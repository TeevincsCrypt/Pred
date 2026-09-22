import { esc, pct, pctClass, rate, et, etFull, dur, provTag, human, CAT, FAILURE_LABEL } from './fmt.js';
import { sparkline, priceChart, rangeViz, reliability, brierLine } from './charts.js';
import { renderGraph } from './graph.js';

const $ = (id) => document.getElementById(id);
const store = (k, v) => {
  try {
    if (v === undefined) return localStorage.getItem(k);
    localStorage.setItem(k, v);
  } catch {
    return null;
  }
};

const ui = {
  mode: new URLSearchParams(location.search).get('mode') || store('pred.mode') || 'demo',
  selected: null,
  revIndex: null, // null = latest
  openHyps: new Set(),
  tlSeen: 0,
  tlEvent: null,
  snap: null,
  es: null,
};

// ---------- connection ----------
function connect() {
  ui.es?.close();
  const q = new URLSearchParams({ mode: ui.mode });
  if (ui.selected) q.set('event', ui.selected);
  ui.es = new EventSource(`/api/stream?${q}`);
  ui.es.onmessage = (m) => render(JSON.parse(m.data));
  ui.es.onerror = () => {
    $('statusRow').dataset.err = '1';
  };
}

function setMode(mode) {
  ui.mode = mode;
  ui.selected = null;
  ui.revIndex = null;
  store('pred.mode', mode);
  document.querySelectorAll('.mode-switch button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  connect();
}

// ---------- render ----------
function render(snap) {
  ui.snap = snap;
  const ev = snap.selected;
  if (ev && ui.tlEvent !== ev.id) {
    ui.tlEvent = ev.id;
    ui.tlSeen = 0;
    ui.revIndex = null;
    ui.openHyps = new Set();
  }
  renderStatus(snap);
  renderAssets(snap);
  renderDemo(snap);
  renderFeed(snap);
  renderHero(snap);
  renderGraph($('graph'), ev);
  renderTimeline(ev);
  renderHypotheses(ev);
  renderReaction(ev);
  renderAction(ev, snap);
  renderMemory(snap);
  spotlight(snap);
}

function renderStatus(s) {
  const mk = s.market;
  const feed = s.feed || {};
  const feedDot = { connected: 'ok', simulated: 'warn', discovering: 'warn', error: 'err', disabled: 'err', idle: 'warn' }[feed.status] || 'warn';
  const nextOpen = mk.nextOpen ? ` · opens in ${dur(mk.nextOpen - s.now)}` : '';
  $('statusRow').innerHTML = `
    <span class="pill"><span class="dot ${s.activeGhostEvents ? 'ghost' : 'ok'}"></span>PRED <b>${s.activeGhostEvents ? 'INVESTIGATING' : 'MONITORING'}</b></span>
    <span class="pill"><span class="dot ${mk.usMarketOpen ? 'ok' : 'closed'}"></span><b>${esc(mk.label)}</b> · ${esc(human(mk.session))} · <span class="num">${esc(mk.nyTime)}</span>${nextOpen}</span>
    <span class="pill">Monitored <b class="num">${s.monitored.length}</b></span>
    <span class="pill">Active Ghost Events <b class="num">${s.activeGhostEvents}</b></span>
    <span class="pill" title="${esc(feed.note || feed.error || '')}"><span class="dot ${feedDot}"></span>Market data: <b>${s.mode === 'live' ? 'Bitget spot API' : 'Simulated tape'}</b> ${provTag(feed.provenance)}${s.mode === 'live' && feed.status !== 'connected' ? ` <span class="muted">${esc(feed.status === 'error' ? 'unreachable' : feed.status)}</span>` : ''}</span>
    <span class="pill" title="Narratives only; probabilities come from PRED's scoring model">Analyst: <b>${s.analyst.enabled ? esc(s.analyst.model) : 'template'}</b></span>`;
}

function renderAssets(s) {
  const focusTicker = s.selected?.ticker || (s.mode === 'demo' ? 'NVDAx' : null);
  const alert = new Set(s.events.filter((e) => !e.closed && !['CONFIRMED', 'INVALIDATED', 'UNRESOLVED'].includes(e.state)).map((e) => e.ticker));
  $('assetStrip').innerHTML =
    s.monitored
      .map(
        (a) => `<div class="asset ${a.ticker === focusTicker ? 'focus' : ''} ${alert.has(a.ticker) ? 'alert' : ''}">
      <span class="tk">${esc(a.ticker)}</span>
      <span class="px">${a.price != null ? a.price.toFixed(2) : '—'} <span class="${pctClass(a.chg1hPct)}">${a.chg1hPct != null ? pct(a.chg1hPct) : ''}</span></span>
      <span class="sym">${esc(a.symbol || (s.mode === 'live' ? 'not listed / no data' : ''))}</span>
      ${sparkline(a.spark)}
    </div>`,
      )
      .join('') || '<div class="empty">No monitored assets.</div>';
}

function renderDemo(s) {
  const bar = $('demoBar');
  bar.hidden = s.mode !== 'demo' || !s.demo;
  if (bar.hidden) return;
  const d = s.demo;
  $('demoSteps').innerHTML = d.steps.map((st, i) => `<span class="st ${st.done ? 'done' : ''} ${st.active ? 'active' : ''}" title="${esc(st.title)}">${i + 1}</span>`).join('');
  $('demoNarration').innerHTML = d.current ? `<b>${d.step + 1}. ${esc(d.current.title)}</b> — ${esc(d.current.narration)}` : `<b>${esc(d.scenario)}</b> — deterministic replay of a full Ghost Event lifecycle. Press <b>Next step</b> or <b>Auto-play</b>.`;
  const done = d.step >= d.total - 1;
  $('btnNext').disabled = d.busy || done;
  $('btnNext').textContent = d.busy ? 'Working…' : done ? 'Complete' : d.step < 0 ? 'Start demo →' : 'Next step →';
  $('btnAuto').classList.toggle('on', d.autoplay);
  $('btnAuto').textContent = d.autoplay ? 'Pause' : 'Auto-play';
}

function renderFeed(s) {
  $('feedCount').textContent = `${s.events.length} event${s.events.length === 1 ? '' : 's'} this session`;
  const sel = s.selected?.id;
  $('eventList').innerHTML =
    s.events
      .map(
        (e) => `<button class="ev-item ${e.id === sel ? 'sel' : ''}" data-id="${esc(e.id)}">
      <div class="row"><span class="code">${esc(e.code)}</span><span class="st">${esc(human(e.state))}</span></div>
      <div class="row"><b class="mono">${esc(e.ticker)}</b><span class="num ${pctClass(e.retPct)}">${pct(e.retPct)}</span><span class="num muted">vol ${e.volumeChangePct >= 0 ? '+' : ''}${e.volumeChangePct}%</span></div>
      <div class="row muted"><span>${e.primary ? `${esc(CAT[e.primary.key]?.short)} ${e.primary.probability}%` : 'investigating…'}</span><span>${et(e.detectedAt)} ET</span></div>
    </button>`,
      )
      .join('') ||
    `<div class="empty">${s.mode === 'live' ? 'No Ghost Events yet. PRED opens one when a monitored tokenized equity moves abnormally while the U.S. market is closed.' : 'Press <b>Start demo</b> to replay a simulated NVDAx Ghost Event.'}</div>`;
  $('eventList').querySelectorAll('.ev-item').forEach((b) =>
    b.addEventListener('click', () => {
      ui.selected = b.dataset.id;
      connect();
    }),
  );
  $('sysLog').innerHTML = s.log.map((l) => `<div class="${esc(l.level)}"><span class="t">${et(l.at)}</span>${esc(l.text)}</div>`).join('');
}

const LIFE = ['DETECTED', 'INVESTIGATING', 'HYPOTHESIS_CREATED', 'AWAITING_CONFIRMATION', 'RESOLVED'];

function renderHero(s) {
  const e = s.selected;
  const el = $('hero');
  if (!e) {
    const mem = s.memory;
    el.innerHTML = `<div class="hero-empty">
      <div class="big">Traditional markets close.<br/>Information doesn't. <span>PRED watches the gap.</span></div>
      <p>PRED monitors tokenized U.S. equities around the clock. When one moves abnormally while the U.S. market is closed and no public catalyst explains it, PRED opens a <b>Ghost Event</b>. It then investigates, forms competing catalyst hypotheses, tracks them until they are confirmed or invalidated, estimates the market reaction, and learns from the outcome.</p>
      <p class="muted">DETECT → INVESTIGATE → HYPOTHESIZE → VERIFY → PREDICT → LEARN${mem ? ` · ${mem.total} events in memory` : ''}</p>
    </div>`;
    return;
  }
  const m = e.anomaly.measurements;
  const rev = e.revisions.at(-1);
  const resolved = ['CONFIRMED', 'INVALIDATED', 'UNRESOLVED'].includes(e.state);
  const stepIdx = resolved ? 4 : LIFE.indexOf(e.state);
  const segCls = (i) => (i > stepIdx ? '' : i === 4 && e.state === 'INVALIDATED' ? 'bad' : i === 4 && e.state === 'UNRESOLVED' ? 'unres' : 'on');
  const catalyst = e.resolution?.actualCategory ? human(e.resolution.actualCategory) : 'UNKNOWN';
  const active = !resolved;
  const r = e.resolution;
  let confirm = '';
  if (r) {
    const ev = e.evidence.find((x) => x.id === r.confirmingEvidenceId);
    const cls = r.outcome === 'CONFIRMED' ? '' : r.outcome === 'INVALIDATED' ? 'bad' : 'unres';
    const head = r.outcome === 'CONFIRMED' ? `<div class="headline good">✓ CATALYST CONFIRMED — ${esc(human(r.actualCategory))}</div>` : r.outcome === 'INVALIDATED' ? `<div class="headline bad">✗ HYPOTHESIS INVALIDATED — actual: ${esc(human(r.actualCategory))}</div>` : `<div class="headline">UNRESOLVED — no authoritative evidence by the horizon</div>`;
    confirm = `<div class="confirm-box ${cls}">${head}
      <div><div class="lbl">Original hypothesis</div><div>${esc(r.originalHypothesis.title)} <b class="num">${r.originalHypothesis.probability}%</b></div><div class="muted">revision 1 · ${etFull(e.revisions[0].at)}</div></div>
      <div><div class="lbl">${r.outcome === 'UNRESOLVED' ? 'Leading hypothesis' : 'Confirming evidence'}</div><div>${ev ? `${esc(ev.title)} ${provTag(ev.provenance)}` : esc(r.judgedHypothesis.title)}</div><div class="muted">${esc(human(r.basis))}</div></div>
      <div><div class="lbl">Detection → ${r.outcome === 'UNRESOLVED' ? 'horizon' : 'confirmation'}</div><div class="num" style="font-size:20px;font-weight:700">${dur(r.timeToResolutionMs)}</div><div class="muted">${etFull(e.detectedAt)} → ${etFull(r.resolvedAt)}</div></div>
    </div>`;
  }
  el.innerHTML = `<div class="hero-grid">
    <div class="ghost-card">
      <div class="ghost-title"><span class="dot ${active ? 'ghost' : 'ok'}" style="width:8px;height:8px;border-radius:50%;display:inline-block"></span>${esc(e.code)} ${provTag(e.provenance)}</div>
      <div class="ghost-ticker">${esc(e.ticker)}</div>
      <div class="ghost-move"><span class="${pctClass(m.retPct)}">${pct(m.retPct)}</span><span class="vol">Volume ${m.volumeChangePct >= 0 ? '+' : ''}${m.volumeChangePct}%</span></div>
      <dl class="kv">
        <dt>Market status</dt><dd style="color:var(--serious)">${esc(e.market.label)}</dd>
        <dt>Catalyst</dt><dd>${esc(catalyst)}</dd>
        <dt>PRED confidence</dt><dd>${rev ? `${rev.primary.probability}% <span class="muted" style="font-weight:400">${esc(CAT[rev.primary.key].short.toLowerCase())}</span>` : '—'}</dd>
        <dt>Status</dt><dd class="state-chip" style="color:var(--accent)">${esc(human(e.state))}</dd>
        <dt>Anomaly</dt><dd>${m.priceZ.toFixed(1)}σ · ${esc(m.severity)} · spread ${m.spread ? `${m.spread.ratio.toFixed(1)}×` : 'n/a'}</dd>
        <dt>Detected</dt><dd>${etFull(e.detectedAt)}</dd>
      </dl>
      <div class="lifecycle">${LIFE.map((_, i) => `<div class="seg ${segCls(i)}"></div>`).join('')}</div>
      <div class="lifecycle-labels"><span>DETECT</span><span>INVESTIGATE</span><span>HYPOTHESIZE</span><span>AWAIT</span><span>RESOLVE</span></div>
    </div>
    <div class="hero-chart">
      <div class="chart-head"><h3>${esc(e.ticker)} · 1-minute closes (ET)</h3><span class="muted">${esc(e.asset.symbol || '')}</span></div>
      <div id="priceChart"></div>
    </div>
  </div>${confirm}`;
  priceChart($('priceChart'), e.chart);
}

function renderTimeline(e) {
  const el = $('timeline');
  if (!e) {
    el.innerHTML = '<div class="empty">Every state change, evidence item, hypothesis revision and prediction is appended here.</div>';
    return;
  }
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
  el.innerHTML = e.timeline
    .map(
      (t, i) => `<div class="tl-item ${esc(t.type)} ${i >= ui.tlSeen && ui.tlSeen ? 'new' : ''}">
      <span class="tl-time">${etFull(t.at).replace(' ET', '')}</span>
      <span class="tl-agent">${esc(t.agent)}</span>
      <span class="tl-text">${esc(t.text)}${t.relation && t.relation !== 'NEUTRAL' ? `<span class="rel ${t.relation}">${t.relation}</span>` : ''} ${t.provenance && t.type !== 'STATE' ? provTag(t.provenance) : ''}</span>
    </div>`,
    )
    .join('');
  if (atBottom || ui.tlSeen === 0) el.scrollTop = el.scrollHeight;
  ui.tlSeen = e.timeline.length;
}

function renderHypotheses(e) {
  const el = $('hypotheses');
  const nav = $('revNav');
  if (!e || !e.revisions.length) {
    nav.innerHTML = '';
    el.innerHTML = `<div class="empty">${e ? 'Investigation in progress — hypotheses appear once evidence is collected.' : 'No event selected.'}</div>`;
    return;
  }
  const n = e.revisions.length;
  const idx = ui.revIndex == null ? n - 1 : Math.min(ui.revIndex, n - 1);
  const rev = e.revisions[idx];
  nav.innerHTML = `<button id="revPrev" ${idx === 0 ? 'disabled' : ''} aria-label="Previous revision">‹</button><span>rev ${rev.rev}/${n}${idx === n - 1 ? ' · latest' : ''}</span><button id="revNext" ${idx === n - 1 ? 'disabled' : ''} aria-label="Next revision">›</button>`;
  $('revPrev').onclick = () => {
    ui.revIndex = idx - 1;
    renderHypotheses(e);
  };
  $('revNext').onclick = () => {
    ui.revIndex = idx + 1 >= n - 1 ? null : idx + 1;
    renderHypotheses(e);
  };
  const nar = rev.narrative;
  const evById = Object.fromEntries(e.evidence.map((x) => [x.id, x]));
  const evRow = (c) => `<li><span class="w ${c.weight > 0 ? 'pos' : 'neg'}">${c.weight > 0 ? '+' : ''}${c.weight.toFixed(2)}</span><span>${esc(c.reason)}<br/><span class="muted">${esc(evById[c.evidenceId]?.title || c.kind)}</span></span><span>${provTag(c.provenance)}</span></li>`;
  el.innerHTML =
    `<div class="muted" style="margin-bottom:8px">Revision ${rev.rev} · ${esc(rev.trigger)} · ${esc(rev.reason || '')} · ${etFull(rev.at)} · ${rev.evidenceCount} evidence items</div>` +
    (nar ? `<div class="narrative"><div class="by">AI HYPOTHESIS · ${esc(nar.author)}</div>${esc(nar.summary)}<div style="margin-top:4px"><b>Would confirm:</b> ${esc(nar.wouldConfirm)}</div><div><b>Would invalidate:</b> ${esc(nar.wouldInvalidate)}</div></div>` : '') +
    rev.hypotheses
      .map((h, i) => {
        const open = ui.openHyps.has(h.key) || (i === 0 && !ui.openHyps.has(`closed:${h.key}`));
        return `<div class="hyp ${i === 0 ? 'primary' : ''}">
        <div class="hyp-head"><div><div class="hyp-rank">${esc(h.rank)}</div><div class="hyp-title">${esc(h.title)}</div></div><div class="hyp-pct">${h.probability}%</div></div>
        <div class="bar"><i style="width:${h.probability}%;background:${CAT[h.key].color}"></i></div>
        <div class="hyp-meta"><span>Confidence: ${esc(h.confidence)}</span><span>${h.evidenceFor.length} for · ${h.evidenceAgainst.length} against</span></div>
        ${
          i < 4
            ? `<details data-key="${h.key}" ${open ? 'open' : ''}><summary>Evidence & implication</summary>
          ${h.evidenceFor.length ? `<ul class="ev-list">${h.evidenceFor.map(evRow).join('')}</ul>` : '<div class="muted">No supporting evidence.</div>'}
          ${h.evidenceAgainst.length ? `<ul class="ev-list">${h.evidenceAgainst.map(evRow).join('')}</ul>` : ''}
          <div class="impl"><b>Expected implication:</b> ${esc(h.implication)}</div>
          <div class="assets">Affected: ${h.affectedAssets.map(esc).join(', ')}</div>
        </details>`
            : ''
        }
      </div>`;
      })
      .join('') +
    `<div class="disclaimer">Percentages are model confidence estimates from a transparent evidence-weighting model — not measured probabilities. Calibration is tracked in PRED Memory.</div>`;
  el.querySelectorAll('details').forEach((d) =>
    d.addEventListener('toggle', () => {
      const k = d.dataset.key;
      if (d.open) {
        ui.openHyps.add(k);
        ui.openHyps.delete(`closed:${k}`);
      } else {
        ui.openHyps.delete(k);
        ui.openHyps.add(`closed:${k}`);
      }
    }),
  );
}

function renderReaction(e) {
  const el = $('reaction');
  const preds = e?.predictions || [];
  const p = preds.at(-1);
  if (!e || !p) {
    el.innerHTML = `<div class="empty">The Reaction Agent runs once the catalyst is confirmed or the leading hypothesis reaches 70%. It estimates the move into the first U.S. regular-session close from comparable events in PRED Memory.</div>`;
    return;
  }
  if (p.status !== 'OK') {
    el.innerHTML = `<div class="empty">${esc(p.note)}. PRED will not guess without comparable history.</div>`;
    return;
  }
  const o = e.outcome;
  const ev = e.evaluation;
  const chk = (v, label, extra = '') => `<div class="check ${v == null ? '' : v ? 'ok' : 'no'}"><span class="muted">${label}</span><b>${v == null ? 'n/a' : v ? '✓ correct' : '✗ missed'}</b>${extra}</div>`;
  el.innerHTML = `
    <div class="rx-top">
      <div class="stat"><div class="lbl">Direction</div><div class="val sm ${p.direction === 'POSITIVE' ? 'up' : p.direction === 'NEGATIVE' ? 'down' : ''}">${esc(p.direction)}</div><div class="sub">P(up) ≈ ${Math.round(p.probUp * 100)}%</div></div>
      <div class="stat"><div class="lbl">Model estimate</div><div class="val ${pctClass(p.estimatePct)}">${pct(p.estimatePct)}</div><div class="sub">to ${etFull(p.horizonAt)}</div></div>
      <div class="stat"><div class="lbl">Confidence</div><div class="val">${p.confidence}%</div><div class="sub">${p.comparableCount} comparables${p.broadened ? ' (broadened)' : ''}</div></div>
    </div>
    <div class="range-viz">${rangeViz(p, o?.reactionPct)}</div>
    <div class="muted">Historical comparable range (20th–80th pct): <b class="num">${pct(p.rangeLowPct)} → ${pct(p.rangeHighPct)}</b> · reference class: ${esc(p.referenceClass || '')} · basis: ${esc(p.basis)} · ref price ${p.refPrice?.toFixed(2)}</div>
    ${
      o
        ? `<div class="verdict">${chk(ev.directionCorrect, 'Direction')}${chk(ev.withinRange, 'Reaction range')}${chk(ev.catalystCorrect, 'Catalyst')}</div>
      <div class="muted" style="margin-top:6px">Actual reaction <b class="num ${pctClass(o.reactionPct)}">${pct(o.reactionPct)}</b> (${o.refPrice.toFixed(2)} → ${o.horizonPrice.toFixed(2)}) · abs. error ${ev.absErrorPct ?? '—'} pts · peers ${pct(o.peerReactionPct)} · total move since pre-move ${pct(o.totalMovePct)}${ev.failures.length ? ` · failure: <b>${ev.failures.map((f) => FAILURE_LABEL[f]).join(', ')}</b>` : ''}</div>`
        : ''
    }
    <table class="comparables"><thead><tr><th>Comparable</th><th>Asset</th><th>Move</th><th>Reaction</th><th>Sim.</th><th></th></tr></thead><tbody>
      ${p.comparables.map((c) => `<tr><td>${esc(c.code)}</td><td>${esc(c.ticker)}</td><td class="${pctClass(c.retPct)}">${pct(c.retPct)}</td><td class="${pctClass(c.reactionPct)}">${pct(c.reactionPct)}</td><td>${c.similarity}</td><td>${provTag(c.provenance)}</td></tr>`).join('')}
    </tbody></table>
    ${preds.length > 1 ? `<div class="muted" style="margin-top:8px">${preds.slice(0, -1).map((q) => `Prediction #${q.seq} (${esc(q.basis)}, ${etFull(q.at)}): ${q.status === 'OK' ? `${pct(q.estimatePct)} [${pct(q.rangeLowPct)} → ${pct(q.rangeHighPct)}], ${q.confidence}%` : esc(q.note)} — superseded, kept for audit`).join('<br/>')}</div>` : ''}
    <div class="disclaimer">${esc(p.label)}.</div>`;
}

function renderAction(e, s) {
  const el = $('action');
  const code = e?.action?.code || 'MONITOR';
  el.innerHTML = `<div class="action-row">${['MONITOR', 'WAIT', 'RESEARCH', 'CONSIDER_TRADE'].map((a) => `<span class="act ${a} ${a === code ? 'on' : ''}">${human(a)}</span>`).join('')}</div>
    <div class="action-reason">${esc(e?.action?.reason || 'No active event — keep monitoring.')}</div>
    <div class="disclaimer">A <b>CONSIDER TRADE</b> posture is published at <a href="/api/signals?mode=${s.mode}" target="_blank" style="color:var(--accent)">/api/signals</a> for a separate execution agent (e.g. on Bitget Agent Hub) that must enforce its own risk controls. PRED never places orders.</div>`;
}

function renderMemory(s) {
  const el = $('memory');
  const m = s.memory;
  if (!m) {
    el.innerHTML = '<div class="empty">Memory unavailable.</div>';
    return;
  }
  const before = s.demo?.memoryBefore;
  const delta = (k) => (before && s.demo.step >= 12 && m.total > before.total && k === 'total' ? `<span class="delta">+${m.total - before.total}</span>` : '');
  const p = m.provenance;
  $('memoryNote').innerHTML = `${p.SIMULATED ? `${provTag('SIMULATED')} ${p.SIMULATED}` : ''} ${p.LIVE ? `${provTag('LIVE')} ${p.LIVE}` : ''} ${s.mode === 'demo' ? '· seed events are a simulated backtest run through PRED’s real models' : ''}`;
  const a = m.accuracy;
  const accRow = (label, r, note, invert = false) => {
    const v = r?.rate;
    return `<div class="acc"><span>${label}</span><span class="v">${v == null ? '—' : `${Math.round(v * 100)}%`} <span class="muted">${r?.n != null ? `n=${r.n}` : ''}</span></span><div class="bar"><i style="width:${v == null ? 0 : v * 100}%;background:${invert ? 'var(--serious)' : 'var(--accent)'}"></i></div>${note ? `<span class="muted" style="grid-column:1/-1">${note}</span>` : ''}</div>`;
  };
  const maxFail = Math.max(1, ...Object.values(m.failures));
  const hl = s.selected?.recordId;
  el.innerHTML = `
    <div class="tiles">
      <div class="tile"><div class="lbl">Events analyzed</div><div class="val">${m.total}${delta('total')}</div><div class="sub">${m.openEvents} open</div></div>
      <div class="tile"><div class="lbl">Confirmed catalysts</div><div class="val" style="color:var(--good-text)">${m.confirmedCatalysts}</div><div class="sub">leading hypothesis confirmed</div></div>
      <div class="tile"><div class="lbl">Liquidity anomalies</div><div class="val" style="color:var(--warning)">${m.liquidityAnomalies}</div><div class="sub">no information behind the move</div></div>
      <div class="tile"><div class="lbl">False hypotheses</div><div class="val" style="color:var(--critical-text)">${m.falseHypotheses}</div><div class="sub">leading hypothesis wrong</div></div>
      <div class="tile"><div class="lbl">Unresolved / other</div><div class="val" style="color:var(--text-secondary)">${m.unresolvedOther}</div><div class="sub">no authoritative evidence by horizon</div></div>
    </div>
    <div class="mem-grid">
      <div class="chart-card"><h3>Prediction vs reality</h3><div class="acc-list">
        ${accRow('Direction accuracy', a.direction)}
        ${accRow('Catalyst confirmation accuracy', a.catalyst)}
        ${accRow('Reaction within predicted range', a.reactionRange, 'target ≈ 60% for a 20–80th percentile band')}
        ${accRow('False-positive rate', { rate: a.falsePositiveRate, n: null }, 'resolved events that were liquidity-driven', true)}
        <div class="acc"><span>Median time to confirmation</span><span class="v">${a.medianTimeToConfirmationMin != null ? dur(a.medianTimeToConfirmationMin * 60000) : '—'}</span></div>
        <div class="acc"><span>Mean abs. reaction error</span><span class="v">${a.meanAbsErrorPct != null ? `${a.meanAbsErrorPct} pts` : '—'}</span></div>
        <div class="acc"><span>Brier score (initial hypothesis)</span><span class="v">${m.calibration.brier ?? '—'}</span></div>
      </div></div>
      <div class="chart-card"><h3>Calibration · stated vs observed</h3><div id="relChart"></div><div class="cap">On the dashed line = calibrated. Above = underconfident, below = overconfident. n=${m.calibration.n}</div></div>
      <div class="chart-card"><h3>Calibration over time · Brier</h3><div id="brierChart"></div><div class="cap">Lower is better. Rolling windows of resolved events.</div></div>
      <div class="chart-card"><h3>Why predictions failed</h3>
        ${Object.entries(m.failures).map(([k, v]) => `<div class="fail"><span>${FAILURE_LABEL[k]}</span><div class="bar"><i style="width:${(v / maxFail) * 100}%"></i></div><span class="num">${v}</span></div>`).join('')}
      </div>
    </div>
    <table class="recent"><thead><tr><th>Event</th><th>Asset</th><th>Initial hypothesis</th><th>Actual cause</th><th>Predicted</th><th>Actual</th><th>Dir</th><th>Range</th><th>Catalyst</th><th>Failure</th><th></th></tr></thead><tbody>
      ${m.recent
        .map((r) => {
          const mk = (v) => (v == null ? '<span class="na-t">—</span>' : v ? '<span class="ok-t">✓</span>' : '<span class="no-t">✗</span>');
          return `<tr class="${r.id === hl ? 'hl' : ''}"><td>${esc(r.code)}</td><td>${esc(r.ticker)}</td><td>${r.initialPrimary ? `${esc(CAT[r.initialPrimary.key].short)} ${r.initialPrimary.probability}%` : '—'}</td><td>${r.actualCategory ? esc(CAT[r.actualCategory].short) : '<span class="na-t">unknown</span>'}</td><td>${r.predicted ? `${pct(r.predicted.est)} <span class="muted">[${pct(r.predicted.lo, 1)}, ${pct(r.predicted.hi, 1)}]</span>` : '<span class="na-t">—</span>'}</td><td class="${pctClass(r.actual)}">${pct(r.actual)}</td><td>${mk(r.evaluation.directionCorrect)}</td><td>${mk(r.evaluation.withinRange)}</td><td>${mk(r.evaluation.catalystCorrect)}</td><td class="muted">${r.evaluation.failures.map((f) => FAILURE_LABEL[f]).join(', ') || '—'}</td><td>${provTag(r.provenance)}</td></tr>`;
        })
        .join('')}
    </tbody></table>`;
  reliability($('relChart'), m.calibration.bins);
  brierLine($('brierChart'), m.calibration.overTime);
}

function spotlight(s) {
  const focus = s.mode === 'demo' ? s.demo?.focus : null;
  const map = { assets: null, feed: 'feed', hero: 'hero', graph: 'graph', timeline: 'timeline', hypotheses: 'hypotheses', reaction: 'reaction', memory: 'memory' };
  document.querySelectorAll('[data-panel]').forEach((p) => p.classList.toggle('spot', !!focus && p.dataset.panel === map[focus]));
  if (focus && s.demo.step !== ui.lastFocusStep) {
    ui.lastFocusStep = s.demo.step;
    const target = document.querySelector(`[data-panel="${map[focus]}"]`);
    if (target && ['memory', 'reaction', 'graph', 'hypotheses'].includes(focus)) target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

// ---------- controls ----------
document.querySelectorAll('.mode-switch button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
const post = (p) => fetch(p, { method: 'POST' });
$('btnNext').addEventListener('click', () => {
  $('btnNext').disabled = true;
  post('/api/demo/next');
});
$('btnReset').addEventListener('click', () => {
  ui.selected = null;
  post('/api/demo/reset').then(connect);
});
$('btnAuto').addEventListener('click', () => post(`/api/demo/autoplay?on=${ui.snap?.demo?.autoplay ? 0 : 1}`));
document.addEventListener('keydown', (e) => {
  if (ui.mode === 'demo' && (e.key === 'ArrowRight' || e.key === ' ') && e.target === document.body) {
    e.preventDefault();
    post('/api/demo/next');
  }
});
let rt;
window.addEventListener('resize', () => {
  clearTimeout(rt);
  rt = setTimeout(() => ui.snap && render(ui.snap), 150);
});

setMode(ui.mode);
