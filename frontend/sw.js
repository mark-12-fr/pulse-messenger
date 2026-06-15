/* Tea service worker — shows push notifications even when the app is closed.
   The payload never contains the message text (privacy): just "X sent you a message". */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
  const title = data.title || 'Tea';
  const body = data.body || 'New message';
  event.waitUntil((async () => {
    if (!data.force) {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // app is open AND in the foreground -> the in-app toast handles it; skip
      if (all.some((c) => c.visibilityState === 'visible')) return;
    }
    await self.registration.showNotification(title, {
      body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'tea-message',
      renotify: true,
      vibrate: [80, 40, 80],
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) return c.focus(); }
    if (self.clients.openWindow) return self.clients.openWindow('/');
  })());
});
