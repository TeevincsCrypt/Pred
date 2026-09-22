// PRED server: zero-dependency HTTP + Server-Sent Events.
//
//   GET  /                            landing page
//   GET  /app                         dashboard
//   GET  /api/state?mode=&event=&sid= snapshot (live | demo)
//   GET  /api/stream?mode=&event=&sid= SSE snapshots
//   GET  /api/events/:id?mode=&sid=   full event detail
//   GET  /api/signals?mode=&sid=      verified signals for an external execution agent
//   POST /api/demo/next | /api/demo/reset | /api/demo/autoplay?on=1   (all take &sid=)
//   GET  /api/track-record            simulated-backtest memory stats (landing page)
//   GET  /api/health
//
// Demo mode is per browser session (`sid`), so concurrent visitors never
// drive each other's scenario. LIVE mode is shared: there is one market.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { createEngine } from './core/engine.js';
import { createMemory } from './agents/memory.js';
import { createAnalyst } from './agents/analyst.js';
import { createLiveFeed } from './market/feed-live.js';
import { ASSETS, CRYPTO_REFS } from './market/universe.js';
import { createSecSource } from './sources/sec.js';
import { createNewsSource } from './sources/news.js';
import { createCalendarSource } from './sources/calendar.js';
import { createUnavailableSource } from './sources/unavailable.js';
import { createDemoSessions } from './demo/sessions.js';
import { generateSeed } from './demo/seed.js';
import { buildSignals } from './core/signals.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(here, '..', 'web');

// ---------- LIVE ----------
const liveMemory = createMemory({ file: config.memoryFile });
if (process.env.PRED_LIVE_BOOTSTRAP_SEED === '1' && !liveMemory.records.some((r) => r.provenance === 'SIMULATED')) {
  for (const r of generateSeed()) liveMemory.upsert({ ...r, id: `bootstrap-${r.seq}` });
}
const live = createEngine({
  mode: 'live',
  universe: ASSETS,
  monitored: config.monitored.filter((t) => ASSETS[t]),
  cryptoRefs: CRYPTO_REFS,
  sources: [
    createNewsSource(),
    createSecSource(),
    createUnavailableSource('social', 'Social / web signals', 'social', 'No social data connector configured'),
    createCalendarSource(),
  ],
  memory: liveMemory,
  analyst: createAnalyst(),
  feedName: 'Bitget',
  feedProvenance: 'LIVE',
});
const feed = createLiveFeed({ engine: live, universe: ASSETS, monitored: config.monitored.filter((t) => ASSETS[t]), cryptoRefs: CRYPTO_REFS, pollMs: config.pollMs });
if (config.live) feed.start();
else live.setFeedStatus({ status: 'disabled', note: 'Live feed disabled (PRED_LIVE=0)' });

// ---------- DEMO (one per browser session) ----------
const demos = createDemoSessions();
const liveListeners = new Set();
live.onChange(() => {
  for (const fn of liveListeners) fn();
});

// Static track record for the landing page: the simulated backtest seed.
const trackRecord = (() => {
  const mem = createMemory({ records: generateSeed() });
  const s = mem.stats();
  return { provenance: 'SIMULATED', note: 'Simulated backtest: synthetic events run through PRED\'s real models (walk-forward)', total: s.total, confirmedCatalysts: s.confirmedCatalysts, liquidityAnomalies: s.liquidityAnomalies, falseHypotheses: s.falseHypotheses, unresolvedOther: s.unresolvedOther, accuracy: s.accuracy, calibration: s.calibration, failures: s.failures, recent: s.recent };
})();

function snapshot(mode, selectedId, sid) {
  if (mode === 'live') return live.snapshot({ selectedId });
  const d = demos.get(sid).demo;
  return { ...d.engine.snapshot({ selectedId }), demo: d.status() };
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

// Each SSE client listens only to its own engine, throttled.
function makePush(c) {
  return () => {
    if (c.pending) return;
    c.pending = true;
    setTimeout(() => {
      c.pending = false;
      c.res.write(`data: ${JSON.stringify(snapshot(c.mode, c.selected, c.sid))}\n\n`);
    }, 150);
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const mode = url.searchParams.get('mode') === 'live' ? 'live' : 'demo';
  const sid = url.searchParams.get('sid');
  const engineFor = () => (mode === 'live' ? live : demos.get(sid).demo.engine);
  try {
    if (url.pathname === '/api/health') return json(res, 200, { ok: true, live: live.feedStatus, demoSessions: demos.size });
    if (url.pathname === '/api/track-record') return json(res, 200, trackRecord);
    if (url.pathname === '/api/state') return json(res, 200, snapshot(mode, url.searchParams.get('event'), sid));
    if (url.pathname.startsWith('/api/events/')) {
      const d = engineFor().eventDetail(decodeURIComponent(url.pathname.split('/').pop()));
      return d ? json(res, 200, d) : json(res, 404, { error: 'not found' });
    }
    if (url.pathname === '/api/signals') return json(res, 200, buildSignals(engineFor()));
    if (url.pathname === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      const c = { res, mode, sid, selected: url.searchParams.get('event'), pending: false };
      const push = makePush(c);
      const session = mode === 'demo' ? demos.get(sid) : null;
      const listeners = session ? session.listeners : liveListeners;
      listeners.add(push);
      res.write(`data: ${JSON.stringify(snapshot(mode, c.selected, sid))}\n\n`);
      const ka = setInterval(() => res.write(': ka\n\n'), 20_000);
      req.on('close', () => {
        clearInterval(ka);
        listeners.delete(push);
      });
      return;
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/demo/')) {
      const s = demos.get(sid);
      const action = url.pathname.split('/').pop();
      if (action === 'next') s.demo.next().then(s.notify);
      else if (action === 'reset') demos.reset(s);
      else if (action === 'autoplay') {
        const on = url.searchParams.get('on') !== '0';
        if (on) s.demo.autoplay(true).then(s.notify);
        else s.demo.autoplay(false);
      } else return json(res, 404, { error: 'unknown demo action' });
      s.notify();
      return json(res, 202, s.demo.status());
    }
    // static
    const rel = url.pathname === '/' ? 'index.html' : url.pathname === '/app' ? 'app.html' : url.pathname.slice(1);
    const file = path.normalize(path.join(WEB, rel));
    if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    json(res, 500, { error: err.message });
  }
});

server.listen(config.port, () => {
  console.log(`PRED listening on http://localhost:${config.port}`);
  console.log(`  live feed: ${config.live ? 'Bitget public API' : 'disabled'} · analyst: ${createAnalyst().enabled ? 'Claude' : 'template'}`);
});
