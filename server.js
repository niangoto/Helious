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
