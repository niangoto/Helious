// Page 0: Показатели — RSI, Volume, OBV gauges + RSI line on the chart canvas.
registerTab({
    index: 0,
    renderPanel: function (candles) {
        const period = 14;
        const rsiVals = computeRSI(candles, period);
        const lastRsi = rsiVals.length > 0 ? +rsiVals[rsiVals.length - 1].toFixed(1) : 50;
        const rsiEl = document.getElementById('ivRsiVal');
        const rsiGauge = document.getElementById('ivRsiGauge');
        rsiEl.textContent = lastRsi.toFixed(1) + '%';
        rsiEl.className = 'iv-card-value ' + (lastRsi > 70 ? 'up' : lastRsi < 30 ? 'down' : 'neutral');
        rsiGauge.style.width = Math.min(100, lastRsi) + '%';
        rsiGauge.className = 'iv-gauge-fill ' + (lastRsi > 70 ? 'rsi-high' : lastRsi < 30 ? 'rsi-low' : 'rsi-mid');

        const vols = candles.map(c => c.volume || 0);
        const volMax = Math.max(...vols);
        const volMin = Math.min(...vols);
        const lastVol = vols[vols.length - 1];
        const volPct = volMax > volMin ? ((lastVol - volMin) / (volMax - volMin)) * 100 : 50;
        const volEl = document.getElementById('ivVolVal');
        const volGauge = document.getElementById('ivVolGauge');
        volEl.textContent = volPct.toFixed(1) + '%';
        volEl.className = 'iv-card-value ' + (volPct > 55 ? 'up' : volPct < 45 ? 'down' : 'neutral');
        volGauge.style.width = Math.min(100, Math.max(0, volPct)) + '%';
        volGauge.className = 'iv-gauge-fill ' + (volPct >= 0 ? 'positive' : 'negative');

        const histEl = document.getElementById('ivVolHist');
        const recent = vols.slice(-30);
        const localMin = Math.min(...recent);
        const localRange = (Math.max(...recent) - localMin) || 1;
        histEl.innerHTML = recent.map(v =>
            `<div style="height:${Math.max(5, ((v - localMin) / localRange) * 100)}%;background:#26a69a"></div>`
        ).join('');

        const obvVals = [0];
        for (let i = 1; i < candles.length; i++) {
            const v = candles[i].volume || 0;
            if (candles[i].close > candles[i - 1].close) obvVals.push(obvVals[i - 1] + v);
            else if (candles[i].close < candles[i - 1].close) obvVals.push(obvVals[i - 1] - v);
            else obvVals.push(obvVals[i - 1]);
        }
        const obvAvg = obvVals.reduce((a, b) => a + b, 0) / obvVals.length;
        const obvMax = Math.max(...obvVals);
        const obvDiff = obvMax - obvAvg || 1;
        const lastObv = obvVals[obvVals.length - 1];
        const obvPct = ((lastObv - obvAvg) / obvDiff) * 100;
        const obvEl = document.getElementById('ivObvVal');
        const obvGauge = document.getElementById('ivObvGauge');
        obvEl.textContent = (obvPct >= 0 ? '+' : '') + obvPct.toFixed(1) + '%';
        obvEl.className = 'iv-card-value ' + (obvPct >= 0 ? 'up' : 'down');
        obvGauge.style.width = Math.min(100, Math.max(0, obvPct)) + '%';
        obvGauge.className = 'iv-gauge-fill ' + (obvPct >= 0 ? 'positive' : 'negative');

        const obvMin = Math.min(...obvVals);
        const obvMinMaxPct = obvMax > obvMin ? ((lastObv - obvMin) / (obvMax - obvMin)) * 100 : 50;
        document.getElementById('ivObvPctVal').textContent = obvMinMaxPct.toFixed(1) + '%';
    },
    drawChart: function (ctx, w, h, label) {
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
        [70, 30].forEach(val => { const y = toY(val); if (y >= 0 && y <= h) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.strokeStyle = 'rgba(255,255,255,0.1)'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]); ctx.stroke(); ctx.setLineDash([]); } });
        label.textContent = 'RSI';
        ctx.beginPath();
        pts.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, toY(p.y)); else ctx.lineTo(p.x, toY(p.y)); });
        ctx.strokeStyle = '#b450ff'; ctx.lineWidth = 1.5; ctx.stroke();
    }
});
