const CACHE = 'flowering-time-v9';

const BASE = '/TW_phenology';
const PRECACHE = [
  BASE + '/',
  BASE + '/index.html',
  BASE + '/css/style.css',
  BASE + '/js/app.js',
  BASE + '/js/api.js',
  BASE + '/js/timeline.js',
  BASE + '/js/map.js',
  BASE + '/js/storage.js',
  BASE + '/manifest.json',
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
        if (e.request.mode === 'navigate') return caches.match('/index.html');
      });
    })
  );
});
