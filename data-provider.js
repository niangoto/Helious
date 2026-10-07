// Data Provider Layer — нормализация на символи + абстракция на източници
// Поддържа: Binance (crypto), Yahoo Finance (indices, forex, stocks),
//           currency-api (forex, free, no key), MT5 (когато е наличен)
//           Опционално: Twelve Data, Alpha Vantage (с API key през env var)

const https = require('https');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// API keys from environment variables
const KEYS = {
  twelvedata: process.env.TWELVEDATA_KEY || '60d414154e994106b75c789994aaa430',
  alphavantage: process.env.ALPHAVANTAGE_KEY || '',
  finnhub: process.env.FINNHUB_KEY || '',
  polygon: process.env.POLYGON_KEY || '',
  oanda: process.env.OANDA_KEY || ''
};

// ─── Symbol Aliases ───────────────────────────────────────────────
const SYMBOL_ALIASES = {
  // Indices
  'DAX':     { canonical: 'DAX',   sources: ['twelvedata:DAX', 'yahoo:^GDAXI', 'mt5:GER40'] },
  'GER40':   { canonical: 'DAX',   sources: ['twelvedata:DAX', 'yahoo:^GDAXI', 'mt5:GER40'] },
  'DAX40':   { canonical: 'DAX',   sources: ['twelvedata:DAX', 'yahoo:^GDAXI', 'mt5:GER40'] },
  'GERMANY40': { canonical: 'DAX', sources: ['twelvedata:DAX', 'yahoo:^GDAXI', 'mt5:GER40'] },
  'DE40':    { canonical: 'DAX',   sources: ['twelvedata:DAX', 'yahoo:^GDAXI', 'mt5:GER40'] },

  'NDX':     { canonical: 'NDX',   sources: ['twelvedata:NASDAQ100', 'yahoo:^NDX', 'mt5:NAS100'] },
  'NAS100':  { canonical: 'NDX',   sources: ['twelvedata:NASDAQ100', 'yahoo:^NDX', 'mt5:NAS100'] },
  'US100':   { canonical: 'NDX',   sources: ['twelvedata:NASDAQ100', 'yahoo:^NDX', 'mt5:NAS100'] },
  'USTEC':   { canonical: 'NDX',   sources: ['twelvedata:NASDAQ100', 'yahoo:^NDX', 'mt5:NAS100'] },
  'NDX100':  { canonical: 'NDX',   sources: ['twelvedata:NASDAQ100', 'yahoo:^NDX', 'mt5:NAS100'] },
  'NASDAQ100': { canonical: 'NDX', sources: ['twelvedata:NASDAQ100', 'yahoo:^NDX', 'mt5:NAS100'] },

  'SPX':     { canonical: 'SPX',   sources: ['twelvedata:SPX', 'yahoo:^GSPC', 'mt5:US500'] },
  'SP500':   { canonical: 'SPX',   sources: ['twelvedata:SPX', 'yahoo:^GSPC', 'mt5:US500'] },
  'US500':   { canonical: 'SPX',   sources: ['twelvedata:SPX', 'yahoo:^GSPC', 'mt5:US500'] },
  'SPX500':  { canonical: 'SPX',   sources: ['twelvedata:SPX', 'yahoo:^GSPC', 'mt5:US500'] },

  'DJI':     { canonical: 'DJI',   sources: ['twelvedata:DJI', 'yahoo:^DJI', 'mt5:US30'] },
  'DOW':     { canonical: 'DJI',   sources: ['twelvedata:DJI', 'yahoo:^DJI', 'mt5:US30'] },
  'US30':    { canonical: 'DJI',   sources: ['twelvedata:DJI', 'yahoo:^DJI', 'mt5:US30'] },
  'DJ30':    { canonical: 'DJI',   sources: ['twelvedata:DJI', 'yahoo:^DJI', 'mt5:US30'] },
  'DOWJONES': { canonical: 'DJI',  sources: ['twelvedata:DJI', 'yahoo:^DJI', 'mt5:US30'] },

  'CAC':     { canonical: 'CAC',   sources: ['yahoo:^FCHI', 'mt5:F40'] },
  'CAC40':   { canonical: 'CAC',   sources: ['yahoo:^FCHI', 'mt5:F40'] },
  'FCHI':    { canonical: 'CAC',   sources: ['yahoo:^FCHI', 'mt5:F40'] },

  'FTSE':    { canonical: 'UK100', sources: ['twelvedata:UK100', 'yahoo:^FTSE', 'mt5:UK100'] },
  'UK100':   { canonical: 'UK100', sources: ['twelvedata:UK100', 'yahoo:^FTSE', 'mt5:UK100'] },
  'FTSE100': { canonical: 'UK100', sources: ['twelvedata:UK100', 'yahoo:^FTSE', 'mt5:UK100'] },

  'NIKKEI':  { canonical: 'NI225', sources: ['twelvedata:NI225', 'yahoo:^N225', 'mt5:JP225'] },
  'NI225':   { canonical: 'NI225', sources: ['twelvedata:NI225', 'yahoo:^N225', 'mt5:JP225'] },
  'JP225':   { canonical: 'NI225', sources: ['twelvedata:NI225', 'yahoo:^N225', 'mt5:JP225'] },
  'N225':    { canonical: 'NI225', sources: ['twelvedata:NI225', 'yahoo:^N225', 'mt5:JP225'] },

  // Forex (TwelveData first, then free forex API, then Yahoo)
  'EURUSD':  { canonical: 'EURUSD', sources: ['twelvedata:EURUSD', 'forex:EURUSD', 'yahoo:EURUSD=X', 'mt5:EURUSD'] },
  'GBPUSD':  { canonical: 'GBPUSD', sources: ['twelvedata:GBPUSD', 'forex:GBPUSD', 'yahoo:GBPUSD=X', 'mt5:GBPUSD'] },
  'USDJPY':  { canonical: 'USDJPY', sources: ['twelvedata:USDJPY', 'forex:USDJPY', 'yahoo:USDJPY=X', 'mt5:USDJPY'] },
  'USDCHF':  { canonical: 'USDCHF', sources: ['twelvedata:USDCHF', 'forex:USDCHF', 'yahoo:USDCHF=X', 'mt5:USDCHF'] },
  'EURJPY':  { canonical: 'EURJPY', sources: ['twelvedata:EURJPY', 'forex:EURJPY', 'yahoo:EURJPY=X', 'mt5:EURJPY'] },
  'GBPJPY':  { canonical: 'GBPJPY', sources: ['twelvedata:GBPJPY', 'forex:GBPJPY', 'yahoo:GBPJPY=X', 'mt5:GBPJPY'] },
  'AUDUSD':  { canonical: 'AUDUSD', sources: ['twelvedata:AUDUSD', 'forex:AUDUSD', 'yahoo:AUDUSD=X', 'mt5:AUDUSD'] },
  'NZDUSD':  { canonical: 'NZDUSD', sources: ['twelvedata:NZDUSD', 'forex:NZDUSD', 'yahoo:NZDUSD=X', 'mt5:NZDUSD'] },
  'USDCAD':  { canonical: 'USDCAD', sources: ['twelvedata:USDCAD', 'forex:USDCAD', 'yahoo:USDCAD=X', 'mt5:USDCAD'] },
  'EURGBP':  { canonical: 'EURGBP', sources: ['twelvedata:EURGBP', 'forex:EURGBP', 'yahoo:EURGBP=X', 'mt5:EURGBP'] },
  'EURAUD':  { canonical: 'EURAUD', sources: ['twelvedata:EURAUD', 'forex:EURAUD', 'yahoo:EURAUD=X', 'mt5:EURAUD'] },
  'EURCHF':  { canonical: 'EURCHF', sources: ['twelvedata:EURCHF', 'forex:EURCHF', 'yahoo:EURCHF=X', 'mt5:EURCHF'] },
  'EURCAD':  { canonical: 'EURCAD', sources: ['twelvedata:EURCAD', 'forex:EURCAD', 'yahoo:EURCAD=X', 'mt5:EURCAD'] },
  'GBPCHF':  { canonical: 'GBPCHF', sources: ['twelvedata:GBPCHF', 'forex:GBPCHF', 'yahoo:GBPCHF=X', 'mt5:GBPCHF'] },

  // Metals
  'XAUUSD':  { canonical: 'XAUUSD', sources: ['twelvedata:XAUUSD', 'yahoo:GC=F', 'mt5:XAUUSD'] },
  'GOLD':    { canonical: 'XAUUSD', sources: ['twelvedata:XAUUSD', 'yahoo:GC=F', 'mt5:XAUUSD'] },
  'XAGUSD':  { canonical: 'XAGUSD', sources: ['twelvedata:XAGUSD', 'yahoo:SI=F', 'mt5:XAGUSD'] },
  'SILVER':  { canonical: 'XAGUSD', sources: ['twelvedata:XAGUSD', 'yahoo:SI=F', 'mt5:XAGUSD'] },

  // Energy
  'WTI':     { canonical: 'WTI',   sources: ['twelvedata:WTI', 'yahoo:CL=F', 'mt5:WTI'] },
  'OIL':     { canonical: 'WTI',   sources: ['twelvedata:WTI', 'yahoo:CL=F', 'mt5:WTI'] },
  'CL':      { canonical: 'WTI',   sources: ['twelvedata:WTI', 'yahoo:CL=F', 'mt5:WTI'] },
  'BRENT':   { canonical: 'BRENT', sources: ['twelvedata:BRENT', 'yahoo:BZ=F', 'mt5:BRENT'] },
  'BZ':      { canonical: 'BRENT', sources: ['twelvedata:BRENT', 'yahoo:BZ=F', 'mt5:BRENT'] },

  // Crypto (canonical = Binance symbol)
  'BTC':     { canonical: 'BTCUSDT', sources: ['binance:BTCUSDT', 'yahoo:BTC-USD'] },
  'ETH':     { canonical: 'ETHUSDT', sources: ['binance:ETHUSDT', 'yahoo:ETH-USD'] },
  'SOL':     { canonical: 'SOLUSDT', sources: ['binance:SOLUSDT', 'yahoo:SOL-USD'] },
};

// Reverse lookup: alias → canonical
function resolveSymbol(input) {
  const key = input.toUpperCase().trim().replace(/[^A-Z0-9]/g, '');
  if (SYMBOL_ALIASES[key]) return SYMBOL_ALIASES[key].canonical;

  // Try exact as-is (e.g. BTCUSDT from Binance)
  for (const [alias, info] of Object.entries(SYMBOL_ALIASES)) {
    if (info.canonical === key || info.canonical === key + 'USDT' || info.canonical === key.replace('USDT', '') + 'USDT') return info.canonical;
  }
  // Return as-is if nothing matches
  return key;
}

function getSources(input) {
  const key = input.toUpperCase().trim().replace(/[^A-Z0-9]/g, '');
  if (SYMBOL_ALIASES[key]) return SYMBOL_ALIASES[key].sources;
  return [`binance:${key}`];
}

function getCanonicalName(input) {
  const key = input.toUpperCase().trim().replace(/[^A-Z0-9]/g, '');
  if (SYMBOL_ALIASES[key]) return SYMBOL_ALIASES[key].canonical;
  return key;
}

function getAllCanonicalSymbols() {
  const set = new Set();
  for (const info of Object.values(SYMBOL_ALIASES)) set.add(info.canonical);
  return [...set].sort();
}

function searchSymbols(query) {
  const q = query.toUpperCase().trim();
  if (!q) return getAllCanonicalSymbols().slice(0, 20);
  const results = [];
  for (const [alias, info] of Object.entries(SYMBOL_ALIASES)) {
    if (alias.includes(q) || info.canonical.includes(q)) {
      if (!results.find(r => r.canonical === info.canonical)) {
        results.push({ alias, canonical: info.canonical, sources: info.sources });
      }
    }
  }
  return results.slice(0, 20);
}

// ─── Data Fetching ──────────────────────────────────────────────
// Извличане на свещи от Binance с пейджинг: Binance връща най-много 1000
// свещи на заявка, затова при по-голям limit се теглят по-стари пакети
// (endTime) докато не се съберат исканите свещи или свърши историята.
async function fetchBinanceKlines(symbol, interval, limit, spot) {
  const base = spot ? 'https://api.binance.com/api/v3/klines' : 'https://fapi.binance.com/fapi/v1/klines';
  const batchSize = 1000;
  const batches = [];
  let endTime;
  let fetched = 0;
  limit = Math.max(limit || 1000, 1);
  while (fetched < limit) {
    const want = Math.min(batchSize, limit - fetched);
    let url = `${base}?symbol=${symbol}&interval=${interval}&limit=${want}`;
    if (endTime) url += `&endTime=${endTime}`;
    let batch;
    try {
      const raw = await fetchFromURL(url);
      batch = JSON.parse(raw);
    } catch (e) {
      break;
    }
    if (!Array.isArray(batch) || batch.length === 0) break;
    const data = batch.map(d => ({
      time: Math.floor(d[0] / 1000), open: parseFloat(d[1]), high: parseFloat(d[2]),
      low: parseFloat(d[3]), close: parseFloat(d[4]), volume: parseFloat(d[5])
    }));
    batches.push(data);
    fetched += data.length;
    endTime = data[0].time * 1000 - 1;
    if (data.length < want) break;
  }
  const out = [];
  for (let i = batches.length - 1; i >= 0; i--) out.push(...batches[i]);
  return out;
}

function fetchFromURL(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) reject(new Error(`HTTP ${res.statusCode}`));
        else resolve(data);
      });
    }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('Timeout')); });
  });
}

// Simple in-memory cache for Yahoo responses
const yahooCache = {};

async function fetchYahoo(symbol, interval) {
  const cacheKey = symbol + '_' + interval;
  const cached = yahooCache[cacheKey];
  // Кратък кеш, за да не изостава paper двигателят с до 5 мин (той проверява на 5с).
  if (cached && Date.now() - cached.time < 60000) return cached.data;

  // Yahoo ограничава range според интервала: 1m → най-много 7d, 2m..90m → 60d,
  // 1h → 730d. Затова не бива да се иска „1mo“ за 1m (връща 422/празно).
  const ranges = { '1m': '7d', '2m': '60d', '5m': '60d', '15m': '60d', '30m': '60d', '90m': '60d', '1h': '730d', '1d': '10y' };
  const fallbacks = { '1m': '5m', '5m': '15m', '15m': '1h', '30m': '1h', '1h': '1d' };
  const tried = [];
  let currentInterval = interval;
  
  while (!tried.includes(currentInterval)) {
    tried.push(currentInterval);
    const range = ranges[currentInterval] || '1mo';
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${currentInterval}&range=${range}&includePrePost=false`;
      const raw = await fetchFromURL(url);
      const parsed = JSON.parse(raw);
      const result = parsed.chart?.result?.[0];
      if (result && result.timestamp && result.timestamp.length > 0) {
        const ts = result.timestamp || [];
        const q = result.indicators?.quote?.[0] || {};
        const data = ts.map((t, i) => ({
          time: t, open: q.open?.[i] || 0, high: q.high?.[i] || 0,
          low: q.low?.[i] || 0, close: q.close?.[i] || 0, volume: q.volume?.[i] || 0
        })).filter(k => k.close > 0);
        yahooCache[cacheKey] = { time: Date.now(), data };
        return data;
      }
    } catch (e) {}
    currentInterval = fallbacks[currentInterval];
  }
  throw new Error('No Yahoo data for any interval');
}

// Free forex API (no key needed) — daily rates from currency-api
const forexCache = {};
async function fetchForex(pair) {
  const cacheKey = 'forex_' + pair;
  const cached = forexCache[cacheKey];
  if (cached && Date.now() - cached.time < 3600000) return cached.data;

  // Parse pair like EURUSD → base=usd, target=eur
  const base = pair.substring(0, 3).toLowerCase();
  const target = pair.substring(3, 6).toLowerCase();
  const url = `https://latest.currency-api.pages.dev/v1/currencies/${base}.json`;
  try {
    const raw = await fetchFromURL(url);
    const parsed = JSON.parse(raw);
    const rates = parsed[base];
    if (!rates || !rates[target]) throw new Error('No rate');
    const rate = rates[target];
    const now = Math.floor(Date.now() / 1000);
    // Generate synthetic daily candles for the last 365 days
    const data = [];
    for (let i = 365; i >= 0; i--) {
      const t = now - i * 86400;
      const noise = rate * 0.002 * (Math.random() - 0.5);
      const r = rate + noise;
      data.push({ time: t, open: r, high: r * 1.002, low: r * 0.998, close: r, volume: 0 });
    }
    forexCache[cacheKey] = { time: Date.now(), data };
    return data;
  } catch (e) {
    throw new Error('Forex API error: ' + e.message);
  }
}

// Безплатни дневни курсове EUR→XXX (currency-api) — без ключ и без лимит.
// Връща колко EUR е 1 единица от валутата (напр. USD ≈ 0.89).
const eurRatesCache = { time: 0, rates: null };
async function fetchEurRates() {
  if (eurRatesCache.rates && Date.now() - eurRatesCache.time < 3600000) return eurRatesCache.rates;
  const raw = await fetchFromURL('https://latest.currency-api.pages.dev/v1/currencies/eur.json');
  const parsed = JSON.parse(raw);
  const r = parsed.eur || {};
  const perEur = { USD: r.usd, GBP: r.gbp, JPY: r.jpy, CHF: r.chf, CAD: r.cad, AUD: r.aud };
  const rates = { EUR: 1 };
  for (const [ccy, v] of Object.entries(perEur)) rates[ccy] = (v > 0) ? 1 / v : 1;
  if (rates.USD > 0 && rates.USD !== 1) { eurRatesCache.rates = rates; eurRatesCache.time = Date.now(); }
  return rates;
}

// Twelve Data (requires TWELVEDATA_KEY env var).
// Безплатният план дава 8 кредита/мин и до 5000 свещи на заявка. За по-дълги
// периоди (напр. 1м за ~месец ≈ 43 000 свещи) теглим последователни страници
// назад във времето чрез `end_date`, ограничени до 8 страници на извикване
// (≈40 000 свещи ≈ 27 дни 1м), за да не надхвърлим кредитите.
const tdCache = {};
const TD_PAGE = 5000;      // максимум свещи на заявка
const TD_MAX_PAGES = 8;    // ≈40 000 свещи на извикване (в рамките на 8 кредита/мин)
const TD_PER_MIN = 8;      // кредити на минута (безплатен план)
let tdReqTimes = [];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Изчаква свободен кредит, за да не хвърля 429 „out of API credits“.
async function tdThrottle() {
  for (;;) {
    const now = Date.now();
    tdReqTimes = tdReqTimes.filter(t => now - t < 60000);
    if (tdReqTimes.length < TD_PER_MIN) break;
    await sleep(60000 - (now - tdReqTimes[0]) + 100);
  }
  tdReqTimes.push(Date.now());
}

// Една страница; хвърля при 429 (за да не повтаряме излишно) и при грешка.
async function tdFetchPage(baseUrl, endDate) {
  let url = baseUrl + '&outputsize=' + TD_PAGE;
  if (endDate) url += '&end_date=' + encodeURIComponent(endDate);
  await tdThrottle();
  const raw = await fetchFromURL(url);
  const parsed = JSON.parse(raw);
  if (parsed.status === 'error') {
    const err = new Error(parsed.message || ('TwelveData error ' + (parsed.code || '')));
    err.tdCode = parsed.code;
    throw err;
  }
  return parsed.values || [];
}

async function fetchTwelvedata(symbol, interval, limit) {
  const want = Math.max(parseInt(limit, 10) || 500, 1);
  const maxAvailable = TD_PAGE * TD_MAX_PAGES;
  const cacheKey = 'td_' + symbol + '_' + interval;
  const cached = tdCache[cacheKey];
  if (cached && Date.now() - cached.time < 300000 && cached.data.length >= Math.min(want, maxAvailable)) {
    return cached.data;
  }
  // TwelveData приема само: 1min, 5min, 15min, 30min, 1h, 2h, 4h, 6h, 8h, 12h, 1day, 3month.
  // („1hour“ и „day“ НЕ са валидни и водят до „Invalid interval“; невалиден интервал
  // преди това мълчащо падаше на 15min → 500 свещи = ~5 дни вместо заявения период.)
  const TD_INTERVALS = {
    '1m': '1min', '5m': '5min', '15m': '15min', '30m': '30min',
    '1h': '1h', '2h': '2h', '4h': '4h', '6h': '6h', '8h': '8h', '12h': '12h',
    '1d': '1day'
  };
  const int = TD_INTERVALS[interval];
  if (!int) throw new Error('TwelveData: unsupported interval ' + interval);

  // Try multiple symbol variants for commodities
  const variants = [symbol];
  if (symbol === 'XAUUSD') variants.push('GOLD', 'FOREX:XAUUSD');
  else if (symbol === 'XAGUSD') variants.push('SILVER', 'FOREX:XAGUSD');
  else if (symbol === 'WTI') variants.push('OIL', 'CL');
  else if (symbol === 'BRENT') variants.push('BZ');
  else if (symbol === 'DAX') variants.push('DE30', 'XETR:DAX');
  else if (symbol === 'NDX' || symbol === 'NASDAQ100') variants.push('NAS100.US', 'IXIC');
  else if (symbol === 'SPX') variants.push('SPX500.US', 'SPY');
  else if (symbol === 'CAC') variants.push('FCHI', 'CAC40');
  else if (symbol === 'NI225') variants.push('JP225', 'NIKKEI');

  let lastErr = null;
  for (const sym of variants) {
    const bases = [`https://api.twelvedata.com/time_series?symbol=${sym}&interval=${int}&apikey=${KEYS.twelvedata}`];
    // For forex pairs, also try slash format (EUR/USD instead of EURUSD)
    if (sym.length === 6 && /^[A-Z]{6}$/.test(sym)) {
      bases.push(`https://api.twelvedata.com/time_series?symbol=${sym.slice(0, 3)}/${sym.slice(3)}&interval=${int}&apikey=${KEYS.twelvedata}`);
    }
    for (const base of bases) {
      try {
        const byTime = new Map();
        let endDate = null;
        let pages = 0;
        while (byTime.size < want && pages < TD_MAX_PAGES) {
          pages++;
          const values = await tdFetchPage(base, endDate);
          if (!values.length) break;
          for (const v of values) {
            const t = Math.floor(new Date(v.datetime).getTime() / 1000);
            if (!byTime.has(t)) {
              byTime.set(t, {
                time: t, open: parseFloat(v.open), high: parseFloat(v.high),
                low: parseFloat(v.low), close: parseFloat(v.close), volume: parseInt(v.volume) || 0
              });
            }
          }
          const oldest = values[values.length - 1].datetime;
          if (endDate && oldest >= endDate) break;   // няма напредък във времето
          endDate = oldest;
          if (values.length < TD_PAGE) break;        // стигнали сме началото на историята
        }
        if (byTime.size === 0) continue;
        const data = [...byTime.values()].sort((a, b) => a.time - b.time);
        tdCache[cacheKey] = { time: Date.now(), data };
        return data;
      } catch (e) {
        lastErr = e;
        // 429 / невалиден символ → не продължавай с други варианти (спестява кредити)
        if (e.tdCode === 429) throw e;
      }
    }
  }
  if (lastErr) throw lastErr;
  throw new Error('TwelveData: no data for any variant of ' + symbol);
}

// Negative cache — remember symbols that failed to avoid hitting APIs repeatedly
const failCache = {};
const FAIL_TTL = 300000; // 5 минути

async function fetchData(symbol, interval, limit) {
  const canonical = resolveSymbol(symbol);
  const cacheKey = canonical + '_' + interval;
  const failed = failCache[cacheKey];
  if (failed && Date.now() - failed.time < FAIL_TTL) {
    throw { message: `Няма данни за ${canonical} (кеширана грешка)`, errors: failed.errors };
  }
  const sources = getSources(symbol);
  const errors = [];

  for (const src of sources) {
    try {
      const [provider, sym] = src.split(':');

      if (provider === 'yahoo') {
        const data = await fetchYahoo(sym, interval);
        if (data.length > 10) return { symbol: canonical, interval, candles: data, source: 'yahoo:' + sym };
      }
      if (provider === 'forex') {
        const data = await fetchForex(sym);
        if (data.length > 10) return { symbol: canonical, interval, candles: data, source: 'forex:' + sym };
      }
      if (provider === 'twelvedata') {
        if (!KEYS.twelvedata) throw new Error('TwelveData key not set; use TWELVEDATA_KEY env var');
        const data = await fetchTwelvedata(sym, interval, limit);
        if (data.length > 10) return { symbol: canonical, interval, candles: data, source: 'twelvedata:' + sym };
      }
      if (provider === 'binance') {
        const data = await fetchBinanceKlines(sym, interval, limit);
        if (data.length > 10) return { symbol: canonical, interval, candles: data, source: 'binance:' + sym };
      }
      if (provider === 'mt5') {
        // MT5 bridge — spawn Python script
        const data = await fetchMT5(sym, interval);
        if (data && data.length > 10) return { symbol: canonical, interval, candles: data, source: 'mt5:' + sym };
      }
    } catch (e) {
      errors.push(`${src}: ${e.message}`);
    }
  }

  // Try Binance Spot as last resort for crypto
  if (!symbol.includes('USDT')) {
    try {
      const data = await fetchBinanceKlines(symbol, interval, limit, true);
      if (data.length > 10) return { symbol: canonical, interval, candles: data, source: 'binance:' + symbol };
    } catch (e) { errors.push(`binance:${symbol}: ${e.message}`); }
  }

  // Cache failure so we don't spam APIs for dead symbols
  failCache[cacheKey] = { time: Date.now(), errors };
  throw { message: `Няма данни за ${canonical}`, errors };
}

// ─── MT5 Bridge ────────────────────────────────────────────────
let mt5Available = false;
let mt5Checked = false;

function checkMT5() {
  if (mt5Checked) return Promise.resolve(mt5Available);
  mt5Checked = true;
  return new Promise(resolve => {
    const proc = spawn('python3', [path.join(__dirname, 'mt5-bridge.py'), '--check']);
    let out = '';
    proc.stdout.on('data', d => out += d);
    proc.on('close', code => {
      mt5Available = code === 0 && out.trim() === 'ok';
      if (mt5Available) log('INFO', 'MT5 available');
      else log('WARN', 'MT5 not available');
      resolve(mt5Available);
    });
    proc.on('error', () => { mt5Available = false; resolve(false); });
    setTimeout(() => { mt5Available = false; resolve(false); }, 3000);
  });
}

async function fetchMT5(symbol, interval) {
  if (!mt5Checked) await checkMT5();
  if (!mt5Available) throw new Error('MT5 not available');
  const tf = { '1m': 'M1', '5m': 'M5', '15m': 'M15', '30m': 'M30', '1h': 'H1', '4h': 'H4', '1d': 'D1' }[interval] || 'D1';
  return new Promise((resolve, reject) => {
    const proc = spawn('python3', [path.join(__dirname, 'mt5-bridge.py'), '--symbol', symbol, '--timeframe', tf, '--bars', '500']);
    let out = '';
    proc.stdout.on('data', d => out += d);
    proc.on('close', code => {
      if (code !== 0) { reject(new Error('MT5 error')); return; }
      try { resolve(JSON.parse(out)); } catch (e) { reject(new Error('MT5 parse error')); }
    });
    proc.on('error', () => reject(new Error('MT5 unavailable')));
    setTimeout(() => reject(new Error('MT5 timeout')), 15000);
  });
}

// ─── Logging ────────────────────────────────────────────────────
// Логът се пише в ./data (persist-ва се през Docker volume).
const LOG_DIR = path.join(__dirname, 'data');
const LOG_FILE = path.join(LOG_DIR, 'data-provider.log');
function log(level, msg, data) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}${data ? ' ' + JSON.stringify(data) : ''}`;
  console.log(line);
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (e) {}
}

// ─── Express-style handler for server.js ────────────────────────
async function handleDataRequest(urlParams) {
  const symbol = (urlParams.get('symbol') || 'BTCUSDT').toUpperCase();
  const interval = urlParams.get('interval') || '1m';
  const limit = parseInt(urlParams.get('limit')) || 500;

  log('INFO', `Fetching ${symbol} @ ${interval}`);

  try {
    const result = await fetchData(symbol, interval, limit);
    const sliced = result.candles.slice(-limit);

    log('OK', `${symbol}: ${sliced.length} candles from ${result.source}`);

    return {
      ok: true,
      symbol: result.symbol,
      interval: result.interval,
      source: result.source,
      candles: sliced
    };
  } catch (e) {
    log('ERROR', `${symbol}: ${e.message}`, e.errors);
    return {
      ok: false,
      symbol: resolveSymbol(symbol),
      error: e.message || 'Unknown error',
      details: e.errors ? e.errors.join('; ') : ''
    };
  }
}

// ─── Информация за инструмента (мин. обем, спред) от Binance ─────
// Само за крипто символи, листнати на Binance Futures. Ливъриджът НЕ е
// публично достъпен (иска API key) — остава ръчна настройка.
const binanceSpotCache = new Map();   // sym -> { at, data }

function isBinanceCrypto(sym) {
  const s = String(sym || '').toUpperCase().trim();
  if (/(USDT|USDC|BUSD|FDUSD|TUSD)$/.test(s)) return true;
  return /^(BTC|ETH|SOL)(USD)?$/.test(s);
}

// SPOT метаданни (същите, които показва binance.com). Кешира per символ.
async function binanceSpotSymbol(sym) {
  const c = binanceSpotCache.get(sym);
  if (c && Date.now() - c.at < 3600000) return c.data;
  const j = JSON.parse(await fetchFromURL(`https://api.binance.com/api/v3/exchangeInfo?symbol=${sym}`));
  const s = (j.symbols || [])[0];
  if (s) binanceSpotCache.set(sym, { at: Date.now(), data: s });
  return s;
}

// Връща { ok, minQty, stepSize, minNotional, tickSize, bid, ask, spread, spreadPct }
// за крипто символ, или { ok:false, reason } за не-крипто/нелистнато.
async function fetchInstrumentInfo(symbol) {
  const canonical = resolveSymbol(symbol) || String(symbol || '').toUpperCase().trim();
  if (!isBinanceCrypto(canonical)) return { ok: false, reason: 'not_binance' };
  let sym = canonical;
  if (!/USDT$/.test(sym) && /^(BTC|ETH|SOL)$/.test(sym)) sym = sym + 'USDT';
  try {
    const s = await binanceSpotSymbol(sym);
    if (!s) return { ok: false, reason: 'not_listed', symbol: sym };
    const lot = (s.filters || []).find(f => f.filterType === 'LOT_SIZE') || {};
    const nt = (s.filters || []).find(f => f.filterType === 'MIN_NOTIONAL' || f.filterType === 'NOTIONAL') || {};
    const pf = (s.filters || []).find(f => f.filterType === 'PRICE_FILTER') || {};
    let bid = 0, ask = 0;
    try {
      const b = JSON.parse(await fetchFromURL(`https://api.binance.com/api/v3/ticker/bookTicker?symbol=${sym}`));
      bid = parseFloat(b.bidPrice) || 0; ask = parseFloat(b.askPrice) || 0;
    } catch (e) { /* ignore */ }
    const mid = (bid + ask) / 2;
    const spread = (bid > 0 && ask > 0) ? (ask - bid) : 0;
    const minQty = parseFloat(lot.minQty) || 0;
    const step = parseFloat(lot.stepSize) || 0;
    const minNotional = parseFloat(nt.minNotional || nt.notional) || 0;
    // Реалният минимум е по-голямото от minQty и minNotional/цена, закръглено
    // НАГОРЕ към стъпката (иначе поръчката се отхвърля по MIN_NOTIONAL).
    let effMinQty = minQty;
    if (minNotional > 0 && mid > 0 && minNotional / mid > effMinQty) effMinQty = minNotional / mid;
    if (step > 0) effMinQty = Math.ceil(effMinQty / step - 1e-9) * step;
    // Стандартна spot taker комисиона на Binance (0.1%).
    const takerFee = 0.001;
    return {
      ok: true, source: 'binance', market: 'spot', symbol: sym,
      minQty, stepSize: step, minNotional, tickSize: parseFloat(pf.tickSize) || 0,
      effMinQty, takerFee,
      bid, ask, mid, spread, spreadPct: mid > 0 ? (spread / mid) * 100 : 0
    };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

module.exports = { resolveSymbol, getCanonicalName, getAllCanonicalSymbols, searchSymbols, fetchData, fetchEurRates, handleDataRequest, checkMT5, fetchInstrumentInfo, log };
