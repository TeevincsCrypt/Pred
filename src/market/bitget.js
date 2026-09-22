// Bitget public market-data client (REST API v2, no key required).
// Docs: https://www.bitget.com/api-doc/spot/market/Get-Tickers
//       https://www.bitget.com/api-doc/spot/market/Get-Candle-Data

const BASE = process.env.BITGET_BASE_URL || 'https://api.bitget.com';

export class BitgetError extends Error {}

async function get(path, params = {}, { timeoutMs = 8000, fetchImpl = fetch } = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${BASE}${path}${qs ? `?${qs}` : ''}`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'PRED/0.1' } });
  if (!res.ok) throw new BitgetError(`Bitget ${path} HTTP ${res.status}`);
  const body = await res.json();
  if (body.code !== '00000') throw new BitgetError(`Bitget ${path} error ${body.code}: ${body.msg}`);
  return body.data;
}

export function createBitgetClient({ fetchImpl = fetch } = {}) {
  const opts = { fetchImpl };
  return {
    source: 'Bitget Spot API v2 (public)',

    async symbols() {
      const data = await get('/api/v2/spot/public/symbols', {}, opts);
      return data.map((s) => ({ symbol: s.symbol, base: s.baseCoin, quote: s.quoteCoin, status: s.status }));
    },

    async ticker(symbol) {
      const [t] = await get('/api/v2/spot/market/tickers', { symbol }, opts);
      if (!t) throw new BitgetError(`No ticker for ${symbol}`);
      return {
        symbol: t.symbol,
        last: +t.lastPr,
        bid: +t.bidPr,
        ask: +t.askPr,
        open24h: +t.open,
        change24hPct: +t.change24h * 100,
        quoteVolume24h: +t.quoteVolume,
        ts: +t.ts,
      };
    },

    // 1-minute candles, oldest first: { ts, open, high, low, close, volume, quoteVolume }
    async candles(symbol, { granularity = '1min', limit = 200 } = {}) {
      const rows = await get('/api/v2/spot/market/candles', { symbol, granularity, limit: String(limit) }, opts);
      return rows
        .map((r) => ({ ts: +r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5], quoteVolume: +r[6] }))
        .sort((a, b) => a.ts - b.ts);
    },
  };
}

// Map PRED tickers to listed Bitget spot symbols.
export function resolveSymbols(listed, assets, { overrides = {}, quote = 'USDT' } = {}) {
  const online = new Map(listed.filter((s) => s.status === 'online' && s.quote === quote).map((s) => [s.base.toUpperCase(), s.symbol]));
  const out = {};
  for (const [ticker, a] of Object.entries(assets)) {
    if (overrides[ticker]) {
      out[ticker] = overrides[ticker];
      continue;
    }
    const hit = (a.bitgetCandidates || []).find((c) => online.has(c.toUpperCase()));
    if (hit) out[ticker] = online.get(hit.toUpperCase());
  }
  return out;
}

export function parseSymbolMap(str = '') {
  return Object.fromEntries(
    str
      .split(',')
      .map((kv) => kv.trim().split('='))
      .filter((kv) => kv.length === 2 && kv[0] && kv[1]),
  );
}
