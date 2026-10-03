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

  hasPosition(symbol) { return this.positions.has(symbol); }

  open(pos) {
    this.positions.set(pos.symbol, pos);
    this.markers.push({
      symbol: pos.symbol,
      time: pos.openTime,
      position: pos.dir === 'BUY' ? 'belowBar' : 'aboveBar',
      color: pos.dir === 'BUY' ? '#00ff66' : '#ff0055',
      shape: pos.dir === 'BUY' ? 'arrowUp' : 'arrowDown',
      text: pos.dir
    });
    return pos;
  }

  close(symbol, exitPrice, reason, time) {
    const pos = this.positions.get(symbol);
    if (!pos) return null;
    const pnl = pos.dir === 'BUY'
      ? (exitPrice - pos.entry) * pos.units
      : (pos.entry - exitPrice) * pos.units;
    this.balance += pnl;
    if (this.balance > this.peak) this.peak = this.balance;
    const dd = this.peak > 0 ? (this.peak - this.balance) / this.peak * 100 : 0;
    if (dd > this.maxDD) this.maxDD = dd;
    const trade = {
      id: this.trades.length + 1,
      symbol,
      dir: pos.dir,
      units: pos.units,
      entry: pos.entry,
      exit: exitPrice,
      tp: pos.tp,
      sl: pos.sl,
      openedAt: pos.openTime,
      closedAt: time,
      pnl,
      reason,
      prob: pos.prob
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
    return trade;
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
