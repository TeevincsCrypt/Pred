export const CAT = {
  COMPANY_SPECIFIC: { color: 'var(--cat-company)', short: 'Company' },
  SECTOR_REPRICING: { color: 'var(--cat-sector)', short: 'Sector' },
  MACRO_CRYPTO: { color: 'var(--cat-macro)', short: 'Macro / crypto' },
  LIQUIDITY: { color: 'var(--cat-liquidity)', short: 'Liquidity' },
  SCHEDULED: { color: 'var(--cat-scheduled)', short: 'Scheduled' },
  UNKNOWN: { color: 'var(--cat-unknown)', short: 'Unknown' },
};

export const FAILURE_LABEL = {
  WRONG_CATALYST: 'Wrong catalyst',
  INSUFFICIENT_EVIDENCE: 'Insufficient evidence',
  LIQUIDITY_ANOMALY: 'Liquidity anomaly',
  UNRELATED_MARKET_MOVE: 'Unrelated market move',
  DELAYED_INFORMATION: 'Delayed information',
  CORRELATION_BREAKDOWN: 'Correlation breakdown',
  UNEXPECTED_EVENT: 'Unexpected event',
};

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const pct = (x, d = 2) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${Number(x).toFixed(d)}%`);
export const pctClass = (x) => (x == null ? '' : x >= 0 ? 'up' : 'down');
export const rate = (r) => (r?.rate == null ? '—' : `${Math.round(r.rate * 100)}%`);

const etFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const etDay = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' });
export const et = (ms) => (ms ? `${etFmt.format(ms)}` : '—');
export const etFull = (ms) => (ms ? `${etDay.format(ms)} ${etFmt.format(ms)} ET` : '—');

export function dur(ms) {
  if (ms == null) return '—';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.round(h / 24)}d`;
}

export const provTag = (p) => {
  const k = String(p || '').toLowerCase();
  const label = p === 'AI_HYPOTHESIS' ? 'AI HYPOTHESIS' : p;
  return p ? `<span class="tag tag-${k}">${esc(label)}</span>` : '';
};

export const human = (s) => String(s || '').replaceAll('_', ' ');
