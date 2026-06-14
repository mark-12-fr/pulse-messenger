"""
Root deployment entrypoint for Render.

Render builds and runs from the repository root, but the application code lives
in `backend/`. This thin shim loads the real Flask app from `backend/app.py` and
exposes `app` / `socketio`, so a start command like:

    gunicorn -k eventlet -w 1 --bind 0.0.0.0:$PORT app:app

works straight from the repo root — no "Root Directory" setting required.

(For local development you can still run `backend/app.py` directly as before.)
"""

import os

# This shim runs in production under gunicorn. Match the real-time engine to the
# gunicorn worker class and monkey-patch BEFORE the backend and its dependencies
# are imported. Defaults to eventlet; set SOCKETIO_ASYNC_MODE=gevent (with a gevent
# worker) or =threading (with the gthread worker) to switch engines.
# Use the system DNS resolver instead of eventlet's greendns, which can fail to
# reach external HTTPS hosts (push services, Supabase Storage). Set before eventlet.
os.environ.setdefault("EVENTLET_NO_GREENDNS", "yes")

_async_mode = os.environ.setdefault("SOCKETIO_ASYNC_MODE", "eventlet")

if _async_mode == "eventlet":
    import eventlet
    eventlet.monkey_patch()
elif _async_mode == "gevent":
    from gevent import monkey
    monkey.patch_all()
# "threading" mode needs no monkey-patching.

import sys
import importlib.util

_BACKEND_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "backend")
sys.path.insert(0, _BACKEND_DIR)
os.chdir(_BACKEND_DIR)  # so relative paths (.env, data/, uploads/) resolve normally

# Load backend/app.py under a distinct module name to avoid colliding with this
# root module (which gunicorn imports as "app").
_spec = importlib.util.spec_from_file_location(
    "pulse_backend_app", os.path.join(_BACKEND_DIR, "app.py")
)
_module = importlib.util.module_from_spec(_spec)
sys.modules["pulse_backend_app"] = _module
_spec.loader.exec_module(_module)

app = _module.app
socketio = _module.socketio

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 10000))
    socketio.run(app, host="0.0.0.0", port=port, allow_unsafe_werkzeug=True)
