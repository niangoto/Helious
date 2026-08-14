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
  const meanAtr = atrV.reduce((s, v) => s + v, 0) / atrV.length;
  const meanVol = volV.reduce((s, v) => s + v, 0) / volV.length;
  const maxBars = Math.min(50, n);
  const combos = new Map();
  let totalWins = 0, totalTrades = 0;
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
// На ефективен пазар глобалната вероятност посоката на една свещ да е "нагоре"
// е винаги ~50/50 — това не е грешка, а математическа реалност. Затова
// историческата и марковската вероятност се оценяват върху ПОСЛЕДНИТЕ N движения
// (прозорец = текущият пазарен режим) — така реагират на актуалния тренд/застой.
const MODEL_WINDOW = 40;

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
// МЕТОД: анализираният период се разделя на 5 по-малки части (под-прозорци).
// За всяка част се прилага дискретно преобразувание на Фурие върху
// детрендирания остатък (линеен тренд a+b·i се отделя преди това) и се
// намират нейните доминантни синусоиди (честота, амплитуда, фаза).
// След това ВСИЧКИ части се екстраполират напред от своите последни моменти
// до крайната точка на целия период (със същите синусоиди и техните фази) и
// крайният резултат е СРЕДНАТА стойност на тези 5 екстраполации (ансамбъл).
//
// ЗАЩО detrend ПРЕДИ FFT: преобразуванието на Фурие приема периодичен
// сигнал; трендът се отделя, за да не доминира и да не предизвиква повторение.
//
// ВАЖНО за нормализацията: при zero-padding сигналът се пресмята върху
// size = степен на 2 >= m (дължина на частта), затова обратното преобразувание
// използва амплитуда 2|X[k]|/size (а НЕ /m). Амплитудите са в ценови единици.
function computeFourierAnalysis(candles) {
  if (!candles || candles.length < 16) return null;
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

  // Брой части: до 5, всяка с поне ~12 свещи, за да има смисъл FFT.
  const partsCount = Math.max(1, Math.min(5, Math.floor(n / 12)));

  // ── 1. За всяка част: детрендинг + FFT + доминантни синусоиди ──
  const parts = [];
  for (let p = 0; p < partsCount; p++) {
    const start = Math.floor(p * n / partsCount);
    const end = Math.floor((p + 1) * n / partsCount) - 1;
    const m = end - start + 1;
    if (m < 8) continue;
    const seg = candles.slice(start, end + 1);

    // Линеен тренд в частта (least squares): close[i] = a + b·i + residual[i]
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < m; i++) {
      const v = seg[i].close;
      sx += i; sy += v; sxx += i * i; sxy += i * v;
    }
    const b = (m * sxy - sx * sy) / (m * sxx - sx * sx || 1);
    const a = (sy - b * sx) / m;

    // FFT върху остатъка (zero-padding до степен на 2)
    let size = 1;
    while (size < m) size <<= 1;
    const re = new Float64Array(size);
    const im = new Float64Array(size);
    for (let i = 0; i < m; i++) re[i] = seg[i].close - (a + b * i);
    fftRadix2(re, im);

    const components = [];
    for (let k = 1; k <= size / 2; k++) {
      const amp = Math.sqrt(re[k] * re[k] + im[k] * im[k]) / size * 2;
      if (amp < 0.002) continue;
      components.push({ freq: k / size, amplitude: amp, phase: Math.atan2(im[k], re[k]) });
    }
    components.sort((a, b) => b.amplitude - a.amplitude);
    const dominant = components.slice(0, 12);
    if (!dominant.length) continue;

    parts.push({ start, end, m, a, b, dominant });
  }

  if (!parts.length) return flatResult();

  // Синтез на една част: тренд + сума от синусоидите при глобален индекс i
  const synthPart = (pt, i) => {
    const t = i - pt.start; // локален индекс в частта
    let v = 0;
    for (const d of pt.dominant) v += d.amplitude * Math.cos(2 * Math.PI * d.freq * t + d.phase);
    return pt.a + pt.b * t + v;
  };

  // ── 2. Синя линия: всяка част реконструира своя сегмент (следва свещите) ──
  const recon = [];
  for (let i = 0; i < n; i++) {
    // намираме частта, която покрива i (или най-близката след нея за гладкост)
    let pt = parts[parts.length - 1];
    for (const p of parts) { if (i >= p.start && i <= p.end) { pt = p; break; } }
    recon.push({ time: candles[i].time, value: synthPart(pt, i) });
  }
  const reconEnd = recon[n - 1].value;

  // ── 3. Продължение: всички части се екстраполират до края на периода ──
  // Ансамблова стойност в бъдещ момент t (глобален индекс) = средна от 5-те
  // екстраполации (всяка продължава със своите честоти/фази/амплитуди).
  const ensembleAt = (t) => {
    let sum = 0;
    for (const pt of parts) sum += synthPart(pt, t);
    return sum / parts.length;
  };

  const forecast = [];
  for (let k = 0; k < n; k++) {
    const t = n - 1 + k;
    // Първата точка (k=0) закотвена към края на реконструкцията, за да е
    // непрекъсната синята -> пунктираната линия. След това сигналът ЗАТИХВА
    // към средната точка на диапазона (mid), за да не повтаря формата на
    // синята линия — всички синусоиди се "сливат" в средата на графиката.
    let val;
    if (k === 0) {
      val = reconEnd;
    } else {
      const decay = Math.exp(-(k / n) * 2.0);
      val = mid + (ensembleAt(t) - mid) * decay;
    }
    forecast.push({ time: candles[n - 1].time + (k + 1) * stepBase, value: val });
  }

  // ── 4. Спектър: обединяваме доминантните компоненти на всички части ──
  const allComp = [];
  for (const pt of parts) allComp.push(...pt.dominant);
  allComp.sort((a, b) => b.amplitude - a.amplitude);
  const dominant = allComp.slice(0, 40);

  // Вероятност: какво описва?
  // Продължението = ансамбъл от 5-те части, затихващ към mid (mean-reversion).
  // Ако втората половина на продължението е средно НАД последната цена, моделът
  // очаква придвижване нагоре през следващия период -> Buy > 50. Под -> Sell.
  // Отклонението е % от целия диапазон на видимия период и се мащабира.
  const halfIdx = Math.max(1, Math.floor(n / 2));
  let futSum = 0;
  for (let k = halfIdx; k < forecast.length; k++) futSum += forecast[k].value;
  const futAvg = futSum / (forecast.length - halfIdx);
  const driftPct = ((futAvg - candles[n - 1].close) / range) * 100;
  const buyPct = Math.max(5, Math.min(95, 50 + driftPct * 0.6));

  return { spectrum: dominant, reconstruction: recon, forecast, buyPct, sellPct: 100 - buyPct, range, min, max };
}

function computeFourierProbability(candles) {
  const f = computeFourierAnalysis(candles);
  if (!f) return { buyPct: 50, sellPct: 50 };
  return { buyPct: f.buyPct, sellPct: f.sellPct };
}

// Плъзгаща FFT вероятност за всяка свещ (за probability canvas).
// Кешира се по хеш на свещите (както statsCache) — преизчислява се само при смяна.
let fourierSeqCache = { hash: 0, data: null };
function computeFourierProbSequence(candles) {
  const n = candles.length;
  if (n < 32) return [];
  const h = candlesHash(candles);
  if (fourierSeqCache.hash === h) return fourierSeqCache.data;
  const result = [];
  // По-лека версия за линията на вероятността: малък прозорец и по-малко
  // компоненти са достатъчни, защото това е само сигналната линия (0-100%).
  const win = 48;
  const maxPoints = 36;
  const step = Math.max(1, Math.floor((n - 30) / maxPoints));
  for (let i = 30; i < n; i += step) {
    const slice = candles.slice(Math.max(0, i - win + 1), i + 1);
    const f = computeFourierAnalysisLight(slice);
    result.push({ time: candles[i].time, value: f ? f.buyPct : 50 });
  }
  fourierSeqCache = { hash: h, data: result };
  return result;
}

// Лека FFT вероятност: същият алгоритъм, но с по-малко доминантни компоненти
// (по-бърза за плъзгащата се поредица на probability canvas).
function computeFourierAnalysisLight(candles) {
  if (!candles || candles.length < 16) return null;
  const n = candles.length;
  let min = Infinity, max = -Infinity;
  for (const c of candles) { if (c.close < min) min = c.close; if (c.close > max) max = c.close; }
  const range = (max - min) || 1;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const v = candles[i].close;
    sx += i; sy += v; sxx += i * i; sxy += i * v;
  }
  const b = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1);
  const a = (sy - b * sx) / n;
  const trendAt = (i) => a + b * i;
  let size = 1;
  while (size < n) size <<= 1;
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < n; i++) re[i] = candles[i].close - trendAt(i);
  fftRadix2(re, im);
  const components = [];
  for (let k = 1; k <= size / 2; k++) {
    const amp = Math.sqrt(re[k] * re[k] + im[k] * im[k]) / size * 2;
    if (amp < 0.002) continue;
    components.push({ freq: k / size, amplitude: amp, phase: Math.atan2(im[k], re[k]) });
  }
  components.sort((a, b) => b.amplitude - a.amplitude);
  const dominant = components.slice(0, 12);
  if (!dominant.length) return { buyPct: 50, sellPct: 50 };
  const synthCycle = (t) => {
    let v = 0;
    for (const d of dominant) v += d.amplitude * Math.cos(2 * Math.PI * d.freq * t + d.phase);
    return v;
  };
  const halfIdx = Math.max(1, Math.floor(n / 2));
  let futSum = 0;
  for (let k = halfIdx; k < n; k++) futSum += trendAt(n - 1 + k) + synthCycle(n - 1 + k);
  const futAvg = futSum / (n - halfIdx);
  const driftPct = ((futAvg - candles[n - 1].close) / range) * 100;
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
  const meanAtr = atrV.reduce((s, v) => s + v, 0) / atrV.length;
  const meanVol = volV.reduce((s, v) => s + v, 0) / volV.length;
  const last = candles.length - 1;
  const mask = signalMask(last, rsiV[last] || 50, ema20[last], ema50[last], ema200[last], macd.macdLine[last], macd.signal[last], macd.histogram[last], atrV[last], adxR.adx[last], volV[last], meanAtr, meanVol);
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
  for (let i = Math.max(20, n - 150); i < n - 1; i++) {
    const r = resolveTrade(candles, i, atrV[i] || 1, 1.5, 1.0, maxBars);
    if (r) {
      trades.push({ win: r.win, atr: atrV[i] || 1 });
      if (trades.length > 50) trades.shift();
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

function computeAllModels(candles) {
  if (!candles || candles.length < 30) return null;
  const prices = candles.map(c => c.close);
  const hist = computeHistoricalProbability(candles);
  return { models: { historical: hist, logistic: computeCombinationProbability(candles), markov: computeMarkovChain(candles), expectedValue: computeExpectedValue(candles), wavelet: computeWaveletProbability(prices), fourier: computeFourierProbability(candles) } };
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
  let totalWins = 0, totalTrades = 0;
  const recentTrades = [];
  const dirs = [];

  const maskAt = (i) => signalMask(i, rsiV[i] || 50, ema20[i], ema50[i], ema200[i], macd.macdLine[i], macd.signal[i], macd.histogram[i], atrV[i], adxR.adx[i], volV[i], meanAtr, meanVol);
  const combosVal = (i, fallback) => { const m = maskAt(i); if (combos.has(m)) { const cc = combos.get(m); if (cc.total > 0) return (cc.wins / cc.total) * 100; } return fallback; };

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

  const sampleVal = (i, hPct) => {
    const histVal = amplify(directionalProb(dirs));
    if (modelIndex === 0) return histVal;
    if (modelIndex === 1) return combosVal(i, hPct);
    if (modelIndex === 2) return amplify(markovProb(dirs));
    if (modelIndex === 3) return evVal();
    if (modelIndex === 4) return computeWaveletProbability(prices.slice(0, i + 1)).buyPct;
    return (histVal + combosVal(i, hPct) + amplify(markovProb(dirs)) + evVal() + computeWaveletProbability(prices.slice(0, i + 1)).buyPct) / 5;
  };

  const pushDir = (i) => {
    const d = candles[i].close >= candles[i - 1].close ? 1 : 0;
    dirs.push(d);
    if (dirs.length > MODEL_WINDOW) dirs.shift();
  };

  for (let i = 30; i < n - 1; i++) {
    // Насочена статистика в плъзгащ прозорец — винаги се обновява
    pushDir(i);

    const atr = atrV[i] || 1;
    const tradeResult = simulateTrade(candles, i, atr, maxBars);
    if (tradeResult >= 0) {
      totalTrades++; if (tradeResult === 1) totalWins++;
      const mask = maskAt(i);
      if (!combos.has(mask)) combos.set(mask, { total: 0, wins: 0 });
      const c = combos.get(mask); c.total++; if (tradeResult === 1) c.wins++;
      recentTrades.push({ win: tradeResult, atr });
      if (recentTrades.length > 100) recentTrades.shift();
    }

    if (i % step === 0 || i === n - 2) {
      const t = candles[i].time;
      const hPct = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 50;
      result.push({ time: t, value: Math.max(1, Math.min(99, sampleVal(i, hPct))) });
    }
  }

  // Добавяне на вероятността за последната свещ (без бъдещ изход)
  const lastIdx = n - 1;
  pushDir(lastIdx);
  const hPctLast = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 50;
  result.push({ time: candles[lastIdx].time, value: Math.max(1, Math.min(99, sampleVal(lastIdx, hPctLast))) });

  return result;
}

// ─── Causal per-candle probability series (for the Hermes bot) ───
// Resolve the outcome of a trade entered at candle `j` (TP/SL hit and the
// candle index where it resolved). Returns null if neither level is reached
// within `maxBars` bars (used as time-exit horizon by the bot).
function resolveTrade(candles, j, atrVal, tpMult, slMult, maxBars) {
  const entry = candles[j].close;
  const tp = entry + tpMult * atrVal;
  const sl = entry - slMult * atrVal;
  const limit = Math.min(j + maxBars, candles.length);
  for (let k = j + 1; k < limit; k++) {
    if (candles[k].high >= tp) return { win: 1, closeIdx: k };
    if (candles[k].low <= sl) return { win: 0, closeIdx: k };
  }
  return null;
}

// Compute the model buy/sell probability at every candle index in a strictly
// causal (walk-forward) way: at index i the statistics only include trades
// entered before i whose outcome was already known by time i.
// modelIndex: 0=historical, 1=logistic, 2=markov, 3=EV,
//             4=wavelet, 5=average of 0..4
// Returns an array aligned with `candles` (null for the warm-up window).
function computeModelProbSeries(candles, modelIndex) {
  const n = candles.length;
  if (n < 30) return [];
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
  const meanAtr = atrV.reduce((s, v) => s + v, 0) / atrV.length;
  const meanVol = volV.reduce((s, v) => s + v, 0) / volV.length;
  const maxBars = Math.min(50, n);

  // Pre-resolve every historical trade outcome and bucket by resolution index.
  const entries = new Array(n).fill(null);
  const resolvedAt = new Array(n).fill(null).map(() => []);
  for (let j = 30; j < n - 1; j++) {
    const r = resolveTrade(candles, j, atrV[j] || 1, 1.5, 1.0, maxBars);
    if (r) {
      const mask = signalMask(j, rsiV[j] || 50, ema20[j], ema50[j], ema200[j], macd.macdLine[j], macd.signal[j], macd.histogram[j], atrV[j], adxR.adx[j], volV[j], meanAtr, meanVol);
      entries[j] = { mask, win: r.win };
      resolvedAt[r.closeIdx].push(j);
    }
  }

  const combos = new Map();
  let totalWins = 0, totalTrades = 0;
  const recentTrades = [];
  const dirs = [];

  const maskAt = (i) => signalMask(i, rsiV[i] || 50, ema20[i], ema50[i], ema200[i], macd.macdLine[i], macd.signal[i], macd.histogram[i], atrV[i], adxR.adx[i], volV[i], meanAtr, meanVol);

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
    // Насочена статистика в плъзгащ прозорец — посоката е известна към време i
    const d = candles[i].close >= candles[i - 1].close ? 1 : 0;
    dirs.push(d);
    if (dirs.length > MODEL_WINDOW) dirs.shift();

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
        if (recentTrades.length > 50) recentTrades.shift();
      }
    }

    let val;
    if (modelIndex === 0) {
      val = amplify(directionalProb(dirs));
    } else if (modelIndex === 1) {
      const mask = maskAt(i);
      val = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 50;
      if (combos.has(mask)) { const cc = combos.get(mask); if (cc.total > 0) val = (cc.wins / cc.total) * 100; }
    } else if (modelIndex === 2) {
      val = amplify(markovProb(dirs));
    } else if (modelIndex === 3) {
      val = evVal();
    } else if (modelIndex === 4) {
      // Плъзгащ прозорец (последни 500 цени) — пази O(n) при големи серии
      const win = Math.max(0, i - 499);
      const w = computeWaveletProbability(prices.slice(win, i + 1));
      val = w.buyPct;
    } else if (modelIndex === 5) {
      let sum = 0, cnt = 0;
      const v0 = amplify(directionalProb(dirs)); sum += v0; cnt++;
      const mask = maskAt(i);
      let v1 = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 50;
      if (combos.has(mask)) { const cc = combos.get(mask); if (cc.total > 0) v1 = (cc.wins / cc.total) * 100; } sum += v1; cnt++;
      const v2 = amplify(markovProb(dirs)); sum += v2; cnt++;
      const v3 = evVal(); sum += v3; cnt++;
      const win = Math.max(0, i - 499);
      const v4 = computeWaveletProbability(prices.slice(win, i + 1)).buyPct; sum += v4; cnt++;
      val = cnt > 0 ? sum / cnt : 50;
    }
    result[i] = { time: candles[i].time, buyPct: Math.max(1, Math.min(99, val)), sellPct: Math.max(1, Math.min(99, 100 - val)) };
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
