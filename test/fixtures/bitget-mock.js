// TEST FIXTURE ONLY — a fake Bitget v3 server used by unit tests. It mirrors
// the documented response envelope ({ code: "00000", data }) and field
// names. It is never imported by production code.

const MIN = 60_000;
const envelope = (data) => ({ code: '00000', msg: 'success', requestTime: Date.now(), data });
const res = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, headers: new Map(), text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

export const SPOT_INSTRUMENTS = [
  { symbol: 'NVDAXUSDT', category: 'SPOT', baseCoin: 'NVDAX', quoteCoin: 'USDT', status: 'online', isRwa: 'YES' },
  { symbol: 'NVDAONUSDT', category: 'SPOT', baseCoin: 'NVDAON', quoteCoin: 'USDT', status: 'online', isRwa: 'YES' },
  { symbol: 'AAPLXUSDT', category: 'SPOT', baseCoin: 'AAPLX', quoteCoin: 'USDT', status: 'online', isRwa: 'YES' },
  { symbol: 'XAUTUSDT', category: 'SPOT', baseCoin: 'XAUT', quoteCoin: 'USDT', status: 'online', isRwa: 'YES' },
  { symbol: 'BTCUSDT', category: 'SPOT', baseCoin: 'BTC', quoteCoin: 'USDT', status: 'online', isRwa: 'NO' },
  { symbol: 'ETHUSDT', category: 'SPOT', baseCoin: 'ETH', quoteCoin: 'USDT', status: 'online', isRwa: 'NO' },
  { symbol: 'IMXUSDT', category: 'SPOT', baseCoin: 'IMX', quoteCoin: 'USDT', status: 'online', isRwa: 'NO' },
];
export const FUTURES_INSTRUMENTS = [{ symbol: 'NVDAUSDT', category: 'USDT-FUTURES', baseCoin: 'NVDA', quoteCoin: 'USDT', status: 'online', symbolType: 'stock', isRwa: 'YES' }];
const PX = { NVDAXUSDT: 180, NVDAONUSDT: 180.2, AAPLXUSDT: 230, XAUTUSDT: 2650, BTCUSDT: 64000, ETHUSDT: 3100, IMXUSDT: 1.2, NVDAUSDT: 180.1 };

export function candlesFor(symbol, limit, { spikePct = 0 } = {}) {
  const end = Math.floor(Date.now() / MIN) * MIN; // current (forming) minute is included, like Bitget
  const out = [];
  let px = PX[symbol] ?? 100;
  for (let i = limit - 1; i >= 0; i--) {
    const ts = end - i * MIN;
    const spike = spikePct && i >= 1 && i <= 5;
    const next = spike ? px * (1 + spikePct / 500) : px * (1 + Math.sin(ts / 7e5) * 0.0002);
    out.push([String(ts), String(px), String(Math.max(px, next) * 1.0001), String(Math.min(px, next) * 0.9999), String(next), String(spike ? 900 : 100), String(next * (spike ? 900 : 100))]);
    px = next;
  }
  return out;
}

export function createBitgetMock({ spikeSymbol = null, spikePct = 0, gdelt = { articles: [] }, failBitget = false } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    calls.push(u.pathname + u.search);
    if (u.hostname === 'api.gdeltproject.org') return res(gdelt);
    if (failBitget) throw new TypeError('fetch failed');
    const q = Object.fromEntries(u.searchParams);
    switch (u.pathname) {
      case '/api/v3/public/time':
        return res(envelope({ serverTime: String(Date.now()) }));
      case '/api/v3/market/instruments':
        return res(envelope(q.category === 'USDT-FUTURES' ? FUTURES_INSTRUMENTS : SPOT_INSTRUMENTS));
      case '/api/v3/market/tickers': {
        const list = (q.category === 'USDT-FUTURES' ? FUTURES_INSTRUMENTS : SPOT_INSTRUMENTS).filter((i) => !q.symbol || i.symbol === q.symbol);
        return res(envelope(list.map((i) => ({ category: q.category, symbol: i.symbol, lastPrice: String(PX[i.symbol]), openPrice24h: String(PX[i.symbol] * 0.99), highPrice24h: String(PX[i.symbol] * 1.01), lowPrice24h: String(PX[i.symbol] * 0.98), ask1Price: String(PX[i.symbol] * 1.0002), bid1Price: String(PX[i.symbol] * 0.9998), bid1Size: '3', ask1Size: '4', price24hPcnt: '0.0101', volume24h: '5000', turnover24h: String(5000 * PX[i.symbol]) }))));
      }
      case '/api/v3/market/candles':
        return res(envelope(candlesFor(q.symbol, Number(q.limit || 100), q.symbol === spikeSymbol ? { spikePct } : {})));
      case '/api/v3/market/orderbook':
        return res(envelope({ a: [[String(PX[q.symbol] * 1.0002), '4']], b: [[String(PX[q.symbol] * 0.9998), '3']], ts: String(Date.now()) }));
      default:
        return res({ code: '40404', msg: 'not found' }, 404);
    }
  };
  return { fetchImpl, calls };
}
