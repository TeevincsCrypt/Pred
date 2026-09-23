// Live runtime: wires the real Bitget market engine, real evidence sources,
// SQLite persistence, live PRED Memory and connection health. Nothing in
// here imports or touches demo/simulated code.

import { createEngine } from '../core/engine.js';
import { createMemory } from '../agents/memory.js';
import { createAnalyst } from '../agents/analyst.js';
import { createBitgetClient } from '../market/bitget.js';
import { createMarketEngine, CRYPTO_REFS } from '../market/market-engine.js';
import { loadRelationships } from '../market/relationships.js';
import { createSecSource } from '../sources/sec.js';
import { createNewsSource } from '../sources/news.js';
import { createCalendarSource } from '../sources/calendar.js';
import { createUnavailableSource } from '../sources/unavailable.js';
import { openDb } from '../store/db.js';
import { logOp } from '../util/log.js';

const label = (s) => ({ connected: 'CONNECTED', ok: 'CONNECTED', disconnected: 'DISCONNECTED', not_configured: 'NOT CONFIGURED', unknown: 'CHECKING' })[s] || String(s || 'UNKNOWN').toUpperCase();

export function createLiveRuntime({ config, fetchImpl = fetch, db = null, analyst = null } = {}) {
  const store = db || openDb(config.dbPath);
  const records = store.loadMemory('live');
  const memory = createMemory({ records, onUpsert: (r) => store.saveMemory(r) });
  const client = createBitgetClient({ fetchImpl, baseUrl: config.bitgetBaseUrl });
  const sec = createSecSource({ fetchImpl });
  const news = createNewsSource({ fetchImpl });
  const calendar = createCalendarSource({ file: config.calendarFile });
  const social = createUnavailableSource('social', 'Social / web signals', 'social', 'No social data connector configured');
  const claude = analyst || createAnalyst();
  const sources = [news, sec, social, calendar];
  const startedAt = Date.now();
  const probes = { sec: null, gdelt: null };

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
    tradability: (key) => market.tokenizedStatus(key),
    persist: { saveEvent: (e) => store.saveEvent(e), appendLog: (id, kind, entry) => store.appendLog(id, kind, entry) },
  });
  market = createMarketEngine({ client, engine, relationships: loadRelationships(), secDirectory: () => sec.loadDirectory(), db: store, config });

  // Restore persisted events so open investigations resume after a restart.
  const restored = store.loadEvents('live');
  engine.restore(restored);

  async function probeSources() {
    for (const [k, src] of [['sec', sec], ['gdelt', news]]) {
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

  function connections() {
    const h = (x) => ({ lastOkAt: x.lastOkAt, lastErrorAt: x.lastErrorAt, lastError: x.lastError, latencyMs: x.lastLatencyMs, requests: x.requests, rateLimited: x.rateLimited });
    let dbh;
    try {
      dbh = store.health();
    } catch (err) {
      dbh = { status: 'disconnected', error: err.message };
    }
    const secStatus = !sec.configured ? 'not_configured' : sec.health.status !== 'unknown' ? sec.health.status : probes.sec?.status === 'ok' ? 'connected' : probes.sec?.status || 'unknown';
    const gdeltStatus = news.health.status !== 'unknown' ? news.health.status : probes.gdelt?.status === 'ok' ? 'connected' : probes.gdelt?.status || 'unknown';
    return {
      bitget: { name: 'Bitget', status: label(client.health.status), detail: client.health.lastError || `${market.assets.length} RWA instruments · ${client.baseUrl}`, ...h(client.health) },
      sec: { name: 'SEC EDGAR', status: label(secStatus), detail: !sec.configured ? 'Set SEC_USER_AGENT (name + email)' : sec.health.lastError || (secStatus === 'connected' ? okNote(sec.health, probes.sec) : probes.sec?.note) || null, ...h(sec.health) },
      gdelt: { name: 'GDELT', status: label(gdeltStatus), detail: news.health.lastError || (gdeltStatus === 'connected' ? okNote(news.health, probes.gdelt) : probes.gdelt?.note) || null, ...h(news.health) },
      claude: { name: 'Claude', status: claude.enabled ? label(claude.status.status) : 'OPTIONAL', detail: claude.status.note, model: claude.model || null },
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
      tradingEnabled: false,
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
      await market.start();
    },
    stop() {
      clearInterval(probeTimer);
      clearInterval(pruneTimer);
      market.stop();
    },
  };
}
