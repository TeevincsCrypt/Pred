// Inline-SVG charts. One axis per chart, thin marks, recessive grid, hover
// layer on every plotted chart.
import { esc, pct, et, etFull } from './fmt.js';

const NS = 'http://www.w3.org/2000/svg';
const tip = () => document.getElementById('tooltip');

export function showTip(evt, html) {
  const t = tip();
  t.innerHTML = html;
  t.hidden = false;
  const pad = 14;
  const w = t.offsetWidth;
  const h = t.offsetHeight;
  let x = evt.clientX + pad;
  let y = evt.clientY + pad;
  if (x + w > window.innerWidth - 8) x = evt.clientX - w - pad;
  if (y + h > window.innerHeight - 8) y = evt.clientY - h - pad;
  t.style.left = `${x}px`;
  t.style.top = `${y}px`;
}
export const hideTip = () => (tip().hidden = true);

export function sparkline(values, { w = 64, h = 26, color } = {}) {
  if (!values || values.length < 2) return `<svg width="${w}" height="${h}"></svg>`;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - lo) / span) * (h - 4)).toFixed(1)}`).join(' ');
  const c = color || (values.at(-1) >= values[0] ? 'var(--good-text)' : 'var(--critical-text)');
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${c}" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
}

// Event price chart with lifecycle markers and a crosshair tooltip.
export function priceChart(el, chart) {
  el.innerHTML = '';
  const pts = chart?.points || [];
  if (pts.length < 2) {
    el.innerHTML = '<div class="empty">Waiting for price data…</div>';
    return;
  }
  const W = el.clientWidth || 600;
  const H = 210;
  const m = { l: 8, r: 58, t: 10, b: 22 };
  const x0 = pts[0].ts;
  const x1 = pts.at(-1).ts;
  const ys = pts.map((p) => p.c).concat(chart.priceBefore);
  let lo = Math.min(...ys);
  let hi = Math.max(...ys);
  const padY = (hi - lo) * 0.12 || 1;
  lo -= padY;
  hi += padY;
  const X = (t) => m.l + ((t - x0) / (x1 - x0 || 1)) * (W - m.l - m.r);
  const Y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', H);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Price around the Ghost Event');

  let s = '';
  for (let i = 0; i <= 4; i++) {
    const v = lo + ((hi - lo) * i) / 4;
    s += `<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/><text class="axis" x="${W - m.r + 6}" y="${Y(v) + 3}" style="fill:var(--text-muted);font:10px var(--mono)">${v.toFixed(2)}</text>`;
  }
  const ticks = 5;
  for (let i = 0; i <= ticks; i++) {
    const t = x0 + ((x1 - x0) * i) / ticks;
    s += `<text x="${X(t)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === ticks ? 'end' : 'middle'}" style="fill:var(--text-muted);font:10px var(--mono)">${et(t)}</text>`;
  }
  s += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(chart.priceBefore)}" y2="${Y(chart.priceBefore)}" stroke="var(--text-muted)" stroke-dasharray="2 4"/>`;
  s += `<text x="${m.l + 2}" y="${Y(chart.priceBefore) - 4}" style="fill:var(--text-muted);font:9.5px var(--mono)">pre-move ${chart.priceBefore.toFixed(2)}</text>`;
  const colors = { detect: 'var(--accent)', resolve: 'var(--good)', predict: 'var(--prov-ai)', session: 'var(--text-muted)', outcome: 'var(--prov-hist)' };
  const placed = [];
  for (const mk of chart.markers) {
    if (mk.ts < x0 || mk.ts > x1) continue;
    const x = X(mk.ts);
    const row = placed.filter((px) => Math.abs(px - x) < 70).length;
    placed.push(x);
    s += `<line x1="${x}" x2="${x}" y1="${m.t}" y2="${H - m.b}" stroke="${colors[mk.kind]}" stroke-width="1" stroke-dasharray="${mk.kind === 'session' ? '2 3' : '0'}" opacity="0.8"/>`;
    const right = x > W - m.r - 90;
    s += `<text x="${right ? x - 4 : x + 4}" text-anchor="${right ? 'end' : 'start'}" y="${m.t + 10 + row * 12}" style="fill:${colors[mk.kind]};font:600 9.5px var(--mono)">${esc(mk.label)}</text>`;
  }
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.ts).toFixed(1)},${Y(p.c).toFixed(1)}`).join('');
  const area = `${path}L${X(x1)},${H - m.b}L${X(x0)},${H - m.b}Z`;
  s += `<defs><linearGradient id="pg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity="0.18"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>`;
  s += `<path d="${area}" fill="url(#pg)"/><path d="${path}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>`;
  s += `<line class="crosshair" id="ch" y1="${m.t}" y2="${H - m.b}" visibility="hidden"/><circle id="chd" r="4" fill="var(--accent)" stroke="var(--surface-1)" stroke-width="2" visibility="hidden"/>`;
  s += `<rect x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="transparent" id="hit"/>`;
  svg.innerHTML = s;
  el.appendChild(svg);
  const hit = svg.querySelector('#hit');
  const ch = svg.querySelector('#ch');
  const chd = svg.querySelector('#chd');
  hit.addEventListener('mousemove', (e) => {
    const r = svg.getBoundingClientRect();
    const t = x0 + ((((e.clientX - r.left) / r.width) * W - m.l) / (W - m.l - m.r)) * (x1 - x0);
    let best = pts[0];
    for (const p of pts) if (Math.abs(p.ts - t) < Math.abs(best.ts - t)) best = p;
    ch.setAttribute('x1', X(best.ts));
    ch.setAttribute('x2', X(best.ts));
    ch.setAttribute('visibility', 'visible');
    chd.setAttribute('cx', X(best.ts));
    chd.setAttribute('cy', Y(best.c));
    chd.setAttribute('visibility', 'visible');
    showTip(e, `<div class="tt-title">${best.c.toFixed(2)}</div><div class="tt-sub">${etFull(best.ts)} · vs pre-move ${pct((best.c / chart.priceBefore - 1) * 100)}</div>`);
  });
  hit.addEventListener('mouseleave', () => {
    ch.setAttribute('visibility', 'hidden');
    chd.setAttribute('visibility', 'hidden');
    hideTip();
  });
}

// Reaction range: comparable range, model estimate, and (later) the actual.
export function rangeViz(pred, actual) {
  const vals = [pred.rangeLowPct, pred.rangeHighPct, pred.estimatePct, 0, actual ?? pred.estimatePct];
  const lo = Math.min(...vals) - 0.8;
  const hi = Math.max(...vals) + 0.8;
  const W = 340;
  const H = 58;
  const X = (v) => 10 + ((v - lo) / (hi - lo)) * (W - 20);
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Predicted reaction range">`;
  s += `<line x1="10" x2="${W - 10}" y1="30" y2="30" stroke="var(--border-strong)"/>`;
  s += `<line x1="${X(0)}" x2="${X(0)}" y1="20" y2="40" stroke="var(--text-muted)" stroke-dasharray="2 2"/><text x="${X(0)}" y="54" text-anchor="middle" style="fill:var(--text-muted);font:9.5px var(--mono)">0%</text>`;
  s += `<rect x="${X(pred.rangeLowPct)}" y="24" width="${Math.max(2, X(pred.rangeHighPct) - X(pred.rangeLowPct))}" height="12" rx="4" fill="var(--prov-ai)" opacity="0.28" stroke="var(--prov-ai)"/>`;
  s += `<text x="${X(pred.rangeLowPct)}" y="18" text-anchor="middle" style="fill:var(--text-secondary);font:9.5px var(--mono)">${pct(pred.rangeLowPct)}</text><text x="${X(pred.rangeHighPct)}" y="18" text-anchor="middle" style="fill:var(--text-secondary);font:9.5px var(--mono)">${pct(pred.rangeHighPct)}</text>`;
  s += `<line x1="${X(pred.estimatePct)}" x2="${X(pred.estimatePct)}" y1="21" y2="39" stroke="var(--prov-ai)" stroke-width="3"/>`;
  if (actual != null) {
    s += `<circle cx="${X(actual)}" cy="30" r="6" fill="var(--accent)" stroke="var(--surface-1)" stroke-width="2"/><text x="${X(actual)}" y="54" text-anchor="middle" style="fill:var(--accent);font:600 10px var(--mono)">actual ${pct(actual)}</text>`;
  }
  return s + '</svg>';
}

// Reliability diagram: stated probability vs observed hit rate per bin.
export function reliability(el, bins) {
  const W = 260;
  const H = 190;
  const m = { l: 30, r: 10, t: 8, b: 26 };
  const X = (v) => m.l + v * (W - m.l - m.r);
  const Y = (v) => m.t + (1 - v) * (H - m.t - m.b);
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Calibration: stated vs observed">`;
  for (const v of [0, 0.25, 0.5, 0.75, 1]) {
    s += `<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${m.l - 5}" y="${Y(v) + 3}" text-anchor="end" style="fill:var(--text-muted);font:9.5px var(--mono)">${v * 100}</text>`;
    s += `<text x="${X(v)}" y="${H - 10}" text-anchor="middle" style="fill:var(--text-muted);font:9.5px var(--mono)">${v * 100}</text>`;
  }
  s += `<text x="${(W + m.l) / 2}" y="${H}" text-anchor="middle" style="fill:var(--text-muted);font:9px var(--mono)">stated confidence %</text>`;
  s += `<line x1="${X(0)}" y1="${Y(0)}" x2="${X(1)}" y2="${Y(1)}" stroke="var(--text-muted)" stroke-dasharray="3 3"/>`;
  const pts = bins.filter((b) => b.n);
  s += `<polyline points="${pts.map((b) => `${X(b.stated)},${Y(b.observed)}`).join(' ')}" fill="none" stroke="var(--accent)" stroke-width="2"/>`;
  pts.forEach((b, i) => {
    s += `<circle data-i="${i}" cx="${X(b.stated)}" cy="${Y(b.observed)}" r="${4 + Math.min(5, b.n / 8)}" fill="var(--accent)" stroke="var(--surface-2)" stroke-width="2"/>`;
  });
  el.innerHTML = s + '</svg>';
  el.querySelectorAll('circle').forEach((c) => {
    const b = pts[+c.dataset.i];
    c.addEventListener('mousemove', (e) => showTip(e, `<div class="tt-title">Bin ${esc(b.range)}</div><div class="tt-sub">stated ${Math.round(b.stated * 100)}% · observed ${Math.round(b.observed * 100)}% · n=${b.n}</div>`));
    c.addEventListener('mouseleave', hideTip);
  });
}

// Brier score per chronological window (lower is better).
export function brierLine(el, windows) {
  const W = 260;
  const H = 190;
  const m = { l: 34, r: 10, t: 10, b: 26 };
  if (!windows.length) {
    el.innerHTML = '<div class="empty">Not enough resolved events yet.</div>';
    return;
  }
  const hi = Math.max(0.3, ...windows.map((w) => w.brier));
  const X = (i) => m.l + (windows.length === 1 ? 0.5 : i / (windows.length - 1)) * (W - m.l - m.r);
  const Y = (v) => m.t + (1 - v / hi) * (H - m.t - m.b);
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Brier score over time">`;
  for (const v of [0, hi / 2, hi]) s += `<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${m.l - 5}" y="${Y(v) + 3}" text-anchor="end" style="fill:var(--text-muted);font:9.5px var(--mono)">${v.toFixed(2)}</text>`;
  s += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(0.25)}" y2="${Y(0.25)}" stroke="var(--serious)" stroke-dasharray="3 3" opacity="0.7"/><text x="${W - m.r}" y="${Y(0.25) - 4}" text-anchor="end" style="fill:var(--serious);font:9px var(--mono)">coin-flip 0.25</text>`;
  s += `<polyline points="${windows.map((w, i) => `${X(i)},${Y(w.brier)}`).join(' ')}" fill="none" stroke="var(--prov-hist)" stroke-width="2"/>`;
  windows.forEach((w, i) => {
    s += `<circle data-i="${i}" cx="${X(i)}" cy="${Y(w.brier)}" r="4.5" fill="var(--prov-hist)" stroke="var(--surface-2)" stroke-width="2"/>`;
  });
  s += `<text x="${m.l}" y="${H - 8}" style="fill:var(--text-muted);font:9.5px var(--mono)">${new Date(windows[0].from).toISOString().slice(5, 10)}</text><text x="${W - m.r}" y="${H - 8}" text-anchor="end" style="fill:var(--text-muted);font:9.5px var(--mono)">${new Date(windows.at(-1).to).toISOString().slice(5, 10)}</text>`;
  el.innerHTML = s + '</svg>';
  el.querySelectorAll('circle').forEach((c) => {
    const w = windows[+c.dataset.i];
    c.addEventListener('mousemove', (e) => showTip(e, `<div class="tt-title">Brier ${w.brier.toFixed(3)}</div><div class="tt-sub">${w.n} events · stated ${Math.round(w.stated * 100)}% vs observed ${Math.round(w.observed * 100)}% · ${w.provenance.join(', ')}</div>`));
    c.addEventListener('mouseleave', hideTip);
  });
}
