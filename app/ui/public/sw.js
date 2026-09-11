/* portabletranscribe service worker.
 *
 * Precache-Manifest und Version werden beim Build von postbuild.mjs in diese
 * Datei "gebacken" (Platzhalter __PRECACHE__ / __BUILD_VERSION__). Dadurch
 * ändert sich der sw.js-Inhalt bei jedem Build -> der Browser erkennt das
 * Update zuverlässig, und install/activate können ohne Netz-Roundtrip arbeiten.
 *
 * Modell-Dateien (/models/) werden cache-first in Cache Storage gehalten, damit
 * die App samt Modell offline funktioniert. (Der grosse int4-Encoder laesst sich
 * in der Headless-Testshell nicht verifizieren; im echten Browser ist Cache
 * Storage der PWA-Standardweg. hub.js waehlt offline den int4-Quant, weil seine
 * /models-Probes bei Netzfehlern optimistisch sind.)
 */
const BUILD_VERSION = '__BUILD_VERSION__';
const PRECACHE = __PRECACHE__;

const SHELL_CACHE = 'pt-shell-' + BUILD_VERSION;
const RUNTIME_CACHE = 'pt-runtime-v1';
const MODELS_CACHE = 'pt-models-v1';
const OFFLINE_FALLBACK = '/index.html';
const NETWORK_TIMEOUT_MS = 3500;
const RUNTIME_PREFIXES = ['/ort/', '/ffmpeg/'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await Promise.all(PRECACHE.map(async (url) => {
      try { await cache.add(new Request(url, { cache: 'reload' })); }
      catch (e) { console.warn('[sw] precache miss:', url, e && e.message); }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => {
      if (k.startsWith('pt-shell-') && k !== SHELL_CACHE) return caches.delete(k);
      return null;
    }));
    await self.clients.claim();
  })());
});

function isShellUrl(pathname) {
  return PRECACHE.includes(pathname);
}
function isRuntimeUrl(pathname) {
  return RUNTIME_PREFIXES.some((p) => pathname.startsWith(p));
}

async function fetchWithTimeout(request, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(request, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res && res.status === 200 && res.type === 'basic') {
    cache.put(request, res.clone()).catch(() => {});
  }
  return res;
}

async function networkFirstNavigation(request) {
  try {
    const res = await fetchWithTimeout(request, NETWORK_TIMEOUT_MS);
    if (res && res.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put(OFFLINE_FALLBACK, res.clone()).catch(() => {});
      return res;
    }
    throw new Error('HTTP ' + (res ? res.status : 'error'));
  } catch (e) {
    const cache = await caches.open(SHELL_CACHE);
    const cached = await cache.match(OFFLINE_FALLBACK);
    if (cached) return cached;
    return Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch { return; }
  if (url.origin !== self.location.origin) return; // Drittanbieter: unangetastet
  if (url.pathname === '/sw.js') return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }
  if (url.pathname.startsWith('/models/')) {
    // Modell-Dateien: cache-first in Cache Storage (offline, grosse Dateien).
    event.respondWith(cacheFirst(request, MODELS_CACHE));
    return;
  }
  if (isRuntimeUrl(url.pathname)) {
    event.respondWith(cacheFirst(request, RUNTIME_CACHE));
    return;
  }
  if (isShellUrl(url.pathname)) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
    return;
  }
  // Übrige Same-Origin-Requests (z. B. config.js-Varianten, Range-Requests): Netz.
});
