// Чиста стратегия (вход/изход/размер) — огледало на логиката в hermes.html.
// Ползва се от MT5 сесията. Без DOM/мрежа — само математика.


// Нормализира параметрите като readParams() в hermes.html.
function normalizeParams(p) {
  p = p || {};
  const num = (v, d) => (isFinite(parseFloat(v)) ? parseFloat(v) : d);
  return {
    budget: Math.max(0, num(p.budget, 0)),   // 0 = риск върху целия капитал; >0 = таван на капитала за оразмеряване
    leverage: Math.max(1, num(p.leverage, 1)),
    alpha: Math.min(10, Math.max(0.1, num(p.alpha, 1.0))),
    buyTh: num(p.buyTh, 75),
    sellTh: num(p.sellTh, 75),
    minEv: num(p.minEv, 0),
    tpMult: num(p.tpMult, 2),
    slMult: num(p.slMult, 1.0),
    holdBars: Math.max(1, parseInt(p.holdBars, 10) || 200),
    kellyF: Math.min(1, Math.max(0.01, num(p.kellyF, 0.25))),
    maxKelly: Math.min(1, Math.max(0.01, num(p.maxKelly, 0.05))),
    maxSpreadFrac: Math.min(1, Math.max(0, num(p.maxSpreadFrac, 0.5))), // макс. спред като дял от по-близкото ниво (TP/SL); 0 = без проверка
    skipNegSwap: !!p.skipNegSwap,                                       // не отваряй, ако суапът за посоката е отрицателен
    maxPositions: Math.max(1, parseInt(p.maxPositions, 10) || 5),
    lookback: Math.min(5000, Math.max(100, parseInt(p.lookback, 10) || 2000)), // свещи назад за модела/ATR
    pctClose: !!p.pctClose,                                  // процентно затваряне (вероятност срещу позицията)
    pctCloseLimit: Math.max(0, num(p.pctCloseLimit, 0)),     // лимит на очакваната загуба; 0 = загубата до SL
    reverse: !!p.reverse
  };
}

// Решение за вход при дадена вероятност и ATR. Връща позиция или null.
// { buyPct, sellPct } = prob; atr/entry = текущи;
// equity = общ капитал (за рисковото правило); freeMargin = свободен маржин
// (equity − вече заетия маржин) — позицията никога не надхвърля него.
// fx = колко EUR е 1 единица от котираната валута (напр. USD→EUR ≈ 0.92).
function entryDecision(prob, atr, entry, equity, freeMargin, P, symbol, fxIn, spec, why) {
  // `why` (по избор) — обект, в който се записва причината за отказ: why.reason (текст).
  const no = (text) => { if (why) why.reason = text; return null; };
  const n2 = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2));
  const fx = (fxIn > 0) ? fxIn : 1;
  if (freeMargin == null) freeMargin = equity;
  if (!prob) return no('Няма изчислена вероятност');
  if (!(atr > 0)) return no('ATR не може да се изчисли (малко свещи)');
  if (!(entry > 0)) return no('Няма цена');
  if (!(equity > 0)) return no('Капиталът е 0 — няма от какво да се смята риск');
  if (!(freeMargin > 0)) return no('Няма свободен маржин в сметката');
  const buyPct = prob.buyPct, sellPct = prob.sellPct;
  const alpha = P.alpha;

  const tpDist = P.tpMult * alpha * atr;
  const slDist = P.slMult * alpha * atr;
  const gain = tpDist;
  const loss = slDist;
  if (gain <= 0 || loss <= 0) return no('TP/SL множителите дават 0');

  const pRise = buyPct / 100, pFall = sellPct / 100;
  const evLong = (pRise * alpha) * gain - (pFall / alpha) * loss;
  const evShort = (pFall * alpha) * gain - (pRise / alpha) * loss;
  const buyPmin = 50 + (P.buyTh - 50) / alpha;
  const sellPmin = 50 + (P.sellTh - 50) / alpha;

  let dir = null;
  if (buyPct >= buyPmin && evLong > P.minEv) dir = 'BUY';
  else if (sellPct >= sellPmin && evShort > P.minEv) dir = 'SELL';
  if (!dir) {
    return no('Сигналът е слаб — рискът не е причина: Buy ' + buyPct.toFixed(1) + '% / Sell ' + sellPct.toFixed(1) +
      '%, нужни ≥ ' + buyPmin.toFixed(1) + '% / ' + sellPmin.toFixed(1) + '%' +
      (P.minEv > 0 ? ' и EV > ' + P.minEv : ''));
  }

  const p = dir === 'BUY' ? pRise : pFall;
  const q = 1 - p;
  const b = gain / loss;
  const fStar = p - q / b;
  if (!(fStar > 0)) return no('Сигналът ' + dir + ' има праг, но Кели ≤ 0 при R:R ' + b.toFixed(2) + ' — няма преимущество');

  const f = Math.min(fStar * P.kellyF * alpha, P.maxKelly);
  if (!(f > 0)) return no('Кели дава риск 0');

  if (!spec || !(spec.contract > 0)) return no('Няма спецификация на символа от MT5');
  const minLot = spec.min;
  const perUnitMargin = spec.marginPerUnit > 0 ? spec.marginPerUnit : (entry * fx);
  const riskAmount = f * equity;
  let units = riskAmount / (loss * fx);
  const maxUnits = perUnitMargin > 0 ? freeMargin / perUnitMargin : 0;
  units = Math.min(units, maxUnits);
  if (!(units > 0)) return no('Свободният маржин не стига за позиция');

  let lots = Math.floor((units / spec.contract) / spec.step + 1e-9) * spec.step;
  lots = Math.min(lots, spec.max);
  let forcedMin = false;
  if (lots < minLot) { lots = minLot; forcedMin = true; }
  lots = Math.round(lots * 1e8) / 1e8;
  const finalUnits = lots * spec.contract;

  if (P.reverse) dir = dir === 'BUY' ? 'SELL' : 'BUY';

  const spread = Math.max(0, spec.spread || 0);
  const nearest = Math.min(tpDist, slDist);
  if (P.maxSpreadFrac > 0 && spread > P.maxSpreadFrac * nearest) {
    return no('Спредът е твърде голям: ' + spread.toPrecision(3) + ' > ' + Math.round(P.maxSpreadFrac * 100) + '% от по-близкото ниво (' + nearest.toPrecision(3) + ')');
  }
  const spreadCost = spread * finalUnits * fx;

  const notionalQuote = finalUnits * entry;
  const notional = notionalQuote * fx;
  const margin = perUnitMargin * finalUnits;
  const tp = dir === 'BUY' ? entry + tpDist : entry - tpDist;
  const sl = dir === 'BUY' ? entry - slDist : entry + slDist;
  const riskCost = slDist * finalUnits * fx;
  if (!(margin > 0)) return no('Маржинът не може да се изчисли');
  if (margin > freeMargin + 1e-9) {
    return no('Маржинът за ' + lots + ' лота (' + n2(margin) + ') е над свободния (' + n2(freeMargin) + ')' + (forcedMin ? ' — даже минималният обем не се побира' : ''));
  }
  if (riskCost > freeMargin + 1e-9) {
    return no('Рискът до SL при ' + lots + ' лота (' + n2(riskCost) + ') е над свободния маржин (' + n2(freeMargin) + ')' + (forcedMin ? ' — минималният обем е по-голям от допустимия риск' : ''));
  }

  const probPct = (dir === 'BUY' ? pRise : pFall) * 100;

  return {
    dir, entry, lots, contract: spec.contract, units: finalUnits,
    notional, notionalQuote, margin, tp, sl, atr, tpDist, slDist, prob: probPct,
    spreadCost, fillShift: 0, fx, forcedMin, riskCost, riskAllowed: riskAmount
  };
}

// Решение за изход за текущата свещ (TP/SL/време), или null.
// heldBars = брой изминали свещи от отварянето до тази свещ.
function exitDecision(pos, candle, heldBars, P) {
  const held = heldBars;
  let exitPrice = null, reason = null;
  // Песимистично: ако барът покрие и TP, и SL, приемаме SL.
  if (pos.dir === 'BUY') {
    if (candle.low <= pos.sl) { exitPrice = pos.sl; reason = 'SL'; }
    else if (candle.high >= pos.tp) { exitPrice = pos.tp; reason = 'TP'; }
    else if (held >= P.holdBars) { exitPrice = candle.close; reason = 'Време'; }
  } else {
    if (candle.high >= pos.sl) { exitPrice = pos.sl; reason = 'SL'; }
    else if (candle.low <= pos.tp) { exitPrice = pos.tp; reason = 'TP'; }
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

module.exports = { normalizeParams, entryDecision, exitDecision, floatingPnl };
