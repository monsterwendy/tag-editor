// Cache version — bump this on every deploy to force immediate refresh
const CACHE_VERSION = 'tag-editor-v1777595213';

self.addEventListener('install', () => {
  // Take over immediately, don't wait for old SW to die
  self.skipWaiting();
});

self.addEventListener('activate', async (e) => {
  // Delete all old caches
  const keys = await caches.keys();
  await Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)));
  // Claim all open clients immediately
  await clients.claim();
});

self.addEventListener('fetch', (e) => {
  // Network-first: always try to fetch fresh, fall back to cache only if offline
  e.respondWith(
    fetch(e.request, { cache: 'no-store' })
      .then(res => {
        // Cache the fresh response
        const clone = res.clone();
        caches.open(CACHE_VERSION).then(c => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
