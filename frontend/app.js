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

  // ---- deter casual right-click / view-source / inspect (NOT real security) ----
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('keydown', (e) => {
    const k = (e.key || '').toLowerCase();
    if (e.key === 'F12'
      || (e.ctrlKey && !e.shiftKey && k === 'u')                                    // view source
      || ((e.ctrlKey || e.metaKey) && e.shiftKey && (k === 'i' || k === 'j' || k === 'c'))) { // devtools
      e.preventDefault();
    }
  });

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

  // A friend's display name, overridden by the user's private nickname if set.
  const friendName = (f) => (f && (f.nickname || f.displayName)) || '';

  // Subtle haptic feedback (mobile only; no-op where unsupported).
  function haptic(ms = 12) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) {} }

  // Lightweight WhatsApp-style formatting on already-escaped text + clickable links.
  function fmtInline(s) {
    return s
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/(^|\s)\*(\S(?:[^*\n]*\S)?)\*(?=\s|$|[.,!?;:])/g, '$1<strong>$2</strong>')
      .replace(/(^|\s)_(\S(?:[^_\n]*\S)?)_(?=\s|$|[.,!?;:])/g, '$1<em>$2</em>')
      .replace(/(^|\s)~(\S(?:[^~\n]*\S)?)~(?=\s|$|[.,!?;:])/g, '$1<del>$2</del>');
  }
  function formatText(escaped) {
    const urlRe = /(https?:\/\/[^\s<]+)/g;
    let out = '', last = 0, m;
    while ((m = urlRe.exec(escaped))) {
      out += fmtInline(escaped.slice(last, m.index));
      out += `<a href="${m[0]}" target="_blank" rel="noopener" class="msg-link">${m[0]}</a>`;
      last = m.index + m[0].length;
    }
    return out + fmtInline(escaped.slice(last));
  }

  function avatarHtml(user, opts = {}) {
    const cls = opts.cls || '';
    const color = user.avatarColor || '#0084ff';
    const dot =
      opts.dot === undefined
        ? ''
        : `<span class="dot ${opts.dot ? 'on' : ''}"></span>`;
    const inner = user.avatarUrl
      ? `<img class="av-img" src="${escapeHtml(mediaUrl(user.avatarUrl))}" alt="" loading="lazy" />`
      : escapeHtml(initials(user.displayName));
    return `<div class="avatar ${cls}" style="background:${color}">${inner}${dot}</div>`;
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
  // Auth feedback shows as a top-right toast (outside the card), auto-dismiss 3s.
  function showAuthMsg(msg, type = 'error') {
    if (!msg) return;
    toast(type === 'success' ? '✅' : '⚠️', msg, '');
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
      showAuthMsg(mode === 'register' ? 'Account created!' : 'Welcome back!', 'success');
      await enterApp();
    } catch (err) {
      showAuthError(err.message);
    } finally {
      submit.disabled = false;
    }
  });

  // Wipe everything the previous account rendered so nothing flashes when the
  // next account (or a brand-new sign-up) logs in.
  function clearAppUI() {
    ['#tab-chats', '#tab-friends', '#tab-requests', '#search-results', '#messages'].forEach((sel) => {
      const el = $(sel);
      if (el) el.innerHTML = '';
    });
    const ca = $('#chat-active'); if (ca) ca.classList.add('hidden');
    const ce = $('#chat-empty'); if (ce) ce.classList.remove('hidden');
    const meName = $('#me-name'); if (meName) meName.textContent = '';
    const meUser = $('#me-username'); if (meUser) meUser.textContent = '';
    const meAv = document.querySelector('.me .avatar'); if (meAv) { meAv.innerHTML = ''; meAv.style.background = 'transparent'; }
    const si = $('#search-input'); if (si) si.value = '';
    const sr = $('#search-results'); if (sr) sr.classList.add('hidden');
  }

  function logout() {
    if (state.socket) state.socket.disconnect();
    localStorage.removeItem('pulse_token');
    Object.assign(state, {
      token: null, me: null, socket: null, friends: new Map(),
      conversations: new Map(), requests: { incoming: [], outgoing: [] },
      current: null, messages: [], attachment: null,
    });
    clearAppUI();
    conversationsReady = false;
    pendingOpenConv = null;
    try { if ('clearAppBadge' in navigator) navigator.clearAppBadge().catch(() => {}); } catch (e) {}
    document.documentElement.classList.remove('resume');
    $('#splash').classList.add('hidden');
    appScreen.classList.add('hidden');
    authScreen.classList.remove('hidden');
    setAuthMode('login');
    $('#auth-form').reset();
  }

  // Ask before logging out (no accidental one-tap sign-out).
  function confirmLogout() {
    const overlay = document.createElement('div');
    overlay.className = 'modal';
    overlay.innerHTML = `
      <div class="modal-card confirm-card">
        <div class="confirm-ic">${IC.logout}</div>
        <h3>Log out?</h3>
        <p class="confirm-text">Are you sure you want to log out of Tea?</p>
        <div class="modal-actions">
          <button class="btn-soft" data-cancel="1">Cancel</button>
          <button class="btn-danger" id="cl-yes">Log out</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));
    const close = () => { overlay.classList.remove('show'); setTimeout(() => overlay.remove(), 220); };
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.closest('[data-cancel]')) return close();
      if (e.target.closest('#cl-yes')) { close(); logout(); }
    });
  }

  function openChangePassword() {
    const overlay = document.createElement('div');
    overlay.className = 'modal';
    overlay.innerHTML = `
      <div class="modal-card">
        <h3>Change password</h3>
        <div class="field"><label>Current password</label><input type="password" id="cp-cur" autocomplete="current-password"></div>
        <div class="field"><label>New password</label><input type="password" id="cp-new" autocomplete="new-password"></div>
        <div class="field"><label>Confirm new password</label><input type="password" id="cp-confirm" autocomplete="new-password"></div>
        <div id="cp-err" class="auth-error"></div>
        <div class="modal-actions">
          <button class="btn-soft" data-cancel="1">Cancel</button>
          <button class="btn-primary" id="cp-save">Update</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));
    const close = () => { overlay.classList.remove('show'); setTimeout(() => overlay.remove(), 220); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay || e.target.closest('[data-cancel]')) close(); });
    const errBox = overlay.querySelector('#cp-err');
    overlay.querySelector('#cp-save').addEventListener('click', async () => {
      const cur = overlay.querySelector('#cp-cur').value;
      const nw = overlay.querySelector('#cp-new').value;
      const cf = overlay.querySelector('#cp-confirm').value;
      const btn = overlay.querySelector('#cp-save');
      const fail = (m) => { errBox.textContent = m; errBox.classList.add('error', 'show'); };
      if (nw.length < 6) return fail('New password must be at least 6 characters.');
      if (nw !== cf) return fail('New passwords do not match.');
      btn.disabled = true;
      try {
        const r = await api('/api/me/password', { method: 'POST', body: { currentPassword: cur, newPassword: nw } });
        if (r.token) { state.token = r.token; localStorage.setItem('pulse_token', r.token); }
        close();
        toast('✅', 'Password changed', 'Other devices were signed out');
      } catch (e2) { fail(e2.message); btn.disabled = false; }
    });
  }

  function openInvite() {
    if (!state.me) return;
    const link = location.origin + '/?add=' + encodeURIComponent(state.me.username);
    const overlay = document.createElement('div');
    overlay.className = 'modal';
    overlay.innerHTML = `
      <div class="modal-card invite-card">
        <h3>Invite a friend</h3>
        <p class="confirm-text">Scan the code or share your link — they can add you on Tea in one tap.</p>
        <div class="invite-qr" id="invite-qr"></div>
        <div class="invite-link" id="invite-link">${escapeHtml(link)}</div>
        <div class="modal-actions">
          <button class="btn-soft" id="invite-copy">Copy link</button>
          <button class="btn-primary" id="invite-share">Share</button>
        </div>
        <button class="mm-act" data-cancel="1" style="margin-top:10px">Close</button>
      </div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));
    const close = () => { overlay.classList.remove('show'); setTimeout(() => overlay.remove(), 220); };
    try {
      if (window.qrcode) {
        const qr = window.qrcode(0, 'M');
        qr.addData(link); qr.make();
        overlay.querySelector('#invite-qr').innerHTML = qr.createImgTag(5, 12);
      } else { overlay.querySelector('#invite-qr').remove(); }
    } catch (e) { const q = overlay.querySelector('#invite-qr'); if (q) q.remove(); }
    overlay.addEventListener('click', async (e) => {
      if (e.target === overlay || e.target.closest('[data-cancel]')) return close();
      if (e.target.closest('#invite-copy')) {
        try { await navigator.clipboard.writeText(link); toast('✅', 'Copied', 'Invite link copied'); }
        catch (_) { toast('⚠️', 'Copy this link', link); }
        return;
      }
      if (e.target.closest('#invite-share')) {
        try {
          if (navigator.share) await navigator.share({ title: 'Tea 🍵', text: 'Add me on Tea', url: link });
          else { await navigator.clipboard.writeText(link); toast('✅', 'Copied', 'Invite link copied'); }
        } catch (_) {}
        return;
      }
    });
  }

  function confirmLogoutOthers() {
    const overlay = document.createElement('div');
    overlay.className = 'modal';
    overlay.innerHTML = `
      <div class="modal-card confirm-card">
        <div class="confirm-ic">${IC.devices}</div>
        <h3>Log out other devices?</h3>
        <p class="confirm-text">You'll stay signed in here. Every other phone, tablet and computer will be signed out of Tea.</p>
        <div class="modal-actions">
          <button class="btn-soft" data-cancel="1">Cancel</button>
          <button class="btn-danger" id="lo-yes">Log out others</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));
    const close = () => { overlay.classList.remove('show'); setTimeout(() => overlay.remove(), 220); };
    overlay.addEventListener('click', async (e) => {
      if (e.target === overlay || e.target.closest('[data-cancel]')) return close();
      if (e.target.closest('#lo-yes')) {
        const btn = overlay.querySelector('#lo-yes');
        btn.disabled = true;
        try {
          const r = await api('/api/me/logout-others', { method: 'POST' });
          if (r.token) { state.token = r.token; localStorage.setItem('pulse_token', r.token); }
          close();
          toast('✅', 'Done', 'Other devices were signed out');
        } catch (e2) { toast('⚠️', 'Error', e2.message); btn.disabled = false; }
      }
    });
  }
  $('#logout-btn').addEventListener('click', confirmLogout);

  // Show / hide password on the login & sign-up form
  (function () {
    const tog = document.getElementById('pw-toggle');
    const pw = document.getElementById('f-password');
    if (!tog || !pw) return;
    const EYE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
    const EYE_OFF = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9.9 4.2A10.9 10.9 0 0 1 12 4c6.5 0 10 7 10 7a18.5 18.5 0 0 1-3 3.9M6.6 6.6A18.6 18.6 0 0 0 2 11s3.5 7 10 7a10.8 10.8 0 0 0 4.4-.9M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="m2 2 20 20"/></svg>';
    tog.innerHTML = EYE;
    tog.addEventListener('click', () => {
      const show = pw.type === 'password';
      pw.type = show ? 'text' : 'password';
      tog.innerHTML = show ? EYE_OFF : EYE;
      tog.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      pw.focus();
    });
  })();

  // ============================================================
  // ENTER APP
  // ============================================================
  async function enterApp() {
    clearAppUI();
    authScreen.classList.add('hidden');
    $('#splash').classList.add('hidden');
    appScreen.classList.remove('hidden');

    // header
    renderMeHeader();
    loadOutbox();

    // show a shimmer placeholder immediately so the list feels instant
    showChatsSkeleton();

    connectSocket();
    await Promise.all([loadFriends(), loadConversations(), loadRequests()]);
    renderAll();
    conversationsReady = true;
    if (pendingOpenConv) { openConversationById(pendingOpenConv); pendingOpenConv = null; }
    if (pendingAdd) {
      const u = pendingAdd; pendingAdd = null;
      searchInput.value = u;
      $('#search-clear').classList.remove('hidden');
      doSearch(u);
    }
  }

  function showChatsSkeleton() {
    const box = $('#tab-chats');
    if (!box) return;
    box.innerHTML = Array.from({ length: 6 }).map(() => `
      <div class="row sk-row">
        <div class="sk sk-av"></div>
        <div class="row-main">
          <div class="sk sk-line" style="width:42%"></div>
          <div class="sk sk-line" style="width:70%;margin-top:9px"></div>
        </div>
      </div>`).join('');
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

    socket.on('connect', () => {
      socket.emit('presence:active', { active: document.visibilityState !== 'hidden' });
      flushOutbox(); // send anything composed while offline
    });

    socket.on('connect_error', (err) => {
      if (err && String(err.message || '').toLowerCase().includes('unauthorized')) logout();
    });

    socket.on('message:new', onMessageNew);
    socket.on('friend:request', onFriendRequest);
    socket.on('friend:accepted', onFriendAccepted);
    socket.on('presence', onPresence);
    socket.on('typing', onTyping);
    socket.on('message:read', onMessageRead);
    socket.on('message:delivered', onMessageDelivered);
    socket.on('message:reaction', onMessageReaction);
    socket.on('message:unsent', onMessageUnsent);
    socket.on('message:edited', onMessageEdited);
    socket.on('conversation:cleared', onConversationCleared);
    socket.on('conversation:new', onConversationNew);
    socket.on('group:updated', onGroupUpdated);
    socket.on('group:removed', onGroupRemoved);
    socket.on('friend:removed', onFriendRemoved);
    socket.on('user:blocked', (p) => onPeerBlock(p.userId, true));
    socket.on('user:unblocked', (p) => onPeerBlock(p.userId, false));
  }

  // The peer blocked/unblocked me. Track it so my composer reflects reality.
  function onPeerBlock(userId, blocked) {
    const f = state.friends.get(userId);
    if (f) f.blockedMe = blocked;
    if (state.current && state.current.peer && state.current.peer.id === userId) {
      state.current.peer.blockedMe = blocked;
    }
  }

  // Tell the server when the app is in the foreground vs backgrounded, so it only
  // pushes notifications when you're NOT actively using it.
  document.addEventListener('visibilitychange', () => {
    if (state.socket && state.socket.connected) {
      state.socket.emit('presence:active', { active: document.visibilityState === 'visible' });
    }
  });

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

  // ---------- offline send queue ----------
  const outboxKey = () => 'tea_outbox_' + (state.me ? state.me.id : '0');
  function loadOutbox() { try { state.outbox = JSON.parse(localStorage.getItem(outboxKey()) || '[]'); } catch (e) { state.outbox = []; } }
  function saveOutbox() { try { localStorage.setItem(outboxKey(), JSON.stringify(state.outbox || [])); } catch (e) {} }
  function queueOutbox(payload) { state.outbox = state.outbox || []; state.outbox.push(payload); saveOutbox(); }
  function flushOutbox() {
    if (!state.socket || !state.socket.connected || !(state.outbox && state.outbox.length)) return;
    const queued = state.outbox;
    state.outbox = [];
    saveOutbox();
    queued.forEach((p) => state.socket.emit('message:send', p, (resp) => {
      if (resp && resp.error) toast('⚠️', 'Not sent', resp.error);
    }));
    toast('✅', 'Sent', queued.length > 1 ? `${queued.length} queued messages sent` : 'Queued message sent');
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

  // A display object usable by avatarHtml for either a friend or a group.
  function convAvatar(c) {
    if (c.isGroup) {
      const gr = c.group || {};
      return { displayName: gr.name || 'Group', avatarColor: gr.avatarColor, avatarUrl: gr.avatarUrl };
    }
    return state.friends.get(c.friend.id) || c.friend;
  }
  function convTitle(c) {
    if (c.isGroup) return (c.group && c.group.name) || 'Group';
    const f = state.friends.get(c.friend.id) || c.friend;
    return friendName(f);
  }
  function senderFirstName(conv, senderId) {
    const m = (conv.group && conv.group.members || []).find((u) => u.id === senderId);
    return m ? String(m.displayName || '').split(/\s+/)[0] : 'Someone';
  }

  function previewText(msg, conv) {
    if (!msg) return conv && conv.isGroup ? 'No messages yet' : '';
    const isGroup = conv && conv.isGroup;
    let who = msg.senderId === state.me.id ? 'You: ' : (isGroup ? senderFirstName(conv, msg.senderId) + ': ' : '');
    if (msg.unsent) return (msg.senderId === state.me.id ? 'You' : (isGroup ? senderFirstName(conv, msg.senderId) : '')) + ' unsent a message';
    if (msg.attachmentType === 'image') return who + '📷 Photo';
    if (msg.attachmentType === 'video') return who + '🎥 Video';
    if (msg.attachmentType === 'audio') return who + '🎤 Voice message';
    if (msg.attachmentType === 'file') return who + '📎 ' + (msg.attachmentName || 'File');
    return who + (msg.body || '');
  }

  function renderChats() {
    updateAppBadge();
    const box = $('#tab-chats');
    const convs = Array.from(state.conversations.values()).sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1; // pinned first
      return (b.lastMessage?.createdAt || '').localeCompare(a.lastMessage?.createdAt || '');
    });
    if (!convs.length) {
      box.innerHTML = `<div class="empty-note">No conversations yet.<br>Add a friend and say hi! 👋</div>`;
      return;
    }
    box.innerHTML = convs
      .map((c) => {
        const isG = !!c.isGroup;
        const au = convAvatar(c);
        const online = isG ? false : !!(state.friends.get(c.friend.id) || c.friend).online;
        const active = state.current && state.current.conversationId === c.id;
        const dotOpt = isG ? {} : { dot: online };
        return `
        <div class="row ${c.unread ? 'unread' : ''} ${active ? 'active' : ''} ${c.pinned ? 'pinned' : ''}" data-open-conv="${c.id}" data-peer="${isG ? '' : (state.friends.get(c.friend.id) || c.friend).id}" data-group="${isG ? '1' : ''}">
          ${isG ? `<span class="av-wrap">${avatarHtml(au, dotOpt)}<span class="grp-badge">👥</span></span>` : avatarHtml(au, dotOpt)}
          <div class="row-main">
            <div class="row-top">
              <span class="row-name">${c.pinned ? '<span class="row-pin">📌</span>' : ''}${escapeHtml(convTitle(c))}</span>
              <span class="row-time">${c.muted ? '<span class="row-mute">🔕</span>' : ''}${c.lastMessage ? fmtTime(c.lastMessage.createdAt) : ''}</span>
            </div>
            <div class="row-top">
              <span class="row-sub">${escapeHtml(previewText(c.lastMessage, c))}</span>
              ${c.unread ? `<span class="row-badge ${c.muted ? 'muted' : ''}">${c.unread}</span>` : ''}
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
          <div class="row-name">${escapeHtml(friendName(f))}</div>
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

  // Swipe left/right across the list to switch tabs.
  (function () {
    const scroller = document.querySelector('.list-scroll');
    if (!scroller) return;
    const TABS = ['chats', 'friends', 'requests'];
    let sx = 0, sy = 0, tracking = false;
    scroller.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) { tracking = false; return; }
      sx = e.touches[0].clientX; sy = e.touches[0].clientY; tracking = true;
    }, { passive: true });
    scroller.addEventListener('touchend', (e) => {
      if (!tracking) return; tracking = false;
      if (!$('#search-results').classList.contains('hidden')) return; // searching
      const t = e.changedTouches[0];
      const dx = t.clientX - sx, dy = t.clientY - sy;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      const cur = TABS.indexOf(state.activeTab || 'chats');
      const next = Math.max(0, Math.min(TABS.length - 1, cur + (dx < 0 ? 1 : -1)));
      if (next !== cur) { haptic(10); const btn = document.querySelector(`.tab[data-tab="${TABS[next]}"]`); if (btn) btn.click(); }
    }, { passive: true });
  })();

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
    if (openRow) {
      if (openRow.dataset.group === '1') return openGroup(Number(openRow.dataset.openConv));
      return openConversation(Number(openRow.dataset.openConv), Number(openRow.dataset.peer));
    }
  });

  // ============================================================
  // CONVERSATION VIEW
  // ============================================================
  function openConversationByPeer(peerId) {
    const f = state.friends.get(peerId);
    if (f) openConversation(f.conversationId, peerId);
  }

  // Deep-link: open a conversation by id (used by notification taps). If the
  // chat list hasn't loaded yet, remember it and open once it has.
  let pendingOpenConv = null;
  let pendingAdd = null;
  let conversationsReady = false;
  function openConversationById(cid) {
    const c = state.conversations.get(cid);
    if (!c) return false;
    if (c.isGroup) openGroup(cid);
    else if (c.friend) openConversation(cid, c.friend.id);
    return true;
  }
  function requestOpenConversation(cid) {
    if (!cid) return;
    if (conversationsReady && openConversationById(cid)) return;
    pendingOpenConv = cid;
  }
  function updateAppBadge() {
    try {
      if (!('setAppBadge' in navigator)) return;
      let n = 0;
      state.conversations.forEach((c) => { n += (c.unread || 0); });
      if (n > 0) navigator.setAppBadge(n).catch(() => {});
      else navigator.clearAppBadge().catch(() => {});
    } catch (e) {}
  }

  async function openConversation(conversationId, peerId) {
    const peer = state.friends.get(peerId);
    if (!peer) return;
    saveDraft(); // keep what was typed in the chat we're leaving
    if (recState) cancelVoiceRecording();
    state.current = { conversationId, peer };
    $('#typing-row').classList.remove('show');
    clearTimeout(state.peerTypingTimer);
    clearAttachment();
    cancelReply();
    cancelEdit();
    restoreDraft(conversationId);
    setComposerBlocked(peer); // reset to cached state; refreshed after messages load

    $('#chat-empty').classList.add('hidden');
    $('#chat-active').classList.remove('hidden');
    appScreen.classList.add('in-chat');

    // header
    $('#peer-avatar').outerHTML = avatarHtml(peer, { dot: !!peer.online }).replace(
      'class="avatar',
      'id="peer-avatar" class="avatar'
    );
    $('#peer-name').textContent = friendName(peer);
    updatePeerStatus();

    $('#messages').innerHTML = `<div class="empty-note">Loading…</div>`;

    try {
      const data = await api('/api/conversations/' + conversationId + '/messages');
      state.messages = data.messages;
      state.hasMore = !!data.hasMore;
      state.loadingOlder = false;
      state.partnerLastRead = data.partnerLastRead || 0;
      state.partnerLastDelivered = data.partnerLastDelivered || 0;
      // refresh peer online + block state from server response
      Object.assign(peer, {
        online: data.friend.online, lastSeen: data.friend.lastSeen,
        iBlocked: !!data.friend.iBlocked, blockedMe: !!data.friend.blockedMe,
      });
      updatePeerStatus();
      setComposerBlocked(peer);
      const conv = state.conversations.get(conversationId);
      state.current.unreadAtOpen = conv ? (conv.unread || 0) : 0;
      renderMessages();

      // clear unread locally
      if (conv) { conv.unread = 0; renderChats(); }
    } catch (e) {
      $('#messages').innerHTML = `<div class="empty-note">Could not load messages.</div>`;
    }
    renderChats();
    renderFriends();
  }

  async function openGroup(cid) {
    const conv = state.conversations.get(cid);
    saveDraft();
    if (recState) cancelVoiceRecording();
    state.current = { conversationId: cid, isGroup: true, group: (conv && conv.group) || { id: cid, name: 'Group', members: [] } };
    $('#typing-row').classList.remove('show');
    clearTimeout(state.peerTypingTimer);
    clearAttachment();
    cancelReply();
    cancelEdit();
    restoreDraft(cid);
    setComposerBlocked(null); // groups can't be blocked — make sure composer shows

    $('#chat-empty').classList.add('hidden');
    $('#chat-active').classList.remove('hidden');
    appScreen.classList.add('in-chat');
    renderGroupHeader(state.current.group);
    $('#messages').innerHTML = `<div class="empty-note">Loading…</div>`;

    try {
      const data = await api('/api/conversations/' + cid + '/messages');
      state.messages = data.messages;
      state.hasMore = !!data.hasMore;
      state.loadingOlder = false;
      state.partnerLastRead = 0;
      state.partnerLastDelivered = 0;
      if (data.group) {
        state.current.group = data.group;
        if (conv) conv.group = data.group;
        renderGroupHeader(data.group);
      }
      state.current.unreadAtOpen = conv ? (conv.unread || 0) : 0;
      renderMessages();
      if (conv) { conv.unread = 0; }
    } catch (e) {
      $('#messages').innerHTML = `<div class="empty-note">Could not load messages.</div>`;
    }
    renderChats();
  }

  function renderGroupHeader(group) {
    const au = { displayName: group.name || 'Group', avatarColor: group.avatarColor, avatarUrl: group.avatarUrl };
    $('#peer-avatar').outerHTML = avatarHtml(au).replace('class="avatar', 'id="peer-avatar" class="avatar');
    $('#peer-name').textContent = group.name || 'Group';
    const status = $('#peer-status');
    const n = group.memberCount || (group.members || []).length || 0;
    status.textContent = n + (n === 1 ? ' member' : ' members');
    status.classList.remove('online');
  }

  // The user object behind a message's sender (me, the 1-to-1 peer, or a group member).
  function msgSenderUser(m) {
    if (m.senderId === state.me.id) return state.me;
    if (state.current && state.current.isGroup) {
      return (state.current.group.members || []).find((u) => u.id === m.senderId) || { displayName: '?', avatarColor: '#8a8f98' };
    }
    return (state.current && state.current.peer) || { displayName: '?', avatarColor: '#8a8f98' };
  }

  // In a group, label the first message of each incoming run with the sender's name.
  function groupSenderLabel(m, out, grouped) {
    if (!state.current || !state.current.isGroup || out || grouped) return '';
    const u = msgSenderUser(m);
    const color = u.avatarColor || '#8a8f98';
    return `<span class="grp-sender" style="color:${color}">${escapeHtml(String(u.displayName || '').split(/\s+/)[0])}</span>`;
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

  function renderMessages(opts) {
    opts = opts || {};
    const box = $('#messages');
    if (!state.messages.length) {
      box.innerHTML = `<div class="empty-note">No messages yet. Say hello! 👋</div>`;
      return;
    }
    let html = '';
    let lastDay = '';
    let prevSender = null;
    const unread = (state.current && state.current.unreadAtOpen) || 0;
    const dividerIdx = unread >= 1 && state.messages.length > unread ? state.messages.length - unread : -1;
    state.messages.forEach((m, i) => {
      const d = dayLabel(m.createdAt);
      if (d !== lastDay) {
        html += `<div class="day-sep">${d}</div>`;
        lastDay = d;
        prevSender = null;
      }
      if (i === dividerIdx) { html += `<div class="new-divider"><span>New messages</span></div>`; prevSender = null; }
      const out = m.senderId === state.me.id;
      const grouped = prevSender === m.senderId;
      const avatar = avatarHtml(out ? state.me : msgSenderUser(m), { cls: 'm-avatar' });
      html += `
        <div class="msg ${out ? 'out' : 'in'} ${grouped ? 'grouped' : 'first'}" data-mid="${m.id}">
          ${avatar}
          ${renderBubble(m, groupSenderLabel(m, out, grouped))}
        </div>`;
      prevSender = m.senderId;
    });

    box.innerHTML = html;
    updateSeenRow();
    bindVoicePlayers();
    if (opts.preserveFromHeight != null) {
      // keep the viewport on the same message after prepending older history
      box.scrollTop = box.scrollHeight - opts.preserveFromHeight;
    } else {
      box.scrollTop = box.scrollHeight;
      if (state.current) state.current.unreadAtOpen = 0;
      newSinceScroll = 0;
    }
    updateScrollBtn();
  }

  async function loadOlderMessages() {
    if (!state.current || !state.hasMore || state.loadingOlder) return;
    const oldest = state.messages[0] && state.messages[0].id;
    if (!oldest) return;
    state.loadingOlder = true;
    const prevH = messagesEl.scrollHeight;
    try {
      const data = await api('/api/conversations/' + state.current.conversationId + '/messages?before=' + oldest);
      const older = data.messages || [];
      if (older.length) {
        state.messages = older.concat(state.messages);
        state.hasMore = !!data.hasMore;
        renderMessages({ preserveFromHeight: prevH });
      } else {
        state.hasMore = false;
      }
    } catch (e) { /* ignore */ }
    finally { state.loadingOlder = false; }
  }

  // Show a plain "Seen" label under the last outgoing message (no avatar).
  function updateSeenRow() {
    const box = $('#messages');
    const old = box.querySelector('.seen-row');
    if (old) old.remove();
    if (state.current && state.current.isGroup) return; // groups don't show a Seen row
    if (!state.messages.length) return;
    const last = state.messages[state.messages.length - 1];
    if (last && last.senderId === state.me.id && (state.partnerLastRead || 0) >= last.id) {
      box.insertAdjacentHTML('beforeend', `<div class="seen-row">Seen</div>`);
    }
  }

  // Delivery state for one of MY messages: sent (✓) · delivered (✓✓) · seen (✓✓ accent)
  function tickState(m) {
    if (state.current && state.current.isGroup) return null; // no per-member ticks in groups
    if (m.senderId !== state.me.id || m.unsent) return null;
    if ((state.partnerLastRead || 0) >= m.id) return 'seen';
    if ((state.partnerLastDelivered || 0) >= m.id) return 'delivered';
    return 'sent';
  }
  function tickHtml(m) {
    const st = tickState(m);
    if (!st) return '';
    return `<span class="ticks ${st}">${st === 'sent' ? IC.tick1 : IC.tick2}</span>`;
  }
  function updateTicks() {
    const box = $('#messages');
    if (!box) return;
    state.messages.forEach((m) => {
      const st = tickState(m);
      if (!st) return;
      const el = box.querySelector(`.msg[data-mid="${m.id}"] .ticks`);
      if (!el) return;
      el.className = 'ticks ' + st;
      el.innerHTML = st === 'sent' ? IC.tick1 : IC.tick2;
    });
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
    const avatar = avatarHtml(out ? state.me : msgSenderUser(m), { cls: 'm-avatar' });
    html += `<div class="msg ${out ? 'out' : 'in'} ${grouped ? 'grouped' : 'first'} is-new" data-mid="${m.id}">${avatar}${renderBubble(m, groupSenderLabel(m, out, grouped))}</div>`;
    // stick to bottom only if it's my message or I'm already near the bottom
    const stick = out || nearBottom(box);
    box.insertAdjacentHTML('beforeend', html);
    updateSeenRow();
    bindVoicePlayers();
    if (stick) {
      box.scrollTop = box.scrollHeight;
      newSinceScroll = 0;
    } else {
      newSinceScroll += 1;
    }
    updateScrollBtn();
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
    let who = 'You';
    if (m.replyTo.senderId !== state.me.id) {
      if (state.current && state.current.isGroup) {
        const u = (state.current.group.members || []).find((x) => x.id === m.replyTo.senderId);
        who = u ? String(u.displayName || '').split(/\s+/)[0] : '';
      } else {
        who = (state.current && state.current.peer && state.current.peer.displayName) || '';
      }
    }
    return `<div class="reply-quote" data-reply-jump="${m.replyTo.id}"><span class="rq-who">${escapeHtml(who)}</span> ${escapeHtml(m.replyTo.preview)}</div>`;
  }

  function renderBubble(m, senderLabel) {
    senderLabel = senderLabel || '';
    if (m.unsent) {
      const name = m.senderId === state.me.id ? 'You' : escapeHtml(String(msgSenderUser(m).displayName || 'They').split(/\s+/)[0]);
      return `<div class="bwrap">${senderLabel}<div class="bubble unsent">🚫 ${name} unsent a message</div></div>`;
    }
    const t = `<span class="m-time">${m.edited ? 'Edited · ' : ''}${fmtTime(m.createdAt)}${tickHtml(m)}</span>`;
    const rx = reactionsHtml(m);
    let inner;
    if (m.attachmentType === 'image') {
      const cap = m.body ? `<div class="caption">${formatText(escapeHtml(m.body))}</div>` : '';
      inner = `<div class="bubble media"><img src="${escapeHtml(mediaUrl(m.attachmentUrl))}" data-light="image" alt="image" loading="lazy">${cap}</div>`;
    } else if (m.attachmentType === 'video') {
      const cap = m.body ? `<div class="caption">${formatText(escapeHtml(m.body))}</div>` : '';
      inner = `<div class="bubble media"><video src="${escapeHtml(mediaUrl(m.attachmentUrl))}" data-light="video" controls preload="metadata"></video>${cap}</div>`;
    } else if (m.attachmentType === 'audio') {
      inner = `<div class="bubble voice">${voicePlayerHtml(m)}</div>`;
    } else if (m.attachmentType === 'file') {
      const cap = m.body ? `<div class="caption">${formatText(escapeHtml(m.body))}</div>` : '';
      inner = `<div class="bubble"><a class="file-card" href="${escapeHtml(mediaUrl(m.attachmentUrl))}" download="${escapeHtml(m.attachmentName || 'file')}" target="_blank" rel="noopener"><span class="file-ico">📎</span><span class="file-meta"><span class="file-name">${escapeHtml(m.attachmentName || 'File')}</span><span class="file-sub">Download</span></span></a>${cap}</div>`;
    } else {
      inner = `<div class="bubble">${formatText(escapeHtml(m.body))}</div>`;
    }
    return `<div class="bwrap">${senderLabel}${replyQuoteHtml(m)}${inner}${rx}${t}</div>`;
  }

  // ---------- back button (mobile) ----------
  function backToList() {
    if (recState) cancelVoiceRecording();
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
  const SEND_ICON = sendBtn.innerHTML; // original paper-plane
  const MIC_ICON = '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z"/></svg>';
  const voiceSupported = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia &&
    window.MediaRecorder && (window.AudioContext || window.webkitAudioContext));

  function refreshSendState() {
    const hasContent = msgInput.value.trim().length > 0 || !!state.attachment;
    const micMode = !hasContent && voiceSupported && !state.editing && !!state.current && !recState;
    const mode = micMode ? 'mic' : 'send';
    if (sendBtn.dataset.mode !== mode) {
      sendBtn.dataset.mode = mode;
      sendBtn.innerHTML = micMode ? MIC_ICON : SEND_ICON;
      sendBtn.classList.toggle('mic-mode', micMode);
      sendBtn.title = micMode ? 'Record voice message' : 'Send';
    }
    sendBtn.disabled = micMode ? false : !hasContent;
  }

  // Per-conversation drafts (in-memory; never persisted — privacy).
  function saveDraft() {
    if (!state.current) return;
    state.drafts = state.drafts || {};
    const v = msgInput.value;
    if (v && v.trim()) state.drafts[state.current.conversationId] = v;
    else delete state.drafts[state.current.conversationId];
  }
  function restoreDraft(id) {
    state.drafts = state.drafts || {};
    msgInput.value = state.drafts[id] || '';
    msgInput.style.height = 'auto';
    msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + 'px';
    refreshSendState();
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
  sendBtn.addEventListener('click', () => {
    if (sendBtn.dataset.mode === 'mic') startVoiceRecording();
    else sendMessage();
  });

  // Where a new message/typing event should be routed: a group (conversationId)
  // or a 1-to-1 chat (toUserId).
  function sendTarget() {
    if (!state.current) return null;
    return state.current.isGroup
      ? { conversationId: state.current.conversationId }
      : { toUserId: state.current.peer.id };
  }

  function emitTyping() {
    if (!state.current || !state.socket) return;
    const t = sendTarget();
    if (!state.isTypingSent) {
      state.socket.emit('typing', { ...t, isTyping: true });
      state.isTypingSent = true;
    }
    clearTimeout(state.sendTypingTimer);
    state.sendTypingTimer = setTimeout(() => {
      state.socket.emit('typing', { ...t, isTyping: false });
      state.isTypingSent = false;
    }, 1500);
  }
  function stopTyping() {
    if (!state.current || !state.socket) return;
    clearTimeout(state.sendTypingTimer);
    if (state.isTypingSent) {
      state.socket.emit('typing', { ...sendTarget(), isTyping: false });
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

    const payload = {
      ...sendTarget(),
      body,
      attachment: state.attachment,
      replyToId: state.replyTo ? state.replyTo.id : null,
    };
    haptic();
    if (!state.socket || !state.socket.connected) {
      queueOutbox(payload);
      toast('📨', 'Queued', "Will send when you're back online");
    } else {
      state.socket.emit('message:send', payload, (resp) => {
        if (resp && resp.error) toast('⚠️', 'Not sent', resp.error);
      });
    }

    msgInput.value = '';
    msgInput.style.height = 'auto';
    saveDraft(); // composer is empty now → clears this chat's draft
    clearAttachment();
    cancelReply();
    refreshSendState();
    stopTyping();
  }

  // ---------- attachments ----------
  const fileInput = $('#file-input');
  const cameraInput = document.getElementById('camera-input');
  $('#attach-btn').addEventListener('click', openAttachMenu);

  function openAttachMenu() {
    if (!state.current) return;
    const overlay = document.createElement('div');
    overlay.className = 'msg-menu';
    overlay.innerHTML = `
      <div class="mm-sheet">
        <div class="mm-actions">
          <button class="mm-act" data-att="camera">Camera</button>
          <button class="mm-act" data-att="media">Photo &amp; Video</button>
          <button class="mm-act" data-att="file">File</button>
          <button class="mm-act" data-cancel="1">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));
    const openedAt = Date.now();
    const close = () => { overlay.classList.remove('show'); setTimeout(() => overlay.remove(), 200); };
    overlay.addEventListener('click', (e) => {
      const a = e.target.closest('[data-att]');
      if (a) {
        const kind = a.dataset.att;
        close();
        if (kind === 'camera') { cameraInput.click(); }
        else if (kind === 'media') { fileInput.accept = 'image/*,video/*'; fileInput.click(); }
        else { fileInput.accept = 'image/*,video/*,.pdf,.doc,.docx,.txt,.zip'; fileInput.click(); }
        return;
      }
      if (e.target.closest('[data-cancel]')) return close();
      if (e.target === overlay && Date.now() - openedAt > 200) close();
    });
  }

  async function handlePickedFiles(files) {
    files = Array.from(files || []);
    if (!files.length) return;
    const tooBig = files.find((f) => f.size > 50 * 1024 * 1024);
    if (tooBig) { toast('⚠️', 'Too large', 'Max file size is 50 MB.'); return; }
    if (files.length === 1) { await uploadAttachment(files[0]); return; }
    await sendMultipleFiles(files);
  }

  // Send several files at once (album) — each becomes its own message.
  async function sendMultipleFiles(files) {
    if (!state.current || !state.socket) return;
    toast('📨', 'Sending', `Uploading ${files.length} items…`);
    for (const f of files) {
      try {
        let file = f;
        if (f.type.startsWith('image/')) { try { file = await compressImage(f); } catch (e) {} }
        const fd = new FormData();
        fd.append('file', file);
        const data = await api('/api/upload', { method: 'POST', body: fd, raw: true });
        if (!state.current) return;
        state.socket.emit('message:send', {
          ...sendTarget(), body: '',
          attachment: { url: data.url, type: data.type, name: data.name, size: data.size },
          replyToId: null,
        });
      } catch (e) { toast('⚠️', 'Upload failed', e.message); }
    }
  }

  fileInput.addEventListener('change', async () => {
    const files = fileInput.files;
    fileInput.value = '';
    await handlePickedFiles(files);
  });
  if (cameraInput) cameraInput.addEventListener('change', async () => {
    const file = cameraInput.files[0];
    cameraInput.value = '';
    if (file) await uploadAttachment(file);
  });

  // Paste an image straight into the composer
  msgInput.addEventListener('paste', (e) => {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    for (const it of items) {
      if (it.type && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) { e.preventDefault(); uploadAttachment(f); return; }
      }
    }
  });

  // Drag & drop files onto the chat
  (function () {
    const drop = document.getElementById('chat-active');
    if (!drop) return;
    let depth = 0;
    drop.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; if (state.current) drop.classList.add('drag-over'); });
    drop.addEventListener('dragover', (e) => { e.preventDefault(); });
    drop.addEventListener('dragleave', (e) => { e.preventDefault(); if (--depth <= 0) drop.classList.remove('drag-over'); });
    drop.addEventListener('drop', (e) => {
      e.preventDefault(); depth = 0; drop.classList.remove('drag-over');
      if (state.current) handlePickedFiles(e.dataTransfer && e.dataTransfer.files);
    });
  })();

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
  // VOICE MESSAGES (recorded in-browser, re-encoded to WAV so they play on
  // every device — Android records webm/opus that iPhone Safari can't play)
  // ============================================================
  let recState = null; // { mr, stream, chunks, startTime, cancelled, timer }

  function fmtDur(sec) {
    sec = Math.max(0, Math.round(sec));
    const m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  async function startVoiceRecording() {
    if (!state.current || recState) return;
    if (state.current.peer && state.current.peer.iBlocked) { toast('🚫', 'Blocked', 'Unblock to send'); return; }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      toast('🎤', 'Mic blocked', 'Allow microphone access to record voice');
      return;
    }
    let mr;
    try { mr = new MediaRecorder(stream); }
    catch (e) { stream.getTracks().forEach((t) => t.stop()); toast('⚠️', 'Cannot record', 'Voice not supported here'); return; }
    const chunks = [];
    mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    mr.onstop = finishVoiceRecording;
    recState = { mr, stream, chunks, startTime: Date.now(), cancelled: false, timer: null };
    mr.start();
    showRecordingBar();
    refreshSendState();
  }

  function stopVoiceRecording() { if (recState) { try { recState.mr.stop(); } catch (e) {} } }
  function cancelVoiceRecording() { if (recState) { recState.cancelled = true; try { recState.mr.stop(); } catch (e) {} } }

  async function finishVoiceRecording() {
    const r = recState; recState = null;
    hideRecordingBar();
    refreshSendState();
    if (r.timer) clearInterval(r.timer);
    if (r.stream) r.stream.getTracks().forEach((t) => t.stop());
    const dur = (Date.now() - r.startTime) / 1000;
    if (r.cancelled || !r.chunks.length) return;
    if (dur < 1) { toast('🎤', 'Too short', 'Hold a little longer'); return; }
    const blob = new Blob(r.chunks, { type: (r.chunks[0] && r.chunks[0].type) || 'audio/webm' });
    let wav;
    try { wav = await blobToWav(blob); }
    catch (e) { toast('⚠️', 'Recording failed', 'Could not process audio'); return; }
    await sendVoiceMessage(wav, dur);
  }

  async function sendVoiceMessage(wavBlob, durationSec) {
    const file = new File([wavBlob], 'voice.wav', { type: 'audio/wav' });
    const fd = new FormData();
    fd.append('file', file);
    let data;
    try { data = await api('/api/upload', { method: 'POST', body: fd, raw: true }); }
    catch (e) { toast('⚠️', 'Upload failed', e.message); return; }
    state.socket.emit('message:send', {
      ...sendTarget(),
      body: '',
      attachment: { url: data.url, type: 'audio', name: fmtDur(durationSec), size: data.size },
      replyToId: state.replyTo ? state.replyTo.id : null,
    }, (resp) => { if (resp && resp.error) toast('⚠️', 'Not sent', resp.error); });
    cancelReply();
  }

  function showRecordingBar() {
    const composer = document.querySelector('.composer');
    let bar = document.getElementById('rec-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'rec-bar';
      bar.className = 'rec-bar';
      composer.parentNode.insertBefore(bar, composer);
    }
    bar.innerHTML = `
      <button class="rec-cancel" id="rec-cancel" aria-label="Cancel recording">
        <svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M6 7h12l-1 13a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 7Zm9-3 1 2h4v2H4V6h4l1-2h6Z"/></svg>
      </button>
      <span class="rec-dot"></span>
      <span class="rec-time" id="rec-time">0:00</span>
      <span class="rec-hint">Recording…</span>
      <button class="rec-send" id="rec-send" aria-label="Send voice">${SEND_ICON}</button>`;
    bar.classList.remove('hidden');
    composer.classList.add('hidden');
    bar.querySelector('#rec-cancel').onclick = cancelVoiceRecording;
    bar.querySelector('#rec-send').onclick = stopVoiceRecording;
    const timeEl = bar.querySelector('#rec-time');
    recState.timer = setInterval(() => {
      const s = (Date.now() - recState.startTime) / 1000;
      timeEl.textContent = fmtDur(s);
      if (s >= 300) stopVoiceRecording(); // 5-minute cap
    }, 250);
  }
  function hideRecordingBar() {
    const bar = document.getElementById('rec-bar');
    if (bar) bar.classList.add('hidden');
    const composer = document.querySelector('.composer');
    const blocked = state.current && state.current.peer && state.current.peer.iBlocked;
    if (composer && !blocked) composer.classList.remove('hidden');
  }

  // Decode whatever was recorded and re-encode to 16 kHz mono 16-bit WAV.
  async function blobToWav(blob) {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    try {
      const buf = await blob.arrayBuffer();
      const audio = await new Promise((resolve, reject) => {
        let ret;
        try { ret = ctx.decodeAudioData(buf, resolve, reject); } catch (e) { reject(e); return; }
        if (ret && typeof ret.then === 'function') ret.then(resolve, reject);
      });
      const rate = 16000;
      const mono = downmixMono(audio);
      const res = resampleLinear(mono, audio.sampleRate, rate);
      return encodeWav(res, rate);
    } finally { try { ctx.close(); } catch (e) {} }
  }
  function downmixMono(audioBuf) {
    const ch = audioBuf.numberOfChannels;
    if (ch === 1) return audioBuf.getChannelData(0).slice();
    const len = audioBuf.length;
    const out = new Float32Array(len);
    for (let c = 0; c < ch; c++) {
      const d = audioBuf.getChannelData(c);
      for (let i = 0; i < len; i++) out[i] += d[i] / ch;
    }
    return out;
  }
  function resampleLinear(data, fromRate, toRate) {
    if (fromRate === toRate) return data;
    const ratio = fromRate / toRate;
    const outLen = Math.floor(data.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const idx = i * ratio;
      const i0 = Math.floor(idx), i1 = Math.min(i0 + 1, data.length - 1);
      out[i] = data[i0] + (data[i1] - data[i0]) * (idx - i0);
    }
    return out;
  }
  function encodeWav(samples, rate) {
    const buf = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buf);
    const wstr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    wstr(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); wstr(8, 'WAVE');
    wstr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    wstr(36, 'data'); view.setUint32(40, samples.length * 2, true);
    let off = 44;
    for (let i = 0; i < samples.length; i++) {
      let s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      off += 2;
    }
    return new Blob([view], { type: 'audio/wav' });
  }

  // Custom voice-message player (play/pause + scrubber + duration).
  function voicePlayerHtml(m) {
    const label = (m.attachmentName && /^\d+:\d\d$/.test(m.attachmentName)) ? m.attachmentName : '🎤';
    return `<div class="vp" data-vp>
      <button class="vp-btn" data-vp-toggle aria-label="Play">${IC.play}</button>
      <div class="vp-track" data-vp-track><div class="vp-fill"></div></div>
      <span class="vp-dur">${escapeHtml(label)}</span>
      <button class="vp-speed" data-vp-speed aria-label="Playback speed">1×</button>
      <audio src="${escapeHtml(mediaUrl(m.attachmentUrl))}" preload="metadata"></audio>
    </div>`;
  }
  function bindVoicePlayers() {
    $$('#messages .vp').forEach((vp) => {
      if (vp.dataset.bound) return;
      vp.dataset.bound = '1';
      const audio = vp.querySelector('audio');
      const fill = vp.querySelector('.vp-fill');
      const btn = vp.querySelector('[data-vp-toggle]');
      const durEl = vp.querySelector('.vp-dur');
      if (!audio) return;
      const setIcon = () => { btn.innerHTML = audio.paused ? IC.play : IC.pause; vp.classList.toggle('playing', !audio.paused); };
      audio.addEventListener('loadedmetadata', () => {
        if (isFinite(audio.duration) && audio.duration > 0 && durEl) durEl.textContent = fmtDur(audio.duration);
      });
      audio.addEventListener('timeupdate', () => { if (audio.duration && fill) fill.style.width = (audio.currentTime / audio.duration * 100) + '%'; });
      audio.addEventListener('play', setIcon);
      audio.addEventListener('pause', setIcon);
      audio.addEventListener('ended', () => { if (fill) fill.style.width = '0%'; setIcon(); });
      setIcon();
    });
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
    if (env.isGroup) return onGroupMessageNew(env);
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

    // I received it — tell the sender it was delivered (✓✓), even if I'm not
    // looking at this chat right now.
    if (!isMine) state.socket.emit('message:delivered', { conversationId: convId });

    if (isOpen) {
      state.messages.push(msg);
      appendMessage(msg);
      conv.unread = 0;
      if (!isMine) {
        state.socket.emit('message:read', { conversationId: convId });
      }
    } else if (!isMine) {
      conv.unread = (conv.unread || 0) + 1;
      if (!conv.muted) toast('💬', friendName(friend), previewText(msg, conv), () => openConversation(convId, friend.id));
    }

    renderChats();
  }

  function onGroupMessageNew(env) {
    const msg = env.message;
    const convId = env.conversationId || msg.conversationId;
    const isMine = msg.senderId === state.me.id;
    const isOpen = state.current && state.current.isGroup && state.current.conversationId === convId;

    let conv = state.conversations.get(convId);
    if (!conv) {
      // we don't have this group yet — pull the list so it appears correctly
      conv = { id: convId, isGroup: true, group: { id: convId, name: 'Group', members: env.sender ? [env.sender] : [] }, lastMessage: msg, unread: 0 };
      state.conversations.set(convId, conv);
      loadConversations().then(renderChats).catch(() => {});
    }
    conv.lastMessage = msg;
    // learn the sender as a group member if we didn't know them
    if (env.sender && conv.group && !(conv.group.members || []).some((u) => u.id === env.sender.id)) {
      conv.group.members = (conv.group.members || []).concat(env.sender);
    }

    if (isOpen) {
      state.messages.push(msg);
      appendMessage(msg);
      conv.unread = 0;
      if (!isMine) state.socket.emit('message:read', { conversationId: convId });
    } else if (!isMine) {
      conv.unread = (conv.unread || 0) + 1;
      if (!conv.muted) {
        const who = env.sender ? String(env.sender.displayName || '').split(/\s+/)[0] : '';
        toast('👥', conv.group.name || 'Group', (who ? who + ': ' : '') + previewText(msg).replace(/^You: /, ''), () => openGroup(convId));
      }
    }
    renderChats();
  }

  function onMessageRead(payload) {
    if (state.current && state.current.conversationId === payload.conversationId) {
      if (payload.byUserId !== state.me.id) {
        state.partnerLastRead = Math.max(state.partnerLastRead || 0, payload.lastReadMessageId);
        updateSeenRow();
        updateTicks();
      }
    }
  }

  function onMessageDelivered(payload) {
    if (state.current && state.current.conversationId === payload.conversationId) {
      if (payload.byUserId !== state.me.id) {
        state.partnerLastDelivered = Math.max(state.partnerLastDelivered || 0, payload.lastDeliveredMessageId);
        updateTicks();
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
    if (state.current && state.current.peer && state.current.peer.id === payload.userId) {
      Object.assign(state.current.peer, { online: payload.online, lastSeen: payload.lastSeen });
      updatePeerStatus();
    }
    renderChats();
    renderFriends();
  }

  function onTyping(payload) {
    if (!state.current || state.current.conversationId !== payload.conversationId) return;
    if (payload.fromUserId === state.me.id) return;
    const isGroup = state.current.isGroup;
    if (!isGroup && payload.fromUserId !== state.current.peer.id) return;
    const row = $('#typing-row');
    clearTimeout(state.peerTypingTimer);
    if (payload.isTyping) {
      const name = isGroup ? (payload.fromName || 'Someone') : state.current.peer.displayName;
      $('#typing-text').textContent = name + ' is typing';
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
    // tap a reply quote -> jump to the original message
    const jump = e.target.closest('[data-reply-jump]');
    if (jump) { jumpToMessage(Number(jump.dataset.replyJump)); return; }
    // voice player: play/pause + scrub
    const toggle = e.target.closest('[data-vp-toggle]');
    if (toggle) {
      const audio = toggle.closest('.vp').querySelector('audio');
      if (audio) {
        $$('#messages audio').forEach((a) => { if (a !== audio) a.pause(); });
        if (audio.paused) audio.play().catch(() => {}); else audio.pause();
      }
      return;
    }
    const track = e.target.closest('[data-vp-track]');
    if (track) {
      const audio = track.closest('.vp').querySelector('audio');
      if (audio && audio.duration) {
        const rect = track.getBoundingClientRect();
        audio.currentTime = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) * audio.duration;
      }
      return;
    }
    const sp = e.target.closest('[data-vp-speed]');
    if (sp) {
      const audio = sp.closest('.vp').querySelector('audio');
      const speeds = [1, 1.5, 2];
      const next = speeds[(speeds.indexOf(audio.playbackRate || 1) + 1) % speeds.length] || 1;
      audio.playbackRate = next;
      sp.textContent = next + '×';
      return;
    }
    const light = e.target.closest('[data-light]');
    if (!light) return;
    const type = light.dataset.light;
    const body = $('#lightbox-body');
    if (type === 'image') {
      body.innerHTML = `<img class="lb-img" src="${light.getAttribute('src')}" alt="">`;
      setupImageZoom(body.querySelector('.lb-img'));
    } else {
      body.innerHTML = `<video src="${light.getAttribute('src')}" controls autoplay></video>`;
    }
    $('#lightbox').classList.remove('hidden');
  });
  $('#lightbox-close').addEventListener('click', closeLightbox);
  $('#lightbox').addEventListener('click', (e) => {
    if (e.target.id === 'lightbox' || e.target.id === 'lightbox-body') closeLightbox();
  });
  function closeLightbox() {
    $('#lightbox-body').innerHTML = '';
    $('#lightbox').classList.add('hidden');
  }

  // Save the open photo/video to the device (before it auto-expires at 24h).
  const dlBtn = document.getElementById('lightbox-download');
  if (dlBtn) dlBtn.addEventListener('click', async () => {
    const el = $('#lightbox-body').querySelector('img, video');
    if (!el) return;
    const src = el.getAttribute('src');
    const isVid = el.tagName === 'VIDEO';
    dlBtn.classList.add('busy');
    try {
      const resp = await fetch(src, { mode: 'cors' });
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'tea-' + Date.now() + (isVid ? '.mp4' : '.jpg');
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast('✅', 'Saved', isVid ? 'Video downloaded' : 'Photo downloaded');
    } catch (e) {
      // CORS / iOS fallback: open it so they can long-press → Save
      window.open(src, '_blank');
    } finally {
      dlBtn.classList.remove('busy');
    }
  });

  // Pinch / wheel / double-tap zoom + drag-to-pan for the lightbox image.
  function setupImageZoom(img) {
    if (!img) return;
    let scale = 1, tx = 0, ty = 0;
    let startDist = 0, startScale = 1;
    let panning = false, sx = 0, sy = 0, stx = 0, sty = 0;
    let lastTap = 0;
    const smooth = (on) => { img.style.transition = on ? 'transform .2s cubic-bezier(.2,.8,.2,1)' : 'none'; };
    const apply = () => {
      img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
      img.style.cursor = scale > 1 ? 'grab' : 'zoom-in';
    };
    const clamp = () => {
      const maxX = (img.clientWidth * (scale - 1)) / 2;
      const maxY = (img.clientHeight * (scale - 1)) / 2;
      tx = Math.max(-maxX, Math.min(maxX, tx));
      ty = Math.max(-maxY, Math.min(maxY, ty));
    };
    const reset = () => { smooth(true); scale = 1; tx = 0; ty = 0; apply(); };
    const zoomTo = (s) => { smooth(true); scale = s; clamp(); apply(); };
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

    img.addEventListener('wheel', (e) => {
      e.preventDefault();
      smooth(false);
      scale = Math.min(5, Math.max(1, scale - e.deltaY * 0.002 * scale));
      if (scale === 1) { tx = 0; ty = 0; }
      clamp(); apply();
    }, { passive: false });

    img.addEventListener('dblclick', (e) => { e.preventDefault(); scale > 1 ? reset() : zoomTo(2.5); });

    img.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        startDist = dist(e.touches); startScale = scale; smooth(false);
      } else if (e.touches.length === 1) {
        const now = Date.now();
        if (now - lastTap < 300) { scale > 1 ? reset() : zoomTo(2.5); }
        lastTap = now;
        if (scale > 1) { panning = true; smooth(false); sx = e.touches[0].clientX; sy = e.touches[0].clientY; stx = tx; sty = ty; }
      }
    }, { passive: true });

    img.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        scale = Math.min(5, Math.max(1, startScale * (dist(e.touches) / (startDist || 1))));
        if (scale === 1) { tx = 0; ty = 0; }
        clamp(); apply();
      } else if (panning && e.touches.length === 1) {
        e.preventDefault();
        tx = stx + (e.touches[0].clientX - sx);
        ty = sty + (e.touches[0].clientY - sy);
        clamp(); apply();
      }
    }, { passive: false });

    img.addEventListener('touchend', (e) => { if (e.touches.length === 0) panning = false; });

    // mouse drag-to-pan (desktop) — listeners added per drag and cleaned up after
    img.addEventListener('mousedown', (e) => {
      if (scale <= 1) return;
      e.preventDefault(); panning = true; smooth(false);
      sx = e.clientX; sy = e.clientY; stx = tx; sty = ty;
      img.style.cursor = 'grabbing';
      const move = (ev) => { tx = stx + (ev.clientX - sx); ty = sty + (ev.clientY - sy); clamp(); apply(); };
      const up = () => {
        panning = false; apply();
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });

    apply();
  }

  // If media was auto-deleted (24h privacy clear), show a tidy placeholder
  // instead of a broken-image icon. Error events don't bubble, so capture them.
  const GONE_IC = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18M21 15l-5-5M3 5.5A1.5 1.5 0 0 1 4.5 4H17M21 8v9.5a1.5 1.5 0 0 1-1.5 1.5H6"/></svg>';
  document.addEventListener('error', (e) => {
    const t = e.target;
    if (!t || t.tagName !== 'IMG') return;
    const wrap = t.closest('.bubble.media');
    if (wrap && !wrap.querySelector('.media-gone')) {
      t.remove();
      wrap.insertAdjacentHTML('afterbegin', `<div class="media-gone">${GONE_IC}<span>Photo expired</span></div>`);
    }
  }, true);

  // ============================================================
  // MESSAGE ACTIONS (react · unsend · copy) — long-press / right-click
  // ============================================================
  const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '😡'];
  const EMOJI_PICKER =['👍','👎','❤️','🔥','😂','🤣','😊','😍','🥰','😘','😎','🤩','😋','😅','😭','😢','😡','🤬','😱','😨','😴','🤔','🙄','😏','😬','🤗','🥺','🙏','👏','🙌','💪','👌','✌️','🤝','💯','✨','⭐','🎉','🎊','🥳','💀','👻','🤡','💩','🤖','👀','💔','💖','💕','💜','💙','💚','🧡','🤍','🌹','🌸','🍀','☀️','🌙','⚡','🍕','🍔','🍓','☕','🍵','🎂','🍻','⚽','🏀','🎮','🎵','📷','💸','🚀','🏆'];
  const messagesEl = $('#messages');
  let pressTimer = null;
  let touchState = null;
  let lastTapTime = 0;
  let lastTapEl = null;

  // Scroll to a message and flash a highlight (used by reply-quote taps).
  function jumpToMessage(id) {
    const el = messagesEl.querySelector(`.msg[data-mid="${id}"]`);
    if (!el) { toast('🔎', 'Unavailable', 'That message is no longer here'); return; }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('jump-hl');
    void el.offsetWidth;
    el.classList.add('jump-hl');
    setTimeout(() => el.classList.remove('jump-hl'), 1600);
  }

  // Double-tap / double-click a bubble to ❤️ it (toggles).
  function quickLike(msgEl, target) {
    if (target && target.closest('img,video,audio,a,.vp,[data-light],[data-reply-jump]')) return;
    const m = state.messages.find((x) => x.id === Number(msgEl.dataset.mid));
    if (m && !m.unsent) reactToMessage(m.id, '❤️');
  }
  messagesEl.addEventListener('dblclick', (e) => {
    const msgEl = e.target.closest('.msg[data-mid]');
    if (msgEl) quickLike(msgEl, e.target);
  });

  // Scroll-to-bottom floating button (+ count of new messages while scrolled up).
  let newSinceScroll = 0;
  function nearBottom(box) { return box.scrollHeight - box.scrollTop - box.clientHeight < 140; }
  function updateScrollBtn() {
    const btn = document.getElementById('scroll-bottom');
    if (!btn) return;
    const show = !nearBottom(messagesEl);
    btn.classList.toggle('hidden', !show);
    const cnt = document.getElementById('sb-count');
    if (cnt) {
      if (show && newSinceScroll > 0) { cnt.textContent = newSinceScroll > 99 ? '99+' : String(newSinceScroll); cnt.classList.remove('hidden'); }
      else cnt.classList.add('hidden');
    }
    if (!show) newSinceScroll = 0;
  }
  messagesEl.addEventListener('scroll', () => {
    updateScrollBtn();
    if (messagesEl.scrollTop < 80) loadOlderMessages();
  }, { passive: true });
  (function () {
    const btn = document.getElementById('scroll-bottom');
    if (btn) btn.addEventListener('click', () => {
      messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' });
      newSinceScroll = 0;
      setTimeout(updateScrollBtn, 350);
    });
  })();

  function onTouchStart(e) {
    const msgEl = e.target.closest('.msg[data-mid]');
    if (!msgEl) return;
    const now = Date.now();
    if (lastTapEl === msgEl && now - lastTapTime < 300) {
      // double tap -> quick like
      clearTimeout(pressTimer); pressTimer = null;
      touchState = null; lastTapTime = 0; lastTapEl = null;
      quickLike(msgEl, e.target);
      return;
    }
    lastTapTime = now; lastTapEl = msgEl;
    const t = e.touches[0];
    touchState = { el: msgEl, startX: t.clientX, startY: t.clientY, swiping: false };
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      pressTimer = null;
      if (touchState && !touchState.swiping) { haptic(18); openMsgMenu(msgEl); }
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
      if (m && !m.unsent) { haptic(15); startReply(m); }
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
    if (m.attachmentType === 'audio') return '🎤 Voice message';
    if (m.attachmentType === 'file') return '📎 ' + (m.attachmentName || 'File');
    return (m.body || '').slice(0, 90);
  }
  function showReplyBar() {
    if (!state.replyTo) return;
    const who = state.replyTo.senderId === state.me.id
      ? 'yourself'
      : (state.current && state.current.isGroup
          ? String(msgSenderUser(state.replyTo).displayName || 'them').split(/\s+/)[0]
          : ((state.current && state.current.peer && state.current.peer.displayName) || 'them'));
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
          ${(m.body || m.attachmentUrl) ? `<button class="mm-act" data-forward="1">Forward</button>` : ''}
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
      if (e.target.closest('[data-forward]')) { close(); openForward(m); return; }
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

  function openForward(m) {
    const attachment = m.attachmentUrl
      ? { url: m.attachmentUrl, type: m.attachmentType, name: m.attachmentName }
      : null;
    const body = m.body || '';
    const friends = Array.from(state.friends.values()).sort((a, b) =>
      a.displayName.localeCompare(b.displayName)
    );
    const selected = new Set();
    const overlay = document.createElement('div');
    overlay.className = 'msg-menu';
    overlay.innerHTML = `
      <div class="mm-sheet fwd-sheet">
        <div class="settings-title">Forward to…</div>
        ${friends.length ? '' : '<div class="empty-note">No friends to forward to.</div>'}
        <div class="fwd-list">
          ${friends.map((f) => `
            <button class="fwd-row" data-fid="${f.id}">
              ${avatarHtml(f)}
              <span class="fwd-name">${escapeHtml(friendName(f))}</span>
              <span class="fwd-check">${IC.check}</span>
            </button>`).join('')}
        </div>
        <div class="mm-actions">
          <button class="mm-act primary" id="fwd-send" disabled>Send</button>
          <button class="mm-act" data-cancel="1">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));
    const openedAt = Date.now();
    const close = () => { overlay.classList.remove('show'); setTimeout(() => overlay.remove(), 220); };
    const sendBtn = overlay.querySelector('#fwd-send');
    overlay.addEventListener('click', (e) => {
      const row = e.target.closest('[data-fid]');
      if (row) {
        const id = Number(row.dataset.fid);
        if (selected.has(id)) { selected.delete(id); row.classList.remove('sel'); }
        else { selected.add(id); row.classList.add('sel'); }
        sendBtn.disabled = selected.size === 0;
        sendBtn.textContent = selected.size > 1 ? `Send (${selected.size})` : 'Send';
        return;
      }
      if (e.target.closest('#fwd-send')) {
        if (!selected.size || !state.socket) return;
        selected.forEach((toUserId) => {
          state.socket.emit('message:send', { toUserId, body, attachment, replyToId: null }, (resp) => {
            if (resp && resp.error) toast('⚠️', 'Not forwarded', resp.error);
          });
        });
        close();
        toast('↪️', 'Forwarded', selected.size > 1 ? `Sent to ${selected.size} chats` : 'Message forwarded');
        return;
      }
      if (e.target.closest('[data-cancel]')) return close();
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
    haptic();
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
    const conv = state.conversations.get(payload.conversationId);
    if (conv && conv.isGroup) {
      conv.lastMessage = null;
      conv.unread = 0;
    } else {
      state.conversations.delete(payload.conversationId);
    }
    if (state.current && state.current.conversationId === payload.conversationId) {
      state.messages = [];
      if (state.current.isGroup) renderMessages(); // stay in the now-empty group
      else backToList();
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

  // ---- group real-time events ----
  function onConversationNew(payload) {
    const c = payload && payload.conversation;
    if (!c) return;
    const existed = state.conversations.has(c.id);
    state.conversations.set(c.id, { ...state.conversations.get(c.id), ...c });
    renderChats();
    // only toast people who were just added (not the creator, who already has it)
    if (c.isGroup && !existed) toast('👥', 'New group', (c.group && c.group.name) || 'You were added to a group', () => openGroup(c.id));
  }
  function onGroupUpdated(payload) {
    const g = payload && payload.group;
    if (!g) return;
    const conv = state.conversations.get(g.id);
    if (conv) { conv.isGroup = true; conv.group = g; }
    if (state.current && state.current.isGroup && state.current.conversationId === g.id) {
      state.current.group = g;
      renderGroupHeader(g);
      renderMessages();
    }
    renderChats();
  }
  function onGroupRemoved(payload) {
    const cid = payload && payload.conversationId;
    if (!cid) return;
    state.conversations.delete(cid);
    if (state.current && state.current.conversationId === cid) backToList();
    renderChats();
  }

  // ---- chat header menu: delete conversation / unfriend ----
  const chatMoreBtn = document.getElementById('chat-more-btn');
  if (chatMoreBtn) chatMoreBtn.addEventListener('click', openChatMenu);

  function openChatMenu() {
    if (!state.current) return;
    if (state.current.isGroup) return openGroupMenu();
    const peer = state.current.peer;
    const cid = state.current.conversationId;
    const conv = state.conversations.get(cid) || {};
    const overlay = document.createElement('div');
    overlay.className = 'msg-menu';
    overlay.innerHTML = `
      <div class="mm-sheet">
        <div class="mm-actions">
          <button class="mm-act" data-pin="1">${conv.pinned ? 'Unpin' : 'Pin'} conversation</button>
          <button class="mm-act" data-mute="1">${conv.muted ? 'Unmute' : 'Mute'} notifications</button>
          <button class="mm-act" data-rename="1">Rename</button>
          <button class="mm-act" data-delconv="1">Delete conversation</button>
          <button class="mm-act ${peer.iBlocked ? '' : 'danger'}" data-block="1">${peer.iBlocked ? 'Unblock' : 'Block'} ${escapeHtml(friendName(peer))}</button>
          <button class="mm-act danger" data-unfriend="1">Unfriend ${escapeHtml(friendName(peer))}</button>
          <button class="mm-act" data-cancel="1">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));
    const close = () => { overlay.classList.remove('show'); setTimeout(() => overlay.remove(), 220); };
    overlay.addEventListener('click', (e) => {
      if (e.target.closest('[data-pin]')) { close(); toggleConvPref(cid, 'pinned', !conv.pinned); return; }
      if (e.target.closest('[data-mute]')) { close(); toggleConvPref(cid, 'muted', !conv.muted); return; }
      if (e.target.closest('[data-rename]')) { close(); openRenameFriend(peer); return; }
      if (e.target.closest('[data-delconv]')) { close(); if (confirm('Delete this conversation for both of you?')) deleteConversation(cid); return; }
      if (e.target.closest('[data-block]')) { close(); toggleBlock(peer, !peer.iBlocked); return; }
      if (e.target.closest('[data-unfriend]')) { close(); if (confirm('Unfriend ' + friendName(peer) + '?')) unfriend(peer.id); return; }
      if (e.target.closest('[data-cancel]') || e.target === overlay) close();
    });
  }

  function openGroupMenu() {
    const cid = state.current.conversationId;
    const conv = state.conversations.get(cid) || {};
    const group = state.current.group || {};
    const n = group.memberCount || (group.members || []).length || 0;
    const overlay = document.createElement('div');
    overlay.className = 'msg-menu';
    overlay.innerHTML = `
      <div class="mm-sheet">
        <div class="mm-actions">
          <button class="mm-act" data-pin="1">${conv.pinned ? 'Unpin' : 'Pin'} conversation</button>
          <button class="mm-act" data-mute="1">${conv.muted ? 'Unmute' : 'Mute'} notifications</button>
          <button class="mm-act" data-members="1">View members (${n})</button>
          <button class="mm-act" data-rename="1">Rename group</button>
          <button class="mm-act" data-photo="1">Change group photo</button>
          <button class="mm-act" data-add="1">Add people</button>
          <button class="mm-act" data-delconv="1">Clear messages</button>
          <button class="mm-act danger" data-leave="1">Leave group</button>
          <button class="mm-act" data-cancel="1">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));
    const close = () => { overlay.classList.remove('show'); setTimeout(() => overlay.remove(), 220); };
    overlay.addEventListener('click', (e) => {
      if (e.target.closest('[data-pin]')) { close(); toggleConvPref(cid, 'pinned', !conv.pinned); return; }
      if (e.target.closest('[data-mute]')) { close(); toggleConvPref(cid, 'muted', !conv.muted); return; }
      if (e.target.closest('[data-members]')) { close(); openGroupMembers(group); return; }
      if (e.target.closest('[data-rename]')) { close(); openRenameGroup(cid, group); return; }
      if (e.target.closest('[data-photo]')) { close(); changeGroupPhoto(cid); return; }
      if (e.target.closest('[data-add]')) { close(); openAddMembers(cid, group); return; }
      if (e.target.closest('[data-delconv]')) { close(); if (confirm('Clear all messages in this group?')) deleteConversation(cid); return; }
      if (e.target.closest('[data-leave]')) { close(); if (confirm('Leave “' + (group.name || 'this group') + '”?')) leaveGroup(cid); return; }
      if (e.target.closest('[data-cancel]') || e.target === overlay) close();
    });
  }

  function openGroupMembers(group) {
    const members = group.members || [];
    const overlay = document.createElement('div');
    overlay.className = 'msg-menu';
    overlay.innerHTML = `
      <div class="mm-sheet">
        <div class="settings-title">Members</div>
        <div class="fwd-list">
          ${members.map((u) => `
            <div class="fwd-row">
              ${avatarHtml(u)}
              <span class="fwd-name">${escapeHtml(u.displayName)}${u.id === state.me.id ? ' (you)' : ''}${u.id === group.ownerId ? ' · admin' : ''}</span>
            </div>`).join('')}
        </div>
        <div class="mm-actions"><button class="mm-act" data-cancel="1">Close</button></div>
      </div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));
    const close = () => { overlay.classList.remove('show'); setTimeout(() => overlay.remove(), 200); };
    overlay.addEventListener('click', (e) => { if (e.target.closest('[data-cancel]') || e.target === overlay) close(); });
  }

  function openRenameGroup(cid, group) {
    const overlay = document.createElement('div');
    overlay.className = 'modal';
    overlay.innerHTML = `
      <div class="modal-card">
        <h3>Rename group</h3>
        <div class="field"><label>Group name</label><input id="gr-name" maxlength="60" value="${escapeHtml(group.name || '')}"></div>
        <div class="modal-actions">
          <button class="btn-soft" data-cancel="1">Cancel</button>
          <button class="btn-primary" id="gr-save">Save</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));
    const close = () => { overlay.classList.remove('show'); setTimeout(() => overlay.remove(), 220); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay || e.target.closest('[data-cancel]')) close(); });
    overlay.querySelector('#gr-save').addEventListener('click', async () => {
      const name = overlay.querySelector('#gr-name').value.trim();
      if (!name) return;
      try {
        const r = await api('/api/groups/' + cid + '/rename', { method: 'POST', body: { name } });
        applyGroupMeta(cid, r.group);
        close();
        toast('✏️', 'Renamed', 'Group is now “' + name + '”');
      } catch (e2) { toast('⚠️', 'Error', e2.message); }
    });
  }

  function changeGroupPhoto(cid) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      try {
        const img = await compressImage(file);
        const fd = new FormData();
        fd.append('file', img);
        fd.append('kind', 'avatar');
        const data = await api('/api/upload', { method: 'POST', body: fd, raw: true });
        const r = await api('/api/groups/' + cid + '/photo', { method: 'POST', body: { avatarUrl: data.url } });
        applyGroupMeta(cid, r.group);
        toast('✅', 'Updated', 'Group photo changed');
      } catch (e2) { toast('⚠️', 'Error', e2.message || 'Upload failed'); }
    };
    input.click();
  }

  function openAddMembers(cid, group) {
    const memberIds = new Set((group.members || []).map((u) => u.id));
    const candidates = Array.from(state.friends.values()).filter((f) => !memberIds.has(f.id))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
    const selected = new Set();
    const overlay = document.createElement('div');
    overlay.className = 'msg-menu';
    overlay.innerHTML = `
      <div class="mm-sheet fwd-sheet">
        <div class="settings-title">Add people</div>
        ${candidates.length ? '' : '<div class="empty-note">All your friends are already in.</div>'}
        <div class="fwd-list">
          ${candidates.map((f) => `
            <button class="fwd-row" data-fid="${f.id}">
              ${avatarHtml(f)}
              <span class="fwd-name">${escapeHtml(friendName(f))}</span>
              <span class="fwd-check">${IC.check}</span>
            </button>`).join('')}
        </div>
        <div class="mm-actions">
          <button class="mm-act primary" id="add-go" disabled>Add</button>
          <button class="mm-act" data-cancel="1">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));
    const close = () => { overlay.classList.remove('show'); setTimeout(() => overlay.remove(), 220); };
    const goBtn = overlay.querySelector('#add-go');
    overlay.addEventListener('click', async (e) => {
      const row = e.target.closest('[data-fid]');
      if (row) {
        const id = Number(row.dataset.fid);
        if (selected.has(id)) { selected.delete(id); row.classList.remove('sel'); }
        else { selected.add(id); row.classList.add('sel'); }
        goBtn.disabled = selected.size === 0;
        goBtn.textContent = selected.size ? `Add (${selected.size})` : 'Add';
        return;
      }
      if (e.target.closest('#add-go')) {
        if (!selected.size) return;
        try {
          const r = await api('/api/groups/' + cid + '/members', { method: 'POST', body: { memberIds: Array.from(selected) } });
          applyGroupMeta(cid, r.group);
          close();
          toast('✅', 'Added', selected.size > 1 ? `${selected.size} people added` : 'Member added');
        } catch (e2) { toast('⚠️', 'Error', e2.message); }
        return;
      }
      if (e.target.closest('[data-cancel]') || e.target === overlay) close();
    });
  }

  async function leaveGroup(cid) {
    try {
      await api('/api/groups/' + cid + '/leave', { method: 'POST', body: {} });
      state.conversations.delete(cid);
      if (state.current && state.current.conversationId === cid) backToList();
      renderChats();
      toast('👋', 'Left group', 'You left the group');
    } catch (e) { toast('⚠️', 'Error', e.message); }
  }

  // Apply fresh group meta to local state + header after a change.
  function applyGroupMeta(cid, meta) {
    if (!meta) return;
    const conv = state.conversations.get(cid);
    if (conv) { conv.isGroup = true; conv.group = meta; }
    if (state.current && state.current.isGroup && state.current.conversationId === cid) {
      state.current.group = meta;
      renderGroupHeader(meta);
      renderMessages();
    }
    renderChats();
  }

  async function toggleConvPref(cid, key, value) {
    const conv = state.conversations.get(cid);
    try {
      const r = await api('/api/conversations/' + cid + '/prefs', { method: 'POST', body: { [key]: value } });
      if (conv) { conv.pinned = r.pinned; conv.muted = r.muted; }
      renderChats();
      if (key === 'pinned') toast(r.pinned ? '📌' : '📍', r.pinned ? 'Pinned' : 'Unpinned', r.pinned ? 'Kept at the top' : 'Removed from top');
      else toast(r.muted ? '🔕' : '🔔', r.muted ? 'Muted' : 'Unmuted', r.muted ? "You won't be notified" : 'Notifications on');
    } catch (e) { toast('⚠️', 'Error', e.message); }
  }

  async function toggleBlock(peer, shouldBlock) {
    if (shouldBlock && !confirm('Block ' + friendName(peer) + '? They will not be able to message you.')) return;
    try {
      await api(shouldBlock ? '/api/friends/block' : '/api/friends/unblock', { method: 'POST', body: { userId: peer.id } });
      peer.iBlocked = shouldBlock;
      const f = state.friends.get(peer.id);
      if (f) f.iBlocked = shouldBlock;
      setComposerBlocked(peer);
      toast(shouldBlock ? '🚫' : '✅', shouldBlock ? 'Blocked' : 'Unblocked',
            shouldBlock ? 'They can no longer message you' : 'You can message each other again');
    } catch (e) { toast('⚠️', 'Error', e.message); }
  }

  function setComposerBlocked(peer) {
    const composer = document.querySelector('.composer');
    if (!composer) return;
    let bar = document.getElementById('block-bar');
    const blocked = peer && peer.iBlocked;
    if (blocked) {
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'block-bar';
        bar.className = 'block-bar';
        composer.parentNode.insertBefore(bar, composer);
      }
      bar.innerHTML = `<span>🚫 You blocked this person.</span><button class="block-unbtn">Unblock</button>`;
      bar.classList.remove('hidden');
      composer.classList.add('hidden');
      bar.querySelector('.block-unbtn').onclick = () => toggleBlock(peer, false);
    } else {
      if (bar) bar.classList.add('hidden');
      composer.classList.remove('hidden');
    }
  }

  // ---------- in-chat message search ----------
  const chatSearchBtn = document.getElementById('chat-search-btn');
  if (chatSearchBtn) chatSearchBtn.addEventListener('click', openChatSearch);

  function searchSnippet(body, q) {
    const text = body || '';
    const idx = text.toLowerCase().indexOf(q.toLowerCase());
    if (idx < 0) return escapeHtml(text.slice(0, 64));
    const start = Math.max(0, idx - 24);
    const pre = (start > 0 ? '…' : '') + text.slice(start, idx);
    const match = text.slice(idx, idx + q.length);
    const tail = text.slice(idx + q.length, idx + q.length + 36);
    const post = tail + (text.length > idx + q.length + 36 ? '…' : '');
    return escapeHtml(pre) + '<mark>' + escapeHtml(match) + '</mark>' + escapeHtml(post);
  }

  function flashMessage(mid) {
    const el = $(`.msg[data-mid="${mid}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('flash');
    void el.offsetWidth; // restart the animation
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1700);
  }

  function openChatSearch() {
    if (!state.current) return;
    const overlay = document.createElement('div');
    overlay.className = 'chat-search-overlay';
    overlay.innerHTML = `
      <div class="cs-bar">
        <svg class="cs-icon" viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M9.5 3A6.5 6.5 0 0 1 16 9.5c0 1.61-.59 3.09-1.56 4.23l.27.27h.79l5 5-1.5 1.5-5-5v-.79l-.27-.27A6.52 6.52 0 0 1 9.5 16 6.5 6.5 0 0 1 3 9.5 6.5 6.5 0 0 1 9.5 3m0 2C7 5 5 7 5 9.5S7 14 9.5 14 14 12 14 9.5 12 5 9.5 5Z"/></svg>
        <input id="cs-input" placeholder="Search this chat…" autocomplete="off" />
        <button class="icon-btn" id="cs-close" aria-label="Close">✕</button>
      </div>
      <div class="cs-results" id="cs-results"><div class="cs-hint">Type to search your messages</div></div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));
    const input = overlay.querySelector('#cs-input');
    const results = overlay.querySelector('#cs-results');
    const close = () => { overlay.classList.remove('show'); setTimeout(() => overlay.remove(), 200); };
    overlay.querySelector('#cs-close').addEventListener('click', close);
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    setTimeout(() => input.focus(), 90);

    const run = () => {
      const q = input.value.trim();
      if (!q) { results.innerHTML = `<div class="cs-hint">Type to search your messages</div>`; return; }
      const ql = q.toLowerCase();
      const matches = state.messages.filter((m) => !m.unsent && m.body && m.body.toLowerCase().includes(ql));
      if (!matches.length) { results.innerHTML = `<div class="cs-hint">No messages found</div>`; return; }
      results.innerHTML = matches.slice().reverse().map((m) => {
        const who = m.senderId === state.me.id ? 'You'
          : (state.current.isGroup ? String(msgSenderUser(m).displayName || '').split(/\s+/)[0] : friendName(state.current.peer));
        return `<button class="cs-row" data-mid="${m.id}">
          <div class="cs-row-top"><span class="cs-who">${escapeHtml(who)}</span><span class="cs-time">${fmtTime(m.createdAt)}</span></div>
          <div class="cs-snip">${searchSnippet(m.body, q)}</div>
        </button>`;
      }).join('');
    };
    input.addEventListener('input', run);
    results.addEventListener('click', (e) => {
      const row = e.target.closest('[data-mid]');
      if (!row) return;
      close();
      setTimeout(() => flashMessage(Number(row.dataset.mid)), 230);
    });
  }

  function openRenameFriend(peer) {
    const overlay = document.createElement('div');
    overlay.className = 'modal';
    overlay.innerHTML = `
      <div class="modal-card">
        <h3>Rename contact</h3>
        <div class="field"><label>Nickname (only you see this)</label>
          <input id="rn-name" maxlength="40" value="${escapeHtml(peer.nickname || '')}" placeholder="${escapeHtml(peer.displayName)}"></div>
        <div class="modal-actions">
          <button class="btn-soft" data-cancel="1">Cancel</button>
          <button class="btn-primary" id="rn-save">Save</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));
    const close = () => { overlay.classList.remove('show'); setTimeout(() => overlay.remove(), 220); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay || e.target.closest('[data-cancel]')) close(); });
    overlay.querySelector('#rn-save').addEventListener('click', async () => {
      const nickname = overlay.querySelector('#rn-name').value.trim();
      try {
        await api('/api/friends/nickname', { method: 'POST', body: { userId: peer.id, nickname } });
        const f = state.friends.get(peer.id);
        if (f) f.nickname = nickname || null;
        if (state.current && state.current.peer && state.current.peer.id === peer.id) {
          state.current.peer.nickname = nickname || null;
          $('#peer-name').textContent = friendName(state.current.peer);
        }
        renderAll();
        close();
        toast('✏️', 'Renamed', nickname ? ('Now “' + nickname + '”') : 'Reset to original');
      } catch (e2) { toast('⚠️', 'Error', e2.message); }
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
    // local working copy of the photo: starts at the current one
    let avatarUrl = state.me.avatarUrl || null;
    const overlay = document.createElement('div');
    overlay.className = 'modal';
    overlay.innerHTML = `
      <div class="modal-card">
        <h3>Edit profile</h3>
        <div class="pe-photo">
          <div class="pe-avatar-wrap" id="pe-avatar-wrap">
            ${avatarHtml(state.me, { cls: 'pe-avatar' })}
            <span class="pe-cam">${IC.camera}</span>
          </div>
          <button class="pe-photo-btn" id="pe-change">Change photo</button>
          <button class="pe-photo-btn pe-photo-remove ${avatarUrl ? '' : 'hidden'}" id="pe-remove">Remove</button>
          <input type="file" id="pe-file" accept="image/*" hidden />
        </div>
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

    const wrap = overlay.querySelector('#pe-avatar-wrap');
    const fileInput = overlay.querySelector('#pe-file');
    const removeBtn = overlay.querySelector('#pe-remove');
    const errBox = overlay.querySelector('#pe-err');
    const saveBtn = overlay.querySelector('#pe-save');

    const repaint = () => {
      wrap.innerHTML = `${avatarHtml({ ...state.me, avatarUrl }, { cls: 'pe-avatar' })}<span class="pe-cam">${IC.camera}</span>`;
      removeBtn.classList.toggle('hidden', !avatarUrl);
    };

    const pick = () => fileInput.click();
    overlay.querySelector('#pe-change').addEventListener('click', pick);
    wrap.addEventListener('click', pick);
    removeBtn.addEventListener('click', () => { avatarUrl = null; repaint(); });

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      errBox.classList.remove('show');
      wrap.classList.add('uploading');
      saveBtn.disabled = true;
      try {
        const img = await compressImage(file);
        const fd = new FormData();
        fd.append('file', img);
        fd.append('kind', 'avatar');
        const data = await api('/api/upload', { method: 'POST', body: fd, raw: true });
        avatarUrl = data.url;
        repaint();
      } catch (e2) {
        errBox.textContent = e2.message || 'Upload failed';
        errBox.classList.add('error', 'show');
      } finally {
        wrap.classList.remove('uploading');
        saveBtn.disabled = false;
      }
    });

    saveBtn.addEventListener('click', async () => {
      const displayName = overlay.querySelector('#pe-name').value.trim();
      const username = overlay.querySelector('#pe-username').value.trim();
      saveBtn.disabled = true;
      try {
        const { user } = await api('/api/me/update', {
          method: 'POST',
          body: { displayName, username, avatarUrl },
        });
        state.me = user;
        renderMeHeader();
        renderChats();
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
  // Emoji that signal a problem → red toast. Everything else → green.
  const TOAST_ERR = new Set(['⚠️', '🚫', '🔕', '❌', '⛔', '💔', '🛑']);
  function toast(icon, title, body, onClick) {
    const isErr = TOAST_ERR.has(icon);
    const el = document.createElement('div');
    el.className = 'toast ' + (isErr ? 'toast-error' : 'toast-success');
    el.innerHTML = `
      <span class="toast-ic">${isErr ? IC.error : IC.success}</span>
      <div class="toast-text">
        <div class="t-title">${escapeHtml(title)}</div>
        ${body ? `<div class="t-body">${escapeHtml(body)}</div>` : ''}
      </div>`;
    const dismiss = () => { el.classList.add('leaving'); setTimeout(() => el.remove(), 360); };
    el.addEventListener('click', () => { if (onClick) onClick(); dismiss(); });
    $('#toasts').appendChild(el);
    void el.offsetWidth; // force reflow so the slide-in transition fires reliably
    el.classList.add('show');
    setTimeout(dismiss, 3000);
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
    camera: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4h-5L8 6H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-4l-1.5-2Z"/><circle cx="12" cy="13" r="3.5"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m20 6-11 11-5-5"/></svg>',
    tick1: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m20 6-11 11-5-5"/></svg>',
    tick2: '<svg viewBox="0 0 24 24" width="17" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 6-7.5 11L11 13"/><path d="m15 6-7.5 11L4 13"/></svg>',
    play: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>',
    sun: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    moon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>',
    eye: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
    eyeOff: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9.9 4.2A10.9 10.9 0 0 1 12 4c6.5 0 10 7 10 7a18.5 18.5 0 0 1-3 3.9M6.6 6.6A18.6 18.6 0 0 0 2 11s3.5 7 10 7a10.8 10.8 0 0 0 4.4-.9M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="m2 2 20 20"/></svg>',
    success: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 4.5-5"/></svg>',
    error: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16h.01"/></svg>',
    lock: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
    devices: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="13" height="10" rx="2"/><path d="M2 18h13"/><rect x="17" y="8" width="5" height="12" rx="1.5"/></svg>',
    share: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5 8.6 10.5"/></svg>',
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
    // tapping a push notification asks us to open that exact conversation
    navigator.serviceWorker.addEventListener('message', (e) => {
      const d = e.data || {};
      if (d.type === 'tea:open' && d.conversationId) requestOpenConversation(Number(d.conversationId));
    });
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

  const newGroupBtn = document.getElementById('new-group-btn');
  if (newGroupBtn) newGroupBtn.addEventListener('click', openCreateGroup);

  function openCreateGroup() {
    const friends = Array.from(state.friends.values()).sort((a, b) => a.displayName.localeCompare(b.displayName));
    const selected = new Set();
    const overlay = document.createElement('div');
    overlay.className = 'msg-menu';
    overlay.innerHTML = `
      <div class="mm-sheet fwd-sheet">
        <div class="settings-title">New group</div>
        <div class="field" style="padding:0 4px 6px"><input id="cg-name" maxlength="60" placeholder="Group name"></div>
        ${friends.length >= 2 ? '' : '<div class="empty-note">You need at least 2 friends to start a group.</div>'}
        <div class="fwd-list">
          ${friends.map((f) => `
            <button class="fwd-row" data-fid="${f.id}">
              ${avatarHtml(f)}
              <span class="fwd-name">${escapeHtml(friendName(f))}</span>
              <span class="fwd-check">${IC.check}</span>
            </button>`).join('')}
        </div>
        <div class="mm-actions">
          <button class="mm-act primary" id="cg-go" disabled>Create</button>
          <button class="mm-act" data-cancel="1">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));
    const close = () => { overlay.classList.remove('show'); setTimeout(() => overlay.remove(), 220); };
    const goBtn = overlay.querySelector('#cg-go');
    const updateGo = () => { goBtn.disabled = selected.size < 2; goBtn.textContent = selected.size ? `Create (${selected.size})` : 'Create'; };
    overlay.addEventListener('click', async (e) => {
      const row = e.target.closest('[data-fid]');
      if (row) {
        const id = Number(row.dataset.fid);
        if (selected.has(id)) { selected.delete(id); row.classList.remove('sel'); }
        else { selected.add(id); row.classList.add('sel'); }
        updateGo();
        return;
      }
      if (e.target.closest('#cg-go')) {
        if (selected.size < 2) { toast('👥', 'Pick friends', 'Choose at least 2 friends'); return; }
        const name = overlay.querySelector('#cg-name').value.trim();
        try {
          const { conversation } = await api('/api/groups', { method: 'POST', body: { name, memberIds: Array.from(selected) } });
          state.conversations.set(conversation.id, conversation);
          renderChats();
          close();
          openGroup(conversation.id);
        } catch (e2) { toast('⚠️', 'Could not create', e2.message); }
        return;
      }
      if (e.target.closest('[data-cancel]') || e.target === overlay) close();
    });
  }

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
            <button data-theme-set="light" class="${curTheme === 'light' ? 'on' : ''}">${IC.sun} Light</button>
            <button data-theme-set="dark" class="${curTheme === 'dark' ? 'on' : ''}">${IC.moon} Dark</button>
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
          <button class="set-row" data-editprofile="1"><span class="set-main">${IC.user}<span>Edit profile</span></span><span class="set-state">›</span></button>
          <button class="set-row" data-invite="1"><span class="set-main">${IC.share}<span>Invite a friend</span></span><span class="set-state">›</span></button>
          <button class="set-row" data-password="1"><span class="set-main">${IC.lock}<span>Change password</span></span><span class="set-state">›</span></button>
          <button class="set-row" data-logout-others="1"><span class="set-main">${IC.devices}<span>Log out other devices</span></span><span class="set-state">›</span></button>
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
      if (e.target.closest('[data-invite]')) { close(); openInvite(); return; }
      if (e.target.closest('[data-password]')) { close(); openChangePassword(); return; }
      if (e.target.closest('[data-logout-others]')) { close(); confirmLogoutOthers(); return; }
      if (e.target.closest('[data-logout]')) { close(); confirmLogout(); return; }
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
    document.documentElement.classList.remove('resume');
    $('#splash').classList.add('hidden');
  }

  // Deep-links: /?open=<conversationId> (notification tap) · /?add=<username> (invite)
  try {
    const params = new URLSearchParams(location.search);
    const oc = params.get('open');
    const ad = params.get('add');
    if (oc) pendingOpenConv = Number(oc);
    if (ad) pendingAdd = String(ad).slice(0, 32);
    if (oc || ad) history.replaceState({}, '', location.pathname);
  } catch (e) {}

  boot();
})();
