/**
 * Mathix Service Worker
 * - Caches the app shell for offline use
 * - Network-first for AI calls, cache-first for static assets
 */

const CACHE_NAME = 'mathix-v1';
const CACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  // CDN assets cached on first fetch
];

// AI/Worker URLs — always network, never cache
const NETWORK_ONLY = [
  'mathixai.salmane0313.workers.dev',
  'generativelanguage.googleapis.com',
  'api.groq.com',
  'openrouter.ai',
];

// ── Install: cache app shell ──
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(CACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: clean old caches ──
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: smart caching strategy ──
self.addEventListener('fetch', (e) => {
  const url = e.request.url;

  // Always network for AI API calls
  if (NETWORK_ONLY.some(domain => url.includes(domain))) {
    e.respondWith(fetch(e.request));
    return;
  }

  // Network-first for HTML (get latest version)
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then(resp => {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
          return resp;
        })
        .catch(() => caches.match('/') || caches.match('/index.html'))
    );
    return;
  }

  // Cache-first for fonts, CDN scripts, images
  if (
    url.includes('fonts.googleapis.com') ||
    url.includes('fonts.gstatic.com') ||
    url.includes('cdnjs.cloudflare.com') ||
    url.includes('cdn.jsdelivr.net') ||
    e.request.destination === 'image' ||
    e.request.destination === 'font' ||
    e.request.destination === 'script' ||
    e.request.destination === 'style'
  ) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(resp => {
          if (resp.ok) {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
          }
          return resp;
        });
      })
    );
    return;
  }

  // Default: network with cache fallback
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
