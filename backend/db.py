"""
Database layer for Pulse Messenger (Flask edition).

Uses SQLAlchemy so the exact same code runs on:
  - SQLite   -> local development / testing   (DATABASE_URL=sqlite:///data/local.db)
  - Postgres -> production on Supabase         (DATABASE_URL=postgresql://...)

All helpers return plain dicts (never live ORM objects), so they are safe to use
from both HTTP request handlers and Socket.IO event handlers.
"""

import os
from contextlib import contextmanager
from datetime import datetime, timezone

from sqlalchemy import (
    create_engine, select, or_, func,
    Integer, String, Text, DateTime, ForeignKey, UniqueConstraint, Index,
)
from sqlalchemy.orm import declarative_base, sessionmaker, mapped_column
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
    username = mapped_column(String(40), unique=True, nullable=False, index=True)
    display_name = mapped_column(String(80), nullable=False)
    password_hash = mapped_column(Text, nullable=False)
    avatar_color = mapped_column(String(16), nullable=False)
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
    user_a = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)  # smaller id
    user_b = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)  # larger id
    created_at = mapped_column(DateTime(timezone=True), default=now_utc)
    __table_args__ = (UniqueConstraint("user_a", "user_b", name="uq_conv_pair"),)


class Message(Base):
    __tablename__ = "messages"
    id = mapped_column(Integer, primary_key=True)
    conversation_id = mapped_column(Integer, ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False)
    sender_id = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    body = mapped_column(Text, nullable=True)
    attachment_url = mapped_column(Text, nullable=True)
    attachment_type = mapped_column(String(16), nullable=True)   # image | video | file
    attachment_name = mapped_column(Text, nullable=True)
    created_at = mapped_column(DateTime(timezone=True), default=now_utc)
    __table_args__ = (Index("idx_messages_conv", "conversation_id", "id"),)


class MessageRead(Base):
    __tablename__ = "message_reads"
    conversation_id = mapped_column(Integer, primary_key=True)
    user_id = mapped_column(Integer, primary_key=True)
    last_read_message_id = mapped_column(Integer, nullable=False, default=0)


class MessageReaction(Base):
    __tablename__ = "message_reactions"
    id = mapped_column(Integer, primary_key=True)
    message_id = mapped_column(Integer, ForeignKey("messages.id", ondelete="CASCADE"), nullable=False)
    user_id = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    emoji = mapped_column(String(16), nullable=False)
    created_at = mapped_column(DateTime(timezone=True), default=now_utc)
    __table_args__ = (UniqueConstraint("message_id", "user_id", name="uq_reaction_user"),)


def init_db():
    Base.metadata.create_all(engine)


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
        "createdAt": _iso(m.created_at),
        "reactions": [],
    }


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
    return {"id": c.id, "user_a": c.user_a, "user_b": c.user_b}


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
    if not conv:
        return None
    return conv["user_b"] if conv["user_a"] == me_id else conv["user_a"]


def is_conversation_member(conv, uid):
    return bool(conv) and (conv["user_a"] == uid or conv["user_b"] == uid)


# ---------------------------------------------------------------------------
# Messages
# ---------------------------------------------------------------------------
def create_message(conversation_id, sender_id, body=None,
                   attachment_url=None, attachment_type=None, attachment_name=None):
    with session_scope() as s:
        m = Message(
            conversation_id=conversation_id, sender_id=sender_id,
            body=body or None, attachment_url=attachment_url or None,
            attachment_type=attachment_type or None, attachment_name=attachment_name or None,
            created_at=now_utc(),
        )
        s.add(m)
        s.flush()
        return public_message(m)


def get_messages(conversation_id):
    with session_scope() as s:
        rows = s.execute(
            select(Message).where(Message.conversation_id == conversation_id)
            .order_by(Message.id.asc()).limit(500)
        ).scalars().all()
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
        return msgs


def get_last_message(conversation_id):
    with session_scope() as s:
        m = s.execute(
            select(Message).where(Message.conversation_id == conversation_id)
            .order_by(Message.id.desc()).limit(1)
        ).scalar_one_or_none()
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


def list_conversations(me_id):
    with session_scope() as s:
        convs = s.execute(
            select(Conversation).where(or_(Conversation.user_a == me_id, Conversation.user_b == me_id))
        ).scalars().all()
        conv_dicts = [_conv_dict(c) for c in convs]

    result = []
    for conv in conv_dicts:
        partner_id = conversation_partner_id(conv, me_id)
        partner = get_user_by_id(partner_id)
        last = get_last_message(conv["id"])
        if not last:
            continue  # hide empty conversations
        result.append({
            "id": conv["id"],
            "friend": partner,
            "lastMessage": last,
            "unread": unread_count(conv["id"], me_id),
        })
    result.sort(key=lambda x: (x["lastMessage"]["createdAt"] or ""), reverse=True)
    return result
