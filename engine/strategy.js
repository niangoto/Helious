// Чиста стратегия (вход/изход/размер) — огледало на логиката в hermes.html.
// Ползва се от paper двигателя. Без DOM/мрежа — само математика.

const { specFor } = require('./symbolSpec');

// Нормализира параметрите като readParams() в hermes.html.
function normalizeParams(p) {
  p = p || {};
  const num = (v, d) => (isFinite(parseFloat(v)) ? parseFloat(v) : d);
  return {
    budget: Math.max(1, num(p.budget, 1000)),
    leverage: Math.max(1, num(p.leverage, 30)),
    alpha: Math.min(10, Math.max(0.1, num(p.alpha, 1.0))),
    buyTh: num(p.buyTh, 65),
    sellTh: num(p.sellTh, 65),
    minEv: num(p.minEv, 0),
    tpMult: num(p.tpMult, 1.5),
    slMult: num(p.slMult, 1.0),
    holdBars: Math.max(1, parseInt(p.holdBars, 10) || 50),
    kellyF: Math.min(1, Math.max(0.01, num(p.kellyF, 0.25))),
    maxKelly: Math.min(1, Math.max(0.01, num(p.maxKelly, 0.05))),
    minLot: Math.max(0.01, num(p.minLot, 0.01)),
    minLotSpread: Math.max(0, num(p.minLotSpread, 0)),
    reverse: !!p.reverse
  };
}

// Решение за вход при дадена вероятност и ATR. Връща позиция или null.
// { buyPct, sellPct } = prob; atr/entry = текущи;
// equity = общ капитал (за рисковото правило); freeMargin = свободен маржин
// (equity − вече заетия маржин) — позицията никога не надхвърля него.
function entryDecision(prob, atr, entry, equity, freeMargin, P, symbol) {
  if (freeMargin == null) freeMargin = equity;
  if (!prob || !(atr > 0) || !(entry > 0) || !(equity > 0)) return null;
  if (!(freeMargin > 0)) return null;
  const buyPct = prob.buyPct, sellPct = prob.sellPct;
  const alpha = P.alpha;

  const tpDist = P.tpMult * alpha * atr;
  const slDist = P.slMult * alpha * atr;
  const gain = tpDist;
  const loss = slDist;
  if (gain <= 0 || loss <= 0) return null;

  const pRise = buyPct / 100, pFall = sellPct / 100;
  const evLong = (pRise * alpha) * gain - (pFall / alpha) * loss;
  const evShort = (pFall * alpha) * gain - (pRise / alpha) * loss;
  const buyPmin = 50 + (P.buyTh - 50) / alpha;
  const sellPmin = 50 + (P.sellTh - 50) / alpha;

  let dir = null;
  if (buyPct >= buyPmin && evLong > P.minEv) dir = 'BUY';
  else if (sellPct >= sellPmin && evShort > P.minEv) dir = 'SELL';
  if (!dir) return null;

  const p = dir === 'BUY' ? pRise : pFall;
  const q = 1 - p;
  const b = gain / loss;
  const fStar = p - q / b;
  if (!(fStar > 0)) return null;

  const f = Math.min(fStar * P.kellyF * alpha, P.maxKelly);
  if (!(f > 0)) return null;

  // Размер по риска (Kelly), ограничен от свободния маржин и ливъриджа.
  const riskAmount = f * equity;
  let units = riskAmount / loss;
  const maxUnits = (freeMargin * P.leverage) / entry;
  units = Math.min(units, maxUnits);
  if (!(units > 0)) return null;

  // Преобразуване в реален обем (лотове) според спецификацията на инструмента.
  // Минималният/стъпковият обем се задава (по подразбиране 0.01 лот).
  const spec = specFor(symbol);
  const minLot = P.minLot || spec.min;
  let lots = Math.floor((units / spec.contract) / minLot + 1e-9) * minLot;
  lots = Math.min(lots, spec.max);
  if (lots < minLot) lots = minLot;
  lots = Math.round(lots * 1e8) / 1e8;
  const finalUnits = lots * spec.contract;
  const notional = finalUnits * entry;
  const margin = notional / P.leverage;
  // Никога не отваряме по-голяма позиция от свободните пари.
  if (!(lots >= minLot && margin > 0 && margin <= freeMargin && notional >= 1)) return null;

  if (P.reverse) dir = dir === 'BUY' ? 'SELL' : 'BUY';

  // Спред за минималния обем: зададената сума (€) отмества реалния вход (BUY
  // нагоре, SELL надолу), т.е. позицията се отваря на реалната цена със спреда
  // и той веднага влиза в рисковите изчисления (плаваща загуба, свободен маржин).
  // Отместване = спред / units  →  плаваща = отместване × units = спред.
  const atMinLot = lots <= minLot + 1e-9;
  const spreadCost = atMinLot ? Math.max(0, P.minLotSpread || 0) : 0;
  const shift = spreadCost > 0 ? spreadCost / finalUnits : 0;
  const fill = dir === 'BUY' ? entry + shift : entry - shift;

  const tp = dir === 'BUY' ? fill + tpDist : fill - tpDist;
  const sl = dir === 'BUY' ? fill - slDist : fill + slDist;
  const probPct = (dir === 'BUY' ? pRise : pFall) * 100;

  return {
    dir, entry: fill, lots, contract: spec.contract, units: finalUnits,
    notional, margin, tp, sl, atr, tpDist, slDist, prob: probPct,
    spreadCost, fillShift: shift
  };
}

// Решение за изход за текущата свещ (TP/SL/време), или null.
// heldBars = брой изминали свещи от отварянето до тази свещ.
function exitDecision(pos, candle, heldBars, P) {
  const held = heldBars;
  let exitPrice = null, reason = null;
  if (pos.dir === 'BUY') {
    if (candle.high >= pos.tp) { exitPrice = pos.tp; reason = 'TP'; }
    else if (candle.low <= pos.sl) { exitPrice = pos.sl; reason = 'SL'; }
    else if (held >= P.holdBars) { exitPrice = candle.close; reason = 'Време'; }
  } else {
    if (candle.low <= pos.tp) { exitPrice = pos.tp; reason = 'TP'; }
    else if (candle.high >= pos.sl) { exitPrice = pos.sl; reason = 'SL'; }
    else if (held >= P.holdBars) { exitPrice = candle.close; reason = 'Време'; }
  }
  if (exitPrice === null) return null;
  const pnl = pos.dir === 'BUY'
    ? (exitPrice - pos.entry) * pos.units
    : (pos.entry - exitPrice) * pos.units;
  return { exitPrice, reason, pnl };
}

// Плаваща печалба на позиция при дадена цена.
function floatingPnl(pos, price) {
  return pos.dir === 'BUY' ? (price - pos.entry) * pos.units : (pos.entry - price) * pos.units;
}

// Крипто инструментите се търгуват 24/7; при тях няма почивка.
function isCrypto(symbol) {
  const s = String(symbol || '').toUpperCase().trim();
  if (/(USDT|USDC|BUSD|FDUSD|TUSD)$/.test(s)) return true;
  return /^(BTC|ETH|SOL)(USD)?$/.test(s);
}

// Пазарът отворен ли е за нови поръчки: крипто — винаги; останалите (индекси,
// форекс, метали, суровини) — само в делнични дни (без събота/неделя).
function marketOpen(symbol, timeSec) {
  if (isCrypto(symbol)) return true;
  const t = (timeSec && isFinite(timeSec)) ? timeSec : Math.floor(Date.now() / 1000);
  const day = new Date(t * 1000).getUTCDay();   // 0 = неделя, 6 = събота
  return day !== 0 && day !== 6;
}

module.exports = { normalizeParams, entryDecision, exitDecision, floatingPnl, isCrypto, marketOpen };
