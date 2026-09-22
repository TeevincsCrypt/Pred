// Quick connectivity check: which tokenized equities does Bitget list, and
// can PRED pull 1-minute candles for them?
import { createBitgetClient, resolveSymbols } from '../src/market/bitget.js';
import { ASSETS } from '../src/market/universe.js';

const client = createBitgetClient();
const listed = await client.symbols();
const map = resolveSymbols(listed, ASSETS);
console.log('Resolved tokenized equities:', map);
for (const [ticker, symbol] of Object.entries(map)) {
  const bars = await client.candles(symbol, { limit: 5 });
  const t = await client.ticker(symbol);
  console.log(`${ticker.padEnd(6)} ${symbol.padEnd(12)} last=${t.last} bid=${t.bid} ask=${t.ask} bars=${bars.length}`);
}
