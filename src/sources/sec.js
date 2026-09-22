// SEC EDGAR recent filings (LIVE). https://www.sec.gov/os/accessing-edgar-data
// EDGAR requires a descriptive User-Agent with contact info: set SEC_USER_AGENT.

const UA = process.env.SEC_USER_AGENT || 'PRED hackathon research bot (set SEC_USER_AGENT)';
const MATERIAL_FORMS = new Set(['8-K', '6-K', '10-Q', '10-K', 'SC 13D', 'SC 13G', '4', 'S-3', '424B5']);

export function createSecSource({ fetchImpl = fetch, lookbackHours = 72 } = {}) {
  return {
    id: 'sec-edgar',
    name: 'SEC EDGAR filings',
    category: 'filings',
    provenance: 'LIVE',
    async collect({ asset, now }) {
      if (!asset.cik) return { status: 'not_configured', note: 'No CIK for asset', evidence: [] };
      const url = `https://data.sec.gov/submissions/CIK${asset.cik}.json`;
      const res = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`EDGAR HTTP ${res.status}`);
      const body = await res.json();
      const r = body.filings?.recent;
      if (!r) return { status: 'ok', note: 'No recent filings block', evidence: [] };
      const evidence = [];
      for (let i = 0; i < r.form.length && i < 60; i++) {
        const acceptedAt = Date.parse(r.acceptanceDateTime[i]);
        if (!Number.isFinite(acceptedAt) || now - acceptedAt > lookbackHours * 3600_000 || acceptedAt > now) continue;
        if (!MATERIAL_FORMS.has(r.form[i])) continue;
        const acc = r.accessionNumber[i].replace(/-/g, '');
        evidence.push({
          key: `sec:${r.accessionNumber[i]}`,
          kind: 'FILING',
          title: `${asset.company} filed ${r.form[i]}`,
          detail: `Accepted ${r.acceptanceDateTime[i]}${r.primaryDocDescription?.[i] ? ` — ${r.primaryDocDescription[i]}` : ''}`,
          sourceTime: acceptedAt,
          url: `https://www.sec.gov/Archives/edgar/data/${Number(asset.cik)}/${acc}/${r.primaryDocument[i]}`,
          data: { form: r.form[i] },
        });
      }
      return { status: 'ok', note: `${evidence.length} material filing(s) in last ${lookbackHours}h`, evidence };
    },
  };
}
