// Scripted source for demo mode. Items become visible only once the
// (virtual) clock passes their `availableAt`, so the verifier discovers
// them exactly as it would discover live items. Everything it emits is
// labeled SIMULATED.

export function createScriptedSource({ id, name, category, items = [] }) {
  return {
    id,
    name,
    category,
    provenance: 'SIMULATED',
    items,
    async collect({ asset, now }) {
      const visible = items.filter((it) => it.ticker === asset.ticker && it.availableAt <= now);
      const evidence = visible.map((it) => ({ key: it.key, kind: it.kind, title: it.title, detail: it.detail, sourceTime: it.availableAt, data: it.data || {} }));
      return { status: 'ok', note: `${visible.length} item(s) visible (scenario script)`, evidence };
    },
  };
}
