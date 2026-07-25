# Agent Guidance: Helious Quantum

## Architecture
- **Single-page app** with a zero-dep Node.js proxy server (`server.js`).
- **UI**: `index.html` (inline CSS + inline JS). **Forecast engine**: `forecast.js` (attaches `window.runForecast(candles)`). Forecast uses an N-arm pendulum physics simulation (RK4 integration).
- **Only CDN dep**: Lightweight Charts 4.1.1 (`unpkg.com`). No `package.json` — never run `npm install/test/start`.
- **UI language**: Bulgarian (`lang="bg"`). All labels, tooltips, and notifications are in Bulgarian.
- **Server** (`server.js`): Static file serving + two Binance proxy endpoints (`/binance` for klines, `/ticker` for 24hr ticker). Both fall back from Spot API to Futures API.

## Commands
- **Start**: `node server.js` (listens on `PORT` env var or `3001`).
- **Tests**: Start server first, then `node scratch/test_endpoints.js` or `node scratch/test_commodities.js`.

## Key Behaviors & Quirks
- **Realtime**: Frontend polls Binance every 5s via `/binance`. The forecast is NOT re-run on poll — only on explicit triggers (selection change, period change, horizon change, force reload, present-line drag, pendulum config change).
- **Present line**: A draggable vertical line on the chart. Dragging it backwards locks a cutoff point — forecast is recomputed using only candles before that line. Double-click to reset to live.
- **Force reload**: The "Презареди Прогнозата" button resets forecast state, unlocks the present line, re-enables forecast toggle, and reloads all data.
- **Horizon slider**: Range 10–500 (default 30), denominated in candle steps. Stretch slider multiplies each step (1–20×).
- **Amplitude slider**: Range 0.1–100×, controls angle→price scaling.
- **Pendulum visual**: Canvas overlay in chart bottom-right. Each arm drawn in distinct color; endpoint glows cyan.
- **Period configs** (`periodConfigs` in `index.html`): Map UI labels (e.g., `'5m'`, `'24h'`, `'7d'`) to a Binance `interval` + `limit`. These are not always 1:1 (e.g., `'5m'` uses `1m` candles, limit 500).
- **Custom symbols**: Added via the search box are persisted in `localStorage` key `helious_custom_symbols`.
- **Port override**: `PORT` env var works (`server.js:6`). Tests assume `3001`.
