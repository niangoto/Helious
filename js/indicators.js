function computeRSI(candles, period) {
    period = period || 14;
    if (candles.length < period + 1) return [];
    const changes = [];
    for (let i = 1; i < candles.length; i++) {
        changes.push(candles[i].close - candles[i - 1].close);
    }
    let avgG = 0, avgL = 0;
    for (let i = 0; i < period; i++) {
        if (changes[i] > 0) avgG += changes[i];
        else avgL += Math.abs(changes[i]);
    }
    avgG /= period;
    avgL /= period;
    const rsi = [avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL)];
    for (let i = period; i < changes.length; i++) {
        const g = changes[i] > 0 ? changes[i] : 0;
        const l = changes[i] < 0 ? Math.abs(changes[i]) : 0;
        avgG = (avgG * (period - 1) + g) / period;
        avgL = (avgL * (period - 1) + l) / period;
        rsi.push(avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL));
    }
    return rsi;
}

function updateIndicatorCharts(candles) {
    if (!candles || candles.length < 20) return;
    // Няма фонови сметки: работим само когато табло/графика е отворено.
    if (typeof appVisible === 'function' && !appVisible()) return;
    const period = 14;
    const rsiVals = computeRSI(candles, period);
    if (!rsiVals.length) return;
    const rsi = [], vol = [], bias = [];
    let obvVal = 0;
    const obvAll = [0];
    for (let i = 1; i < candles.length; i++) {
        const v = candles[i].volume || 0;
        if (candles[i].close > candles[i - 1].close) obvVal += v;
        else if (candles[i].close < candles[i - 1].close) obvVal -= v;
        obvAll.push(obvVal);
    }
    const obvMin = Math.min(...obvAll), obvMax = Math.max(...obvAll);
    for (let i = 0; i < candles.length; i++) {
        const t = candles[i].time;
        rsi.push({ time: t, value: i < period ? null : rsiVals[i - period] });
        vol.push({ time: t, value: candles[i].volume || 0 });
        if (i < period) {
            bias.push({ time: t, value: null });
        } else {
            const oNorm = obvMax > obvMin ? ((obvAll[i] - obvMin) / (obvMax - obvMin)) * 100 : 50;
            const bBuy = (100 - rsiVals[i - period] + oNorm) / 2;
            const bSell = (100 + rsiVals[i - period] - oNorm) / 2;
            bias.push({ time: t, value: (bBuy / (bBuy + bSell || 1)) * 100 });
        }
    }
    indicatorData = { rsi, vol, bias };
    // Моделните вероятностни редици + FFT overlay са нужни САМО на графиката.
    if (typeof chartViewVisible === 'function' && !chartViewVisible()) return;
    computeIndicatorModelProbs(candles);
    updateFftOverlay(candles);
    if (typeof updateCandleForecastOverlay === 'function') updateCandleForecastOverlay(candles);
    drawIndicatorCanvases();
}

// Изчислява само вероятностните редици, нужни на АКТИВНАТА страница (0-9), за да
// не се смятат всичките модели, когато страницата не ги показва. Индексите в
// indicatorData.modelProbs отговарят на drawChart на съответния таб.
function computeIndicatorModelProbs(candles) {
    if (typeof computeModelProbSequence !== 'function') return;
    const neededByPage = {
        1: [0, 1, 2, 3, 4, 5], // Средна вероятност (0-4 за линията, 5 за дължина)
        2: [0], // Историческа
        3: [1], // Логистична
        4: [2], // Марковска
        5: [3], // Очаквана стойност
        6: [4], // Уейвлет
        7: [5]  // Фурие
    };
    const needed = neededByPage[currentPage];
    if (!needed) { indicatorData.modelProbs = null; return; }
    const mp = [null, null, null, null, null, null];
    for (const mi of needed) {
        mp[mi] = (mi === 5) ? computeFourierProbSequence(candles) : computeModelProbSequence(candles, mi);
    }
    indicatorData.modelProbs = mp;
}
