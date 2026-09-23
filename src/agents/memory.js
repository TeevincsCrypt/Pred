// MEMORY AGENT — persists every Ghost Event, evaluates prediction vs.
// reality once the outcome is known, attributes failures, and reports
// accuracy and calibration.

import fs from 'node:fs';
import path from 'node:path';
import { mean, round } from '../util/stats.js';

export const FAILURE_CATEGORIES = {
  WRONG_CATALYST: 'wrong catalyst',
  INSUFFICIENT_EVIDENCE: 'insufficient evidence',
  LIQUIDITY_ANOMALY: 'liquidity anomaly',
  UNRELATED_MARKET_MOVE: 'unrelated market movement',
  DELAYED_INFORMATION: 'delayed information',
  CORRELATION_BREAKDOWN: 'correlation breakdown',
  UNEXPECTED_EVENT: 'unexpected event',
};

const DEADBAND = 0.1; // % — moves smaller than this count as "flat"

export function evaluateOutcome(record) {
  const pred = record.predictions?.[record.predictions.length - 1];
  const o = record.outcome;
  const res = record.resolution;
  const ev = { failures: [] };

  if (pred?.status === 'OK' && o?.reactionPct != null) {
    const s = (x) => (Math.abs(x) < DEADBAND ? 0 : Math.sign(x));
    ev.directionCorrect = s(pred.estimatePct) === s(o.reactionPct);
    ev.withinRange = o.reactionPct >= pred.rangeLowPct && o.reactionPct <= pred.rangeHighPct;
    ev.absErrorPct = round(Math.abs(pred.estimatePct - o.reactionPct), 2);
  } else {
    ev.directionCorrect = null;
    ev.withinRange = null;
    ev.absErrorPct = null;
  }

  ev.catalystCorrect = res?.outcome === 'CONFIRMED' ? true : res?.outcome === 'INVALIDATED' ? false : null;
  ev.timeToConfirmationMs = res?.outcome === 'CONFIRMED' ? res.timeToResolutionMs : null;
  ev.falsePositive = record.actualCategory === 'LIQUIDITY';

  const f = ev.failures;
  const primaryKey = res?.judgedHypothesis?.key ?? record.finalPrimary?.key;
  if (res?.outcome === 'INVALIDATED') f.push(record.actualCategory === 'LIQUIDITY' ? 'LIQUIDITY_ANOMALY' : 'WRONG_CATALYST');
  if (!res || res.outcome === 'UNRESOLVED') f.push('INSUFFICIENT_EVIDENCE');
  if (res?.outcome === 'CONFIRMED' && record.nextOpenAt && res.resolvedAt > record.nextOpenAt) f.push('DELAYED_INFORMATION');
  if (ev.directionCorrect === false) {
    const peer = o?.peerReactionPct;
    if (primaryKey === 'SECTOR_REPRICING' && peer != null && Math.sign(peer) !== Math.sign(o.reactionPct)) f.push('CORRELATION_BREAKDOWN');
    else if (peer != null && Math.abs(peer) >= 0.8 * Math.abs(o.reactionPct) && Math.sign(peer) === Math.sign(o.reactionPct)) f.push('UNRELATED_MARKET_MOVE');
    else f.push('UNEXPECTED_EVENT');
  }
  ev.success = ev.catalystCorrect !== false && ev.directionCorrect !== false && !f.includes('INSUFFICIENT_EVIDENCE');
  return ev;
}

export function createMemory({ file = null, records = [], onUpsert = null } = {}) {
  let data = records;
  if (file && fs.existsSync(file)) {
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8')).records || [];
    } catch {
      data = records;
    }
  }
  let saveTimer = null;
  const persist = () => {
    if (!file) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ version: 1, records: data }, null, 1));
    }, 250);
  };

  const api = {
    get records() {
      return data;
    },
    nextSeq() {
      return data.reduce((m, r) => Math.max(m, r.seq || 0), 0) + 1;
    },
    upsert(record) {
      const i = data.findIndex((r) => r.id === record.id);
      if (i >= 0) data[i] = record;
      else data.push(record);
      persist();
      if (onUpsert) onUpsert(record);
      return record;
    },
    get(id) {
      return data.find((r) => r.id === id);
    },

    // Nearest past events by anomaly shape (sign, |move|, volume ratio).
    similar(m, { limit = 40 } = {}) {
      const dir = Math.sign(m.retPct);
      return data
        .filter((r) => r.measurements && Math.sign(r.measurements.retPct) === dir)
        .map((r) => ({
          r,
          d: Math.abs(Math.log(Math.max(Math.abs(r.measurements.retPct), 0.05) / Math.max(Math.abs(m.retPct), 0.05))) + 0.5 * Math.abs(Math.log(Math.max(r.measurements.volumeRatio, 0.1) / Math.max(m.volumeRatio, 0.1))),
        }))
        .sort((a, b) => a.d - b.d)
        .slice(0, limit)
        .map((x) => x.r);
    },

    stats() {
      const all = [...data].sort((a, b) => a.detectedAt - b.detectedAt);
      const count = (fn) => all.filter(fn).length;
      const evald = all.filter((r) => r.evaluation);
      const confirmedCatalysts = count((r) => r.resolution?.outcome === 'CONFIRMED' && r.actualCategory !== 'LIQUIDITY');
      const liquidity = count((r) => r.actualCategory === 'LIQUIDITY');
      const falseHyp = count((r) => r.resolution?.outcome === 'INVALIDATED' && r.actualCategory !== 'LIQUIDITY');
      const open = count((r) => !r.evaluation);
      const rate = (xs, key) => {
        const v = xs.map((r) => r.evaluation?.[key]).filter((x) => x === true || x === false);
        return v.length ? { rate: round(v.filter(Boolean).length / v.length, 3), n: v.length } : { rate: null, n: 0 };
      };
      const ttc = evald.map((r) => r.evaluation.timeToConfirmationMs).filter((x) => x != null);
      const resolved = all.filter((r) => r.resolution && r.resolution.outcome !== 'UNRESOLVED');

      const failures = Object.fromEntries(Object.keys(FAILURE_CATEGORIES).map((k) => [k, 0]));
      for (const r of evald) for (const f of r.evaluation.failures) failures[f] += 1;

      // Calibration: stated probability of the initial primary hypothesis vs. whether it was right.
      const calib = all.filter((r) => r.evaluation?.catalystCorrect != null && r.initialPrimary);
      const bins = [
        [0, 40],
        [40, 55],
        [55, 70],
        [70, 85],
        [85, 101],
      ].map(([lo, hi]) => {
        const xs = calib.filter((r) => r.initialPrimary.probability >= lo && r.initialPrimary.probability < hi);
        return {
          range: `${lo}–${Math.min(hi, 100)}%`,
          n: xs.length,
          stated: xs.length ? round(mean(xs.map((r) => r.initialPrimary.probability / 100)), 3) : null,
          observed: xs.length ? round(xs.filter((r) => r.evaluation.catalystCorrect).length / xs.length, 3) : null,
        };
      });
      const brier = (xs) => (xs.length ? round(mean(xs.map((r) => (r.initialPrimary.probability / 100 - (r.evaluation.catalystCorrect ? 1 : 0)) ** 2)), 4) : null);
      const windowSize = Math.max(8, Math.ceil(calib.length / 8));
      const overTime = [];
      for (let i = 0; i < calib.length; i += windowSize) {
        const xs = calib.slice(i, i + windowSize);
        if (xs.length < 4) break;
        overTime.push({
          from: xs[0].detectedAt,
          to: xs[xs.length - 1].detectedAt,
          n: xs.length,
          brier: brier(xs),
          stated: round(mean(xs.map((r) => r.initialPrimary.probability / 100)), 3),
          observed: round(xs.filter((r) => r.evaluation.catalystCorrect).length / xs.length, 3),
          provenance: [...new Set(xs.map((r) => r.provenance))],
        });
      }

      return {
        total: all.length,
        confirmedCatalysts,
        liquidityAnomalies: liquidity,
        falseHypotheses: falseHyp,
        unresolvedOther: all.length - confirmedCatalysts - liquidity - falseHyp,
        openEvents: open,
        provenance: Object.fromEntries(['LIVE', 'SIMULATED', 'HISTORICAL'].map((p) => [p, count((r) => r.provenance === p)])),
        accuracy: {
          direction: rate(evald, 'directionCorrect'),
          catalyst: rate(evald, 'catalystCorrect'),
          reactionRange: rate(evald, 'withinRange'),
          meanAbsErrorPct: evald.some((r) => r.evaluation.absErrorPct != null) ? round(mean(evald.map((r) => r.evaluation.absErrorPct).filter((x) => x != null)), 2) : null,
          medianTimeToConfirmationMin: ttc.length ? Math.round([...ttc].sort((a, b) => a - b)[Math.floor(ttc.length / 2)] / 60000) : null,
          falsePositiveRate: resolved.length ? round(resolved.filter((r) => r.actualCategory === 'LIQUIDITY').length / resolved.length, 3) : null,
        },
        failures,
        calibration: { bins, brier: brier(calib), overTime, n: calib.length },
        recent: all
          .filter((r) => r.evaluation)
          .slice(-12)
          .reverse()
          .map((r) => ({
            id: r.id,
            code: r.code,
            ticker: r.ticker,
            detectedAt: r.detectedAt,
            provenance: r.provenance,
            initialPrimary: r.initialPrimary,
            actualCategory: r.actualCategory,
            status: r.status,
            predicted: r.predictions?.at(-1)?.status === 'OK' ? { est: r.predictions.at(-1).estimatePct, lo: r.predictions.at(-1).rangeLowPct, hi: r.predictions.at(-1).rangeHighPct } : null,
            actual: r.outcome?.reactionPct ?? null,
            evaluation: r.evaluation,
          })),
      };
    },
  };
  return api;
}
