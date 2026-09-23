// Configurable relationship map for correlated-asset analysis, keyed by the
// UNDERLYING U.S. ticker. PRED maps these onto whatever instruments Bitget
// actually lists; an entry for a stock Bitget doesn't list is simply unused.
//
// Override or extend with PRED_RELATIONSHIPS_FILE (same JSON shape).
// Companies not listed here still work: SEC EDGAR's official ticker map
// supplies the company name and CIK, and they are compared against the
// market-wide move of all live tokenized equities.

import fs from 'node:fs';

export const DEFAULT_RELATIONSHIPS = {
  NVDA: { company: 'NVIDIA', sector: 'Semiconductors / AI', peers: ['AMD', 'AVGO', 'TSM', 'INTC'], newsTerms: ['NVIDIA', 'Nvidia'], irDomains: ['nvidianews.nvidia.com', 'investor.nvidia.com'] },
  AMD: { company: 'Advanced Micro Devices', sector: 'Semiconductors / AI', peers: ['NVDA', 'AVGO', 'TSM', 'INTC'], newsTerms: ['Advanced Micro Devices', 'AMD'], irDomains: ['ir.amd.com'] },
  AVGO: { company: 'Broadcom', sector: 'Semiconductors / AI', peers: ['NVDA', 'AMD', 'TSM'], newsTerms: ['Broadcom'] },
  TSM: { company: 'Taiwan Semiconductor', sector: 'Semiconductors / AI', peers: ['NVDA', 'AMD', 'AVGO'], newsTerms: ['TSMC', 'Taiwan Semiconductor'] },
  INTC: { company: 'Intel', sector: 'Semiconductors / AI', peers: ['AMD', 'NVDA'], newsTerms: ['Intel'] },
  AAPL: { company: 'Apple', sector: 'Mega-cap tech', peers: ['MSFT', 'GOOGL', 'AMZN', 'META'], newsTerms: ['Apple Inc', 'Apple'] },
  MSFT: { company: 'Microsoft', sector: 'Mega-cap tech', peers: ['AAPL', 'GOOGL', 'AMZN', 'META'], newsTerms: ['Microsoft'] },
  GOOGL: { company: 'Alphabet', sector: 'Mega-cap tech', peers: ['MSFT', 'META', 'AMZN', 'AAPL'], newsTerms: ['Alphabet', 'Google'] },
  AMZN: { company: 'Amazon', sector: 'Mega-cap tech', peers: ['MSFT', 'GOOGL', 'AAPL', 'META'], newsTerms: ['Amazon'] },
  META: { company: 'Meta Platforms', sector: 'Mega-cap tech', peers: ['GOOGL', 'MSFT', 'AMZN'], newsTerms: ['Meta Platforms', 'Facebook'] },
  NFLX: { company: 'Netflix', sector: 'Media', peers: ['META', 'GOOGL'], newsTerms: ['Netflix'] },
  TSLA: { company: 'Tesla', sector: 'Autos / EV', peers: ['NVDA'], newsTerms: ['Tesla'], irDomains: ['ir.tesla.com'] },
  COIN: { company: 'Coinbase', sector: 'Crypto equities', peers: ['MSTR', 'HOOD', 'CRCL'], newsTerms: ['Coinbase'] },
  MSTR: { company: 'Strategy', sector: 'Crypto equities', peers: ['COIN'], newsTerms: ['MicroStrategy', 'Strategy Inc', 'Saylor'] },
  HOOD: { company: 'Robinhood', sector: 'Crypto equities', peers: ['COIN'], newsTerms: ['Robinhood'] },
  CRCL: { company: 'Circle Internet Group', sector: 'Crypto equities', peers: ['COIN'], newsTerms: ['Circle Internet', 'Circle'] },
  PLTR: { company: 'Palantir', sector: 'Software / AI', peers: ['MSFT', 'NVDA'], newsTerms: ['Palantir'] },
  SPY: { company: 'SPDR S&P 500 ETF', sector: 'Index ETF', peers: ['QQQ', 'IVV'], newsTerms: ['S&P 500'], isFund: true },
  IVV: { company: 'iShares Core S&P 500 ETF', sector: 'Index ETF', peers: ['SPY', 'QQQ'], newsTerms: ['S&P 500'], isFund: true },
  QQQ: { company: 'Invesco QQQ Trust', sector: 'Index ETF', peers: ['SPY'], newsTerms: ['Nasdaq 100', 'Nasdaq-100'], isFund: true },
};

export function loadRelationships(file = process.env.PRED_RELATIONSHIPS_FILE) {
  if (!file) return DEFAULT_RELATIONSHIPS;
  try {
    const extra = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ...DEFAULT_RELATIONSHIPS, ...extra };
  } catch (err) {
    console.error(`PRED_RELATIONSHIPS_FILE unreadable (${err.message}); using defaults`);
    return DEFAULT_RELATIONSHIPS;
  }
}
