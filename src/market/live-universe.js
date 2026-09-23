// Builds PRED's live asset universe from Bitget's instrument list.
// Nothing here invents a symbol: every asset comes from the instrument
// response, and PRED_ASSETS can only narrow that list.

const COMMODITY_BASES = new Set(['XAUT', 'PAXG', 'XAUM', 'KAU', 'KAG', 'XAGX', 'XAUX']);

// NVDAX → { underlying: 'NVDA', issuer: 'xStocks' }, NVDAON → { 'NVDA', 'Ondo' }.
export function parseUnderlying(baseCoin) {
  const b = String(baseCoin || '').toUpperCase();
  if (COMMODITY_BASES.has(b)) return { underlying: b, issuer: null, assetClass: 'commodity', suffix: '' };
  let m = /^([A-Z]{1,6})ON$/.exec(b);
  if (m) return { underlying: m[1], issuer: 'Ondo', assetClass: 'equity', suffix: 'on' };
  m = /^([A-Z]{1,6})X$/.exec(b);
  if (m) return { underlying: m[1], issuer: 'xStocks', assetClass: 'equity', suffix: 'x' };
  return { underlying: b, issuer: null, assetClass: 'rwa-other', suffix: '' };
}

const cleanCompany = (title) =>
  String(title || '')
    .replace(/\s*\/[a-z]{2,3}\/?/gi, ' ') // EDGAR state suffixes: /DE/, /NY, /new
    .replace(/\b(INC|CORP|CORPORATION|CO|LTD|PLC|HOLDINGS?|GROUP|N\.?V\.?|S\.?A\.?|AG|CLASS [A-Z])\b\.?/gi, '')
    .replace(/[,.]+/g, ' ')
    .replace(/[&/\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

// Perpetual base coins name the underlying directly; Bitget appends STOCK
// where the ticker would clash with a crypto coin (RTXSTOCK, NOKSTOCK) and
// HKD for Hong Kong listings.
export function parsePerpUnderlying(baseCoin, symbolType) {
  const b = String(baseCoin || '').toUpperCase();
  const hk = /HKD$/.test(b);
  const underlying = b.replace(/STOCK$/, '').replace(/HKD$/, '');
  const assetClass = symbolType === 'metal' || symbolType === 'commodity' || COMMODITY_BASES.has(b) ? 'commodity' : symbolType === 'crypto' ? 'crypto' : 'equity';
  return { underlying, issuer: null, assetClass, suffix: '', market: hk ? 'HK' : null };
}

function titleCase(s) {
  return s
    .toLowerCase()
    .split(' ')
    .map((w) => (w.length <= 3 && w === w.toUpperCase() ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

export function displayTicker(inst, parsed) {
  if (inst.category === 'USDT-FUTURES') return `${inst.baseCoin}-PERP`;
  return parsed.suffix ? `${parsed.underlying}${parsed.suffix}` : inst.baseCoin;
}

/**
 * @param spot      normalized SPOT instruments
 * @param futures   normalized USDT-FUTURES instruments (may be empty)
 * @param tickers   Map symbol → normalized ticker (for liquidity ranking)
 * @param relationships  underlying → { company, sector, peers, newsTerms, irDomains }
 * @param secDirectory   Map TICKER → { cik, title } from SEC (optional)
 * @param opts { assetsFilter: string[]|null, maxAssets, categories: string[], quote }
 */
export function buildUniverse({ spot = [], futures = [], tickers = new Map(), relationships = {}, secDirectory = null, opts = {} }) {
  const { assetsFilter = null, maxAssets = 30, categories = ['SPOT', 'USDT-FUTURES'], quote = 'USDT' } = opts;
  const candidates = [
    ...spot.filter((i) => i.isRwa),
    ...futures.filter((i) => i.symbolType === 'stock' || i.isRwa),
  ];

  const assets = [];
  const used = new Set();
  for (const inst of candidates) {
    const isPerp = (inst.category || (futures.includes(inst) ? 'USDT-FUTURES' : 'SPOT')) === 'USDT-FUTURES';
    const parsed = isPerp ? parsePerpUnderlying(inst.baseCoin, inst.symbolType) : parseUnderlying(inst.baseCoin);
    let key = displayTicker(inst, parsed);
    if (used.has(key)) key = `${key}:${inst.quoteCoin}`;
    if (used.has(key)) continue;
    used.add(key);
    // Commodity perps (CL = crude oil, BZ = Brent) share tickers with listed
    // companies, so they are never matched against the SEC registrant list.
    const isCommodity = parsed.assetClass === 'commodity';
    const rel = isCommodity ? null : relationships[parsed.underlying] || null;
    const sec = isCommodity ? null : secDirectory?.get(parsed.underlying) || null;
    // Bitget tags a few stock perps (HPQ, FCX, RIO…) as "crypto"; an SEC
    // registrant match identifies them as equities.
    const assetClass = rel?.isFund ? 'etf' : parsed.assetClass === 'crypto' && isPerp && sec ? 'equity' : parsed.assetClass;
    const company = rel?.company || (sec ? titleCase(cleanCompany(sec.title)) : null);
    const t = tickers.get(isPerp ? `${inst.symbol}:PERP` : inst.symbol) || null;
    // PRED reasons about U.S. market hours, so it monitors U.S.-listed
    // equities: in SEC EDGAR's registrant list or in the relationship map.
    // Without the SEC list, fall back to Bitget's own stock classification.
    const usListed = parsed.market !== 'HK' && !isCommodity && (!!rel || !!sec || (!secDirectory && (inst.symbolType === 'stock' || !isPerp)));
    assets.push({
      key,
      ticker: key,
      symbol: inst.symbol,
      category: isPerp ? 'USDT-FUTURES' : 'SPOT',
      baseCoin: inst.baseCoin,
      quoteCoin: inst.quoteCoin,
      status: inst.status,
      isRwa: inst.isRwa,
      symbolType: inst.symbolType,
      issuer: parsed.issuer,
      underlying: parsed.underlying,
      assetClass,
      usListed,
      company: company || parsed.underlying,
      cik: sec ? String(sec.cik).padStart(10, '0') : null,
      sector: rel?.sector || 'Unclassified',
      relatedUnderlyings: rel?.peers || [],
      newsTerms: rel?.newsTerms || (company ? [company] : []),
      irDomains: rel?.irDomains || [],
      turnover24h: t?.turnover24h ?? null,
      peers: [],
      monitored: false,
    });
  }

  // Monitored set: real, tradable equity/ETF instruments in the configured categories.
  const eligible = assets.filter((a) => categories.includes(a.category) && ['equity', 'etf'].includes(a.assetClass) && a.usListed && !['offline', 'restrictedAPI'].includes(a.status) && (a.category !== 'SPOT' || a.quoteCoin === quote));
  let monitored;
  const unmatched = [];
  if (assetsFilter?.length) {
    const want = assetsFilter.map((s) => s.trim().toUpperCase()).filter(Boolean);
    monitored = eligible.filter((a) => want.some((w) => w === a.symbol.toUpperCase() || w === String(a.baseCoin).toUpperCase() || w === a.underlying || w === a.key.toUpperCase()));
    for (const w of want) if (!assets.some((a) => w === a.symbol.toUpperCase() || w === String(a.baseCoin).toUpperCase() || w === a.underlying || w === a.key.toUpperCase())) unmatched.push(w);
  } else {
    monitored = [...eligible].sort((a, b) => (b.turnover24h ?? -1) - (a.turnover24h ?? -1)).slice(0, maxAssets);
  }
  for (const a of monitored) a.monitored = true;

  // Peers: same underlying from another issuer first ("sibling"), then mapped related companies.
  const monitoredSet = new Set(monitored.map((a) => a.key));
  for (const a of assets) {
    const siblings = assets.filter((b) => b !== a && b.underlying === a.underlying && b.category === a.category && monitoredSet.has(b.key)).map((b) => b.key);
    const related = assets.filter((b) => a.relatedUnderlyings.includes(b.underlying) && b.category === a.category && monitoredSet.has(b.key)).map((b) => b.key);
    a.siblings = siblings;
    a.peers = [...new Set([...siblings, ...related])].slice(0, 6);
  }
  return { assets, monitored: monitored.map((a) => a.key), unmatched, eligible: eligible.length };
}
