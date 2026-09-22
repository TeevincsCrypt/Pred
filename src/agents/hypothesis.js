// HYPOTHESIS AGENT — turns evidence into competing catalyst explanations.
//
// The model is deliberately transparent: every evidence item contributes a
// signed log-odds weight to one or more catalyst categories (see
// `signalsFor`). Scores are softmaxed into model confidence estimates,
// rounded to whole percents, capped so no hypothesis ever reads as certain,
// and each hypothesis lists exactly which evidence moved it and by how much.

import { softmax, toWholePercents, clamp } from '../util/stats.js';

export const CATEGORIES = {
  COMPANY_SPECIFIC: { title: 'Company-specific catalyst', short: 'Company catalyst', prior: 0 },
  SECTOR_REPRICING: { title: 'Sector-wide repricing', short: 'Sector repricing', prior: 0 },
  MACRO_CRYPTO: { title: 'Macro / crypto risk flow', short: 'Macro / crypto flow', prior: -0.5 },
  LIQUIDITY: { title: 'Liquidity anomaly', short: 'Liquidity anomaly', prior: -0.2 },
  SCHEDULED: { title: 'Scheduled event pre-positioning', short: 'Scheduled event', prior: -1.5 },
  UNKNOWN: { title: 'Unknown / unexplained', short: 'Unknown', prior: 0.3 },
};
export const CATEGORY_KEYS = Object.keys(CATEGORIES);

// Softmax temperature > 1 keeps estimates humble: evidence weights are
// hand-set, so the model should not sound sharper than it is.
const TEMPERATURE = 1.5;
const MAX_PROB = 0.95;
const MAX_PROB_UNCONFIRMED = 0.9;
const MIN_UNKNOWN = 0.03;
const MIN_ANY = 0.012;

const sameSign = (a, b) => Math.sign(a) === Math.sign(b) && a !== 0;

// Signed log-odds contributions of one evidence item, with a short reason.
export function signalsFor(ev, ctx) {
  const d = ev.data || {};
  const move = ctx.retPct;
  const out = [];
  const add = (key, w, why) => out.push({ key, w, why });

  switch (ev.kind) {
    case 'PRICE_ANOMALY':
      if (Math.abs(d.priceZ) >= 6) add('LIQUIDITY', -0.2, 'move is too large and orderly to be noise alone');
      break;
    case 'VOLUME_ANOMALY':
      if (d.volumeRatio >= 4) {
        add('COMPANY_SPECIFIC', 0.5, `volume ${d.volumeRatio.toFixed(1)}× baseline suggests informed participation`);
        add('LIQUIDITY', -0.4, 'heavy two-sided volume argues against a thin-book print');
      } else if (d.volumeRatio < 2) {
        add('LIQUIDITY', 0.8, 'price moved without matching volume');
      }
      break;
    case 'SPREAD_CHANGE':
      if (d.ratio >= 2) add('LIQUIDITY', 1.0, `spread widened ${d.ratio.toFixed(1)}× — book thinned`);
      else if (d.ratio <= 1.3) add('LIQUIDITY', -0.3, 'spread stable — book intact');
      break;
    case 'SECTOR_SUMMARY': {
      if (d.avgPeerRetPct == null) break;
      const share = Math.abs(d.residualPct) / Math.max(Math.abs(move), 1e-6);
      if (share >= 0.6) {
        add('COMPANY_SPECIFIC', 1.0, `${Math.round(share * 100)}% of the move is not explained by peers`);
        add('SECTOR_REPRICING', -0.8, 'peers did not move with it');
      } else if (share <= 0.35 && sameSign(d.avgPeerRetPct, move)) {
        add('SECTOR_REPRICING', 1.2, 'peers moved in the same direction with similar size');
        add('COMPANY_SPECIFIC', -0.6, 'move is largely shared with peers');
      }
      break;
    }
    case 'PEER_MOVE':
      if (sameSign(d.retPct, move) && Math.abs(d.retPct) >= 0.5 * Math.abs(move)) add('SECTOR_REPRICING', 0.25, `${d.ticker} moved alongside`);
      break;
    case 'CRYPTO_MOVE':
      if (Math.abs(d.retPct) >= 1.5 && sameSign(d.retPct, move)) add('MACRO_CRYPTO', 1.0, `${d.ticker} moved ${d.retPct.toFixed(2)}% in the same window`);
      else add('MACRO_CRYPTO', -0.4, `${d.ticker} flat (${d.retPct.toFixed(2)}%) — no broad risk flow`);
      break;
    case 'NEWS_ARTICLE':
      if (d.scope === 'company') add('COMPANY_SPECIFIC', d.official ? 2.0 : 0.8, d.official ? 'official company communication' : 'company-specific coverage');
      else if (d.scope === 'sector') add('SECTOR_REPRICING', 0.6, 'sector-level coverage');
      else if (d.scope === 'macro') add('MACRO_CRYPTO', 0.6, 'macro coverage');
      break;
    case 'NEWS_SCAN_EMPTY':
      add('UNKNOWN', 0.3, 'no public coverage found yet');
      add('COMPANY_SPECIFIC', -0.1, 'no public company news yet');
      break;
    case 'FILING':
      add('COMPANY_SPECIFIC', d.form === '8-K' || d.form === '6-K' ? 1.2 : 0.4, `recent ${d.form} filing`);
      break;
    case 'SOCIAL_SIGNAL':
      if (d.velocity >= 3) {
        add('COMPANY_SPECIFIC', 0.6, `discussion velocity ${d.velocity.toFixed(1)}× baseline`);
        add('UNKNOWN', -0.2, 'emerging discussion gives a lead to follow');
      }
      break;
    case 'SCHEDULED_EVENT':
      if (d.hoursAway != null && d.hoursAway <= 48) add('SCHEDULED', 1.8, `${d.title} within ${Math.round(d.hoursAway)}h`);
      break;
    case 'HISTORICAL_PATTERN':
      for (const [key, share] of Object.entries(d.shares || {})) {
        const base = 1 / CATEGORY_KEYS.length;
        if (d.n >= 5 && share > 0) add(key, clamp(0.5 * Math.log(share / base), -0.6, 0.6), `${Math.round(share * 100)}% of ${d.n} similar past events`);
      }
      break;
    case 'PRICE_FOLLOWTHROUGH':
      add('COMPANY_SPECIFIC', 0.4, `move held ${Math.round(d.retention * 100)}% after ${d.minutes}m`);
      add('LIQUIDITY', -0.8, 'no mean reversion');
      break;
    case 'PRICE_REVERSAL':
      add('LIQUIDITY', 1.5, `move retraced ${Math.round((1 - d.retention) * 100)}% within ${d.minutes}m`);
      add('COMPANY_SPECIFIC', -0.6, 'information-driven moves rarely fully revert');
      break;
    case 'OFFICIAL_ANNOUNCEMENT':
      add(d.category, 3.5, 'authoritative source');
      for (const k of CATEGORY_KEYS) if (k !== d.category && k !== 'UNKNOWN') add(k, -1.0, 'explained by the announced catalyst');
      add('UNKNOWN', -2.0, 'catalyst identified');
      break;
    default:
      break;
  }
  return out;
}

function affectedAssets(key, ctx) {
  switch (key) {
    case 'SECTOR_REPRICING':
      return [ctx.ticker, ...(ctx.peers || [])];
    case 'MACRO_CRYPTO':
      return [ctx.ticker, ...(ctx.peers || []), 'BTC'];
    default:
      return [ctx.ticker];
  }
}

function implication(key, ctx) {
  const dir = ctx.retPct >= 0 ? 'upside' : 'downside';
  const up = ctx.retPct >= 0;
  switch (key) {
    case 'COMPANY_SPECIFIC':
      return `If confirmed, ${ctx.ticker} likely carries the ${dir} into the next regular session; peers may follow partially.`;
    case 'SECTOR_REPRICING':
      return `Expect ${up ? 'broad strength' : 'broad weakness'} across ${ctx.sector} at the open, not only ${ctx.ticker}.`;
    case 'MACRO_CRYPTO':
      return `Move tied to cross-asset risk flow; it should track crypto and fade if that reverses.`;
    case 'LIQUIDITY':
      return `Likely to mean-revert toward ${ctx.priceBefore?.toFixed?.(2) ?? 'the pre-move level'} as liquidity returns.`;
    case 'SCHEDULED':
      return `Pre-positioning ahead of a scheduled event; direction depends on the event itself.`;
    default:
      return `No reliable implication until more evidence arrives.`;
  }
}

function qualityLabel(evidence, sourceChecks, margin, hasAuthority) {
  if (hasAuthority) return 'HIGH';
  const ok = sourceChecks.filter((s) => s.status === 'ok').length;
  const coverage = sourceChecks.length ? ok / sourceChecks.length : 0;
  const s = coverage * 0.5 + clamp(margin / 0.4, 0, 1) * 0.5;
  if (s >= 0.7) return 'MODERATE';
  return 'LOW';
}

// Score evidence → ranked hypotheses. `ctx`: { ticker, retPct, peers, sector, priceBefore }
export function generateHypotheses(evidence, ctx, sourceChecks = []) {
  const scores = Object.fromEntries(CATEGORY_KEYS.map((k) => [k, CATEGORIES[k].prior]));
  const contrib = Object.fromEntries(CATEGORY_KEYS.map((k) => [k, []]));
  for (const ev of evidence) {
    for (const s of signalsFor(ev, ctx)) {
      if (!(s.key in scores)) continue;
      scores[s.key] += s.w;
      contrib[s.key].push({ evidenceId: ev.id, kind: ev.kind, provenance: ev.provenance, weight: Math.round(s.w * 100) / 100, reason: s.why });
    }
  }

  const hasAuthority = evidence.some((e) => e.kind === 'OFFICIAL_ANNOUNCEMENT');
  let probs = softmax(CATEGORY_KEYS.map((k) => scores[k] / TEMPERATURE));
  // Never present certainty: cap the leader, keep floors on every category
  // (and a larger one on "unknown"), then renormalize.
  const cap = hasAuthority ? MAX_PROB : MAX_PROB_UNCONFIRMED;
  const ui = CATEGORY_KEYS.indexOf('UNKNOWN');
  for (let iter = 0; iter < 3; iter++) {
    probs = probs.map((p, i) => Math.max(Math.min(p, cap), i === ui ? MIN_UNKNOWN : MIN_ANY));
    const total = probs.reduce((a, b) => a + b, 0);
    probs = probs.map((p) => p / total);
  }
  const pct = toWholePercents(probs).map((x) => Math.max(x, 1));
  const over = pct.reduce((a, b) => a + b, 0) - 100;
  if (over > 0) pct[pct.indexOf(Math.max(...pct))] -= over;

  const ranked = CATEGORY_KEYS.map((key, i) => ({ key, p: probs[i], pct: pct[i] })).sort((a, b) => b.p - a.p);
  const margin = ranked[0].p - ranked[1].p;
  const quality = qualityLabel(evidence, sourceChecks, margin, hasAuthority);

  return ranked.map((r, rank) => ({
    key: r.key,
    rank: rank === 0 ? 'PRIMARY' : rank === 1 ? 'SECONDARY' : 'ALTERNATIVE',
    title: CATEGORIES[r.key].title,
    probability: r.pct,
    rawProbability: Math.round(r.p * 1000) / 1000,
    score: Math.round(scores[r.key] * 100) / 100,
    evidenceFor: contrib[r.key].filter((c) => c.weight > 0).sort((a, b) => b.weight - a.weight),
    evidenceAgainst: contrib[r.key].filter((c) => c.weight < 0).sort((a, b) => a.weight - b.weight),
    confidence: rank === 0 ? quality : r.p >= 0.15 ? 'LOW' : 'VERY LOW',
    affectedAssets: affectedAssets(r.key, ctx),
    implication: implication(r.key, ctx),
    label: 'Model confidence estimate — not a measured probability',
  }));
}
