// PRED server — zero-dependency HTTP + Server-Sent Events.
//
// LIVE (default, PRED_MODE=live)
//   GET /                         live dashboard          GET /about   landing page
//   GET /api/health               liveness + database
//   GET /api/status               market status, connections, counts
//   GET /api/assets               discovered Bitget tokenized-equity universe
//   GET /api/market/:key          rolling market state (+ ?depth=1 order book)
//   GET /api/events[?active=1]    Ghost Events
//   GET /api/events/:id           full event
//   GET /api/events/:id/timeline  timeline + append-only audit log
//   GET /api/events/:id/hypotheses
//   GET /api/events/:id/evidence
//   GET /api/memory               LIVE MEMORY statistics
//   GET /api/signals              verified signals (agents never trade)
//   GET /api/stream               SSE snapshots
//
// TRADE (human-approved execution; see src/trading/)
//   GET  /api/auth/session                 { authenticated, csrfToken? }
//   POST /api/auth/login {token}           operator login (PRED_ADMIN_TOKEN)
//   POST /api/auth/logout
//   GET  /api/trade/status                 execution readiness + limits (no secrets)
//   GET  /api/trade/plans[?event=id]       trade plans
//   GET  /api/trade/plans/:id              plan + audit trail
//   POST /api/trade/events/:id/plan        human: draft a fresh plan
//   POST /api/trade/plans/:id/review       human: fresh quote for the confirmation panel
//   POST /api/trade/plans/:id/reject       human: discard plan
//   POST /api/trade/plans/:id/execute {confirmation}  human: APPROVE & EXECUTE
//   POST /api/trade/plans/:id/cancel-order human: cancel the live exchange order
// Every POST requires the session cookie, X-PRED-CSRF and a same-origin Origin.
// The browser only names a plan id; the server builds the order.
//
// DEMO (simulated; only when PRED_MODE=demo or PRED_DEMO_ENABLED=true)
//   GET /demo, /api/demo/state|stream|signals, POST /api/demo/next|reset|autoplay
// Demo engines, memory and data never touch the live runtime.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { config as defaultConfig } from './config.js';
import { buildSignals } from './core/signals.js';
import { logOp } from './util/log.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(here, '..', 'web');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};
const EVENT_ID_RE = /^[a-z]+-\d{1,9}$/;
const KEY_RE = /^[A-Za-z0-9:_-]{1,40}$/;

const PLAN_ID_RE = /^TP_[a-z0-9]{6,40}$/;

async function readJson(req, limit = 4096) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('request body too large'), { http: 413 });
    chunks.push(c);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw Object.assign(new Error('body must be a JSON object'), { http: 400 });
  }
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

export async function createPredServer({ config = defaultConfig, runtime = null, fetchImpl = fetch } = {}) {
  let live = runtime;
  if (!live && config.mode === 'live') {
    const { createLiveRuntime } = await import('./live/runtime.js');
    live = createLiveRuntime({ config, fetchImpl });
  }
  let demos = null;
  if (config.demoEnabled) {
    const { createDemoSessions } = await import('./demo/sessions.js');
    demos = createDemoSessions();
  }

  const liveListeners = new Set();
  const notifyLive = () => {
    for (const fn of liveListeners) fn();
  };
  if (live) live.engine.onChange(notifyLive);
  const tick = live ? setInterval(notifyLive, Math.max(5000, config.pollIntervalMs)) : null;
  tick?.unref?.();

  function liveSnapshot(selectedId, operator = false) {
    const snap = live.engine.snapshot({ selectedId });
    const markets = live.marketsView();
    return {
      ...snap,
      mode: 'live',
      status: live.status(),
      markets,
      monitored: markets.map((m) => ({ ticker: m.key, company: m.company, symbol: m.symbol, price: m.lastPrice, chg1hPct: null, change24hPct: m.change24hPct, tokenizedMarket: m.tokenizedMarket, lastBarAt: m.lastCandleAt, spark: m.spark })),
      memoryLabel: 'LIVE MEMORY',
      // Read-only view of the selected event's trade plans, for the logged-in
      // operator's stream only (SSE can never execute).
      tradePlans: operator && snap.selected ? live.trading.plansForEvent(snap.selected.id) : [],
    };
  }
  function demoSnapshot(selectedId, sid) {
    const d = demos.get(sid).demo;
    return { ...d.engine.snapshot({ selectedId }), demo: d.status(), memoryLabel: 'SIMULATED MEMORY' };
  }

  const orderbookCache = new Map();

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return json(res, 400, { error: 'bad url' });
    }
    const p = url.pathname;
    try {
      // ---------- live API ----------
      if (p === '/api/health') {
        let db = null;
        try {
          db = live ? live.db.health() : null;
        } catch (err) {
          db = { status: 'disconnected', error: err.message };
        }
        return json(res, 200, { ok: true, mode: config.mode, uptimeSec: Math.round(process.uptime()), database: db?.status ?? null, bitget: live?.client.health.status ?? null });
      }
      if (p.startsWith('/api/') && !p.startsWith('/api/demo/')) {
        if (!live) return json(res, 404, { error: 'live mode disabled (PRED_MODE=demo)' });
        if (p === '/api/status') return json(res, 200, live.status());

        // ---------- operator auth + human-approved trading ----------
        if (p === '/api/auth/session') return json(res, 200, live.auth.session(req));
        if (p === '/api/auth/login') {
          if (req.method !== 'POST') return json(res, 405, { error: 'POST required' });
          const body = await readJson(req);
          const r = live.auth.login(req, body.token);
          if (!r.ok) return json(res, r.code, { error: r.error });
          res.setHeader('Set-Cookie', r.cookie);
          return json(res, 200, { authenticated: true, csrfToken: r.csrfToken, expiresAt: r.expiresAt });
        }
        if (p === '/api/auth/logout') {
          if (req.method !== 'POST') return json(res, 405, { error: 'POST required' });
          res.setHeader('Set-Cookie', live.auth.logout(req));
          return json(res, 200, { authenticated: false });
        }
        if (p === '/api/trade/status') return json(res, 200, live.trading.status({ operator: live.auth.session(req).authenticated }));
        // Trade plans, fills and the audit trail are account information: operator only.
        if ((p === '/api/trade/plans' || p.startsWith('/api/trade/plans/')) && req.method === 'GET' && !live.auth.session(req).authenticated) return json(res, 401, { error: 'operator login required' });
        if (p === '/api/trade/plans') {
          const ev = url.searchParams.get('event');
          if (ev && !EVENT_ID_RE.test(ev)) return json(res, 400, { error: 'invalid event id' });
          return json(res, 200, { plans: ev ? live.trading.plansForEvent(ev) : live.trading.recentPlans(50), execution: live.trading.status({ operator: true }) });
        }
        const tp = /^\/api\/trade\/plans\/([^/]+)(?:\/(review|reject|execute|cancel-order))?$/.exec(p);
        const te = /^\/api\/trade\/events\/([^/]+)\/plan$/.exec(p);
        if (tp || te) {
          const id = decodeURIComponent((tp || te)[1]);
          if (tp && !PLAN_ID_RE.test(id)) return json(res, 400, { error: 'invalid trade plan id' });
          if (te && !EVENT_ID_RE.test(id)) return json(res, 400, { error: 'invalid event id' });
          if (tp && !tp[2]) {
            if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });
            const plan = live.trading.getPlan(id);
            return plan ? json(res, 200, { plan, audit: live.trading.audit(id), execution: live.trading.status({ operator: true }) }) : json(res, 404, { error: 'trade plan not found' });
          }
          // State-changing: POST + operator session + CSRF + same origin.
          const gate = live.auth.requireHuman(req);
          if (!gate.ok) return json(res, gate.code, { error: gate.error });
          const body = await readJson(req);
          let r;
          if (te) r = await live.trading.requestPlan(id, gate.approval);
          else if (tp[2] === 'review') r = await live.trading.reviewPlan(id, gate.approval);
          else if (tp[2] === 'reject') r = await live.trading.rejectPlan(id, gate.approval);
          else if (tp[2] === 'execute') r = await live.trading.approveAndExecute(id, gate.approval, { confirmation: typeof body.confirmation === 'string' ? body.confirmation.slice(0, 80) : undefined });
          else r = await live.trading.cancelOrder(id, gate.approval);
          notifyLive();
          const { code, ...rest } = r;
          return json(res, r.ok ? 200 : code || 400, rest);
        }
        if (p === '/api/assets') return json(res, 200, { venue: 'Bitget', endpoint: '/api/v3/market/instruments (isRwa=YES spot; symbolType=stock futures)', discoveredAt: live.market.status.discoveredAt, count: live.market.assets.length, monitored: live.engine.monitored.length, unmatchedFilter: live.market.unmatched, assets: live.assetsView() });
        if (p.startsWith('/api/market/')) {
          const key = decodeURIComponent(p.slice('/api/market/'.length));
          if (!KEY_RE.test(key)) return json(res, 400, { error: 'invalid symbol' });
          const asset = live.market.assets.find((a) => a.key === key || a.symbol === key);
          if (!asset) return json(res, 404, { error: 'not in the discovered Bitget universe' });
          const state = live.market.marketState(asset.key);
          const candles = live.engine.store.candles(asset.key).slice(-240);
          let orderbook = { available: false, note: 'add ?depth=1' };
          if (url.searchParams.get('depth') === '1') {
            const hit = orderbookCache.get(asset.key);
            if (hit && Date.now() - hit.at < 5000) orderbook = hit.value;
            else {
              try {
                orderbook = { available: true, ...(await live.client.orderbook(asset.category, asset.symbol, 10)) };
              } catch (err) {
                orderbook = { available: false, error: err.message };
              }
              orderbookCache.set(asset.key, { at: Date.now(), value: orderbook });
            }
          }
          return json(res, 200, { asset, state, candles, orderbook });
        }
        if (p === '/api/events') {
          const active = url.searchParams.get('active') === '1';
          const list = live.engine.snapshot().events.filter((e) => !active || (!e.closed && !['CONFIRMED', 'INVALIDATED', 'UNRESOLVED'].includes(e.state)));
          return json(res, 200, { count: list.length, events: list, message: list.length ? null : 'No active Ghost Events detected.' });
        }
        const m = /^\/api\/events\/([^/]+)(?:\/(timeline|hypotheses|evidence))?$/.exec(p);
        if (m) {
          const id = decodeURIComponent(m[1]);
          if (!EVENT_ID_RE.test(id)) return json(res, 400, { error: 'invalid event id' });
          const e = live.engine.eventDetail(id);
          if (!e) return json(res, 404, { error: 'event not found' });
          if (m[2] === 'timeline') return json(res, 200, { id, timeline: e.timeline, auditLog: live.db.eventLog(id) });
          if (m[2] === 'hypotheses') return json(res, 200, { id, revisions: e.revisions });
          if (m[2] === 'evidence') return json(res, 200, { id, sourceChecks: e.sourceChecks, evidence: e.evidence });
          return json(res, 200, e);
        }
        if (p === '/api/memory') {
          const s = live.memory.stats();
          const verified = s.confirmedCatalysts + s.falseHypotheses + s.liquidityAnomalies;
          return json(res, 200, { label: 'LIVE MEMORY', verifiedEvents: verified, message: s.total ? null : 'PRED MEMORY · 0 verified events', insufficientHistory: verified < 5, ...s });
        }
        if (p === '/api/signals') return json(res, 200, { ...buildSignals(live.engine), tradingEnabled: live.trading.status().executionEnabled, note: 'Signals never trade. Orders require a human-approved trade plan.' });
        if (p === '/api/stream') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          const selected = url.searchParams.get('event');
          const operator = live.auth.session(req).authenticated;
          const c = { pending: false };
          const push = () => {
            if (c.pending) return;
            c.pending = true;
            setTimeout(() => {
              c.pending = false;
              res.write(`data: ${JSON.stringify(liveSnapshot(selected, operator))}\n\n`);
            }, 250);
          };
          liveListeners.add(push);
          res.write(`data: ${JSON.stringify(liveSnapshot(selected, operator))}\n\n`);
          const ka = setInterval(() => res.write(': ka\n\n'), 20_000);
          req.on('close', () => {
            clearInterval(ka);
            liveListeners.delete(push);
          });
          return;
        }
        return json(res, 404, { error: 'not found' });
      }

      // ---------- demo API (simulated, isolated) ----------
      if (p.startsWith('/api/demo/')) {
        if (!demos) return json(res, 404, { error: 'demo disabled (set PRED_DEMO_ENABLED=true)' });
        const sid = url.searchParams.get('sid');
        const action = p.slice('/api/demo/'.length);
        if (action === 'state') return json(res, 200, demoSnapshot(url.searchParams.get('event'), sid));
        if (action === 'signals') return json(res, 200, { ...buildSignals(demos.get(sid).demo.engine), provenance: 'SIMULATED' });
        if (action === 'stream') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          const session = demos.get(sid);
          const selected = url.searchParams.get('event');
          const c = { pending: false };
          const push = () => {
            if (c.pending) return;
            c.pending = true;
            setTimeout(() => {
              c.pending = false;
              res.write(`data: ${JSON.stringify(demoSnapshot(selected, sid))}\n\n`);
            }, 150);
          };
          session.listeners.add(push);
          res.write(`data: ${JSON.stringify(demoSnapshot(selected, sid))}\n\n`);
          const ka = setInterval(() => res.write(': ka\n\n'), 20_000);
          req.on('close', () => {
            clearInterval(ka);
            session.listeners.delete(push);
          });
          return;
        }
        if (req.method === 'POST') {
          const s = demos.get(sid);
          if (action === 'next') s.demo.next().then(s.notify);
          else if (action === 'reset') demos.reset(s);
          else if (action === 'autoplay') {
            if (url.searchParams.get('on') !== '0') s.demo.autoplay(true).then(s.notify);
            else s.demo.autoplay(false);
          } else return json(res, 404, { error: 'unknown demo action' });
          s.notify();
          return json(res, 202, s.demo.status());
        }
        return json(res, 404, { error: 'not found' });
      }

      // ---------- pages & static ----------
      let rel;
      // "/" is the landing page; the live dashboard is at /app.
      if (p === '/' || p === '/about') rel = 'index.html';
      else if (p === '/app') rel = 'app.html';
      else if (p === '/demo') {
        if (!demos) return json(res, 404, { error: 'demo disabled in this deployment' });
        rel = 'app.html';
      } else rel = p.slice(1);
      const file = path.normalize(path.join(WEB, rel));
      if (!file.startsWith(WEB + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', ...SECURITY_HEADERS });
      fs.createReadStream(file).pipe(res);
    } catch (err) {
      if (err?.http) return json(res, err.http, { error: err.message });
      logOp({ component: 'server', op: 'REQUEST', status: 'FAILURE', path: p, error: err });
      json(res, 500, { error: 'internal error' });
    }
  });

  return {
    server,
    live,
    demos,
    listen(port = config.port) {
      return new Promise((resolve) => server.listen(port, () => resolve(server.address().port)));
    },
    async close() {
      clearInterval(tick);
      live?.stop();
      await new Promise((r) => server.close(r));
      server.closeAllConnections?.();
    },
  };
}

// Entry point.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const app = await createPredServer();
  const port = await app.listen();
  logOp({ component: 'server', op: 'LISTEN', port, mode: defaultConfig.mode, demo: defaultConfig.demoEnabled });
  console.log(`PRED ${defaultConfig.mode.toUpperCase()} on http://localhost:${port}${defaultConfig.demoEnabled ? ' · simulated demo at /demo' : ''}`);
  if (app.live && defaultConfig.live) app.live.start().catch((err) => logOp({ component: 'server', op: 'LIVE_START', status: 'FAILURE', error: err }));
  const shutdown = async () => {
    await app.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
