// Runtime configuration (environment variables). LIVE is the default mode.
const int = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);
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

  dbPath: process.env.PRED_DB_PATH || 'data/pred.sqlite',
  calendarFile: process.env.PRED_CALENDAR || 'data/calendar.json',
};
