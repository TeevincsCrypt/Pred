// Which tokenized equities does Bitget list right now? (Unified v3 API)
import { createBitgetClient } from '../src/market/bitget.js';
import { buildUniverse } from '../src/market/live-universe.js';
import { loadRelationships } from '../src/market/relationships.js';

const client = createBitgetClient();
const [spot, futures] = await Promise.all([client.instruments('SPOT'), client.instruments('USDT-FUTURES').catch(() => [])]);
const { assets, monitored } = buildUniverse({ spot, futures, relationships: loadRelationships() });
console.log(`${spot.length} spot instruments, ${assets.length} tokenized-equity instruments (${monitored.length} monitorable)\n`);
for (const a of assets) console.log(`${a.symbol.padEnd(16)} ${String(a.category).padEnd(13)} ${String(a.status).padEnd(12)} ${a.key.padEnd(12)} ${a.issuer || ''} ${a.company}`);
