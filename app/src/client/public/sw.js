// アプリ本体をスマホに保存しておき、当日の読み込みを通信に頼らないための Service Worker。
// 状態のやり取り（/api/）は保存しない。
const CACHE = 'urafess-v2';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/apple-touch-icon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // 保存してある方をすぐ返し、裏で新しいものを取りに行く。通信が無ければ保存してある方だけで動く
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const isPage = request.mode === 'navigate';
      const key = isPage ? '/index.html' : request;
      const cached = await cache.match(key, { ignoreSearch: isPage });
      const network = fetch(request)
        .then((response) => {
          if (response.ok) cache.put(key, response.clone());
          return response;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
