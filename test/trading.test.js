// Human-approved execution: unit + HTTP tests against a MOCKED Bitget client.
// No test here (or anywhere) talks to the real Bitget trading API.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDb } from '../src/store/db.js';
import { createTradeStore } from '../src/trading/store.js';
import { createTradingService, humanApproval } from '../src/trading/execution.js';
import { createOperatorAuth } from '../src/trading/auth.js';
import { signBitget, createBitgetPrivateClient } from '../src/trading/bitget-private.js';
import { buildPlan, mapOrderStatus } from '../src/trading/rules.js';

const CFG = { enabled: true, maxOrderNotional: 100, maxPositionNotional: 200, maxDailyNotional: 300, planNotional: 25, planTtlMs: 300_000, maxDriftBps: 50, slippageBps: 10, quoteMaxAgeMs: 15_000, autoPlanMinConfidence: 60, marginMode: 'isolated', statusPollMs: 10_000 };
const INST = { symbol: 'NVDAUSDT', category: 'USDT-FUTURES', baseCoin: 'NVDA', status: 'online', pricePrecision: 2, quantityPrecision: 2, priceMultiplier: 0.01, quantityMultiplier: 0.01, minOrderQty: 0.01, maxOrderQty: 10_000, minOrderAmount: 5 };
const ASSET = { key: 'NVDA-PERP', symbol: 'NVDAUSDT', category: 'USDT-FUTURES' };
const HUMAN = humanApproval({ sessionId: 'test-session', ip: '127.0.0.1' });

function makeEvent(over = {}) {
  return {
    id: 'live-1',
    code: 'GHOST EVENT #1',
    ticker: 'NVDA-PERP',
    asset: { company: 'NVIDIA' },
    anomaly: { measurements: { retPct: 4.8, priceBefore: 191, price: 200 } },
    revisions: [{ primary: { key: 'COMPANY_SPECIFIC', title: 'Company-specific catalyst', probability: 72, evidenceFor: [{ evidenceId: 'E1', reason: 'abnormal overnight volume', weight: 0.8 }] } }],
    predictions: [{ status: 'OK', at: 1, direction: 'POSITIVE', estimatePct: 2.1, rangeLowPct: -1.2, rangeHighPct: 4.0, confidence: 78, comparableCount: 12 }],
    resolution: null,
    outcome: null,
    ...over,
  };
}

function mockBitget({ ticker = { bid: 199.9, ask: 200.1, last: 200 }, inst = INST, usdt = '1000', accountMode = 'unified', placeImpl = null, orderStatus = 'live', cumExecQty = '0' } = {}) {
  const calls = { place: [], cancel: [], info: [] };
  const state = { ticker: { ...ticker }, inst: inst && { ...inst }, orderStatus, cumExecQty };
  const pub = {
    instruments: async (category, symbol) => (state.inst && state.inst.symbol === symbol ? [state.inst] : []),
    tickers: async () => [{ symbol: 'NVDAUSDT', ...state.ticker, ts: Date.now() }],
  };
  const read = {
    configured: true,
    health: { status: 'connected' },
    accountSettings: async () => ({ accountMode, holdMode: 'one_way_mode' }),
    accountAssets: async () => ({ assets: [{ coin: 'USDT', available: usdt, balance: usdt }] }),
    currentPosition: async () => [],
    orderInfo: async (q) => {
      calls.info.push(q);
      if (q.clientOid && !calls.place.length) return null;
      return { orderId: 'BG-1', qty: calls.place[0]?.qty ?? '0.12', cumExecQty: state.cumExecQty, avgPrice: '200.2', orderStatus: state.orderStatus };
    },
  };
  const priv = {
    ...read,
    readOnly: () => Object.freeze({ ...read }),
    placeOrder: async (order) => {
      calls.place.push(order);
      if (placeImpl) return placeImpl(order);
      await new Promise((r) => setTimeout(r, 5));
      return { orderId: 'BG-1', clientOid: order.clientOid };
    },
    cancelOrder: async (q) => {
      calls.cancel.push(q);
      state.orderStatus = 'cancelled';
      return { orderId: q.orderId };
    },
  };
  return { pub, priv, calls, state };
}

function setup({ cfg = {}, bitget = {}, event = makeEvent(), auth = true } = {}) {
  const db = openDb(':memory:');
  const store = createTradeStore(db.sqlite);
  const bg = mockBitget(bitget);
  const svc = createTradingService({ tradingConfig: { ...CFG, ...cfg }, store, publicClient: bg.pub, privateClient: bg.priv, authConfigured: () => auth, events: (id) => (id === event.id ? event : null), assets: (t) => (t === ASSET.key ? ASSET : null) });
  return { db, store, svc, bg, event };
}
async function planFor(t) {
  const r = await t.svc.requestPlan(t.event.id, HUMAN);
  assert.ok(r.ok, r.error);
  return r.plan;
}

test('trade plan is built from a real PRED event with live instrument precision', async () => {
  const t = setup();
  const plan = await planFor(t);
  assert.equal(plan.status, 'AWAITING_APPROVAL');
  assert.equal(plan.side, 'buy');
  assert.equal(plan.direction, 'LONG');
  assert.equal(plan.quantity, '0.12'); // 25 USDT / 200.1 floored to 0.01
  assert.ok(Number(plan.stopLoss) < Number(plan.estimatedPrice) && Number(plan.takeProfit) > Number(plan.estimatedPrice));
  assert.equal(plan.confirmationPhrase, 'BUY 0.12 NVDAUSDT');
  assert.equal(plan.confidence, 78);
  assert.ok(plan.thesis.includes('GHOST EVENT #1'));
  assert.equal(t.store.auditFor(plan.id)[0].kind, 'TRADE_PLAN_CREATED');
});

test('confidence never authorises: a strong auto plan still waits for a human', async () => {
  const t = setup();
  const r = await t.svc.maybeAutoPlan(t.event);
  assert.ok(r.ok);
  assert.equal(r.plan.status, 'AWAITING_APPROVAL');
  assert.equal(t.bg.calls.place.length, 0);
  assert.equal(await t.svc.maybeAutoPlan(t.event), null, 'one auto plan per prediction');
});

test('CRITICAL: executing without human approval fails', async () => {
  const t = setup();
  const plan = await planFor(t);
  for (const approval of [undefined, null, {}, { actor: 'human' }, { actor: 'human', sessionId: 'x' }]) {
    const r = await t.svc.approveAndExecute(plan.id, approval, { confirmation: plan.confirmationPhrase });
    assert.equal(r.ok, false);
    assert.equal(r.code, 403);
  }
  assert.equal(t.bg.calls.place.length, 0);
  assert.equal(t.svc.getPlan(plan.id).status, 'AWAITING_APPROVAL');
});

test('approval requires the exact confirmation phrase', async () => {
  const t = setup();
  const plan = await planFor(t);
  const r = await t.svc.approveAndExecute(plan.id, HUMAN, { confirmation: 'yes' });
  assert.equal(r.code, 400);
  assert.equal(t.bg.calls.place.length, 0);
});

test('trading disabled / missing credentials / missing limits / no login → rejected, no order', async () => {
  for (const [cfg, auth, creds, expect] of [
    [{ enabled: false }, true, true, /trading disabled/],
    [{}, true, false, /credentials/],
    [{ maxDailyNotional: null }, true, true, /PRED_MAX_DAILY_TRADING_NOTIONAL/],
    [{}, false, true, /approval login/],
  ]) {
    const t = setup({ cfg, auth });
    if (!creds) t.bg.priv.configured = false;
    const plan = await planFor(t);
    const r = await t.svc.approveAndExecute(plan.id, HUMAN, { confirmation: plan.confirmationPhrase });
    assert.equal(r.ok, false);
    assert.match(r.error, expect);
    assert.equal(t.bg.calls.place.length, 0);
    assert.equal(t.svc.status().executionEnabled, false);
  }
});

test('successful submission: SUBMITTED with the real exchange order id, never FILLED on acceptance', async () => {
  const t = setup();
  const plan = await planFor(t);
  const r = await t.svc.approveAndExecute(plan.id, HUMAN, { confirmation: plan.confirmationPhrase });
  assert.ok(r.ok, r.error);
  assert.equal(r.plan.status, 'SUBMITTED');
  assert.equal(r.plan.exchangeOrderId, 'BG-1');
  assert.ok(r.plan.executionId.startsWith('EX_'));
  const o = t.bg.calls.place[0];
  assert.deepEqual(
    { category: o.category, symbol: o.symbol, side: o.side, orderType: o.orderType, qty: o.qty, marginMode: o.marginMode, clientOid: o.clientOid },
    { category: 'USDT-FUTURES', symbol: 'NVDAUSDT', side: 'buy', orderType: 'limit', qty: '0.12', marginMode: 'isolated', clientOid: r.plan.executionId },
  );
  assert.equal(o.price, '200.31', 'marketable limit = ask + 10 bps, rounded up to the tick');
  assert.ok(o.takeProfit && o.stopLoss, 'futures orders carry TP/SL');
  const kinds = t.store.auditFor(plan.id).map((a) => a.kind);
  for (const k of ['TRADE_PLAN_CREATED', 'TRADE_APPROVED', 'ORDER_SUBMISSION_STARTED', 'ORDER_SUBMITTED']) assert.ok(kinds.includes(k), k);
  assert.equal(t.store.auditFor(plan.id).find((a) => a.kind === 'TRADE_APPROVED').actor, 'human');
});

test('CRITICAL: two concurrent approvals create exactly ONE exchange order', async () => {
  const t = setup();
  const plan = await planFor(t);
  const [a, b, c] = await Promise.all([1, 2, 3].map(() => t.svc.approveAndExecute(plan.id, HUMAN, { confirmation: plan.confirmationPhrase })));
  assert.equal(t.bg.calls.place.length, 1);
  assert.equal([a, b, c].filter((r) => r.idempotent).length, 2);
  const again = await t.svc.approveAndExecute(plan.id, HUMAN, { confirmation: plan.confirmationPhrase });
  assert.ok(again.idempotent);
  assert.equal(t.bg.calls.place.length, 1, 'a later double-click returns the existing execution');
});

test('expired plan cannot execute', async () => {
  const t = setup({ cfg: { planTtlMs: 1 } });
  const plan = await planFor(t);
  await new Promise((r) => setTimeout(r, 5));
  const r = await t.svc.approveAndExecute(plan.id, HUMAN, { confirmation: plan.confirmationPhrase });
  assert.equal(r.ok, false);
  assert.equal(t.svc.getPlan(plan.id).status, 'EXPIRED');
  assert.equal(t.bg.calls.place.length, 0);
});

test('stale plan: price moved beyond the drift limit → EXPIRED, not submitted', async () => {
  const t = setup();
  const plan = await planFor(t);
  t.bg.state.ticker = { bid: 205, ask: 205.2, last: 205 };
  const r = await t.svc.approveAndExecute(plan.id, HUMAN, { confirmation: plan.confirmationPhrase });
  assert.equal(r.ok, false);
  assert.ok(r.regenerate);
  assert.match(r.error, /price moved/);
  assert.equal(t.svc.getPlan(plan.id).status, 'EXPIRED');
  assert.equal(t.bg.calls.place.length, 0);
});

test('invalid instrument (delisted / not online) → REJECTED at revalidation', async () => {
  const t = setup();
  const plan = await planFor(t);
  t.bg.state.inst.status = 'limit_open';
  const r = await t.svc.approveAndExecute(plan.id, HUMAN, { confirmation: plan.confirmationPhrase });
  assert.equal(r.ok, false);
  assert.match(r.error, /not open for new orders/);
  assert.equal(t.svc.getPlan(plan.id).status, 'REJECTED');
  t.bg.state.inst = null;
  const t2 = setup();
  t2.bg.state.inst = null;
  assert.equal((await t2.svc.requestPlan('live-1', HUMAN)).ok, false);
  assert.equal(t.bg.calls.place.length + t2.bg.calls.place.length, 0);
});

test('invalid quantity: below minimum after a metadata change → REJECTED', async () => {
  const t = setup();
  const plan = await planFor(t);
  t.bg.state.inst.minOrderQty = 1;
  const r = await t.svc.approveAndExecute(plan.id, HUMAN, { confirmation: plan.confirmationPhrase });
  assert.match(r.error, /below Bitget's minimum/);
  assert.equal(t.bg.calls.place.length, 0);
});

test('insufficient balance → REJECTED', async () => {
  const t = setup({ bitget: { usdt: '3' } });
  const plan = await planFor(t);
  const r = await t.svc.approveAndExecute(plan.id, HUMAN, { confirmation: plan.confirmationPhrase });
  assert.match(r.error, /insufficient available USDT/);
  assert.equal(t.bg.calls.place.length, 0);
});

test('safety limits: order, daily and position notional', async () => {
  const t1 = setup({ cfg: { maxOrderNotional: 10, planNotional: 25 } });
  const p1 = await planFor(t1); // sized down to ≤ 10 USDT
  assert.ok(p1.notional <= 10);
  const t2 = setup({ cfg: { maxDailyNotional: 20 } });
  const p2 = await planFor(t2);
  assert.match((await t2.svc.approveAndExecute(p2.id, HUMAN, { confirmation: p2.confirmationPhrase })).error, /PRED_MAX_DAILY_TRADING_NOTIONAL/);
  const t3 = setup();
  t3.bg.priv.currentPosition = async () => [{ symbol: 'NVDAUSDT', total: '1', markPrice: '200' }];
  const p3 = await planFor(t3);
  assert.match((await t3.svc.approveAndExecute(p3.id, HUMAN, { confirmation: p3.confirmationPhrase })).error, /PRED_MAX_POSITION_NOTIONAL/);
  const t4 = setup({ cfg: { maxOrderNotional: 1 } });
  assert.match((await t4.svc.requestPlan('live-1', HUMAN)).error, /exceeds PRED_MAX_ORDER_NOTIONAL/);
  assert.equal(t2.bg.calls.place.length + t3.bg.calls.place.length, 0);
});

test('non-unified Bitget account → REJECTED with a clear reason', async () => {
  const t = setup({ bitget: { accountMode: 'classic' } });
  const plan = await planFor(t);
  assert.match((await t.svc.approveAndExecute(plan.id, HUMAN, { confirmation: plan.confirmationPhrase })).error, /cannot use the Unified Trading API/);
});

test('Bitget rejection → REJECTED with the exchange code; network failure → reconciled, never resubmitted', async () => {
  const t = setup({ bitget: { placeImpl: () => Promise.reject(Object.assign(new Error('Bitget /api/v3/trade/place-order: 40762 insufficient balance'), { code: '40762' })) } });
  const plan = await planFor(t);
  const r = await t.svc.approveAndExecute(plan.id, HUMAN, { confirmation: plan.confirmationPhrase });
  assert.equal(r.ok, false);
  assert.equal(t.svc.getPlan(plan.id).status, 'REJECTED');
  assert.equal(t.svc.getPlan(plan.id).exchangeErrorCode, '40762');

  // Timeout after sending: the order may exist → reconcile by clientOid.
  const t2 = setup({ bitget: { placeImpl: () => Promise.reject(Object.assign(new Error('no response'), { code: 'TIMEOUT', ambiguous: true })) } });
  const p2 = await planFor(t2);
  const r2 = await t2.svc.approveAndExecute(p2.id, HUMAN, { confirmation: p2.confirmationPhrase });
  assert.ok(r2.pending);
  assert.equal(t2.bg.calls.place.length, 1, 'never resubmitted');
  assert.equal(t2.svc.getPlan(p2.id).status, 'SUBMITTED', 'found at Bitget by clientOid');
  assert.equal(t2.svc.getPlan(p2.id).exchangeOrderId, 'BG-1');

  // Plain connection failure before Bitget answered anything useful → FAILED.
  const t3 = setup({ bitget: { placeImpl: () => Promise.reject(Object.assign(new Error('network error'), { code: 'NETWORK' })) } });
  const p3 = await planFor(t3);
  await t3.svc.approveAndExecute(p3.id, HUMAN, { confirmation: p3.confirmationPhrase });
  assert.equal(t3.svc.getPlan(p3.id).status, 'FAILED');
  assert.ok(t3.store.auditFor(p3.id).some((a) => a.kind === 'ORDER_FAILED'));
});

test('order status: partial fill, full fill and cancellation are tracked separately', async () => {
  const t = setup();
  const plan = await planFor(t);
  await t.svc.approveAndExecute(plan.id, HUMAN, { confirmation: plan.confirmationPhrase });
  assert.equal(t.svc.getPlan(plan.id).status, 'SUBMITTED');
  t.bg.state.orderStatus = 'partially_filled';
  t.bg.state.cumExecQty = '0.05';
  await t.svc.trackAll();
  assert.equal(t.svc.getPlan(plan.id).status, 'PARTIALLY_FILLED');
  t.bg.state.orderStatus = 'filled';
  t.bg.state.cumExecQty = '0.12';
  await t.svc.trackAll();
  const done = t.svc.getPlan(plan.id);
  assert.equal(done.status, 'FILLED');
  assert.ok(done.final);
  const kinds = t.store.auditFor(plan.id).map((a) => a.kind);
  assert.ok(kinds.includes('ORDER_PARTIALLY_FILLED') && kinds.includes('ORDER_FILLED'));

  const c = setup();
  const cp = await planFor(c);
  await c.svc.approveAndExecute(cp.id, HUMAN, { confirmation: cp.confirmationPhrase });
  assert.equal((await c.svc.cancelOrder(cp.id, undefined)).code, 403, 'cancel also needs a human');
  const r = await c.svc.cancelOrder(cp.id, HUMAN);
  assert.ok(r.ok);
  assert.equal(c.svc.getPlan(cp.id).status, 'CANCELLED');
  assert.deepEqual(c.bg.calls.cancel[0], { category: 'USDT-FUTURES', orderId: 'BG-1' });
  assert.deepEqual(mapOrderStatus({ orderStatus: 'cancelled', cumExecQty: '0.05', qty: '0.12' }), { status: 'PARTIALLY_FILLED', final: true });
  assert.deepEqual(mapOrderStatus({ orderStatus: 'live', cumExecQty: '0', qty: '0.12' }), { status: 'SUBMITTED', final: false });
});

test('spot shorts are refused; insufficient-history plans are labelled LOW CONFIDENCE and never auto-created', async () => {
  const ev = makeEvent({ predictions: [{ status: 'INSUFFICIENT_HISTORY' }] });
  const r = buildPlan({ event: { ...ev, anomaly: { measurements: { retPct: -3 } } }, asset: { symbol: 'NVDAXUSDT', category: 'SPOT' }, instrument: { ...INST, symbol: 'NVDAXUSDT', category: 'SPOT' }, ticker: { bid: 1, ask: 1.01 }, tradingConfig: CFG, source: 'HUMAN_REQUEST' });
  assert.equal(r.ok, false);
  const t = setup({ event: ev });
  assert.equal(await t.svc.maybeAutoPlan(ev), null);
  const plan = await planFor(t);
  assert.equal(plan.lowConfidence, true);
  assert.equal(plan.confidence, null);
});

test('Bitget request signing matches the documented scheme and secrets never leak', async () => {
  const sig = signBitget('secret', '1700000000000', 'POST', '/api/v3/trade/place-order', '{"a":1}');
  assert.equal(sig, crypto.createHmac('sha256', 'secret').update('1700000000000POST/api/v3/trade/place-order{"a":1}').digest('base64'));
  let seen;
  const client = createBitgetPrivateClient({
    credentials: { apiKey: 'KEY_abc', apiSecret: 'SECRET_xyz', passphrase: 'PASS_123' },
    baseUrl: 'https://bitget.test',
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return { status: 400, text: async () => '{"code":"40009","msg":"sign signature error"}' };
    },
  });
  await assert.rejects(client.accountAssets(), (err) => {
    assert.ok(!/SECRET_xyz|PASS_123|KEY_abc/.test(err.message));
    return true;
  });
  assert.equal(seen.init.headers['ACCESS-KEY'], 'KEY_abc');
  assert.equal(seen.init.headers['ACCESS-SIGN'], signBitget('SECRET_xyz', seen.init.headers['ACCESS-TIMESTAMP'], 'GET', '/api/v3/account/assets'));
  assert.ok(!JSON.stringify(client.health).includes('SECRET_xyz'));
  assert.ok(!JSON.stringify(Object.keys(client)).includes('secret'));
  // POST place-order is sent once, never retried.
  let n = 0;
  const once = createBitgetPrivateClient({ credentials: { apiKey: 'k', apiSecret: 's', passphrase: 'p' }, baseUrl: 'https://bitget.test', fetchImpl: async () => { n++; throw Object.assign(new Error('reset'), { name: 'TypeError' }); } });
  await assert.rejects(once.placeOrder({ symbol: 'X' }), (e) => e.ambiguous === true);
  assert.equal(n, 1);
});

test('isolation: no agent, engine, demo or market module can reach the execution layer', () => {
  const root = new URL('../src/', import.meta.url).pathname;
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(root)) {
    const rel = path.relative(root, f);
    const src = fs.readFileSync(f, 'utf8');
    if (/^(agents|core|demo|market|sources)\//.test(rel)) assert.ok(!/(from|import\()\s*['"][^'"]*trading\//.test(src), `${rel} must not import trading code`);
    if (!rel.startsWith('trading/')) assert.ok(!/\.placeOrder\(/.test(src), `${rel} must not call placeOrder`);
    if (rel.startsWith('trading/') && rel !== 'trading/execution.js' && rel !== 'trading/bitget-private.js') assert.ok(!/\.placeOrder\(/.test(src), `${rel} must not call placeOrder`);
    if (!['trading/auth.js', 'trading/execution.js'].includes(rel)) assert.ok(!/humanApproval\(/.test(src), `${rel} must not mint approvals`);
  }
  const exec = fs.readFileSync(path.join(root, 'trading/execution.js'), 'utf8');
  assert.equal((exec.match(/privateClient\.placeOrder\(/g) || []).length, 1, 'exactly one submission call site');
});

test('operator auth: constant-time token login, CSRF and same-origin required', () => {
  const auth = createOperatorAuth({ token: 'x'.repeat(30) });
  const req = (h = {}, method = 'POST') => ({ method, headers: { host: 'pred.test', origin: 'https://pred.test', ...h }, socket: { remoteAddress: '1.2.3.4' } });
  assert.equal(auth.login(req(), 'wrong').code, 401);
  const ok = auth.login(req(), 'x'.repeat(30));
  assert.ok(ok.ok);
  const cookie = ok.cookie.split(';')[0];
  assert.ok(/HttpOnly/.test(ok.cookie) && /SameSite=Strict/.test(ok.cookie));
  assert.equal(auth.requireHuman(req({ cookie })).code, 403, 'no CSRF header');
  assert.equal(auth.requireHuman(req({ cookie, 'x-pred-csrf': ok.csrfToken, origin: 'https://evil.test' })).code, 403);
  assert.equal(auth.requireHuman(req({ cookie, 'x-pred-csrf': ok.csrfToken }, 'GET')).code, 405);
  assert.equal(auth.requireHuman(req({ 'x-pred-csrf': ok.csrfToken })).code, 401);
  const g = auth.requireHuman(req({ cookie, 'x-pred-csrf': ok.csrfToken }));
  assert.ok(g.ok && g.approval.actor === 'human');
  assert.equal(createOperatorAuth({ token: 'short' }).configured, false);
  const limited = createOperatorAuth({ token: 'y'.repeat(30) });
  for (let i = 0; i < 5; i++) limited.login(req({ 'x-forwarded-for': '9.9.9.9' }), 'bad');
  assert.equal(limited.login(req({ 'x-forwarded-for': '9.9.9.9' }), 'y'.repeat(30)).code, 429);
});

// ---------- HTTP: the only door to execution ----------
import os from 'node:os';
import { createPredServer } from '../src/server.js';
import { createLiveRuntime } from '../src/live/runtime.js';
import { measure, crossAsset } from '../src/agents/detector.js';
import { config as baseConfig } from '../src/config.js';
import { createBitgetMock } from './fixtures/bitget-mock.js';

test('HTTP: unauthenticated / GET / no-CSRF execution is refused; the human flow submits exactly one order', async () => {
  process.env.PRED_LOG_LEVEL = 'silent';
  const ua = process.env.SEC_USER_AGENT;
  delete process.env.SEC_USER_AGENT;
  const TOKEN = 'operator-token-for-tests-0123456789';
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pred-')), 'pred.sqlite');
  const { fetchImpl } = createBitgetMock({ spikeSymbol: 'NVDAXUSDT', spikePct: 2.5 });
  const bg = mockBitget();
  const config = { ...baseConfig, mode: 'live', demoEnabled: false, live: true, dbPath, assets: null, categories: ['SPOT'], pollIntervalMs: 60_000, detectorIntervalMs: 60_000, assetRefreshMs: 600_000, candleBatch: 50, sourceProbeMs: 600_000, trading: { ...CFG, quoteMaxAgeMs: 60_000 } };
  const runtime = createLiveRuntime({ config, fetchImpl, privateClient: bg.priv, auth: createOperatorAuth({ token: TOKEN }) });
  if (ua) process.env.SEC_USER_AGENT = ua;
  await runtime.market.refreshAssets();
  await runtime.market.pollTickers();
  for (let i = 0; i < 3; i++) await runtime.market.pollCandles();
  const store = runtime.engine.store;
  const m = measure(store.candles('NVDAx'));
  const cross = crossAsset(store, m, ['NVDAon'], { BTC: 'BTCUSDT' }, []);
  runtime.engine.openEvent({ ticker: 'NVDAx', detectedAt: Date.now(), marketSession: 'WEEKEND', priority: 'ELEVATED', measurements: { ...m, spread: null, score: 10, severity: 'HIGH' }, cross: { peers: cross.withCorr([]), crypto: cross.crypto, marketWide: cross.marketWide, avgPeerRetPct: cross.avgPeerRetPct, residualPct: cross.residualPct } });
  await runtime.engine.idle();
  const ev = [...runtime.engine.events.values()][0];
  const app = await createPredServer({ config, runtime });
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const origin = { origin: base };
  const call = async (p, { method = 'GET', headers = {}, body } = {}) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json(), headers: r.headers };
  };
  try {
    assert.equal((await call(`/api/trade/events/${ev.id}/plan`, { method: 'POST', headers: origin })).status, 401, 'no session → no plan');
    assert.equal((await call('/api/auth/login', { method: 'POST', headers: origin, body: { token: 'nope' } })).status, 401);
    const login = await call('/api/auth/login', { method: 'POST', headers: origin, body: { token: TOKEN } });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const auth = { ...origin, cookie, 'x-pred-csrf': login.body.csrfToken };

    const made = await call(`/api/trade/events/${ev.id}/plan`, { method: 'POST', headers: auth });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const plan = made.body.plan;
    assert.equal(plan.symbol, 'NVDAXUSDT');
    assert.equal(plan.lowConfidence, true, 'live memory is empty → labelled low confidence');

    const ex = `/api/trade/plans/${plan.id}/execute`;
    assert.equal((await call(ex, { method: 'POST', headers: origin, body: { confirmation: plan.confirmationPhrase } })).status, 401, 'unauthenticated');
    assert.equal((await call(ex, { headers: auth })).status, 405, 'GET never executes');
    assert.equal((await call(ex, { method: 'POST', headers: { ...origin, cookie }, body: { confirmation: plan.confirmationPhrase } })).status, 403, 'no CSRF token');
    assert.equal((await call(ex, { method: 'POST', headers: { ...auth, origin: 'https://evil.example' }, body: { confirmation: plan.confirmationPhrase } })).status, 403, 'cross-origin');
    const review = await call(`/api/trade/plans/${plan.id}/review`, { method: 'POST', headers: auth });
    assert.equal(review.status, 200);
    assert.ok(review.body.market.bid > 0, 'review shows a fresh quote');
    assert.equal(bg.calls.place.length, 0, 'plan creation and review never submit');
    // Double-click, with forged order fields the server must ignore.
    const forged = { confirmation: plan.confirmationPhrase, symbol: 'BTCUSDT', qty: '999', side: 'sell', price: '1' };
    const [a, b] = await Promise.all([1, 2].map(() => call(ex, { method: 'POST', headers: auth, body: forged })));
    assert.equal(bg.calls.place.length, 1, 'exactly one exchange order');
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(b.status, 200);
    assert.ok(a.body.idempotent || b.body.idempotent);
    const sent = bg.calls.place[0];
    assert.equal(sent.symbol, 'NVDAXUSDT');
    assert.equal(sent.qty, plan.quantity);
    assert.equal(sent.side, plan.side);
    assert.notEqual(sent.price, '1');
    assert.equal((await call(`/api/trade/plans/${plan.id}`)).status, 401, 'plans are operator-only');
    assert.equal((await call('/api/trade/plans')).status, 401);
    const final = await call(`/api/trade/plans/${plan.id}`, { headers: { cookie } });
    assert.equal(final.body.plan.status, 'SUBMITTED');
    assert.equal(final.body.plan.exchangeOrderId, 'BG-1');
    assert.ok(final.body.audit.some((x) => x.kind === 'TRADE_APPROVED' && x.actor === 'human'));
    assert.ok(final.body.audit.length >= 2);
    for (const r of [a, b]) assert.ok(!JSON.stringify(r.body).includes(TOKEN));
    const st = JSON.stringify((await call('/api/status')).body) + JSON.stringify((await call('/api/trade/status')).body) + JSON.stringify(final.body);
    assert.ok(!st.includes(TOKEN) && !st.includes(cookie.split('=')[1]), 'no secrets in API responses');
  } finally {
    await app.close();
  }
});
