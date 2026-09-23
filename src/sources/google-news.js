// Google News RSS — free, keyless backup news source, used automatically when
// GDELT is paused, rate-limited or blocking this server's IP (common on shared
// cloud hosts).
//   https://news.google.com/rss/search?q="NVIDIA" when:1d&hl=en-US&gl=US&ceid=US:en
// Same guarantees as GDELT: 15-min cache per query, no retry into a 429/503
// (exponential pause instead), headlines/URLs/publishers exactly as published.

import { createHttp } from '../util/http.js';

const CACHE_MS = 15 * 60_000;

const decode = (s) =>
  String(s ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
    .trim();
const tag = (xml, name) => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  return m ? decode(m[1]) : null;
};

// Parse RSS <item>s into { title, url, domain, publisher, ts }.
export function parseGoogleNewsRss(xml) {
  const out = [];
  for (const m of String(xml).matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const it = m[1];
    const sourceUrl = /<source[^>]*url="([^"]+)"/i.exec(it)?.[1] || null;
    const publisher = tag(it, 'source');
    let title = tag(it, 'title') || '';
    // Google appends " - Publisher" to titles.
    if (publisher && title.endsWith(` - ${publisher}`)) title = title.slice(0, -(publisher.length + 3));
    const ts = Date.parse(tag(it, 'pubDate') || '');
    let domain = null;
    try {
      domain = sourceUrl ? new URL(sourceUrl).hostname.replace(/^www\./, '') : null;
    } catch {
      domain = null;
    }
    out.push({ title, url: tag(it, 'link'), domain, publisher, ts: Number.isFinite(ts) ? ts : null });
  }
  return out;
}

export function createGoogleNewsSource({ fetchImpl = fetch, now = () => Date.now() } = {}) {
  const http = createHttp({ name: 'googlenews', minIntervalMs: 2000, timeoutMs: 12_000, retries: 0, fetchImpl, cacheTtlMs: 0 });
  const cache = new Map();
  const guard = { pausedUntil: 0, strikes: 0 };
  const hhmm = (t) => new Date(t).toISOString().slice(11, 16);

  const url = (terms) => {
    const q = `${terms.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ')} when:1d`;
    return `https://news.google.com/rss/search?${new URLSearchParams({ q, hl: 'en-US', gl: 'US', ceid: 'US:en' })}`;
  };

  async function search(terms) {
    const u = url(terms);
    const hit = cache.get(u);
    if (hit && now() - hit.at < CACHE_MS) return hit.items;
    if (now() < guard.pausedUntil) throw Object.assign(new Error(`Google News paused after rate limiting — retrying after ${hhmm(guard.pausedUntil)} UTC`), { skipped: true });
    try {
      const xml = await http.getText(u, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PRED/1.0; +market-intelligence)', Accept: 'application/rss+xml, application/xml' } });
      if (!/<rss[\s>]/i.test(xml)) throw new Error('Google News: response is not RSS');
      const items = parseGoogleNewsRss(xml);
      guard.strikes = 0;
      cache.set(u, { at: now(), items });
      if (cache.size > 500) cache.delete(cache.keys().next().value);
      return items;
    } catch (err) {
      if (/429|503|timeout|no response/i.test(String(err.message))) {
        guard.strikes++;
        guard.pausedUntil = now() + Math.min(30 * 60_000, 60_000 * 2 ** (guard.strikes - 1));
        http.health.lastError = `rate limited by Google News — paused until ${hhmm(guard.pausedUntil)} UTC`;
      }
      throw err;
    }
  }

  return {
    id: 'google-news',
    name: 'Google News RSS',
    health: http.health,
    search,
    async probe() {
      const items = await search(['stock market']);
      return { status: 'ok', note: `${items.length} headlines in probe` };
    },
  };
}
