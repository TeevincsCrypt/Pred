// Scheduled-event calendar. Reads a user-maintained JSON file so PRED never
// invents earnings dates: [{ "ticker": "NVDAx", "title": "Q3 earnings", "at": "2026-11-19T21:20:00Z" }]

import fs from 'node:fs';

export function createCalendarSource({ file = process.env.PRED_CALENDAR || 'data/calendar.json', provenance = 'LIVE', entries = null } = {}) {
  return {
    id: 'calendar',
    name: 'Scheduled events',
    category: 'calendar',
    provenance,
    async collect({ asset, now }) {
      let list = entries;
      if (!list) {
        if (!fs.existsSync(file)) return { status: 'not_configured', note: `No calendar file (${file})`, evidence: [] };
        list = JSON.parse(fs.readFileSync(file, 'utf8'));
      }
      const evidence = list
        .filter((e) => e.ticker === asset.ticker)
        .map((e) => ({ ...e, ts: Date.parse(e.at) }))
        .filter((e) => e.ts > now - 6 * 3600_000 && e.ts < now + 7 * 86400_000)
        .map((e) => ({
          key: `cal:${e.ticker}:${e.at}`,
          kind: 'SCHEDULED_EVENT',
          title: e.title,
          detail: `Scheduled ${new Date(e.ts).toISOString()}`,
          sourceTime: now,
          data: { title: e.title, at: e.ts, hoursAway: Math.max(0, (e.ts - now) / 3600_000) },
        }));
      return { status: 'ok', note: `${evidence.length} scheduled event(s) within 7d`, evidence };
    },
  };
}
