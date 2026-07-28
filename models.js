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
  const combos = new Map();
  let totalWins = 0, totalTrades = 0;
  let prevWin = -1;
  let bb = 0, bs = 0, sb = 0, ss = 0;
  let wins = 0, losses = 0, tpSum = 0, slSum = 0;
  for (let i = 20; i < n - 1; i++) {
    const atr = atrV[i] || atrV[atrV.length - 1] || 1;
    const result = simulateTrade(candles, i, atr, maxBars);
    if (result < 0) continue;
    totalTrades++;
    if (result === 1) totalWins++;
    const mask = signalMask(i, rsiV[i] || 50, ema20[i], ema50[i], ema200[i], macd.macdLine[i], macd.signal[i], macd.histogram[i], atrV[i], adxR.adx[i], volV[i], meanAtr, meanVol);
    if (!combos.has(mask)) combos.set(mask, { total: 0, wins: 0 });
    const c = combos.get(mask); c.total++;
    if (result === 1) c.wins++;
    if (prevWin >= 0) {
      if (prevWin === 1 && result === 1) bb++;
      else if (prevWin === 1 && result === 0) bs++;
      else if (prevWin === 0 && result === 1) sb++;
      else if (prevWin === 0 && result === 0) ss++;
    }
    prevWin = result;
    if (result === 1) { wins++; tpSum += atr * 1.5; } else { losses++; slSum += atr * 1.0; }
  }
  const hTotal = totalTrades || 1;
  return {
    hash: candlesHash(candles), combos, histBuyPct: (totalWins / hTotal) * 100,
    markovMatrix: { bb: bb / (bb + bs || 1), bs: bs / (bb + bs || 1), sb: sb / (sb + ss || 1), ss: ss / (sb + ss || 1) },
    prevWin,
    ev: { wins, losses, tpSum, slSum, winRate: wins / (wins + losses || 1) * 100, avgProfit: wins > 0 ? tpSum / wins : 0, avgLoss: losses > 0 ? slSum / losses : 0 }
  };
}

function getStats(candles) {
  const h = candlesHash(candles);
  if (statsCache.hash !== h) {
    statsCache = { hash: 0, combos: null, histBuyPct: 50, markovMatrix: null, evData: null };
    const s = buildStats(candles); if (s) statsCache = s;
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
  if (s.combos.has(mask)) { const c = s.combos.get(mask); if (c.total > 0) return { buyPct: Math.max(1, Math.min(99, (c.wins / c.total) * 100)), sellPct: Math.max(1, Math.min(99, 100 - (c.wins / c.total) * 100)) }; }
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
  const buyPct = 50 + (ev.winRate - 50) * 0.5;
  return { buyPct: Math.max(1, Math.min(99, buyPct)), sellPct: Math.max(1, Math.min(99, 100 - buyPct)), ev: (ev.winRate / 100) * ev.avgProfit - (1 - ev.winRate / 100) * ev.avgLoss, winRate: ev.winRate, avgProfit: ev.avgProfit, avgLoss: ev.avgLoss };
}

function computeAllModels(candles) {
  if (!candles || candles.length < 30) return null;
  const prices = candles.map(c => c.close);
  const hist = computeHistoricalProbability(candles);
  return { models: { historical: hist, bayesian: computeCombinationProbability(candles), logistic: computeCombinationProbability(candles), markov: computeMarkovChain(candles), expectedValue: computeExpectedValue(candles), wavelet: computeWaveletProbability(prices) } };
}

function computeModelProbSequence(candles, modelIndex) {
  if (!candles || candles.length < 30) return [];
  const result = []; const n = candles.length;
  const step = Math.max(1, Math.floor(n / 200));
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
  const combos = new Map();
  let totalWins = 0, totalTrades = 0, bb = 0, bs = 0, sb = 0, ss = 0, prevWin = -1, wins = 0, losses = 0, tpSum = 0, slSum = 0;
  for (let i = 30; i < n - 1; i++) {
    const atr = atrV[i] || 1;
    const tradeResult = simulateTrade(candles, i, atr, maxBars);
    if (tradeResult < 0) continue;
    totalTrades++; if (tradeResult === 1) totalWins++;
    const mask = signalMask(i, rsiV[i] || 50, ema20[i], ema50[i], ema200[i], macd.macdLine[i], macd.signal[i], macd.histogram[i], atrV[i], adxR.adx[i], volV[i], meanAtr, meanVol);
    if (!combos.has(mask)) combos.set(mask, { total: 0, wins: 0 });
    const c = combos.get(mask); c.total++; if (tradeResult === 1) c.wins++;
    if (prevWin >= 0) { if (prevWin === 1 && tradeResult === 1) bb++; else if (prevWin === 1 && tradeResult === 0) bs++; else if (prevWin === 0 && tradeResult === 1) sb++; else if (prevWin === 0 && tradeResult === 0) ss++; }
    prevWin = tradeResult;
    if (tradeResult === 1) { wins++; tpSum += atr * 1.5; } else { losses++; slSum += atr * 1.0; }
    if (i % step === 0 || i === n - 2) {
      const t = candles[i].time;
      const hPct = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 50;
      if (modelIndex === 0) result.push({ time: t, value: hPct });
      else if (modelIndex === 1 || modelIndex === 2) { const tMask = mask; let val = hPct; if (combos.has(tMask)) { const cc = combos.get(tMask); if (cc.total > 0) val = (cc.wins / cc.total) * 100; } result.push({ time: t, value: val }); }
      else if (modelIndex === 3) { const p = prevWin === 1 ? (bb / (bb + bs || 1)) : (sb / (sb + ss || 1)); result.push({ time: t, value: p * 100 }); }
      else if (modelIndex === 4) { const wr = wins / (wins + losses || 1); result.push({ time: t, value: 50 + (wr - 0.5) * 40 }); }
      else if (modelIndex === 5) { const w = computeWaveletProbability(prices.slice(0, i + 1)); result.push({ time: t, value: w.buyPct }); }
    }
  }
  return result;
}

// ════════════════════════════════════════════════════════════════
//  Professional Wavelet Analysis — Daubechies 4 (db4)
//  Multi-Resolution Analysis (MRA) + Soft Thresholding Denoising
// ════════════════════════════════════════════════════════════════

// Db4 filter coefficients (scaling / low-pass)
const DB4_LO = [0.4829629131445341, 0.8365163037378077, 0.2241438680420134, -0.1294095225512603];
// Db4 wavelet coefficients (high-pass) — quadrature mirror of LO
const DB4_HI = [-0.1294095225512603, -0.2241438680420134, 0.8365163037378077, -0.4829629131445341];

// Single-level Db4 decomposition using convolution + downsampling
// Periodic extension at boundaries preserves signal length compatibility
function db4Decompose(signal) {
  const n = signal.length;
  if (n < 4) return { approx: signal, details: [] };
  const half = Math.ceil(n / 2);
  const approx = new Array(half);
  const details = new Array(half);
  const ext = 4; // filter length

  for (let i = 0; i < half; i++) {
    let a = 0, d = 0;
    for (let k = 0; k < ext; k++) {
      const idx = (2 * i + k) % n; // periodic extension
      a += signal[idx] * DB4_LO[k];
      d += signal[idx] * DB4_HI[k];
    }
    approx[i] = a;
    details[i] = d;
  }
  return { approx, details };
}

// Multi-level MRA: decomposes signal into L levels
// Returns: approximations A0..AL (trend) and details D1..DL (cycles/noise)
function mraDecompose(prices, levels) {
  levels = levels || 4;
  const approximations = [prices];
  const allDetails = [];
  let current = prices;
  for (let level = 0; level < levels; level++) {
    const { approx, details } = db4Decompose(current);
    approximations.push(approx);
    allDetails.push(details);
    current = approx;
    if (approx.length < 4) break;
  }
  return { approximations, allDetails };
}

// Soft thresholding: shrinks coefficients toward zero
// Removes noise (small coefficients) while preserving strong signal
function softThreshold(details, threshold) {
  return details.map(d => {
    const abs = Math.abs(d);
    if (abs <= threshold) return 0;
    return Math.sign(d) * (abs - threshold);
  });
}

// Reconstruct a single level from approx + details using Db4 synthesis
function db4Reconstruct(approx, details) {
  const n = approx.length + details.length; // approximate original length
  const signal = new Array(n).fill(0);
  for (let i = 0; i < approx.length; i++) {
    const idx = 2 * i;
    if (idx < n) signal[idx] += approx[i] * DB4_LO[0] + details[i] * DB4_HI[0];
    if (idx + 1 < n) signal[idx + 1] += approx[i] * DB4_LO[1] + details[i] * DB4_HI[1];
    if (idx - 1 >= 0) signal[idx - 1] += approx[i] * DB4_LO[2] + details[i] * DB4_HI[2];
    if (idx - 2 >= 0) signal[idx - 2] += approx[i] * DB4_LO[3] + details[i] * DB4_HI[3];
  }
  return signal;
}

// Compute buy/sell probability using MRA energy analysis
// 1. Decompose price into levels
// 2. Soft-threshold details to remove noise
// 3. Compare energy of recent details (dominant cycle) with trend direction
// 4. Strong upward trend + positive cycle energy → buy bias
// 5. Strong downward trend + negative cycle energy → sell bias
function computeWaveletProbability(prices) {
  if (prices.length < 16) return { buyPct: 50, sellPct: 50 };

  const levels = Math.min(4, Math.floor(Math.log2(prices.length)) - 1);
  const { approximations, allDetails } = mraDecompose(prices, levels);
  if (allDetails.length === 0) return { buyPct: 50, sellPct: 50 };

  // Estimate noise level as median absolute deviation of finest details
  const finest = allDetails[0];
  const sorted = [...finest].map(Math.abs).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 0;
  const threshold = median * 1.4826 * Math.sqrt(2 * Math.log(finest.length)); // universal threshold

  // Soft-threshold all levels
  const denoisedDetails = allDetails.map(d => softThreshold(d, threshold));

  // Get trend from final approximation (lowest frequency)
  const trend = approximations[approximations.length - 1];
  const trendDirection = trend.length > 1 ? trend[trend.length - 1] - trend[0] : 0;

  // Compute energy (sum of squares) of each denoised detail level
  // Higher energy at D3/D4 often corresponds to dominant market cycles
  let cycleEnergy = 0;
  let cycleSignal = 0;

  for (let level = 0; level < denoisedDetails.length; level++) {
    const dd = denoisedDetails[level];
    const energy = dd.reduce((s, v) => s + v * v, 0);
    const levelWeight = Math.pow(2, level); // higher levels = longer cycles

    // Look at last few coefficients in each level for recent signal
    const recentCount = Math.min(4, dd.length);
    let recentSum = 0;
    for (let i = dd.length - recentCount; i < dd.length; i++)
      recentSum += dd[i] || 0;

    cycleEnergy += energy * levelWeight;
    cycleSignal += recentSum * levelWeight;
  }

  // Normalize by price level
  const currentPrice = prices[prices.length - 1];
  const normalizedSignal = cycleSignal / (currentPrice * 0.01) || 0;
  const totalEnergy = cycleEnergy || 1;
  const normalizedEnergy = Math.min(1, cycleEnergy / (currentPrice * currentPrice * 0.0001 * prices.length));

  // Combine trend direction (-1..1) with cycle signal (-1..1)
  const trendNorm = Math.max(-1, Math.min(1, trendDirection / (currentPrice * 0.02)));
  const cycleNorm = Math.max(-1, Math.min(1, normalizedSignal * 0.1));
  const combined = trendNorm * 0.6 + cycleNorm * 0.4;

  // Market regime: high energy = high volatility = trend-following
  // Low energy = low volatility = mean-reverting
  const isTrending = normalizedEnergy > 0.3;

  let buyPct;
  if (isTrending) {
    // Trending market: follow the trend
    buyPct = 50 + combined * 40;
  } else {
    // Sideways market: mean-revert (weakened signal)
    buyPct = 50 + combined * 20;
  }

  return { buyPct: Math.max(1, Math.min(99, buyPct)), sellPct: Math.max(1, Math.min(99, 100 - buyPct)) };
}

// Public: get the denoised trend and dominant cycle phase for forecast.js
function getWaveletForecastData(prices, forecastSteps) {
  if (prices.length < 16) return null;

  const levels = Math.min(4, Math.floor(Math.log2(prices.length)) - 1);
  const { approximations, allDetails } = mraDecompose(prices, levels);
  if (allDetails.length === 0) return null;

  // Soft threshold
  const finest = allDetails[0];
  const sorted = [...finest].map(Math.abs).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 0;
  const threshold = median * 1.4826 * Math.sqrt(2 * Math.log(finest.length));
  const denoised = allDetails.map(d => softThreshold(d, threshold));

  // Get trend (final approximation) — this is the low-frequency signal
  const trend = approximations[approximations.length - 1];

  // Find dominant cycle by finding the level with highest energy
  let maxEnergy = 0;
  let dominantLevel = 0;
  for (let i = 0; i < denoised.length; i++) {
    const e = denoised[i].reduce((s, v) => s + v * v, 0);
    if (e > maxEnergy) { maxEnergy = e; dominantLevel = i; }
  }

  // Extract cycle from dominant level
  const dominantCycle = denoised[dominantLevel];
  const cycleLength = Math.max(2, dominantCycle.length);

  // Compute phase and amplitude of dominant cycle from last few coefficients
  const lastFew = dominantCycle.slice(-Math.min(8, dominantCycle.length));
  const cycleAmp = lastFew.reduce((s, v) => Math.max(s, Math.abs(v)), 0) || 1;

  // Determine cycle phase (mean of sign of last 3 coefficients)
  const phase3 = dominantCycle.slice(-3);
  const phaseMean = phase3.reduce((s, v) => s + Math.sign(v), 0) / phase3.length || 0;

  // Trend extrapolation: simple linear projection of the last 3 trend values
  const tLen = trend.length;
  const t0 = trend[tLen - 3] || trend[tLen - 1];
  const t1 = trend[tLen - 2] || trend[tLen - 1];
  const t2 = trend[tLen - 1];
  const trendSlope = tLen >= 3 ? ((t2 - t1) + (t1 - t0)) / 2 : (t2 - (trend[tLen - 2] || t2));

  return {
    lastPrice: prices[prices.length - 1],
    trendSlope,
    cycleAmp: cycleAmp * 3, // scale for forecast oscillation
    cyclePhase: phaseMean,
    dominantLevel
  };
}
