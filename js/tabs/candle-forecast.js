// Page 9: ПРОГНОЗА НА СВЕЩИ — експоненциално претеглено средно на свещите.
//
// За всяка следваща свещ:
//   - взима ПРОЦЕНТНОТО тяло (close − open)/open·100 на ВСИЧКИ свещи преди нея със
//     знак (+ ако е зелена нагоре, − ако е червена надолу);
//   - прави тегловно средно с ЕКСПОНЕНЦИАЛНИ тежести A(t) = A0 · e^(−β t)
//     (затихващи трептения): най-новата свещ има най-голяма тежест, а по-старите
//     затихват. t е нормираната възраст (0 за най-новата, 1 за най-старата).
//     β (коефициент на затихване) се задава със слайдер, по подразбиране 1.
//   - следващата свещ = последното затваряне · (1 + средно/100).
// Повтаря се за следващите 10 свещи (прогнозните влизат в прозореца).
//
// На канваса под графиката се рисува ДВИЖЕНИЕТО на свещите (нагоре/надолу) около
// нулева линия, позиционирано по времевата ос на графиката.

const CANDLE_FORECAST_STEPS = 10;

// Тегловно средно с експоненциални тежести A(t) = A0 · e^(−β t).
// t = нормирана възраст: 0 за най-новата стойност, 1 за най-старата. A0 = 1.
function weightedAvg(values, beta) {
    const n = values.length;
    if (n === 0) return 0;
    if (n === 1) return values[0];
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
        const age = (n - 1 - i) / (n - 1);   // най-новата → 0, най-старата → 1
        const w = Math.exp(-beta * age);
        num += w * values[i];
        den += w;
    }
    return den > 0 ? num / den : 0;
}

// Прогноза за `steps` свещи напред. Движението е в ПРОЦЕНТИ.
function computeCandleForecast(candles, steps, beta) {
    if (!candles || candles.length < 2) return null;
    beta = (typeof beta === 'number') ? beta : candleForecastBeta;
    const bodiesPct = candles.map(c => c.open ? ((c.close - c.open) / c.open) * 100 : 0);
    let lastClose = candles[candles.length - 1].close;
    let lastTime = candles[candles.length - 1].time;
    const step = (candles[candles.length - 1].time - candles[0].time) / (candles.length - 1);
    const work = bodiesPct.slice();
    const out = [];
    for (let s = 0; s < steps; s++) {
        const avgPct = weightedAvg(work, beta);
        const open = lastClose;
        const close = lastClose * (1 + avgPct / 100);
        out.push({
            time: lastTime + (s + 1) * step,
            open, close,
            high: Math.max(open, close),
            low: Math.min(open, close),
            pct: avgPct
        });
        work.push(avgPct); // прогнозната свещ (в %) влиза в прозореца
        lastClose = close;
    }
    return out;
}

// Сумата на предвиденото движение за 10-те свещи, в %.
function candleForecastTotalPct(candles) {
    const base = candleForecastBase(candles);
    const forecast = computeCandleForecast(base, CANDLE_FORECAST_STEPS, candleForecastBeta);
    if (!forecast) return null;
    return forecast.reduce((s, c) => s + c.pct, 0);
}

// База за прогнозата: ВСИЧКИ свещи (вкл. допълнителната история назад) до линията
// "СЕГА" (cutoff), ако е заключена. Така всяка свещ има равен брой свещи назад.
function candleForecastBase(fallback) {
    const hist = (typeof historyCandles !== 'undefined' && historyCandles && historyCandles.length >= 2)
        ? historyCandles
        : ((typeof latestCandles !== 'undefined' && latestCandles) ? latestCandles : (fallback || []));
    let src = hist;
    if (typeof presentLineLocked !== 'undefined' && presentLineLocked && presentCutoffTime) {
        src = src.filter(c => c.time <= presentCutoffTime);
    }
    return src;
}

// Дълбочина на историята (колко свещи назад) — равен брой за всяка = дължината на периода.
function candleForecastLookback() {
    try {
        const cfg = periodConfigs[activePeriod];
        if (cfg && cfg.limit) return cfg.limit;
    } catch (e) {}
    return 100;
}

// Слайдер: промяна на коефициента на затихване β (0.01..1) → преизчислява таблото и графиката.
function candleBetaChange(val) {
    const v = parseFloat(val);
    candleForecastBeta = Math.max(0.01, Math.min(1, isNaN(v) ? candleForecastBeta : v));
    const el = document.getElementById('candleBetaVal');
    if (el) el.textContent = candleForecastBeta.toFixed(2);
    const base = candleForecastBase(latestCandles);
    renderCandleForecastPanel(base);
    updateCandleForecastOverlay(base);
    if (typeof updatePresentLinePosition === 'function') updatePresentLinePosition();
    else if (window.updatePresentLinePosition) window.updatePresentLinePosition();
}

// Показва прогнозните свещи на САМАТА графика (candleForecastSeries) — само когато
// е активен панелът "Прогноза на свещи" (page 9). Иначе се изчистват.
function updateCandleForecastOverlay(candles) {
    if (typeof candleForecastSeries === 'undefined' || !candleForecastSeries) return;
    if (typeof currentPage === 'number' && currentPage !== 9) {
        candleForecastSeries.setData([]);
        return;
    }
    const base = candleForecastBase(candles);
    const forecast = computeCandleForecast(base, CANDLE_FORECAST_STEPS, candleForecastBeta);
    if (!forecast) { candleForecastSeries.setData([]); return; }
    candleForecastSeries.setData(forecast.map(c => ({
        time: c.time, open: c.open, high: c.high, low: c.low, close: c.close
    })));
}

// Panel: прогнозна цена след 10 свещи + ред за всяка прогнозна свещ.
function renderCandleForecastPanel(candles) {
    const finalEl = document.getElementById('candleForecastNext');
    const metaEl = document.getElementById('candleForecastMeta');
    const rowsEl = document.getElementById('candleForecastRows');
    const base = candleForecastBase(candles);
    const forecast = computeCandleForecast(base, CANDLE_FORECAST_STEPS, candleForecastBeta);

    const betaEl = document.getElementById('candleBetaVal');
    if (betaEl) betaEl.textContent = candleForecastBeta.toFixed(2);

    if (!forecast) {
        if (finalEl) { finalEl.textContent = '---'; finalEl.className = 'iv-card-value neutral'; }
        if (metaEl) metaEl.textContent = 'Няма достатъчно данни';
        if (rowsEl) rowsEl.innerHTML = '';
        return;
    }
    const last = base[base.length - 1].close;
    const final = forecast[forecast.length - 1].close;
    const pct = ((final - last) / (last || 1)) * 100;
    const sumPct = forecast.reduce((s, c) => s + c.pct, 0);
    if (finalEl) {
        finalEl.textContent = final.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        finalEl.className = 'iv-card-value ' + (pct > 0 ? 'up' : pct < 0 ? 'down' : 'neutral');
    }
    if (metaEl) metaEl.textContent = `Сума ${sumPct >= 0 ? '+' : ''}${sumPct.toFixed(2)}% · ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}% цена · β=${candleForecastBeta.toFixed(2)}`;
    if (rowsEl) {
        rowsEl.innerHTML = forecast.map((c, i) => {
            const pct = c.pct;
            const cls = pct >= 0 ? 'up' : 'down';
            return `<div class="iv-fft-bin">
                <span class="iv-fft-freq">#${i + 1}</span>
                <span>O ${c.open.toFixed(2)}</span>
                <span>C ${c.close.toFixed(2)}</span>
                <span class="${cls}">${(pct >= 0 ? '+' : '') + pct.toFixed(3)}%</span>
            </div>`;
        }).join('');
    }
}

// Canvas: движение на свещите (нагоре/надолу) около нулева линия + прогнозните 10.
// Баровете се позиционират по времевата ос на графиката (timeToCoordinate), така че
// канвасът се движи и мащабира ЗАЕДНО с графиката.
function drawCandleForecastChart(ctx, w, h, label) {
    const base = candleForecastBase(latestCandles);
    if (!base || base.length < 2) return;
    const forecast = computeCandleForecast(base, CANDLE_FORECAST_STEPS, candleForecastBeta);
    if (!forecast) return;
    label.textContent = 'Движение на свещите';

    // x-координати по времевата ос на графиката → синхрон с графиката
    let chartW = w;
    try { const el = document.getElementById('chart'); if (el && el.clientWidth) chartW = el.clientWidth; } catch (e) {}
    const scaleX = chartW > 0 ? (w / chartW) : 1;
    const xOf = (t) => {
        try {
            const x = chart.timeScale().timeToCoordinate(t);
            return (x == null) ? null : x * scaleX;
        } catch (e) { return null; }
    };
    let barW = 4;
    try { const o = chart.timeScale().options(); if (o && o.barSpacing) barW = Math.max(2, o.barSpacing * scaleX * 0.7); } catch (e) {}

    const items = [];
    for (const c of base) {
        const x = xOf(c.time);
        if (x != null && x >= -barW && x <= w + barW) items.push({ x, pct: c.open ? ((c.close - c.open) / c.open) * 100 : 0, fc: false });
    }
    for (const c of forecast) {
        const x = xOf(c.time);
        if (x != null && x >= -barW && x <= w + barW) items.push({ x, pct: c.pct, fc: true });
    }
    if (items.length < 2) return;

    // устойчив мащаб: 90-и персентил на |движението в %| (изблиците се ограничават)
    const absBodies = items.map(it => Math.abs(it.pct)).sort((a, b) => a - b);
    const scale = Math.max(absBodies[Math.floor(absBodies.length * 0.9)] || absBodies[absBodies.length - 1] || 1, 1e-9);
    const midY = h / 2;
    const halfH = h / 2 - 4;

    // нулева линия
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, midY); ctx.lineTo(w, midY); ctx.stroke();

    // разделител преди прогнозните свещи
    const firstFc = forecast.map(c => xOf(c.time)).filter(x => x != null)[0];
    if (firstFc != null) {
        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(firstFc - barW * 0.7, 0); ctx.lineTo(firstFc - barW * 0.7, h); ctx.stroke();
        ctx.setLineDash([]);
    }

    for (const it of items) {
        const up = it.pct >= 0;
        const color = it.fc
            ? (up ? 'rgba(0,240,255,0.9)' : 'rgba(138,43,226,0.9)')
            : (up ? '#00ff66' : '#ff0055');
        const bh = Math.min(halfH, Math.max(1.5, (Math.abs(it.pct) / scale) * halfH));
        ctx.fillStyle = color;
        ctx.globalAlpha = it.fc ? 0.75 : 1;
        if (up) ctx.fillRect(it.x - barW / 2, midY - bh, barW, bh);
        else ctx.fillRect(it.x - barW / 2, midY, barW, bh);
        ctx.globalAlpha = 1;
    }

    // втора лента: предвиденият процент за всяка видима свещ
    if (typeof drawCandlePredictionStrip === 'function') drawCandlePredictionStrip();
}

// Пресмята предвидения процент за всяка подадена (видима) свещ, ползвайки историята
// назад с равен брой свещи (candleForecastLookback()).
function rollingForecastPct(visible) {
    const hist = candleForecastBase(latestCandles);
    if (!hist || hist.length < 3) return [];
    const W = candleForecastLookback();
    const beta = candleForecastBeta;
    const idx = new Map();
    for (let i = 0; i < hist.length; i++) idx.set(hist[i].time, i);
    const pctOf = c => c.open ? ((c.close - c.open) / c.open) * 100 : 0;
    return visible.map(c => {
        const body = pctOf(c);
        const hi = idx.get(c.time);
        if (hi == null || hi < 2) return { time: c.time, pct: null, body };
        const from = Math.max(0, hi - W);
        const n = hi - from;
        let num = 0, den = 0;
        for (let j = 0; j < n; j++) {
            const age = n === 1 ? 0 : (n - 1 - j) / (n - 1);
            const w = Math.exp(-beta * age);
            num += w * pctOf(hist[from + j]);
            den += w;
        }
        return { time: c.time, pct: den > 0 ? num / den : null, body };
    });
}

// Съхранени точки/геометрия на лентата за hover tooltip.
let _predPoints = [];
let _predGeom = { w: 0, h: 0 };

// Втора лента: предвиден процент (в %) за всяка видима свещ, по времевата ос.
function drawCandlePredictionStrip() {
    const cvs = document.getElementById('candlePredictionCanvas');
    const label = document.getElementById('candlePredictionLabel');
    if (!cvs || !label) return;
    const parent = cvs.parentElement;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    if (w <= 0 || h <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    cvs.width = w * dpr;
    cvs.height = h * dpr;
    cvs.style.width = w + 'px';
    cvs.style.height = h + 'px';
    const ctx = cvs.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    label.textContent = 'Прогноза %';

    const visible = (typeof getVisibleCandles === 'function' ? getVisibleCandles(latestCandles) : latestCandles);
    const data = rollingForecastPct(visible).filter(d => d.pct != null);
    _predPoints = [];
    _predGeom = { w, h };
    if (data.length < 2) return;

    let chartW = w;
    try { const el = document.getElementById('chart'); if (el && el.clientWidth) chartW = el.clientWidth; } catch (e) {}
    const scaleX = chartW > 0 ? (w / chartW) : 1;
    const xOf = (t) => {
        try { const x = chart.timeScale().timeToCoordinate(t); return (x == null) ? null : x * scaleX; } catch (e) { return null; }
    };
    let barW = 4;
    try { const o = chart.timeScale().options(); if (o && o.barSpacing) barW = Math.max(2, o.barSpacing * scaleX * 0.7); } catch (e) {}

    const midY = h / 2;
    const halfH = h / 2 - 4;
    const abs = data.map(d => Math.abs(d.pct)).sort((a, b) => a - b);
    const scale = Math.max(abs[Math.floor(abs.length * 0.9)] || abs[abs.length - 1] || 1, 1e-9);
    const fmt = v => (v >= 0 ? '+' : '') + v.toFixed(2) + '%';

    // нулева линия
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, midY); ctx.lineTo(w, midY); ctx.stroke();

    // скала: пунктирани линии на +scale и -scale
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.setLineDash([3, 3]);
    [scale, -scale].forEach(v => { const y = midY - (v / scale) * halfH; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); });
    ctx.setLineDash([]);
    // етикети на скалата (в %)
    ctx.font = '9px JetBrains Mono';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText(fmt(scale), 4, midY - halfH + 7);
    ctx.fillText('0%', 4, midY);
    ctx.fillText(fmt(-scale), 4, midY + halfH - 7);

    // барове
    for (const d of data) {
        const x = xOf(d.time);
        if (x == null || x < -barW || x > w + barW) continue;
        const up = d.pct >= 0;
        const bh = Math.min(halfH, Math.max(1.5, (Math.abs(d.pct) / scale) * halfH));
        ctx.fillStyle = up ? 'rgba(0,179,255,0.85)' : 'rgba(255,136,0,0.85)';
        if (up) ctx.fillRect(x - barW / 2, midY - bh, barW, bh);
        else ctx.fillRect(x - barW / 2, midY, barW, bh);
        _predPoints.push({ x, time: d.time, pct: d.pct, body: d.body });
    }

    // маркиране на най-високото и най-ниското място
    let maxP = data[0], minP = data[0];
    for (const d of data) { if (d.pct > maxP.pct) maxP = d; if (d.pct < minP.pct) minP = d; }
    const markPoint = (p, isMax) => {
        const x = xOf(p.time);
        if (x == null || x < 0 || x > w) return;
        const y = Math.max(6, Math.min(h - 6, midY - (p.pct / scale) * halfH));
        const col = isMax ? '#00ff66' : '#ff0055';
        ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.stroke();
        ctx.font = '9px JetBrains Mono';
        ctx.textAlign = 'center';
        ctx.textBaseline = isMax ? 'bottom' : 'top';
        ctx.fillText((isMax ? '▲ ' : '▼ ') + (p.pct >= 0 ? '+' : '') + p.pct.toFixed(2) + '%', x, isMax ? y - 5 : y + 5);
    };
    markPoint(maxP, true);
    markPoint(minP, false);
}

// Hover върху лентата → показва конкретните стойности за най-близката свещ.
function onPredictionHover(e) {
    const tip = document.getElementById('candlePredictionTip');
    const cvs = document.getElementById('candlePredictionCanvas');
    if (!tip || !cvs || !_predPoints.length) return;
    const rect = cvs.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    let best = null, bd = Infinity;
    for (const p of _predPoints) { const d = Math.abs(p.x - mx); if (d < bd) { bd = d; best = p; } }
    if (!best || bd > 18) { tip.style.display = 'none'; return; }
    tip.style.display = 'block';
    tip.style.left = Math.max(2, Math.min(Math.max(2, _predGeom.w - 140), best.x - 60)) + 'px';
    const d = new Date(best.time * 1000);
    const tstr = d.toLocaleString('bg-BG', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    tip.innerHTML = `${tstr}<br>Прогноза: <b style="color:#00d0ff">${best.pct >= 0 ? '+' : ''}${best.pct.toFixed(3)}%</b><br>Тяло: ${best.body >= 0 ? '+' : ''}${best.body.toFixed(3)}%`;
}

function hidePredictionTip() {
    const tip = document.getElementById('candlePredictionTip');
    if (tip) tip.style.display = 'none';
}

// Приближава главната графика към края, за да са едри свещите + прогнозните 10.
function zoomCandleForecastChart() {
    if (typeof chart === 'undefined' || !chart || currentPage !== 9) return;
    const n = latestCandles ? latestCandles.length : 0;
    if (n < 2) return;
    const from = Math.max(0, n - 120);
    const to = n + CANDLE_FORECAST_STEPS + 2;
    try { chart.timeScale().setVisibleLogicalRange({ from, to }); } catch (e) {}
}

registerTab({
    index: 9,
    renderPanel: renderCandleForecastPanel,
    drawChart: drawCandleForecastChart
});
