import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyArticle, parseGdeltDate, createNewsSource } from '../src/sources/news.js';
import { scanSources } from '../src/agents/investigator.js';
import { ASSETS } from '../src/market/universe.js';

const ok = (data) => async () => ({ ok: true, json: async () => ({ code: '00000', msg: 'success', data }) });

test('news classification', () => {
  const a = classifyArticle({ title: 'NVIDIA unveils new chip', domain: 'nvidianews.nvidia.com' }, ASSETS.NVDAx);
  assert.equal(a.scope, 'company');
  assert.equal(a.official, true);
  assert.ok(a.matchedTerms.includes('NVIDIA'));
  const b = classifyArticle({ title: 'Chip stocks rally', domain: 'reuters.com' }, ASSETS.NVDAx);
  assert.equal(b.scope, 'mention');
  assert.equal(b.official, false);
  assert.equal(parseGdeltDate('20260921T110200Z'), Date.parse('2026-09-21T11:02:00Z'));
});

test('failing sources are reported, not hidden; empty news scans are explicit', async () => {
  const down = { id: 'x', name: 'Down', category: 'filings', provenance: 'LIVE', collect: async () => { throw new Error('HTTP 403'); } };
  const news = createNewsSource({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{"articles":[]}' }) });
  const { items, checks } = await scanSources([down, news], { asset: ASSETS.NVDAx, now: Date.now() });
  assert.equal(checks.find((c) => c.source === 'x').status, 'unavailable');
  assert.ok(items.some((i) => i.kind === 'NEWS_SCAN_EMPTY'));
});

test('GDELT: 15-min cache, circuit breaker on 429, no retry storms', async () => {
  let t = Date.parse('2026-09-23T12:00:00Z');
  let calls = 0;
  let mode = 'ok';
  const fetchImpl = async () => {
    calls++;
    if (mode === '429') return { ok: false, status: 429, headers: new Map(), text: async () => 'Please limit requests to one every 5 seconds' };
    return { ok: true, status: 200, headers: new Map(), text: async () => '{"articles":[]}' };
  };
  const news = createNewsSource({ fetchImpl, now: () => t });
  const asset = { ticker: 'NVDA-PERP', company: 'NVIDIA', newsTerms: ['NVIDIA'] };
  assert.equal((await news.collect({ asset, now: t })).status, 'ok');
  await news.collect({ asset, now: t });
  assert.equal(calls, 1, 'second identical query served from the 15-min cache');

  mode = '429';
  t += 16 * 60_000; // cache expired
  await assert.rejects(news.collect({ asset, now: t }));
  assert.equal(calls, 2, 'a 429 is not retried');
  const paused = await news.collect({ asset: { ...asset, newsTerms: ['Tesla'] }, now: t });
  assert.equal(paused.status, 'unavailable');
  assert.match(paused.note, /paused after rate limiting/);
  assert.equal(calls, 2, 'no request while paused');
  assert.match(news.health.lastError, /paused until/);

  mode = 'ok';
  t += 61_000; // first backoff is 1 minute
  assert.equal((await news.collect({ asset: { ...asset, newsTerms: ['Tesla'] }, now: t })).status, 'ok');
  assert.equal(calls, 3, 'resumes after the backoff');
});
