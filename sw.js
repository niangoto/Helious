const CACHE = 'helious-v9';
const URLS = [
    '/',
    '/manifest.json',
    '/forecast.js',
    '/models.js',
    '/js/config.js',
    '/js/state.js',
    '/js/data.js',
    '/js/news.js',
    '/js/indicators.js',
    '/js/app.js',
    '/js/install.js',
    '/js/tabs/tabs.js',
    '/js/tabs/indicators.js',
    '/js/tabs/average.js',
    '/js/tabs/historical.js',
    '/js/tabs/logistic.js',
    '/js/tabs/markov.js',
    '/js/tabs/expected-value.js',
    '/js/tabs/wavelet.js',
    '/js/tabs/fourier.js',
    '/js/tabs/rsi-phase.js'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(URLS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Network-first for index.html, cache-first for static assets
  if (e.request.url.includes('index.html')) {
    e.respondWith(
      fetch(e.request).catch(() => caches.match(e.request))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});
