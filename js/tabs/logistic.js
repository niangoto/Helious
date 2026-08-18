// Page 3: ЛОГИСТИЧНА РЕГРЕСИЯ — combination/signal-mask model win rate.
registerTab({
    index: 3,
    renderPanel: function (candles, models) {
        if (!models) return;
        const m = models.models.logistic;
        setModelDisplay('modLog', m.buyPct, m.sellPct);
    },
    drawChart: function (ctx, w, h, label) {
        const d = indicatorData;
        if (!d.modelProbs || !d.modelProbs[1]) return;
        label.textContent = 'Логистична вероятност';
        drawProbLine(ctx, w, h, d.modelProbs[1]);
    }
});
