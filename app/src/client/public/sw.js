// アプリ本体をスマホに保存しておき、当日の読み込みを通信に頼らないための Service Worker。
// 状態のやり取り（/api/）は保存しない。
const CACHE = 'urafess-v4';
const SHELL = ['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/apple-touch-icon.png', '/fonts/URAJI-Black.woff2'];

/**
 * 転送（リダイレクト）を経た応答は、ページの読み込みに返すとブラウザが表示しない（真っ白・読み込みエラー）。
 * 本番は /index.html を / へ転送するので、保存する前に「転送の印」の無い応答に作り直す
 */
async function clean(response) {
  if (!response.redirected) return response;
  const body = await response.blob();
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.all(
        SHELL.map(async (path) => {
          const response = await fetch(path, { cache: 'reload' });
          if (!response.ok) throw new Error(`${path}: ${response.status}`);
          await cache.put(path, await clean(response));
        }),
      ),
    ),
  );
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
  // 画面が「新しい版が出ているか」を確かめるときは、保存してあるものを返さずに通信で取りに行かせる
  if (request.cache === 'no-store') return;

  // 保存してある方をすぐ返し、裏で新しいものを取りに行く。通信が無ければ保存してある方だけで動く
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const isPage = request.mode === 'navigate';
      // ページはどの道（/・/host・?g=…）でも同じ1枚（/）
      const key = isPage ? '/' : request;
      const hit = await cache.match(key, { ignoreSearch: isPage });
      const cached = hit ? await clean(hit) : undefined;
      const network = fetch(request)
        .then(async (response) => {
          if (response.ok) await cache.put(key, await clean(response.clone()));
          return response;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
