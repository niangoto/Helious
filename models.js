// Technical Indicators
// RSI (Wilder). Дефиниран тук, за да е наличен и когато models.js се ползва в Node.
// В браузъра js/indicators.js / hermes.html предефинират същата функция — без проблем.
function computeRSI(candles, period) {
  period = period || 14;
  if (!candles || candles.length < period + 1) return [];
  const changes = [];
  for (let i = 1; i < candles.length; i++) changes.push(candles[i].close - candles[i - 1].close);
  let avgG = 0, avgL = 0;
  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) avgG += changes[i];
    else avgL += Math.abs(changes[i]);
  }
  avgG /= period; avgL /= period;
  const rsi = [avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL)];
  for (let i = period; i < changes.length; i++) {
    const g = changes[i] > 0 ? changes[i] : 0;
    const l = changes[i] < 0 ? Math.abs(changes[i]) : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
    rsi.push(avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL));
  }
  return rsi;
}

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

// Причинна (causal) средна: out[i] = средно на arr[0..i] (без бъдеще).
function expandingMean(arr) {
  const out = new Array(arr.length);
  let s = 0;
  for (let i = 0; i < arr.length; i++) { s += (arr[i] || 0); out[i] = s / (i + 1); }
  return out;
}

// Причинна (causal) плъзгаща средна: out[i] = средно на последните `win`
// елемента (arr[max(0,i-win+1)..i]). Ползва се, за да съвпада базовата линия с
// живата сесия, която смята модела върху подвижен прозорец от `win` свещи.
function rollingMean(arr, win) {
  const out = new Array(arr.length);
  let s = 0;
  for (let i = 0; i < arr.length; i++) {
    s += (arr[i] || 0);
    if (i >= win) s -= (arr[i - win] || 0);
    out[i] = s / Math.min(i + 1, win);
  }
  return out;
}

// RSI масивът от computeRSI() е изместен: rsi[k] отговаря на свещ k+period.
// Затова RSI за свещ i се чете от rsiV[i - period], а не rsiV[i] (последното
// четеше RSI от БЪДЕЩЕТО с period свещи напред).
function rsiAt(rsiV, i, period) {
  const k = i - (period || 14);
  return (rsiV && k >= 0 && k < rsiV.length && rsiV[k] != null) ? rsiV[k] : 50;
}

function simulateTrade(candles, i, atrVal, maxBars) {
  const entry = candles[i].close;
  const tp = entry + 1.5 * atrVal;
  const sl = entry - 1.0 * atrVal;
  const limit = Math.min(i + maxBars, candles.length);
  for (let j = i + 1; j < limit; j++) {
    // Песимистично при same-bar TP+SL: приемаме SL.
    if (candles[j].low <= sl) return 0;
    if (candles[j].high >= tp) return 1;
  }
  return -1;
}

// --- Cached statistics ---
let statsCache = { hash: 0, combos: null, histBuyPct: 50, evData: null };

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
  const meanAtrV = rollingMean(atrV, LOGISTIC_LOOKBACK);
  const meanVolV = rollingMean(volV, LOGISTIC_LOOKBACK);
  const maxBars = Math.min(50, n);
  const combos = new Map();
  let totalWins = 0, totalTrades = 0;
  let wins = 0, losses = 0, tpSum = 0, slSum = 0;
  // Логистичната гледа фиксирано LOGISTIC_LOOKBACK бара назад.
  for (let i = Math.max(20, n - LOGISTIC_LOOKBACK - 1); i < n - 1; i++) {
    const atr = atrV[i] || atrV[atrV.length - 1] || 1;
    const result = simulateTrade(candles, i, atr, maxBars);
    if (result < 0) continue;
    totalTrades++;
    if (result === 1) totalWins++;
    const mask = signalMask(i, rsiAt(rsiV, i, 14), ema20[i], ema50[i], ema200[i], macd.macdLine[i], macd.signal[i], macd.histogram[i], atrV[i], adxR.adx[i], volV[i], meanAtrV[i], meanVolV[i]);
    if (!combos.has(mask)) combos.set(mask, { total: 0, wins: 0 });
    const c = combos.get(mask); c.total++;
    if (result === 1) c.wins++;
    if (result === 1) { wins++; tpSum += atr * 1.5; } else { losses++; slSum += atr * 1.0; }
  }
  const hTotal = totalTrades || 1;

  return {
    hash: candlesHash(candles), combos, histBuyPct: (totalWins / hTotal) * 100,
    ev: { wins, losses, tpSum, slSum, winRate: wins / (wins + losses || 1) * 100, avgProfit: wins > 0 ? tpSum / wins : 0, avgLoss: losses > 0 ? slSum / losses : 0 }
  };
}

function getStats(candles) {
  const h = candlesHash(candles);
  if (statsCache.hash !== h) {
    statsCache = { hash: 0, combos: null, histBuyPct: 50, evData: null };
    const s = buildStats(candles); if (s) statsCache = s;
  }
  return statsCache;
}

// ─── Модели ───
// ЕДИНЕН прозорец назад за ВСИЧКИ модели (≈2000 свещи): историческа, марковска,
// логистична, очаквана стойност, уейвлет и средната им. Така всички гледат
// еднакво количество история (и в Hermes, и в живата сесия `engine/session.js`
// с WINDOW = 2000). Преди всеки модел имаше собствена дължина (40/50/500/1000).
const MODEL_LOOKBACK = 2000;
// За обратна съвместимост (същият прозорец).
const MODEL_WINDOW = MODEL_LOOKBACK;
const MODEL_STATS_WINDOW = MODEL_LOOKBACK;
// „Логистична“ гледа фиксирано назад LOGISTIC_LOOKBACK свещи: базовата линия
// (среден ATR/обем) и статистиката по приключили сделки се държат само в този
// прозорец (FIFO). Така решението не зависи от цялата налична история.
const LOGISTIC_LOOKBACK = 3000;
// Прозорец за FFT модела (колко назад гледа Фурие).
const FOURIER_LOOKBACK = 500;

// ─── Fast Fourier Transform (FFT) ───
// Дискретно преобразувание на Фурие върху видимите свещи. Серията се
// нормализира спрямо диапазона [min, max] на периода, после се разлага на
// синусоиди (честота, амплитуда, фаза). Доминантните компоненти се
// мултиплицират обратно в сигнал и се екстраполират със същия период напред.

// Итеративно radix-2 Cooley–Tukey FFT (in-place). re/im с дължина степен на 2.
function fftRadix2(re, im) {
  const n = re.length;
  if (n < 2) return;
  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      const half = len >> 1;
      for (let j = 0; j < half; j++) {
        const uRe = re[i + j], uIm = im[i + j];
        const vRe = re[i + j + half] * curRe - im[i + j + half] * curIm;
        const vIm = re[i + j + half] * curIm + im[i + j + half] * curRe;
        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + half] = uRe - vRe;
        im[i + j + half] = uIm - vIm;
        const nxtRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nxtRe;
      }
    }
  }
}

// Връща спектъра на серията: доминантни синусоиди {freq, amplitude, phase},
// реконструкцията по тях (покрива видимия период) и екстраполация напред.
//
// МЕТОД — анализ на ОТНОСИТЕЛНИТЕ ДВИЖЕНИЯ (returns):
// Всички свещи се "разполагат една до друга" математически само чрез това
// дали всяка е била нагоре или надолу и с колко (в %), БЕЗ текущото ниво на
// цената:  ret[i] = close[i]/close[i-1] - 1. Така серията е ниво-независима.
// След това върху returns се прилага дискретно преобразувание на Фурие
// (след отделяне на средната доходност), намират се доминантните синусоиди
// (честота, амплитуда, фаза) на ДВИЖЕНИЯТА, и се определят очакваните
// размери на бъдещите свещи. Синята линия показва натрупаните движения едно
// след друго: за миналото — реалните свещи, за бъдещето — очакваните размери,
// умножени последователно (price *= 1 + очакван return).
//
// ВАЖНО за нормализацията: при zero-padding сигналът се пресмята върху
// size = степен на 2 >= m (брой returns), затова обратното преобразувание
// използва амплитуда 2|X[k]|/size (а НЕ /m). Амплитудите са в относителни
// единици (дроб от цената), напр. 0.0012 = 0.12%.
function computeFourierAnalysis(candles) {
  if (!candles || candles.length < 17) return null;
  const n = candles.length;

  // Диапазон за вероятностите и за мащаба на спектъра
  let min = Infinity, max = -Infinity;
  for (const c of candles) { if (c.close < min) min = c.close; if (c.close > max) max = c.close; }
  const range = (max - min) || 1;
  const mid = (min + max) / 2;

  const stepBase = n > 1 ? (candles[n - 1].time - candles[0].time) / (n - 1) : 60;

  const flatResult = () => {
    const reconstruction = candles.map(c => ({ time: c.time, value: c.close }));
    const forecast = [];
    for (let k = 1; k <= n; k++) {
      forecast.push({ time: candles[n - 1].time + k * stepBase, value: candles[n - 1].close });
    }
    return { spectrum: [], reconstruction, forecast, buyPct: 50, sellPct: 50, range, min, max };
  };

  // ── 1. Относителни движения (ниво-независими) ──
  const rets = [];
  for (let i = 1; i < n; i++) rets.push(candles[i].close / candles[i - 1].close - 1);
  const m = rets.length;
  const meanRet = rets.reduce((s, v) => s + v, 0) / m;

  // ── 2. FFT върху детрендираните returns ──
  let size = 1;
  while (size < m) size <<= 1;
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < m; i++) re[i] = rets[i] - meanRet;
  fftRadix2(re, im);

  const components = [];
  for (let k = 1; k <= size / 2; k++) {
    const amp = Math.sqrt(re[k] * re[k] + im[k] * im[k]) / size * 2;
    if (amp < 1e-7) continue;
    components.push({ freq: k / size, amplitude: amp, phase: Math.atan2(im[k], re[k]) });
  }
  components.sort((a, b) => b.amplitude - a.amplitude);
  const dominant = components.slice(0, 20);
  if (!dominant.length) return flatResult();

  // Синтез на очаквания return в момент t (t=0 е първата доходност)
  const synthRet = (t) => {
    let v = 0;
    for (const d of dominant) v += d.amplitude * Math.cos(2 * Math.PI * d.freq * t + d.phase);
    return v;
  };

  // ── 3. Синя линия: реалните свещи (натрупаните реални движения) ──
  const recon = candles.map(c => ({ time: c.time, value: c.close }));
  const lastClose = candles[n - 1].close;

  // ── 4. Продължение: очакваните размери на бъдещите свещи, натрупани ──
  // Всяка следваща цена = предишната × (1 + очакван return). Очакваният return
  // = средната доходност + затихваща сума от синусоидите на движенията.
  const forecast = [];
  let price = lastClose;
  for (let k = 0; k < n; k++) {
    if (k === 0) {
      forecast.push({ time: candles[n - 1].time + (k + 1) * stepBase, value: lastClose });
      continue;
    }
    const decay = Math.exp(-(k / n) * 1.5);
    const expectedRet = meanRet + synthRet(m - 1 + k) * decay;
    price *= (1 + expectedRet);
    forecast.push({ time: candles[n - 1].time + (k + 1) * stepBase, value: price });
  }

  // Вероятност: какво описва?
  // Продължението = натрупани очаквани размери на свещите (mean-reversion към
  // средната доходност). Ако втората половина на продължението е средно НАД
  // последната цена, моделът очаква придвижване нагоре -> Buy > 50.
  const halfIdx = Math.max(1, Math.floor(n / 2));
  let futSum = 0;
  for (let k = halfIdx; k < forecast.length; k++) futSum += forecast[k].value;
  const futAvg = futSum / (forecast.length - halfIdx);
  const driftPct = ((futAvg - lastClose) / range) * 100;
  const buyPct = Math.max(5, Math.min(95, 50 + driftPct * 0.6));

  return { spectrum: dominant, reconstruction: recon, forecast, buyPct, sellPct: 100 - buyPct, range, min, max };
}

function computeFourierProbability(candles) {
  const f = computeFourierAnalysis(candles);
  if (!f) return { buyPct: 50, sellPct: 50 };
  // Обърнати вероятности (Buy ↔ Sell): точно обратното на предишното.
  const buyPct = Math.max(0, Math.min(100, 100 - f.buyPct));
  return { buyPct, sellPct: 100 - buyPct };
}

// RSI модел: 0 = 100% sell, 100 = 100% buy. buyPct = 100 − RSI (RSI > 50 →
// overbought → sell; RSI < 50 → oversold → buy).
function computeRSIProbability(candles) {
  if (!candles || candles.length < 16) return { buyPct: 50, sellPct: 50 };
  const rsiV = computeRSI(candles, 14);
  if (!rsiV.length) return { buyPct: 50, sellPct: 50 };
  const buyPct = Math.max(0, Math.min(100, 100 - rsiV[rsiV.length - 1]));
  return { buyPct, sellPct: 100 - buyPct };
}

// Стандартни таймфреймове (сек) за RSI модела (1м,5м,15м,30м,1ч,4ч,1д,7д).
const RSI_TIMEFRAMES = [60, 300, 900, 1800, 3600, 14400, 86400, 604800];

// buyPct серия за RSI на по-висок таймфрейм, получен чрез групиране на k
// последователни входни свещи (k = tf / избран интервал). За всеки бар b се
// взима RSI(14) на последния ЗАВЪРШЕН висок таймфрейм бар. k<=1 → RSI направо.
function rsiBuySeriesForTf(candles, k) {
  const n = candles.length;
  const out = new Array(n).fill(50);
  if (k <= 1) {
    const rsiV = computeRSI(candles, 14);
    for (let i = 0; i < n; i++) out[i] = 100 - rsiAt(rsiV, i, 14);
    return out;
  }
  const gc = [];
  for (let i = k - 1; i < n; i += k) gc.push(candles[i].close);
  const grsi = computeRSI(gc.map(c => ({ close: c })), 14);
  for (let b = 0; b < n; b++) {
    const g = Math.floor((b - (k - 1)) / k);
    out[b] = (g < 0) ? 50 : (100 - rsiAt(grsi, g, 14));
  }
  return out;
}

// Плъзгаща FFT вероятност за всяка свещ (за probability canvas).
// Кешира се по хеш на свещите (както statsCache) — преизчислява се само при смяна.
let fourierSeqCache = { hash: 0, lookback: -1, data: null };
function computeFourierProbSequence(candles, opts) {
  const n = candles.length;
  if (n < 32) return [];
  const lb = lookbackOf(opts);
  const h = candlesHash(candles);
  if (fourierSeqCache.hash === h && fourierSeqCache.lookback === lb) return fourierSeqCache.data;
  const result = [];
  // 1:1 с Hermes: Фурие ползва последните min(lookback, FOURIER_LOOKBACK) свещи
  // (в строгия прозорец), с пълния computeFourierProbability.
  const win = FOURIER_LOOKBACK;   // като модел 6 в computeModelProbCore
  const maxPoints = 36;
  const step = Math.max(1, Math.floor((n - 30) / maxPoints));
  for (let i = 30; i < n; i += step) {
    const slice = candles.slice(Math.max(0, i - win + 1), i + 1);
    const f = computeFourierProbability(slice);
    result.push({ time: candles[i].time, value: f ? f.buyPct : 50 });
  }
  // Винаги добавяме и последната (текуща) свещ, за да съвпада картата с графиката.
  if (result.length && result[result.length - 1].time !== candles[n - 1].time) {
    const slice = candles.slice(Math.max(0, n - win), n);
    const f = computeFourierProbability(slice);
    result.push({ time: candles[n - 1].time, value: f ? f.buyPct : 50 });
  }
  fourierSeqCache = { hash: h, lookback: lb, data: result };
  return result;
}

// Лека FFT вероятност: същият returns-базиран алгоритъм, но с по-малко
// доминантни компоненти (по-бърза за плъзгащата се поредица на probability canvas).
function computeFourierAnalysisLight(candles) {
  if (!candles || candles.length < 17) return null;
  const n = candles.length;
  let min = Infinity, max = -Infinity;
  for (const c of candles) { if (c.close < min) min = c.close; if (c.close > max) max = c.close; }
  const range = (max - min) || 1;

  // Относителни движения (ниво-независими)
  const rets = [];
  for (let i = 1; i < n; i++) rets.push(candles[i].close / candles[i - 1].close - 1);
  const m = rets.length;
  const meanRet = rets.reduce((s, v) => s + v, 0) / m;

  let size = 1;
  while (size < m) size <<= 1;
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < m; i++) re[i] = rets[i] - meanRet;
  fftRadix2(re, im);
  const components = [];
  for (let k = 1; k <= size / 2; k++) {
    const amp = Math.sqrt(re[k] * re[k] + im[k] * im[k]) / size * 2;
    if (amp < 1e-7) continue;
    components.push({ freq: k / size, amplitude: amp, phase: Math.atan2(im[k], re[k]) });
  }
  components.sort((a, b) => b.amplitude - a.amplitude);
  const dominant = components.slice(0, 12);
  if (!dominant.length) return { buyPct: 50, sellPct: 50 };
  const synthRet = (t) => {
    let v = 0;
    for (const d of dominant) v += d.amplitude * Math.cos(2 * Math.PI * d.freq * t + d.phase);
    return v;
  };
  // Натрупваме очакваните размери на бъдещите свещи от последната цена
  const lastClose = candles[n - 1].close;
  let price = lastClose;
  let futSum = 0;
  let cnt = 0;
  const halfIdx = Math.max(1, Math.floor(n / 2));
  for (let k = 1; k < n; k++) {
    const decay = Math.exp(-(k / n) * 1.5);
    price *= (1 + meanRet + synthRet(m - 1 + k) * decay);
    if (k >= halfIdx) { futSum += price; cnt++; }
  }
  const futAvg = cnt > 0 ? futSum / cnt : lastClose;
  const driftPct = ((futAvg - lastClose) / range) * 100;
  return { buyPct: Math.max(5, Math.min(95, 50 + driftPct * 0.6)), sellPct: Math.max(5, Math.min(95, 50 - driftPct * 0.6)) };
}

// Коефициент на усилване на отклонението от 50%: без него стойностите стоят
// плътно около 50 и не се виждат резките пазарни движения. С усилването
// отклонение от ±10% става ±16%, т.е. сигналът е видимо различен.
const SIGNAL_AMP = 1.6;

// Усилва отклонение спрямо неутралното 50% и го ограничава до [1, 99].
function amplify(px) {
  return Math.max(1, Math.min(99, 50 + (px - 50) * SIGNAL_AMP));
}

function windowDirections(candles, windowSize) {
  const n = candles.length;
  const start = Math.max(1, n - windowSize);
  const dirs = [];
  for (let i = start; i < n; i++) dirs.push(candles[i].close >= candles[i - 1].close ? 1 : 0);
  return dirs;
}

// Историческа вероятност: P(следваща свещ нагоре) = дял на up-движенията в прозореца.
function directionalProb(dirs) {
  if (!dirs.length) return 50;
  let up = 0;
  for (const d of dirs) if (d === 1) up++;
  return (up / dirs.length) * 100;
}

// Марковска верига от 1-ви ред върху 2-състояниевите up/down движения в прозореца:
// преходна матрица P(U|U), P(D|U), P(U|D), P(D|D) + последно наблюдавано състояние,
// с Laplace (add-1) изглаждане, за да няма нулеви вероятности.
function markovProb(dirs) {
  if (dirs.length < 2) return 50;
  let uu = 0, ud = 0, du = 0, dd = 0;
  for (let k = 1; k < dirs.length; k++) {
    const a = dirs[k - 1], b = dirs[k];
    if (a === 1 && b === 1) uu++;
    else if (a === 1 && b === 0) ud++;
    else if (a === 0 && b === 1) du++;
    else dd++;
  }
  const lastDir = dirs[dirs.length - 1];
  const s = 1;
  return (lastDir === 1 ? (uu + s) / (uu + ud + 2 * s) : (du + s) / (du + dd + 2 * s)) * 100;
}

// Изравнителен win-rate за дадено R:R (R = gain/loss): p* = 1 / (1 + R).
// За TP=1.5×ATR и SL=1.0×ATR → R = 1.5 → p* = 40%.
function breakevenWinRate(tpMult, slMult) {
  return 1 / (1 + tpMult / slMult) * 100;
}

function computeHistoricalProbability(candles) {
  const dirs = windowDirections(candles, MODEL_WINDOW);
  const buyPct = amplify(directionalProb(dirs));
  return { buyPct, sellPct: 100 - buyPct };
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
  const meanAtrV = rollingMean(atrV, LOGISTIC_LOOKBACK);
  const meanVolV = rollingMean(volV, LOGISTIC_LOOKBACK);
  const last = candles.length - 1;
  const mask = signalMask(last, rsiAt(rsiV, last, 14), ema20[last], ema50[last], ema200[last], macd.macdLine[last], macd.signal[last], macd.histogram[last], atrV[last], adxR.adx[last], volV[last], meanAtrV[last], meanVolV[last]);
  if (s.combos.has(mask)) { const c = s.combos.get(mask); if (c.total > 0) return { buyPct: Math.max(1, Math.min(99, (c.wins / c.total) * 100)), sellPct: Math.max(1, Math.min(99, 100 - (c.wins / c.total) * 100)) }; }
  return { buyPct: s.histBuyPct, sellPct: 100 - s.histBuyPct };
}

function computeMarkovChain(candles) {
  const dirs = windowDirections(candles, MODEL_WINDOW);
  const buyPct = amplify(markovProb(dirs));
  return { buyPct: Math.max(1, Math.min(99, buyPct)), sellPct: Math.max(1, Math.min(99, 100 - buyPct)) };
}

// Очаквана стойност: win-rate на симулирани TP/SL сделки върху последните ~50
// приключили сделки. Buy вероятността се отчита спрямо ИЗРАВНИТЕЛНИЯ win-rate
// (p* = 40% за R:R 1.5/1), а не спрямо 50% — иначе моделът винаги стои близо до 50.
function computeExpectedValue(candles) {
  const n = candles.length;
  if (n < 30) return { buyPct: 50, sellPct: 50, ev: 0, winRate: 50, avgProfit: 0, avgLoss: 0 };
  const atrV = computeATR(candles, 14);
  const maxBars = Math.min(50, n);
  const trades = [];
  for (let i = Math.max(20, n - MODEL_LOOKBACK); i < n - 1; i++) {
    const r = resolveTrade(candles, i, atrV[i] || 1, 1.5, 1.0, maxBars);
    if (r) {
      trades.push({ win: r.win, atr: atrV[i] || 1 });
      if (trades.length > MODEL_LOOKBACK) trades.shift();
    }
  }
  let wins = 0, tpSum = 0, slSum = 0;
  for (const t of trades) { if (t.win === 1) { wins++; tpSum += t.atr * 1.5; } else slSum += t.atr * 1.0; }
  const total = trades.length;
  const winRate = total > 0 ? (wins / total) * 100 : 50;
  const avgProfit = wins > 0 ? tpSum / wins : 0;
  const avgLoss = total > wins ? slSum / (total - wins) : 0;
  const ev = (winRate / 100) * avgProfit - (1 - winRate / 100) * avgLoss;
  const buyPct = 50 + (winRate - breakevenWinRate(1.5, 1.0)) * 1.5;
  return { buyPct: Math.max(1, Math.min(99, buyPct)), sellPct: Math.max(1, Math.min(99, 100 - buyPct)), ev, winRate, avgProfit, avgLoss };
}

// ── Строг (1:1 с Hermes) прозорец ───────────────────────────────
// За бар i моделът се смята САМО върху последните W свещи
// (candles[i-W+1 .. i]), с индикатори, заредени от началото на този прозорец —
// точно както computeModelProbSeriesStrict в Hermes.
function lookbackOf(opts) {
  return (opts && opts.lookback > 0) ? Math.floor(opts.lookback) : 0;
}
function windowFor(modelIndex, opts) {
  const lb = lookbackOf(opts);
  if (lb > 0) return lb;
  return (modelIndex === 1 || modelIndex === 8 || modelIndex === 10 || modelIndex === 11) ? LOGISTIC_LOOKBACK : MODEL_LOOKBACK;
}
function computeModelProbAt(candles, i, modelIndex, opts, W) {
  const w = Math.max(30, Math.floor(W) || 1);
  const s = Math.max(0, i - w + 1);
  const win = candles.slice(s, i + 1);
  const vals = computeModelProbCore(win, modelIndex, Object.assign({}, opts, { lookback: w }));
  if (!vals) return null;
  return vals[vals.length - 1];
}

// Стойностите за картите на таблото се взимат от СЪЩАТА строга стойност на
// последния бар, която чертае и графиката (1:1 с Hermes).
function computeAllModels(candles, opts) {
  if (!candles || candles.length < 30) return null;
  const n = candles.length;
  // Бързо причинно изчисление (индикаторите се смятат веднъж за целия период,
  // но само напред — без бъдеще); картата = последната точка на графиката.
  const atLast = (mi) => {
    const vals = computeModelProbCore(candles, mi, opts || null);
    return vals ? vals[n - 1] : null;
  };
  const wrap = (v) => ({ buyPct: v == null ? 50 : v, sellPct: 100 - (v == null ? 50 : v) });
  // Фурие: като модел 6 в Hermes — последните FOURIER_LOOKBACK (500) свещи.
  const f = computeFourierProbability(candles.slice(Math.max(0, n - FOURIER_LOOKBACK), n));
  return { models: {
    historical: wrap(atLast(0)),
    logistic: wrap(atLast(1)),
    markov: wrap(atLast(2)),
    expectedValue: wrap(atLast(3)),
    wavelet: wrap(atLast(4)),
    fourier: wrap(f ? f.buyPct : 50),
    rsi: computeRSIProbability(candles)
  } };
}

// Кеш по хеш на свещите + lookback. Пази максимум 1 запис на модел.
const modelSeqCache = new Map();
function computeModelProbSequence(candles, modelIndex, opts) {
  if (!candles || candles.length < 30) return [];
  const lookback = lookbackOf(opts);
  const cacheHash = candlesHash(candles);
  const cached = modelSeqCache.get(modelIndex);
  if (cached && cached.hash === cacheHash && cached.lookback === lookback) return cached.data;
  const n = candles.length;
  // Едно причинно изчисление за целия период (индикаторите са forward-only,
  // статистиката е walk-forward) → бързо и БЕЗ да вижда бъдещето.
  const vals = computeModelProbCore(candles, modelIndex, opts || null);
  if (!vals) return [];
  const step = Math.max(1, Math.floor(n / 200));
  const result = [];
  for (let i = 30; i < n; i++) {
    if ((i % step === 0 || i === n - 1) && vals[i] != null) result.push({ time: candles[i].time, value: vals[i] });
  }
  modelSeqCache.set(modelIndex, { hash: cacheHash, lookback, data: result });
  return result;
}

// ─── Causal per-candle probability series (for the Hermes bot) ───
// Resolve the outcome of a trade entered at candle `j` (TP/SL hit and the
// candle index where it resolved). Returns null if neither level is reached
// within `maxBars` bars (used as time-exit horizon by the bot).
// Огледално на resolveTrade за къса сделка (TP надолу, SL нагоре).
function resolveTradeShort(candles, j, atrVal, tpMult, slMult, maxBars) {
  const entry = candles[j].close;
  const tp = entry - tpMult * atrVal;
  const sl = entry + slMult * atrVal;
  const limit = Math.min(j + maxBars, candles.length);
  for (let k = j + 1; k < limit; k++) {
    // Песимистично при same-bar TP+SL: приемаме SL (както при дългите).
    if (candles[k].high >= sl) return { win: 0, closeIdx: k };
    if (candles[k].low <= tp) return { win: 1, closeIdx: k };
  }
  return null;
}
function resolveTrade(candles, j, atrVal, tpMult, slMult, maxBars) {
  const entry = candles[j].close;
  const tp = entry + tpMult * atrVal;
  const sl = entry - slMult * atrVal;
  const limit = Math.min(j + maxBars, candles.length);
  for (let k = j + 1; k < limit; k++) {
    // Песимистично при same-bar TP+SL: приемаме SL.
    if (candles[k].low <= sl) return { win: 0, closeIdx: k };
    if (candles[k].high >= tp) return { win: 1, closeIdx: k };
  }
  return null;
}


// ─── Модел 9: „Аналози“ (близост по показатели) ───
// За всяка минала свещ j (само с данни до j) се записват показателите ѝ и се симулират
// въображаеми BUY и SELL с вход close[j] за до H бара напред (H = времево затваряне).
// За всяка посока: MFE = макс. печалба (в ATR), tBest = бар на максимума, MAE = макс. загуба
// до този бар (в ATR). По-успешна е посоката с по-голям резултат score = MFE − MAE;
// записват се: посока, tp = MFE, sl = MAE, hold = tBest. Запис j е известен едва на бар j+H.
// За текущата свещ i: за всеки показател известните записи се подреждат по близост до
// стойността му (ранг → тежест 1 − ранг/N), тежестите се сумират; от топ K по обща тежест
// buyPct = дял на тежестта на BUY-записите; tp/sl/hold = претеглено средно за доминиращата посока.
const ANALOG_TOP_K = 20;
const ANALOG_FEATURES = 7;

function createAnalogEngine(candles, c, H, lb, K, simple, boltz) {
  const n = candles.length;
  const NF = ANALOG_FEATURES;
  const F = [];
  for (let f = 0; f < NF; f++) F.push(new Float64Array(n));
  for (let j = 0; j < n; j++) {
    const atr = c.atrV[j] || 1;
    const ma = c.meanAtrV[j] || atr, mv = c.meanVolV[j] || 1;
    const fv = [
      rsiAt(c.rsiV, j, 14),
      (c.ema20[j] - c.ema50[j]) / atr,
      (c.macd.macdLine[j] - c.macd.signal[j]) / atr,
      c.adxR.adx[j] || 0,
      atr / (ma || 1),
      (c.volV[j] || 0) / (mv || 1),
      c.macd.histogram[j] / atr
    ];
    for (let f = 0; f < NF; f++) F[f][j] = isFinite(fv[f]) ? fv[f] : 0;
  }
  // Записи (известни от бар j+H нататък).
  const rDir = new Int8Array(n), rTp = new Float64Array(n), rSl = new Float64Array(n), rHold = new Float64Array(n);
  const valid = new Uint8Array(n);
  for (let j = 30; j + H <= n - 1; j++) {
    const atr = c.atrV[j] || 1, entry = candles[j].close;
    let maxH = -Infinity, minL = Infinity;
    let bMfe = 0, bMae = 0, bK = 1, sMfe = 0, sMae = 0, sK = 1;
    for (let k = 1; k <= H; k++) {
      const cd = candles[j + k];
      if (cd.high > maxH) maxH = cd.high;
      if (cd.low < minL) minL = cd.low;
      const bm = (maxH - entry) / atr;
      if (bm > bMfe) { bMfe = bm; bK = k; bMae = Math.max(0, (entry - minL) / atr); }
      const sm = (entry - minL) / atr;
      if (sm > sMfe) { sMfe = sm; sK = k; sMae = Math.max(0, (maxH - entry) / atr); }
    }
    const bScore = bMfe - bMae, sScore = sMfe - sMae;
    if (bScore >= sScore) { rDir[j] = 1; rTp[j] = bMfe; rSl[j] = bMae; rHold[j] = bK; }
    else { rDir[j] = 0; rTp[j] = sMfe; rSl[j] = sMae; rHold[j] = sK; }
    valid[j] = 1;
  }
  // Сортирани по стойност масиви (по показател) на записите в прозореца.
  const cap = Math.max(16, lb + 2);
  const sv = [], si = [];
  for (let f = 0; f < NF; f++) { sv.push(new Float64Array(cap)); si.push(new Int32Array(cap)); }
  let m = 0;
  const lowerBound = (arr, x) => { let lo = 0, hi = m; while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; } return lo; };
  const insert = (j) => {
    for (let f = 0; f < NF; f++) {
      const v = F[f][j], a = sv[f], b = si[f];
      const pos = lowerBound(a, v);
      a.copyWithin(pos + 1, pos, m); b.copyWithin(pos + 1, pos, m);
      a[pos] = v; b[pos] = j;
    }
    m++;
  };
  const remove = (j) => {
    for (let f = 0; f < NF; f++) {
      const v = F[f][j], a = sv[f], b = si[f];
      let pos = lowerBound(a, v);
      while (pos < m && b[pos] !== j) pos++;
      if (pos >= m) continue;
      a.copyWithin(pos, pos + 1, m); b.copyWithin(pos, pos + 1, m);
    }
    m--;
  };
  const w = new Float64Array(n);
  return {
    // Към бар i в прозореца влиза записът j = i−H и излиза j = i−lb (прозорец j ∈ [i−lb+1, i−H]).
    add(i) {
      const jn = i - H;
      if (jn >= 30 && valid[jn]) insert(jn);
      const jo = i - lb;
      if (jo >= 30 && valid[jo]) remove(jo);
    },
    evalAt(i) {
      if (m < Math.max(K, 30)) return { buyPct: 50, plan: null };
      // За всеки показател поотделно ВСИЧКИ известни записи се подреждат по близост;
      // точките на записа = номерът му отзад напред (най-близкият = m, най-далечният = 1).
      // Точките от всички показатели се сумират в общата тежест на записа.
      const touched = [];
      for (let f = 0; f < NF; f++) {
        const a = sv[f], b = si[f], x = F[f][i];
        let l = lowerBound(a, x) - 1, r = l + 1, pts = simple ? K : m;
        // „Проста тежест“: само първите K най-близки записа (точки K…1), иначе всички (m…1).
        for (let cnt = 0; (l >= 0 || r < m) && (!simple || cnt < K); cnt++) {
          let id;
          if (l < 0) id = b[r++];
          else if (r >= m) id = b[l--];
          else if (x - a[l] <= a[r] - x) id = b[l--];
          else id = b[r++];
          if (w[id] === 0) touched.push(id);
          w[id] += pts--;
        }
      }
      // Топ K записа по обща тежест.
      const tId = [], tW = [];
      for (let q = 0; q < touched.length; q++) {
        const id = touched[q], tw = w[id]; w[id] = 0;
        if (tId.length < K || tw > tW[tW.length - 1]) {
          let p = tId.length;
          while (p > 0 && tW[p - 1] < tw) p--;
          tId.splice(p, 0, id); tW.splice(p, 0, tw);
          if (tId.length > K) { tId.pop(); tW.pop(); }
        }
      }
      // Болцман: точките на топ K стават тегла exp((s − s_max)/T), T = стандартно отклонение на точките
      // в топ K (адаптивна „температура“) — реалното съотношение според разликите в близостта.
      if (boltz && tW.length > 1) {
        let mu = 0; for (const x of tW) mu += x; mu /= tW.length;
        let va = 0; for (const x of tW) va += (x - mu) * (x - mu);
        const T = Math.max(Math.sqrt(va / tW.length), 1e-9);
        const sMax = tW[0];
        for (let q = 0; q < tW.length; q++) tW[q] = Math.exp((tW[q] - sMax) / T);
      }
      let wb = 0, ws = 0;
      for (let q = 0; q < tId.length; q++) { if (rDir[tId[q]] === 1) wb += tW[q]; else ws += tW[q]; }
      if (wb + ws <= 0) return { buyPct: 50, plan: null };
      const buyPct = 100 * wb / (wb + ws);
      const dir = wb >= ws ? 1 : 0;
      // План за всяка посока (претеглено по точки от записите на тази посока в топ K);
      // plan = планът на доминиращата посока, plan.plans = {BUY, SELL}.
      const mk = (d) => {
        let sw = 0, tp = 0, sl = 0, hd = 0;
        for (let q = 0; q < tId.length; q++) {
          const id = tId[q]; if (rDir[id] !== d) continue;
          sw += tW[q]; tp += tW[q] * rTp[id]; sl += tW[q] * rSl[id]; hd += tW[q] * rHold[id];
        }
        return sw > 0 ? { dir: d === 1 ? 'BUY' : 'SELL', tpMult: Math.max(0.1, tp / sw), slMult: Math.max(0.2, 2 * sl / sw), hold: Math.max(1, Math.round(hd / sw)) } : null;
      };
      const pB = mk(1), pS = mk(0);
      const base = (dir === 1 ? pB : pS) || pB || pS;
      const plan = base ? Object.assign({}, base, { plans: { BUY: pB, SELL: pS } }) : null;
      return { buyPct, plan };
    }
  };
}


// ── Аналози v2 (само модел 9) ───────────────────────────────────
// Поправки спрямо стария двигател (измерено: IC ≈ 0 или леко отрицателен):
//  1) Честен етикет: напред-доходност (close[j+H]−close[j])/ATR, а не „най-добър връх“ със задна дата.
//  2) Истинско разстояние: евклидово върху показатели, стандартизирани със std от прозореца
//     (вместо сума от рангове; всички 9 показателя са в сравними единици).
//  3) Разреждане: избраните аналози са на поне `sep` бара един от друг (съседните свещи
//     имат почти еднакви показатели и изход → иначе топ K са 2–3 епизода).
//  4) Калибрирана вероятност: t-статистика на претеглената средна доходност,
//     buyPct = 50 + 50·tanh(0.4·z). При липса на преимущество z ~ N(0,1) → буйни стойности са редки,
//     а прагът на Hermes има смисъл. Не се прилага EMA/наклон (закъснява).
//  5) TP/SL от съседите: 0.5 × претеглена средна максимална печалба / загуба в посоката (в ATR).
// Показатели 8–9 (|MACD−сигнал|, дневен размах) помагат за предсказване на волатилността.
function createAnalogKnn(candles, c, H, lb, K) {
  const n = candles.length;
  const NF = 9;
  const F = [];
  for (let f = 0; f < NF; f++) F.push(new Float64Array(n));
  for (let j = 0; j < n; j++) {
    const atr = c.atrV[j] || 1;
    const ma = c.meanAtrV[j] || atr, mv = c.meanVolV[j] || 1;
    const k5 = j >= 5 ? Math.abs(candles[j].close - candles[j - 5].close) / atr : 0;
    const k20 = j >= 20 ? Math.abs(candles[j].close - candles[j - 20].close) / atr : 0;
    const fv = [
      rsiAt(c.rsiV, j, 14),
      (c.ema20[j] - c.ema50[j]) / atr,
      (c.macd.macdLine[j] - c.macd.signal[j]) / atr,
      c.adxR.adx[j] || 0,
      atr / (ma || 1),
      (c.volV[j] || 0) / (mv || 1),
      k5, k20,
      (candles[j].high - candles[j].low) / atr
    ];
    for (let f = 0; f < NF; f++) F[f][j] = isFinite(fv[f]) ? fv[f] : 0;
  }
  // Префиксни суми за std на показателите в прозорец (O(1) на бар).
  const PS = [], PQ = [];
  for (let f = 0; f < NF; f++) {
    const a = new Float64Array(n + 1), q = new Float64Array(n + 1);
    for (let j = 0; j < n; j++) { a[j + 1] = a[j] + F[f][j]; q[j + 1] = q[j] + F[f][j] * F[f][j]; }
    PS.push(a); PQ.push(q);
  }
  // Записи: известни от бар j+H.
  const rRet = new Float64Array(n), rUp = new Float64Array(n), rDn = new Float64Array(n);
  const valid = new Uint8Array(n);
  const PR = new Float64Array(n + 1), PR2 = new Float64Array(n + 1);
  for (let j = 0; j < n; j++) {
    if (j >= 30 && j + H <= n - 1) {
      const atr = c.atrV[j] || 1, entry = candles[j].close;
      let mx = -Infinity, mn = Infinity;
      for (let k = 1; k <= H; k++) {
        const cd = candles[j + k];
        if (cd.high > mx) mx = cd.high;
        if (cd.low < mn) mn = cd.low;
      }
      rRet[j] = (candles[j + H].close - entry) / atr;
      rUp[j] = Math.max(0, (mx - entry) / atr);
      rDn[j] = Math.max(0, (entry - mn) / atr);
      valid[j] = 1;
    }
    PR[j + 1] = PR[j] + rRet[j]; PR2[j + 1] = PR2[j] + rRet[j] * rRet[j];
  }
  const sd = new Float64Array(NF);
  const distArr = new Float64Array(Math.max(16, lb + 2));
  return {
    add() { },
    evalAt(i) {
      const lo = Math.max(30, i - lb + 1), hi = i - H;
      const m = hi - lo + 1;
      if (m < Math.max(K * 2, 30)) return { buyPct: 50, plan: null };
      for (let f = 0; f < NF; f++) {
        const mu = (PS[f][hi + 1] - PS[f][lo]) / m;
        const v = (PQ[f][hi + 1] - PQ[f][lo]) / m - mu * mu;
        sd[f] = Math.sqrt(Math.max(v, 1e-12)) || 1;
      }
      const ids = new Array(m);
      for (let j = lo; j <= hi; j++) {
        let d = 0;
        for (let f = 0; f < NF; f++) { const z = (F[f][j] - F[f][i]) / sd[f]; d += z * z; }
        distArr[j - lo] = d; ids[j - lo] = j;
      }
      ids.sort((a, b) => distArr[a - lo] - distArr[b - lo]);
      // Разреждане: поне sep бара между избраните.
      const sep = Math.max(1, Math.min(H >> 1, Math.floor(m / (2 * K))));
      const pick = [];
      for (let q = 0; q < ids.length && pick.length < K; q++) {
        const j = ids[q];
        let ok = true;
        for (let p = 0; p < pick.length; p++) if (Math.abs(pick[p] - j) < sep) { ok = false; break; }
        if (ok) pick.push(j);
      }
      if (pick.length < 5) return { buyPct: 50, plan: null };
      const dK = distArr[pick[pick.length - 1] - lo] || 1;
      let ws = 0, ws2 = 0, mean = 0, up = 0, dn = 0;
      const wts = new Array(pick.length);
      for (let q = 0; q < pick.length; q++) {
        const j = pick[q], w = Math.exp(-distArr[j - lo] / dK);
        wts[q] = w; ws += w; ws2 += w * w;
        mean += w * rRet[j]; up += w * rUp[j]; dn += w * rDn[j];
      }
      mean /= ws; up /= ws; dn /= ws;
      const keff = ws * ws / ws2;
      const mR = (PR[hi + 1] - PR[lo]) / m;
      const vR = (PR2[hi + 1] - PR2[lo]) / m - mR * mR;
      const scale = Math.sqrt(Math.max(vR, 1e-12));
      const z = (mean - mR) / scale * Math.sqrt(keff);
      const buyPct = 50 + 50 * Math.tanh(0.4 * z);
      const mk = (buy) => ({
        dir: buy ? 'BUY' : 'SELL',
        tpMult: Math.max(0.5, 0.5 * (buy ? up : dn)),
        slMult: Math.max(0.5, 0.5 * (buy ? dn : up)),
        hold: H
      });
      const pB = mk(true), pS = mk(false);
      const base = buyPct >= 50 ? pB : pS;
      return { buyPct, plan: Object.assign({}, base, { plans: { BUY: pB, SELL: pS } }) };
    }
  };
}


// ── Модел 12: Невронна мрежа (само HERMES) ──────────────────────
// Без настройки. Обучава се ВЕДНЪЖ върху свещите ПРЕДИ избрания период (бар < trainEnd):
//  • за всяка минала свещ записва 14 показателя (стандартизирани);
//  • симулира въображаеми позиции — BUY и SELL с няколко (TP,SL) варианта (в ATR) до H бара —
//    и записва резултата на всеки вариант (в ATR; SL при двойно засягане);
//  • MLP (14→32→16→V, tanh, Adam) учи очаквания резултат на всеки вариант.
// Последните ~20% от обучението са валидация: избира се праг на очакваната печалба, който дава
// положителен реален резултат; ако такъв няма → моделът няма предимство и НЕ отваря позиции.
// Сега (за бар ≥ trainEnd): избира варианта с най-висока очаквана печалба; ако е под прага или
// текущата ситуация няма аналог в обучението (разстояние до най-близките примери > 90-ия
// персентил от валидацията) → plan = null (Hermes не отваря).
const NN_H = 50;   // хоризонт на въображаемите позиции за разпознаване на шанса
const NN_VARIANTS = (() => {
  const v = [];
  for (const dir of ['BUY', 'SELL']) for (const [tp, sl] of [[1, 1], [2, 1], [1.5, 1.5], [3, 1.5], [2, 2], [4, 2]]) v.push({ dir, tp, sl, hold: NN_H });
  return v;
})();

function nnFeatures(candles, c, j) {
  const atr = c.atrV[j] || 1, cl = candles[j].close;
  const ma = c.meanAtrV[j] || atr, mv = c.meanVolV[j] || 1;
  const rg = (k) => j >= k ? (cl - candles[j - k].close) / atr : 0;
  const cd = candles[j];
  return [
    rsiAt(c.rsiV, j, 14),
    (c.ema20[j] - c.ema50[j]) / atr,
    (cl - c.ema200[j]) / atr,
    (c.macd.macdLine[j] - c.macd.signal[j]) / atr,
    c.macd.histogram[j] / atr,
    c.adxR.adx[j] || 0,
    atr / (ma || 1),
    Math.log1p((c.volV[j] || 0) / (mv || 1)),
    rg(3), rg(10), rg(30),
    (cd.high - cd.low) / atr,
    (cd.close - cd.open) / atr,
    (cd.high - Math.max(cd.open, cd.close) - (Math.min(cd.open, cd.close) - cd.low)) / atr
  ];
}

function nnOutcomes(candles, atrV, j) {
  const atr = atrV[j] || 1, entry = candles[j].close;
  const out = new Float64Array(NN_VARIANTS.length);
  for (let v = 0; v < NN_VARIANTS.length; v++) {
    const { dir, tp, sl, hold } = NN_VARIANTS[v];
    const buy = dir === 'BUY';
    const tpP = buy ? entry + tp * atr : entry - tp * atr, slP = buy ? entry - sl * atr : entry + sl * atr;
    let r = null;
    for (let k = 1; k <= hold; k++) {
      const cd = candles[j + k];
      const hitSl = buy ? cd.low <= slP : cd.high >= slP;
      const hitTp = buy ? cd.high >= tpP : cd.low <= tpP;
      if (hitSl) { r = -sl; break; }
      if (hitTp) { r = tp; break; }
    }
    if (r === null) { const m = (candles[j + hold].close - entry) / atr; r = Math.max(-sl, Math.min(tp, buy ? m : -m)); }
    out[v] = r;
  }
  return out;
}

function nnTrain(Xn, Y, nTr, D, V, seed0, H1, H2, maxEp) {
  // MLP
  let seed = seed0;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const gauss = () => { let u = 0; for (let k = 0; k < 6; k++) u += rnd(); return (u - 3) * 1.4142; };
  const sizes = [D, H1 || 32, H2 || 16, V];
  const W = [], B = [];
  for (let l = 0; l < 3; l++) {
    const w = new Float64Array(sizes[l] * sizes[l + 1]), sc = Math.sqrt(1 / sizes[l]);
    for (let k = 0; k < w.length; k++) w[k] = gauss() * sc;
    W.push(w); B.push(new Float64Array(sizes[l + 1]));
  }
  const fwd = (x, acts) => {
    let a = x;
    for (let l = 0; l < 3; l++) {
      const ni = sizes[l], no = sizes[l + 1], o = new Float64Array(no), w = W[l];
      for (let j = 0; j < no; j++) { let t = B[l][j]; for (let i = 0; i < ni; i++) t += w[j * ni + i] * a[i]; o[j] = l < 2 ? Math.tanh(t) : t; }
      if (acts) acts.push(o);
      a = o;
    }
    return a;
  };
  const mW = W.map(w => new Float64Array(w.length)), vW = W.map(w => new Float64Array(w.length));
  const mB = B.map(b => new Float64Array(b.length)), vB = B.map(b => new Float64Array(b.length));
  let step = 0;
  const gW = W.map(w => new Float64Array(w.length)), gB = B.map(b => new Float64Array(b.length));
  const valMSE = () => {
    let e = 0, m = 0;
    for (let i = nTr; i < Xn.length; i++) { const o = fwd(Xn[i]); for (let v = 0; v < V; v++) { e += (o[v] - Y[i][v]) ** 2; m++; } }
    return e / Math.max(1, m);
  };
  const snap = () => ({ W: W.map(w => w.slice()), B: B.map(b => b.slice()) });
  const restore = (s) => { for (let l = 0; l < 3; l++) { W[l].set(s.W[l]); B[l].set(s.B[l]); } };
  let best = Infinity, bestSnap = snap(), bad = 0;
  const order = Array.from({ length: nTr }, (_, i) => i);
  const BS = 64, LR = 0.003, L2 = 1e-4;
  for (let ep = 0; ep < (maxEp || 60) && bad < 6; ep++) {
    for (let i = order.length - 1; i > 0; i--) { const k = Math.floor(rnd() * (i + 1)); const t = order[i]; order[i] = order[k]; order[k] = t; }
    for (let b0 = 0; b0 < nTr; b0 += BS) {
      for (let l = 0; l < 3; l++) { gW[l].fill(0); gB[l].fill(0); }
      const bn = Math.min(BS, nTr - b0);
      for (let q = 0; q < bn; q++) {
        const i = order[b0 + q], acts = [], x = Xn[i], out = fwd(x, acts);
        let d = new Float64Array(V);
        for (let v = 0; v < V; v++) d[v] = 2 * (out[v] - Y[i][v]) / V;
        for (let l = 2; l >= 0; l--) {
          const ni = sizes[l], no = sizes[l + 1], inp = l === 0 ? x : acts[l - 1];
          const dp = new Float64Array(ni);
          for (let j = 0; j < no; j++) {
            const dj = d[j]; if (dj === 0) continue;
            gB[l][j] += dj;
            for (let k = 0; k < ni; k++) { gW[l][j * ni + k] += dj * inp[k]; dp[k] += dj * W[l][j * ni + k]; }
          }
          if (l > 0) { const a = acts[l - 1]; for (let k = 0; k < ni; k++) dp[k] *= (1 - a[k] * a[k]); }
          d = dp;
        }
      }
      step++;
      const b1 = 0.9, b2 = 0.999, c1 = 1 - Math.pow(b1, step), c2 = 1 - Math.pow(b2, step);
      for (let l = 0; l < 3; l++) {
        const w = W[l], g = gW[l], m1 = mW[l], v1 = vW[l];
        for (let k = 0; k < w.length; k++) { const gg = g[k] / bn + L2 * w[k]; m1[k] = b1 * m1[k] + (1 - b1) * gg; v1[k] = b2 * v1[k] + (1 - b2) * gg * gg; w[k] -= LR * (m1[k] / c1) / (Math.sqrt(v1[k] / c2) + 1e-8); }
        const bb = B[l], gb = gB[l], mb = mB[l], vb = vB[l];
        for (let k = 0; k < bb.length; k++) { const gg = gb[k] / bn; mb[k] = b1 * mb[k] + (1 - b1) * gg; vb[k] = b2 * vb[k] + (1 - b2) * gg * gg; bb[k] -= LR * (mb[k] / c1) / (Math.sqrt(vb[k] / c2) + 1e-8); }
      }
    }
    const e = valMSE();
    if (e < best - 1e-5) { best = e; bestSnap = snap(); bad = 0; } else bad++;
  }
  restore(bestSnap);
  return (x, wantHid) => { if (!wantHid) return fwd(x); const a = []; const o = fwd(x, a); return { o, h: a[1] }; };
}

const NN_LEV = [0.4, 0.6, 0.8, 1, 1.3, 1.6, 2, 2.5, 3, 4, 5];   // нива на TP/SL (ATR), които моделът тества сам
const NN_HOLDS = [6, 12, 20, 30, 50, 75, 100];
const NN_HMAX = 100;

// За една свещ: първия бар, в който цената достига всяко ниво нагоре/надолу, и доходността при всяко време.
function nnPath(candles, atrV, j) {
  const L = NN_LEV.length, atr = atrV[j] || 1, entry = candles[j].close;
  const up = new Int16Array(L).fill(9999), dn = new Int16Array(L).fill(9999);
  let mx = -Infinity, mn = Infinity;
  for (let k = 1; k <= NN_HMAX; k++) {
    const cd = candles[j + k];
    if (cd.high > mx) mx = cd.high;
    if (cd.low < mn) mn = cd.low;
    const u = (mx - entry) / atr, d = (entry - mn) / atr;
    for (let l = 0; l < L; l++) {
      if (up[l] === 9999 && u >= NN_LEV[l]) up[l] = k;
      if (dn[l] === 9999 && d >= NN_LEV[l]) dn[l] = k;
    }
  }
  const ret = new Float64Array(NN_HOLDS.length);
  for (let h = 0; h < NN_HOLDS.length; h++) ret[h] = (candles[j + NN_HOLDS[h]].close - entry) / atr;
  return { up, dn, ret };
}
// Резултат (в ATR) на позиция dir (1=BUY,0=SELL) с TP ниво a, SL ниво b, време h. SL е първи при равенство.
function nnOutcome(P, dir, a, b, h) {
  const hold = NN_HOLDS[h], tp = NN_LEV[a], sl = NN_LEV[b];
  const tpT = dir ? P.up[a] : P.dn[a], slT = dir ? P.dn[b] : P.up[b];
  const t1 = tpT <= hold, t2 = slT <= hold;
  if (t2 && (!t1 || slT <= tpT)) return -sl;
  if (t1) return tp;
  const m = dir ? P.ret[h] : -P.ret[h];
  return Math.max(-sl, Math.min(tp, m));
}

function computeNeuralSeries(candles, opts) {
  const n = candles.length;
  const res = new Array(n).fill(null);
  const trainEnd = Math.max(0, Math.min(n, Math.floor((opts && opts.trainEnd) || 0)));
  const info = { trained: false, reason: '' };
  res.info = info;
  if (n < 100 || trainEnd < 400) { info.reason = 'малко данни за обучение'; return res; }
  const prices = candles.map(c => c.close);
  const c = {
    rsiV: computeRSI(candles, 14), ema20: computeEMA(prices, 20), ema50: computeEMA(prices, 50), ema200: computeEMA(prices, 200),
    macd: computeMACD(prices), atrV: computeATR(candles, 14), adxR: computeADX(candles, 14),
    volV: candles.map(x => x.volume || 0)
  };
  c.meanAtrV = rollingMean(c.atrV, 2000); c.meanVolV = rollingMean(c.volV, 2000);
  const D = 14, V = NN_VARIANTS.length, L = NN_LEV.length, NH = NN_HOLDS.length;
  const idx = [];
  for (let j = 60; j + NN_H < trainEnd; j++) idx.push(j);
  if (idx.length < 300) { info.reason = 'малко обучителни свещи'; return res; }
  const X = idx.map(j => nnFeatures(candles, c, j).map(v => isFinite(v) ? v : 0));
  const Y = idx.map(j => nnOutcomes(candles, c.atrV, j));
  const nTr = Math.floor(idx.length * 0.8);
  const mu = new Float64Array(D), sd = new Float64Array(D);
  for (let d = 0; d < D; d++) {
    let a = 0; for (let i = 0; i < nTr; i++) a += X[i][d]; mu[d] = a / nTr;
    let q = 0; for (let i = 0; i < nTr; i++) q += (X[i][d] - mu[d]) ** 2; sd[d] = Math.sqrt(q / nTr) || 1;
  }
  const norm = (x) => { const o = new Float64Array(D); for (let d = 0; d < D; d++) o[d] = Math.max(-5, Math.min(5, (x[d] - mu[d]) / sd[d])); return o; };
  const Xn = X.map(norm);
  // ── Разпознаване на шанса (непроменено): MLP → най-добър от 12 варианта, праг от валидацията, новост ──
  const net = nnTrain(Xn, Y, nTr, D, V, 12345, 32, 16, 60);
  const fwd = (z) => net(z);
  const pickBest = (o) => { let bv = 0; for (let v = 1; v < V; v++) if (o[v] > o[bv]) bv = v; return bv; };
  const preds = [];
  for (let i = nTr; i < idx.length; i++) { const o = fwd(Xn[i]); const bv = pickBest(o); preds.push({ e: o[bv], r: Y[i][bv], bv, i }); }
  let thr = null, bestTot = -Infinity;
  for (const t of [0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.7]) {
    let cnt = 0, tot = 0; for (const q of preds) if (q.e >= t) { cnt++; tot += q.r; }
    if (cnt >= 30 && tot > bestTot) { bestTot = tot; thr = t; }
  }
  if (thr == null) thr = 0.15;
  const KN = 5;
  const knnDist = (z, limitIdx) => {
    const ds = [];
    for (let i = 0; i < limitIdx; i++) { const x = Xn[i]; let dd = 0; for (let d = 0; d < D; d++) { const t = x[d] - z[d]; dd += t * t; } ds.push(dd); }
    ds.sort((a, b) => a - b);
    return Math.sqrt(ds[Math.min(KN - 1, ds.length - 1)]);
  };
  const vd = [];
  for (let i = nTr; i < idx.length; i += 3) vd.push(knnDist(Xn[i], nTr - NN_H));
  vd.sort((a, b) => a - b);
  const noveltyLim = vd.length ? vd[Math.floor(vd.length * 0.9)] : Infinity;

  // ── Настройка на TP / SL / време: само за вече избраната посока. Върху най-близките минали случаи се тества
  // плътна мрежа (11 TP × 11 SL × 7 времена) и се взема комбинацията с най-добра долна граница на
  // предимството на единица риск (след изваждане на общия дрейф на комбинацията). ──
  const nPath = idx.filter(j => j + NN_HMAX < trainEnd).length;   // примери с пълен път до 100 бара
  const PATH = new Array(nPath);
  for (let i = 0; i < nPath; i++) PATH[i] = nnPath(candles, c.atrV, idx[i]);
  const E = Xn.map(z => Float64Array.from(net(z, true).h));
  const ED = E[0].length;
  const NC = L * L * NH, cidx = (a, b, h) => (a * L + b) * NH + h;
  const globalMean = (upto, dir) => {
    const g = new Float64Array(NC);
    for (let i = 0; i < upto; i++) { const P = PATH[i]; for (let a = 0; a < L; a++) for (let b = 0; b < L; b++) for (let h = 0; h < NH; h++) g[cidx(a, b, h)] += nnOutcome(P, dir, a, b, h); }
    for (let k = 0; k < NC; k++) g[k] /= Math.max(1, upto);
    return g;
  };
  const K = 60, SEP = 12;
  const sum = new Float64Array(NC), sq = new Float64Array(NC);
  const tune = (z, upto, g, dir) => {
    upto = Math.min(upto, nPath);
    const dist = new Float64Array(upto);
    for (let i = 0; i < upto; i++) { const e = E[i]; let t = 0; for (let d = 0; d < ED; d++) { const q = e[d] - z[d]; t += q * q; } dist[i] = t; }
    const ord = Array.from({ length: upto }, (_, i) => i).sort((p, q) => dist[p] - dist[q]);
    const pick = [];
    for (let q = 0; q < ord.length && pick.length < K; q++) { const i = ord[q]; let ok = true; for (let p = 0; p < pick.length; p++) if (Math.abs(pick[p] - i) < SEP) { ok = false; break; } if (ok) pick.push(i); }
    if (pick.length < 20) return null;
    sum.fill(0); sq.fill(0);
    for (const i of pick) { const P = PATH[i]; for (let a = 0; a < L; a++) for (let b = 0; b < L; b++) for (let h = 0; h < NH; h++) { const o = nnOutcome(P, dir, a, b, h), k = cidx(a, b, h); sum[k] += o; sq[k] += o * o; } }
    const m = pick.length;
    let best = null;
    for (let a = 0; a < L; a++) for (let b = 0; b < L; b++) for (let h = 0; h < NH; h++) {
      const k = cidx(a, b, h), mean = sum[k] / m, vr = Math.max(1e-9, sq[k] / m - mean * mean);
      const slv = NN_LEV[b], score = (mean - g[k]) / slv - Math.sqrt(vr / m) / slv;
      if (mean > 0 && (!best || score > best.score)) best = { a, b, h, score };
    }
    return best;
  };
  // Валидация: настроените стойности трябва да бият фиксираната двойка на мрежата, иначе се ползва нейната.
  const upVal = Math.max(100, Math.min(nTr - NN_HMAX, nPath));
  const gV = [globalMean(upVal, 0), globalMean(upVal, 1)];
  let totTuned = 0, totFixed = 0, cntV = 0;
  for (const q of preds) {
    if (q.e < thr || q.i >= nPath) continue;
    const dir = NN_VARIANTS[q.bv].dir === 'BUY' ? 1 : 0;
    const bt = tune(E[q.i], upVal, gV[dir], dir);
    if (!bt) continue;
    totTuned += nnOutcome(PATH[q.i], dir, bt.a, bt.b, bt.h);
    totFixed += q.r; cntV++;
  }
  const useTuned = cntV >= 20 && totTuned > totFixed;
  info.trained = true; info.samples = idx.length; info.thr = thr; info.noveltyLim = noveltyLim;
  info.valPicks = preds.filter(q => q.e >= thr).length;
  info.tuned = useTuned; info.valTuned = totTuned; info.valFixed = totFixed;
  // ── Прилагане ──
  const gAll = [globalMean(nPath, 0), globalMean(nPath, 1)];
  let ok = 0, tot = 0;
  for (let i = trainEnd; i < n; i++) {
    const x = nnFeatures(candles, c, i);
    if (!x.every(isFinite)) continue;
    tot++;
    const z = norm(x), o = fwd(z), bv = pickBest(o);
    let plan = null, buyPct = 50;
    if (o[bv] >= thr && knnDist(z, idx.length) <= noveltyLim) {
      const vr = NN_VARIANTS[bv], dir = vr.dir === 'BUY' ? 1 : 0;
      plan = { dir: vr.dir, tpMult: vr.tp, slMult: vr.sl, hold: vr.hold };
      if (useTuned) {
        const bt = tune(Float64Array.from(net(z, true).h), nPath, gAll[dir], dir);
        if (bt) plan = { dir: vr.dir, tpMult: NN_LEV[bt.a], slMult: NN_LEV[bt.b], hold: NN_HOLDS[bt.h] };
      }
      buyPct = 50 + (dir ? 1 : -1) * 50 * Math.tanh(o[bv] * 2);
      ok++;
    }
    res[i] = { time: candles[i].time, buyPct, sellPct: 100 - buyPct };
    if (plan) res[i].plan = plan;
  }
  info.evalBars = tot; info.signalBars = ok;
  return res;
}

// Causal (walk-forward) core shared by the bot series and the chart sequence.
// At index i the statistics only include trades entered before i whose outcome
// was already known by time i, and every baseline (ATR/volume mean, RSI) is
// taken only from data up to i — so NO model sees the future.
// modelIndex: 0=historical, 1=logistic, 2=markov, 3=EV,
//             4=wavelet, 5=average of 0..4
// Returns an array aligned with `candles` (null for the warm-up window).
function computeModelProbCore(candles, modelIndex, opts) {
  const n = candles.length;
  if (n < 30) return null;
  const invert = (opts && Array.isArray(opts.invert)) ? opts.invert : [];
  const inv = (v, m) => invert[m] ? (100 - v) : v;
  const noClamp = !!(opts && opts.noClamp);
  // Параметър „поглед назад“ (свещи). Ако не е подаден — текущите стойности по
  // подразбиране (логистична: LOGISTIC_LOOKBACK; останалите: MODEL_LOOKBACK).
  const lb = (opts && opts.lookback > 0) ? Math.max(30, Math.floor(opts.lookback)) : 0;
  const logisticLb = lb || LOGISTIC_LOOKBACK;
  const modelLb = lb || MODEL_LOOKBACK;
  // „Разширявай“: от growFrom нататък прозорецът расте с +1 на бар.
  const growFrom = (opts && opts.lookbackGrow && opts.growFrom > 0) ? Math.floor(opts.growFrom) : -1;
  const result = new Array(n).fill(null);
  const prices = candles.map(c => c.close);
  const rsiV = typeof computeRSI === 'function' ? computeRSI(candles, 14) : prices.map(() => 50);
  const ema20 = computeEMA(prices, 20);
  const ema50 = computeEMA(prices, 50);
  const ema200 = computeEMA(prices, 200);
  const macd = computeMACD(prices);
  const atrV = computeATR(candles, 14);
  const adxR = computeADX(candles, 14);
  const volV = candles.map(c => c.volume || 0);
  // Причинна базова линия (средно само до i) — без бъдещи ATR/обем.
  // При „разширявай“ базовата линия е expanding (цялата история до i).
  const meanWin = (growFrom >= 0) ? n : logisticLb;
  const meanAtrV = rollingMean(atrV, meanWin);
  const meanVolV = rollingMean(volV, meanWin);
  const maxBars = Math.min(50, n);
  // Логистична 2 (8): виртуалните сделки ползват TP/SL от настройките (в ATR множители,
  // подават се в opts.tpMult/opts.slMult); останалите модели — фиксирани 1.5/1.
  const vTp = (modelIndex === 8) ? ((opts && opts.virtTp > 0) ? opts.virtTp : 1.5) : ((modelIndex === 10 || modelIndex === 11) && opts && opts.tpMult > 0) ? opts.tpMult : 1.5;
  const vSl = (modelIndex === 8) ? ((opts && opts.virtSl > 0) ? opts.virtSl : 1.5) : ((modelIndex === 10 || modelIndex === 11) && opts && opts.slMult > 0) ? opts.slMult : 1.0;

  // RSI модел: усредняваме buyPct само за таймфреймове >= избрания период за
  // свещ (по-големи или равни). Ресемплираме входните свещи (k = tf/интервал).
  let rsiTfSeries = null;
  if (modelIndex === 7) {
    const iv = (opts && opts.intervalSec) || 0;
    rsiTfSeries = [];
    for (const tf of RSI_TIMEFRAMES) {
      if (iv > 0 && tf < iv) continue;            // само >= избрания период
      const k = iv > 0 ? Math.max(1, Math.round(tf / iv)) : 1;
      rsiTfSeries.push(rsiBuySeriesForTf(candles, k));
    }
    if (!rsiTfSeries.length) rsiTfSeries = null;
  }

  // Pre-resolve every historical trade outcome and bucket by resolution index.
  const entries = new Array(n).fill(null);
  const resolvedAt = new Array(n).fill(null).map(() => []);
  for (let j = 30; j < n - 1; j++) {
    const r = resolveTrade(candles, j, atrV[j] || 1, vTp, vSl, maxBars);
    if (r) {
      const mask = signalMask(j, rsiAt(rsiV, j, 14), ema20[j], ema50[j], ema200[j], macd.macdLine[j], macd.signal[j], macd.histogram[j], atrV[j], adxR.adx[j], volV[j], meanAtrV[j], meanVolV[j]);
      entries[j] = { mask, win: r.win };
      resolvedAt[r.closeIdx].push(j);
    }
  }

  // Логистична 2 (8): нормирана — отделна статистика за къси сделки (TP −1.5/SL +1).
  // Buy = wL/(wL+wS): при шум и двата дяла са ~40% → 50/50 (няма наклон към Sell).
  const norm8 = (modelIndex === 10 || modelIndex === 11);
  // Модел 11 (Логистична 3): EMA на вероятността на модел 8; крайната вероятност е наклонът ѝ.
  let ema11 = NaN;
  const resolvedAtS = norm8 ? new Array(n).fill(null).map(() => []) : null;
  const entriesS = norm8 ? new Array(n).fill(null) : null;
  if (norm8) {
    for (let j = 30; j < n - 1; j++) {
      const r = resolveTradeShort(candles, j, atrV[j] || 1, vTp, vSl, maxBars);
      if (r) {
        const mask = signalMask(j, rsiAt(rsiV, j, 14), ema20[j], ema50[j], ema200[j], macd.macdLine[j], macd.signal[j], macd.histogram[j], atrV[j], adxR.adx[j], volV[j], meanAtrV[j], meanVolV[j]);
        entriesS[j] = { mask, win: r.win };
        resolvedAtS[r.closeIdx].push(j);
      }
    }
  }
  const combosS = new Map();
  let totalWinsS = 0, totalTradesS = 0;
  const resolvedQS = [];
  // Модел 10: линия на Аналози (двойна средна на buyPct на модел 9) → наклон (производна).
  const slopeN = (opts && opts.analogAvg > 0) ? Math.floor(opts.analogAvg) : 200;
  const slopeK = (opts && opts.slopeK > 0) ? opts.slopeK : 0.03;
  const anaBuy = (modelIndex === 10) ? new Float64Array(n).fill(NaN) : null;
  const anaAvg1 = (modelIndex === 10) ? new Float64Array(n).fill(NaN) : null;
  const anaLine = (modelIndex === 10) ? new Float64Array(n).fill(NaN) : null;
  const analogH = (opts && opts.holdBars > 0) ? Math.min(500, Math.floor(opts.holdBars)) : 50;
  const analog = (modelIndex === 9)
    ? createAnalogKnn(candles, { rsiV, ema20, ema50, macd, atrV, adxR, volV, meanAtrV, meanVolV }, analogH, modelLb, (opts && opts.analogTop > 0) ? Math.floor(opts.analogTop) : ANALOG_TOP_K)
    : (modelIndex === 10)
    ? createAnalogEngine(candles, { rsiV, ema20, ema50, macd, atrV, adxR, volV, meanAtrV, meanVolV }, analogH, modelLb, (opts && opts.analogTop > 0) ? Math.floor(opts.analogTop) : ANALOG_TOP_K, !!(opts && opts.analogSimple), false)
    : null;
  const combos = new Map();
  let totalWins = 0, totalTrades = 0;
  const recentTrades = [];
  const dirs = [];
  // FIFO на приключилите сделки по closeIdx — за да изхвърляме статистиката
  // по-стара от MODEL_LOOKBACK (иначе „Логистична“ трупа от бар 30 до края и
  // вижда цялата история, не само последните 2000 бара).
  const resolvedQ = [];

  const maskAt = (i) => signalMask(i, rsiAt(rsiV, i, 14), ema20[i], ema50[i], ema200[i], macd.macdLine[i], macd.signal[i], macd.histogram[i], atrV[i], adxR.adx[i], volV[i], meanAtrV[i], meanVolV[i]);

  const evStats = () => {
    let wins = 0, tpSum = 0, slSum = 0;
    for (const t of recentTrades) { if (t.win === 1) { wins++; tpSum += t.atr * 1.5; } else slSum += t.atr * 1.0; }
    const total = recentTrades.length;
    const winRate = total > 0 ? (wins / total) * 100 : 50;
    const avgProfit = wins > 0 ? tpSum / wins : 0;
    const avgLoss = total > wins ? slSum / (total - wins) : 0;
    return { winRate, ev: (winRate / 100) * avgProfit - (1 - winRate / 100) * avgLoss };
  };
  const evVal = () => 50 + (evStats().winRate - breakevenWinRate(1.5, 1.0)) * 1.5;

  for (let i = 30; i < n; i++) {
    // Текущ (при „разширявай“ — растящ) прозорец.
    const growAdd = (growFrom >= 0) ? Math.max(0, i - growFrom) : 0;
    const curLogisticLb = logisticLb + growAdd;
    const curModelLb = modelLb + growAdd;
    // Насочена статистика в плъзгащ прозорец — посоката е известна към време i
    const d = candles[i].close >= candles[i - 1].close ? 1 : 0;
    dirs.push(d);
    if (dirs.length > curModelLb) dirs.shift();

    // Fold in all trades that resolved exactly at candle i (entry order).
    if (resolvedAt[i].length) {
      resolvedAt[i].sort((a, b) => a - b);
      for (const j of resolvedAt[i]) {
        const e = entries[j];
        totalTrades++;
        if (e.win === 1) totalWins++;
        if (!combos.has(e.mask)) combos.set(e.mask, { total: 0, wins: 0 });
        const c = combos.get(e.mask); c.total++;
        if (e.win === 1) c.wins++;
        recentTrades.push({ win: e.win, atr: atrV[j] || 1 });
        if (recentTrades.length > curModelLb) recentTrades.shift();
        resolvedQ.push({ mask: e.mask, win: e.win, closeIdx: i });
      }
    }

    if (norm8 && resolvedAtS[i].length) {
      resolvedAtS[i].sort((a, b) => a - b);
      for (const j of resolvedAtS[i]) {
        const e = entriesS[j];
        totalTradesS++;
        if (e.win === 1) totalWinsS++;
        if (!combosS.has(e.mask)) combosS.set(e.mask, { total: 0, wins: 0 });
        const c = combosS.get(e.mask); c.total++;
        if (e.win === 1) c.wins++;
        resolvedQS.push({ mask: e.mask, win: e.win, closeIdx: i });
      }
    }
    if (norm8) {
      while (resolvedQS.length && resolvedQS[0].closeIdx < i - (curLogisticLb - 1)) {
        const old = resolvedQS.shift();
        totalTradesS--;
        if (old.win === 1) totalWinsS--;
        const oc = combosS.get(old.mask);
        if (oc) {
          oc.total--;
          if (old.win === 1) oc.wins--;
          if (oc.total <= 0) combosS.delete(old.mask);
        }
      }
    }

    // Изхвърляме статистиката по-стара от MODEL_LOOKBACK бара (плъзгащ прозорец).
    while (resolvedQ.length && resolvedQ[0].closeIdx < i - (curLogisticLb - 1)) {
      const old = resolvedQ.shift();
      totalTrades--;
      if (old.win === 1) totalWins--;
      const oc = combos.get(old.mask);
      if (oc) {
        oc.total--;
        if (old.win === 1) oc.wins--;
        if (oc.total <= 0) combos.delete(old.mask);
      }
    }

    if (analog) analog.add(i);
    if (modelIndex === 10 && opts && opts.onlyLast && i < n - 1 - 6 * slopeN) continue;
    // opts.onlyLast: нужна е само стойността за последния бар — скъпите модели (Уейвлет, Средна, Фурие)
    // не се смятат за останалите барове; статистиката по-горе е вече натрупана → последната стойност е идентична.
    if (opts && opts.onlyLast && i < n - 1 && (modelIndex === 4 || modelIndex === 5 || modelIndex === 6 || modelIndex === 9)) continue;
    let val;
    if (modelIndex === 0) {
      val = amplify(directionalProb(dirs));
    } else if (modelIndex === 10 || modelIndex === 11) {
      const mask = maskAt(i);
      // Смекчаване към общия дял (prior k): малките извадки по маска не дават 0/100.
      const K8 = 25;
      const prior = vSl / (vTp + vSl);   // шанс при шум за TP преди SL
      const baseL = totalTrades > 0 ? totalWins / totalTrades : prior;
      const baseS = totalTradesS > 0 ? totalWinsS / totalTradesS : prior;
      const cL = combos.get(mask) || { total: 0, wins: 0 };
      const cS = combosS.get(mask) || { total: 0, wins: 0 };
      const wL = (cL.wins + K8 * baseL) / (cL.total + K8);
      const wS = (cS.wins + K8 * baseS) / (cS.total + K8);
      val = (wL + wS) > 0 ? (wL / (wL + wS)) * 100 : 50;
      if (modelIndex === 11) {
        // EMA(N) на Buy % (N = analogAvg, по подразбиране 200); Buy % = 50 + 50·tg, tg = d·(N+1)/2·0.03.
        const N11 = (opts && opts.analogAvg > 0) ? Math.floor(opts.analogAvg) : 200;
        const prev = ema11;
        ema11 = isNaN(prev) ? val : prev + (2 / (N11 + 1)) * (val - prev);
        let tg = 0;
        if (!isNaN(prev)) tg = Math.max(-0.9, Math.min(0.9, (ema11 - prev) * (N11 + 1) / 2 * ((opts && opts.slopeK > 0) ? opts.slopeK : 0.03)));
        val = 50 + 50 * tg;
        if (opts && opts.slopeOut) opts.slopeOut[i] = tg;
      }
      if (modelIndex === 10) {
        // Линия от Аналози: EMA(N) на сурови buyPct (N = analogAvg, по подразбиране 50).
        anaBuy[i] = analog.evalAt(i).buyPct;
        const aE = 2 / (slopeN + 1);
        anaLine[i] = (i > 0 && !isNaN(anaLine[i - 1])) ? anaLine[i - 1] + aE * (anaBuy[i] - anaLine[i - 1]) : anaBuy[i];
        if (i > 0 && !isNaN(anaLine[i]) && !isNaN(anaLine[i - 1])) {
          // tg = производна на линията × (N+1)/2 × slopeK (≈ сурова − EMA; мащабът не зависи от N)
          const tg = Math.max(-0.9, Math.min(0.9, (anaLine[i] - anaLine[i - 1]) * (slopeN + 1) / 2 * slopeK));
          const kB = 1 + tg, kS = 1 - tg;
          const b = val, sl2 = 100 - val;
          val = (b * kB + sl2 * kS) > 0 ? (b * kB) / (b * kB + sl2 * kS) * 100 : 50;
          if (opts && opts.slopeOut) opts.slopeOut[i] = tg;
        }
      }
    } else if (modelIndex === 1 || modelIndex === 8) {
      const mask = maskAt(i);
      val = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 50;
      if (combos.has(mask)) { const cc = combos.get(mask); if (cc.total > 0) val = (cc.wins / cc.total) * 100; }
    } else if (modelIndex === 9) {
      const ar = analog.evalAt(i);
      val = ar.buyPct;
      if (opts && opts.planOut) opts.planOut[i] = ar.plan;
    } else if (modelIndex === 2) {
      val = amplify(markovProb(dirs));
    } else if (modelIndex === 3) {
      val = evVal();
    } else if (modelIndex === 4) {
      // Плъзгащ прозорец (последни 500 цени) — пази O(n) при големи серии
      const win = Math.max(0, i - (curModelLb - 1));
      const w = computeWaveletProbability(prices.slice(win, i + 1));
      val = w.buyPct;
    } else if (modelIndex === 5) {
      let sum = 0, cnt = 0;
      const v0 = inv(amplify(directionalProb(dirs)), 0); sum += v0; cnt++;
      const mask = maskAt(i);
      let v1 = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 50;
      if (combos.has(mask)) { const cc = combos.get(mask); if (cc.total > 0) v1 = (cc.wins / cc.total) * 100; }
      v1 = inv(v1, 1); sum += v1; cnt++;
      const v2 = inv(amplify(markovProb(dirs)), 2); sum += v2; cnt++;
      const v3 = inv(evVal(), 3); sum += v3; cnt++;
      const win = Math.max(0, i - (curModelLb - 1));
      const v4 = inv(computeWaveletProbability(prices.slice(win, i + 1)).buyPct, 4); sum += v4; cnt++;
      val = cnt > 0 ? sum / cnt : 50;
    } else if (modelIndex === 6) {
      // Преобразование на Фурие: 0 = 100% sell, 100 = 100% buy (buyPct).
      const win = Math.max(0, i - (FOURIER_LOOKBACK - 1));
      const f = computeFourierProbability(candles.slice(win, i + 1));
      val = f.buyPct;
    } else if (modelIndex === 7) {
      // RSI анализ: усреднено buyPct само за таймфреймове >= избрания период
      // за свещ (по-големи или равни). 0 = 100% sell, 100 = 100% buy.
      if (rsiTfSeries && rsiTfSeries.length) {
        let sum = 0, cnt = 0;
        for (const s of rsiTfSeries) { const v = s[i]; if (v != null) { sum += v; cnt++; } }
        val = cnt ? sum / cnt : 50;
      } else {
        val = 100 - rsiAt(rsiV, i, 14);
      }
    }
    result[i] = noClamp ? val : Math.max(1, Math.min(99, val));
  }
  return result;
}

// Връща масив, подравнен с `candles` (null за загряващия прозорец), всеки
// елемент { time, buyPct, sellPct } — строго причинен (без бъдеще).
function computeModelProbSeries(candles, modelIndex, opts) {
  if (modelIndex === 12) return computeNeuralSeries(candles, opts);
  let planOut = null;
  if (modelIndex === 9) { planOut = []; opts = Object.assign({}, opts, { planOut }); }
  const vals = computeModelProbCore(candles, modelIndex, opts);
  if (!vals) return [];
  const n = candles.length;
  const result = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (vals[i] == null) continue;
    result[i] = { time: candles[i].time, buyPct: vals[i], sellPct: 100 - vals[i] };
    if (planOut && planOut[i]) result[i].plan = planOut[i];
  }
  return result;
}

// Причинна серия от вероятности (същата, която ползва живият двигател).
// „Логистична“ (1) вече е с фиксиран прозорец LOGISTIC_LOOKBACK (= 3000) вътре
// в computeModelProbCore — базовата линия и FIFO статистиката по приключили
// сделки се държат само в него. Затова тук не се правят тежки пре-изчисления по
// плъзгащ прозорец: те не променят статистиката, а биха забавили всеки tick.
function computeModelProbSeriesLive(candles, modelIndex, opts, window) {
  return computeModelProbSeries(candles, modelIndex, opts);
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

// ─── Node.js export (за търговския двигател) ───────────────────────
// В браузъра `module` липсва, така че това не се изпълнява.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    computeRSI,
    computeEMA,
    computeMACD,
    computeATR,
    computeADX,
    signalMask,
    resolveTrade,
    computeModelProbSeries,
    computeNeuralSeries,
    computeModelProbSeriesLive,
    computeModelProbCore,
    computeModelProbSequence,
    computeWaveletProbability,
    computeFourierProbSequence,
    computeRSIProbability,
    computeAllModels,
    computeHistoricalProbability,
    computeMarkovChain,
    computeExpectedValue
  };
}
