// Structured logging. One line per operation:
//   [2026-09-22T21:14:07.412Z] [INVESTIGATOR] [live-12] SEC_QUERY SUCCESS 412ms …
// Set PRED_LOG_FORMAT=json for JSON lines. Never pass secrets or request
// headers to the logger.

const recent = [];

export function logOp({ component, op, status = 'SUCCESS', eventId = null, durationMs = null, error = null, ...fields }) {
  const entry = { ts: new Date().toISOString(), component: String(component).toUpperCase(), eventId, op, status, durationMs: durationMs == null ? null : Math.round(durationMs), error: error ? String(error.message || error).slice(0, 300) : null, ...fields };
  recent.push(entry);
  if (recent.length > 500) recent.splice(0, recent.length - 500);
  if (process.env.PRED_LOG_LEVEL === 'silent') return entry;
  if (process.env.PRED_LOG_FORMAT === 'json') console.log(JSON.stringify(entry));
  else {
    const extra = Object.entries(fields)
      .filter(([, v]) => v != null && typeof v !== 'object')
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    console.log(`[${entry.ts}] [${entry.component}]${eventId ? ` [${eventId}]` : ''} ${op} ${status}${entry.durationMs != null ? ` ${entry.durationMs}ms` : ''}${extra ? ` ${extra}` : ''}${entry.error ? ` error="${entry.error}"` : ''}`);
  }
  return entry;
}

export async function timed(meta, fn) {
  const t0 = Date.now();
  try {
    const out = await fn();
    logOp({ ...meta, status: 'SUCCESS', durationMs: Date.now() - t0 });
    return out;
  } catch (err) {
    logOp({ ...meta, status: 'FAILURE', durationMs: Date.now() - t0, error: err });
    throw err;
  }
}

export const recentLogs = (n = 100) => recent.slice(-n);
