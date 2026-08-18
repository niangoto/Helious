// Page 2: ИСТОРИЧЕСКА ВЕРОЯТНОСТ — historical up/down probability over the last N moves.
registerTab({
    index: 2,
    renderPanel: function (candles, models) {
        if (!models) return;
        const m = models.models.historical;
        setModelDisplay('modHist', m.buyPct, m.sellPct);
    },
    drawChart: function (ctx, w, h, label) {
        const d = indicatorData;
        if (!d.modelProbs || !d.modelProbs[0]) return;
        label.textContent = 'Историческа вероятност';
        drawProbLine(ctx, w, h, d.modelProbs[0]);
    }
});
