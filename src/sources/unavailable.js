// Placeholder for a source category PRED checks but has no connector for.
// It is shown in the investigation as "not connected" rather than silently skipped.
export function createUnavailableSource(id, name, category, note) {
  return {
    id,
    name,
    category,
    provenance: 'LIVE',
    async collect() {
      return { status: 'not_configured', note, evidence: [] };
    },
  };
}
