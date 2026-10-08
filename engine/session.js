// Paper търговска сесия: на всеки затворен бар смята вероятност по модела,
// влиза/излиза на виртуална сметка и подава живо състояние към UI (SSE).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const dp = require('../data-provider');
const models = require('../models');
const db = require('../db');
const { normalizeParams, entryDecision, exitDecision, floatingPnl, marketOpen } = require('./strategy');
const fx = require('./fx');
const { specFor } = require('./symbolSpec');
const { PaperAccount } = require('./paperBroker');

const IV_SEC = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 };
const WINDOW = 1000;      // свещи за модела/ATR
const POLL_MS = 5000;     // период на проверка
const MAX_EQ = 4000;      // горна граница на точките в equitySeries (разреждане)
const MARGIN_LEVEL_MIN = 50; // под това ниво (капитал/нотионал) затваряме на загуба
const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'paper-sessions.json');

const nowSec = () => Math.floor(Date.now() / 1000);
const startOfDay = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
const startOfWeek = () => { const d = new Date(); const day = (d.getDay() + 6) % 7; d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - day); return d.getTime(); };
const startOfMonth = () => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(1); return d.getTime(); };

class PaperSession {
  constructor(id, config) {
    config = config || {};
    this.id = id;
    this.ownerId = config.ownerId || null;   // профилът, който е стартирал сесията
    this.symbols = (Array.isArray(config.symbols) && config.symbols.length ? config.symbols : ['BTCUSDT'])
      .map(s => String(s).toUpperCase().trim()).filter(Boolean).slice(0, 10);
    this.interval = IV_SEC[config.interval] ? config.interval : '1h';
    this.model = Number.isInteger(config.model) ? config.model : 1;
    this.contra = Array.isArray(config.contra) ? config.contra.slice(0, 6) : [];
    this.P = normalizeParams(config.params || config);
    // Референтна цена per символ за спреда (€ при тази цена; мащабира се после).
    this.refPrices = (config.refPrices && typeof config.refPrices === 'object') ? Object.assign({}, config.refPrices) : {};
    this.account = new PaperAccount(this.P.budget);
    this.status = 'running';
    this.error = null;
    this.createdAt = Date.now();
    this.startedAt = null;
    this.updatedAt = Date.now();
    this.state = {};
    for (const s of this.symbols) this.state[s] = { candles: [], lastBarTime: 0, source: null, error: null };
    this.equitySeries = [];
    this.timer = null;
    this.listeners = new Set();
    this._ticking = false;
    this._lastSnapshot = 0;
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { const st = this.getState(); for (const fn of this.listeners) { try { fn(st); } catch (e) {} } }

  async warmup() {
    const limit = WINDOW;
    const iv = IV_SEC[this.interval];
    for (const s of this.symbols) {
      try {
        const r = await dp.fetchData(s, this.interval, limit);
        if (r && r.candles && r.candles.length) {
          const st = this.state[s];
          st.candles = r.candles;
          st.source = r.source;
          st.error = null;
          const arr = r.candles;
          const last = arr[arr.length - 1];
          const closed = (last.time + iv) <= nowSec() ? last : (arr[arr.length - 2] || last);
          st.lastBarTime = closed ? closed.time : 0;
          // Референтната цена за спреда се заковава при първото зареждане.
          if (!(this.refPrices[s] > 0) && last.close > 0) this.refPrices[s] = last.close;
        }
      } catch (e) {
        this.state[s].error = e.message;
      }
    }
  }

  start(preserveStartedAt) {
    if (!preserveStartedAt || !this.startedAt) this.startedAt = nowSec();
    if (this.timer) clearInterval(this.timer);
    fx.loadRates().catch(() => {});
    this.timer = setInterval(() => { this.tick().catch(e => console.error('[paper] tick:', e.message)); }, POLL_MS);
    this.emit();
  }

  prices() {
    const p = {};
    for (const s of this.symbols) {
      const c = this.state[s].candles;
      if (c && c.length) p[s] = c[c.length - 1].close;
    }
    return p;
  }

  async tick() {
    if (this._ticking || this.status === 'stopped') return;
    this._ticking = true;
    try {
      // Обновяване на валутните курсове към EUR във фонов режим (не блокира
      // обработката на баровете; при първия тик може да ползва кешираните).
      fx.loadRates().catch(() => {});
      const iv = IV_SEC[this.interval];
      for (const s of this.symbols) {
        const st = this.state[s];
        let r;
        try { r = await dp.fetchData(s, this.interval, WINDOW); }
        catch (e) { st.error = e.message; continue; }
        if (!r || !r.candles || !r.candles.length) continue;
        st.candles = r.candles;
        st.source = r.source;
        st.error = null;

        const arr = r.candles;
        const last = arr[arr.length - 1];
        const closed = (last.time + iv) <= nowSec() ? last : (arr[arr.length - 2] || null);
        if (!closed || closed.time <= st.lastBarTime) continue;

        // БЕЗ наваксване: обработваме само НАЙ-НОВИЯ затворен бар, а изпуснатите
        // (докато сървърът/сесията е била спряна) се прескачат.
        const missed = arr.filter(c => c.time > st.lastBarTime && c.time + iv <= nowSec());
        const latest = missed.length ? missed[missed.length - 1] : null;
        if (latest) {
          const idx = arr.indexOf(latest);
          if (idx >= 0) this.processBar(s, arr, idx, latest);
        }
        st.lastBarTime = latest ? latest.time : closed.time;
      }

      // Маржин ниво = капитал / зает маржин на отворените позиции.
      // Ако падне под 50%, затваряме позицията с най-голяма загуба (маржин кол).
      for (let guard = 0; guard < 50 && this.account.positions.size; guard++) {
        const mp = this.prices();
        if (this.account.marginLevel(mp) >= MARGIN_LEVEL_MIN) break;
        const worst = this.account.worstPosition(mp);
        if (!worst) break;
        const tr = this.account.close(worst, mp[worst], 'Маржин', nowSec());
        if (tr) this.persistTrade(tr);
      }

      const p = this.prices();
      const eq = this.account.equity(p);
      this.equitySeries.push({ t: nowSec(), equity: eq, balance: this.account.balance, floating: this.account.floating(p) });
      // Разреждаме старата половина (вместо да режем началото), за да покрива
      // кривата целия живот на сесията, а не само последните часове.
      if (this.equitySeries.length > MAX_EQ) {
        const half = Math.floor(this.equitySeries.length / 2);
        const out = [];
        for (let i = 0; i < half; i += 2) out.push(this.equitySeries[i]);
        for (let i = half; i < this.equitySeries.length; i++) out.push(this.equitySeries[i]);
        this.equitySeries = out;
      }
      this.updatedAt = Date.now();
      // Периодично записване на състоянието (за възстановяване след рестарт)
      if (Date.now() - (this._lastPersist || 0) > 30000) { saveAll(); this._lastPersist = Date.now(); }
      this.emit();
    } finally {
      this._ticking = false;
    }
  }

  processBar(symbol, arr, idx, bar) {
    // 1) Изход на отворена позиция
    const pos = this.account.positions.get(symbol);
    if (pos) {
      const held = Math.max(0, Math.round((bar.time - pos.openTime) / IV_SEC[this.interval]));
      const ex = exitDecision(pos, bar, held, this.P);
      if (ex) {
        const tr = this.account.close(symbol, ex.exitPrice, ex.reason, bar.time);
        this.persistTrade(tr);
      }
    }

    // 2) Вход (само ако не сме на пауза, няма позиция и пазарът е отворен)
    if (this.status !== 'running' || this.account.positions.get(symbol)) return;
    // Некрипто активите не се търгуват събота/неделя (пазарът е затворен).
    if (!marketOpen(symbol, bar.time)) return;
    const win = arr.slice(0, idx + 1).slice(-WINDOW);
    if (win.length < 30) return;
    let probs;
    try { probs = models.computeModelProbSeries(win, this.model, { invert: this.contra }); }
    catch (e) { return; }
    const prob = probs[probs.length - 1];
    if (!prob) return;
    const atrArr = models.computeATR(win, 14);
    const atr = atrArr[atrArr.length - 1];
    // Свободен маржин: капитал (баланс + плаваща) минус заетия маржин.
    const prices = this.prices();
    const equity = this.account.equity(prices);
    let usedMargin = 0;
    for (const p of this.account.positions.values()) usedMargin += p.margin || 0;
    const freeMargin = Math.max(0, equity - usedMargin);
    const fxr = fx.eurRateForSymbol(symbol);
    // Спредът е валиден при референтната цена на символа, после се мащабира.
    const Psym = (this.refPrices[symbol] > 0) ? Object.assign({}, this.P, { refPrice: this.refPrices[symbol] }) : this.P;
    const dec = entryDecision(prob, atr, bar.close, equity, freeMargin, Psym, symbol, fxr);
    if (!dec) return;
    this.account.open({
      symbol,
      dir: dec.dir,
      entry: dec.entry,
      lots: dec.lots,
      contract: dec.contract,
      units: dec.units,
      notional: dec.notional,
      margin: dec.margin,
      fx: dec.fx,
      tp: dec.tp,
      sl: dec.sl,
      atr: dec.atr,
      prob: dec.prob,
      spread: dec.spreadCost,
      fillShift: dec.fillShift || 0,
      openTime: bar.time
    });
  }

  pause() { if (this.status === 'running') { this.status = 'paused'; this.persistStatus(); saveAll(); this.emit(); } }
  resume() { if (this.status === 'paused') { this.status = 'running'; this.persistStatus(); saveAll(); this.emit(); } }

  stop() {
    if (this.status === 'stopped') return;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    const p = this.prices();
    this.account.closeAll(p, nowSec(), 'Край').forEach(tr => this.persistTrade(tr));
    this.status = 'stopped';
    this.persistStatus();
    saveAll();
    this.emit();
  }

  destroy() { if (this.timer) clearInterval(this.timer); this.timer = null; this.listeners.clear(); }

  // Реалната промяна на капитала от началото на периода до сега (вкл. плаващата),
  // а не максималната/пиковата стойност. Базовата точка е последният запис от
  // equitySeries преди началото на периода (или началният капитал).
  periodPnl(ms, equityNow) {
    const s = this.equitySeries;
    let base = this.account.initial;
    for (let i = s.length - 1; i >= 0; i--) {
      if (s[i].t * 1000 < ms) { base = s[i].equity; break; }
    }
    return equityNow - base;
  }

  stats() {
    const p = this.prices();
    const s = this.account.summary(p);
    return {
      ...s,
      dayPnl: this.periodPnl(startOfDay(), s.equity),
      weekPnl: this.periodPnl(startOfWeek(), s.equity),
      monthPnl: this.periodPnl(startOfMonth(), s.equity)
    };
  }

  getState() {
    const p = this.prices();
    const symbols = {};
    for (const sym of this.symbols) {
      const st = this.state[sym];
      symbols[sym] = {
        source: st.source,
        error: st.error,
        contract: specFor(sym).contract,
        lastBarTime: st.lastBarTime,
        candles: st.candles.slice(-800).map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })),
        markers: this.account.markers.filter(m => m.symbol === sym).slice(-300)
      };
    }
    const openPositions = [...this.account.positions.values()].map(pos => ({
      symbol: pos.symbol,
      dir: pos.dir,
      entry: pos.entry,
      lots: pos.lots,
      contract: pos.contract,
      units: pos.units,
      notional: pos.notional,
      margin: pos.margin,
      tp: pos.tp,
      sl: pos.sl,
      openTime: pos.openTime,
      prob: pos.prob,
      spread: pos.spread || 0,
      fx: pos.fx || 1,
      floating: p[pos.symbol] != null ? floatingPnl(pos, p[pos.symbol]) : null
    }));
    return {
      id: this.id,
      status: this.status,
      error: this.error,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
      config: {
        symbols: this.symbols,
        interval: this.interval,
        model: this.model,
        contra: this.contra,
        params: this.P
      },
      stats: this.stats(),
      openPositions,
      trades: this.account.trades.slice(-100),
      symbols,
      // Цялата серия (ограничена до MAX_EQ точки чрез разреждане), за да се
      // вижда цялата % графика при презареждане, а не само последните часове.
      equitySeries: this.equitySeries
    };
  }

  serialize() {
    return {
      id: this.id,
      ownerId: this.ownerId,
      symbols: this.symbols,
      interval: this.interval,
      model: this.model,
      contra: this.contra,
      P: this.P,
      refPrices: this.refPrices,
      status: this.status,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
      account: {
        initial: this.account.initial,
        balance: this.account.balance,
        peak: this.account.peak,
        maxDD: this.account.maxDD,
        trades: this.account.trades,
        positions: [...this.account.positions.values()],
        markers: this.account.markers
      },
      equitySeries: this.equitySeries,
      bars: Object.fromEntries(this.symbols.map(s => [s, this.state[s].lastBarTime || 0]))
    };
  }

  async persistStatus() {
    if (!db.isEnabled()) return;
    try {
      await db.query(
        `UPDATE sessions SET status=$2, updated_at=now(), config=$3 WHERE id=$1`,
        [this.id, this.status, JSON.stringify({ symbols: this.symbols, interval: this.interval, model: this.model, contra: this.contra, params: this.P })]
      );
    } catch (e) { /* ignore */ }
  }

  async persistTrade(tr) {
    if (!db.isEnabled() || !tr) return;
    try {
      await db.query(
        `INSERT INTO trades(session_id, opened_at, closed_at, symbol, direction, lot, entry, exit, sl, tp, pnl, reason)
         VALUES($1, to_timestamp($2), to_timestamp($3), $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [this.id, tr.openedAt, tr.closedAt, tr.symbol, tr.dir, tr.units, tr.entry, tr.exit, tr.sl, tr.tp, tr.pnl, tr.reason]
      );
    } catch (e) { /* ignore */ }
  }
}

// ─── Мениджър на сесиите ───────────────────────────────────────────
const sessions = new Map();

// Записва всички сесии на диск (./data/paper-sessions.json — в Docker volume),
// за да оцелеят рестарт и да продължат да търгуват самостоятелно.
function saveAll() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const data = { savedAt: Date.now(), sessions: [...sessions.values()].map(s => s.serialize()) };
    fs.writeFileSync(STORE_FILE, JSON.stringify(data));
  } catch (e) { /* ignore */ }
}

function restoreSession(obj) {
  const s = new PaperSession(obj.id, {
    ownerId: obj.ownerId, symbols: obj.symbols, interval: obj.interval, model: obj.model, contra: obj.contra, params: obj.P, refPrices: obj.refPrices
  });
  s.status = obj.status || 'running';
  s.createdAt = obj.createdAt || Date.now();
  s.startedAt = obj.startedAt || nowSec();
  s.updatedAt = obj.updatedAt || Date.now();
  const a = obj.account || {};
  s.account.initial = a.initial != null ? a.initial : s.P.budget;
  s.account.balance = a.balance != null ? a.balance : s.account.initial;
  s.account.peak = a.peak != null ? a.peak : s.account.balance;
  s.account.maxDD = a.maxDD || 0;
  s.account.trades = Array.isArray(a.trades) ? a.trades : [];
  s.account.markers = Array.isArray(a.markers) ? a.markers : [];
  s.account.positions = new Map((a.positions || []).map(p => [p.symbol, p]));
  s.equitySeries = Array.isArray(obj.equitySeries) ? obj.equitySeries : [];
  for (const sym of s.symbols) if (obj.bars && obj.bars[sym]) s.state[sym].lastBarTime = obj.bars[sym];
  return s;
}

// Зарежда запазените сесии при старт и подновява работата им.
async function init() {
  let data;
  try { data = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); } catch (e) { return 0; }
  if (!data || !Array.isArray(data.sessions)) return 0;
  let n = 0;
  for (const obj of data.sessions) {
    try {
      if (obj.status === 'stopped') continue;
      const s = restoreSession(obj);
      sessions.set(s.id, s);
      if (s.status === 'running' || s.status === 'paused') s.start(true);
      n++;
    } catch (e) { console.error('[paper] restore fail:', e.message); }
  }
  if (n) console.log(`[paper] възстановени ${n} сесии от диска.`);
  return n;
}

async function createSession(config) {
  const id = crypto.randomBytes(6).toString('hex');
  const s = new PaperSession(id, config);
  await s.warmup();
  sessions.set(id, s);
  s.start();
  saveAll();
  if (db.isEnabled()) {
    try {
      await db.query(
        `INSERT INTO sessions(id, status, symbol, timeframe, model, config)
         VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO UPDATE SET status=$2, updated_at=now(), config=$6`,
        [s.id, s.status, s.symbols[0] || null, s.interval, s.model,
         JSON.stringify({ symbols: s.symbols, interval: s.interval, model: s.model, contra: s.contra, params: s.P })]
      );
    } catch (e) { /* ignore */ }
  }
  return s;
}

function getSession(id) { return sessions.get(id); }
function owns(id, ownerId) {
  const s = sessions.get(id);
  if (!s) return false;
  return !s.ownerId || !ownerId || s.ownerId === ownerId;
}
function listSessions(ownerId) {
  return [...sessions.values()]
    .filter(s => !ownerId || !s.ownerId || s.ownerId === ownerId)
    .map(s => ({
      id: s.id, status: s.status, symbols: s.symbols, interval: s.interval,
      model: s.model, contra: s.contra, params: s.P,
      createdAt: s.createdAt, startedAt: s.startedAt, updatedAt: s.updatedAt,
      equity: s.account.equity(s.prices()), balance: s.account.balance,
      trades: s.account.trades.length,
      lastBars: Object.fromEntries(s.symbols.map(x => [x, s.state[x].lastBarTime || 0])),
      errors: s.symbols.filter(x => s.state[x].error).map(x => x + ': ' + s.state[x].error)
    }))
    .sort((a, b) => (b.startedAt || b.createdAt || 0) - (a.startedAt || a.createdAt || 0));
}
// Активни (работещи/на пауза) сесии на потребител — за авто-възстановяване при вход.
function activeSessions(ownerId) {
  return listSessions(ownerId).filter(s => s.status === 'running' || s.status === 'paused');
}
function removeSession(id) {
  const s = sessions.get(id);
  if (s) { s.destroy(); sessions.delete(id); saveAll(); }
}

// При спиране на процеса — записваме, за да продължат след рестарт.
let _sigHooked = false;
function hookSignals() {
  if (_sigHooked) return;
  _sigHooked = true;
  const bye = () => { try { saveAll(); } catch (e) {} process.exit(0); };
  process.on('SIGTERM', bye);
  process.on('SIGINT', bye);
}
hookSignals();

module.exports = { PaperSession, createSession, getSession, listSessions, activeSessions, owns, removeSession, init, saveAll, IV_SEC };
