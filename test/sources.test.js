import test from 'node:test';
import assert from 'node:assert/strict';
import { createBitgetClient, resolveSymbols, parseSymbolMap } from '../src/market/bitget.js';
import { classifyArticle, parseGdeltDate, createNewsSource } from '../src/sources/news.js';
import { scanSources } from '../src/agents/investigator.js';
import { ASSETS } from '../src/market/universe.js';

const ok = (data) => async () => ({ ok: true, json: async () => ({ code: '00000', msg: 'success', data }) });

test('Bitget candles are parsed and sorted oldest-first', async () => {
  const c = createBitgetClient({ fetchImpl: ok([['1700000060000', '2', '3', '1', '2.5', '10', '25', '25'], ['1700000000000', '1', '2', '1', '2', '5', '10', '10']]) });
  const bars = await c.candles('NVDAXUSDT');
  assert.deepEqual(bars.map((b) => b.ts), [1700000000000, 1700000060000]);
  assert.equal(bars[1].close, 2.5);
});

test('Bitget error codes surface as errors', async () => {
  const c = createBitgetClient({ fetchImpl: async () => ({ ok: true, json: async () => ({ code: '40034', msg: 'param error' }) }) });
  await assert.rejects(c.ticker('X'), /40034/);
});

test('symbol resolution prefers listed tokenized-equity candidates and honours overrides', () => {
  const listed = [
    { symbol: 'NVDAXUSDT', base: 'NVDAX', quote: 'USDT', status: 'online' },
    { symbol: 'AMDONUSDT', base: 'AMDON', quote: 'USDT', status: 'online' },
    { symbol: 'TSLAXUSDT', base: 'TSLAX', quote: 'USDT', status: 'offline' },
  ];
  const m = resolveSymbols(listed, ASSETS, { overrides: parseSymbolMap('COINx=COINXUSDT') });
  assert.equal(m.NVDAx, 'NVDAXUSDT');
  assert.equal(m.AMDx, 'AMDONUSDT');
  assert.equal(m.TSLAx, undefined);
  assert.equal(m.COINx, 'COINXUSDT');
});

test('news classification', () => {
  assert.deepEqual(classifyArticle({ title: 'NVIDIA unveils new chip', domain: 'nvidianews.nvidia.com' }, ASSETS.NVDAx), { scope: 'company', official: true });
  assert.deepEqual(classifyArticle({ title: 'Chip stocks rally', domain: 'reuters.com' }, ASSETS.NVDAx), { scope: 'sector', official: false });
  assert.equal(parseGdeltDate('20260921T110200Z'), Date.parse('2026-09-21T11:02:00Z'));
});

test('failing sources are reported, not hidden; empty news scans are explicit', async () => {
  const down = { id: 'x', name: 'Down', category: 'filings', provenance: 'LIVE', collect: async () => { throw new Error('HTTP 403'); } };
  const news = createNewsSource({ fetchImpl: async () => ({ ok: true, text: async () => '{"articles":[]}' }) });
  const { items, checks } = await scanSources([down, news], { asset: ASSETS.NVDAx, now: Date.now() });
  assert.equal(checks.find((c) => c.source === 'x').status, 'unavailable');
  assert.ok(items.some((i) => i.kind === 'NEWS_SCAN_EMPTY'));
});
