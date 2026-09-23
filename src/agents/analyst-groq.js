// Optional Groq analyst — a free alternative to Claude for the narrative only.
//
//   POST https://api.groq.com/openai/v1/chat/completions   (OpenAI-compatible)
//   GET  https://api.groq.com/openai/v1/models              (startup check)
//
// Configure with GROQ_API_KEY + GROQ_MODEL (e.g. GROQ_MODEL=openai/gpt-oss-120b).
// The model is not hard-coded: Groq retires models often, so the startup
// check confirms the configured id is currently served to this key.
//
// Same contract as the Claude analyst: it writes an explanation of the
// leading hypothesis from PRED's evidence only. It never sets prices,
// confidence numbers, confirmations or trade decisions, and any failure
// falls back to the deterministic template.
//
// Free-tier friendly: requests are spaced (PRED_GROQ_MIN_INTERVAL_MS, default
// 4 s ≈ 15/min), capped per UTC day (PRED_GROQ_DAILY_CAP, default 800), and a
// 429 pauses calls until Groq's Retry-After. While paused or over budget the
// template narrative is used and the reason is shown in the status panel.

import { ANALYST_SCHEMA, analystPrompt, templateNarrative } from './analyst.js';

const BASE = 'https://api.groq.com/openai/v1';
const redact = (s, key) => String(s ?? '').split(key || '\u0000').join('[redacted]').replace(/gsk_[A-Za-z0-9]+/g, '[redacted]');

export function createGroqAnalyst({
  apiKey = process.env.GROQ_API_KEY,
  model = process.env.GROQ_MODEL,
  fetchImpl = fetch,
  minIntervalMs = Number(process.env.PRED_GROQ_MIN_INTERVAL_MS) || 4000,
  dailyCap = Number(process.env.PRED_GROQ_DAILY_CAP) || 800,
  timeoutMs = 30_000,
  now = () => Date.now(),
} = {}) {
  const enabled = !!(apiKey && model);
  const status = { status: enabled ? 'unknown' : 'not_configured', note: !apiKey ? 'Optional — set GROQ_API_KEY and GROQ_MODEL' : !model ? 'GROQ_MODEL not set (e.g. openai/gpt-oss-120b)' : 'not checked yet', lastOkAt: null, lastError: null };
  let lastCallAt = 0;
  let pausedUntil = 0;
  let day = null;
  let usedToday = 0;
  let chain = Promise.resolve();
  let waiting = 0;
  const MAX_WAITING = 5;

  const headers = () => ({ Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' });
  const fail = (msg) => Object.assign(status, { status: 'disconnected', lastError: msg, note: msg });

  // One request at a time, spaced out, within the daily budget.
  function slot() {
    const run = chain.then(async () => {
      const d = new Date(now()).toISOString().slice(0, 10);
      if (d !== day) {
        day = d;
        usedToday = 0;
      }
      if (now() < pausedUntil) throw new Error(`rate limited by Groq until ${new Date(pausedUntil).toISOString().slice(11, 19)} UTC`);
      if (usedToday >= dailyCap) throw new Error(`daily Groq budget used (${dailyCap} requests, PRED_GROQ_DAILY_CAP)`);
      const wait = lastCallAt + minIntervalMs - now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastCallAt = now();
      usedToday++;
    });
    chain = run.catch(() => {});
    return run;
  }

  async function request(method, path, body) {
    let res;
    try {
      res = await fetchImpl(`${BASE}${path}`, { method, headers: headers(), body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new Error(err?.name === 'TimeoutError' ? `no response within ${timeoutMs / 1000}s` : `network error (${redact(err?.cause?.code || err?.message, apiKey)})`);
    }
    const text = await res.text().catch(() => '');
    if (res.status === 429) {
      const ra = Number(res.headers?.get?.('retry-after'));
      pausedUntil = now() + (Number.isFinite(ra) && ra > 0 ? Math.min(ra, 3600) * 1000 : 60_000);
    }
    if (!res.ok) {
      let msg = '';
      try {
        msg = JSON.parse(text)?.error?.message || '';
      } catch {
        msg = text.slice(0, 160);
      }
      const hint = { 401: '(invalid GROQ_API_KEY)', 404: '(GROQ_MODEL not available)', 413: '(prompt too large)', 429: '(rate limited — using template until the limit resets)' }[res.status] || '';
      throw new Error(`HTTP ${res.status} ${hint} ${redact(msg, apiKey)}`.replace(/\s+/g, ' ').trim().slice(0, 220));
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('unreadable response from Groq');
    }
  }

  // Groq may wrap JSON in ``` fences even in JSON mode.
  function parseNarrative(content) {
    const raw = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    const obj = JSON.parse(start >= 0 && end > start ? raw.slice(start, end + 1) : raw);
    if (typeof obj.summary !== 'string' || !obj.summary.trim()) throw new Error('analyst output missing summary');
    return obj;
  }

  return {
    provider: 'groq',
    providerName: 'Groq',
    enabled,
    model: enabled ? model : null,
    status,

    // Confirms the configured model is served to this key. Never throws.
    async probe() {
      if (!enabled) return status;
      try {
        const list = await request('GET', '/models');
        const ids = (list?.data || []).map((m) => m.id);
        if (!ids.includes(model)) {
          fail(`GROQ_MODEL "${model}" is not available to this key; available: ${ids.slice(0, 6).join(', ')}${ids.length > 6 ? '…' : ''}`);
          return status;
        }
        Object.assign(status, { status: 'connected', note: `${model} via Groq`, lastOkAt: now(), lastError: null });
      } catch (err) {
        fail(`model check failed: ${err.message}`);
      }
      return status;
    },

    async narrate(event, rev) {
      const fallback = templateNarrative(event, rev);
      if (!enabled) return fallback;
      // Don't build an ever-growing queue on a busy night: template instead.
      if (waiting >= MAX_WAITING) return { ...fallback, note: 'Groq queue full — template narrative shown' };
      waiting++;
      let released = false;
      const release = () => {
        if (!released) {
          released = true;
          waiting--;
        }
      };
      try {
        await slot().finally(release);
        const { system, user } = analystPrompt(event, rev);
        const out = await request('POST', '/chat/completions', {
          model,
          temperature: 0.2,
          max_completion_tokens: 2000,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: `${system}\nReply with a single JSON object with exactly these string fields: ${Object.keys(ANALYST_SCHEMA.properties).join(', ')}. ${Object.entries(ANALYST_SCHEMA.properties).map(([k, v]) => `${k}: ${v.description}`).join(' ')}` },
            { role: 'user', content: user },
          ],
        });
        const choice = out?.choices?.[0];
        if (choice?.finish_reason && choice.finish_reason !== 'stop') throw new Error(`generation stopped (${choice.finish_reason})`);
        const parsed = parseNarrative(choice?.message?.content);
        Object.assign(status, { status: 'connected', lastOkAt: now(), lastError: null, note: `narrative generated by ${out.model || model} via Groq` });
        return {
          author: `Groq (${out.model || model})`,
          provenance: 'AI_HYPOTHESIS',
          summary: parsed.summary.slice(0, 2000),
          wouldConfirm: String(parsed.wouldConfirm || fallback.wouldConfirm).slice(0, 600),
          wouldInvalidate: String(parsed.wouldInvalidate || fallback.wouldInvalidate).slice(0, 600),
        };
      } catch (err) {
        release();
        const why = redact(err.message, apiKey);
        // Budget / pause are expected on the free tier: degraded, not broken.
        const soft = /rate limited|daily Groq budget/.test(why);
        Object.assign(status, { status: soft ? 'degraded' : 'disconnected', lastError: why, note: `${soft ? 'template in use' : 'last narrative request failed'}: ${why}` });
        return { ...fallback, note: `Groq unavailable: ${why}` };
      }
    },
  };
}
