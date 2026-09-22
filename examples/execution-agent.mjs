// Reference consumer for PRED's verified signals — a *separate* execution
// agent with explicit risk controls. DRY RUN ONLY: it prints the order it
// would send; wiring it to Bitget Agent Hub / trading APIs is left to the
// operator, behind their own keys, limits and approvals.
//
//   node examples/execution-agent.mjs [http://localhost:8787] [demo|live]

const base = process.argv[2] || 'http://localhost:8787';
const mode = process.argv[3] || 'demo';
const EQUITY_USD = 10_000;

const { signals } = await (await fetch(`${base}/api/signals?mode=${mode}`)).json();
if (!signals.length) console.log('No CONSIDER_TRADE signals. Nothing to do.');

for (const s of signals) {
  const r = s.riskPolicy;
  const checks = [
    [s.state === r.requireState, `state ${s.state} must be ${r.requireState}`],
    [s.reactionConfidence >= r.minReactionConfidence, `confidence ${s.reactionConfidence} >= ${r.minReactionConfidence}`],
    [Date.now() < s.validUntil || s.provenance === 'SIMULATED', 'signal not expired'],
    [s.direction !== 'NEUTRAL', 'directional signal'],
  ];
  const failed = checks.filter(([ok]) => !ok);
  const notional = Math.min(r.maxNotionalUsd, (EQUITY_USD * r.maxPositionPctOfEquity) / 100);
  console.log(`\n${s.eventCode} ${s.asset} ${s.direction} (${s.provenance})`);
  for (const [ok, label] of checks) console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (failed.length) {
    console.log('  → REJECTED by risk policy');
    continue;
  }
  const side = s.direction === 'POSITIVE' ? 'buy' : 'sell';
  const stop = s.referencePrice * (1 + ((side === 'buy' ? -1 : 1) * r.stopLossPct) / 100);
  const target = s.referencePrice * (1 + s.modelEstimatePct / 100);
  console.log(`  → DRY RUN ${side.toUpperCase()} ${s.venueSymbol} notional $${notional.toFixed(0)} · stop ${stop.toFixed(2)} · target ${target.toFixed(2)}${notional > r.humanApprovalAboveUsd ? ' · REQUIRES HUMAN APPROVAL' : ''}`);
}
