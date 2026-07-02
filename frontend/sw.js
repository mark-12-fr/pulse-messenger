/* Tea service worker — keeps the app fresh and shows push notifications. */
const SHELL = 'tea-shell-v3';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // drop stale caches from older versions
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Network-first for our OWN static files (index.html, styles.css, app.js, …) so a
// new deploy is never stuck behind a stale cache. Falls back to cache only when
// offline. Cross-origin requests (API, CDNs, sockets) are left completely alone.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    try {
      const fresh = await fetch(req, { cache: 'no-cache' });
      if (fresh && fresh.ok && fresh.type === 'basic') {
        const copy = fresh.clone();
        caches.open(SHELL).then((c) => c.put(req, copy)).catch(() => {});
      }
      return fresh;
    } catch (e) {
      const cached = await caches.match(req);
      return cached || Response.error();
    }
  })());
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
  const title = data.title || 'Tea';
  const body = data.body || 'New message';
  event.waitUntil((async () => {
    try {
      if (typeof data.badge === 'number' && self.navigator && self.navigator.setAppBadge) {
        if (data.badge > 0) await self.navigator.setAppBadge(data.badge);
        else await self.navigator.clearAppBadge();
      }
    } catch (e) {}
    if (!data.force && data.type !== 'call') {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (all.some((c) => c.visibilityState === 'visible')) return;
    }
    const tag = data.type === 'call' ? 'tea-call' : 'tea-message';
    await self.registration.showNotification(title, {
      body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag,
      renotify: true,
      vibrate: data.type === 'call' ? [200, 100, 200, 100, 200, 100, 400] : [120, 60, 120, 60, 120],
      requireInteraction: data.type === 'call',
      data: { type: data.type || 'message', callId: data.callId || null, fromUserId: data.fromUserId || null, media: data.media || null, conversationId: data.conversationId || null },
    });
  })());
});

self.addEventListener('message', (event) => {
  const d = event.data || {};
  if (d.type === 'badge' && self.navigator && self.navigator.setAppBadge) {
    if (d.count > 0) self.navigator.setAppBadge(d.count).catch(() => {});
    else self.navigator.clearAppBadge().catch(() => {});
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const nd = event.notification.data || {};
  const isCall = nd.type === 'call';
  const cid = nd.conversationId;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) {
        try { c.postMessage({ type: isCall ? 'tea:call' : 'tea:open', callId: nd.callId, fromUserId: nd.fromUserId, media: nd.media, conversationId: cid }); } catch (e) {}
        return c.focus();
      }
    }
    if (self.clients.openWindow) {
      if (isCall) return self.clients.openWindow('/?call=' + nd.callId + '&from=' + nd.fromUserId + '&media=' + nd.media);
      return self.clients.openWindow(cid ? ('/?open=' + cid) : '/');
    }
  })());
});
