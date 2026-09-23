// Runtime configuration (environment variables). LIVE is the default mode.
const int = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);
const posNum = (v) => (v != null && v !== '' && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
const list = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : null);

const mode = (process.env.PRED_MODE || 'live').toLowerCase() === 'demo' ? 'demo' : 'live';

export const config = {
  port: int(process.env.PORT, 8787),
  mode,
  // In live mode the simulated demo is off unless explicitly enabled; it then
  // runs fully separately under /demo with its own simulated memory.
  demoEnabled: mode === 'demo' || process.env.PRED_DEMO_ENABLED === 'true',
  live: mode === 'live' && process.env.PRED_LIVE !== '0',

  bitgetBaseUrl: process.env.BITGET_BASE_URL || 'https://api.bitget.com',
  assets: list(process.env.PRED_ASSETS),
  // How many eligible U.S.-listed instruments to watch, ranked by 24h turnover.
  // "all" watches every eligible one (candle polling scales to match).
  maxAssets: String(process.env.PRED_MAX_ASSETS).toLowerCase() === 'all' ? Infinity : int(process.env.PRED_MAX_ASSETS, 30),
  // Both Bitget categories that carry tokenized U.S. equities: spot RWA tokens
  // and USDT-margined stock perpetuals.
  categories: list(process.env.PRED_MONITOR_CATEGORIES) || ['SPOT', 'USDT-FUTURES'],
  pollIntervalMs: int(process.env.PRED_POLL_INTERVAL_MS, 15_000),
  detectorIntervalMs: int(process.env.PRED_DETECTOR_INTERVAL_MS, 30_000),
  assetRefreshMs: int(process.env.PRED_ASSET_REFRESH_MS, 15 * 60_000),
  candleRefreshMs: int(process.env.PRED_CANDLE_REFRESH_MS, 60_000),
  candleBatch: int(process.env.PRED_CANDLE_BATCH, 15),
  staleAfterMs: int(process.env.PRED_STALE_AFTER_MS, 10 * 60_000),
  minTurnoverUsd: int(process.env.PRED_MIN_TURNOVER_USD, 5_000),
  rescanIntervalMs: int(process.env.PRED_RESCAN_INTERVAL_MS, 5 * 60_000),
  sourceProbeMs: int(process.env.PRED_SOURCE_PROBE_MS, 10 * 60_000),
  resolutionTimeoutMs: int(process.env.PRED_VERIFY_TIMEOUT_MS, null),
  // Verification closes this long after the next U.S. open ("off" = wait for the close).
  openDeadlineMs: String(process.env.PRED_OPEN_GRACE_MS).toLowerCase() === 'off' ? null : int(process.env.PRED_OPEN_GRACE_MS, 30 * 60_000),

  // ---------- Human-approved trade execution (src/trading/) ----------
  // Live orders are possible only when ALL of these hold: PRED_MODE=live,
  // PRED_TRADING_ENABLED=true (exactly), Bitget API credentials, an admin
  // token for the approval login, and every safety limit set. Credentials
  // and the admin token are read inside their modules and never stored here.
  trading: {
    enabled: mode === 'live' && process.env.PRED_TRADING_ENABLED === 'true',
    maxOrderNotional: posNum(process.env.PRED_MAX_ORDER_NOTIONAL),
    maxPositionNotional: posNum(process.env.PRED_MAX_POSITION_NOTIONAL),
    maxDailyNotional: posNum(process.env.PRED_MAX_DAILY_TRADING_NOTIONAL),
    planNotional: posNum(process.env.PRED_TRADE_NOTIONAL) ?? 25,
    planTtlMs: int(process.env.PRED_TRADE_PLAN_TTL_MS, 5 * 60_000),
    maxDriftBps: int(process.env.PRED_TRADE_MAX_DRIFT_BPS, 50),
    slippageBps: int(process.env.PRED_TRADE_SLIPPAGE_BPS, 10),
    quoteMaxAgeMs: int(process.env.PRED_TRADE_QUOTE_MAX_AGE_MS, 15_000),
    autoPlanMinConfidence: int(process.env.PRED_TRADE_MIN_CONFIDENCE, 60),
    marginMode: process.env.PRED_TRADE_MARGIN_MODE === 'crossed' ? 'crossed' : 'isolated',
    statusPollMs: int(process.env.PRED_TRADE_STATUS_POLL_MS, 10_000),
  },

  dbPath: process.env.PRED_DB_PATH || 'data/pred.sqlite',
  calendarFile: process.env.PRED_CALENDAR || 'data/calendar.json',
};
