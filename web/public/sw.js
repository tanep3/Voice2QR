// Voice2QR service worker: caches CODE ASSETS ONLY (the app, the
// library, and the wasm modules) so the app installs and runs fully
// offline. No recording or payload data ever passes through here —
// fetches of data: URLs and non-GET requests are left alone.
//
// The cache name carries the app version (__APP_VERSION__ is stamped
// by scripts/assemble-site.mjs at build time). A new release therefore
// changes this file's bytes, which is what makes the browser notice
// the update: the new worker installs a fresh cache and the activate
// handler deletes the old one. Navigations are network-first so the
// HTML itself is never more than one load behind; version.json is
// never intercepted (the app's update probe must see the network).
const VERSION = '__APP_VERSION__';
const CACHE_PREFIX = 'voice2qr-';
const CACHE = CACHE_PREFIX + VERSION;
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './lib/v1/index.js',
  './lib/v1/browser.js',
  './lib/v1/voice2qr_core.wasm',
  './lib/v1/codec2.wasm',
  './lib/v1/zxing_reader.wasm',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    // Cache Storage is shared by the whole ORIGIN, not by this
    // worker's scope: other apps served from the same host (e.g.
    // other project sites on a user Pages domain) keep their caches
    // in the same store. Only ever delete caches with our own
    // prefix — cleaning up a neighbour's cache would break their
    // offline behaviour.
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE)
          .map((k) => caches.delete(k)),
      ),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('/version.json')) return; // update probe: network only
  if (event.request.mode === 'navigate') {
    // Network-first for the document: fresh HTML whenever online,
    // the cached copy only as an offline fallback.
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put('./index.html', copy));
          return response;
        })
        .catch(() => caches.match('./index.html')),
    );
    return;
  }
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then(
      (hit) => hit ?? fetch(event.request),
    ),
  );
});
