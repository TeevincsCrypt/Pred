import test from 'node:test';
import assert from 'node:assert/strict';
import { toAuthoritative, resolve } from '../src/agents/verifier.js';
import { evaluateOutcome, createMemory } from '../src/agents/memory.js';

const event = (primaryKey) => ({
  detectedAt: 1000,
  revisions: [{ rev: 1, at: 1000, primary: { key: primaryKey, title: primaryKey, probability: 70 } }],
  evidence: [],
});

test('official company news and 8-Ks become authoritative; ordinary news does not', () => {
  const e = event('COMPANY_SPECIFIC');
  assert.equal(toAuthoritative({ key: 'n', kind: 'NEWS_ARTICLE', sourceTime: 2000, data: { scope: 'company', official: false } }, e), null);
  assert.equal(toAuthoritative({ key: 'f', kind: 'FILING', sourceTime: 2000, data: { form: '8-K' } }, e).data.category, 'COMPANY_SPECIFIC');
  assert.ok(toAuthoritative({ key: 'o', kind: 'NEWS_ARTICLE', sourceTime: 2000, data: { scope: 'company', official: true } }, e));
});

test('resolution judges the hypothesis that led before the evidence arrived', () => {
  const e = event('SECTOR_REPRICING');
  e.evidence.push({ id: 'x', kind: 'OFFICIAL_ANNOUNCEMENT', observedAt: 5000, data: { category: 'COMPANY_SPECIFIC' } });
  e.revisions.push({ rev: 2, at: 5000, primary: { key: 'COMPANY_SPECIFIC', title: 'c', probability: 95 } });
  const r = resolve(e, 5000);
  assert.equal(r.outcome, 'INVALIDATED');
  assert.equal(r.judgedHypothesis.key, 'SECTOR_REPRICING');
});

test('evaluation attributes failures', () => {
  const base = { predictions: [{ status: 'OK', estimatePct: 2, rangeLowPct: 1, rangeHighPct: 3 }], outcome: { reactionPct: -1.5, peerReactionPct: -1.4 } };
  const a = evaluateOutcome({ ...base, resolution: { outcome: 'CONFIRMED', judgedHypothesis: { key: 'COMPANY_SPECIFIC' } }, actualCategory: 'COMPANY_SPECIFIC' });
  assert.equal(a.directionCorrect, false);
  assert.deepEqual(a.failures, ['UNRELATED_MARKET_MOVE']);
  const b = evaluateOutcome({ ...base, resolution: { outcome: 'INVALIDATED', judgedHypothesis: { key: 'COMPANY_SPECIFIC' } }, actualCategory: 'LIQUIDITY' });
  assert.ok(b.failures.includes('LIQUIDITY_ANOMALY'));
  assert.equal(b.falsePositive, true);
  const c = evaluateOutcome({ predictions: [], outcome: { reactionPct: 1 }, resolution: { outcome: 'UNRESOLVED' } });
  assert.deepEqual(c.failures, ['INSUFFICIENT_EVIDENCE']);
});

test('memory stats count outcomes and calibration', () => {
  const m = createMemory();
  m.upsert({ id: 1, detectedAt: 1, measurements: { retPct: 1, volumeRatio: 3 }, initialPrimary: { key: 'COMPANY_SPECIFIC', probability: 80 }, resolution: { outcome: 'CONFIRMED' }, actualCategory: 'COMPANY_SPECIFIC', evaluation: { catalystCorrect: true, directionCorrect: true, withinRange: true, failures: [], timeToConfirmationMs: 60000 } });
  m.upsert({ id: 2, detectedAt: 2, measurements: { retPct: 1, volumeRatio: 3 }, initialPrimary: { key: 'COMPANY_SPECIFIC', probability: 60 }, resolution: { outcome: 'INVALIDATED' }, actualCategory: 'LIQUIDITY', evaluation: { catalystCorrect: false, directionCorrect: false, withinRange: false, failures: ['LIQUIDITY_ANOMALY'] } });
  const s = m.stats();
  assert.equal(s.total, 2);
  assert.equal(s.confirmedCatalysts, 1);
  assert.equal(s.liquidityAnomalies, 1);
  assert.equal(s.accuracy.catalyst.rate, 0.5);
  assert.equal(s.accuracy.falsePositiveRate, 0.5);
  assert.equal(m.nextSeq(), 1);
});
