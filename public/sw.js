/* sw.js — makes the pages installable and shows a friendly screen when there's no signal.
   It never caches menus, orders or API calls: everything live always comes from the server. */
const CACHE = 'ft-offline-v11';
const OFFLINE = '/offline.html';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all([OFFLINE, '/app.css', '/theme.css', '/theme.js'].map((u) => c.add(u).catch(() => {})))));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return; // let the browser handle everything else normally
  e.respondWith(fetch(e.request).catch(() => caches.match(OFFLINE)));
});

// "Your order is ready" notification: tapping it brings the order page back to the front.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const page = list.find((c) => 'focus' in c);
      return page ? page.focus() : self.clients.openWindow('/');
    })
  );
});
