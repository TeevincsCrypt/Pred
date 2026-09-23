// Persistence on Node's built-in SQLite (node:sqlite, no dependency).
// Single-instance deployments with a persistent disk (e.g. a Railway
// volume mounted at /app/data). Tables:
//   events      one row per Ghost Event (latest full JSON snapshot)
//   event_log   append-only audit trail: every timeline entry, state
//               transition, hypothesis revision, evidence item, prediction
//   memory      PRED Memory records (outcomes, evaluations)
//   candles     1-minute observations needed to resume detection after restart
//   meta        schema version

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_VERSION = 1;

export function openDb(file = process.env.PRED_DB_PATH || 'data/pred.sqlite') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY, mode TEXT NOT NULL, seq INTEGER NOT NULL, ticker TEXT NOT NULL,
      state TEXT, detected_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS events_mode ON events(mode, detected_at);
    CREATE TABLE IF NOT EXISTS event_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL, at INTEGER NOT NULL,
      kind TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS event_log_event ON event_log(event_id, id);
    CREATE TABLE IF NOT EXISTS memory (id TEXT PRIMARY KEY, mode TEXT NOT NULL, detected_at INTEGER, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS candles (
      key TEXT NOT NULL, ts INTEGER NOT NULL, open REAL, high REAL, low REAL, close REAL, volume REAL, quote_volume REAL,
      PRIMARY KEY (key, ts));
  `);
  db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));

  const q = {
    saveEvent: db.prepare('INSERT INTO events (id, mode, seq, ticker, state, detected_at, updated_at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at, data = excluded.data'),
    appendLog: db.prepare('INSERT INTO event_log (event_id, at, kind, payload) VALUES (?, ?, ?, ?)'),
    loadEvents: db.prepare('SELECT data FROM events WHERE mode = ? ORDER BY detected_at'),
    eventLog: db.prepare('SELECT id, at, kind, payload FROM event_log WHERE event_id = ? ORDER BY id'),
    saveMemory: db.prepare('INSERT INTO memory (id, mode, detected_at, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data'),
    loadMemory: db.prepare('SELECT data FROM memory WHERE mode = ? ORDER BY detected_at'),
    saveCandle: db.prepare('INSERT OR REPLACE INTO candles (key, ts, open, high, low, close, volume, quote_volume) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    loadCandles: db.prepare('SELECT ts, open, high, low, close, volume, quote_volume AS quoteVolume FROM candles WHERE key = ? AND ts >= ? ORDER BY ts'),
    pruneCandles: db.prepare('DELETE FROM candles WHERE ts < ?'),
    counts: db.prepare("SELECT (SELECT COUNT(*) FROM events WHERE mode = 'live') AS events, (SELECT COUNT(*) FROM event_log) AS logEntries, (SELECT COUNT(*) FROM memory WHERE mode = 'live') AS memory, (SELECT COUNT(*) FROM candles) AS candles"),
  };

  const tx = (fn) => {
    db.exec('BEGIN');
    try {
      fn();
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };

  return {
    file,
    saveEvent(e) {
      q.saveEvent.run(e.id, e.mode, e.seq, e.ticker, e.state ?? null, e.detectedAt, Date.now(), JSON.stringify(e));
    },
    appendLog(eventId, kind, payload) {
      q.appendLog.run(eventId, payload?.at ?? Date.now(), kind, JSON.stringify(payload));
    },
    loadEvents(mode) {
      return q.loadEvents.all(mode).map((r) => JSON.parse(r.data));
    },
    eventLog(eventId) {
      return q.eventLog.all(eventId).map((r) => ({ id: r.id, at: r.at, kind: r.kind, ...JSON.parse(r.payload) }));
    },
    saveMemory(r) {
      q.saveMemory.run(String(r.id), r.mode || 'live', r.detectedAt ?? null, JSON.stringify(r));
    },
    loadMemory(mode) {
      return q.loadMemory.all(mode).map((r) => JSON.parse(r.data));
    },
    saveCandles(key, bars) {
      tx(() => {
        for (const b of bars) q.saveCandle.run(key, b.ts, b.open, b.high, b.low, b.close, b.volume, b.quoteVolume ?? null);
      });
    },
    loadCandles(key, sinceTs) {
      return q.loadCandles.all(key, sinceTs).map((r) => ({ ...r }));
    },
    prune(keepMs = 3 * 86400_000) {
      q.pruneCandles.run(Date.now() - keepMs);
    },
    health() {
      const t0 = Date.now();
      db.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('health_check', CAST(strftime('%s','now') AS TEXT))");
      const c = q.counts.get();
      return { status: 'connected', file, latencyMs: Date.now() - t0, counts: { ...c } };
    },
    close() {
      db.close();
    },
  };
}
