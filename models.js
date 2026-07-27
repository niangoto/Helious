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
  const tr = [];
  const plusDM = [0];
  const minusDM = [0];
  for (let i = 1; i < candles.length; i++) {
    const hl = candles[i].high - candles[i].low;
    const hc = Math.abs(candles[i].high - candles[i - 1].close);
    const lc = Math.abs(candles[i].low - candles[i - 1].close);
    tr.push(Math.max(hl, hc, lc));
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }
  const atr = computeEMA(tr, period);
  const pDMSmooth = computeEMA(plusDM, period);
  const mDMSmooth = computeEMA(minusDM, period);
  const plusDI = []; const minusDI = [];
  for (let i = 0; i < candles.length; i++) {
    const a = atr[i] || 1;
    plusDI.push(100 * (pDMSmooth[i] || 0) / a);
    minusDI.push(100 * (mDMSmooth[i] || 0) / a);
  }
  const dx = plusDI.map((p, i) => {
    const diff = Math.abs(p - minusDI[i]);
    const sum = p + minusDI[i];
    return sum > 0 ? 100 * diff / sum : 0;
  });
  const adx = computeEMA(dx, period);
  return { adx, plusDI, minusDI };
}

// Build training dataset: for each candle i, record indicators + whether next close > current close
function buildTrainingData(candles, rsiVals, ema20, ema50, macdLine, macdSignal, macdHist, atrVals, adxVals, volVals) {
  const data = [];
  const n = candles.length;
  for (let i = 20; i < n - 1; i++) {
    const nextUp = candles[i + 1].close > candles[i].close ? 1 : 0;
    const rsi = rsiVals[i] || 50;
    const emaRatio = ema20[i] > 0 ? (candles[i].close - ema20[i]) / ema20[i] : 0;
    const macdV = macdHist[i] || 0;
    const atrV = atrVals[i] || 0;
    const atrNorm = candles[i].close > 0 ? atrV / candles[i].close : 0;
    const adxV = adxVals[i] || 0;
    const volNorm = volVals[i] || 0;
    data.push({ rsi, emaRatio, macdV, atrNorm, adxV, volNorm, label: nextUp });
  }
  return data;
}

// --- Model 1: Historical Probability ---
// P(BUY) = count(Close[next] > Close[current]) / total
function computeHistoricalProbability(candles) {
  let buy = 0, sell = 0;
  for (let i = 0; i < candles.length - 1; i++) {
    if (candles[i + 1].close > candles[i].close) buy++;
    else sell++;
  }
  const total = buy + sell || 1;
  return { buyPct: (buy / total) * 100, sellPct: (sell / total) * 100 };
}

// --- Model 2: Bayesian Probability ---
// Build frequency tables from data. For each condition, count next candle up/down.
function computeBayesianProbability(candles, rsiVals, ema20, ema50, macdLine, macdSignal, atrVals, adxVals, volVals, histBuyPct) {
  const n = candles.length;
  // Frequency tables: { condition: { total, buy, sell } }
  const tables = {
    rsiLow: { total: 0, buy: 0 },
    rsiHigh: { total: 0, buy: 0 },
    emaBull: { total: 0, buy: 0 },
    emaBear: { total: 0, buy: 0 },
    macdBull: { total: 0, buy: 0 },
    macdBear: { total: 0, buy: 0 },
    adxStrong: { total: 0, buy: 0 },
    adxWeak: { total: 0, buy: 0 },
    atrHigh: { total: 0, buy: 0 },
    atrLow: { total: 0, buy: 0 },
    volHigh: { total: 0, buy: 0 },
    volLow: { total: 0, buy: 0 }
  };

  const meanAtr = atrVals.reduce((a, b) => a + b, 0) / atrVals.length;
  const meanVol = volVals.reduce((a, b) => a + b, 0) / volVals.length;

  for (let i = 20; i < n - 1; i++) {
    const nextUp = candles[i + 1].close > candles[i].close ? 1 : 0;
    const rsi = rsiVals[i] || 50;
    if (rsi < 30) { tables.rsiLow.total++; if (nextUp) tables.rsiLow.buy++; }
    if (rsi > 70) { tables.rsiHigh.total++; if (nextUp) tables.rsiHigh.buy++; }
    if (ema20[i] > ema50[i]) { tables.emaBull.total++; if (nextUp) tables.emaBull.buy++; }
    if (ema20[i] < ema50[i]) { tables.emaBear.total++; if (nextUp) tables.emaBear.buy++; }
    if (macdLine[i] > macdSignal[i]) { tables.macdBull.total++; if (nextUp) tables.macdBull.buy++; }
    if (macdLine[i] < macdSignal[i]) { tables.macdBear.total++; if (nextUp) tables.macdBear.buy++; }
    if (adxVals[i] > 25) { tables.adxStrong.total++; if (nextUp) tables.adxStrong.buy++; }
    if (adxVals[i] < 20) { tables.adxWeak.total++; if (nextUp) tables.adxWeak.buy++; }
    if (atrVals[i] > meanAtr) { tables.atrHigh.total++; if (nextUp) tables.atrHigh.buy++; }
    if (atrVals[i] < meanAtr) { tables.atrLow.total++; if (nextUp) tables.atrLow.buy++; }
    if (volVals[i] > meanVol) { tables.volHigh.total++; if (nextUp) tables.volHigh.buy++; }
    if (volVals[i] < meanVol) { tables.volLow.total++; if (nextUp) tables.volLow.buy++; }
  }

  // Prior P(BUY)
  const hist = computeHistoricalProbability(candles);
  const prior = hist.buyPct / 100;

  // For each condition that is currently true, update probability via Bayes
  const last = candles.length - 1;
  const lastRsi = rsiVals[last] || 50;
  const conditions = [];
  if (lastRsi < 30) conditions.push('rsiLow');
  if (lastRsi > 70) conditions.push('rsiHigh');
  if (ema20[last] > ema50[last]) conditions.push('emaBull');
  if (ema20[last] < ema50[last]) conditions.push('emaBear');
  if (macdLine[last] > macdSignal[last]) conditions.push('macdBull');
  if (macdLine[last] < macdSignal[last]) conditions.push('macdBear');
  if (adxVals[last] > 25) conditions.push('adxStrong');
  if (adxVals[last] < 20) conditions.push('adxWeak');
  if (atrVals[last] > meanAtr) conditions.push('atrHigh');
  if (atrVals[last] < meanAtr) conditions.push('atrLow');
  if (volVals[last] > meanVol) conditions.push('volHigh');
  if (volVals[last] < meanVol) conditions.push('volLow');

  let prob = prior;
  let totalBuyCount = 0, totalSellCount = 0;
  for (const c of conditions) {
    const t = tables[c];
    if (t.total > 0) {
      const buyGivenCond = t.buy / t.total;
      const sellGivenCond = (t.total - t.buy) / t.total;
      // Bayesian update: P(B|S) = P(S|B)*P(B) / P(S)
      // P(S) = P(S|B)*P(B) + P(S|S)*P(S)
      const pSignal = buyGivenCond * prior + sellGivenCond * (1 - prior);
      if (pSignal > 0) {
        prob = (buyGivenCond * prior) / pSignal;
      }
      totalBuyCount += t.buy;
      totalSellCount += t.total - t.buy;
    }
  }
  // If multiple conditions, average the posterior
  if (conditions.length > 1) {
    // Use the average of individual posteriors
    prob = conditions.reduce((sum, c) => {
      const t = tables[c];
      if (t.total > 0) {
        const buyGivenCond = t.buy / t.total;
        const pSignal = buyGivenCond * prior + ((t.total - t.buy) / t.total) * (1 - prior);
        return sum + (pSignal > 0 ? (buyGivenCond * prior) / pSignal : prior);
      }
      return sum + prior;
    }, 0) / conditions.length;
  }

  return {
    buyPct: Math.max(1, Math.min(99, prob * 100)),
    sellPct: Math.max(1, Math.min(99, (1 - prob) * 100))
  };
}

// --- Model 3: Logistic Regression ---
// Train via gradient descent (MLE). No fixed coefficients.
function trainLogisticRegression(data) {
  if (data.length < 10) return null;
  const features = 6; // rsi, emaRatio, macdV, atrNorm, adxV, volNorm
  let w = new Array(features + 1).fill(0); // bias + 6 weights
  const lr = 0.001;
  const epochs = 200;

  // Normalize features
  const means = new Array(features).fill(0);
  const stds = new Array(features).fill(1);
  for (let f = 0; f < features; f++) {
    let sum = 0;
    for (const d of data) sum += [d.rsi, d.emaRatio, d.macdV, d.atrNorm, d.adxV, d.volNorm][f];
    means[f] = sum / data.length;
    let sq = 0;
    for (const d of data) sq += Math.pow([d.rsi, d.emaRatio, d.macdV, d.atrNorm, d.adxV, d.volNorm][f] - means[f], 2);
    stds[f] = Math.sqrt(sq / data.length) || 1;
  }

  function sigmoid(z) { return 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, z)))); }

  for (let epoch = 0; epoch < epochs; epoch++) {
    const grad = new Array(features + 1).fill(0);
    for (const d of data) {
      const x = [1,
        (d.rsi - means[0]) / stds[0],
        (d.emaRatio - means[1]) / stds[1],
        (d.macdV - means[2]) / stds[2],
        (d.atrNorm - means[3]) / stds[3],
        (d.adxV - means[4]) / stds[4],
        (d.volNorm - means[5]) / stds[5]
      ];
      let z = 0;
      for (let j = 0; j <= features; j++) z += w[j] * x[j];
      const p = sigmoid(z);
      const err = p - d.label;
      for (let j = 0; j <= features; j++) grad[j] += err * x[j];
    }
    for (let j = 0; j <= features; j++) w[j] -= (lr / data.length) * grad[j];
  }

  return { w, means, stds };
}

let cachedLogReg = null;

function computeLogisticRegression(candles, rsiVals, ema20, ema50, macdLine, macdSignal, macdHist, atrVals, adxVals, volVals) {
  const data = buildTrainingData(candles, rsiVals, ema20, ema50, macdLine, macdSignal, macdHist, atrVals, adxVals, volVals);
  const model = trainLogisticRegression(data);
  if (!model) return { buyPct: 50, sellPct: 50 };

  cachedLogReg = model;
  const last = candles.length - 1;
  const x = [1,
    ((rsiVals[last] || 50) - model.means[0]) / model.stds[0],
    ((candles[last].close - ema20[last]) / (ema20[last] || 1) - model.means[1]) / model.stds[1],
    ((macdHist[last] || 0) - model.means[2]) / model.stds[2],
    (((atrVals[last] || 0) / (candles[last].close || 1)) - model.means[3]) / model.stds[3],
    ((adxVals[last] || 0) - model.means[4]) / model.stds[4],
    ((volVals[last] || 0) - model.means[5]) / model.stds[5]
  ];
  let z = 0;
  for (let j = 0; j <= 6; j++) z += model.w[j] * x[j];
  const prob = 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, z))));
  return {
    buyPct: Math.max(1, Math.min(99, prob * 100)),
    sellPct: Math.max(1, Math.min(99, (1 - prob) * 100))
  };
}

// --- Model 4: Markov Chain ---
// Based on Close(next) > Close(current)
function computeMarkovChain(candles) {
  let bb = 0, bs = 0, sb = 0, ss = 0;
  for (let i = 0; i < candles.length - 1; i++) {
    const bull = candles[i + 1].close > candles[i].close;
    if (i === 0) continue;
    const prevBull = candles[i].close > candles[i - 1].close;
    if (prevBull && bull) bb++;
    else if (prevBull && !bull) bs++;
    else if (!prevBull && bull) sb++;
    else ss++;
  }
  const totalB = bb + bs || 1;
  const totalS = sb + ss || 1;
  const pBuyGivenBuy = bb / totalB;
  const pBuyGivenSell = sb / totalS;
  const lastBull = candles[candles.length - 1].close > candles[candles.length - 2].close;
  const prob = lastBull ? pBuyGivenBuy : pBuyGivenSell;
  return {
    buyPct: Math.max(1, Math.min(99, prob * 100)),
    sellPct: Math.max(1, Math.min(99, (1 - prob) * 100)),
    matrix: { bb: bb / totalB, bs: bs / totalB, sb: sb / totalS, ss: ss / totalS }
  };
}

// --- Model 5: Expected Value ---
function computeExpectedValue(candles) {
  let wins = 0, losses = 0, totalProfit = 0, totalLoss = 0;
  for (let i = 0; i < candles.length - 1; i++) {
    const change = candles[i + 1].close - candles[i].close;
    if (change > 0) { wins++; totalProfit += change; }
    else { losses++; totalLoss += Math.abs(change); }
  }
  const total = wins + losses || 1;
  const winRate = wins / total;
  const avgProfit = wins > 0 ? totalProfit / wins : 0;
  const avgLoss = losses > 0 ? totalLoss / losses : 0;
  const ev = winRate * avgProfit - (1 - winRate) * avgLoss;
  const maxEV = avgProfit + avgLoss || 1;
  const evRatio = Math.max(-1, Math.min(1, ev / maxEV));
  const buyPct = 50 + evRatio * 40;
  return {
    buyPct: Math.max(1, Math.min(99, buyPct)),
    sellPct: Math.max(1, Math.min(99, 100 - buyPct)),
    ev, winRate: winRate * 100, avgProfit, avgLoss
  };
}

// Main function
function computeAllModels(candles) {
  if (!candles || candles.length < 30) return null;
  const prices = candles.map(c => c.close);

  const rsiVals = typeof computeRSI === 'function' ? computeRSI(candles, 14) : prices.map(() => 50);
  const ema20 = computeEMA(prices, 20);
  const ema50 = computeEMA(prices, 50);
  const macd = computeMACD(prices);
  const atrVals = computeATR(candles, 14);
  const adxResult = computeADX(candles, 14);
  const volVals = candles.map(c => c.volume || 0);

  const hist = computeHistoricalProbability(candles);
  const bayes = computeBayesianProbability(candles, rsiVals, ema20, ema50, macd.macdLine, macd.signal, atrVals, adxResult.adx, volVals, hist.buyPct);
  const logReg = computeLogisticRegression(candles, rsiVals, ema20, ema50, macd.macdLine, macd.signal, macd.histogram, atrVals, adxResult.adx, volVals);
  const markov = computeMarkovChain(candles);
  const ev = computeExpectedValue(candles);

  return {
    models: {
      historical: hist,
      bayesian: bayes,
      logistic: logReg,
      markov,
      expectedValue: ev
    }
  };
}

// Sequence computation for chart bar
function computeModelProbSequence(candles, modelIndex) {
  if (!candles || candles.length < 30) return [];
  const result = [];
  const warmup = 30;

  for (let i = warmup; i < candles.length; i++) {
    const sub = candles.slice(0, i + 1);
    const t = candles[i].time;
    let val = 50;

    if (modelIndex === 0) {
      const h = computeHistoricalProbability(sub);
      val = h.buyPct;
    } else if (modelIndex === 1 || modelIndex === 2) {
      // Bayesian and Logistic need indicators - compute on subset
      const prices = sub.map(c => c.close);
      const rsi = typeof computeRSI === 'function' ? computeRSI(sub, 14) : prices.map(() => 50);
      const ema20 = computeEMA(prices, 20);
      const ema50 = computeEMA(prices, 50);
      const macd = computeMACD(prices);
      const atr = computeATR(sub, 14);
      const adxR = computeADX(sub, 14);
      const vols = sub.map(c => c.volume || 0);
      if (modelIndex === 1) {
        const b = computeBayesianProbability(sub, rsi, ema20, ema50, macd.macdLine, macd.signal, atr, adxR.adx, vols, 50);
        val = b.buyPct;
      } else {
        const l = computeLogisticRegression(sub, rsi, ema20, ema50, macd.macdLine, macd.signal, macd.histogram, atr, adxR.adx, vols);
        val = l.buyPct;
      }
    } else if (modelIndex === 3) {
      const m = computeMarkovChain(sub);
      val = m.buyPct;
    } else if (modelIndex === 4) {
      const e = computeExpectedValue(sub);
      val = e.buyPct;
    }
    result.push({ time: t, value: val });
  }
  return result;
}
