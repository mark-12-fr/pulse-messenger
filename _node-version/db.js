'use strict';

/**
 * Database layer for the Realtime Messenger.
 * Uses Node.js' built-in `node:sqlite` module (no native compilation needed).
 */

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

// Make sure the data directory exists.
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new DatabaseSync(path.join(DATA_DIR, 'messenger.db'));

// Sensible pragmas for a small local app.
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    display_name  TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    avatar_color  TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    last_seen     TEXT
  );

  CREATE TABLE IF NOT EXISTS friendships (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    requester_id  INTEGER NOT NULL,
    addressee_id  INTEGER NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending', -- pending | accepted
    created_at    TEXT NOT NULL,
    UNIQUE (requester_id, addressee_id),
    FOREIGN KEY (requester_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (addressee_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_a      INTEGER NOT NULL,  -- always the smaller user id
    user_b      INTEGER NOT NULL,  -- always the larger user id
    created_at  TEXT NOT NULL,
    UNIQUE (user_a, user_b),
    FOREIGN KEY (user_a) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (user_b) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    sender_id       INTEGER NOT NULL,
    body            TEXT,
    attachment_url  TEXT,
    attachment_type TEXT,   -- image | video | file
    attachment_name TEXT,
    created_at      TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS message_reads (
    conversation_id      INTEGER NOT NULL,
    user_id              INTEGER NOT NULL,
    last_read_message_id INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (conversation_id, user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
`);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const nowISO = () => new Date().toISOString();

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    avatarColor: row.avatar_color,
    lastSeen: row.last_seen,
  };
}

// --- Users -----------------------------------------------------------------
const stmtInsertUser = db.prepare(
  `INSERT INTO users (username, display_name, password_hash, avatar_color, created_at)
   VALUES (?, ?, ?, ?, ?)`
);
const stmtUserById = db.prepare('SELECT * FROM users WHERE id = ?');
const stmtUserByUsername = db.prepare('SELECT * FROM users WHERE username = ?');
const stmtUpdateLastSeen = db.prepare('UPDATE users SET last_seen = ? WHERE id = ?');
const stmtSearchUsers = db.prepare(
  `SELECT * FROM users
   WHERE id != ? AND (username LIKE ? OR display_name LIKE ?)
   ORDER BY display_name LIMIT 25`
);

function createUser({ username, displayName, passwordHash, avatarColor }) {
  const info = stmtInsertUser.run(username, displayName, passwordHash, avatarColor, nowISO());
  return getUserById(Number(info.lastInsertRowid));
}
function getUserById(id) {
  return stmtUserById.get(id);
}
function getUserByUsername(username) {
  return stmtUserByUsername.get(username);
}
function setLastSeen(id, when = nowISO()) {
  stmtUpdateLastSeen.run(when, id);
}
function searchUsers(meId, query) {
  const like = `%${query}%`;
  return stmtSearchUsers.all(meId, like, like);
}

// --- Friendships -----------------------------------------------------------
const stmtFindFriendship = db.prepare(
  `SELECT * FROM friendships
   WHERE (requester_id = ? AND addressee_id = ?)
      OR (requester_id = ? AND addressee_id = ?)`
);
const stmtInsertFriendship = db.prepare(
  `INSERT INTO friendships (requester_id, addressee_id, status, created_at)
   VALUES (?, ?, 'pending', ?)`
);
const stmtFriendshipById = db.prepare('SELECT * FROM friendships WHERE id = ?');
const stmtAcceptFriendship = db.prepare(
  `UPDATE friendships SET status = 'accepted' WHERE id = ?`
);
const stmtDeleteFriendship = db.prepare('DELETE FROM friendships WHERE id = ?');

function findFriendship(a, b) {
  return stmtFindFriendship.get(a, b, b, a);
}
function createFriendRequest(requesterId, addresseeId) {
  const info = stmtInsertFriendship.run(requesterId, addresseeId, nowISO());
  return stmtFriendshipById.get(Number(info.lastInsertRowid));
}
function getFriendshipById(id) {
  return stmtFriendshipById.get(id);
}
function acceptFriendship(id) {
  stmtAcceptFriendship.run(id);
}
function deleteFriendship(id) {
  stmtDeleteFriendship.run(id);
}

const stmtListFriends = db.prepare(
  `SELECT u.* FROM friendships f
   JOIN users u ON u.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END
   WHERE f.status = 'accepted' AND (f.requester_id = ? OR f.addressee_id = ?)
   ORDER BY u.display_name`
);
function listFriends(userId) {
  return stmtListFriends.all(userId, userId, userId);
}

const stmtIncomingRequests = db.prepare(
  `SELECT f.id AS request_id, u.* FROM friendships f
   JOIN users u ON u.id = f.requester_id
   WHERE f.addressee_id = ? AND f.status = 'pending'
   ORDER BY f.created_at DESC`
);
const stmtOutgoingRequests = db.prepare(
  `SELECT f.id AS request_id, u.* FROM friendships f
   JOIN users u ON u.id = f.addressee_id
   WHERE f.requester_id = ? AND f.status = 'pending'
   ORDER BY f.created_at DESC`
);
function incomingRequests(userId) {
  return stmtIncomingRequests.all(userId);
}
function outgoingRequests(userId) {
  return stmtOutgoingRequests.all(userId);
}

/**
 * Describe the relationship between `meId` and another user.
 * Returns: 'self' | 'friends' | 'incoming' | 'outgoing' | 'none'
 */
function relationship(meId, otherId) {
  if (meId === otherId) return 'self';
  const f = findFriendship(meId, otherId);
  if (!f) return 'none';
  if (f.status === 'accepted') return 'friends';
  return f.requester_id === meId ? 'outgoing' : 'incoming';
}

// --- Conversations ---------------------------------------------------------
const stmtFindConversation = db.prepare(
  'SELECT * FROM conversations WHERE user_a = ? AND user_b = ?'
);
const stmtInsertConversation = db.prepare(
  'INSERT INTO conversations (user_a, user_b, created_at) VALUES (?, ?, ?)'
);
const stmtConversationById = db.prepare('SELECT * FROM conversations WHERE id = ?');

function getOrCreateConversation(u1, u2) {
  const a = Math.min(u1, u2);
  const b = Math.max(u1, u2);
  let conv = stmtFindConversation.get(a, b);
  if (!conv) {
    const info = stmtInsertConversation.run(a, b, nowISO());
    conv = stmtConversationById.get(Number(info.lastInsertRowid));
  }
  return conv;
}
function getConversationById(id) {
  return stmtConversationById.get(id);
}
function conversationPartnerId(conv, meId) {
  return conv.user_a === meId ? conv.user_b : conv.user_a;
}
function isConversationMember(conv, userId) {
  return conv && (conv.user_a === userId || conv.user_b === userId);
}

// --- Messages --------------------------------------------------------------
const stmtInsertMessage = db.prepare(
  `INSERT INTO messages (conversation_id, sender_id, body, attachment_url, attachment_type, attachment_name, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);
const stmtMessageById = db.prepare('SELECT * FROM messages WHERE id = ?');
const stmtMessagesByConversation = db.prepare(
  `SELECT * FROM messages WHERE conversation_id = ? ORDER BY id ASC LIMIT 500`
);
const stmtLastMessage = db.prepare(
  `SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1`
);

function createMessage({ conversationId, senderId, body, attachmentUrl, attachmentType, attachmentName }) {
  const info = stmtInsertMessage.run(
    conversationId,
    senderId,
    body || null,
    attachmentUrl || null,
    attachmentType || null,
    attachmentName || null,
    nowISO()
  );
  return stmtMessageById.get(Number(info.lastInsertRowid));
}
function getMessages(conversationId) {
  return stmtMessagesByConversation.all(conversationId);
}
function getLastMessage(conversationId) {
  return stmtLastMessage.get(conversationId);
}

function publicMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    body: row.body,
    attachmentUrl: row.attachment_url,
    attachmentType: row.attachment_type,
    attachmentName: row.attachment_name,
    createdAt: row.created_at,
  };
}

// --- Read receipts ---------------------------------------------------------
const stmtUpsertRead = db.prepare(
  `INSERT INTO message_reads (conversation_id, user_id, last_read_message_id)
   VALUES (?, ?, ?)
   ON CONFLICT(conversation_id, user_id)
   DO UPDATE SET last_read_message_id = MAX(last_read_message_id, excluded.last_read_message_id)`
);
const stmtGetRead = db.prepare(
  'SELECT last_read_message_id FROM message_reads WHERE conversation_id = ? AND user_id = ?'
);
const stmtUnreadCount = db.prepare(
  `SELECT COUNT(*) AS c FROM messages
   WHERE conversation_id = ? AND sender_id != ? AND id > ?`
);

function markRead(conversationId, userId, lastMessageId) {
  stmtUpsertRead.run(conversationId, userId, lastMessageId);
}
function getLastRead(conversationId, userId) {
  const row = stmtGetRead.get(conversationId, userId);
  return row ? row.last_read_message_id : 0;
}
function unreadCount(conversationId, userId) {
  const lastRead = getLastRead(conversationId, userId);
  const row = stmtUnreadCount.get(conversationId, userId, lastRead);
  return row ? row.c : 0;
}

// Conversations list for a user, with partner + last message + unread count.
function listConversations(userId) {
  const rows = db
    .prepare(
      `SELECT * FROM conversations WHERE user_a = ? OR user_b = ?`
    )
    .all(userId, userId);

  const result = [];
  for (const conv of rows) {
    const partnerId = conversationPartnerId(conv, userId);
    const partner = getUserById(partnerId);
    const last = getLastMessage(conv.id);
    if (!last) continue; // hide empty conversations from the chat list
    result.push({
      id: conv.id,
      friend: publicUser(partner),
      lastMessage: publicMessage(last),
      unread: unreadCount(conv.id, userId),
    });
  }
  // Most recent activity first.
  result.sort((x, y) => (y.lastMessage?.createdAt || '').localeCompare(x.lastMessage?.createdAt || ''));
  return result;
}

module.exports = {
  db,
  nowISO,
  publicUser,
  publicMessage,
  // users
  createUser,
  getUserById,
  getUserByUsername,
  setLastSeen,
  searchUsers,
  // friendships
  findFriendship,
  createFriendRequest,
  getFriendshipById,
  acceptFriendship,
  deleteFriendship,
  listFriends,
  incomingRequests,
  outgoingRequests,
  relationship,
  // conversations
  getOrCreateConversation,
  getConversationById,
  conversationPartnerId,
  isConversationMember,
  // messages
  createMessage,
  getMessages,
  getLastMessage,
  // reads
  markRead,
  getLastRead,
  unreadCount,
  listConversations,
};
