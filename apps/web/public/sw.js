/*
 * Hader AI — Service Worker
 *
 * The portal is served under Next.js `basePath: '/app'`, so every public file
 * (this script included) lives under `/app/...`. Registering at `/app/sw.js`
 * gives the worker a default scope of `/app/`, which covers the whole portal.
 *
 * Caching strategy:
 *   • navigations (HTML)        → network-first, fall back to cache, then offline.html
 *   • build assets + static     → stale-while-revalidate (instant load, refresh in bg)
 *   • cross-origin (the API)    → not intercepted (origin guard) — always hits the network
 *
 * CACHE_VERSION is stamped with the deploy's git SHA by infra/scripts/
 * redeploy.sh (it sed-replaces the __BUILD_ID__ token after `git reset`). That
 * makes this file byte-different every deploy, so returning browsers install
 * the new worker, `activate` purges the stale caches, and PwaRegister reloads
 * open tabs onto the fresh build. In dev (no stamping) the literal token is a
 * fine, stable cache name.
 */
const CACHE_VERSION = '__BUILD_ID__';
const STATIC_CACHE = `hader-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `hader-runtime-${CACHE_VERSION}`;

const BASE = '/app';
const OFFLINE_URL = `${BASE}/offline.html`;

// The minimal app shell guaranteed available offline. Next.js build assets are
// hashed and cached at runtime instead of being listed here.
const APP_SHELL = [
  OFFLINE_URL,
  `${BASE}/manifest.webmanifest`,
  `${BASE}/icons/icon-192.png`,
  `${BASE}/icons/icon-512.png`,
  `${BASE}/icons/maskable-512.png`,
  `${BASE}/icons/apple-touch-icon.png`,
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      // Tolerate a single missing asset rather than failing the whole install.
      .then((cache) => Promise.allSettled(APP_SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name !== STATIC_CACHE && name !== RUNTIME_CACHE)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// Let the page tell a waiting worker to take over immediately.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin GETs. The API lives on another origin, so its
  // (often authed, always dynamic) requests pass straight through.
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Never let the worker cache or serve itself.
  if (url.pathname.endsWith('/sw.js')) return;

  // HTML navigations — keep them fresh, degrade to cache, then the offline page.
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }

  // Hashed build output + static assets — fast from cache, refreshed in the bg.
  if (
    url.pathname.startsWith(`${BASE}/_next/`) ||
    /\.(?:css|js|mjs|woff2?|ttf|otf|png|jpe?g|svg|gif|webp|avif|ico|json|webmanifest)$/.test(
      url.pathname,
    )
  ) {
    event.respondWith(staleWhileRevalidate(request));
  }
});

async function networkFirst(request) {
  try {
    const fresh = await fetch(request);
    const cache = await caches.open(RUNTIME_CACHE);
    cache.put(request, fresh.clone());
    return fresh;
  } catch {
    const cached = await caches.match(request);
    return cached || (await caches.match(OFFLINE_URL));
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      // Only cache complete, same-origin (non-opaque) successful responses.
      if (response && response.status === 200 && response.type === 'basic') {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => cached);
  return cached || network;
}
