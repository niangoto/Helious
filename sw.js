const CACHE = 'helious-v31';
const URLS = [
    '/index.html',
    '/manifest.json',
    '/forecast.js',
    '/models.js',
    '/js/config.js',
    '/js/state.js',
    '/js/data.js',
    '/js/news.js',
    '/js/calculator.js',
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
    '/js/tabs/rsi-phase.js',
    '/js/tabs/candle-forecast.js'
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
  const req = e.request;
  if (req.method !== 'GET') return;
  // Network-first за всичко (за да не сервираме стари JS/HTML), с кеш само
  // като offline fallback.
  e.respondWith(
    fetch(req).then(res => {
      try {
        if (res && res.ok && new URL(req.url).origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
      } catch (err) { /* ignore */ }
      return res;
    }).catch(() =>
      caches.match(req).then(r => r || new Response('Офлайн — опитай отново.', {
        status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      }))
    )
  );
});
