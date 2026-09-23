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
npm test                  # node:test suites
```

`/` is the landing page and `/app` opens **PRED LIVE**, the live dashboard. The simulated demo lives only at `/demo` and is **off** unless you set `PRED_DEMO_ENABLED=true` or run `npm run start:demo`.

PRED has no runtime dependencies. The AI analyst is optional: `@anthropic-ai/sdk` is used only when `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` are set; the free Groq alternative uses plain HTTPS (`GROQ_API_KEY` + `GROQ_MODEL`).

---

## Live mode (default)

### 1. Bitget integration: Unified API v3, public, no key

| Purpose | Endpoint |
|---|---|
| Server time / connectivity | `GET /api/v2/public/time` (v3 `/public/time` returns 40404 on the live API) |
| Instrument discovery + metadata + trading status | `GET /api/v3/market/instruments?category=SPOT` and `?category=USDT-FUTURES` |
| Ticker: last price, 24h change, 24h volume & turnover, best bid/ask (spread) | `GET /api/v3/market/tickers?category=SPOT` / `?category=USDT-FUTURES` (every ticker in one call) |
| 1-minute candles (K-lines) | `GET /api/v3/market/candles?category=&symbol=&interval=1m&limit=` |
| Order book (on request) | `GET /api/v3/market/orderbook?category=&symbol=&limit=` |

**Tokenized equities are discovered, never assumed.** Bitget flags them in the instrument response:
- **Spot tokenized stocks**: `isRwa: "YES"`. These are xStocks (`NVDAXUSDT`, `TSLAXUSDT`, …) and Ondo tokens (`NVDAONUSDT`, `SPYONUSDT`, …).
- **Stock perpetuals**: `USDT-FUTURES` instruments with `symbolType: "stock"`. At the time of writing this is how Bitget exposes most tokenized US equities (e.g. `NFLXUSDT`, `RTXSTOCKUSDT`), so they are monitored by default. Perp base coins are parsed as plain tickers (a `STOCK` suffix is stripped; `…HKD` names are marked Hong Kong and not monitored as US equities).

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
| **Google News RSS** (backup, keyless) | headline, publisher domain, publication time, link | used automatically whenever GDELT is paused, rate-limited or blocking the server's IP; same 15-min cache and backoff; evidence records `via Google News` |
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
- No authoritative evidence by 30 minutes after the next U.S. open (`PRED_OPEN_GRACE_MS`):
  - if the move **faded** before the open (≤ 20% of it left), it was liquidity, not information. The event is **INVALIDATED**, or **CONFIRMED** as liquidity if PRED already led with that. This is the same price-behaviour rule the Verifier applies overnight.
  - otherwise it is **UNRESOLVED**, marked *held* or *partly faded*. A move that held with no official explanation is exactly what PRED exists to surface. The price reaction is still measured at the U.S. close and scored in PRED Memory.

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

Two interchangeable providers:
- **Claude**: set `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL`, for example `claude-opus-5`.
- **Groq (free tier)**: set `GROQ_API_KEY` and `GROQ_MODEL`, for example `openai/gpt-oss-120b`. PRED spaces requests (`PRED_GROQ_MIN_INTERVAL_MS`, default 4 s), caps them per day (`PRED_GROQ_DAILY_CAP`, default 800) and honours Groq's 429 `Retry-After`. While Groq is rate-limited it shows **DEGRADED** and events use the template narrative.

Claude is used if both are configured; `PRED_ANALYST=groq` forces Groq. Models are never hard-coded: the configured model is checked against the provider's model list at startup, and its real status appears in the Connections panel as "AI analyst". Claude writes explanations only, citing evidence IDs. It never sets prices, confidence numbers, confirmations or trade decisions. Without it, PRED works fully on deterministic logic.

### 9. No autonomous trading

PRED recommends one of **MONITOR / WAIT / RESEARCH / CONSIDER TRADE**. Its agents never place orders. `GET /api/signals` publishes confirmed signals. Acting on them is a separate, human-approved step — see **Human-approved execution** below.


### 10. Human-approved execution

PRED can submit **real** Bitget orders, but **only after a human approves a specific trade plan**. No agent, background loop, SSE stream or webhook can place an order. Live execution is **off by default** (`PRED_TRADING_ENABLED=false`).

```
LIVE MARKET DATA → GHOST EVENT → INVESTIGATION → HYPOTHESIS → VERIFICATION → REACTION PREDICTION
→ TRADE PLAN → HUMAN REVIEW → EXPLICIT APPROVAL → REVALIDATION → REAL ORDER → ORDER STATUS → AUDIT TRAIL
```

**Where it lives.** Everything is in `src/trading/`, separate from the agents. A test fails the build if any agent, engine, demo or market module imports it, or if `placeOrder(` is called anywhere except the single call site in `execution.js`.

| File | Role |
|---|---|
| `bitget-private.js` | Signed Bitget **Unified Trading API v3** client. Secrets stay in a closure. POSTs are never retried. |
| `rules.js` | Pure logic: instrument precision, plan construction, order construction, risk checks, status mapping |
| `store.js` | `trade_plans` + append-only `trade_audit` tables; atomic status transitions |
| `execution.js` | The trading service. `approveAndExecute` is the only path to `placeOrder` |
| `auth.js` | Operator login (`PRED_ADMIN_TOKEN`), session cookie, CSRF |

**Bitget endpoints** (verified against the official `bitget-api` SDK v3 typings). The signature is `base64(HMAC-SHA256(secret, timestamp + METHOD + path + query|body))`, sent with the `ACCESS-KEY / ACCESS-SIGN / ACCESS-TIMESTAMP / ACCESS-PASSPHRASE` headers.
- `POST /api/v3/trade/place-order`: `category, symbol, qty, price, side, orderType=limit, timeInForce=gtc, clientOid=<executionId>`. Futures orders also send `marginMode`, `posSide` (hedge mode only), `takeProfit` and `stopLoss`.
- `GET /api/v3/trade/order-info`: order status by `orderId`, or by `clientOid` to reconcile after a timeout.
- `POST /api/v3/trade/cancel-order`: human-initiated cancel.
- `GET /api/v3/account/settings`, `GET /api/v3/account/assets`, `GET /api/v3/position/current-position`: used for revalidation.
- `GET /api/v3/market/instruments?symbol=`: `status`, `minOrderQty`, `maxOrderQty`, `quantityMultiplier/Precision`, `priceMultiplier/Precision`, `minOrderAmount`.

The Bitget account must be a **Unified Trading Account**. `check:live` reports the account mode.

**Trade plans.** Plans are created in two ways:
- *automatically*, when a reaction prediction is OK, directional and ≥ `PRED_TRADE_MIN_CONFIDENCE`;
- *on request*, from a logged-in human ("Generate trade plan"). While live memory has no history, these plans are labelled **LOW CONFIDENCE** and follow the detected move's direction.

Each plan is sized to about `PRED_TRADE_NOTIONAL` USDT (never above `PRED_MAX_ORDER_NOTIONAL`). Quantity and price are rounded to Bitget's live precision. Stop and target come from the reaction range. A plan expires after `PRED_TRADE_PLAN_TTL_MS`. Spot tokens are long-only. **Confidence never authorises an order.**

Statuses: `AWAITING_APPROVAL → APPROVED → SUBMITTING → SUBMITTED → PARTIALLY_FILLED → FILLED`, or `CANCELLED / REJECTED / EXPIRED / FAILED`. *Submitted* means Bitget accepted the order. *Filled* is set only from Bitget's order status.

**Approval.** The dashboard's **Trade** panel keeps *Prediction* (intelligence) and *Execution* (red, "LIVE ORDER") visibly separate. After **Review trade** it shows:
- asset, direction, order type, quantity, estimated price and notional;
- stop and target, and PRED's confidence;
- the reasoning and the evidence behind it, and the current bid/ask;
- how many seconds ago the market data was refreshed, and when the plan expires.

**Approve & execute** sends `POST /api/trade/plans/:id/execute` with the plan's exact confirmation phrase (e.g. `BUY 0.12 NVDAUSDT`). That route requires:
- the operator session cookie (HttpOnly, SameSite=Strict);
- the session's CSRF token in `X-PRED-CSRF`;
- a same-origin `Origin` header.

GET requests never execute. The browser sends a plan id only; symbol, side, quantity and price are rebuilt server-side, and any other fields in the request are ignored.

**Before any order is sent**, the server:
1. reloads the plan from the database;
2. claims it atomically (`UPDATE … WHERE status='AWAITING_APPROVAL' AND execution_id IS NULL`), so only one request can win;
3. checks the plan hasn't expired;
4. fetches fresh instrument metadata and a fresh ticker, and rejects if the price moved more than `PRED_TRADE_MAX_DRIFT_BPS`;
5. re-checks precision, minimum and maximum quantity, and minimum order value;
6. reads the account mode, the available USDT (the full order value plus fees must be available, i.e. 1× margin), and the current position;
7. applies the order, position and daily limits;
8. confirms trading is still enabled.

If anything changed, the plan is marked `EXPIRED` or `REJECTED` and you are asked to review a fresh one.

A double-click or a concurrent request gets the existing execution back and never creates a second order. If Bitget doesn't answer an order request, PRED **reconciles by `clientOid`** instead of resending. A read-only tracker then polls the order status every `PRED_TRADE_STATUS_POLL_MS`.

**Audit.** Every step is written to `trade_audit` with timestamp, event id, plan id, execution id, symbol, actor (`human` / `system`) and result. The step kinds are:
- plan: `TRADE_PLAN_CREATED`, `TRADE_PLAN_REVIEWED`, `TRADE_PLAN_EXPIRED`;
- approval: `TRADE_APPROVAL_REQUESTED`, `TRADE_APPROVED`, `TRADE_REJECTED`;
- order: `ORDER_SUBMISSION_STARTED`, `ORDER_SUBMITTED`, `ORDER_PARTIALLY_FILLED`, `ORDER_FILLED`, `ORDER_CANCELLED`, `ORDER_REJECTED`, `ORDER_FAILED`.

`GET /api/trade/plans/:id` answers "why was this trade submitted?". Secrets are never stored, logged or returned.

**Turning it on (deliberately).** Execution stays disabled until **all** of these are true: `PRED_TRADING_ENABLED=true`, the Bitget API key/secret/passphrase are set, `PRED_ADMIN_TOKEN` is at least 24 characters, and all three safety limits are set. `/api/status` → `trading.blockers` lists whatever is still missing.

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
| GET | `/api/signals` | verified signals (signals never trade) |
| GET | `/api/stream` | Server-Sent Events: a snapshot on every engine change and every poll |

| GET | `/api/auth/session` | `{ authenticated, csrfToken? }` |
| POST | `/api/auth/login` `{token}` | operator login → session cookie |
| POST | `/api/auth/logout` | |
| GET | `/api/trade/status` | execution readiness, blockers, limits (no secrets) |
| GET | `/api/trade/plans` (`?event=id`) | trade plans |
| GET | `/api/trade/plans/:id` | plan + audit trail |
| POST | `/api/trade/events/:id/plan` | human: draft a fresh plan |
| POST | `/api/trade/plans/:id/review` | human: fresh quote for the confirmation panel |
| POST | `/api/trade/plans/:id/reject` | human: discard the plan |
| POST | `/api/trade/plans/:id/execute` `{confirmation}` | human: **approve & execute** |
| POST | `/api/trade/plans/:id/cancel-order` | human: cancel the open Bitget order |

Every trade POST needs the session cookie, `X-PRED-CSRF` and a same-origin `Origin`. The demo, when enabled, is namespaced under `/api/demo/*` with per-browser sessions and has no trade routes.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `PRED_MODE` | `live` | `demo` runs only the simulated demo |
| `PRED_DEMO_ENABLED` | `false` | also expose the simulated demo at `/demo` |
| `BITGET_BASE_URL` | `https://api.bitget.com` | |
| `BITGET_TIMEOUT_MS` | `8000` | per-request timeout; raise on slow networks |
| `PRED_ASSETS` | all discovered | e.g. `NVDA,TSLA,AAPL,AMZN` (underlying, base coin or symbol) |
| `PRED_MAX_ASSETS` | 30 | how many eligible U.S.-listed instruments to watch, ranked by 24h turnover; `all` watches every eligible one (candle polling scales automatically, up to ~240 at 1-minute freshness) |
| `PRED_MONITOR_CATEGORIES` | `SPOT,USDT-FUTURES` | restrict to `SPOT` to ignore stock perps |
| `PRED_POLL_INTERVAL_MS` | 15000 | tickers + candle refresh cadence |
| `PRED_DETECTOR_INTERVAL_MS` | 30000 | detector cadence |
| `PRED_ASSET_REFRESH_MS` | 900000 | instrument discovery cadence |
| `PRED_MIN_TURNOVER_USD` | 5000 | below this 24h turnover a market is "thin" and anomalies are not Ghost Events |
| `PRED_VERIFY_TIMEOUT_MS` | – | optional earlier UNRESOLVED timeout |
| `PRED_OPEN_GRACE_MS` | `1800000` | verification closes this long after the next U.S. open; `off` waits for the close |
| `SEC_USER_AGENT` | – | **required for SEC**: `"Your Name you@example.com"` |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | – | optional analyst (Claude) |
| `GROQ_API_KEY`, `GROQ_MODEL` | – | optional analyst (Groq, free tier), e.g. `GROQ_MODEL=openai/gpt-oss-120b` |
| `PRED_ANALYST` | auto | `claude` or `groq` to force a provider |
| `PRED_GROQ_MIN_INTERVAL_MS`, `PRED_GROQ_DAILY_CAP` | `4000`, `800` | Groq free-tier budget |
| `PRED_DB_PATH` | `data/pred.sqlite` | put it on a persistent volume |
| `PRED_CALENDAR` | `data/calendar.json` | scheduled events you maintain |
| `PRED_RELATIONSHIPS_FILE` | – | extend or override the peer map |
| `PRED_LOG_FORMAT` | text | `json` for JSON-lines logs |
| **Execution** | | *(all off by default)* |
| `PRED_TRADING_ENABLED` | `false` | must be exactly `true` to allow live orders |
| `BITGET_API_KEY`, `BITGET_API_SECRET`, `BITGET_API_PASSPHRASE` | – | Bitget API key with **trade** permission (Unified Trading Account); never logged or returned |
| `PRED_ADMIN_TOKEN` | – | operator secret (24+ chars) for the approval login |
| `PRED_MAX_ORDER_NOTIONAL` | – (execution disabled) | max USDT per order, e.g. `25` |
| `PRED_MAX_POSITION_NOTIONAL` | – (execution disabled) | max USDT position per symbol incl. this order, e.g. `50` |
| `PRED_MAX_DAILY_TRADING_NOTIONAL` | – (execution disabled) | max USDT submitted per UTC day, e.g. `100` |
| `PRED_TRADE_NOTIONAL` | `25` | target plan size (capped by the order limit) |
| `PRED_TRADE_PLAN_TTL_MS` | `300000` | plan expiry |
| `PRED_TRADE_MAX_DRIFT_BPS` | `50` | max price move between plan and execution |
| `PRED_TRADE_SLIPPAGE_BPS` | `10` | limit price this far through the touch |
| `PRED_TRADE_QUOTE_MAX_AGE_MS` | `15000` | freshest-quote requirement at execution |
| `PRED_TRADE_MIN_CONFIDENCE` | `60` | reaction confidence needed for an automatic plan |
| `PRED_TRADE_MARGIN_MODE` | `isolated` | futures margin mode (`isolated`/`crossed`) |
| `PRED_TRADE_STATUS_POLL_MS` | `10000` | order-status polling |

Logs are structured, one line per operation: `[ts] [COMPONENT] [event] OP STATUS duration fields`. Secrets and request headers are never logged. No secret ever reaches the browser, and the Content-Security-Policy restricts the page to its own origin.

## Deploy on Railway

1. **New Project → Deploy from GitHub repo**, branch `main`. `railway.json` builds the `Dockerfile` and health-checks `/api/health`.
2. **Variables**: `SEC_USER_AGENT="Your Name you@example.com"`, `PRED_DB_PATH=/app/data/pred.sqlite`. Optionally set `PRED_ASSETS`, `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL`.
3. **Volume**: attach one mounted at `/app/data`, otherwise events are lost on every redeploy.
4. **Networking → Generate Domain.**
5. Verify from inside the running service: `railway ssh`, then `npm run check:live`. Running it on your own machine also works as a connectivity test. It prints ✓ or the exact failure for Bitget, Instruments, Market Data, SEC, GDELT, Database, SSE and Detector, plus the execution checks (config, limits, credentials, account, a dry-run trade plan, the approval gate). **It never places an order.** Then open `/api/status` and `/api/assets`.
6. Execution stays off until you deliberately set `PRED_TRADING_ENABLED=true` together with the Bitget key/secret/passphrase, `PRED_ADMIN_TOKEN` and the three `PRED_MAX_*` limits.

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
  trading/     human-approved execution: bitget-private · rules · store · execution · auth
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
