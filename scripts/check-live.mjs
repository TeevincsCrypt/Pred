// Production health check — run it where PRED is deployed:
//   npm run check:live
// Exercises the real endpoints: Bitget (time, instruments, tickers, candles,
// order book), SEC EDGAR, GDELT, the SQLite database, the SSE server and
// detector startup, plus the human-approved execution layer (credentials,
// account, a dry-run trade plan, the approval gate and safety limits).
// Prints ✓ or the exact failure; exits 1 on any failure.
//
// check:live NEVER places an order: the trading service it builds is given a
// Bitget client whose placeOrder throws, and every execution attempt it makes
// is one that must be refused.

import { createBitgetClient } from '../src/market/bitget.js';
import { buildUniverse } from '../src/market/live-universe.js';
import { loadRelationships } from '../src/market/relationships.js';
import { createSecSource } from '../src/sources/sec.js';
import { createNewsSource } from '../src/sources/news.js';
import { openDb } from '../src/store/db.js';
import { measure } from '../src/agents/detector.js';
import { config } from '../src/config.js';
import { createBitgetPrivateClient, credentialsFromEnv } from '../src/trading/bitget-private.js';
import { createTradeStore } from '../src/trading/store.js';
import { createTradingService } from '../src/trading/execution.js';
import { buildPlan } from '../src/trading/rules.js';

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

// ---------- human-approved execution (no order is ever placed here) ----------
const tcfg = config.trading;
const armedWanted = tcfg.enabled;
const priv = createBitgetPrivateClient({ baseUrl: config.bitgetBaseUrl });
// The service below can never submit: placeOrder/cancelOrder throw.
const neverTrade = {
  ...priv,
  configured: priv.configured,
  health: priv.health,
  readOnly: priv.readOnly,
  placeOrder: () => {
    throw new Error('check:live must never place an order');
  },
  cancelOrder: () => {
    throw new Error('check:live must never cancel an order');
  },
};
let placeAttempted = false;
const guarded = { ...neverTrade, placeOrder: (...a) => ((placeAttempted = true), neverTrade.placeOrder(...a)) };

await step('Execution cfg', async () => `PRED_TRADING_ENABLED=${tcfg.enabled ? 'true (ARMED)' : 'false (safe default — no live orders)'} · margin ${tcfg.marginMode} · plan ≈${tcfg.planNotional} USDT, TTL ${Math.round(tcfg.planTtlMs / 1000)}s, drift ≤${tcfg.maxDriftBps} bps`);

{
  const limits = [['PRED_MAX_ORDER_NOTIONAL', tcfg.maxOrderNotional], ['PRED_MAX_POSITION_NOTIONAL', tcfg.maxPositionNotional], ['PRED_MAX_DAILY_TRADING_NOTIONAL', tcfg.maxDailyNotional]];
  const missing = limits.filter(([, v]) => v == null).map(([k]) => k);
  const text = limits.map(([k, v]) => `${k.replace('PRED_', '').toLowerCase()}=${v ?? 'unset'}`).join(' · ');
  if (!missing.length) ok('Safety limits', `${text} (USDT)`);
  else if (armedWanted) fail('Safety limits', new Error(`${missing.join(', ')} not set — execution stays disabled`));
  else warn('Safety limits', `${text} — set all three before enabling trading`);
}

if (credentialsFromEnv()) ok('Credentials', 'BITGET_API_KEY / BITGET_API_SECRET / BITGET_API_PASSPHRASE configured (values not shown)');
else if (armedWanted) fail('Credentials', new Error('PRED_TRADING_ENABLED=true but Bitget API credentials are missing'));
else warn('Credentials', 'Bitget API credentials not configured — trade plans are view-only');

if (priv.configured) {
  await step('Account', async () => {
    const st = await priv.accountSettings();
    const mode = String(st?.accountMode || 'unknown');
    if (!['unified', 'hybrid'].includes(mode.toLowerCase())) throw new Error(`account mode "${mode}" — PRED executes through the Unified Trading API; upgrade the Bitget account to a Unified Trading Account`);
    const assets = await priv.accountAssets();
    const hasUsdt = (assets?.assets || []).some((a) => a.coin === 'USDT');
    return `authenticated · account mode ${mode} · hold mode ${st?.holdMode ?? 'n/a'} · balances readable${hasUsdt ? '' : ' (no USDT balance)'} · amounts not shown`;
  });
} else if (armedWanted) fail('Account', new Error('cannot check the account without credentials'));
else warn('Account', 'skipped — no credentials');

const auth = (process.env.PRED_ADMIN_TOKEN || '').length >= 24;
if (auth) ok('Approval login', 'PRED_ADMIN_TOKEN configured (value not shown)');
else if (armedWanted) fail('Approval login', new Error('PRED_ADMIN_TOKEN missing or shorter than 24 characters'));
else warn('Approval login', 'PRED_ADMIN_TOKEN not set — nobody can approve orders');

let dryPlan = null;
const memDb = openDb(':memory:');
const tstore = createTradeStore(memDb.sqlite);
await step('Trade plan', async () => {
  if (!sample) throw new Error('no instrument to plan against');
  const [inst] = (await client.instruments(sample.category, sample.symbol)).filter((i) => i.symbol === sample.symbol);
  const [tk] = await client.tickers(sample.category, sample.symbol);
  const retPct = results.detector?.retPct ?? 1;
  const event = { id: 'live-0', code: 'CHECK (dry run)', ticker: sample.key, asset: { company: sample.company }, anomaly: { measurements: { retPct: Math.abs(retPct) || 1 } }, revisions: [], predictions: [], resolution: null, outcome: null };
  const r = buildPlan({ event, asset: sample, instrument: inst, ticker: tk, tradingConfig: tcfg, source: 'HUMAN_REQUEST' });
  if (!r.ok) throw new Error(r.reason);
  dryPlan = tstore.insert(r.plan);
  return `dry-run from live ${sample.symbol} metadata: "${dryPlan.confirmationPhrase}" ≈${dryPlan.notional} USDT, stop ${dryPlan.stopLoss}, target ${dryPlan.takeProfit} (in-memory, not persisted, not submitted)`;
});

await step('Approval gate', async () => {
  if (!dryPlan) throw new Error('no dry-run plan to test the gate with');
  const svc = createTradingService({ tradingConfig: tcfg, store: tstore, publicClient: client, privateClient: guarded, authConfigured: () => auth, events: () => null, assets: () => sample });
  for (const forged of [undefined, {}, { actor: 'human', sessionId: 'forged' }]) {
    const r = await svc.approveAndExecute(dryPlan.id, forged, { confirmation: dryPlan.confirmationPhrase });
    if (r.ok || r.code !== 403) throw new Error('an execution without human approval was not refused');
  }
  if (placeAttempted) throw new Error('an order submission was attempted');
  if (tstore.get(dryPlan.id).status !== 'AWAITING_APPROVAL') throw new Error('plan state changed without approval');
  const st = svc.status();
  return `executions without an authenticated human approval are refused · no order sent · live execution ${st.executionEnabled ? 'ARMED' : `disabled (${st.blockers.length} blocker${st.blockers.length === 1 ? '' : 's'}: ${st.blockers[0]})`}`;
});
memDb.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? `${failed.length} check(s) failed: ${failed.map((f) => f.name).join(', ')}` : 'All checks passed — PRED can run LIVE here.'}`);
// Set the exit code and let the event loop drain; calling process.exit()
// while fetch sockets are closing aborts Node on Windows (libuv assertion).
process.exitCode = failed.length ? 1 : 0;
setTimeout(() => process.exit(), 3000).unref();
