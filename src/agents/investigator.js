// INVESTIGATOR — collects and correlates evidence for a Ghost Event.
//
// Market-structure evidence comes straight from the Detector's measurements
// (tagged with the feed's provenance: LIVE for Bitget, SIMULATED in demo).
// Information evidence comes from pluggable sources (news, filings, social,
// calendar). Every source is recorded in `sourceChecks` with its status, so
// a missing connector shows up as "not connected" instead of as silence.

import { CATEGORY_KEYS } from './hypothesis.js';

export const INVESTIGATION_STEPS = [
  'Market data',
  'Related tokenized equities',
  'Sector movement',
  'Crypto correlations',
  'News',
  'Company announcements',
  'SEC filings',
  'Social / web signals',
  'Scheduled events',
  'Historical similar patterns',
];

// Every evidence item carries a class so the UI can separate what was
// OBSERVED from what was merely SCHEDULED or recalled from HISTORY.
export function marketEvidence(anomaly, asset) {
  const m = anomaly.measurements;
  const x = anomaly.cross;
  const out = [
    {
      key: 'mkt:price',
      kind: 'PRICE_ANOMALY',
      title: `${asset.ticker} ${m.retPct >= 0 ? '+' : ''}${m.retPct.toFixed(2)}% in ${Math.round((m.windowEnd - m.windowStart) / 60000)}m`,
      detail: `${m.priceZ.toFixed(1)}σ vs trailing ${m.baselineBars}-bar volatility (${m.sigma1mPct.toFixed(3)}%/min)`,
      data: { retPct: m.retPct, priceZ: m.priceZ },
    },
    {
      key: 'mkt:volume',
      kind: 'VOLUME_ANOMALY',
      title: `Volume ${m.volumeChangePct >= 0 ? '+' : ''}${m.volumeChangePct}%`,
      detail: `${m.volumeRatio.toFixed(1)}× baseline median 1m volume`,
      data: { volumeRatio: m.volumeRatio },
    },
    {
      key: 'mkt:volatility',
      kind: 'VOLATILITY_CHANGE',
      title: `Intrabar range ${m.volatilityRatio.toFixed(1)}× baseline`,
      detail: 'Mean (high − low) / close over the window vs baseline',
      data: { ratio: m.volatilityRatio },
    },
  ];
  if (m.spread) {
    out.push({
      key: 'mkt:spread',
      kind: 'SPREAD_CHANGE',
      title: `Spread ${m.spread.currentBps.toFixed(1)} bps (${m.spread.ratio.toFixed(1)}× baseline)`,
      detail: `Baseline median ${m.spread.baselineBps.toFixed(1)} bps`,
      data: m.spread,
    });
  }
  for (const p of x.peers) {
    out.push({
      key: `mkt:peer:${p.ticker}`,
      kind: 'PEER_MOVE',
      title: `${p.ticker} ${p.retPct >= 0 ? '+' : ''}${p.retPct.toFixed(2)}%${p.sibling ? ' (same stock, other issuer)' : ''}`,
      detail: `Same window · baseline return correlation ${p.corr.toFixed(2)}`,
      data: p,
    });
  }
  if (x.avgPeerRetPct != null) {
    out.push({
      key: 'mkt:sector',
      kind: 'SECTOR_SUMMARY',
      title: `${asset.sector}: peers avg ${x.avgPeerRetPct >= 0 ? '+' : ''}${x.avgPeerRetPct.toFixed(2)}%`,
      detail: `Residual (unexplained by peers) ${x.residualPct >= 0 ? '+' : ''}${x.residualPct.toFixed(2)}%`,
      data: { avgPeerRetPct: x.avgPeerRetPct, residualPct: x.residualPct },
    });
  }
  if (x.marketWide) {
    const w = x.marketWide;
    out.push({
      key: 'mkt:wide',
      kind: 'MARKET_WIDE_MOVE',
      title: `Tokenized market avg ${w.avgRetPct >= 0 ? '+' : ''}${w.avgRetPct.toFixed(2)}% (${w.n} assets)`,
      detail: `${Math.round(w.breadth * 100)}% moved in the same direction by ≥0.1%`,
      data: w,
    });
  }
  for (const c of x.crypto) {
    out.push({
      key: `mkt:crypto:${c.ticker}`,
      kind: 'CRYPTO_MOVE',
      title: `${c.ticker} ${c.retPct >= 0 ? '+' : ''}${c.retPct.toFixed(2)}%`,
      detail: 'Same window',
      data: c,
    });
  }
  return out.map((e) => ({ ...e, class: 'OBSERVED' }));
}

// Similar past events from memory → category base rates (HISTORICAL).
export function historicalEvidence(memory, anomaly) {
  const similar = memory.similar(anomaly.measurements, { limit: 40 });
  const resolved = similar.filter((r) => r.actualCategory);
  if (!resolved.length) return null;
  const shares = Object.fromEntries(CATEGORY_KEYS.map((k) => [k, 0]));
  for (const r of resolved) shares[r.actualCategory] += 1 / resolved.length;
  const top = Object.entries(shares).sort((a, b) => b[1] - a[1])[0];
  return {
    key: 'hist:similar',
    kind: 'HISTORICAL_PATTERN',
    title: `${resolved.length} similar past events in PRED Memory`,
    detail: `Most common resolved cause: ${top[0].replace('_', ' ').toLowerCase()} (${Math.round(top[1] * 100)}%)`,
    data: { n: resolved.length, shares, sampleProvenance: [...new Set(resolved.map((r) => r.provenance))] },
    provenance: 'HISTORICAL',
    class: 'HISTORICAL',
  };
}

async function withTimeout(p, ms) {
  let t;
  const timeout = new Promise((_, rej) => (t = setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms)));
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(t);
  }
}

// Run information sources. Returns { items, checks }.
export async function scanSources(sources, ctx, { timeoutMs = 12000 } = {}) {
  const results = await Promise.all(
    sources.map(async (s) => {
      const started = Date.now();
      try {
        const r = await withTimeout(s.collect(ctx), timeoutMs);
        return { s, r, ms: Date.now() - started };
      } catch (err) {
        return { s, r: { status: 'unavailable', note: err.message, evidence: [] }, ms: Date.now() - started };
      }
    }),
  );
  const items = [];
  const checks = [];
  for (const { s, r, ms } of results) {
    checks.push({ source: s.id, name: s.name, category: s.category, provenance: s.provenance, status: r.status, note: r.note, found: r.evidence.length, checkedAt: ctx.now, latencyMs: ms });
    for (const e of r.evidence) items.push({ ...e, source: s.name, provenance: e.provenance || s.provenance, class: e.class || (s.category === 'calendar' ? 'SCHEDULED' : 'OBSERVED') });
    if (s.category === 'news' && r.status === 'ok' && !r.evidence.some((e) => e.data?.scope === 'company')) {
      items.push({
        key: `${s.id}:empty`,
        kind: 'NEWS_SCAN_EMPTY',
        title: `No company-specific coverage for ${ctx.asset.company}`,
        detail: `${s.name} scan returned no matching headlines`,
        source: s.name,
        provenance: s.provenance,
        sourceTime: ctx.now,
        class: 'OBSERVED',
        data: {},
      });
    }
  }
  return { items, checks };
}

export function createInvestigator({ sources = [], memory, feedProvenance = 'LIVE', feedName = 'Bitget' } = {}) {
  return {
    sources,
    async investigate({ anomaly, asset, now }) {
      const items = marketEvidence(anomaly, asset).map((e) => ({ ...e, source: feedName, provenance: feedProvenance, sourceTime: anomaly.measurements.windowEnd }));
      const checks = [{ source: 'market', name: feedName, category: 'market', provenance: feedProvenance, status: 'ok', note: `${items.length} market-structure measurements`, found: items.length, checkedAt: now }];
      const hist = memory ? historicalEvidence(memory, anomaly) : null;
      checks.push({ source: 'memory', name: 'PRED Memory', category: 'historical', provenance: 'HISTORICAL', status: 'ok', note: hist ? hist.detail : 'No comparable resolved events yet', found: hist ? 1 : 0, checkedAt: now });
      if (hist) items.push({ ...hist, source: 'PRED Memory', sourceTime: now });
      const scan = await scanSources(sources, { asset, now, anomaly });
      return { items: [...items, ...scan.items], checks: [...checks, ...scan.checks] };
    },
    async rescan({ asset, now }) {
      return scanSources(sources, { asset, now });
    },
  };
}
