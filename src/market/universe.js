// Tokenized-equity universe PRED knows how to reason about.
//
// `bitgetCandidates` are base-coin names PRED looks for in Bitget's public
// symbol list at startup; the first one that is listed and online wins.
// Override the mapping with PRED_SYMBOL_MAP (e.g. "NVDAx=NVDAXUSDT").

export const ASSETS = {
  NVDAx: {
    ticker: 'NVDAx',
    underlying: 'NVDA',
    company: 'NVIDIA',
    cik: '0001045810',
    sector: 'Semiconductors / AI',
    peers: ['AMDx', 'AVGOx', 'TSMx'],
    newsTerms: ['NVIDIA', 'Nvidia', 'NVDA'],
    irDomains: ['nvidianews.nvidia.com', 'investor.nvidia.com', 'blogs.nvidia.com'],
    bitgetCandidates: ['NVDAX', 'NVDAON'],
  },
  AMDx: {
    ticker: 'AMDx',
    underlying: 'AMD',
    company: 'Advanced Micro Devices',
    cik: '0000002488',
    sector: 'Semiconductors / AI',
    peers: ['NVDAx', 'AVGOx', 'TSMx'],
    newsTerms: ['AMD', 'Advanced Micro Devices'],
    irDomains: ['ir.amd.com', 'amd.com'],
    bitgetCandidates: ['AMDX', 'AMDON'],
  },
  AVGOx: {
    ticker: 'AVGOx',
    underlying: 'AVGO',
    company: 'Broadcom',
    cik: '0001730168',
    sector: 'Semiconductors / AI',
    peers: ['NVDAx', 'AMDx', 'TSMx'],
    newsTerms: ['Broadcom', 'AVGO'],
    bitgetCandidates: ['AVGOX', 'AVGOON'],
  },
  TSMx: {
    ticker: 'TSMx',
    underlying: 'TSM',
    company: 'Taiwan Semiconductor',
    cik: '0001046179',
    sector: 'Semiconductors / AI',
    peers: ['NVDAx', 'AMDx', 'AVGOx'],
    newsTerms: ['TSMC', 'Taiwan Semiconductor'],
    bitgetCandidates: ['TSMX', 'TSMON'],
  },
  TSLAx: {
    ticker: 'TSLAx',
    underlying: 'TSLA',
    company: 'Tesla',
    cik: '0001318605',
    sector: 'Autos / EV',
    peers: ['NVDAx'],
    newsTerms: ['Tesla', 'TSLA', 'Elon Musk'],
    irDomains: ['ir.tesla.com', 'tesla.com'],
    bitgetCandidates: ['TSLAX', 'TSLAON'],
  },
  AAPLx: {
    ticker: 'AAPLx',
    underlying: 'AAPL',
    company: 'Apple',
    cik: '0000320193',
    sector: 'Mega-cap tech',
    peers: ['MSFTx'],
    newsTerms: ['Apple Inc', 'AAPL'],
    bitgetCandidates: ['AAPLX', 'AAPLON'],
  },
  MSFTx: {
    ticker: 'MSFTx',
    underlying: 'MSFT',
    company: 'Microsoft',
    cik: '0000789019',
    sector: 'Mega-cap tech',
    peers: ['AAPLx', 'NVDAx'],
    newsTerms: ['Microsoft', 'MSFT'],
    bitgetCandidates: ['MSFTX', 'MSFTON'],
  },
  COINx: {
    ticker: 'COINx',
    underlying: 'COIN',
    company: 'Coinbase',
    cik: '0001679788',
    sector: 'Crypto equities',
    peers: ['MSTRx'],
    newsTerms: ['Coinbase', 'COIN'],
    bitgetCandidates: ['COINX', 'COINON'],
  },
  MSTRx: {
    ticker: 'MSTRx',
    underlying: 'MSTR',
    company: 'Strategy (MicroStrategy)',
    cik: '0001050446',
    sector: 'Crypto equities',
    peers: ['COINx'],
    newsTerms: ['MicroStrategy', 'Strategy Inc', 'MSTR', 'Saylor'],
    bitgetCandidates: ['MSTRX', 'MSTRON'],
  },
};

// Crypto reference assets used for cross-asset correlation.
export const CRYPTO_REFS = { BTC: 'BTCUSDT', ETH: 'ETHUSDT' };

export const DEFAULT_MONITORED = ['NVDAx', 'AMDx', 'AVGOx', 'TSMx', 'TSLAx', 'COINx'];
