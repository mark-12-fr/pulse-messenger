"""
Database layer for Pulse Messenger (Flask edition).

Uses SQLAlchemy so the exact same code runs on:
  - SQLite   -> local development / testing   (DATABASE_URL=sqlite:///data/local.db)
  - Postgres -> production on Supabase         (DATABASE_URL=postgresql://...)

All helpers return plain dicts (never live ORM objects), so they are safe to use
from both HTTP request handlers and Socket.IO event handlers.
"""

import json
import os
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

from sqlalchemy import (
    create_engine, select, or_, and_, func, delete, text,
    Integer, String, Text, Boolean, DateTime, ForeignKey, UniqueConstraint, Index,
)
from sqlalchemy.orm import declarative_base, sessionmaker, mapped_column, aliased
from sqlalchemy.exc import IntegrityError

# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------
DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite:///data/local.db")

# Accept the various Postgres URL forms and force the psycopg2 driver.
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = "postgresql+psycopg2://" + DATABASE_URL[len("postgres://"):]
elif DATABASE_URL.startswith("postgresql://"):
    DATABASE_URL = "postgresql+psycopg2://" + DATABASE_URL[len("postgresql://"):]

engine_kwargs = {"pool_pre_ping": True, "future": True}
if DATABASE_URL.startswith("sqlite"):
    engine_kwargs["connect_args"] = {"check_same_thread": False}
    # make sure the folder for the sqlite file exists
    if DATABASE_URL.startswith("sqlite:///"):
        _p = DATABASE_URL[len("sqlite:///"):]
        _d = os.path.dirname(_p)
        if _d and not os.path.exists(_d):
            os.makedirs(_d, exist_ok=True)
else:
    engine_kwargs.update(pool_size=5, max_overflow=5, pool_recycle=1800)

engine = create_engine(DATABASE_URL, **engine_kwargs)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False, future=True)
Base = declarative_base()


def now_utc():
    return datetime.now(timezone.utc)


@contextmanager
def session_scope():
    s = SessionLocal()
    try:
        yield s
        s.commit()
    except Exception:
        s.rollback()
        raise
    finally:
        s.close()


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class User(Base):
    __tablename__ = "users"
    id = mapped_column(Integer, primary_key=True)
    username = mapped_column(String(32), unique=True, nullable=False, index=True)
    display_name = mapped_column(String(64), nullable=False)
    password_hash = mapped_column(String(256), nullable=False)
    avatar_color = mapped_column(String(16), nullable=False)
    avatar_url = mapped_column(Text, nullable=True)
    token_version = mapped_column(Integer, nullable=False, default=0)
    privacy = mapped_column(Text, nullable=True)
    created_at = mapped_column(DateTime(timezone=True), default=now_utc)
    last_seen = mapped_column(DateTime(timezone=True), nullable=True)


class Friendship(Base):
    __tablename__ = "friendships"
    id = mapped_column(Integer, primary_key=True)
    requester_id = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    addressee_id = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    status = mapped_column(String(16), nullable=False, default="pending")  # pending | accepted
    created_at = mapped_column(DateTime(timezone=True), default=now_utc)
    __table_args__ = (UniqueConstraint("requester_id", "addressee_id", name="uq_friend_pair"),)


class Conversation(Base):
    __tablename__ = "conversations"
    id = mapped_column(Integer, primary_key=True)
    user_a = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=True)  # smaller id (1-to-1 only)
    user_b = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=True)  # larger id (1-to-1 only)
    is_group = mapped_column(Boolean, nullable=False, default=False)
    name = mapped_column(Text, nullable=True)            # group name
    avatar_url = mapped_column(Text, nullable=True)      # group photo
    avatar_color = mapped_column(String(16), nullable=True)
    owner_id = mapped_column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    description = mapped_column(Text, nullable=True)
    pinned_message_id = mapped_column(Integer, nullable=True)
    created_at = mapped_column(DateTime(timezone=True), default=now_utc)
    __table_args__ = (UniqueConstraint("user_a", "user_b", name="uq_conv_pair"),)


class ConversationMember(Base):
    __tablename__ = "conversation_members"
    conversation_id = mapped_column(Integer, ForeignKey("conversations.id", ondelete="CASCADE"), primary_key=True)
    user_id = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    joined_at = mapped_column(DateTime(timezone=True), default=now_utc)


class Message(Base):
    __tablename__ = "messages"
    id = mapped_column(Integer, primary_key=True)
    conversation_id = mapped_column(Integer, ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False)
    sender_id = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    body = mapped_column(Text, nullable=True)
    attachment_url = mapped_column(Text, nullable=True)
    attachment_type = mapped_column(String(16), nullable=True)   # image | video | file
    attachment_name = mapped_column(Text, nullable=True)
    unsent = mapped_column(Boolean, nullable=False, default=False)
    edited = mapped_column(Boolean, nullable=False, default=False)
    consumed = mapped_column(Boolean, nullable=False, default=False)
    reply_to_id = mapped_column(Integer, ForeignKey("messages.id", ondelete="SET NULL"), nullable=True)
    created_at = mapped_column(DateTime(timezone=True), default=now_utc)
    __table_args__ = (Index("idx_messages_conv", "conversation_id", "id"),)


class MessageRead(Base):
    __tablename__ = "message_reads"
    conversation_id = mapped_column(Integer, primary_key=True)
    user_id = mapped_column(Integer, primary_key=True)
    last_read_message_id = mapped_column(Integer, nullable=False, default=0)


class MessageDelivery(Base):
    __tablename__ = "message_delivery"
    conversation_id = mapped_column(Integer, primary_key=True)
    user_id = mapped_column(Integer, primary_key=True)
    last_delivered_message_id = mapped_column(Integer, nullable=False, default=0)


class MessageReaction(Base):
    __tablename__ = "message_reactions"
    id = mapped_column(Integer, primary_key=True)
    message_id = mapped_column(Integer, ForeignKey("messages.id", ondelete="CASCADE"), nullable=False)
    user_id = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    emoji = mapped_column(String(16), nullable=False)
    created_at = mapped_column(DateTime(timezone=True), default=now_utc)
    __table_args__ = (UniqueConstraint("message_id", "user_id", name="uq_reaction_user"),)


class PushSubscription(Base):
    __tablename__ = "push_subscriptions"
    id = mapped_column(Integer, primary_key=True)
    user_id = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    endpoint = mapped_column(Text, nullable=False, unique=True)
    p256dh = mapped_column(Text, nullable=False)
    auth = mapped_column(Text, nullable=False)
    created_at = mapped_column(DateTime(timezone=True), default=now_utc)


class AppConfig(Base):
    __tablename__ = "app_config"
    key = mapped_column(String(64), primary_key=True)
    value = mapped_column(Text, nullable=False)


class FriendNickname(Base):
    __tablename__ = "friend_nicknames"
    owner_id = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    friend_id = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    nickname = mapped_column(Text, nullable=False)


class ConversationPref(Base):
    __tablename__ = "conversation_prefs"
    id = mapped_column(Integer, primary_key=True)
    user_id = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    conversation_id = mapped_column(Integer, ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False)
    pinned = mapped_column(Boolean, nullable=False, default=False)
    muted = mapped_column(Boolean, nullable=False, default=False)
    __table_args__ = (UniqueConstraint("user_id", "conversation_id", name="uq_conv_pref"),)


class Block(Base):
    __tablename__ = "blocks"
    id = mapped_column(Integer, primary_key=True)
    blocker_id = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    blocked_id = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    created_at = mapped_column(DateTime(timezone=True), default=now_utc)
    __table_args__ = (UniqueConstraint("blocker_id", "blocked_id", name="uq_block_pair"),)


class Follow(Base):
    __tablename__ = "follows"
    follower_id = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    followee_id = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    created_at = mapped_column(DateTime(timezone=True), default=now_utc)


class Reel(Base):
    __tablename__ = "reels"
    id = mapped_column(Integer, primary_key=True)
    user_id = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    video_url = mapped_column(Text, nullable=False)
    caption = mapped_column(Text, nullable=True)
    views = mapped_column(Integer, nullable=False, default=0)
    created_at = mapped_column(DateTime(timezone=True), default=now_utc)


class ReelLike(Base):
    __tablename__ = "reel_likes"
    reel_id = mapped_column(Integer, ForeignKey("reels.id", ondelete="CASCADE"), primary_key=True)
    user_id = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    created_at = mapped_column(DateTime(timezone=True), default=now_utc)


class ReelComment(Base):
    __tablename__ = "reel_comments"
    id = mapped_column(Integer, primary_key=True)
    reel_id = mapped_column(Integer, ForeignKey("reels.id", ondelete="CASCADE"), nullable=False)
    user_id = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    text = mapped_column(Text, nullable=False)
    created_at = mapped_column(DateTime(timezone=True), default=now_utc)


class Story(Base):
    __tablename__ = "stories"
    id = mapped_column(Integer, primary_key=True)
    user_id = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    media_url = mapped_column(Text, nullable=True)
    media_type = mapped_column(String(16), nullable=False)  # image | video | text
    caption = mapped_column(Text, nullable=True)
    text = mapped_column(Text, nullable=True)
    bg_color = mapped_column(String(32), nullable=True)
    created_at = mapped_column(DateTime(timezone=True), default=now_utc)
    expires_at = mapped_column(DateTime(timezone=True), nullable=False)
    view_count = mapped_column(Integer, nullable=False, default=0)
    __table_args__ = (Index("idx_stories_user_expires", "user_id", "expires_at"),)


class StoryView(Base):
    __tablename__ = "story_views"
    id = mapped_column(Integer, primary_key=True)
    story_id = mapped_column(Integer, ForeignKey("stories.id", ondelete="CASCADE"), nullable=False)
    viewer_id = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    viewed_at = mapped_column(DateTime(timezone=True), default=now_utc)
    __table_args__ = (UniqueConstraint("story_id", "viewer_id", name="uq_story_view"),)


class Note(Base):
    __tablename__ = "notes"
    user_id = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    text = mapped_column(Text, nullable=False)
    music = mapped_column(Text, nullable=True)   # JSON: {title, artist, art, url}
    created_at = mapped_column(DateTime(timezone=True), default=now_utc)
    expires_at = mapped_column(DateTime(timezone=True), nullable=False)


NOTE_TTL_HOURS = 24


def get_user_note(uid):
    with session_scope() as s:
        n = s.get(Note, uid)
        if n and n.expires_at > now_utc():
            return {"id": n.user_id, "text": n.text, "music": n.music, "createdAt": _iso(n.created_at)}
        return None


def set_note(user_id, text, music=None):
    """Set (or replace) the user's 24h note (optional attached song)."""
    music_json = json.dumps(music) if music else None
    expires = now_utc() + timedelta(hours=NOTE_TTL_HOURS)
    with session_scope() as s:
        n = s.get(Note, user_id)
        if n:
            n.text = text
            n.music = music_json
            n.created_at = now_utc()
            n.expires_at = expires
        else:
            s.add(Note(user_id=user_id, text=text, music=music_json, created_at=now_utc(), expires_at=expires))


def clear_note(user_id):
    with session_scope() as s:
        n = s.get(Note, user_id)
        if n:
            s.delete(n)


def init_db():
    Base.metadata.create_all(engine)
    # Migrate existing tables (safe to run multiple times)
    try:
        with engine.connect() as c:
            c.execute(text("ALTER TABLE stories ADD COLUMN text TEXT"))
            c.commit()
    except Exception:
        pass
    try:
        with engine.connect() as c:
            c.execute(text("ALTER TABLE stories ADD COLUMN bg_color VARCHAR(32)"))
            c.commit()
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Serializers
# ---------------------------------------------------------------------------
def _iso(dt):
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


def public_user(u):
    if not u:
        return None
    return {
        "id": u.id,
        "username": u.username,
        "displayName": u.display_name,
        "avatarColor": u.avatar_color,
        "avatarUrl": u.avatar_url,
        "lastSeen": _iso(u.last_seen),
    }


def public_message(m):
    if not m:
        return None
    return {
        "id": m.id,
        "conversationId": m.conversation_id,
        "senderId": m.sender_id,
        "body": m.body,
        "attachmentUrl": m.attachment_url,
        "attachmentType": m.attachment_type,
        "attachmentName": m.attachment_name,
        "unsent": bool(m.unsent),
        "edited": bool(m.edited),
        "createdAt": _iso(m.created_at),
        "reactions": [],
        "replyTo": None,
    }


def _msg_preview(m):
    if m.unsent:
        return "unsent a message"
    if m.attachment_type == "image":
        return "📷 Photo"
    if m.attachment_type == "video":
        return "🎥 Video"
    if m.attachment_type == "audio":
        return "🎤 Voice message"
    if m.attachment_type == "file":
        return "📎 " + (m.attachment_name or "File")
    return (m.body or "")[:80]


# ---------------------------------------------------------------------------
# Users
# ---------------------------------------------------------------------------
def create_user(username, display_name, password_hash, avatar_color):
    with session_scope() as s:
        u = User(username=username, display_name=display_name,
                 password_hash=password_hash, avatar_color=avatar_color, created_at=now_utc())
        s.add(u)
        s.flush()
        return public_user(u)


def auth_user(uid):
    """For token validation: returns {user: public_user, tv: token_version} or None."""
    with session_scope() as s:
        u = s.get(User, uid)
        if not u:
            return None
        return {"user": public_user(u), "tv": int(u.token_version or 0)}


def get_token_version(uid):
    with session_scope() as s:
        u = s.get(User, uid)
        return int(u.token_version or 0) if u else 0


def bump_token_version(uid):
    """Invalidate every existing token for this user (log out all devices)."""
    with session_scope() as s:
        u = s.get(User, uid)
        if not u:
            return 0
        u.token_version = (u.token_version or 0) + 1
        return int(u.token_version)


def set_password(uid, password_hash):
    """Set a new password hash and bump token_version (revokes other sessions)."""
    with session_scope() as s:
        u = s.get(User, uid)
        if not u:
            return False
        u.password_hash = password_hash
        u.token_version = (u.token_version or 0) + 1
        return True


def get_user_by_id(uid):
    with session_scope() as s:
        return public_user(s.get(User, uid))


def get_auth_user(username):
    """Returns dict including password_hash, for login only."""
    with session_scope() as s:
        u = s.execute(select(User).where(User.username == username)).scalar_one_or_none()
        if not u:
            return None
        d = public_user(u)
        d["passwordHash"] = u.password_hash
        return d


def username_exists(username):
    with session_scope() as s:
        return s.execute(select(User.id).where(User.username == username)).first() is not None


def set_last_seen(uid, when=None):
    with session_scope() as s:
        u = s.get(User, uid)
        if u:
            u.last_seen = when or now_utc()


def update_user(uid, display_name, username, avatar_url=None, set_avatar=False):
    with session_scope() as s:
        u = s.get(User, uid)
        if not u:
            return None
        u.display_name = display_name
        u.username = username
        if set_avatar:
            u.avatar_url = avatar_url or None
        s.flush()
        return public_user(u)


def search_users(me_id, query):
    like = f"%{query}%"
    with session_scope() as s:
        rows = s.execute(
            select(User)
            .where(User.id != me_id)
            .where(or_(User.username.ilike(like), User.display_name.ilike(like)))
            .order_by(User.display_name)
            .limit(25)
        ).scalars().all()
        return [public_user(u) for u in rows]


# ---------------------------------------------------------------------------
# Friendships
# ---------------------------------------------------------------------------
def _friendship_dict(f):
    if not f:
        return None
    return {
        "id": f.id,
        "requester_id": f.requester_id,
        "addressee_id": f.addressee_id,
        "status": f.status,
    }


def find_friendship(a, b):
    with session_scope() as s:
        f = s.execute(
            select(Friendship).where(
                or_(
                    (Friendship.requester_id == a) & (Friendship.addressee_id == b),
                    (Friendship.requester_id == b) & (Friendship.addressee_id == a),
                )
            )
        ).scalar_one_or_none()
        return _friendship_dict(f)


def create_friend_request(requester_id, addressee_id):
    with session_scope() as s:
        f = Friendship(requester_id=requester_id, addressee_id=addressee_id,
                       status="pending", created_at=now_utc())
        s.add(f)
        s.flush()
        return _friendship_dict(f)


def get_friendship_by_id(fid):
    with session_scope() as s:
        return _friendship_dict(s.get(Friendship, fid))


def accept_friendship(fid):
    with session_scope() as s:
        f = s.get(Friendship, fid)
        if f:
            f.status = "accepted"


def delete_friendship(fid):
    with session_scope() as s:
        f = s.get(Friendship, fid)
        if f:
            s.delete(f)


def remove_friend(me_id, other_id):
    with session_scope() as s:
        f = s.execute(
            select(Friendship).where(
                or_(
                    (Friendship.requester_id == me_id) & (Friendship.addressee_id == other_id),
                    (Friendship.requester_id == other_id) & (Friendship.addressee_id == me_id),
                )
            )
        ).scalar_one_or_none()
        if f:
            s.delete(f)


def list_friends(me_id):
    with session_scope() as s:
        rows = s.execute(
            select(Friendship).where(
                Friendship.status == "accepted",
                or_(Friendship.requester_id == me_id, Friendship.addressee_id == me_id),
            )
        ).scalars().all()
        out = []
        for f in rows:
            other = f.addressee_id if f.requester_id == me_id else f.requester_id
            u = s.get(User, other)
            if u:
                out.append(public_user(u))
        out.sort(key=lambda x: (x["displayName"] or "").lower())
        return out


def incoming_requests(me_id):
    with session_scope() as s:
        rows = s.execute(
            select(Friendship).where(Friendship.addressee_id == me_id, Friendship.status == "pending")
            .order_by(Friendship.created_at.desc())
        ).scalars().all()
        out = []
        for f in rows:
            u = s.get(User, f.requester_id)
            if u:
                d = public_user(u)
                d["requestId"] = f.id
                out.append(d)
        return out


def outgoing_requests(me_id):
    with session_scope() as s:
        rows = s.execute(
            select(Friendship).where(Friendship.requester_id == me_id, Friendship.status == "pending")
            .order_by(Friendship.created_at.desc())
        ).scalars().all()
        out = []
        for f in rows:
            u = s.get(User, f.addressee_id)
            if u:
                d = public_user(u)
                d["requestId"] = f.id
                out.append(d)
        return out


def relationship(me_id, other_id):
    if me_id == other_id:
        return "self"
    f = find_friendship(me_id, other_id)
    if not f:
        return "none"
    if f["status"] == "accepted":
        return "friends"
    return "outgoing" if f["requester_id"] == me_id else "incoming"


# ---------------------------------------------------------------------------
# Conversations
# ---------------------------------------------------------------------------
def _conv_dict(c):
    if not c:
        return None
    return {
        "id": c.id, "user_a": c.user_a, "user_b": c.user_b,
        "is_group": bool(c.is_group), "name": c.name,
        "avatar_url": c.avatar_url, "avatar_color": c.avatar_color,
        "owner_id": c.owner_id, "created_at": _iso(c.created_at),
    }


def get_or_create_conversation(u1, u2):
    a, b = min(u1, u2), max(u1, u2)
    with session_scope() as s:
        c = s.execute(select(Conversation).where(Conversation.user_a == a, Conversation.user_b == b)).scalar_one_or_none()
        if c:
            return _conv_dict(c)
        c = Conversation(user_a=a, user_b=b, created_at=now_utc())
        s.add(c)
        try:
            s.flush()
        except IntegrityError:
            s.rollback()
            c = s.execute(select(Conversation).where(Conversation.user_a == a, Conversation.user_b == b)).scalar_one()
        return _conv_dict(c)


def get_conversation_by_id(cid):
    with session_scope() as s:
        return _conv_dict(s.get(Conversation, cid))


def conversation_partner_id(conv, me_id):
    if not conv or conv.get("is_group"):
        return None
    return conv["user_b"] if conv["user_a"] == me_id else conv["user_a"]


def conversation_member_ids(conv):
    """All user ids that should receive events for this conversation."""
    if not conv:
        return []
    if conv.get("is_group"):
        with session_scope() as s:
            rows = s.execute(
                select(ConversationMember.user_id).where(
                    ConversationMember.conversation_id == conv["id"]
                )
            ).scalars().all()
            return list(rows)
    return [conv["user_a"], conv["user_b"]]


def is_conversation_member(conv, uid):
    if not conv:
        return False
    if conv.get("is_group"):
        with session_scope() as s:
            row = s.get(ConversationMember, (conv["id"], uid))
            return row is not None
    return conv["user_a"] == uid or conv["user_b"] == uid


# ---------------------------------------------------------------------------
# Group conversations
# ---------------------------------------------------------------------------
def create_group(owner_id, name, member_ids):
    name = (name or "").strip()[:60] or "Group"
    ids = [owner_id] + [int(i) for i in member_ids if int(i) != owner_id]
    ids = list(dict.fromkeys(ids))  # de-dupe, keep order
    with session_scope() as s:
        c = Conversation(is_group=True, name=name, owner_id=owner_id,
                         avatar_color=_pick_color(name), created_at=now_utc())
        s.add(c)
        s.flush()
        for uid in ids:
            s.add(ConversationMember(conversation_id=c.id, user_id=uid, joined_at=now_utc()))
        s.flush()
        return _conv_dict(c)


def _pick_color(seed):
    palette = ["#0a7cff", "#7c4dff", "#ff4d8d", "#ff7a00", "#00b894", "#e84393", "#0984e3", "#6c5ce7"]
    h = sum(ord(ch) for ch in (seed or "G"))
    return palette[h % len(palette)]


def group_member_users(conversation_id):
    with session_scope() as s:
        rows = s.execute(
            select(User).join(ConversationMember, ConversationMember.user_id == User.id)
            .where(ConversationMember.conversation_id == conversation_id)
            .order_by(User.display_name)
        ).scalars().all()
        return [public_user(u) for u in rows]


def add_group_members(conversation_id, member_ids):
    added = []
    with session_scope() as s:
        for uid in member_ids:
            uid = int(uid)
            if not s.get(ConversationMember, (conversation_id, uid)):
                s.add(ConversationMember(conversation_id=conversation_id, user_id=uid, joined_at=now_utc()))
                added.append(uid)
    return added


def remove_group_member(conversation_id, user_id):
    with session_scope() as s:
        s.execute(delete(ConversationMember).where(
            ConversationMember.conversation_id == conversation_id,
            ConversationMember.user_id == user_id,
        ))


def update_group(conversation_id, name=None, avatar_url=None, set_avatar=False):
    with session_scope() as s:
        c = s.get(Conversation, conversation_id)
        if not c or not c.is_group:
            return None
        if name is not None:
            c.name = name.strip()[:60] or c.name
        if set_avatar:
            c.avatar_url = avatar_url or None
        s.flush()
        return _conv_dict(c)


def public_conversation_meta(conv, me_id):
    """Serialize a group's display info for the client."""
    if not conv or not conv.get("is_group"):
        return None
    members = group_member_users(conv["id"])
    return {
        "id": conv["id"],
        "isGroup": True,
        "name": conv["name"],
        "avatarUrl": conv["avatar_url"],
        "avatarColor": conv["avatar_color"] or "#0a7cff",
        "ownerId": conv["owner_id"],
        "members": members,
        "memberCount": len(members),
    }


# ---------------------------------------------------------------------------
# Messages
# ---------------------------------------------------------------------------
def create_message(conversation_id, sender_id, body=None,
                   attachment_url=None, attachment_type=None, attachment_name=None,
                   reply_to_id=None):
    with session_scope() as s:
        m = Message(
            conversation_id=conversation_id, sender_id=sender_id,
            body=body or None, attachment_url=attachment_url or None,
            attachment_type=attachment_type or None, attachment_name=attachment_name or None,
            reply_to_id=reply_to_id or None,
            created_at=now_utc(),
        )
        s.add(m)
        s.flush()
        d = public_message(m)
        if reply_to_id:
            o = s.get(Message, reply_to_id)
            if o:
                d["replyTo"] = {"id": o.id, "senderId": o.sender_id, "preview": _msg_preview(o)}
        return d


def get_messages(conversation_id, before_id=None, limit=40):
    """Return up to ``limit`` messages (ascending). With ``before_id``, returns the
    page of messages immediately older than that id (for lazy-loading history)."""
    with session_scope() as s:
        q = select(Message).where(Message.conversation_id == conversation_id)
        if before_id:
            q = q.where(Message.id < before_id)
        # take the newest `limit`, then flip back to chronological order
        rows = s.execute(q.order_by(Message.id.desc()).limit(limit)).scalars().all()
        rows = list(reversed(rows))
        msgs = [public_message(m) for m in rows]
        ids = [m["id"] for m in msgs]
        if ids:
            rx = s.execute(
                select(MessageReaction).where(MessageReaction.message_id.in_(ids))
            ).scalars().all()
            bucket = {}
            for r in rx:
                bucket.setdefault(r.message_id, []).append({"emoji": r.emoji, "userId": r.user_id})
            for m in msgs:
                m["reactions"] = bucket.get(m["id"], [])
        reply_ids = {r.reply_to_id for r in rows if r.reply_to_id}
        if reply_ids:
            originals = s.execute(
                select(Message).where(Message.id.in_(reply_ids))
            ).scalars().all()
            omap = {o.id: o for o in originals}
            for md, mr in zip(msgs, rows):
                if mr.reply_to_id and mr.reply_to_id in omap:
                    o = omap[mr.reply_to_id]
                    md["replyTo"] = {"id": o.id, "senderId": o.sender_id, "preview": _msg_preview(o)}
        return msgs


def get_last_message(conversation_id):
    with session_scope() as s:
        m = s.execute(
            select(Message).where(Message.conversation_id == conversation_id)
            .order_by(Message.id.desc()).limit(1)
        ).scalar_one_or_none()
        return public_message(m)


def set_pinned_message(conversation_id, message_id):
    """Pin (or unpin with None) a message in a conversation. Validates the message
    belongs to the conversation. Returns the pinned public_message or None."""
    with session_scope() as s:
        conv = s.get(Conversation, conversation_id)
        if not conv:
            return None
        if message_id:
            m = s.get(Message, message_id)
            if not m or m.conversation_id != conversation_id or m.unsent:
                return None
            conv.pinned_message_id = message_id
            return public_message(m)
        conv.pinned_message_id = None
        return None


def get_pinned_message(conversation_id):
    """Return the pinned public_message, or None if unset / already expired."""
    with session_scope() as s:
        conv = s.get(Conversation, conversation_id)
        if not conv or not conv.pinned_message_id:
            return None
        m = s.get(Message, conv.pinned_message_id)
        if not m or m.unsent:
            conv.pinned_message_id = None  # clean up a dangling pin
            return None
        return public_message(m)


def get_message_meta(message_id):
    """Lightweight lookup for ownership / routing checks. Returns dict or None."""
    with session_scope() as s:
        m = s.get(Message, message_id)
        if not m:
            return None
        return {"id": m.id, "senderId": m.sender_id, "conversationId": m.conversation_id}


def delete_message(message_id):
    with session_scope() as s:
        m = s.get(Message, message_id)
        if m:
            s.delete(m)  # reactions cascade-delete via FK


def unsend_message(message_id):
    """Soft-delete: keep the row as an 'unsent' tombstone but wipe its content."""
    with session_scope() as s:
        m = s.get(Message, message_id)
        if not m:
            return
        m.unsent = True
        m.body = None
        m.attachment_url = None
        m.attachment_type = None
        m.attachment_name = None
        for r in s.execute(
            select(MessageReaction).where(MessageReaction.message_id == message_id)
        ).scalars().all():
            s.delete(r)


def edit_message(message_id, new_body):
    with session_scope() as s:
        m = s.get(Message, message_id)
        if not m or m.unsent:
            return
        m.body = new_body
        m.edited = True


def delete_conversation_messages(conversation_id):
    with session_scope() as s:
        for m in s.execute(
            select(Message).where(Message.conversation_id == conversation_id)
        ).scalars().all():
            s.delete(m)
        for mr in s.execute(
            select(MessageRead).where(MessageRead.conversation_id == conversation_id)
        ).scalars().all():
            s.delete(mr)


def toggle_reaction(message_id, user_id, emoji):
    """One reaction per user per message: same emoji toggles off, a different one
    replaces it. Returns the updated reaction list for the message."""
    with session_scope() as s:
        existing = s.execute(
            select(MessageReaction).where(
                MessageReaction.message_id == message_id,
                MessageReaction.user_id == user_id,
            )
        ).scalar_one_or_none()
        if existing:
            if existing.emoji == emoji:
                s.delete(existing)
            else:
                existing.emoji = emoji
        else:
            s.add(MessageReaction(message_id=message_id, user_id=user_id,
                                  emoji=emoji, created_at=now_utc()))
        s.flush()
        rows = s.execute(
            select(MessageReaction).where(MessageReaction.message_id == message_id)
        ).scalars().all()
        return [{"emoji": r.emoji, "userId": r.user_id} for r in rows]


# ---------------------------------------------------------------------------
# Read receipts
# ---------------------------------------------------------------------------
def mark_read(conversation_id, user_id, last_message_id):
    with session_scope() as s:
        mr = s.get(MessageRead, (conversation_id, user_id))
        if mr:
            if last_message_id > mr.last_read_message_id:
                mr.last_read_message_id = last_message_id
        else:
            s.add(MessageRead(conversation_id=conversation_id, user_id=user_id,
                              last_read_message_id=last_message_id))


def get_last_read(conversation_id, user_id):
    with session_scope() as s:
        mr = s.get(MessageRead, (conversation_id, user_id))
        return mr.last_read_message_id if mr else 0


# ---------------------------------------------------------------------------
# Delivery receipts (✓ sent · ✓✓ delivered · ✓✓ seen)
# ---------------------------------------------------------------------------
def get_last_delivered(conversation_id, user_id):
    with session_scope() as s:
        md = s.get(MessageDelivery, (conversation_id, user_id))
        return md.last_delivered_message_id if md else 0


def mark_conversation_delivered(conversation_id, user_id):
    """Mark the latest inbound message in this conversation as delivered to
    ``user_id``. Returns the new last-delivered id (0 if nothing to deliver)."""
    with session_scope() as s:
        latest = s.execute(
            select(func.max(Message.id)).where(
                Message.conversation_id == conversation_id,
                Message.sender_id != user_id,
            )
        ).scalar()
        if not latest:
            return 0
        md = s.get(MessageDelivery, (conversation_id, user_id))
        if md:
            if latest > md.last_delivered_message_id:
                md.last_delivered_message_id = latest
        else:
            s.add(MessageDelivery(conversation_id=conversation_id, user_id=user_id,
                                  last_delivered_message_id=latest))
        return latest


def deliver_all_pending(user_id):
    """When ``user_id`` comes online, mark every conversation's latest inbound
    message as delivered. Returns a list of
    {conversationId, partnerId, lastDeliveredMessageId} for the conversations
    that changed, so the senders can be told their messages were delivered."""
    changed = []
    with session_scope() as s:
        convs = s.execute(
            select(Conversation).where(
                or_(Conversation.user_a == user_id, Conversation.user_b == user_id)
            )
        ).scalars().all()
        for c in convs:
            partner_id = c.user_b if c.user_a == user_id else c.user_a
            latest = s.execute(
                select(func.max(Message.id)).where(
                    Message.conversation_id == c.id,
                    Message.sender_id != user_id,
                )
            ).scalar()
            if not latest:
                continue
            md = s.get(MessageDelivery, (c.id, user_id))
            if md:
                if latest > md.last_delivered_message_id:
                    md.last_delivered_message_id = latest
                else:
                    continue
            else:
                s.add(MessageDelivery(conversation_id=c.id, user_id=user_id,
                                      last_delivered_message_id=latest))
            changed.append({"conversationId": c.id, "partnerId": partner_id,
                            "lastDeliveredMessageId": latest})
    return changed


def unread_count(conversation_id, user_id):
    last_read = get_last_read(conversation_id, user_id)
    with session_scope() as s:
        n = s.execute(
            select(func.count(Message.id)).where(
                Message.conversation_id == conversation_id,
                Message.sender_id != user_id,
                Message.id > last_read,
            )
        ).scalar_one()
        return int(n or 0)


def total_unread(user_id):
    """Total unread messages across every conversation the user belongs to
    (used for the app-icon badge)."""
    with session_scope() as s:
        direct_ids = s.execute(
            select(Conversation.id).where(
                or_(Conversation.user_a == user_id, Conversation.user_b == user_id)
            )
        ).scalars().all()
        group_ids = s.execute(
            select(ConversationMember.conversation_id).where(ConversationMember.user_id == user_id)
        ).scalars().all()
        conv_ids = list(direct_ids) + list(group_ids)
        if not conv_ids:
            return 0
        mr = aliased(MessageRead)
        n = s.execute(
            select(func.count(Message.id))
            .join(mr, and_(mr.conversation_id == Message.conversation_id, mr.user_id == user_id), isouter=True)
            .where(
                Message.conversation_id.in_(conv_ids),
                Message.sender_id != user_id,
                Message.id > func.coalesce(mr.last_read_message_id, 0),
            )
        ).scalar()
        return int(n or 0)


def list_conversations(me_id):
    # All data is gathered with a handful of batched queries in ONE session
    # (instead of several queries per conversation) so the chat list loads fast.
    with session_scope() as s:
        direct = s.execute(
            select(Conversation).where(or_(Conversation.user_a == me_id, Conversation.user_b == me_id))
        ).scalars().all()
        group_convs = s.execute(
            select(Conversation).join(ConversationMember, ConversationMember.conversation_id == Conversation.id)
            .where(ConversationMember.user_id == me_id, Conversation.is_group == True)  # noqa: E712
        ).scalars().all()
        all_convs = list(direct) + list(group_convs)
        conv_ids = [c.id for c in all_convs]
        if not conv_ids:
            return []

        # pin / mute prefs (1 query)
        prefs = {
            p.conversation_id: {"pinned": bool(p.pinned), "muted": bool(p.muted)}
            for p in s.execute(
                select(ConversationPref).where(ConversationPref.user_id == me_id)
            ).scalars().all()
        }

        # last message per conversation (1 query, DISTINCT ON)
        last_by_conv = {
            m.conversation_id: m
            for m in s.execute(
                select(Message).where(Message.conversation_id.in_(conv_ids))
                .order_by(Message.conversation_id, Message.id.desc())
                .distinct(Message.conversation_id)
            ).scalars().all()
        }

        # unread count per conversation for me (1 query, joined to my read marker)
        mr = aliased(MessageRead)
        unread_by_conv = {
            cid: int(cnt)
            for cid, cnt in s.execute(
                select(Message.conversation_id, func.count(Message.id))
                .join(mr, and_(mr.conversation_id == Message.conversation_id, mr.user_id == me_id), isouter=True)
                .where(
                    Message.conversation_id.in_(conv_ids),
                    Message.sender_id != me_id,
                    Message.id > func.coalesce(mr.last_read_message_id, 0),
                )
                .group_by(Message.conversation_id)
            ).all()
        }

        # partner users for 1-to-1 chats (1 query)
        partner_ids = [conversation_partner_id(_conv_dict(c), me_id) for c in direct]
        users_by_id = {
            u.id: public_user(u)
            for u in s.execute(
                select(User).where(User.id.in_([p for p in partner_ids if p]))
            ).scalars().all()
        }

        result = []
        for c in all_convs:
            conv = _conv_dict(c)
            cid = conv["id"]
            is_group = conv.get("is_group")
            m = last_by_conv.get(cid)
            last = public_message(m) if m else None
            if not last and not is_group:
                continue  # hide empty 1-to-1 conversations
            pref = prefs.get(cid, {})
            entry = {
                "id": cid,
                "isGroup": bool(is_group),
                "lastMessage": last,
                "unread": unread_by_conv.get(cid, 0),
                "pinned": bool(pref.get("pinned")),
                "muted": bool(pref.get("muted")),
                "_sort": (last["createdAt"] if last else conv.get("created_at")) or "",
            }
            if is_group:
                entry["group"] = public_conversation_meta(conv, me_id)
            else:
                entry["friend"] = users_by_id.get(conversation_partner_id(conv, me_id))
            result.append(entry)

    # pinned conversations float to the top, then most-recent first
    result.sort(key=lambda x: (x["pinned"], x["_sort"]), reverse=True)
    for e in result:
        e.pop("_sort", None)
    return result


# ---------------------------------------------------------------------------
# Conversation prefs (pin / mute) & blocking
# ---------------------------------------------------------------------------
def _get_or_make_pref(s, user_id, conversation_id):
    p = s.execute(
        select(ConversationPref).where(
            ConversationPref.user_id == user_id,
            ConversationPref.conversation_id == conversation_id,
        )
    ).scalar_one_or_none()
    if not p:
        p = ConversationPref(user_id=user_id, conversation_id=conversation_id)
        s.add(p)
    return p


def set_conversation_pref(user_id, conversation_id, pinned=None, muted=None):
    """Update pin/mute for one user's view of a conversation. Returns {pinned, muted}."""
    with session_scope() as s:
        p = _get_or_make_pref(s, user_id, conversation_id)
        if pinned is not None:
            p.pinned = bool(pinned)
        if muted is not None:
            p.muted = bool(muted)
        s.flush()
        return {"pinned": bool(p.pinned), "muted": bool(p.muted)}


def is_muted(user_id, conversation_id):
    with session_scope() as s:
        p = s.execute(
            select(ConversationPref.muted).where(
                ConversationPref.user_id == user_id,
                ConversationPref.conversation_id == conversation_id,
            )
        ).scalar_one_or_none()
        return bool(p)


def block_user(blocker_id, blocked_id):
    with session_scope() as s:
        exists = s.execute(
            select(Block).where(Block.blocker_id == blocker_id, Block.blocked_id == blocked_id)
        ).scalar_one_or_none()
        if not exists:
            s.add(Block(blocker_id=blocker_id, blocked_id=blocked_id, created_at=now_utc()))
    return True


def unblock_user(blocker_id, blocked_id):
    with session_scope() as s:
        s.execute(
            delete(Block).where(Block.blocker_id == blocker_id, Block.blocked_id == blocked_id)
        )
    return True


def i_blocked(blocker_id, blocked_id):
    """True if blocker_id has blocked blocked_id."""
    with session_scope() as s:
        row = s.execute(
            select(Block.id).where(Block.blocker_id == blocker_id, Block.blocked_id == blocked_id)
        ).scalar_one_or_none()
        return row is not None


def is_blocked_either(a_id, b_id):
    """True if either user has blocked the other (messaging is disallowed)."""
    with session_scope() as s:
        row = s.execute(
            select(Block.id).where(
                or_(
                    and_(Block.blocker_id == a_id, Block.blocked_id == b_id),
                    and_(Block.blocker_id == b_id, Block.blocked_id == a_id),
                )
            )
        ).first()
        return row is not None


def blocked_ids(me_id):
    """Set of user ids that me_id has blocked."""
    with session_scope() as s:
        rows = s.execute(
            select(Block.blocked_id).where(Block.blocker_id == me_id)
        ).scalars().all()
        return list(rows)


# ---------------------------------------------------------------------------
# Reels (short videos)
# ---------------------------------------------------------------------------
def public_reel(r, author, like_count, liked_by_me, comment_count=0, followed=False):
    return {
        "id": r.id,
        "videoUrl": r.video_url,
        "caption": r.caption or "",
        "author": author,
        "likeCount": int(like_count or 0),
        "likedByMe": bool(liked_by_me),
        "commentCount": int(comment_count or 0),
        "views": int(getattr(r, "views", 0) or 0),
        "followed": bool(followed),
        "createdAt": _iso(r.created_at),
    }


def create_reel(user_id, video_url, caption):
    with session_scope() as s:
        r = Reel(user_id=user_id, video_url=video_url, caption=(caption or None), created_at=now_utc())
        s.add(r)
        s.flush()
        author = public_user(s.get(User, user_id))
        return public_reel(r, author, 0, False)


def list_reels(me_id, before_id=None, limit=10, following_only=False):
    with session_scope() as s:
        q = select(Reel)
        if following_only:
            followee_ids = s.execute(
                select(Follow.followee_id).where(Follow.follower_id == me_id)
            ).scalars().all()
            ids = list(followee_ids) + [me_id]
            q = q.where(Reel.user_id.in_(ids))
        if before_id:
            q = q.where(Reel.id < before_id)
        reels = s.execute(q.order_by(Reel.id.desc()).limit(limit)).scalars().all()
        if not reels:
            return []
        rid_list = [r.id for r in reels]
        uid_list = list({r.user_id for r in reels})
        authors = {
            u.id: public_user(u)
            for u in s.execute(select(User).where(User.id.in_(uid_list))).scalars().all()
        }
        like_counts = dict(s.execute(
            select(ReelLike.reel_id, func.count(ReelLike.user_id))
            .where(ReelLike.reel_id.in_(rid_list)).group_by(ReelLike.reel_id)
        ).all())
        comment_counts = dict(s.execute(
            select(ReelComment.reel_id, func.count(ReelComment.id))
            .where(ReelComment.reel_id.in_(rid_list)).group_by(ReelComment.reel_id)
        ).all())
        my_likes = set(s.execute(
            select(ReelLike.reel_id).where(ReelLike.reel_id.in_(rid_list), ReelLike.user_id == me_id)
        ).scalars().all())
        my_follows = set(s.execute(
            select(Follow.followee_id).where(Follow.follower_id == me_id, Follow.followee_id.in_(uid_list))
        ).scalars().all())
        return [
            public_reel(r, authors.get(r.user_id), like_counts.get(r.id, 0), r.id in my_likes,
                        comment_counts.get(r.id, 0), r.user_id in my_follows)
            for r in reels
        ]


def increment_reel_views(reel_id):
    with session_scope() as s:
        r = s.get(Reel, reel_id)
        if r:
            r.views = (r.views or 0) + 1
            return int(r.views)
        return 0


def add_reel_comment(reel_id, user_id, text):
    with session_scope() as s:
        if not s.get(Reel, reel_id):
            return None
        c = ReelComment(reel_id=reel_id, user_id=user_id, text=text, created_at=now_utc())
        s.add(c)
        s.flush()
        author = public_user(s.get(User, user_id))
        return {
            "id": c.id,
            "text": c.text,
            "author": author,
            "createdAt": _iso(c.created_at),
        }


def list_reel_comments(reel_id):
    with session_scope() as s:
        rows = s.execute(
            select(ReelComment).where(ReelComment.reel_id == reel_id).order_by(ReelComment.id.asc())
        ).scalars().all()
        if not rows:
            return []
        uids = list({c.user_id for c in rows})
        authors = {u.id: public_user(u) for u in s.execute(select(User).where(User.id.in_(uids))).scalars().all()}
        return [{"id": c.id, "text": c.text, "author": authors.get(c.user_id), "createdAt": _iso(c.created_at)} for c in rows]


def delete_reel_comment(comment_id, user_id):
    with session_scope() as s:
        c = s.get(ReelComment, comment_id)
        if not c or c.user_id != user_id:
            return False
        s.delete(c)
        return True


def toggle_follow(follower_id, followee_id):
    if follower_id == followee_id:
        return {"following": False}
    with session_scope() as s:
        existing = s.get(Follow, (follower_id, followee_id))
        if existing:
            s.delete(existing)
            return {"following": False}
        s.add(Follow(follower_id=follower_id, followee_id=followee_id, created_at=now_utc()))
        return {"following": True}


def toggle_reel_like(reel_id, user_id):
    with session_scope() as s:
        existing = s.get(ReelLike, (reel_id, user_id))
        if existing:
            s.delete(existing)
            liked = False
        else:
            s.add(ReelLike(reel_id=reel_id, user_id=user_id, created_at=now_utc()))
            liked = True
        s.flush()
        count = s.execute(
            select(func.count(ReelLike.user_id)).where(ReelLike.reel_id == reel_id)
        ).scalar_one()
        return {"liked": liked, "likeCount": int(count or 0)}


def delete_reel(reel_id, user_id):
    with session_scope() as s:
        r = s.get(Reel, reel_id)
        if not r or r.user_id != user_id:
            return False
        s.delete(r)
        return True


# ---------------------------------------------------------------------------
# Message / Group / Privacy helpers
# ---------------------------------------------------------------------------
def mark_message_consumed(message_id):
    with session_scope() as s:
        m = s.get(Message, message_id)
        if m:
            m.consumed = True


def transfer_group(cid, new_owner_id):
    with session_scope() as s:
        c = s.get(Conversation, cid)
        if c:
            c.owner_id = new_owner_id


def set_group_description(cid, desc):
    with session_scope() as s:
        c = s.get(Conversation, cid)
        if c:
            c.description = desc


def get_read_by(conversation_id):
    with session_scope() as s:
        rows = s.execute(
            select(MessageRead).where(MessageRead.conversation_id == conversation_id)
        ).scalars().all()
        result = []
        for r in rows:
            u = s.get(User, r.user_id)
            if u:
                result.append({"userId": r.user_id, "displayName": u.display_name, "lastReadMessageId": r.last_read_message_id})
        return result


def get_conversation_media(conversation_id):
    with session_scope() as s:
        rows = s.execute(
            select(Message).where(
                Message.conversation_id == conversation_id,
                Message.attachment_type.in_(["image", "video"]),
                Message.unsent == False,
            ).order_by(Message.created_at.desc()).limit(200)
        ).scalars().all()
        return [public_message(m) for m in rows if m.attachment_url]


def set_user_privacy(uid, key, value):
    with session_scope() as s:
        u = s.get(User, uid)
        if u:
            priv = json.loads(u.privacy) if u.privacy else {}
            priv[key] = value
            u.privacy = json.dumps(priv)


# ---------------------------------------------------------------------------
# Push subscriptions & app config
# ---------------------------------------------------------------------------
def get_config(key):
    with session_scope() as s:
        c = s.get(AppConfig, key)
        return c.value if c else None


def set_config(key, value):
    with session_scope() as s:
        c = s.get(AppConfig, key)
        if c:
            c.value = value
        else:
            s.add(AppConfig(key=key, value=value))


def save_push_subscription(user_id, endpoint, p256dh, auth):
    with session_scope() as s:
        existing = s.execute(
            select(PushSubscription).where(PushSubscription.endpoint == endpoint)
        ).scalar_one_or_none()
        if existing:
            existing.user_id = user_id
            existing.p256dh = p256dh
            existing.auth = auth
        else:
            s.add(PushSubscription(user_id=user_id, endpoint=endpoint,
                                   p256dh=p256dh, auth=auth, created_at=now_utc()))


def delete_push_subscription(endpoint):
    with session_scope() as s:
        sub = s.execute(
            select(PushSubscription).where(PushSubscription.endpoint == endpoint)
        ).scalar_one_or_none()
        if sub:
            s.delete(sub)


def get_push_subscriptions(user_id):
    with session_scope() as s:
        rows = s.execute(
            select(PushSubscription).where(PushSubscription.user_id == user_id)
        ).scalars().all()
        return [{"endpoint": r.endpoint, "p256dh": r.p256dh, "auth": r.auth} for r in rows]


def set_nickname(owner_id, friend_id, nickname):
    with session_scope() as s:
        existing = s.get(FriendNickname, (owner_id, friend_id))
        if not nickname:
            if existing:
                s.delete(existing)
            return
        if existing:
            existing.nickname = nickname
        else:
            s.add(FriendNickname(owner_id=owner_id, friend_id=friend_id, nickname=nickname))


def get_nicknames(owner_id):
    with session_scope() as s:
        rows = s.execute(
            select(FriendNickname).where(FriendNickname.owner_id == owner_id)
        ).scalars().all()
        return {r.friend_id: r.nickname for r in rows}


# ---------------------------------------------------------------------------
# Stories (My Day)
# ---------------------------------------------------------------------------
STORY_TTL_HOURS = 24


def create_story(user_id, media_url, media_type, caption=None, text=None, bg_color=None):
    """Create a new story. Returns the story dict."""
    expires = now_utc() + timedelta(hours=STORY_TTL_HOURS)
    with session_scope() as s:
        story = Story(
            user_id=user_id,
            media_url=media_url,
            media_type=media_type,
            caption=caption,
            text=text,
            bg_color=bg_color,
            expires_at=expires,
            created_at=now_utc(),
        )
        s.add(story)
        s.flush()
        return public_story(story)


def public_story(story):
    if not story:
        return None
    return {
        "id": story.id,
        "userId": story.user_id,
        "mediaUrl": story.media_url,
        "mediaType": story.media_type,
        "caption": story.caption,
        "text": story.text or "",
        "bgColor": story.bg_color,
        "createdAt": _iso(story.created_at),
        "expiresAt": _iso(story.expires_at),
        "viewCount": story.view_count,
    }


def get_user_stories(user_id, include_expired=False):
    """Get all stories for a user (non-expired by default)."""
    with session_scope() as s:
        q = select(Story).where(Story.user_id == user_id)
        if not include_expired:
            q = q.where(Story.expires_at > now_utc())
        q = q.order_by(Story.created_at.desc())
        rows = s.execute(q).scalars().all()
        return [public_story(r) for r in rows]


def get_friends_stories(me_id):
    """Get latest story per friend (for the story tray)."""
    with session_scope() as s:
        friend_ids = [f["id"] for f in list_friends(me_id)]
        if not friend_ids:
            return []
        # Subquery: latest non-expired story per friend
        subq = (
            select(Story)
            .where(Story.user_id.in_(friend_ids))
            .where(Story.expires_at > now_utc())
            .order_by(Story.user_id, Story.created_at.desc())
            .distinct(Story.user_id)
        ).subquery()
        rows = s.execute(select(Story).select_from(subq)).scalars().all()
        # Also include my own stories at the front
        my_stories = s.execute(
            select(Story).where(Story.user_id == me_id, Story.expires_at > now_utc())
            .order_by(Story.created_at.desc())
        ).scalars().all()
        all_stories = list(my_stories) + list(rows)
        # Enrich with user info
        user_ids = list({st.user_id for st in all_stories})
        users = {u.id: public_user(u) for u in s.execute(select(User).where(User.id.in_(user_ids))).scalars().all()}
        result = []
        for st in all_stories:
            d = public_story(st)
            d["user"] = users.get(st.user_id)
            result.append(d)
        return result


def get_story_by_id(story_id):
    with session_scope() as s:
        st = s.get(Story, story_id)
        return public_story(st) if st else None


def view_story(story_id, viewer_id):
    """Record a view. Returns True if this is a new view."""
    with session_scope() as s:
        st = s.get(Story, story_id)
        if not st or st.expires_at <= now_utc():
            return False
        existing = s.execute(
            select(StoryView).where(StoryView.story_id == story_id, StoryView.viewer_id == viewer_id)
        ).scalar_one_or_none()
        if existing:
            return False
        s.add(StoryView(story_id=story_id, viewer_id=viewer_id, viewed_at=now_utc()))
        st.view_count = (st.view_count or 0) + 1
        return True


def get_story_viewers(story_id):
    """Get list of users who viewed this story."""
    with session_scope() as s:
        rows = s.execute(
            select(StoryView, User)
            .join(User, User.id == StoryView.viewer_id)
            .where(StoryView.story_id == story_id)
            .order_by(StoryView.viewed_at.desc())
        ).all()
        return [{"viewer": public_user(u), "viewedAt": _iso(sv.viewed_at)} for sv, u in rows]


def delete_story(story_id, user_id):
    """Delete own story."""
    with session_scope() as s:
        st = s.get(Story, story_id)
        if st and st.user_id == user_id:
            s.delete(st)
            return True
        return False


def cleanup_expired_stories():
    """Delete expired stories and their media. Called by cron."""
    with session_scope() as s:
        expired = s.execute(
            select(Story).where(Story.expires_at <= now_utc())
        ).scalars().all()
        count = len(expired)
        for st in expired:
            s.delete(st)
        return count


def status_feed(me_id):
    """Stories from me + my friends in the last 24h, grouped by user (legacy /api/status format)."""
    cutoff = now_utc() - timedelta(hours=24)
    with session_scope() as s:
        fr = s.execute(
            select(Friendship).where(
                or_(Friendship.requester_id == me_id, Friendship.addressee_id == me_id),
                Friendship.status == "accepted",
            )
        ).scalars().all()
        friend_ids = [(f.addressee_id if f.requester_id == me_id else f.requester_id) for f in fr]
        user_ids = list(set(friend_ids) | {me_id})

        rows = s.execute(
            select(Story).where(Story.user_id.in_(user_ids), Story.created_at >= cutoff)
            .order_by(Story.created_at.asc())
        ).scalars().all()
        notes = {
            n.user_id: n
            for n in s.execute(select(Note).where(Note.user_id.in_(user_ids), Note.created_at >= cutoff)).scalars().all()
        }
        active_uids = set(notes.keys()) | {r.user_id for r in rows}
        if not active_uids:
            return []
        sid_list = [r.id for r in rows]
        my_views = set(s.execute(
            select(StoryView.story_id).where(StoryView.story_id.in_(sid_list), StoryView.viewer_id == me_id)
        ).scalars().all()) if sid_list else set()
        authors = {
            u.id: public_user(u)
            for u in s.execute(select(User).where(User.id.in_(active_uids))).scalars().all()
        }
        groups = {}
        for r in rows:
            g = groups.setdefault(r.user_id, {"user": authors.get(r.user_id), "statuses": [], "hasUnseen": False, "_latest": "", "note": None})
            ps = public_story(r)
            ps["seen"] = r.id in my_views
            g["statuses"].append(ps)
            g["_latest"] = ps["createdAt"] or g["_latest"]
            if not ps["seen"] and r.user_id != me_id:
                g["hasUnseen"] = True
        for uid in active_uids:
            g = groups.setdefault(uid, {"user": authors.get(uid), "statuses": [], "hasUnseen": False, "_latest": "", "note": None})
            n = notes.get(uid)
            if n:
                music = None
                if n.music:
                    try:
                        music = json.loads(n.music)
                    except Exception:
                        music = None
                g["note"] = {"text": n.text, "music": music, "createdAt": _iso(n.created_at)}
                if not g["_latest"]:
                    g["_latest"] = _iso(n.created_at)
        result = [g for g in groups.values() if g["user"]]
        result.sort(key=lambda g: g["_latest"], reverse=True)
        result.sort(key=lambda g: (g["user"]["id"] != me_id, not g["hasUnseen"]))
        for g in result:
            g.pop("_latest", None)
        return result
