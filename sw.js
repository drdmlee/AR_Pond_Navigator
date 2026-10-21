/* 오프라인용 Service Worker: 앱 파일 + 위성 타일 캐시 */
const APP_CACHE = 'lpn-app-v2';
const TILE_CACHE = 'lpn-tiles-v1';
const ASSETS = [
  './', './index.html', './manifest.webmanifest', './css/app.css',
  './lib/leaflet.css', './lib/leaflet.js', './lib/react.production.min.js', './lib/react-dom.production.min.js', './lib/htm.umd.js',
  './lib/images/marker-icon.png', './lib/images/marker-shadow.png', './lib/images/layers.png',
  './js/ponds.js', './js/roads.js', './js/geo.js', './js/i18n.js', './js/app.js',
  './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(APP_CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('lpn-') && k !== APP_CACHE && k !== TILE_CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // 위성 타일: 캐시 우선, 없으면 네트워크 후 저장
  if (url.hostname.endsWith('arcgisonline.com')) {
    e.respondWith(caches.open(TILE_CACHE).then(async c => {
      const hit = await c.match(req.url, { ignoreVary: true });
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok) c.put(req.url, res.clone());
        return res;
      } catch (err) {
        return new Response('', { status: 504 });
      }
    }));
    return;
  }

  // 앱 파일: 캐시 즉시 응답 + 백그라운드 갱신 (stale-while-revalidate)
  if (url.origin === self.location.origin) {
    e.respondWith(caches.open(APP_CACHE).then(async c => {
      const hit = await c.match(req, { ignoreSearch: true });
      const net = fetch(req).then(res => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => null);
      return hit || (await net) || new Response('offline', { status: 503 });
    }));
  }
});
