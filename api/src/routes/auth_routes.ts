import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { getSql, release, withSql } from '../db';
import { hashPassword, verifyPassword, passwordProblem, sha256Hex } from '../password';
import { COOKIE, endSession, forgetAll, forgetSession, requireAdmin, startSession, type Account } from '../auth';
import { accountMail, mailConfigured, mailFrom, mailTransport, sendMail } from '../email';

/**
 * /api/auth/*  - login, logout, own password, first-admin setup
 * /api/auth/users* - admin account management (list / create / update / set password / delete)
 * Every response is no-store. The lead data routes are untouched: they only read c.get('user').
 * NOTE: Hyperdrive caches plain SELECTs for 60 s; every read here that must be fresh mentions now() (never cached).
 */
export const authRoutes = new Hono<AppEnv>();
authRoutes.use('/auth/*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
authRoutes.use('/auth/users', requireAdmin);
authRoutes.use('/auth/users/*', requireAdmin);

const MAX_FAILS = 8; const LOCK_MIN = 15;
const email = z.string().trim().toLowerCase().email().max(200);
const Login = z.object({ email, password: z.string().min(1).max(128) });
const Setup = z.object({ email, name: z.string().trim().max(120).default(''), password: z.string() });
const NewUser = z.object({ email, name: z.string().trim().max(120).default(''), role: z.enum(['admin', 'user', 'bde']), password: z.string(), send_email: z.boolean().default(false) });
const Patch = z.object({ name: z.string().trim().max(120).optional(), role: z.enum(['admin', 'user', 'bde']).optional(), is_active: z.boolean().optional() });
const SetPw = z.object({ password: z.string(), send_email: z.boolean().default(false) });
const ChangePw = z.object({ current: z.string(), password: z.string() });
const SavedFilter = z.object({ query: z.string().max(4000) });

const adminList = (s: string | undefined) => (s ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
const bad = (c: { json: (b: unknown, s: 400) => Response }, message: string) => c.json({ error: { code: 'bad_request', message } }, 400);
const publicUser = (a: Account) => ({ id: a.id, email: a.email, name: a.name, role: a.role });

async function body<T>(c: { req: { json(): Promise<unknown> } }, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw Object.assign(new Error(parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')), { status: 400 });
  return parsed.data;
}

// ---------------------------------------------------------------- session
/** GET /auth/status : { mode, setup_required, user } - public, called on every page load */
authRoutes.get('/auth/status', async (c) => {
  if (c.env.AUTH_MODE === 'none') return c.json({ data: { mode: 'none', setup_required: false, user: { email: 'public', name: 'Public', role: c.env.PUBLIC_ROLE === 'admin' ? 'admin' : 'user' } } });
  const token = getCookie(c, COOKIE);
  const tokenHash = token ? await sha256Hex(token) : null;
  const data = await withSql(c.env, c.executionCtx, async (sql) => {
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM app_auth.users WHERE created_at <= now()`;
    let user: ReturnType<typeof publicUser> | null = null;
    if (n > 0 && tokenHash) {
      const rows = await sql<Account[]>`SELECT u.id::int AS id, u.email, u.name, u.role, u.is_active FROM app_auth.sessions s JOIN app_auth.users u ON u.id = s.user_id
                                          WHERE s.token_hash = ${tokenHash} AND s.expires_at > now() AND u.is_active`;
      if (rows[0]) user = publicUser(rows[0]);
    }
    return { mode: 'password' as const, setup_required: n === 0, user };
  });
  return c.json({ data });
});

/** POST /auth/setup : create the FIRST admin (only while there are no accounts; e-mail must be in ADMIN_EMAILS) */
authRoutes.post('/auth/setup', async (c) => {
  if (c.env.AUTH_MODE === 'none') return bad(c, 'login is not enabled');
  const b = await body(c, Setup);
  const pwErr = passwordProblem(b.password); if (pwErr) return bad(c, pwErr);
  if (!adminList(c.env.ADMIN_EMAILS).includes(b.email)) return c.json({ error: { code: 'forbidden', message: 'This e-mail is not allowed to create the first admin account' } }, 403);
  const sql = getSql(c.env);
  try {
    const created = await sql.begin(async (tx) => {
      await tx`LOCK TABLE app_auth.users IN EXCLUSIVE MODE`;
      const [{ n }] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM app_auth.users`;
      if (n > 0) return null;
      const [u] = await tx<Account[]>`INSERT INTO app_auth.users (email, name, role, password_hash, created_by) VALUES (${b.email}, ${b.name || b.email.split('@')[0]!}, 'admin', ${await hashPassword(b.password)}, 'setup')
                                       RETURNING id::int AS id, email, name, role, is_active`;
      await tx`INSERT INTO app_auth.audit (actor, action, target) VALUES (${b.email}, 'setup_first_admin', ${b.email})`;
      return u!;
    });
    if (!created) return c.json({ error: { code: 'conflict', message: 'Setup is already done: sign in instead' } }, 409);
    await sql`UPDATE app_auth.users SET last_login_at = now() WHERE id = ${created.id}`;
    await startSession(c, sql, created.id);
    return c.json({ data: { user: publicUser(created) } }, 201);
  } finally { release(sql, c.executionCtx); }
});

/** POST /auth/login { email, password } */
authRoutes.post('/auth/login', async (c) => {
  if (c.env.AUTH_MODE === 'none') return bad(c, 'login is not enabled');
  const b = await body(c, Login);
  return withSql(c.env, c.executionCtx, async (sql) => {
    const rows = await sql<(Account & { password_hash: string; failed_attempts: number; locked_until: string | null })[]>`
      SELECT id::int AS id, email, name, role, is_active, password_hash, failed_attempts, locked_until::text FROM app_auth.users WHERE lower(email) = ${b.email} AND created_at <= now()`;
    const u = rows[0];
    if (u && u.locked_until && new Date(u.locked_until).getTime() > Date.now()) {
      const mins = Math.ceil((new Date(u.locked_until).getTime() - Date.now()) / 60_000);
      return c.json({ error: { code: 'locked', message: `Too many failed attempts. Try again in ${mins} min` } }, 429);
    }
    const ok = await verifyPassword(b.password, u?.password_hash);      // also runs (same cost) for unknown e-mails
    if (!u || !ok || !u.is_active) {
      if (u) {
        const fails = u.failed_attempts + 1;
        await sql`UPDATE app_auth.users SET failed_attempts = ${fails}, locked_until = ${fails >= MAX_FAILS ? sql`now() + ${LOCK_MIN + ' minutes'}::interval` : null}, updated_at = now() WHERE id = ${u.id}`;
        if (fails >= MAX_FAILS) await sql`INSERT INTO app_auth.audit (actor, action, target, detail) VALUES (${u.email}, 'locked', ${u.email}, ${`${fails} failed attempts`})`;
      }
      return c.json({ error: { code: 'unauthenticated', message: !u || !ok ? 'Wrong e-mail or password' : 'This account is disabled: ask an admin' } }, 401);
    }
    await sql`UPDATE app_auth.users SET failed_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = ${u.id}`;
    await startSession(c, sql, u.id);
    return c.json({ data: { user: publicUser(u) } });
  });
});

/** POST /auth/logout */
authRoutes.post('/auth/logout', async (c) => {
  const sql = getSql(c.env);
  try { await endSession(c, sql); return c.json({ data: { ok: true } }); } finally { release(sql, c.executionCtx); }
});

/** GET /auth/me */
authRoutes.get('/auth/me', (c) => {
  const u = c.get('user');
  return c.json({ data: { id: u.id ?? null, email: u.email, name: u.name ?? '', role: u.role === 'admin' ? 'admin' : 'user' } });
});

// ---------------------------------------------------------------- saved filter set (one per user; sql/043)
/** GET /auth/filter : { query, saved_at } of the caller's saved filter set, or { query: null } */
authRoutes.get('/auth/filter', async (c) => {
  const me = c.get('user');
  const sql = getSql(c.env);
  try {
    const [r] = await sql<{ query: string; saved_at: string }[]>`SELECT query, saved_at::text FROM app_auth.user_filters WHERE email = ${me.email.toLowerCase()} AND saved_at <= now()`;
    return c.json({ data: { query: r?.query ?? null, saved_at: r?.saved_at ?? null } });
  } finally { release(sql, c.executionCtx); }
});
/** PUT /auth/filter { query } : save the caller's filter set (the filter bar's URL query string) */
authRoutes.put('/auth/filter', async (c) => {
  const me = c.get('user'); const b = await body(c, SavedFilter);
  const sql = getSql(c.env);
  try {
    await sql`INSERT INTO app_auth.user_filters (email, query, saved_at) VALUES (${me.email.toLowerCase()}, ${b.query}, now())
              ON CONFLICT (email) DO UPDATE SET query = EXCLUDED.query, saved_at = now()`;
    return c.json({ data: { ok: true } });
  } finally { release(sql, c.executionCtx); }
});
/** DELETE /auth/filter : forget the caller's saved filter set */
authRoutes.delete('/auth/filter', async (c) => {
  const me = c.get('user');
  const sql = getSql(c.env);
  try {
    await sql`DELETE FROM app_auth.user_filters WHERE email = ${me.email.toLowerCase()}`;
    return c.json({ data: { ok: true } });
  } finally { release(sql, c.executionCtx); }
});

// ---------------------------------------------------------------- named filter views (sql/053, 2026-11-26), like Google Sheets filter views
// Any number per user; a view marked shared is listed for everyone ("Team views") but only its owner can change or delete it.
// The name is unique per owner (case-insensitive). The query is the filter bar's URL query string, as in user_filters.
const ViewNew = z.object({ name: z.string().trim().min(1).max(80), query: z.string().max(4000), shared: z.boolean().default(false) });
const ViewPatch = z.object({ name: z.string().trim().min(1).max(80).optional(), query: z.string().max(4000).optional(), shared: z.boolean().optional() });
type ViewRow = { id: string; name: string; query: string; shared: boolean; owner_email: string; owner_name: string | null; updated_at: string; mine: boolean };
const viewError = (e: unknown) => (e as { code?: string })?.code === '23505'
  ? Object.assign(new Error('You already have a view with that name'), { status: 400 }) : e;

/** GET /auth/views : the caller's views and the team's shared views */
authRoutes.get('/auth/views', async (c) => {
  const me = c.get('user').email.toLowerCase();
  const sql = getSql(c.env);
  try {
    const rows = await sql<ViewRow[]>`
      SELECT v.id::text, v.name, v.query, v.shared, v.email AS owner_email, NULLIF(u.name, '') AS owner_name, v.updated_at::text,
             (v.email = ${me}) AS mine
      FROM app_auth.filter_views v LEFT JOIN app_auth.users u ON lower(u.email) = v.email
      WHERE (v.email = ${me} OR v.shared) AND v.updated_at <= now()
      ORDER BY (v.email = ${me}) DESC, lower(v.name)`;
    return c.json({ data: { views: rows } });
  } finally { release(sql, c.executionCtx); }
});
/** POST /auth/views { name, query, shared } : save the current filters as a new named view */
authRoutes.post('/auth/views', async (c) => {
  const me = c.get('user').email.toLowerCase(); const b = await body(c, ViewNew);
  const sql = getSql(c.env);
  try {
    const [n] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM app_auth.filter_views WHERE email = ${me}`;
    if ((n?.n ?? 0) >= 50) return bad(c, 'At most 50 views per person; delete one first');
    let id: string | undefined;
    try { const [r] = await sql<{ id: string }[]>`INSERT INTO app_auth.filter_views (email, name, query, shared) VALUES (${me}, ${b.name}, ${b.query}, ${b.shared ?? false}) RETURNING id::text`; id = r?.id; }
    catch (e) { throw viewError(e); }
    return c.json({ data: { id } });
  } finally { release(sql, c.executionCtx); }
});
/** PUT /auth/views/:id { name?, query?, shared? } : rename, overwrite with the current filters, share / unshare (owner only) */
authRoutes.put('/auth/views/:id', async (c) => {
  const me = c.get('user').email.toLowerCase(); const b = await body(c, ViewPatch); const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return bad(c, 'bad view id');
  const sql = getSql(c.env);
  try {
    let rows: readonly unknown[];
    try {
      rows = await sql`UPDATE app_auth.filter_views SET name = COALESCE(${b.name ?? null}, name), query = COALESCE(${b.query ?? null}, query),
                         shared = COALESCE(${b.shared ?? null}, shared), updated_at = now()
                       WHERE id = ${id} AND email = ${me} RETURNING id`;
    } catch (e) { throw viewError(e); }
    if (!rows.length) return c.json({ error: { code: 'not_found', message: 'View not found, or it is not yours' } }, 404);
    return c.json({ data: { ok: true } });
  } finally { release(sql, c.executionCtx); }
});
/** DELETE /auth/views/:id : delete one of the caller's views */
authRoutes.delete('/auth/views/:id', async (c) => {
  const me = c.get('user').email.toLowerCase(); const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return bad(c, 'bad view id');
  const sql = getSql(c.env);
  try {
    const rows = await sql`DELETE FROM app_auth.filter_views WHERE id = ${id} AND email = ${me} RETURNING id`;
    if (!rows.length) return c.json({ error: { code: 'not_found', message: 'View not found, or it is not yours' } }, 404);
    return c.json({ data: { ok: true } });
  } finally { release(sql, c.executionCtx); }
});

/** POST /auth/password { current, password } : change own password; other sessions are signed out */
authRoutes.post('/auth/password', async (c) => {
  const me = c.get('user'); if (!me.id) return bad(c, 'not available in this mode');
  const b = await body(c, ChangePw);
  const pwErr = passwordProblem(b.password); if (pwErr) return bad(c, pwErr);
  const sql = getSql(c.env);
  try {
    const [u] = await sql<{ password_hash: string }[]>`SELECT password_hash FROM app_auth.users WHERE id = ${me.id} AND created_at <= now()`;
    if (!u || !(await verifyPassword(b.current, u.password_hash))) return c.json({ error: { code: 'unauthenticated', message: 'Current password is wrong' } }, 401);
    const token = getCookie(c, COOKIE); const keep = token ? await sha256Hex(token) : '';
    await sql`UPDATE app_auth.users SET password_hash = ${await hashPassword(b.password)}, password_set_at = now(), updated_at = now() WHERE id = ${me.id}`;
    await sql`DELETE FROM app_auth.sessions WHERE user_id = ${me.id} AND token_hash <> ${keep}`;
    await sql`INSERT INTO app_auth.audit (actor, action, target) VALUES (${me.email}, 'change_own_password', ${me.email})`;
    forgetAll();
    return c.json({ data: { ok: true } });
  } finally { release(sql, c.executionCtx); }
});

// ---------------------------------------------------------------- admin: accounts (requireAdmin is scoped to /auth/users* above)
const admin = authRoutes;

/** GET /auth/mail/status : can the app e-mail passwords? (SMTP mailbox or Resend, see email.ts) - admin only */
admin.get('/auth/mail/status', requireAdmin, (c) => c.json({ data: { configured: mailConfigured(c.env), from: mailFrom(c.env), transport: mailTransport(c.env) } }));

/** e-mail the account details; never throws - the account change itself has already happened */
async function mailPassword(c: { env: Parameters<typeof sendMail>[0]; req: { url: string } }, o: { to: string; name: string; password: string; kind: 'new' | 'reset'; by: string }): Promise<{ email_sent: boolean; email_error?: string }> {
  const origin = new URL(c.req.url).origin;
  const r = await sendMail(c.env, accountMail({ ...o, origin }));
  return r.ok ? { email_sent: true } : { email_sent: false, email_error: r.error };
}

const USER_COLS = (sql: ReturnType<typeof getSql>) => sql`u.id::int AS id, u.email, u.name, u.role, u.is_active, u.last_login_at::text, u.password_set_at::text, u.created_at::text, u.created_by, u.locked_until::text,
  (SELECT count(*)::int FROM app_auth.sessions s WHERE s.user_id = u.id AND s.expires_at > now()) AS active_sessions`;

admin.get('/auth/users', async (c) => {
  const sql = getSql(c.env);
  try {
    const rows = await sql`SELECT ${USER_COLS(sql)} FROM app_auth.users u ORDER BY u.role, lower(u.email)`;
    const audit = await sql`SELECT at::text, actor, action, target, detail FROM app_auth.audit WHERE at <= now() ORDER BY at DESC LIMIT 50`;
    return c.json({ data: { users: rows, audit } });
  } finally { release(sql, c.executionCtx); }
});

admin.post('/auth/users', async (c) => {
  const me = c.get('user'); const b = await body(c, NewUser);
  const pwErr = passwordProblem(b.password); if (pwErr) return bad(c, pwErr);
  const sql = getSql(c.env);
  try {
    const [dup] = await sql`SELECT 1 FROM app_auth.users WHERE lower(email) = ${b.email} AND created_at <= now()`;
    if (dup) return c.json({ error: { code: 'conflict', message: 'An account with this e-mail already exists' } }, 409);
    const [u] = await sql`INSERT INTO app_auth.users (email, name, role, password_hash, created_by) VALUES (${b.email}, ${b.name || b.email.split('@')[0]!}, ${b.role}, ${await hashPassword(b.password)}, ${me.email}) RETURNING id::int AS id, email, name, role, is_active`;
    const mail = b.send_email ? await mailPassword(c, { to: b.email, name: b.name ?? '', password: b.password, kind: 'new', by: me.name || me.email }) : { email_sent: false };
    await sql`INSERT INTO app_auth.audit (actor, action, target, detail) VALUES (${me.email}, 'create_user', ${b.email}, ${`role=${b.role}${b.send_email ? (mail.email_sent ? ' · password e-mailed' : ` · e-mail failed: ${mail.email_error}`) : ''}`})`;
    return c.json({ data: { user: u, ...mail } }, 201);
  } finally { release(sql, c.executionCtx); }
});

async function guardLastAdmin(sql: ReturnType<typeof getSql>, targetId: number, next: { role?: string; is_active?: boolean }): Promise<string | null> {
  const [t] = await sql<{ role: string; is_active: boolean }[]>`SELECT role, is_active FROM app_auth.users WHERE id = ${targetId} AND created_at <= now()`;
  if (!t) return 'No such account';
  const demoting = (next.role && next.role !== 'admin') || next.is_active === false;
  if (t.role === 'admin' && t.is_active && demoting) {
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM app_auth.users WHERE role = 'admin' AND is_active AND id <> ${targetId} AND created_at <= now()`;
    if (n === 0) return 'This is the last active admin: make someone else an admin first';
  }
  return null;
}

admin.patch('/auth/users/:id', async (c) => {
  const me = c.get('user'); const id = Number(c.req.param('id')); const b = await body(c, Patch);
  if (!Number.isInteger(id)) return bad(c, 'bad id');
  if (id === me.id && (b.role === 'user' || b.is_active === false)) return bad(c, 'You cannot demote or disable your own account');
  const sql = getSql(c.env);
  try {
    const g = await guardLastAdmin(sql, id, b); if (g) return bad(c, g);
    const [u] = await sql`UPDATE app_auth.users SET name = COALESCE(${b.name ?? null}, name), role = COALESCE(${b.role ?? null}, role), is_active = COALESCE(${b.is_active ?? null}, is_active), updated_at = now()
                          WHERE id = ${id} RETURNING id::int AS id, email, name, role, is_active`;
    if (!u) return c.json({ error: { code: 'not_found', message: 'No such account' } }, 404);
    if (b.is_active === false) await sql`DELETE FROM app_auth.sessions WHERE user_id = ${id}`;
    await sql`INSERT INTO app_auth.audit (actor, action, target, detail) VALUES (${me.email}, 'update_user', ${u.email as string}, ${JSON.stringify(b)})`;
    forgetAll();
    return c.json({ data: { user: u } });
  } finally { release(sql, c.executionCtx); }
});

/** POST /auth/users/:id/password { password } : admin sets a new password; the user's sessions are signed out */
admin.post('/auth/users/:id/password', async (c) => {
  const me = c.get('user'); const id = Number(c.req.param('id')); const b = await body(c, SetPw);
  const pwErr = passwordProblem(b.password); if (pwErr) return bad(c, pwErr);
  const sql = getSql(c.env);
  try {
    const [u] = await sql`UPDATE app_auth.users SET password_hash = ${await hashPassword(b.password)}, password_set_at = now(), failed_attempts = 0, locked_until = NULL, updated_at = now() WHERE id = ${id} RETURNING email, name`;
    if (!u) return c.json({ error: { code: 'not_found', message: 'No such account' } }, 404);
    const token = getCookie(c, COOKIE); const keep = id === me.id && token ? await sha256Hex(token) : '';
    await sql`DELETE FROM app_auth.sessions WHERE user_id = ${id} AND token_hash <> ${keep}`;
    await sql`INSERT INTO app_auth.audit (actor, action, target) VALUES (${me.email}, 'set_password', ${u.email as string})`;
    forgetAll();
    const mail = b.send_email ? await mailPassword(c, { to: u.email as string, name: (u.name as string) ?? '', password: b.password, kind: 'reset', by: me.name || me.email }) : { email_sent: false };
    return c.json({ data: { ok: true, ...mail } });
  } finally { release(sql, c.executionCtx); }
});

admin.delete('/auth/users/:id', async (c) => {
  const me = c.get('user'); const id = Number(c.req.param('id'));
  if (id === me.id) return bad(c, 'You cannot delete your own account');
  const sql = getSql(c.env);
  try {
    const g = await guardLastAdmin(sql, id, { is_active: false }); if (g) return bad(c, g);
    const [u] = await sql`DELETE FROM app_auth.users WHERE id = ${id} RETURNING email`;
    if (!u) return c.json({ error: { code: 'not_found', message: 'No such account' } }, 404);
    await sql`INSERT INTO app_auth.audit (actor, action, target) VALUES (${me.email}, 'delete_user', ${u.email as string})`;
    forgetAll();
    return c.json({ data: { ok: true } });
  } finally { release(sql, c.executionCtx); }
});

export { forgetSession };
