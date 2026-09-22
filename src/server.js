// PRED server: zero-dependency HTTP + Server-Sent Events.
//
//   GET  /                       dashboard
//   GET  /api/state?mode=&event= snapshot (live | demo)
//   GET  /api/stream?mode=&event= SSE snapshots
//   GET  /api/events/:id?mode=   full event detail
//   GET  /api/signals?mode=      verified signals for an external execution agent
//   POST /api/demo/next | /api/demo/reset | /api/demo/autoplay?on=1
//   GET  /api/health

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
import { createDemo } from './demo/runner.js';
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

// ---------- DEMO ----------
const demo = createDemo();

const engineFor = (mode) => (mode === 'live' ? live : demo.engine);

function snapshot(mode, selectedId) {
  const snap = engineFor(mode).snapshot({ selectedId });
  if (mode === 'demo') snap.demo = demo.status();
  return snap;
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const clients = new Set();
function broadcast() {
  for (const c of clients) {
    if (c.pending) continue;
    c.pending = true;
    setTimeout(() => {
      c.pending = false;
      c.res.write(`data: ${JSON.stringify(snapshot(c.mode, c.selected))}\n\n`);
    }, 150);
  }
}
live.onChange(broadcast);
let unsubDemo = demo.engine.onChange(broadcast);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const mode = url.searchParams.get('mode') === 'live' ? 'live' : 'demo';
  try {
    if (url.pathname === '/api/health') return json(res, 200, { ok: true, live: live.feedStatus, demoStep: demo.status().step });
    if (url.pathname === '/api/state') return json(res, 200, snapshot(mode, url.searchParams.get('event')));
    if (url.pathname.startsWith('/api/events/')) {
      const d = engineFor(mode).eventDetail(decodeURIComponent(url.pathname.split('/').pop()));
      return d ? json(res, 200, d) : json(res, 404, { error: 'not found' });
    }
    if (url.pathname === '/api/signals') return json(res, 200, buildSignals(engineFor(mode)));
    if (url.pathname === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      const c = { res, mode, selected: url.searchParams.get('event'), pending: false };
      clients.add(c);
      res.write(`data: ${JSON.stringify(snapshot(mode, c.selected))}\n\n`);
      const ka = setInterval(() => res.write(': ka\n\n'), 20_000);
      req.on('close', () => {
        clearInterval(ka);
        clients.delete(c);
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/demo/next') {
      demo.next().then(broadcast);
      return json(res, 202, demo.status());
    }
    if (req.method === 'POST' && url.pathname === '/api/demo/reset') {
      unsubDemo();
      demo.reset();
      unsubDemo = demo.engine.onChange(broadcast);
      broadcast();
      return json(res, 200, demo.status());
    }
    if (req.method === 'POST' && url.pathname === '/api/demo/autoplay') {
      const on = url.searchParams.get('on') !== '0';
      if (on) demo.autoplay(true).then(broadcast);
      else demo.autoplay(false);
      broadcast();
      return json(res, 202, demo.status());
    }
    // static
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
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
