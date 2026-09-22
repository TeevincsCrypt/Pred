// Rolling in-memory store of 1-minute candles and quote snapshots per ticker.

const MAX_BARS = 2 * 24 * 60;

export class SeriesStore {
  constructor() {
    this.bars = new Map();
    this.quotes = new Map();
  }

  addCandle(ticker, c) {
    const arr = this.bars.get(ticker) || [];
    const last = arr[arr.length - 1];
    if (last && c.ts < last.ts) return false;
    if (last && c.ts === last.ts) arr[arr.length - 1] = c;
    else arr.push(c);
    if (arr.length > MAX_BARS) arr.splice(0, arr.length - MAX_BARS);
    this.bars.set(ticker, arr);
    return true;
  }

  addQuote(ticker, q) {
    const arr = this.quotes.get(ticker) || [];
    arr.push(q);
    if (arr.length > 500) arr.splice(0, arr.length - 500);
    this.quotes.set(ticker, arr);
  }

  candles(ticker) {
    return this.bars.get(ticker) || [];
  }

  lastPrice(ticker) {
    const arr = this.candles(ticker);
    return arr.length ? arr[arr.length - 1].close : null;
  }

  // Close of the last bar at or before ts.
  priceAt(ticker, ts) {
    const arr = this.candles(ticker);
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i].ts <= ts) return arr[i].close;
    return null;
  }

  // Percent change between the bar closes at-or-before `from` and `to`.
  changePct(ticker, from, to) {
    const a = this.priceAt(ticker, from);
    const b = this.priceAt(ticker, to);
    return a && b ? (b / a - 1) * 100 : null;
  }

  quotesSince(ticker, ts) {
    return (this.quotes.get(ticker) || []).filter((q) => q.ts >= ts);
  }
}
