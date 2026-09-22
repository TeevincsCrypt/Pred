// News scan via the GDELT DOC 2.0 API (LIVE, keyless).
// https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/

const PRESS_WIRES = ['businesswire.com', 'prnewswire.com', 'globenewswire.com'];

export function parseGdeltDate(s) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s || '');
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

export function classifyArticle(article, asset) {
  const title = article.title || '';
  const domain = (article.domain || '').toLowerCase();
  const mentionsCompany = asset.newsTerms.some((t) => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(title));
  const official = (asset.irDomains || []).some((d) => domain.endsWith(d)) || (mentionsCompany && PRESS_WIRES.some((d) => domain.endsWith(d)));
  return { scope: mentionsCompany ? 'company' : 'sector', official };
}

export function createNewsSource({ fetchImpl = fetch, timespan = '24h' } = {}) {
  return {
    id: 'gdelt-news',
    name: 'Global news (GDELT)',
    category: 'news',
    provenance: 'LIVE',
    async collect({ asset, now }) {
      const q = `(${asset.newsTerms.map((t) => `"${t}"`).join(' OR ')}) sourcelang:english`;
      const url = `https://api.gdeltproject.org/api/v2/doc/doc?${new URLSearchParams({ query: q, mode: 'artlist', format: 'json', maxrecords: '25', sort: 'datedesc', timespan })}`;
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`GDELT HTTP ${res.status}`);
      const text = await res.text();
      const body = text.trim().startsWith('{') ? JSON.parse(text) : { articles: [] };
      const evidence = (body.articles || [])
        .map((a) => ({ a, ts: parseGdeltDate(a.seendate), c: classifyArticle(a, asset) }))
        .filter(({ ts }) => ts && ts <= now)
        .map(({ a, ts, c }) => ({
          key: `news:${a.url}`,
          kind: 'NEWS_ARTICLE',
          title: a.title,
          detail: `${a.domain}${c.official ? ' · official/press wire' : ''}`,
          sourceTime: ts,
          url: a.url,
          data: { scope: c.scope, official: c.official, domain: a.domain },
        }));
      return { status: 'ok', note: `${evidence.length} article(s) in last ${timespan}`, evidence };
    },
  };
}
