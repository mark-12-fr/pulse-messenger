"""
File storage for uploads.

  - If Supabase Storage is configured (SUPABASE_URL + a service key), files are
    uploaded to a public Supabase Storage bucket and a public URL is returned.
    This is required in production because Render's filesystem is ephemeral.
  - Otherwise files are saved to a local ./uploads folder (handy for local dev).
"""

import os
import io
import time
import shutil
import secrets
from datetime import datetime

import requests

LOCAL_DIR = os.path.join(os.path.dirname(__file__), "uploads")
os.makedirs(LOCAL_DIR, exist_ok=True)

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
# Accept either name; the service_role key is what's needed to write to storage.
SUPABASE_KEY = (
    os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    or os.environ.get("SUPABASE_KEY")
    or ""
)
BUCKET = os.environ.get("SUPABASE_BUCKET", "media")

MAX_BYTES = 100 * 1024 * 1024  # 100 MB (videos)

# A configured Supabase URL still containing the placeholder is treated as "off".
_SUPABASE_READY = bool(
    SUPABASE_URL and SUPABASE_KEY
    and "your_supabase" not in SUPABASE_URL.lower()
    and "your_supabase" not in SUPABASE_KEY.lower()
)


class TooLarge(Exception):
    pass


def using_supabase():
    return _SUPABASE_READY


def attachment_type_for(mime):
    if not mime:
        return "file"
    if mime.startswith("image/"):
        return "image"
    if mime.startswith("video/"):
        return "video"
    if mime.startswith("audio/"):
        return "audio"
    return "file"


def _safe_ext(filename):
    ext = os.path.splitext(filename or "")[1]
    return ext[:12]


def save_file(file_storage, prefix=""):
    """file_storage is a Werkzeug FileStorage. Returns a dict the client can use.

    ``prefix`` puts the file in a sub-folder of the bucket. Files under the
    ``avatars/`` prefix are kept permanently — the privacy auto-clear job only
    sweeps the bucket root, so profile photos survive the 3-hour message purge.
    """
    # Determine size without loading the whole file into memory (big videos would
    # OOM Render's small instance). Werkzeug spools large uploads to a temp file.
    stream = file_storage.stream
    try:
        stream.seek(0, os.SEEK_END)
        size = stream.tell()
        stream.seek(0)
    except Exception:
        data = file_storage.read()
        size = len(data)
        stream = io.BytesIO(data)
    if size > MAX_BYTES:
        raise TooLarge()

    mime = file_storage.mimetype or "application/octet-stream"
    key = f"{int(time.time() * 1000)}-{secrets.token_hex(12)}{_safe_ext(file_storage.filename)}"
    prefix = "".join(c for c in (prefix or "") if c.isalnum() or c in "-_").strip("/")
    if prefix:
        key = f"{prefix}/{key}"

    if _SUPABASE_READY:
        try:
            stream.seek(0)
            endpoint = f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/{key}"
            resp = requests.post(
                endpoint,
                data=stream,  # streamed, not buffered in memory
                headers={
                    "Authorization": f"Bearer {SUPABASE_KEY}",
                    "Content-Type": mime,
                    "Content-Length": str(size),
                    "x-upsert": "true",
                },
                timeout=180,
            )
            if resp.status_code in (200, 201):
                public_url = f"{SUPABASE_URL}/storage/v1/object/public/{BUCKET}/{key}"
                return {
                    "url": public_url,
                    "type": attachment_type_for(mime),
                    "name": file_storage.filename,
                    "size": size,
                }
            # Don't fail the whole upload — log the reason and fall back to local
            # storage so the user can still send the photo. A 400/401/403 here
            # usually means SUPABASE_SERVICE_ROLE_KEY is wrong (e.g. the anon key
            # was used instead of the service_role key) or SUPABASE_URL is wrong.
            print(
                f"[storage] Supabase upload failed ({resp.status_code}): "
                f"{resp.text[:300]} — falling back to local storage.",
                flush=True,
            )
        except Exception as e:
            print(f"[storage] Supabase upload error: {e!r} — falling back to local storage.", flush=True)

    # Local fallback (also used for local dev). NOTE: Render's disk is ephemeral,
    # so files saved here disappear when the instance restarts — set
    # SUPABASE_SERVICE_ROLE_KEY for permanent photo storage.
    local_path = os.path.join(LOCAL_DIR, key)
    os.makedirs(os.path.dirname(local_path), exist_ok=True)
    try:
        stream.seek(0)
    except Exception:
        pass
    with open(local_path, "wb") as fp:
        shutil.copyfileobj(stream, fp)
    return {
        "url": f"/uploads/{key}",
        "type": attachment_type_for(mime),
        "name": file_storage.filename,
        "size": size,
    }


def _parse_iso(s):
    """Parse a Supabase ISO timestamp to a unix epoch (seconds). 0 on failure."""
    if not s:
        return 0
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0


def clear_old_media(retention_hours=24):
    """Delete media files older than ``retention_hours`` from the bucket root,
    keeping the permanent ``avatars/`` sub-folder. Uses the Supabase Storage API
    with the service-role key (the same one used for uploads). Returns a small
    diagnostics dict. This is the privacy auto-clear for photos/videos/voice."""
    if not _SUPABASE_READY:
        return {"ok": False, "removed": 0, "reason": "supabase-not-configured"}

    boundary = time.time() - retention_hours * 3600
    headers = {"Authorization": f"Bearer {SUPABASE_KEY}", "Content-Type": "application/json"}
    to_delete = []
    offset = 0
    page = 1000
    try:
        while True:
            resp = requests.post(
                f"{SUPABASE_URL}/storage/v1/object/list/{BUCKET}",
                json={"prefix": "", "limit": page, "offset": offset,
                      "sortBy": {"column": "created_at", "order": "asc"}},
                headers=headers, timeout=30,
            )
            if resp.status_code != 200:
                return {"ok": False, "removed": 0, "status": resp.status_code, "error": resp.text[:200]}
            items = resp.json() or []
            if not items:
                break
            for it in items:
                name = it.get("name")
                # skip the permanent avatars/ folder and folder placeholders (id is null)
                if not name or name.startswith("avatars/") or it.get("id") is None:
                    continue
                ts = _parse_iso(it.get("created_at"))
                if ts and ts < boundary:
                    to_delete.append(name)
            if len(items) < page:
                break
            offset += page

        removed = 0
        for i in range(0, len(to_delete), 100):
            batch = to_delete[i:i + 100]
            d = requests.delete(
                f"{SUPABASE_URL}/storage/v1/object/{BUCKET}",
                json={"prefixes": batch}, headers=headers, timeout=30,
            )
            if d.status_code in (200, 204):
                removed += len(batch)
        return {"ok": True, "removed": removed, "scanned_for_delete": len(to_delete)}
    except Exception as e:
        return {"ok": False, "removed": 0, "error": repr(e)[:200]}
