// Operator authentication for the trade approval routes.
//
// PRED had no user accounts, so approval is protected by a single operator
// secret, PRED_ADMIN_TOKEN (24+ characters, set on the server only):
//   POST /api/auth/login  {token}  → HttpOnly, SameSite=Strict session cookie
//   every state-changing trade route requires that session AND the session's
//   CSRF token in the X-PRED-CSRF header AND a same-origin Origin header.
// The token is compared in constant time, login attempts are rate-limited,
// and neither the token nor session ids are ever logged or returned.

import crypto from 'node:crypto';
import { humanApproval } from './execution.js';

const COOKIE = 'pred_session';
const SESSION_TTL_MS = 8 * 3600_000;
const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();

export function createOperatorAuth({ token = process.env.PRED_ADMIN_TOKEN || '', now = () => Date.now() } = {}) {
  const configured = typeof token === 'string' && token.length >= 24;
  const secretDigest = configured ? digest(token) : null;
  const sessions = new Map(); // id → { csrf, expiresAt }
  const attempts = new Map(); // ip → [timestamps]

  // The proxy appends the real client address last; earlier entries can be forged.
  const clientIp = (req) => String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean).at(-1) || req.socket?.remoteAddress || 'unknown';
  let globalFails = [];
  function cookieSession(req) {
    const m = /(?:^|;\s*)pred_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '');
    if (!m) return null;
    const s = sessions.get(m[1]);
    if (!s) return null;
    if (now() > s.expiresAt) {
      sessions.delete(m[1]);
      return null;
    }
    return { id: m[1], ...s };
  }
  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return false; // browsers send Origin on POST; refuse when absent
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }
  const secureCookie = (req) => (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

  return {
    configured,
    login(req, suppliedToken) {
      if (!configured) return { ok: false, code: 503, error: 'Approval login is not configured on this server (PRED_ADMIN_TOKEN)' };
      const ip = clientIp(req);
      const recent = (attempts.get(ip) || []).filter((t) => now() - t < 15 * 60_000);
      globalFails = globalFails.filter((t) => now() - t < 15 * 60_000);
      if (recent.length >= 5 || globalFails.length >= 50) return { ok: false, code: 429, error: 'Too many login attempts; try again in 15 minutes' };
      recent.push(now());
      attempts.set(ip, recent);
      if (!sameOrigin(req)) return { ok: false, code: 403, error: 'cross-origin login refused' };
      const ok = typeof suppliedToken === 'string' && suppliedToken.length > 0 && crypto.timingSafeEqual(digest(suppliedToken), secretDigest);
      if (!ok) {
        globalFails.push(now());
        return { ok: false, code: 401, error: 'invalid operator token' };
      }
      attempts.delete(ip);
      const id = crypto.randomBytes(32).toString('hex');
      const csrf = crypto.randomBytes(32).toString('hex');
      sessions.set(id, { csrf, expiresAt: now() + SESSION_TTL_MS, ip });
      const cookie = `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secureCookie(req) ? '; Secure' : ''}`;
      return { ok: true, cookie, csrfToken: csrf, expiresAt: now() + SESSION_TTL_MS };
    },
    logout(req) {
      const s = cookieSession(req);
      if (s) sessions.delete(s.id);
      return `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
    },
    session(req) {
      const s = cookieSession(req);
      return s ? { authenticated: true, csrfToken: s.csrf, expiresAt: s.expiresAt } : { authenticated: false, loginAvailable: configured };
    },
    // Gate for every state-changing trade route. Returns { ok, approval } or { ok:false, code, error }.
    requireHuman(req) {
      if (req.method !== 'POST') return { ok: false, code: 405, error: 'POST required' };
      const s = cookieSession(req);
      if (!s) return { ok: false, code: 401, error: 'operator login required' };
      if (!sameOrigin(req)) return { ok: false, code: 403, error: 'cross-origin request refused' };
      const header = String(req.headers['x-pred-csrf'] || '');
      if (header.length !== s.csrf.length || !crypto.timingSafeEqual(Buffer.from(header), Buffer.from(s.csrf))) return { ok: false, code: 403, error: 'missing or invalid CSRF token' };
      return { ok: true, approval: humanApproval({ sessionId: s.id, ip: clientIp(req) }) };
    },
  };
}
