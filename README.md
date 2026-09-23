# PRED — Predictive Reaction Event Detector

**Find what the market knows before the news says it.**

> Traditional markets close. Information doesn't. PRED watches the gap.

PRED provides 24/7 market event intelligence for tokenized U.S. equities. It is **not** a stock predictor and **not** a trading bot.

Tokenized equities on Bitget trade around the clock, while the underlying U.S. market is open for only 6.5 hours a day. Outside those hours, price and volume can react before Wall Street opens and before any news explains the move. PRED watches Bitget's real market data continuously. When a tokenized equity moves abnormally while the U.S. market is closed, PRED opens a **Ghost Event**. It then investigates with real evidence (SEC EDGAR, GDELT news), forms competing catalyst hypotheses, tracks them until they are confirmed, invalidated or left unresolved, estimates the reaction, and learns from the outcome.

```
DETECT → INVESTIGATE → HYPOTHESIZE → VERIFY → PREDICT → LEARN
```

Built for the **Bitget AI Genesis Season 2** hackathon.

---

## Quick start

```bash
node --version            # >= 22.5 (uses the built-in node:sqlite)
npm start                 # PRED LIVE on http://localhost:8787
npm run check:live        # production health check against the real endpoints
npm test                  # 32 tests
```

`/` opens straight into **PRED LIVE**. `/about` is the product page. The simulated demo lives only at `/demo` and is **off** unless you set `PRED_DEMO_ENABLED=true` or run `npm run start:demo`.

PRED has no runtime dependencies. `@anthropic-ai/sdk` is optional and is used only when `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` are set.

---

## Live mode (default)

### 1. Bitget integration: Unified API v3, public, no key

| Purpose | Endpoint |
|---|---|
| Server time / connectivity | `GET /api/v3/public/time` |
| Instrument discovery + metadata + trading status | `GET /api/v3/market/instruments?category=SPOT` and `?category=USDT-FUTURES` |
| Ticker: last price, 24h change, 24h volume & turnover, best bid/ask (spread) | `GET /api/v3/market/tickers?category=SPOT` (every spot ticker in one call) |
| 1-minute candles (K-lines) | `GET /api/v3/market/candles?category=&symbol=&interval=1m&limit=` |
| Order book (on request) | `GET /api/v3/market/orderbook?category=&symbol=&limit=` |

**Tokenized equities are discovered, never assumed.** Bitget flags them in the instrument response:
- **Spot tokenized stocks**: `isRwa: "YES"`. These are xStocks (`NVDAXUSDT`, `TSLAXUSDT`, …) and Ondo tokens (`NVDAONUSDT`, `SPYONUSDT`, …).
- **Stock perpetuals**: `USDT-FUTURES` instruments with `symbolType: "stock"`. They are listed in `/api/assets` and monitored only when `PRED_MONITOR_CATEGORIES` includes `USDT-FUTURES`.

Only listed instruments appear in the UI and in `/api/assets`. `PRED_ASSETS=NVDA,TSLA,AAPL,AMZN` can narrow the list. It matches by underlying ticker, base coin or symbol, and any requested ticker that Bitget does not list is reported as unmatched instead of being faked. Default response shapes follow the official typings (`bitget-api` SDK v3 types: `InstrumentV3`, `TickerV3`, `CandlestickV3`).

### 2. Market engine: Bitget → client → normalizer → rolling market state → Detector

`src/market/market-engine.js` runs three independent loops. A failure in one never stops the others, and a failed request never crashes the server.

| Loop | Default | Env |
|---|---|---|
| Market poll: all spot tickers (1 request) + due 1m candles | 15 s | `PRED_POLL_INTERVAL_MS` |
| Detector: evaluates every monitored asset | 30 s | `PRED_DETECTOR_INTERVAL_MS` |
| Asset refresh: instrument discovery | 15 min | `PRED_ASSET_REFRESH_MS` |

Requests are spaced to roughly 8 per second, well under Bitget's public limits. They retry with exponential backoff and jitter on network errors, 429 and 5xx, and honour `Retry-After`. Only **closed** 1-minute candles are stored.

For each asset, PRED keeps: latest price, previous price, percentage change, 24h volume and turnover, rolling volume baseline (2-hour median), volume anomaly ratio, 1-minute volatility, spread, tokenized-market status, real timestamps and candle history. **Any field Bitget does not provide is `null` and shown as n/a.** Nothing is estimated or filled in.

### 3. When a Ghost Event is opened

The Detector compares the last 5 one-minute bars against a 120-bar baseline. It looks at the price z-score, the volume ratio, intrabar volatility, the spread change, the residual move not explained by peers, market-wide breadth, and the move of the same stock on a different token issuer. A Ghost Event opens **only** when all three of these hold:

1. **Abnormal activity**: |z| ≥ 3.5 with volume ≥ 2.5× baseline, or a composite score ≥ 6, together with a move of at least 0.6%.
2. **Traditional market closed**: according to the NYSE calendar in `src/market/hours.js`, which includes weekends, 2025–2027 holidays and 13:00 early closes.
3. **Tokenized market LIVE**: the Bitget instrument is `online`, the last candle is fresh and there were trades in the last 15 minutes. It also must not be a thin market (`PRED_MIN_TURNOVER_USD`).

An abnormal move that fails condition 2 or 3 is logged as "not a Ghost Event" with the reason, and no event is opened. A data gap, for example after a restart or a trading halt, is never read as a price move. Qualifying events get **ELEVATED** priority.

If nothing is abnormal, the dashboard says **"No active Ghost Events detected."** That is a normal, valid state.

### 4. Real evidence

| Source | What PRED stores | Hardening |
|---|---|---|
| **Bitget** | price, volume, volatility and spread anomalies; related-asset, market-wide and BTC/ETH moves | as above |
| **SEC EDGAR** (`www.sec.gov/files/company_tickers.json`, `data.sec.gov/submissions/CIK##########.json`) | accession number, form, company, filing date, acceptance time, items, URL | required `SEC_USER_AGENT` (without it the source reports **NOT CONFIGURED**), ≤ 6 req/s, timeouts, retries, shape validation, de-duplication by accession |
| **GDELT DOC 2.0** | title, source domain, publication time, URL, matched entities, relevance | 1 request per 5.5 s (GDELT's limit), plain-text rate-limit replies detected, 4-minute cache, de-duplication by URL and title |
| **Calendar** (`data/calendar.json`, maintained by you) | scheduled events | labeled **SCHEDULED**. It is never treated as an observed catalyst |
| Social / web | — | shown as **not connected**; there is no connector |

Every evidence item carries a class (**OBSERVED**, **SCHEDULED** or **HISTORICAL**) and a provenance tag. URLs are validated as `http(s)` before they reach the browser.

Correlated assets come from a configurable relationship map (`src/market/relationships.js`, override with `PRED_RELATIONSHIPS_FILE`). The map is applied only to instruments Bitget actually lists. Companies not in the map still get their name and CIK from SEC's official directory, and they are compared against the market-wide move of all live tokenized equities.

### 5. Hypotheses, verification, lifecycle

The hypothesis model is still the transparent, deterministic evidence-weighted model (`MODEL_VERSION = pred-hyp-1.1.0`). Each hypothesis shows:
- the evidence for and against it, with log-odds weights and sources
- the source count
- confidence and its change since the previous revision
- a timestamp and the model version
- a "why N%" breakdown: prior + weights → score → softmax (T = 1.5), capped short of certainty

Evidence of one kind has diminishing returns, so 30 headlines about a mega-cap cannot add up to certainty. Headlines published before the move count only as background.

The **Verifier** re-checks open events every 5 minutes. It re-runs SEC and GDELT and checks whether the price held or reverted at +60 and +180 minutes.
- An official company release or an 8-K/6-K → **CONFIRMED**, or **INVALIDATED** if a different catalyst had been leading.
- A full reversal that turns the model toward a liquidity explanation → **INVALIDATED**.
- No authoritative evidence by the first regular-session close (or `PRED_VERIFY_TIMEOUT_MS`) → **UNRESOLVED**.

PRED never forces a confirmation.

Lifecycle: `DETECTED → INVESTIGATING → HYPOTHESIS_CREATED → AWAITING_CONFIRMATION → CONFIRMED | INVALIDATED | UNRESOLVED`. Every transition, evidence item, hypothesis revision, prediction, resolution, outcome and evaluation is appended to an audit log. Nothing is ever overwritten.

### 6. Persistence

PRED uses SQLite through Node's built-in `node:sqlite`, so there is no dependency. The database is at `PRED_DB_PATH` (default `data/pred.sqlite`) and holds these tables:
- `events`: the latest snapshot of each event
- `event_log`: the append-only audit trail
- `memory`: outcomes and evaluations
- `candles`: 3 days of 1-minute observations, used to resume detection after a restart

Open events are restored on startup and verification continues. This suits a **single-instance** deployment with a **persistent disk**. On Railway, attach a volume (see below). The status panel warns when no volume is attached.

### 7. LIVE MEMORY and the reaction model

LIVE MEMORY starts at **0 verified events**. Accuracy metrics (direction, catalyst, reaction range, Brier score, false-positive rate) appear only once enough real events have resolved; until then the UI says *Insufficient live history*. The Reaction Agent publishes no range without comparable real history and shows **LOW CONFIDENCE** instead. Synthetic data exists only in the separate demo and never mixes with live data.

### 8. Claude analyst (optional)

Set `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL`, for example `claude-opus-5`. The model is validated against the Models API at startup and its real status appears in the Connections panel. Claude writes explanations only, citing evidence IDs. It never sets prices, confidence numbers, confirmations or trade decisions. Without it, PRED works fully on deterministic logic.

### 9. No autonomous trading

PRED recommends one of **MONITOR / WAIT / RESEARCH / CONSIDER TRADE**. It never places orders, and the server has no order-placement code. No private API keys are required or used. `GET /api/signals` publishes confirmed signals with a risk policy for a *separate* execution agent; `examples/execution-agent.mjs` is a dry-run consumer.

---

## API

| Method | Path | |
|---|---|---|
| GET | `/api/health` | liveness, database, Bitget state |
| GET | `/api/status` | traditional market OPEN/CLOSED, Bitget tokenized market LIVE/CLOSED/UNKNOWN, Ghost-window flag, connections (Bitget, SEC, GDELT, Claude, Database), counts, last market update |
| GET | `/api/assets` | discovered Bitget universe: symbol, base/quote, status, category, monitored, last price, 24h volume/turnover, available market data |
| GET | `/api/market/:symbolOrKey` | rolling market state and last 240 candles; add `?depth=1` for the order book |
| GET | `/api/events` (`?active=1`) | Ghost Events |
| GET | `/api/events/:id` | full event |
| GET | `/api/events/:id/timeline` | timeline and persisted audit log |
| GET | `/api/events/:id/hypotheses` | every revision |
| GET | `/api/events/:id/evidence` | evidence and source checks |
| GET | `/api/memory` | LIVE MEMORY statistics |
| GET | `/api/signals` | verified signals and risk policy (`tradingEnabled: false`) |
| GET | `/api/stream` | Server-Sent Events: a snapshot on every engine change and every poll |

The demo, when enabled, is namespaced under `/api/demo/*` with per-browser sessions.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `PRED_MODE` | `live` | `demo` runs only the simulated demo |
| `PRED_DEMO_ENABLED` | `false` | also expose the simulated demo at `/demo` |
| `BITGET_BASE_URL` | `https://api.bitget.com` | |
| `PRED_ASSETS` | all discovered | e.g. `NVDA,TSLA,AAPL,AMZN` (underlying, base coin or symbol) |
| `PRED_MAX_ASSETS` | 30 | cap when `PRED_ASSETS` is unset (ranked by 24h turnover) |
| `PRED_MONITOR_CATEGORIES` | `SPOT` | add `USDT-FUTURES` to monitor stock perps |
| `PRED_POLL_INTERVAL_MS` | 15000 | tickers + candle refresh cadence |
| `PRED_DETECTOR_INTERVAL_MS` | 30000 | detector cadence |
| `PRED_ASSET_REFRESH_MS` | 900000 | instrument discovery cadence |
| `PRED_MIN_TURNOVER_USD` | 5000 | below this 24h turnover a market is "thin" and anomalies are not Ghost Events |
| `PRED_VERIFY_TIMEOUT_MS` | – | optional earlier UNRESOLVED timeout |
| `SEC_USER_AGENT` | – | **required for SEC**: `"Your Name you@example.com"` |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | – | optional analyst |
| `PRED_DB_PATH` | `data/pred.sqlite` | put it on a persistent volume |
| `PRED_CALENDAR` | `data/calendar.json` | scheduled events you maintain |
| `PRED_RELATIONSHIPS_FILE` | – | extend or override the peer map |
| `PRED_LOG_FORMAT` | text | `json` for JSON-lines logs |

Logs are structured, one line per operation: `[ts] [COMPONENT] [event] OP STATUS duration fields`. Secrets and request headers are never logged. No secret ever reaches the browser, and the Content-Security-Policy restricts the page to its own origin.

## Deploy on Railway

1. **New Project → Deploy from GitHub repo**, branch `main`. `railway.json` builds the `Dockerfile` and health-checks `/api/health`.
2. **Variables**: `SEC_USER_AGENT="Your Name you@example.com"`, `PRED_DB_PATH=/app/data/pred.sqlite`. Optionally set `PRED_ASSETS`, `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL`.
3. **Volume**: attach one mounted at `/app/data`, otherwise events are lost on every redeploy.
4. **Networking → Generate Domain.**
5. Verify from inside the running service: `railway ssh`, then `npm run check:live`. Running it on your own machine also works as a connectivity test. It prints ✓ or the exact failure for Bitget, Instruments, Market Data, SEC, GDELT, Database, SSE and Detector. Then open `/api/status` and `/api/assets`.

If Bitget ever answers 403 from a hosting region, the check shows it. Point `BITGET_BASE_URL` at an allowed endpoint or proxy, or deploy the service in a region Bitget serves. PRED never falls back to simulated data.

## Demo (simulated, separate)

`npm run start:demo` or `PRED_DEMO_ENABLED=true` runs a deterministic 15-step NVDAx scenario at `/demo`. It is labeled SIMULATED everywhere and has its own simulated memory: 183 synthetic backtest events run through the real models. It never shares an engine, memory or database with LIVE.

## Repository layout

```
src/
  agents/      detector · investigator · hypothesis · verifier · reaction · memory · analyst
  core/        engine (lifecycle, audit) · graph · action · signals
  market/      bitget (v3 client + normalizer) · live-universe · market-engine · hours · relationships · series
  sources/     sec · news (GDELT) · calendar · unavailable · scripted (demo only)
  live/        runtime (wires the live system; imports no demo code)
  store/       db (node:sqlite)
  demo/        simulated scenario, runner, sessions, seed
  server.js    HTTP + SSE
scripts/       check-live.mjs
web/           dashboard (app.html) · about page (index.html)
test/          node:test suites (a mocked Bitget is used only in tests)
```

## Honest limitations

- The evidence weights are hand-set; live calibration is there to show where they are wrong.
- Headline sentiment is not inferred. A confirmed live catalyst says *that* something happened, not which direction it points.
- Only one instance should write to the SQLite file. Horizontal scaling would need PostgreSQL, which is not included.
- The development sandbox used to build PRED could not reach Bitget, SEC or GDELT (HTTP 403 from its egress proxy). The live integration follows Bitget's documented v3 contract and is exercised end to end against a contract-shaped mock in the tests. `npm run check:live` in the deployed environment is the source of truth.

*Not financial advice.*
