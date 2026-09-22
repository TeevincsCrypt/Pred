// DETECTOR — finds statistical anomalies in 1-minute tokenized-equity bars.
//
// Measures, for the most recent window of W bars versus a trailing baseline:
//   • price move and its z-score against baseline 1-minute volatility
//   • volume ratio against the baseline median
//   • intrabar-range (volatility) ratio
//   • bid/ask spread change (when quotes are available)
//   • peer and crypto moves over the same window, and the residual move
//     not explained by peers
// A Ghost Event is proposed only when the U.S. regular session is closed.

import { mean, median, std, logReturns, pearson, round } from '../util/stats.js';

export const DETECTOR_DEFAULTS = {
  windowBars: 5,
  baselineBars: 120,
  minBaselineBars: 45,
  minAbsMovePct: 0.6,
  minPriceZ: 3.5,
  minVolumeRatio: 2.5,
  scoreThreshold: 6,
  cooldownMs: 60 * 60 * 1000,
};

export function measure(candles, { windowBars = 5, baselineBars = 120, minBaselineBars = 45 } = {}) {
  if (candles.length < minBaselineBars + windowBars + 1) return null;
  const win = candles.slice(-windowBars);
  const base = candles.slice(-(windowBars + baselineBars), -windowBars);
  const anchor = base[base.length - 1];

  const baseRets = logReturns(base.map((c) => c.close));
  const sigma = Math.max(std(baseRets), 1e-4);
  const lastClose = win[win.length - 1].close;
  const logMove = Math.log(lastClose / anchor.close);
  const retPct = (lastClose / anchor.close - 1) * 100;
  const priceZ = logMove / (sigma * Math.sqrt(windowBars));

  const baseVol = Math.max(median(base.map((c) => c.volume)), 1e-9);
  const volumeRatio = mean(win.map((c) => c.volume)) / baseVol;

  const rangeOf = (c) => (c.high - c.low) / c.close;
  const baseRange = Math.max(mean(base.map(rangeOf)), 1e-6);
  const volatilityRatio = mean(win.map(rangeOf)) / baseRange;

  return {
    windowStart: anchor.ts,
    windowEnd: win[win.length - 1].ts,
    priceBefore: anchor.close,
    price: lastClose,
    retPct: round(retPct, 3),
    priceZ: round(priceZ, 2),
    sigma1mPct: round(sigma * 100, 4),
    volumeRatio: round(volumeRatio, 2),
    volumeChangePct: round((volumeRatio - 1) * 100, 0),
    volatilityRatio: round(volatilityRatio, 2),
    baselineBars: base.length,
  };
}

export function spreadChange(quotesBaseline, quotesRecent) {
  const bps = (q) => ((q.ask - q.bid) / ((q.ask + q.bid) / 2)) * 1e4;
  const valid = (q) => q.bid > 0 && q.ask > q.bid;
  const b = quotesBaseline.filter(valid).map(bps);
  const r = quotesRecent.filter(valid).map(bps);
  if (b.length < 3 || !r.length) return null;
  const baselineBps = median(b);
  const currentBps = median(r);
  return { baselineBps: round(baselineBps, 2), currentBps: round(currentBps, 2), ratio: round(currentBps / Math.max(baselineBps, 0.01), 2) };
}

// Cross-asset context over the same window.
export function crossAsset(store, m, peers, cryptoRefs) {
  const peerMoves = peers
    .map((p) => {
      const chg = store.changePct(p, m.windowStart, m.windowEnd);
      if (chg == null) return null;
      const a = store.candles(p).filter((c) => c.ts <= m.windowStart).slice(-m.baselineBars);
      return { ticker: p, retPct: round(chg, 3), a };
    })
    .filter(Boolean);

  // Baseline return correlation between asset and each peer.
  const withCorr = (assetBars) =>
    peerMoves.map(({ ticker, retPct, a }) => {
      const x = logReturns(assetBars.map((c) => c.close));
      const y = logReturns(a.map((c) => c.close));
      return { ticker, retPct, corr: round(pearson(x, y), 2) };
    });

  const crypto = Object.keys(cryptoRefs)
    .map((k) => {
      const chg = store.changePct(k, m.windowStart, m.windowEnd);
      return chg == null ? null : { ticker: k, retPct: round(chg, 3) };
    })
    .filter(Boolean);

  const avgPeer = peerMoves.length ? mean(peerMoves.map((p) => p.retPct)) : null;
  const residualPct = avgPeer == null ? null : m.retPct - avgPeer;
  return { withCorr, peerMoves, crypto, avgPeerRetPct: avgPeer == null ? null : round(avgPeer, 3), residualPct: residualPct == null ? null : round(residualPct, 3) };
}

export function anomalyScore(m, spread) {
  const z = Math.max(0, Math.abs(m.priceZ) - 1) * 0.9;
  const v = Math.max(0, Math.log2(Math.max(m.volumeRatio, 1e-9))) * 1.2;
  const vol = Math.max(0, m.volatilityRatio - 1) * 0.5;
  const s = spread ? Math.max(0, spread.ratio - 1) * 0.3 : 0;
  return round(z + v + vol + s, 2);
}

export function severity(score) {
  if (score >= 14) return 'EXTREME';
  if (score >= 9) return 'HIGH';
  return 'ELEVATED';
}

export function createDetector(opts = {}) {
  const cfg = { ...DETECTOR_DEFAULTS, ...opts };
  const lastFired = new Map();

  return {
    config: cfg,
    // Returns an anomaly object or null.
    evaluate({ ticker, store, now, market, peers = [], cryptoRefs = {} }) {
      const m = measure(store.candles(ticker), cfg);
      if (!m) return null;
      const quotesBase = store.quotesSince(ticker, m.windowStart - cfg.baselineBars * 60_000).filter((q) => q.ts < m.windowStart);
      const quotesRecent = store.quotesSince(ticker, m.windowStart);
      const spread = spreadChange(quotesBase, quotesRecent);
      const score = anomalyScore(m, spread);

      const strongMove = Math.abs(m.retPct) >= cfg.minAbsMovePct && Math.abs(m.priceZ) >= cfg.minPriceZ;
      const triggered = (strongMove && m.volumeRatio >= cfg.minVolumeRatio) || (Math.abs(m.retPct) >= cfg.minAbsMovePct && score >= cfg.scoreThreshold);
      if (!triggered) return null;
      if (now - (lastFired.get(ticker) ?? -Infinity) < cfg.cooldownMs) return null;
      if (market.usMarketOpen) return null; // regular session open → not a Ghost Event

      lastFired.set(ticker, now);
      const cross = crossAsset(store, m, peers, cryptoRefs);
      return {
        ticker,
        detectedAt: now,
        marketSession: market.session,
        measurements: { ...m, spread, score, severity: severity(score) },
        cross: { peers: cross.withCorr(store.candles(ticker).filter((c) => c.ts <= m.windowStart).slice(-cfg.baselineBars)), crypto: cross.crypto, avgPeerRetPct: cross.avgPeerRetPct, residualPct: cross.residualPct },
      };
    },
    reset() {
      lastFired.clear();
    },
  };
}
