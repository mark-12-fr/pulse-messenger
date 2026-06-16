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
    // update the app-icon unread badge if the device supports it
    try {
      if (typeof data.badge === 'number' && self.navigator && self.navigator.setAppBadge) {
        if (data.badge > 0) await self.navigator.setAppBadge(data.badge);
        else await self.navigator.clearAppBadge();
      }
    } catch (e) {}
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
      renotify: true,        // re-alert (sound + buzz) for each new message
      silent: false,         // play the device's notification sound
      vibrate: [120, 60, 120, 60, 120],
      requireInteraction: false,
      data: { conversationId: data.conversationId || null },
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
