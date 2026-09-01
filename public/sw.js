/**
 * Campaigner app-shell service worker (tablet/PWA support, 05-UI §Tablet).
 * All campaign data lives in IndexedDB and is untouched by the SW; this only
 * makes a reload work offline and the installed app start without network.
 *
 * - Navigation requests: network first (fresh index.html), cached copy as the
 *   offline fallback.
 * - Hashed build assets (/assets/*): cache first — filenames are content
 *   hashes, so a cache hit is always the right file.
 * - Everything else (OpenRouter API, cross-origin, non-GET): untouched.
 * Paths are relative to the SW scope, so non-root Vite bases work too.
 */
const { caches } = globalThis;
const CACHE = 'campaigner-shell-v1';
const PRECACHE = [
  './',
  './manifest.webmanifest',
  './favicon.svg',
  './apple-touch-icon.png',
  './pwa-192.png',
  './pwa-512.png',
  './pwa-maskable-512.png',
];

globalThis.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => globalThis.skipWaiting()),
  );
});

globalThis.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => globalThis.clients.claim()),
  );
});

globalThis.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== globalThis.location.origin) return;
  if (!url.pathname.startsWith(globalThis.registration.scope)) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          void caches.open(CACHE).then((cache) => cache.put('./', copy));
          return response;
        })
        .catch(() => caches.match('./')),
    );
    return;
  }

  if (url.pathname.includes('/assets/')) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ??
          fetch(request).then((response) => {
            const copy = response.clone();
            void caches.open(CACHE).then((cache) => cache.put(request, copy));
            return response;
          }),
      ),
    );
  }
});
