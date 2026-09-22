// Verified event signals for a *separate* execution agent (e.g. one built
// on Bitget Agent Hub). PRED publishes the signal and the risk policy the
// consumer must enforce; PRED itself never places orders.

import { recommendAction } from './action.js';

export const DEFAULT_RISK_POLICY = {
  requireState: 'CONFIRMED',
  minReactionConfidence: 60,
  maxNotionalUsd: 1000,
  maxPositionPctOfEquity: 2,
  stopLossPct: 1.5,
  takeProfitAtModelEstimate: true,
  expireAt: 'horizon',
  killSwitch: 'consumer must support manual halt',
  humanApprovalAboveUsd: 250,
};

export function buildSignals(engine) {
  const now = engine.clock.now();
  const signals = [];
  for (const e of engine.events.values()) {
    const action = recommendAction(e, now);
    if (action.code !== 'CONSIDER_TRADE') continue;
    const p = e.predictions.at(-1);
    signals.push({
      signalId: `${e.id}-p${p.seq}`,
      eventCode: e.code,
      mode: e.mode,
      provenance: e.provenance,
      asset: e.ticker,
      venueSymbol: e.asset.symbol,
      state: e.state,
      catalyst: e.resolution.actualCategory,
      direction: p.direction,
      referencePrice: p.refPrice,
      expectedRangePct: [p.rangeLowPct, p.rangeHighPct],
      modelEstimatePct: p.estimatePct,
      reactionConfidence: p.confidence,
      validUntil: e.horizonAt,
      riskPolicy: DEFAULT_RISK_POLICY,
      disclaimer: 'Event-intelligence signal, not financial advice. Execution requires an independent agent enforcing riskPolicy.',
    });
  }
  return { generatedAt: now, count: signals.length, signals };
}
