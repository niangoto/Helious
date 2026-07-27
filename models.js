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
  const plusDI = []; const minusDI = [];
  const pDMSmooth = computeEMA(plusDM, period);
  const mDMSmooth = computeEMA(minusDM, period);
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

// Probability Models
function computeHistoricalProbability(candles) {
  let buy = 0, sell = 0;
  for (const c of candles) {
    if (c.close > c.open) buy++;
    else sell++;
  }
  const total = buy + sell || 1;
  return { buyPct: (buy / total) * 100, sellPct: (sell / total) * 100 };
}

function computeBayesianProbability(histBuyPct, rsi, macdHist, emaSignal, atrNorm, adx, volNorm) {
  // Start with historical probability as prior
  let prob = histBuyPct / 100;
  // Each indicator updates the belief
  // RSI > 70 oversold-ish boosts buy; signal strength proportional
  const rsiFactor = 1 + (50 - rsi) / 100; // rsi < 50 → buy bias
  prob = prob * rsiFactor;

  // MACD histogram > 0 → bullish
  const macdFactor = 1 + Math.max(-0.5, Math.min(0.5, macdHist * 2));
  prob = prob * macdFactor;

  // EMA signal: close above EMA20 → bullish
  prob = prob * (emaSignal > 0 ? 1.1 : 0.9);

  // ATR: high volatility reduces confidence
  const atrFactor = 1 - Math.min(0.3, atrNorm * 0.3);
  prob = prob * atrFactor;

  // ADX > 25 → strong trend
  if (adx > 25) prob = prob * 1.05;

  // Volume confirmation
  prob = prob * (0.8 + volNorm / 250);

  return {
    buyPct: Math.max(5, Math.min(95, prob * 100)),
    sellPct: Math.max(5, Math.min(95, (1 - prob) * 100))
  };
}

function computeLogisticRegression(rsi, macdHist, emaSignal, atrNorm, adx, volNorm) {
  // Weights (b0..b6) calibrated for typical ranges
  const b0 = -2.5, b1 = 0.04, b2 = 0.3, b3 = 0.5, b4 = -0.3, b5 = 0.02, b6 = 0.005;
  const Z = b0
    + b1 * (rsi - 50)
    + b2 * Math.max(-3, Math.min(3, macdHist * 10))
    + b3 * Math.max(-1, Math.min(1, emaSignal * 0.001))
    + b4 * Math.min(2, atrNorm * 2)
    + b5 * Math.max(-25, Math.min(25, adx - 25))
    + b6 * (volNorm - 50);
  const prob = 1 / (1 + Math.exp(-Z));
  return {
    buyPct: Math.max(5, Math.min(95, prob * 100)),
    sellPct: Math.max(5, Math.min(95, (1 - prob) * 100))
  };
}

function computeMarkovChain(candles) {
  let bb = 0, bs = 0, sb = 0, ss = 0;
  let prevBull = candles[0].close >= candles[0].open;
  for (let i = 1; i < candles.length; i++) {
    const bull = candles[i].close >= candles[i].open;
    if (prevBull && bull) bb++;
    else if (prevBull && !bull) bs++;
    else if (!prevBull && bull) sb++;
    else ss++;
    prevBull = bull;
  }
  const totalB = bb + bs || 1;
  const totalS = sb + ss || 1;
  const pBuyGivenBuy = bb / totalB;
  const pBuyGivenSell = sb / totalS;
  // Use last candle direction
  const lastBull = candles[candles.length - 1].close >= candles[candles.length - 1].open;
  const prob = lastBull ? pBuyGivenBuy : pBuyGivenSell;
  return {
    buyPct: Math.max(5, Math.min(95, prob * 100)),
    sellPct: Math.max(5, Math.min(95, (1 - prob) * 100))
  };
}

function computeExpectedValue(candles) {
  // Compute win rate and avg profit/loss from recent candles
  const recent = candles.slice(-100);
  let wins = 0, losses = 0, totalProfit = 0, totalLoss = 0;
  for (const c of recent) {
    const change = c.close - c.open;
    if (change > 0) { wins++; totalProfit += change; }
    else { losses++; totalLoss += Math.abs(change); }
  }
  const total = wins + losses || 1;
  const winRate = wins / total;
  const avgProfit = wins > 0 ? totalProfit / wins : 0;
  const avgLoss = losses > 0 ? totalLoss / losses : 0;
  const ev = winRate * avgProfit - (1 - winRate) * avgLoss;
  // Normalize EV to probability-like scale
  const maxEV = avgProfit + avgLoss || 1;
  const evRatio = Math.max(-1, Math.min(1, ev / maxEV));
  const buyPct = 50 + evRatio * 40;
  return {
    buyPct: Math.max(5, Math.min(95, buyPct)),
    sellPct: Math.max(5, Math.min(95, 100 - buyPct)),
    ev,
    winRate: winRate * 100,
    avgProfit,
    avgLoss
  };
}

function computeAllModels(candles) {
  if (!candles || candles.length < 30) return null;
  const prices = candles.map(c => c.close);

  // Indicators
  const rsiVals = typeof computeRSI === 'function'
    ? computeRSI(candles, 14)
    : prices.map((_, i) => 50);
  const lastRsi = rsiVals.length > 0 ? rsiVals[rsiVals.length - 1] : 50;

  const ema20 = computeEMA(prices, 20);
  const ema50 = computeEMA(prices, 50);
  const lastPrice = prices[prices.length - 1];
  const emaSignal = (lastPrice - ema20[ema20.length - 1]) / lastPrice;

  const macd = computeMACD(prices);
  const lastMacdHist = macd.histogram[macd.histogram.length - 1] || 0;

  const atr = computeATR(candles, 14);
  const lastAtr = atr[atr.length - 1] || 0;
  const atrNorm = lastAtr / lastPrice;

  const adxResult = computeADX(candles, 14);
  const lastAdx = adxResult.adx[adxResult.adx.length - 1] || 0;

  const vols = candles.map(c => c.volume || 0);
  const volMax = Math.max(...vols);
  const volMin = Math.min(...vols);
  const lastVol = vols[vols.length - 1];
  const volNorm = volMax > volMin ? ((lastVol - volMin) / (volMax - volMin)) * 100 : 50;

  // Models
  const hist = computeHistoricalProbability(candles);
  const bayes = computeBayesianProbability(hist.buyPct, lastRsi, lastMacdHist, emaSignal, atrNorm, lastAdx, volNorm);
  const logReg = computeLogisticRegression(lastRsi, lastMacdHist, emaSignal, atrNorm, lastAdx, volNorm);
  const markov = computeMarkovChain(candles);
  const ev = computeExpectedValue(candles);

  return {
    rsi: lastRsi,
    macdHist: lastMacdHist,
    emaSignal,
    atrNorm,
    adx: lastAdx,
    volNorm,
    models: {
      historical: hist,
      bayesian: bayes,
      logistic: logReg,
      markov,
      expectedValue: ev
    }
  };
}
