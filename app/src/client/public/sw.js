// アプリ本体をスマホに保存しておき、当日の読み込みを通信に頼らないための Service Worker。
// 状態のやり取り（/api/）は保存しない。
const CACHE = 'urafess-v3';
// ページ本体（index.html）はここに入れない。/index.html はサーバーが / へ送り直すので、そのまま保存すると
// 「送り直しを通って来た返事」になり、ブラウザはそれをページの読み込みに返すとエラーにする
// （保存した直後の、次の1回の読み込みだけ失敗していた）。下で / を取りに行って、作り直してから保存する
const PAGE = '/index.html';
const SHELL = ['/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/apple-touch-icon.png', '/fonts/URAJI-Black.woff2'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      await cache.addAll(SHELL);
      const page = await fetch('/', { cache: 'no-store' });
      if (!page.ok) throw new Error(`page ${page.status}`);
      await cache.put(PAGE, await plain(page));
    }),
  );
  self.skipWaiting();
});

/** 送り直しを通って来た返事は、中身だけ写して作り直す（ページの読み込みに返せる形にする） */
async function plain(response) {
  if (!response || !response.redirected) return response;
  return new Response(await response.blob(), { status: response.status, statusText: response.statusText, headers: response.headers });
}

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
      const key = isPage ? PAGE : request;
      // 前の版が保存した「送り直しを通って来た」ページが残っていても、作り直してから返す
      const cached = await plain(await cache.match(key, { ignoreSearch: isPage }));
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
