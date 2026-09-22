// Optional action layer. PRED only *recommends* one of four postures; it
// never places orders. CONSIDER_TRADE is a verified signal a separate,
// risk-controlled execution agent may consume.

export const ACTIONS = {
  MONITOR: 'Keep watching; nothing actionable.',
  RESEARCH: 'Evidence is mixed; a human should look at the sources.',
  WAIT: 'Leading hypothesis is strong but unconfirmed; wait for confirmation.',
  CONSIDER_TRADE: 'Catalyst confirmed and reaction model is confident; eligible for an execution agent with explicit risk controls.',
};

export function recommendAction(event, now) {
  const rev = event.revisions.at(-1);
  const pred = event.predictions.at(-1);
  if (event.outcome) return { code: 'MONITOR', reason: 'Event closed; outcome recorded in PRED Memory.' };
  if (!rev) return { code: 'MONITOR', reason: 'Investigation in progress.' };
  const res = event.resolution?.outcome;
  if (res === 'INVALIDATED' || res === 'UNRESOLVED') return { code: 'MONITOR', reason: 'Leading hypothesis did not hold; no signal.' };
  if (res === 'CONFIRMED') {
    if (event.resolution.actualCategory === 'LIQUIDITY') return { code: 'MONITOR', reason: 'Liquidity anomaly — no information to trade on.' };
    if (pred?.status === 'OK' && pred.confidence >= 60 && Math.abs(pred.estimatePct) >= 1 && now < event.horizonAt) {
      return { code: 'CONSIDER_TRADE', reason: `${ACTIONS.CONSIDER_TRADE} Direction ${pred.direction.toLowerCase()}, model estimate ${pred.estimatePct > 0 ? '+' : ''}${pred.estimatePct}%.` };
    }
    return { code: 'MONITOR', reason: 'Catalyst confirmed, but reaction estimate is too weak or uncertain to act on.' };
  }
  if (rev.primary.probability < 55) return { code: 'RESEARCH', reason: ACTIONS.RESEARCH };
  return { code: 'WAIT', reason: ACTIONS.WAIT };
}
