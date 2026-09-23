// Trade-plan persistence (SQLite, same database as events).
//
//   trade_plans  one row per TradePlan; `status` + `execution_id` are real
//                columns so status changes are atomic conditional UPDATEs
//   trade_audit  append-only record of every trading action (never secrets)
//
// The single most important statement is `claim`: it moves a plan from
// AWAITING_APPROVAL to APPROVED and stamps one execution id, and only one
// caller can ever win it. Everything after that is keyed to that execution.

export const PLAN_STATUSES = ['DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'SUBMITTING', 'SUBMITTED', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED', 'FAILED'];
export const FINAL_STATUSES = new Set(['FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED', 'FAILED']);

export function createTradeStore(sqlite) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS trade_plans (
      id TEXT PRIMARY KEY, event_id TEXT NOT NULL, symbol TEXT NOT NULL, status TEXT NOT NULL,
      execution_id TEXT UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, submitted_at INTEGER, notional REAL, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS trade_plans_event ON trade_plans(event_id, created_at);
    CREATE INDEX IF NOT EXISTS trade_plans_status ON trade_plans(status);
    CREATE TABLE IF NOT EXISTS trade_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL,
      plan_id TEXT, event_id TEXT, execution_id TEXT, symbol TEXT, result TEXT, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS trade_audit_plan ON trade_audit(plan_id, id);
  `);
  const q = {
    insert: sqlite.prepare('INSERT INTO trade_plans (id, event_id, symbol, status, execution_id, created_at, expires_at, updated_at, submitted_at, notional, data) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?)'),
    get: sqlite.prepare('SELECT * FROM trade_plans WHERE id = ?'),
    byEvent: sqlite.prepare('SELECT * FROM trade_plans WHERE event_id = ? ORDER BY created_at DESC'),
    recent: sqlite.prepare('SELECT * FROM trade_plans ORDER BY created_at DESC LIMIT ?'),
    byStatus: sqlite.prepare('SELECT * FROM trade_plans WHERE status = ?'),
    claim: sqlite.prepare("UPDATE trade_plans SET status = 'APPROVED', execution_id = ?, updated_at = ? WHERE id = ? AND status = 'AWAITING_APPROVAL' AND execution_id IS NULL AND expires_at > ?"),
    transition: sqlite.prepare('UPDATE trade_plans SET status = ?, updated_at = ?, data = ? WHERE id = ? AND status = ?'),
    save: sqlite.prepare('UPDATE trade_plans SET data = ?, updated_at = ?, submitted_at = COALESCE(?, submitted_at), notional = COALESCE(?, notional) WHERE id = ?'),
    daily: sqlite.prepare("SELECT COALESCE(SUM(notional), 0) AS n FROM trade_plans WHERE submitted_at >= ? AND status IN ('SUBMITTING','SUBMITTED','PARTIALLY_FILLED','FILLED')"),
    audit: sqlite.prepare('INSERT INTO trade_audit (at, kind, actor, plan_id, event_id, execution_id, symbol, result, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    auditFor: sqlite.prepare('SELECT * FROM trade_audit WHERE plan_id = ? ORDER BY id'),
    auditRecent: sqlite.prepare('SELECT * FROM trade_audit ORDER BY id DESC LIMIT ?'),
  };
  const row = (r) => (r ? { ...JSON.parse(r.data), id: r.id, status: r.status, executionId: r.execution_id, submittedAt: r.submitted_at } : null);
  const auditRow = (r) => ({ id: r.id, at: r.at, kind: r.kind, actor: r.actor, planId: r.plan_id, eventId: r.event_id, executionId: r.execution_id, symbol: r.symbol, result: r.result, ...JSON.parse(r.data) });

  return {
    insert(plan) {
      q.insert.run(plan.id, plan.eventId, plan.symbol, plan.status, plan.createdAt, plan.expiresAt, plan.createdAt, plan.notional ?? null, JSON.stringify(plan));
      return this.get(plan.id);
    },
    get: (id) => row(q.get.get(id)),
    byEvent: (eventId) => q.byEvent.all(eventId).map(row),
    recent: (n = 50) => q.recent.all(n).map(row),
    byStatus: (status) => q.byStatus.all(status).map(row),
    // Atomic: exactly one caller can move AWAITING_APPROVAL → APPROVED.
    claim(id, executionId, now) {
      return q.claim.run(executionId, now, id, now).changes === 1;
    },
    // Atomic conditional transition; `patch` is merged into the stored plan.
    transition(id, from, to, patch = {}, now = Date.now()) {
      const cur = this.get(id);
      if (!cur || cur.status !== from) return false;
      const next = { ...cur, ...patch, status: to, updatedAt: now };
      return q.transition.run(to, now, JSON.stringify(next), id, from).changes === 1;
    },
    // Update non-status fields (order tracking metadata).
    patch(id, patch, { submittedAt = null, notional = null } = {}) {
      const cur = this.get(id);
      if (!cur) return null;
      const next = { ...cur, ...patch, updatedAt: Date.now() };
      q.save.run(JSON.stringify(next), next.updatedAt, submittedAt, notional, id);
      return this.get(id);
    },
    dailyNotional: (sinceTs) => q.daily.get(sinceTs).n,
    audit(kind, { actor = 'system', plan = null, planId = plan?.id ?? null, eventId = plan?.eventId ?? null, executionId = plan?.executionId ?? null, symbol = plan?.symbol ?? null, result = null, ...data } = {}) {
      q.audit.run(Date.now(), kind, actor, planId, eventId, executionId, symbol, result, JSON.stringify(data));
    },
    auditFor: (planId) => q.auditFor.all(planId).map(auditRow),
    auditRecent: (n = 100) => q.auditRecent.all(n).map(auditRow),
  };
}
