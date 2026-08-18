// Tab registry + shared helpers for the 8 swipeable indicator pages.
const TabRegistry = [];

function registerTab(tab) {
    TabRegistry[tab.index] = tab;
}

// Update all tab panels from current candles. Called by ivReload().
function updateIvPanel(candles) {
    if (!candles || candles.length < 25) return;
    const models = computeAllModels(candles);
    TabRegistry.forEach(tab => {
        if (tab && typeof tab.renderPanel === 'function') {
            try {
                tab.renderPanel(candles, models);
            } catch (e) {
                console.error(`Tab[${tab.index}] renderPanel error:`, e);
            }
        }
    });
}

// Set up the shared canvas and delegate drawing to the active tab.
function drawIndicatorCanvases() {
    const cvs = document.getElementById('chartIndicatorCanvas');
    const label = document.getElementById('chartIndicatorLabel');
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

    if (!indicatorData.rsi.length) return;

    const tab = TabRegistry[currentPage];
    if (tab && typeof tab.drawChart === 'function') {
        try {
            tab.drawChart(ctx, w, h, label);
        } catch (e) {
            console.error(`Tab[${tab.index}] drawChart error:`, e);
        }
    }
}

// Shared DOM helper: update Buy/Sell cards, gauges, bars and labels for a model.
function setModelDisplay(prefix, buyPct, sellPct) {
    const bEl = document.getElementById(prefix + 'Buy');
    const sEl = document.getElementById(prefix + 'Sell');
    const bGauge = document.getElementById(prefix + 'BuyGauge');
    const sGauge = document.getElementById(prefix + 'SellGauge');
    const bBar = document.getElementById(prefix + 'BuyBar');
    const sBar = document.getElementById(prefix + 'SellBar');
    const bLbl = document.getElementById(prefix + 'BuyLbl');
    const sLbl = document.getElementById(prefix + 'SellLbl');
    const total = buyPct + sellPct || 1;
    const bNorm = (buyPct / total) * 100;
    const sNorm = (sellPct / total) * 100;
    if (bEl) { bEl.textContent = buyPct.toFixed(1) + '%'; bEl.className = 'iv-card-value ' + (buyPct > 55 ? 'up' : buyPct < 45 ? 'down' : 'neutral'); }
    if (sEl) { sEl.textContent = sellPct.toFixed(1) + '%'; sEl.className = 'iv-card-value ' + (sellPct > 55 ? 'up' : sellPct < 45 ? 'down' : 'neutral'); }
    if (bGauge) bGauge.style.width = buyPct + '%';
    if (sGauge) sGauge.style.width = sellPct + '%';
    if (bBar) bBar.style.width = bNorm + '%';
    if (sBar) sBar.style.width = sNorm + '%';
    if (bLbl) bLbl.textContent = 'Buy ' + buyPct.toFixed(0) + '%';
    if (sLbl) sLbl.textContent = 'Sell ' + sellPct.toFixed(0) + '%';
}

// Shared canvas helper: draw a probability line (0-100% buy scale) over the chart range.
function drawProbLine(ctx, w, h, probData) {
    let range = chart.timeScale().getVisibleRange();
    if (!range && probData.length > 1) range = { from: probData[0].time, to: probData[probData.length - 1].time };
    if (!range) return;

    const leftX = chart.timeScale().timeToCoordinate(range.from);
    const rightX = chart.timeScale().timeToCoordinate(range.to);
    const plotW = rightX - leftX;
    if (!plotW || plotW <= 0) return;

    const vis = probData.filter(p => p.time >= range.from && p.time <= range.to && p.value !== null);
    if (vis.length < 2) return;
    const pts = vis.map(p => ({ x: chart.timeScale().timeToCoordinate(p.time), y: p.value })).filter(p => p.x !== null);
    if (pts.length < 2) return;

    const toY = (v) => h - (v / 100) * (h - 8) - 4;
    const midY = toY(50);

    // Axis labels: 0 at middle, ±100 at extremes
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    [
        { v: 100, label: 'Buy 100' },
        { v: 75, label: 'Buy 50' },
        { v: 50, label: '0' },
        { v: 25, label: 'Sell 50' },
        { v: 0, label: 'Sell 100' }
    ].forEach(({ v, label }) => {
        const y = toY(v);
        ctx.fillStyle = v === 50 ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.35)';
        ctx.font = 'bold 10px JetBrains Mono';
        ctx.fillText(label, leftX - 6, y);
    });

    // Draw only within plot area
    ctx.save();
    ctx.beginPath(); ctx.rect(leftX, 0, plotW, h); ctx.clip();

    // Background zones
    ctx.fillStyle = 'rgba(0,255,102,0.06)';
    ctx.fillRect(leftX, 0, plotW, midY);
    ctx.fillStyle = 'rgba(255,0,85,0.06)';
    ctx.fillRect(leftX, midY, plotW, h - midY);

    // Gridlines
    const gridVals = [0, 25, 50, 75, 100];
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
    gridVals.forEach(v => {
        const y = toY(v);
        ctx.beginPath(); ctx.moveTo(leftX, y); ctx.lineTo(rightX, y); ctx.stroke();
    });
    ctx.setLineDash([]);

    // 50% line (solid)
    ctx.strokeStyle = 'rgba(255,255,255,0.2)'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(leftX, midY); ctx.lineTo(rightX, midY); ctx.stroke();
    ctx.setLineDash([]);

    // Probability line (single red line, 0-100% buy scale)
    ctx.beginPath();
    pts.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, toY(p.y)); else ctx.lineTo(p.x, toY(p.y)); });
    ctx.strokeStyle = '#ff3344';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.restore();
}

// Return the subset of candles currently visible on the chart (with safety checks).
function getVisibleCandles(candles) {
    try {
        const range = chart.timeScale().getVisibleRange();
        if (range && range.from && range.to) {
            // When the symbol changes, the visible range may still belong to the
            // PREVIOUS symbol; only filter when the range ends near the last candle
            // of the current symbol (difference <= 3 steps).
            const lastTime = candles[candles.length - 1].time;
            const step = candles.length > 1 ? (candles[candles.length - 1].time - candles[0].time) / (candles.length - 1) : 60;
            if (Math.abs(range.to - lastTime) > step * 3) return candles;
            const vis = candles.filter(c => c.time >= range.from && c.time <= range.to);
            if (vis.length >= 16) return vis;
        }
    } catch (e) {}
    return candles;
}
