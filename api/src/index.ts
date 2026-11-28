import { Hono } from 'hono';
import { ZodError } from 'zod';
import type { AppEnv, Env } from './env';
import { authMiddleware, INTERNAL_HEADER, INTERNAL_ROLE_HEADER, INTERNAL_TOKEN } from './auth';
import { forgetVersion, memStats } from './cache';
import { getSql, withSql } from './db';
import { presetRange, savedQueryToApi } from './saved_filter';
import { meta } from './routes/meta';
import { filters } from './routes/filters';
import { leads } from './routes/leads';
import { syncRoute, dailySync, dailySyncDue } from './routes/sync';
import { overview } from './routes/overview';
import { overviewLeads } from './routes/overview_leads';
import { newLeads } from './routes/new_leads';
import { touchAttribution } from './routes/touch_attribution';
import { converted } from './routes/converted';
import { analysis } from './routes/analysis';
import { authRoutes } from './routes/auth_routes';
import { exportRoutes, requireExportPassword } from './routes/export_auth';

const app = new Hono<AppEnv>();

app.get('/api/health', (c) => c.json({ ok: true, version: c.env.APP_VERSION ?? 'dev' }));

app.use('/api/*', async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'same-origin');
  // diagnosis only (preview with --var SEQ_TIMING:1): run each fan-out one statement at a time and log every statement's own duration
  const g = globalThis as { __seqTiming?: boolean; __seqLog?: unknown[] };
  g.__seqTiming = (c.env as { SEQ_TIMING?: string }).SEQ_TIMING === '1';
  if (g.__seqTiming) g.__seqLog = [];
  await next();
  if (g.__seqTiming && g.__seqLog?.length) c.header('X-Seq-Timing', JSON.stringify(g.__seqLog));
});
app.use('/api/*', authMiddleware);

const api = new Hono<AppEnv>();
// BDE accounts: no Lead explorer list, no CSV, no export password check (phone numbers are masked by maskPhone for them)
api.use('*', async (c, next) => {
  if (c.get('user')?.role === 'bde') {   // public routes (login, status) carry no user
    const path = new URL(c.req.url).pathname;
    if (/\.csv$/.test(path) || path === '/api/leads' || path.startsWith('/api/export/')) return c.json({ error: { code: 'forbidden', message: 'Not available for BDE accounts' } }, 403);
  }
  await next();
});
// every streamed CSV asks for the shared export password (routes/export_auth.ts)
for (const csv of ['/leads/export.csv', '/converted/users.csv', '/overview/new_leads.csv', '/overview/leads.csv']) api.use(csv, requireExportPassword);
for (const r of [authRoutes, exportRoutes, meta, filters, leads, syncRoute, overview, overviewLeads, newLeads, touchAttribution, converted, analysis]) api.route('/', r);

// Admin-only manual refresh (the Cron Trigger calls the same function)
api.post('/admin/refresh', async (c) => {
  if (c.get('user').role !== 'admin') return c.json({ error: { code: 'forbidden', message: 'admin only' } }, 403);
  const out = await refreshViews(c.env);
  forgetVersion();
  return c.json({ data: out });
});

// Admin: cache warm-up on demand (the cron does the same every 10 minutes; the deploy script and the sync job call it with X-Warm-Secret) + a peek at the memory layer
api.post('/admin/warm', async (c) => {
  if (c.get('user').role !== 'admin') return c.json({ error: { code: 'forbidden', message: 'admin only' } }, 403);
  const out = await warmCache(c.env, c.executionCtx);
  return c.json({ data: { warmed: out, memory: memStats() } });
});

app.route('/api', api);

app.notFound((c) => (c.req.path.startsWith('/api/') ? c.json({ error: { code: 'not_found', message: 'no such endpoint' } }, 404) : c.env.ASSETS.fetch(c.req.raw)));

app.onError((err, c) => {
  if (err instanceof ZodError) {
    return c.json({ error: { code: 'bad_request', message: 'invalid filters', issues: err.issues } }, 400);
  }
  if (err instanceof Error && err.message.startsWith('No database configured')) {
    return c.json({ error: { code: 'not_configured', message: 'Database not connected yet: run `npx wrangler secret put DATABASE_URL` in the api folder.' } }, 503);
  }
  const status = (err as { status?: number }).status;
  if (status && status >= 400 && status < 500) return c.json({ error: { code: 'bad_request', message: err.message } }, status as 400);
  console.error('unhandled', err);
  const queryTimes = (err as { queryTimes?: Record<string, number> }).queryTimes;
  return c.json({ error: { code: 'internal', message: 'internal error', detail: err instanceof Error ? err.message : String(err), queryTimes } }, 500);
});

async function refreshViews(env: Env) {
  const sql = getSql(env);
  try {
    // lt_app_ro has default_transaction_read_only=on and a 20s statement_timeout;
    // both are session-settable, so override them for this transaction only.
    return await sql.begin(async (tx) => {
      await tx`SET TRANSACTION READ WRITE`;
      await tx`SET LOCAL statement_timeout = '25min'`;
      return tx<{ view_name: string; row_count: number; seconds: number }[]>`SELECT * FROM analytics.refresh_all()`;
    });
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------- cache warm-up
// The default view of every page (last 30 days IST, both bases, the quick-picker lists) is requested through the
// Worker itself so the answers sit in the cache before the first visitor arrives. Sequential on purpose: the
// database is the bottleneck, and when the data version has not changed every request is a cache hit anyway.
const ymd = (d: Date) => d.toISOString().slice(0, 10);
export function warmUrls(): string[] {
  const nowIst = new Date(Date.now() + 5.5 * 3600 * 1000);
  // the default Last 30 days view: the 30 days before today (2026-11-27: today is left out, as in Metabase)
  const to = ymd(new Date(nowIst.getTime() - 86400 * 1000)); const from = ymd(new Date(nowIst.getTime() - 30 * 86400 * 1000));
  const base = (basis: 'created' | 'touch') => `from=${from}&to=${to}&basis=${basis}&compare=none`;
  const urls = [
    // Overview is asked for in two halves (part=top / part=rest, 2026-11-26); the top half takes yet_days, the rest half no day count
    `/api/overview?${base('created')}&part=top&yet_days=5`, `/api/overview?${base('created')}&part=rest`,
    `/api/converted?${base('created')}&pm=all`,
    ...['class_group', 'touch_point', 'source', 'campaign', 'medium'].map((dim) => `/api/filters?${base('created')}&dim=${dim}&limit=5000`),
    `/api/overview?${base('touch')}&part=top&yet_days=5`, `/api/overview?${base('touch')}&part=rest`,
    `/api/converted?${base('touch')}&pm=all`,
  ];
  // the other short presets (2026-11-28): an uncached view costs 5-12 s on the Micro database, and answers stay cached until the next
  // sync, so the first visitor of the day no longer pays for Yesterday / Last 7 / Last 90 days / This month / Last month. Last 30 days
  // (above) first. This financial year is left out: one view costs tens of seconds.
  const today = ymd(nowIst);
  for (const preset of ['7d', 'yesterday', 'mtd', 'lastm', '90d']) {
    const [pf, pt] = presetRange(preset, today);
    for (const basis of ['created', 'touch'] as const) {
      const b = `from=${pf}&to=${pt}&basis=${basis}&compare=none`;
      urls.push(`/api/overview?${b}&part=top&yet_days=5`, `/api/overview?${b}&part=rest`, `/api/converted?${b}&pm=all`);
    }
  }
  return urls;
}

type FetchCtx = Parameters<typeof app.fetch>[2];
type WarmRole = 'analyst' | 'bde';
/** The default views plus, for every named filter view (app_auth.filter_views), the Overview and Converted
 *  views that user lands on - so the first visit after a sync or a deploy is warm for them as well. A set saved by a bde account is warmed
 *  as that role (masked answers are cached apart from full ones). */
export async function warmTargets(env: Env, ctx: FetchCtx): Promise<{ url: string; role: WarmRole }[]> {
  const out: { url: string; role: WarmRole }[] = warmUrls().map((url) => ({ url, role: 'analyst' }));
  try {
    const rows: { query: string; role: string | null }[] = await withSql(env, ctx ?? { waitUntil: () => undefined }, (sql) => sql<{ query: string; role: string | null }[]>`
      -- named filter views (sql/053): warmed as the owner's role; a shared view also as a full-access role, for the team. The single saved
      -- "Default" filter sets (app_auth.user_filters) are no longer applied by the page (2026-11-26), so they are not warmed
      SELECT v.query, u.role FROM app_auth.filter_views v LEFT JOIN app_auth.users u ON lower(u.email) = v.email AND u.is_active WHERE v.updated_at <= now()
      UNION
      SELECT v.query, 'analyst' FROM app_auth.filter_views v WHERE v.shared AND v.updated_at <= now()`);   // now(): Hyperdrive would otherwise serve a 60 s old answer
    for (const r of rows) {
      const p = savedQueryToApi(r.query);
      if (!p) continue;
      const role: WarmRole = r.role === 'bde' ? 'bde' : 'analyst';
      const q = (extra: Record<string, string>) => new URLSearchParams({ ...p, ...extra }).toString();
      out.push({ url: `/api/overview?${q({ part: 'top', yet_days: '5' })}`, role }, { url: `/api/overview?${q({ part: 'rest' })}`, role }, { url: `/api/converted?${q({ pm: 'all' })}`, role });
    }
  } catch (e) {
    console.error('warm: saved filter sets not read', e instanceof Error ? e.message : e);
  }
  const seen = new Set<string>();
  return out.filter((t) => { const k = `${t.role} ${t.url}`; if (seen.has(k)) return false; seen.add(k); return true; });
}
export async function warmCache(env: Env, ctx: FetchCtx): Promise<{ url: string; status: number; cache: string; ms: number }[]> {
  const out: { url: string; status: number; cache: string; ms: number }[] = [];
  for (const { url, role } of await warmTargets(env, ctx)) {
    const t0 = Date.now();
    try {
      // revalidate=1: compute when the stored answer is from an older data version (a plain request would just get that stale answer)
      const res = await app.fetch(new Request(`https://warm.internal${url}${url.includes('?') ? '&' : '?'}revalidate=1`, { headers: { [INTERNAL_HEADER]: INTERNAL_TOKEN(), [INTERNAL_ROLE_HEADER]: role, accept: 'application/json' } }), env, ctx);
      await res.arrayBuffer();   // drain so the body is not kept open
      out.push({ url, status: res.status, cache: res.headers.get('X-LT-Cache') ?? '-', ms: Date.now() - t0 });
    } catch (e) {
      out.push({ url, status: 0, cache: e instanceof Error ? e.message.slice(0, 120) : String(e), ms: Date.now() - t0 });
    }
  }
  return out;
}

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    // the daily sync at 06:00 IST (GitHub's own schedule runs hours late)
    if (dailySyncDue(controller.scheduledTime)) {
      ctx.waitUntil(dailySync(env, controller.scheduledTime).then((m) => console.log('daily sync:', m)).catch((e) => console.error('daily sync failed', e)));
    }
    ctx.waitUntil(
      warmCache(env, ctx)
        .then((rows) => console.log('warm', JSON.stringify(rows)))
        .catch((e) => console.error('warm failed', e)),
    );
  },
} satisfies ExportedHandler<Env>;
