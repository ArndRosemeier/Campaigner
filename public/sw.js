/**
 * Campaigner app-shell service worker (tablet/PWA support, 05-UI §Tablet).
 * All campaign data lives in IndexedDB and is untouched by the SW; this only
 * makes a reload work offline and the installed app start without network.
 *
 * - Navigation requests: network first (fresh index.html), the CACHED SHELL as
 *   the fallback for both a network rejection and a non-OK response.
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

/**
 * The cached app shell, or `undefined` when this browser has never stored one.
 *
 * The Cache API's own miss answer is `undefined`, so every caller must handle
 * it: `event.respondWith(undefined)` is a TypeError, not a network error.
 */
function cachedShell() {
  return caches.match('./');
}

/**
 * The honest last resort: no network AND no cached shell (docs/17 row 378).
 * Deliberately a real failure rather than a blank/synthetic shell, which would
 * hide a genuinely missing app (AGENTS rule 1).
 */
function noShellResponse() {
  return new Response('Campaigner is offline and no app shell has been cached yet.', {
    status: 503,
    statusText: 'Offline',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

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
  // `registration.scope` is an ABSOLUTE url (`https://host/<base>/`), so it must
  // be compared against the request's whole href. Comparing it to `url.pathname`
  // never matches and silently defers EVERY request, which is what made this
  // worker inert (docs/17 row 378).
  if (!url.href.startsWith(globalThis.registration.scope)) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (!response.ok) {
            // A static host that has no file for a client-side route answers 404,
            // and that is a RESPONSE, not a network rejection — so the `.catch`
            // below never runs for it. Without this arm the browser is handed the
            // host's 404 on every refresh or deep link to a real route
            // (docs/17 row 378). This is the SPA fallback `public/.htaccess`
            // supplied on the retired Apache host; this static host ignores both
            // `.htaccess` and a `404.html`, so the service worker is the ONLY
            // place it can live. With no shell cached the host's own response is
            // the honest answer — never a synthetic page that hides a missing app.
            return cachedShell().then((shell) => shell ?? response);
          }
          const copy = response.clone();
          void caches.open(CACHE).then((cache) => cache.put('./', copy));
          return response;
        })
        // Offline (or the network rejected the request): the shell, and when this
        // browser has none yet, a real failure — never the `undefined` the Cache
        // API answers with on a miss.
        .catch(() => cachedShell().then((shell) => shell ?? noShellResponse())),
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
