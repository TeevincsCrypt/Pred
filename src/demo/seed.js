// SIMULATED BACKTEST SEED for demo-mode PRED Memory.
//
// Generates synthetic Ghost Events with a hidden "true" cause, synthesizes
// noisy evidence consistent with that cause, and runs them through PRED's
// real Hypothesis Agent, Reaction Agent (walk-forward: each prediction only
// sees earlier events) and Memory evaluation. The resulting accuracy and
// calibration numbers are therefore genuine measurements of PRED's models —
// on synthetic data. Every record is labeled provenance: SIMULATED.

import { createRng } from '../util/rng.js';
import { generateHypotheses } from '../agents/hypothesis.js';
import { predictReaction, PREDICTION_THRESHOLD } from '../agents/reaction.js';
import { evaluateOutcome, createMemory } from '../agents/memory.js';
import { marketStatus, nextRegularClose, nextRegularOpen } from '../market/hours.js';
import { ASSETS } from '../market/universe.js';
import { round } from '../util/stats.js';

const TRUTHS = [
  ['COMPANY_SPECIFIC', 0.34],
  ['SECTOR_REPRICING', 0.18],
  ['MACRO_CRYPTO', 0.1],
  ['LIQUIDITY', 0.2],
  ['SCHEDULED', 0.06],
  ['NONE', 0.12],
];
const TICKERS = ['NVDAx', 'AMDx', 'AVGOx', 'TSMx', 'TSLAx', 'COINx', 'MSTRx', 'AAPLx', 'MSFTx'];

function drawTruth(rng) {
  let u = rng.next();
  for (const [k, p] of TRUTHS) {
    if ((u -= p) <= 0) return k;
  }
  return 'NONE';
}

function syntheticEvidence(rng, truth, dir, ret, asset) {
  const ev = [];
  let n = 0;
  const push = (kind, data, title) => ev.push({ id: `S-${++n}`, kind, data, title, provenance: 'SIMULATED' });
  const noisy = (p) => rng.chance(p);

  const volRatio = truth === 'LIQUIDITY' ? rng.range(1.2, 3.5) : truth === 'COMPANY_SPECIFIC' ? rng.range(3, 11) : rng.range(2.2, 7);
  push('PRICE_ANOMALY', { retPct: ret, priceZ: dir * rng.range(3.5, 9) });
  push('VOLUME_ANOMALY', { volumeRatio: volRatio });
  push('SPREAD_CHANGE', { ratio: truth === 'LIQUIDITY' && noisy(0.7) ? rng.range(1.8, 4) : rng.range(0.8, 1.6) });

  const peerFrac = truth === 'SECTOR_REPRICING' || truth === 'MACRO_CRYPTO' ? rng.range(0.55, 1.1) : rng.range(-0.1, 0.35);
  const avgPeer = ret * (noisy(0.85) ? peerFrac : rng.range(0, 0.8));
  push('SECTOR_SUMMARY', { avgPeerRetPct: avgPeer, residualPct: ret - avgPeer });
  for (const p of asset.peers.slice(0, 3)) push('PEER_MOVE', { ticker: p, retPct: avgPeer * rng.range(0.6, 1.4) });

  const btc = truth === 'MACRO_CRYPTO' && noisy(0.8) ? dir * rng.range(1.5, 4) : rng.normal() * 0.6;
  push('CRYPTO_MOVE', { ticker: 'BTC', retPct: btc });

  const earlyNews = truth === 'COMPANY_SPECIFIC' ? noisy(0.15) : false;
  if (earlyNews) push('NEWS_ARTICLE', { scope: 'company', official: false });
  else push('NEWS_SCAN_EMPTY', {});
  if (truth === 'SECTOR_REPRICING' && noisy(0.3)) push('NEWS_ARTICLE', { scope: 'sector', official: false });

  const socialV = truth === 'COMPANY_SPECIFIC' ? (noisy(0.55) ? rng.range(3, 8) : rng.range(1, 2.5)) : noisy(0.15) ? rng.range(3, 5) : rng.range(0.8, 2.2);
  push('SOCIAL_SIGNAL', { velocity: socialV });
  if (truth === 'SCHEDULED' && noisy(0.8)) push('SCHEDULED_EVENT', { title: 'Scheduled event', hoursAway: rng.range(4, 40) });
  return { evidence: ev, volRatio, avgPeer };
}

function reactionFor(rng, truth, dir, ret) {
  const a = Math.abs(ret);
  switch (truth) {
    case 'COMPANY_SPECIFIC':
      return dir * (1.1 * a + rng.normal() * 1.3);
    case 'SECTOR_REPRICING':
      return dir * (0.4 * a + rng.normal() * 1.0);
    case 'MACRO_CRYPTO':
      return dir * (0.1 * a + rng.normal() * 1.3);
    case 'LIQUIDITY':
      return -dir * (0.75 * a + rng.normal() * 0.35);
    case 'SCHEDULED':
      return rng.normal() * 2.6;
    default:
      return dir * (0.2 * a + rng.normal() * 1.2);
  }
}

// Returns an array of memory records.
export function generateSeed({ count = 183, seed = 2026, endAt = Date.parse('2026-09-19T12:00:00Z'), spanDays = 150 } = {}) {
  const rng = createRng(seed);
  const memory = createMemory();
  const start = endAt - spanDays * 86400_000;
  const times = [];
  while (times.length < count) {
    let t = Math.round(start + rng.next() * (endAt - start));
    if (marketStatus(t).usMarketOpen) t += 8 * 3600_000;
    if (t < endAt) times.push(Math.floor(t / 60000) * 60000);
  }
  times.sort((a, b) => a - b);

  times.forEach((detectedAt, i) => {
    const seq = i + 1;
    const truth = drawTruth(rng);
    const ticker = rng.pick(TICKERS);
    const asset = ASSETS[ticker];
    const dir = rng.chance(0.58) ? 1 : -1;
    const ret = round(dir * Math.exp(rng.normal() * 0.45 + Math.log(1.6)), 2);
    const { evidence, volRatio, avgPeer } = syntheticEvidence(rng, truth, dir, ret, asset);
    const ctx = { ticker, retPct: ret, peers: asset.peers, sector: asset.sector, priceBefore: 100 };
    const hyps = generateHypotheses(evidence, ctx, [{ status: 'ok' }, { status: 'ok' }, { status: 'ok' }, { status: rng.chance(0.8) ? 'ok' : 'unavailable' }]);
    const primary = { key: hyps[0].key, title: hyps[0].title, probability: hyps[0].probability, confidence: hyps[0].confidence };

    const knowable = truth !== 'NONE';
    const pResolve = { COMPANY_SPECIFIC: 0.75, SECTOR_REPRICING: 0.45, MACRO_CRYPTO: 0.4, LIQUIDITY: 0.7, SCHEDULED: 0.9 }[truth] ?? 0;
    const resolved = knowable && rng.chance(pResolve);
    const horizonAt = nextRegularClose(detectedAt);
    const nextOpenAt = nextRegularOpen(detectedAt);
    const resolveDelay = rng.range(0.2, 1.1) * (nextOpenAt - detectedAt);
    const resolution = resolved
      ? {
          outcome: truth === primary.key ? 'CONFIRMED' : 'INVALIDATED',
          actualCategory: truth,
          basis: truth === 'LIQUIDITY' ? 'price-behaviour' : 'authoritative-source',
          judgedHypothesis: primary,
          originalHypothesis: primary,
          resolvedAt: detectedAt + resolveDelay,
          timeToResolutionMs: Math.round(resolveDelay),
        }
      : { outcome: 'UNRESOLVED', actualCategory: null, basis: 'horizon-reached', judgedHypothesis: primary, originalHypothesis: primary, resolvedAt: horizonAt, timeToResolutionMs: horizonAt - detectedAt };

    const measurements = { retPct: ret, volumeRatio: round(volRatio, 2), volumeChangePct: Math.round((volRatio - 1) * 100), priceZ: evidence[0].data.priceZ, priceBefore: 100, price: 100 * (1 + ret / 100) };
    const record = {
      id: `seed-${seq}`,
      seq,
      code: `GHOST EVENT #${seq}`,
      mode: 'demo',
      provenance: 'SIMULATED',
      ticker,
      detectedAt,
      nextOpenAt,
      horizonAt,
      measurements,
      status: resolution.outcome,
      initialHypotheses: hyps.map((h) => ({ key: h.key, probability: h.probability })),
      initialPrimary: primary,
      finalPrimary: primary,
      revisions: 1,
      evidenceSummary: evidence.map((e) => ({ id: e.id, kind: e.kind, provenance: 'SIMULATED' })),
      resolution,
      actualCategory: resolution.actualCategory,
      predictions: [],
      outcome: null,
      evaluation: null,
    };

    // Walk-forward reaction prediction using only earlier seed events.
    const confirmed = resolution.outcome === 'CONFIRMED';
    const eligible = (confirmed || primary.probability >= PREDICTION_THRESHOLD) && resolution.actualCategory !== 'LIQUIDITY' && primary.key !== 'UNKNOWN' && resolution.outcome !== 'INVALIDATED';
    if (eligible) {
      const fakeEvent = { recordId: record.id, revisions: [{ primary }], resolution: confirmed ? resolution : null, anomaly: { measurements }, horizonAt };
      const p = predictReaction({ event: fakeEvent, memory, now: confirmed ? resolution.resolvedAt : detectedAt, refPrice: measurements.price, basis: confirmed ? 'confirmed' : 'high-confidence' });
      p.seq = 1;
      record.predictions.push(p);
    }
    const reactionPct = round(reactionFor(rng, truth, dir, ret), 2);
    const peerReactionPct = round(truth === 'SECTOR_REPRICING' ? reactionPct * rng.range(0.5, 1.1) : avgPeer * 0.3 + rng.normal() * 0.7, 2);
    record.outcome = { horizonAt, reactionPct, peerReactionPct, measuredAt: horizonAt };
    record.evaluation = evaluateOutcome(record);
    memory.upsert(record);
  });
  return memory.records;
}
