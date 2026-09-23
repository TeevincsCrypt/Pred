import test from 'node:test';
import assert from 'node:assert/strict';
import { SeriesStore } from '../src/market/series.js';
import { createDetector, measure } from '../src/agents/detector.js';
import { createRng } from '../src/util/rng.js';
import { marketStatus } from '../src/market/hours.js';

const T0 = Date.parse('2026-09-20T18:00:00Z'); // Sunday
function tape(rng, n, { spike = null } = {}) {
  const bars = [];
  let px = 100;
  for (let i = 0; i < n; i++) {
    const inSpike = spike && i >= n - 5;
    const r = inSpike ? spike / 5 / 100 : rng.normal() * 0.0003;
    const close = px * (1 + r);
    bars.push({ ts: T0 + i * 60000, open: px, high: Math.max(px, close) * 1.0001, low: Math.min(px, close) * 0.9999, close, volume: (inSpike ? 8 : 1) * 1000 * Math.exp(rng.normal() * 0.3) });
    px = close;
  }
  return bars;
}
const load = (bars, ticker = 'NVDAx') => {
  const s = new SeriesStore();
  for (const b of bars) s.addCandle(ticker, b);
  return s;
};

test('noise alone never opens a Ghost Event', () => {
  const rng = createRng(1);
  const det = createDetector();
  const bars = tape(rng, 2000);
  const store = new SeriesStore();
  let fired = 0;
  for (const b of bars) {
    store.addCandle('NVDAx', b);
    if (det.evaluate({ ticker: 'NVDAx', store, now: b.ts + 60000, market: marketStatus(b.ts) })) fired++;
  }
  assert.equal(fired, 0);
});

test('price + volume spike while closed opens a Ghost Event with measurements', () => {
  const store = load(tape(createRng(2), 200, { spike: 2.3 }));
  const a = createDetector().evaluate({ ticker: 'NVDAx', store, now: T0 + 200 * 60000, market: marketStatus(T0) });
  assert.ok(a);
  assert.ok(a.measurements.retPct > 2 && a.measurements.retPct < 2.6);
  assert.ok(a.measurements.volumeRatio > 5);
  assert.ok(Math.abs(a.measurements.priceZ) > 10);
  assert.equal(a.marketSession, 'WEEKEND');
});

test('illiquid baseline (mostly zero-volume minutes) never opens a Ghost Event and never reports absurd volume', () => {
  const bars = tape(createRng(5), 200, { spike: 1 });
  // 70% of baseline minutes with no trades, like a thin pre-market perp.
  bars.forEach((b, i) => {
    if (i < 195 && i % 10 < 7) b.volume = 0;
  });
  const store = load(bars);
  const a = createDetector().evaluate({ ticker: 'NVDAx', store, now: T0 + 200 * 60000, market: marketStatus(T0) });
  assert.ok(a?.suppressed, 'suppressed, not opened');
  assert.match(a.reason, /illiquid baseline/);
  assert.ok(a.measurements.volumeRatio <= 50, `volume ratio capped (got ${a.measurements.volumeRatio})`);
});

test('same spike during the regular session is not a Ghost Event', () => {
  const store = load(tape(createRng(2), 200, { spike: 2.3 }));
  const open = marketStatus(Date.parse('2026-09-21T15:00:00Z'));
  const r = createDetector().evaluate({ ticker: 'NVDAx', store, now: 1, market: open });
  assert.equal(r.suppressed, true);
  assert.match(r.reason, /regular session open/);
});

test('abnormal move while the tokenized market is not live is suppressed, not a Ghost Event', () => {
  const store = load(tape(createRng(2), 200, { spike: 2.3 }));
  const closed = marketStatus(T0);
  const r = createDetector().evaluate({ ticker: 'NVDAx', store, now: T0 + 200 * 60000, market: closed, tradability: { status: 'UNKNOWN', reason: 'stale candles' } });
  assert.equal(r.suppressed, true);
  assert.match(r.reason, /tokenized market UNKNOWN/);
  const thin = createDetector().evaluate({ ticker: 'NVDAx', store, now: T0 + 200 * 60000, market: closed, tradability: { status: 'LIVE', thin: true, reason: 'low turnover' } });
  assert.equal(thin.suppressed, true);
});

test('Ghost Event carries elevated priority and all three conditions', () => {
  const store = load(tape(createRng(2), 200, { spike: 2.3 }));
  const a = createDetector().evaluate({ ticker: 'NVDAx', store, now: T0 + 200 * 60000, market: marketStatus(T0), tradability: { status: 'LIVE' } });
  assert.equal(a.priority, 'ELEVATED');
  assert.deepEqual(a.conditions, { abnormalActivity: true, traditionalMarketClosed: true, tokenizedMarketLive: true });
});

test('a data gap is never read as a price move', () => {
  const bars = tape(createRng(4), 200);
  // Shift the last 5 bars 3 hours later and 3% higher: a restart gap, not a move.
  for (const b of bars.slice(-5)) {
    b.ts += 3 * 3600_000;
    b.close *= 1.03;
    b.open *= 1.03;
    b.high *= 1.03;
    b.low *= 1.03;
    b.volume *= 10;
  }
  assert.equal(measure(bars), null);
});

test('measure needs a baseline', () => {
  assert.equal(measure(tape(createRng(3), 20)), null);
});
