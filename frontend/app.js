/* ============================================================
   Pulse Messenger — client application
   ============================================================ */
(function () {
  'use strict';

  // ---------- backend location ----------
  // "" means same-origin (local dev). In production config.js sets the Render URL.
  const API_BASE = ((window.PULSE_CONFIG && window.PULSE_CONFIG.backendUrl) || '').replace(/\/$/, '');
  // Resolve a media URL: absolute (Supabase) URLs are used as-is, relative ones
  // (local-storage dev) are prefixed with the backend base.
  const mediaUrl = (u) => (!u ? '' : /^https?:\/\//i.test(u) ? u : API_BASE + u);

  // ---------- tiny DOM helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const escapeHtml = (s) =>
    String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  function initials(name) {
    const parts = String(name || '?').trim().split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function avatarHtml(user, opts = {}) {
    const cls = opts.cls || '';
    const color = user.avatarColor || '#0084ff';
    const dot =
      opts.dot === undefined
        ? ''
        : `<span class="dot ${opts.dot ? 'on' : ''}"></span>`;
    return `<div class="avatar ${cls}" style="background:${color}">${escapeHtml(
      initials(user.displayName)
    )}${dot}</div>`;
  }

  function fmtTime(iso) {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  function dayLabel(iso) {
    const d = new Date(iso);
    const today = new Date();
    const y = new Date();
    y.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function lastSeenText(user) {
    if (user.online) return 'Active now';
    if (!user.lastSeen) return 'Offline';
    const diff = Date.now() - new Date(user.lastSeen).getTime();
    const min = Math.floor(diff / 60000);
    if (min < 1) return 'Active just now';
    if (min < 60) return `Active ${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `Active ${hr}h ago`;
    return `Active ${dayLabel(user.lastSeen)}`;
  }
  function fmtSize(bytes) {
    if (!bytes && bytes !== 0) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // ---------- state ----------
  const state = {
    token: localStorage.getItem('pulse_token') || null,
    me: null,
    socket: null,
    activeTab: 'chats',
    friends: new Map(), // id -> friend
    conversations: new Map(), // convId -> {id, friend, lastMessage, unread}
    requests: { incoming: [], outgoing: [] },
    current: null, // {conversationId, peer}
    messages: [],
    attachment: null,
    replyTo: null,
    editing: null,
    partnerLastRead: 0,
    peerTypingTimer: null,
    sendTypingTimer: null,
    isTypingSent: false,
  };

  // ============================================================
  // API helper
  // ============================================================
  async function api(path, { method = 'GET', body, raw } = {}) {
    const headers = {};
    if (state.token) headers.Authorization = 'Bearer ' + state.token;
    let payload = body;
    if (body && !raw) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(API_BASE + path, { method, headers, body: payload });
    let data = null;
    try { data = await res.json(); } catch { /* no body */ }
    if (!res.ok) throw new Error((data && data.error) || 'Something went wrong.');
    return data;
  }

  // ============================================================
  // AUTH
  // ============================================================
  const authScreen = $('#auth-screen');
  const appScreen = $('#app-screen');

  function setAuthMode(mode) {
    authScreen.dataset.mode = mode;
    $$('.auth-tab').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    $('#auth-submit').textContent = mode === 'login' ? 'Log in' : 'Create account';
    showAuthError('');
    const f = $('#auth-form');
    if (f) { f.classList.remove('mode-anim'); void f.offsetWidth; f.classList.add('mode-anim'); }
  }
  function showAuthMsg(msg, type = 'error') {
    const box = $('#auth-error');
    box.classList.remove('show', 'error', 'success');
    box.textContent = msg || '';
    if (!msg) return;
    box.classList.add(type);
    void box.offsetWidth; // restart the entrance animation
    box.classList.add('show');
  }
  function showAuthError(msg) { showAuthMsg(msg, 'error'); }

  $$('.auth-tab').forEach((b) => b.addEventListener('click', () => setAuthMode(b.dataset.mode)));
  $$('[data-switch]').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      setAuthMode(a.dataset.switch);
    })
  );

  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const mode = authScreen.dataset.mode || 'login';
    const username = $('#f-username').value.trim();
    const password = $('#f-password').value;
    const displayName = $('#f-displayname').value.trim();
    const submit = $('#auth-submit');
    submit.disabled = true;

    try {
      let data;
      if (mode === 'register') {
        data = await api('/api/register', { method: 'POST', body: { username, displayName, password } });
      } else {
        data = await api('/api/login', { method: 'POST', body: { username, password } });
      }
      state.token = data.token;
      localStorage.setItem('pulse_token', data.token);
      state.me = data.user;
      showAuthMsg(mode === 'register' ? 'Account created 🎉' : 'Welcome back 🎉', 'success');
      await new Promise((r) => setTimeout(r, 420));
      await enterApp();
    } catch (err) {
      showAuthError(err.message);
    } finally {
      submit.disabled = false;
    }
  });

  function logout() {
    if (state.socket) state.socket.disconnect();
    localStorage.removeItem('pulse_token');
    Object.assign(state, {
      token: null, me: null, socket: null, friends: new Map(),
      conversations: new Map(), requests: { incoming: [], outgoing: [] },
      current: null, messages: [], attachment: null,
    });
    appScreen.classList.add('hidden');
    authScreen.classList.remove('hidden');
    $('#auth-form').reset();
  }
  $('#logout-btn').addEventListener('click', logout);

  // ============================================================
  // ENTER APP
  // ============================================================
  async function enterApp() {
    authScreen.classList.add('hidden');
    appScreen.classList.remove('hidden');

    // header
    renderMeHeader();

    connectSocket();
    await Promise.all([loadFriends(), loadConversations(), loadRequests()]);
    renderAll();
  }

  function renderMeHeader() {
    const wrap = $('.me');
    wrap.querySelector('.avatar').outerHTML = avatarHtml(state.me);
    $('#me-name').textContent = state.me.displayName;
    $('#me-username').textContent = '@' + state.me.username;
  }

  // ============================================================
  // SOCKET
  // ============================================================
  function connectSocket() {
    const opts = { auth: { token: state.token }, transports: ['websocket', 'polling'] };
    const socket = API_BASE ? io(API_BASE, opts) : io(opts);
    state.socket = socket;

    socket.on('connect_error', (err) => {
      if (err && String(err.message || '').toLowerCase().includes('unauthorized')) logout();
    });

    socket.on('message:new', onMessageNew);
    socket.on('friend:request', onFriendRequest);
    socket.on('friend:accepted', onFriendAccepted);
    socket.on('presence', onPresence);
    socket.on('typing', onTyping);
    socket.on('message:read', onMessageRead);
    socket.on('message:reaction', onMessageReaction);
    socket.on('message:unsent', onMessageUnsent);
    socket.on('message:edited', onMessageEdited);
    socket.on('conversation:cleared', onConversationCleared);
    socket.on('friend:removed', onFriendRemoved);
  }

  // ============================================================
  // DATA LOADERS
  // ============================================================
  async function loadFriends() {
    const { friends } = await api('/api/friends');
    state.friends = new Map(friends.map((f) => [f.id, f]));
  }
  async function loadConversations() {
    const { conversations } = await api('/api/conversations');
    state.conversations = new Map(conversations.map((c) => [c.id, c]));
  }
  async function loadRequests() {
    state.requests = await api('/api/friends/requests');
  }

  // ============================================================
  // RENDERING — sidebar
  // ============================================================
  function renderAll() {
    renderChats();
    renderFriends();
    renderRequests();
    updateReqBadge();
  }

  function previewText(msg) {
    if (!msg) return '';
    if (msg.unsent) return msg.senderId === state.me.id ? 'You unsent a message' : 'Unsent a message';
    const mine = msg.senderId === state.me.id ? 'You: ' : '';
    if (msg.attachmentType === 'image') return mine + '📷 Photo';
    if (msg.attachmentType === 'video') return mine + '🎥 Video';
    if (msg.attachmentType === 'file') return mine + '📎 ' + (msg.attachmentName || 'File');
    return mine + (msg.body || '');
  }

  function renderChats() {
    const box = $('#tab-chats');
    const convs = Array.from(state.conversations.values()).sort((a, b) =>
      (b.lastMessage?.createdAt || '').localeCompare(a.lastMessage?.createdAt || '')
    );
    if (!convs.length) {
      box.innerHTML = `<div class="empty-note">No conversations yet.<br>Add a friend and say hi! 👋</div>`;
      return;
    }
    box.innerHTML = convs
      .map((c) => {
        const f = state.friends.get(c.friend.id) || c.friend;
        const active = state.current && state.current.conversationId === c.id;
        return `
        <div class="row ${c.unread ? 'unread' : ''} ${active ? 'active' : ''}" data-open-conv="${c.id}" data-peer="${f.id}">
          ${avatarHtml(f, { dot: !!f.online })}
          <div class="row-main">
            <div class="row-top">
              <span class="row-name">${escapeHtml(f.displayName)}</span>
              <span class="row-time">${c.lastMessage ? fmtTime(c.lastMessage.createdAt) : ''}</span>
            </div>
            <div class="row-top">
              <span class="row-sub">${escapeHtml(previewText(c.lastMessage))}</span>
              ${c.unread ? `<span class="row-badge">${c.unread}</span>` : ''}
            </div>
          </div>
        </div>`;
      })
      .join('');
  }

  function renderFriends() {
    const box = $('#tab-friends');
    const friends = Array.from(state.friends.values()).sort((a, b) =>
      a.displayName.localeCompare(b.displayName)
    );
    if (!friends.length) {
      box.innerHTML = `<div class="empty-note">No friends yet.<br>Use the search bar above to find people. 🔍</div>`;
      return;
    }
    box.innerHTML = friends
      .map(
        (f) => `
      <div class="row" data-open-conv="${f.conversationId}" data-peer="${f.id}">
        ${avatarHtml(f, { dot: !!f.online })}
        <div class="row-main">
          <div class="row-name">${escapeHtml(f.displayName)}</div>
          <div class="row-sub">${f.online ? 'Online' : 'Offline'}</div>
        </div>
      </div>`
      )
      .join('');
  }

  function renderRequests() {
    const box = $('#tab-requests');
    const { incoming, outgoing } = state.requests;
    let html = '';
    if (incoming.length) {
      html += `<div class="section-label">Friend requests</div>`;
      html += incoming
        .map(
          (r) => `
        <div class="row" data-req-row="${r.requestId}">
          ${avatarHtml(r)}
          <div class="row-main">
            <div class="row-name">${escapeHtml(r.displayName)}</div>
            <div class="row-sub">@${escapeHtml(r.username)}</div>
          </div>
          <div class="row-actions">
            <button class="btn-sm btn-accept" data-accept="${r.requestId}">Accept</button>
            <button class="btn-sm btn-soft" data-decline="${r.requestId}">Decline</button>
          </div>
        </div>`
        )
        .join('');
    }
    if (outgoing.length) {
      html += `<div class="section-label">Sent requests</div>`;
      html += outgoing
        .map(
          (r) => `
        <div class="row">
          ${avatarHtml(r)}
          <div class="row-main">
            <div class="row-name">${escapeHtml(r.displayName)}</div>
            <div class="row-sub">@${escapeHtml(r.username)}</div>
          </div>
          <div class="row-actions"><button class="btn-sm btn-soft" disabled>Requested</button></div>
        </div>`
        )
        .join('');
    }
    if (!html) html = `<div class="empty-note">No pending requests.</div>`;
    box.innerHTML = html;
  }

  function updateReqBadge() {
    const n = state.requests.incoming.length;
    const badge = $('#req-badge');
    badge.textContent = n;
    badge.classList.toggle('hidden', n === 0);
  }

  // ---------- tab switching ----------
  $$('.tab').forEach((t) =>
    t.addEventListener('click', () => {
      state.activeTab = t.dataset.tab;
      $$('.tab').forEach((x) => x.classList.toggle('active', x === t));
      ['chats', 'friends', 'requests'].forEach((name) =>
        $('#tab-' + name).classList.toggle('hidden', name !== state.activeTab)
      );
      $('#search-results').classList.add('hidden');
      $('#search-input').value = '';
      $('#search-clear').classList.add('hidden');
      showActivePanel();
    })
  );

  function showActivePanel() {
    const searching = !$('#search-results').classList.contains('hidden');
    ['chats', 'friends', 'requests'].forEach((name) =>
      $('#tab-' + name).classList.toggle('hidden', searching || name !== state.activeTab)
    );
  }

  // ============================================================
  // SEARCH + ADD FRIEND
  // ============================================================
  const searchInput = $('#search-input');
  let searchTimer = null;
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim();
    $('#search-clear').classList.toggle('hidden', !q);
    clearTimeout(searchTimer);
    if (!q) {
      $('#search-results').classList.add('hidden');
      showActivePanel();
      return;
    }
    searchTimer = setTimeout(() => doSearch(q), 250);
  });
  $('#search-clear').addEventListener('click', () => {
    searchInput.value = '';
    $('#search-clear').classList.add('hidden');
    $('#search-results').classList.add('hidden');
    showActivePanel();
  });

  async function doSearch(q) {
    try {
      const { users } = await api('/api/users/search?q=' + encodeURIComponent(q));
      renderSearch(users);
    } catch (e) { /* ignore */ }
  }

  function relButton(u) {
    switch (u.relationship) {
      case 'friends':
        return `<button class="btn-sm btn-soft" data-open-conv-peer="${u.id}">Message</button>`;
      case 'outgoing':
        return `<button class="btn-sm btn-soft" disabled>Requested</button>`;
      case 'incoming':
        return `<button class="btn-sm btn-accept" data-add="${u.id}">Accept</button>`;
      default:
        return `<button class="btn-sm btn-accept" data-add="${u.id}">Add</button>`;
    }
  }

  function renderSearch(users) {
    const box = $('#search-results');
    box.classList.remove('hidden');
    showActivePanel();
    if (!users.length) {
      box.innerHTML = `<div class="empty-note">No users found.</div>`;
      return;
    }
    box.innerHTML =
      `<div class="section-label">People</div>` +
      users
        .map(
          (u) => `
      <div class="row" data-user="${u.id}">
        ${avatarHtml(u, { dot: !!u.online })}
        <div class="row-main">
          <div class="row-name">${escapeHtml(u.displayName)}</div>
          <div class="row-sub">@${escapeHtml(u.username)}</div>
        </div>
        <div class="row-actions">${relButton(u)}</div>
      </div>`
        )
        .join('');
  }

  async function sendFriendRequest(userId, btn) {
    btn.disabled = true;
    try {
      const r = await api('/api/friends/request', { method: 'POST', body: { userId } });
      if (r.status === 'accepted') {
        btn.textContent = 'Friends';
        await refreshSocial();
        toast('🎉', 'New friend', 'You are now connected!');
      } else {
        btn.textContent = 'Requested';
        await loadRequests();
        updateReqBadge();
        renderRequests();
      }
    } catch (e) {
      toast('⚠️', 'Could not add', e.message);
      btn.disabled = false;
    }
  }

  async function respondRequest(requestId, action) {
    try {
      await api('/api/friends/respond', { method: 'POST', body: { requestId, action } });
      await refreshSocial();
    } catch (e) {
      toast('⚠️', 'Error', e.message);
    }
  }

  async function refreshSocial() {
    await Promise.all([loadFriends(), loadConversations(), loadRequests()]);
    renderAll();
  }

  // ============================================================
  // EVENT DELEGATION (sidebar clicks)
  // ============================================================
  $('#sidebar').addEventListener('click', (e) => {
    const add = e.target.closest('[data-add]');
    if (add) return sendFriendRequest(Number(add.dataset.add), add);

    const accept = e.target.closest('[data-accept]');
    if (accept) return respondRequest(Number(accept.dataset.accept), 'accept');

    const decline = e.target.closest('[data-decline]');
    if (decline) return respondRequest(Number(decline.dataset.decline), 'decline');

    const openPeer = e.target.closest('[data-open-conv-peer]');
    if (openPeer) return openConversationByPeer(Number(openPeer.dataset.openConvPeer));

    const openRow = e.target.closest('[data-open-conv]');
    if (openRow) return openConversation(Number(openRow.dataset.openConv), Number(openRow.dataset.peer));
  });

  // ============================================================
  // CONVERSATION VIEW
  // ============================================================
  function openConversationByPeer(peerId) {
    const f = state.friends.get(peerId);
    if (f) openConversation(f.conversationId, peerId);
  }

  async function openConversation(conversationId, peerId) {
    const peer = state.friends.get(peerId);
    if (!peer) return;
    state.current = { conversationId, peer };
    $('#typing-row').classList.remove('show');
    clearTimeout(state.peerTypingTimer);
    clearAttachment();
    cancelReply();
    cancelEdit();
    msgInput.value = '';
    msgInput.style.height = 'auto';
    refreshSendState();

    $('#chat-empty').classList.add('hidden');
    $('#chat-active').classList.remove('hidden');
    appScreen.classList.add('in-chat');

    // header
    $('#peer-avatar').outerHTML = avatarHtml(peer, { dot: !!peer.online }).replace(
      'class="avatar',
      'id="peer-avatar" class="avatar'
    );
    $('#peer-name').textContent = peer.displayName;
    updatePeerStatus();

    $('#messages').innerHTML = `<div class="empty-note">Loading…</div>`;

    try {
      const data = await api('/api/conversations/' + conversationId + '/messages');
      state.messages = data.messages;
      state.partnerLastRead = data.partnerLastRead || 0;
      // refresh peer online from server response
      Object.assign(peer, { online: data.friend.online, lastSeen: data.friend.lastSeen });
      updatePeerStatus();
      renderMessages();

      // clear unread locally
      const conv = state.conversations.get(conversationId);
      if (conv) { conv.unread = 0; renderChats(); }
    } catch (e) {
      $('#messages').innerHTML = `<div class="empty-note">Could not load messages.</div>`;
    }
    renderChats();
    renderFriends();
  }

  function updatePeerStatus() {
    const peer = state.current && state.current.peer;
    if (!peer) return;
    const el = $('#peer-status');
    el.textContent = lastSeenText(peer);
    el.classList.toggle('online', !!peer.online);
    const dot = $('#peer-avatar .dot');
    if (dot) dot.classList.toggle('on', !!peer.online);
  }

  function renderMessages() {
    const box = $('#messages');
    if (!state.messages.length) {
      box.innerHTML = `<div class="empty-note">No messages yet. Say hello! 👋</div>`;
      return;
    }
    let html = '';
    let lastDay = '';
    let prevSender = null;
    state.messages.forEach((m, i) => {
      const d = dayLabel(m.createdAt);
      if (d !== lastDay) {
        html += `<div class="day-sep">${d}</div>`;
        lastDay = d;
        prevSender = null;
      }
      const out = m.senderId === state.me.id;
      const grouped = prevSender === m.senderId;
      const peer = state.current.peer;
      const avatar = avatarHtml(out ? state.me : peer, { cls: 'm-avatar' });
      html += `
        <div class="msg ${out ? 'out' : 'in'} ${grouped ? 'grouped' : 'first'}" data-mid="${m.id}">
          ${avatar}
          ${renderBubble(m)}
        </div>`;
      prevSender = m.senderId;
    });

    box.innerHTML = html;
    updateSeenRow();
    box.scrollTop = box.scrollHeight;
  }

  // Show a plain "Seen" label under the last outgoing message (no avatar).
  function updateSeenRow() {
    const box = $('#messages');
    const old = box.querySelector('.seen-row');
    if (old) old.remove();
    if (!state.messages.length) return;
    const last = state.messages[state.messages.length - 1];
    if (last && last.senderId === state.me.id && state.partnerLastRead >= last.id) {
      box.insertAdjacentHTML('beforeend', `<div class="seen-row">Seen</div>`);
    }
  }

  // Append a single new message (with entrance animation) without re-rendering all.
  function appendMessage(m) {
    const box = $('#messages');
    const note = box.querySelector('.empty-note');
    if (note) note.remove();
    const seen = box.querySelector('.seen-row');
    if (seen) seen.remove();
    const idx = state.messages.indexOf(m);
    const prev = idx > 0 ? state.messages[idx - 1] : null;
    const d = dayLabel(m.createdAt);
    const prevD = prev ? dayLabel(prev.createdAt) : null;
    let html = '';
    if (d !== prevD) html += `<div class="day-sep">${d}</div>`;
    const out = m.senderId === state.me.id;
    const grouped = !!prev && prevD === d && prev.senderId === m.senderId;
    const avatar = avatarHtml(out ? state.me : state.current.peer, { cls: 'm-avatar' });
    html += `<div class="msg ${out ? 'out' : 'in'} ${grouped ? 'grouped' : 'first'} is-new" data-mid="${m.id}">${avatar}${renderBubble(m)}</div>`;
    box.insertAdjacentHTML('beforeend', html);
    updateSeenRow();
    box.scrollTop = box.scrollHeight;
  }

  function reactionsHtml(m) {
    const rx = m.reactions || [];
    if (!rx.length) return '';
    const counts = {};
    rx.forEach((r) => { counts[r.emoji] = (counts[r.emoji] || 0) + 1; });
    const emojis = Object.keys(counts).join('');
    const mine = rx.some((r) => r.userId === state.me.id);
    return `<div class="reactions ${mine ? 'mine' : ''}">${emojis}${rx.length > 1 ? `<span class="rc">${rx.length}</span>` : ''}</div>`;
  }

  function replyQuoteHtml(m) {
    if (!m.replyTo) return '';
    const who = m.replyTo.senderId === state.me.id ? 'You' : ((state.current && state.current.peer && state.current.peer.displayName) || '');
    return `<div class="reply-quote"><span class="rq-who">${escapeHtml(who)}</span> ${escapeHtml(m.replyTo.preview)}</div>`;
  }

  function renderBubble(m) {
    if (m.unsent) {
      const name = m.senderId === state.me.id ? 'You' : ((state.current && state.current.peer && state.current.peer.displayName) || 'They');
      return `<div class="bwrap"><div class="bubble unsent">🚫 ${escapeHtml(name)} unsent a message</div></div>`;
    }
    const t = `<span class="m-time">${m.edited ? 'Edited · ' : ''}${fmtTime(m.createdAt)}</span>`;
    const rx = reactionsHtml(m);
    let inner;
    if (m.attachmentType === 'image') {
      const cap = m.body ? `<div class="caption">${escapeHtml(m.body)}</div>` : '';
      inner = `<div class="bubble media"><img src="${escapeHtml(mediaUrl(m.attachmentUrl))}" data-light="image" alt="image" loading="lazy">${cap}</div>`;
    } else if (m.attachmentType === 'video') {
      const cap = m.body ? `<div class="caption">${escapeHtml(m.body)}</div>` : '';
      inner = `<div class="bubble media"><video src="${escapeHtml(mediaUrl(m.attachmentUrl))}" data-light="video" controls preload="metadata"></video>${cap}</div>`;
    } else if (m.attachmentType === 'file') {
      const cap = m.body ? `<div class="caption">${escapeHtml(m.body)}</div>` : '';
      inner = `<div class="bubble"><a class="file-card" href="${escapeHtml(mediaUrl(m.attachmentUrl))}" download="${escapeHtml(m.attachmentName || 'file')}" target="_blank" rel="noopener"><span class="file-ico">📎</span><span class="file-meta"><span class="file-name">${escapeHtml(m.attachmentName || 'File')}</span><span class="file-sub">Download</span></span></a>${cap}</div>`;
    } else {
      inner = `<div class="bubble">${escapeHtml(m.body)}</div>`;
    }
    return `<div class="bwrap">${replyQuoteHtml(m)}${inner}${rx}${t}</div>`;
  }

  // ---------- back button (mobile) ----------
  function backToList() {
    appScreen.classList.remove('in-chat');
    state.current = null;
    $('#chat-active').classList.add('hidden');
    $('#chat-empty').classList.remove('hidden');
    renderChats();
  }
  $('#back-btn').addEventListener('click', backToList);

  // ============================================================
  // COMPOSER (send / typing / attachments)
  // ============================================================
  const msgInput = $('#message-input');
  const sendBtn = $('#send-btn');

  function refreshSendState() {
    const hasText = msgInput.value.trim().length > 0;
    sendBtn.disabled = !(hasText || state.attachment);
  }

  msgInput.addEventListener('input', () => {
    // auto-grow
    msgInput.style.height = 'auto';
    msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + 'px';
    refreshSendState();
    emitTyping();
  });

  msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  sendBtn.addEventListener('click', sendMessage);

  function emitTyping() {
    if (!state.current || !state.socket) return;
    const toUserId = state.current.peer.id;
    if (!state.isTypingSent) {
      state.socket.emit('typing', { toUserId, isTyping: true });
      state.isTypingSent = true;
    }
    clearTimeout(state.sendTypingTimer);
    state.sendTypingTimer = setTimeout(() => {
      state.socket.emit('typing', { toUserId, isTyping: false });
      state.isTypingSent = false;
    }, 1500);
  }
  function stopTyping() {
    if (!state.current || !state.socket) return;
    clearTimeout(state.sendTypingTimer);
    if (state.isTypingSent) {
      state.socket.emit('typing', { toUserId: state.current.peer.id, isTyping: false });
      state.isTypingSent = false;
    }
  }

  function sendMessage() {
    if (!state.current) return;
    const body = msgInput.value.trim();
    if (state.editing) {
      if (!body) return;
      const mid = state.editing;
      state.socket.emit('message:edit', { messageId: mid, body }, (resp) => {
        if (resp && resp.error) toast('⚠️', 'Not edited', resp.error);
      });
      cancelEdit();
      stopTyping();
      return;
    }
    if (!body && !state.attachment) return;

    state.socket.emit(
      'message:send',
      {
        toUserId: state.current.peer.id,
        body,
        attachment: state.attachment,
        replyToId: state.replyTo ? state.replyTo.id : null,
      },
      (resp) => {
        if (resp && resp.error) toast('⚠️', 'Not sent', resp.error);
      }
    );

    msgInput.value = '';
    msgInput.style.height = 'auto';
    clearAttachment();
    cancelReply();
    refreshSendState();
    stopTyping();
  }

  // ---------- attachments ----------
  const fileInput = $('#file-input');
  $('#attach-btn').addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) {
      toast('⚠️', 'Too large', 'Max file size is 50 MB.');
      return;
    }
    await uploadAttachment(file);
  });

  // Resize + re-encode photos to JPEG before upload. This shrinks big iPhone
  // photos (lighter storage) AND converts HEIC/HEIF so every device can view it.
  function compressImage(file) {
    return new Promise((resolve) => {
      const isImage = file.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif|bmp|tiff?)$/i.test(file.name || '');
      const isGif = file.type === 'image/gif' || /\.gif$/i.test(file.name || '');
      if (!isImage || isGif) return resolve(file);
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          const MAX = 1600;
          let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
          const scale = Math.min(1, MAX / Math.max(w, h));
          w = Math.max(1, Math.round(w * scale));
          h = Math.max(1, Math.round(h * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          URL.revokeObjectURL(url);
          canvas.toBlob((blob) => {
            if (!blob) return resolve(file);
            const isHeic = /heic|heif/i.test(file.type) || /\.(heic|heif)$/i.test(file.name || '');
            // HEIC/HEIF: always use the JPEG. Others: keep it only if it's smaller.
            if (!isHeic && blob.size >= file.size) return resolve(file);
            const base = (file.name || 'photo').replace(/\.[^.]+$/, '');
            resolve(new File([blob], base + '.jpg', { type: 'image/jpeg' }));
          }, 'image/jpeg', 0.82);
        } catch (e) { URL.revokeObjectURL(url); resolve(file); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }

  async function uploadAttachment(file) {
    const isImg = file.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif|gif|bmp|tiff?)$/i.test(file.name || '');
    const isVid = file.type.startsWith('video/');
    if (isImg) { try { file = await compressImage(file); } catch (e) { /* keep original */ } }
    const localUrl = (isImg || isVid) ? URL.createObjectURL(file) : null;
    showAttachPreview({ name: file.name, size: file.size, localUrl, isImg, isVid, uploading: true });

    const fd = new FormData();
    fd.append('file', file);
    try {
      const data = await api('/api/upload', { method: 'POST', body: fd, raw: true });
      state.attachment = { url: data.url, type: data.type, name: data.name, size: data.size };
      showAttachPreview({ name: data.name, size: data.size, localUrl, isImg, isVid, uploading: false });
      refreshSendState();
    } catch (e) {
      toast('⚠️', 'Upload failed', e.message);
      clearAttachment();
    }
  }

  function showAttachPreview({ name, size, localUrl, isImg, isVid, uploading }) {
    const box = $('#attach-preview');
    let thumb = '<span class="file-ico">📎</span>';
    if (isImg && localUrl) thumb = `<img src="${localUrl}">`;
    else if (isVid && localUrl) thumb = `<video src="${localUrl}" muted></video>`;
    box.className = 'attach-preview' + (uploading ? ' uploading' : '');
    box.innerHTML = `
      ${thumb}
      <div class="ap-meta">
        <div class="ap-name">${escapeHtml(name)}</div>
        <div class="ap-sub">${fmtSize(size)}</div>
      </div>
      <button class="ap-remove" id="ap-remove" aria-label="Remove">✕</button>`;
    box.classList.remove('hidden');
    $('#ap-remove').addEventListener('click', clearAttachment);
  }
  function clearAttachment() {
    state.attachment = null;
    const box = $('#attach-preview');
    box.classList.add('hidden');
    box.innerHTML = '';
    refreshSendState();
  }

  // ============================================================
  // SOCKET EVENT HANDLERS
  // ============================================================
  function peerFromEnvelope(env) {
    const ids = Object.keys(env.participants).map(Number);
    const peerId = ids.find((id) => id !== state.me.id);
    return env.participants[peerId];
  }

  function onMessageNew(env) {
    const msg = env.message;
    const peerInfo = peerFromEnvelope(env);
    const convId = msg.conversationId;
    const isMine = msg.senderId === state.me.id;
    const isOpen = state.current && state.current.conversationId === convId;

    // make sure we know this friend (e.g. brand-new conversation)
    if (!state.friends.has(peerInfo.id)) {
      state.friends.set(peerInfo.id, { ...peerInfo, online: true, conversationId: convId });
    } else {
      state.friends.get(peerInfo.id).conversationId = convId;
    }
    const friend = state.friends.get(peerInfo.id);

    // update conversation list entry
    let conv = state.conversations.get(convId);
    if (!conv) {
      conv = { id: convId, friend: friend, lastMessage: msg, unread: 0 };
      state.conversations.set(convId, conv);
    }
    conv.lastMessage = msg;
    conv.friend = friend;

    if (isOpen) {
      state.messages.push(msg);
      appendMessage(msg);
      conv.unread = 0;
      if (!isMine) {
        state.socket.emit('message:read', { conversationId: convId });
      }
    } else if (!isMine) {
      conv.unread = (conv.unread || 0) + 1;
      toast('💬', friend.displayName, previewText(msg), () => openConversation(convId, friend.id));
    }

    renderChats();
  }

  function onMessageRead(payload) {
    if (state.current && state.current.conversationId === payload.conversationId) {
      if (payload.byUserId !== state.me.id) {
        state.partnerLastRead = Math.max(state.partnerLastRead, payload.lastReadMessageId);
        updateSeenRow();
      }
    }
  }

  async function onFriendRequest(payload) {
    await loadRequests();
    updateReqBadge();
    renderRequests();
    toast('👤', 'Friend request', `${payload.from.displayName} wants to connect`, () => {
      $('.tab[data-tab="requests"]').click();
    });
  }

  function onFriendAccepted(payload) {
    const f = payload.friend;
    state.friends.set(f.id, f);
    // remove from any pending request lists
    state.requests.incoming = state.requests.incoming.filter((r) => r.id !== f.id);
    state.requests.outgoing = state.requests.outgoing.filter((r) => r.id !== f.id);
    renderAll();
    toast('🎉', 'New friend', `You and ${f.displayName} are now friends!`);
  }

  function onPresence(payload) {
    const f = state.friends.get(payload.userId);
    if (f) {
      f.online = payload.online;
      f.lastSeen = payload.lastSeen;
    }
    if (state.current && state.current.peer.id === payload.userId) {
      Object.assign(state.current.peer, { online: payload.online, lastSeen: payload.lastSeen });
      updatePeerStatus();
    }
    renderChats();
    renderFriends();
  }

  function onTyping(payload) {
    if (!state.current || state.current.conversationId !== payload.conversationId) return;
    if (payload.fromUserId !== state.current.peer.id) return;
    const row = $('#typing-row');
    clearTimeout(state.peerTypingTimer);
    if (payload.isTyping) {
      $('#typing-text').textContent = state.current.peer.displayName + ' is typing';
      row.classList.add('show');
      state.peerTypingTimer = setTimeout(() => row.classList.remove('show'), 5000);
    } else {
      row.classList.remove('show');
    }
  }

  // ============================================================
  // LIGHTBOX
  // ============================================================
  $('#messages').addEventListener('click', (e) => {
    const light = e.target.closest('[data-light]');
    if (!light) return;
    const type = light.dataset.light;
    const body = $('#lightbox-body');
    body.innerHTML =
      type === 'image'
        ? `<img src="${light.getAttribute('src')}">`
        : `<video src="${light.getAttribute('src')}" controls autoplay></video>`;
    $('#lightbox').classList.remove('hidden');
  });
  $('#lightbox-close').addEventListener('click', closeLightbox);
  $('#lightbox').addEventListener('click', (e) => {
    if (e.target.id === 'lightbox') closeLightbox();
  });
  function closeLightbox() {
    $('#lightbox-body').innerHTML = '';
    $('#lightbox').classList.add('hidden');
  }

  // ============================================================
  // MESSAGE ACTIONS (react · unsend · copy) — long-press / right-click
  // ============================================================
  const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '😡'];
  const EMOJI_PICKER = ['👍','👎','❤️','🔥','😂','🤣','😊','😍','🥰','😘','😎','🤩','😋','😅','😭','😢','😡','🤬','😱','😨','😴','🤔','🙄','😏','😬','🤗','🥺','🙏','👏','🙌','💪','👌','✌️','🤝','💯','✨','⭐','🎉','🎊','🥳','💀','👻','🤡','💩','🤖','👀','💔','💖','💕','💜','💙','💚','🧡','🤍','🌹','🌸','🍀','☀️','🌙','⚡','🍕','🍔','🍓','☕','🍵','🎂','🍻','⚽','🏀','🎮','🎵','📷','💸','🚀','🏆'];
  const messagesEl = $('#messages');
  let pressTimer = null;
  let touchState = null;

  function onTouchStart(e) {
    const msgEl = e.target.closest('.msg[data-mid]');
    if (!msgEl) return;
    const t = e.touches[0];
    touchState = { el: msgEl, startX: t.clientX, startY: t.clientY, swiping: false };
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      pressTimer = null;
      if (touchState && !touchState.swiping) openMsgMenu(msgEl);
    }, 480);
  }
  function onTouchMove(e) {
    if (!touchState) return;
    const t = e.touches[0];
    const dx = t.clientX - touchState.startX;
    const dy = t.clientY - touchState.startY;
    if (!touchState.swiping && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) + 4) {
      touchState.swiping = true;
      clearTimeout(pressTimer); pressTimer = null;
      touchState.el.classList.add('swiping');
    }
    if (touchState.swiping) {
      const out = touchState.el.classList.contains('out');
      const move = out ? Math.max(-90, Math.min(0, dx)) : Math.min(90, Math.max(0, dx));
      touchState.el.style.transform = `translateX(${move}px)`;
      touchState.el.classList.toggle('swipe-armed', Math.abs(move) > 52);
    }
  }
  function onTouchEnd() {
    clearTimeout(pressTimer); pressTimer = null;
    if (!touchState) return;
    const el = touchState.el;
    const armed = el.classList.contains('swipe-armed');
    el.classList.remove('swiping', 'swipe-armed');
    el.style.transform = '';
    if (armed) {
      const m = state.messages.find((x) => x.id === Number(el.dataset.mid));
      if (m && !m.unsent) startReply(m);
    }
    touchState = null;
  }
  messagesEl.addEventListener('touchstart', onTouchStart, { passive: true });
  messagesEl.addEventListener('touchmove', onTouchMove, { passive: true });
  messagesEl.addEventListener('touchend', onTouchEnd);
  messagesEl.addEventListener('touchcancel', onTouchEnd);
  messagesEl.addEventListener('contextmenu', (e) => {
    const msgEl = e.target.closest('.msg[data-mid]');
    if (msgEl) { e.preventDefault(); openMsgMenu(msgEl); }
  });

  function startReply(m) {
    state.editing = null;
    state.replyTo = { id: m.id, senderId: m.senderId, preview: msgPreviewShort(m) };
    showReplyBar();
    msgInput.focus();
  }
  function startEdit(m) {
    state.replyTo = null;
    state.editing = m.id;
    $('#reply-bar-label').textContent = 'Editing message';
    $('#reply-bar-text').textContent = msgPreviewShort(m);
    $('#reply-bar').classList.remove('hidden');
    msgInput.value = m.body || '';
    msgInput.style.height = 'auto';
    msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + 'px';
    refreshSendState();
    msgInput.focus();
  }
  function cancelEdit() {
    state.editing = null;
    $('#reply-bar').classList.add('hidden');
    msgInput.value = '';
    msgInput.style.height = 'auto';
    refreshSendState();
  }
  function msgPreviewShort(m) {
    if (m.unsent) return 'unsent a message';
    if (m.attachmentType === 'image') return '📷 Photo';
    if (m.attachmentType === 'video') return '🎥 Video';
    if (m.attachmentType === 'file') return '📎 ' + (m.attachmentName || 'File');
    return (m.body || '').slice(0, 90);
  }
  function showReplyBar() {
    if (!state.replyTo) return;
    const who = state.replyTo.senderId === state.me.id
      ? 'yourself'
      : ((state.current && state.current.peer && state.current.peer.displayName) || 'them');
    $('#reply-bar-label').textContent = 'Replying to ' + who;
    $('#reply-bar-text').textContent = state.replyTo.preview;
    $('#reply-bar').classList.remove('hidden');
  }
  function cancelReply() {
    state.replyTo = null;
    const rb = $('#reply-bar');
    if (rb) rb.classList.add('hidden');
  }
  const replyCancelBtn = $('#reply-cancel');
  if (replyCancelBtn) replyCancelBtn.addEventListener('click', () => { if (state.editing) cancelEdit(); else cancelReply(); });

  function openMsgMenu(msgEl) {
    const mid = Number(msgEl.dataset.mid);
    const m = state.messages.find((x) => x.id === mid);
    if (!m || m.unsent) return;
    const mine = m.senderId === state.me.id;
    const myReact = (m.reactions || []).find((r) => r.userId === state.me.id);
    const overlay = document.createElement('div');
    overlay.className = 'msg-menu';
    overlay.innerHTML = `
      <div class="mm-sheet">
        <div class="mm-reacts">
          ${REACTIONS.map((em) => `<button class="mm-react ${myReact && myReact.emoji === em ? 'on' : ''}" data-react="${em}">${em}</button>`).join('')}
          <button class="mm-react mm-plus" data-emoji-more="1" aria-label="More emojis">+</button>
        </div>
        <div class="mm-actions">
          <button class="mm-act" data-reply="1">Reply</button>
          ${mine && m.body ? `<button class="mm-act" data-edit="1">Edit</button>` : ''}
          ${m.body ? `<button class="mm-act" data-copy="1">Copy text</button>` : ''}
          ${mine ? `<button class="mm-act danger" data-unsend="1">Unsend</button>` : ''}
          <button class="mm-act" data-cancel="1">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));
    const openedAt = Date.now();
    const close = () => { overlay.classList.remove('show'); setTimeout(() => overlay.remove(), 220); };
    overlay.addEventListener('click', (e) => {
      const react = e.target.closest('[data-react]');
      if (react) { reactToMessage(mid, react.dataset.react); return close(); }
      if (e.target.closest('[data-emoji-more]')) { close(); openEmojiPicker(mid); return; }
      if (e.target.closest('[data-reply]')) { startReply(m); return close(); }
      if (e.target.closest('[data-edit]')) { startEdit(m); return close(); }
      if (e.target.closest('[data-unsend]')) { unsendMessage(mid); return close(); }
      if (e.target.closest('[data-copy]')) {
        try { navigator.clipboard.writeText(m.body || ''); toast('📋', 'Copied', 'Message copied'); } catch (_) {}
        return close();
      }
      if (e.target.closest('[data-cancel]')) return close();
      // backdrop tap — ignore the trailing tap that opened the sheet
      if (e.target === overlay && Date.now() - openedAt > 220) close();
    });
  }

  function openEmojiPicker(mid) {
    const overlay = document.createElement('div');
    overlay.className = 'msg-menu';
    overlay.innerHTML = `
      <div class="mm-sheet emoji-sheet">
        <div class="settings-title">React</div>
        <div class="emoji-grid">
          ${EMOJI_PICKER.map((e) => `<button class="emoji-pick" data-emoji="${e}">${e}</button>`).join('')}
        </div>
        <button class="mm-act" data-cancel="1">Cancel</button>
      </div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));
    const openedAt = Date.now();
    const close = () => { overlay.classList.remove('show'); setTimeout(() => overlay.remove(), 200); };
    overlay.addEventListener('click', (e) => {
      const pick = e.target.closest('[data-emoji]');
      if (pick) { reactToMessage(mid, pick.dataset.emoji); return close(); }
      if (e.target.closest('[data-cancel]')) return close();
      if (e.target === overlay && Date.now() - openedAt > 220) close();
    });
  }

  function reactToMessage(mid, emoji) {
    if (!state.socket) return;
    state.socket.emit('message:react', { messageId: mid, emoji }, (resp) => {
      if (resp && resp.error) toast('⚠️', 'Could not react', resp.error);
    });
  }
  function unsendMessage(mid) {
    if (!state.socket) return;
    state.socket.emit('message:delete', { messageId: mid }, (resp) => {
      if (resp && resp.error) toast('⚠️', 'Could not unsend', resp.error);
    });
  }

  function onMessageReaction(payload) {
    const m = state.messages.find((x) => x.id === payload.messageId);
    if (m && state.current && state.current.conversationId === payload.conversationId) {
      m.reactions = payload.reactions || [];
      updateMessageReactions(payload.messageId);
    }
  }
  function updateMessageReactions(messageId) {
    const m = state.messages.find((x) => x.id === messageId);
    const wrap = messagesEl.querySelector(`.msg[data-mid="${messageId}"] .bwrap`);
    if (!m || !wrap) return;
    const old = wrap.querySelector('.reactions');
    if (old) old.remove();
    const html = reactionsHtml(m);
    if (!html) return;
    const time = wrap.querySelector('.m-time');
    if (time) time.insertAdjacentHTML('beforebegin', html);
    else wrap.insertAdjacentHTML('beforeend', html);
  }
  function onMessageEdited(payload) {
    const m = state.messages.find((x) => x.id === payload.messageId);
    if (m) {
      m.body = payload.body;
      m.edited = true;
      if (state.current && state.current.conversationId === payload.conversationId) {
        const bwrap = messagesEl.querySelector(`.msg[data-mid="${payload.messageId}"] .bwrap`);
        if (bwrap) bwrap.outerHTML = renderBubble(m);
      }
    }
    const conv = state.conversations.get(payload.conversationId);
    if (conv && conv.lastMessage && conv.lastMessage.id === payload.messageId) {
      conv.lastMessage = m || conv.lastMessage;
      renderChats();
    }
  }

  function onMessageUnsent(payload) {
    const m = state.messages.find((x) => x.id === payload.messageId);
    if (m) {
      m.unsent = true; m.body = null;
      m.attachmentUrl = null; m.attachmentType = null; m.attachmentName = null;
      m.reactions = [];
      if (state.current && state.current.conversationId === payload.conversationId) {
        const bwrap = messagesEl.querySelector(`.msg[data-mid="${payload.messageId}"] .bwrap`);
        if (bwrap) bwrap.outerHTML = renderBubble(m);
        updateSeenRow();
      }
    }
    const conv = state.conversations.get(payload.conversationId);
    if (conv && conv.lastMessage && conv.lastMessage.id === payload.messageId) {
      conv.lastMessage = m || conv.lastMessage;
      renderChats();
    }
  }

  function onConversationCleared(payload) {
    state.conversations.delete(payload.conversationId);
    if (state.current && state.current.conversationId === payload.conversationId) {
      state.messages = [];
      backToList();
    }
    renderChats();
  }

  function removeFriendLocal(userId) {
    state.friends.delete(userId);
    for (const [cid, c] of state.conversations) {
      if (c.friend && c.friend.id === userId) state.conversations.delete(cid);
    }
    if (state.current && state.current.peer && state.current.peer.id === userId) backToList();
    renderAll();
  }
  function onFriendRemoved(payload) { removeFriendLocal(payload.userId); }

  // ---- chat header menu: delete conversation / unfriend ----
  const chatMoreBtn = document.getElementById('chat-more-btn');
  if (chatMoreBtn) chatMoreBtn.addEventListener('click', openChatMenu);

  function openChatMenu() {
    if (!state.current) return;
    const peer = state.current.peer;
    const cid = state.current.conversationId;
    const overlay = document.createElement('div');
    overlay.className = 'msg-menu';
    overlay.innerHTML = `
      <div class="mm-sheet">
        <div class="mm-actions">
          <button class="mm-act" data-delconv="1">Delete conversation</button>
          <button class="mm-act danger" data-unfriend="1">Unfriend ${escapeHtml(peer.displayName)}</button>
          <button class="mm-act" data-cancel="1">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));
    const close = () => { overlay.classList.remove('show'); setTimeout(() => overlay.remove(), 220); };
    overlay.addEventListener('click', (e) => {
      if (e.target.closest('[data-delconv]')) { close(); if (confirm('Delete this conversation for both of you?')) deleteConversation(cid); return; }
      if (e.target.closest('[data-unfriend]')) { close(); if (confirm('Unfriend ' + peer.displayName + '?')) unfriend(peer.id); return; }
      if (e.target.closest('[data-cancel]') || e.target === overlay) close();
    });
  }

  function deleteConversation(cid) {
    if (!state.socket) return;
    state.socket.emit('conversation:delete', { conversationId: cid }, (resp) => {
      if (resp && resp.error) toast('⚠️', 'Error', resp.error);
    });
  }
  async function unfriend(userId) {
    try {
      await api('/api/friends/remove', { method: 'POST', body: { userId } });
      removeFriendLocal(userId);
      toast('👋', 'Unfriended', 'Removed from your friends');
    } catch (e) { toast('⚠️', 'Error', e.message); }
  }

  // ---- edit own profile (display name + username) ----
  const meHeaderEl = $('.me');
  if (meHeaderEl) meHeaderEl.addEventListener('click', openProfileEditor);

  function openProfileEditor() {
    if (!state.me) return;
    const overlay = document.createElement('div');
    overlay.className = 'modal';
    overlay.innerHTML = `
      <div class="modal-card">
        <h3>Edit profile</h3>
        <div class="field"><label>Display name</label><input id="pe-name" maxlength="40" value="${escapeHtml(state.me.displayName)}"></div>
        <div class="field"><label>Username</label><input id="pe-username" maxlength="20" value="${escapeHtml(state.me.username)}"></div>
        <div id="pe-err" class="auth-error"></div>
        <div class="modal-actions">
          <button class="btn-soft" data-cancel="1">Cancel</button>
          <button class="btn-primary" id="pe-save">Save</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));
    const close = () => { overlay.classList.remove('show'); setTimeout(() => overlay.remove(), 220); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay || e.target.closest('[data-cancel]')) close(); });
    overlay.querySelector('#pe-save').addEventListener('click', async () => {
      const displayName = overlay.querySelector('#pe-name').value.trim();
      const username = overlay.querySelector('#pe-username').value.trim();
      const errBox = overlay.querySelector('#pe-err');
      const saveBtn = overlay.querySelector('#pe-save');
      saveBtn.disabled = true;
      try {
        const { user } = await api('/api/me/update', { method: 'POST', body: { displayName, username } });
        state.me = user;
        renderMeHeader();
        if (state.current) renderMessages();
        close();
        toast('✅', 'Saved', 'Profile updated');
      } catch (e2) {
        errBox.textContent = e2.message;
        errBox.classList.add('error', 'show');
        saveBtn.disabled = false;
      }
    });
  }

  // ============================================================
  // TOASTS
  // ============================================================
  function toast(icon, title, body, onClick) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `
      <div style="font-size:22px">${icon}</div>
      <div style="min-width:0">
        <div class="t-title">${escapeHtml(title)}</div>
        <div class="t-body">${escapeHtml(body)}</div>
      </div>`;
    el.addEventListener('click', () => {
      if (onClick) onClick();
      el.remove();
    });
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }

  // ============================================================
  // THEME (light / dark)
  // ============================================================
  const THEME_KEY = 'tea_theme';
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    const m = document.getElementById('theme-color-dyn');
    if (m) m.setAttribute('content', t === 'light' ? '#ffffff' : '#0a0a0f');
    try { localStorage.setItem(THEME_KEY, t); } catch (e) {}
  }
  (function initTheme() {
    // collapse the static theme-color metas into one that tracks the chosen theme
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove());
    const meta = document.createElement('meta');
    meta.id = 'theme-color-dyn';
    meta.name = 'theme-color';
    const cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    meta.setAttribute('content', cur === 'light' ? '#ffffff' : '#0a0a0f');
    document.head.appendChild(meta);

    const btn = document.getElementById('theme-btn');
    if (btn) btn.addEventListener('click', () => {
      const c = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
      applyTheme(c === 'dark' ? 'light' : 'dark');
    });
    try {
      matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
        if (!localStorage.getItem(THEME_KEY)) applyTheme(e.matches ? 'dark' : 'light');
      });
    } catch (e) {}
  })();

  // ============================================================
  // SETTINGS · accent color · push notifications
  // ============================================================
  const ACCENTS = [
    { id: 'blue', c1: '#0a7cff', c2: '#6c46ff' },
    { id: 'violet', c1: '#7c3aed', c2: '#c026d3' },
    { id: 'ocean', c1: '#0ea5e9', c2: '#2563eb' },
    { id: 'teal', c1: '#06b6d4', c2: '#0d9488' },
    { id: 'green', c1: '#10b981', c2: '#22c55e' },
    { id: 'lime', c1: '#84cc16', c2: '#10b981' },
    { id: 'sunset', c1: '#ff8a3d', c2: '#ff3d77' },
    { id: 'pink', c1: '#ff4f8b', c2: '#ff7a45' },
    { id: 'rose', c1: '#f43f5e', c2: '#ec4899' },
    { id: 'gold', c1: '#f59e0b', c2: '#ef4444' },
    { id: 'crimson', c1: '#ef4444', c2: '#b91c1c' },
    { id: 'mono', c1: '#64748b', c2: '#334155' },
  ];
  const IC = {
    bell: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>',
    send: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>',
    user: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
    logout: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/></svg>',
  };
  function applyAccent(id) {
    const a = ACCENTS.find((x) => x.id === id) || ACCENTS[0];
    const s = document.documentElement.style;
    s.setProperty('--accent', a.c1);
    s.setProperty('--accent-2', a.c2);
    s.setProperty('--accent-grad', `linear-gradient(135deg, ${a.c1} 0%, ${a.c2} 100%)`);
    try { localStorage.setItem('tea_accent', id); } catch (e) {}
  }
  applyAccent(localStorage.getItem('tea_accent') || 'blue');

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  function urlB64ToUint8Array(b64) {
    const padding = '='.repeat((4 - (b64.length % 4)) % 4);
    const base64 = (b64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }
  async function pushState() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      return sub ? 'on' : 'off';
    } catch (e) { return 'off'; }
  }
  async function enablePush() {
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return false;
      const { key } = await api('/api/push/key');
      if (!key) { toast('⚠️', 'Unavailable', 'Notifications not ready on the server yet'); return false; }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(key),
      });
      const j = sub.toJSON();
      await api('/api/push/subscribe', { method: 'POST', body: { endpoint: j.endpoint, keys: j.keys } });
      toast('🔔', 'Notifications on', "You'll be alerted of new messages");
      return true;
    } catch (e) {
      toast('⚠️', 'Could not enable', e.message || 'Try installing Tea to your home screen first');
      return false;
    }
  }
  async function disablePush() {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
        await sub.unsubscribe();
      }
    } catch (e) { /* ignore */ }
  }

  const settingsBtn = document.getElementById('settings-btn');
  if (settingsBtn) settingsBtn.addEventListener('click', openSettings);

  function openSettings() {
    const curTheme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    const curAccent = localStorage.getItem('tea_accent') || 'blue';
    const overlay = document.createElement('div');
    overlay.className = 'msg-menu settings-menu';
    overlay.innerHTML = `
      <div class="mm-sheet settings-sheet">
        <div class="settings-title">Settings</div>
        <div class="set-section">
          <div class="set-label">Appearance</div>
          <div class="seg">
            <button data-theme-set="light" class="${curTheme === 'light' ? 'on' : ''}">☀️ Light</button>
            <button data-theme-set="dark" class="${curTheme === 'dark' ? 'on' : ''}">🌙 Dark</button>
          </div>
        </div>
        <div class="set-section">
          <div class="set-label">Accent color</div>
          <div class="swatches">
            ${ACCENTS.map((a) => `<button class="swatch ${curAccent === a.id ? 'on' : ''}" data-accent="${a.id}" style="background:linear-gradient(135deg,${a.c1},${a.c2})" aria-label="${a.id}"></button>`).join('')}
          </div>
        </div>
        <div class="set-section set-list">
          <button class="set-row" data-notif="1"><span class="set-main">${IC.bell}<span>Notifications</span></span><span class="set-state" id="set-notif">…</span></button>
          <button class="set-row" data-notif-test="1"><span class="set-main">${IC.send}<span>Send test notification</span></span><span class="set-state">›</span></button>
          <button class="set-row" data-editprofile="1"><span class="set-main">${IC.user}<span>Edit profile</span></span><span class="set-state">›</span></button>
          <button class="set-row danger" data-logout="1"><span class="set-main">${IC.logout}<span>Log out</span></span></button>
        </div>
        <button class="mm-act" data-cancel="1">Close</button>
      </div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));
    const close = () => { overlay.classList.remove('show'); setTimeout(() => overlay.remove(), 220); };

    const notifEl = overlay.querySelector('#set-notif');
    const renderNotif = async () => {
      const st = await pushState();
      notifEl.textContent = st === 'on' ? 'On' : st === 'denied' ? 'Blocked' : st === 'unsupported' ? 'N/A' : 'Off';
    };
    renderNotif();

    overlay.addEventListener('click', async (e) => {
      const ts = e.target.closest('[data-theme-set]');
      if (ts) { applyTheme(ts.dataset.themeSet); overlay.querySelectorAll('[data-theme-set]').forEach((b) => b.classList.toggle('on', b === ts)); return; }
      const sw = e.target.closest('[data-accent]');
      if (sw) { applyAccent(sw.dataset.accent); overlay.querySelectorAll('.swatch').forEach((b) => b.classList.toggle('on', b === sw)); return; }
      if (e.target.closest('[data-notif]')) {
        const st = await pushState();
        if (st === 'on') await disablePush();
        else if (st === 'off') await enablePush();
        else if (st === 'denied') toast('🔕', 'Blocked', 'Enable notifications in your browser settings');
        else toast('ℹ️', 'Not supported', 'Add Tea to your home screen first (iPhone: Share → Add to Home Screen)');
        renderNotif();
        return;
      }
      if (e.target.closest('[data-notif-test]')) {
        try {
          const r = await api('/api/push/test', { method: 'POST' });
          if (r.sent > 0) toast('📨', 'Sent', 'Check your notification bar / lock screen');
          else if (r.subs === 0) toast('🔕', 'No devices', 'Turn Notifications on first');
          else toast('⚠️', 'Not delivered', r.error || 'Unknown error');
        } catch (e2) { toast('⚠️', 'Error', e2.message); }
        return;
      }
      if (e.target.closest('[data-editprofile]')) { close(); openProfileEditor(); return; }
      if (e.target.closest('[data-logout]')) { close(); logout(); return; }
      if (e.target.closest('[data-cancel]') || e.target === overlay) close();
    });
  }

  // ============================================================
  // BOOT
  // ============================================================
  async function boot() {
    setAuthMode('login');
    // Wake the backend early (Render free tier sleeps) so login feels instant.
    try { fetch(API_BASE + '/api/health', { cache: 'no-store' }).catch(() => {}); } catch (e) {}
    if (!state.token) return; // show auth screen
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const { user } = await api('/api/me');
        state.me = user;
        await enterApp();
        return;
      } catch (err) {
        // Only sign out if the token is genuinely invalid — never on a network
        // or cold-start error, so the user stays logged in across restarts.
        if (/not authenticated/i.test(String((err && err.message) || ''))) { logout(); return; }
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    showAuthMsg('Server is waking up — please try again.', 'error');
  }
  boot();
})();
