// Initialize App
function init() {
    const container = document.getElementById('chart');

    chart = LightweightCharts.createChart(container, {
        layout: {
            background: { color: '#06080f' },
            textColor: '#94a3b8',
            fontSize: 12,
            fontFamily: 'Outfit, sans-serif'
        },
        grid: {
            vertLines: { color: 'rgba(255, 255, 255, 0.02)' },
            horzLines: { color: 'rgba(255, 255, 255, 0.02)' }
        },
        timeScale: {
            borderColor: 'rgba(255, 255, 255, 0.08)',
            timeVisible: true,
            secondsVisible: false,
            barSpacing: 8
        },
        rightPriceScale: {
            borderColor: 'rgba(255, 255, 255, 0.08)',
            alignLabels: true
        },
        crosshair: {
            mode: LightweightCharts.CrosshairMode.Normal,
            vertLine: {
                color: 'rgba(0, 240, 255, 0.25)',
                width: 1,
                style: 3,
                labelBackgroundColor: '#8a2be2'
            },
            horzLine: {
                color: 'rgba(0, 240, 255, 0.25)',
                width: 1,
                style: 3,
                labelBackgroundColor: '#8a2be2'
            }
        }
    });

    candleSeries = chart.addCandlestickSeries({
        upColor: '#00ff66',
        downColor: '#ff0055',
        borderVisible: false,
        wickUpColor: '#00ff66',
        wickDownColor: '#ff0055'
    });

    fftSeries = chart.addLineSeries({
        color: 'rgba(0, 240, 255, 0.75)',
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        lineStyle: 0
    });

    fftForecastSeries = chart.addLineSeries({
        color: 'rgba(138, 43, 226, 0.7)',
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        lineStyle: 2
    });

    setupPresentLine();
    // Build page dots
    const dotContainer = document.getElementById('ivPageDots');
    if (dotContainer) {
        for (let i = 0; i < 9; i++) {
            const dot = document.createElement('div');
            dot.className = 'iv-page-dot' + (i === 0 ? ' active' : '');
            dot.id = 'ivDot' + i;
            dotContainer.appendChild(dot);
        }
    }
    loadData();
    startRealtimePolling();

    // Default to indicator view
    document.getElementById('chart-view').style.display = 'none';
    document.getElementById('indicator-view').style.display = 'flex';
    document.getElementById('viewToggle').classList.add('active');
    document.getElementById('viewToggle').textContent = '📈 Графика';
    ivReload();

    window.addEventListener('resize', () => {
        chart.resize(container.clientWidth, container.clientHeight);
        drawIndicatorCanvases();
        drawFftSpectrum();
    });
    chart.timeScale().subscribeVisibleTimeRangeChange(() => {
        drawIndicatorCanvases();
        if (latestCandles.length) updateFftOverlay(latestCandles);
    });
}

function selectSymbol(sym) {
    currentSymbol = sym;
    latestForecastData = null;
    drawForecast();
    document.getElementById('displaySymbol').innerText = sym.replace('USDT', '') + ' / USDT';
    loadData();
    if (ivCurrentSymbol !== sym) {
        ivCurrentSymbol = sym;
        document.getElementById('ivSearch').value = symbolDetails[sym] ? symbolDetails[sym].name : sym.replace('USDT', '');
        ivDataCache = null;
        ivReload();
    }
}

function changeAnalysisPeriod(period) {
    activePeriod = period;
    latestForecastData = null;
    drawForecast();
    const config = periodConfigs[period];
    currentInterval = config.interval;

    document.getElementById('displayInterval').innerHTML = `<span class="live-dot"></span>Времеви мащаб: ${currentInterval}`;

    document.querySelectorAll('.period-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    document.querySelector(`.period-btn[onclick*="'${period}'"]`)?.classList.add('active');

    ivDataCache = null;
    loadData();
    ivReload();
}

function updateForecastHorizon(val) {
    forecastSteps = parseInt(val);
    latestForecastData = null;
    drawForecast();
    reRunForecast();
}

function showLoading(show) {
    const overlay = document.getElementById('loading-overlay');
    if (show) overlay.classList.add('active');
    else overlay.classList.remove('active');
}

function showNotification(msg, type = 'success') {
    const box = document.getElementById('notification-box');
    const toast = document.createElement('div');
    toast.className = `notification ${type}`;
    toast.innerHTML = `
        <span>${type === 'success' ? '✅' : '❌'}</span>
        <span>${msg}</span>
    `;
    box.appendChild(toast);

    setTimeout(() => toast.classList.add('active'), 50);

    setTimeout(() => {
        toast.classList.remove('active');
        setTimeout(() => toast.remove(), 400);
    }, 3500);
}

async function loadData() {
    showLoading(true);
    try {
        const config = periodConfigs[activePeriod];
        const data = await fetchKlines(currentSymbol, config.interval, config.limit);

        if (data.error || !Array.isArray(data)) {
            throw new Error(data.error || "Грешка при зареждането на пазарните данни.");
        }

        const candles = data.map(d => ({
            time: timeToLocal(d[0] / 1000),
            open: parseFloat(d[1]),
            high: parseFloat(d[2]),
            low: parseFloat(d[3]),
            close: parseFloat(d[4]),
            volume: parseFloat(d[5])
        }));

        candleSeries.setData(candles);
        latestCandles = candles;

        if (!presentLineLocked && candles.length > 0) {
            presentCutoffTime = candles[candles.length - 1].time;
        }
        updatePresentLinePosition();

        const lastClose = candles[candles.length - 1].close;
        const formattedPrice = lastClose.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
        document.getElementById('currentPrice').innerText = `${formattedPrice} USDT`;

        const forecastData = presentLineLocked && presentCutoffTime ?
            candles.filter(c => c.time <= presentCutoffTime) : candles;
        if (typeof runForecast === 'function') runForecast(forecastData);

        updateIndicatorCharts(candles);
        chart.timeScale().fitContent();
    } catch (e) {
        console.error("Data loading error:", e);
        showNotification(`${e.message}`, "error");
        // Clear forecast and candles to avoid stale data
        latestForecastData = null;
        latestFft = null;
        candleSeries.setData([]);
        if (fftSeries) fftSeries.setData([]);
        if (fftForecastSeries) fftForecastSeries.setData([]);
        drawFftSpectrum();
        document.getElementById('currentPrice').innerText = '---';
    } finally {
        showLoading(false);
    }
}

function drawForecast() {
    // Forecast removed — showing only raw price candles
}

function cycleIndicator() {
    indicatorCycle = (indicatorCycle + 1) % 3;
    drawIndicatorCanvases();
}

function toggleView() {
    const chartView = document.getElementById('chart-view');
    const ivView = document.getElementById('indicator-view');
    const btn = document.getElementById('viewToggle');
    const showing = ivView.style.display !== 'none';
    chartView.style.display = showing ? 'flex' : 'none';
    ivView.style.display = showing ? 'none' : 'flex';
    btn.classList.toggle('active', !showing);
    btn.textContent = showing ? '📊 Табло' : '📈 Графика';
    if (!showing) {
        if (!ivDataCache) ivReload();
    } else {
        const c = document.getElementById('chart');
        chart.resize(c.clientWidth, c.clientHeight);
        chart.timeScale().fitContent();
        // Retry drawing canvases until it works
        let tries = 0;
        function tryDraw() {
            drawIndicatorCanvases();
            if (++tries < 10) setTimeout(tryDraw, 200);
        }
        tryDraw();
    }
}

function onIvPageScroll() {
    const pages = document.getElementById('ivPages');
    if (!pages) return;
    const count = 9;
    const idx = Math.round(pages.scrollLeft / pages.clientWidth);
    if (currentPage !== idx) {
        currentPage = idx;
        // Refresh the chart overlay: the FFT forecast line is hidden on the RSI phase page
        if (latestCandles && latestCandles.length) updateFftOverlay(latestCandles);
    }
    for (let i = 0; i < count; i++) {
        const dot = document.getElementById('ivDot' + i);
        if (dot) dot.classList.toggle('active', i === idx);
    }
    const prev = document.getElementById('ivArrowPrev');
    const next = document.getElementById('ivArrowNext');
    if (prev) prev.style.display = 'flex';
    if (next) {
        const labels = ['›', '›', '›', '›', '›', '›', '›', '›', 'A'];
        next.textContent = labels[idx] || '›';
    }
}

function scrollIvPage(dir) {
    const pages = document.getElementById('ivPages');
    if (!pages) return;
    const w = pages.clientWidth;
    const idx = Math.round(pages.scrollLeft / w);
    const target = idx + dir;
    if (dir < 0 && target < 0) return;
    const maxPage = 8;
    if (dir > 0 && target > maxPage) {
        showNotification('Модел A — активен модел', 'success');
        return;
    }
    pages.scrollBy({ left: dir * w, behavior: 'smooth' });
}

function tryAddCustomSymbol(input) {
    // Map display name to ticker if possible
    const upper = input.toUpperCase().trim();
    let sym = upper;
    for (const [k, v] of Object.entries(symbolDetails)) {
        if (v.name.toUpperCase().includes(upper) || k.includes(upper)) { sym = k; break; }
    }
    // Also check Yahoo symbol mapping
    if (YAHOO_SYMBOLS[upper]) sym = upper;
    showLoading(true);
    const trySym = (s) => fetchKlines(s, '1h', 10).then(() => s).catch(() => null);
    trySym(sym).then(ok => ok || trySym(sym + 'USDT')).then(found => {
        const finalSym = found || sym;
        if (!customSymbols.includes(finalSym)) {
            customSymbols.push(finalSym);
            localStorage.setItem('helious_custom_symbols', JSON.stringify(customSymbols));
        }
        showNotification(`Символът ${finalSym} е добавен!`, 'success');
        ivSelectSymbol(finalSym);
    }).catch(() => {
        // Add anyway if user insists
        if (!customSymbols.includes(sym)) {
            customSymbols.push(sym);
            localStorage.setItem('helious_custom_symbols', JSON.stringify(customSymbols));
        }
        showNotification(`Символът ${sym} е добавен (без Binance проверка)`, 'success');
        ivSelectSymbol(sym);
    }).finally(() => showLoading(false));
}

function ivFilterSymbols(q) {
    const results = document.getElementById('ivSearchResults');
    if (!results) return;
    const query = q.toUpperCase().trim();
    if (API_BASE && query.length >= 1) {
        fetch(`${API_BASE}/symbols?query=${encodeURIComponent(query)}`).then(r => r.json()).then(list => {
            results.innerHTML = list.map(s =>
                `<div onclick="ivSelectSymbol('${s.canonical}')">${s.canonical} <span style="color:var(--text-dim);font-size:11px">${s.alias !== s.canonical ? s.alias : ''}</span></div>`
            ).join('');
            results.style.display = list.length ? 'block' : 'none';
        }).catch(() => {});
    } else if (query.length >= 1) {
        // Fallback for direct mode (no proxy)
        const all = getFullSymbolList();
        const filtered = all.filter(s => s.includes(query) || (symbolDetails[s]?.name || '').toUpperCase().includes(query)).slice(0, 15);
        results.innerHTML = filtered.map(s =>
            `<div onclick="ivSelectSymbol('${s}')">${symbolDetails[s] ? symbolDetails[s].name : s.replace('USDT','')} <span style="color:var(--text-dim);font-size:11px">${s}</span></div>`
        ).join('');
        results.style.display = filtered.length ? 'block' : 'none';
    } else {
        results.style.display = 'none';
    }
}

function ivShowResults() {
    const inp = document.getElementById('ivSearch');
    if (inp) ivFilterSymbols(inp.value);
}

function ivSelectSymbol(sym) {
    ivCurrentSymbol = sym;
    const inp = document.getElementById('ivSearch');
    if (inp) {
        const displayName = symbolDetails[sym] ? symbolDetails[sym].name : sym.replace('USDT', '');
        if (inp.value !== displayName) inp.value = displayName;
    }
    const r = document.getElementById('ivSearchResults');
    if (r) r.style.display = 'none';
    ivReload();
    if (currentSymbol !== sym) {
        currentSymbol = sym;
        latestForecastData = null;
        document.getElementById('displaySymbol').innerText = sym.replace('USDT', '') + ' / USDT';
        loadData();
    }
}

document.addEventListener('click', (e) => {
    const r = document.getElementById('ivSearchResults');
    if (r && !e.target.closest('.iv-search-wrapper')) r.style.display = 'none';
});

async function ivReload() {
    const ivEl = document.getElementById('indicator-view');
    ivEl.style.opacity = '0.4';
    const sym = ivCurrentSymbol;
    const period = activePeriod;
    const config = periodConfigs[period];
    if (!config) { ivEl.style.opacity = '1'; return; }
    try {
        const data = await fetchKlines(sym, config.interval, config.limit);
        if (data.code === -1121 || data.error || !Array.isArray(data)) {
            document.getElementById('ivRsiVal').textContent = 'N/A';
            document.getElementById('ivVolVal').textContent = 'N/A';
            document.getElementById('ivObvVal').textContent = 'N/A';
            ivEl.style.opacity = '1';
            return;
        }
        const candles = data.map(d => ({
            time: timeToLocal(d[0] / 1000),
            open: parseFloat(d[1]),
            high: parseFloat(d[2]),
            low: parseFloat(d[3]),
            close: parseFloat(d[4]),
            volume: parseFloat(d[5])
        }));
        ivDataCache = candles;
        updateIvPanel(candles);
    } catch (e) {
        document.getElementById('ivRsiVal').textContent = '--';
        document.getElementById('ivVolVal').textContent = '--';
        document.getElementById('ivObvVal').textContent = '--';
        ['modHist','modLog','modMarkov','modEv','modWavelet','modFft'].forEach(p => {
            const b = document.getElementById(p + 'Buy');
            const s = document.getElementById(p + 'Sell');
            if (b) b.textContent = '--';
            if (s) s.textContent = '--';
        });
        console.error('ivReload error:', e);
    }
    ivEl.style.opacity = '1';
}

function openHermes(modelIndex) {
    const sym = ivCurrentSymbol || currentSymbol;
    const url = `hermes.html?symbol=${encodeURIComponent(sym)}&period=${encodeURIComponent(activePeriod)}&model=${modelIndex}`;
    const w = window.open(url, 'hermes', 'width=1180,height=800');
    if (!w) {
        showNotification('Хермес е блокиран — разрешете изскачащите прозорци', 'error');
    }
}

function reRunForecast() {
    if (!latestCandles || latestCandles.length < 10) return;
    const used = presentCutoffTime ? latestCandles.filter(c => c.time <= presentCutoffTime) : latestCandles;
    if (used.length >= 10 && typeof runForecast === 'function') runForecast(used);
}

async function forceReloadForecast() {
    showLoading(true);
    showNotification('Презареждане на прогнозата...', 'success');

    presentLineLocked = false;

    await loadData();
    reRunForecast();
    showLoading(false);
}

async function loadRealtimeData() {
    if (isRealtimeLoading) return;
    isRealtimeLoading = true;
    try {
        const config = periodConfigs[activePeriod];
        const data = await fetchKlines(currentSymbol, config.interval, config.limit);

        if (data.error || !Array.isArray(data)) {
            throw new Error(data.error || "Грешка при зареждането на пазарните данни.");
        }

        const candles = data.map(d => ({
            time: timeToLocal(d[0] / 1000),
            open: parseFloat(d[1]),
            high: parseFloat(d[2]),
            low: parseFloat(d[3]),
            close: parseFloat(d[4]),
            volume: parseFloat(d[5])
        }));

        candleSeries.setData(candles);
        latestCandles = candles;
        updateIndicatorCharts(candles);

        const lastClose = candles[candles.length - 1].close;
        const formattedPrice = lastClose.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
        document.getElementById('currentPrice').innerText = `${formattedPrice} USDT`;

        if (!presentLineLocked && candles.length > 0) {
            presentCutoffTime = candles[candles.length - 1].time;
        }
        updatePresentLinePosition();
    } catch (e) {
        console.warn("Silent realtime load failed:", e);
    } finally {
        isRealtimeLoading = false;
    }
}

function startRealtimePolling() {
    if (realtimeInterval) clearInterval(realtimeInterval);
    realtimeInterval = setInterval(loadRealtimeData, 5000);
}

// --- Present line: drag handling and helpers ---
function setupPresentLine() {
    const line = document.getElementById('presentLine');
    const label = document.getElementById('presentLineLabel');
    let dragging = false;

    function clientXToChartTime(clientX) {
        const container = document.getElementById('chart');
        const rect = container.getBoundingClientRect();
        const x = clientX - rect.left;
        try {
            const time = chart.timeScale().coordinateToTime(x);
            return time;
        } catch (e) {
            return null;
        }
    }

    function updatePresentLinePosition() {
        const container = document.getElementById('chart');
        const rect = container.getBoundingClientRect();
        if (!presentCutoffTime) {
            line.style.display = 'none';
            return;
        }
        const coord = chart.timeScale().timeToCoordinate(presentCutoffTime);
        if (coord == null || isNaN(coord)) {
            line.style.display = 'none';
            return;
        }
        line.style.display = 'block';
        const left = Math.round(coord + rect.left - rect.left);
        line.style.left = `${left}px`;
        const d = new Date(presentCutoffTime * 1000);
        label.innerText = presentLineLocked ? `Cutoff: ${d.toLocaleString()}` : `СЕГА`;
    }

    function onPointerDown(e) {
        dragging = true;
        presentLineLocked = true;
        line.classList.add('dragging');
        document.body.style.userSelect = 'none';
    }

    function onPointerMove(e) {
        if (!dragging) return;
        const time = clientXToChartTime(e.clientX);
        if (!time) return;
        presentCutoffTime = Math.floor(time);
        updatePresentLinePosition();
    }

    function onPointerUp(e) {
        if (!dragging) return;
        dragging = false;
        document.body.style.userSelect = '';
        line.classList.remove('dragging');
        if (latestCandles && latestCandles.length > 0) {
            const used = latestCandles.filter(c => c.time <= presentCutoffTime);
            if (used.length >= 10 && typeof runForecast === 'function') runForecast(used);
        }
    }

    line.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);

    line.addEventListener('dblclick', () => {
        presentLineLocked = false;
        if (latestCandles && latestCandles.length > 0) {
            presentCutoffTime = latestCandles[latestCandles.length - 1].time;
        }
        updatePresentLinePosition();
        if (latestCandles && latestCandles.length > 0 && typeof runForecast === 'function') runForecast(latestCandles);
        showNotification('Линията беше възстановена до сегашното време', 'success');
    });

    window.addEventListener('resize', updatePresentLinePosition);
    try {
        chart.timeScale().subscribeVisibleTimeRangeChange(updatePresentLinePosition);
    } catch (e) {}
    window.updatePresentLinePosition = updatePresentLinePosition;
}

// Service Worker за PWA
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
}

init();
