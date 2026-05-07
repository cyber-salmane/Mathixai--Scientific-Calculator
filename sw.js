/**
 * Mathix Service Worker v3
 * - App shell + critical CDN libs precached so the calculator works offline
 * - Stale-while-revalidate for static assets (instant load, fresh in background)
 * - Network-only for AI endpoints (never cached)
 * - Handles share_target POSTs and forwards them to the scanner page
 */

const CACHE_NAME = 'mathix-v12';

// App shell (must succeed for install to succeed)
const CORE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
];

// Critical CDN libraries — precached so first calculation works offline.
// addAll fails atomically; we use individual put() so a single CDN hiccup doesn't block install.
const CDN_PRECACHE = [
  'https://cdnjs.cloudflare.com/ajax/libs/mathjs/11.11.0/math.min.js',
  'https://cdn.jsdelivr.net/npm/algebrite@1.4.0/dist/algebrite.bundle-for-browser.js',
  'https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/katex.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/katex.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js',
];

const NETWORK_ONLY = [
  'mathixai.salmane0313.workers.dev',
  'generativelanguage.googleapis.com',
  'api.groq.com',
  'openrouter.ai',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(CORE_URLS);
    // Best-effort precache of CDN libs (don't fail install if any are unreachable)
    await Promise.allSettled(
      CDN_PRECACHE.map(url =>
        fetch(url, { mode: 'no-cors' }).then(r => cache.put(url, r)).catch(() => {})
      )
    );
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Stale-while-revalidate helper
async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);
  const networkPromise = fetch(req).then(resp => {
    if (resp && resp.ok) cache.put(req, resp.clone()).catch(() => {});
    return resp;
  }).catch(() => cached); // network failed → fall back to cache
  return cached || networkPromise;
}

self.addEventListener('fetch', (e) => {
  const url = e.request.url;
  const method = e.request.method;

  // ── share_target: another app shared an image with us ──
  // The manifest declares /share-target as the action; we receive a POST FormData and
  // redirect the user to /#scan-share so the page can pick the file up via fetch().
  if (method === 'POST' && new URL(url).pathname === '/share-target') {
    e.respondWith((async () => {
      try {
        const formData = await e.request.formData();
        const file = formData.get('image') || formData.get('photos');
        if (file && file.name) {
          // Stash the file in cache so the scanner page can read it back
          const cache = await caches.open(CACHE_NAME);
          const stashUrl = '/__shared_image__';
          await cache.put(stashUrl, new Response(file, {
            headers: { 'Content-Type': file.type || 'image/jpeg' },
          }));
          return Response.redirect('/?tab=scan&shared=1', 303);
        }
      } catch(e) {}
      return Response.redirect('/?tab=scan', 303);
    })());
    return;
  }

  // Stash-image read endpoint for the page
  if (method === 'GET' && new URL(url).pathname === '/__shared_image__') {
    e.respondWith(caches.match(url).then(r => r || new Response(null, { status: 404 })));
    return;
  }

  // Never cache AI endpoints
  if (NETWORK_ONLY.some(domain => url.includes(domain))) {
    e.respondWith(fetch(e.request));
    return;
  }

  // Navigation requests → network-first, cache fallback
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

  // Static assets / fonts / scripts → stale-while-revalidate
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
    e.respondWith(staleWhileRevalidate(e.request));
    return;
  }

  // Anything else → network with cache fallback
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
