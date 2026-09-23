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

// Each browser gets its own demo session so visitors never drive each other's scenario.
const sid = (() => {
  let v = store('pred.sid');
  if (!v) {
    v = (crypto.randomUUID?.() || String(Math.random()).slice(2)).replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
    store('pred.sid', v);
  }
  return v;
})();

const ui = {
  // LIVE is the default. The simulated demo lives only under /demo.
  mode: location.pathname.startsWith('/demo') ? 'demo' : 'live',
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
  const q = new URLSearchParams({ mode: ui.mode, sid });
  if (ui.selected) q.set('event', ui.selected);
  ui.es = new EventSource(ui.mode === 'live' ? `/api/stream?${q}` : `/api/demo/stream?${q}`);
  ui.es.onmessage = (m) => render(JSON.parse(m.data));
  ui.es.onerror = () => {
    $('statusRow').dataset.err = '1';
  };
}

function setMode(mode) {
  ui.mode = mode;
  ui.selected = null;
  ui.revIndex = null;
  $('signalsLink').href = mode === 'live' ? '/api/signals' : `/api/demo/signals?sid=${sid}`;
  $('pageTitle').textContent = mode === 'live' ? 'PRED LIVE' : 'PRED DEMO · SIMULATED';
  $('pageSub').textContent = mode === 'live' ? '24/7 event intelligence for tokenized equities · Bitget market data' : 'Deterministic simulated scenario — not market data';
  $('assetsLink').hidden = mode !== 'live';
  $('liveLink').hidden = mode === 'live';
  document.title = mode === 'live' ? 'PRED LIVE — Ghost Events' : 'PRED DEMO — simulated';
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
  renderTrade(ev, snap);
  renderMemory(snap);
  spotlight(snap);
}

// Volume vs baseline as a capped multiple (a near-empty baseline must never read as 10^10 %).
const volX = (pct) => {
  if (pct == null || !Number.isFinite(Number(pct))) return 'n/a';
  const r = 1 + Number(pct) / 100;
  return r >= 50 ? '>50× baseline' : `${r.toFixed(1)}× baseline`;
};
// Connections: always open on wide screens, collapsed to a one-line summary on phones/tablets.
const narrow = window.matchMedia('(max-width: 1180px)');
const syncConnBox = () => {
  const box = $('connBox');
  if (box) box.open = !narrow.matches;
};
narrow.addEventListener?.('change', syncConnBox);
syncConnBox();

const CONN_DOT = { CONNECTED: 'ok', ARMED: 'warn', DISABLED: '', DEGRADED: 'warn', DISCONNECTED: 'err', 'NOT CONFIGURED': 'warn', OPTIONAL: '', CHECKING: 'warn' };
const ago = (t, now) => (t ? `${dur(Math.max(0, now - t)).replace(/^0m$/, '<1m')} ago` : 'never');

function renderLiveStatus(s) {
  const st = s.status;
  const tm = st.traditionalMarket;
  const tk = st.tokenizedMarket.status;
  const nextOpen = tm.nextOpen ? ` · opens in ${dur(tm.nextOpen - s.now)}` : '';
  $('statusRow').innerHTML = `
    <span class="pill"><span class="dot ${st.activeGhostEvents ? 'ghost' : 'ok'}"></span>PRED <b>${st.activeGhostEvents ? 'INVESTIGATING' : 'MONITORING'}</b></span>
    <span class="pill" title="U.S. equity regular session (NYSE calendar, holidays, early closes)"><span class="dot ${tm.status === 'OPEN' ? 'ok' : 'closed'}"></span>Traditional market <b>${tm.status}</b> · ${esc(human(tm.session).toLowerCase())} · <span class="num">${esc(tm.nyTime)}</span>${nextOpen}</span>
    <span class="pill" title="Bitget tokenized equities: LIVE when instruments are online and trading with fresh candles"><span class="dot ${tk === 'LIVE' ? 'ok' : tk === 'CLOSED' ? 'closed' : 'warn'}"></span>Bitget tokenized market <b>${tk}</b></span>
    <span class="pill" title="Bitget lists ${st.assetsDiscovered} tokenized instruments. ${st.assetsEligible ?? '?'} are U.S.-listed stocks/ETFs PRED can reason about (commodities, FX, Hong Kong/Korea/Japan listings and unregistered names are excluded). PRED watches the ${st.assetsMonitored} most-traded by 24h turnover (PRED_MAX_ASSETS=${st.maxAssets ?? 30}).">Monitoring <b class="num">${st.assetsMonitored}</b> of ${st.assetsEligible ?? st.assetsDiscovered} eligible · ${st.assetsDiscovered} discovered</span>
    <span class="pill">Active Ghost Events <b class="num">${st.activeGhostEvents}</b></span>
    <span class="pill" title="${st.lastMarketUpdate ? new Date(st.lastMarketUpdate).toISOString() : ''}">Last market update <b>${ago(st.lastMarketUpdate, s.now)}</b></span>
    ${st.ghostCondition ? '<span class="pill ghost-pill"><span class="dot ghost"></span><b>Ghost window open</b> · tokenized live, Wall Street closed</span>' : ''}`;
  const conns = Object.values(st.connections);
  const bad = conns.filter((c) => ['DISCONNECTED', 'DEGRADED', 'NOT CONFIGURED'].includes(c.status)).length;
  const ok = conns.filter((c) => c.status === 'CONNECTED').length;
  $('connSummary').innerHTML = `<span class="dot ${conns.some((c) => c.status === 'DISCONNECTED') ? 'err' : bad ? 'warn' : 'ok'}"></span>${ok}/${conns.length} connected${bad ? ` · ${bad} need attention` : ''}`;
  $('connList').innerHTML = conns
    .map((c) => `<div class="conn" title="${esc(c.detail || '')}"><span class="dot ${CONN_DOT[c.status] ?? ''}"></span><span class="conn-name">${esc(c.name)}</span><span class="conn-st ${esc(String(c.status).replace(/\s+/g, '-'))}">${esc(c.status)}</span>${c.detail ? `<span class="conn-detail">${esc(c.detail)}</span>` : ''}</div>`)
    .join('');
  $('demoLink').hidden = !st.demoEnabled;
}

function renderStatus(s) {
  if (s.mode === 'live' && s.status) return renderLiveStatus(s);
  const mk = s.market;
  const feed = s.feed || {};
  const feedDot = { connected: 'ok', simulated: 'warn', discovering: 'warn', error: 'err', disabled: 'err', idle: 'warn' }[feed.status] || 'warn';
  const nextOpen = mk.nextOpen ? ` · opens in ${dur(mk.nextOpen - s.now)}` : '';
  $('statusRow').innerHTML = `
    <span class="pill"><span class="dot ${s.activeGhostEvents ? 'ghost' : 'ok'}"></span>PRED <b>${s.activeGhostEvents ? 'INVESTIGATING' : 'MONITORING'}</b></span>
    <span class="pill"><span class="dot ${mk.usMarketOpen ? 'ok' : 'closed'}"></span><b>${esc(mk.label)}</b> · ${esc(human(mk.session))} · <span class="num">${esc(mk.nyTime)}</span>${nextOpen}</span>
    <span class="pill">Active Ghost Events <b class="num">${s.activeGhostEvents}</b> / ${s.monitored.length} monitored</span>
    <span class="pill" title="${esc(feed.note || feed.error || '')}"><span class="dot ${feedDot}"></span><b>${s.mode === 'live' ? 'Bitget' : 'Simulated tape'}</b> ${provTag(feed.provenance)}${s.mode === 'live' && feed.status !== 'connected' ? ` <span class="muted">${esc(feed.status === 'error' ? 'unreachable' : feed.status)}</span>` : ''}</span>`;
  $('connList').innerHTML = `<div class="conn"><span class="dot warn"></span><span class="conn-name">Simulated tape</span><span class="conn-st">SIMULATED</span><span class="conn-detail">Deterministic demo data — no live sources are used here</span></div>`;
}

function renderAssets(s) {
  const focusTicker = s.selected?.ticker || (s.mode === 'demo' ? 'NVDAx' : null);
  const alert = new Set(s.events.filter((e) => !e.closed && !['CONFIRMED', 'INVALIDATED', 'UNRESOLVED'].includes(e.state)).map((e) => e.ticker));
  $('assetStrip').innerHTML =
    s.monitored
      .map(
        (a) => `<div class="asset ${a.ticker === focusTicker ? 'focus' : ''} ${alert.has(a.ticker) ? 'alert' : ''}">
      <span class="tk">${esc(a.ticker)}</span>
      <span class="px">${a.price != null ? fmtPx(a.price) : '—'} ${s.mode === 'live' ? `<span class="${pctClass(a.change24hPct)}" title="24h">${a.change24hPct != null ? pct(a.change24hPct) : '—'}</span>` : `<span class="${pctClass(a.chg1hPct)}">${a.chg1hPct != null ? pct(a.chg1hPct) : ''}</span>`}</span>
      <span class="sym">${esc(a.symbol || '')}${a.tokenizedMarket ? ` · <span class="tk-st ${esc(a.tokenizedMarket)}">${esc(a.tokenizedMarket)}</span>` : ''}</span>
      ${sparkline(a.spark)}
    </div>`,
      )
      .join('') || `<div class="empty">${s.mode !== 'live' ? 'No monitored assets.' : s.status?.connections?.bitget?.status === 'DISCONNECTED' ? `Bitget unreachable — no assets discovered (${esc(s.status.connections.bitget.detail || '')}). Nothing is simulated in LIVE mode.` : s.status?.assetsDiscovered === 0 && s.status?.connections?.bitget?.status === 'CONNECTED' ? 'Bitget lists no tokenized-equity (RWA) instruments right now.' : 'Discovering tokenized equities from Bitget…'}</div>`;
}

const fmtPx = (x) => (x == null ? '—' : x >= 1000 ? x.toFixed(1) : x >= 1 ? x.toFixed(2) : x.toPrecision(4));
const fmtVol = (x) => (x == null ? '—' : x >= 1e9 ? `${(x / 1e9).toFixed(2)}B` : x >= 1e6 ? `${(x / 1e6).toFixed(2)}M` : x >= 1e3 ? `${(x / 1e3).toFixed(1)}K` : x.toFixed(0));

function renderDemo(s) {
  const bar = $('demoBar');
  bar.hidden = s.mode !== 'demo' || !s.demo;
  if (bar.hidden) return;
  const d = s.demo;
  $('demoSteps').innerHTML = d.steps.map((st, i) => `<span class="st ${st.done ? 'done' : ''} ${st.active ? 'active' : ''}" title="${i + 1}. ${esc(st.title)}"><span>${i + 1}/${d.total} · ${esc(st.title)}</span></span>`).join('');
  $('demoNarration').innerHTML = d.current ? `<b>${esc(d.current.title)}</b> — ${esc(d.current.narration)}` : `<b>${esc(d.scenario)}</b> — a replay of a full Ghost Event lifecycle, the same every time. Press <b>Start demo</b> or <b>Auto-play</b>.`;
  const done = d.step >= d.total - 1;
  $('btnNext').disabled = d.busy || done;
  $('btnNext').textContent = d.busy ? 'Working…' : done ? 'Complete' : d.step < 0 ? 'Start demo →' : 'Next step →';
  $('btnAuto').classList.toggle('on', d.autoplay);
  $('btnAuto').textContent = d.autoplay ? 'Pause' : 'Auto-play';
}

function renderFeed(s) {
  $('feedCount').textContent = s.mode === 'live' ? `${s.events.length} persisted event${s.events.length === 1 ? '' : 's'}` : `${s.events.length} event${s.events.length === 1 ? '' : 's'} this session`;
  const sel = s.selected?.id;
  $('eventList').innerHTML =
    s.events
      .map(
        (e) => `<button class="ev-item ${e.id === sel ? 'sel' : ''}" data-id="${esc(e.id)}">
      <div class="row"><span class="code">${esc(e.code)}</span><span class="st">${esc(human(e.state))}${e.resolutionBasis === 'faded-by-open' ? ' · faded' : e.state === 'UNRESOLVED' && e.moveHeld === true ? ' · held' : e.state === 'UNRESOLVED' && e.moveHeld === false ? ' · partly faded' : ''}</span></div>
      <div class="row"><b class="mono">${esc(e.ticker)}</b><span class="num ${pctClass(e.retPct)}">${pct(e.retPct)}</span><span class="num muted">vol ${volX(e.volumeChangePct)}</span></div>
      <div class="row muted"><span>${e.primary ? `${esc(CAT[e.primary.key]?.short)} ${e.primary.probability}%` : 'investigating…'}</span><span>${et(e.detectedAt)} ET</span></div>
    </button>`,
      )
      .join('') ||
    `<div class="empty">${s.mode === 'live' ? '<b>No active Ghost Events detected.</b><br/>PRED opens one only when a Bitget tokenized equity is trading, the U.S. market is closed, and price/volume behave abnormally. Quiet is a valid state.' : 'Press <b>Start demo</b> to replay a simulated NVDAx Ghost Event.'}</div>`;
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
  if (!e && s.mode === 'live') {
    const rows = (s.markets || [])
      .map(
        (m) => `<tr><td><b>${esc(m.key)}</b><div class="muted">${esc(m.symbol)}</div></td><td class="m">${fmtPx(m.lastPrice)}</td><td class="m ${pctClass(m.change24hPct)}">${m.change24hPct == null ? '—' : pct(m.change24hPct)}</td><td class="m">${fmtVol(m.turnover24h)}</td><td class="m">${m.volumeAnomalyRatio == null ? '<span class="na-t">n/a</span>' : `${m.volumeAnomalyRatio}×`}</td><td class="m">${m.volatility1mPct == null ? '<span class="na-t">n/a</span>' : `${m.volatility1mPct}%`}</td><td class="m">${m.spreadBps == null ? '<span class="na-t">n/a</span>' : `${m.spreadBps} bps`}</td><td><span class="tk-st ${esc(m.tokenizedMarket)}" title="${esc(m.tokenizedReason)}">${esc(m.tokenizedMarket)}</span></td><td class="m muted">${m.lastCandleAt ? et(m.lastCandleAt) : '—'}</td></tr>`,
      )
      .join('');
    el.innerHTML = `<div class="hero-empty live-empty">
      <div class="eyebrow">Live · Bitget tokenized equities</div>
      <div class="big">No active Ghost Events detected.</div>
      <p>PRED is monitoring real Bitget market data. A Ghost Event opens only when a tokenized equity is actively trading, the U.S. market is closed, and price/volume move abnormally against their own baseline. No activity is simulated here.</p>
      <div class="table-wrap"><table class="recent live-table"><thead><tr><th>Asset</th><th>Last</th><th>24h</th><th>24h turnover</th><th>Vol ratio</th><th>1m vol.</th><th>Spread</th><th>Tokenized</th><th>Last candle (ET)</th></tr></thead><tbody>${rows || `<tr><td colspan="9" class="muted">${s.status?.connections?.bitget?.status === 'DISCONNECTED' ? `Bitget unreachable: ${esc(s.status.connections.bitget.detail || '')}` : 'Waiting for the first Bitget market data…'}</td></tr>`}</tbody></table></div>
      <p class="muted" style="margin-top:10px">Values Bitget does not provide are shown as n/a, never estimated. Vol ratio = last 5 one-minute bars vs. their 2-hour median.</p>
    </div>`;
    return;
  }
  if (!e) {
    const mem = s.memory;
    el.innerHTML = `<div class="hero-empty">
      <div class="eyebrow">Traditional markets close. Information doesn't.</div>
      <div class="big">PRED watches <span>the gap.</span></div>
      <p>${s.mode === 'live' ? 'PRED is watching Bitget tokenized equities. When one moves abnormally while the U.S. market is closed and no public catalyst explains it, a <b>Ghost Event</b> opens here.' : 'Press <b>Start demo</b> to replay a simulated NVDAx Ghost Event on a Sunday evening, from detection through confirmation, reaction and learning.'}</p>
      <div class="loop"><span>Detect</span><span>Investigate</span><span>Hypothesize</span><span>Verify</span><span>Predict</span><span>Learn</span></div>
      ${mem ? `<p class="muted" style="margin-top:14px">${mem.total} events in PRED Memory</p>` : ''}
    </div>`;
    return;
  }
  const m = e.anomaly.measurements;
  const rev = e.revisions.at(-1);
  const resolved = ['CONFIRMED', 'INVALIDATED', 'UNRESOLVED'].includes(e.state);
  const stepIdx = resolved ? 4 : LIFE.indexOf(e.state);
  const segCls = (i) => (i > stepIdx ? '' : i === 4 && e.state === 'INVALIDATED' ? 'on bad' : i === 4 && e.state === 'UNRESOLVED' ? 'on unres' : 'on');
  const catalyst = e.resolution?.actualCategory ? human(e.resolution.actualCategory) : 'UNKNOWN';
  const active = !resolved;
  const r = e.resolution;
  let confirm = '';
  if (r) {
    const ev = e.evidence.find((x) => x.id === r.confirmingEvidenceId);
    const cls = r.outcome === 'CONFIRMED' ? '' : r.outcome === 'INVALIDATED' ? 'bad' : 'unres';
    const head = r.outcome === 'CONFIRMED' ? `<div class="headline good">✓ Catalyst confirmed — ${esc(human(r.actualCategory).toLowerCase())}</div>` : r.outcome === 'INVALIDATED' ? `<div class="headline bad">✗ Hypothesis invalidated — actual cause: ${esc(human(r.actualCategory).toLowerCase())}</div>` : `<div class="headline">Unresolved — no authoritative evidence by the horizon</div>`;
    confirm = `<div class="confirm-box ${cls}">${head}
      <div><div class="lbl">Original hypothesis</div><div>${esc(r.originalHypothesis.title)} <b class="num">${r.originalHypothesis.probability}%</b></div><div class="muted">revision 1 · ${etFull(e.revisions[0].at)}</div></div>
      <div><div class="lbl">${r.outcome === 'UNRESOLVED' ? 'Leading hypothesis' : 'Confirming evidence'}</div><div>${ev ? `${esc(ev.title)} ${provTag(ev.provenance)}` : esc(r.judgedHypothesis.title)}</div><div class="muted">${esc(human(r.basis))}</div></div>
      <div><div class="lbl">Detection → ${r.outcome === 'UNRESOLVED' ? 'horizon' : 'confirmation'}</div><div class="big-num">${dur(r.timeToResolutionMs)}</div><div class="muted">${etFull(e.detectedAt)} → ${etFull(r.resolvedAt)}</div></div>
    </div>`;
  }
  el.innerHTML = `<div class="hero-grid">
    <div class="ghost-card">
      <div class="ghost-title"><span class="dot ${active ? 'ghost' : 'ok'}"></span>${esc(e.code)} ${provTag(e.provenance)}${e.priority ? ` <span class="prio">${esc(e.priority)} PRIORITY</span>` : ''}</div>
      <div class="ghost-ticker">${esc(e.ticker)}</div>
      <div class="ghost-move"><span class="${pctClass(m.retPct)}">${pct(m.retPct)}</span><span class="vol">Volume ${volX(m.volumeChangePct)}</span></div>
      <dl class="kv">
        <dt>Market status</dt><dd><span class="closed-badge">${esc(e.market.label)}</span></dd>
        <dt>Catalyst</dt><dd>${esc(catalyst)}</dd>
        <dt>PRED confidence</dt><dd>${rev ? `${rev.primary.probability}% <span class="muted" style="font-weight:400">${esc(CAT[rev.primary.key].short.toLowerCase())}</span>` : '—'}</dd>
        <dt>Status</dt><dd><span class="state-badge ${esc(e.state)}">${esc(human(e.state))}</span></dd>
        <dt>Anomaly</dt><dd>${m.priceZ.toFixed(1)}σ · ${esc(m.severity)} · spread ${m.spread ? `${m.spread.ratio.toFixed(1)}×` : 'n/a'}</dd>
        <dt>Detected</dt><dd>${etFull(e.detectedAt)}</dd>
        ${e.state === 'AWAITING_CONFIRMATION' && e.verifyDeadlineAt ? `<dt>Verification closes</dt><dd>${etFull(e.verifyDeadlineAt)} <span class="muted" style="font-weight:400">US open + ${Math.round((e.verifyDeadlineAt - e.nextOpenAt) / 60000)}m</span></dd>` : ''}
        ${e.resolution?.basis === 'open-deadline' && e.resolution.moveAtOpenPct != null ? `<dt>Move at US open</dt><dd><span class="${pctClass(e.resolution.moveAtOpenPct)}">${pct(e.resolution.moveAtOpenPct)}</span> <span class="muted" style="font-weight:400">${e.resolution.moveHeld ? 'held' : 'faded'}</span></dd>` : ''}
      </dl>
      <div class="stepper">${['Detect', 'Investigate', 'Hypothesis', 'Await', 'Resolve'].map((l, i) => `<div class="s ${segCls(i)}"><i>${i <= stepIdx ? (segCls(i).includes('bad') ? '✕' : '✓') : ''}</i>${l}</div>`).join('')}</div>
    </div>
    <div class="hero-chart">
      <div class="chart-head"><h3>${esc(e.ticker)} · 1-minute closes (ET)</h3><span class="muted">${esc(e.asset.symbol || '')}${e.asset.company ? ` · ${esc(e.asset.company)}` : ''}</span></div>
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
      <span class="tl-time" title="${new Date(t.at).toISOString()}">${etFull(t.at).replace(' ET', '')}${s_sec(t.at)}</span>
      <span class="tl-agent">${esc(t.agent)}${t.source && t.source !== t.agent ? `<span class="tl-src">${esc(t.source)}${t.durationMs != null ? ` · ${t.durationMs}ms` : ''}</span>` : ''}</span>
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
  const evRow = (c) => {
    const ev = evById[c.evidenceId];
    const title = esc(ev?.title || c.kind);
    const link = ev?.url && /^https?:\/\//.test(ev.url) ? `<a href="${esc(ev.url)}" target="_blank" rel="noopener noreferrer nofollow">${title}</a>` : title;
    return `<li><span class="w ${c.weight > 0 ? 'pos' : 'neg'}">${c.weight > 0 ? '+' : ''}${c.weight.toFixed(2)}</span><span>${esc(c.reason)}<br/><span class="muted">${link}${ev?.source ? ` · ${esc(ev.source)}` : ''}${ev?.class && ev.class !== 'OBSERVED' ? ` · ${esc(ev.class)}` : ''}</span></span><span>${provTag(c.provenance)}</span></li>`;
  };
  el.innerHTML =
    `<div class="muted" style="margin-bottom:8px">Revision ${rev.rev} · ${esc(rev.trigger)} · ${esc(rev.reason || '')} · ${etFull(rev.at)} · ${rev.evidenceCount} evidence items${rev.sourceCount != null ? ` from ${rev.sourceCount} sources` : ''}${rev.modelVersion ? ` · model <span class="mono">${esc(rev.modelVersion)}</span>` : ''}</div>` +
    (nar ? `<div class="narrative"><div class="by">AI HYPOTHESIS · ${esc(nar.author)}</div>${esc(nar.summary)}<div style="margin-top:4px"><b>Would confirm:</b> ${esc(nar.wouldConfirm)}</div><div><b>Would invalidate:</b> ${esc(nar.wouldInvalidate)}</div></div>` : '') +
    rev.hypotheses
      .map((h, i) => {
        const open = ui.openHyps.has(h.key) || (i === 0 && !ui.openHyps.has(`closed:${h.key}`));
        return `<div class="hyp ${i === 0 ? 'primary' : ''}">
        <div class="hyp-head"><div><div class="hyp-rank">${esc(h.rank)}</div><div class="hyp-title">${esc(h.title)}</div></div><div class="hyp-pct">${h.probability}%</div></div>
        <div class="bar"><i style="width:${h.probability}%;background:${CAT[h.key].color}"></i></div>
        <div class="hyp-meta"><span>Confidence: ${esc(h.confidence)}${h.confidenceChange != null && h.confidenceChange !== 0 ? ` · <b class="${h.confidenceChange > 0 ? 'up' : 'down'}">${h.confidenceChange > 0 ? '▲' : '▼'} ${Math.abs(h.confidenceChange)} pts</b>` : ''}</span><span>${h.evidenceFor.length} for · ${h.evidenceAgainst.length} against${h.sourceCount != null ? ` · ${h.sourceCount} sources` : ''}</span></div>
        ${
          i < 4
            ? `<details data-key="${h.key}" ${open ? 'open' : ''}><summary>Evidence & implication</summary>
          ${h.evidenceFor.length ? `<ul class="ev-list">${h.evidenceFor.map(evRow).join('')}</ul>` : '<div class="muted">No supporting evidence.</div>'}
          ${h.evidenceAgainst.length ? `<ul class="ev-list">${h.evidenceAgainst.map(evRow).join('')}</ul>` : ''}
          ${h.prior != null ? `<div class="muted" style="margin-top:6px">Why ${h.probability}%: prior ${h.prior >= 0 ? '+' : ''}${h.prior} + evidence weights above = score ${h.score}, softmax (T=1.5) across all six categories, capped short of certainty.</div>` : ''}
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
    el.innerHTML = `<div class="rx-top"><div class="stat"><div class="lbl">Historical comparables</div><div class="val sm">Insufficient live history</div><div class="sub">${esc(p.note)}</div></div><div class="stat"><div class="lbl">Reaction prediction</div><div class="val sm down">LOW CONFIDENCE</div><div class="sub">no range published</div></div><div class="stat"><div class="lbl">Category</div><div class="val sm">${esc(CAT[p.category]?.short || '—')}</div><div class="sub">leading hypothesis</div></div></div><div class="disclaimer">PRED does not guess a reaction range without enough verified live events to compare against. It will start estimating as real outcomes accumulate in LIVE MEMORY.</div>`;
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
    <div class="disclaimer">This posture is intelligence, not an order. PRED's agents never place orders; a live order only happens in the <b>Trade</b> panel, after you review a specific plan and press <b>Approve &amp; execute</b>. Signals: <a href="${s.mode === 'live' ? '/api/signals' : `/api/demo/signals?sid=${sid}`}" target="_blank" rel="noopener">${s.mode === 'live' ? '/api/signals' : '/api/demo/signals'}</a>.</div>`;
}

function renderMemory(s) {
  const el = $('memory');
  const m = s.memory;
  if (!m) {
    el.innerHTML = '<div class="empty">Memory unavailable.</div>';
    return;
  }
  $('memoryTitle').textContent = `${s.memoryLabel || (s.mode === 'live' ? 'LIVE MEMORY' : 'SIMULATED MEMORY')} · self-evaluation`;
  if (s.mode === 'live' && m.total === 0) {
    $('memoryNote').innerHTML = `${provTag('LIVE')} real events only`;
    el.innerHTML = `<div class="tiles"><div class="tile"><div class="lbl">PRED Memory</div><div class="val">0</div><div class="sub">verified events</div></div><div class="tile" style="grid-column:span 4"><div class="lbl">Accuracy</div><div class="val sm" style="font-size:16px">Insufficient live history</div><div class="sub">Direction, catalyst and reaction-range accuracy, Brier score and false-positive rate are computed only from real, resolved Ghost Events. None exist yet, so no numbers are shown.</div></div></div>`;
    return;
  }
  const before = s.demo?.memoryBefore;
  const delta = (k) => (before && s.demo.step >= 12 && m.total > before.total && k === 'total' ? `<span class="delta">+${m.total - before.total}</span>` : '');
  const p = m.provenance;
  $('memoryNote').innerHTML = `${p.SIMULATED ? `${provTag('SIMULATED')} ${p.SIMULATED}` : ''} ${p.LIVE ? `${provTag('LIVE')} ${p.LIVE}` : ''} ${s.mode === 'demo' ? '· seed events are a simulated backtest run through PRED’s real models' : ''}`;
  const a = m.accuracy;
  const accRow = (label, r, note, invert = false) => {
    const v = s.mode === 'live' && r?.n != null && r.n < 5 ? null : r?.rate;
    if (s.mode === 'live' && r?.n != null && r.n < 5) note = `insufficient live history (n=${r.n}, need ≥5)`;
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
          return `<tr class="${r.id === hl ? 'hl' : ''}"><td class="m">${esc(r.code.replace('GHOST EVENT ', ''))}</td><td><b>${esc(r.ticker)}</b></td><td>${r.initialPrimary ? `${esc(CAT[r.initialPrimary.key].short)} ${r.initialPrimary.probability}%` : '—'}</td><td>${r.actualCategory ? esc(CAT[r.actualCategory].short) : '<span class="na-t">unknown</span>'}</td><td>${r.predicted ? `${pct(r.predicted.est)} <span class="muted">[${pct(r.predicted.lo, 1)}, ${pct(r.predicted.hi, 1)}]</span>` : '<span class="na-t">—</span>'}</td><td class="m ${pctClass(r.actual)}">${pct(r.actual)}</td><td>${mk(r.evaluation.directionCorrect)}</td><td>${mk(r.evaluation.withinRange)}</td><td>${mk(r.evaluation.catalystCorrect)}</td><td class="muted">${r.evaluation.failures.map((f) => FAILURE_LABEL[f]).join(', ') || '—'}</td><td>${provTag(r.provenance)}</td></tr>`;
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
function s_sec(t) {
  const d = new Date(t);
  return `:${String(d.getSeconds()).padStart(2, '0')}`;
}
const post = (p) => fetch(`${p}${p.includes('?') ? '&' : '?'}sid=${sid}`, { method: 'POST' });
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

// Sidebar: highlight the section in view.
const navLinks = [...document.querySelectorAll('.side-nav a')];
const io = new IntersectionObserver(
  (entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      navLinks.forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#${en.target.id}`));
    }
  },
  { rootMargin: '-35% 0px -60% 0px' },
);
navLinks.forEach((a) => {
  const t = document.querySelector(a.getAttribute('href'));
  if (t) io.observe(t);
});

// A deployment running PRED_MODE=demo has no live API; send visitors to /demo.
fetch('/api/health')
  .then((r) => r.json())
  .then((h) => {
    if (h.mode === 'demo' && ui.mode === 'live') location.replace('/demo');
  })
  .catch(() => {});
setMode(ui.mode);

// ---------- Trade: human-approved execution (live only) ----------
// The browser never sends order parameters. It names a plan id; the server
// rebuilds the order from the stored plan and fresh Bitget data.
const trade = { session: null, review: null, msg: null, busy: false };

async function tradeApi(path, { method = 'GET', body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (method === 'POST' && trade.session?.csrfToken) headers['x-pred-csrf'] = trade.session.csrfToken;
  const r = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ...j };
}
async function loadSession() {
  if (ui.mode !== 'live') return;
  trade.session = await tradeApi('/api/auth/session').catch(() => null);
}

const TRADE_ST = { AWAITING_APPROVAL: 'warn', APPROVED: 'warn', SUBMITTING: 'warn', SUBMITTED: 'info', PARTIALLY_FILLED: 'info', FILLED: 'ok', CANCELLED: '', REJECTED: 'err', EXPIRED: '', FAILED: 'err', DRAFT: '' };
const stBadge = (st) => `<span class="tp-st ${TRADE_ST[st] ?? ''}">${esc(human(st))}</span>`;
const money = (x) => (x == null || x === '' ? '—' : `$${Number(x).toLocaleString('en-US', { maximumFractionDigits: 6 })}`);

function renderTrade(e, s) {
  const el = $('trade');
  if (!el) return;
  if (el.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return; // don't wipe typing
  if (s.mode !== 'live') {
    el.innerHTML = `<div class="tp-note">Simulated demo — no trade execution here. Live orders exist only on <a href="/app">PRED Live</a>, and only after a human approves a specific plan.</div>`;
    return;
  }
  const t = s.status?.trading || {};
  const armed = !!t.executionEnabled;
  const exec = `<div class="tp-exec-state ${armed ? 'armed' : ''}"><b>Live execution: ${armed ? 'ARMED' : 'DISABLED'}</b>${armed ? ' — every order still needs your approval' : ` — ${esc(t.blockers?.[0] || 'not configured')}`}</div>`;
  if (!e) {
    el.innerHTML = `${exec}<div class="tp-note">Select a Ghost Event. Trade plans are drafted from PRED's intelligence; nothing executes without you.</div>`;
    return;
  }
  const plans = s.tradePlans || [];
  const plan = plans[0] || null;
  const pred = e.predictions?.filter((p) => p.status === 'OK').at(-1);
  const rev = e.revisions?.at(-1);
  const prediction = `<div class="tp-block tp-prediction">
      <div class="tp-kicker">Prediction · intelligence, not an order</div>
      <div class="tp-line"><b>${esc(e.ticker)}</b> <span class="${pctClass(e.anomaly.measurements.retPct)}">${pct(e.anomaly.measurements.retPct)}</span> · Traditional market ${esc(e.market?.label || '')}</div>
      <div class="tp-line">Catalyst: <b>${e.resolution?.outcome === 'CONFIRMED' ? 'CONFIRMED' : 'UNCONFIRMED'}</b>${rev ? ` · leading: ${esc(rev.primary.title)} ${rev.primary.probability}%` : ''}</div>
      <div class="tp-line">Reaction: ${pred ? `<b>${pred.direction === 'POSITIVE' ? 'Bullish' : pred.direction === 'NEGATIVE' ? 'Bearish' : 'Neutral'} — ${pred.confidence}%</b> (${pct(pred.estimatePct)} to the U.S. close)` : '<b>Insufficient live history</b> · LOW CONFIDENCE'}</div>
    </div>`;
  let body = '';
  const login = !trade.session?.authenticated
    ? trade.session?.loginAvailable === false
      ? `<div class="tp-note">Operator login is not configured on this server (PRED_ADMIN_TOKEN). Plans are view-only.</div>`
      : `<form class="tp-login" id="tpLogin"><input type="password" id="tpToken" placeholder="Operator token" autocomplete="current-password" aria-label="Operator token"/><button class="btn" type="submit">Log in to review</button></form>`
    : `<div class="tp-note">Operator session active. <a href="#" id="tpLogout">Log out</a></div>`;
  if (!plan || ['EXPIRED', 'CANCELLED', 'REJECTED', 'FAILED'].includes(plan.status)) {
    body += plan ? `<div class="tp-card muted-card">Last plan ${stBadge(plan.status)} ${esc(plan.failureReason || plan.expiredReason || plan.cancelledReason || '')}</div>` : '';
    body += trade.session?.authenticated ? `<button class="btn" id="tpGenerate" ${trade.busy ? 'disabled' : ''}>Generate trade plan</button>` : '';
  } else {
    const dir = plan.direction === 'LONG' ? 'LONG' : 'SHORT';
    body += `<div class="tp-card">
        <div class="tp-head"><span class="tp-dir ${dir}">${dir} ${esc(plan.ticker)}</span>${stBadge(plan.status)}</div>
        <dl class="kv tp-kv">
          <dt>Quantity</dt><dd>${esc(plan.quantity)} <span class="muted">${esc(plan.symbol)}</span></dd>
          <dt>Estimated price</dt><dd>${money(plan.estimatedPrice)} <span class="muted">≈ ${money(plan.notional)} USDT</span></dd>
          <dt>Stop</dt><dd>${money(plan.stopLoss)}</dd><dt>Target</dt><dd>${money(plan.takeProfit)}${plan.tpslAttached ? '' : ' <span class="muted">(reference only on spot)</span>'}</dd>
          <dt>Confidence</dt><dd>${plan.confidence != null ? `${plan.confidence}%` : '<b>LOW</b> — reaction model has no live history'}</dd>
          ${plan.exchangeOrderId ? `<dt>Bitget order</dt><dd class="mono">${esc(plan.exchangeOrderId)}</dd><dt>Filled</dt><dd>${esc(plan.filledQty ?? '0')} / ${esc(plan.quantity)}${plan.avgPrice && Number(plan.avgPrice) > 0 ? ` @ ${money(plan.avgPrice)}` : ''}</dd>` : ''}
          ${plan.expiresInSec != null ? `<dt>Expires</dt><dd>${plan.expiresInSec}s</dd>` : ''}
        </dl>
        ${plan.status === 'AWAITING_APPROVAL' && trade.session?.authenticated && !(trade.review && trade.review.plan.id === plan.id) ? `<button class="btn primary" id="tpReview" ${trade.busy ? 'disabled' : ''}>Review trade</button> <button class="btn" id="tpDiscard">Discard</button>` : ''}
        ${['SUBMITTED', 'PARTIALLY_FILLED'].includes(plan.status) && !plan.final && trade.session?.authenticated ? `<button class="btn" id="tpCancelOrder">Cancel order</button>` : ''}
        ${plan.status === 'SUBMITTED' ? '<div class="tp-note">Order <b>accepted</b> by Bitget — not yet filled.</div>' : ''}
        <div class="tp-note"><a href="/api/trade/plans/${encodeURIComponent(plan.id)}" target="_blank" rel="noopener">Audit trail</a></div>
      </div>`;
  }
  const rv = trade.review && plan && trade.review.plan.id === plan.id && plan.status === 'AWAITING_APPROVAL' ? trade.review : null;
  const confirm = rv
    ? (() => {
        const p = rv.plan;
        const ageSec = rv.market?.fetchedAt ? Math.round((Date.now() - rv.market.fetchedAt) / 1000) : null;
        const verb = p.side === 'buy' ? 'BUY' : 'SELL';
        return `<div class="tp-block tp-confirm" role="dialog" aria-label="Confirm live order">
          <div class="tp-live">⚠️ LIVE ORDER — real money on Bitget</div>
          <div class="tp-phrase">${esc(p.confirmationPhrase)}</div>
          <dl class="kv tp-kv">
            <dt>Asset</dt><dd>${esc(p.ticker)} · ${esc(p.symbol)} (${esc(p.category)})</dd>
            <dt>Direction</dt><dd>${verb} (${esc(p.direction)})</dd>
            <dt>Order type</dt><dd>Limit, good-till-cancelled, ≤ ${esc(s.status?.trading?.plan?.slippageBps ?? 10)} bps through the touch</dd>
            <dt>Quantity</dt><dd>${esc(p.quantity)}</dd>
            <dt>Estimated price</dt><dd>${money(p.estimatedPrice)}</dd>
            <dt>Notional</dt><dd>≈ ${money(p.notional)} USDT</dd>
            <dt>Stop loss</dt><dd>${money(p.stopLoss)}</dd><dt>Take profit</dt><dd>${money(p.takeProfit)}</dd>
            <dt>PRED confidence</dt><dd>${p.confidence != null ? `${p.confidence}%` : 'LOW (no live history)'}</dd>
            <dt>Current market</dt><dd>${rv.market?.bid ? `${money(rv.market.bid)} / ${money(rv.market.ask)}` : esc(rv.market?.error || '—')}${rv.market?.driftBps != null ? ` · ${rv.market.driftBps} bps from plan` : ''}</dd>
            <dt>Plan created</dt><dd>${etFull(p.createdAt)}</dd>
          </dl>
          <div class="tp-note">Market data refreshed ${ageSec ?? '—'} seconds ago. ${p.expiresInSec != null && p.expiresInSec < 60 ? `<b>Plan expires in ${p.expiresInSec}s.</b>` : ''} The server re-checks price, instrument, balance and limits before submitting.</div>
          <div class="tp-why"><b>Why PRED generated this trade</b><p>${esc(p.thesis)}</p>${(p.evidenceSummary || []).length ? `<ul>${p.evidenceSummary.map((x) => `<li>${esc(x.reason)} <span class="muted">[${esc(x.id)}]</span></li>`).join('')}</ul>` : ''}</div>
          <div class="tp-actions"><button class="btn" id="tpCancelReview">Cancel</button><button class="btn danger" id="tpExecute" ${armed && !trade.busy ? '' : 'disabled'} title="${armed ? 'Submit this exact order to Bitget' : esc(t.blockers?.join('; ') || 'execution disabled')}">Approve &amp; execute</button></div>
          ${armed ? '' : `<div class="tp-note">Execution is disabled on this server: ${esc((t.blockers || []).join('; '))}</div>`}
        </div>`;
      })()
    : '';
  const msg = trade.msg ? `<div class="tp-msg ${trade.msg.ok ? 'ok' : 'err'}">${esc(trade.msg.text)}</div>` : '';
  el.innerHTML = `${prediction}<div class="tp-block tp-execution"><div class="tp-kicker">Execution · real orders</div>${exec}${login}${body}${confirm}${msg}</div>`;
  bindTrade(e, plan);
}

function bindTrade(e, plan) {
  const on = (id, fn) => $(id)?.addEventListener(id === 'tpLogin' ? 'submit' : 'click', async (ev) => {
    ev.preventDefault();
    if (trade.busy) return;
    trade.busy = true;
    try {
      await fn();
    } catch (err) {
      trade.msg = { ok: false, text: String(err.message || err) };
    } finally {
      trade.busy = false;
      ui.snap && render(ui.snap);
    }
  });
  const done = (r, okText) => {
    trade.msg = r.status === 200 ? { ok: true, text: okText(r) } : { ok: false, text: r.error || `HTTP ${r.status}` };
  };
  on('tpLogin', async () => {
    const r = await tradeApi('/api/auth/login', { method: 'POST', body: { token: $('tpToken').value } });
    $('tpToken').value = '';
    if (r.status === 200) {
      trade.session = { authenticated: true, csrfToken: r.csrfToken };
      connect(); // the operator's stream includes trade plans
    }
    done(r, () => 'Logged in. Plans can now be reviewed.');
  });
  on('tpLogout', async () => {
    await tradeApi('/api/auth/logout', { method: 'POST' });
    trade.session = { authenticated: false, loginAvailable: true };
    trade.review = null;
    connect();
    trade.msg = null;
  });
  on('tpGenerate', async () => done(await tradeApi(`/api/trade/events/${encodeURIComponent(e.id)}/plan`, { method: 'POST' }), (r) => `Plan drafted: ${r.plan.confirmationPhrase}. Review it before anything is sent.`));
  on('tpReview', async () => {
    const r = await tradeApi(`/api/trade/plans/${encodeURIComponent(plan.id)}/review`, { method: 'POST' });
    if (r.status === 200) trade.review = { plan: r.plan, market: r.market };
    else done(r, () => '');
  });
  on('tpDiscard', async () => done(await tradeApi(`/api/trade/plans/${encodeURIComponent(plan.id)}/reject`, { method: 'POST' }), () => 'Plan discarded.'));
  on('tpCancelReview', async () => {
    trade.review = null;
    trade.msg = { ok: true, text: 'Nothing was sent.' };
  });
  on('tpExecute', async () => {
    const p = trade.review.plan;
    const r = await tradeApi(`/api/trade/plans/${encodeURIComponent(p.id)}/execute`, { method: 'POST', body: { confirmation: p.confirmationPhrase } });
    trade.review = null;
    done(r, (x) => (x.plan?.status === 'SUBMITTED' || x.plan?.status === 'PARTIALLY_FILLED' || x.plan?.status === 'FILLED' ? `Bitget accepted order ${x.plan.exchangeOrderId} (${human(x.plan.status)}).` : x.pending ? 'Submission outcome unknown — reconciling with Bitget. It will not be resent.' : `Plan is ${human(x.plan?.status)}.`));
  });
  on('tpCancelOrder', async () => done(await tradeApi(`/api/trade/plans/${encodeURIComponent(plan.id)}/cancel-order`, { method: 'POST' }), () => 'Cancel sent to Bitget.'));
}
loadSession().then(() => ui.snap && render(ui.snap));
