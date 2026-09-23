// News via the GDELT DOC 2.0 API (LIVE, keyless).
//   https://api.gdeltproject.org/api/v2/doc/doc?query=…&mode=artlist&format=json
// GDELT asks clients to send at most one request every 5 seconds; it replies
// to faster callers with a plain-text notice, which is treated as a
// retryable rate-limit error. Results are cached and de-duplicated.

import { createHttp, safeUrl } from '../util/http.js';

const PRESS_WIRES = ['businesswire.com', 'prnewswire.com', 'globenewswire.com', 'accesswire.com'];

export function parseGdeltDate(s) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s || '');
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function classifyArticle(article, asset) {
  const title = article.title || '';
  const domain = (article.domain || '').toLowerCase();
  const matchedTerms = (asset.newsTerms || []).filter((t) => new RegExp(`\\b${esc(t)}\\b`, 'i').test(title));
  const inTitle = matchedTerms.length > 0;
  const official = (asset.irDomains || []).some((d) => domain === d || domain.endsWith(`.${d}`)) || (inTitle && PRESS_WIRES.some((d) => domain === d || domain.endsWith(`.${d}`)));
  const relevance = Math.min(1, (inTitle ? 0.6 : 0.2) + 0.15 * Math.max(0, matchedTerms.length - 1) + (official ? 0.3 : 0));
  return { scope: inTitle ? 'company' : 'mention', official, matchedTerms, relevance: Math.round(relevance * 100) / 100 };
}

const canonical = (u) => {
  try {
    const x = new URL(u);
    return `${x.hostname.replace(/^www\./, '')}${x.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return String(u);
  }
};
const titleKey = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// GDELT's DOC index refreshes every 15 minutes, so asking more often adds load
// without adding news. Shared cloud IPs get blocked when hammered, so PRED
// (1) caches each company query for 15 min, (2) never retries into a 429 and
// instead pauses all GDELT calls with exponential backoff (1, 2, 4 … 30 min),
// and (3) keeps at most a few requests waiting, skipping the rest until the
// next rescan rather than queueing requests whose callers already gave up.
const CACHE_MS = 15 * 60_000;
const MAX_WAITING = 4;

export function createNewsSource({ fetchImpl = fetch, timespan = '24h', now = () => Date.now() } = {}) {
  const http = createHttp({ name: 'gdelt', minIntervalMs: 6000, timeoutMs: 15000, retries: 0, fetchImpl, cacheTtlMs: CACHE_MS });
  const cache = new Map();
  const guard = { pausedUntil: 0, strikes: 0, waiting: 0 };
  const hhmm = (t) => new Date(t).toISOString().slice(11, 16);
  const unavailable = (msg) => Object.assign(new Error(msg), { gdeltSkipped: true });

  async function fetchNews(url) {
    const hit = cache.get(url);
    if (hit && now() - hit.at < CACHE_MS) return hit.body;
    if (now() < guard.pausedUntil) throw unavailable(`GDELT paused after rate limiting — retrying after ${hhmm(guard.pausedUntil)} UTC`);
    if (guard.waiting >= MAX_WAITING) throw unavailable('GDELT busy — news re-checked on the next rescan');
    guard.waiting++;
    try {
      const body = await http.getJson(url, { cacheTtlMs: 0 });
      guard.strikes = 0;
      cache.set(url, { at: now(), body });
      if (cache.size > 500) cache.delete(cache.keys().next().value);
      return body;
    } catch (err) {
      if (/429|rate limited|timeout|no response/i.test(String(err.message))) {
        guard.strikes++;
        const pauseMs = Math.min(30 * 60_000, 60_000 * 2 ** (guard.strikes - 1));
        guard.pausedUntil = now() + pauseMs;
        http.health.lastError = `rate limited by GDELT — paused until ${hhmm(guard.pausedUntil)} UTC (backoff ${Math.round(pauseMs / 60_000)} min)`;
      }
      throw err;
    } finally {
      guard.waiting--;
    }
  }

  function query(terms) {
    // GDELT rejects parentheses around a single term ("Parentheses may only
    // be used around OR'd statements"), so only group two or more.
    const quoted = terms.map((t) => `"${t.replace(/"/g, '')}"`);
    const q = `${quoted.length > 1 ? `(${quoted.join(' OR ')})` : quoted[0]} sourcelang:english`;
    return `https://api.gdeltproject.org/api/v2/doc/doc?${new URLSearchParams({ query: q, mode: 'artlist', format: 'json', maxrecords: '50', sort: 'datedesc', timespan })}`;
  }

  return {
    id: 'gdelt-news',
    name: 'GDELT news',
    category: 'news',
    provenance: 'LIVE',
    health: http.health,
    // For the status panel: intentional backoff vs a persistent block.
    backoff: () => ({ paused: now() < guard.pausedUntil, pausedUntil: guard.pausedUntil || null, strikes: guard.strikes }),

    async probe() {
      if (now() < guard.pausedUntil) return { status: 'ok', note: `paused after rate limiting until ${hhmm(guard.pausedUntil)} UTC` };
      const body = await fetchNews(query(['stock market']));
      return { status: 'ok', note: `${(body.articles || []).length} articles in probe` };
    },

    async collect({ asset, now }) {
      const terms = (asset.newsTerms || []).filter((t) => t && t.length >= 3);
      if (!terms.length) return { status: 'ok', note: `no search terms for ${asset.ticker}`, evidence: [] };
      let body;
      try {
        body = await fetchNews(query(terms));
      } catch (err) {
        if (err.gdeltSkipped) return { status: 'unavailable', note: err.message, evidence: [] };
        throw err;
      }
      if (body && typeof body === 'object' && !('articles' in body) && Object.keys(body).length) return { status: 'unavailable', note: 'GDELT response missing articles', evidence: [] };
      const seenUrl = new Set();
      const seenTitle = new Set();
      const evidence = [];
      for (const a of body?.articles || []) {
        const ts = parseGdeltDate(a.seendate);
        const url = safeUrl(a.url);
        if (!ts || ts > now || !url || !a.title) continue;
        const cu = canonical(url);
        const tk = titleKey(a.title);
        if (seenUrl.has(cu) || seenTitle.has(tk)) continue;
        seenUrl.add(cu);
        seenTitle.add(tk);
        const c = classifyArticle(a, asset);
        evidence.push({
          key: `news:${cu}`,
          kind: 'NEWS_ARTICLE',
          title: String(a.title).slice(0, 300),
          detail: `${a.domain || 'unknown source'}${c.official ? ' · official / press wire' : ''} · relevance ${c.relevance}`,
          sourceTime: ts,
          url,
          data: { scope: c.scope, official: c.official, domain: a.domain || null, publishedAt: ts, matchedTerms: c.matchedTerms, relevance: c.relevance, language: a.language || null },
        });
      }
      const inTitle = evidence.filter((e) => e.data.scope === 'company').length;
      return { status: 'ok', note: `${inTitle} relevant article(s) naming ${asset.company} in the headline, ${evidence.length - inTitle} other mention(s), last ${timespan}`, evidence };
    },
  };
}
