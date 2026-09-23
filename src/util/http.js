// Resilient HTTP for external sources: per-source rate limiting (minimum
// spacing between requests), timeouts, exponential backoff with jitter on
// network errors / 429 / 5xx (honouring Retry-After), a small TTL cache,
// and a health record the UI shows as the source's connection status.

import { logOp } from './log.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class HttpError extends Error {
  constructor(message, { status = null, retryable = false, body = null } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
    this.body = body;
  }
}

export function createHttp({ name, minIntervalMs = 0, timeoutMs = 8000, retries = 2, baseBackoffMs = 500, maxBackoffMs = 8000, fetchImpl = fetch, cacheTtlMs = 0 } = {}) {
  let chain = Promise.resolve();
  let lastAt = 0;
  const cache = new Map();
  const health = { name, status: 'unknown', lastOkAt: null, lastErrorAt: null, lastError: null, consecutiveFailures: 0, lastLatencyMs: null, requests: 0, rateLimited: 0 };

  // Serialize requests so they are at least minIntervalMs apart.
  function slot() {
    const p = chain.then(async () => {
      const wait = lastAt + minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastAt = Date.now();
    });
    chain = p.catch(() => {});
    return p;
  }

  async function once(url, { headers = {}, parse = 'json' } = {}) {
    await slot();
    const t0 = Date.now();
    health.requests++;
    let res;
    try {
      res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      // Node's fetch reports every network error as "fetch failed"; the real
      // reason (DNS, TLS certificate, refused connection) is in err.cause.
      const cause = err.cause ? ` (${[err.cause.code, err.cause.message].filter(Boolean).join(': ')})` : '';
      throw new HttpError(`${name}: ${err.name === 'TimeoutError' ? `timeout after ${timeoutMs}ms` : `${err.message}${cause}`}`, { retryable: true });
    }
    health.lastLatencyMs = Date.now() - t0;
    if (res.status === 429 || res.status >= 500) {
      if (res.status === 429) health.rateLimited++;
      const ra = Number(res.headers?.get?.('retry-after'));
      const err = new HttpError(`${name}: HTTP ${res.status}`, { status: res.status, retryable: true });
      err.retryAfterMs = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 60_000) : null;
      throw err;
    }
    if (!res.ok) throw new HttpError(`${name}: HTTP ${res.status}`, { status: res.status, retryable: false });
    const text = await res.text();
    if (parse === 'text') return text;
    if (!text.trim()) return {};
    try {
      return JSON.parse(text);
    } catch {
      // GDELT answers rate-limit violations and query errors with plain text.
      const limited = /limit requests|rate limit/i.test(text);
      if (limited) health.rateLimited++;
      const snippet = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
      throw new HttpError(`${name}: ${limited ? 'rate limited' : 'non-JSON response'}: ${snippet}`, { retryable: limited, body: text.slice(0, 200) });
    }
  }

  async function request(url, opts = {}) {
    const key = opts.cacheKey ?? url;
    const ttl = opts.cacheTtlMs ?? cacheTtlMs;
    if (ttl > 0) {
      const hit = cache.get(key);
      if (hit && hit.exp > Date.now()) return hit.value;
    }
    let attempt = 0;
    for (;;) {
      try {
        const value = await once(url, opts);
        health.status = 'connected';
        health.lastOkAt = Date.now();
        health.consecutiveFailures = 0;
        health.lastError = null;
        if (ttl > 0) cache.set(key, { value, exp: Date.now() + ttl });
        if (cache.size > 500) cache.delete(cache.keys().next().value);
        return value;
      } catch (err) {
        if (err.retryable && attempt < (opts.retries ?? retries)) {
          const backoff = err.retryAfterMs ?? Math.min(maxBackoffMs, baseBackoffMs * 2 ** attempt) * (0.75 + Math.random() * 0.5);
          logOp({ component: name, op: 'HTTP_RETRY', status: 'RETRY', error: err, attempt: attempt + 1, backoffMs: Math.round(backoff) });
          attempt++;
          await sleep(backoff);
          continue;
        }
        health.status = 'disconnected';
        health.lastErrorAt = Date.now();
        health.lastError = err.message;
        health.consecutiveFailures++;
        throw err;
      }
    }
  }

  return {
    name,
    health,
    getJson: (url, opts) => request(url, { ...opts, parse: 'json' }),
    getText: (url, opts) => request(url, { ...opts, parse: 'text' }),
    clearCache: () => cache.clear(),
  };
}

// Only http(s) URLs are ever handed to the browser.
export function safeUrl(u) {
  try {
    const url = new URL(String(u));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
