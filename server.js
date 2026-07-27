const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3001;

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
    const symbol = url.searchParams.get('symbol') || '^GSPC';
    const interval = url.searchParams.get('interval') || '1d';
    const range = interval === '1d' ? '1y' : interval === '5m' ? '1mo' : interval === '1h' ? '6mo' : interval === '1wk' ? '5y' : '2y';
    const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=false`;

    const req = https.get(yahooUrl, { timeout: 8000 }, (yhRes) => {
      let data = '';
      yhRes.on('data', (chunk) => data += chunk);
      yhRes.on('end', () => {
        if (yhRes.statusCode !== 200) { sendJson(res, 400, { error: 'Yahoo error ' + yhRes.statusCode }); return; }
        try {
          const parsed = JSON.parse(data);
          const result = parsed.chart?.result?.[0];
          if (!result) { sendJson(res, 400, { error: 'No data from Yahoo' }); return; }
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
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify(klines));
        } catch (e) { sendJson(res, 500, { error: 'Yahoo parse: ' + e.message }); }
      });
      yhRes.on('error', () => sendJson(res, 504, { error: 'Yahoo unavailable' }));
    });
    req.on('timeout', () => { req.destroy(); sendJson(res, 504, { error: 'Yahoo timeout' }); });
    req.on('error', () => sendJson(res, 504, { error: 'Yahoo error' }));
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
});
