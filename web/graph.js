// Catalyst Graph renderer: five layered columns, bezier edges. Inference
// edges carry the weight the Hypothesis Agent actually applied.
import { esc, CAT, human } from './fmt.js';
import { showTip, hideTip } from './charts.js';

const LAYERS = ['ASSET', 'ANOMALIES', 'CORRELATIONS', 'INFORMATION', 'CATALYST HYPOTHESES'];
const seen = new Set();
let lastEventId = null;

const PROV_COLOR = { LIVE: 'var(--prov-live)', HISTORICAL: 'var(--prov-hist)', SIMULATED: 'var(--prov-sim)' };

export function renderGraph(el, event) {
  if (!event) {
    el.innerHTML = '<div class="empty">The graph builds itself as the Investigator collects evidence.</div>';
    return;
  }
  if (event.id !== lastEventId) {
    seen.clear();
    lastEventId = event.id;
  }
  const { nodes, edges } = event.graph;
  const evidenceById = Object.fromEntries(event.evidence.map((e) => [e.id, e]));
  const W = Math.max(el.clientWidth || 900, 640);
  const colW = W / LAYERS.length;
  const nodeW = Math.min(170, colW - 22);
  const nodeH = 38;
  const gap = 10;
  const byLayer = LAYERS.map((_, i) => nodes.filter((n) => n.layer === i));
  const maxN = Math.max(...byLayer.map((l) => l.length), 1);
  const H = Math.max(300, 34 + maxN * (nodeH + gap) + 10);
  const pos = {};
  byLayer.forEach((list, li) => {
    const total = list.length * (nodeH + gap) - gap;
    const top = 34 + (H - 34 - total) / 2;
    list.forEach((n, i) => {
      pos[n.id] = { x: li * colW + (colW - nodeW) / 2, y: top + i * (nodeH + gap), n };
    });
  });

  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Catalyst graph">`;
  LAYERS.forEach((l, i) => {
    s += `<text class="glayer" x="${i * colW + colW / 2}" y="16" text-anchor="middle">${l}</text>`;
    if (i) s += `<line x1="${i * colW}" x2="${i * colW}" y1="26" y2="${H - 6}" stroke="rgba(255,255,255,0.035)"/>`;
  });

  const maxW = Math.max(0.5, ...edges.filter((e) => e.weight).map((e) => Math.abs(e.weight)));
  for (const e of edges) {
    const a = pos[e.from];
    const b = pos[e.to];
    if (!a || !b) continue;
    const x1 = a.x + nodeW;
    const y1 = a.y + nodeH / 2;
    const x2 = b.x;
    const y2 = b.y + nodeH / 2;
    const dx = Math.max(40, (x2 - x1) / 2);
    const key = `${e.from}>${e.to}`;
    const cls = e.type === 'structural' ? 'structural' : e.polarity;
    const width = e.type === 'structural' ? 1.2 : 1 + (2.6 * Math.abs(e.weight)) / maxW;
    const op = e.type === 'structural' ? 0.9 : 0.35 + (0.5 * Math.abs(e.weight)) / maxW;
    s += `<path class="gedge ${cls} ${seen.has(key) ? '' : 'enter'}" d="M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}" stroke-width="${width.toFixed(2)}" opacity="${op.toFixed(2)}" data-e="${esc(key)}" data-w="${e.weight ?? ''}"/>`;
    seen.add(key);
  }

  for (const { x, y, n } of Object.values(pos)) {
    const isNew = !seen.has(n.id);
    seen.add(n.id);
    let cls = 'gnode';
    if (n.kind === 'ASSET') cls += ' asset';
    if (n.kind === 'HYPOTHESIS') {
      cls += ' hyp';
      if (n.rank === 'PRIMARY') cls += ' primary';
      if (n.confirmed === 'CONFIRMED') cls += ' confirmed';
      if (n.confirmed === 'INVALIDATED') cls += ' invalid';
    }
    s += `<g class="${cls} ${isNew ? 'enter' : ''}" data-id="${esc(n.id)}" transform="translate(${x},${y})">`;
    if (n.kind === 'HYPOTHESIS') {
      const c = CAT[n.id.slice(2)]?.color || 'var(--text-muted)';
      s += `<rect class="bg" width="${nodeW}" height="${nodeH}" rx="7"/>`;
      s += `<rect x="0" y="${nodeH - 4}" width="${(nodeW * n.probability) / 100}" height="4" rx="2" fill="${c}"/>`;
      s += `<circle cx="11" cy="13" r="4" fill="${c}"/>`;
      s += `<text x="20" y="17">${esc(trim(CAT[n.id.slice(2)]?.short || n.label, nodeW - 60))}</text><text class="sub" x="${nodeW - 8}" y="17" text-anchor="end">${esc(n.sub)}</text>`;
      if (n.confirmed) s += `<text class="sub" x="20" y="30" style="fill:${n.confirmed === 'CONFIRMED' ? 'var(--good-text)' : 'var(--critical-text)'}">${n.confirmed === 'CONFIRMED' ? '✓ CONFIRMED' : '✗ ACTUAL CAUSE'}</text>`;
    } else {
      s += `<rect width="${nodeW}" height="${nodeH}" rx="7"/>`;
      s += `<text x="10" y="${n.sub ? 16 : 23}">${esc(trim(n.label, nodeW - 24))}</text>`;
      if (n.sub) s += `<text class="sub" x="10" y="30">${esc(trim(n.sub, nodeW - 20))}</text>`;
      if (n.provenance) s += `<circle class="provdot" cx="${nodeW - 8}" cy="8" r="4" fill="${PROV_COLOR[n.provenance] || 'var(--text-muted)'}"/>`;
    }
    s += '</g>';
  }
  el.innerHTML = s + '</svg>';

  el.querySelectorAll('.gnode').forEach((g) => {
    const n = pos[g.dataset.id].n;
    g.addEventListener('mousemove', (e) => {
      let html;
      if (n.kind === 'HYPOTHESIS') html = `<div class="tt-title">${esc(n.label)} — ${n.probability}%</div><div class="tt-sub">Model confidence estimate</div>`;
      else if (n.evidenceIds) {
        html = n.evidenceIds
          .slice(0, 4)
          .map((id) => evidenceById[id])
          .filter(Boolean)
          .map((ev) => `<div class="tt-title">${esc(ev.title)}</div><div class="tt-sub">${esc(ev.detail || '')}</div><div class="tt-sub">${esc(ev.source)} · ${esc(ev.provenance)} · ${esc(ev.id)}</div>`)
          .join('<hr style="border:0;border-top:1px solid var(--border);margin:6px 0">');
      } else html = `<div class="tt-title">${esc(n.label)}</div>`;
      showTip(e, html);
    });
    g.addEventListener('mouseleave', hideTip);
  });
  el.querySelectorAll('.gedge[data-w]').forEach((p) => {
    if (!p.dataset.w) return;
    p.style.pointerEvents = 'stroke';
    p.addEventListener('mousemove', (e) => {
      const [from, to] = p.dataset.e.split('>');
      showTip(e, `<div class="tt-title">${esc(pos[from]?.n.label)} → ${esc(human(to.slice(2)).toLowerCase())}</div><div class="tt-sub">log-odds weight ${Number(p.dataset.w) > 0 ? '+' : ''}${p.dataset.w}</div>`);
    });
    p.addEventListener('mouseleave', hideTip);
  });
}

function trim(s, px) {
  const max = Math.floor(px / 6.3);
  s = String(s ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
