// Bitget authenticated client — Unified Trading API v3 (same API family as
// PRED's public market-data client). Used ONLY by src/trading/.
//
//   GET  /api/v3/account/settings          account mode (must be unified) + hold mode
//   GET  /api/v3/account/assets            available balances
//   GET  /api/v3/position/current-position open futures position for a symbol
//   GET  /api/v3/trade/order-info          order status by orderId or clientOid
//   POST /api/v3/trade/place-order         submit an order   (execution.js only)
//   POST /api/v3/trade/cancel-order        cancel an order   (human action only)
//
// Signing (Bitget): base64(HMAC-SHA256(secret, timestamp + METHOD + path +
// ("?" + sorted query for GET | JSON body for POST))), sent with ACCESS-KEY,
// ACCESS-SIGN, ACCESS-TIMESTAMP and ACCESS-PASSPHRASE.
//
// Secrets live only in this closure. They are never logged, returned,
// persisted or included in error messages. POST requests are NEVER retried:
// a retried place-order could create a second order.

import crypto from 'node:crypto';
import { BITGET_BASE_URL } from '../market/bitget.js';

export class BitgetApiError extends Error {
  constructor(message, { code = null, status = null, ambiguous = false } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    // true when the request may have reached Bitget but no answer came back
    // (timeout / connection reset) — the order state must be reconciled, never resubmitted.
    this.ambiguous = ambiguous;
  }
}

export function signBitget(secret, timestamp, method, pathWithQuery, body = '') {
  return crypto.createHmac('sha256', secret).update(`${timestamp}${method.toUpperCase()}${pathWithQuery}${body}`).digest('base64');
}

const sortedQuery = (params) =>
  Object.keys(params)
    .filter((k) => params[k] != null && params[k] !== '')
    .sort()
    .map((k) => `${k}=${encodeURIComponent(params[k])}`)
    .join('&');

export function credentialsFromEnv(env = process.env) {
  const apiKey = env.BITGET_API_KEY || '';
  const apiSecret = env.BITGET_API_SECRET || '';
  const passphrase = env.BITGET_API_PASSPHRASE || '';
  return apiKey && apiSecret && passphrase ? { apiKey, apiSecret, passphrase } : null;
}

export function createBitgetPrivateClient({ credentials = credentialsFromEnv(), fetchImpl = fetch, baseUrl = BITGET_BASE_URL, timeoutMs = 10_000 } = {}) {
  const creds = credentials; // captured; never exposed
  const configured = !!creds;
  const health = { status: configured ? 'unknown' : 'not_configured', lastOkAt: null, lastErrorAt: null, lastError: null };

  async function call(method, path, params = {}) {
    if (!creds) throw new BitgetApiError('Bitget API credentials are not configured (BITGET_API_KEY, BITGET_API_SECRET, BITGET_API_PASSPHRASE)', { code: 'NO_CREDENTIALS' });
    const ts = String(Date.now());
    let url = `${baseUrl}${path}`;
    let signPath = path;
    let body = '';
    if (method === 'GET') {
      const q = sortedQuery(params);
      if (q) {
        signPath += `?${q}`;
        url += `?${q}`;
      }
    } else body = JSON.stringify(params);
    const headers = {
      'ACCESS-KEY': creds.apiKey,
      'ACCESS-SIGN': signBitget(creds.apiSecret, ts, method, signPath, body),
      'ACCESS-TIMESTAMP': ts,
      'ACCESS-PASSPHRASE': creds.passphrase,
      'Content-Type': 'application/json',
      locale: 'en-US',
    };
    let res;
    try {
      res = await fetchImpl(url, { method, headers, body: method === 'GET' ? undefined : body, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      const e = new BitgetApiError(`Bitget ${path}: ${timeout ? `no response within ${timeoutMs}ms` : `network error (${err?.cause?.code || err?.message || 'unknown'})`}`, { code: timeout ? 'TIMEOUT' : 'NETWORK', ambiguous: method !== 'GET' });
      fail(e);
      throw e;
    }
    let data = null;
    const text = await res.text().catch(() => '');
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!data || typeof data !== 'object') {
      // An unparseable answer to a POST may still mean the order was accepted.
      const e = new BitgetApiError(`Bitget ${path}: HTTP ${res.status}, unreadable response`, { status: res.status, code: 'BAD_RESPONSE', ambiguous: method !== 'GET' && res.status >= 500 });
      fail(e);
      throw e;
    }
    if (data.code !== '00000') {
      const e = new BitgetApiError(`Bitget ${path}: ${data.code} ${String(data.msg ?? '').slice(0, 200)}`.trim(), { status: res.status, code: String(data.code ?? res.status) });
      fail(e);
      throw e;
    }
    health.status = 'connected';
    health.lastOkAt = Date.now();
    return data.data;
  }
  function fail(e) {
    health.status = 'disconnected';
    health.lastErrorAt = Date.now();
    health.lastError = e.message;
  }

  const read = {
    configured,
    health,
    accountSettings: () => call('GET', '/api/v3/account/settings'),
    accountAssets: () => call('GET', '/api/v3/account/assets'),
    async currentPosition(category, symbol) {
      const d = await call('GET', '/api/v3/position/current-position', { category, symbol });
      return Array.isArray(d?.list) ? d.list : Array.isArray(d) ? d : [];
    },
    orderInfo: ({ orderId, clientOid }) => call('GET', '/api/v3/trade/order-info', orderId ? { orderId } : { clientOid }),
  };
  return {
    ...read,
    // Read-only view for background order tracking: it cannot place or cancel.
    readOnly: () => Object.freeze({ ...read }),
    // Called only by the human approval path in execution.js.
    placeOrder: (order) => call('POST', '/api/v3/trade/place-order', order),
    // Called only by the human cancel-order route.
    cancelOrder: ({ category, orderId }) => call('POST', '/api/v3/trade/cancel-order', { category, orderId }),
  };
}
