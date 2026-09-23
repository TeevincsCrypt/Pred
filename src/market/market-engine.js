// Live market-data engine:  Bitget → client → normalizer → rolling market state → Detector.
//
// Three independent loops, each isolated so one failure never stops the others:
//   • asset refresh    (PRED_ASSET_REFRESH_MS)   instruments → live universe
//   • market poll      (PRED_POLL_INTERVAL_MS)   all SPOT tickers in one call + due 1m candles
//   • detector         (PRED_DETECTOR_INTERVAL_MS) engine.afterBatch() on the latest state
// Nothing is synthesized. A value Bitget does not provide is null.

import { buildUniverse } from './live-universe.js';
import { marketStatus } from './hours.js';
import { logOp } from '../util/log.js';
import { median, mean, std, logReturns, round } from '../util/stats.js';

const MIN = 60_000;
// 60 candle requests per 15s poll at 120ms spacing ≈ 4 req/s on average.
const MAX_CANDLE_BATCH = 60;

export const CRYPTO_REFS = { BTC: 'BTCUSDT', ETH: 'ETHUSDT' };

export function createMarketEngine({ client, engine, relationships, secDirectory = async () => null, db = null, config }) {
  const universe = engine.universe; // shared, mutated in place
  const monitored = engine.monitored; // shared, mutated in place
  let assets = []; // every discovered tokenized-equity instrument
  let unmatched = [];
  let eligibleCount = 0;
  const tickers = new Map(); // symbol → normalized ticker
  const state = new Map(); // key → market state
  const candleMeta = new Map(); // key → { lastFetch, backfilled }
  const status = { discoveredAt: null, lastTickerAt: null, lastCandleAt: null, lastDetectorRunAt: null, lastError: null, running: false };
  const timers = [];

  const keyToSymbol = () => {
    const m = new Map(assets.map((a) => [a.key, a]));
    for (const [k, sym] of Object.entries(CRYPTO_REFS)) m.set(k, { key: k, symbol: sym, category: 'SPOT', assetClass: 'crypto' });
    return m;
  };

  async function refreshAssets() {
    const t0 = Date.now();
    try {
      const [spot, futures, spotTickers] = await Promise.all([
        client.instruments('SPOT'),
        client.instruments('USDT-FUTURES').catch((err) => {
          logOp({ component: 'market', op: 'FUTURES_INSTRUMENTS', status: 'FAILURE', error: err });
          return [];
        }),
        client.tickers('SPOT').catch(() => []),
      ]);
      for (const t of spotTickers) tickers.set(t.symbol, t);
      if (futures.length) for (const t of await client.tickers('USDT-FUTURES').catch(() => [])) tickers.set(`${t.symbol}:PERP`, t);
      const dir = await secDirectory().catch(() => null);
      const built = buildUniverse({ spot, futures, tickers, relationships, secDirectory: dir, opts: { assetsFilter: config.assets, maxAssets: config.maxAssets, categories: config.categories } });
      assets = built.assets;
      unmatched = built.unmatched;
      eligibleCount = built.eligible;
      for (const k of Object.keys(universe)) delete universe[k];
      for (const a of assets) universe[a.key] = a;
      monitored.splice(0, monitored.length, ...built.monitored);
      status.discoveredAt = Date.now();
      engine.setFeedStatus({ status: 'connected', symbols: Object.fromEntries(assets.map((a) => [a.key, a.symbol])), note: `${assets.length} tokenized-equity instruments discovered · ${monitored.length} monitored`, unmatched });
      logOp({ component: 'market', op: 'ASSET_DISCOVERY', durationMs: Date.now() - t0, spotInstruments: spot.length, rwa: assets.length, monitored: monitored.length, unmatched: unmatched.join(',') || null });
      if (!assets.length) engine.log('Bitget returned no tokenized-equity (RWA) instruments. Nothing to monitor yet.', 'error');
      else engine.log(`Bitget: ${assets.length} tokenized-equity instruments discovered, ${monitored.length} monitored`, 'info');
      if (unmatched.length) engine.log(`PRED_ASSETS not listed on Bitget: ${unmatched.join(', ')}`, 'error');
    } catch (err) {
      status.lastError = err.message;
      engine.setFeedStatus({ status: 'error', error: err.message });
      logOp({ component: 'market', op: 'ASSET_DISCOVERY', status: 'FAILURE', durationMs: Date.now() - t0, error: err });
    }
  }

  // Keys whose candles we need: monitored assets, their peers, crypto references.
  function trackedKeys() {
    const set = new Set(monitored);
    for (const k of monitored) for (const p of universe[k]?.peers || []) set.add(p);
    for (const k of Object.keys(CRYPTO_REFS)) set.add(k);
    return [...set];
  }

  async function pollTickers() {
    const t0 = Date.now();
    try {
      const list = await client.tickers('SPOT');
      const at = Date.now();
      for (const t of list) tickers.set(t.symbol, { ...t, receivedAt: at });
      // Futures tickers are always polled (one request) so every discovered
      // stock perpetual shows a real price in /api/assets.
      if (assets.some((x) => x.category === 'USDT-FUTURES')) {
        for (const t of await client.tickers('USDT-FUTURES').catch(() => [])) tickers.set(`${t.symbol}:PERP`, { ...t, receivedAt: at });
      }
      const map = keyToSymbol();
      for (const key of trackedKeys()) {
        const a = map.get(key);
        if (!a) continue;
        const t = tickers.get(a.category === 'USDT-FUTURES' ? `${a.symbol}:PERP` : a.symbol);
        if (t?.bid && t?.ask) engine.ingestQuote(key, { ts: at, bid: t.bid, ask: t.ask });
      }
      status.lastTickerAt = at;
      logOp({ component: 'market', op: 'TICKERS', durationMs: at - t0, count: list.length });
    } catch (err) {
      status.lastError = err.message;
      logOp({ component: 'market', op: 'TICKERS', status: 'FAILURE', durationMs: Date.now() - t0, error: err });
    }
  }

  async function pollCandles() {
    const map = keyToSymbol();
    const now = Date.now();
    const due = trackedKeys().filter((k) => map.get(k) && now - (candleMeta.get(k)?.lastFetch ?? 0) >= config.candleRefreshMs);
    // Size each batch so every tracked asset refreshes about once per
    // candleRefreshMs, capped to stay far below Bitget's public rate limits.
    const perPoll = Math.ceil((trackedKeys().length * config.pollIntervalMs) / config.candleRefreshMs) + 2;
    const batch = due.slice(0, Math.min(MAX_CANDLE_BATCH, Math.max(config.candleBatch, perPoll)));
    await Promise.all(
      batch.map(async (key) => {
        const a = map.get(key);
        const meta = candleMeta.get(key) || { lastFetch: 0, backfilled: false };
        meta.lastFetch = Date.now();
        candleMeta.set(key, meta);
        const t0 = Date.now();
        try {
          const bars = await client.candles(a.category, a.symbol, { interval: '1m', limit: meta.backfilled ? 5 : 200 });
          const closedBefore = Math.floor(Date.now() / MIN) * MIN;
          const closed = bars.filter((b) => b.ts < closedBefore);
          for (const b of closed) engine.ingestCandle(key, b);
          if (db && closed.length) db.saveCandles(key, closed);
          meta.backfilled = true;
          if (closed.length) status.lastCandleAt = Math.max(status.lastCandleAt ?? 0, closed.at(-1).ts);
          if (!meta.logged || !meta.backfilled) logOp({ component: 'market', op: 'CANDLES', durationMs: Date.now() - t0, asset: key, bars: closed.length });
          meta.logged = true;
          meta.error = null;
        } catch (err) {
          meta.error = err.message;
          logOp({ component: 'market', op: 'CANDLES', status: 'FAILURE', durationMs: Date.now() - t0, asset: key, error: err });
        }
      }),
    );
  }

  // Tokenized-market status for one asset: LIVE / CLOSED / UNKNOWN.
  function tokenizedStatus(key) {
    const a = universe[key];
    if (!a) return { status: 'UNKNOWN', reason: 'not in discovered universe' };
    if (['offline', 'limit_close', 'restrictedAPI'].includes(a.status)) return { status: 'CLOSED', reason: `Bitget instrument status: ${a.status}` };
    const bars = engine.store.candles(key);
    if (!bars.length) return { status: 'UNKNOWN', reason: 'no candle data yet' };
    const age = Date.now() - bars.at(-1).ts;
    if (age > config.staleAfterMs) return { status: 'UNKNOWN', reason: `last closed candle ${Math.round(age / MIN)}m old` };
    const recent = bars.slice(-15);
    if (!recent.some((b) => b.volume > 0)) return { status: 'CLOSED', reason: 'no trades in the last 15 minutes' };
    const t = tickers.get(a.category === 'USDT-FUTURES' ? `${a.symbol}:PERP` : a.symbol);
    if (config.minTurnoverUsd > 0 && t?.turnover24h != null && t.turnover24h < config.minTurnoverUsd) return { status: 'LIVE', thin: true, reason: `24h turnover ${Math.round(t.turnover24h)} < ${config.minTurnoverUsd}` };
    return { status: 'LIVE', reason: 'trading, fresh candles' };
  }

  function marketState(key) {
    const a = universe[key] || keyToSymbol().get(key);
    if (!a) return null;
    const t = tickers.get(a.category === 'USDT-FUTURES' ? `${a.symbol}:PERP` : a.symbol) || null;
    const bars = engine.store.candles(key);
    const last = bars.at(-1) || null;
    const prev = bars.at(-2) || null;
    const base = bars.slice(-125, -5);
    const baseVol = base.length >= 30 ? median(base.map((b) => b.volume)) : null;
    const recentVol = bars.length >= 5 ? mean(bars.slice(-5).map((b) => b.volume)) : null;
    const rets = logReturns(bars.slice(-61).map((b) => b.close));
    const spreadBps = t?.bid && t?.ask ? ((t.ask - t.bid) / ((t.ask + t.bid) / 2)) * 1e4 : null;
    const ts = tokenizedStatus(key);
    return {
      key,
      symbol: a.symbol,
      category: a.category,
      baseAsset: a.baseCoin ?? null,
      quoteAsset: a.quoteCoin ?? null,
      company: a.company ?? null,
      instrumentStatus: a.status ?? null,
      monitored: monitored.includes(key),
      lastPrice: t?.last ?? last?.close ?? null,
      previousPrice: prev?.close ?? null,
      changePct: last && prev ? round((last.close / prev.close - 1) * 100, 4) : null,
      change24hPct: t?.change24hPct == null ? null : round(t.change24hPct, 3),
      volume24h: t?.volume24h ?? null,
      turnover24h: t?.turnover24h ?? null,
      lastBarVolume: last?.volume ?? null,
      rollingVolumeBaseline: baseVol,
      volumeAnomalyRatio: baseVol && recentVol != null && baseVol > 0 ? round(recentVol / baseVol, 2) : null,
      volatility1mPct: rets.length >= 20 ? round(std(rets) * 100, 4) : null,
      bid: t?.bid ?? null,
      ask: t?.ask ?? null,
      spreadBps: spreadBps == null ? null : round(spreadBps, 2),
      tokenizedMarket: ts.status,
      tokenizedReason: ts.reason,
      lastCandleAt: last?.ts ?? null,
      tickerReceivedAt: t?.receivedAt ?? null,
      candleCount: bars.length,
      spark: bars.slice(-90).map((b) => b.close),
      available: { ticker: !!t, candles: bars.length > 0, spread: spreadBps != null, orderbook: 'on request (/api/market/:symbol?depth=1)' },
    };
  }

  function aggregateTokenizedStatus() {
    const s = monitored.map((k) => tokenizedStatus(k).status);
    if (!s.length) return 'UNKNOWN';
    if (s.includes('LIVE')) return 'LIVE';
    if (s.every((x) => x === 'CLOSED')) return 'CLOSED';
    return 'UNKNOWN';
  }

  function every(ms, name, fn) {
    let busy = false;
    const run = async () => {
      if (busy) return;
      busy = true;
      try {
        await fn();
      } catch (err) {
        logOp({ component: 'market', op: name, status: 'FAILURE', error: err });
      } finally {
        busy = false;
      }
    };
    timers.push(setInterval(run, ms));
    return run;
  }

  return {
    status,
    get assets() {
      return assets;
    },
    get unmatched() {
      return unmatched;
    },
    get eligibleCount() {
      return eligibleCount;
    },
    tickers,
    marketState,
    tokenizedStatus,
    aggregateTokenizedStatus,
    trackedKeys,
    refreshAssets,
    pollTickers,
    pollCandles,

    // Restore recent candles from the database so detection resumes after a restart.
    warmStart() {
      if (!db) return 0;
      let n = 0;
      for (const key of trackedKeys()) {
        const bars = db.loadCandles(key, Date.now() - 6 * 3600_000);
        for (const b of bars) engine.ingestCandle(key, b);
        n += bars.length;
      }
      return n;
    },

    async start() {
      status.running = true;
      engine.setFeedStatus({ status: 'discovering' });
      await refreshAssets();
      const warmed = this.warmStart();
      if (warmed) logOp({ component: 'market', op: 'WARM_START', bars: warmed });
      await pollTickers();
      // Backfill everything once, respecting the request spacing.
      for (let i = 0; i < 20 && trackedKeys().some((k) => !candleMeta.get(k)?.backfilled); i++) await pollCandles();
      every(config.assetRefreshMs, 'ASSET_REFRESH', refreshAssets);
      every(config.pollIntervalMs, 'MARKET_POLL', async () => {
        await pollTickers();
        await pollCandles();
      });
      every(config.detectorIntervalMs, 'DETECTOR', async () => {
        status.lastDetectorRunAt = Date.now();
        engine.afterBatch();
      })();
    },

    stop() {
      status.running = false;
      for (const t of timers) clearInterval(t);
      timers.length = 0;
    },

    marketStatusNow() {
      const trad = marketStatus(Date.now());
      return { traditional: trad, tokenized: aggregateTokenizedStatus() };
    },
  };
}
