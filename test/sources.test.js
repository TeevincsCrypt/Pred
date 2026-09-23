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
