// Binance Testnet (ДЕМО) REST клиент — спот и фючърси.
// Само testnet хостове (фалшиви пари): spot testnet.binance.vision,
// futures testnet.binancefuture.com. Реални акаунти НЕ пипаме.
const crypto = require('crypto');
const https = require('https');

const HOSTS = {
  spot: 'testnet.binance.vision',
  futures: 'testnet.binancefuture.com'
};

function request(host, path, { method = 'GET', apiKey } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'helious/1.0' };
    if (apiKey) headers['X-MBX-APIKEY'] = apiKey;
    const req = https.request({ method, host, path, headers, timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let j = {};
        try { j = data ? JSON.parse(data) : {}; } catch (e) { j = { raw: data }; }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(j);
        else reject(Object.assign(new Error(j.msg || ('HTTP ' + res.statusCode)), { code: j.code, status: res.statusCode }));
      });
    });
    req.on('error', reject);
    req.on('timeout', function () { this.destroy(new Error('timeout')); });
    req.end();
  });
}

function sign(secret, query) {
  return crypto.createHmac('sha256', String(secret || '')).update(query).digest('hex');
}

// Публична GET заявка (без подпис).
function publicGet(market, path) {
  return request(HOSTS[market] || HOSTS.spot, path, {});
}

// Подписана заявка (HMAC SHA256). params → query string + signature.
function signedRequest(market, apiKey, secret, path, params = {}, method = 'GET') {
  const host = HOSTS[market] || HOSTS.spot;
  params.timestamp = Date.now();
  if (params.recvWindow == null) params.recvWindow = 5000;
  const query = new URLSearchParams(params).toString();
  const signature = sign(secret, query);
  return request(host, `${path}?${query}&signature=${signature}`, { method, apiKey });
}

// Проверка на връзката + нормализиран баланс.
async function testConnection(market, apiKey, secret) {
  market = (market === 'futures') ? 'futures' : 'spot';
  if (!apiKey || !secret) throw new Error('Липсват API ключ/секрет');
  const a = await (market === 'futures'
    ? signedRequest('futures', apiKey, secret, '/fapi/v2/account')
    : signedRequest('spot', apiKey, secret, '/api/v3/account'));
  let balances = [];
  if (market === 'futures') {
    balances = [{ asset: 'USDT', free: a.availableBalance, total: a.totalWalletBalance }];
  } else {
    balances = (a.balances || [])
      .filter(b => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0)
      .map(b => ({ asset: b.asset, free: b.free, locked: b.locked }));
  }
  return { ok: true, market, canTrade: !!a.canTrade, balances };
}

// Цена (публична).
async function getPrice(market, symbol) {
  const path = market === 'futures'
    ? `/fapi/v1/ticker/price?symbol=${encodeURIComponent(symbol)}`
    : `/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`;
  const r = await publicGet(market, path);
  return parseFloat(r.price);
}

// ── Ордерни функции (за бъдещата автоматична търговия на демо) ──
async function placeMarketOrder(market, apiKey, secret, symbol, side, quantity) {
  if (market === 'futures') {
    return signedRequest('futures', apiKey, secret, '/fapi/v1/order', {
      symbol, side, type: 'MARKET', quantity
    }, 'POST');
  }
  return signedRequest('spot', apiKey, secret, '/api/v3/order', {
    symbol, side, type: 'MARKET', quantity
  }, 'POST');
}

async function getOpenOrders(market, apiKey, secret, symbol) {
  const path = market === 'futures' ? '/fapi/v1/openOrders' : '/api/v3/openOrders';
  return signedRequest(market, apiKey, secret, path, symbol ? { symbol } : {});
}

async function cancelOpenOrders(market, apiKey, secret, symbol) {
  const path = market === 'futures' ? '/fapi/v1/allOpenOrders' : '/api/v3/openOrders';
  return signedRequest(market, apiKey, secret, path, { symbol }, 'DELETE');
}

module.exports = { HOSTS, publicGet, signedRequest, testConnection, getPrice, placeMarketOrder, getOpenOrders, cancelOpenOrders };
