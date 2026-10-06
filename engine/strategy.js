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
// fx = колко EUR е 1 единица от котираната валута (напр. USD→EUR ≈ 0.92).
function entryDecision(prob, atr, entry, equity, freeMargin, P, symbol, fxIn) {
  const fx = (fxIn > 0) ? fxIn : 1;
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
  // € риск за 1 единица при движение loss в цена = loss × fx.
  const spec = specFor(symbol);
  const minLot = P.minLot || spec.min;
  const minSpread = Math.max(0, P.minLotSpread || 0);
  // Разход за 1 единица = маржин + начален спред (за 1 единица спредът е
  // minSpread / (minLot × contract)). Свободният маржин трябва да покрие и двете.
  const perUnitCost = (entry * fx) / P.leverage + minSpread / (minLot * spec.contract);
  const perUnitNotional = entry * fx;
  const riskAmount = f * equity;
  let units = riskAmount / (loss * fx);
  // Размерът се ограничава и от свободния маржин (маржин + спред за 1 единица),
  // и от цената на позицията (нотионал за 1 единица < свободен маржин).
  const maxUnits = perUnitCost > 0
    ? Math.min(freeMargin / perUnitCost, freeMargin / perUnitNotional)
    : 0;
  units = Math.min(units, maxUnits);
  if (!(units > 0)) return null;

  // Преобразуване в реален обем (лотове) според спецификацията на инструмента.
  // Минималният/стъпковият обем се задава (по подразбиране 0.01 лот).
  let lots = Math.floor((units / spec.contract) / minLot + 1e-9) * minLot;
  lots = Math.min(lots, spec.max);
  if (lots < minLot) lots = minLot;
  lots = Math.round(lots * 1e8) / 1e8;
  const finalUnits = lots * spec.contract;

  if (P.reverse) dir = dir === 'BUY' ? 'SELL' : 'BUY';

  // Спред на минимален обем: `minLotSpread` (€) е за ЕДИН минимален обем и е
  // пропорционален на броя минимални обеми. Отмества реалния вход (BUY нагоре,
  // SELL надолу): отместване = спред(€) / (units × fx).
  const spreadCost = minSpread * (lots / minLot);
  const shift = spreadCost > 0 ? spreadCost / (finalUnits * fx) : 0;
  const fill = dir === 'BUY' ? entry + shift : entry - shift;

  // Състоянието на сметката и маржинът се смятат по ЦЕНАТА ЗА ОТВАРЯНЕ `fill`
  // (пазарната цена след обема и спреда).
  const notionalQuote = finalUnits * fill;       // в котираната валута
  const notional = notionalQuote * fx;           // в EUR
  const margin = notional / P.leverage;          // в EUR
  // Нивата (TP/SL) се смятат по ПАЗАРНАТА цена при отваряне.
  const tp = dir === 'BUY' ? entry + tpDist : entry - tpDist;
  const sl = dir === 'BUY' ? entry - slDist : entry + slDist;
  // Загубата до SL от реалния вход (fill) включва и началния спред.
  const riskCost = slDist * finalUnits * fx + spreadCost;
  // Отваряме само ако свободният маржин е над цената ѝ и покрива маржина,
  // началния спред и потенциалната загуба до SL.
  if (!(lots >= minLot && margin > 0 && notional < freeMargin
        && margin + spreadCost <= freeMargin + 1e-9 && riskCost <= freeMargin + 1e-9 && notional >= 1)) return null;

  const probPct = (dir === 'BUY' ? pRise : pFall) * 100;

  return {
    dir, entry: fill, lots, contract: spec.contract, units: finalUnits,
    notional, notionalQuote, margin, tp, sl, atr, tpDist, slDist, prob: probPct,
    spreadCost, fillShift: shift, fx
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
  const fx = (pos.fx > 0) ? pos.fx : 1;
  const pnl = (pos.dir === 'BUY'
    ? (exitPrice - pos.entry) * pos.units
    : (pos.entry - exitPrice) * pos.units) * fx;
  return { exitPrice, reason, pnl };
}

// Плаваща печалба на позиция при дадена цена (в EUR).
function floatingPnl(pos, price) {
  const fx = (pos.fx > 0) ? pos.fx : 1;
  return (pos.dir === 'BUY' ? (price - pos.entry) * pos.units : (pos.entry - price) * pos.units) * fx;
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
