const CACHE = 'flowering-time-v14';

const PRECACHE = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/api.js',
  './js/timeline.js',
  './js/map.js',
  './js/storage.js',
  './js/memo.js',
  './js/pheno.js',
  './js/annotate.js',
  './js/backup.js',
  './manifest.json',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const { hostname } = new URL(e.request.url);

  // Never cache API calls
  if (hostname.includes('api.inaturalist.org') || hostname.includes('api.gbif.org')) return;

  // Cache-first for everything else (static + CDN)
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res.ok && e.request.method === 'GET') {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => {
        if (e.request.mode === 'navigate') return caches.match(new URL('./index.html', self.location.href).href);
      });
    })
  );
});
