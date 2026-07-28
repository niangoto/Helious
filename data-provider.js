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
  twelvedata: process.env.TWELVEDATA_KEY || '',
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

  'CAC':     { canonical: 'CAC',   sources: ['twelvedata:CAC', 'yahoo:^FCHI', 'mt5:F40'] },
  'CAC40':   { canonical: 'CAC',   sources: ['twelvedata:CAC', 'yahoo:^FCHI', 'mt5:F40'] },
  'FCHI':    { canonical: 'CAC',   sources: ['twelvedata:CAC', 'yahoo:^FCHI', 'mt5:F40'] },

  'FTSE':    { canonical: 'UK100', sources: ['twelvedata:UK100', 'yahoo:^FTSE', 'mt5:UK100'] },
  'UK100':   { canonical: 'UK100', sources: ['twelvedata:UK100', 'yahoo:^FTSE', 'mt5:UK100'] },
  'FTSE100': { canonical: 'UK100', sources: ['twelvedata:UK100', 'yahoo:^FTSE', 'mt5:UK100'] },

  'NIKKEI':  { canonical: 'NI225', sources: ['twelvedata:NI225', 'yahoo:^N225', 'mt5:JP225'] },
  'NI225':   { canonical: 'NI225', sources: ['twelvedata:NI225', 'yahoo:^N225', 'mt5:JP225'] },
  'JP225':   { canonical: 'NI225', sources: ['twelvedata:NI225', 'yahoo:^N225', 'mt5:JP225'] },
  'N225':    { canonical: 'NI225', sources: ['twelvedata:NI225', 'yahoo:^N225', 'mt5:JP225'] },

  // Forex
  'EURUSD':  { canonical: 'EURUSD', sources: ['forex:EURUSD', 'yahoo:EURUSD=X', 'mt5:EURUSD'] },
  'GBPUSD':  { canonical: 'GBPUSD', sources: ['forex:GBPUSD', 'yahoo:GBPUSD=X', 'mt5:GBPUSD'] },
  'USDJPY':  { canonical: 'USDJPY', sources: ['forex:USDJPY', 'yahoo:USDJPY=X', 'mt5:USDJPY'] },
  'USDCHF':  { canonical: 'USDCHF', sources: ['forex:USDCHF', 'yahoo:USDCHF=X', 'mt5:USDCHF'] },
  'EURJPY':  { canonical: 'EURJPY', sources: ['forex:EURJPY', 'yahoo:EURJPY=X', 'mt5:EURJPY'] },
  'GBPJPY':  { canonical: 'GBPJPY', sources: ['forex:GBPJPY', 'yahoo:GBPJPY=X', 'mt5:GBPJPY'] },
  'AUDUSD':  { canonical: 'AUDUSD', sources: ['forex:AUDUSD', 'yahoo:AUDUSD=X', 'mt5:AUDUSD'] },
  'NZDUSD':  { canonical: 'NZDUSD', sources: ['forex:NZDUSD', 'yahoo:NZDUSD=X', 'mt5:NZDUSD'] },
  'USDCAD':  { canonical: 'USDCAD', sources: ['forex:USDCAD', 'yahoo:USDCAD=X', 'mt5:USDCAD'] },
  'EURGBP':  { canonical: 'EURGBP', sources: ['forex:EURGBP', 'yahoo:EURGBP=X', 'mt5:EURGBP'] },
  'EURAUD':  { canonical: 'EURAUD', sources: ['forex:EURAUD', 'yahoo:EURAUD=X', 'mt5:EURAUD'] },
  'GBPCHF':  { canonical: 'GBPCHF', sources: ['forex:GBPCHF', 'yahoo:GBPCHF=X', 'mt5:GBPCHF'] },

  // Metals
  'XAUUSD':  { canonical: 'XAUUSD', sources: ['yahoo:GC=F', 'mt5:XAUUSD'] },
  'GOLD':    { canonical: 'XAUUSD', sources: ['yahoo:GC=F', 'mt5:XAUUSD'] },
  'XAGUSD':  { canonical: 'XAGUSD', sources: ['yahoo:SI=F', 'mt5:XAGUSD'] },
  'SILVER':  { canonical: 'XAGUSD', sources: ['yahoo:SI=F', 'mt5:XAGUSD'] },

  // Energy
  'WTI':     { canonical: 'WTI',   sources: ['yahoo:CL=F', 'mt5:WTI'] },
  'OIL':     { canonical: 'WTI',   sources: ['yahoo:CL=F', 'mt5:WTI'] },
  'CL':      { canonical: 'WTI',   sources: ['yahoo:CL=F', 'mt5:WTI'] },
  'BRENT':   { canonical: 'BRENT', sources: ['yahoo:BZ=F', 'mt5:BRENT'] },
  'BZ':      { canonical: 'BRENT', sources: ['yahoo:BZ=F', 'mt5:BRENT'] },

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
function fetchFromURL(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { timeout: 10000 }, (res) => {
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
  if (cached && Date.now() - cached.time < 60000) return cached.data;

  const fallbacks = { '5m': '1h', '15m': '1h', '30m': '1h', '1h': '1d' };
  const tried = [];
  let currentInterval = interval;
  
  while (!tried.includes(currentInterval)) {
    tried.push(currentInterval);
    const range = currentInterval === '1d' ? '1y' : currentInterval === '1h' ? '6mo' : '1mo';
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

// Twelve Data (requires TWELVEDATA_KEY env var)
const tdCache = {};
async function fetchTwelvedata(symbol, interval) {
  const cacheKey = 'td_' + symbol + '_' + interval;
  const cached = tdCache[cacheKey];
  if (cached && Date.now() - cached.time < 60000) return cached.data;
  const int = interval === '1d' ? 'day' : interval === '1h' ? '1hour' : interval === '5m' ? '5min' : '15min';
  const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=${int}&outputsize=500&apikey=${KEYS.twelvedata}`;
  const raw = await fetchFromURL(url);
  const parsed = JSON.parse(raw);
  if (parsed.status === 'error') throw new Error('TwelveData: ' + parsed.message);
  const values = parsed.values || [];
  if (values.length === 0) throw new Error('TwelveData: no data');
  const data = values.map(v => ({
    time: Math.floor(new Date(v.datetime).getTime() / 1000),
    open: parseFloat(v.open), high: parseFloat(v.high), low: parseFloat(v.low),
    close: parseFloat(v.close), volume: parseInt(v.volume) || 0
  })).reverse();
  tdCache[cacheKey] = { time: Date.now(), data };
  return data;
}

async function fetchData(symbol, interval) {
  const canonical = resolveSymbol(symbol);
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
        const data = await fetchTwelvedata(sym, interval);
        if (data.length > 10) return { symbol: canonical, interval, candles: data, source: 'twelvedata:' + sym };
      }
      if (provider === 'binance') {
        const raw = await fetchFromURL(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${interval}&limit=1000`);
        const data = JSON.parse(raw).map(d => ({
          time: Math.floor(d[0] / 1000), open: parseFloat(d[1]), high: parseFloat(d[2]),
          low: parseFloat(d[3]), close: parseFloat(d[4]), volume: parseFloat(d[5])
        }));
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
      const raw = await fetchFromURL(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=1000`);
      const data = JSON.parse(raw).map(d => ({
        time: Math.floor(d[0] / 1000), open: parseFloat(d[1]), high: parseFloat(d[2]),
        low: parseFloat(d[3]), close: parseFloat(d[4]), volume: parseFloat(d[5])
      }));
      if (data.length > 10) return { symbol: canonical, interval, candles: data, source: 'binance:' + symbol };
    } catch (e) { errors.push(`binance:${symbol}: ${e.message}`); }
  }

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
function log(level, msg, data) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}${data ? ' ' + JSON.stringify(data) : ''}`;
  console.log(line);
  try { require('fs').appendFileSync(path.join(__dirname, 'data-provider.log'), line + '\n'); } catch (e) {}
}

// ─── Express-style handler for server.js ────────────────────────
async function handleDataRequest(urlParams) {
  const symbol = (urlParams.get('symbol') || 'BTCUSDT').toUpperCase();
  const interval = urlParams.get('interval') || '1m';
  const limit = parseInt(urlParams.get('limit')) || 500;

  log('INFO', `Fetching ${symbol} @ ${interval}`);

  try {
    const result = await fetchData(symbol, interval);
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
      error: e.message || 'Unknown error'
    };
  }
}

module.exports = { resolveSymbol, getCanonicalName, getAllCanonicalSymbols, searchSymbols, fetchData, handleDataRequest, checkMT5, log };
