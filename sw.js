/**
 * Mathix Service Worker
 *
 * Cache strategy (no manual version bumps):
 *   - APP_CACHE  : app shell — index.html, manifest, share-target stash.
 *                  Network-first on navigation; the cached entry is overwritten
 *                  by every successful response, so it's always self-healing.
 *   - CDN_CACHE  : 3rd-party libs (math.js, KaTeX, Algebrite, Chart.js).
 *                  Stale-while-revalidate; entries refresh in the background.
 *
 * Why no `mathix-vN` version string anymore:
 *   The previous design relied on a hand-bumped CACHE_NAME to invalidate stale
 *   entries on deploy. That was a manual step that *will* be forgotten. With
 *   stable named caches plus network-first navigation, every successful fetch
 *   overwrites the cached entry, so a deploy is picked up on the next reload
 *   without any string bump. SW logic changes still trigger a fresh install
 *   the normal way (browser detects byte-diff in this file).
 *
 * Update flow:
 *   - We do NOT call skipWaiting() on install. The new SW waits until the page
 *     opts in by posting {type:'SKIP_WAITING'}. The page shows a toast offering
 *     reload; if the user defers, the new SW activates next time all tabs are
 *     closed. Prevents mid-session asset mismatches.
 */

const APP_CACHE = 'mathix-app';
const CDN_CACHE = 'mathix-cdn';
const ACTIVE_CACHES = new Set([APP_CACHE, CDN_CACHE]);

// App shell (must succeed for install to succeed)
const CORE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
];

// Critical CDN libraries — precached so first calculation works offline.
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
    const appCache = await caches.open(APP_CACHE);
    await appCache.addAll(CORE_URLS);
    const cdnCache = await caches.open(CDN_CACHE);
    // Best-effort precache; one CDN hiccup must not block install.
    await Promise.allSettled(
      CDN_PRECACHE.map(url =>
        fetch(url, { mode: 'no-cors' })
          .then(r => cdnCache.put(url, r))
          .catch(() => {})
      )
    );
    // Note: NO skipWaiting() here — see header comment.
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // Purge any cache not in the active set (e.g. legacy mathix-vN entries).
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => !ACTIVE_CACHES.has(k)).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Page → SW messages. The page asks us to activate immediately when the user
// clicks "Reload to update".
self.addEventListener('message', (e) => {
  const data = e.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'SKIP_WAITING') self.skipWaiting();
});

// Stale-while-revalidate helper for a given cache.
async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
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
  if (method === 'POST' && new URL(url).pathname === '/share-target') {
    e.respondWith((async () => {
      try {
        const formData = await e.request.formData();
        const file = formData.get('image') || formData.get('photos');
        if (file && file.name) {
          const cache = await caches.open(APP_CACHE);
          const stashUrl = '/__shared_image__';
          await cache.put(stashUrl, new Response(file, {
            headers: { 'Content-Type': file.type || 'image/jpeg' },
          }));
          return Response.redirect('/?tab=scan&shared=1', 303);
        }
      } catch(_) {}
      return Response.redirect('/?tab=scan', 303);
    })());
    return;
  }

  if (method === 'GET' && new URL(url).pathname === '/__shared_image__') {
    e.respondWith(caches.match(url).then(r => r || new Response(null, { status: 404 })));
    return;
  }

  // Never cache AI endpoints
  if (NETWORK_ONLY.some(domain => url.includes(domain))) {
    e.respondWith(fetch(e.request));
    return;
  }

  // Navigation requests → network-first, cache fallback.
  // This is what makes deploys auto-pick-up: we always try fresh HTML first,
  // and overwrite the cached copy with the response body.
  if (e.request.mode === 'navigate') {
    e.respondWith((async () => {
      const cache = await caches.open(APP_CACHE);
      try {
        const resp = await fetch(e.request);
        // Only cache successful, basic/cors responses
        if (resp && resp.ok) cache.put(e.request, resp.clone()).catch(() => {});
        return resp;
      } catch (_) {
        return (await cache.match(e.request))
          || (await cache.match('/'))
          || (await cache.match('/index.html'))
          || new Response('Offline', { status: 503, statusText: 'Offline' });
      }
    })());
    return;
  }

  // 3rd-party CDN libs / fonts → CDN cache, stale-while-revalidate
  if (
    url.includes('fonts.googleapis.com') ||
    url.includes('fonts.gstatic.com') ||
    url.includes('cdnjs.cloudflare.com') ||
    url.includes('cdn.jsdelivr.net')
  ) {
    e.respondWith(staleWhileRevalidate(e.request, CDN_CACHE));
    return;
  }

  // Same-origin static assets → app cache, stale-while-revalidate
  if (
    e.request.destination === 'image' ||
    e.request.destination === 'font' ||
    e.request.destination === 'script' ||
    e.request.destination === 'style'
  ) {
    e.respondWith(staleWhileRevalidate(e.request, APP_CACHE));
    return;
  }

  // Anything else → network with cache fallback
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
