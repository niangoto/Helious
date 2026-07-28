// Technical Indicators
function computeEMA(prices, period) {
  const k = 2 / (period + 1);
  const ema = [prices[0]];
  for (let i = 1; i < prices.length; i++)
    ema.push(prices[i] * k + ema[i - 1] * (1 - k));
  return ema;
}

function computeMACD(prices) {
  const ema12 = computeEMA(prices, 12);
  const ema26 = computeEMA(prices, 26);
  const macdLine = ema12.map((v, i) => v - ema26[i]);
  const signal = computeEMA(macdLine, 9);
  const histogram = macdLine.map((v, i) => v - signal[i]);
  return { macdLine, signal, histogram };
}

function computeATR(candles, period) {
  period = period || 14;
  const tr = [candles[0].high - candles[0].low];
  for (let i = 1; i < candles.length; i++) {
    const hl = candles[i].high - candles[i].low;
    const hc = Math.abs(candles[i].high - candles[i - 1].close);
    const lc = Math.abs(candles[i].low - candles[i - 1].close);
    tr.push(Math.max(hl, hc, lc));
  }
  return computeEMA(tr, period);
}

function computeADX(candles, period) {
  period = period || 14;
  const tr = []; const plusDM = [0]; const minusDM = [0];
  for (let i = 1; i < candles.length; i++) {
    const hl = candles[i].high - candles[i].low;
    const hc = Math.abs(candles[i].high - candles[i - 1].close);
    const lc = Math.abs(candles[i].low - candles[i - 1].close);
    tr.push(Math.max(hl, hc, lc));
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
  }
  const atr = computeEMA(tr, period);
  const pDS = computeEMA(plusDM, period);
  const mDS = computeEMA(minusDM, period);
  const plusDI = []; const minusDI = [];
  for (let i = 0; i < candles.length; i++) {
    const a = atr[i] || 1;
    plusDI.push(100 * (pDS[i] || 0) / a);
    minusDI.push(100 * (mDS[i] || 0) / a);
  }
  const dx = plusDI.map((p, i) => { const d = Math.abs(p - minusDI[i]); const s = p + minusDI[i]; return s > 0 ? 100 * d / s : 0; });
  return { adx: computeEMA(dx, period), plusDI, minusDI };
}

// Build signal bitmask for a candle (13 conditions → 13-bit mask)
function signalMask(i, rsi, ema20, ema50, ema200, macdLine, macdSig, macdHist, atr, adx, vol, meanAtr, meanVol) {
  let mask = 0;
  if (rsi < 30) mask |= 1 << 0;
  if (rsi > 70) mask |= 1 << 1;
  if (ema20 > ema50) mask |= 1 << 2;
  if (ema20 < ema50) mask |= 1 << 3;
  if (macdLine > macdSig) mask |= 1 << 4;
  if (macdLine < macdSig) mask |= 1 << 5;
  if (adx > 25) mask |= 1 << 6;
  if (adx < 20) mask |= 1 << 7;
  if (atr > meanAtr) mask |= 1 << 8;
  if (atr < meanAtr) mask |= 1 << 9;
  if (vol > meanVol) mask |= 1 << 10;
  if (vol < meanVol) mask |= 1 << 11;
  if (macdHist > 0) mask |= 1 << 12;
  return mask;
}

// Simulate trade: entry at close[i], TP = close + 1.5*ATR, SL = close - 1.0*ATR
// Returns: 1 if TP hit first, 0 if SL hit first, -1 if neither within maxBars
function simulateTrade(candles, i, atrVal, maxBars) {
  const entry = candles[i].close;
  const tp = entry + 1.5 * atrVal;
  const sl = entry - 1.0 * atrVal;
  const limit = Math.min(i + maxBars, candles.length);
  for (let j = i + 1; j < limit; j++) {
    if (candles[j].high >= tp) return 1;
    if (candles[j].low <= sl) return 0;
  }
  return -1;
}

// --- Cached statistics ---
let statsCache = { hash: 0, combos: null, histBuyPct: 50, markovMatrix: null, evData: null };

function candlesHash(candles) {
  let h = 0;
  const n = Math.min(candles.length, 50);
  for (let i = candles.length - n; i < candles.length; i++)
    h = ((h << 5) - h + Math.round(candles[i].close * 100)) | 0;
  return h;
}

// Build all statistics from historical data
function buildStats(candles) {
  const n = candles.length;
  if (n < 30) return null;
  const prices = candles.map(c => c.close);
  const rsiV = typeof computeRSI === 'function' ? computeRSI(candles, 14) : prices.map(() => 50);
  const ema20 = computeEMA(prices, 20);
  const ema50 = computeEMA(prices, 50);
  const ema200 = computeEMA(prices, 200);
  const macd = computeMACD(prices);
  const atrV = computeATR(candles, 14);
  const adxR = computeADX(candles, 14);
  const volV = candles.map(c => c.volume || 0);

  const meanAtr = atrV.reduce((s, v) => s + v, 0) / atrV.length;
  const meanVol = volV.reduce((s, v) => s + v, 0) / volV.length;
  const maxBars = Math.min(50, n);

  // Combo stats: mask → { total, wins }
  const combos = new Map();
  let totalWins = 0, totalTrades = 0;

  // Markov: track sequence of trade outcomes
  let prevWin = -1;
  let bb = 0, bs = 0, sb = 0, ss = 0;

  // EV data
  let wins = 0, losses = 0, tpSum = 0, slSum = 0;

  for (let i = 20; i < n - 1; i++) {
    const atr = atrV[i] || atrV[atrV.length - 1] || 1;
    const result = simulateTrade(candles, i, atr, maxBars);
    if (result < 0) continue;

    totalTrades++;
    if (result === 1) totalWins++;

    const mask = signalMask(i, rsiV[i] || 50, ema20[i], ema50[i], ema200[i], macd.macdLine[i], macd.signal[i], macd.histogram[i], atrV[i], adxR.adx[i], volV[i], meanAtr, meanVol);
    if (!combos.has(mask)) combos.set(mask, { total: 0, wins: 0 });
    const c = combos.get(mask);
    c.total++;
    if (result === 1) c.wins++;

    // Markov
    if (prevWin >= 0) {
      if (prevWin === 1 && result === 1) bb++;
      else if (prevWin === 1 && result === 0) bs++;
      else if (prevWin === 0 && result === 1) sb++;
      else if (prevWin === 0 && result === 0) ss++;
    }
    prevWin = result;

    // EV
    if (result === 1) { wins++; tpSum += atr * 1.5; }
    else { losses++; slSum += atr * 1.0; }
  }

  const hTotal = totalTrades || 1;
  const markovMatrix = { bb: bb / (bb + bs || 1), bs: bs / (bb + bs || 1), sb: sb / (sb + ss || 1), ss: ss / (sb + ss || 1) };

  return {
    hash: candlesHash(candles),
    combos,
    histBuyPct: (totalWins / hTotal) * 100,
    markovMatrix,
    prevWin,
    ev: { wins, losses, tpSum, slSum, winRate: wins / (wins + losses || 1) * 100, avgProfit: wins > 0 ? tpSum / wins : 0, avgLoss: losses > 0 ? slSum / losses : 0 }
  };
}

function getStats(candles) {
  const h = candlesHash(candles);
  if (statsCache.hash !== h) {
    statsCache = { hash: 0, combos: null, histBuyPct: 50, markovMatrix: null, evData: null };
    const s = buildStats(candles);
    if (s) statsCache = s;
  }
  return statsCache;
}

// --- Models ---

function computeHistoricalProbability(candles) {
  const s = getStats(candles);
  return { buyPct: s.histBuyPct, sellPct: 100 - s.histBuyPct };
}

function computeCombinationProbability(candles) {
  const s = getStats(candles);
  if (!s.combos || s.combos.size === 0) return { buyPct: s.histBuyPct, sellPct: 100 - s.histBuyPct };

  const prices = candles.map(c => c.close);
  const rsiV = typeof computeRSI === 'function' ? computeRSI(candles, 14) : prices.map(() => 50);
  const ema20 = computeEMA(prices, 20);
  const ema50 = computeEMA(prices, 50);
  const ema200 = computeEMA(prices, 200);
  const macd = computeMACD(prices);
  const atrV = computeATR(candles, 14);
  const adxR = computeADX(candles, 14);
  const volV = candles.map(c => c.volume || 0);
  const meanAtr = atrV.reduce((s, v) => s + v, 0) / atrV.length;
  const meanVol = volV.reduce((s, v) => s + v, 0) / volV.length;

  const last = candles.length - 1;
  const mask = signalMask(last, rsiV[last] || 50, ema20[last], ema50[last], ema200[last], macd.macdLine[last], macd.signal[last], macd.histogram[last], atrV[last], adxR.adx[last], volV[last], meanAtr, meanVol);

  // Find exact match
  if (s.combos.has(mask)) {
    const c = s.combos.get(mask);
    if (c.total > 0) {
      const buyPct = (c.wins / c.total) * 100;
      return { buyPct: Math.max(1, Math.min(99, buyPct)), sellPct: Math.max(1, Math.min(99, 100 - buyPct)) };
    }
  }

  // No exact match: fall back to historical
  return { buyPct: s.histBuyPct, sellPct: 100 - s.histBuyPct };
}

function computeMarkovChain(candles) {
  const s = getStats(candles);
  if (!s.markovMatrix) return { buyPct: s.histBuyPct, sellPct: 100 - s.histBuyPct };
  const prob = s.prevWin === 1 ? s.markovMatrix.bb : s.markovMatrix.sb;
  return { buyPct: Math.max(1, Math.min(99, prob * 100)), sellPct: Math.max(1, Math.min(99, (1 - prob) * 100)) };
}

function computeExpectedValue(candles) {
  const s = getStats(candles);
  if (!s.ev) return { buyPct: 50, sellPct: 50, ev: 0, winRate: 50, avgProfit: 0, avgLoss: 0 };
  const ev = s.ev;
  const buyPct = 50 + (ev.winRate - 50) * 0.5; // map win rate toward probability
  return {
    buyPct: Math.max(1, Math.min(99, buyPct)),
    sellPct: Math.max(1, Math.min(99, 100 - buyPct)),
    ev: (ev.winRate / 100) * ev.avgProfit - (1 - ev.winRate / 100) * ev.avgLoss,
    winRate: ev.winRate,
    avgProfit: ev.avgProfit,
    avgLoss: ev.avgLoss
  };
}

function computeAllModels(candles) {
  if (!candles || candles.length < 30) return null;
  const prices = candles.map(c => c.close);
  const hist = computeHistoricalProbability(candles);
  return {
    models: {
      historical: hist,
      bayesian: computeCombinationProbability(candles),
      logistic: computeCombinationProbability(candles),
      markov: computeMarkovChain(candles),
      expectedValue: computeExpectedValue(candles),
      wavelet: computeWaveletProbability(prices)
    }
  };
}

function computeModelProbSequence(candles, modelIndex) {
  if (!candles || candles.length < 30) return [];
  const result = [];
  const n = candles.length;
  const step = Math.max(1, Math.floor(n / 200)); // sample ~200 points

  // Pre-compute all indicators once
  const prices = candles.map(c => c.close);
  const rsiV = typeof computeRSI === 'function' ? computeRSI(candles, 14) : prices.map(() => 50);
  const ema20 = computeEMA(prices, 20);
  const ema50 = computeEMA(prices, 50);
  const ema200 = computeEMA(prices, 200);
  const macd = computeMACD(prices);
  const atrV = computeATR(candles, 14);
  const adxR = computeADX(candles, 14);
  const volV = candles.map(c => c.volume || 0);
  const meanAtr = atrV.reduce((s, v) => s + v, 0) / atrV.length;
  const meanVol = volV.reduce((s, v) => s + v, 0) / volV.length;
  const maxBars = Math.min(50, n);

  // Build combo stats progressively
  const combos = new Map();
  let totalWins = 0, totalTrades = 0;
  let bb = 0, bs = 0, sb = 0, ss = 0;
  let prevWin = -1;
  let wins = 0, losses = 0, tpSum = 0, slSum = 0;

  for (let i = 30; i < n - 1; i++) {
    const atr = atrV[i] || 1;
    const tradeResult = simulateTrade(candles, i, atr, maxBars);
    if (tradeResult < 0) continue;

    totalTrades++;
    if (tradeResult === 1) totalWins++;

    const mask = signalMask(i, rsiV[i] || 50, ema20[i], ema50[i], ema200[i], macd.macdLine[i], macd.signal[i], macd.histogram[i], atrV[i], adxR.adx[i], volV[i], meanAtr, meanVol);
    if (!combos.has(mask)) combos.set(mask, { total: 0, wins: 0 });
    const c = combos.get(mask);
    c.total++;
    if (tradeResult === 1) c.wins++;

    if (prevWin >= 0) {
      if (prevWin === 1 && tradeResult === 1) bb++;
      else if (prevWin === 1 && tradeResult === 0) bs++;
      else if (prevWin === 0 && tradeResult === 1) sb++;
      else if (prevWin === 0 && tradeResult === 0) ss++;
    }
    prevWin = tradeResult;
    if (tradeResult === 1) { wins++; tpSum += atr * 1.5; }
    else { losses++; slSum += atr * 1.0; }

    // Record at sampled points
    if (i % step === 0 || i === n - 2) {
      const t = candles[i].time;
      const hPct = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 50;

      if (modelIndex === 0) { // Historical
        result.push({ time: t, value: hPct });
      } else if (modelIndex === 1 || modelIndex === 2) { // Combination (Bayesian/Logistic)
        const tMask = signalMask(i, rsiV[i] || 50, ema20[i], ema50[i], ema200[i], macd.macdLine[i], macd.signal[i], macd.histogram[i], atrV[i], adxR.adx[i], volV[i], meanAtr, meanVol);
        let val = hPct;
        if (combos.has(tMask)) { const cc = combos.get(tMask); if (cc.total > 0) val = (cc.wins / cc.total) * 100; }
        result.push({ time: t, value: val });
      } else if (modelIndex === 3) { // Markov
        const p = prevWin === 1 ? (bb / (bb + bs || 1)) : (sb / (sb + ss || 1));
        result.push({ time: t, value: p * 100 });
      } else if (modelIndex === 4) { // EV
        const wr = wins / (wins + losses || 1);
        result.push({ time: t, value: 50 + (wr - 0.5) * 40 });
      } else if (modelIndex === 5) { // Wavelet
        const subPrices = prices.slice(0, i + 1);
        const w = computeWaveletProbability(subPrices);
        result.push({ time: t, value: w.buyPct });
      }
    }
  }
  return result;
}

// --- Wavelet Transform (Haar) ---
function haarWaveletDecompose(data) {
  const n = data.length;
  if (n < 2) return { approx: data, details: [] };
  const half = Math.floor(n / 2);
  const approx = new Array(half);
  const details = new Array(half);
  for (let i = 0; i < half; i++) {
    const a = data[i * 2];
    const b = data[i * 2 + 1];
    approx[i] = (a + b) / 2;
    details[i] = (a - b) / 2;
  }
  return { approx, details };
}

function haarWaveletMultiLevel(prices, levels) {
  levels = levels || 3;
  let current = prices;
  const allDetails = [];
  for (let level = 0; level < levels; level++) {
    const result = haarWaveletDecompose(current);
    allDetails.push(result.details);
    current = result.approx;
    if (current.length < 2) break;
  }
  return { finalApprox: current, allDetails };
}

function computeWaveletProbability(prices) {
  if (prices.length < 8) return { buyPct: 50, sellPct: 50 };
  const result = haarWaveletMultiLevel(prices, 4);
  const details = result.allDetails;
  let signal = 0, totalWeight = 0;
  for (let level = 0; level < details.length; level++) {
    const weight = Math.pow(2, -level);
    totalWeight += weight * details[level].length;
    for (const d of details[level]) {
      const normalized = Math.max(-1, Math.min(1, d / (prices[prices.length - 1] * 0.01)));
      signal += normalized * weight;
    }
  }
  const avgSignal = totalWeight > 0 ? signal / totalWeight : 0;
  const buyPct = 50 + Math.max(-40, Math.min(40, avgSignal * 200));
  return { buyPct: Math.max(1, Math.min(99, buyPct)), sellPct: Math.max(1, Math.min(99, 100 - buyPct)) };
}
