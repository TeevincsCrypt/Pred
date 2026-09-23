// Production health check — run it where PRED is deployed:
//   npm run check:live
// Exercises the real endpoints: Bitget (time, instruments, tickers, candles,
// order book), SEC EDGAR, GDELT, the SQLite database, the SSE server and
// detector startup. Prints ✓ or the exact failure; exits 1 on any failure.

import { createBitgetClient } from '../src/market/bitget.js';
import { buildUniverse } from '../src/market/live-universe.js';
import { loadRelationships } from '../src/market/relationships.js';
import { createSecSource } from '../src/sources/sec.js';
import { createNewsSource } from '../src/sources/news.js';
import { openDb } from '../src/store/db.js';
import { measure } from '../src/agents/detector.js';
import { config } from '../src/config.js';

process.env.PRED_LOG_LEVEL = process.env.PRED_LOG_LEVEL || 'silent';
const results = [];
const ok = (name, detail) => {
  results.push({ name, ok: true });
  console.log(`✓ ${name.padEnd(13)} ${detail}`);
};
const HINTS = [
  [/CERT|certificate|self[- ]signed/i, 'TLS certificate rejected — antivirus or a proxy is intercepting HTTPS. Node 22.15+: set $env:NODE_OPTIONS="--use-system-ca" (PowerShell) to trust the Windows certificate store, or disable HTTPS scanning for node.exe.'],
  [/bitget: timeout|ENOTFOUND|ECONNREFUSED|ECONNRESET|fetch failed/i, 'this machine cannot reach Bitget — test with `curl.exe -m 10 https://api.bitget.com/api/v2/public/time`; if that also fails, your ISP/DNS/firewall blocks it (try DNS 1.1.1.1 or a VPN) or raise BITGET_TIMEOUT_MS. The Railway deployment has its own network.'],
];
const fail = (name, err) => {
  results.push({ name, ok: false });
  const msg = String(err?.message || err);
  const hint = HINTS.find(([re]) => re.test(msg))?.[1];
  console.log(`✗ ${name.padEnd(13)} ${msg}${hint ? `\n                → ${hint}` : ''}`);
};
// Reachable but throttled: reported, not counted as a failure.
const warn = (name, detail) => {
  results.push({ name, ok: true, warn: true });
  console.log(`⚠ ${name.padEnd(13)} ${detail}`);
};
const step = async (name, fn) => {
  try {
    ok(name, await fn());
  } catch (err) {
    fail(name, err);
  }
};

console.log(`PRED live check · Bitget ${config.bitgetBaseUrl} · ${new Date().toISOString()}\n`);
const client = createBitgetClient({ baseUrl: config.bitgetBaseUrl });
let spot = [];
let universe = null;
let sample = null;

await step('Bitget', async () => {
  const t = await client.serverTime();
  if (!t) throw new Error('no serverTime in response');
  return `server time ${new Date(t).toISOString()} (clock skew ${Math.round((Date.now() - t) / 1000)}s)`;
});

await step('Instruments', async () => {
  spot = await client.instruments('SPOT');
  const futures = await client.instruments('USDT-FUTURES').catch(() => []);
  universe = buildUniverse({ spot, futures, relationships: loadRelationships(), opts: { assetsFilter: config.assets, maxAssets: config.maxAssets, categories: config.categories } });
  const rwa = universe.assets;
  if (!rwa.length) throw new Error(`${spot.length} spot instruments, but none flagged isRwa=YES and no stock perpetuals — nothing to monitor`);
  sample = universe.assets.find((a) => universe.monitored.includes(a.key)) || rwa[0];
  const spotRwa = rwa.filter((a) => a.category === 'SPOT').length;
  return `${spot.length} spot instruments · ${spotRwa} tokenized-equity spot (isRwa) · ${rwa.length - spotRwa} stock perps · ${universe.monitored.length} would be monitored · e.g. ${rwa.slice(0, 8).map((a) => a.symbol).join(', ')}${universe.unmatched.length ? ` · PRED_ASSETS not listed: ${universe.unmatched.join(',')}` : ''}`;
});

await step('Market Data', async () => {
  if (!sample) throw new Error('no instrument to test');
  const [t] = await client.tickers(sample.category, sample.symbol);
  if (!t || t.last == null) throw new Error(`no ticker price for ${sample.symbol}`);
  const bars = await client.candles(sample.category, sample.symbol, { limit: 200 });
  if (!bars.length) throw new Error(`no candles for ${sample.symbol}`);
  let book = 'order book n/a';
  try {
    const ob = await client.orderbook(sample.category, sample.symbol, 5);
    book = ob.bids.length && ob.asks.length ? `book ${ob.bids[0].price} / ${ob.asks[0].price}` : 'order book empty';
  } catch (err) {
    book = `order book error: ${err.message}`;
  }
  const last = bars.at(-1);
  const m = measure(bars, { windowBars: 5, baselineBars: 120, minBaselineBars: 45 });
  results.detector = m;
  return `${sample.symbol} last ${t.last} · 24h vol ${t.volume24h ?? 'n/a'} · bid/ask ${t.bid ?? 'n/a'}/${t.ask ?? 'n/a'} · ${bars.length} 1m candles, latest ${new Date(last.ts).toISOString()} · ${book}`;
});

await step('SEC', async () => {
  const sec = createSecSource();
  if (!sec.configured) throw new Error('SEC_USER_AGENT not set (EDGAR requires "Name contact@email")');
  const p = await sec.probe();
  const r = await sec.collect({ asset: { underlying: sample?.underlying || 'NVDA', ticker: sample?.key || 'NVDA', company: sample?.company || 'NVIDIA' }, now: Date.now() });
  if (r.status !== 'ok') throw new Error(r.note);
  return `${p.note} · ${sample?.underlying || 'NVDA'}: ${r.note}`;
});

{
  // GDELT allows one request per ~5s per IP and answers faster callers (or
  // busy shared IPs) with HTTP 429. That proves it is reachable, so after
  // one spaced retry a 429 is a warning, not a failure.
  const asset = { ticker: sample?.key || 'NVDA', company: sample?.company || 'NVIDIA', newsTerms: sample?.newsTerms?.length ? sample.newsTerms : ['NVIDIA'] };
  const attempt = async () => {
    const r = await createNewsSource().collect({ asset, now: Date.now() });
    if (r.status !== 'ok') throw new Error(r.note);
    return r.note;
  };
  try {
    ok('GDELT', await attempt());
  } catch (err) {
    if (!/429|rate limited/i.test(String(err.message))) fail('GDELT', err);
    else {
      await new Promise((r) => setTimeout(r, 20_000));
      try {
        ok('GDELT', await attempt());
      } catch (err2) {
        if (/429|rate limited/i.test(String(err2.message))) warn('GDELT', 'reachable but rate-limited (HTTP 429) from this IP — PRED spaces and caches GDELT calls and retries automatically; re-run in a few minutes');
        else fail('GDELT', err2);
      }
    }
  }
}

await step('Database', async () => {
  const db = openDb(config.dbPath);
  const h = db.health();
  db.close();
  return `${h.file} writable · ${h.counts.events} live events, ${h.counts.logEntries} audit entries, ${h.counts.candles} stored candles${process.env.RAILWAY_ENVIRONMENT && !process.env.RAILWAY_VOLUME_MOUNT_PATH ? ' · WARNING: no Railway volume attached, data will not survive redeploys' : ''}`;
});

await step('SSE', async () => {
  const { createPredServer } = await import('../src/server.js');
  const app = await createPredServer({ config: { ...config, mode: 'live', demoEnabled: false, dbPath: ':memory:' } });
  const port = await app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/stream`, { signal: AbortSignal.timeout(5000) });
    const reader = res.body.getReader();
    const { value } = await reader.read();
    reader.cancel();
    const text = new TextDecoder().decode(value);
    if (!text.startsWith('data: ') || !text.includes('"mode":"live"')) throw new Error('first SSE frame was not a live snapshot');
    return `stream delivers live snapshots (${text.length} bytes first frame)`;
  } finally {
    await app.close();
  }
});

await step('Detector', async () => {
  const m = results.detector;
  if (m === undefined) throw new Error('no candles to run on');
  if (m === null) return `started · ${sample.symbol}: not enough contiguous 1m bars yet for a baseline (needs 50) — detection starts once history accrues`;
  return `started · ${sample.symbol} now: ${m.retPct}% over 5m (${m.priceZ}σ), volume ${m.volumeRatio}× baseline — ${Math.abs(m.priceZ) >= 3.5 && m.volumeRatio >= 2.5 ? 'ANOMALOUS' : 'normal'}`;
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? `${failed.length} check(s) failed: ${failed.map((f) => f.name).join(', ')}` : 'All checks passed — PRED can run LIVE here.'}`);
// Set the exit code and let the event loop drain; calling process.exit()
// while fetch sockets are closing aborts Node on Windows (libuv assertion).
process.exitCode = failed.length ? 1 : 0;
setTimeout(() => process.exit(), 3000).unref();
