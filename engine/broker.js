// HEROS демо брокер — Binance Testnet (фалшиви пари).
// Само testnet хостове (виж engine/binance.js). Реални акаунти НЕ се пипат.
// Изпълнява MARKET поръчки и връща snapshot на демо сметката (баланс/позиции).
const binance = require('./binance');

// Кеш на филтрите по символ (стъпка/минимум) от exchangeInfo.
const infoCache = { market: null, at: 0, symbols: null };

async function loadFilters(market) {
  if (infoCache.market === market && Date.now() - infoCache.at < 3600000) return infoCache.symbols;
  const path = market === 'futures' ? '/fapi/v1/exchangeInfo' : '/api/v3/exchangeInfo';
  const j = await binance.publicGet(market, path);
  const map = {};
  for (const s of (j.symbols || [])) {
    const lot = (s.filters || []).find(f => f.filterType === 'LOT_SIZE') || {};
    const nt = (s.filters || []).find(f => f.filterType === 'MIN_NOTIONAL' || f.filterType === 'NOTIONAL') || {};
    const pf = (s.filters || []).find(f => f.filterType === 'PRICE_FILTER') || {};
    map[s.symbol] = {
      step: parseFloat(lot.stepSize) || 0.001,
      minQty: parseFloat(lot.minQty) || 0,
      minNotional: parseFloat(nt.notional || nt.minNotional) || 0,
      priceTick: parseFloat(pf.tickSize) || 0
    };
  }
  infoCache.market = market; infoCache.at = Date.now(); infoCache.symbols = map;
  return map;
}

function roundStep(q, step) {
  if (!(step > 0)) return q;
  const v = Math.floor(q / step + 1e-9) * step;
  return Math.round(v * 1e12) / 1e12;
}

// Коригира обема към филтрите на борсата (стъпка + минимум).
async function normalizeQty(creds, symbol, qty) {
  const filters = await loadFilters(creds.market);
  const f = filters[symbol];
  if (!f) return qty;
  let q = roundStep(qty, f.step);
  if (q < f.minQty) q = f.minQty;
  return q;
}

async function symbolTradable(creds, symbol) {
  try { const f = await loadFilters(creds.market); return !!f[symbol]; } catch (e) { return false; }
}

async function setLeverage(creds, symbol, leverage) {
  if (creds.market !== 'futures') return null;
  try {
    return await binance.signedRequest('futures', creds.apiKey, creds.apiSecret, '/fapi/v1/leverage', { symbol, leverage }, 'POST');
  } catch (e) { return null; }
}

// Пазарна поръчка. side = 'BUY' | 'SELL'. reduceOnly (само фючърси).
async function marketOrder(creds, symbol, side, quantity, reduceOnly) {
  const q = await normalizeQty(creds, symbol, quantity);
  if (creds.market === 'futures') {
    const p = { symbol, side, type: 'MARKET', quantity: q };
    if (reduceOnly) p.reduceOnly = 'true';
    return binance.signedRequest('futures', creds.apiKey, creds.apiSecret, '/fapi/v1/order', p, 'POST');
  }
  return binance.signedRequest('spot', creds.apiKey, creds.apiSecret, '/api/v3/order', { symbol, side, type: 'MARKET', quantity: q }, 'POST');
}

// Snapshot на демо сметката: баланс, свободни средства, плаваща печалба, позиции.
async function account(creds) {
  if (creds.market === 'futures') {
    const a = await binance.signedRequest('futures', creds.apiKey, creds.apiSecret, '/fapi/v2/account');
    let pr = [];
    try { pr = await binance.signedRequest('futures', creds.apiKey, creds.apiSecret, '/fapi/v2/positionRisk'); } catch (e) { pr = []; }
    const positions = (pr || [])
      .filter(p => Math.abs(parseFloat(p.positionAmt)) > 0)
      .map(p => {
        const amt = parseFloat(p.positionAmt);
        return {
          symbol: p.symbol,
          dir: amt > 0 ? 'BUY' : 'SELL',
          qty: Math.abs(amt),
          entry: parseFloat(p.entryPrice),
          unrealized: parseFloat(p.unRealizedProfit),
          margin: (() => { const m = parseFloat(p.isolatedMargin); return isFinite(m) && m > 0 ? m : null; })(),
          leverage: parseFloat(p.leverage),
          liquidation: parseFloat(p.liquidationPrice)
        };
      });
    const balance = parseFloat(a.totalWalletBalance) || 0;
    const unrealized = parseFloat(a.totalUnrealizedProfit) || 0;
    const available = parseFloat(a.availableBalance) || 0;
    return {
      market: 'futures', balance, available, unrealized,
      equity: balance + unrealized, positions, canTrade: !!a.canTrade
    };
  }
  const a = await binance.signedRequest('spot', creds.apiKey, creds.apiSecret, '/api/v3/account');
  const balances = (a.balances || [])
    .filter(b => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0)
    .map(b => ({ asset: b.asset, free: parseFloat(b.free), locked: parseFloat(b.locked) }));
  return { market: 'spot', balances, canTrade: !!a.canTrade, positions: [] };
}

module.exports = { loadFilters, normalizeQty, symbolTradable, setLeverage, marketOrder, account, roundStep };
