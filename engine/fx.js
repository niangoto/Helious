// Валутна конверсия към EUR (валутата на сметката).
// Повечето инструменти се котират в USD (крипто, метали, енергия, US индекси,
// forex с долар), някои в GBP/JPY/CHF/CAD/AUD, а DAX/CAC са в EUR.
// P/L, нотионал и маржин се смятат в котираната валута и се превръщат в EUR.

const dp = require('../data-provider');

const INDEX_CCY = { DAX: 'EUR', CAC: 'EUR', UK100: 'GBP', NI225: 'JPY', NDX: 'USD', SPX: 'USD', DJI: 'USD' };
const CRYPTO_RE = /(USDT|USDC|BUSD|FDUSD|TUSD)$/i;

function quoteCurrency(symbol) {
  const s = String(symbol || '').toUpperCase().trim();
  if (INDEX_CCY[s]) return INDEX_CCY[s];
  if (['XAUUSD', 'XAGUSD', 'WTI', 'BRENT'].includes(s)) return 'USD';
  if (CRYPTO_RE.test(s) || /^(BTC|ETH|SOL)(USD)?$/.test(s)) return 'USD';
  if (/^[A-Z]{6}$/.test(s)) return s.slice(3);
  return 'EUR';
}

// EUR кросове: EURXXX = колко XXX струва 1 EUR → XXX→EUR = 1 / EURXXX.
const PAIRS = { USD: 'EURUSD', GBP: 'EURGBP', JPY: 'EURJPY', CHF: 'EURCHF', CAD: 'EURCAD', AUD: 'EURAUD' };

let rates = { EUR: 1 };
let loadedAt = 0;
let loading = null;

// Зарежда курсовете (кеширани 5 мин). Безопасно е да се вика често.
async function loadRates(force) {
  if (!force && loadedAt && Date.now() - loadedAt < 300000) return rates;
  if (loading) return loading;
  loading = (async () => {
    const out = { EUR: 1 };
    await Promise.all(Object.entries(PAIRS).map(async ([ccy, pair]) => {
      try {
        const r = await dp.fetchData(pair, '1d', 5);
        const c = r && r.candles;
        const last = c && c.length ? c[c.length - 1].close : 0;
        out[ccy] = last > 0 ? 1 / last : 1;
      } catch (e) { out[ccy] = 1; }
    }));
    rates = out;
    loadedAt = Date.now();
    loading = null;
    return rates;
  })();
  return loading;
}

// Колко EUR е 1 единица от валутата (напр. 1 USD → ~0.92 EUR).
function eurRate(ccy) {
  const r = rates[ccy];
  return (r > 0) ? r : 1;
}

function eurRateForSymbol(symbol) { return eurRate(quoteCurrency(symbol)); }

module.exports = { quoteCurrency, eurRate, eurRateForSymbol, loadRates };
