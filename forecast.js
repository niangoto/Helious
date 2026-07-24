window.wavesConfig = [
  { amplitude: 0.5, length: 100, phase: 0, offset: 0 },
  { amplitude: 0.3, length: 250, phase: 0, offset: 0 },
  { amplitude: 0.2, length: 500, phase: 0, offset: 0 }
];

function runForecast(candles) {
  if (!candles || candles.length < 10) return;

  // Use a much larger range for the lines
  const horizon = 2000; 
  const prices = candles.map(c => c.close);
  const lastPrice = prices[prices.length - 1];
  const startTime = typeof presentCutoffTime === 'number' ? presentCutoffTime : candles[candles.length - 1].time;
  const stepBase = candles.length > 1 ? Math.round((candles[candles.length - 1].time - candles[0].time) / (candles.length - 1)) : 60;
  
  // Resonance: sum of sine waves
  const forecastPath = [];
  const waveTrajectories = window.wavesConfig.map(() => []);

  for (let k = -horizon; k <= horizon; k++) {
    const time = startTime + k * stepBase;
    let value = lastPrice;
    
    window.wavesConfig.forEach((wave, i) => {
      // Frequency proportional to 1/length
      const frequency = 1 / (wave.length * stepBase);
      // Further reduction: divide by 1000 instead of 100 to make it extremely subtle
      const sinWave = (wave.amplitude / 1000) * lastPrice * Math.sin(2 * Math.PI * frequency * (k * stepBase) + wave.phase);
      const waveVal = sinWave + (wave.offset * lastPrice / 1000);
      value += waveVal;
      waveTrajectories[i].push(waveVal);
    });
    
    forecastPath.push({ time, value });
  }

  const ensVals = forecastPath.map(p => p.value);
  const finalVal = ensVals[ensVals.length - 1];
  const maxVal = Math.max(...ensVals);
  const minVal = Math.min(...ensVals);

  latestForecastData = {
    centerPath: candles.map(c => ({ time: c.time, value: (c.high + c.low) / 2 })),
    forecastPath: forecastPath,
    waveTrajectories: waveTrajectories,
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
