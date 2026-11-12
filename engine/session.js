// HEROS търговска сесия — реална (демо или реална) сметка в MetaTrader 5.
//  • Няма симулация: цени, спред, суап, маржин, позиции и история идват от
//    MT5 агента (engine/mt5.js ↔ mt5-agent.py на Windows компютъра).
//  • Непрекъснат loop на всеки ~3с: snapshot от MT5 → модел върху последните
//    WINDOW свещи (вкл. текущия бар) → решение вход/изход → команда към MT5.
//  • TP/SL се задават директно в ордера в MT5 (защита, ако връзката падне);
//    времевото затваряне и маржин нивото се правят от сървъра.
//  • Позициите на сесията се разпознават по `magic` номер; MT5 е източник на истината.
//  • Работи в българско време (TZ=Europe/Sofia, зададен в server.js).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const models = require('../models');
const db = require('../db');
const mt5 = require('./mt5');
const { normalizeParams, entryDecision } = require('./strategy');

const IV_SEC = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 };
const WINDOW = 2000;          // свещи за модела/ATR
const TICK_MS = 3000;         // период на непрекъснатата проверка
const MAX_EQ = 4000;          // горна граница на точките в equitySeries
const MARGIN_LEVEL_MIN = 50;  // под това ниво на маржина затваряме най-губещата позиция
const STALE_TICK_SEC = 300;   // по-стар тик → пазарът е затворен
const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'mt5-sessions.json');

const nowSec = () => Math.floor(Date.now() / 1000);
const startOfDay = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
const startOfWeek = () => { const d = new Date(); const day = (d.getDay() + 6) % 7; d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - day); return d.getTime(); };
const startOfMonth = () => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(1); return d.getTime(); };

class Session {
  constructor(id, config) {
    config = config || {};
    this.id = id;
    this.ownerId = config.ownerId || null;
    this.agentId = config.agentId || null;
    // Имената са точно като в MT5 (чувствителни към главни/малки, напр. GER30.cash).
    this.symbols = (Array.isArray(config.symbols) ? config.symbols : [])
      .map(s => String(s).trim()).filter(Boolean).slice(0, 10);
    this.interval = IV_SEC[config.interval] ? config.interval : '1h';
    this.model = Number.isInteger(config.model) ? config.model : 1;
    this.contra = Array.isArray(config.contra) ? config.contra.slice(0, 6) : [];
    this.P = normalizeParams(config.params || config);
    this.magic = config.magic || (parseInt(String(id).slice(0, 7), 16) % 2000000000) + 1;
    this.status = 'running';
    this.error = null;
    this.createdAt = Date.now();
    this.startedAt = null;
    this.updatedAt = Date.now();
    this.state = {};
    for (const s of this.symbols) this.state[s] = { candles: [], lastBarTime: 0, error: null, prob: null, probTime: 0, info: null, cooldown: 0, hist: [] };
    this.account = null;            // последен snapshot на сметката
    this.connected = false;
    this.positions = new Map();     // ticket → позиция на сесията
    this.trades = [];               // затворени сделки (от историята на MT5)
    this.tradeIds = new Set();
    this.closeReasons = new Map();  // ticket → причина, зададена от нас
    this.startBalance = null;
    this.realized = 0;
    this.peak = 0; this.maxDD = 0;
    this.equitySeries = [];
    this.timer = null;
    this.listeners = new Set();
    this._ticking = false;
    this._lastPersist = 0;
  }

  window() { return this.P.lookback || WINDOW; }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { const st = this.getState(); for (const fn of this.listeners) { try { fn(st); } catch (e) {} } }

  start(preserveStartedAt) {
    if (!preserveStartedAt || !this.startedAt) this.startedAt = nowSec();
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => { this.tick().catch(e => console.error('[trade] tick:', e.message)); }, TICK_MS);
    this.tick().catch(() => {});
    this.emit();
  }

  // ── Данни от MT5 ──────────────────────────────────────────
  async fetchSnapshot() {
    const iv = IV_SEC[this.interval];
    const now = nowSec();
    const req = this.symbols.map(name => {
      const st = this.state[name];
      const last = st.candles.length ? st.candles[st.candles.length - 1].time : 0;
      const gap = last > 0 && (now - last) > 4 * iv;      // дупка → тегли отначало
      return { name, interval: this.interval, count: this.window(), from: (last > 0 && !gap && st.candles.length >= 30) ? last : 0 };
    });
    return mt5.call(this.agentId, 'snapshot', {
      symbols: req, magic: this.magic, historyFrom: Math.max(0, (this.startedAt || now) - 3600),
      pnlFrom: Math.floor(Math.min(startOfMonth(), startOfWeek(), startOfDay()) / 1000) - 3600
    });
  }

  ingest(snap) {
    this.account = snap.account || null;
    if (Array.isArray(snap.pnl_deals)) this.pnlDeals = snap.pnl_deals;   // всички сделки по сметката от началото на месеца
    this.connected = !!this.account;
    if (this.account) {
      if (this.startBalance == null && this.account.balance > 0) this.startBalance = this.account.balance;
    }
    for (const name of this.symbols) {
      const st = this.state[name];
      const d = snap.symbols && snap.symbols[name];
      if (!d) { st.error = 'Няма данни от MT5 за ' + name; continue; }
      if (d.error) { st.error = d.error; continue; }
      st.error = null;
      st.info = {
        bid: d.bid, ask: d.ask, spread: Math.max(0, d.ask - d.bid), point: d.point, digits: d.digits,
        contract: d.contract, vmin: d.vmin, vmax: d.vmax, vstep: d.vstep,
        tickValue: d.tick_value, tickSize: d.tick_size, swapLong: d.swap_long, swapShort: d.swap_short,
        swapMode: d.swap_mode, margin1: d.margin_1lot, tradeAllowed: d.trade_allowed !== false,
        tickAge: d.tick_age, stopsLevel: d.stops_level || 0
      };
      if (Array.isArray(d.candles) && d.candles.length) {
        const add = d.candles.map(c => ({ time: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] || 0 }));
        const first = add[0].time;
        let keep = st.candles.filter(c => c.time < first);
        if (d.candles_full) keep = [];
        st.candles = keep.concat(add).slice(-(this.window() + 50));
        const iv = IV_SEC[this.interval];
        const arr = st.candles, last = arr[arr.length - 1];
        const closed = (last.time + iv) <= nowSec() ? last : (arr[arr.length - 2] || last);
        st.lastBarTime = closed ? closed.time : 0;
      }
    }
    // Позиции на сесията (по magic)
    const mine = new Map();
    for (const p of (snap.positions || [])) {
      if (p.magic !== this.magic) continue;
      mine.set(p.ticket, {
        ticket: p.ticket, symbol: p.symbol, dir: p.type, lots: p.volume, entry: p.price_open,
        sl: p.sl, tp: p.tp, profit: p.profit, swap: p.swap, commission: p.commission || 0,
        openTime: p.time, price: p.price_current,
        prob: (this.positions.get(p.ticket) || {}).prob || null
      });
    }
    this.positions = mine;
    // Затворени сделки от историята
    for (const t of (snap.deals || [])) {
      if (this.tradeIds.has(t.ticket)) continue;
      this.tradeIds.add(t.ticket);
      const reason = this.closeReasons.get(t.ticket) || ({ TP: 'TP', SL: 'SL', SO: 'Маржин' }[t.reason] || 'Ръчно/MT5');
      this.trades.push({
        id: this.trades.length + 1, ticket: t.ticket, symbol: t.symbol, dir: t.type, lots: t.volume,
        entry: t.price_open, exit: t.price_close, openedAt: t.time_open, closedAt: t.time_close,
        pnl: (t.profit || 0) + (t.swap || 0) + (t.commission || 0), swap: t.swap || 0, commission: t.commission || 0,
        reason, spread: 0
      });
    }
    this.trades.sort((a, b) => a.closedAt - b.closedAt);
    this.realized = this.trades.reduce((s, t) => s + t.pnl, 0);
  }

  floatingTotal() {
    let f = 0;
    for (const p of this.positions.values()) f += (p.profit || 0) + (p.swap || 0) + (p.commission || 0);
    return f;
  }
  sessionEquity() { return (this.startBalance || 0) + this.realized + this.floatingTotal(); }

  async tick() {
    if (this._ticking || this.status === 'stopped') return;
    this._ticking = true;
    try {
      let snap;
      try {
        snap = await this.fetchSnapshot();
        this.error = null;
      } catch (e) {
        this.connected = false;
        this.error = e.message;
        this.emit();
        return;
      }
      this.ingest(snap);
      await this.manage();
      this.trackDrawdown();
      this.sampleEquity();
      this.updatedAt = Date.now();
      if (Date.now() - this._lastPersist > 30000) { saveAll(); this._lastPersist = Date.now(); }
      this.emit();
    } finally {
      this._ticking = false;
    }
  }

  trackDrawdown() {
    const eq = this.sessionEquity();
    if (eq > this.peak) this.peak = eq;
    const dd = this.peak > 0 ? (this.peak - eq) / this.peak * 100 : 0;
    if (dd > this.maxDD) this.maxDD = dd;
  }

  async manage() {
    // Маржин ниво — затваря най-губещата позиция на сесията.
    const a = this.account;
    if (a && a.margin > 0 && a.margin_level > 0 && a.margin_level < MARGIN_LEVEL_MIN && this.positions.size) {
      let worst = null, wl = Infinity;
      for (const p of this.positions.values()) { const f = p.profit + p.swap; if (f < wl) { wl = f; worst = p; } }
      if (worst) await this.closeTicket(worst, 'Маржин');
    }
    for (const s of this.symbols) {
      const st = this.state[s];
      if (!st.candles.length || !st.info) { st.why = { level: 'block', text: st.error || 'Още няма данни от MT5 за символа', time: nowSec() }; continue; }
      await this.processSymbol(s, st);
    }
  }

  async processSymbol(symbol, st) {
    const arr = st.candles;
    const bar = arr[arr.length - 1];
    const iv = IV_SEC[this.interval];

    let prob = null;
    if (arr.length >= 30) {
      try {
        // Както computeModelProbSeriesStrict в HERMES за последния бар: моделът се
        // смята САМО върху последните `lookback` свещи (индикаторите — от началото им).
        const W = Math.max(30, this.window());
        const win = arr.length > W ? arr.slice(arr.length - W) : arr;
        const vals = models.computeModelProbCore(win, this.model, { invert: this.contra, intervalSec: iv, lookback: W });
        const v = vals ? vals[vals.length - 1] : null;
        prob = v != null ? { time: bar.time, buyPct: v, sellPct: 100 - v } : null;
      } catch (e) { prob = null; }
    }
    if (prob && prob.buyPct) {
      st.prob = prob.buyPct; st.probTime = bar.time; st.probAt = nowSec();
      // История на вероятностите, каквито алгоритъмът реално ги е виждал (за лентата под графиката).
      st.hist.push([nowSec(), Math.round(prob.buyPct * 10) / 10]);
      if (st.hist.length > 16000) {          // разреждаме по-старата половина (≈ 1 на 2 проверки)
        const half = Math.floor(st.hist.length / 2), out = [];
        for (let i = 0; i < half; i += 2) out.push(st.hist[i]);
        st.hist = out.concat(st.hist.slice(half));
      }
    }

    // 1) Изход по време (TP/SL са в MT5 и се изпълняват от брокера)
    for (const pos of [...this.positions.values()]) {
      if (pos.symbol !== symbol) continue;
      const held = Math.max(0, Math.floor((nowSec() - pos.openTime) / iv));
      if (held >= this.P.holdBars) { await this.closeTicket(pos, 'Време'); continue; }
      // Процентно затваряне: вероятност срещу позицията × плаваща загуба ≥ лимит
      if (this.P.pctClose && prob && st.info) {
        const i = st.info;
        const fx = (i.contract > 0 && i.tickSize > 0) ? (i.tickValue / i.tickSize) / i.contract : 1;
        const units = pos.lots * (i.contract || 1);
        const loss = Math.max(0, -((pos.profit || 0) + (pos.swap || 0) + (pos.commission || 0)));
        const slLoss = Math.abs(pos.entry - pos.sl) * units * fx;
        const limit = this.P.pctCloseLimit > 0 ? this.P.pctCloseLimit : slLoss;
        const pOpp = (pos.dir === 'BUY' ? prob.sellPct : prob.buyPct) / 100;
        if (limit > 0 && loss > 0 && pOpp * loss >= limit - 1e-9) await this.closeTicket(pos, 'Процентно');
      }
    }

    // 2) Вход — при всеки отказ записваме ПРИЧИНАТА в st.why (показва се в UI).
    const why = (level, text) => { st.why = { level, text, time: nowSec() }; };
    const probTxt = (prob && prob.buyPct) ? ' (Buy ' + prob.buyPct.toFixed(1) + '% / Sell ' + prob.sellPct.toFixed(1) + '%)' : '';
    if (this.status !== 'running') { why('block', 'Сесията е на пауза'); return; }
    if (Date.now() < st.cooldown) { why('block', 'Пауза ' + Math.ceil((st.cooldown - Date.now()) / 1000) + 'с след отказана поръчка — ' + (st.error || '')); return; }
    if ([...this.positions.values()].some(p => p.symbol === symbol)) { why('info', 'Има отворена позиция по този символ — нов вход не се прави'); return; }
    if (this.positions.size >= this.P.maxPositions) { why('block', 'Достигнат лимит „Макс. позиции“ (' + this.P.maxPositions + ')'); return; }
    const info = st.info;
    if (!info.tradeAllowed) { why('block', 'Търговията по символа е забранена в MT5 (режимът не е „пълен“)'); return; }
    if (!(info.tickAge < STALE_TICK_SEC)) { why('block', 'Пазарът е затворен — последният тик е отпреди ' + Math.round(info.tickAge / 60) + ' мин'); return; }
    if (!this.account || !this.account.trade_allowed) { why('block', 'В MT5 е изключена алгоритмичната търговия („Algo Trading“) или сметката е само за четене'); return; }
    if (!prob || !prob.buyPct) { why('block', 'Няма вероятност — малко свещи (' + arr.length + ', трябват ≥ 30)'); return; }
    if (!(info.contract > 0) || !(info.tickValue > 0) || !(info.tickSize > 0)) { why('block', 'MT5 не дава contract size / tick value за символа'); return; }

    const atrArr = models.computeATR(arr, 14);
    const atr = atrArr[atrArr.length - 1];
    const mid = (info.bid + info.ask) / 2;
    const fx = (info.tickValue / info.tickSize) / info.contract;     // валута на сметката за 1 единица от цената
    let equity = this.account.equity || 0;
    if (this.P.budget > 0) equity = Math.min(equity, this.P.budget);
    const freeMargin = this.account.margin_free || 0;
    const spec = {
      contract: info.contract, min: info.vmin, step: info.vstep, max: info.vmax,
      spread: info.spread, marginPerUnit: info.margin1 > 0 ? info.margin1 / info.contract : 0
    };
    const w = {};
    const dec = entryDecision(prob, atr, mid, equity, freeMargin, this.P, symbol, fx, spec, w);
    if (!dec) {
      const weak = /^Сигналът е слаб/.test(w.reason || '');
      why(weak ? 'wait' : 'block', w.reason || 'Няма решение за вход');
      return;
    }

    // Суап: по избор не отваряме при отрицателен суап за посоката.
    const swap = dec.dir === 'BUY' ? info.swapLong : info.swapShort;
    if (this.P.skipNegSwap && swap < 0) { why('block', 'Сигнал ' + dec.dir + ', но суапът е отрицателен (' + swap + ') и е включено „Не отваряй при отрицателен суап“'); return; }

    // Лимити на агента (max_volume / max_positions / allowed_symbols): подравняваме обема
    // към тях, вместо агентът да откаже поръчката.
    const lim = mt5.limits(this.agentId);
    if (lim) {
      if (Array.isArray(lim.allowed_symbols) && lim.allowed_symbols.length && !lim.allowed_symbols.includes(symbol)) {
        why('block', symbol + ' не е в allowed_symbols на агента (mt5-agent.config.json)'); return;
      }
      if (lim.max_volume > 0 && dec.lots > lim.max_volume + 1e-9) {
        const step = info.vstep > 0 ? info.vstep : 0.01;
        let cl = Math.floor(lim.max_volume / step + 1e-9) * step;
        cl = Math.round(cl * 1e8) / 1e8;
        if (cl < info.vmin) { why('block', 'Лимитът max_volume на агента (' + lim.max_volume + ') е под минималния обем на символа (' + info.vmin + ')'); return; }
        dec.clampedFrom = dec.lots; dec.lots = cl;
      }
    }
    // Минимално разстояние на SL/TP от цената (stops level на брокера).
    const minDist = (info.stopsLevel || 0) * (info.point || 0) + info.spread;
    if (minDist > 0 && Math.min(dec.tpDist, dec.slDist) < minDist) {
      why('block', 'TP/SL (' + Math.min(dec.tpDist, dec.slDist).toPrecision(3) + ') са по-близо от минимума на брокера (' + minDist.toPrecision(3) + ') — увеличи TP/SL множителите или интервала'); return;
    }

    // Реалният вход е ask (BUY) / bid (SELL); нивата са от него.
    const fill = dec.dir === 'BUY' ? info.ask : info.bid;
    const tp = dec.dir === 'BUY' ? fill + dec.tpDist : fill - dec.tpDist;
    const sl = dec.dir === 'BUY' ? fill - dec.slDist : fill + dec.slDist;
    const baseTxt = ' · капитал ' + equity.toFixed(2) + ', свободен маржин ' + freeMargin.toFixed(2) + ' ' + ((this.account && this.account.currency) || '');
    why('ok', 'Сигнал ' + dec.dir + probTxt + ' — изпращам поръчка за ' + dec.lots + ' лота' + (dec.clampedFrom ? ' (намален от ' + dec.clampedFrom + ' заради max_volume на агента)' : '') + (dec.forcedMin ? ' (минималният обем е над риска по Кели)' : '') + baseTxt);
    try {
      const r = await mt5.call(this.agentId, 'order_open', {
        symbol, side: dec.dir, volume: dec.lots, sl, tp, magic: this.magic, comment: 'HEROS'
      }, 30000);
      this.positions.set(r.ticket, {
        ticket: r.ticket, symbol, dir: dec.dir, lots: r.volume || dec.lots, entry: r.price || fill, sl, tp,
        profit: 0, swap: 0, commission: 0, openTime: nowSec(), price: r.price || fill, prob: dec.prob
      });
      st.error = null;
    } catch (e) {
      st.error = 'Поръчка: ' + e.message;
      st.cooldown = Date.now() + 30000;
      why('block', 'Поръчката ' + dec.dir + ' ' + dec.lots + ' лота е отказана: ' + e.message);
    }
  }

  async closeTicket(pos, reason) {
    try {
      this.closeReasons.set(pos.ticket, reason);
      await mt5.call(this.agentId, 'order_close', { ticket: pos.ticket, symbol: pos.symbol, magic: this.magic, comment: 'HEROS ' + reason }, 30000);
      this.positions.delete(pos.ticket);
    } catch (e) {
      this.closeReasons.delete(pos.ticket);
      const st = this.state[pos.symbol];
      if (st) st.error = 'Затваряне: ' + e.message;
    }
  }

  sampleEquity() {
    if (!this.connected || this.startBalance == null) return;
    const eq = this.sessionEquity();
    this.equitySeries.push({ t: nowSec(), equity: eq, balance: this.startBalance + this.realized, floating: this.floatingTotal() });
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

  // keepPositions=true → спира алгоритъма, но оставя отворените позиции в MT5 (с техните SL/TP).
  async stop(keepPositions) {
    if (this.status === 'stopped') return;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (!keepPositions) {
      for (const pos of [...this.positions.values()]) await this.closeTicket(pos, 'Край');
    }
    this.status = 'stopped';
    this.persistStatus();
    saveAll();
    this.emit();
  }

  destroy() { if (this.timer) clearInterval(this.timer); this.timer = null; this.listeners.clear(); }

  // Печалба за период по ЦЯЛАТА сметка (не само сесията): нетни сделки от историята на MT5 от
  // началото на периода + текущата плаваща (equity − balance). Ако агентът е стар → резервен метод.
  accountPeriodPnl(ms) {
    if (!Array.isArray(this.pnlDeals) || !this.account) return null;
    const from = Math.floor(ms / 1000);
    let sum = 0;
    for (const [t, v] of this.pnlDeals) if (t >= from) sum += v;
    return sum + ((this.account.equity || 0) - (this.account.balance || 0));
  }

  periodPnl(ms, equityNow) {
    const a = this.accountPeriodPnl(ms);
    if (a != null) return a;
    const s = this.equitySeries;
    let base = this.startBalance || equityNow;
    for (let i = s.length - 1; i >= 0; i--) {
      if (s[i].t * 1000 < ms) { base = s[i].equity; break; }
    }
    return equityNow - base;
  }

  stats() {
    const start = this.startBalance || 0;
    const equity = this.sessionEquity();
    const floating = this.floatingTotal();
    const wins = this.trades.filter(t => t.pnl > 0).length;
    return {
      initial: start, balance: start + this.realized, equity, floating,
      accountEquity: this.account ? this.account.equity : null, accountBalance: this.account ? this.account.balance : null,
      totalPnl: equity - start, totalPct: start > 0 ? (equity - start) / start * 100 : 0,
      trades: this.trades.length, wins,
      winRate: this.trades.length ? wins / this.trades.length * 100 : 0,
      openCount: this.positions.size, maxDD: this.maxDD || 0,
      dayPnl: this.periodPnl(startOfDay(), equity),
      weekPnl: this.periodPnl(startOfWeek(), equity),
      monthPnl: this.periodPnl(startOfMonth(), equity)
    };
  }

  markers(sym) {
    const iv = IV_SEC[this.interval];
    const bar = t => t - (t % iv);
    const out = [];
    const open = (p, t) => out.push({ time: bar(t), position: p.dir === 'BUY' ? 'belowBar' : 'aboveBar', color: p.dir === 'BUY' ? '#00ff66' : '#ff0055', shape: p.dir === 'BUY' ? 'arrowUp' : 'arrowDown', text: p.dir + ' ' + p.lots + 'л' });
    for (const t of this.trades) {
      if (t.symbol !== sym) continue;
      open(t, t.openedAt);
      out.push({ time: bar(t.closedAt), position: t.dir === 'BUY' ? 'aboveBar' : 'belowBar', color: t.pnl >= 0 ? '#00ff66' : '#ff0055', shape: 'circle', text: t.reason + (t.pnl >= 0 ? ' +' : ' ') + t.pnl.toFixed(2) });
    }
    for (const p of this.positions.values()) if (p.symbol === sym) open(p, p.openTime);
    out.sort((a, b) => a.time - b.time);
    return out.slice(-300);
  }

  // Всяка проверка на вероятността като точка [време, buyPct] (за кривата под графиката).
  // Последните 2 часа — всички; по-старите — най-много една на 60с (за да е малък отговорът).
  histFor(st) {
    const now = nowSec(), out = [];
    let lastOld = -1e12;
    for (const pt of st.hist) {
      if (pt[0] >= now - 7200) out.push(pt);
      else if (pt[0] - lastOld >= 60) { out.push(pt); lastOld = pt[0]; }
    }
    return out.slice(-3500);
  }

  getState() {
    const symbols = {};
    for (const sym of this.symbols) {
      const st = this.state[sym];
      const i = st.info || {};
      symbols[sym] = {
        source: 'MT5', error: st.error, why: st.why || null, contract: i.contract || null,
        vmin: i.vmin, vstep: i.vstep, vmax: i.vmax, contract: i.contract,
        minMargin: (i.margin1 > 0 && i.vmin > 0) ? i.margin1 * i.vmin : null,
        minNotional: (i.contract > 0 && i.vmin > 0 && i.bid > 0 && i.tickSize > 0) ? i.vmin * i.contract * i.bid * ((i.tickValue / i.tickSize) / i.contract) : null,
        minSpreadCost: (i.contract > 0 && i.vmin > 0 && i.tickSize > 0) ? i.spread * i.vmin * i.contract * ((i.tickValue / i.tickSize) / i.contract) : null,
        bid: i.bid, ask: i.ask, spread: i.spread, swapLong: i.swapLong, swapShort: i.swapShort,
        marketOpen: !!(st.info && i.tradeAllowed && i.tickAge < STALE_TICK_SEC),
        lastBarTime: st.lastBarTime, prob: st.prob, probTime: st.probTime, probAt: st.probAt || 0, probHist: this.histFor(st),
        candles: st.candles.slice(-800).map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })),
        markers: this.markers(sym)
      };
    }
    const openPositions = [...this.positions.values()].map(p => {
      const i = (this.state[p.symbol] || {}).info || {};
      const fx = i.contract > 0 && i.tickSize > 0 ? (i.tickValue / i.tickSize) / i.contract : 1;
      const units = p.lots * (i.contract || 1);
      return {
        ticket: p.ticket, symbol: p.symbol, dir: p.dir, entry: p.entry, lots: p.lots, contract: i.contract,
        units, notional: units * p.entry * fx, margin: i.margin1 ? i.margin1 * p.lots : null, tp: p.tp, sl: p.sl,
        openTime: p.openTime, prob: p.prob, spread: i.spread ? i.spread * units * fx : 0, fx,
        swap: p.swap, floating: (p.profit || 0) + (p.swap || 0) + (p.commission || 0)
      };
    });
    const a = this.account;
    const account = {
      mode: 'mt5', broker: a ? a.company || a.server : null, server: a ? a.server : null, login: a ? a.login : null,
      demo: a ? a.demo : null, currency: a ? a.currency : null, leverage: a ? a.leverage : null,
      marginMode: a ? a.margin_mode : null,
      balance: a ? a.balance : null, equity: a ? a.equity : null, margin: a ? a.margin : null,
      available: a ? a.margin_free : null, marginLevel: a ? a.margin_level : null,
      unrealized: a ? a.profit : null, initial: this.startBalance,
      connected: this.connected, agentOnline: mt5.isOnline(this.agentId)
    };
    return {
      id: this.id, status: this.status, error: this.error, mode: 'mt5',
      createdAt: this.createdAt, startedAt: this.startedAt, updatedAt: this.updatedAt,
      agentId: this.agentId, magic: this.magic,
      config: { symbols: this.symbols, interval: this.interval, model: this.model, contra: this.contra, params: this.P, agentId: this.agentId },
      stats: this.stats(), account, openPositions,
      trades: this.trades.slice(-100),
      symbols, equitySeries: this.equitySeries
    };
  }

  serialize() {
    return {
      id: this.id, ownerId: this.ownerId, agentId: this.agentId, magic: this.magic,
      symbols: this.symbols, interval: this.interval, model: this.model, contra: this.contra, P: this.P,
      status: this.status, createdAt: this.createdAt, startedAt: this.startedAt, updatedAt: this.updatedAt,
      startBalance: this.startBalance, peak: this.peak, maxDD: this.maxDD,
      hist: Object.fromEntries(this.symbols.map(x => [x, this.state[x].hist.slice(-8000)])),
      equitySeries: this.equitySeries
    };
  }

  async persistStatus() {
    if (!db.isEnabled()) return;
    try {
      await db.query(`UPDATE sessions SET status=$2, updated_at=now(), config=$3 WHERE id=$1`,
        [this.id, this.status, JSON.stringify({ symbols: this.symbols, interval: this.interval, model: this.model, contra: this.contra, params: this.P, mode: 'mt5', agentId: this.agentId })]);
    } catch (e) { /* ignore */ }
  }
}

// ─── Мениджър на сесиите ───────────────────────────────────────────
const sessions = new Map();

function saveAll() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify({ savedAt: Date.now(), sessions: [...sessions.values()].map(s => s.serialize()) }));
  } catch (e) { /* ignore */ }
}

function restoreSession(obj) {
  const s = new Session(obj.id, {
    ownerId: obj.ownerId, agentId: obj.agentId, magic: obj.magic, symbols: obj.symbols, interval: obj.interval,
    model: obj.model, contra: obj.contra, params: obj.P
  });
  s.status = obj.status || 'running';
  s.createdAt = obj.createdAt || Date.now();
  s.startedAt = obj.startedAt || nowSec();
  s.updatedAt = obj.updatedAt || Date.now();
  s.startBalance = obj.startBalance != null ? obj.startBalance : null;
  s.peak = obj.peak || 0;
  s.maxDD = obj.maxDD || 0;
  s.equitySeries = Array.isArray(obj.equitySeries) ? obj.equitySeries : [];
  for (const x of s.symbols) if (obj.hist && Array.isArray(obj.hist[x])) s.state[x].hist = obj.hist[x];
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
  if (n) console.log(`[trade] възстановени ${n} MT5 сесии от диска.`);
  return n;
}

async function createSession(config) {
  if (!config.agentId || !mt5.owns(config.ownerId, config.agentId)) throw new Error('Избери MT5 агент (връзка) от профила си.');
  if (!mt5.isOnline(config.agentId)) throw new Error('MT5 агентът е офлайн — стартирай mt5-agent.py на Windows компютъра.');
  const id = crypto.randomBytes(6).toString('hex');
  const s = new Session(id, config);
  if (!s.symbols.length) throw new Error('Въведи поне един MT5 символ.');
  // Проверка, че символите съществуват в MT5 и сметката е готова за търговия.
  const snap = await s.fetchSnapshot();
  s.ingest(snap);
  if (!s.account) throw new Error('Няма данни за MT5 сметката.');
  if (!s.account.trade_allowed) throw new Error('В MT5 е изключена алгоритмичната търговия (бутон „Algo Trading“) или сметката е само за четене.');
  const bad = s.symbols.filter(x => s.state[x].error);
  if (bad.length) throw new Error('Проблем със символи: ' + bad.map(x => x + ' — ' + s.state[x].error).join('; '));
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
         JSON.stringify({ symbols: s.symbols, interval: s.interval, model: s.model, contra: s.contra, params: s.P, mode: 'mt5', agentId: s.agentId })]);
    } catch (e) { /* ignore */ }
  }
  return s;
}

function getSession(id) { return sessions.get(id); }
function owns(id, ownerId) {
  const s = sessions.get(id);
  return !!s && !!ownerId && s.ownerId === ownerId;
}
function listSessions(ownerId) {
  return [...sessions.values()]
    .filter(s => s.ownerId === ownerId)
    .map(s => ({
      id: s.id, status: s.status, mode: 'mt5', agentId: s.agentId, symbols: s.symbols, interval: s.interval,
      model: s.model, contra: s.contra, params: s.P,
      createdAt: s.createdAt, startedAt: s.startedAt, updatedAt: s.updatedAt,
      equity: s.sessionEquity(), balance: s.startBalance != null ? s.startBalance + s.realized : null,
      initial: s.startBalance, currency: s.account ? s.account.currency : null,
      trades: s.trades.length,
      lastBars: Object.fromEntries(s.symbols.map(x => [x, s.state[x].lastBarTime || 0])),
      errors: (s.error ? [s.error] : []).concat(s.symbols.filter(x => s.state[x].error).map(x => x + ': ' + s.state[x].error))
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

module.exports = { Session, createSession, getSession, listSessions, activeSessions, owns, removeSession, init, saveAll, IV_SEC, WINDOW, TICK_MS };
