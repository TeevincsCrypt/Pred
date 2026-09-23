import test from 'node:test';
import assert from 'node:assert/strict';
import { createBitgetClient, normalizeCandle, normalizeTicker } from '../src/market/bitget.js';
import { buildUniverse, parseUnderlying, parsePerpUnderlying } from '../src/market/live-universe.js';
import { DEFAULT_RELATIONSHIPS } from '../src/market/relationships.js';
import { createHttp, safeUrl } from '../src/util/http.js';
import { createBitgetMock } from './fixtures/bitget-mock.js';

test('v3 client parses the documented envelope and candle arrays', async () => {
  const { fetchImpl } = createBitgetMock();
  const c = createBitgetClient({ fetchImpl, minIntervalMs: 0 });
  const inst = await c.instruments('SPOT');
  assert.ok(inst.find((i) => i.symbol === 'NVDAXUSDT').isRwa);
  assert.equal(inst.find((i) => i.symbol === 'BTCUSDT').isRwa, false);
  const bars = await c.candles('SPOT', 'NVDAXUSDT', { limit: 10 });
  assert.equal(bars.length, 10);
  assert.ok(bars[0].ts < bars[9].ts);
  const [t] = await c.tickers('SPOT', 'NVDAXUSDT');
  assert.equal(t.last, 180);
  assert.ok(Math.abs(t.change24hPct - 1.01) < 1e-9);
  assert.equal(c.health.status, 'connected');
  assert.ok((await c.serverTime()) > 0, 'server time comes from /api/v2/public/time');
});

test('missing or malformed fields become null, never invented', () => {
  assert.equal(normalizeCandle(['1', 'x', '2', '1', '1', '1']), null);
  assert.equal(normalizeCandle(['1', '1', '0.5', '1', '1', '1']), null); // high < low
  const t = normalizeTicker({ symbol: 'NVDAXUSDT', lastPrice: '180', bid1Price: '0' });
  assert.equal(t.bid, null);
  assert.equal(t.volume24h, null);
  assert.equal(t.turnover24h, null);
});

test('Bitget error codes and invalid symbols are rejected', async () => {
  const c = createBitgetClient({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{"code":"40034","msg":"param error"}' }), minIntervalMs: 0 });
  await assert.rejects(c.tickers('SPOT'), /40034/);
  await assert.rejects(c.candles('SPOT', 'bad symbol!'), /Invalid symbol/);
});

test('universe is discovered from isRwa / stock instruments only', () => {
  const spot = [
    { symbol: 'NVDAXUSDT', category: 'SPOT', baseCoin: 'NVDAX', quoteCoin: 'USDT', status: 'online', isRwa: true },
    { symbol: 'NVDAONUSDT', category: 'SPOT', baseCoin: 'NVDAON', quoteCoin: 'USDT', status: 'online', isRwa: true },
    { symbol: 'AMDXUSDT', category: 'SPOT', baseCoin: 'AMDX', quoteCoin: 'USDT', status: 'online', isRwa: true },
    { symbol: 'XAUTUSDT', category: 'SPOT', baseCoin: 'XAUT', quoteCoin: 'USDT', status: 'online', isRwa: true },
    { symbol: 'IMXUSDT', category: 'SPOT', baseCoin: 'IMX', quoteCoin: 'USDT', status: 'online', isRwa: false },
  ];
  const u = buildUniverse({ spot, futures: [{ symbol: 'NVDAUSDT', category: 'USDT-FUTURES', baseCoin: 'NVDA', quoteCoin: 'USDT', status: 'online', symbolType: 'stock' }], relationships: DEFAULT_RELATIONSHIPS });
  assert.deepEqual(u.assets.map((a) => a.symbol).sort(), ['AMDXUSDT', 'NVDAONUSDT', 'NVDAUSDT', 'NVDAXUSDT', 'XAUTUSDT']);
  assert.ok(!u.monitored.includes('XAUT'), 'commodities are listed but not monitored as equities');
  assert.ok(u.monitored.includes('NVDA-PERP'), 'US-listed stock perps are monitored by default');
  const spotOnly = buildUniverse({ spot, futures: [{ symbol: 'NVDAUSDT', category: 'USDT-FUTURES', baseCoin: 'NVDA', quoteCoin: 'USDT', status: 'online', symbolType: 'stock' }], relationships: DEFAULT_RELATIONSHIPS, opts: { categories: ['SPOT'] } });
  assert.ok(!spotOnly.monitored.includes('NVDA-PERP'), 'stock perps are not monitored when that category is disabled');
  const nvdax = u.assets.find((a) => a.key === 'NVDAx');
  assert.deepEqual(nvdax.siblings, ['NVDAon']);
  assert.ok(nvdax.peers.includes('AMDx'));
  const filtered = buildUniverse({ spot, relationships: DEFAULT_RELATIONSHIPS, opts: { assetsFilter: ['NVDA', 'AMZN'] } });
  assert.deepEqual(filtered.monitored.sort(), ['NVDAon', 'NVDAx']);
  assert.deepEqual(filtered.unmatched, ['AMZN'], 'requested assets Bitget does not list are reported, not faked');
  assert.equal(parsePerpUnderlying('NFLX', 'stock').underlying, 'NFLX', 'perp base coins are not split into issuer suffixes');
  assert.equal(parsePerpUnderlying('AXON', 'stock').underlying, 'AXON');
  assert.equal(parsePerpUnderlying('RTXSTOCK', 'stock').underlying, 'RTX');
  assert.equal(parsePerpUnderlying('TENCENTHKD', 'stock').market, 'HK');
  assert.equal(parsePerpUnderlying('XAU', 'metal').assetClass, 'commodity');
  assert.deepEqual(parseUnderlying('TSLAON'), { underlying: 'TSLA', issuer: 'Ondo', assetClass: 'equity', suffix: 'on' });
});

test('commodity perps are never matched to SEC companies; SEC-matched "crypto" perps are equities', () => {
  const futures = [
    { symbol: 'CLUSDT', category: 'USDT-FUTURES', baseCoin: 'CL', quoteCoin: 'USDT', status: 'online', symbolType: 'commodity', isRwa: true },
    { symbol: 'HPQUSDT', category: 'USDT-FUTURES', baseCoin: 'HPQ', quoteCoin: 'USDT', status: 'online', symbolType: 'crypto', isRwa: true },
    { symbolType: 'crypto', symbol: 'EURUSDUSDT', category: 'USDT-FUTURES', baseCoin: 'EURUSD', quoteCoin: 'USDT', status: 'online', isRwa: true },
  ];
  const secDirectory = new Map([['CL', { cik: 21665, title: 'COLGATE PALMOLIVE CO' }], ['HPQ', { cik: 47217, title: 'HP INC' }]]);
  const u = buildUniverse({ futures, secDirectory, relationships: {} });
  const by = Object.fromEntries(u.assets.map((a) => [a.key, a]));
  assert.equal(by['CL-PERP'].company, 'CL');
  assert.equal(by['CL-PERP'].usListed, false);
  assert.equal(by['HPQ-PERP'].assetClass, 'equity');
  assert.ok(u.monitored.includes('HPQ-PERP'));
  assert.equal(by['EURUSD-PERP'].assetClass, 'crypto');
  assert.ok(!u.monitored.includes('EURUSD-PERP'));
});

test('http retries 429 with backoff and records health', async () => {
  let n = 0;
  const http = createHttp({
    name: 't',
    retries: 2,
    baseBackoffMs: 5,
    fetchImpl: async () => (++n < 3 ? { ok: false, status: 429, headers: new Map(), text: async () => '' } : { ok: true, status: 200, headers: new Map(), text: async () => '{"ok":1}' }),
  });
  assert.deepEqual(await http.getJson('https://x.test/'), { ok: 1 });
  assert.equal(n, 3);
  assert.equal(http.health.rateLimited, 2);
  const bad = createHttp({ name: 'b', retries: 1, baseBackoffMs: 1, fetchImpl: async () => ({ ok: true, status: 200, headers: new Map(), text: async () => 'Please limit requests to one every 5 seconds' }) });
  await assert.rejects(bad.getJson('https://x.test/'), /rate limited/);
  assert.equal(bad.health.status, 'disconnected');
});

test('only http(s) URLs are ever shown', () => {
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('https://www.sec.gov/x'), 'https://www.sec.gov/x');
});
