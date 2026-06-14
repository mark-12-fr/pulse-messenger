"""
Web Push (VAPID) helper for Tea.

Degrades gracefully: if pywebpush/cryptography aren't installed (or keys can't be
made), push is simply disabled and the in-app notifications still work. The VAPID
keypair is generated once and stored in the app_config table, so no env vars are
required.
"""
import json

import db

_VAPID_SUB = "mailto:tea@pulse.app"

try:
    import base64
    from pywebpush import webpush, WebPushException
    from py_vapid import Vapid02
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives import serialization
    _AVAILABLE = True
except Exception:  # pragma: no cover - library not installed yet
    _AVAILABLE = False


def available():
    return _AVAILABLE


def _b64url(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


_cache = {}


def _ensure_keys():
    """Return (private_pem, public_application_server_key). Generated + stored once."""
    if "priv" in _cache:
        return _cache["priv"], _cache["pub"]
    priv_pem = db.get_config("vapid_private")
    pub_b64 = db.get_config("vapid_public")
    if not priv_pem or not pub_b64:
        key = ec.generate_private_key(ec.SECP256R1())
        priv_pem = key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ).decode("ascii")
        pub_raw = key.public_key().public_bytes(
            serialization.Encoding.X962,
            serialization.PublicFormat.UncompressedPoint,
        )
        pub_b64 = _b64url(pub_raw)
        db.set_config("vapid_private", priv_pem)
        db.set_config("vapid_public", pub_b64)
    _cache["priv"], _cache["pub"] = priv_pem, pub_b64
    return priv_pem, pub_b64


def public_key():
    """The applicationServerKey the browser needs to subscribe (or None)."""
    if not _AVAILABLE:
        return None
    try:
        return _ensure_keys()[1]
    except Exception:
        return None


def send_to_user(user_id, title, body):
    """Send a content-free push to all of a user's devices. Returns diagnostics."""
    result = {"available": _AVAILABLE, "subs": 0, "sent": 0, "failed": 0, "error": None}
    if not _AVAILABLE:
        result["error"] = "pywebpush not installed on the server"
        return result
    try:
        priv_pem, _ = _ensure_keys()
        vapid = Vapid02.from_pem(priv_pem.encode("ascii"))
    except Exception as e:
        result["error"] = "vapid: " + str(e)[:200]
        return result
    payload = json.dumps({"title": title, "body": body})
    try:
        subs = db.get_push_subscriptions(user_id)
    except Exception as e:
        result["error"] = "db: " + str(e)[:200]
        return result
    result["subs"] = len(subs)
    for sub in subs:
        info = {"endpoint": sub["endpoint"], "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]}}
        try:
            webpush(
                subscription_info=info,
                data=payload,
                vapid_private_key=vapid,
                vapid_claims={"sub": _VAPID_SUB},
                timeout=10,
            )
            result["sent"] += 1
        except WebPushException as e:
            result["failed"] += 1
            status = getattr(getattr(e, "response", None), "status_code", None)
            result["error"] = "webpush %s: %s" % (status, str(e)[:200])
            if status in (404, 410):
                db.delete_push_subscription(sub["endpoint"])
        except Exception as e:
            result["failed"] += 1
            result["error"] = "send: " + str(e)[:300]
    try:
        import time as _t
        db.set_config("last_push_result", json.dumps({**result, "at": int(_t.time())}))
    except Exception:
        pass
    return result
