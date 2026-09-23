// About page: fills the track-record sections from LIVE PRED Memory
// (/api/memory). With no resolved real events it says so and shows no numbers.
import { reliability } from './charts.js';
import { esc, CAT, FAILURE_LABEL } from './fmt.js';

const $ = (id) => document.getElementById(id);
const pctOf = (r, min = 5) => (r?.rate == null || r.n < min ? '—' : `${Math.round(r.rate * 100)}%`);

function outcomeBadge(r) {
  if (r.actualCategory === 'LIQUIDITY') return '<span class="st liq">Liquidity noise</span>';
  if (r.status === 'CONFIRMED') return '<span class="st ok">Confirmed</span>';
  if (r.status === 'INVALIDATED') return '<span class="st bad">Invalidated</span>';
  return '<span class="st un">Unresolved</span>';
}

async function load() {
  let m;
  try {
    const res = await fetch('/api/memory');
    if (!res.ok) throw new Error(String(res.status));
    m = await res.json();
  } catch {
    $('eventRows').innerHTML = '<tr><td colspan="5" class="empty-row">LIVE MEMORY unavailable on this deployment.</td></tr>';
    return;
  }
  const a = m.accuracy;
  const few = m.verifiedEvents < 5;
  $('kpis').innerHTML = [
    ['Live events', m.total, `${m.verifiedEvents} verified`],
    ['Direction accuracy', pctOf(a.direction), a.direction.n ? `n=${a.direction.n}` : 'insufficient live history'],
    ['Catalyst accuracy', pctOf(a.catalyst), a.catalyst.n ? `n=${a.catalyst.n}` : 'insufficient live history'],
    ['Within predicted range', pctOf(a.reactionRange), a.reactionRange.n ? `n=${a.reactionRange.n}` : 'insufficient live history'],
    ['Brier score', few || m.calibration.brier == null ? '—' : m.calibration.brier, few ? 'needs ≥5 verified events' : 'lower is better'],
  ]
    .map(([l, v, s]) => `<div class="kpi"><span>${l}</span><b>${esc(v)}</b><small>${esc(s)}</small></div>`)
    .join('');

  $('eventRows').innerHTML = (m.recent || []).length
    ? m.recent
        .slice(0, 6)
        .map((r) => `<tr><td class="m">#${esc(r.code.replace('GHOST EVENT #', ''))}</td><td><b>${esc(r.ticker)}</b></td><td>${esc(CAT[r.initialPrimary?.key]?.short || '—')}</td><td><div class="conf"><i style="--w:${r.initialPrimary?.probability || 0}%"></i><span>${r.initialPrimary?.probability ?? '—'}%</span></div></td><td>${outcomeBadge(r)}</td></tr>`)
        .join('')
    : '<tr><td colspan="5" class="empty-row">PRED MEMORY · 0 verified events.<br/>Real Ghost Events will appear here once they resolve.</td></tr>';

  if (m.calibration.n) reliability($('relChart'), m.calibration.bins);
  else $('relChart').innerHTML = '<div class="cap" style="padding:40px 0;text-align:center">Insufficient live history</div>';

  const max = Math.max(1, ...Object.values(m.failures));
  $('failList').innerHTML = Object.values(m.failures).some(Boolean)
    ? Object.entries(m.failures)
        .sort((x, y) => y[1] - x[1])
        .map(([k, v]) => `<div class="fail"><span>${FAILURE_LABEL[k]}</span><i style="--w:${(v / max) * 100}%"></i><b>${v}</b></div>`)
        .join('')
    : '<div class="cap">No evaluated live events yet.</div>';

  const mix = [
    ['Confirmed catalysts', m.confirmedCatalysts, 'var(--good)'],
    ['Liquidity anomalies', m.liquidityAnomalies, 'var(--warning)'],
    ['False hypotheses', m.falseHypotheses, 'var(--critical)'],
    ['Unresolved / other', m.unresolvedOther, '#c3c5d4'],
  ];
  $('mix').innerHTML = m.total
    ? `<div class="mixbar">${mix.map(([, v, c]) => `<i style="flex:${v};background:${c}"></i>`).join('')}</div>` + mix.map(([l, v, c]) => `<div class="mixrow"><span><i style="background:${c}"></i>${l}</span><b>${v}</b></div>`).join('')
    : '<div class="cap">0 live events recorded so far.</div>';
}

const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries) if (e.isIntersecting) {
      e.target.classList.add('in');
      io.unobserve(e.target);
    }
  },
  { rootMargin: '0px 0px -10% 0px' },
);
document.querySelectorAll('.section .wrap > *, .cta-in > *').forEach((el) => {
  el.classList.add('reveal');
  io.observe(el);
});

load();
