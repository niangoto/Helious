// Page 8: RSI ФАЗОВ АНАЛИЗ — phase across multiple look-back periods.
//
// Всеки период използва СВОИ интервал на свещите (не се реже една и съща серия):
//   10м  → 1m свещи, 30м → 5m, 1ч → 15m, 4ч → 1h, 1д → 1h, 7д → 4h, 30д → 1d.
// За всеки период:
//   1. АМПЛИТУДА в цената на стоката = max(high) - min(low) за периода (НЕ RSI).
//      По-големият период вложено включва по-малкия → амплитудата расте с периода.
//   2. RSI: взимат се НАЙ-МАКСИМАЛНИТЕ и НАЙ-МИНИМАЛНИТЕ стойности за целия период;
//      стойностите в лентата около неутралното 50 (|v-50| < 10) се пропускат,
//      а от поредицата се премахват съседните еднакви по тип (пик/спад) с най-малка
//      абсолютна стойност — остават само строго редуващи се пикове и долини.
//   3. avgMax = средно на пиковете, avgMin = средно на спадовете,
//      avgMid = (avgMax + avgMin) / 2 — три стойности за фазата.
//   4. ФАЗА В ГРАДУСИ: -180 при минимума, 0 при средата, +180 при максимума.
//   5. Относителна амплитуда = amplitude / maxAmplitude (най-голямата = 1).
// Краен резултат:
//   - сборна фаза (градуси) = Σ(фаза_градуси_i × относителна_амплитуда_i) / Σ(relAmp)
//   - сборен RSI индекс (0-100) = 50 + сборна_фаза/180 × 50

const RSI_PHASE_PERIODS = [
    { label: '10м', interval: '1m', bars: 30 },
    { label: '30м', interval: '5m', bars: 30 },
    { label: '1ч', interval: '15m', bars: 30 },
    { label: '4ч', interval: '1h', bars: 30 },
    { label: '1д', interval: '1h', bars: 48 },
    { label: '7д', interval: '4h', bars: 48 },
    { label: '30д', interval: '1d', bars: 40 }
];

function rsiPhaseClamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

// Намира екстремумите за ЦЕЛИЯ период. Пиковете са локални максимуми НАД 50,
// долините — локални минимуми ПОД 50. Стойностите в лентата около неутралното 50
// (|v-50| < 10) се пропускат, а от поредицата се ПРЕМАХВАТ съседните еднакви по тип
// (пик/спад) с най-малка абсолютна стойност — остават само строго редуващи се.
function findPeriodExtremes(values) {
    const n = values.length;
    const NEUTRAL = 50;
    const APPROACH = 10; // пренебрегваме стойности в лентата |v-50| < 10
    const seq = [];
    for (let i = 1; i < n - 1; i++) {
        const v = values[i];
        const isPeak = v > 50 && v > values[i - 1] && v >= values[i + 1];
        const isTrough = v < 50 && v < values[i - 1] && v <= values[i + 1];
        if (!isPeak && !isTrough) continue;
        if (Math.abs(v - NEUTRAL) < APPROACH) continue;
        const type = isPeak ? 'max' : 'min';
        const dev = Math.abs(v - NEUTRAL);
        const last = seq[seq.length - 1];
        if (last && last.type === type) {
            // съседни еднакви: запазваме по-крайния (по-голяма абсолютна стойност)
            if (dev > last.dev) seq[seq.length - 1] = { type, i, v, dev };
        } else {
            seq.push({ type, i, v, dev });
        }
    }
    return {
        maxima: seq.filter(e => e.type === 'max'),
        minima: seq.filter(e => e.type === 'min')
    };
}

// Зарежда свещи за даден символ + интервал (кеширани).
let rsiPhaseCache = {};
async function getPeriodCandles(symbol, interval, bars) {
    const key = symbol + '|' + interval;
    if (rsiPhaseCache[key]) return rsiPhaseCache[key];
    const data = await fetchKlines(symbol, interval, bars);
    const candles = data.map(d => ({
        time: timeToLocal(d[0] / 1000),
        open: parseFloat(d[1]),
        high: parseFloat(d[2]),
        low: parseFloat(d[3]),
        close: parseFloat(d[4]),
        volume: parseFloat(d[5])
    }));
    rsiPhaseCache[key] = candles;
    return candles;
}

// Асинхронен анализ по всички периоди — всеки със собствен интервал на свещи.
let rsiPhaseSeq = 0;
async function computeRsiPhaseAnalysis() {
    const seq = ++rsiPhaseSeq;
    const symbol = ivCurrentSymbol || currentSymbol;
    if (!symbol) return null;

    const results = [];
    await Promise.all(RSI_PHASE_PERIODS.map(async (p) => {
        try {
            const candles = await getPeriodCandles(symbol, p.interval, p.bars);
            if (seq !== rsiPhaseSeq) return;
            const rsiVals = computeRSI(candles, 14);
            if (rsiVals.length < 14) return;
            const currentRsi = rsiVals[rsiVals.length - 1];
            const maxR = Math.max(...rsiVals);
            const minR = Math.min(...rsiVals);
            // АМПЛИТУДА в цената на стоката: max(high) - min(low) за периода (НЕ RSI).
            // По-големият период вложено включва по-малкия → амплитудата расте с периода.
            let priceMax = -Infinity, priceMin = Infinity;
            for (const c of candles) {
                if (c.high > priceMax) priceMax = c.high;
                if (c.low < priceMin) priceMin = c.low;
            }
            const amplitude = (priceMax - priceMin) || 1e-6;
            const { maxima, minima } = findPeriodExtremes(rsiVals);
            const avgMax = maxima.length ? maxima.reduce((s, e) => s + e.v, 0) / maxima.length : maxR;
            const avgMin = minima.length ? minima.reduce((s, e) => s + e.v, 0) / minima.length : minR;
            const avgMid = (avgMax + avgMin) / 2;
            const range = avgMax - avgMin;
            // фаза в градуси: -180 при минимума, 0 при средата, +180 при максимума
            const phaseDeg = range > 1e-9 ? rsiPhaseClamp(((currentRsi - avgMid) / range) * 360, -180, 180) : 0;
            results.push({
                label: p.label, interval: p.interval, bars: candles.length,
                currentRsi, maxR, minR, priceMax, priceMin,
                amplitude, avgMax, avgMin, avgMid, phaseDeg, peaks: maxima.length, troughs: minima.length
            });
        } catch (e) {
            console.warn('RSI phase period fail:', p.label, e);
        }
    }));
    if (seq !== rsiPhaseSeq) return null;
    if (!results.length) return null;

    // най-голямата амплитуда се приравнява на 1, останалите спрямо нея
    const maxAmp = Math.max(...results.map(r => r.amplitude), 1e-6);
    let wSum = 0, degSum = 0;
    for (const r of results) {
        r.relAmp = r.amplitude / maxAmp;
        wSum += r.relAmp;
        degSum += r.phaseDeg * r.relAmp;
    }
    // сборна фаза (градуси) и сборен RSI индекс (0-100)
    const finalPhaseDeg = wSum > 0 ? degSum / wSum : 0;
    const finalRsi = rsiPhaseClamp(50 + (finalPhaseDeg / 180) * 50, 0, 100);

    // подредба по зададената последователност на периодите
    const order = RSI_PHASE_PERIODS.map(p => p.label);
    results.sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label));
    return { results, finalRsi, finalPhaseDeg };
}

// Panel: сборен RSI индекс + фаза в градуси + редове за всеки период.
async function renderRsiPhasePanel() {
    const finalEl = document.getElementById('rsiPhaseFinal');
    const gaugeEl = document.getElementById('rsiPhaseFinalGauge');
    const degEl = document.getElementById('rsiPhaseDeg');
    const rowsEl = document.getElementById('rsiPhaseRows');

    const analysis = await computeRsiPhaseAnalysis();
    if (!analysis) {
        if (finalEl) { finalEl.textContent = '---'; finalEl.className = 'iv-card-value neutral'; }
        if (degEl) degEl.textContent = '---';
        if (gaugeEl) gaugeEl.style.width = '0%';
        if (rowsEl) rowsEl.innerHTML = '';
        return;
    }
    const rsi = analysis.finalRsi;
    if (finalEl) {
        finalEl.textContent = rsi.toFixed(1);
        finalEl.className = 'iv-card-value ' + (rsi > 55 ? 'up' : rsi < 45 ? 'down' : 'neutral');
    }
    if (degEl) {
        const d = analysis.finalPhaseDeg;
        degEl.textContent = (d >= 0 ? '+' : '') + d.toFixed(0) + '°';
        degEl.className = d > 10 ? 'up' : d < -10 ? 'down' : 'neutral';
    }
    if (gaugeEl) gaugeEl.style.width = Math.min(100, Math.max(0, rsi)) + '%';
    if (rowsEl) {
        rowsEl.innerHTML = analysis.results.map(r => {
            const d = r.phaseDeg;
            const cls = d > 10 ? 'up' : d < -10 ? 'down' : 'neutral';
            // амплитуда в цената (абсолютна) + нормализирана спрямо най-голямата
            const ampAbs = r.amplitude.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            return `<div class="iv-fft-bin">
                <span class="iv-fft-freq">${r.label} · ${r.interval}</span>
                <span>RSI <b style="color:#fff">${r.currentRsi.toFixed(1)}</b></span>
                <span class="${cls}">${(d >= 0 ? '+' : '') + d.toFixed(0)}°</span>
                <span>Ампл ${ampAbs} (${(r.relAmp * 100).toFixed(0)}%)</span>
            </div>`;
        }).join('');
    }
}

// Chart canvas: RSI линия + отбелязани пикове (▲) и минимуми (▼).
// Екстремумите се смятат върху ЦЕЛИЯ период (всички свещи за активния период),
// не само върху видимия отрязък — така при смяна на времевия период анализът е пълен.
function drawRsiPhaseChart(ctx, w, h, label) {
    const d = indicatorData;
    if (!d.rsi.length) return;
    let range = chart.timeScale().getVisibleRange();
    if (!range && d.rsi.length > 1) range = { from: d.rsi[0].time, to: d.rsi[d.rsi.length - 1].time };
    if (!range) return;
    const vis = d.rsi.filter(p => p.time >= range.from && p.time <= range.to && p.value !== null);
    if (vis.length < 2) return;
    const pts = vis.map(p => ({ x: chart.timeScale().timeToCoordinate(p.time), y: p.value })).filter(p => p.x !== null);
    if (pts.length < 2) return;
    let minY = Infinity, maxY = -Infinity;
    vis.forEach(p => { if (p.value < minY) minY = p.value; if (p.value > maxY) maxY = p.value; });
    if (maxY === minY) { minY -= 1; maxY += 1; }
    const pad = (maxY - minY) * 0.1;
    minY -= pad; maxY += pad;
    const toY = (v) => h - ((v - minY) / (maxY - minY)) * (h - 8) - 4;

    // линия на RSI
    label.textContent = 'RSI Фаза';
    [70, 30].forEach(val => { const y = toY(val); if (y >= 0 && y <= h) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.strokeStyle = 'rgba(255,255,255,0.1)'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]); ctx.stroke(); ctx.setLineDash([]); } });
    ctx.beginPath();
    pts.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, toY(p.y)); else ctx.lineTo(p.x, toY(p.y)); });
    ctx.strokeStyle = '#b450ff'; ctx.lineWidth = 1.5; ctx.stroke();

    // редуващи се пикове и минимуми върху ЦЕЛИЯ период (всички RSI точки),
    // след което се чертаят само тези, попадащи във видимия диапазон.
    const allValues = d.rsi.filter(p => p.value !== null);
    const { maxima, minima } = findPeriodExtremes(allValues.map(p => p.value));
    const mark = (e, isPeak) => {
        const p = allValues[e.i];
        if (!p) return;
        const x = chart.timeScale().timeToCoordinate(p.time);
        if (x == null) return;
        const y = Math.max(2, Math.min(h - 2, toY(p.value)));
        ctx.fillStyle = isPeak ? 'rgba(0,255,102,0.9)' : 'rgba(255,0,85,0.9)';
        ctx.beginPath();
        if (isPeak) { ctx.moveTo(x, y - 7); ctx.lineTo(x - 5, y); ctx.lineTo(x + 5, y); }
        else { ctx.moveTo(x, y + 7); ctx.lineTo(x - 5, y); ctx.lineTo(x + 5, y); }
        ctx.closePath();
        ctx.fill();
        // вертикална пунктирана линия
        ctx.strokeStyle = isPeak ? 'rgba(0,255,102,0.3)' : 'rgba(255,0,85,0.3)';
        ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
        ctx.setLineDash([]);
    };
    maxima.forEach(e => mark(e, true));
    minima.forEach(e => mark(e, false));
}

registerTab({
    index: 8,
    renderPanel: renderRsiPhasePanel,
    drawChart: drawRsiPhaseChart
});
