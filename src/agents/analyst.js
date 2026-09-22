// Optional Claude analyst. When ANTHROPIC_API_KEY is set, it writes a short
// narrative for each hypothesis revision, constrained to the evidence PRED
// collected. It never changes the probabilities — those come from the
// transparent scoring model — and its output is labeled AI HYPOTHESIS.
// Without a key, PRED uses a deterministic template narrative.

const MODEL = process.env.PRED_CLAUDE_MODEL || 'claude-opus-5';

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

export function createAnalyst({ enabled = !!process.env.ANTHROPIC_API_KEY } = {}) {
  let client = null;
  async function getClient() {
    if (client) return client;
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    client = new Anthropic();
    return client;
  }
  return {
    enabled,
    model: enabled ? MODEL : null,
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
        const res = await c.beta.messages.create({
          model: MODEL,
          max_tokens: 2000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
          system:
            'You are the analyst inside PRED, a market event-intelligence system for tokenized equities. Explain the leading catalyst hypothesis using ONLY the evidence listed. Cite evidence ids. Never invent facts, sources, or numbers. Probabilities are model confidence estimates; do not restate them as certainties.',
          messages: [{ role: 'user', content: `Ghost Event ${event.code} on ${event.ticker} (${event.asset.company}).\n\nHypotheses (model estimates):\n${hyps}\n\nEvidence:\n${evidence}` }],
        });
        if (res.stop_reason !== 'end_turn') return fallback;
        const text = res.content.find((b) => b.type === 'text')?.text;
        const parsed = JSON.parse(text);
        return { author: `Claude (${res.model})`, provenance: 'AI_HYPOTHESIS', ...parsed };
      } catch (err) {
        return { ...fallback, note: `Claude unavailable: ${err.message}` };
      }
    },
  };
}
