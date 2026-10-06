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

let rates = { EUR: 1 };
let loadedAt = 0;
let loading = null;

// Зарежда курсовете (кеширани 5 мин) от безплатния currency-api (без ключ и
// без лимит) — за да не хаби TwelveData кредити и да не блокира търговията.
async function loadRates(force) {
  if (!force && loadedAt && Date.now() - loadedAt < 300000) return rates;
  if (loading) return loading;
  loading = (async () => {
    try {
      const r = await dp.fetchEurRates();
      if (r && r.EUR) { rates = r; loadedAt = Date.now(); }
    } catch (e) { /* пази старите курсове */ }
    loading = null;
    return rates;
  })();
  return loading;
}

function snapshot() { return Object.assign({ EUR: 1 }, rates); }

// Колко EUR е 1 единица от валутата (напр. 1 USD → ~0.92 EUR).
function eurRate(ccy) {
  const r = rates[ccy];
  return (r > 0) ? r : 1;
}

function eurRateForSymbol(symbol) { return eurRate(quoteCurrency(symbol)); }

module.exports = { quoteCurrency, eurRate, eurRateForSymbol, loadRates, snapshot };
