// Demo runner: drives a full Ghost Event lifecycle on a deterministic
// SIMULATED tape with a virtual clock. The agents are the real ones — the
// Detector genuinely detects, the Verifier genuinely discovers scripted
// items as the clock passes them — the runner only controls time and lets
// the presenter step through lifecycle gates.

import { createEngine } from '../core/engine.js';
import { createMemory } from '../agents/memory.js';
import { createScriptedSource } from '../sources/scripted.js';
import { ASSETS, CRYPTO_REFS } from '../market/universe.js';
import { SCENARIO, buildTape, scenarioSources } from './scenario.js';
import { generateSeed } from './seed.js';

const MIN = 60_000;
const MONITORED = ['NVDAx', 'AMDx', 'AVGOx', 'TSMx', 'TSLAx', 'COINx'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const STEPS = [
  { id: 'select', title: 'Select NVDAx', focus: 'assets', narration: 'PRED is pointed at NVDAx, a tokenized NVIDIA share that trades 24/7, plus its semiconductor peers and BTC for cross-asset context.' },
  { id: 'monitor', title: 'Start monitoring', focus: 'feed', narration: 'It is Sunday 17:00 ET, so U.S. markets are closed. The Detector loads 3 hours of history and watches each new 1-minute bar.' },
  { id: 'trigger', title: 'Trigger abnormal movement', focus: 'hero', narration: 'In five minutes NVDAx rises 2.34% on 7.4× normal volume, while peers barely move. The Detector opens a Ghost Event.' },
  { id: 'ghost', title: 'Ghost Event', focus: 'hero', narration: 'This is a Ghost Event: an abnormal move with the U.S. market closed and no public catalyst yet identified.' },
  { id: 'investigate', title: 'Investigate', focus: 'timeline', narration: 'The Investigator checks market structure, peers, sector, crypto, news, filings, social, the calendar and PRED Memory. Every source reports a status, including the ones that found nothing.' },
  { id: 'graph', title: 'Evidence graph', focus: 'graph', narration: 'The Catalyst Graph traces the path from the asset, through the anomalies and correlations, to the information signals.' },
  { id: 'hypothesize', title: 'Generate hypotheses', focus: 'hypotheses', narration: 'The Hypothesis Agent scores competing explanations. Every edge in the graph is a weighted piece of evidence for or against a catalyst.' },
  { id: 'confidence', title: 'Confidence', focus: 'hypotheses', narration: 'The probabilities are model confidence estimates, capped short of certainty. PRED now waits for confirmation.' },
  { id: 'fastforward', title: 'Fast-forward overnight', focus: 'timeline', narration: 'Time jumps forward to Monday pre-market. The Verifier checks whether the move held and rescans the sources. Each change is logged as a new revision; earlier reasoning is never overwritten.' },
  { id: 'reveal', title: 'Reveal confirming information', focus: 'timeline', narration: 'At 07:02 ET a simulated official NVIDIA release appears on the news feed. The Verifier promotes it to authoritative evidence.' },
  { id: 'confirm', title: 'Catalyst confirmed', focus: 'hero', narration: 'The release matches the leading hypothesis, so the catalyst is CONFIRMED. PRED shows the original hypothesis, the confirming evidence, and the time from detection to confirmation.' },
  { id: 'reaction', title: 'Reaction prediction', focus: 'reaction', narration: 'The Reaction Agent estimates the move into the first regular-session close, based on comparable events in memory.' },
  { id: 'outcome', title: 'Reveal actual reaction', focus: 'reaction', narration: 'Time runs through the Monday session. At the 16:00 ET close the actual reaction is measured against the prediction.' },
  { id: 'memory', title: 'Update PRED Memory', focus: 'memory', narration: 'The event is stored in PRED Memory with its hypotheses, evidence, resolution, prediction and outcome. Later events use it as a comparable.' },
  { id: 'accuracy', title: 'Show accuracy', focus: 'memory', narration: 'Self-evaluation: direction, catalyst, range, time to confirmation, false-positive rate, failure attribution and calibration over time. Seed events are a simulated backtest.' },
];

export function createDemo({ stageDelayMs = 700, tickDelayMs = 120 } = {}) {
  let state;

  function build() {
    const clock = { t: SCENARIO.t0 - SCENARIO.historyMinutes * MIN, now() { return this.t; } };
    const memory = createMemory({ records: generateSeed() });
    const gates = new Map(); // stage -> { waiting: [resolve], released: bool }
    for (const g of ['investigate', 'hypothesize', 'await', 'resolve']) gates.set(g, { waiting: [], released: false });
    const gate = (stage) => {
      const g = gates.get(stage);
      if (!g || g.released) return Promise.resolve();
      return new Promise((r) => g.waiting.push(r));
    };
    const engine = createEngine({
      mode: 'demo',
      clock,
      universe: ASSETS,
      monitored: MONITORED,
      cryptoRefs: { BTC: CRYPTO_REFS.BTC },
      sources: scenarioSources(createScriptedSource),
      memory,
      feedName: 'Simulated tape (Bitget-format bars)',
      feedProvenance: 'SIMULATED',
      stageDelayMs,
      rescanIntervalMs: 10 * MIN,
      gate,
    });
    const { tape, quotes, histStart, trigStart } = buildTape();
    engine.setFeedStatus({ status: 'simulated', symbols: Object.fromEntries(MONITORED.map((t) => [t, `${t.toUpperCase()}USDT (sim)`])), note: 'Deterministic simulated tape — not live Bitget data' });
    state = { clock, memory, engine, gates, tape, quotes, histStart, trigStart, cursor: histStart, step: -1, busy: false, autoplay: false, memoryBefore: null, focus: 'assets' };
  }

  function release(stage) {
    const g = state.gates.get(stage);
    g.released = true;
    for (const r of g.waiting.splice(0)) r();
  }

  // Push bars up to (and including) ts, in batches of `batchMin` minutes.
  async function advanceTo(ts, { batchMin = 1, delay = tickDelayMs, rescan = false } = {}) {
    const { engine, tape, quotes, clock } = state;
    while (state.cursor <= ts) {
      const until = Math.min(ts, state.cursor + (batchMin - 1) * MIN);
      for (const [ticker, bars] of Object.entries(tape)) {
        for (const b of bars) if (b.ts >= state.cursor && b.ts <= until) engine.ingestCandle(ticker, b);
        for (const q of quotes[ticker]) if (q.ts >= state.cursor && q.ts <= until) engine.ingestQuote(ticker, q);
      }
      state.cursor = until + MIN;
      clock.t = until + MIN; // bar closes one minute after its open timestamp
      engine.afterBatch({ rescan });
      if (delay) await sleep(delay);
    }
  }

  async function settled() {
    // Wait for the pipeline to finish or park at a gate.
    for (let i = 0; i < 100; i++) {
      await sleep(30);
      const parked = [...state.gates.values()].some((g) => g.waiting.length);
      if (parked) {
        await sleep(stageDelayMs + 50);
        return;
      }
      const p = state.engine.idle();
      const done = await Promise.race([p.then(() => true), sleep(200).then(() => false)]);
      if (done) return;
    }
  }

  const actions = {
    async select() {},
    async monitor() {
      await advanceTo(SCENARIO.t0 - MIN, { batchMin: SCENARIO.historyMinutes, delay: 0 });
      state.engine.log('Monitoring started — 6 tokenized equities + BTC (simulated tape)', 'info');
      await advanceTo(state.trigStart - MIN, { batchMin: 1, delay: 220 });
    },
    async trigger() {
      await advanceTo(state.trigStart + 4 * MIN, { batchMin: 5, delay: 0 });
    },
    async ghost() {},
    async investigate() {
      release('investigate');
    },
    async graph() {},
    async hypothesize() {
      release('hypothesize');
    },
    async confidence() {
      release('await');
    },
    async fastforward() {
      await advanceTo(SCENARIO.announcementAt - 3 * MIN, { batchMin: 60, delay: 160, rescan: true });
    },
    async reveal() {
      await advanceTo(SCENARIO.announcementAt + 2 * MIN, { batchMin: 5, delay: 0, rescan: true });
    },
    async confirm() {
      release('resolve');
    },
    async reaction() {},
    async outcome() {
      state.memoryBefore = state.memory.stats();
      await advanceTo(SCENARIO.endAt, { batchMin: 30, delay: 140 });
    },
    async memory() {},
    async accuracy() {},
  };

  const api = {
    get engine() {
      return state.engine;
    },
    reset() {
      state && (state.autoplay = false);
      build();
      state.engine.log('Demo mode ready — deterministic SIMULATED scenario. Press Next or Auto-play.', 'info');
      return api.status();
    },
    async next() {
      if (state.busy || state.step >= STEPS.length - 1) return api.status();
      state.busy = true;
      try {
        state.step += 1;
        const s = STEPS[state.step];
        state.focus = s.focus;
        state.engine.log(`Demo step ${state.step + 1}/${STEPS.length}: ${s.title}`, 'demo');
        await actions[s.id]();
        await settled();
      } finally {
        state.busy = false;
      }
      return api.status();
    },
    async autoplay(on = true, pauseMs = 2600) {
      state.autoplay = on;
      while (state.autoplay && state.step < STEPS.length - 1) {
        await api.next();
        if (state.autoplay) await sleep(pauseMs);
      }
      state.autoplay = false;
      return api.status();
    },
    status() {
      return {
        scenario: SCENARIO.name,
        step: state.step,
        total: STEPS.length,
        steps: STEPS.map((s, i) => ({ ...s, done: i < state.step, active: i === state.step })),
        current: state.step >= 0 ? STEPS[state.step] : null,
        focus: state.focus,
        busy: state.busy,
        autoplay: state.autoplay,
        memoryBefore: state.memoryBefore ? { total: state.memoryBefore.total, direction: state.memoryBefore.accuracy.direction, catalyst: state.memoryBefore.accuracy.catalyst, reactionRange: state.memoryBefore.accuracy.reactionRange } : null,
      };
    },
  };
  api.reset();
  return api;
}
