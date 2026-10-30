const CACHE = 'helious-v34';
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
    '/js/tabs/candle-forecast.js',
    '/js/tabs/derivative.js'
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

  const url = new URL(req.url);
  const isApi = url.origin === self.location.origin && (
    url.pathname === '/data' || url.pathname === '/news' ||
    url.pathname === '/symbols' || url.pathname === '/ticker' ||
    url.pathname === '/fx' || url.pathname === '/instrument' ||
    url.pathname === '/binance' || url.pathname === '/yahoo' ||
    url.pathname === '/version' || url.pathname === '/health' ||
    url.pathname.startsWith('/api/')
  );

  // API заявките НЕ се кешират и при offline връщат JSON (за да не чупи
  // r.json() с HTML/text „Офлайн...“).
  if (isApi) {
    e.respondWith(
      fetch(req).catch(() => new Response(JSON.stringify({
        ok: false,
        error: 'Офлайн — сървърът не е достъпен. Опитай отново.'
      }), {
        status: 503,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      }))
    );
    return;
  }

  // Network-first за всичко останало (за да не сервираме стари JS/HTML), с кеш
  // само като offline fallback.
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
