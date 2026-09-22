// Builds the Catalyst Graph: asset → anomalies → correlations → information
// signals → catalyst hypotheses. Edges into hypotheses carry the signed
// weight the Hypothesis Agent actually used, so the picture is the model.

import { signalsFor } from '../agents/hypothesis.js';

const LAYER = {
  PRICE_ANOMALY: 1,
  VOLUME_ANOMALY: 1,
  VOLATILITY_CHANGE: 1,
  SPREAD_CHANGE: 1,
  PEER_MOVE: 2,
  SECTOR_SUMMARY: 2,
  CRYPTO_MOVE: 2,
  NEWS_ARTICLE: 3,
  NEWS_SCAN_EMPTY: 3,
  FILING: 3,
  SOCIAL_SIGNAL: 3,
  SCHEDULED_EVENT: 3,
  HISTORICAL_PATTERN: 3,
  PRICE_FOLLOWTHROUGH: 3,
  PRICE_REVERSAL: 3,
  PRICE_PARTIAL: 3,
  OFFICIAL_ANNOUNCEMENT: 3,
};

const SHORT = {
  PRICE_ANOMALY: 'Price anomaly',
  VOLUME_ANOMALY: 'Volume anomaly',
  VOLATILITY_CHANGE: 'Volatility',
  SPREAD_CHANGE: 'Spread / liquidity',
  SECTOR_SUMMARY: 'Sector movement',
  NEWS_SCAN_EMPTY: 'News: nothing yet',
  SOCIAL_SIGNAL: 'Emerging discussion',
  SCHEDULED_EVENT: 'Scheduled event',
  HISTORICAL_PATTERN: 'Historical pattern',
  PRICE_FOLLOWTHROUGH: 'Move holding',
  PRICE_REVERSAL: 'Move reverting',
  PRICE_PARTIAL: 'Partial retention',
  OFFICIAL_ANNOUNCEMENT: 'Authoritative source',
};

function groupKey(ev) {
  if (ev.kind === 'NEWS_ARTICLE') return `news:${ev.data?.scope}:${ev.data?.official ? 'o' : 'n'}`;
  if (ev.kind === 'FILING') return 'filings';
  if (['SOCIAL_SIGNAL', 'PRICE_FOLLOWTHROUGH', 'PRICE_REVERSAL', 'PRICE_PARTIAL'].includes(ev.kind)) return ev.kind;
  return ev.id;
}

function label(ev, n) {
  if (ev.kind === 'NEWS_ARTICLE') return `${ev.data?.official ? 'Official release' : 'News'} (${n})`;
  if (ev.kind === 'FILING') return `SEC filings (${n})`;
  if (n > 1) return `${SHORT[ev.kind]} (${n})`;
  if (ev.kind === 'PEER_MOVE' || ev.kind === 'CRYPTO_MOVE') return `${ev.data.ticker} ${ev.data.retPct >= 0 ? '+' : ''}${ev.data.retPct.toFixed(2)}%`;
  return SHORT[ev.kind] || ev.kind;
}

export function buildGraph(event) {
  // Before the first revision the graph shows evidence only (no hypotheses yet).
  const rev = event.revisions.at(-1) || { rev: 0, hypotheses: [] };
  const m = event.anomaly.measurements;
  const ctx = { ticker: event.ticker, retPct: m.retPct, peers: event.asset.peers, sector: event.asset.sector, priceBefore: m.priceBefore };
  const nodes = [{ id: 'asset', label: event.ticker, sub: `${m.retPct >= 0 ? '+' : ''}${m.retPct.toFixed(2)}%`, layer: 0, kind: 'ASSET' }];
  const edges = [];
  const groups = new Map();
  for (const ev of event.evidence.filter((e) => !e.superseded && LAYER[e.kind] != null)) {
    const k = groupKey(ev);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(ev);
  }
  const price = event.evidence.find((e) => e.kind === 'PRICE_ANOMALY');
  const volume = event.evidence.find((e) => e.kind === 'VOLUME_ANOMALY');
  const hypIds = new Set(rev.hypotheses.filter((h, i) => i < 4 || h.key === event.resolution?.actualCategory).map((h) => h.key));

  for (const [k, evs] of groups) {
    const ev = evs[0];
    const id = `n:${k}`;
    nodes.push({ id, label: label(ev, evs.length), sub: ev.kind === 'PRICE_ANOMALY' || ev.kind === 'VOLUME_ANOMALY' ? ev.title : undefined, layer: LAYER[ev.kind], kind: ev.kind, provenance: ev.provenance, evidenceIds: evs.map((e) => e.id), at: ev.observedAt });
    // Structural edges (how PRED got here).
    if (LAYER[ev.kind] === 1) edges.push({ from: 'asset', to: id, type: 'structural' });
    if (LAYER[ev.kind] === 2 && price) edges.push({ from: `n:${price.id}`, to: id, type: 'structural' });
    if (LAYER[ev.kind] === 3 && volume) edges.push({ from: `n:${volume.id}`, to: id, type: 'structural' });
    // Inference edges (how the evidence moved each hypothesis).
    const agg = new Map();
    for (const e of evs) for (const s of signalsFor(e, ctx)) agg.set(s.key, (agg.get(s.key) || 0) + s.w);
    for (const [key, w] of agg) {
      if (!hypIds.has(key) || Math.abs(w) < 0.05) continue;
      edges.push({ from: id, to: `h:${key}`, type: 'inference', polarity: w > 0 ? 'supports' : 'contradicts', weight: Math.round(w * 100) / 100 });
    }
  }
  for (const h of rev.hypotheses.filter((x) => hypIds.has(x.key))) {
    nodes.push({ id: `h:${h.key}`, label: h.title, sub: `${h.probability}%`, layer: 4, kind: 'HYPOTHESIS', rank: h.rank, probability: h.probability, confirmed: event.resolution?.actualCategory === h.key ? event.resolution.outcome : null });
  }
  const valid = new Set(nodes.map((n) => n.id));
  return { nodes, edges: edges.filter((e) => valid.has(e.from) && valid.has(e.to)), revision: rev.rev };
}
