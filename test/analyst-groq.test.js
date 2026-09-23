// Groq analyst against a MOCKED Groq API (no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGroqAnalyst } from '../src/agents/analyst-groq.js';
import { selectAnalyst } from '../src/agents/analyst-select.js';

const KEY = 'gsk_testsecretkey123456';
const event = { code: 'GHOST EVENT #7', ticker: 'NVDA-PERP', asset: { company: 'NVIDIA' }, evidence: [{ id: 'E7-1', provenance: 'LIVE', kind: 'PRICE_ANOMALY', title: 'NVDA +4.8% while closed', detail: 'Bitget' }] };
const rev = { hypotheses: [{ key: 'COMPANY_SPECIFIC', title: 'Company-specific catalyst', probability: 62, evidenceFor: [{ reason: 'move not explained by peers', evidenceId: 'E7-1' }], evidenceAgainst: [] }, { key: 'UNKNOWN', title: 'Unknown / unexplained', probability: 20, evidenceFor: [], evidenceAgainst: [] }] };
const res = (status, body, headers = {}) => ({ ok: status < 300, status, headers: new Map(Object.entries(headers)), text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const chat = (content, finish = 'stop') => res(200, { model: 'openai/gpt-oss-120b', choices: [{ finish_reason: finish, message: { content } }] });

test('Groq: narrative from JSON (even wrapped in fences), request shape, no secrets', async () => {
  const calls = [];
  const a = createGroqAnalyst({ apiKey: KEY, model: 'openai/gpt-oss-120b', minIntervalMs: 0, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return chat('```json\n{"summary":"Company-specific catalyst leads [E7-1].","wouldConfirm":"An 8-K.","wouldInvalidate":"Full reversal."}\n```');
  } });
  const n = await a.narrate(event, rev);
  assert.equal(n.author, 'Groq (openai/gpt-oss-120b)');
  assert.equal(n.provenance, 'AI_HYPOTHESIS');
  assert.match(n.summary, /\[E7-1\]/);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(calls[0].url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(body.model, 'openai/gpt-oss-120b');
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${KEY}`);
  assert.ok(body.messages[1].content.includes('[E7-1]'), 'the model only sees PRED evidence');
  assert.equal(a.status.status, 'connected');
  assert.ok(!JSON.stringify(a.status).includes(KEY));
});

test('Groq: 429 pauses calls and falls back to the template (degraded, not broken)', async () => {
  let n = 0;
  const a = createGroqAnalyst({ apiKey: KEY, model: 'm', minIntervalMs: 0, fetchImpl: async () => (n++, res(429, { error: { message: `Rate limit reached for key ${KEY}` } }, { 'retry-after': '30' })) });
  const r1 = await a.narrate(event, rev);
  assert.equal(r1.author, 'PRED template');
  assert.equal(a.status.status, 'degraded');
  assert.ok(!JSON.stringify(a.status).includes(KEY), 'key redacted from errors');
  const r2 = await a.narrate(event, rev);
  assert.equal(r2.author, 'PRED template');
  assert.equal(n, 1, 'paused: no second request during Retry-After');
});

test('Groq: bad JSON / truncated output / auth errors → template; daily cap honoured', async () => {
  for (const [resp, re] of [[chat('not json'), /./], [chat('{"summary":"x"', 'length'), /length/], [res(401, { error: { message: 'Invalid API Key' } }), /401/]]) {
    const a = createGroqAnalyst({ apiKey: KEY, model: 'm', minIntervalMs: 0, fetchImpl: async () => resp });
    const r = await a.narrate(event, rev);
    assert.equal(r.author, 'PRED template');
    assert.match(a.status.lastError, re);
  }
  let n = 0;
  const capped = createGroqAnalyst({ apiKey: KEY, model: 'm', minIntervalMs: 0, dailyCap: 2, fetchImpl: async () => (n++, chat('{"summary":"ok","wouldConfirm":"a","wouldInvalidate":"b"}')) });
  for (let i = 0; i < 4; i++) await capped.narrate(event, rev);
  assert.equal(n, 2);
  assert.match(capped.status.note, /daily Groq budget/);
});

test('Groq: startup check verifies the configured model is served', async () => {
  const ok = createGroqAnalyst({ apiKey: KEY, model: 'openai/gpt-oss-120b', fetchImpl: async () => res(200, { data: [{ id: 'openai/gpt-oss-120b' }, { id: 'openai/gpt-oss-20b' }] }) });
  assert.equal((await ok.probe()).status, 'connected');
  const gone = createGroqAnalyst({ apiKey: KEY, model: 'llama-3.3-70b-versatile', fetchImpl: async () => res(200, { data: [{ id: 'openai/gpt-oss-120b' }] }) });
  const st = await gone.probe();
  assert.equal(st.status, 'disconnected');
  assert.match(st.note, /not available/);
});

test('provider selection: Claude if configured, else Groq, else none; PRED_ANALYST forces', () => {
  assert.equal(selectAnalyst({ GROQ_API_KEY: KEY, GROQ_MODEL: 'm' }).provider, 'groq');
  assert.equal(selectAnalyst({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_MODEL: 'claude-opus-5', GROQ_API_KEY: KEY, GROQ_MODEL: 'm' }).provider, 'claude');
  assert.equal(selectAnalyst({ PRED_ANALYST: 'groq', ANTHROPIC_API_KEY: 'k', ANTHROPIC_MODEL: 'c', GROQ_API_KEY: KEY, GROQ_MODEL: 'm' }).provider, 'groq');
  const none = selectAnalyst({});
  assert.equal(none.enabled, false);
  assert.equal(selectAnalyst({ GROQ_API_KEY: KEY }).enabled, false, 'GROQ_MODEL is required (never hard-coded)');
});
