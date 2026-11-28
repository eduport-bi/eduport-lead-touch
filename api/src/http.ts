import type { Context } from 'hono';
import type { Sql } from 'postgres';
import type { AppEnv, Role } from './env';
import { getSql, release, withSql } from './db';
import { parseFilters, resolvePeriods, type Filters, type Periods } from './filters';
import { cacheGet, cacheKey, cachePut, dataVersion, KV_TTL_VERSIONED, packAnswer, unpackAnswer, wantsFresh } from './cache';

export interface Ctx { sql: Sql; f: Filters; periods: Periods; q: Record<string, string>; role: Role; }

/**
 * Edge cache policy for a handler:
 *   'version'        keyed on the data version (default): valid until the next sync refresh
 *   { ttl, perUser }  keyed on time instead (for answers that depend on more than the data, e.g. /meta)
 *   false             never cached
 */
// wrangler dev: a token minted once per isolate, so a code reload never reads answers of the previous code and never touches production entries
let devBuild: string | null = null;
const devBuildId = () => (devBuild ??= `dev-${crypto.randomUUID().slice(0, 8)}`);

export type EdgePolicy = 'version' | false | { ttl: number; perUser?: boolean };

/** Parse filters, open a DB client, run `fn`, JSON-envelope the result. Successful GET answers are cached (see cache.ts). */
export async function handle<T>(c: Context<AppEnv>, fn: (x: Ctx) => Promise<T>, cache = 60, edge: EdgePolicy = 'version'): Promise<Response> {
  const q = c.req.query();
  const f = parseFilters(q);
  const periods = resolvePeriods(f);
  const user = c.get('user');
  const headers: Record<string, string> = { 'Cache-Control': `private, max-age=${cache}` };

  let key: string | null = null; let ttl = KV_TTL_VERSIONED;
  // 'version' answers (2026-11-25): ONE entry per view, holding the last answer and the data version it was computed for. Same version =
  // a hit. Older version (a sync ran since) = the old answer is returned at once as "stale" (X-LT-Cache: stale); the page shows it and asks
  // again with revalidate=1, which computes the fresh answer (single flight). The cron warm-up asks with revalidate=1 too.
  let version: string | null = null;
  const revalidate = q.revalidate === '1';
  // `wrangler dev --remote` inherits the deployed Worker's BUILD_ID, so dev and production would share cache entries (dev would read
  // answers of the live code and write answers of unreleased code). The launch config passes --var CACHE_SCOPE:dev; localhost hosts count too.
  const isDev = c.env.CACHE_SCOPE === 'dev' || /^(localhost|127.0.0.1|[::1])$/.test(new URL(c.req.url).hostname);
  const build = isDev ? devBuildId() : (c.env.BUILD_ID ?? 'nobuild');
  if (edge && c.req.method === 'GET') {
    const mask = user.role === 'viewer' || user.role === 'bde' ? 'masked' : 'full';   // masked roles never read an answer computed for a full one (and vice versa)
    if (edge === 'version') {
      version = await dataVersion(c.env, c.executionCtx);
      // local testing only: x-lt-test-version pretends a newer data version, to see the stale path without touching the live database
      if (isDev && c.req.header('x-lt-test-version')) version = `${version}|${c.req.header('x-lt-test-version')}`;
      key = await cacheKey({ version: 'latest', build, mask, path: c.req.path, query: q });
    }
    else { ttl = edge.ttl; key = await cacheKey({ version: `ttl${edge.ttl}`, build, mask, path: c.req.path, query: q, user: edge.perUser ? String(user.id ?? user.email) : undefined }); }
  }

  const json = (body: string, tag: string) => new Response(body, { status: 200, headers: { ...headers, 'Content-Type': 'application/json; charset=UTF-8', 'X-LT-Cache': tag, 'Access-Control-Expose-Headers': 'X-LT-Cache' } });
  // what a stored value means for this request: a hit (same version, or a ttl entry), a stale answer, or nothing usable
  const readStored = (raw: string): { body: string; fresh: boolean } => {
    if (version === null) return { body: raw, fresh: true };
    const u = unpackAnswer(raw);
    return { body: u.body, fresh: u.version === version };
  };
  // the old answer first: no waiting behind the computation of the new one (unless this request is the one that asked for it)
  if (key && version !== null && !revalidate && !wantsFresh(c.req.raw, q)) {
    const hit = await cacheGet(c.env, key);
    if (hit) { const s = readStored(hit.body); if (s.fresh) return json(s.body, `hit-${hit.layer}`); return json(s.body, 'stale'); }
  }
  // single flight: a second identical request while the first is still computing (the warm-up and the first visitor, two users on the
  // same view) waits for that answer instead of running the same fan-out again on the two-core database. The entry is registered
  // synchronously as soon as the key is known - the cache lookup runs inside the shared work - because with the lookup before the
  // check-and-set, two requests arriving together both missed the map and both computed (no join was ever logged before 2026-10-31).
  // The computing request is kept alive with waitUntil: when its browser gives up (a reload while the page is loading), the runtime
  // would otherwise cancel that invocation together with its database sockets and timers, the shared promise would never settle, and
  // every request that joined it would hang until the browser's own 3-minute limit (seen 2026-10-31: 180 s "canceled" Converted
  // requests, no 504, while the same view took 12 s elsewhere). A joiner also stops waiting after JOIN_TIMEOUT_MS and computes itself.
  const running = key ? inflight.get(key) : undefined;
  if (running && key) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const joined = await Promise.race([running.then((r) => r), new Promise<null>((res) => { timer = setTimeout(() => res(null), JOIN_TIMEOUT_MS); })]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
    if (joined) return json(joined.body, 'hit-inflight');
    if (inflight.get(key) === running) inflight.delete(key);   // the leader is gone: compute the answer here
  }
  const work = (async (): Promise<Answer> => {
    if (key && !wantsFresh(c.req.raw, q)) {
      const hit = await cacheGet(c.env, key);
      if (hit) { const s = readStored(hit.body); if (s.fresh) return { body: s.body, tag: `hit-${hit.layer}` }; }   // only a same-version answer ends a revalidation
    }
    const t0 = Date.now();
    const data = await withSql(c.env, c.executionCtx, (sql) => fn({ sql, f, periods, q, role: user.role }));
    const body = JSON.stringify({ data, meta: { period: periods.current, previous: periods.previous, basis: f.basis, tookMs: Date.now() - t0, cachedAt: key ? new Date().toISOString() : undefined, build: key ? build : undefined } });
    if (key) cachePut(c.env, c.executionCtx, key, version !== null ? packAnswer(version, body) : body, ttl);
    return { body, tag: key ? 'miss' : 'bypass' };
  })();
  if (key) { inflight.set(key, work); const done = work.catch(() => undefined).finally(() => { if (inflight.get(key) === work) inflight.delete(key); }); c.executionCtx.waitUntil(done); }
  const r = await work;
  return json(r.body, r.tag);
}
type Answer = { body: string; tag: string };
const inflight = new Map<string, Promise<Answer>>();
/** How long a request waits for another request's in-flight answer before computing its own. */
export const JOIN_TIMEOUT_MS = 60_000;

/** How many statements of a fan-out run at the same time. The Overview fires two dozen; all at once on the two-core database they
 *  only slow each other down (every statement 3-4x its solo time, temp files, parallel workers fighting for the same cores). */
export const FANOUT_LIMIT = 6;
/** A statement that has not answered after this long is given up: a dead pooled connection (Hyperdrive right after a deploy) otherwise
 *  hangs the whole fan-out - and, through the single-flight map, every later request for the same view - with no error at all
 *  (seen 2026-10-31: an Overview request ran 211 s until the browser cancelled it while the same view took 11 s elsewhere). */
export const STATEMENT_TIMEOUT_MS = 100_000;
/** Statements known to be heavy start first (longest-first keeps the tail short); the rest follow in call order. */
const HEAVY = ['fees', 'conv_ay', 'leads_union', 'ic_course', 'tat', 'stage_react', 'revised_new', 'call_reason', 'new_leads', 'ic_status', 'daily'];

/**
 * Promise.all for a page's query fan-out that records how long each query took, running at most FANOUT_LIMIT statements at a time
 * (postgres.js queries are lazy: nothing is sent until the query is awaited). Slow ones (> 2 s) are logged ("slow queries" in the
 * Worker logs); when one fails, every duration is attached to the error as queryTimes so the 500 response names the statement that
 * hit the timeout instead of just "internal error".
 */
export async function timedAll<T extends readonly unknown[] | []>(names: readonly string[], qs: T, limit = FANOUT_LIMIT): Promise<{ -readonly [P in keyof T]: Awaited<T[P]> }> {
  const seq = (globalThis as { __seqTiming?: boolean }).__seqTiming === true; if (seq) limit = 1;
  const t0 = Date.now(); const times: Record<string, number> = {}; const own: Record<string, number> = {};
  const rank = (i: number) => { const k = HEAVY.indexOf(names[i] ?? ''); return k < 0 ? HEAVY.length : k; };
  const order = (qs as readonly unknown[]).map((_, i) => i).sort((a, b) => rank(a) - rank(b));
  const settled: PromiseSettledResult<unknown>[] = new Array(qs.length);
  let next = 0;
  const worker = async () => {
    while (next < order.length) {
      const i = order[next++]!; const s0 = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error(`The statement "${names[i] ?? i}" did not answer within ${STATEMENT_TIMEOUT_MS / 1000} s; please retry`), { status: 504 })), STATEMENT_TIMEOUT_MS); });
      try { settled[i] = { status: 'fulfilled', value: await Promise.race([(qs as readonly unknown[])[i], deadline]) }; }
      catch (e) { settled[i] = { status: 'rejected', reason: e }; }
      finally { if (timer !== undefined) clearTimeout(timer); times[names[i] ?? String(i)] = Date.now() - t0; own[names[i] ?? String(i)] = Date.now() - s0; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, order.length)) }, worker));
  if (seq) { const g = globalThis as { __seqLog?: unknown[] }; (g.__seqLog ??= []).push({ total: Date.now() - t0, ...Object.fromEntries(Object.entries(own).sort((x, y) => y[1] - x[1])) }); }
  // one line per fan-out whenever it was slow (any statement over 2 s): every duration, slowest first, so the Worker log shows where the time went
  if (Object.values(times).some((ms) => ms > 2000)) console.log('slow queries', JSON.stringify(Object.fromEntries(Object.entries(times).sort((x, y) => y[1] - x[1]))));
  const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed) { const e = failed.reason as { queryTimes?: Record<string, number> }; if (e && typeof e === 'object') e.queryTimes = times; throw failed.reason; }
  return settled.map((r) => (r as PromiseFulfilledResult<unknown>).value) as unknown as { -readonly [P in keyof T]: Awaited<T[P]> };
}

/** Sort a lead / payer list by ANY of its columns (user, 2026-11-27). The list queries sort and page first and fill the extra columns
 *  (calls, payments, touch points ...) for the page only; a sort on one of those extra columns builds the whole list, then sorts and
 *  pages it here. `cols` is the whitelist of column names (only these reach ORDER BY); `fast` = the keys the list query sorts itself. */
export function sortAnyColumn<Q extends Record<string, string>>(
  sql: import('postgres').Sql, q: Q, cols: readonly string[], fast: Record<string, string>, idCol: string,
  run: (q: Q, page: { limit: number; offset: number } | null) => import('postgres').PendingQuery<import('postgres').Row[]>,
  page: { limit: number; offset: number },
) {
  const key = q.sort ?? '';
  if (!key || fast[key] || !cols.includes(key)) return run(q, page);
  // blanks go last in both directions, so the first page always shows values (2026-11-27)
  const dir = q.dir === 'asc' ? sql`ASC NULLS LAST` : sql`DESC NULLS LAST`;
  return sql`SELECT * FROM (${run({ ...q, sort: '' }, null)}) z ORDER BY z.${sql(key)} ${dir}, z.${sql(idCol)} LIMIT ${page.limit} OFFSET ${page.offset}`;
}

export function intParam(q: Record<string, string>, key: string, def: number, min: number, max: number): number {
  const n = Number.parseInt(q[key] ?? '', 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}

export function pct(num: number | null | undefined, den: number | null | undefined): number | null {
  if (!den) return null;
  return Math.round(((num ?? 0) / den) * 10000) / 100;
}

// ---------------------------------------------------------------- PII masking
/** BDE accounts never download anything: every *.csv route and the export password check refuse them (index.ts), the UI hides the buttons */
export const canDownload = (role: Role): boolean => role !== 'bde';

export function maskPhone(v: string | null | undefined, role: Role): string | null {
  if (v == null) return null;
  if (role !== 'viewer' && role !== 'bde') return v;   // bde: phone numbers masked everywhere, names and e-mails stay
  const d = v.replace(/\D/g, '');
  return d.length >= 4 ? `${'•'.repeat(Math.max(0, d.length - 4))}${d.slice(-4)}` : '••••';
}
export function maskEmail(v: string | null | undefined, role: Role): string | null {
  if (v == null) return null;
  if (role !== 'viewer') return v;
  const [u, dom] = v.split('@');
  return dom ? `${(u ?? '').slice(0, 1)}•••@${dom}` : '•••';
}
export function maskName(v: string | null | undefined, role: Role): string | null {
  if (v == null) return null;
  if (role !== 'viewer') return v;
  return v.split(/\s+/).map((p) => (p.length ? `${p[0]}${'•'.repeat(Math.min(6, Math.max(1, p.length - 1)))}` : p)).join(' ');
}

// ---------------------------------------------------------------- CSV export, streamed in pages
/**
 * Streams a CSV while fetching the rows in pages of `pageSize` through `fetchPage(sql, limit, offset)`. One statement per
 * page keeps every query far below the 90 s statement timeout of the pooled connection (one statement for the whole
 * export timed out on the throttled database and produced an empty file). The header row is sent first, so the
 * browser sees the download start immediately. Rows beyond `cap` are dropped and noted in a trailing comment line.
 */
export function csvStream<R extends Record<string, unknown>>(c: Context<AppEnv>, o: {
  cols: readonly string[]; cap: number; filename: string; mask: (r: R) => Record<string, unknown>;
  fetchPage: (sql: Sql, limit: number, offset: number) => Promise<R[]>; pageSize?: number;
}): Response {
  const sql = getSql(c.env);
  const enc = new TextEncoder();
  const size = Math.max(50, o.pageSize ?? 500);
  const esc = (v: unknown) => { if (v == null) return ''; const s = v instanceof Date ? v.toISOString() : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(enc.encode(o.cols.join(',') + '\n'));
        let n = 0; let offset = 0;
        while (n < o.cap) {
          const limit = Math.min(size, o.cap - n);
          const rows = await o.fetchPage(sql, limit, offset);
          let chunk = '';
          for (const r of rows) { const m = o.mask(r); chunk += o.cols.map((k) => esc(m[k])).join(',') + '\n'; }
          if (chunk) controller.enqueue(enc.encode(chunk));
          n += rows.length; offset += rows.length;
          if (rows.length < limit) break;
        }
        if (n >= o.cap) controller.enqueue(enc.encode(`# truncated at ${o.cap} rows\n`));
        controller.close();
      } catch (e) { controller.error(e); } finally { release(sql, c.executionCtx); }
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${o.filename}"`, 'cache-control': 'private, no-store' } });
}
