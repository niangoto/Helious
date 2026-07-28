function runForecast(candles) {
  if (!candles || candles.length < 10) return;

  const prices = candles.map(c => c.close);
  const lastPrice = prices[prices.length - 1];
  const startTime = typeof presentCutoffTime === 'number' ? presentCutoffTime : candles[candles.length - 1].time;
  const stepBase = candles.length > 1 ? Math.round((candles[candles.length - 1].time - candles[0].time) / (candles.length - 1)) : 60;

  const forecastSteps = typeof forecastSteps === 'number' ? Math.min(forecastSteps, 200) : 30;
  const historyBars = Math.min(300, candles.length);

  // Get wavelet forecast data: trend slope + dominant cycle parameters
  const waveletData = typeof getWaveletForecastData === 'function'
    ? getWaveletForecastData(prices, forecastSteps)
    : null;

  const horizon = 2000;
  const forecastPath = [];

  // Compute the recent local price change for fallback
  const recentPrices = prices.slice(-20);
  const localSlope = (recentPrices[recentPrices.length - 1] - recentPrices[0]) / recentPrices.length;

  for (let k = -horizon; k <= horizon; k++) {
    const time = startTime + k * stepBase;
    let value = lastPrice;

    if (k > 0) {
      // --- Forward forecast (k > 0) ---
      if (waveletData) {
        // Extrapolate trend: lastPrice + trendSlope * k
        const trend = waveletData.trendSlope * k * stepBase / 1000;

        // Add dominant cycle oscillation
        // The cycle oscillates around the trend line
        const cycleFreq = Math.PI * 2 / 30; // approx 30-bar cycle
        const cycleDecay = Math.exp(-k / 200); // slowly dampen the cycle
        const cycle = waveletData.cycleAmp * cycleDecay * Math.sin(cycleFreq * k + waveletData.cyclePhase * 0.5);

        value = lastPrice + trend + cycle;
      } else {
        // Fallback: simple linear projection with noise
        value = lastPrice + localSlope * k;
        value += (Math.random() - 0.5) * lastPrice * 0.001 * Math.min(1, k / 50);
      }
    } else {
      // --- Backward view (k <= 0): show actual data for past candles ---
      const histIdx = candles.length - 1 + k;
      if (histIdx >= 0 && histIdx < candles.length) {
        value = candles[histIdx].close;
      } else {
        value = lastPrice + localSlope * k;
      }
    }

    forecastPath.push({ time, value });
  }

  const ensVals = forecastPath.map(p => p.value);
  const finalVal = ensVals[ensVals.length - 1];
  const maxVal = Math.max(...ensVals);
  const minVal = Math.min(...ensVals);

  latestForecastData = {
    centerPath: candles.map(c => ({ time: c.time, value: (c.high + c.low) / 2 })),
    forecastPath: forecastPath,
    finalPredictedPrice: finalVal,
    maxPredPrice: maxVal,
    minPredPrice: minVal,
    lastCandle: candles[candles.length - 1]
  };

  if (typeof drawForecast === 'function') drawForecast();
};

window.setForecastData = function (obj) {
  latestForecastData = obj;
  if (typeof drawForecast === 'function') drawForecast();
};
