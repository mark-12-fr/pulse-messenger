/* Tea service worker — keeps the app fresh and shows push notifications.
   The push payload never contains the message text (privacy): just "X sent you a message". */
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
  const isCall = data.type === 'call';
  const title = data.title || 'Tea';
  const body = data.body || 'New message';
  event.waitUntil((async () => {
    // update the app-icon unread badge if the device supports it
    try {
      if (typeof data.badge === 'number' && self.navigator && self.navigator.setAppBadge) {
        if (data.badge > 0) await self.navigator.setAppBadge(data.badge);
        else await self.navigator.clearAppBadge();
      }
    } catch (e) {}
    if (!data.force && !isCall) {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // app is open AND in the foreground -> the in-app toast handles it; skip
      if (all.some((c) => c.visibilityState === 'visible')) return;
    }
    await self.registration.showNotification(title, {
      body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: isCall ? 'tea-call' : 'tea-message',
      renotify: true,        // re-alert (sound + buzz) for each new message
      silent: false,         // play the device's notification sound
      vibrate: isCall ? [400, 200, 400, 200, 400, 200, 400] : [120, 60, 120, 60, 120],
      requireInteraction: !!isCall,  // a call stays up until tapped
      data: { conversationId: data.conversationId || null, type: data.type || null },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const cid = event.notification.data && event.notification.data.conversationId;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) {
        if (cid) { try { c.postMessage({ type: 'tea:open', conversationId: cid }); } catch (e) {} }
        return c.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(cid ? ('/?open=' + cid) : '/');
  })());
});
