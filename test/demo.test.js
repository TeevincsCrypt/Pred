import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemo, STEPS } from '../src/demo/runner.js';

test('demo runs the full Ghost Event lifecycle deterministically', async () => {
  const demo = createDemo({ stageDelayMs: 0, tickDelayMs: 0 });
  const states = [];
  for (let i = 0; i < STEPS.length; i++) {
    await demo.next();
    states.push(demo.engine.snapshot().selected?.state ?? null);
  }
  assert.deepEqual(states.slice(0, 2), [null, null], 'no event before the anomaly');
  assert.equal(states[2], 'DETECTED');
  assert.equal(states[4], 'INVESTIGATING');
  assert.equal(states[6], 'HYPOTHESIS_CREATED');
  assert.equal(states[7], 'AWAITING_CONFIRMATION');
  assert.equal(states[10], 'CONFIRMED');

  const e = demo.engine.snapshot().selected;
  assert.equal(e.code, 'GHOST EVENT #184');
  assert.equal(e.anomaly.measurements.retPct, 2.34);
  assert.equal(e.anomaly.measurements.volumeChangePct, 640);
  assert.equal(e.market.usMarketOpen, false);
  assert.equal(e.resolution.outcome, 'CONFIRMED');
  assert.ok(e.revisions.length >= 3, 'revisions are appended, not overwritten');
  assert.ok(e.revisions[0].primary.probability < e.revisions.at(-1).primary.probability);
  assert.ok(e.evidence.every((x) => ['SIMULATED', 'HISTORICAL'].includes(x.provenance)), 'demo never claims LIVE data');
  assert.ok(e.predictions.some((p) => p.status === 'OK'));
  assert.ok(e.outcome && e.evaluation);
  assert.equal(e.evaluation.catalystCorrect, true);

  const mem = demo.engine.snapshot().memory;
  assert.equal(mem.total, 184);
  assert.equal(mem.provenance.SIMULATED, 184);
});
