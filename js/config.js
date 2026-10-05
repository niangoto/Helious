const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
const API_BASE = isLocal ? 'http://localhost:3001' : '';
const BINANCE_SPOT = 'https://api.binance.com';
const BINANCE_FUTURES = 'https://fapi.binance.com';

const YAHOO_SYMBOLS = {
    'CAC': '^FCHI', 'CAC40': '^FCHI', 'DAX': '^GDAXI', 'DAX40': '^GDAXI',
    'NDX': '^NDX', 'NAS100': '^NDX', 'SPX': '^GSPC', 'SP500': '^GSPC',
    'DJI': '^DJI', 'DOW': '^DJI',
    'EURUSD': 'EURUSD=X', 'GBPUSD': 'GBPUSD=X', 'USDJPY': 'USDJPY=X',
    'USDCHF': 'USDCHF=X', 'EURJPY': 'EURJPY=X', 'GBPJPY': 'GBPJPY=X',
    'AUDUSD': 'AUDUSD=X', 'NZDUSD': 'NZDUSD=X', 'USDCAD': 'USDCAD=X',
    'EURGBP': 'EURGBP=X', 'EURAUD': 'EURAUD=X', 'GBPCHF': 'GBPCHF=X',
    'XAUUSD': 'GC=F', 'XAGUSD': 'SI=F', 'GOLD': 'GC=F', 'SILVER': 'SI=F',
    'WTI': 'CL=F', 'OIL': 'CL=F', 'BRENT': 'BZ=F'
};

const periodConfigs = {
    '5m': { interval: '1m', limit: 500 },
    '15m': { interval: '1m', limit: 1000 },
    '30m': { interval: '1m', limit: 1000 },
    '1h': { interval: '1m', limit: 1000 },
    '4h': { interval: '5m', limit: 1000 },
    '12h': { interval: '5m', limit: 1000 },
    '24h': { interval: '5m', limit: 1000 },
    '7d': { interval: '1h', limit: 1000 },
    '30d': { interval: '4h', limit: 1000 },
    '90d': { interval: '1d', limit: 500 }
};

// Заглавия на 10-те страници на таблото — ползват се като подписи на точките
// за навигация (на телефон няма стрелки и прескачането е само с тях).
const IV_PAGE_LABELS = [
    'Показатели (RSI / Обем / OBV)',
    'Средна вероятност',
    'Историческа вероятност',
    'Логистична регресия',
    'Марковска верига',
    'Очаквана стойност (EV)',
    'Уейвлет трансформация',
    'Фурие (FFT)',
    'RSI фазов анализ',
    'Прогноза на свещи'
];

const symbolDetails = {
    'BTCUSDT': { name: 'BTC (Биткойн)', desc: 'Крипто Лидер' },
    'ETHUSDT': { name: 'ETH (Етериум)', desc: 'Смарт Контракти' },
    'BNBUSDT': { name: 'BNB (Binance)', desc: 'Екосистема на Binance' },
    'SOLUSDT': { name: 'SOL (Солана)', desc: 'Високоскоростна Мрежа' },
    'XRPUSDT': { name: 'XRP (Ripple)', desc: 'Междубанкови Плащания' },
    'ADAUSDT': { name: 'ADA (Cardano)', desc: 'Академичен Блокчейн' },
    'DOTUSDT': { name: 'DOT (Polkadot)', desc: 'Свързани Блокчейни' },
    'AVAXUSDT': { name: 'AVAX (Avalanche)', desc: 'Мащабируем Блокчейн' },
    'LINKUSDT': { name: 'LINK (Chainlink)', desc: 'Децентрализирани Оракули' },
    'MATICUSDT': { name: 'POL (Polygon)', desc: 'L2 Мащабиране' },
    'LTCUSDT': { name: 'LTC (Litecoin)', desc: 'Дигитално Сребро' },
    'DOGEUSDT': { name: 'DOGE (Dogecoin)', desc: 'Меме Лидер' },
    'PAXGUSDT': { name: 'GOLD (Злато)', desc: 'Физическо Злато' },
    'BZUSDT': { name: 'BRENT OIL (Петрол)', desc: 'Брент Суров Петрол' },
    'CLUSDT': { name: 'WTI OIL (Петрол)', desc: 'WTI Суров Петрол' }
};

const popularSymbols = [
    'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','ADAUSDT','AVAXUSDT','DOTUSDT',
    'LINKUSDT','MATICUSDT','LTCUSDT','DOGEUSDT','SHIBUSDT','NEARUSDT','UNIUSDT',
    'FILUSDT','ATOMUSDT','OPUSDT','ARBUSDT','SUIUSDT','PEPEUSDT','FTMUSDT',
    'TIAUSDT','RENDERUSDT','INJUSDT','APTUSDT','SEIUSDT','ORDIUSDT','RUNUSDT',
    'FETUSDT','AGIXUSDT','OCEANUSDT','ICPUSDT','EOSUSDT','TRXUSDT','VETUSDT',
    'THETAUSDT','ALGOUSDT','MANAUSDT','SANDUSDT','AXSUSDT','AAVEUSDT','MKRUSDT',
    'COMPUSDT','SNXUSDT','CRVUSDT','BALUSDT','YFIUSDT','ZECUSDT','XMRUSDT',
    'DASHUSDT','ETCUSDT','CHZUSDT','ENJUSDT','BATUSDT','OMGUSDT','ZILUSDT',
    'IOSTUSDT','IOTAUSDT','ONTUSDT','QTUMUSDT','WAVESUSDT','KSMUSDT','XEMUSDT',
    'NEOUSDT','GALAUSDT','IMXUSDT','BLURUSDT','LOOKSUSDT','DYDXUSDT','GMXUSDT',
    'PAXGUSDT','BZUSDT','CLUSDT'
];

let customSymbols = JSON.parse(localStorage.getItem('helious_custom_symbols') || '[]');

function getFullSymbolList() {
    const combined = [...popularSymbols, ...customSymbols];
    return [...new Set(combined)];
}
