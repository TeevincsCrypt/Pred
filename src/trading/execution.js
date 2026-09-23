// PRED trading service — the ONLY module that can submit a live order.
//
//   LIVE DATA → GHOST EVENT → … → REACTION PREDICTION → TRADE PLAN
//   → HUMAN REVIEW → EXPLICIT APPROVAL → REVALIDATION → ORDER → STATUS → AUDIT
//
// Rules enforced here (and tested):
//  • Agents, the engine, background loops, SSE and webhooks never receive this
//    service's execute path. The runtime only wires `maybeAutoPlan` (creates a
//    plan, never an order) and the read-only order tracker.
//  • `approveAndExecute` must be called with a human approval produced by the
//    authenticated, CSRF-protected POST route, and the exact confirmation
//    phrase shown on the review panel.
//  • The plan is re-read from the database and claimed with one atomic
//    UPDATE (AWAITING_APPROVAL → APPROVED); a second click gets the existing
//    execution back, never a second order.
//  • Every exchange parameter is rebuilt server-side from the persisted plan
//    and FRESH Bitget data; nothing order-shaped is accepted from the browser.
//  • Confidence never authorises anything.

import crypto from 'node:crypto';
import { logOp } from '../util/log.js';
import { buildPlan, buildOrder, riskProblems, mapOrderStatus } from './rules.js';
import { FINAL_STATUSES } from './store.js';

const HUMAN = Symbol('pred.human-approval');

// Only the authenticated HTTP route mints approvals (see src/trading/auth.js).
export function humanApproval({ sessionId, ip }) {
  return Object.freeze({ [HUMAN]: true, actor: 'human', sessionId: String(sessionId).slice(0, 12), ip: ip || null, at: Date.now() });
}
const isHuman = (a) => !!(a && a[HUMAN] === true);

const say = (op, msg, fields = {}) => logOp({ component: 'trade', op, message: `[PRED] ${msg}`, ...fields });
const startOfUtcDay = (t) => {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

export function createTradingService({ tradingConfig: cfg, mode = 'live', store, publicClient, privateClient, authConfigured = () => false, events, assets, now = () => Date.now() }) {
  const instCache = new Map();
  let trackTimer = null;

  // ---------- configuration / readiness ----------
  function blockers() {
    const b = [];
    if (mode !== 'live') b.push('not in live mode');
    if (!cfg.enabled) b.push('trading disabled (PRED_TRADING_ENABLED is not "true")');
    if (!privateClient?.configured) b.push('Bitget API credentials not configured');
    if (!authConfigured()) b.push('approval login not configured (PRED_ADMIN_TOKEN, 24+ characters)');
    if (cfg.maxOrderNotional == null) b.push('PRED_MAX_ORDER_NOTIONAL not set');
    if (cfg.maxPositionNotional == null) b.push('PRED_MAX_POSITION_NOTIONAL not set');
    if (cfg.maxDailyNotional == null) b.push('PRED_MAX_DAILY_TRADING_NOTIONAL not set');
    return b;
  }
  function status({ operator = false } = {}) {
    const b = blockers();
    return {
      executionEnabled: b.length === 0,
      tradingFlag: cfg.enabled,
      blockers: b,
      credentialsConfigured: !!privateClient?.configured,
      approvalLoginConfigured: authConfigured(),
      venue: 'Bitget Unified Trading API v3 (/api/v3/trade/place-order)',
      limits: { maxOrderNotional: cfg.maxOrderNotional, maxPositionNotional: cfg.maxPositionNotional, maxDailyNotional: cfg.maxDailyNotional, quote: 'USDT' },
      // Account activity only for the logged-in operator.
      dailyUsed: operator ? store.dailyNotional(startOfUtcDay(now())) : undefined,
      plan: { notional: cfg.planNotional, ttlSec: Math.round(cfg.planTtlMs / 1000), maxDriftBps: cfg.maxDriftBps, slippageBps: cfg.slippageBps, autoPlanMinConfidence: cfg.autoPlanMinConfidence, marginMode: cfg.marginMode },
      privateApi: privateClient?.health?.status ?? 'not_configured',
    };
  }

  async function instrument(category, symbol, { fresh = false } = {}) {
    const k = `${category}:${symbol}`;
    const hit = instCache.get(k);
    if (!fresh && hit && now() - hit.at < 10 * 60_000) return hit.value;
    const list = await publicClient.instruments(category, symbol);
    const value = list.find((i) => i.symbol === symbol) || null;
    instCache.set(k, { at: now(), value });
    return value;
  }
  async function quote(category, symbol) {
    const t0 = now();
    const [t] = await publicClient.tickers(category, symbol);
    if (!t) return null;
    return { ...t, fetchedAt: t0, ts: t.ts || t0 };
  }

  // ---------- plan creation (never places an order) ----------
  async function createPlan(event, source) {
    const asset = assets(event.ticker) || null;
    if (!asset) return { ok: false, reason: `${event.ticker} is not in the discovered Bitget universe` };
    const [inst, tk] = await Promise.all([instrument(asset.category, asset.symbol), quote(asset.category, asset.symbol)]);
    const r = buildPlan({ event, asset, instrument: inst, ticker: tk, tradingConfig: cfg, source, now: now() });
    if (!r.ok) return r;
    // One open plan per event: supersede an older AWAITING one.
    for (const old of store.byEvent(event.id).filter((p) => p.status === 'AWAITING_APPROVAL')) {
      if (store.transition(old.id, 'AWAITING_APPROVAL', 'EXPIRED', { expiredReason: 'superseded by a newer plan' }, now())) store.audit('TRADE_PLAN_EXPIRED', { plan: old, result: 'superseded' });
    }
    const plan = store.insert(r.plan);
    store.audit('TRADE_PLAN_CREATED', { actor: source === 'HUMAN_REQUEST' ? 'human' : 'system', plan, result: 'AWAITING_APPROVAL', side: plan.side, quantity: plan.quantity, estimatedPrice: plan.estimatedPrice, notional: plan.notional, confidence: plan.confidence, thesis: plan.thesis, evidence: plan.evidenceSummary, source });
    say('TRADE_PLAN_CREATED', `Trade plan created: ${plan.id} (${plan.confirmationPhrase}, ≈${plan.notional} USDT)`, { planId: plan.id, eventId: plan.eventId, source });
    say('AWAITING_APPROVAL', `Awaiting human approval: ${plan.id}`, { planId: plan.id });
    return { ok: true, plan };
  }

  // Called by the runtime on engine updates. Creates at most one plan per
  // strong prediction. It cannot execute: it has no approval and never calls
  // approveAndExecute.
  async function maybeAutoPlan(event) {
    const pred = event.predictions?.filter((p) => p.status === 'OK').at(-1);
    if (!pred || pred.direction === 'NEUTRAL' || pred.confidence < cfg.autoPlanMinConfidence) return null;
    if (event.outcome || ['INVALIDATED', 'UNRESOLVED'].includes(event.resolution?.outcome)) return null;
    if (store.byEvent(event.id).some((p) => p.predictionAt === pred.at && p.source === 'AUTO_PREDICTION')) return null;
    return createPlan(event, 'AUTO_PREDICTION').catch((err) => ({ ok: false, reason: err.message }));
  }

  async function requestPlan(eventId, approval) {
    if (!isHuman(approval)) return { ok: false, code: 403, error: 'human session required' };
    const event = events(eventId);
    if (!event) return { ok: false, code: 404, error: 'event not found' };
    const r = await createPlan(event, 'HUMAN_REQUEST');
    return r.ok ? { ok: true, plan: view(r.plan) } : { ok: false, code: 422, error: r.reason };
  }

  function expireIfStale(plan) {
    if (plan?.status === 'AWAITING_APPROVAL' && now() >= plan.expiresAt) {
      if (store.transition(plan.id, 'AWAITING_APPROVAL', 'EXPIRED', { expiredReason: 'plan older than PRED_TRADE_PLAN_TTL_MS' }, now())) {
        store.audit('TRADE_PLAN_EXPIRED', { plan, result: 'EXPIRED' });
        say('TRADE_PLAN_EXPIRED', `Trade plan expired: ${plan.id}`, { planId: plan.id });
      }
      return store.get(plan.id);
    }
    return plan;
  }

  // Review = fresh quote for the confirmation panel. Records who looked.
  async function reviewPlan(planId, approval) {
    if (!isHuman(approval)) return { ok: false, code: 403, error: 'human session required' };
    let plan = expireIfStale(store.get(planId));
    if (!plan) return { ok: false, code: 404, error: 'trade plan not found' };
    let market = null;
    try {
      const tk = await quote(plan.category, plan.symbol);
      const mid = tk && tk.bid > 0 && tk.ask > 0 ? (tk.bid + tk.ask) / 2 : tk?.last ?? null;
      market = { bid: tk?.bid ?? null, ask: tk?.ask ?? null, last: tk?.last ?? null, fetchedAt: tk?.fetchedAt ?? null, driftBps: mid ? Math.round((Math.abs(mid - Number(plan.estimatedPrice)) / Number(plan.estimatedPrice)) * 10_000) : null };
    } catch (err) {
      market = { error: err.message };
    }
    if (plan.status === 'AWAITING_APPROVAL') {
      store.audit('TRADE_PLAN_REVIEWED', { actor: 'human', plan, result: 'reviewed', session: approval.sessionId, market });
      store.audit('TRADE_APPROVAL_REQUESTED', { actor: 'system', plan, result: 'confirmation panel shown', confirmationPhrase: plan.confirmationPhrase });
    }
    plan = store.get(planId);
    return { ok: true, plan: view(plan), market, execution: status() };
  }

  async function rejectPlan(planId, approval) {
    if (!isHuman(approval)) return { ok: false, code: 403, error: 'human session required' };
    const plan = store.get(planId);
    if (!plan) return { ok: false, code: 404, error: 'trade plan not found' };
    if (!store.transition(planId, 'AWAITING_APPROVAL', 'CANCELLED', { cancelledReason: 'rejected by human' }, now())) return { ok: false, code: 409, error: `plan is ${plan.status}`, plan: view(plan) };
    store.audit('TRADE_REJECTED', { actor: 'human', plan, result: 'CANCELLED', session: approval.sessionId });
    say('TRADE_REJECTED', `Human rejected trade plan: ${planId}`, { planId });
    return { ok: true, plan: view(store.get(planId)) };
  }

  // ---------- THE execution path ----------
  async function approveAndExecute(planId, approval, { confirmation } = {}) {
    if (!isHuman(approval)) {
      store.audit('TRADE_APPROVAL_DENIED', { planId, result: 'no human approval', actor: 'system' });
      return { ok: false, code: 403, error: 'Execution requires an explicit human approval from an authenticated session' };
    }
    let plan = store.get(planId);
    if (!plan) return { ok: false, code: 404, error: 'trade plan not found' };
    // Idempotency: a plan that already has an execution returns it, never a second order.
    if (plan.executionId) return { ok: true, idempotent: true, plan: view(plan) };
    plan = expireIfStale(plan);
    if (plan.status !== 'AWAITING_APPROVAL') return { ok: false, code: 409, error: `plan is ${plan.status}; generate a fresh plan`, plan: view(plan) };
    const b = blockers();
    if (b.length) {
      store.audit('TRADE_REJECTED', { actor: 'system', plan, result: 'execution disabled', reasons: b });
      return { ok: false, code: 403, error: `Live execution is disabled: ${b.join('; ')}`, blockers: b, plan: view(plan) };
    }
    if (typeof confirmation !== 'string' || confirmation !== plan.confirmationPhrase) return { ok: false, code: 400, error: `confirmation must be exactly "${plan.confirmationPhrase}"`, plan: view(plan) };

    const executionId = `EX_${now().toString(36)}${crypto.randomBytes(6).toString('hex')}`;
    if (!store.claim(planId, executionId, now())) {
      // Lost the race (double click / concurrent request) or it expired this instant.
      const cur = store.get(planId);
      return cur.executionId ? { ok: true, idempotent: true, plan: view(cur) } : { ok: false, code: 409, error: `plan is ${cur.status}`, plan: view(cur) };
    }
    try {
      return await executeClaimed(planId, executionId, approval, confirmation);
    } catch (err) {
      // Unexpected error after the claim: nothing was sent unless SUBMITTING was reached.
      const cur = store.get(planId);
      if (cur?.status === 'APPROVED') {
        store.transition(planId, 'APPROVED', 'FAILED', { failureReason: `internal error before submission: ${err.message}` }, now());
        store.audit('ORDER_FAILED', { actor: 'system', plan: store.get(planId), result: 'FAILED', reason: err.message });
      } else if (cur?.status === 'SUBMITTING' && !cur.reconcile) store.patch(planId, { reconcile: { since: now(), reason: err.message } });
      say('EXECUTION_ERROR', `Execution error: ${err.message}`, { planId, executionId, status: 'FAILURE' });
      return { ok: false, code: 500, error: 'execution error; the order was not resent', plan: view(store.get(planId)) };
    }
  }

  async function executeClaimed(planId, executionId, approval, confirmation) {
    let plan = store.get(planId);
    store.audit('TRADE_APPROVED', { actor: 'human', plan, result: 'APPROVED', session: approval.sessionId, ip: approval.ip, confirmation });
    say('TRADE_APPROVED', `Human approval received: ${planId}`, { planId, executionId });

    // ---- pre-execution revalidation (fresh data only) ----
    say('REVALIDATE', 'Revalidating market data...', { planId, executionId });
    const fail = (to, reason, extra = {}) => {
      store.transition(planId, 'APPROVED', to, { failureReason: reason, ...extra }, now());
      store.audit(to === 'EXPIRED' ? 'TRADE_PLAN_EXPIRED' : 'TRADE_REJECTED', { actor: 'system', plan: store.get(planId), result: to, reason });
      say('REVALIDATE', `Execution stopped before submission: ${reason}`, { planId, executionId, status: 'FAILURE' });
      return { ok: false, code: 409, error: `${reason}. Review a fresh trade plan.`, plan: view(store.get(planId)), regenerate: true };
    };
    let inst;
    let tk;
    let settings;
    let assetsResp;
    let positions = [];
    try {
      [inst, tk, settings, assetsResp] = await Promise.all([instrument(plan.category, plan.symbol, { fresh: true }), quote(plan.category, plan.symbol), privateClient.accountSettings(), privateClient.accountAssets()]);
      if (plan.category === 'USDT-FUTURES') positions = await privateClient.currentPosition(plan.category, plan.symbol);
    } catch (err) {
      return fail('REJECTED', `could not revalidate with Bitget (${err.message})`);
    }
    if (!['unified', 'hybrid'].includes(String(settings?.accountMode || '').toLowerCase())) return fail('REJECTED', `Bitget account mode "${settings?.accountMode ?? 'unknown'}" cannot use the Unified Trading API`);
    if (!tk || now() - tk.fetchedAt > cfg.quoteMaxAgeMs) return fail('EXPIRED', 'market data is stale');
    const mid = (tk.bid + tk.ask) / 2;
    const driftBps = Math.abs(mid - Number(plan.estimatedPrice)) / Number(plan.estimatedPrice) * 10_000;
    if (!(driftBps <= cfg.maxDriftBps)) return fail('EXPIRED', `price moved ${Math.round(driftBps)} bps since the plan (limit ${cfg.maxDriftBps})`);
    const built = buildOrder({ plan, instrument: inst, ticker: tk, holdMode: settings?.holdMode, tradingConfig: cfg, executionId });
    if (!built.ok) return fail(built.stale ? 'EXPIRED' : 'REJECTED', built.reason);
    const usdt = (assetsResp?.assets || []).find((a) => a.coin === 'USDT');
    const available = Number(usdt?.available) || 0;
    let positionNotional = 0;
    if (plan.category === 'USDT-FUTURES') positionNotional = positions.filter((p) => p.symbol === plan.symbol).reduce((s, p) => s + Math.abs(Number(p.total) || 0) * (Number(p.markPrice) || mid), 0);
    else {
      const base = (assetsResp?.assets || []).find((a) => a.coin === inst.baseCoin);
      positionNotional = (Number(base?.balance) || 0) * mid;
    }
    const problems = riskProblems({ notional: built.notional, tradingConfig: cfg, dailyUsed: store.dailyNotional(startOfUtcDay(now())), positionNotional, availableQuote: available });
    if (!cfg.enabled) problems.push('trading was disabled');
    if (problems.length) return fail('REJECTED', problems.join('; '));
    say('RISK_CHECKS', 'Risk checks passed', { planId, executionId, notional: built.notional });

    // ---- submission ----
    if (!store.transition(planId, 'APPROVED', 'SUBMITTING', { order: built.order, orderNotional: built.notional, revalidation: { bid: tk.bid, ask: tk.ask, driftBps: Math.round(driftBps), holdMode: settings?.holdMode ?? null, at: now() } }, now())) {
      return { ok: false, code: 409, error: 'plan changed during revalidation', plan: view(store.get(planId)) };
    }
    store.patch(planId, {}, { submittedAt: now(), notional: built.notional });
    store.audit('ORDER_SUBMISSION_STARTED', { actor: 'human', plan: store.get(planId), result: 'SUBMITTING', order: built.order });
    say('ORDER_SUBMIT', 'Submitting Bitget order...', { planId, executionId, symbol: plan.symbol });
    try {
      const resp = await privateClient.placeOrder(built.order);
      if (!resp?.orderId) throw Object.assign(new Error('Bitget accepted the request but returned no orderId'), { ambiguous: true });
      store.transition(planId, 'SUBMITTING', 'SUBMITTED', { exchangeOrderId: String(resp.orderId), exchangeClientOid: resp.clientOid ?? executionId, acceptedAt: now() }, now());
      store.audit('ORDER_SUBMITTED', { actor: 'human', plan: store.get(planId), result: 'SUBMITTED', exchangeOrderId: String(resp.orderId) });
      say('ORDER_ACCEPTED', `Bitget order accepted: ${resp.orderId}`, { planId, executionId, orderId: String(resp.orderId) });
      say('ORDER_STATUS', 'Order status: SUBMITTED', { planId });
      await trackOne(store.get(planId)).catch(() => {});
      return { ok: true, plan: view(store.get(planId)) };
    } catch (err) {
      if (err.ambiguous) {
        // The order may exist. Never resubmit — reconcile by clientOid.
        store.patch(planId, { reconcile: { since: now(), reason: err.message } });
        store.audit('ORDER_STATUS_UNKNOWN', { actor: 'system', plan: store.get(planId), result: 'reconciling', reason: err.message });
        say('ORDER_UNKNOWN', `Submission outcome unknown, reconciling by clientOid: ${err.message}`, { planId, executionId, status: 'FAILURE' });
        await trackOne(store.get(planId)).catch(() => {});
        return { ok: true, pending: true, plan: view(store.get(planId)) };
      }
      const to = err.code && !['NETWORK', 'TIMEOUT', 'BAD_RESPONSE', 'NO_CREDENTIALS'].includes(err.code) ? 'REJECTED' : 'FAILED';
      store.transition(planId, 'SUBMITTING', to, { failureReason: err.message, exchangeErrorCode: err.code ?? null }, now());
      store.audit(to === 'REJECTED' ? 'ORDER_REJECTED' : 'ORDER_FAILED', { actor: 'system', plan: store.get(planId), result: to, reason: err.message, code: err.code ?? null });
      say('ORDER_FAILED', `Bitget ${to === 'REJECTED' ? 'rejected' : 'did not accept'} the order: ${err.message}`, { planId, executionId, status: 'FAILURE' });
      return { ok: false, code: 502, error: err.message, plan: view(store.get(planId)) };
    }
  }

  // ---------- human cancel of a live exchange order ----------
  async function cancelOrder(planId, approval) {
    if (!isHuman(approval)) return { ok: false, code: 403, error: 'human session required' };
    const plan = store.get(planId);
    if (!plan) return { ok: false, code: 404, error: 'trade plan not found' };
    if (!plan.exchangeOrderId || !['SUBMITTED', 'PARTIALLY_FILLED'].includes(plan.status) || plan.orderFinal) return { ok: false, code: 409, error: `no open order to cancel (plan is ${plan.status})`, plan: view(plan) };
    try {
      await privateClient.cancelOrder({ category: plan.category, orderId: plan.exchangeOrderId });
      store.audit('ORDER_CANCEL_REQUESTED', { actor: 'human', plan, result: 'accepted by Bitget', session: approval.sessionId });
      say('ORDER_CANCEL', `Cancel requested for Bitget order ${plan.exchangeOrderId}`, { planId });
    } catch (err) {
      store.audit('ORDER_CANCEL_FAILED', { actor: 'human', plan, result: 'failed', reason: err.message });
      return { ok: false, code: 502, error: err.message, plan: view(plan) };
    }
    await trackOne(store.get(planId)).catch(() => {});
    return { ok: true, plan: view(store.get(planId)) };
  }

  // ---------- order tracking (read-only) ----------
  const reader = privateClient?.readOnly ? privateClient.readOnly() : null;
  async function trackOne(plan) {
    if (!reader || !plan || plan.orderFinal) return plan;
    if (plan.status === 'SUBMITTING' && plan.reconcile) {
      let info = null;
      try {
        info = await reader.orderInfo({ clientOid: plan.executionId });
      } catch {
        info = null;
      }
      if (info?.orderId) {
        store.transition(plan.id, 'SUBMITTING', 'SUBMITTED', { exchangeOrderId: String(info.orderId), acceptedAt: now(), reconcile: null }, now());
        store.audit('ORDER_SUBMITTED', { actor: 'system', plan: store.get(plan.id), result: 'SUBMITTED (reconciled)', exchangeOrderId: String(info.orderId) });
        plan = store.get(plan.id);
      } else if (now() - plan.reconcile.since > 2 * 60_000) {
        store.transition(plan.id, 'SUBMITTING', 'FAILED', { failureReason: 'Bitget has no order with this clientOid', reconcile: null }, now());
        store.audit('ORDER_FAILED', { actor: 'system', plan: store.get(plan.id), result: 'FAILED', reason: 'not found at Bitget after reconciliation' });
        return store.get(plan.id);
      } else return plan;
    }
    if (!plan.exchangeOrderId || !['SUBMITTED', 'PARTIALLY_FILLED'].includes(plan.status)) return plan;
    const info = await reader.orderInfo({ orderId: plan.exchangeOrderId });
    const m = mapOrderStatus(info);
    const fill = { filledQty: info?.cumExecQty ?? null, avgPrice: info?.avgPrice ?? null, exchangeStatus: info?.orderStatus ?? null, cancelReason: info?.cancelReason || null, lastCheckedAt: now() };
    if (m.status !== plan.status) {
      store.transition(plan.id, plan.status, m.status, { ...fill, orderFinal: m.final }, now());
      const kind = { FILLED: 'ORDER_FILLED', PARTIALLY_FILLED: 'ORDER_PARTIALLY_FILLED', CANCELLED: 'ORDER_CANCELLED', REJECTED: 'ORDER_REJECTED' }[m.status] || 'ORDER_STATUS';
      store.audit(kind, { actor: 'system', plan: store.get(plan.id), result: m.status, ...fill });
      say('ORDER_STATUS', `Order status: ${m.status}${m.final && m.status === 'PARTIALLY_FILLED' ? ' (remainder cancelled)' : ''}`, { planId: plan.id, orderId: plan.exchangeOrderId });
    } else store.patch(plan.id, { ...fill, orderFinal: m.final });
    return store.get(plan.id);
  }
  async function trackAll() {
    for (const p of store.byStatus('AWAITING_APPROVAL')) expireIfStale(p);
    for (const s of ['SUBMITTING', 'SUBMITTED', 'PARTIALLY_FILLED']) for (const p of store.byStatus(s)) await trackOne(p).catch((err) => say('ORDER_STATUS', `status check failed: ${err.message}`, { planId: p.id, status: 'FAILURE' }));
  }

  function view(plan) {
    if (!plan) return null;
    const { order, ...rest } = plan;
    return { ...rest, order: order ? { ...order } : null, final: FINAL_STATUSES.has(plan.status) || !!plan.orderFinal, expiresInSec: plan.status === 'AWAITING_APPROVAL' ? Math.max(0, Math.round((plan.expiresAt - now()) / 1000)) : null };
  }

  return {
    status,
    blockers,
    maybeAutoPlan,
    requestPlan,
    reviewPlan,
    rejectPlan,
    approveAndExecute,
    cancelOrder,
    trackAll,
    getPlan: (id) => view(expireIfStale(store.get(id))),
    plansForEvent: (eventId) => store.byEvent(eventId).map((p) => view(expireIfStale(p))),
    recentPlans: (n) => store.recent(n).map(view),
    audit: (planId) => store.auditFor(planId),
    startTracking() {
      if (trackTimer || !reader) return;
      trackTimer = setInterval(() => trackAll().catch(() => {}), cfg.statusPollMs);
      trackTimer.unref?.();
    },
    stopTracking() {
      clearInterval(trackTimer);
      trackTimer = null;
    },
  };
}
