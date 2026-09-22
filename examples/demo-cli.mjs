// Run the full demo lifecycle headless and print the event timeline.
//   npm run demo:cli
import { createDemo, STEPS } from '../src/demo/runner.js';

const demo = createDemo({ stageDelayMs: 0, tickDelayMs: 0 });
for (const s of STEPS) {
  await demo.next();
  console.log(`\n▶ ${s.title}\n  ${s.narration}`);
}
const e = demo.engine.snapshot().selected;
console.log(`\n${e.code} — ${e.ticker} (${e.provenance})\n`);
for (const t of e.timeline) console.log(`${new Date(t.at).toISOString().slice(5, 16)}  ${t.agent.padEnd(17)} ${t.text}`);
const m = demo.engine.snapshot().memory;
console.log(`\nPRED Memory: ${m.total} events · direction ${Math.round(m.accuracy.direction.rate * 100)}% · catalyst ${Math.round(m.accuracy.catalyst.rate * 100)}% · range ${Math.round(m.accuracy.reactionRange.rate * 100)}% · Brier ${m.calibration.brier}`);
