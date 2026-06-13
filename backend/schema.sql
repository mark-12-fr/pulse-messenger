-- ============================================================================
-- Pulse Messenger — Postgres schema (for Supabase)
--
-- NOTE: You do NOT have to run this manually. The backend calls
-- `db.init_db()` on startup and creates these tables automatically.
-- This file is provided for reference, or if you prefer to create the
-- tables yourself in the Supabase SQL Editor.
-- ============================================================================

CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    username      VARCHAR(40) UNIQUE NOT NULL,
    display_name  VARCHAR(80) NOT NULL,
    password_hash TEXT NOT NULL,
    avatar_color  VARCHAR(16) NOT NULL,
    created_at    TIMESTAMPTZ DEFAULT now(),
    last_seen     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_users_username ON users(username);

CREATE TABLE IF NOT EXISTS friendships (
    id            SERIAL PRIMARY KEY,
    requester_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    addressee_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status        VARCHAR(16) NOT NULL DEFAULT 'pending',
    created_at    TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT uq_friend_pair UNIQUE (requester_id, addressee_id)
);

CREATE TABLE IF NOT EXISTS conversations (
    id          SERIAL PRIMARY KEY,
    user_a      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_b      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT uq_conv_pair UNIQUE (user_a, user_b)
);

CREATE TABLE IF NOT EXISTS messages (
    id              SERIAL PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body            TEXT,
    attachment_url  TEXT,
    attachment_type VARCHAR(16),
    attachment_name TEXT,
    created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);

CREATE TABLE IF NOT EXISTS message_reads (
    conversation_id      INTEGER NOT NULL,
    user_id              INTEGER NOT NULL,
    last_read_message_id INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (conversation_id, user_id)
);
