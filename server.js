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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

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

  // Static Files
  const filePath = path.join(__dirname, url.pathname === '/' ? 'index.html' : url.pathname);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const contentType = filePath.endsWith('.html') ? 'text/html' : 'text/plain';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  // Check MT5 availability in background
  const dp = require('./data-provider');
  dp.checkMT5().catch(() => {});
});
