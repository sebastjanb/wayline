// The app shell is one set of files that belong together. It is stored whole
// under a versioned name and always served from that one set, so a weak
// connection can never mix files from two versions. A new version is fetched
// whole in the background and takes over only once every file has arrived.
// Map tiles are kept too, so streets already seen still draw offline.

const VERSION = '2.9';
const SHELL = 'wayline-shell-' + VERSION;
const TILES = 'wayline-tiles-v1';
const MAX_TILES = 400;
const FILES = [
  './', 'css/app.css', 'manifest.webmanifest', 'favicon.png',
  'js/app.js', 'js/map.js', 'js/mvt.js', 'js/geo.js', 'js/guide.js', 'js/services.js',
];

self.addEventListener('install', (event) => {
  // cache: 'reload' so the new set is never built from stale HTTP-cached files.
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
  if (url.origin !== self.location.origin || url.pathname.endsWith('/sw.js')) return;
  event.respondWith(
    caches.open(SHELL)
      .then((cache) => cache.match(request, { ignoreSearch: true }))
      .then((hit) => hit || fetch(request)),
  );
});
