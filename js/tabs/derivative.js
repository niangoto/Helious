// Page 10: Производна на кривата (без вероятност).
// Показва свещи + изгладена крива (SMA) и под тях производната на кривата
// (процентно изменение на SMA за един бар). Не използва модели/вероятности.

(function () {
    let derivCandles = [];
    let derivBound = false;

    function derivPeriod() {
        const el = document.getElementById('derivativePeriod');
        const v = el ? parseInt(el.value, 10) : 20;
        return Math.max(2, Math.min(500, v || 20));
    }

    // 1 = първа производна, 2 = производна на производната.
    function derivOrder() {
        const el = document.getElementById('derivativeOrder');
        return el && parseInt(el.value, 10) === 2 ? 2 : 1;
    }

    // Проста плъзгаща средна (SMA) върху затварящите цени.
    function derivSma(values, period) {
        const out = new Array(values.length).fill(null);
        let sum = 0;
        for (let i = 0; i < values.length; i++) {
            sum += values[i] || 0;
            if (i >= period) sum -= values[i - period] || 0;
            if (i >= period - 1) out[i] = sum / period;
        }
        return out;
    }

    // Производна: (SMA[i] − SMA[i−1]) / SMA[i−1] × 100 (% за бар).
    function derivSeries(sma) {
        const out = new Array(sma.length).fill(null);
        for (let i = 1; i < sma.length; i++) {
            if (sma[i] != null && sma[i - 1] != null && sma[i - 1] !== 0) {
                out[i] = ((sma[i] - sma[i - 1]) / sma[i - 1]) * 100;
            }
        }
        return out;
    }

    // Втора производна: изменение на първата за един бар.
    function derivSecond(d1) {
        const out = new Array(d1.length).fill(null);
        for (let i = 1; i < d1.length; i++) {
            if (d1[i] != null && d1[i - 1] != null) out[i] = d1[i] - d1[i - 1];
        }
        return out;
    }

    function derivUnit(order) {
        return order === 2 ? '%/бар²' : '%/бар';
    }

    function fmtPrice(v) {
        if (v == null || !isFinite(v)) return '---';
        const abs = Math.abs(v);
        const frac = abs >= 1000 ? 2 : abs >= 1 ? 4 : 6;
        return v.toLocaleString('en-US', { minimumFractionDigits: frac, maximumFractionDigits: frac });
    }

    function fmtTime(t) {
        try {
            return new Date(t * 1000).toLocaleString('bg-BG', {
                day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
            });
        } catch (e) { return ''; }
    }

    function bindDerivUI() {
        if (derivBound) return;
        derivBound = true;
        const sel = document.getElementById('derivativePeriod');
        if (sel) sel.addEventListener('change', drawDerivativePage);
        const orderSel = document.getElementById('derivativeOrder');
        if (orderSel) orderSel.addEventListener('change', drawDerivativePage);
        window.addEventListener('resize', () => {
            if (derivCandles.length) drawDerivativePage();
        });
    }

    function drawDerivativePage() {
        const cvs = document.getElementById('derivativeCanvas');
        const info = document.getElementById('derivativeInfo');
        if (!cvs) return;
        const wrap = cvs.parentElement;
        const w = wrap ? wrap.clientWidth : cvs.clientWidth;
        const h = wrap ? wrap.clientHeight : cvs.clientHeight;
        if (w <= 0 || h <= 0) return;

        const dpr = window.devicePixelRatio || 1;
        cvs.width = Math.round(w * dpr);
        cvs.height = Math.round(h * dpr);
        cvs.style.width = w + 'px';
        cvs.style.height = h + 'px';
        const ctx = cvs.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);

        const candles = derivCandles || [];
        if (candles.length < 3) {
            if (info) info.textContent = 'Няма достатъчно данни.';
            return;
        }

        const period = derivPeriod();
        const order = derivOrder();
        const closes = candles.map(c => c.close);
        const sma = derivSma(closes, period);
        const d1 = derivSeries(sma);
        const deriv = order === 2 ? derivSecond(d1) : d1;

        const padL = 54, padR = 12, padT = 12, padB = 18;
        const plotW = Math.max(10, w - padL - padR);
        const totalH = h - padT - padB;
        let priceH = Math.round(totalH * 0.60);
        const gap = 22;
        let dTop = padT + priceH + gap;
        let dH = h - padB - dTop;
        if (dH < 40) {
            dH = 40;
            priceH = Math.max(60, totalH - gap - dH);
            dTop = padT + priceH + gap;
        }

        const maxBars = Math.max(40, Math.min(340, Math.floor(plotW / 3.2)));
        const from = Math.max(0, candles.length - maxBars);
        const view = candles.slice(from);
        const smaView = sma.slice(from);
        const derView = deriv.slice(from);
        if (view.length < 2) {
            if (info) info.textContent = 'Няма достатъчно данни.';
            return;
        }

        let pMin = Infinity, pMax = -Infinity;
        for (const c of view) {
            pMin = Math.min(pMin, c.low);
            pMax = Math.max(pMax, c.high);
        }
        for (const v of smaView) {
            if (v != null) { pMin = Math.min(pMin, v); pMax = Math.max(pMax, v); }
        }
        if (!(pMax > pMin)) { pMin -= 1; pMax += 1; }
        const pPad = (pMax - pMin) * 0.05;
        pMin -= pPad; pMax += pPad;

        let dAbs = 0;
        for (const v of derView) if (v != null) dAbs = Math.max(dAbs, Math.abs(v));
        if (!(dAbs > 0)) dAbs = 0.01;
        const dMin = -dAbs * 1.15, dMax = dAbs * 1.15;

        const X = i => padL + (i + 0.5) * (plotW / view.length);
        const Yp = v => padT + ((pMax - v) / (pMax - pMin)) * priceH;
        const Yd = v => dTop + ((dMax - v) / (dMax - dMin)) * dH;

        // ── Цена: решетка и скала ──
        ctx.font = '9px JetBrains Mono';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
        ctx.lineWidth = 1;
        for (let k = 0; k <= 4; k++) {
            const v = pMax - (pMax - pMin) * k / 4;
            const y = Yp(v);
            ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
            ctx.fillStyle = 'rgba(255,255,255,0.45)';
            ctx.fillText(fmtPrice(v), padL - 6, y);
        }

        // ── Свещи ──
        const barW = plotW / view.length;
        const bodyW = Math.max(1, Math.min(7, barW * 0.62));
        for (let i = 0; i < view.length; i++) {
            const c = view[i];
            const x = X(i);
            const up = c.close >= c.open;
            ctx.strokeStyle = up ? 'rgba(0,255,102,0.9)' : 'rgba(255,59,92,0.9)';
            ctx.fillStyle = ctx.strokeStyle;
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(x, Yp(c.high)); ctx.lineTo(x, Yp(c.low)); ctx.stroke();
            const yO = Yp(c.open), yC = Yp(c.close);
            const top = Math.min(yO, yC);
            const hgt = Math.max(1, Math.abs(yC - yO));
            ctx.fillRect(x - bodyW / 2, top, bodyW, hgt);
        }

        // ── Крива (SMA) ──
        ctx.beginPath();
        let started = false;
        smaView.forEach((v, i) => {
            if (v == null) return;
            const x = X(i), y = Yp(v);
            if (!started) { ctx.moveTo(x, y); started = true; }
            else ctx.lineTo(x, y);
        });
        ctx.strokeStyle = '#00f0ff';
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText('Цена · свещи + SMA(' + period + ')', padL + 4, padT + 3);

        // ── Разделител ──
        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.beginPath(); ctx.moveTo(padL, dTop - gap / 2); ctx.lineTo(w - padR, dTop - gap / 2); ctx.stroke();

        // ── Производна: решетка, нула и скала ──
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (let k = 0; k <= 4; k++) {
            const v = dMax - (dMax - dMin) * k / 4;
            const y = Yd(v);
            ctx.strokeStyle = 'rgba(255,255,255,0.06)';
            ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
            ctx.fillStyle = 'rgba(255,255,255,0.45)';
            ctx.fillText((v >= 0 ? '+' : '') + v.toFixed(3) + '%', padL - 6, y);
        }
        const zeroY = Yd(0);
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(padL, zeroY); ctx.lineTo(w - padR, zeroY); ctx.stroke();
        ctx.setLineDash([]);

        // ── Производна: линия ──
        ctx.beginPath();
        started = false;
        derView.forEach((v, i) => {
            if (v == null) return;
            const x = X(i), y = Yd(v);
            if (!started) { ctx.moveTo(x, y); started = true; }
            else ctx.lineTo(x, y);
        });
        ctx.strokeStyle = '#ffb020';
        ctx.lineWidth = 1.8;
        ctx.stroke();

        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText((order === 2 ? 'Втора производна' : 'Производна') + ' (' + derivUnit(order) + ')', padL + 4, dTop + 3);

        // ── Времева ос ──
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(fmtTime(view[0].time), padL, h - 14);
        ctx.textAlign = 'right';
        ctx.fillText(fmtTime(view[view.length - 1].time), w - padR, h - 14);

        // ── Текущи стойности ──
        const last = candles.length - 1;
        const curSma = sma[last];
        const curDer = deriv[last];
        if (info) {
            info.textContent = 'Цена ' + fmtPrice(candles[last].close) +
                ' · SMA(' + period + ') ' + fmtPrice(curSma) +
                ' · ' + (order === 2 ? 'd² ' : 'd ') +
                (curDer == null ? '—' : ((curDer >= 0 ? '+' : '') + curDer.toFixed(3) + derivUnit(order)));
        }
        const legend = document.querySelector('.derivative-legend');
        if (legend) {
            legend.textContent = 'Свещи · SMA(' + period + ') крива · ' +
                (order === 2 ? 'втора производна (%/бар²)' : 'производна (%/бар)');
        }
    }

    // Малка лента под основната графика (при отворена графика на тази страница).
    function drawDerivativeStrip(ctx, w, h, label) {
        const candles = (typeof candlesUpToCutoff === 'function')
            ? candlesUpToCutoff(typeof latestCandles !== 'undefined' ? latestCandles : null)
            : ((typeof ivPanelCandles !== 'undefined' && ivPanelCandles) ? ivPanelCandles : []);
        if (!candles || candles.length < 3 || typeof chart === 'undefined' || !chart) {
            label.textContent = 'Производна';
            return;
        }
        const period = derivPeriod();
        const order = derivOrder();
        const closes = candles.map(c => c.close);
        const sma = derivSma(closes, period);
        const d1 = derivSeries(sma);
        const deriv = order === 2 ? derivSecond(d1) : d1;
        let range = null;
        try { range = chart.timeScale().getVisibleRange(); } catch (e) { range = null; }

        const pts = [];
        for (let i = 1; i < candles.length; i++) {
            const t = candles[i].time;
            if (range && (t < range.from || t > range.to)) continue;
            if (deriv[i] == null) continue;
            let x = null;
            try { x = chart.timeScale().timeToCoordinate(t); } catch (e) { x = null; }
            if (x == null) continue;
            pts.push({ x, v: deriv[i] });
        }
        label.textContent = (order === 2 ? '2-ра производна' : 'Производна') + ' (' + period + ')';
        if (pts.length < 2) return;

        let abs = 0;
        for (const p of pts) abs = Math.max(abs, Math.abs(p.v));
        if (!(abs > 0)) abs = 0.01;
        const toY = v => h - ((v + abs * 1.15) / (abs * 2.3)) * (h - 8) - 4;
        const zeroY = toY(0);
        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(0, zeroY); ctx.lineTo(w, zeroY); ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        pts.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, toY(p.v)); else ctx.lineTo(p.x, toY(p.v)); });
        ctx.strokeStyle = '#ffb020';
        ctx.lineWidth = 1.5;
        ctx.stroke();
    }

    registerTab({
        index: 10,
        renderPanel: function (candles) {
            derivCandles = candles || [];
            bindDerivUI();
            drawDerivativePage();
        },
        drawChart: drawDerivativeStrip
    });
})();
