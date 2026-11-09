/* ACM Classroom PWA service worker.
 * Only the static application shell is cached. Authenticated API responses,
 * submissions, class data and judge results are deliberately never cached.
 */
const CACHE_PREFIX = 'acm-classroom-shell-';
const CACHE_NAME = `${CACHE_PREFIX}2.13.0`;
const PRECACHE_URLS = [
  '/',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(PRECACHE_URLS);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

function isCacheableAsset(url) {
  return url.pathname.startsWith('/assets/')
    || url.pathname.startsWith('/monaco/')
    || url.pathname.startsWith('/icons/')
    || url.pathname === '/manifest.webmanifest';
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never cache private API responses, authentication, user data or judge results.
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;
  // Let the browser fetch the service worker itself so update checks stay fresh.
  if (url.pathname === '/sw.js') return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const response = await fetch(request);
        if (response && response.ok) await cache.put('/', response.clone());
        return response;
      } catch {
        const cachedPage = await cache.match('/') || await cache.match('/index.html');
        if (cachedPage) return cachedPage;
        return new Response('<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>اتصال در دسترس نیست</title><body style="font-family:Tahoma,sans-serif;padding:2rem;line-height:2;background:#101d2c;color:#eef5ff"><h2>اتصال به سرور برقرار نیست</h2><p>برای ورود، مشاهدهٔ کلاس‌ها و اجرای داوری، اتصال اینترنت لازم است. پس از اتصال دوباره صفحه را تازه‌سازی کنید.</p></body></html>', {
          status: 503,
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }
    })());
    return;
  }

  if (isCacheableAsset(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);
      if (cached) return cached;
      try {
        const response = await fetch(request);
        if (response && response.ok && response.type === 'basic' && !/(?:no-store|private)/i.test(response.headers.get('cache-control') || '')) {
          await cache.put(request, response.clone());
        }
        return response;
      } catch {
        return cached || new Response('', { status: 504, statusText: 'Offline' });
      }
    })());
  }
});
