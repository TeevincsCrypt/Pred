import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoSessions } from '../src/demo/sessions.js';

test('demo sessions are isolated per visitor and capped', async () => {
  const demos = createDemoSessions({ max: 2, demoOpts: { stageDelayMs: 0, tickDelayMs: 0 } });
  const a = demos.get('visitorAAA');
  const b = demos.get('visitorBBB');
  await a.demo.next();
  await a.demo.next();
  assert.equal(a.demo.status().step, 1);
  assert.equal(b.demo.status().step, -1, "one visitor's steps never move another's demo");
  assert.equal(demos.get('visitorAAA'), a, 'same sid returns the same session');
  demos.get('visitorCCC');
  assert.ok(demos.size <= 2, 'idle sessions are evicted past the cap');
  assert.equal(demos.get('bad id!').id, 'shared', 'invalid ids fall back to a shared session');
});
