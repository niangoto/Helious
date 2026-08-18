// Page 4: МАРКОВСКА ВЕРИГА — first-order Markov chain on up/down moves.
registerTab({
    index: 4,
    renderPanel: function (candles, models) {
        if (!models) return;
        const m = models.models.markov;
        setModelDisplay('modMarkov', m.buyPct, m.sellPct);
    },
    drawChart: function (ctx, w, h, label) {
        const d = indicatorData;
        if (!d.modelProbs || !d.modelProbs[2]) return;
        label.textContent = 'Марковска вероятност';
        drawProbLine(ctx, w, h, d.modelProbs[2]);
    }
});
