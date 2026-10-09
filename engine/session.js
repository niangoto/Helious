// HEROS търговска сесия.
//  • Непрекъснат loop: НА ВСЕКИ tick (не само на затворен бар) се преизчислява
//    моделът върху последните WINDOW свещи (вкл. текущия незатворен бар) и се
//    проверяват вход/изход по текущата цена.
//  • Same-bar TP+SL се решава по 1м свещи (first-touch; при една 1м свещ —
//    песимистично SL), както в HERMES.
//  • Демо сметка: Binance Testnet (реални demo поръчки) при налични ключове;
//    иначе — виртуална paper сметка. И двете показват данните си в UI.
//  • Работи в българско време (TZ=Europe/Sofia, зададен в server.js).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const dp = require('../data-provider');
const models = require('../models');
const db = require('../db');
const { normalizeParams, entryDecision, floatingPnl, marketOpen } = require('./strategy');
const fx = require('./fx');
const broker = require('./broker');
const { specFor } = require('./symbolSpec');
const { PaperAccount } = require('./paperBroker');

const IV_SEC = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 };
const WINDOW = 1000;         // свещи за модела/ATR
const TICK_MS = 3000;        // период на непрекъснатата проверка
const MAX_EQ = 4000;         // горна граница на точките в equitySeries (разреждане)
const MARGIN_LEVEL_MIN = 50; // под това ниво (капитал/нотионал) затваряме на загуба
const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'paper-sessions.json');

const nowSec = () => Math.floor(Date.now() / 1000);
const startOfDay = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
const startOfWeek = () => { const d = new Date(); const day = (d.getDay() + 6) % 7; d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - day); return d.getTime(); };
const startOfMonth = () => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(1); return d.getTime(); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class PaperSession {
  constructor(id, config) {
    config = config || {};
    this.id = id;
    this.ownerId = config.ownerId || null;
    this.symbols = (Array.isArray(config.symbols) && config.symbols.length ? config.symbols : ['BTCUSDT'])
      .map(s => String(s).toUpperCase().trim()).filter(Boolean).slice(0, 10);
    this.interval = IV_SEC[config.interval] ? config.interval : '1h';
    this.model = Number.isInteger(config.model) ? config.model : 1;
    this.contra = Array.isArray(config.contra) ? config.contra.slice(0, 6) : [];
    this.P = normalizeParams(config.params || config);
    this.refPrices = (config.refPrices && typeof config.refPrices === 'object') ? Object.assign({}, config.refPrices) : {};
    this.broker = config.broker || null;                       // { market, apiKey, apiSecret }
    this.mode = this.broker ? 'live' : 'paper';                // 'live' = Binance Testnet
    this.account = new PaperAccount(this.P.budget);            // (paper режим)
    this.live = this.mode === 'live' ? {
      startBalance: null, equity: 0, balance: 0, available: 0, unrealized: 0,
      snapshot: null, positions: new Map(), trades: [], markers: [], maxDD: 0, peak: 0
    } : null;
    this.status = 'running';
    this.error = null;
    this.createdAt = Date.now();
    this.startedAt = null;
    this.updatedAt = Date.now();
    this.state = {};
    for (const s of this.symbols) this.state[s] = { candles: [], lastBarTime: 0, source: null, error: null, prob: null, probTime: 0 };
    this.equitySeries = [];
    this.timer = null;
    this.listeners = new Set();
    this._ticking = false;
    this._lastSnapshot = 0;
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { const st = this.getState(); for (const fn of this.listeners) { try { fn(st); } catch (e) {} } }

  get isLive() { return this.mode === 'live'; }
  positionsMap() { return this.isLive ? this.live.positions : this.account.positions; }
  getPosition(sym) { return this.positionsMap().get(sym) || null; }
  tradeList() { return this.isLive ? this.live.trades : this.account.trades; }
  markersFor(sym) {
    const list = this.isLive ? this.live.markers : this.account.markers;
    return list.filter(m => m.symbol === sym).slice(-300);
  }

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
          if (!(this.refPrices[s] > 0) && last.close > 0) this.refPrices[s] = last.close;
        }
      } catch (e) {
        this.state[s].error = e.message;
      }
    }
    if (this.isLive) await this.refreshLiveAccount(true);
  }

  start(preserveStartedAt) {
    if (!preserveStartedAt || !this.startedAt) this.startedAt = nowSec();
    if (this.timer) clearInterval(this.timer);
    fx.loadRates().catch(() => {});
    this.timer = setInterval(() => { this.tick().catch(e => console.error('[trade] tick:', e.message)); }, TICK_MS);
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

  // ── Демо акаунт (Binance Testnet) ───────────────────────────────
  async refreshLiveAccount(force) {
    if (!this.broker) return;
    if (!force && Date.now() - this._lastSnapshot < 2500) return;
    this._lastSnapshot = Date.now();
    try {
      const snap = await broker.account(this.broker);
      const fxr = fx.eurRateForSymbol('BTCUSDT') || fx.eurRate('USD');
      this.live.snapshot = snap;
      this.live.balance = (snap.balance || 0) * fxr;
      this.live.available = (snap.available || 0) * fxr;
      this.live.unrealized = (snap.unrealized || 0) * fxr;
      this.live.equity = this.live.balance + this.live.unrealized;
      if (this.live.startBalance == null && this.live.balance > 0) this.live.startBalance = this.live.balance;
      if (this.live.equity > (this.live.peak || 0)) this.live.peak = this.live.equity;
      const peak = this.live.peak || this.live.equity;
      const dd = peak > 0 ? (peak - this.live.equity) / peak * 100 : 0;
      if (dd > this.live.maxDD) this.live.maxDD = dd;
    } catch (e) {
      this.error = e.message;
    }
  }

  // 1м first-touch за бар, покрил и TP, и SL (както в HERMES).
  async resolve1m(symbol, barTime, ivSec, pos) {
    const need = Math.ceil((nowSec() - barTime) / 60) + Math.ceil(ivSec / 60) + 5;
    if (!(need > 0)) return { exitPrice: pos.sl, reason: 'SL' };
    let arr = [];
    try { const r = await dp.fetchData(symbol, '1m', Math.min(need, 40000)); arr = (r && r.candles) || []; } catch (e) { arr = []; }
    const from = barTime, to = barTime + ivSec;
    for (const m of arr) {
      if (m.time < from) continue;
      if (m.time >= to) break;
      if (pos.dir === 'BUY') {
        if (m.low <= pos.sl) return { exitPrice: pos.sl, reason: 'SL' };
        if (m.high >= pos.tp) return { exitPrice: pos.tp, reason: 'TP' };
      } else {
        if (m.high >= pos.sl) return { exitPrice: pos.sl, reason: 'SL' };
        if (m.low <= pos.tp) return { exitPrice: pos.tp, reason: 'TP' };
      }
    }
    return { exitPrice: pos.sl, reason: 'SL' };   // няма 1м данни → песимистично
  }

  async tick() {
    if (this._ticking || this.status === 'stopped') return;
    this._ticking = true;
    try {
      fx.loadRates().catch(() => {});
      if (this.isLive) await this.refreshLiveAccount();
      for (const s of this.symbols) {
        const st = this.state[s];
        let r;
        try { r = await dp.fetchData(s, this.interval, WINDOW); }
        catch (e) { st.error = e.message; continue; }
        if (!r || !r.candles || !r.candles.length) continue;
        st.candles = r.candles;
        st.source = r.source;
        st.error = null;
        await this.processLive(s, r.candles);
      }
      await this.enforceMarginLevel();
      this.sampleEquity();
      this.updatedAt = Date.now();
      if (Date.now() - (this._lastPersist || 0) > 30000) { saveAll(); this._lastPersist = Date.now(); }
      this.emit();
    } finally {
      this._ticking = false;
    }
  }

  // Непрекъсната обработка на текущия (последен) бар: изход + вход.
  async processLive(symbol, arr) {
    const iv = IV_SEC[this.interval];
    const bar = arr[arr.length - 1];
    if (!bar) return;
    const fxr = fx.eurRateForSymbol(symbol);
    const spec = specFor(symbol);

    // 1) Изход на отворена позиция
    const pos = this.getPosition(symbol);
    if (pos) {
      let exitPrice = null, reason = null;
      const sameBar = (bar.time === pos.openBarTime);
      if (sameBar) {
        // В бара на отваряне ползваме само текущата цена (без pre-entry екстремуми).
        if (pos.dir === 'BUY') {
          if (bar.close >= pos.tp) { exitPrice = pos.tp; reason = 'TP'; }
          else if (bar.close <= pos.sl) { exitPrice = pos.sl; reason = 'SL'; }
        } else {
          if (bar.close <= pos.tp) { exitPrice = pos.tp; reason = 'TP'; }
          else if (bar.close >= pos.sl) { exitPrice = pos.sl; reason = 'SL'; }
        }
      } else {
        const tpHit = pos.dir === 'BUY' ? (bar.high >= pos.tp) : (bar.low <= pos.tp);
        const slHit = pos.dir === 'BUY' ? (bar.low <= pos.sl) : (bar.high >= pos.sl);
        if (tpHit && slHit) {
          const r = await this.resolve1m(symbol, bar.time, iv, pos);
          exitPrice = r.exitPrice; reason = r.reason;
        } else if (tpHit) { exitPrice = pos.tp; reason = 'TP'; }
        else if (slHit) { exitPrice = pos.sl; reason = 'SL'; }
      }
      if (exitPrice === null && this.isLive) {
        // Процентно затваряне при live (моделна вероятност срещу позицията).
        const probs = models.computeModelProbSeriesLive(arr, this.model, { invert: this.contra }, WINDOW);
        const pr = probs[probs.length - 1];
        if (pr && this.P.pctClose) {
          const pOpp = (pos.dir === 'BUY' ? pr.sellPct : pr.buyPct) / 100;
          const floatPnl = floatingPnl(pos, bar.close);
          const loss = Math.max(0, -floatPnl);
          const slLoss = Math.abs(pos.entry - pos.sl) * pos.units * (pos.fx || 1);
          const limit = (this.P.pctCloseLimit > 0) ? this.P.pctCloseLimit : slLoss;
          if (pOpp * loss >= limit - 1e-9) { exitPrice = bar.close; reason = 'Процентно'; }
        }
      }
      if (exitPrice === null) {
        const held = Math.max(0, Math.round((bar.time - pos.openTime) / iv));
        if (held >= this.P.holdBars) { exitPrice = bar.close; reason = 'Време'; }
      }
      if (exitPrice !== null) await this.closePosition(symbol, exitPrice, reason, bar.time);
    }

    // 2) Вход (само running, без позиция, пазар отворен)
    if (this.status !== 'running' || this.getPosition(symbol)) return;
    if (!marketOpen(symbol, bar.time)) return;
    if (arr.length < 30) return;
    const probs = models.computeModelProbSeriesLive(arr, this.model, { invert: this.contra }, WINDOW);
    const prob = probs[probs.length - 1];
    if (!prob || !prob.buyPct) return;
    this.state[symbol].prob = prob.buyPct; this.state[symbol].probTime = bar.time;
    const atrArr = models.computeATR(arr, 14);
    const atr = atrArr[atrArr.length - 1];
    const equity = this.isLive ? (this.live.equity || 0) : this.account.equity(this.prices());
    let freeMargin;
    if (this.isLive) freeMargin = this.live.available || 0;
    else {
      let used = 0; for (const p of this.account.positions.values()) used += p.margin || 0;
      freeMargin = Math.max(0, equity - used);
    }
    const Psym = (this.refPrices[symbol] > 0) ? Object.assign({}, this.P, { refPrice: this.refPrices[symbol] }) : this.P;
    const dec = entryDecision(prob, atr, bar.close, equity, freeMargin, Psym, symbol, fxr);
    if (!dec) return;
    await this.openPosition(symbol, dec, bar, spec, fxr);
  }

  async openPosition(symbol, dec, bar, spec, fxr) {
    const pos = {
      symbol, dir: dec.dir, entry: dec.entry, lots: dec.lots, contract: spec.contract,
      units: dec.units, notional: dec.notional, margin: dec.margin, fx: dec.fx,
      tp: dec.tp, sl: dec.sl, atr: dec.atr, prob: dec.prob, spread: dec.spreadCost || 0,
      fillShift: dec.fillShift || 0, openTime: bar.time, openBarTime: bar.time
    };
    if (this.isLive) {
      if (!(await broker.symbolTradable(this.broker, symbol))) {
        this.state[symbol].error = symbol + ' не се търгува на Binance Testnet — само крипто.';
        return;
      }
      if (this.broker.market === 'spot' && dec.dir === 'SELL') {
        this.state[symbol].error = 'Спот демо сметката не позволява къси позиции (избери фючърси).';
        return;
      }
      try {
        if (this.broker.market === 'futures') await broker.setLeverage(this.broker, symbol, Math.max(1, Math.round(this.P.leverage)));
        const order = await broker.marketOrder(this.broker, symbol, dec.dir, dec.lots);
        const fill = parseFloat(order.avgPrice || order.price) || dec.entry;
        pos.entry = fill;
        pos.tp = dec.dir === 'BUY' ? fill + dec.tpDist : fill - dec.tpDist;
        pos.sl = dec.dir === 'BUY' ? fill - dec.slDist : fill + dec.slDist;
        this.live.positions.set(symbol, pos);
        this.live.markers.push({ symbol, time: bar.time, position: dec.dir === 'BUY' ? 'belowBar' : 'aboveBar', color: dec.dir === 'BUY' ? '#00ff66' : '#ff0055', shape: dec.dir === 'BUY' ? 'arrowUp' : 'arrowDown', text: dec.dir + ' ' + dec.lots + 'л' });
        this.trimMarkers();
      } catch (e) {
        this.state[symbol].error = 'Поръчка: ' + e.message;
      }
    } else {
      this.account.open(pos);
    }
  }

  async closePosition(symbol, exitPrice, reason, barTime) {
    const pos = this.getPosition(symbol);
    if (!pos) return;
    if (this.isLive) {
      try {
        const side = pos.dir === 'BUY' ? 'SELL' : 'BUY';
        const order = await broker.marketOrder(this.broker, symbol, side, pos.lots, true);
        const fill = parseFloat(order.avgPrice || order.price) || exitPrice;
        const pnl = (pos.dir === 'BUY' ? (fill - pos.entry) : (pos.entry - fill)) * pos.units * (pos.fx || 1);
        this.live.trades.push({ id: this.live.trades.length + 1, symbol, dir: pos.dir, lots: pos.lots, contract: pos.contract, units: pos.units, entry: pos.entry, exit: fill, tp: pos.tp, sl: pos.sl, openedAt: pos.openTime, closedAt: barTime, pnl, reason, prob: pos.prob, spread: pos.spread || 0 });
        this.live.positions.delete(symbol);
        this.live.markers.push({ symbol, time: barTime, position: pos.dir === 'BUY' ? 'aboveBar' : 'belowBar', color: pnl >= 0 ? '#00ff66' : '#ff0055', shape: 'circle', text: reason + (pnl >= 0 ? ' +' : ' ') + pnl.toFixed(2) + '€' });
        this.trimMarkers();
      } catch (e) {
        this.state[symbol].error = 'Затваряне: ' + e.message;
      }
    } else {
      const tr = this.account.close(symbol, exitPrice, reason, barTime);
      if (tr) this.persistTrade(tr);
    }
  }

  async enforceMarginLevel() {
    if (this.isLive) {
      const eq = this.live.equity || 0;
      let used = 0; for (const p of this.live.positions.values()) used += p.margin || 0;
      if (used > 0 && eq / used * 100 < MARGIN_LEVEL_MIN) {
        let worst = null, wl = Infinity;
        const prices = this.prices();
        for (const [sym, p] of this.live.positions) {
          const f = floatingPnl(p, prices[sym]);
          if (f < wl) { wl = f; worst = sym; }
        }
        if (worst) await this.closePosition(worst, prices[worst], 'Маржин', nowSec());
      }
      return;
    }
    for (let guard = 0; guard < 50 && this.account.positions.size; guard++) {
      const mp = this.prices();
      if (this.account.marginLevel(mp) >= MARGIN_LEVEL_MIN) break;
      const worst = this.account.worstPosition(mp);
      if (!worst) break;
      const tr = this.account.close(worst, mp[worst], 'Маржин', nowSec());
      if (tr) this.persistTrade(tr);
    }
  }

  trimMarkers() {
    const MAX = 5000;
    if (this.live && this.live.markers.length > MAX) this.live.markers.splice(0, this.live.markers.length - MAX);
  }

  sampleEquity() {
    const eq = this.isLive ? (this.live.equity || 0) : this.account.equity(this.prices());
    const floating = this.isLive ? (this.live.unrealized || 0) : this.account.floating(this.prices());
    const balance = this.isLive ? (this.live.balance || 0) : this.account.balance;
    // Само живият режим може да няма още snapshot — не пишем нулеви точки.
    if (this.isLive && !this.live.snapshot) return;
    this.equitySeries.push({ t: nowSec(), equity: eq, balance, floating });
    if (this.equitySeries.length > MAX_EQ) {
      const half = Math.floor(this.equitySeries.length / 2);
      const out = [];
      for (let i = 0; i < half; i += 2) out.push(this.equitySeries[i]);
      for (let i = half; i < this.equitySeries.length; i++) out.push(this.equitySeries[i]);
      this.equitySeries = out;
    }
  }

  pause() { if (this.status === 'running') { this.status = 'paused'; this.persistStatus(); saveAll(); this.emit(); } }
  resume() { if (this.status === 'paused') { this.status = 'running'; this.persistStatus(); saveAll(); this.emit(); } }

  async stop() {
    if (this.status === 'stopped') return;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.isLive) {
      const prices = this.prices();
      for (const sym of Array.from(this.live.positions.keys())) {
        await this.closePosition(sym, prices[sym], 'Край', nowSec());
      }
    } else {
      const p = this.prices();
      this.account.closeAll(p, nowSec(), 'Край').forEach(tr => this.persistTrade(tr));
    }
    this.status = 'stopped';
    this.persistStatus();
    saveAll();
    this.emit();
  }

  destroy() { if (this.timer) clearInterval(this.timer); this.timer = null; this.listeners.clear(); }

  periodPnl(ms, equityNow) {
    const s = this.equitySeries;
    const base0 = this.isLive ? (this.live.startBalance || equityNow) : this.account.initial;
    let base = base0;
    for (let i = s.length - 1; i >= 0; i--) {
      if (s[i].t * 1000 < ms) { base = s[i].equity; break; }
    }
    return equityNow - base;
  }

  stats() {
    if (this.isLive) {
      const equity = this.live.equity || 0;
      const floating = this.live.unrealized || 0;
      const balance = this.live.balance || 0;
      const start = this.live.startBalance || balance;
      const wins = this.live.trades.filter(t => t.pnl > 0).length;
      return {
        initial: start, balance, equity, floating,
        totalPnl: equity - start, totalPct: start > 0 ? (equity - start) / start * 100 : 0,
        trades: this.live.trades.length, wins,
        winRate: this.live.trades.length ? wins / this.live.trades.length * 100 : 0,
        openCount: this.live.positions.size, maxDD: this.live.maxDD || 0,
        dayPnl: this.periodPnl(startOfDay(), equity),
        weekPnl: this.periodPnl(startOfWeek(), equity),
        monthPnl: this.periodPnl(startOfMonth(), equity)
      };
    }
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
    const prices = this.prices();
    const symbols = {};
    for (const sym of this.symbols) {
      const st = this.state[sym];
      symbols[sym] = {
        source: st.source,
        error: st.error,
        contract: specFor(sym).contract,
        lastBarTime: st.lastBarTime,
        prob: st.prob,
        probTime: st.probTime,
        candles: st.candles.slice(-800).map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })),
        markers: this.markersFor(sym)
      };
    }
    const openPositions = [...this.positionsMap().values()].map(pos => ({
      symbol: pos.symbol, dir: pos.dir, entry: pos.entry, lots: pos.lots, contract: pos.contract,
      units: pos.units, notional: pos.notional, margin: pos.margin, tp: pos.tp, sl: pos.sl,
      openTime: pos.openTime, prob: pos.prob, spread: pos.spread || 0, fx: pos.fx || 1,
      floating: prices[pos.symbol] != null ? floatingPnl(pos, prices[pos.symbol]) : null
    }));
    const snap = this.live && this.live.snapshot;
    const account = this.isLive ? {
      mode: 'live', broker: 'Binance Testnet', market: this.broker && this.broker.market,
      currency: 'USDT',
      balance: snap ? snap.balance : this.live.balance,
      available: snap ? snap.available : this.live.available,
      equity: snap ? snap.equity : this.live.equity,
      unrealized: snap ? snap.unrealized : this.live.unrealized,
      positions: (snap && snap.positions) || []
    } : { mode: 'paper', currency: 'EUR', balance: this.account.balance, equity: this.account.equity(prices) };
    return {
      id: this.id, status: this.status, error: this.error, mode: this.mode,
      createdAt: this.createdAt, startedAt: this.startedAt, updatedAt: this.updatedAt,
      config: { symbols: this.symbols, interval: this.interval, model: this.model, contra: this.contra, params: this.P },
      stats: this.stats(), account, openPositions,
      trades: this.tradeList().slice(-100),
      symbols, equitySeries: this.equitySeries
    };
  }

  serialize() {
    return {
      id: this.id, ownerId: this.ownerId, symbols: this.symbols, interval: this.interval,
      model: this.model, contra: this.contra, P: this.P, refPrices: this.refPrices,
      mode: this.mode, status: this.status, createdAt: this.createdAt, startedAt: this.startedAt,
      updatedAt: this.updatedAt,
      account: {
        initial: this.account.initial, balance: this.account.balance, peak: this.account.peak,
        maxDD: this.account.maxDD, trades: this.account.trades,
        positions: [...this.account.positions.values()], markers: this.account.markers
      },
      live: this.live ? {
        startBalance: this.live.startBalance, peak: this.live.peak, maxDD: this.live.maxDD,
        trades: this.live.trades, positions: [...this.live.positions.values()], markers: this.live.markers
      } : null,
      equitySeries: this.equitySeries,
      bars: Object.fromEntries(this.symbols.map(s => [s, this.state[s].lastBarTime || 0]))
    };
  }

  async persistStatus() {
    if (!db.isEnabled()) return;
    try {
      await db.query(`UPDATE sessions SET status=$2, updated_at=now(), config=$3 WHERE id=$1`,
        [this.id, this.status, JSON.stringify({ symbols: this.symbols, interval: this.interval, model: this.model, contra: this.contra, params: this.P, mode: this.mode })]);
    } catch (e) { /* ignore */ }
  }

  async persistTrade(tr) {
    if (!db.isEnabled() || !tr) return;
    try {
      await db.query(
        `INSERT INTO trades(session_id, opened_at, closed_at, symbol, direction, lot, entry, exit, sl, tp, pnl, reason)
         VALUES($1, to_timestamp($2), to_timestamp($3), $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [this.id, tr.openedAt, tr.closedAt, tr.symbol, tr.dir, tr.units, tr.entry, tr.exit, tr.sl, tr.tp, tr.pnl, tr.reason]);
    } catch (e) { /* ignore */ }
  }
}

// ─── Мениджър на сесиите ───────────────────────────────────────────
const sessions = new Map();

function saveAll() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const data = { savedAt: Date.now(), sessions: [...sessions.values()].map(s => s.serialize()) };
    fs.writeFileSync(STORE_FILE, JSON.stringify(data));
  } catch (e) { /* ignore */ }
}

function restoreSession(obj) {
  // За live сесии ключовете не се пазят във файла — взимат се от профила.
  let brokerCreds = null;
  if (obj.mode === 'live') {
    try { brokerCreds = require('./brokerStore').getCredentials(obj.ownerId); } catch (e) { brokerCreds = null; }
  }
  const s = new PaperSession(obj.id, {
    ownerId: obj.ownerId, symbols: obj.symbols, interval: obj.interval, model: obj.model,
    contra: obj.contra, params: obj.P, refPrices: obj.refPrices, broker: brokerCreds
  });
  s.status = obj.status || 'running';
  s.createdAt = obj.createdAt || Date.now();
  s.startedAt = obj.startedAt || nowSec();
  s.updatedAt = obj.updatedAt || Date.now();
  if (s.isLive) {
    const L = obj.live || {};
    s.live.startBalance = L.startBalance != null ? L.startBalance : null;
    s.live.peak = L.peak || 0;
    s.live.maxDD = L.maxDD || 0;
    s.live.trades = Array.isArray(L.trades) ? L.trades : [];
    s.live.markers = Array.isArray(L.markers) ? L.markers : [];
    s.live.positions = new Map((L.positions || []).map(p => [p.symbol, p]));
  } else {
    const a = obj.account || {};
    s.account.initial = a.initial != null ? a.initial : s.P.budget;
    s.account.balance = a.balance != null ? a.balance : s.account.initial;
    s.account.peak = a.peak != null ? a.peak : s.account.balance;
    s.account.maxDD = a.maxDD || 0;
    s.account.trades = Array.isArray(a.trades) ? a.trades : [];
    s.account.markers = Array.isArray(a.markers) ? a.markers : [];
    s.account.positions = new Map((a.positions || []).map(p => [p.symbol, p]));
  }
  s.equitySeries = Array.isArray(obj.equitySeries) ? obj.equitySeries : [];
  for (const sym of s.symbols) if (obj.bars && obj.bars[sym]) s.state[sym].lastBarTime = obj.bars[sym];
  return s;
}

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
    } catch (e) { console.error('[trade] restore fail:', e.message); }
  }
  if (n) console.log(`[trade] възстановени ${n} сесии от диска.`);
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
         JSON.stringify({ symbols: s.symbols, interval: s.interval, model: s.model, contra: s.contra, params: s.P, mode: s.mode })]);
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
      id: s.id, status: s.status, mode: s.mode, symbols: s.symbols, interval: s.interval,
      model: s.model, contra: s.contra, params: s.P,
      createdAt: s.createdAt, startedAt: s.startedAt, updatedAt: s.updatedAt,
      equity: s.isLive ? s.live.equity : s.account.equity(s.prices()),
      balance: s.isLive ? s.live.balance : s.account.balance,
      trades: s.tradeList().length,
      lastBars: Object.fromEntries(s.symbols.map(x => [x, s.state[x].lastBarTime || 0])),
      errors: s.symbols.filter(x => s.state[x].error).map(x => x + ': ' + s.state[x].error)
    }))
    .sort((a, b) => (b.startedAt || b.createdAt || 0) - (a.startedAt || a.createdAt || 0));
}
function activeSessions(ownerId) {
  return listSessions(ownerId).filter(s => s.status === 'running' || s.status === 'paused');
}
function removeSession(id) {
  const s = sessions.get(id);
  if (s) { s.destroy(); sessions.delete(id); saveAll(); }
}

let _sigHooked = false;
function hookSignals() {
  if (_sigHooked) return;
  _sigHooked = true;
  const bye = () => { try { saveAll(); } catch (e) {} process.exit(0); };
  process.on('SIGTERM', bye);
  process.on('SIGINT', bye);
}
hookSignals();

module.exports = { PaperSession, createSession, getSession, listSessions, activeSessions, owns, removeSession, init, saveAll, IV_SEC, WINDOW, TICK_MS };
