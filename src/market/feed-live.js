// Live Bitget feed: discovers tokenized-equity symbols, backfills 1-minute
// candles, then polls candles + tickers and hands *closed* bars to the
// engine. Nothing here is synthesized: if Bitget is unreachable the feed
// reports the error and PRED detects nothing.

import { createBitgetClient, resolveSymbols, parseSymbolMap } from './bitget.js';

const MIN = 60_000;

export function createLiveFeed({ engine, universe, monitored, cryptoRefs, pollMs = 20_000, client = createBitgetClient() }) {
  let timer = null;
  let symbols = {};
  const lastTs = new Map();

  async function discover() {
    const overrides = parseSymbolMap(process.env.PRED_SYMBOL_MAP);
    const listed = await client.symbols();
    const wanted = Object.fromEntries(monitored.flatMap((t) => [t, ...universe[t].peers]).map((t) => [t, universe[t]]));
    symbols = resolveSymbols(listed, wanted, { overrides });
    for (const [k, sym] of Object.entries(cryptoRefs)) symbols[k] = sym;
    const missing = Object.keys(wanted).filter((t) => !symbols[t]);
    engine.setFeedStatus({ status: 'connected', symbols, missing, note: missing.length ? `Not listed on Bitget spot: ${missing.join(', ')}` : 'All monitored assets listed' });
    engine.log(`Bitget: resolved ${Object.keys(symbols).length - Object.keys(cryptoRefs).length} tokenized equities${missing.length ? ` (not listed: ${missing.join(', ')})` : ''}`, 'info');
  }

  async function pull(ticker, symbol, limit) {
    const bars = await client.candles(symbol, { limit });
    const closedBefore = Math.floor(Date.now() / MIN) * MIN; // drop the still-forming bar
    let n = 0;
    for (const b of bars) {
      if (b.ts >= closedBefore || b.ts <= (lastTs.get(ticker) ?? 0)) continue;
      engine.ingestCandle(ticker, b);
      lastTs.set(ticker, b.ts);
      n++;
    }
    return n;
  }

  async function poll(initial = false) {
    const entries = Object.entries(symbols);
    const results = await Promise.allSettled(
      entries.map(async ([ticker, symbol]) => {
        await pull(ticker, symbol, initial ? 200 : 5);
        if (!initial) {
          const t = await client.ticker(symbol);
          if (t.bid > 0 && t.ask > 0) engine.ingestQuote(ticker, { ts: t.ts, bid: t.bid, ask: t.ask });
        }
      }),
    );
    const failed = results.filter((r) => r.status === 'rejected');
    engine.setFeedStatus({ lastPollAt: Date.now(), status: failed.length === entries.length && entries.length ? 'error' : 'connected', error: failed[0]?.reason?.message || null });
    engine.afterBatch();
  }

  return {
    async start() {
      engine.setFeedStatus({ status: 'discovering' });
      try {
        await discover();
        await poll(true);
      } catch (err) {
        engine.setFeedStatus({ status: 'error', error: err.message });
        engine.log(`Bitget feed unavailable: ${err.message}. Retrying — no data will be simulated in LIVE mode.`, 'error');
      }
      timer = setInterval(async () => {
        try {
          if (!Object.keys(symbols).length) await discover();
          await poll(false);
        } catch (err) {
          engine.setFeedStatus({ status: 'error', error: err.message });
        }
      }, pollMs);
    },
    stop() {
      clearInterval(timer);
    },
  };
}
