// Page 7: ПРЕОБРАЗУВАНИЕ НА ФУРИЕ (FFT) — dominant sinusoids, spectrum canvas + bins.
registerTab({
    index: 7,
    renderPanel: function (candles, models) {
        if (!models) return;
        const m = models.models.fourier;
        setModelDisplay('modFft', m.buyPct, m.sellPct);
        updateFftBins(candles);
    },
    drawChart: function (ctx, w, h, label) {
        const d = indicatorData;
        if (!d.modelProbs || !d.modelProbs[5]) return;
        label.textContent = 'Фурие (FFT) вероятност';
        drawProbLine(ctx, w, h, d.modelProbs[5]);
    }
});

// Recompute the FFT on the visible candles and refresh chart overlay + spectrum.
function updateFftOverlay(candles) {
    // На страниците с RSI фаза (8) и прогноза на свещи (9) графиката НЕ трябва да
    // показва FFT прогнозната линия — вместо нея отдолу се рисуват пикове/свещи.
    const hiddenOnPhasePage = typeof currentPage === 'number' && (currentPage === 8 || currentPage === 9);
    if (typeof computeFourierAnalysis !== 'function' || !candles || candles.length < 16) {
        latestFft = null;
        if (fftSeries) fftSeries.setData([]);
        if (fftForecastSeries) fftForecastSeries.setData([]);
        drawFftSpectrum();
        return;
    }
    const vis = getVisibleCandles(candles);
    latestFft = computeFourierAnalysis(vis);
    if (!latestFft) {
        if (fftSeries) fftSeries.setData([]);
        if (fftForecastSeries) fftForecastSeries.setData([]);
        drawFftSpectrum();
        return;
    }
    if (fftSeries) fftSeries.setData(hiddenOnPhasePage ? [] : latestFft.reconstruction);
    if (fftForecastSeries) fftForecastSeries.setData(hiddenOnPhasePage ? [] : latestFft.forecast);
    drawFftSpectrum();
}

function drawFftSpectrum() {
    const cvs = document.getElementById('fftSpectrumCanvas');
    const label = document.getElementById('fftSpectrumLabel');
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
    if (!latestFft || !latestFft.spectrum || !latestFft.spectrum.length) {
        label.textContent = 'FFT Спектър';
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        ctx.font = '10px JetBrains Mono';
        ctx.fillText('—', w / 2, h / 2);
        return;
    }
    const spec = latestFft.spectrum;
    const maxAmp = Math.max(...spec.map(s => s.amplitude), 1e-6);
    const binW = w / spec.length;
    const baseY = h - 4;
    const maxH = h - 12;
    ctx.font = '9px JetBrains Mono';
    spec.forEach((s, i) => {
        const barH = Math.max(2, (s.amplitude / maxAmp) * maxH);
        const x = i * binW + binW / 2;
        const grad = ctx.createLinearGradient(0, baseY - barH, 0, baseY);
        grad.addColorStop(0, 'rgba(0, 240, 255, 0.9)');
        grad.addColorStop(1, 'rgba(138, 43, 226, 0.4)');
        ctx.fillStyle = grad;
        ctx.fillRect(x - binW * 0.3, baseY - barH, binW * 0.6, barH);
    });
    // Frequency labels: period in bars for top-3 components
    const top3 = spec.slice(0, 3);
    const visRange = latestFft.reconstruction.length > 1 ? (latestFft.reconstruction[latestFft.reconstruction.length - 1].time - latestFft.reconstruction[0].time) / (latestFft.reconstruction.length - 1) : 60;
    top3.forEach((s, i) => {
        const periodBars = visRange > 0 ? Math.max(1, Math.round(1 / (s.freq || 1e-6))) : '?';
        const x = (i + 0.5) * (w / top3.length);
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.textAlign = 'center';
        ctx.fillText(String(periodBars) + 'б', x, h - 5);
    });
    label.textContent = 'FFT Спектър';
}

function updateFftBins(candles) {
    const binsEl = document.getElementById('fftBins');
    if (!binsEl) return;
    if (typeof computeFourierAnalysis !== 'function') return;
    const vis = getVisibleCandles(candles);
    const fft = computeFourierAnalysis(vis);
    if (!fft || !fft.spectrum || !fft.spectrum.length) {
        binsEl.innerHTML = '';
        return;
    }
    const rangeBars = vis.length > 1 ? (vis[vis.length - 1].time - vis[0].time) / (vis.length - 1) : 60;
    const top = fft.spectrum.slice(0, 5);
    binsEl.innerHTML = '<div class="iv-section-label" style="margin:6px 0 2px">Доминантни синусоиди</div>' +
        top.map(s => {
            const periodBars = rangeBars > 0 ? Math.max(1, Math.round(1 / (s.freq || 1e-6))) : '?';
            const ampPrice = (s.amplitude * 100).toFixed(3) + '%';
            return `<div class="iv-fft-bin"><span class="iv-fft-freq">${s.freq.toFixed(4)} c/бр</span><span>Период: ${periodBars} бр</span><span>Амплитуда: ${ampPrice}</span></div>`;
        }).join('');
}
