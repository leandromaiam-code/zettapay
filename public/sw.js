// Veridian Fabric — Service Worker (network-first com fallback offline)
const CACHE = 'fabric-v1';
const OFFLINE = '/offline';
const SHELL = ['/', '/login', '/icon-192.png', '/icon-512.png', '/veridian-symbol.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL).catch(() => {})),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Não interfere em chamadas dinâmicas / APIs / auth
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return;
  if (url.origin !== self.location.origin) return;

  // Network-first com fallback ao cache + shell
  event.respondWith(
    fetch(request)
      .then((res) => {
        const copy = res.clone();
        if (res.ok && res.type === 'basic') {
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(request).then((m) => m || caches.match(OFFLINE) || caches.match('/')),
      ),
  );
});
