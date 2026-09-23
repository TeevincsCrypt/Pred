// Bitget public market-data client — Unified (v3) market API, no API key.
//
//   GET /api/v3/public/time
//   GET /api/v3/market/instruments?category=SPOT|USDT-FUTURES[&symbol=]
//   GET /api/v3/market/tickers?category=SPOT|USDT-FUTURES[&symbol=]
//   GET /api/v3/market/candles?category=&symbol=&interval=1m&limit=
//   GET /api/v3/market/orderbook?category=&symbol=&limit=
//
// Tokenized U.S. equities are discovered, never assumed:
//   • SPOT instruments with isRwa === "YES" (e.g. xStocks …X, Ondo …ON)
//   • USDT-FUTURES instruments with symbolType === "stock" (stock perpetuals)
// Every numeric field is parsed defensively; anything missing becomes null.

import { createHttp, HttpError, num } from '../util/http.js';

export const BITGET_BASE_URL = (process.env.BITGET_BASE_URL || 'https://api.bitget.com').replace(/\/+$/, '');
const SYMBOL_RE = /^[A-Z0-9_]{2,40}$/;

export class BitgetError extends Error {}

export function createBitgetClient({ fetchImpl = fetch, baseUrl = BITGET_BASE_URL, minIntervalMs = 120, timeoutMs = Number(process.env.BITGET_TIMEOUT_MS) || 8000 } = {}) {
  // ~8 req/s, well under Bitget's public market-data limits.
  const http = createHttp({ name: 'bitget', minIntervalMs, timeoutMs, retries: 2, fetchImpl });

  async function get(path, params = {}) {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString();
    const body = await http.getJson(`${baseUrl}${path}${qs ? `?${qs}` : ''}`, { headers: { 'User-Agent': 'PRED/1.0 (+market-intelligence)', Accept: 'application/json' } });
    if (!body || typeof body !== 'object') throw new BitgetError(`Bitget ${path}: malformed response`);
    if (body.code !== '00000') throw new BitgetError(`Bitget ${path}: error ${body.code} ${body.msg ?? ''}`.trim());
    return body.data;
  }

  return {
    source: 'Bitget public market API v3',
    baseUrl,
    health: http.health,

    async serverTime() {
      const d = await get('/api/v3/public/time');
      return num(d?.serverTime);
    },

    async instruments(category = 'SPOT') {
      const d = await get('/api/v3/market/instruments', { category });
      if (!Array.isArray(d)) throw new BitgetError('Bitget instruments: expected an array');
      return d.map((r) => normalizeInstrument({ ...r, category: r?.category ?? category })).filter(Boolean);
    },

    async tickers(category = 'SPOT', symbol) {
      if (symbol) assertSymbol(symbol);
      const d = await get('/api/v3/market/tickers', { category, symbol });
      if (!Array.isArray(d)) throw new BitgetError('Bitget tickers: expected an array');
      return d.map((r) => normalizeTicker({ ...r, category: r?.category ?? category })).filter(Boolean);
    },

    // 1-minute candles, oldest first.
    async candles(category, symbol, { interval = '1m', limit = 200 } = {}) {
      assertSymbol(symbol);
      const d = await get('/api/v3/market/candles', { category, symbol, interval, limit: String(limit) });
      if (!Array.isArray(d)) throw new BitgetError('Bitget candles: expected an array');
      return d.map(normalizeCandle).filter(Boolean).sort((a, b) => a.ts - b.ts);
    },

    async orderbook(category, symbol, limit = 5) {
      assertSymbol(symbol);
      const d = await get('/api/v3/market/orderbook', { category, symbol, limit: String(limit) });
      const side = (xs) => (Array.isArray(xs) ? xs.map((l) => ({ price: num(l?.[0]), size: num(l?.[1]) })).filter((l) => l.price != null && l.size != null) : []);
      return { bids: side(d?.b), asks: side(d?.a), ts: num(d?.ts) };
    },
  };
}

function assertSymbol(s) {
  if (!SYMBOL_RE.test(String(s))) throw new BitgetError(`Invalid symbol: ${s}`);
}

export function normalizeInstrument(r) {
  if (!r || typeof r.symbol !== 'string' || !SYMBOL_RE.test(r.symbol)) return null;
  return {
    symbol: r.symbol,
    category: r.category ?? null,
    baseCoin: r.baseCoin ?? null,
    quoteCoin: r.quoteCoin ?? null,
    status: r.status ?? null,
    isRwa: r.isRwa === 'YES',
    isReality: r.isReality ?? null,
    symbolType: r.symbolType ?? null,
    type: r.type ?? null,
    pricePrecision: num(r.pricePrecision),
    minOrderAmount: num(r.minOrderAmount),
    launchTime: num(r.launchTime),
    offTime: num(r.offTime),
    maintainTime: num(r.maintainTime),
  };
}

export function normalizeTicker(r) {
  if (!r || typeof r.symbol !== 'string') return null;
  const bid = num(r.bid1Price);
  const ask = num(r.ask1Price);
  return {
    symbol: r.symbol,
    category: r.category ?? null,
    last: num(r.lastPrice),
    open24h: num(r.openPrice24h),
    high24h: num(r.highPrice24h),
    low24h: num(r.lowPrice24h),
    change24hPct: num(r.price24hPcnt) == null ? null : num(r.price24hPcnt) * 100,
    volume24h: num(r.volume24h), // base units
    turnover24h: num(r.turnover24h), // quote units (USDT)
    bid: bid && bid > 0 ? bid : null,
    ask: ask && ask > 0 ? ask : null,
    bidSize: num(r.bid1Size),
    askSize: num(r.ask1Size),
    markPrice: num(r.markPrice),
    indexPrice: num(r.indexPrice),
    ts: num(r.ts),
  };
}

// v3 candle: [ts, open, high, low, close, volume(base), turnover(quote)]
export function normalizeCandle(r) {
  if (!Array.isArray(r) || r.length < 6) return null;
  const c = { ts: num(r[0]), open: num(r[1]), high: num(r[2]), low: num(r[3]), close: num(r[4]), volume: num(r[5]), quoteVolume: num(r[6]) };
  if (c.ts == null || c.open == null || c.high == null || c.low == null || c.close == null || c.volume == null) return null;
  if (c.close <= 0 || c.high < c.low) return null;
  return c;
}

export { HttpError };
