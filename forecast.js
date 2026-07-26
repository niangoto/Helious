function runForecast(candles) {
  if (!candles || candles.length < 10) return;

  const horizon = 2000;
  const prices = candles.map(c => c.close);
  const lastPrice = prices[prices.length - 1];
  const startTime = typeof presentCutoffTime === 'number' ? presentCutoffTime : candles[candles.length - 1].time;
  const stepBase = candles.length > 1 ? Math.round((candles[candles.length - 1].time - candles[0].time) / (candles.length - 1)) : 60;

  const forecastPath = [];

  for (let k = -horizon; k <= horizon; k++) {
    const time = startTime + k * stepBase;
    forecastPath.push({ time, value: lastPrice });
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
