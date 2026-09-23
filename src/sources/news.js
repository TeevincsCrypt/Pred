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

export function createNewsSource({ fetchImpl = fetch, timespan = '24h' } = {}) {
  const http = createHttp({ name: 'gdelt', minIntervalMs: 6000, timeoutMs: 15000, retries: 1, baseBackoffMs: 10_000, fetchImpl, cacheTtlMs: 10 * 60_000 });

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

    async probe() {
      const body = await http.getJson(query(['stock market']), { cacheTtlMs: 15 * 60_000 });
      return { status: 'ok', note: `${(body.articles || []).length} articles in probe` };
    },

    async collect({ asset, now }) {
      const terms = (asset.newsTerms || []).filter((t) => t && t.length >= 3);
      if (!terms.length) return { status: 'ok', note: `no search terms for ${asset.ticker}`, evidence: [] };
      const body = await http.getJson(query(terms));
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
