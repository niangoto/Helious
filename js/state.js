let chart, candleSeries, fftSeries, fftForecastSeries;
let latestForecastData = null;
let latestCandles = [];
let indicatorData = { rsi: [], volume: [] };
let presentCutoffTime = null;
let presentLineLocked = false;
let latestFft = null;

let currentSymbol = 'BTCUSDT';
let activePeriod = '24h';
let currentInterval = '5m';
let forecastSteps = 30;

let ivDataCache = null;
let ivCurrentSymbol = 'BTCUSDT';
let currentPage = 0;
let indicatorCycle = 0;

let isRealtimeLoading = false;
let realtimeInterval = null;
