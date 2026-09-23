// Pure trading rules: instrument precision, TradePlan construction, order
// construction and risk checks. No I/O here — every number comes from live
// Bitget instrument metadata and tickers passed in by the caller.

import crypto from 'node:crypto';

const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export function stepsFor(inst) {
  const qtyStep = inst?.quantityMultiplier > 0 ? inst.quantityMultiplier : inst?.quantityPrecision != null ? 10 ** -inst.quantityPrecision : null;
  const tick = inst?.priceMultiplier > 0 ? inst.priceMultiplier : inst?.pricePrecision != null ? 10 ** -inst.pricePrecision : null;
  return { qtyStep, tick };
}
const decimals = (step) => (step >= 1 ? 0 : Math.min(12, Math.ceil(-Math.log10(step) - 1e-9)));
export const floorTo = (x, step) => Math.floor(x / step + 1e-9) * step;
export const ceilTo = (x, step) => Math.ceil(x / step - 1e-9) * step;
export const fmt = (x, step) => x.toFixed(decimals(step));
export const isMultiple = (x, step) => Math.abs(Math.round(x / step) * step - x) <= step * 1e-6;

// Why an instrument cannot take a new opening order, or null if it can.
export function instrumentProblem(inst, { symbol, category }) {
  if (!inst) return `${symbol} is not listed by Bitget in ${category}`;
  if (inst.symbol !== symbol) return `instrument mismatch (${inst.symbol} ≠ ${symbol})`;
  if (inst.status !== 'online') return `${symbol} is not open for new orders (status: ${inst.status ?? 'unknown'})`;
  const { qtyStep, tick } = stepsFor(inst);
  if (!qtyStep || !tick) return `${symbol} has no quantity/price precision in Bitget metadata`;
  if (!(inst.minOrderQty > 0)) return `${symbol} has no minimum order quantity in Bitget metadata`;
  return null;
}

function quoteOk(ticker) {
  return ticker && ticker.bid > 0 && ticker.ask > 0 && ticker.ask >= ticker.bid;
}

/**
 * Build a TradePlan from a PRED event. Returns { ok, plan } or { ok:false, reason }.
 * source: 'AUTO_PREDICTION' (strong reaction prediction) | 'HUMAN_REQUEST'.
 */
export function buildPlan({ event, asset, instrument, ticker, tradingConfig: cfg, source, now = Date.now() }) {
  const category = asset?.category;
  const symbol = asset?.symbol;
  if (!symbol || !['SPOT', 'USDT-FUTURES'].includes(category)) return { ok: false, reason: 'event has no tradable Bitget instrument' };
  const ip = instrumentProblem(instrument, { symbol, category });
  if (ip) return { ok: false, reason: ip };
  if (!quoteOk(ticker)) return { ok: false, reason: `no live bid/ask for ${symbol}` };
  if (event.outcome) return { ok: false, reason: 'event is closed (outcome already measured)' };
  if (['INVALIDATED', 'UNRESOLVED'].includes(event.resolution?.outcome)) return { ok: false, reason: `event resolved ${event.resolution.outcome} — no signal to act on` };
  if (event.resolution?.actualCategory === 'LIQUIDITY') return { ok: false, reason: 'catalyst confirmed as liquidity noise — nothing to trade on' };

  const pred = event.predictions?.filter((p) => p.status === 'OK').at(-1) || null;
  const rev = event.revisions?.at(-1) || null;
  const m = event.anomaly.measurements;
  let dirSign;
  let basis;
  if (pred && pred.direction !== 'NEUTRAL') {
    dirSign = pred.direction === 'POSITIVE' ? 1 : -1;
    basis = `Reaction model: ${pred.direction.toLowerCase()} ${pred.estimatePct > 0 ? '+' : ''}${pred.estimatePct}% to the U.S. close (confidence ${pred.confidence}%, ${pred.comparableCount} comparable events)`;
  } else {
    if (source === 'AUTO_PREDICTION') return { ok: false, reason: 'no directional reaction prediction' };
    dirSign = Math.sign(m.retPct) || 1;
    basis = 'Reaction model: insufficient live history — direction follows the detected off-hours move (LOW CONFIDENCE)';
  }
  const direction = dirSign > 0 ? 'LONG' : 'SHORT';
  if (category === 'SPOT' && direction === 'SHORT') return { ok: false, reason: 'spot tokens cannot be sold short; no plan' };
  const side = dirSign > 0 ? 'buy' : 'sell';

  const { qtyStep, tick } = stepsFor(instrument);
  const entry = side === 'buy' ? ticker.ask : ticker.bid;
  const target = Math.min(cfg.planNotional, cfg.maxOrderNotional ?? cfg.planNotional);
  let qty = floorTo(target / entry, qtyStep);
  if (qty < instrument.minOrderQty) qty = ceilTo(instrument.minOrderQty, qtyStep);
  const notional = qty * entry;
  if (cfg.maxOrderNotional != null && notional > cfg.maxOrderNotional) return { ok: false, reason: `minimum order (${fmt(qty, qtyStep)} ${symbol} ≈ ${round(notional)} USDT) exceeds PRED_MAX_ORDER_NOTIONAL (${cfg.maxOrderNotional})` };
  if (instrument.minOrderAmount > 0 && notional < instrument.minOrderAmount) return { ok: false, reason: `order value ${round(notional)} USDT is below Bitget's minimum ${instrument.minOrderAmount}` };

  // Take-profit / stop-loss distances from the model (or the move itself when the model has no history).
  const tpPct = pred ? clamp(Math.abs(pred.estimatePct), 0.5, 10) : clamp(Math.abs(m.retPct) * 0.5, 0.5, 5);
  const adverse = pred ? (dirSign > 0 ? pred.rangeLowPct : -pred.rangeHighPct) : null;
  const slPct = adverse != null && adverse < 0 ? clamp(-adverse, 0.5, 5) : clamp(Math.abs(m.retPct) * 0.5, 0.5, 3);
  const takeProfit = dirSign > 0 ? ceilTo(entry * (1 + tpPct / 100), tick) : floorTo(entry * (1 - tpPct / 100), tick);
  const stopLoss = dirSign > 0 ? floorTo(entry * (1 - slPct / 100), tick) : ceilTo(entry * (1 + slPct / 100), tick);

  const primary = rev?.primary || null;
  const evidence = (primary?.evidenceFor || [])
    .slice(0, 4)
    .map((c) => ({ id: c.evidenceId, reason: c.reason, weight: c.weight ?? null }));
  const verb = side === 'buy' ? 'BUY' : 'SELL';
  const plan = {
    id: `TP_${now.toString(36)}${crypto.randomBytes(4).toString('hex')}`,
    eventId: event.id,
    eventCode: event.code,
    ticker: event.ticker,
    company: event.asset?.company || null,
    category,
    symbol,
    direction,
    side,
    orderType: 'limit',
    timeInForce: 'gtc',
    quantity: fmt(qty, qtyStep),
    estimatedPrice: fmt(entry, tick),
    notional: round(notional, 2),
    stopLoss: fmt(stopLoss, tick),
    takeProfit: fmt(takeProfit, tick),
    // TP/SL are attached to the order only for futures; for spot they are reference levels.
    tpslAttached: category === 'USDT-FUTURES',
    thesis: `${event.code}: ${event.ticker} ${m.retPct > 0 ? '+' : ''}${round(m.retPct)}% while the U.S. market was closed. ${primary ? `Leading hypothesis: ${primary.title} (${primary.probability}%).` : ''} ${basis}.`.replace(/\s+/g, ' ').trim(),
    confidence: pred ? pred.confidence : null,
    hypothesisConfidence: primary?.probability ?? null,
    lowConfidence: !pred,
    predictionAt: pred?.at ?? null,
    evidenceSummary: evidence,
    catalyst: event.resolution?.outcome === 'CONFIRMED' ? 'CONFIRMED' : 'UNCONFIRMED',
    source,
    marketAtPlan: { bid: ticker.bid, ask: ticker.ask, last: ticker.last ?? null, quoteTs: ticker.ts ?? now },
    instrumentAtPlan: { minOrderQty: instrument.minOrderQty, qtyStep, tick, status: instrument.status },
    confirmationPhrase: `${verb} ${fmt(qty, qtyStep)} ${symbol}`,
    createdAt: now,
    expiresAt: now + cfg.planTtlMs,
    status: 'AWAITING_APPROVAL',
  };
  return { ok: true, plan };
}

/**
 * Construct the exchange order from a persisted plan + FRESH market data.
 * The browser never supplies any of these values.
 */
export function buildOrder({ plan, instrument, ticker, holdMode, tradingConfig: cfg, executionId }) {
  const ip = instrumentProblem(instrument, { symbol: plan.symbol, category: plan.category });
  if (ip) return { ok: false, reason: ip };
  if (!quoteOk(ticker)) return { ok: false, reason: `no live bid/ask for ${plan.symbol}` };
  if (!['buy', 'sell'].includes(plan.side)) return { ok: false, reason: `invalid side ${plan.side}` };
  if (plan.orderType !== 'limit') return { ok: false, reason: `unsupported order type ${plan.orderType}` };
  if (plan.category === 'SPOT' && plan.side !== 'buy') return { ok: false, reason: 'spot sell/short is not supported' };
  const { qtyStep, tick } = stepsFor(instrument);
  const qty = Number(plan.quantity);
  if (!(qty > 0) || !Number.isFinite(qty)) return { ok: false, reason: 'quantity must be positive' };
  if (!isMultiple(qty, qtyStep)) return { ok: false, reason: `quantity ${plan.quantity} does not match Bitget's step ${qtyStep}` };
  if (qty < instrument.minOrderQty) return { ok: false, reason: `quantity ${plan.quantity} is below Bitget's minimum ${instrument.minOrderQty}` };
  if (instrument.maxOrderQty > 0 && qty > instrument.maxOrderQty) return { ok: false, reason: `quantity ${plan.quantity} exceeds Bitget's maximum ${instrument.maxOrderQty}` };

  // Marketable limit: at most PRED_TRADE_SLIPPAGE_BPS through the touch.
  const slip = cfg.slippageBps / 10_000;
  const price = plan.side === 'buy' ? ceilTo(ticker.ask * (1 + slip), tick) : floorTo(ticker.bid * (1 - slip), tick);
  const notional = qty * price;
  if (instrument.minOrderAmount > 0 && notional < instrument.minOrderAmount) return { ok: false, reason: `order value ${round(notional)} is below Bitget's minimum ${instrument.minOrderAmount}` };

  const tp = Number(plan.takeProfit);
  const sl = Number(plan.stopLoss);
  if (plan.side === 'buy' && !(sl < price && tp > price)) return { ok: false, reason: 'stop loss / take profit no longer bracket the price', stale: true };
  if (plan.side === 'sell' && !(sl > price && tp < price)) return { ok: false, reason: 'stop loss / take profit no longer bracket the price', stale: true };

  const order = {
    category: plan.category,
    symbol: plan.symbol,
    qty: fmt(qty, qtyStep),
    price: fmt(price, tick),
    side: plan.side,
    orderType: 'limit',
    timeInForce: 'gtc',
    clientOid: executionId,
  };
  if (plan.category === 'USDT-FUTURES') {
    order.marginMode = cfg.marginMode;
    if (/hedge/i.test(holdMode || '')) order.posSide = plan.side === 'buy' ? 'long' : 'short';
    order.takeProfit = fmt(tp, tick);
    order.stopLoss = fmt(sl, tick);
    order.tpTriggerBy = 'market';
    order.slTriggerBy = 'market';
  }
  return { ok: true, order, price, notional: round(notional, 4) };
}

// Risk limits. Returns a list of problems (empty = pass).
export function riskProblems({ notional, tradingConfig: cfg, dailyUsed, positionNotional, availableQuote }) {
  const out = [];
  if (cfg.maxOrderNotional == null || cfg.maxPositionNotional == null || cfg.maxDailyNotional == null) out.push('safety limits are not configured');
  if (cfg.maxOrderNotional != null && notional > cfg.maxOrderNotional) out.push(`order value ${round(notional)} USDT exceeds PRED_MAX_ORDER_NOTIONAL ${cfg.maxOrderNotional}`);
  if (cfg.maxDailyNotional != null && dailyUsed + notional > cfg.maxDailyNotional) out.push(`today's traded value would be ${round(dailyUsed + notional)} USDT, above PRED_MAX_DAILY_TRADING_NOTIONAL ${cfg.maxDailyNotional}`);
  if (cfg.maxPositionNotional != null && positionNotional + notional > cfg.maxPositionNotional) out.push(`position would be ${round(positionNotional + notional)} USDT, above PRED_MAX_POSITION_NOTIONAL ${cfg.maxPositionNotional}`);
  // Conservative: require the full order value (1× margin) plus fees in available USDT.
  if (!(availableQuote >= notional * 1.002)) out.push(`insufficient available USDT balance for a ${round(notional)} USDT order`);
  return out;
}

// Map a Bitget v3 order to PRED's status. Accepted ≠ filled.
export function mapOrderStatus(info) {
  const s = String(info?.orderStatus || '').toLowerCase();
  const filled = Number(info?.cumExecQty) || 0;
  const qty = Number(info?.qty) || 0;
  if (s === 'filled' || (qty > 0 && filled >= qty)) return { status: 'FILLED', final: true };
  if (/cancel/.test(s)) return filled > 0 ? { status: 'PARTIALLY_FILLED', final: true } : { status: 'CANCELLED', final: true };
  if (/reject|fail/.test(s)) return { status: 'REJECTED', final: true };
  if (/partial/.test(s) || filled > 0) return { status: 'PARTIALLY_FILLED', final: false };
  return { status: 'SUBMITTED', final: false };
}
