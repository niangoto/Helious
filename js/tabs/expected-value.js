// Page 5: ОЧАКВАНА СТОЙНОСТ (EV) — simulated TP/SL trade win-rate vs breakeven.
registerTab({
    index: 5,
    renderPanel: function (candles, models) {
        if (!models) return;
        const m = models.models.expectedValue;
        setModelDisplay('modEv', m.buyPct, m.sellPct);
        const evEl = document.getElementById('modEvVal');
        const wrEl = document.getElementById('modEvWinRate');
        if (evEl) evEl.textContent = m.ev ? (m.ev > 0 ? '+' : '') + m.ev.toFixed(2) : '---';
        if (wrEl) wrEl.textContent = m.winRate ? m.winRate.toFixed(1) + '%' : '---';
    },
    drawChart: function (ctx, w, h, label) {
        const d = indicatorData;
        if (!d.modelProbs || !d.modelProbs[3]) return;
        label.textContent = 'Очаквана стойност вероятност';
        drawProbLine(ctx, w, h, d.modelProbs[3]);
    }
});
