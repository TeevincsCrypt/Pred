// REACTION AGENT — estimates the likely market reaction once a catalyst is
// confirmed or the leading hypothesis is strong enough, using comparable
// events from PRED Memory. Output is a range with a model estimate and a
// confidence, never a point forecast presented as certain.
//
// Reaction = % move from the price when the prediction is made to the first
// U.S. regular-session close after detection (the "gap-close horizon").

import { weightedQuantile, clamp, round } from '../util/stats.js';
import { CATEGORIES } from './hypothesis.js';

export const PREDICTION_THRESHOLD = 70;

function similarity(a, b) {
  const r = Math.abs(Math.log(Math.max(Math.abs(a.retPct), 0.05) / Math.max(Math.abs(b.retPct), 0.05)));
  const v = Math.abs(Math.log(Math.max(a.volumeRatio, 0.1) / Math.max(b.volumeRatio, 0.1)));
  return Math.exp(-r) * Math.exp(-v / 2);
}

// Reference class depends on what PRED knows:
//  • confirmed catalyst → past events whose *actual* cause was that category
//  • unconfirmed        → past events where PRED *initially led* with that
//                         category, right or wrong (prices in the risk of
//                         the hypothesis being wrong)
export function comparables(memory, { category, measurements, excludeId, confirmed = false }) {
  const dir = Math.sign(measurements.retPct);
  const pool = memory.records.filter((r) => r.id !== excludeId && r.outcome?.reactionPct != null && Math.sign(r.measurements.retPct) === dir);
  let set = pool.filter((r) => (confirmed ? r.actualCategory : r.initialPrimary?.key) === category);
  let broadened = false;
  if (set.length < 5) {
    set = pool;
    broadened = true;
  }
  return {
    broadened,
    items: set.map((r) => ({ r, w: similarity(measurements, r.measurements) })).sort((a, b) => b.w - a.w).slice(0, 30),
  };
}

export function predictReaction({ event, memory, now, refPrice, basis }) {
  const current = event.revisions[event.revisions.length - 1];
  const confirmed = event.resolution?.outcome === 'CONFIRMED';
  const category = event.resolution?.actualCategory || current.primary.key;
  const m = event.anomaly.measurements;
  const { items, broadened } = comparables(memory, { category, measurements: m, excludeId: event.recordId, confirmed });
  if (items.length < 3) {
    return { at: now, basis, category, status: 'INSUFFICIENT_HISTORY', note: `Only ${items.length} comparable events with known outcomes`, refPrice };
  }
  const pts = items.map(({ r, w }) => ({ value: r.outcome.reactionPct, weight: w }));
  const est = weightedQuantile(pts, 0.5);
  const lo = weightedQuantile(pts, 0.2);
  const hi = weightedQuantile(pts, 0.8);
  const totalW = pts.reduce((a, p) => a + p.weight, 0);
  const posShare = pts.filter((p) => p.value > 0).reduce((a, p) => a + p.weight, 0) / totalW;
  const spread = Math.max(hi - lo, 0.1);
  const catProb = confirmed ? 0.9 : current.primary.probability / 100;
  const conf = clamp(0.25 + 0.2 * Math.min(items.length, 25) / 25 + 0.3 * catProb + 0.15 * Math.abs(posShare - 0.5) * 2 - 0.1 * clamp(spread / Math.max(Math.abs(est), 0.5) - 1, 0, 1) - (broadened ? 0.1 : 0), 0.15, 0.85);

  return {
    at: now,
    basis,
    category,
    categoryTitle: CATEGORIES[category].title,
    status: 'OK',
    refPrice,
    direction: est > 0.15 ? 'POSITIVE' : est < -0.15 ? 'NEGATIVE' : 'NEUTRAL',
    probUp: round(posShare, 2),
    rangeLowPct: round(lo, 2),
    rangeHighPct: round(hi, 2),
    estimatePct: round(est, 2),
    confidence: Math.round(conf * 100),
    horizonAt: event.horizonAt,
    horizonLabel: 'first U.S. regular-session close after detection',
    comparableCount: items.length,
    referenceClass: confirmed ? `past events confirmed as ${CATEGORIES[category].short.toLowerCase()}` : `past events where PRED initially led with ${CATEGORIES[category].short.toLowerCase()}`,
    broadened,
    comparables: items.slice(0, 6).map(({ r, w }) => ({
      id: r.id,
      code: r.code,
      ticker: r.ticker,
      detectedAt: r.detectedAt,
      category: r.actualCategory || r.finalPrimary?.key,
      retPct: r.measurements.retPct,
      reactionPct: r.outcome.reactionPct,
      similarity: round(w, 2),
      provenance: r.provenance,
    })),
    label: 'Model estimate from comparable events — not a price target',
  };
}
