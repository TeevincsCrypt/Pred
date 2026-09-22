import { DEFAULT_MONITORED } from './market/universe.js';

export const config = {
  port: +(process.env.PORT || 8787),
  live: process.env.PRED_LIVE !== '0',
  monitored: (process.env.PRED_MONITORED || DEFAULT_MONITORED.join(',')).split(',').map((s) => s.trim()).filter(Boolean),
  pollMs: +(process.env.PRED_POLL_MS || 20_000),
  memoryFile: process.env.PRED_MEMORY_FILE || 'data/memory-live.json',
};
