async function fetchKlines(symbol, interval, limit) {
    if (API_BASE) {
        const resp = await fetch(`${API_BASE}/data?symbol=${symbol}&interval=${interval}&limit=${limit}`).then(r => r.json()).catch(() => null);
        if (resp && resp.ok && resp.candles && resp.candles.length > 0) {
            return resp.candles.map(c => [c.time * 1000, c.open.toString(), c.high.toString(), c.low.toString(), c.close.toString(), c.volume.toString(), c.time * 1000 + 60000, '0', 0, '0', '0', '0']);
        }
        const detail = resp?.details ? ' (' + resp.details + ')' : '';
        throw new Error((resp?.error || 'Няма данни за ' + symbol) + detail);
    }
    // Direct mode: try Binance Spot → Futures → Yahoo
    let r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
    if (r.ok) return r.json();
    r = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
    if (r.ok) return r.json();
    // Try Yahoo (may fail due to CORS)
    try {
        const yhSym = YAHOO_SYMBOLS[symbol.toUpperCase()] || symbol;
        const yh = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yhSym)}?interval=${interval}&range=1y&includePrePost=false`);
        if (yh.ok) {
            const parsed = await yh.json();
            const result = parsed.chart?.result?.[0];
            if (result && result.timestamp) {
                const q = result.indicators.quote[0];
                return result.timestamp.map((t, i) => [
                    t * 1000, (q.open[i] || 0).toString(), (q.high[i] || 0).toString(), (q.low[i] || 0).toString(), (q.close[i] || 0).toString(), (q.volume[i] || 0).toString(),
                    t * 1000 + 60000, '0', 0, '0', '0', '0'
                ]).filter(k => parseFloat(k[4]) > 0);
            }
        }
    } catch (e) {}
    throw new Error('Symbol not available');
}

function timeToLocal(originalTime) {
    const d = new Date(originalTime * 1000);
    return Date.UTC(
        d.getFullYear(),
        d.getMonth(),
        d.getDate(),
        d.getHours(),
        d.getMinutes(),
        d.getSeconds(),
        d.getMilliseconds()
    ) / 1000;
}
