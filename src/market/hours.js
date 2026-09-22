// U.S. equity market session calendar (NYSE/Nasdaq), computed in
// America/New_York regardless of the host timezone.
//
// Sessions: PRE 04:00-09:30, REGULAR 09:30-16:00, POST 16:00-20:00,
// OVERNIGHT 20:00-04:00, WEEKEND, HOLIDAY. A Ghost Event requires the
// REGULAR session to be closed.

const TZ = 'America/New_York';

// Full-day closures. Source: NYSE published holiday calendar.
const HOLIDAYS = new Set([
  '2025-01-01', '2025-01-09', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26',
  '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25',
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19',
  '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18',
  '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
]);

// Early closes at 13:00 ET.
const EARLY_CLOSES = new Set(['2025-07-03', '2025-11-28', '2025-12-24', '2026-11-27', '2026-12-24', '2027-11-26']);

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  weekday: 'short',
});

export function nyParts(ms) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    year: +p.year,
    month: +p.month,
    day: +p.day,
    hour: +p.hour,
    minute: +p.minute,
    second: +p.second,
    weekday: p.weekday, // Mon..Sun
  };
}

// UTC ms for a New York wall-clock time on a given YYYY-MM-DD.
export function nyWallToUtc(date, hour, minute = 0) {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hour, minute);
  // Offset between UTC and NY at the guess; apply twice to settle across DST edges.
  let ts = guess;
  for (let i = 0; i < 2; i++) {
    const p = nyParts(ts);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    ts += guess - asUtc;
  }
  return ts;
}

export const isHoliday = (date) => HOLIDAYS.has(date);

export function isTradingDay(date) {
  const [y, m, d] = date.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow !== 0 && dow !== 6 && !HOLIDAYS.has(date);
}

function regularWindow(date) {
  const open = nyWallToUtc(date, 9, 30);
  const close = EARLY_CLOSES.has(date) ? nyWallToUtc(date, 13, 0) : nyWallToUtc(date, 16, 0);
  return { open, close };
}

function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

export function nextRegularOpen(ms) {
  let date = nyParts(ms).date;
  for (let i = 0; i < 14; i++, date = addDays(date, 1)) {
    if (!isTradingDay(date)) continue;
    const { open } = regularWindow(date);
    if (open > ms) return open;
  }
  return null;
}

// First regular-session close strictly after ms.
export function nextRegularClose(ms) {
  let date = nyParts(ms).date;
  for (let i = 0; i < 14; i++, date = addDays(date, 1)) {
    if (!isTradingDay(date)) continue;
    const { close } = regularWindow(date);
    if (close > ms) return close;
  }
  return null;
}

export function marketStatus(ms) {
  const p = nyParts(ms);
  const mins = p.hour * 60 + p.minute;
  let session;
  if (p.weekday === 'Sat' || p.weekday === 'Sun') session = 'WEEKEND';
  else if (HOLIDAYS.has(p.date)) session = 'HOLIDAY';
  else {
    const { close } = regularWindow(p.date);
    const closeMins = nyParts(close).hour * 60 + nyParts(close).minute;
    if (mins >= 570 && mins < closeMins) session = 'REGULAR';
    else if (mins >= 240 && mins < 570) session = 'PRE_MARKET';
    else if (mins >= closeMins && mins < 1200) session = 'AFTER_HOURS';
    else session = 'OVERNIGHT';
  }
  const open = session === 'REGULAR';
  return {
    session,
    usMarketOpen: open,
    label: open ? 'US MARKET OPEN' : 'US MARKET CLOSED',
    nyTime: `${p.date} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')} ET`,
    nextOpen: open ? null : nextRegularOpen(ms),
    nextClose: nextRegularClose(ms),
  };
}
