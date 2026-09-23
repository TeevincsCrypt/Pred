import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPredServer } from '../src/server.js';
import { createLiveRuntime } from '../src/live/runtime.js';
import { measure, crossAsset } from '../src/agents/detector.js';
import { config as baseConfig } from '../src/config.js';
import { createBitgetMock } from './fixtures/bitget-mock.js';

process.env.PRED_LOG_LEVEL = 'silent';
const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pred-')), 'pred.sqlite');
const cfg = (dbPath) => ({ ...baseConfig, mode: 'live', demoEnabled: false, live: true, dbPath, assets: null, categories: ['SPOT'], pollIntervalMs: 60_000, detectorIntervalMs: 60_000, assetRefreshMs: 600_000, candleBatch: 50, sourceProbeMs: 600_000 });
const noSec = () => {
  const ua = process.env.SEC_USER_AGENT;
  delete process.env.SEC_USER_AGENT;
  return () => (ua ? (process.env.SEC_USER_AGENT = ua) : null);
};

test('live server: real-shaped discovery, market state, honest status, SSE, no synthetic data', async () => {
  const restore = noSec();
  const { fetchImpl } = createBitgetMock();
  const app = await createPredServer({ config: cfg(tmpDb()), fetchImpl });
  restore();
  await app.live.start();
  const port = await app.listen(0);
  const get = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`)).json();
  try {
    const assets = await get('/api/assets');
    assert.deepEqual(assets.assets.map((a) => a.symbol).sort(), ['AAPLXUSDT', 'NVDAONUSDT', 'NVDAUSDT', 'NVDAXUSDT', 'XAUTUSDT']);
    assert.equal(assets.assets.find((a) => a.symbol === 'NVDAUSDT').category, 'USDT-FUTURES');
    assert.equal(assets.assets.find((a) => a.symbol === 'NVDAUSDT').monitored, false);
    const nvdax = assets.assets.find((a) => a.symbol === 'NVDAXUSDT');
    for (const k of ['symbol', 'baseAsset', 'quoteAsset', 'status', 'availableMarketData', 'lastPrice', 'volume24h']) assert.ok(k in nvdax, k);
    assert.equal(nvdax.lastPrice, 180);
    assert.equal(nvdax.availableMarketData.candles, true);

    const mkt = await get('/api/market/NVDAXUSDT');
    assert.equal(mkt.state.symbol, 'NVDAXUSDT');
    assert.ok(mkt.candles.length > 100);
    assert.ok(mkt.candles.at(-1).ts < Math.floor(Date.now() / 60000) * 60000, 'only closed candles are stored');
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/market/FAKEUSDT`)).status, 404);

    const st = await get('/api/status');
    assert.equal(st.mode, 'live');
    assert.equal(st.connections.bitget.status, 'CONNECTED');
    assert.equal(st.connections.sec.status, 'NOT CONFIGURED', 'missing SEC_USER_AGENT is reported, not hidden');
    assert.equal(st.tradingEnabled, false);
    assert.ok(['OPEN', 'CLOSED'].includes(st.traditionalMarket.status));

    const events = await get('/api/events');
    assert.equal(events.count, 0);
    assert.equal(events.message, 'No active Ghost Events detected.');

    const mem = await get('/api/memory');
    assert.equal(mem.label, 'LIVE MEMORY');
    assert.equal(mem.total, 0);
    assert.equal(mem.provenance.SIMULATED, 0);
    assert.equal(mem.accuracy.direction.rate, null, 'no accuracy without real history');

    assert.equal((await fetch(`http://127.0.0.1:${port}/api/demo/state`)).status, 404, 'demo is off in live production');
    const page = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`)).text();
    assert.match(await page('/'), /Find what the market knows/, '/ is the landing page');
    assert.match(await page('/app'), /id="connList"/, '/app is the live dashboard');
    assert.match(await page('/about'), /Find what the market knows/);

    const res = await fetch(`http://127.0.0.1:${port}/api/stream`);
    const reader = res.body.getReader();
    const { value } = await reader.read();
    reader.cancel();
    const frame = JSON.parse(new TextDecoder().decode(value).replace(/^data: /, ''));
    assert.equal(frame.mode, 'live');
    assert.ok(frame.markets.length >= 2);
    assert.ok(!JSON.stringify(frame).includes('"provenance":"SIMULATED"'), 'no simulated provenance in the live stream');
    assert.equal(frame.memory.provenance.SIMULATED, 0);
  } finally {
    await app.close();
  }
});

test('Bitget outage is shown as DISCONNECTED and nothing is simulated', async () => {
  const { fetchImpl } = createBitgetMock({ failBitget: true });
  const app = await createPredServer({ config: cfg(tmpDb()), fetchImpl });
  await app.live.market.refreshAssets();
  const st = app.live.status();
  assert.equal(st.connections.bitget.status, 'DISCONNECTED');
  assert.equal(st.assetsDiscovered, 0);
  assert.equal(app.live.marketsView().length, 0);
  await app.close();
});

test('events, hypotheses and the audit trail persist across a restart', async () => {
  const dbPath = tmpDb();
  const restore = noSec();
  const { fetchImpl } = createBitgetMock({ spikeSymbol: 'NVDAXUSDT', spikePct: 2.5 });
  const a = createLiveRuntime({ config: cfg(dbPath), fetchImpl });
  await a.market.refreshAssets();
  await a.market.pollTickers();
  for (let i = 0; i < 3; i++) await a.market.pollCandles();
  const store = a.engine.store;
  const m = measure(store.candles('NVDAx'));
  assert.ok(m && m.retPct > 2, 'spike measured from real-shaped candles');
  const cross = crossAsset(store, m, ['NVDAon', 'AAPLx'], { BTC: 'BTCUSDT' }, ['AAPLx']);
  a.engine.openEvent({ ticker: 'NVDAx', detectedAt: Date.now(), marketSession: 'WEEKEND', priority: 'ELEVATED', measurements: { ...m, spread: null, score: 10, severity: 'HIGH' }, cross: { peers: cross.withCorr([]), crypto: cross.crypto, marketWide: cross.marketWide, avgPeerRetPct: cross.avgPeerRetPct, residualPct: cross.residualPct } });
  await a.engine.idle();
  const ev = [...a.engine.events.values()][0];
  assert.equal(ev.state, 'AWAITING_CONFIRMATION');
  assert.ok(ev.revisions[0].modelVersion);
  assert.ok(ev.evidence.every((e) => e.provenance !== 'SIMULATED'));
  const log = a.db.eventLog(ev.id);
  assert.ok(log.some((l) => l.kind === 'HYPOTHESIS_REVISION'));
  assert.ok(log.some((l) => l.kind === 'STATE' && l.state === 'DETECTED'));
  a.stop();
  a.db.close();

  const b = createLiveRuntime({ config: cfg(dbPath), fetchImpl });
  restore();
  assert.equal(b.restoredEvents, 1);
  const again = b.engine.eventDetail(ev.id);
  assert.equal(again.state, 'AWAITING_CONFIRMATION');
  assert.equal(again.revisions.length, ev.revisions.length);
  assert.equal(again.timeline.length, ev.timeline.length);
  assert.equal(b.memory.stats().total, 1);
  assert.ok(again.verifyDeadlineAt > again.nextOpenAt, 'verification closes after the next US open');

  // Past the open deadline with no official catalyst → UNRESOLVED (not stuck awaiting).
  const live = b.engine.events.get(ev.id);
  live.nextOpenAt = Date.now() - 31 * 60_000;
  b.engine.afterBatch();
  assert.equal(live.state, 'UNRESOLVED');
  assert.equal(live.resolution.basis, 'open-deadline');
  assert.ok(!live.outcome, 'the reaction is still measured at the US close');
  assert.ok(b.db.eventLog(ev.id).some((l) => l.kind === 'RESOLUTION'));
  b.stop();
  b.db.close();
});

test('live runtime never imports demo code', () => {
  const src = fs.readFileSync(new URL('../src/live/runtime.js', import.meta.url), 'utf8') + fs.readFileSync(new URL('../src/market/market-engine.js', import.meta.url), 'utf8');
  const code = src.replace(/\/\/.*$/gm, '');
  assert.ok(!/demo\//.test(code));
  assert.ok(!/seed|scenario/i.test(src.replace(/\/\/.*$/gm, '')));
});

test('open deadline: a move that faded before the open with no news is INVALIDATED as liquidity', async () => {
  const restore = noSec();
  const { fetchImpl } = createBitgetMock({ spikeSymbol: 'NVDAXUSDT', spikePct: 2.5 });
  const a = createLiveRuntime({ config: cfg(tmpDb()), fetchImpl });
  restore();
  await a.market.refreshAssets();
  await a.market.pollTickers();
  for (let i = 0; i < 3; i++) await a.market.pollCandles();
  const store = a.engine.store;
  const m = measure(store.candles('NVDAx'));
  const cross = crossAsset(store, m, ['NVDAon'], { BTC: 'BTCUSDT' }, []);
  a.engine.openEvent({ ticker: 'NVDAx', detectedAt: Date.now(), marketSession: 'WEEKEND', priority: 'ELEVATED', measurements: { ...m, spread: null, score: 10, severity: 'HIGH' }, cross: { peers: cross.withCorr([]), crypto: cross.crypto, marketWide: cross.marketWide, avgPeerRetPct: cross.avgPeerRetPct, residualPct: cross.residualPct } });
  await a.engine.idle();
  const ev = [...a.engine.events.values()][0];
  assert.equal(ev.state, 'AWAITING_CONFIRMATION');
  // "The open" 31 min ago: the spike is in the last 5 minutes, so the price then is pre-move.
  ev.nextOpenAt = Date.now() - 31 * 60_000;
  a.engine.afterBatch();
  assert.equal(ev.state, 'INVALIDATED');
  assert.equal(ev.resolution.basis, 'faded-by-open');
  assert.equal(ev.resolution.actualCategory, 'LIQUIDITY');
  assert.equal(ev.resolution.moveHeld, false);
  assert.ok(ev.resolution.moveRetained <= 0.2);
  assert.ok(ev.timeline.some((t) => /HYPOTHESIS INVALIDATED|LIQUIDITY CONFIRMED/.test(t.text || t.message || JSON.stringify(t))));
  a.stop();
  a.db.close();
});
