// Landing page: fills the track-record sections from PRED Memory's
// simulated backtest and adds scroll reveals.
import { reliability } from './charts.js';
import { esc, CAT, FAILURE_LABEL } from './fmt.js';

const $ = (id) => document.getElementById(id);
const pctOf = (r) => (r?.rate == null ? '—' : `${Math.round(r.rate * 100)}%`);

function outcomeBadge(r) {
  if (r.actualCategory === 'LIQUIDITY') return '<span class="st liq">Liquidity noise</span>';
  if (r.status === 'CONFIRMED') return '<span class="st ok">Confirmed</span>';
  if (r.status === 'INVALIDATED') return '<span class="st bad">Invalidated</span>';
  return '<span class="st un">Unresolved</span>';
}

async function load() {
  let tr;
  try {
    tr = await (await fetch('/api/track-record')).json();
  } catch {
    $('eventRows').innerHTML = '<tr><td colspan="5" class="muted">PRED Memory unavailable.</td></tr>';
    return;
  }
  const a = tr.accuracy;
  const kpis = [
    ['Events analyzed', tr.total, 'simulated backtest'],
    ['Direction accuracy', pctOf(a.direction), `n=${a.direction.n}`],
    ['Catalyst accuracy', pctOf(a.catalyst), `n=${a.catalyst.n}`],
    ['Within predicted range', pctOf(a.reactionRange), '20th–80th pct band'],
    ['Brier score', tr.calibration.brier ?? '—', 'lower is better · 0.25 = coin flip'],
  ];
  $('kpis').innerHTML = kpis.map(([l, v, s]) => `<div class="kpi"><span>${l}</span><b>${esc(v)}</b><small>${esc(s)}</small></div>`).join('');

  $('eventRows').innerHTML = (tr.recent || [])
    .slice(0, 6)
    .map(
      (r) => `<tr>
      <td class="m">#${r.code.replace('GHOST EVENT #', '')}</td>
      <td><b>${esc(r.ticker)}</b></td>
      <td>${esc(CAT[r.initialPrimary?.key]?.short || '—')}</td>
      <td><div class="conf"><i style="--w:${r.initialPrimary?.probability || 0}%"></i><span>${r.initialPrimary?.probability ?? '—'}%</span></div></td>
      <td>${outcomeBadge(r)}</td>
    </tr>`,
    )
    .join('');

  reliability($('relChart'), tr.calibration.bins);

  const max = Math.max(1, ...Object.values(tr.failures));
  $('failList').innerHTML = Object.entries(tr.failures)
    .sort((x, y) => y[1] - x[1])
    .map(([k, v]) => `<div class="fail"><span>${FAILURE_LABEL[k]}</span><i style="--w:${(v / max) * 100}%"></i><b>${v}</b></div>`)
    .join('');

  const mix = [
    ['Confirmed catalysts', tr.confirmedCatalysts, 'var(--good)'],
    ['Liquidity anomalies', tr.liquidityAnomalies, 'var(--warning)'],
    ['False hypotheses', tr.falseHypotheses, 'var(--critical)'],
    ['Unresolved / other', tr.unresolvedOther, '#c3c5d4'],
  ];
  $('mix').innerHTML =
    `<div class="mixbar">${mix.map(([, v, c]) => `<i style="flex:${v};background:${c}"></i>`).join('')}</div>` +
    mix.map(([l, v, c]) => `<div class="mixrow"><span><i style="background:${c}"></i>${l}</span><b>${v}</b></div>`).join('') +
    `<div class="cap">False-positive rate ${a.falsePositiveRate == null ? '—' : `${Math.round(a.falsePositiveRate * 100)}%`} · median time to confirmation ${a.medianTimeToConfirmationMin != null ? `${Math.round(a.medianTimeToConfirmationMin / 60)}h` : '—'}</div>`;
}

// Scroll reveal
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
