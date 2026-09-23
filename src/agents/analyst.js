// Optional Claude analyst. When ANTHROPIC_API_KEY is set, it writes a short
// narrative for each hypothesis revision, constrained to the evidence PRED
// collected. It never changes the probabilities — those come from the
// transparent scoring model — and its output is labeled AI HYPOTHESIS.
// Without a key, PRED uses a deterministic template narrative.
//
// Claude never controls prices, confidence numbers, trade decisions or
// event confirmation. Configure with ANTHROPIC_API_KEY + ANTHROPIC_MODEL
// (e.g. ANTHROPIC_MODEL=claude-opus-5); the model is validated against the
// Models API at startup and reported honestly in the status panel.

const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Two to three sentences explaining the leading hypothesis, citing evidence ids like [E184-3].' },
    wouldConfirm: { type: 'string', description: 'What specific evidence would confirm it.' },
    wouldInvalidate: { type: 'string', description: 'What specific evidence would invalidate it.' },
  },
  required: ['summary', 'wouldConfirm', 'wouldInvalidate'],
  additionalProperties: false,
};

export function templateNarrative(event, rev) {
  const p = rev.hypotheses[0];
  const s = rev.hypotheses[1];
  const cite = (list) => list.slice(0, 3).map((c) => `${c.reason} [${c.evidenceId}]`).join('; ');
  return {
    author: 'PRED template',
    provenance: 'AI_HYPOTHESIS',
    summary: `${p.title} leads at ${p.probability}% (model estimate), ahead of ${s.title.toLowerCase()} at ${s.probability}%. ${p.evidenceFor.length ? `Support: ${cite(p.evidenceFor)}.` : 'Support is thin.'}${p.evidenceAgainst.length ? ` Against: ${cite(p.evidenceAgainst)}.` : ''}`,
    wouldConfirm: {
      COMPANY_SPECIFIC: `An official ${event.asset.company} release or material SEC filing, or the move holding into the open.`,
      SECTOR_REPRICING: `Peers continuing to move with ${event.ticker}; sector-wide coverage.`,
      MACRO_CRYPTO: 'Crypto and other tokenized equities moving together; macro headlines.',
      LIQUIDITY: 'Full mean reversion as liquidity returns, with no news.',
      SCHEDULED: 'The scheduled event occurring as listed.',
      UNKNOWN: 'Any source-backed explanation.',
    }[p.key],
    wouldInvalidate: {
      COMPANY_SPECIFIC: 'The move fully reverting with no company news, or an unrelated catalyst.',
      SECTOR_REPRICING: `Peers diverging from ${event.ticker}.`,
      MACRO_CRYPTO: 'Crypto reversing while the move holds.',
      LIQUIDITY: 'The move holding on heavy volume, or company news appearing.',
      SCHEDULED: 'The event being unrelated or rescheduled.',
      UNKNOWN: 'A confirmed catalyst.',
    }[p.key],
  };
}

// A short, secret-free reason for the status panel. The SDK's typed errors
// carry the HTTP status; the API key never appears in them.
function describeError(err) {
  const status = err?.status ? `HTTP ${err.status} ` : '';
  const hint = { 401: '(invalid ANTHROPIC_API_KEY)', 403: '(key lacks access)', 404: '(ANTHROPIC_MODEL not available to this key)', 429: '(rate limited)', 529: '(API overloaded)' }[err?.status] || '';
  const msg = String(err?.error?.error?.message || err?.message || err).replace(/sk-ant-[\w-]+/g, '[redacted]');
  return `${status}${hint} ${msg}`.replace(/\s+/g, ' ').trim().slice(0, 220);
}

export function createAnalyst({ apiKey = process.env.ANTHROPIC_API_KEY, model = process.env.ANTHROPIC_MODEL || process.env.PRED_CLAUDE_MODEL } = {}) {
  const enabled = !!(apiKey && model);
  const MODEL = model || null;
  const status = { status: !apiKey ? 'not_configured' : !model ? 'not_configured' : 'unknown', note: !apiKey ? 'Optional — set ANTHROPIC_API_KEY and ANTHROPIC_MODEL' : !model ? 'ANTHROPIC_MODEL not set' : 'not checked yet', lastOkAt: null, lastError: null };
  let client = null;
  async function getClient() {
    if (client) return client;
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    client = new Anthropic();
    return client;
  }
  return {
    enabled,
    model: MODEL,
    status,

    // Confirms the configured model exists for this key (Models API). Never throws.
    async probe() {
      if (!enabled) return status;
      try {
        const c = await getClient();
        const m = await c.models.retrieve(MODEL);
        Object.assign(status, { status: 'connected', note: `${m.display_name || m.id}`, lastOkAt: Date.now(), lastError: null });
      } catch (err) {
        Object.assign(status, { status: 'disconnected', note: `model check failed: ${describeError(err)}`, lastError: describeError(err) });
      }
      return status;
    },
    async narrate(event, rev) {
      const fallback = templateNarrative(event, rev);
      if (!enabled) return fallback;
      try {
        const c = await getClient();
        const evidence = event.evidence
          .filter((e) => !e.superseded)
          .map((e) => `[${e.id}] (${e.provenance}) ${e.kind}: ${e.title} — ${e.detail || ''}`)
          .join('\n');
        const hyps = rev.hypotheses.map((h) => `${h.title}: ${h.probability}%`).join('\n');
        const res = await c.messages.create({
          model: MODEL,
          // Current models think by default; leave room for thinking plus the JSON.
          max_tokens: 16000,
          output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
          system:
            'You are the analyst inside PRED, a market event-intelligence system for tokenized equities. Explain the leading catalyst hypothesis using ONLY the evidence listed. Cite evidence ids. Never invent facts, sources, or numbers. Probabilities are model confidence estimates; do not restate them as certainties.',
          messages: [{ role: 'user', content: `Ghost Event ${event.code} on ${event.ticker} (${event.asset.company}).\n\nHypotheses (model estimates):\n${hyps}\n\nEvidence:\n${evidence}` }],
        });
        if (res.stop_reason !== 'end_turn') {
          Object.assign(status, { status: 'connected', lastOkAt: Date.now(), note: `last request stopped: ${res.stop_reason}` });
          return { ...fallback, note: `Claude stopped (${res.stop_reason}); template narrative shown` };
        }
        const text = res.content.find((b) => b.type === 'text')?.text;
        const parsed = JSON.parse(text);
        if (typeof parsed.summary !== 'string') throw new Error('unexpected analyst output');
        Object.assign(status, { status: 'connected', lastOkAt: Date.now(), lastError: null, note: `narrative generated by ${res.model}` });
        return { author: `Claude (${res.model})`, provenance: 'AI_HYPOTHESIS', summary: parsed.summary.slice(0, 2000), wouldConfirm: String(parsed.wouldConfirm || '').slice(0, 600), wouldInvalidate: String(parsed.wouldInvalidate || '').slice(0, 600) };
      } catch (err) {
        const why = describeError(err);
        Object.assign(status, { status: 'disconnected', lastError: why, note: `last narrative request failed: ${why}` });
        return { ...fallback, note: `Claude unavailable: ${why}` };
      }
    },
  };
}
