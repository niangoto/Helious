const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3001;

// Simple in-memory cache for Yahoo responses
const yahooCache = {};

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(payload));
}

// MIME типове за статичните файлове (по-важно под reverse proxy в реална среда).
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};
function mimeType(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

const db = require('./db');

// Чете JSON тяло на заявка (за POST API).
function readJson(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // ─── Paper търговия API ──────────────────────────────────────────
  if (url.pathname.startsWith('/api/paper/')) {
    const engine = require('./engine/session');
    const parts = url.pathname.split('/').filter(Boolean); // api/paper/sessions/:id/:action
    const method = req.method;
    try {
      if (parts.length === 3 && parts[2] === 'sessions') {
        if (method === 'GET') return sendJson(res, 200, { ok: true, sessions: engine.listSessions() });
        if (method === 'POST') {
          const body = await readJson(req);
          const s = await engine.createSession(body || {});
          return sendJson(res, 201, { ok: true, id: s.id, state: s.getState() });
        }
      }
      if (parts.length >= 4 && parts[2] === 'sessions') {
        const s = engine.getSession(parts[3]);
        if (!s) return sendJson(res, 404, { ok: false, error: 'Няма такава сесия' });
        const action = parts[4];
        if (!action && method === 'GET') return sendJson(res, 200, { ok: true, state: s.getState() });
        if (action === 'stream' && method === 'GET') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
          });
          res.write('retry: 3000\n\n');
          res.write('data: ' + JSON.stringify(s.getState()) + '\n\n');
          const off = s.on((st) => { try { res.write('data: ' + JSON.stringify(st) + '\n\n'); } catch (e) {} });
          const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 15000);
          req.on('close', () => { clearInterval(hb); off(); });
          return;
        }
        if (action === 'pause' && method === 'POST') { s.pause(); return sendJson(res, 200, { ok: true, status: s.status }); }
        if (action === 'resume' && method === 'POST') { s.resume(); return sendJson(res, 200, { ok: true, status: s.status }); }
        if (action === 'stop' && method === 'POST') { s.stop(); return sendJson(res, 200, { ok: true, status: s.status }); }
      }
      return sendJson(res, 404, { ok: false, error: 'Неизвестен API път' });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  // Health check (за Docker healthcheck и мониторинг)
  if (url.pathname === '/health') {
    const dbHealth = await db.health().catch((e) => ({ enabled: true, ok: false, error: e.message }));
    const ok = dbHealth.ok !== false || !dbHealth.enabled;
    sendJson(res, ok ? 200 : 503, {
      ok,
      uptime: Math.round(process.uptime()),
      db: dbHealth,
      time: new Date().toISOString()
    });
    return;
  }

  // Binance Proxy Endpoint
  if (url.pathname === '/binance' && req.method === 'GET') {
    const symbol = (url.searchParams.get('symbol') || 'BTCUSDT').toUpperCase();
    const interval = url.searchParams.get('interval') || '1m';
    const limit = url.searchParams.get('limit') || '600';

    const spotUrl = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const futuresUrl = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;

    https.get(spotUrl, (spotRes) => {
      let data = '';
      spotRes.on('data', (chunk) => data += chunk);
      spotRes.on('end', () => {
        if (spotRes.statusCode === 200) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(data);
        } else {
          // Fallback to Futures API
          https.get(futuresUrl, (futRes) => {
            let futData = '';
            futRes.on('data', (chunk) => futData += chunk);
            futRes.on('end', () => {
              res.writeHead(futRes.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
              res.end(futData);
            });
          }).on('error', (err) => sendJson(res, 500, { error: err.message }));
        }
      });
    }).on('error', (err) => sendJson(res, 500, { error: err.message }));
    return;
  }

  // Binance Ticker Proxy Endpoint
  if (url.pathname === '/ticker' && req.method === 'GET') {
    const symbol = url.searchParams.get('symbol');
    if (!symbol) {
      const binanceUrl = `https://api.binance.com/api/v3/ticker/24hr`;
      https.get(binanceUrl, (response) => {
        let data = '';
        response.on('data', (chunk) => data += chunk);
        response.on('end', () => {
          res.writeHead(response.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(data);
        });
      }).on('error', (err) => sendJson(res, 500, { error: err.message }));
      return;
    }

    const symUpper = symbol.toUpperCase();
    const spotUrl = `https://api.binance.com/api/v3/ticker/24hr?symbol=${symUpper}`;
    const futuresUrl = `https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${symUpper}`;

    https.get(spotUrl, (spotRes) => {
      let data = '';
      spotRes.on('data', (chunk) => data += chunk);
      spotRes.on('end', () => {
        if (spotRes.statusCode === 200) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(data);
        } else {
          // Fallback to Futures API
          https.get(futuresUrl, (futRes) => {
            let futData = '';
            futRes.on('data', (chunk) => futData += chunk);
            futRes.on('end', () => {
              res.writeHead(futRes.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
              res.end(futData);
            });
          }).on('error', (err) => sendJson(res, 500, { error: err.message }));
        }
      });
    }).on('error', (err) => sendJson(res, 500, { error: err.message }));
    return;
  }

  // Yahoo Finance Proxy Endpoint (for indices, forex, stocks)
  if (url.pathname === '/yahoo' && req.method === 'GET') {
    let symbol = url.searchParams.get('symbol') || '^GSPC';
    // Symbol mapping for common indices/forex
    const yahooMap = {
      'CAC': '^FCHI', 'CAC40': '^FCHI', 'DAX': '^GDAXI', 'DAX40': '^GDAXI',
      'NDX': '^NDX', 'NAS100': '^NDX', 'SPX': '^GSPC', 'SP500': '^GSPC',
      'DJI': '^DJI', 'DOW': '^DJI',
      'USDCHF': 'USDCHF=X', 'EURUSD': 'EURUSD=X', 'GBPUSD': 'GBPUSD=X',
      'USDJPY': 'USDJPY=X', 'EURJPY': 'EURJPY=X', 'GBPJPY': 'GBPJPY=X',
      'XAUUSD': 'GC=F', 'XAGUSD': 'SI=F', 'GOLD': 'GC=F', 'SILVER': 'SI=F',
      'WTI': 'CL=F', 'OIL': 'CL=F', 'BRENT': 'BZ=F'
    };
    const mapped = yahooMap[symbol.toUpperCase()];
    if (mapped) symbol = mapped;
    const interval = url.searchParams.get('interval') || '1d';
    const cacheKey = symbol + '_' + interval;
    const cached = yahooCache[cacheKey];
    const now = Date.now();
    // Cache for: 1min for 1m/5m, 5min for 15m/30m/1h, 1h for 1d+
    const ttl = interval === '1d' ? 3600000 : interval === '1h' ? 300000 : 60000;
    if (cached && now - cached.time < ttl) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(cached.data));
      return;
    }
    const range = interval === '1d' ? '1y' : interval === '5m' ? '1mo' : interval === '1h' ? '6mo' : interval === '1wk' ? '5y' : '2y';
    const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=false`;

    let triedIntervals = [interval];
    const fallbacks = { '5m': '1h', '15m': '1h', '30m': '1h', '1h': '1d' };
    let currentInterval = interval;
    
    function tryYahoo() {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${currentInterval}&range=${currentInterval === '1d' ? '1y' : '1mo'}&includePrePost=false`;
      const req = https.get(url, { timeout: 8000 }, (yhRes) => {
        let data = '';
        yhRes.on('data', (chunk) => data += chunk);
        yhRes.on('end', () => {
          if (yhRes.statusCode !== 200) {
            // Try fallback interval
            const next = fallbacks[currentInterval];
            if (next && !triedIntervals.includes(next)) {
              triedIntervals.push(next);
              currentInterval = next;
              tryYahoo();
              return;
            }
            sendJson(res, 400, { error: 'Yahoo error ' + yhRes.statusCode });
            return;
          }
          try {
            const parsed = JSON.parse(data);
            const result = parsed.chart?.result?.[0];
            if (!result) {
              const next = fallbacks[currentInterval];
              if (next && !triedIntervals.includes(next)) {
                triedIntervals.push(next);
                currentInterval = next;
                tryYahoo();
                return;
              }
              sendJson(res, 400, { error: 'No data from Yahoo' }); return;
            }
            const timestamps = result.timestamp || [];
            const quote = result.indicators?.quote?.[0] || {};
            const klines = timestamps.map((t, i) => [
              t * 1000,
              (quote.open?.[i] || 0).toString(),
              (quote.high?.[i] || 0).toString(),
              (quote.low?.[i] || 0).toString(),
              (quote.close?.[i] || 0).toString(),
              (quote.volume?.[i] || 0).toString(),
              t * 1000 + 60000, '0', 0, '0', '0', '0'
            ]).filter(k => parseFloat(k[4]) > 0);
            yahooCache[cacheKey] = { time: Date.now(), data: klines };
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify(klines));
          } catch (e) { sendJson(res, 500, { error: 'Yahoo parse: ' + e.message }); }
        });
        yhRes.on('error', () => {
          const next = fallbacks[currentInterval];
          if (next && !triedIntervals.includes(next)) {
            triedIntervals.push(next);
            currentInterval = next;
            tryYahoo();
            return;
          }
          sendJson(res, 504, { error: 'Yahoo unavailable' });
        });
      });
      req.on('timeout', () => { req.destroy();
        const next = fallbacks[currentInterval];
        if (next && !triedIntervals.includes(next)) {
          triedIntervals.push(next);
          currentInterval = next;
          tryYahoo();
          return;
        }
        sendJson(res, 504, { error: 'Yahoo timeout' });
      });
      req.on('error', () => {
        const next = fallbacks[currentInterval];
        if (next && !triedIntervals.includes(next)) {
          triedIntervals.push(next);
          currentInterval = next;
          tryYahoo();
          return;
        }
        sendJson(res, 504, { error: 'Yahoo error' });
      });
    }
    tryYahoo();
    return;
  }

  // Data Provider Endpoint (unified, with symbol normalization)
  if (url.pathname === '/data' && req.method === 'GET') {
    const dp = require('./data-provider');
    dp.handleDataRequest(url.searchParams).then(result => {
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(result));
    });
    return;
  }

  // Symbol Search Endpoint
  if (url.pathname === '/symbols' && req.method === 'GET') {
    const dp = require('./data-provider');
    const query = url.searchParams.get('query') || '';
    const results = dp.searchSymbols(query);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(results));
    return;
  }

  // Check MT5 availability
  if (url.pathname === '/check-mt5' && req.method === 'GET') {
    const dp = require('./data-provider');
    dp.checkMT5().then(ok => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ mt5: ok }));
    });
    return;
  }

  // News endpoint: RSS (Google News → Bing) + keyword sentiment (bullish/bearish)
  if (url.pathname === '/news' && req.method === 'GET') {
    const query = url.searchParams.get('query') || 'markets';
    fetchNews(query).then(items => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, items }));
    }).catch(e => {
      sendJson(res, 500, { ok: false, error: e.message });
    });
    return;
  }

  // Static Files
  // '/' и /heros → порталът ХЕРОС (отделен проект в папка heros/).
  // /helious → аналитичният терминал Helious (index.html).
  let urlPath = url.pathname;
  if (urlPath === '/' || urlPath === '/heros' || urlPath === '/heros/') urlPath = '/heros/index.html';
  else if (urlPath === '/helious' || urlPath === '/helious/') urlPath = '/index.html';
  const filePath = path.join(__dirname, urlPath);
  // Предпазване от излизане извън проекта (../)
  if (!path.resolve(filePath).startsWith(path.resolve(__dirname))) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': mimeType(filePath) });
    res.end(data);
  });
});

// ─── News: RSS fetch + sentiment ────────────────────────────────────
// Положителните думи дават зелена стрелка нагоре (bullish → ще расте),
// отрицателните — червена надолу (bearish → ще пада).

const BULL_KEYWORDS = [
  'raises', 'raised', 'surge', 'soar', 'jump', 'gain', 'gains', 'rall', 'record', 'beat',
  'growth', 'upgrade', 'upgrades', 'strong', 'bullish', 'bull', 'buy', 'buyback', 'boost',
  'recovery', 'breakout', 'profit', 'positive', 'higher', 'expands', 'rises', 'rise', 'rally',
  'ръст', 'растеж', 'расте', 'покачва', 'скок', 'рекорд', 'печалба', 'повишение', 'рали',
  'покупател', 'възстановяване', 'силни', 'нагоре', 'печели', 'успех'
];
const BEAR_KEYWORDS = [
  'drop', 'falls', 'fall', 'plunge', 'slide', 'slump', 'downgrade', 'downgrades', 'loss',
  'losses', 'weak', 'bearish', 'bear', 'sell', 'selloff', 'cut', 'cuts', 'low', 'lower',
  'negative', 'concern', 'fear', 'worry', 'recession', 'crash', 'pressure', 'below',
  'спад', 'спада', 'пада', 'загуба', 'слаб', 'мечешки', 'продажба', 'срив', 'натиск',
  'рецесия', 'понижение', 'страх', 'надолу', 'губи', 'криза', 'упадък'
];

function sentimentScore(text) {
  const t = ' ' + String(text).toLowerCase() + ' ';
  let score = 0;
  for (const w of BULL_KEYWORDS) if (t.includes(w.toLowerCase())) score += 1;
  for (const w of BEAR_KEYWORDS) if (t.includes(w.toLowerCase())) score -= 1;
  return score;
}

function xmlEntitiesToText(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, d) => { const c = String.fromCodePoint(parseInt(d, 10)); return /[^\x00-\x1F]/.test(c) ? c : ''; })
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => { const c = String.fromCodePoint(parseInt(h, 16)); return /[^\x00-\x1F]/.test(c) ? c : ''; })
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Взема RSS (Bing News с резюмета) за няколко заявки и извлича текста на всяка
// статия (meta description / първите абзаци). Връща {title, link, source, date, summary, sentiment}.
function fetchNews(query, tries) {
  tries = tries || 0;
  const queries = [query].concat(newsExtraQueries(query));
  if (tries >= queries.length) return Promise.resolve([]);
  const enc = encodeURIComponent(queries[tries]);
  const url = `https://www.bing.com/news/search?q=${enc}&format=rss`;
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } }, (r) => {
      let data = '';
      r.on('data', (c) => { data += c; if (data.length > 2e6) { req.destroy(); } });
      r.on('end', () => {
        try {
          const items = parseRssItems(data);
          const enriched = items.map(it => {
            // Декодираме XML entities (Bing apiclick има &amp; в link).
            let link = xmlEntitiesToText(it.link || '').replace(/&amp;/g, '&');
            const m = link.match(/[?&]url=([^&]+)/);
            if (m) link = decodeURIComponent(m[1]);
            const summary = xmlEntitiesToText(it.summary || '');
            const title = xmlEntitiesToText(it.title || '');
            const score = sentimentScore(title + ' ' + summary);
            return {
              title,
              link,
              source: xmlEntitiesToText(it.source || '') || 'Новини',
              date: it.date || '',
              summary,
              sentiment: score > 0 ? 'bullish' : score < 0 ? 'bearish' : 'neutral',
              score
            };
          });
          enrichArticleContents(enriched, 12).then(full => {
            // ако са малко, дотъгваме със следваща заявка
            if (full.length < 10 && tries < queries.length - 1) {
              fetchNews(query, tries + 1).then(more => resolve(mergeNews(full, more)));
            } else {
              resolve(full);
            }
          });
        } catch (e) {
          if (tries < queries.length - 1) resolve(fetchNews(query, tries + 1));
          else reject(e);
        }
      });
    });
    req.on('timeout', () => { req.destroy(); if (tries < queries.length - 1) resolve(fetchNews(query, tries + 1)); else reject(new Error('news timeout')); });
    req.on('error', (e) => { if (tries < queries.length - 1) resolve(fetchNews(query, tries + 1)); else reject(e); });
  });
}

// Допълнителни заявки към основната, за повече статии (без дублиране).
function newsExtraQueries(query) {
  const parts = query.split(/[\s+]+/).filter(Boolean);
  const variants = [];
  if (parts[0]) variants.push(parts[0] + ' news');
  if (parts[0]) variants.push(parts[0] + ' price');
  if (parts[1]) variants.push(parts[1]);
  return variants.slice(0, 2);
}

// Обединява списъци от статии без дублиране по заглавие.
function mergeNews(a, b) {
  const seen = new Set();
  const out = [];
  for (const it of a.concat(b)) {
    const key = String(it.title || '').toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

// Кеш за извлеченото съдържание на статиите.
const articleCache = {};
const MAX_SUMMARY = 500;

// Прави GET с http/https според протокола на URL-то.
function httpGet(url, timeout) {
  const mod = url.startsWith('https:') ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.get(url, { timeout: timeout || 8000, headers: { 'User-Agent': 'Mozilla/5.0' } }, (r) => {
      let d = '';
      r.on('data', (c) => { d += c; if (d.length > 800000) req.destroy(); });
      r.on('end', () => resolve({ status: r.statusCode, location: r.headers.location, body: d }));
      r.on('error', () => reject(new Error('read error')));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', (e) => reject(e));
  });
}

// За всяка статия отваря страницата и изважда резюмето (meta description/og + първите <p>).
// Неуспешните заявки пазят RSS summary-то/заглавието. Ограничаваме до limit статии.
function enrichArticleContents(items, limit) {
  const todo = items.slice(0, limit);
  return Promise.all(todo.map(it => {
    if (!it.link || !/^https?:\/\//.test(it.link)) return it;
    if (articleCache[it.link]) { it.summary = articleCache[it.link]; return it; }
    return httpGet(it.link).then(res => {
      // следваме redirect (напр. Bing apiclick → реалната статия)
      if (res.status >= 300 && res.status < 400 && res.location) {
        return httpGet(res.location).then(res2 => applyArticle(it, res2.body)).catch(() => it);
      }
      return applyArticle(it, res.body);
    }).catch(() => it);
  }));
}

// Извлича резюме от HTML на статията (meta description/og + първите <p> абзаци).
// Ако извлеченият текст е боклук (кеш бъг, защитна страница), се пази RSS summary.
function applyArticle(it, html) {
  const og = html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/i);
  const md = html.match(/<meta[^>]+name="description"[^>]+content="([^"]+)"/i);
  const ps = (html.match(/<p[^>]*>([\s\S]*?)<\/p>/gi) || []).map(p =>
    xmlEntitiesToText(p)
  ).filter(t => t.length > 40);
  let text = '';
  if (og) text = xmlEntitiesToText(og[1]);
  if (!text && md) text = xmlEntitiesToText(md[1]);
  if (!text && ps.length) text = ps.slice(0, 3).join(' ');
  if (text.length > MAX_SUMMARY) text = text.slice(0, MAX_SUMMARY) + '…';
  // Отхвърляме технически/защитни резюмета — те не са съдържание на новината.
  const garbage = /(cache-|security service|protection|cloudflare|captcha|error|404|нужно е|защитава|грешка)/i;
  if (text && text.length > 30 && !garbage.test(text)) {
    it.summary = text;
    articleCache[it.link] = text;
  }
  // обновяваме сентимента и спрямо извлеченото съдържание
  const score = sentimentScore(it.title + ' ' + it.summary);
  it.sentiment = score > 0 ? 'bullish' : score < 0 ? 'bearish' : 'neutral';
  it.score = score;
  return it;
}

// Лек RSS парсер: извлича <item> елементи с title/link/description/source/pubDate.
function parseRssItems(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const body = m[1];
    const tag = (name) => {
      const re = new RegExp('<' + name + '[^>]*>([\\s\\S]*?)</' + name + '>', 'i');
      const mm = body.match(re);
      return mm ? mm[1].trim() : '';
    };
    items.push({
      title: tag('title'),
      link: tag('link'),
      summary: tag('description') || tag('summary') || tag('content'),
      source: tag('source') || tag('provider'),
      date: tag('pubDate') || tag('published') || tag('date')
    });
  }
  // Най-новите първо (RFC2822 или ISO дати; непознат формат остава в края).
  const parseDate = (s) => {
    if (!s) return 0;
    const t = Date.parse(s);
    return isNaN(t) ? 0 : t;
  };
  return items.sort((a, b) => parseDate(b.date) - parseDate(a.date));
}

server.listen(PORT, async () => {
  console.log(`Server running at http://localhost:${PORT}`);
  // Инициализация на базата + миграции (ако е конфигурирана)
  try {
    const ok = await db.init();
    if (ok) {
      const migrate = require('./migrate');
      await migrate.run();
    }
  } catch (e) {
    console.error('[db] init/migrate fail:', e.message);
  }
  // Check MT5 availability in background
  const dp = require('./data-provider');
  dp.checkMT5().catch(() => {});
});
