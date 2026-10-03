// Спецификации на инструментите за реалистичен обем.
// contract = колко единици от базовия актив има в 1 лот.
// step/min/max = стъпка, минимум и максимум обем в лотове (както при брокерите).
// Минималният обем е 0.01 лот за всички инструменти.

const STEP = 0.01;
const MIN = 0.01;

const SPECS = {
  // Forex: 1 лот = 100 000 единици
  EURUSD: { contract: 100000, step: STEP, min: MIN, max: 100 },
  GBPUSD: { contract: 100000, step: STEP, min: MIN, max: 100 },
  USDJPY: { contract: 100000, step: STEP, min: MIN, max: 100 },
  USDCHF: { contract: 100000, step: STEP, min: MIN, max: 100 },
  EURJPY: { contract: 100000, step: STEP, min: MIN, max: 100 },
  GBPJPY: { contract: 100000, step: STEP, min: MIN, max: 100 },
  AUDUSD: { contract: 100000, step: STEP, min: MIN, max: 100 },
  NZDUSD: { contract: 100000, step: STEP, min: MIN, max: 100 },
  USDCAD: { contract: 100000, step: STEP, min: MIN, max: 100 },
  EURGBP: { contract: 100000, step: STEP, min: MIN, max: 100 },
  EURAUD: { contract: 100000, step: STEP, min: MIN, max: 100 },
  GBPCHF: { contract: 100000, step: STEP, min: MIN, max: 100 },

  // Метали
  XAUUSD: { contract: 100, step: STEP, min: MIN, max: 50 },   // 100 унции/лот
  XAGUSD: { contract: 5000, step: STEP, min: MIN, max: 50 },  // 5000 унции/лот

  // Енергия
  WTI: { contract: 1000, step: STEP, min: MIN, max: 50 },     // 1000 барела/лот
  BRENT: { contract: 1000, step: STEP, min: MIN, max: 50 },

  // Индекси (CFD): 1 лот = 1 единица
  DAX: { contract: 1, step: STEP, min: MIN, max: 1000 },
  NDX: { contract: 1, step: STEP, min: MIN, max: 1000 },
  SPX: { contract: 1, step: STEP, min: MIN, max: 1000 },
  DJI: { contract: 1, step: STEP, min: MIN, max: 1000 },
  CAC: { contract: 1, step: STEP, min: MIN, max: 1000 },
  UK100: { contract: 1, step: STEP, min: MIN, max: 1000 },
  NI225: { contract: 1, step: STEP, min: MIN, max: 1000 },

  // Крипто
  BTCUSDT: { contract: 1, step: STEP, min: MIN, max: 100 },
  ETHUSDT: { contract: 1, step: STEP, min: MIN, max: 1000 },
  SOLUSDT: { contract: 1, step: STEP, min: MIN, max: 5000 }
};

const DEFAULT = { contract: 1, step: STEP, min: MIN, max: 1000 };

function specFor(symbol) {
  const s = String(symbol || '').toUpperCase().trim();
  return SPECS[s] || DEFAULT;
}

// Закръгля обема надолу към стъпката (за да не надвишава риска).
function floorLots(lots, spec) {
  const v = Math.floor(lots / spec.step + 1e-9) * spec.step;
  return Math.round(v * 1e8) / 1e8;
}

module.exports = { SPECS, specFor, floorLots, STEP, MIN };
