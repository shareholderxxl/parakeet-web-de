/* portabletranscribe service worker.
 *
 * Precache-Manifest und Version werden beim Build von postbuild.mjs in diese
 * Datei "gebacken" (Platzhalter __PRECACHE__ / __BUILD_VERSION__). Dadurch
 * ändert sich der sw.js-Inhalt bei jedem Build -> der Browser erkennt das
 * Update zuverlässig, und install/activate können ohne Netz-Roundtrip arbeiten.
 *
 * Runtime-Assets (/ort/, /ffmpeg/) sind pro Build versioniert, Modell-Dateien
 * generationiert (siehe MODELS_CACHE unten) — so koennen sich Runtime- und
 * Modell-Updates nie hinter einem cache-first Treffer verstecken.
 *
 * Modell-Dateien werden cache-first in Cache Storage gehalten, damit die App
 * samt Modell offline funktioniert — sowohl der eigene Mirror (/models/, LAN,
 * Quelle 'local') als auch HuggingFace (huggingface.co/<repo>/resolve/…, Quelle
 * 'remote', z. B. GitHub Pages). Zusaetzlich wird die HF-Dateiliste
 * (api/models/…) network-first gecacht, damit hub.js offline den int4-Quant
 * waehlen kann.
 */
const BUILD_VERSION = '__BUILD_VERSION__';
const PRECACHE = __PRECACHE__;

const SHELL_CACHE = 'pt-shell-' + BUILD_VERSION;
// Runtime-Assets (ORT/ffmpeg) sind pro Build versioniert. Ihre Dateinamen
// aendern sich bei Upgrades NICHT (z. B. ort-wasm-simd-threaded.jsep.wasm),
// aber backend.js prueft die Bytes gegen das neue /ort/manifest.json: ein
// cache-first Treffer mit den ALTEN Bytes liesse den PROD-Build hart scheitern
// ("ORT integrity check failed"). Versionierung per Build erzwingt frische
// Bytes (~28 MB pro Deploy).
const RUNTIME_CACHE = 'pt-runtime-' + BUILD_VERSION;
// Modell-Dateien sind gross (~400 MB), daher NICHT pro Build versioniert.
// Bei jeder Aenderung an ausgelieferten Modelldateien die Generation hier
// hochziehen ('pt-models-v2' -> 'v3'); der Activate-Handler loescht dann die
// alte Generation, damit der Browser die neuen Bytes laedt.
const MODELS_CACHE = 'pt-models-v2';
const CACHE_FAMILIES = ['pt-shell-', 'pt-runtime-', 'pt-models-'];
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
    const current = new Set([SHELL_CACHE, RUNTIME_CACHE, MODELS_CACHE]);
    await Promise.all(keys.map((k) => {
      // Alte Generationen aller drei Familien loeschen (Shell, Runtime, Modelle).
      if (CACHE_FAMILIES.some((p) => k.startsWith(p)) && !current.has(k)) return caches.delete(k);
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
  // 'basic' = same-origin, 'cors' = HuggingFace (Modell-Download).
  if (res && res.status === 200 && (res.type === 'basic' || res.type === 'cors')) {
    cache.put(request, res.clone()).catch(() => {});
  }
  return res;
}

// Netz zuerst (frische Daten), Cache als Offline-Rueckfall. Fuer die
// HF-Dateiliste (api/models/...) gedacht, damit hub.js offline die Datei-Liste
// bekommt und den int4-Quant waehlen kann.
async function networkFirstCache(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    if (res && res.status === 200 && (res.type === 'basic' || res.type === 'cors')) {
      cache.put(request, res.clone()).catch(() => {});
    }
    return res;
  } catch (e) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw e;
  }
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

  // HuggingFace (Modellquelle 'remote'): Modell-Dateien cache-first, die
  // Dateiliste (api/models) network-first mit Offline-Fallback.
  if (url.hostname === 'huggingface.co') {
    if (/^\/[^/]+\/[^/]+\/resolve\//.test(url.pathname)) {
      event.respondWith(cacheFirst(request, MODELS_CACHE));
    } else if (url.pathname.startsWith('/api/models/')) {
      event.respondWith(networkFirstCache(request, MODELS_CACHE));
    }
    return;
  }
  if (url.origin !== self.location.origin) return; // sonstige Drittanbieter
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
