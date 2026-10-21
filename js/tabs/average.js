// Page 1: СРЕДНА ВЕРОЯТНОСТ — average of the 6 model buy probabilities.
registerTab({
    index: 1,
    renderPanel: function (candles, models) {
        if (!models) return;
        const sets = [
            models.models.historical,
            models.models.logistic,
            models.models.markov,
            models.models.expectedValue,
            models.models.wavelet,
            models.models.fourier
        ];
        let avgBuy = 0;
        sets.forEach(m => { avgBuy += m.buyPct; });
        avgBuy /= sets.length;
        setModelDisplay('avg', avgBuy, 100 - avgBuy);
    },
    drawChart: function (ctx, w, h, label) {
        const d = indicatorData;
        if (!d.modelProbs || !d.modelProbs[0]) return;
        label.textContent = 'Средна вероятност';
        // Същият набор като картата в таблото: историческа, логистична,
        // марковска, EV, уейвлет и Фурие (6 модела). Редиците имат различна
        // резолюция (Фурие е по-рядка), затова ги подравняваме ПО ВРЕМЕ:
        // за по-редките ползваме последната известна стойност (forward-fill).
        const series = d.modelProbs.filter(p => p && p.length && p.length > 0);
        if (!series.length) return;
        const maps = series.map(p => { const m = new Map(); for (const pt of p) if (pt && pt.value != null) m.set(pt.time, pt.value); return m; });
        const times = series.map(p => p.map(pt => pt.time));
        let baseIdx = 0;
        for (let i = 1; i < series.length; i++) if (series[i].length > series[baseIdx].length) baseIdx = i;
        const avgData = [];
        for (const basePt of series[baseIdx]) {
            const t = basePt.time;
            let sum = 0, count = 0;
            for (let m = 0; m < series.length; m++) {
                let v = maps[m].get(t);
                if (v == null) {
                    // Последната стойност на тази редица с време <= t.
                    const tm = times[m];
                    let lo = 0, hi = tm.length - 1, idx = -1;
                    while (lo <= hi) { const mid = (lo + hi) >> 1; if (tm[mid] <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
                    if (idx >= 0) v = series[m][idx].value;
                }
                if (v != null) { sum += v; count++; }
            }
            if (count) avgData.push({ time: t, value: sum / count });
        }
        drawProbLine(ctx, w, h, avgData);
    }
});
