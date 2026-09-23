// SEC EDGAR (LIVE, official endpoints).
//   https://www.sec.gov/files/company_tickers.json        ticker → CIK directory
//   https://data.sec.gov/submissions/CIK##########.json   recent filings
// SEC fair-access rules: ≤10 requests/second and a User-Agent that names
// you and a contact email. Without SEC_USER_AGENT this source reports
// "not configured" instead of sending an anonymous request.

import { createHttp, safeUrl } from '../util/http.js';

const MATERIAL_FORMS = new Set(['8-K', '8-K/A', '6-K', '10-Q', '10-K', 'SC 13D', 'SC 13D/A', 'SC 13G', '4', 'S-3', '424B5', '425']);

export function createSecSource({ fetchImpl = fetch, lookbackHours = 72, userAgent = process.env.SEC_USER_AGENT } = {}) {
  const http = createHttp({ name: 'sec', minIntervalMs: 150, timeoutMs: 10000, retries: 2, fetchImpl });
  const headers = () => ({ 'User-Agent': userAgent, Accept: 'application/json' });
  let directory = null;
  let directoryAt = 0;

  async function loadDirectory() {
    if (!userAgent) return null;
    if (directory && Date.now() - directoryAt < 24 * 3600_000) return directory;
    const body = await http.getJson('https://www.sec.gov/files/company_tickers.json', { headers: headers() });
    if (!body || typeof body !== 'object') throw new Error('SEC ticker directory: malformed');
    const map = new Map();
    for (const row of Object.values(body)) {
      if (row && typeof row.ticker === 'string' && Number.isFinite(Number(row.cik_str))) map.set(row.ticker.toUpperCase().replace(/[.-]/g, ''), { cik: Number(row.cik_str), title: String(row.title || '') });
    }
    directory = map;
    directoryAt = Date.now();
    return directory;
  }

  return {
    id: 'sec-edgar',
    name: 'SEC EDGAR',
    category: 'filings',
    provenance: 'LIVE',
    health: http.health,
    configured: !!userAgent,
    loadDirectory,

    async probe() {
      if (!userAgent) return { status: 'not_configured', note: 'Set SEC_USER_AGENT (name + contact email)' };
      const dir = await loadDirectory();
      return { status: 'ok', note: `${dir.size} tickers in SEC directory` };
    },

    async collect({ asset, now }) {
      if (!userAgent) return { status: 'not_configured', note: 'SEC_USER_AGENT not set — EDGAR requires a contact User-Agent', evidence: [] };
      let cik = asset.cik;
      if (!cik) {
        const dir = await loadDirectory().catch(() => null);
        const hit = dir?.get(String(asset.underlying || '').toUpperCase());
        if (hit) cik = String(hit.cik).padStart(10, '0');
      }
      if (!cik) return { status: 'ok', note: `No SEC registrant for ${asset.underlying || asset.ticker} (fund or foreign issuer)`, evidence: [] };
      const body = await http.getJson(`https://data.sec.gov/submissions/CIK${cik}.json`, { headers: headers(), cacheTtlMs: 60_000 });
      const r = body?.filings?.recent;
      const cols = ['form', 'accessionNumber', 'filingDate', 'acceptanceDateTime', 'primaryDocument'];
      if (!r || !cols.every((c) => Array.isArray(r[c])) || new Set(cols.map((c) => r[c].length)).size !== 1) {
        return { status: 'unavailable', note: 'EDGAR response did not have the expected filings shape', evidence: [] };
      }
      const company = body.name || asset.company;
      const seen = new Set();
      const evidence = [];
      for (let i = 0; i < r.form.length && i < 100; i++) {
        const acceptedAt = Date.parse(r.acceptanceDateTime[i]);
        if (!Number.isFinite(acceptedAt) || acceptedAt > now || now - acceptedAt > lookbackHours * 3600_000) continue;
        if (!MATERIAL_FORMS.has(r.form[i])) continue;
        const accession = String(r.accessionNumber[i]);
        if (seen.has(accession)) continue;
        seen.add(accession);
        const url = safeUrl(`https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, '')}/${encodeURIComponent(r.primaryDocument[i])}`);
        evidence.push({
          key: `sec:${accession}`,
          kind: 'FILING',
          title: `${company} filed ${r.form[i]}`,
          detail: `Accepted ${r.acceptanceDateTime[i]}${r.items?.[i] ? ` · items ${r.items[i]}` : ''}${r.primaryDocDescription?.[i] ? ` · ${r.primaryDocDescription[i]}` : ''}`,
          sourceTime: acceptedAt,
          url,
          data: { accession, form: r.form[i], company, cik, filingDate: r.filingDate[i], acceptedAt, items: r.items?.[i] || null, description: r.primaryDocDescription?.[i] || null },
        });
      }
      return { status: 'ok', note: evidence.length ? `${evidence.length} material filing(s) in the last ${lookbackHours}h` : `no new material filing in the last ${lookbackHours}h`, evidence };
    },
  };
}
