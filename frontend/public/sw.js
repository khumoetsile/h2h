// Head2Head service worker. It does two small jobs: show a notification when the server pushes one, and
// open the right page when it is tapped. It does not cache anything, so a new deploy is always what people get.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'Head2Head', body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'Head2Head';
  event.waitUntil((async () => {
    // If the app is open and in front, the player already sees it on screen. Skip the banner.
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (windows.some((w) => w.visibilityState === 'visible' && w.focused)) return;
    await self.registration.showNotification(title, {
      body: data.body || '',
      tag: data.tag || undefined,
      renotify: !!data.tag,
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      data: { url: data.url || '/' },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of windows) {
      if ('focus' in w) {
        await w.focus();
        if ('navigate' in w) { try { await w.navigate(url); } catch { /* cross-origin or closed */ } }
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
