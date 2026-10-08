// App shell comes from the network when there is one, so a new deploy shows up
// on the next launch; the cached copy opens the app without a connection.
// Map tiles are kept too, so streets already seen still draw offline.

const SHELL = 'wayline-shell-v19';
const TILES = 'wayline-tiles-v1';
const MAX_TILES = 400;
const FILES = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest', 'favicon.png',
  'js/app.js', 'js/map.js', 'js/mvt.js', 'js/geo.js', 'js/guide.js', 'js/services.js',
];

self.addEventListener('install', (event) => {
  // cache: 'reload' so a new version is never rebuilt from stale HTTP-cached files.
  event.waitUntil(
    caches.open(SHELL)
      .then((cache) => cache.addAll(FILES.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== SHELL && key !== TILES).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

async function tile(request) {
  const cache = await caches.open(TILES);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) {
    cache.put(request, response.clone());
    cache.keys().then((keys) => {
      for (let i = 0; i < keys.length - MAX_TILES; i++) cache.delete(keys[i]);
    });
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.hostname === 'tiles.openfreemap.org' && url.pathname.endsWith('.pbf')) {
    event.respondWith(tile(request));
    return;
  }
  // The worker script itself must always come from the network, or updates stall.
  if (url.origin !== self.location.origin || url.pathname.endsWith('/sw.js') || url.pathname.startsWith('/api/')) return;
  // Network first, but a weak connection must not hold the app hostage: after
  // four seconds the cached copy opens it and the fresh one lands for next time.
  const fresh = fetch(request, { cache: 'no-cache' }).then((response) => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(SHELL).then((cache) => cache.put(request, copy));
    }
    return response;
  });
  const cached = () => caches.match(request, { ignoreSearch: true });
  event.respondWith(
    Promise.race([fresh.catch(() => null), new Promise((resolve) => setTimeout(resolve, 4000))])
      .then((response) => response || cached().then((hit) => hit || fresh)),
  );
});
