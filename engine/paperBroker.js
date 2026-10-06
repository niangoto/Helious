// Виртуален (paper) брокер: бюджет, позиции, реализирана/плаваща печалба, маркери.

const { floatingPnl } = require('./strategy');

class PaperAccount {
  constructor(budget) {
    this.initial = budget;
    this.balance = budget;      // реализиран капитал
    this.peak = budget;
    this.maxDD = 0;             // макс. теглене в %
    this.trades = [];           // затворени сделки
    this.positions = new Map(); // symbol -> позиция (макс. 1 на символ)
    this.markers = [];          // маркери за графиката (всички символи)
  }

  floating(prices) {
    let f = 0;
    for (const [sym, pos] of this.positions) {
      const price = prices[sym];
      if (price != null) f += floatingPnl(pos, price);
    }
    return f;
  }

  equity(prices) { return this.balance + this.floating(prices); }

  // Обща „цена“ (нотионал в EUR) на всички отворени позиции.
  totalNotional() {
    let n = 0;
    for (const pos of this.positions.values()) n += Math.abs(pos.notional || 0);
    return n;
  }

  // Зает маржин (в EUR) на всички отворени позиции.
  totalMargin() {
    let m = 0;
    for (const pos of this.positions.values()) m += Math.abs(pos.margin || 0);
    return m;
  }

  // Маржин ниво = капитал / зает маржин × 100 (%) — както при реален брокер
  // (не / нотионал; при ливъридж 30 това е 30× разлика).
  marginLevel(prices) {
    const m = this.totalMargin();
    if (m <= 0) return Infinity;
    return this.equity(prices) / m * 100;
  }

  // Символът на позицията с най-голяма плаваща загуба (за принудително затваряне).
  worstPosition(prices) {
    let worst = null, wl = 0;
    for (const [sym, pos] of this.positions) {
      const price = prices[sym];
      if (price == null) continue;
      const f = floatingPnl(pos, price);
      if (f < wl) { wl = f; worst = sym; }
    }
    return worst;
  }

  hasPosition(symbol) { return this.positions.has(symbol); }

  open(pos) {
    this.positions.set(pos.symbol, pos);
    this.markers.push({
      symbol: pos.symbol,
      time: pos.openTime,
      position: pos.dir === 'BUY' ? 'belowBar' : 'aboveBar',
      color: pos.dir === 'BUY' ? '#00ff66' : '#ff0055',
      shape: pos.dir === 'BUY' ? 'arrowUp' : 'arrowDown',
      text: pos.dir + ' ' + (pos.lots != null ? pos.lots : '') + 'л'
    });
    this._trimMarkers();
    return pos;
  }

  close(symbol, exitPrice, reason, time) {
    const pos = this.positions.get(symbol);
    if (!pos) return null;
    const fx = (pos.fx > 0) ? pos.fx : 1;
    const pnl = (pos.dir === 'BUY'
      ? (exitPrice - pos.entry) * pos.units
      : (pos.entry - exitPrice) * pos.units) * fx;
    this.balance += pnl;
    if (this.balance > this.peak) this.peak = this.balance;
    const dd = this.peak > 0 ? (this.peak - this.balance) / this.peak * 100 : 0;
    if (dd > this.maxDD) this.maxDD = dd;
    const trade = {
      id: this.trades.length + 1,
      symbol,
      dir: pos.dir,
      lots: pos.lots,
      contract: pos.contract,
      units: pos.units,
      entry: pos.entry,
      exit: exitPrice,
      tp: pos.tp,
      sl: pos.sl,
      openedAt: pos.openTime,
      closedAt: time,
      pnl,
      reason,
      prob: pos.prob,
      spread: pos.spread || 0
    };
    this.trades.push(trade);
    this.positions.delete(symbol);
    this.markers.push({
      symbol,
      time,
      position: pos.dir === 'BUY' ? 'aboveBar' : 'belowBar',
      color: pnl >= 0 ? '#00ff66' : '#ff0055',
      shape: 'circle',
      text: reason + (pnl >= 0 ? ' +' : ' ') + pnl.toFixed(2) + '€'
    });
    this._trimMarkers();
    return trade;
  }

  // Пази паметта ограничена при дълга (24/7) работа.
  _trimMarkers() {
    const MAX = 5000;
    if (this.markers.length > MAX) this.markers.splice(0, this.markers.length - MAX);
  }

  // Затваря всички позиции по дадена цена (напр. при Стоп).
  closeAll(prices, time, reason) {
    const closed = [];
    for (const sym of Array.from(this.positions.keys())) {
      const price = prices[sym];
      if (price == null) continue;
      closed.push(this.close(sym, price, reason || 'Край', time));
    }
    return closed.filter(Boolean);
  }

  summary(prices) {
    const floating = this.floating(prices);
    const equity = this.balance + floating;
    const wins = this.trades.filter(t => t.pnl > 0).length;
    return {
      initial: this.initial,
      balance: this.balance,
      equity,
      floating,
      totalPnl: this.balance - this.initial,
      totalPct: this.initial > 0 ? (this.balance - this.initial) / this.initial * 100 : 0,
      trades: this.trades.length,
      wins,
      winRate: this.trades.length ? wins / this.trades.length * 100 : 0,
      openCount: this.positions.size,
      maxDD: this.maxDD
    };
  }
}

module.exports = { PaperAccount };
