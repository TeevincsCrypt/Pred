# PRED Live Validation Record

> PRED is a live production market-intelligence system validated against Bitget production infrastructure. This record distinguishes production-validated functionality from implemented-but-not-yet-exercised functionality. It is not marketing copy — every claim below is tied to a source: a reproducible test run, a `npm run check:live` output, or a specific file in this repository.

**Last updated against:** Railway validation run `2026-09-23T11:14:34.271Z` (see [Production Validation Summary](#3-production-validation-summary)).

**Legend**

| Status | Meaning |
|---|---|
| ✅ **PRODUCTION VALIDATED** | Observed working against real Bitget production infrastructure in the runs below |
| 🧩 **IMPLEMENTED** | Present in the codebase, exercised by unit/integration tests, but not yet observed against real production infrastructure (or not applicable to a `PRED_TRADING_ENABLED=false` run) |
| 🧪 **TESTED WITH MOCKS** | Covered by the automated test suite against fixture/mock data, not real Bitget |
| ⏳ **NOT YET VALIDATED** | No test, run, or log currently demonstrates this |
| 🚫 **NOT CURRENTLY AVAILABLE** | Explicitly disabled, unset, or blocked in the documented environment |

---

## 1. Validation Environment

| Item | Value |
|---|---|
| Deployment | Railway (production container) |
| Bitget endpoint | `https://api.bitget.com` (production API, not testnet) |
| Mode | `PRED_MODE=live` |
| Trading flag | `PRED_TRADING_ENABLED=false` for all three runs below |
| Validation tool | `npm run check:live` → `scripts/check-live.mjs` |
| Runs captured | 3 (two pre-migration, one post-migration to a Unified account) |

A separate **local** run of `check:live` was also attempted on the operator's own machine and failed to reach Bitget/GDELT (`UND_ERR_CONNECT_TIMEOUT` / DNS-level failure). That failure reflects the local network path (ISP/firewall/DNS), not the production deployment, and is **not** used as evidence anywhere in this document. Only the three Railway runs below are treated as production validation.

`scripts/check-live.mjs` is designed so it **cannot** place a real order even by accident: the private Bitget client it builds has `placeOrder` and `cancelOrder` replaced with functions that throw (`scripts/check-live.mjs:174-187`), and the "Approval gate" step asserts that no submission was attempted (`scripts/check-live.mjs:243`). Every run below is therefore a read-only production check plus an in-memory, never-submitted dry-run trade plan.

---

## 2. Executive Summary

| Capability | Status |
|---|---|
| Connects to real Bitget production API | ✅ PRODUCTION VALIDATED |
| Discovers the live tradable instrument universe | ✅ PRODUCTION VALIDATED |
| Pulls live market data (ticker, candles, order book) | ✅ PRODUCTION VALIDATED |
| Persists events/candles/audit log to SQLite in production | ✅ PRODUCTION VALIDATED |
| Ghost Event detector runs against live candles | ✅ PRODUCTION VALIDATED (ran; no anomaly present in monitored window) |
| SEC EDGAR evidence source | ✅ PRODUCTION VALIDATED |
| GDELT evidence source | ⚠️ PARTIAL — succeeded once, timed out in the latest run |
| Google News fallback source | 🧩 IMPLEMENTED (in code as of this commit; not yet in a captured `check:live` transcript) |
| SSE live dashboard stream | ✅ PRODUCTION VALIDATED |
| Bitget account authentication (Unified) | ✅ PRODUCTION VALIDATED (as of run #3) |
| Trade-plan construction from live market metadata | ✅ PRODUCTION VALIDATED (dry-run, never submitted) |
| Human-approval gate (reject unapproved execution) | ✅ PRODUCTION VALIDATED |
| Real order submission to Bitget | 🚫 **NOT PERFORMED** — trading was disabled throughout |
| Real order fill / trade outcome | 🚫 **NOT PERFORMED** — no order was ever sent |
| Profitability / win rate / trading accuracy | ⏳ **NOT YET VALIDATED** — no real trade exists to measure |

---

## 3. Production Validation Summary

Three `npm run check:live` runs were captured against the Railway deployment.

### Run #1 — `2026-09-23T10:54:45.336Z`
Pre-migration (Bitget account in Classic mode). 1 check failed: **Account**.

### Run #2 — `2026-09-23T11:09:35.917Z`
Pre-migration. 2 checks failed: **GDELT** (connect timeout), **Account** (still Classic mode).

### Run #3 — `2026-09-23T11:14:34.271Z` (current / final)
After migrating the Bitget account to a Unified Trading Account. 1 check failed: **GDELT** (connect timeout).

```text
✓ Bitget        server time 2026-09-23T11:14:34.271Z (clock skew 0s)
✓ Instruments   3172 spot instruments · 0 tokenized-equity spot (isRwa) · 336 stock perps · 306 would be monitored
✓ Market Data   TSLAUSDT last 379.74 · 24h vol 46334.95 · bid/ask 379.7/379.73 · 200 1m candles · book 379.7/379.74
✓ SEC           10455 tickers in SEC directory · TSLA: no new material filing in the last 72h
✗ GDELT         fetch failed (UND_ERR_CONNECT_TIMEOUT) — api.gdeltproject.org unreachable from this host at this time
✓ Database      data/pred.sqlite writable · 72 live events, 6207 audit entries, 76585 stored candles
✓ SSE           stream delivers live snapshots (3452 bytes first frame)
✓ Detector      started · TSLAUSDT now: -0.018% over 5m (-0.39σ), volume 0.36× baseline — normal
✓ Execution cfg PRED_TRADING_ENABLED=false (safe default — no live orders) · margin isolated · plan ≈25 USDT, TTL 300s, drift ≤50 bps
✓ Safety limits max_order_notional=25 · max_position_notional=50 · max_daily_trading_notional=100 (USDT)
✓ Credentials   BITGET_API_KEY / BITGET_API_SECRET / BITGET_API_PASSPHRASE configured (values not shown)
✓ Account       authenticated · account mode unified · hold mode hedge_mode · balances readable (no USDT balance) · amounts not shown
✓ Approval login PRED_ADMIN_TOKEN configured (value not shown)
✓ Trade plan    dry-run "BUY 0.06 TSLAUSDT" ≈22.78 USDT, stop 377.83, target 381.63 (in-memory, not persisted, not submitted)
✓ Approval gate executions without an authenticated human approval are refused · no order sent · live execution disabled (1 blocker: trading disabled)

1 check(s) failed: GDELT
```

**This is the current state: 12 of 13 checks pass. GDELT — one of two independent news sources — currently times out from the production host. This is explicitly not glossed over: no claim in this document says "every check passes."**

An earlier snapshot (Run #1, before the timeout appeared) shows GDELT succeeding:

```text
✓ GDELT  3 relevant article(s) naming Tesla in the headline, 36 other mention(s), last 24h
```

This is presented as a historical data point, not current state — the most recent run experienced a connect timeout to `api.gdeltproject.org`.

---

## 4. Bitget Connectivity — ✅ PRODUCTION VALIDATED

Real Bitget production server time was fetched with 0-second clock skew in all three runs (`src/market/bitget.js`, `client.serverTime()`). This confirms PRED's HTTP client, request signing/timing, and network path to `api.bitget.com` all work in the deployed environment — not a mock.

## 5. Instrument Discovery — ✅ PRODUCTION VALIDATED

`buildUniverse()` (`src/market/live-universe.js`) processed the real Bitget instrument catalog:

- 3,172 spot instruments returned by `/api/v3/market/instruments`
- 0 tokenized-equity spot instruments currently flagged `isRwa=YES`
- 336 USDT-margined stock perpetuals discovered
- 306 instruments matched PRED's monitoring filters (e.g. `TSLAUSDT`, `NVDAUSDT`, `AAPLUSDT`, `AMZNUSDT`, `GOOGLUSDT`, `CRCLUSDT`)

Note: PRED's universe currently monitors stock **perpetuals**, not spot `isRwa` tokens — Bitget presently lists 0 spot instruments flagged `isRwa=YES`. The pipeline supports both categories (`src/market/live-universe.js`), but live coverage today is via perpetuals.

## 6. Live Market Data — ✅ PRODUCTION VALIDATED

For the sampled instrument (`TSLAUSDT`), the following were fetched live and used successfully:
- Ticker: last price, 24h volume, bid/ask
- 200 one-minute candles, most recent timestamped to the second
- Level-2 order book (top of book)

Source: `src/market/bitget.js` (`tickers`, `candles`, `orderbook`), exercised directly by `scripts/check-live.mjs`.

## 7. Ghost Event Detection — ✅ PRODUCTION VALIDATED (ran; no anomaly present)

`measure()` from `src/agents/detector.js` ran against the live 200-candle window and returned a real statistical read (e.g. `-0.018% over 5m (-0.39σ), volume 0.36× baseline`). The detector's threshold logic (`|priceZ| ≥ 3.5` and `volumeRatio ≥ 2.5` ⇒ anomalous) was exercised with real inputs and correctly classified the sampled window as normal (not anomalous) — it did **not** happen to observe an actual Ghost Event trigger during these three runs.

What this validates: the detection math runs on live data end-to-end in production. What it does **not** validate: a live-fire detection of a real Ghost Event with downstream investigation/hypothesis/verification (see [§19](#19-what-has-not-been-validated)).

## 8. Production Persistence — ✅ PRODUCTION VALIDATED

`data/pred.sqlite` was confirmed writable in production across all three runs, with monotonically increasing counts:

| Run | Live events | Audit entries | Stored candles |
|---|---|---|---|
| #1 | 58 | 5,294 | 72,236 |
| #2 | 70 | 6,148 | 75,632 |
| #3 | 72 | 6,207 | 76,585 |

Growth between runs indicates the production process was actively collecting and persisting market data between checks, not just at check time. Schema/health reporting: `src/store/db.js` (`db.health()`).

## 9. SEC Validation — ✅ PRODUCTION VALIDATED

`src/sources/sec.js` connected to the real SEC EDGAR ticker directory (10,455 tickers loaded) and ran a live filing lookup for TSLA (no new material filing in the trailing 72h — a valid, checked result, not a stub).

## 10. GDELT Validation — ⚠️ PARTIAL

- Run #1: succeeded — 3 Tesla-headline articles + 36 other mentions in the last 24h (`src/sources/news.js`).
- Runs #2 and #3: failed with `UND_ERR_CONNECT_TIMEOUT` reaching `api.gdeltproject.org:443`.

PRED does not depend on GDELT alone: `src/sources/google-news.js` exists in the codebase as a fallback news source. It is present and used by `scripts/check-live.mjs` (`Google News` step), but no captured production transcript in this record includes its output — its production behavior is 🧩 **IMPLEMENTED**, not yet independently confirmed in a saved run.

## 11. SSE / Dashboard Validation — ✅ PRODUCTION VALIDATED

`scripts/check-live.mjs` opened a real HTTP connection to `/api/stream` on a live-mode server instance and confirmed the first frame is a valid `text/event-stream` snapshot containing `"mode":"live"` (3,452–3,520 bytes across runs). This is the same endpoint the production dashboard (`web/app.html`, `web/app.js`) consumes.

## 12. Agent / Intelligence Architecture — 🧩 IMPLEMENTED, 🧪 mostly TESTED WITH MOCKS

The production pipeline, by actual module:

```text
MARKET DATA         src/market/bitget.js, src/market/market-engine.js
   → DETECTION       src/agents/detector.js        (measure, anomalyScore, severity)
   → INVESTIGATION    src/agents/investigator.js     (marketEvidence, historicalEvidence, scanSources)
   → HYPOTHESIS       src/agents/hypothesis.js       (signalsFor, generateHypotheses)
   → VERIFICATION     src/agents/verifier.js         (toAuthoritative, priceCheck, resolve)
   → REACTION         src/agents/reaction.js         (predictReaction, comparables)
   → MEMORY           src/agents/memory.js           (createMemory, evaluateOutcome)
   → TRADE PLAN       src/trading/rules.js           (buildPlan, buildOrder, riskProblems)
   → HUMAN APPROVAL    src/trading/auth.js, src/trading/execution.js (requireHuman, approveAndExecute)
   → OPTIONAL EXECUTION src/trading/execution.js      (executeClaimed → privateClient.placeOrder)
```

Orchestration lives in `src/core/engine.js` and `src/live/runtime.js`, which wire real Bitget data, real evidence sources, SQLite persistence and PRED Memory together (`src/live/runtime.js:1-20` — explicitly documented as touching no demo/simulated code).

The evidence-gathering and detection stages (§7, §9, §10) were exercised against **real** production data in the runs above. The hypothesis-generation, verification, and reaction-prediction stages are covered by the automated test suite (`test/hypothesis.test.js`, `test/verifier-memory.test.js`) against constructed fixtures, not yet by a captured live end-to-end Ghost Event walkthrough — see §19.

An optional Claude-based analyst narrator exists (`src/agents/analyst.js`, `src/agents/analyst-groq.js`, `src/agents/analyst-select.js`) behind `ANTHROPIC_API_KEY` — not exercised in the `check:live` runs captured here.

## 13. PRED Memory — 🧪 TESTED WITH MOCKS

`src/agents/memory.js` (`createMemory`, `evaluateOutcome`) is covered by `test/verifier-memory.test.js`, including calibration/outcome-attribution logic. The 72 events persisted in production (§8) exist in the live database, but no resolved/scored outcome sample from production memory is included in this record — the memory statistics reported live are counts, not accuracy claims.

## 14. Trade Plan Validation — ✅ PRODUCTION VALIDATED (construction only, never submitted)

In run #3, `buildPlan()` (`src/trading/rules.js`) constructed a real trade plan from **live** Bitget instrument metadata and a **live** quote:

```text
"BUY 0.06 TSLAUSDT" ≈ 22.78 USDT
stop 377.83 · target 381.63
in-memory, not persisted to the production DB, not submitted to Bitget
```

This confirms the sizing, precision-rounding, stop/target, and confirmation-phrase logic run correctly against live market shape. It is explicitly a **dry run**: `scripts/check-live.mjs` stores it in an in-memory SQLite instance (`openDb(':memory:')`) separate from the production database, and the trading service it is tested against has `placeOrder` replaced with a function that throws.

## 15. Unified Account Validation — ✅ PRODUCTION VALIDATED (as of run #3)

- Run #1/#2: Bitget returned error `40084 — "You are in Classic Account mode, and the Unified Account API is not supported at this time"`. PRED correctly detected and reported this as a failed check rather than silently proceeding.
- Run #3, after the account was migrated to Unified: `authenticated · account mode unified · hold mode hedge_mode · balances readable (no USDT balance) · amounts not shown`.

`src/trading/execution.js:230` independently re-checks account mode on every execution attempt (`if (!['unified','hybrid'].includes(...)) return fail(...)`), so this is enforced at runtime, not just at check time.

**The latest account validation showed no USDT balance.** Any real order attempt would currently fail the balance check in `riskProblems()` (`src/trading/rules.js:184`) even if trading were enabled.

## 16. Safety Controls — 🧩 IMPLEMENTED, ✅ configuration PRODUCTION VALIDATED

Configured and confirmed present in the production environment:

| Control | Value | Source |
|---|---|---|
| Trading enabled | `false` (all 3 runs) | `PRED_TRADING_ENABLED` |
| Max order notional | 25 USDT | `PRED_MAX_ORDER_NOTIONAL` |
| Max position notional | 50 USDT | `PRED_MAX_POSITION_NOTIONAL` |
| Max daily trading notional | 100 USDT | `PRED_MAX_DAILY_TRADING_NOTIONAL` |
| Plan TTL | 300s | `PRED_TRADE_PLAN_TTL_MS` |
| Max price drift before re-quote required | 50 bps | `PRED_TRADE_MAX_DRIFT_BPS` |
| Margin mode | isolated | `PRED_TRADE_MARGIN_MODE` |

Enforcement logic that exists in code and is covered by `test/trading.test.js` (mocked Bitget) but **not yet exercised against a real submitted order**:
- Order/position/daily notional caps (`riskProblems()`, `src/trading/rules.js:177-186`)
- Stale-quote rejection (`quoteMaxAgeMs`, `src/trading/execution.js:231`)
- Price-drift rejection before submission (`maxDriftBps`, `src/trading/execution.js:233-234`)
- Available-balance check requiring full notional + 0.2% buffer (`src/trading/rules.js:184`)
- Atomic claim-before-execute + idempotent replay on double-submit (`store.claim`, `src/trading/execution.js:186-191`, `execution.js:176`)

## 17. Human Approval Gate — ✅ PRODUCTION VALIDATED

Run #3's "Approval gate" step sent three forged/unauthenticated approval attempts directly at `approveAndExecute()` against the live trading service instance and confirmed all three were refused with HTTP 403, that Bitget's `placeOrder` was never invoked, and that the plan's status remained `AWAITING_APPROVAL`. This is a production-configuration exercise of the actual approval-checking code path (`isHuman()` in `src/trading/execution.js:31`), not a mock of that logic.

Separately, at the HTTP layer, `src/trading/auth.js` implements and `test/trading.test.js` (test #59, #60) verifies:
- Constant-time token comparison for operator login (`crypto.timingSafeEqual`)
- Rate limiting (5 attempts / 15 min per IP, 50 global)
- `HttpOnly; SameSite=Strict` session cookie
- CSRF token required on every state-changing route (`X-PRED-CSRF` header, constant-time compare)
- Same-origin `Origin` header required (absent Origin = refused)

`PRED_ADMIN_TOKEN` was confirmed **configured** in production (run #2 and #3); its value was never displayed or logged.

## 18. Execution Layer — 🧩 IMPLEMENTED, NOT PRODUCTION EXERCISED

`src/trading/execution.js` implements the full order path: pre-submission revalidation against fresh Bitget data, order construction (`buildOrder()`), risk checks, atomic status transition to `SUBMITTING`, `placeOrder()` call, ambiguous-response reconciliation by `clientOid`, and post-submission status polling/cancellation.

**None of this has been exercised against the real Bitget order-placement endpoint.** `PRED_TRADING_ENABLED=false` throughout every documented run, and `scripts/check-live.mjs` structurally prevents `placeOrder`/`cancelOrder` from ever being called for real. This layer is implemented and unit-tested against mocks (`test/trading.test.js`); it is not production-validated.

## 19. What Has NOT Been Validated

- **No real-money order has ever been submitted to Bitget.**
- **No real-money fill has ever been observed.**
- No trading profitability, win rate, or trading accuracy exists to report — there is no real trade to measure.
- No end-to-end live Ghost Event has been captured in this record (detection → investigation → hypothesis → resolution) — only each stage's components individually, against live or fixture data as noted per section.
- Google News fallback source's production output has not been captured in a saved transcript.
- PRED Memory's calibration accuracy against real resolved events has not been reported here.
- The order-status polling/reconciliation path (`trackOne`, `src/trading/execution.js:303-333`) has not run against a real Bitget order lifecycle.
- The previously reported "54/54 tests passing" figure could not be found anywhere in this repository's history or documentation; it is not repeated here. The current test suite is **64/64 passing** (`npm test`, `node --test`, `node:test` runner), all of it against fixtures/mocks — see §20.

## 20. Test Suite (Repository Evidence)

```text
$ npm test
1..64
# tests 64
# pass 64
# fail 0
```

- 64 tests, 9 files under `test/`, using the built-in `node:test` runner.
- `test/bitget-live.test.js` and `test/trading.test.js` explicitly state and structurally enforce that **no test talks to the real Bitget API** — both use `test/fixtures/bitget-mock.js` or hand-built mock clients.
- `test/trading.test.js` covers: request signing correctness without secret leakage, module isolation (agents/engine/demo cannot reach execution), operator auth (constant-time, CSRF, same-origin), and the full HTTP flow proving an unauthenticated/CSRF-less/GET execution attempt is refused while the legitimate human flow submits exactly one order (against the mock).
- **64/64 tests passing is a statement about code correctness under test fixtures. It is not evidence of 64 real trades, and no test in this repository submits a real order.**

## 21. Known Limitations

- GDELT connectivity from the current production host is intermittently failing (timeout), reducing PRED to one confirmed live news source (SEC) plus an implemented-but-unconfirmed fallback (Google News) at the moment this record was written.
- Bitget currently lists 0 spot instruments flagged `isRwa=YES`; live monitoring today runs on stock perpetuals, not the originally described tokenized-equity spot universe.
- The Bitget account used for validation has no USDT balance, so even with trading enabled, an order would currently fail PRED's own balance check before reaching Bitget.
- No real order, fill, cancellation, or reconciliation has ever occurred; the entire execution layer's real-world behavior is inferred from code + mocked tests, not observed.

## 22. Reproducibility

Any judge or reviewer can reproduce §3–§18 directly:

```bash
# Local test suite (mocked, no network required)
npm test

# Production health check (requires a live deployment + Bitget credentials)
npm run check:live
```

`check:live` is read-only by construction (§1) and safe to re-run at any time; it will not place an order regardless of `PRED_TRADING_ENABLED`.

## 23. Final Status

PRED's live data pipeline — Bitget connectivity, instrument discovery, market data, detection, SEC evidence, persistence, and the SSE dashboard feed — is **production validated** against real Bitget infrastructure as of the run captured in §3. The Bitget account is Unified and authenticated. Human-approval authentication is configured. Trade-plan generation works correctly against live market metadata as a dry run.

The execution layer (real order submission) is **implemented and unit-tested against mocks, but has not been exercised against real Bitget order placement**, because `PRED_TRADING_ENABLED=false` throughout every documented validation. No real-money order has been submitted. No real-money fill has been observed. GDELT — one of two news sources — is currently timing out in production. These facts are not hidden: they are the explicit boundary of what this validation record supports.
