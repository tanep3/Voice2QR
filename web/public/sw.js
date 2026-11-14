// Voice2QR service worker: caches CODE ASSETS ONLY (the app, the
// library, and the wasm modules) so the app installs and runs fully
// offline. No recording or payload data ever passes through here —
// fetches of data: URLs and non-GET requests are left alone.
const CACHE = 'voice2qr-v1';
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
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then(
      (hit) => hit ?? fetch(event.request),
    ),
  );
});
