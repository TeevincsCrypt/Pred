// VERIFIER — tests the standing hypotheses against evidence that arrives
// after the Ghost Event was opened, and decides when the event resolves.
//
//  • classifies each new item as SUPPORTS / CONTRADICTS / NEUTRAL relative
//    to the current primary hypothesis
//  • promotes authoritative items (official company releases, 8-K/6-K
//    filings) into OFFICIAL_ANNOUNCEMENT evidence
//  • measures price follow-through vs. reversal at fixed checkpoints
//  • resolves CONFIRMED / INVALIDATED; UNRESOLVED is set by the engine at
//    the evaluation horizon

import { signalsFor } from './hypothesis.js';

export const FOLLOW_CHECKPOINTS_MIN = [60, 180];

export function relation(item, primaryKey, ctx) {
  const w = signalsFor(item, ctx)
    .filter((s) => s.key === primaryKey)
    .reduce((a, s) => a + s.w, 0);
  if (w > 0.05) return { relation: 'SUPPORTS', weight: w };
  if (w < -0.05) return { relation: 'CONTRADICTS', weight: w };
  return { relation: 'NEUTRAL', weight: 0 };
}

// Authoritative items become OFFICIAL_ANNOUNCEMENT evidence. Direction is
// only set when the source states it (demo script / LLM analyst); PRED does
// not guess sentiment from a headline.
export function toAuthoritative(item, event) {
  if (item.kind === 'OFFICIAL_ANNOUNCEMENT') return null;
  const recent = (item.sourceTime ?? 0) >= event.detectedAt - 12 * 3600_000;
  const officialNews = item.kind === 'NEWS_ARTICLE' && item.data?.official && item.data?.scope === 'company';
  const materialFiling = item.kind === 'FILING' && ['8-K', '6-K'].includes(item.data?.form);
  if (!recent || !(officialNews || materialFiling)) return null;
  return {
    key: `auth:${item.key}`,
    kind: 'OFFICIAL_ANNOUNCEMENT',
    title: `Authoritative source: ${item.title}`,
    detail: officialNews ? 'Official company communication' : `Material SEC filing (${item.data.form})`,
    source: item.source,
    provenance: item.provenance,
    sourceTime: item.sourceTime,
    url: item.url,
    data: { category: 'COMPANY_SPECIFIC', direction: item.data?.direction ?? null, basedOn: item.key },
  };
}

// Retention of the original move at a checkpoint → FOLLOWTHROUGH / REVERSAL.
export function priceCheck(event, store, now) {
  const m = event.anomaly.measurements;
  const out = [];
  const done = new Set(event.evidence.filter((e) => e.kind === 'PRICE_FOLLOWTHROUGH' || e.kind === 'PRICE_REVERSAL').map((e) => e.data.minutes));
  for (const minutes of FOLLOW_CHECKPOINTS_MIN) {
    const at = m.windowEnd + minutes * 60_000;
    if (now < at || done.has(minutes)) continue;
    const px = store.priceAt(event.ticker, at);
    if (px == null) continue;
    const move = m.price - m.priceBefore;
    const retention = move === 0 ? 0 : (px - m.priceBefore) / move;
    const r = Math.round(retention * 100) / 100;
    if (retention >= 0.7) {
      out.push({ key: `px:follow:${minutes}`, kind: 'PRICE_FOLLOWTHROUGH', title: `Move held ${Math.round(r * 100)}% after ${minutes}m`, detail: `Price ${px.toFixed(2)} vs pre-move ${m.priceBefore.toFixed(2)}`, sourceTime: at, data: { retention: r, minutes, price: px } });
    } else if (retention <= 0.3) {
      out.push({ key: `px:revert:${minutes}`, kind: 'PRICE_REVERSAL', title: `Move retraced ${Math.round((1 - r) * 100)}% after ${minutes}m`, detail: `Price ${px.toFixed(2)} vs pre-move ${m.priceBefore.toFixed(2)}`, sourceTime: at, data: { retention: r, minutes, price: px } });
    } else {
      out.push({ key: `px:partial:${minutes}`, kind: 'PRICE_PARTIAL', title: `Move ${Math.round(r * 100)}% retained after ${minutes}m`, detail: 'Neither clear follow-through nor reversal', sourceTime: at, data: { retention: r, minutes, price: px } });
    }
  }
  return out;
}

// Decide whether the event is resolved. Returns a resolution or null.
export function resolve(event, now) {
  const revs = event.revisions;
  const auth = event.evidence.find((e) => e.kind === 'OFFICIAL_ANNOUNCEMENT');
  if (auth) {
    // Judge against the leading hypothesis *before* the authoritative item arrived.
    const before = [...revs].reverse().find((r) => r.at < auth.observedAt) || revs[0];
    const matched = before.primary.key === auth.data.category;
    return {
      outcome: matched ? 'CONFIRMED' : 'INVALIDATED',
      actualCategory: auth.data.category,
      basis: 'authoritative-source',
      judgedHypothesis: before.primary,
      originalHypothesis: revs[0].primary,
      confirmingEvidenceId: auth.id,
      resolvedAt: now,
      timeToResolutionMs: now - event.detectedAt,
    };
  }
  const current = revs[revs.length - 1];
  const reversal = event.evidence.find((e) => e.kind === 'PRICE_REVERSAL' && e.data.minutes >= 180);
  if (reversal && current.primary.key === 'LIQUIDITY' && current.primary.probability >= 70) {
    return {
      outcome: 'CONFIRMED',
      actualCategory: 'LIQUIDITY',
      basis: 'price-behaviour',
      judgedHypothesis: current.primary,
      originalHypothesis: revs[0].primary,
      confirmingEvidenceId: reversal.id,
      resolvedAt: now,
      timeToResolutionMs: now - event.detectedAt,
    };
  }
  return null;
}
