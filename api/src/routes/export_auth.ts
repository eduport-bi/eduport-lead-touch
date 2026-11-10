import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { getSql, release, withSql } from '../db';
import { hashPassword, verifyPassword, passwordProblem } from '../password';
import { requireAdmin } from '../auth';

/**
 * Shared CSV export password (sql/031). Admins set it on the Access page; every CSV download must carry it in the
 * `X-Export-Password` header (server-streamed files) or verify it through POST /export/verify first (files built in
 * the browser from data already on screen). Until a password is set, every export is refused.
 *
 *   GET  /export/status          { configured, updated_at, updated_by }        any signed-in user
 *   PUT  /export/password        { password }                                   admin
 *   GET  /export/password        { configured, password | null }                admin: the current password, to hand it to a colleague
 *   POST /export/verify          { password } -> { ok }                         any signed-in user (401 when wrong)
 *   requireExportPassword        middleware for the *.csv routes (index.ts)
 * Successful and failed checks are written to app_auth.audit, so admins can see who exported what.
 */
export const exportRoutes = new Hono<AppEnv>();
exportRoutes.use('/export/*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });

const KEY = 'export_password';
// A readable copy next to the hash, so an admin can look the shared password up instead of resetting it for everybody (user request,
// 2026-11-10). It is a shared gate, not a personal login: admins can already replace it. Checks still run against the hash only.
const KEY_PLAIN = 'export_password_plain';
export const EXPORT_HEADER = 'x-export-password';
const Pw = z.object({ password: z.string().min(1).max(128) });

interface Setting { value: string | null; updated_at: string; updated_by: string | null }

// the hash changes rarely: keep it per isolate for a minute so a download does not add a round-trip on the slow database
let hashMem: { s: Setting | null; at: number } | null = null;
async function loadSetting(c: { env: AppEnv['Bindings']; executionCtx: { waitUntil(p: Promise<unknown>): void } }, fresh = false): Promise<Setting | null> {
  if (!fresh && hashMem && Date.now() - hashMem.at < 60_000) return hashMem.s;
  const rows = await withSql(c.env, c.executionCtx, (sql) => sql<Setting[]>`
    SELECT value, updated_at::text, updated_by FROM app_auth.settings WHERE key = ${KEY} AND updated_at <= now()`);
  hashMem = { s: rows[0] ?? null, at: Date.now() };
  return hashMem.s;
}

async function audit(c: { env: AppEnv['Bindings']; executionCtx: { waitUntil(p: Promise<unknown>): void } }, actor: string, action: string, target: string | null, detail: string | null): Promise<void> {
  await withSql(c.env, c.executionCtx, (sql) => sql`INSERT INTO app_auth.audit (actor, action, target, detail) VALUES (${actor}, ${action}, ${target}, ${detail})`).catch(() => undefined);
}

exportRoutes.get('/export/status', async (c) => {
  const s = await loadSetting(c);
  return c.json({ data: { configured: !!s?.value, updated_at: s?.updated_at ?? null, updated_by: s?.updated_by ?? null } });
});

exportRoutes.put('/export/password', requireAdmin, async (c) => {
  const me = c.get('user');
  const parsed = Pw.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: { code: 'bad_request', message: 'password is required' } }, 400);
  const problem = passwordProblem(parsed.data.password);
  if (problem) return c.json({ error: { code: 'bad_request', message: problem } }, 400);
  const hash = await hashPassword(parsed.data.password);
  const sql = getSql(c.env);
  try {
    await sql`INSERT INTO app_auth.settings (key, value, updated_at, updated_by) VALUES (${KEY}, ${hash}, now(), ${me.email})
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`;
    await sql`INSERT INTO app_auth.settings (key, value, updated_at, updated_by) VALUES (${KEY_PLAIN}, ${parsed.data.password}, now(), ${me.email})
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`;
    await sql`INSERT INTO app_auth.audit (actor, action, target) VALUES (${me.email}, 'set_export_password', 'csv exports')`;
  } finally { release(sql, c.executionCtx); }
  hashMem = null;
  return c.json({ data: { ok: true } });
});

/** The current password, for admins. null when it was set before the readable copy existed (or the copy does not match the hash): set it once more. */
exportRoutes.get('/export/password', requireAdmin, async (c) => {
  const me = c.get('user');
  const rows = await withSql(c.env, c.executionCtx, (sql) => sql<{ key: string; value: string | null }[]>`
    SELECT key, value FROM app_auth.settings WHERE key IN (${KEY}, ${KEY_PLAIN})`);
  const hash = rows.find((r) => r.key === KEY)?.value ?? null;
  const plain = rows.find((r) => r.key === KEY_PLAIN)?.value ?? null;
  if (!hash) return c.json({ data: { configured: false, password: null } });
  const ok = !!plain && (await verifyPassword(plain, hash));
  c.executionCtx.waitUntil(audit(c, me.email, 'view_export_password', 'csv exports', ok ? null : 'not viewable: set before passwords were kept'));
  return c.json({ data: { configured: true, password: ok ? plain : null } });
});

/** Shared check used by the verify endpoint and the middleware. */
async function check(c: { env: AppEnv['Bindings']; executionCtx: { waitUntil(p: Promise<unknown>): void } }, password: string | undefined, actor: string, target: string, detail: string | null): Promise<{ status: 200 | 401 | 403; message: string }> {
  const s = await loadSetting(c);
  if (!s?.value) return { status: 403, message: 'No export password has been set yet: an admin sets it on the Access page' };
  if (!password || !(await verifyPassword(password, s.value))) {
    c.executionCtx.waitUntil(audit(c, actor, 'export_password_failed', target, detail));
    await new Promise((r) => setTimeout(r, 800));   // slow down guessing
    return { status: 401, message: 'Wrong export password' };
  }
  c.executionCtx.waitUntil(audit(c, actor, 'export_csv', target, detail));
  return { status: 200, message: 'ok' };
}

exportRoutes.post('/export/verify', async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { password?: string; file?: string };
  const r = await check(c, b.password, c.get('user').email, (b.file ?? 'browser csv').slice(0, 200), null);
  return r.status === 200 ? c.json({ data: { ok: true } }) : c.json({ error: { code: r.status === 401 ? 'unauthenticated' : 'forbidden', message: r.message } }, r.status);
});

/** For the streamed *.csv routes: the password travels in the X-Export-Password header (never in the URL). */
export const requireExportPassword = createMiddleware<AppEnv>(async (c, next) => {
  const url = new URL(c.req.url);
  const r = await check(c, c.req.header(EXPORT_HEADER), c.get('user').email, url.pathname.replace(/^\/api/, ''), url.search.slice(1, 300) || null);
  if (r.status !== 200) return c.json({ error: { code: r.status === 401 ? 'unauthenticated' : 'forbidden', message: r.message } }, r.status);
  await next();
});
