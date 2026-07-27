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

// --- Cached Logistic Regression ---
let logRegCache = { trainedOn: 0, w: null, means: null, stds: null };
let modelSeqCache = { candlesHash: 0, data: null };

function candlesHash(candles) {
  let h = 0;
  const n = Math.min(candles.length, 20);
  for (let i = candles.length - n; i < candles.length; i++)
    h = ((h << 5) - h + Math.round(candles[i].close * 100)) | 0;
  return h;
}

function trainLogReg(data) {
  const f = 6;
  let w = new Array(f + 1).fill(0);
  const means = new Array(f).fill(0);
  const stds = new Array(f).fill(1);
  for (let j = 0; j < f; j++) {
    let s = 0;
    for (const d of data) s += [d.rsi, d.emaRatio, d.macdV, d.atrNorm, d.adxV, d.volNorm][j];
    means[j] = s / data.length;
    let sq = 0;
    for (const d of data) sq += Math.pow([d.rsi, d.emaRatio, d.macdV, d.atrNorm, d.adxV, d.volNorm][j] - means[j], 2);
    stds[j] = Math.sqrt(sq / data.length) || 1;
  }
  function sig(z) { return 1 / (1 + Math.exp(-Math.max(-15, Math.min(15, z)))); }
  for (let ep = 0; ep < 80; ep++) {
    const g = new Array(f + 1).fill(0);
    for (const d of data) {
      const x = [1, (d.rsi - means[0]) / stds[0], (d.emaRatio - means[1]) / stds[1], (d.macdV - means[2]) / stds[2], (d.atrNorm - means[3]) / stds[3], (d.adxV - means[4]) / stds[4], (d.volNorm - means[5]) / stds[5]];
      let z = 0; for (let j = 0; j <= f; j++) z += w[j] * x[j];
      const p = sig(z);
      const e = p - d.label;
      for (let j = 0; j <= f; j++) g[j] += e * x[j];
    }
    for (let j = 0; j <= f; j++) w[j] -= (0.003 / data.length) * g[j];
  }
  return { w, means, stds };
}

// --- Models ---
function computeHistoricalProbability(candles) {
  let buy = 0, sell = 0;
  for (let i = 0; i < candles.length - 1; i++) {
    if (candles[i + 1].close > candles[i].close) buy++;
    else sell++;
  }
  const total = buy + sell || 1;
  return { buyPct: (buy / total) * 100, sellPct: (sell / total) * 100 };
}

function computeBayesianProbability(candles, rsiVals, ema20, ema50, macdLine, macdSignal, atrVals, adxVals, volVals) {
  const n = candles.length;
  const t = { rsiLow: { a: 0, b: 0 }, rsiHigh: { a: 0, b: 0 }, emaBull: { a: 0, b: 0 }, emaBear: { a: 0, b: 0 }, macdBull: { a: 0, b: 0 }, macdBear: { a: 0, b: 0 }, adxS: { a: 0, b: 0 }, adxW: { a: 0, b: 0 }, atrH: { a: 0, b: 0 }, atrL: { a: 0, b: 0 }, volH: { a: 0, b: 0 }, volL: { a: 0, b: 0 } };
  const mAtr = atrVals.reduce((s, v) => s + v, 0) / atrVals.length;
  const mVol = volVals.reduce((s, v) => s + v, 0) / volVals.length;

  for (let i = 20; i < n - 1; i++) {
    const up = candles[i + 1].close > candles[i].close ? 1 : 0;
    const r = rsiVals[i] || 50;
    if (r < 30) { t.rsiLow.a++; if (up) t.rsiLow.b++; }
    if (r > 70) { t.rsiHigh.a++; if (up) t.rsiHigh.b++; }
    if (ema20[i] > ema50[i]) { t.emaBull.a++; if (up) t.emaBull.b++; }
    if (ema20[i] < ema50[i]) { t.emaBear.a++; if (up) t.emaBear.b++; }
    if (macdLine[i] > macdSignal[i]) { t.macdBull.a++; if (up) t.macdBull.b++; }
    if (macdLine[i] < macdSignal[i]) { t.macdBear.a++; if (up) t.macdBear.b++; }
    if (adxVals[i] > 25) { t.adxS.a++; if (up) t.adxS.b++; }
    if (adxVals[i] < 20) { t.adxW.a++; if (up) t.adxW.b++; }
    if (atrVals[i] > mAtr) { t.atrH.a++; if (up) t.atrH.b++; }
    if (atrVals[i] < mAtr) { t.atrL.a++; if (up) t.atrL.b++; }
    if (volVals[i] > mVol) { t.volH.a++; if (up) t.volH.b++; }
    if (volVals[i] < mVol) { t.volL.a++; if (up) t.volL.b++; }
  }

  const prior = (() => { let b = 0, s = 0; for (let i = 0; i < n - 1; i++) { if (candles[i + 1].close > candles[i].close) b++; else s++; } return b / (b + s || 1); })();
  const last = n - 1;
  const conds = [];
  const lr = rsiVals[last] || 50;
  if (lr < 30) conds.push(t.rsiLow);
  if (lr > 70) conds.push(t.rsiHigh);
  if (ema20[last] > ema50[last]) conds.push(t.emaBull);
  if (ema20[last] < ema50[last]) conds.push(t.emaBear);
  if (macdLine[last] > macdSignal[last]) conds.push(t.macdBull);
  if (macdLine[last] < macdSignal[last]) conds.push(t.macdBear);
  if (adxVals[last] > 25) conds.push(t.adxS);
  if (adxVals[last] < 20) conds.push(t.adxW);
  if (atrVals[last] > mAtr) conds.push(t.atrH);
  if (atrVals[last] < mAtr) conds.push(t.atrL);
  if (volVals[last] > mVol) conds.push(t.volH);
  if (volVals[last] < mVol) conds.push(t.volL);

  let prob = prior;
  if (conds.length > 0) {
    prob = conds.reduce((s, c) => {
      if (c.a > 0) { const pSgB = c.b / c.a; const pSgS = (c.a - c.b) / c.a; const pS = pSgB * prior + pSgS * (1 - prior); return s + (pS > 0 ? (pSgB * prior) / pS : prior); }
      return s + prior;
    }, 0) / conds.length;
  }
  return { buyPct: Math.max(1, Math.min(99, prob * 100)), sellPct: Math.max(1, Math.min(99, (1 - prob) * 100)) };
}

function computeLogisticRegression(candles, rsiVals, ema20, ema50, macdLine, macdSignal, macdHist, atrVals, adxVals, volVals, forceRetrain) {
  if (!logRegCache.w || forceRetrain || Math.abs(candles.length - logRegCache.trainedOn) > 50) {
    const data = [];
    for (let i = 20; i < candles.length - 1; i++) {
      data.push({
        rsi: rsiVals[i] || 50,
        emaRatio: ema20[i] > 0 ? (candles[i].close - ema20[i]) / ema20[i] : 0,
        macdV: macdHist[i] || 0,
        atrNorm: (atrVals[i] || 0) / (candles[i].close || 1),
        adxV: adxVals[i] || 0,
        volNorm: volVals[i] || 0,
        label: candles[i + 1].close > candles[i].close ? 1 : 0
      });
    }
    const trained = trainLogReg(data);
    if (trained) {
      logRegCache = { trainedOn: candles.length, w: trained.w, means: trained.means, stds: trained.stds };
    }
  }

  if (!logRegCache.w) return { buyPct: 50, sellPct: 50 };
  const last = candles.length - 1;
  const x = [1, ((rsiVals[last] || 50) - logRegCache.means[0]) / logRegCache.stds[0],
    ((candles[last].close - ema20[last]) / (ema20[last] || 1) - logRegCache.means[1]) / logRegCache.stds[1],
    ((macdHist[last] || 0) - logRegCache.means[2]) / logRegCache.stds[2],
    (((atrVals[last] || 0) / (candles[last].close || 1)) - logRegCache.means[3]) / logRegCache.stds[3],
    ((adxVals[last] || 0) - logRegCache.means[4]) / logRegCache.stds[4],
    ((volVals[last] || 0) - logRegCache.means[5]) / logRegCache.stds[5]
  ];
  let z = 0; for (let j = 0; j <= 6; j++) z += logRegCache.w[j] * x[j];
  const prob = 1 / (1 + Math.exp(-Math.max(-15, Math.min(15, z))));
  return { buyPct: Math.max(1, Math.min(99, prob * 100)), sellPct: Math.max(1, Math.min(99, (1 - prob) * 100)) };
}

function computeMarkovChain(candles) {
  let bb = 0, bs = 0, sb = 0, ss = 0;
  for (let i = 1; i < candles.length - 1; i++) {
    const bull = candles[i + 1].close > candles[i].close;
    const prevBull = candles[i].close > candles[i - 1].close;
    if (prevBull && bull) bb++;
    else if (prevBull && !bull) bs++;
    else if (!prevBull && bull) sb++;
    else ss++;
  }
  const tB = bb + bs || 1, tS = sb + ss || 1;
  const prob = (candles[candles.length - 1].close > candles[candles.length - 2].close) ? (bb / tB) : (sb / tS);
  return { buyPct: Math.max(1, Math.min(99, prob * 100)), sellPct: Math.max(1, Math.min(99, (1 - prob) * 100)) };
}

function computeExpectedValue(candles) {
  let wins = 0, losses = 0, tp = 0, tl = 0;
  for (let i = 0; i < candles.length - 1; i++) {
    const ch = candles[i + 1].close - candles[i].close;
    if (ch > 0) { wins++; tp += ch; } else { losses++; tl += Math.abs(ch); }
  }
  const t = wins + losses || 1;
  const wr = wins / t;
  const ap = wins > 0 ? tp / wins : 0, al = losses > 0 ? tl / losses : 0;
  const ev = wr * ap - (1 - wr) * al;
  const ratio = Math.max(-1, Math.min(1, ev / (ap + al || 1)));
  const buyPct = 50 + ratio * 40;
  return { buyPct: Math.max(1, Math.min(99, buyPct)), sellPct: Math.max(1, Math.min(99, 100 - buyPct)), ev, winRate: wr * 100, avgProfit: ap, avgLoss: al };
}

function computeAllModels(candles) {
  if (!candles || candles.length < 30) return null;
  const prices = candles.map(c => c.close);
  const rsiVals = typeof computeRSI === 'function' ? computeRSI(candles, 14) : prices.map(() => 50);
  const ema20 = computeEMA(prices, 20);
  const ema50 = computeEMA(prices, 50);
  const macd = computeMACD(prices);
  const atrVals = computeATR(candles, 14);
  const adxR = computeADX(candles, 14);
  const volVals = candles.map(c => c.volume || 0);

  return {
    models: {
      historical: computeHistoricalProbability(candles),
      bayesian: computeBayesianProbability(candles, rsiVals, ema20, ema50, macd.macdLine, macd.signal, atrVals, adxR.adx, volVals),
      logistic: computeLogisticRegression(candles, rsiVals, ema20, ema50, macd.macdLine, macd.signal, macd.histogram, atrVals, adxR.adx, volVals, false),
      markov: computeMarkovChain(candles),
      expectedValue: computeExpectedValue(candles)
    }
  };
}

function computeModelProbSequence(candles, modelIndex) {
  if (!candles || candles.length < 30) return [];
  const h = candlesHash(candles);
  if (modelSeqCache.candlesHash === h && modelSeqCache.data && modelSeqCache.data[modelIndex]) return modelSeqCache.data[modelIndex];

  const n = candles.length;
  const prices = candles.map(c => c.close);
  const allRsi = typeof computeRSI === 'function' ? computeRSI(candles, 14) : prices.map(() => 50);
  const allEma20 = computeEMA(prices, 20);
  const allEma50 = computeEMA(prices, 50);
  const allMacd = computeMACD(prices);
  const allAtr = computeATR(candles, 14);
  const allAdx = computeADX(candles, 14);
  const allVol = candles.map(c => c.volume || 0);

  const results = [[], [], [], [], []];
  for (let i = 30; i < n; i++) {
    const sub = { candles: candles.slice(0, i + 1), rsi: allRsi.slice(0, i + 1), ema20: allEma20.slice(0, i + 1), ema50: allEma50.slice(0, i + 1), macdLine: allMacd.macdLine.slice(0, i + 1), macdSig: allMacd.signal.slice(0, i + 1), macdHist: allMacd.histogram.slice(0, i + 1), atr: allAtr.slice(0, i + 1), adx: allAdx.adx.slice(0, i + 1), vol: allVol.slice(0, i + 1) };
    const t = candles[i].time;
    results[0].push({ time: t, value: computeHistoricalProbability(sub.candles).buyPct });
    if (i % 3 === 0 || i === n - 1) {
      results[1].push({ time: t, value: computeBayesianProbability(sub.candles, sub.rsi, sub.ema20, sub.ema50, sub.macdLine, sub.macdSig, sub.atr, sub.adx, sub.vol).buyPct });
      results[2].push({ time: t, value: computeLogisticRegression(sub.candles, sub.rsi, sub.ema20, sub.ema50, sub.macdLine, sub.macdSig, sub.macdHist, sub.atr, sub.adx, sub.vol, false).buyPct });
    }
    results[3].push({ time: t, value: computeMarkovChain(sub.candles).buyPct });
    results[4].push({ time: t, value: computeExpectedValue(sub.candles).buyPct });
  }
  // Fill gaps for sparse models
  for (let m = 1; m <= 2; m++) {
    for (let i = results[m].length; i < results[0].length; i++)
      results[m].push({ time: results[0][i].time, value: results[m][results[m].length - 1] ? results[m][results[m].length - 1].value : 50 });
  }

  modelSeqCache = { candlesHash: h, data: results };
  return results[modelIndex];
}
