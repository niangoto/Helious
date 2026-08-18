// Page 6: УЕЙВЛЕТ ТРАНСФОРМАЦИЯ — Db4 MRA + soft-thresholding probability.
registerTab({
    index: 6,
    renderPanel: function (candles, models) {
        if (!models) return;
        const m = models.models.wavelet;
        setModelDisplay('modWavelet', m.buyPct, m.sellPct);
    },
    drawChart: function (ctx, w, h, label) {
        const d = indicatorData;
        if (!d.modelProbs || !d.modelProbs[4]) return;
        label.textContent = 'Уейвлет трансформация';
        drawProbLine(ctx, w, h, d.modelProbs[4]);
    }
});
