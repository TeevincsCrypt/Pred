// PRED engine — orchestrates the six agents around the event lifecycle:
//
//   DETECT → INVESTIGATE → HYPOTHESIZE → VERIFY → PREDICT → LEARN
//
//   DETECTED → INVESTIGATING → HYPOTHESIS_CREATED → AWAITING_CONFIRMATION
//            → CONFIRMED / INVALIDATED / UNRESOLVED
//
// Every change is appended to the event timeline. Hypothesis revisions and
// reaction predictions are append-only: PRED never silently overwrites its
// earlier reasoning.

import { SeriesStore } from '../market/series.js';
import { marketStatus, nextRegularClose, nextRegularOpen } from '../market/hours.js';
import { createDetector } from '../agents/detector.js';
import { createInvestigator } from '../agents/investigator.js';
import { generateHypotheses, CATEGORIES } from '../agents/hypothesis.js';
import { relation, toAuthoritative, priceCheck, resolve } from '../agents/verifier.js';
import { predictReaction, PREDICTION_THRESHOLD } from '../agents/reaction.js';
import { evaluateOutcome } from '../agents/memory.js';
import { templateNarrative } from '../agents/analyst.js';
import { buildGraph } from './graph.js';
import { recommendAction } from './action.js';
import { mean, round } from '../util/stats.js';

export const STATES = ['DETECTED', 'INVESTIGATING', 'HYPOTHESIS_CREATED', 'AWAITING_CONFIRMATION', 'CONFIRMED', 'INVALIDATED', 'UNRESOLVED'];
const TERMINAL = new Set(['CONFIRMED', 'INVALIDATED', 'UNRESOLVED']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createEngine({
  mode,
  clock = { now: () => Date.now() },
  universe,
  monitored,
  cryptoRefs = {},
  sources = [],
  memory,
  analyst = null,
  feedName = 'Bitget',
  feedProvenance = 'LIVE',
  detectorOpts = {},
  stageDelayMs = 0,
  rescanIntervalMs = 5 * 60_000,
  // Demo mode passes a gate so each lifecycle stage can be stepped through.
  gate = async () => {},
}) {
  const store = new SeriesStore();
  const detector = createDetector(detectorOpts);
  const investigator = createInvestigator({ sources, memory, feedProvenance, feedName });
  const events = new Map();
  const log = [];
  const listeners = new Set();
  const pending = new Set();
  let feedStatus = { source: feedName, provenance: feedProvenance, status: 'idle', symbols: {} };
  let lastRescan = 0;
  let evidenceCounter = new Map();

  const now = () => clock.now();

  function emit() {
    for (const fn of listeners) fn();
  }

  function sys(text, level = 'info', ref = null) {
    log.push({ at: now(), text, level, ref });
    if (log.length > 300) log.splice(0, log.length - 300);
    emit();
  }

  function track(p) {
    pending.add(p);
    p.finally(() => pending.delete(p));
    return p;
  }

  // ---------- timeline / state ----------

  function note(event, type, agent, text, extra = {}) {
    event.timeline.push({ at: now(), type, agent, text, ...extra });
  }

  function setState(event, state, text) {
    if (event.state === state) return;
    const from = event.state;
    event.state = state;
    event.stateHistory.push({ state, at: now() });
    note(event, 'STATE', 'Engine', text || `${from ?? '—'} → ${state}`, { state });
    sys(`${event.code} ${event.ticker}: ${state.replaceAll('_', ' ')}`, TERMINAL.has(state) ? 'resolve' : 'info', event.id);
  }

  // ---------- evidence ----------

  function addEvidence(event, items, trigger) {
    const known = new Set(event.evidence.map((e) => e.key));
    const added = [];
    const primary = event.revisions.at(-1)?.primary?.key;
    const ctx = hypCtx(event);
    for (const it of items) {
      if (known.has(it.key)) continue;
      known.add(it.key);
      const n = (evidenceCounter.get(event.id) || 0) + 1;
      evidenceCounter.set(event.id, n);
      const ev = { id: `E${event.seq}-${n}`, observedAt: now(), trigger, ...it };
      if (primary) Object.assign(ev, relation(ev, primary, ctx));
      event.evidence.push(ev);
      added.push(ev);
    }
    // A clean news scan is superseded (not deleted) once company news appears.
    if (event.evidence.some((e) => e.kind === 'NEWS_ARTICLE' && e.data?.scope === 'company')) {
      for (const e of event.evidence) if (e.kind === 'NEWS_SCAN_EMPTY' && !e.superseded) {
        e.superseded = true;
        e.supersededAt = now();
      }
    }
    return added;
  }

  function hypCtx(event) {
    const m = event.anomaly.measurements;
    return { ticker: event.ticker, retPct: m.retPct, peers: event.asset.peers, sector: event.asset.sector, priceBefore: m.priceBefore };
  }

  async function revise(event, trigger, reason) {
    const active = event.evidence.filter((e) => !e.superseded);
    const hypotheses = generateHypotheses(active, hypCtx(event), event.sourceChecks);
    const prev = event.revisions.at(-1);
    const top = hypotheses[0];
    const rev = {
      rev: (prev?.rev || 0) + 1,
      at: now(),
      trigger,
      reason,
      evidenceCount: active.length,
      hypotheses,
      primary: { key: top.key, title: top.title, probability: top.probability, confidence: top.confidence },
    };
    rev.narrative = templateNarrative(event, rev);
    event.revisions.push(rev);
    let text;
    if (!prev) text = `Hypotheses generated — primary: ${top.title} ${top.probability}%`;
    else if (prev.primary.key !== top.key) text = `Primary changed: ${prev.primary.title} ${prev.primary.probability}% → ${top.title} ${top.probability}%`;
    else text = `${top.title} ${prev.primary.probability}% → ${top.probability}%`;
    note(event, 'HYPOTHESIS', 'Hypothesis Agent', `Revision ${rev.rev}: ${text}`, { rev: rev.rev });
    if (analyst?.enabled) {
      track(
        analyst.narrate(event, rev).then((n) => {
          rev.narrative = n;
          syncRecord(event);
          emit();
        }),
      );
    }
    return rev;
  }

  // ---------- memory record ----------

  function syncRecord(event) {
    if (!memory) return;
    const first = event.revisions[0];
    const last = event.revisions.at(-1);
    memory.upsert({
      id: event.recordId,
      seq: event.seq,
      code: event.code,
      mode,
      provenance: feedProvenance,
      ticker: event.ticker,
      detectedAt: event.detectedAt,
      nextOpenAt: event.nextOpenAt,
      horizonAt: event.horizonAt,
      measurements: event.anomaly.measurements,
      cross: event.anomaly.cross,
      status: event.state,
      initialHypotheses: first?.hypotheses.map((h) => ({ key: h.key, probability: h.probability })),
      initialPrimary: first?.primary,
      finalPrimary: last?.primary,
      revisions: event.revisions.length,
      evidenceSummary: event.evidence.map((e) => ({ id: e.id, kind: e.kind, title: e.title, provenance: e.provenance, relation: e.relation })),
      resolution: event.resolution,
      actualCategory: event.resolution?.actualCategory ?? null,
      predictions: event.predictions,
      outcome: event.outcome,
      evaluation: event.evaluation,
    });
  }

  // ---------- prediction ----------

  function maybePredict(event, basis) {
    if (!memory || event.outcome || now() >= event.horizonAt) return;
    if (event.resolution && event.resolution.outcome !== 'CONFIRMED') return;
    const rev = event.revisions.at(-1);
    const lastPred = event.predictions.at(-1);
    const confirmed = event.resolution?.outcome === 'CONFIRMED';
    const eligible = confirmed || rev.primary.probability >= PREDICTION_THRESHOLD;
    if (!eligible) return;
    if (lastPred && !(confirmed && lastPred.basis !== 'confirmed')) return;
    if (event.resolution?.actualCategory === 'LIQUIDITY' || rev.primary.key === 'UNKNOWN') return;
    const refPrice = store.lastPrice(event.ticker);
    const p = predictReaction({ event, memory, now: now(), refPrice, basis: confirmed ? 'confirmed' : 'high-confidence' });
    p.seq = event.predictions.length + 1;
    event.predictions.push(p);
    if (p.status === 'OK') {
      note(event, 'PREDICTION', 'Reaction Agent', `Expected reaction ${p.direction.toLowerCase()}: ${fmtPct(p.rangeLowPct)} → ${fmtPct(p.rangeHighPct)}, estimate ${fmtPct(p.estimatePct)} (confidence ${p.confidence}%, ${p.comparableCount} comparables)${lastPred ? ' — supersedes prediction #' + lastPred.seq : ''}`);
    } else {
      note(event, 'PREDICTION', 'Reaction Agent', `No reaction estimate: ${p.note}`);
    }
  }

  // ---------- lifecycle ----------

  async function openEvent(anomaly) {
    const asset = universe[anomaly.ticker];
    const seq = memory ? memory.nextSeq() : events.size + 1;
    const detectedAt = anomaly.detectedAt;
    const event = {
      id: `${mode}-${seq}`,
      recordId: `${mode}-${seq}`,
      seq,
      code: `GHOST EVENT #${seq}`,
      mode,
      provenance: feedProvenance,
      ticker: anomaly.ticker,
      asset: { ticker: asset.ticker, company: asset.company, sector: asset.sector, peers: asset.peers, symbol: feedStatus.symbols?.[anomaly.ticker] || null },
      detectedAt,
      market: marketStatus(detectedAt),
      horizonAt: nextRegularClose(detectedAt),
      nextOpenAt: nextRegularOpen(detectedAt),
      anomaly,
      state: null,
      stateHistory: [],
      timeline: [],
      evidence: [],
      sourceChecks: [],
      revisions: [],
      predictions: [],
      resolution: null,
      outcome: null,
      evaluation: null,
    };
    events.set(event.id, event);
    const m = anomaly.measurements;
    setState(event, 'DETECTED', `Detector: ${event.ticker} ${fmtPct(m.retPct)} (${m.priceZ.toFixed(1)}σ), volume ${m.volumeChangePct >= 0 ? '+' : ''}${m.volumeChangePct}%, ${event.market.label.toLowerCase()} (${m.severity})`);
    syncRecord(event);
    emit();

    await gate('investigate', event);
    await sleep(stageDelayMs);
    setState(event, 'INVESTIGATING', 'Investigator: collecting market, sector, crypto, news, filings, social, calendar and historical evidence');
    emit();
    const { items, checks } = await investigator.investigate({ anomaly, asset, now: now() });
    event.sourceChecks = checks;
    const added = addEvidence(event, items, 'investigation');
    for (const c of checks) note(event, 'SOURCE', 'Investigator', `${c.name}: ${c.status === 'ok' ? c.note : c.status.replace('_', ' ') + ' — ' + c.note}`, { provenance: c.provenance, status: c.status });
    note(event, 'EVIDENCE', 'Investigator', `${added.length} evidence items collected`);
    emit();
    await gate('hypothesize', event);
    await sleep(stageDelayMs);

    await revise(event, 'investigation', 'initial investigation');
    setState(event, 'HYPOTHESIS_CREATED');
    // Authoritative evidence may already exist (catalyst already public).
    if (promoteAuthoritative(event, added).length) await revise(event, 'investigation', 'authoritative evidence already public');
    syncRecord(event);
    emit();
    await gate('await', event);
    await sleep(stageDelayMs / 2);
    setState(event, 'AWAITING_CONFIRMATION', 'Verifier: watching for confirming or contradicting evidence');
    await settle(event, 'investigation');
    syncRecord(event);
    emit();
    return event;
  }

  function promoteAuthoritative(event, items) {
    const auth = items.map((i) => toAuthoritative(i, event)).filter(Boolean);
    return auth.length ? addEvidence(event, auth, 'verification') : [];
  }

  // Re-score after evidence changes, resolve if warranted, and predict.
  async function settle(event, trigger) {
    let res = resolve(event, now());
    if (res && !event.resolution) {
      emit();
      await gate('resolve', event);
      if (event.resolution) return;
      res = { ...res, resolvedAt: now(), timeToResolutionMs: now() - event.detectedAt };
      event.resolution = res;
      const auth = event.evidence.find((e) => e.id === res.confirmingEvidenceId);
      note(event, 'RESOLUTION', 'Verifier', `${res.outcome === 'CONFIRMED' ? 'CATALYST CONFIRMED' : 'HYPOTHESIS INVALIDATED'} — ${CATEGORIES[res.actualCategory].title} (${auth?.title}). Leading hypothesis at the time: ${res.judgedHypothesis.title} ${res.judgedHypothesis.probability}%. Time to resolution ${fmtDur(res.timeToResolutionMs)}.`, { evidenceId: auth?.id });
      setState(event, res.outcome);
    }
    maybePredict(event, trigger);
  }

  const verifying = new Set();
  async function verifyEvent(event, opts) {
    if (verifying.has(event.id)) return;
    verifying.add(event.id);
    try {
      await verifyOnce(event, opts);
    } finally {
      verifying.delete(event.id);
    }
  }

  async function verifyOnce(event, { rescan = true } = {}) {
    if (TERMINAL.has(event.state) && event.state !== 'CONFIRMED') return;
    if (event.outcome) return;
    const fresh = [];
    const px = priceCheck(event, store, now()).map((e) => ({ ...e, source: feedName, provenance: feedProvenance }));
    fresh.push(...px);
    if (rescan && !event.resolution) {
      const asset = universe[event.ticker];
      const { items, checks } = await investigator.rescan({ asset, now: now() });
      event.sourceChecks = [...event.sourceChecks.filter((c) => c.category === 'market' || c.category === 'historical'), ...checks];
      fresh.push(...items);
    }
    const added = addEvidence(event, fresh, 'verification');
    if (!added.length) return;
    const all = [...added, ...promoteAuthoritative(event, added)];
    for (const e of all) {
      const tag = e.relation ? ` [${e.relation.toLowerCase()} primary]` : '';
      note(event, 'EVIDENCE', 'Verifier', `New evidence: ${e.title}${tag}`, { evidenceId: e.id, provenance: e.provenance, relation: e.relation });
    }
    if (!event.resolution) await revise(event, 'verification', `${all.length} new evidence item(s)`);
    await settle(event, 'verification');
    syncRecord(event);
    emit();
  }

  function evaluateHorizon(event) {
    if (event.outcome || now() < event.horizonAt) return;
    const bars = store.candles(event.ticker);
    if (!bars.length || bars.at(-1).ts < event.horizonAt - 60_000) return; // need data through the horizon
    const pxH = store.priceAt(event.ticker, event.horizonAt);
    const pred = event.predictions.filter((p) => p.status === 'OK').at(-1);
    const refTs = pred ? pred.at : event.anomaly.measurements.windowEnd;
    const refPx = pred ? pred.refPrice : event.anomaly.measurements.price;
    const peerMoves = event.asset.peers.map((p) => store.changePct(p, refTs, event.horizonAt)).filter((x) => x != null);
    if (!event.resolution) {
      event.resolution = { outcome: 'UNRESOLVED', actualCategory: null, basis: 'horizon-reached', judgedHypothesis: event.revisions.at(-1).primary, originalHypothesis: event.revisions[0].primary, resolvedAt: now(), timeToResolutionMs: now() - event.detectedAt };
      note(event, 'RESOLUTION', 'Verifier', 'Horizon reached without authoritative evidence — UNRESOLVED');
      setState(event, 'UNRESOLVED');
    }
    event.outcome = {
      horizonAt: event.horizonAt,
      refPrice: refPx,
      horizonPrice: pxH,
      reactionPct: round((pxH / refPx - 1) * 100, 2),
      totalMovePct: round((pxH / event.anomaly.measurements.priceBefore - 1) * 100, 2),
      peerReactionPct: peerMoves.length ? round(mean(peerMoves), 2) : null,
      measuredAt: now(),
    };
    syncRecord(event);
    event.evaluation = evaluateOutcome(memory ? memory.get(event.recordId) : { ...event });
    const e = event.evaluation;
    const o = event.outcome;
    const predText = pred ? `predicted ${fmtPct(pred.estimatePct)} (${fmtPct(pred.rangeLowPct)} → ${fmtPct(pred.rangeHighPct)})` : 'no reaction prediction';
    note(event, 'OUTCOME', 'Memory Agent', `Actual reaction ${fmtPct(o.reactionPct)} vs ${predText}. Direction ${e.directionCorrect == null ? 'n/a' : e.directionCorrect ? '✓' : '✗'}, range ${e.withinRange == null ? 'n/a' : e.withinRange ? '✓' : '✗'}, catalyst ${e.catalystCorrect == null ? 'n/a' : e.catalystCorrect ? '✓' : '✗'}${e.failures.length ? `. Failure: ${e.failures.join(', ').toLowerCase().replaceAll('_', ' ')}` : ''}`);
    syncRecord(event);
    sys(`${event.code} evaluated and stored in PRED Memory`, 'memory', event.id);
    emit();
  }

  // ---------- public API ----------

  const api = {
    mode,
    store,
    events,
    detector,
    clock,
    get feedStatus() {
      return feedStatus;
    },
    setFeedStatus(s) {
      feedStatus = { ...feedStatus, ...s };
      emit();
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    log: sys,

    ingestCandle(ticker, c) {
      store.addCandle(ticker, c);
    },
    ingestQuote(ticker, q) {
      store.addQuote(ticker, q);
    },

    // Called after each batch of market data.
    afterBatch({ rescan = false } = {}) {
      const t = now();
      const market = marketStatus(t);
      for (const ticker of monitored) {
        // One open event per ticker until its outcome is measured (avoids double-counting one catalyst).
        const hasOpen = [...events.values()].some((e) => e.ticker === ticker && !e.outcome);
        if (hasOpen) continue;
        const a = detector.evaluate({ ticker, store, now: t, market, peers: universe[ticker].peers, cryptoRefs });
        if (a) track(openEvent(a).catch((err) => sys(`Event pipeline error: ${err.message}`, 'error')));
      }
      const doRescan = rescan || t - lastRescan >= rescanIntervalMs;
      if (doRescan) lastRescan = t;
      for (const e of events.values()) {
        if (e.state === 'AWAITING_CONFIRMATION' || (e.state === 'CONFIRMED' && !e.outcome)) track(verifyEvent(e, { rescan: doRescan }).catch((err) => sys(`Verifier error: ${err.message}`, 'error')));
        if (e.revisions.length) evaluateHorizon(e);
      }
      emit();
    },

    verifyAll({ rescan = true } = {}) {
      const ps = [...events.values()].filter((e) => !e.outcome && e.revisions.length).map((e) => verifyEvent(e, { rescan }));
      return track(Promise.all(ps));
    },

    evaluateHorizons() {
      for (const e of events.values()) if (e.revisions.length) evaluateHorizon(e);
    },

    async idle() {
      while (pending.size) await Promise.allSettled([...pending]);
    },

    eventDetail(id) {
      const e = events.get(id);
      if (!e) return null;
      return { ...e, graph: buildGraph(e), action: recommendAction(e, now()), chart: chartFor(e) };
    },

    snapshot({ selectedId } = {}) {
      const t = now();
      const list = [...events.values()].sort((a, b) => b.detectedAt - a.detectedAt);
      const sel = selectedId && events.has(selectedId) ? selectedId : list[0]?.id;
      return {
        mode,
        now: t,
        market: marketStatus(t),
        feed: feedStatus,
        analyst: analyst?.enabled ? { enabled: true, model: analyst.model } : { enabled: false },
        monitored: monitored.map((ticker) => tickerSummary(ticker, t)),
        activeGhostEvents: list.filter((e) => !TERMINAL.has(e.state) && !e.outcome).length,
        events: list.map((e) => ({
          id: e.id,
          code: e.code,
          ticker: e.ticker,
          state: e.state,
          detectedAt: e.detectedAt,
          retPct: e.anomaly.measurements.retPct,
          volumeChangePct: e.anomaly.measurements.volumeChangePct,
          severity: e.anomaly.measurements.severity,
          primary: e.revisions.at(-1)?.primary || null,
          provenance: e.provenance,
          closed: !!e.outcome,
        })),
        selected: sel ? api.eventDetail(sel) : null,
        log: log.slice(-80).reverse(),
        memory: memory ? memory.stats() : null,
      };
    },
  };

  function tickerSummary(ticker, t) {
    const bars = store.candles(ticker);
    const last = bars.at(-1);
    const hourAgo = store.priceAt(ticker, t - 3600_000);
    return {
      ticker,
      company: universe[ticker]?.company,
      symbol: feedStatus.symbols?.[ticker] || null,
      price: last?.close ?? null,
      chg1hPct: last && hourAgo ? round((last.close / hourAgo - 1) * 100, 2) : null,
      lastBarAt: last?.ts ?? null,
      spark: bars.slice(-90).map((b) => b.close),
    };
  }

  function chartFor(e) {
    const from = e.anomaly.measurements.windowStart - 90 * 60_000;
    const bars = store.candles(e.ticker).filter((b) => b.ts >= from);
    const step = Math.max(1, Math.ceil(bars.length / 360));
    const pts = bars.filter((_, i) => i % step === 0 || i === bars.length - 1).map((b) => ({ ts: b.ts, c: b.close, v: b.volume }));
    const markers = [{ ts: e.detectedAt, label: 'Detected', kind: 'detect' }];
    if (e.resolution && e.resolution.outcome !== 'UNRESOLVED') markers.push({ ts: e.resolution.resolvedAt, label: e.resolution.outcome, kind: 'resolve' });
    for (const p of e.predictions.filter((x) => x.status === 'OK')) markers.push({ ts: p.at, label: `Prediction #${p.seq}`, kind: 'predict' });
    if (e.nextOpenAt && e.nextOpenAt <= (bars.at(-1)?.ts ?? 0)) markers.push({ ts: e.nextOpenAt, label: 'US open', kind: 'session' });
    if (e.outcome) markers.push({ ts: e.horizonAt, label: 'Horizon (US close)', kind: 'outcome' });
    return { points: pts, markers, priceBefore: e.anomaly.measurements.priceBefore };
  }

  return api;
}

export const fmtPct = (x) => `${x >= 0 ? '+' : ''}${Number(x).toFixed(2)}%`;
export function fmtDur(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}
