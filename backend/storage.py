"""
File storage for uploads.

  - If Supabase Storage is configured (SUPABASE_URL + a service key), files are
    uploaded to a public Supabase Storage bucket and a public URL is returned.
    This is required in production because Render's filesystem is ephemeral.
  - Otherwise files are saved to a local ./uploads folder (handy for local dev).
"""

import os
import time
import secrets

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

MAX_BYTES = 50 * 1024 * 1024  # 50 MB

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
    return "file"


def _safe_ext(filename):
    ext = os.path.splitext(filename or "")[1]
    return ext[:12]


def save_file(file_storage):
    """file_storage is a Werkzeug FileStorage. Returns a dict the client can use."""
    data = file_storage.read()
    if len(data) > MAX_BYTES:
        raise TooLarge()

    mime = file_storage.mimetype or "application/octet-stream"
    key = f"{int(time.time() * 1000)}-{secrets.token_hex(12)}{_safe_ext(file_storage.filename)}"

    if _SUPABASE_READY:
        try:
            endpoint = f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/{key}"
            resp = requests.post(
                endpoint,
                data=data,
                headers={
                    "Authorization": f"Bearer {SUPABASE_KEY}",
                    "Content-Type": mime,
                    "x-upsert": "true",
                },
                timeout=60,
            )
            if resp.status_code in (200, 201):
                public_url = f"{SUPABASE_URL}/storage/v1/object/public/{BUCKET}/{key}"
                return {
                    "url": public_url,
                    "type": attachment_type_for(mime),
                    "name": file_storage.filename,
                    "size": len(data),
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
    with open(os.path.join(LOCAL_DIR, key), "wb") as fp:
        fp.write(data)
    return {
        "url": f"/uploads/{key}",
        "type": attachment_type_for(mime),
        "name": file_storage.filename,
        "size": len(data),
    }
