"""
Pulse Messenger — Flask backend (deploy to Render).

  - REST API (auth, friends, search, conversations, upload)
  - Socket.IO real-time messaging, presence, typing, read receipts
  - SQLAlchemy storage (SQLite locally, Supabase Postgres in production)
"""

import os

# Decide the async mode from the OS environment and, when using eventlet/gevent,
# monkey-patch the standard library BEFORE importing anything else (otherwise
# locks created by other modules are not "greened"). Production (Render) sets
# SOCKETIO_ASYNC_MODE as a real environment variable; local dev stays "threading".
os.environ.setdefault("EVENTLET_NO_GREENDNS", "yes")  # native DNS; greendns can't reach some hosts
ASYNC_MODE = os.environ.get("SOCKETIO_ASYNC_MODE", "threading")
if ASYNC_MODE == "eventlet":
    import eventlet
    eventlet.monkey_patch()
elif ASYNC_MODE == "gevent":
    from gevent import monkey
    monkey.patch_all()

from dotenv import load_dotenv

load_dotenv()  # load .env for local development

# Make psycopg2 cooperative with the chosen green-thread library.
if ASYNC_MODE == "eventlet":
    try:
        from psycogreen.eventlet import patch_psycopg
        patch_psycopg()
    except Exception:
        pass
elif ASYNC_MODE == "gevent":
    try:
        from psycogreen.gevent import patch_psycopg
        patch_psycopg()
    except Exception:
        pass

import re
import secrets
import functools
from datetime import datetime, timedelta, timezone

import jwt
from flask import Flask, request, jsonify, g, send_from_directory
from flask_cors import CORS
from flask_socketio import SocketIO, join_room, ConnectionRefusedError
from werkzeug.security import generate_password_hash, check_password_hash

# eventlet's greendns fails to resolve some external hosts on Render
# (NameResolutionError for web.push.apple.com, Supabase Storage, …), and Render's
# free tier has no outbound IPv6. Resolve through the ORIGINAL (native) getaddrinfo
# — bypassing greendns — and keep only IPv4 results, so requests/urllib3 can
# connect. (gunicorn's eventlet worker monkey-patches before app code runs, so
# setting EVENTLET_NO_GREENDNS here is too late; we patch getaddrinfo directly.)
import socket as _socket
try:
    import eventlet as _ev
    _native_getaddrinfo = _ev.patcher.original("socket").getaddrinfo
except Exception:
    _native_getaddrinfo = _socket.getaddrinfo
def _ipv4_getaddrinfo(*args, **kwargs):
    res = _native_getaddrinfo(*args, **kwargs)
    v4 = [r for r in res if r[0] == _socket.AF_INET]
    return v4 or res
_socket.getaddrinfo = _ipv4_getaddrinfo

import db
import storage
import push

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
db.init_db()

# Keep JWT_SECRET stable across restarts so logins persist forever (until the user
# logs out). Prefer the env var; otherwise load — or generate once and store — it
# in the database. Without this, a fresh random secret on each restart would
# invalidate everyone's token and silently log them out.
JWT_SECRET = os.environ.get("JWT_SECRET")
if not JWT_SECRET:
    try:
        JWT_SECRET = db.get_config("jwt_secret")
        if not JWT_SECRET:
            JWT_SECRET = secrets.token_hex(32)
            db.set_config("jwt_secret", JWT_SECRET)
    except Exception:
        JWT_SECRET = secrets.token_hex(32)
        print("[warn] could not persist JWT_SECRET; logins may reset on restart.")

_origin_env = os.environ.get("FRONTEND_ORIGIN", "*")
ORIGINS = "*" if _origin_env.strip() == "*" else [o.strip() for o in _origin_env.split(",") if o.strip()]

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024  # 50 MB uploads
CORS(app, resources={r"/api/*": {"origins": ORIGINS}})
socketio = SocketIO(
    app,
    cors_allowed_origins=ORIGINS,
    async_mode=ASYNC_MODE,
    max_http_buffer_size=2 * 1024 * 1024,
)

AVATAR_COLORS = [
    "#0084ff", "#7646ff", "#ff5e3a", "#13b955", "#ff9500",
    "#e0457b", "#00b8d4", "#8e44ad", "#16a085", "#d35400",
]
USERNAME_RE = re.compile(r"^[a-z0-9_.]{3,20}$")

# ---------------------------------------------------------------------------
# Auth helpers
# ---------------------------------------------------------------------------
def sign_token(user):
    payload = {
        "id": user["id"],
        "username": user["username"],
        "exp": datetime.now(timezone.utc) + timedelta(days=365),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")


def user_from_token(token):
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
        return db.get_user_by_id(payload["id"])
    except Exception:
        return None


def auth_required(fn):
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        header = request.headers.get("Authorization", "")
        token = header[7:] if header.startswith("Bearer ") else None
        user = user_from_token(token) if token else None
        if not user:
            return jsonify(error="Not authenticated"), 401
        g.user = user
        return fn(*args, **kwargs)
    return wrapper


# ---------------------------------------------------------------------------
# Presence (in-memory; run a single worker, see render.yaml)
# ---------------------------------------------------------------------------
online = {}        # user_id -> set(sid)
sid_user = {}      # sid -> user_id
active_sids = set()  # sids whose app is currently in the foreground


def is_online(uid):
    return uid in online and len(online[uid]) > 0


def is_active(uid):
    """True if any of the user's sessions has the app in the foreground."""
    return any(sid in active_sids for sid in online.get(uid, ()))


def emit_to_user(uid, event, data):
    socketio.emit(event, data, room=f"user:{uid}")


def emit_conv(conv, event, data, exclude=None):
    """Emit to everyone in a conversation (both 1-to-1 parties or all group members)."""
    for mid in db.conversation_member_ids(conv):
        if mid and mid != exclude:
            emit_to_user(mid, event, data)


def broadcast_presence(uid, up):
    me = db.get_user_by_id(uid)
    last_seen = me["lastSeen"] if me else None
    for f in db.list_friends(uid):
        emit_to_user(f["id"], "presence", {"userId": uid, "online": up, "lastSeen": last_seen})


def notify_friend_accepted(a, b):
    conv = db.get_or_create_conversation(a, b)
    ua, ub = db.get_user_by_id(a), db.get_user_by_id(b)
    emit_to_user(a, "friend:accepted", {"friend": {**ub, "online": is_online(b), "conversationId": conv["id"]}})
    emit_to_user(b, "friend:accepted", {"friend": {**ua, "online": is_online(a), "conversationId": conv["id"]}})


# ---------------------------------------------------------------------------
# Health / root
# ---------------------------------------------------------------------------
@app.get("/")
def root():
    return jsonify(name="Pulse Messenger API", status="ok", storage="supabase" if storage.using_supabase() else "local")


@app.get("/api/health")
def health():
    return jsonify(status="ok")


# ---------------------------------------------------------------------------
# Auth routes
# ---------------------------------------------------------------------------
@app.post("/api/register")
def register():
    data = request.get_json(silent=True) or {}
    username = str(data.get("username", "")).strip().lower()
    display_name = str(data.get("displayName", "")).strip()
    password = str(data.get("password", ""))

    if not USERNAME_RE.match(username):
        return jsonify(error="Username must be 3-20 characters (letters, numbers, _ or . only)."), 400
    if not (1 <= len(display_name) <= 40):
        return jsonify(error="Display name must be 1-40 characters."), 400
    if len(password) < 6:
        return jsonify(error="Password must be at least 6 characters."), 400
    if db.username_exists(username):
        return jsonify(error="That username is already taken."), 409

    password_hash = generate_password_hash(password, method="pbkdf2:sha256")
    avatar_color = secrets.choice(AVATAR_COLORS)
    user = db.create_user(username, display_name, password_hash, avatar_color)
    return jsonify(token=sign_token(user), user=user)


@app.post("/api/login")
def login():
    data = request.get_json(silent=True) or {}
    username = str(data.get("username", "")).strip().lower()
    password = str(data.get("password", ""))

    user = db.get_auth_user(username)
    if not user or not check_password_hash(user["passwordHash"], password):
        return jsonify(error="Wrong username or password."), 401
    user.pop("passwordHash", None)
    return jsonify(token=sign_token(user), user=user)


@app.get("/api/me")
@auth_required
def me():
    return jsonify(user=g.user)


@app.post("/api/me/update")
@auth_required
def update_me():
    data = request.get_json(silent=True) or {}
    me_id = g.user["id"]
    display_name = str(data.get("displayName", "")).strip()
    username = str(data.get("username", "")).strip().lower()
    if not (1 <= len(display_name) <= 40):
        return jsonify(error="Display name must be 1-40 characters."), 400
    if not USERNAME_RE.match(username):
        return jsonify(error="Username must be 3-20 characters (letters, numbers, _ or . only)."), 400
    if username != g.user["username"] and db.username_exists(username):
        return jsonify(error="That username is already taken."), 409
    user = db.update_user(
        me_id, display_name, username,
        avatar_url=data.get("avatarUrl"),
        set_avatar=("avatarUrl" in data),
    )
    return jsonify(user=user)


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------
@app.get("/api/users/search")
@auth_required
def search():
    q = str(request.args.get("q", "")).strip()
    if not q:
        return jsonify(users=[])
    rows = db.search_users(g.user["id"], q)
    users = [
        {**u, "online": is_online(u["id"]), "relationship": db.relationship(g.user["id"], u["id"])}
        for u in rows
    ]
    return jsonify(users=users)


# ---------------------------------------------------------------------------
# Friends
# ---------------------------------------------------------------------------
@app.post("/api/friends/request")
@auth_required
def friend_request():
    data = request.get_json(silent=True) or {}
    target_id = int(data.get("userId") or 0)
    me_id = g.user["id"]
    if not target_id or target_id == me_id:
        return jsonify(error="Invalid user."), 400
    if not db.get_user_by_id(target_id):
        return jsonify(error="User not found."), 404
    if db.is_blocked_either(me_id, target_id):
        return jsonify(error="You can't add this person."), 403

    existing = db.find_friendship(me_id, target_id)
    if existing:
        if existing["status"] == "accepted":
            return jsonify(error="You are already friends."), 409
        # They already requested me -> accept instead of duplicating.
        if existing["addressee_id"] == me_id:
            db.accept_friendship(existing["id"])
            notify_friend_accepted(me_id, target_id)
            return jsonify(ok=True, status="accepted")
        return jsonify(error="Friend request already sent."), 409

    db.create_friend_request(me_id, target_id)
    emit_to_user(target_id, "friend:request", {"from": {**g.user, "online": is_online(me_id)}})
    return jsonify(ok=True, status="pending")


@app.post("/api/friends/respond")
@auth_required
def friend_respond():
    data = request.get_json(silent=True) or {}
    request_id = int(data.get("requestId") or 0)
    action = str(data.get("action", ""))
    fr = db.get_friendship_by_id(request_id)
    if not fr or fr["addressee_id"] != g.user["id"] or fr["status"] != "pending":
        return jsonify(error="Request not found."), 404

    if action == "accept":
        db.accept_friendship(request_id)
        notify_friend_accepted(fr["requester_id"], fr["addressee_id"])
        return jsonify(ok=True, status="accepted")
    if action == "decline":
        db.delete_friendship(request_id)
        return jsonify(ok=True, status="declined")
    return jsonify(error="Invalid action."), 400


@app.post("/api/friends/remove")
@auth_required
def friend_remove():
    data = request.get_json(silent=True) or {}
    other_id = int(data.get("userId") or 0)
    me_id = g.user["id"]
    if not other_id:
        return jsonify(error="Invalid user."), 400
    db.remove_friend(me_id, other_id)
    emit_to_user(other_id, "friend:removed", {"userId": me_id})
    return jsonify(ok=True)


@app.get("/api/friends")
@auth_required
def friends():
    me_id = g.user["id"]
    rows = db.list_friends(me_id)
    nicks = db.get_nicknames(me_id)
    out = []
    for u in rows:
        conv = db.get_or_create_conversation(me_id, u["id"])
        out.append({**u, "online": is_online(u["id"]), "conversationId": conv["id"],
                    "nickname": nicks.get(u["id"])})
    return jsonify(friends=out)


@app.post("/api/friends/nickname")
@auth_required
def friend_nickname():
    data = request.get_json(silent=True) or {}
    friend_id = int(data.get("userId") or 0)
    nickname = str(data.get("nickname", "")).strip()[:40]
    if not friend_id:
        return jsonify(error="Invalid user."), 400
    db.set_nickname(g.user["id"], friend_id, nickname)
    return jsonify(ok=True, nickname=nickname or None)


@app.post("/api/friends/block")
@auth_required
def friend_block():
    data = request.get_json(silent=True) or {}
    other_id = int(data.get("userId") or 0)
    me_id = g.user["id"]
    if not other_id or other_id == me_id:
        return jsonify(error="Invalid user."), 400
    db.block_user(me_id, other_id)
    # let the other side refresh (they can no longer message me)
    emit_to_user(other_id, "user:blocked", {"userId": me_id})
    return jsonify(ok=True, blocked=True)


@app.post("/api/friends/unblock")
@auth_required
def friend_unblock():
    data = request.get_json(silent=True) or {}
    other_id = int(data.get("userId") or 0)
    me_id = g.user["id"]
    if not other_id:
        return jsonify(error="Invalid user."), 400
    db.unblock_user(me_id, other_id)
    emit_to_user(other_id, "user:unblocked", {"userId": me_id})
    return jsonify(ok=True, blocked=False)


@app.get("/api/friends/requests")
@auth_required
def friend_requests():
    me_id = g.user["id"]
    incoming = [{**r, "online": is_online(r["id"])} for r in db.incoming_requests(me_id)]
    outgoing = db.outgoing_requests(me_id)
    return jsonify(incoming=incoming, outgoing=outgoing)


# ---------------------------------------------------------------------------
# Conversations & messages
# ---------------------------------------------------------------------------
@app.get("/api/conversations")
@auth_required
def conversations():
    return jsonify(conversations=db.list_conversations(g.user["id"]))


@app.post("/api/conversations/<int:cid>/prefs")
@auth_required
def conversation_prefs(cid):
    me_id = g.user["id"]
    conv = db.get_conversation_by_id(cid)
    if not db.is_conversation_member(conv, me_id):
        return jsonify(error="Conversation not found."), 404
    data = request.get_json(silent=True) or {}
    pinned = data.get("pinned")
    muted = data.get("muted")
    prefs = db.set_conversation_pref(
        me_id, cid,
        pinned=bool(pinned) if pinned is not None else None,
        muted=bool(muted) if muted is not None else None,
    )
    return jsonify(ok=True, **prefs)


@app.get("/api/conversations/<int:cid>/messages")
@auth_required
def conversation_messages(cid):
    me_id = g.user["id"]
    conv = db.get_conversation_by_id(cid)
    if not db.is_conversation_member(conv, me_id):
        return jsonify(error="Conversation not found."), 404

    messages = db.get_messages(cid)
    if messages:
        last_id = messages[-1]["id"]
        db.mark_read(cid, me_id, last_id)

    # --- group conversation ---
    if conv.get("is_group"):
        return jsonify(messages=messages, group=db.public_conversation_meta(conv, me_id))

    # --- 1-to-1 conversation ---
    partner_id = db.conversation_partner_id(conv, me_id)
    partner = db.get_user_by_id(partner_id)
    if messages:
        emit_to_user(partner_id, "message:read",
                     {"conversationId": cid, "byUserId": me_id, "lastReadMessageId": messages[-1]["id"]})
    return jsonify(
        messages=messages,
        friend={**partner, "online": is_online(partner_id),
                "iBlocked": db.i_blocked(me_id, partner_id),
                "blockedMe": db.i_blocked(partner_id, me_id)},
        partnerLastRead=db.get_last_read(cid, partner_id),
        partnerLastDelivered=db.get_last_delivered(cid, partner_id),
    )


# ---------------------------------------------------------------------------
# Group chats
# ---------------------------------------------------------------------------
def _group_entry(conv, me_id):
    return {
        "id": conv["id"], "isGroup": True,
        "group": db.public_conversation_meta(conv, me_id),
        "lastMessage": None, "unread": 0, "pinned": False, "muted": False,
    }


@app.post("/api/groups")
@auth_required
def create_group():
    me_id = g.user["id"]
    data = request.get_json(silent=True) or {}
    name = str(data.get("name") or "").strip()
    member_ids = data.get("memberIds") or []
    try:
        member_ids = [int(x) for x in member_ids]
    except (ValueError, TypeError):
        return jsonify(error="Invalid members."), 400
    friend_ids = {f["id"] for f in db.list_friends(me_id)}
    member_ids = [m for m in member_ids if m in friend_ids]
    if len(member_ids) < 2:
        return jsonify(error="Pick at least 2 friends for a group."), 400
    conv = db.create_group(me_id, name, member_ids)
    # tell every member (including me) so their chat list gains the group
    for mid in db.conversation_member_ids(conv):
        emit_to_user(mid, "conversation:new", {"conversation": _group_entry(conv, mid)})
    return jsonify(conversation=_group_entry(conv, me_id))


@app.post("/api/groups/<int:cid>/rename")
@auth_required
def rename_group(cid):
    me_id = g.user["id"]
    conv = db.get_conversation_by_id(cid)
    if not conv or not conv.get("is_group") or not db.is_conversation_member(conv, me_id):
        return jsonify(error="Group not found."), 404
    name = str((request.get_json(silent=True) or {}).get("name") or "").strip()
    if not name:
        return jsonify(error="Name required."), 400
    db.update_group(cid, name=name)
    conv = db.get_conversation_by_id(cid)
    meta = db.public_conversation_meta(conv, me_id)
    emit_conv(conv, "group:updated", {"group": meta})
    return jsonify(ok=True, group=meta)


@app.post("/api/groups/<int:cid>/photo")
@auth_required
def group_photo(cid):
    me_id = g.user["id"]
    conv = db.get_conversation_by_id(cid)
    if not conv or not conv.get("is_group") or not db.is_conversation_member(conv, me_id):
        return jsonify(error="Group not found."), 404
    data = request.get_json(silent=True) or {}
    db.update_group(cid, avatar_url=data.get("avatarUrl"), set_avatar=True)
    conv = db.get_conversation_by_id(cid)
    meta = db.public_conversation_meta(conv, me_id)
    emit_conv(conv, "group:updated", {"group": meta})
    return jsonify(ok=True, group=meta)


@app.post("/api/groups/<int:cid>/members")
@auth_required
def add_members(cid):
    me_id = g.user["id"]
    conv = db.get_conversation_by_id(cid)
    if not conv or not conv.get("is_group") or not db.is_conversation_member(conv, me_id):
        return jsonify(error="Group not found."), 404
    data = request.get_json(silent=True) or {}
    try:
        ids = [int(x) for x in (data.get("memberIds") or [])]
    except (ValueError, TypeError):
        return jsonify(error="Invalid members."), 400
    friend_ids = {f["id"] for f in db.list_friends(me_id)}
    ids = [i for i in ids if i in friend_ids]
    added = db.add_group_members(cid, ids)
    conv = db.get_conversation_by_id(cid)
    meta = db.public_conversation_meta(conv, me_id)
    emit_conv(conv, "group:updated", {"group": meta})
    for mid in added:
        emit_to_user(mid, "conversation:new", {"conversation": _group_entry(conv, mid)})
    return jsonify(ok=True, group=meta)


@app.post("/api/groups/<int:cid>/leave")
@auth_required
def leave_group(cid):
    me_id = g.user["id"]
    conv = db.get_conversation_by_id(cid)
    if not conv or not conv.get("is_group") or not db.is_conversation_member(conv, me_id):
        return jsonify(error="Group not found."), 404
    db.remove_group_member(cid, me_id)
    emit_to_user(me_id, "group:removed", {"conversationId": cid})
    conv = db.get_conversation_by_id(cid)
    meta = db.public_conversation_meta(conv, me_id)
    emit_conv(conv, "group:updated", {"group": meta})
    return jsonify(ok=True)


# ---------------------------------------------------------------------------
# Upload
# ---------------------------------------------------------------------------
@app.post("/api/upload")
@auth_required
def upload():
    f = request.files.get("file")
    if not f:
        return jsonify(error="No file uploaded."), 400
    # Avatars go to a permanent sub-folder so the privacy auto-clear (which only
    # sweeps the bucket root) never deletes them.
    prefix = "avatars" if request.form.get("kind") == "avatar" else ""
    try:
        info = storage.save_file(f, prefix=prefix)
    except storage.TooLarge:
        return jsonify(error="File is too large (max 50 MB)."), 400
    except Exception:
        return jsonify(error="Upload failed."), 400
    return jsonify(info)


@app.errorhandler(413)
def too_large(_e):
    return jsonify(error="File is too large (max 50 MB)."), 413


# Serve locally-stored uploads (only used when Supabase Storage is not configured).
@app.get("/uploads/<path:filename>")
def serve_upload(filename):
    return send_from_directory(storage.LOCAL_DIR, filename)


# ---------------------------------------------------------------------------
# Push notifications (content-free: "X sent you a message")
# ---------------------------------------------------------------------------
@app.get("/api/push/key")
def push_key():
    return jsonify(key=push.public_key())


@app.post("/api/push/subscribe")
@auth_required
def push_subscribe():
    data = request.get_json(silent=True) or {}
    endpoint = str(data.get("endpoint") or "")
    keys = data.get("keys") or {}
    p256dh = str(keys.get("p256dh") or "")
    auth = str(keys.get("auth") or "")
    if not endpoint or not p256dh or not auth:
        return jsonify(error="Invalid subscription."), 400
    db.save_push_subscription(g.user["id"], endpoint, p256dh, auth)
    return jsonify(ok=True)


@app.post("/api/push/unsubscribe")
@auth_required
def push_unsubscribe():
    data = request.get_json(silent=True) or {}
    endpoint = str(data.get("endpoint") or "")
    if endpoint:
        db.delete_push_subscription(endpoint)
    return jsonify(ok=True)


@app.post("/api/push/test")
@auth_required
def push_test():
    return jsonify(push.send_to_user(g.user["id"], "Tea 🍵", "Test notification — it works!", force=True))


# ---------------------------------------------------------------------------
# Socket.IO
# ---------------------------------------------------------------------------
@socketio.on("connect")
def on_connect(auth):
    token = auth.get("token") if isinstance(auth, dict) else None
    user = user_from_token(token) if token else None
    if not user:
        raise ConnectionRefusedError("unauthorized")  # reject the connection
    uid = user["id"]
    sid = request.sid
    sid_user[sid] = uid
    was_offline = not is_online(uid)
    online.setdefault(uid, set()).add(sid)
    join_room(f"user:{uid}")
    if was_offline:
        db.set_last_seen(uid)
        broadcast_presence(uid, True)
    # Now that this user is connected, mark messages waiting for them as
    # delivered and let the senders' ticks turn to ✓✓.
    socketio.start_background_task(_deliver_pending, uid)


def _deliver_pending(uid):
    for d in db.deliver_all_pending(uid):
        emit_to_user(d["partnerId"], "message:delivered", {
            "conversationId": d["conversationId"],
            "byUserId": uid,
            "lastDeliveredMessageId": d["lastDeliveredMessageId"],
        })


@socketio.on("disconnect")
def on_disconnect():
    sid = request.sid
    active_sids.discard(sid)
    uid = sid_user.pop(sid, None)
    if uid is None:
        return
    sids = online.get(uid)
    if sids and sid in sids:
        sids.discard(sid)
        if not sids:
            online.pop(uid, None)
            db.set_last_seen(uid)
            broadcast_presence(uid, False)


@socketio.on("presence:active")
def on_presence_active(payload):
    sid = request.sid
    if sid not in sid_user:
        return
    if (payload or {}).get("active"):
        active_sids.add(sid)
    else:
        active_sids.discard(sid)


@socketio.on("message:send")
def on_message_send(payload):
    uid = sid_user.get(request.sid)
    if not uid:
        return {"error": "Not authenticated."}
    payload = payload or {}
    to_user_id = int(payload.get("toUserId") or 0)
    conv_id = int(payload.get("conversationId") or 0)
    body = str(payload.get("body") or "")[:5000]
    attachment = payload.get("attachment")
    reply_to_id = int(payload.get("replyToId") or 0) or None

    if not body and not attachment:
        return {"error": "Empty message."}

    sender = db.get_user_by_id(uid)

    # --- group message (client passes conversationId of a group) ---
    if conv_id:
        conv = db.get_conversation_by_id(conv_id)
        if not conv or not conv.get("is_group"):
            return {"error": "Conversation not found."}
        if not db.is_conversation_member(conv, uid):
            return {"error": "You are not in this group."}
    else:
        # --- 1-to-1 message ---
        if not to_user_id:
            return {"error": "Missing recipient."}
        fr = db.find_friendship(uid, to_user_id)
        if not fr or fr["status"] != "accepted":
            return {"error": "You can only message your friends."}
        if db.is_blocked_either(uid, to_user_id):
            return {"error": "You can't message this person."}
        conv = db.get_or_create_conversation(uid, to_user_id)

    if reply_to_id:
        rmeta = db.get_message_meta(reply_to_id)
        if not rmeta or rmeta["conversationId"] != conv["id"]:
            reply_to_id = None
    msg = db.create_message(
        conv["id"], uid, body,
        attachment.get("url") if attachment else None,
        attachment.get("type") if attachment else None,
        attachment.get("name") if attachment else None,
        reply_to_id=reply_to_id,
    )
    db.mark_read(conv["id"], uid, msg["id"])

    is_group = bool(conv.get("is_group"))
    envelope = {"message": msg, "conversationId": conv["id"], "isGroup": is_group, "sender": sender}
    if not is_group:
        recipient = db.get_user_by_id(db.conversation_partner_id(conv, uid))
        envelope["participants"] = {str(uid): sender, str(recipient["id"]): recipient}

    emit_conv(conv, "message:new", envelope)

    # Push to recipients who aren't actively in the app and haven't muted this chat.
    title = (conv.get("name") or "Group") if is_group else sender["displayName"]
    bodytext = (f"{sender['displayName']}: " + (msg.get("body") or "sent a message")) if is_group else "Sent you a message"
    for mid in db.conversation_member_ids(conv):
        if not mid or mid == uid:
            continue
        if not is_active(mid) and not db.is_muted(mid, conv["id"]):
            socketio.start_background_task(push.send_to_user, mid, title, bodytext[:120])
    return {"ok": True, "message": msg}


@socketio.on("typing")
def on_typing(payload):
    uid = sid_user.get(request.sid)
    if not uid:
        return
    payload = payload or {}
    conv_id = int(payload.get("conversationId") or 0)
    to_user_id = int(payload.get("toUserId") or 0)
    if conv_id:
        conv = db.get_conversation_by_id(conv_id)
        if not db.is_conversation_member(conv, uid):
            return
    elif to_user_id:
        fr = db.find_friendship(uid, to_user_id)
        if not fr or fr["status"] != "accepted":
            return
        conv = db.get_or_create_conversation(uid, to_user_id)
    else:
        return
    me = db.get_user_by_id(uid)
    emit_conv(conv, "typing", {
        "conversationId": conv["id"],
        "fromUserId": uid,
        "fromName": me["displayName"] if me else "",
        "isTyping": bool(payload.get("isTyping")),
    }, exclude=uid)


@socketio.on("message:read")
def on_message_read(payload):
    uid = sid_user.get(request.sid)
    if not uid:
        return
    payload = payload or {}
    cid = int(payload.get("conversationId") or 0)
    conv = db.get_conversation_by_id(cid)
    if not db.is_conversation_member(conv, uid):
        return
    last = db.get_last_message(cid)
    if not last:
        return
    db.mark_read(cid, uid, last["id"])
    # Reading implies delivered too — keep the delivered marker in step.
    db.mark_conversation_delivered(cid, uid)
    # Per-message seen ticks are only shown in 1-to-1 chats.
    if not conv.get("is_group"):
        partner_id = db.conversation_partner_id(conv, uid)
        emit_to_user(partner_id, "message:read",
                     {"conversationId": cid, "byUserId": uid, "lastReadMessageId": last["id"]})


@socketio.on("message:delivered")
def on_message_delivered(payload):
    uid = sid_user.get(request.sid)
    if not uid:
        return
    cid = int((payload or {}).get("conversationId") or 0)
    if not cid:
        return
    conv = db.get_conversation_by_id(cid)
    if not db.is_conversation_member(conv, uid):
        return
    last_id = db.mark_conversation_delivered(cid, uid)
    if not last_id or conv.get("is_group"):
        return
    partner_id = db.conversation_partner_id(conv, uid)
    emit_to_user(partner_id, "message:delivered",
                 {"conversationId": cid, "byUserId": uid, "lastDeliveredMessageId": last_id})


ALLOWED_REACTIONS = {"👍", "❤️", "😂", "😮", "😢", "😡"}


@socketio.on("message:react")
def on_message_react(payload):
    uid = sid_user.get(request.sid)
    if not uid:
        return {"error": "Not authenticated."}
    payload = payload or {}
    message_id = int(payload.get("messageId") or 0)
    emoji = str(payload.get("emoji") or "").strip()
    if not message_id or not emoji or len(emoji) > 12:
        return {"error": "Invalid reaction."}
    meta = db.get_message_meta(message_id)
    if not meta:
        return {"error": "Message not found."}
    conv = db.get_conversation_by_id(meta["conversationId"])
    if not db.is_conversation_member(conv, uid):
        return {"error": "Not allowed."}
    reactions = db.toggle_reaction(message_id, uid, emoji)
    data = {"messageId": message_id, "conversationId": meta["conversationId"], "reactions": reactions}
    emit_conv(conv, "message:reaction", data)
    return {"ok": True, "reactions": reactions}


@socketio.on("message:edit")
def on_message_edit(payload):
    uid = sid_user.get(request.sid)
    if not uid:
        return {"error": "Not authenticated."}
    payload = payload or {}
    message_id = int(payload.get("messageId") or 0)
    body = str(payload.get("body") or "").strip()[:5000]
    if not message_id or not body:
        return {"error": "Empty message."}
    meta = db.get_message_meta(message_id)
    if not meta:
        return {"error": "Message not found."}
    if meta["senderId"] != uid:
        return {"error": "You can only edit your own messages."}
    db.edit_message(message_id, body)
    conv = db.get_conversation_by_id(meta["conversationId"])
    data = {"messageId": message_id, "conversationId": meta["conversationId"], "body": body, "edited": True}
    emit_conv(conv, "message:edited", data)
    return {"ok": True}


@socketio.on("message:delete")
def on_message_delete(payload):
    uid = sid_user.get(request.sid)
    if not uid:
        return {"error": "Not authenticated."}
    payload = payload or {}
    message_id = int(payload.get("messageId") or 0)
    meta = db.get_message_meta(message_id)
    if not meta:
        return {"error": "Message not found."}
    if meta["senderId"] != uid:
        return {"error": "You can only unsend your own messages."}
    conv = db.get_conversation_by_id(meta["conversationId"])
    db.unsend_message(message_id)
    data = {"messageId": message_id, "conversationId": meta["conversationId"]}
    emit_conv(conv, "message:unsent", data)
    return {"ok": True}


@socketio.on("conversation:delete")
def on_conversation_delete(payload):
    uid = sid_user.get(request.sid)
    if not uid:
        return {"error": "Not authenticated."}
    payload = payload or {}
    cid = int(payload.get("conversationId") or 0)
    conv = db.get_conversation_by_id(cid)
    if not db.is_conversation_member(conv, uid):
        return {"error": "Not allowed."}
    db.delete_conversation_messages(cid)
    data = {"conversationId": cid}
    emit_conv(conv, "conversation:cleared", data)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Local dev entrypoint
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    print(f"\n  Pulse Messenger API (async_mode={ASYNC_MODE}, "
          f"storage={'supabase' if storage.using_supabase() else 'local'})")
    print(f"  -> http://localhost:{port}\n")
    socketio.run(app, host="0.0.0.0", port=port, allow_unsafe_werkzeug=True)
