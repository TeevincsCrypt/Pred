import test from 'node:test';
import assert from 'node:assert/strict';
import { generateHypotheses, CATEGORY_KEYS } from '../src/agents/hypothesis.js';

const ctx = { ticker: 'NVDAx', retPct: 2.34, peers: ['AMDx'], sector: 'Semis', priceBefore: 100 };
const ev = (id, kind, data) => ({ id, kind, data, provenance: 'SIMULATED' });

test('probabilities are whole percents summing to 100 and never certain', () => {
  const h = generateHypotheses(
    [ev('a', 'VOLUME_ANOMALY', { volumeRatio: 9 }), ev('b', 'SECTOR_SUMMARY', { avgPeerRetPct: 0.1, residualPct: 2.24 }), ev('c', 'SOCIAL_SIGNAL', { velocity: 8 }), ev('d', 'FILING', { form: '8-K' })],
    ctx,
  );
  assert.equal(h.length, CATEGORY_KEYS.length);
  assert.equal(h.reduce((a, x) => a + x.probability, 0), 100);
  assert.equal(h[0].key, 'COMPANY_SPECIFIC');
  assert.ok(h[0].probability <= 90, 'unconfirmed hypotheses are capped');
  assert.ok(h.every((x) => x.probability >= 1));
  assert.ok(h.find((x) => x.key === 'UNKNOWN').probability >= 3);
});

test('each hypothesis lists evidence for and against with weights', () => {
  const h = generateHypotheses([ev('a', 'SECTOR_SUMMARY', { avgPeerRetPct: 2.1, residualPct: 0.24 }), ev('b', 'PEER_MOVE', { ticker: 'AMDx', retPct: 2 })], ctx);
  const sector = h.find((x) => x.key === 'SECTOR_REPRICING');
  assert.equal(h[0].key, 'SECTOR_REPRICING');
  assert.ok(sector.evidenceFor.some((e) => e.evidenceId === 'a' && e.weight > 0));
  assert.ok(h.find((x) => x.key === 'COMPANY_SPECIFIC').evidenceAgainst.some((e) => e.evidenceId === 'a'));
  assert.ok(sector.affectedAssets.includes('AMDx'));
  assert.match(sector.label, /model confidence estimate/i);
});

test('spread blow-out and reversal point to liquidity', () => {
  const h = generateHypotheses([ev('a', 'SPREAD_CHANGE', { ratio: 4 }), ev('b', 'VOLUME_ANOMALY', { volumeRatio: 1.4 }), ev('c', 'PRICE_REVERSAL', { retention: 0.1, minutes: 60 })], ctx);
  assert.equal(h[0].key, 'LIQUIDITY');
});
