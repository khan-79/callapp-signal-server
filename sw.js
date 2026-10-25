/* CallApp service worker: shows call and message notifications when the app is closed. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch (e) {
    d = { title: 'CallApp', body: event.data ? event.data.text() : '' };
  }
  event.waitUntil((async () => {
    if (d.type === 'cancel') {
      // The call was answered elsewhere, ended, or missed: remove its notification.
      const list = await self.registration.getNotifications({ tag: d.tag });
      list.forEach((n) => n.close());
      return;
    }
    const isCall = d.type === 'call';
    await self.registration.showNotification(d.title || 'CallApp', {
      body: d.body || '',
      tag: d.tag,
      renotify: !!d.tag,
      requireInteraction: !!d.requireInteraction,
      vibrate: isCall ? [400, 200, 400, 200, 400] : [120],
      data: { url: d.url || '/', chat: d.chat || null }
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((w) => 'focus' in w);
    if (win) {
      await win.focus();
      if (data.chat) win.postMessage({ type: 'open', chat: data.chat });
      return;
    }
    await self.clients.openWindow(data.url || '/');
  })());
});
