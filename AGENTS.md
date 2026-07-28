# Agent Guidance: Helious Quantum

## Architecture
- **Single-page app** with a zero-dep Node.js proxy server (`server.js`).
- **UI**: `index.html` (inline CSS + inline JS). **Forecast engine**: `forecast.js`.
- **Models**: `models.js` (statistical probability models: historical, Bayesian, logistic regression, Markov chain, expected value). **Data provider**: `data-provider.js` (symbol normalization, multi-source data fetching, MT5 bridge).
- **Only CDN dep**: Lightweight Charts 4.1.1 (`unpkg.com`). No `package.json` — never run `npm install/test/start`.
- **UI language**: Bulgarian (`lang="bg"`). All labels, tooltips, and notifications are in Bulgarian.
- **Server** (`server.js`): Static file serving + `/data` endpoint (unified data via `data-provider.js`), plus legacy `/binance`, `/yahoo`, `/ticker` endpoints.

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
- **Force reload**: "Презареди Прогнозата" resets forecast state, unlocks present line, reloads all data.
- **Period configs** (`periodConfigs` in `index.html`): Map UI labels to `interval` + `limit`.
- **Custom symbols**: Added via search box are persisted in `localStorage` key `helious_custom_symbols`. Also resolved via data-provider alias table.
- **Port override**: `PORT` env var works (`server.js:6`). Tests assume `3001`.
