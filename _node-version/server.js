'use strict';

/**
 * Realtime Messenger — backend server.
 *
 *  - Express REST API for auth, friends, search, conversations and uploads.
 *  - Socket.io for real-time messaging, presence and typing indicators.
 *  - Storage via the built-in node:sqlite (see db.js).
 */

// Silence only the "SQLite is experimental" warning so the console stays clean.
const _emit = process.emit;
process.emit = function (name, data, ...rest) {
  if (
    name === 'warning' &&
    data &&
    data.name === 'ExperimentalWarning' &&
    /SQLite/i.test(String(data.message))
  ) {
    return false;
  }
  return _emit.call(process, name, data, ...rest);
};

const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

const express = require('express');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');

const db = require('./db');

const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// JWT secret (generated once and persisted to ./data/secret.key)
// ---------------------------------------------------------------------------
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const SECRET_PATH = path.join(DATA_DIR, 'secret.key');
let JWT_SECRET;
if (fs.existsSync(SECRET_PATH)) {
  JWT_SECRET = fs.readFileSync(SECRET_PATH, 'utf8').trim();
} else {
  JWT_SECRET = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(SECRET_PATH, JWT_SECRET, { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 12);
    const safe = crypto.randomBytes(16).toString('hex');
    cb(null, `${Date.now()}-${safe}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
});

function attachmentTypeFor(mime) {
  if (!mime) return 'file';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  return 'file';
}

// ---------------------------------------------------------------------------
// App + helpers
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

const AVATAR_COLORS = [
  '#0084ff', '#7646ff', '#ff5e3a', '#13b955', '#ff9500',
  '#e0457b', '#00b8d4', '#8e44ad', '#16a085', '#d35400',
];

function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, {
    expiresIn: '30d',
  });
}

function userFromToken(token) {
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return db.getUserById(payload.id) || null;
  } catch {
    return null;
  }
}

// REST auth middleware.
function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const user = token ? userFromToken(token) : null;
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  req.user = user;
  next();
}

const USERNAME_RE = /^[a-zA-Z0-9_.]{3,20}$/;

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------
app.post('/api/register', (req, res) => {
  let { username, displayName, password } = req.body || {};
  username = String(username || '').trim().toLowerCase();
  displayName = String(displayName || '').trim();
  password = String(password || '');

  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({
      error: 'Username must be 3-20 characters (letters, numbers, _ or . only).',
    });
  }
  if (displayName.length < 1 || displayName.length > 40) {
    return res.status(400).json({ error: 'Display name must be 1-40 characters.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  if (db.getUserByUsername(username)) {
    return res.status(409).json({ error: 'That username is already taken.' });
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  const avatarColor = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
  const user = db.createUser({ username, displayName, passwordHash, avatarColor });
  const token = signToken(user);
  res.json({ token, user: db.publicUser(user) });
});

app.post('/api/login', (req, res) => {
  let { username, password } = req.body || {};
  username = String(username || '').trim().toLowerCase();
  password = String(password || '');

  const user = db.getUserByUsername(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Wrong username or password.' });
  }
  const token = signToken(user);
  res.json({ token, user: db.publicUser(user) });
});

app.get('/api/me', auth, (req, res) => {
  res.json({ user: db.publicUser(req.user) });
});

// ---------------------------------------------------------------------------
// User search
// ---------------------------------------------------------------------------
app.get('/api/users/search', auth, (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ users: [] });
  const rows = db.searchUsers(req.user.id, q);
  const users = rows.map((u) => ({
    ...db.publicUser(u),
    online: isOnline(u.id),
    relationship: db.relationship(req.user.id, u.id),
  }));
  res.json({ users });
});

// ---------------------------------------------------------------------------
// Friends
// ---------------------------------------------------------------------------
app.post('/api/friends/request', auth, (req, res) => {
  const targetId = Number(req.body && req.body.userId);
  if (!targetId || targetId === req.user.id) {
    return res.status(400).json({ error: 'Invalid user.' });
  }
  const target = db.getUserById(targetId);
  if (!target) return res.status(404).json({ error: 'User not found.' });

  const existing = db.findFriendship(req.user.id, targetId);
  if (existing) {
    if (existing.status === 'accepted') {
      return res.status(409).json({ error: 'You are already friends.' });
    }
    // If the target already requested me, accept it instead of duplicating.
    if (existing.addressee_id === req.user.id) {
      db.acceptFriendship(existing.id);
      notifyFriendAccepted(req.user.id, targetId);
      return res.json({ ok: true, status: 'accepted' });
    }
    return res.status(409).json({ error: 'Friend request already sent.' });
  }

  db.createFriendRequest(req.user.id, targetId);
  // Real-time notify the target of the new incoming request.
  emitToUser(targetId, 'friend:request', {
    from: { ...db.publicUser(req.user), online: isOnline(req.user.id) },
  });
  res.json({ ok: true, status: 'pending' });
});

app.post('/api/friends/respond', auth, (req, res) => {
  const requestId = Number(req.body && req.body.requestId);
  const action = String((req.body && req.body.action) || '');
  const fr = db.getFriendshipById(requestId);
  if (!fr || fr.addressee_id !== req.user.id || fr.status !== 'pending') {
    return res.status(404).json({ error: 'Request not found.' });
  }
  if (action === 'accept') {
    db.acceptFriendship(requestId);
    notifyFriendAccepted(fr.requester_id, fr.addressee_id);
    return res.json({ ok: true, status: 'accepted' });
  }
  if (action === 'decline') {
    db.deleteFriendship(requestId);
    return res.json({ ok: true, status: 'declined' });
  }
  res.status(400).json({ error: 'Invalid action.' });
});

app.get('/api/friends', auth, (req, res) => {
  const rows = db.listFriends(req.user.id);
  const friends = rows.map((u) => {
    const conv = db.getOrCreateConversation(req.user.id, u.id);
    return {
      ...db.publicUser(u),
      online: isOnline(u.id),
      conversationId: conv.id,
    };
  });
  res.json({ friends });
});

app.get('/api/friends/requests', auth, (req, res) => {
  const incoming = db.incomingRequests(req.user.id).map((r) => ({
    requestId: r.request_id,
    ...db.publicUser(r),
    online: isOnline(r.id),
  }));
  const outgoing = db.outgoingRequests(req.user.id).map((r) => ({
    requestId: r.request_id,
    ...db.publicUser(r),
  }));
  res.json({ incoming, outgoing });
});

// ---------------------------------------------------------------------------
// Conversations & messages
// ---------------------------------------------------------------------------
app.get('/api/conversations', auth, (req, res) => {
  res.json({ conversations: db.listConversations(req.user.id) });
});

app.get('/api/conversations/:id/messages', auth, (req, res) => {
  const conv = db.getConversationById(Number(req.params.id));
  if (!db.isConversationMember(conv, req.user.id)) {
    return res.status(404).json({ error: 'Conversation not found.' });
  }
  const partnerId = db.conversationPartnerId(conv, req.user.id);
  const partner = db.getUserById(partnerId);
  const messages = db.getMessages(conv.id).map(db.publicMessage);

  // Mark everything read up to the latest message.
  if (messages.length) {
    const lastId = messages[messages.length - 1].id;
    db.markRead(conv.id, req.user.id, lastId);
    emitToUser(partnerId, 'message:read', {
      conversationId: conv.id,
      byUserId: req.user.id,
      lastReadMessageId: lastId,
    });
  }

  res.json({
    messages,
    friend: { ...db.publicUser(partner), online: isOnline(partnerId) },
    partnerLastRead: db.getLastRead(conv.id, partnerId),
  });
});

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------
app.post('/api/upload', auth, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const msg =
        err.code === 'LIMIT_FILE_SIZE'
          ? 'File is too large (max 50 MB).'
          : 'Upload failed.';
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    res.json({
      url: `/uploads/${req.file.filename}`,
      type: attachmentTypeFor(req.file.mimetype),
      name: req.file.originalname,
      size: req.file.size,
    });
  });
});

// Fallback to the SPA for any non-API route.
app.get(/^(?!\/api|\/uploads|\/socket\.io).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------------------
// Socket.io real-time layer
// ---------------------------------------------------------------------------
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 2 * 1024 * 1024 });

// Track which users are online: userId -> Set of socket ids.
const online = new Map();

function isOnline(userId) {
  return online.has(userId) && online.get(userId).size > 0;
}
function emitToUser(userId, event, payload) {
  io.to(`user:${userId}`).emit(event, payload);
}

function broadcastPresenceToFriends(userId, isUp) {
  const friends = db.listFriends(userId);
  const lastSeen = db.getUserById(userId)?.last_seen || null;
  for (const f of friends) {
    emitToUser(f.id, 'presence', { userId, online: isUp, lastSeen });
  }
}

function notifyFriendAccepted(userIdA, userIdB) {
  const conv = db.getOrCreateConversation(userIdA, userIdB);
  const a = db.getUserById(userIdA);
  const b = db.getUserById(userIdB);
  emitToUser(userIdA, 'friend:accepted', {
    friend: { ...db.publicUser(b), online: isOnline(b.id), conversationId: conv.id },
  });
  emitToUser(userIdB, 'friend:accepted', {
    friend: { ...db.publicUser(a), online: isOnline(a.id), conversationId: conv.id },
  });
}

// Authenticate every socket from the handshake token.
io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  const user = token ? userFromToken(token) : null;
  if (!user) return next(new Error('unauthorized'));
  socket.userId = user.id;
  next();
});

io.on('connection', (socket) => {
  const userId = socket.userId;

  // Register presence.
  if (!online.has(userId)) online.set(userId, new Set());
  const wasOffline = online.get(userId).size === 0;
  online.get(userId).add(socket.id);
  socket.join(`user:${userId}`);
  if (wasOffline) {
    db.setLastSeen(userId);
    broadcastPresenceToFriends(userId, true);
  }

  // Send a message to a friend.
  socket.on('message:send', (payload, ack) => {
    try {
      const toUserId = Number(payload && payload.toUserId);
      const body = payload && payload.body ? String(payload.body).slice(0, 5000) : '';
      const attachment = payload && payload.attachment;

      if (!toUserId) return ack && ack({ error: 'Missing recipient.' });
      if (!body && !attachment) return ack && ack({ error: 'Empty message.' });

      // Must be friends to message.
      const fr = db.findFriendship(userId, toUserId);
      if (!fr || fr.status !== 'accepted') {
        return ack && ack({ error: 'You can only message your friends.' });
      }

      const conv = db.getOrCreateConversation(userId, toUserId);
      const row = db.createMessage({
        conversationId: conv.id,
        senderId: userId,
        body,
        attachmentUrl: attachment ? attachment.url : null,
        attachmentType: attachment ? attachment.type : null,
        attachmentName: attachment ? attachment.name : null,
      });
      const message = db.publicMessage(row);

      // Sender has implicitly read their own message.
      db.markRead(conv.id, userId, message.id);

      const sender = db.getUserById(userId);
      const recipient = db.getUserById(toUserId);
      const envelope = {
        message,
        participants: {
          [userId]: db.publicUser(sender),
          [toUserId]: db.publicUser(recipient),
        },
      };

      emitToUser(userId, 'message:new', envelope);
      emitToUser(toUserId, 'message:new', envelope);

      if (ack) ack({ ok: true, message });
    } catch (e) {
      if (ack) ack({ error: 'Could not send message.' });
    }
  });

  // Typing indicator.
  socket.on('typing', (payload) => {
    const toUserId = Number(payload && payload.toUserId);
    if (!toUserId) return;
    const fr = db.findFriendship(userId, toUserId);
    if (!fr || fr.status !== 'accepted') return;
    const conv = db.getOrCreateConversation(userId, toUserId);
    emitToUser(toUserId, 'typing', {
      conversationId: conv.id,
      fromUserId: userId,
      isTyping: !!(payload && payload.isTyping),
    });
  });

  // Read receipt.
  socket.on('message:read', (payload) => {
    const conversationId = Number(payload && payload.conversationId);
    const conv = db.getConversationById(conversationId);
    if (!db.isConversationMember(conv, userId)) return;
    const last = db.getLastMessage(conversationId);
    if (!last) return;
    db.markRead(conversationId, userId, last.id);
    const partnerId = db.conversationPartnerId(conv, userId);
    emitToUser(partnerId, 'message:read', {
      conversationId,
      byUserId: userId,
      lastReadMessageId: last.id,
    });
  });

  socket.on('disconnect', () => {
    const set = online.get(userId);
    if (set) {
      set.delete(socket.id);
      if (set.size === 0) {
        online.delete(userId);
        db.setLastSeen(userId);
        broadcastPresenceToFriends(userId, false);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log('\n  💬  Realtime Messenger is running!');
  console.log(`  ➜  Open this in your browser:  http://localhost:${PORT}\n`);
});
