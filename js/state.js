let chart, candleSeries, fftSeries, fftForecastSeries, candleForecastSeries;
let latestForecastData = null;
let latestCandles = [];
// Допълнителна история (още един период назад) за равна дълбочина на пресмятанията.
let historyCandles = [];
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

// Коефициент на затихване β за експоненциалните тежести на прогнозата на свещи.
let candleForecastBeta = 1;
