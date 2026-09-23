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
//   GET /api/signals              verified signals (PRED never trades)
//   GET /api/stream               SSE snapshots
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

  function liveSnapshot(selectedId) {
    const snap = live.engine.snapshot({ selectedId });
    const markets = live.marketsView();
    return {
      ...snap,
      mode: 'live',
      status: live.status(),
      markets,
      monitored: markets.map((m) => ({ ticker: m.key, company: m.company, symbol: m.symbol, price: m.lastPrice, chg1hPct: null, change24hPct: m.change24hPct, tokenizedMarket: m.tokenizedMarket, lastBarAt: m.lastCandleAt, spark: m.spark })),
      memoryLabel: 'LIVE MEMORY',
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
        if (p === '/api/signals') return json(res, 200, { ...buildSignals(live.engine), tradingEnabled: false });
        if (p === '/api/stream') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          const selected = url.searchParams.get('event');
          const c = { pending: false };
          const push = () => {
            if (c.pending) return;
            c.pending = true;
            setTimeout(() => {
              c.pending = false;
              res.write(`data: ${JSON.stringify(liveSnapshot(selected))}\n\n`);
            }, 250);
          };
          liveListeners.add(push);
          res.write(`data: ${JSON.stringify(liveSnapshot(selected))}\n\n`);
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
      if (p === '/' || p === '/app') rel = config.mode === 'live' ? 'app.html' : 'app.html';
      else if (p === '/demo') {
        if (!demos) return json(res, 404, { error: 'demo disabled in this deployment' });
        rel = 'app.html';
      } else if (p === '/about') rel = 'index.html';
      else rel = p.slice(1);
      const file = path.normalize(path.join(WEB, rel));
      if (!file.startsWith(WEB + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', ...SECURITY_HEADERS });
      fs.createReadStream(file).pipe(res);
    } catch (err) {
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
