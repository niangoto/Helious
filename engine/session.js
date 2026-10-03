// Paper търговска сесия: на всеки затворен бар смята вероятност по модела,
// влиза/излиза на виртуална сметка и подава живо състояние към UI (SSE).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const dp = require('../data-provider');
const models = require('../models');
const db = require('../db');
const { normalizeParams, entryDecision, exitDecision } = require('./strategy');
const { PaperAccount } = require('./paperBroker');

const IV_SEC = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 };
const WINDOW = 1000;      // свещи за модела/ATR
const POLL_MS = 5000;     // период на проверка
const MAX_NEW_BARS = 20;  // колко изпуснати бара да навакса наведнъж
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
    this.symbols = (Array.isArray(config.symbols) && config.symbols.length ? config.symbols : ['BTCUSDT'])
      .map(s => String(s).toUpperCase().trim()).filter(Boolean).slice(0, 10);
    this.interval = IV_SEC[config.interval] ? config.interval : '1h';
    this.model = Number.isInteger(config.model) ? config.model : 0;
    this.contra = Array.isArray(config.contra) ? config.contra.slice(0, 6) : [];
    this.P = normalizeParams(config.params || config);
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
        }
      } catch (e) {
        this.state[s].error = e.message;
      }
    }
  }

  start(preserveStartedAt) {
    if (!preserveStartedAt || !this.startedAt) this.startedAt = nowSec();
    if (this.timer) clearInterval(this.timer);
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

        const newBars = arr.filter(c => c.time > st.lastBarTime && c.time + iv <= nowSec()).slice(-MAX_NEW_BARS);
        for (const bar of newBars) {
          const idx = arr.indexOf(bar);
          if (idx >= 0) this.processBar(s, arr, idx, bar);
        }
        st.lastBarTime = newBars.length ? newBars[newBars.length - 1].time : closed.time;
      }

      const p = this.prices();
      const eq = this.account.equity(p);
      this.equitySeries.push({ t: nowSec(), equity: eq, balance: this.account.balance, floating: this.account.floating(p) });
      if (this.equitySeries.length > 6000) this.equitySeries.splice(0, this.equitySeries.length - 6000);
      this.updatedAt = Date.now();
      // Периодично записване на състоянието (за възстановяване след рестарт)
      if (Date.now() - (this._lastPersist || 0) > 10000) { saveAll(); this._lastPersist = Date.now(); }
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

    // 2) Вход (само ако не сме на пауза и няма позиция на този символ)
    if (this.status !== 'running' || this.account.positions.get(symbol)) return;
    const win = arr.slice(0, idx + 1).slice(-WINDOW);
    if (win.length < 30) return;
    let probs;
    try { probs = models.computeModelProbSeries(win, this.model, { invert: this.contra }); }
    catch (e) { return; }
    const prob = probs[probs.length - 1];
    if (!prob) return;
    const atrArr = models.computeATR(win, 14);
    const atr = atrArr[atrArr.length - 1];
    const dec = entryDecision(prob, atr, bar.close, this.account.balance, this.P);
    if (!dec) return;
    this.account.open({
      symbol,
      dir: dec.dir,
      entry: dec.entry,
      units: dec.units,
      notional: dec.notional,
      margin: dec.margin,
      tp: dec.tp,
      sl: dec.sl,
      atr: dec.atr,
      prob: dec.prob,
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

  stats() {
    const p = this.prices();
    const s = this.account.summary(p);
    const sumSince = (ms) => this.account.trades.filter(t => (t.closedAt * 1000) >= ms).reduce((a, t) => a + t.pnl, 0);
    return {
      ...s,
      dayPnl: sumSince(startOfDay()),
      weekPnl: sumSince(startOfWeek()),
      monthPnl: sumSince(startOfMonth())
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
        lastBarTime: st.lastBarTime,
        candles: st.candles.slice(-800).map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })),
        markers: this.account.markers.filter(m => m.symbol === sym).slice(-300)
      };
    }
    const openPositions = [...this.account.positions.values()].map(pos => ({
      symbol: pos.symbol,
      dir: pos.dir,
      entry: pos.entry,
      units: pos.units,
      tp: pos.tp,
      sl: pos.sl,
      openTime: pos.openTime,
      prob: pos.prob,
      floating: p[pos.symbol] != null ? (pos.dir === 'BUY' ? (p[pos.symbol] - pos.entry) * pos.units : (pos.entry - p[pos.symbol]) * pos.units) : null
    }));
    return {
      id: this.id,
      status: this.status,
      error: this.error,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
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
      equitySeries: this.equitySeries.slice(-1500)
    };
  }

  serialize() {
    return {
      id: this.id,
      symbols: this.symbols,
      interval: this.interval,
      model: this.model,
      contra: this.contra,
      P: this.P,
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
    symbols: obj.symbols, interval: obj.interval, model: obj.model, contra: obj.contra, params: obj.P
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
function listSessions() {
  return [...sessions.values()].map(s => ({
    id: s.id, status: s.status, symbols: s.symbols, interval: s.interval,
    model: s.model, startedAt: s.startedAt, equity: s.account.equity(s.prices())
  }));
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

module.exports = { PaperSession, createSession, getSession, listSessions, removeSession, init, saveAll, IV_SEC };
