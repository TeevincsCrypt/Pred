// Chooses the optional AI analyst from the environment.
//   PRED_ANALYST=claude|groq forces one. Otherwise: Claude when ANTHROPIC_API_KEY
//   and ANTHROPIC_MODEL are set, else Groq when GROQ_API_KEY and GROQ_MODEL are
//   set, else none (PRED uses its deterministic template narrative).
import { createAnalyst } from './analyst.js';
import { createGroqAnalyst } from './analyst-groq.js';

export function selectAnalyst(env = process.env, { fetchImpl } = {}) {
  const want = String(env.PRED_ANALYST || '').toLowerCase();
  const claudeReady = !!(env.ANTHROPIC_API_KEY && (env.ANTHROPIC_MODEL || env.PRED_CLAUDE_MODEL));
  const groqReady = !!(env.GROQ_API_KEY && env.GROQ_MODEL);
  if (want === 'groq' || (want !== 'claude' && !claudeReady && groqReady)) {
    return createGroqAnalyst({ apiKey: env.GROQ_API_KEY, model: env.GROQ_MODEL, ...(fetchImpl ? { fetchImpl } : {}) });
  }
  return createAnalyst({ apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL || env.PRED_CLAUDE_MODEL });
}
