/* sw.js — makes the pages installable and keeps them usable when the signal or the server drops.
   Pages and their css/js are fetched from the network first, every time; a copy is kept only as a
   spare for when the network fails. Menus, orders and every /api call are never cached here: the
   pages keep their own last copy and say plainly when they are showing it. */
const CACHE = 'ft-offline-v15';
const OFFLINE = '/offline.html';
// Pages worth a spare copy. Links carrying a private token (bookings, unsubscribe) are never kept.
const PAGES = new Set(['/', '/customer', '/customer.html', '/owner', '/owner.html', '/now', '/schedule', '/catering/manage', '/clients']);
const ASSET = /\.(css|js|png|svg|woff2?)$/;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all([OFFLINE, '/app.css', '/theme.css', '/theme.js', '/ok.css', '/logo.js'].map((u) => c.add(u).catch(() => {})))));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

function keep(key, res) {
  const copy = res.clone();
  caches.open(CACHE).then((c) => c.put(key, copy)).catch(() => {});
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname === '/sw.js') return;

  if (req.mode === 'navigate') {
    const key = url.pathname;
    const kept = PAGES.has(key);
    e.respondWith(fetch(req).then((res) => {
      if (res.ok && kept) { keep(key, res); return res; }
      // The server is down (the proxy answered for it): the last good copy of this page beats an error page.
      if (res.status >= 500 && kept) return caches.match(key).then((c) => c || res);
      return res;
    }).catch(() => caches.match(kept ? key : OFFLINE).then((c) => c || caches.match(OFFLINE))));
    return;
  }

  if (ASSET.test(url.pathname) && !url.pathname.startsWith('/uploads/')) {
    e.respondWith(fetch(req).then((res) => {
      if (res.ok) keep(url.pathname, res);
      return res.ok ? res : caches.match(url.pathname).then((c) => c || res);
    }).catch(() => caches.match(url.pathname).then((c) => c || Response.error())));
  }
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
