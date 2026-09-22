// Deterministic SIMULATED scenario: an NVDAx Ghost Event on a Sunday
// evening while U.S. markets are closed, a company announcement before the
// Monday open, and the regular-session reaction.
//
// All prices, volumes, headlines and discussion signals below are synthetic
// scenario content. None of it is real market data or real news.

import { createRng } from '../util/rng.js';
import { median } from '../util/stats.js';

export const SCENARIO = {
  name: 'NVDAx weekend Ghost Event (simulated)',
  focus: 'NVDAx',
  // Sunday 2026-09-20 17:00 ET — U.S. market closed (weekend).
  t0: Date.parse('2026-09-20T21:00:00Z'),
  historyMinutes: 180,
  triggerAfterMinutes: 10,
  anomaly: { retPct: 2.34, volumeRatio: 7.4 },
  announcementAt: Date.parse('2026-09-21T11:02:00Z'), // Mon 07:02 ET
  endAt: Date.parse('2026-09-21T20:10:00Z'), // Mon 16:10 ET
  closeTargetFromAnnouncementPct: 3.3,
};

const START = {
  NVDAx: { px: 176.4, vol: 0.00032, volume: 1400 },
  AMDx: { px: 158.2, vol: 0.00036, volume: 900 },
  AVGOx: { px: 342.1, vol: 0.00034, volume: 500 },
  TSMx: { px: 247.9, vol: 0.0003, volume: 700 },
  TSLAx: { px: 412.5, vol: 0.00045, volume: 1600 },
  COINx: { px: 318.3, vol: 0.0005, volume: 800 },
  BTC: { px: 64210, vol: 0.00028, volume: 35 },
};

const MIN = 60_000;

// Log-price path from a to b in n steps with Brownian-bridge noise.
function bridge(rng, a, b, n, sigma) {
  const w = [0];
  for (let i = 1; i <= n; i++) w.push(w[i - 1] + rng.normal() * sigma);
  return Array.from({ length: n }, (_, i) => a + ((b - a) * (i + 1)) / n + (w[i + 1] - ((i + 1) / n) * w[n]));
}

function toBars(rng, t, logs, prevClose, volumes, sigma) {
  const bars = [];
  let prev = prevClose;
  logs.forEach((lp, i) => {
    const close = Math.exp(lp);
    const open = prev;
    const wick = Math.abs(rng.normal()) * sigma * close * 0.6;
    bars.push({
      ts: t + i * MIN,
      open: +open.toFixed(4),
      high: +(Math.max(open, close) + wick).toFixed(4),
      low: +(Math.min(open, close) - wick).toFixed(4),
      close: +close.toFixed(4),
      volume: +volumes[i].toFixed(3),
    });
    prev = close;
  });
  return bars;
}

// Build the full minute-by-minute tape for every ticker.
export function buildTape(seed = 184) {
  const rng = createRng(seed);
  const S = SCENARIO;
  const histStart = S.t0 - S.historyMinutes * MIN;
  const trigStart = S.t0 + S.triggerAfterMinutes * MIN; // first anomalous bar
  const nPre = (trigStart - histStart) / MIN;
  const annIdx = (S.announcementAt - histStart) / MIN;
  const nTotal = (S.endAt - histStart) / MIN;
  const tape = {};

  for (const [ticker, cfg] of Object.entries(START)) {
    const noiseVol = (k) => cfg.volume * Math.exp(rng.normal() * 0.35) * k;
    // Segment plan in log-return space relative to the start price.
    const L0 = Math.log(cfg.px);
    let logs = [];
    let vols = [];
    // 1) quiet pre-event tape
    const pre = [L0];
    for (let i = 1; i < nPre; i++) pre.push(pre[i - 1] + rng.normal() * cfg.vol);
    logs.push(...pre);
    vols.push(...pre.map(() => noiseVol(1)));
    const anchor = pre[pre.length - 1];

    // 2) the 5-minute event window
    const eventMove = { NVDAx: S.anomaly.retPct, AMDx: 0.38, AVGOx: 0.27, TSMx: 0.21, BTC: 0.18, TSLAx: -0.05, COINx: 0.06 }[ticker];
    const winTarget = anchor + Math.log(1 + eventMove / 100);
    const win = ticker === 'NVDAx' ? [0.16, 0.41, 0.66, 0.87, 1].map((f) => anchor + f * (winTarget - anchor)) : bridge(rng, anchor, winTarget, 5, cfg.vol);
    logs.push(...win);
    if (ticker === 'NVDAx') {
      const base = median(vols.slice(-120));
      vols.push(...[0.8, 1.1, 1.25, 0.95, 0.9].map((f) => base * S.anomaly.volumeRatio * f));
    } else vols.push(...win.map(() => noiseVol(ticker === 'AMDx' ? 1.6 : 1.2)));

    // 3) overnight until the announcement: the move holds (NVDAx), peers drift
    const nOvernight = annIdx - logs.length;
    const holdTarget = { NVDAx: 2.45, AMDx: 0.5, AVGOx: 0.35, TSMx: 0.3, BTC: -0.2, TSLAx: 0.1, COINx: -0.3 }[ticker];
    logs.push(...bridge(rng, winTarget, L0 + Math.log(1 + holdTarget / 100), nOvernight, cfg.vol * 0.9));
    vols.push(...Array.from({ length: nOvernight }, (_, i) => noiseVol(ticker === 'NVDAx' ? 1.1 + 1.2 * Math.exp(-i / 90) : 1)));

    // 4) announcement → regular session close
    const nAfter = nTotal - logs.length;
    const annLevel = logs[logs.length - 1];
    const closeIdx = (Date.parse('2026-09-21T20:00:00Z') - histStart) / MIN - logs.length;
    const post = { NVDAx: S.closeTargetFromAnnouncementPct + 0.15, AMDx: 1.1, AVGOx: 0.8, TSMx: 0.7, BTC: 0.2, TSLAx: -0.4, COINx: 0.3 }[ticker];
    const toClose = bridge(rng, annLevel, annLevel + Math.log(1 + post / 100), closeIdx, cfg.vol * 1.3);
    const tail = bridge(rng, toClose[toClose.length - 1], toClose[toClose.length - 1], nAfter - closeIdx, cfg.vol * 0.6);
    logs.push(...toClose, ...tail);
    vols.push(...Array.from({ length: nAfter }, (_, i) => noiseVol(ticker === 'NVDAx' && i < 30 ? 3.5 : i >= 148 && i < 538 ? 2.2 : 1)));

    tape[ticker] = toBars(rng, histStart, logs, Math.exp(L0), vols, cfg.vol);
  }

  // Quotes: stable ~3 bps spreads throughout (the book stays intact).
  const quotes = {};
  for (const [ticker, bars] of Object.entries(tape)) {
    quotes[ticker] = bars.map((b) => {
      const bps = 3 + Math.abs(rng.normal()) * 0.4;
      const half = (b.close * bps) / 2e4;
      return { ts: b.ts, bid: +(b.close - half).toFixed(4), ask: +(b.close + half).toFixed(4) };
    });
  }
  return { tape, quotes, histStart, trigStart };
}

// Scripted information sources (SIMULATED).
export function scenarioSources(createScriptedSource) {
  const S = SCENARIO;
  return [
    createScriptedSource({
      id: 'sim-news',
      name: 'News wire (simulated feed)',
      category: 'news',
      items: [
        {
          ticker: 'NVDAx',
          key: 'sim-news:nvda-agreement',
          kind: 'NEWS_ARTICLE',
          availableAt: S.announcementAt,
          title: '[SIMULATED] NVIDIA announces multi-year AI infrastructure supply agreement',
          detail: 'Scenario press release · official company communication · not real news',
          data: { scope: 'company', official: true, direction: 'POSITIVE', domain: 'scenario.pred.local' },
        },
      ],
    }),
    createScriptedSource({ id: 'sim-filings', name: 'SEC filings (simulated feed)', category: 'filings', items: [] }),
    createScriptedSource({
      id: 'sim-social',
      name: 'Social / web signals (simulated feed)',
      category: 'social',
      items: [
        {
          ticker: 'NVDAx',
          key: 'sim-social:1',
          kind: 'SOCIAL_SIGNAL',
          availableAt: S.t0 + 13 * MIN,
          title: 'Emerging discussion: NVIDIA supply-agreement chatter',
          detail: 'Mention velocity 3.8× 7-day baseline (scenario data)',
          data: { velocity: 3.8, mentions: 412 },
        },
        {
          ticker: 'NVDAx',
          key: 'sim-social:2',
          kind: 'SOCIAL_SIGNAL',
          availableAt: Date.parse('2026-09-21T09:30:00Z'),
          title: 'Discussion accelerating overnight',
          detail: 'Mention velocity 6.2× baseline (scenario data)',
          data: { velocity: 6.2, mentions: 1180 },
        },
      ],
    }),
    createScriptedSource({ id: 'sim-calendar', name: 'Scheduled events (simulated)', category: 'calendar', items: [] }),
  ];
}
