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
        const minLen = Math.min(...d.modelProbs.map(p => p.length));
        const avgData = [];
        for (let i = 0; i < minLen; i++) {
            let sum = 0, count = 0;
            for (let m = 0; m < 5; m++) { const v = d.modelProbs[m][i].value; if (v !== null) { sum += v; count++; } }
            avgData.push({ time: d.modelProbs[0][i].time, value: count > 0 ? sum / count : 50 });
        }
        drawProbLine(ctx, w, h, avgData);
    }
});
