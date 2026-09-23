// Live runtime: wires the real Bitget market engine, real evidence sources,
// SQLite persistence, live PRED Memory and connection health. Nothing in
// here imports or touches demo/simulated code.

import { createEngine } from '../core/engine.js';
import { createMemory } from '../agents/memory.js';
import { selectAnalyst } from '../agents/analyst-select.js';
import { createBitgetClient } from '../market/bitget.js';
import { createMarketEngine, CRYPTO_REFS } from '../market/market-engine.js';
import { loadRelationships } from '../market/relationships.js';
import { createSecSource } from '../sources/sec.js';
import { createNewsSource } from '../sources/news.js';
import { createGoogleNewsSource } from '../sources/google-news.js';
import { createCalendarSource } from '../sources/calendar.js';
import { createUnavailableSource } from '../sources/unavailable.js';
import { openDb } from '../store/db.js';
import { logOp } from '../util/log.js';
import { createTradeStore } from '../trading/store.js';
import { createBitgetPrivateClient } from '../trading/bitget-private.js';
import { createTradingService } from '../trading/execution.js';
import { createOperatorAuth } from '../trading/auth.js';

const label = (s) => ({ connected: 'CONNECTED', ok: 'CONNECTED', degraded: 'DEGRADED', disconnected: 'DISCONNECTED', not_configured: 'NOT CONFIGURED', unknown: 'CHECKING' })[s] || String(s || 'UNKNOWN').toUpperCase();

export function createLiveRuntime({ config, fetchImpl = fetch, db = null, analyst = null, privateClient = null, auth = null } = {}) {
  const store = db || openDb(config.dbPath);
  const records = store.loadMemory('live');
  const memory = createMemory({ records, onUpsert: (r) => store.saveMemory(r) });
  const client = createBitgetClient({ fetchImpl, baseUrl: config.bitgetBaseUrl });
  const sec = createSecSource({ fetchImpl });
  // GDELT first; Google News RSS takes over when GDELT is paused or blocked.
  const googleNews = createGoogleNewsSource({ fetchImpl });
  const news = createNewsSource({ fetchImpl, fallback: googleNews });
  const calendar = createCalendarSource({ file: config.calendarFile });
  const social = createUnavailableSource('social', 'Social / web signals', 'social', 'No social data connector configured');
  const claude = analyst || selectAnalyst();
  const sources = [news, sec, social, calendar];
  const startedAt = Date.now();
  const probes = { sec: null, gdelt: null, googlenews: null };

  const universe = {};
  const monitored = [];
  let market;
  const engine = createEngine({
    mode: 'live',
    universe,
    monitored,
    cryptoRefs: CRYPTO_REFS,
    sources,
    memory,
    analyst: claude,
    feedName: 'Bitget',
    feedProvenance: 'LIVE',
    rescanIntervalMs: config.rescanIntervalMs,
    resolutionTimeoutMs: config.resolutionTimeoutMs,
    openDeadlineMs: config.openDeadlineMs,
    tradability: (key) => market.tokenizedStatus(key),
    persist: { saveEvent: (e) => store.saveEvent(e), appendLog: (id, kind, entry) => store.appendLog(id, kind, entry) },
  });
  market = createMarketEngine({ client, engine, relationships: loadRelationships(), secDirectory: () => sec.loadDirectory(), db: store, config });

  // ---------- human-approved execution (separate from every agent) ----------
  // The engine and agents never receive `trading`; the runtime only lets it
  // draft plans from engine updates. Orders need the approval route.
  const operatorAuth = auth || createOperatorAuth();
  const tradeStore = createTradeStore(store.sqlite);
  const bitgetPrivate = privateClient || createBitgetPrivateClient({ fetchImpl, baseUrl: config.bitgetBaseUrl });
  const trading = createTradingService({
    tradingConfig: config.trading || { enabled: false, planNotional: 25, planTtlMs: 300_000, maxDriftBps: 50, slippageBps: 10, quoteMaxAgeMs: 15_000, autoPlanMinConfidence: 60, marginMode: 'isolated', statusPollMs: 10_000, maxOrderNotional: null, maxPositionNotional: null, maxDailyNotional: null },
    mode: 'live',
    store: tradeStore,
    publicClient: client,
    privateClient: bitgetPrivate,
    authConfigured: () => operatorAuth.configured,
    events: (id) => engine.eventDetail(id),
    assets: (ticker) => market.assets.find((a) => a.key === ticker) || null,
  });
  let autoPlanBusy = false;
  engine.onChange(() => {
    if (autoPlanBusy) return;
    autoPlanBusy = true;
    Promise.all([...engine.events.values()].map((e) => trading.maybeAutoPlan(e)))
      .catch(() => {})
      .finally(() => {
        autoPlanBusy = false;
      });
  });

  // Restore persisted events so open investigations resume after a restart.
  const restored = store.loadEvents('live');
  engine.restore(restored);

  async function probeSources() {
    for (const [k, src] of [['sec', sec], ['gdelt', news], ['googlenews', googleNews]]) {
      const t0 = Date.now();
      try {
        probes[k] = { ...(await src.probe()), at: Date.now() };
        logOp({ component: k, op: 'PROBE', durationMs: Date.now() - t0, status: probes[k].status === 'ok' ? 'SUCCESS' : 'SKIPPED', note: probes[k].note });
      } catch (err) {
        probes[k] = { status: 'disconnected', note: err.message, at: Date.now() };
        logOp({ component: k, op: 'PROBE', status: 'FAILURE', durationMs: Date.now() - t0, error: err });
      }
    }
    await claude.probe?.();
  }

  // Once a source is answering again, show its current state rather than a
  // stale error left over from an earlier failed probe.
  const okNote = (h, probe) =>
    [probe?.status === 'ok' ? probe.note : null, h.lastOkAt ? `last OK ${new Date(h.lastOkAt).toISOString().slice(11, 19)} UTC` : null, h.rateLimited ? `${h.rateLimited} rate-limited replies (backing off)` : null].filter(Boolean).join(' · ') || null;

  // A free source that fails one request but answered recently is DEGRADED
  // (intermittent), not DISCONNECTED; DISCONNECTED means no answer for 30 min.
  const DEGRADED_WINDOW_MS = 30 * 60_000;
  const intermittent = (st, h) => (st === 'disconnected' && h.lastOkAt && Date.now() - h.lastOkAt < DEGRADED_WINDOW_MS ? 'degraded' : st);

  const hhmm = (t) => new Date(t).toISOString().slice(11, 16);
  const degradedNote = (h) => `intermittent — last OK ${hhmm(h.lastOkAt)} UTC; last error ${hhmm(h.lastErrorAt)} UTC: ${h.lastError}`;

  function connections() {
    const h = (x) => ({ lastOkAt: x.lastOkAt, lastErrorAt: x.lastErrorAt, lastError: x.lastError, latencyMs: x.lastLatencyMs, requests: x.requests, rateLimited: x.rateLimited });
    let dbh;
    try {
      dbh = store.health();
    } catch (err) {
      dbh = { status: 'disconnected', error: err.message };
    }
    const secStatus0 = !sec.configured ? 'not_configured' : sec.health.status !== 'unknown' ? sec.health.status : probes.sec?.status === 'ok' ? 'connected' : probes.sec?.status || 'unknown';
    const gdeltStatus0 = news.health.status !== 'unknown' ? news.health.status : probes.gdelt?.status === 'ok' ? 'connected' : probes.gdelt?.status || 'unknown';
    const secStatus = intermittent(secStatus0, sec.health);
    const bo = news.backoff?.() || {};
    // Early backoff pauses are deliberate (DEGRADED); repeated refusals mean a real block.
    const gdeltStatus = bo.paused && bo.strikes <= 4 ? 'degraded' : intermittent(gdeltStatus0, news.health);
    return {
      bitget: { name: 'Bitget', status: label(client.health.status), detail: client.health.lastError || `${market.assets.length} RWA instruments · ${client.baseUrl}`, ...h(client.health) },
      sec: { name: 'SEC EDGAR', status: label(secStatus), detail: !sec.configured ? 'Set SEC_USER_AGENT (name + email)' : secStatus === 'degraded' ? degradedNote(sec.health) : sec.health.lastError || (secStatus === 'connected' ? okNote(sec.health, probes.sec) : probes.sec?.note) || null, ...h(sec.health) },
      gdelt: { name: 'GDELT', status: label(gdeltStatus), detail: bo.paused ? news.health.lastError : gdeltStatus === 'degraded' ? degradedNote(news.health) : news.health.lastError || (gdeltStatus === 'connected' ? okNote(news.health, probes.gdelt) : probes.gdelt?.note) || null, ...h(news.health) },
      googlenews: (() => {
        const st0 = googleNews.health.status !== 'unknown' ? googleNews.health.status : probes.googlenews?.status === 'ok' ? 'connected' : probes.googlenews?.status || 'unknown';
        const st = intermittent(st0, googleNews.health);
        return { name: 'Google News (backup)', status: label(st), detail: googleNews.health.lastError || (st === 'connected' ? okNote(googleNews.health, probes.googlenews) : probes.googlenews?.note) || 'used when GDELT is unavailable', ...h(googleNews.health) };
      })(),
      claude: { name: claude.enabled ? `AI analyst · ${claude.providerName || 'Claude'}` : 'AI analyst', status: claude.enabled ? label(claude.status.status) : 'OPTIONAL', detail: claude.status.note, model: claude.model || null, provider: claude.provider || null },
      execution: (() => {
        const t = trading.status();
        return { name: 'Execution', status: t.executionEnabled ? 'ARMED' : 'DISABLED', detail: t.executionEnabled ? 'Live orders possible — each one needs human approval' : t.blockers[0] };
      })(),
      database: { name: 'Database', status: label(dbh.status), detail: dbh.error || `SQLite ${dbh.file}`, counts: dbh.counts, persistentDisk: process.env.RAILWAY_VOLUME_MOUNT_PATH ? `volume at ${process.env.RAILWAY_VOLUME_MOUNT_PATH}` : process.env.RAILWAY_ENVIRONMENT ? 'WARNING: no Railway volume — data is lost on redeploy' : 'local disk' },
    };
  }

  function status() {
    const ms = market.marketStatusNow();
    const events = [...engine.events.values()];
    return {
      mode: 'live',
      memoryLabel: 'LIVE MEMORY',
      startedAt,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      traditionalMarket: { status: ms.traditional.usMarketOpen ? 'OPEN' : 'CLOSED', session: ms.traditional.session, nyTime: ms.traditional.nyTime, nextOpen: ms.traditional.nextOpen, nextClose: ms.traditional.nextClose },
      tokenizedMarket: { status: ms.tokenized, venue: 'Bitget' },
      ghostCondition: ms.tokenized === 'LIVE' && !ms.traditional.usMarketOpen,
      assetsDiscovered: market.assets.length,
      assetsMonitored: monitored.length,
      assetsEligible: market.eligibleCount,
      maxAssets: Number.isFinite(config.maxAssets) ? config.maxAssets : 'all',
      unmatchedAssets: market.unmatched,
      activeGhostEvents: events.filter((e) => !e.outcome && ['DETECTED', 'INVESTIGATING', 'HYPOTHESIS_CREATED', 'AWAITING_CONFIRMATION'].includes(e.state)).length,
      totalEvents: events.length,
      lastMarketUpdate: Math.max(market.status.lastTickerAt ?? 0, market.status.lastCandleAt ?? 0) || null,
      lastTickerAt: market.status.lastTickerAt,
      lastCandleAt: market.status.lastCandleAt,
      lastDetectorRunAt: market.status.lastDetectorRunAt,
      intervals: { pollMs: config.pollIntervalMs, detectorMs: config.detectorIntervalMs, assetRefreshMs: config.assetRefreshMs },
      connections: connections(),
      demoEnabled: config.demoEnabled,
      tradingEnabled: trading.status().executionEnabled,
      trading: trading.status(),
    };
  }

  function assetsView() {
    return market.assets.map((a) => {
      const s = market.marketState(a.key);
      return {
        key: a.key,
        symbol: a.symbol,
        category: a.category,
        baseAsset: a.baseCoin,
        quoteAsset: a.quoteCoin,
        status: a.status,
        issuer: a.issuer,
        underlying: a.underlying,
        company: a.company,
        assetClass: a.assetClass,
        symbolType: a.symbolType,
        usListed: a.usListed,
        monitored: a.monitored,
        lastPrice: s?.lastPrice ?? null,
        change24hPct: s?.change24hPct ?? null,
        volume24h: s?.volume24h ?? null,
        turnover24h: s?.turnover24h ?? null,
        tokenizedMarket: s?.tokenizedMarket ?? 'UNKNOWN',
        lastCandleAt: s?.lastCandleAt ?? null,
        availableMarketData: s?.available ?? { ticker: false, candles: false, spread: false },
      };
    });
  }

  let probeTimer = null;
  let pruneTimer = null;
  return {
    config,
    engine,
    market,
    memory,
    db: store,
    client,
    sources: { sec, news, calendar, social },
    analyst: claude,
    trading,
    auth: operatorAuth,
    restoredEvents: restored.length,
    status,
    connections,
    assetsView,
    marketsView: () => monitored.map((k) => market.marketState(k)).filter(Boolean),
    async start() {
      logOp({ component: 'server', op: 'LIVE_START', restoredEvents: restored.length, memoryRecords: records.length });
      probeSources();
      probeTimer = setInterval(probeSources, config.sourceProbeMs);
      pruneTimer = setInterval(() => store.prune(), 3600_000);
      trading.startTracking();
      await market.start();
    },
    stop() {
      clearInterval(probeTimer);
      clearInterval(pruneTimer);
      trading.stopTracking();
      market.stop();
    },
  };
}
