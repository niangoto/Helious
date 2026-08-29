# Agent Guidance: Helious Quantum

## Architecture
- **Single-page app** with a zero-dep Node.js proxy server (`server.js`).
- **UI**: `index.html` (inline CSS, scripts split under `js/`). **Forecast engine**: `forecast.js`.
- **Frontend modules**: `js/config.js` (constants/symbols), `js/state.js` (shared state), `js/data.js` (fetchKlines), `js/news.js` (news view), `js/indicators.js` (RSI + indicator data), `js/app.js` (main app: chart, present line, realtime). Tab algorithms live in `js/tabs/`: `tabs.js` (registry + shared helpers), `indicators.js`, `average.js`, `historical.js`, `logistic.js`, `markov.js`, `expected-value.js`, `wavelet.js`, `fourier.js`, `rsi-phase.js` — each registers a `renderPanel`/`drawChart` pair into `TabRegistry`.
- **Models**: `models.js` (statistical probability models: historical, logistic regression, Markov chain, expected value, wavelet, FFT). **Data provider**: `data-provider.js` (symbol normalization, multi-source data fetching, MT5 bridge).
- **Only CDN dep**: Lightweight Charts 4.1.1 (`unpkg.com`). No `package.json` — never run `npm install/test/start`.
- **UI language**: Bulgarian (`lang="bg"`). All labels, tooltips, and notifications are in Bulgarian.
- **Server** (`server.js`): Static file serving + `/data` endpoint (unified data via `data-provider.js`), `/news` endpoint (RSS Google News→Bing + keyword sentiment), plus legacy `/binance`, `/yahoo`, `/ticker` endpoints.

## Data Flow
1. Client calls `fetchKlines(symbol, interval)` → `/data?symbol=X&interval=Y`
2. `data-provider.js` resolves symbol aliases (e.g. DAX → Yahoo:^GDAXI, MT5:GER40)
3. Tries sources in order: MT5 → Binance Futures → Yahoo Finance
4. Returns normalized candles `[{time, open, high, low, close, volume}]`

## Symbol Aliases
Defined in `data-provider.js` `SYMBOL_ALIASES` table. Canonical names: DAX, NDX, SPX, DJI, CAC, UK100, NI225, EURUSD, GBPUSD, XAUUSD, WTI, BRENT, BTCUSDT, ETHUSDT... Any alias resolves to canonical. Search via `/symbols?query=...`.

## Commands
- **Start**: `node server.js` (listens on `PORT` env var or `3001`).
- **MT5**: Install `MetaTrader5` Python package → `pip install MetaTrader5`. Run `python3 mt5-bridge.py --check` to verify.
- **Tests**: Start server first, then `node scratch/test_endpoints.js` or `node scratch/test_commodities.js`.

## Key Behaviors & Quirks
- **Realtime**: Frontend polls every 5s via `/data`. Forecast NOT re-run on poll — only on explicit triggers (selection change, period change, force reload, present-line drag).
- **Present line**: Draggable vertical line. Drag backwards to lock cutoff → forecast recomputed using candles before that line. Double-click to reset to live.
- **RSI phase tab** (`js/tabs/rsi-phase.js`, page 8): Each period (10м/30м/1ч/4ч/1д/7д/30д) fetches its OWN candle interval (1m/5m/15m/1h/1h/4h/1d) via `/data`, computes RSI, finds alternating peaks/troughs (only values beyond |RSI-50|≥10, strictly alternating max/min, most extreme kept among same-type neighbors). Per period: absolute amplitude (max−min), avgMax/avgMin/avgMid, phase in degrees (−180 at min / 0 at mid / +180 at max). Final output = weighted sum of (phaseDeg × relAmp) → aggregate phase, and aggregate RSI index = 50 + phase/180×50. On this page the FFT forecast overlay is hidden; the RSI peaks (▲) and minima (▼) are drawn on the indicator canvas below the chart. Data is cached per symbol+interval.
- **Force reload**: "Презареди Прогнозата" resets forecast state, unlocks present line, reloads all data.
- **Period configs** (`periodConfigs` in `js/config.js`): Map UI labels to `interval` + `limit`.
- **Custom symbols**: Added via search box are persisted in `localStorage` key `helious_custom_symbols`. Also resolved via data-provider alias table.
- **Port override**: `PORT` env var works (`server.js:6`). Tests assume `3001`.
