/**
 * Replication into the analytics Postgres (Supabase):
 *   1. Salesforce objects  -> salesforce.*   (REST queryAll, SystemModstamp watermarks)
 *   2. Production app DB   -> app.*          (home_customuser, home_payment; id / updated watermarks)
 *   3. analytics.refresh_all()               (materialized views)
 *
 * Usage:
 *   npm run sync            # incremental
 *   npm run sync:full       # ignore watermarks, reload everything
 *   npm run refresh         # only refresh the analytics materialized views
 *
 * Env (see .env.example):
 *   SF_LOGIN_URL, SF_CLIENT_ID, SF_CLIENT_SECRET   Salesforce connected app (client-credentials flow)
 *   SF_USERNAME, SF_PASSWORD, SF_SECURITY_TOKEN   optional fallback: username-password flow
 *   DATABASE_URL            target  = Supabase, role lt_analytics_owner
 *   SOURCE_DATABASE_URL     source  = Eduport production Postgres (read-only user is enough)
 *   LEAD_SINCE              initial Lead_Master__c / Interested_Course__c lower bound (default 2025-04-01)
 *   TASK_SINCE              initial Task lower bound (default 2026-01-01)
 *   SYNC_OBJECTS            optional comma list to restrict (e.g. Lead_Touch__c,home_payment,ujra_payment)
 *   UJRA_DATABASE_URL       second payment source: the Ujra Postgres (residential Integrated programmes); read-only user is enough.
 *                           When unset but METABASE_URL + METABASE_API_KEY are set, the tables are read through three saved Metabase questions
 *                           (collection "Ujra", ids 6973-6975; the key only needs to view that collection). Otherwise the CSV snapshot in
 *                           sync/seed/ujra/ is loaded if present - a local one-time copy; the repository ships no such files (student data is never committed).
 *   REFRESH_AFTER_SYNC=1    run analytics.refresh_all() at the end (default 1)
 *
 * Idempotent (INSERT ... ON CONFLICT DO UPDATE). Run from GitHub Actions every 30 min.
 */
import fs from 'node:fs';
import postgres, { type Sql } from 'postgres';
import { OBJECTS, type ObjectSpec } from './objects.js';
import { txPooler } from './sync-url.js';

const API_VERSION = 'v62.0';
const BATCH = 1000;

const env = (k: string, d?: string): string => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`Missing env ${k}`);
  return v;
};

const args = new Set(process.argv.slice(2));
const FULL = args.has('--full');
const REFRESH_ONLY = args.has('--refresh-only');
const REFRESH_AFTER = (process.env.REFRESH_AFTER_SYNC ?? '1') === '1';
const ONLY = process.env.SYNC_OBJECTS?.split(',').map((x) => x.trim()).filter(Boolean) ?? [];
const SKIP = (process.env.SKIP_OBJECTS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const wanted = (name: string) => (!ONLY.length || ONLY.includes(name)) && !SKIP.includes(name);

// Supabase: the session pooler (5432) allows only 15 clients on the free plan and Hyperdrive keeps most of
// them; the transaction pooler (6543) allows far more. Rewrite the port and avoid session-level state.
const sql = postgres(txPooler(env('DATABASE_URL')), { max: 2, prepare: false, idle_timeout: 20, transform: { undefined: null }, connection: { application_name: 'lead-touch-sync' } });

// ---------------------------------------------------------------- watermark helpers
async function getState(name: string): Promise<Date | null> {
  const [s] = await sql<{ last_modstamp: Date | null }[]>`SELECT last_modstamp FROM salesforce._sync_state WHERE object_name = ${name}`;
  return FULL ? null : s?.last_modstamp ?? null;
}
async function setState(name: string, stamp: Date | string | null, rows: number, error: string | null): Promise<void> {
  await sql`
    INSERT INTO salesforce._sync_state (object_name, last_modstamp, last_run_at, last_run_rows, last_error)
    VALUES (${name}, ${stamp}, now(), ${rows}, ${error})
    ON CONFLICT (object_name) DO UPDATE SET
      last_modstamp = COALESCE(EXCLUDED.last_modstamp, salesforce._sync_state.last_modstamp),
      last_run_at = now(), last_run_rows = EXCLUDED.last_run_rows, last_error = EXCLUDED.last_error`;
}

async function upsert(table: string, rows: Record<string, unknown>[]): Promise<void> {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const updateCols = cols.filter((c) => c !== 'id');
  await sql`
    INSERT INTO ${sql(table)} ${sql(rows, ...cols)}
    ON CONFLICT (id) DO UPDATE SET
    ${sql.unsafe(updateCols.map((c) => `"${c}" = EXCLUDED."${c}"`).join(', '))}
  `;
}

// ---------------------------------------------------------------- Salesforce
interface SfSession { instanceUrl: string; token: string; }

async function login(): Promise<SfSession> {
  // Tries OAuth client-credentials first (Connected App with "Enable Client Credentials Flow" + Run-As user),
  // then the username-password flow when SF_USERNAME is set. Reports both errors if both fail.
  const base = { client_id: env('SF_CLIENT_ID'), client_secret: env('SF_CLIENT_SECRET') };
  const attempts: [string, URLSearchParams][] = [['client-credentials flow', new URLSearchParams({ grant_type: 'client_credentials', ...base })]];
  if (process.env.SF_USERNAME) {
    attempts.push(['username-password flow', new URLSearchParams({ grant_type: 'password', ...base,
      username: env('SF_USERNAME'), password: env('SF_PASSWORD') + (process.env.SF_SECURITY_TOKEN ?? '') })]);
  }
  // Client-credentials MUST hit the org's My Domain (https://xxx.my.salesforce.com); login.salesforce.com answers
  // "request not supported on this domain". Try SF_MY_DOMAIN first, then SF_LOGIN_URL / login.salesforce.com.
  const hosts = [...new Set([process.env.SF_MY_DOMAIN, process.env.SF_LOGIN_URL, 'https://login.salesforce.com']
    .filter((h): h is string => !!h).map((h) => h.replace(/\/+$/, '')))];
  const errors: string[] = [];
  for (const [name, body] of attempts) {
    for (const host of hosts) {
      const res = await fetch(`${host}/services/oauth2/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
      if (res.ok) {
        console.log(`[salesforce] logged in via ${name} at ${host}`);
        const j = (await res.json()) as { access_token: string; instance_url: string };
        return { instanceUrl: j.instance_url, token: j.access_token };
      }
      errors.push(`${name} @ ${host}: ${res.status} ${await res.text()}`);
    }
  }
  throw new Error(`Salesforce login failed - ${errors.join(' | ')}`);
}

async function* soql(s: SfSession, query: string, all: boolean): AsyncGenerator<Record<string, unknown>[]> {
  let url: string | null = `${s.instanceUrl}/services/data/${API_VERSION}/${all ? 'queryAll' : 'query'}?q=${encodeURIComponent(query)}`;
  while (url) {
    let res = await fetch(url, { headers: { authorization: `Bearer ${s.token}` } });
    if (res.status === 401) { const n = await login(); s.token = n.token; res = await fetch(url, { headers: { authorization: `Bearer ${s.token}` } }); }
    if (!res.ok) throw new Error(`SOQL failed ${res.status}: ${await res.text()}`);
    const j = (await res.json()) as { records: Record<string, unknown>[]; done: boolean; nextRecordsUrl?: string };
    yield j.records;
    url = j.done || !j.nextRecordsUrl ? null : `${s.instanceUrl}${j.nextRecordsUrl}`;
  }
}

function getPath(rec: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : null), rec);
}
function toRow(spec: ObjectSpec, rec: Record<string, unknown>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const f of spec.fields) {
    const col = spec.flatten?.[f] ?? f.toLowerCase();
    const v = f.includes('.') ? getPath(rec, f) : rec[f];
    row[col] = v === undefined ? null : v;
  }
  row._synced_at = new Date();
  return row;
}

async function syncSalesforceObject(s: SfSession, spec: ObjectSpec): Promise<void> {
  const key = spec.key ?? spec.object;
  const since = await getState(key);
  const where: string[] = [];
  if (since) where.push(`SystemModstamp > ${since.toISOString()}`);
  if (spec.initialWhere) where.push(spec.initialWhere);   // window applies always, so old leads modified later never creep in
  const q = `SELECT ${spec.fields.join(', ')} FROM ${spec.object}` + (where.length ? ` WHERE ${where.join(' AND ')}` : '') + ' ORDER BY SystemModstamp ASC';

  console.log(`[${key}] ${since ? `incremental since ${since.toISOString()}` : `FULL load${spec.initialWhere ? ` (${spec.initialWhere})` : ''}`}`);
  let n = 0;
  let maxStamp: string | null = since?.toISOString() ?? null;
  const t0 = Date.now();
  try {
    let buf: Record<string, unknown>[] = [];
    for await (const page of soql(s, q, spec.queryAll ?? false)) {
      for (const rec of page) {
        const row = toRow(spec, rec);
        buf.push(row);
        const st = row.systemmodstamp as string | null;
        if (st && (!maxStamp || st > maxStamp)) maxStamp = st;
        if (buf.length >= BATCH) { await upsert(`salesforce.${spec.table}`, buf); n += buf.length; buf = []; }
      }
      if (n && n % 20000 < BATCH) console.log(`[${key}] ${n} rows...`);
    }
    if (buf.length) { await upsert(`salesforce.${spec.table}`, buf); n += buf.length; }
    await setState(key, maxStamp, n, null);
    console.log(`[${key}] done: ${n} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s (watermark ${maxStamp})`);
  } catch (e) {
    await setState(key, null, n, e instanceof Error ? e.message : String(e));
    throw e;
  }
}

// ---------------------------------------------------------------- Salesforce stage history -> one row per lead
// Lead_Master__History (Field = Lead_Stage__c) is 1.5 M rows since March 2026; we keep only each lead's LATEST change:
// salesforce.lead_stage (lead_id, stage, prev_stage, changed_at). Watermark = history CreatedDate (the object has no SystemModstamp).
/** Full loads of history / task objects are split into month windows: one SOQL over a year of rows hits Salesforce's QUERY_TIMEOUT
 *  (seen 2026-10-24 on Lead_Master__History since 2025-01-01). An incremental run keeps its single "CreatedDate > watermark" term. */
function dateTerms(since: Date | null, floor: string): string[][] {
  if (since) return [[`CreatedDate > ${since.toISOString()}`]];
  const out: string[][] = [];
  let a = new Date(floor); a = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), 1));
  const end = new Date(Date.now() + 86400_000);
  while (a < end) {
    const b = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth() + 1, 1));
    out.push([`CreatedDate >= ${a.toISOString()}`, `CreatedDate < ${b.toISOString()}`]);
    a = b;
  }
  return out;
}

const STAGE_HISTORY_KEY = 'Lead_Master__History';
async function syncStageHistory(s: SfSession): Promise<void> {
  const since = await getState(STAGE_HISTORY_KEY);
  const floor = process.env.STAGE_HISTORY_SINCE || process.env.LEAD_SINCE || '2026-03-01T00:00:00Z';
  const qFor = (dt: string[]) => `SELECT Id, ParentId, OldValue, NewValue, CreatedDate FROM Lead_Master__History WHERE ${[`Field = 'Lead_Stage__c'`, ...dt].join(' AND ')} ORDER BY CreatedDate ASC`;
  const windows = dateTerms(since, floor);
  console.log(`[${STAGE_HISTORY_KEY}] ${since ? `incremental since ${since.toISOString()}` : `FULL load (since ${floor})`}`);
  let n = 0; let maxStamp: string | null = since?.toISOString() ?? null; const t0 = Date.now();
  const flush = async (buf: Map<string, Record<string, unknown>>) => {
    if (!buf.size) return;
    const rows = [...buf.values()];
    await sql`
      INSERT INTO salesforce.lead_stage ${sql(rows, 'lead_id', 'stage', 'prev_stage', 'changed_at', '_synced_at')}
      ON CONFLICT (lead_id) DO UPDATE SET stage = EXCLUDED.stage, prev_stage = EXCLUDED.prev_stage, changed_at = EXCLUDED.changed_at,
        _synced_at = EXCLUDED._synced_at
      WHERE EXCLUDED.changed_at >= salesforce.lead_stage.changed_at`;
  };
  try {
    let buf = new Map<string, Record<string, unknown>>();   // lead_id -> latest row in this batch (ON CONFLICT cannot hit a row twice)
    for (const dt of windows) for await (const page of soql(s, qFor(dt), false)) {
      for (const rec of page) {
        const lead = String(rec.ParentId); const at = String(rec.CreatedDate);
        const prev = buf.get(lead);
        if (!prev || String(prev.changed_at) <= at) buf.set(lead, { lead_id: lead, stage: rec.NewValue == null ? '' : String(rec.NewValue), prev_stage: rec.OldValue == null ? null : String(rec.OldValue), changed_at: at, _synced_at: new Date() });
        if (!maxStamp || at > maxStamp) maxStamp = at;
        n++;
        if (buf.size >= BATCH) { await flush(buf); buf = new Map(); }
      }
      if (n % 20000 < 2000) console.log(`[${STAGE_HISTORY_KEY}] ${n} history rows...`);
    }
    await flush(buf);
    await setState(STAGE_HISTORY_KEY, maxStamp, n, null);
    console.log(`[${STAGE_HISTORY_KEY}] done: ${n} history rows in ${((Date.now() - t0) / 1000).toFixed(1)}s (watermark ${maxStamp})`);
  } catch (e) {
    await setState(STAGE_HISTORY_KEY, null, n, e instanceof Error ? e.message : String(e));
    throw e;
  }
}

// ---------------------------------------------------------------- Salesforce call log (Task) -> one row per lead
// Task is ~2 M rows since March 2026; we keep per lead: calls, first / last call, and the reason / status / owner of the LAST call.
// Calls are logged either on the lead (What = Lead_Master__c) or, far more often, on one of its Interested Courses
// (What = Interested_Course__c); TYPEOF resolves both to the lead id.
// Watermark = Task CreatedDate (new calls only; later edits of an old call's reason are not picked up). A full load truncates first.
// ---------------------------------------------------------------- Salesforce IC status history -> one row per interested course
// Interested_Course__History (Field = Status__c) reduced to each IC's LATEST change: salesforce.ic_status (sql/034). Same shape as the
// lead-stage history. The first (full) load is heavy, so it only runs when IC_HISTORY_INIT=1 (the one-off night job); afterwards every
// sync pulls the increment by history CreatedDate.
const IC_HISTORY_KEY = 'Interested_Course__History';
async function syncIcStatusHistory(s: SfSession): Promise<void> {
  const since = await getState(IC_HISTORY_KEY);
  if (!since && process.env.IC_HISTORY_INIT !== '1') { console.log(`[${IC_HISTORY_KEY}] no watermark yet and IC_HISTORY_INIT is not set - skipping (the initial load runs at night)`); return; }
  const floor = process.env.STAGE_HISTORY_SINCE || '2026-03-01T00:00:00Z';
  const qFor = (dt: string[]) => `SELECT Id, ParentId, OldValue, NewValue, CreatedDate FROM Interested_Course__History WHERE ${[`Field = 'Status__c'`, ...dt].join(' AND ')} ORDER BY CreatedDate ASC`;
  const windows = dateTerms(since, floor);
  console.log(`[${IC_HISTORY_KEY}] ${since ? `incremental since ${since.toISOString()}` : `FULL load (since ${floor})`}`);
  let n = 0; let maxStamp: string | null = since?.toISOString() ?? null; const t0 = Date.now();
  const flush = async (buf: Map<string, Record<string, unknown>>) => {
    if (!buf.size) return;
    const rows = [...buf.values()];
    await sql`
      INSERT INTO salesforce.ic_status ${sql(rows, 'ic_id', 'status', 'prev_status', 'changed_at', '_synced_at')}
      ON CONFLICT (ic_id) DO UPDATE SET status = EXCLUDED.status, prev_status = EXCLUDED.prev_status, changed_at = EXCLUDED.changed_at,
        _synced_at = EXCLUDED._synced_at
      WHERE EXCLUDED.changed_at >= salesforce.ic_status.changed_at`;
  };
  try {
    let buf = new Map<string, Record<string, unknown>>();
    for (const dt of windows) for await (const page of soql(s, qFor(dt), false)) {
      for (const rec of page) {
        const ic = String(rec.ParentId); const at = String(rec.CreatedDate);
        const prev = buf.get(ic);
        if (!prev || String(prev.changed_at) <= at) buf.set(ic, { ic_id: ic, status: rec.NewValue == null ? '' : String(rec.NewValue), prev_status: rec.OldValue == null ? null : String(rec.OldValue), changed_at: at, _synced_at: new Date() });
        if (!maxStamp || at > maxStamp) maxStamp = at;
        n++;
        if (buf.size >= BATCH) { await flush(buf); buf = new Map(); }
      }
      if (n % 20000 < 2000) console.log(`[${IC_HISTORY_KEY}] ${n} history rows...`);
    }
    await flush(buf);
    // lead of each IC (for the lead-level index); cheap, runs after every load
    await sql`UPDATE salesforce.ic_status h SET lead_id = ic.lead_master__c FROM salesforce.interested_course__c ic WHERE ic.id = h.ic_id AND h.lead_id IS DISTINCT FROM ic.lead_master__c`;
    await setState(IC_HISTORY_KEY, maxStamp, n, null);
    console.log(`[${IC_HISTORY_KEY}] done: ${n} history rows in ${((Date.now() - t0) / 1000).toFixed(1)}s (watermark ${maxStamp})`);
  } catch (e) {
    await setState(IC_HISTORY_KEY, null, n, e instanceof Error ? e.message : String(e));
    throw e;
  }
}

const CALLS_KEY = 'Lead_Calls';
interface CallAgg { lead_id: string; calls: number; first_call_at: string; last_call_at: string; last_reason: string | null; last_call_status: string | null; last_owner_id: string | null; last_subject: string | null; last_comment: string | null; call_days: string[]; _synced_at: Date }
/** IST calendar day of a Salesforce timestamp (the dashboard's day boundary) */
const istDay = (iso: string) => new Date(Date.parse(iso) + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
async function syncCallSummary(s: SfSession): Promise<void> {
  const since = await getState(CALLS_KEY);
  const floor = process.env.CALLS_SINCE || process.env.LEAD_SINCE || '2026-03-01T00:00:00Z';   // repo variable CALLS_SINCE (2026-05-01)
  if (!since) await sql`TRUNCATE salesforce.lead_calls`;
  const qFor = (dt: string[]) => `SELECT Id, WhatId, CreatedDate, Reason__c, Call_Status__c, OwnerId, Subject, Activity_Comments__c, TYPEOF What WHEN Interested_Course__c THEN Lead_Master__c WHEN Lead_Master__c THEN Id END FROM Task WHERE What.Type IN ('Lead_Master__c', 'Interested_Course__c') AND ${dt.join(' AND ')} ORDER BY CreatedDate ASC`;
  const windows = dateTerms(since, floor);
  console.log(`[${CALLS_KEY}] ${since ? `incremental since ${since.toISOString()}` : `FULL load (since ${floor})`}`);
  let n = 0; let maxStamp: string | null = since?.toISOString() ?? null; const t0 = Date.now();
  const flush = async (buf: Map<string, CallAgg>) => {
    if (!buf.size) return;
    const rows = [...buf.values()];
    await sql`
      INSERT INTO salesforce.lead_calls ${sql(rows as unknown as Record<string, unknown>[], 'lead_id', 'calls', 'first_call_at', 'last_call_at', 'last_reason', 'last_call_status', 'last_owner_id', 'last_subject', 'last_comment', 'call_days', '_synced_at')}
      ON CONFLICT (lead_id) DO UPDATE SET
        calls = salesforce.lead_calls.calls + EXCLUDED.calls,
        -- the activity days of the lead (sql/046): the known days plus the new ones, distinct and sorted
        call_days = (SELECT array_agg(d ORDER BY d) FROM (SELECT DISTINCT unnest(COALESCE(salesforce.lead_calls.call_days, '{}'::date[]) || EXCLUDED.call_days) AS d) u),
        first_call_at = LEAST(salesforce.lead_calls.first_call_at, EXCLUDED.first_call_at),
        last_reason = CASE WHEN EXCLUDED.last_call_at >= salesforce.lead_calls.last_call_at THEN EXCLUDED.last_reason ELSE salesforce.lead_calls.last_reason END,
        last_call_status = CASE WHEN EXCLUDED.last_call_at >= salesforce.lead_calls.last_call_at THEN EXCLUDED.last_call_status ELSE salesforce.lead_calls.last_call_status END,
        last_owner_id = CASE WHEN EXCLUDED.last_call_at >= salesforce.lead_calls.last_call_at THEN EXCLUDED.last_owner_id ELSE salesforce.lead_calls.last_owner_id END,
        last_subject = CASE WHEN EXCLUDED.last_call_at >= salesforce.lead_calls.last_call_at THEN EXCLUDED.last_subject ELSE salesforce.lead_calls.last_subject END,
        last_comment = CASE WHEN EXCLUDED.last_call_at >= salesforce.lead_calls.last_call_at THEN EXCLUDED.last_comment ELSE salesforce.lead_calls.last_comment END,
        last_call_at = GREATEST(salesforce.lead_calls.last_call_at, EXCLUDED.last_call_at),
        _synced_at = EXCLUDED._synced_at`;
  };
  try {
    let buf = new Map<string, CallAgg>();
    for (const dt of windows) for await (const page of soql(s, qFor(dt), false)) {
      for (const rec of page) {
        const what = rec.What as { Lead_Master__c?: string | null; Id?: string | null } | null;
        const lead = what?.Lead_Master__c ?? what?.Id ?? (String(rec.WhatId).startsWith('a02') ? String(rec.WhatId) : null);
        const at = String(rec.CreatedDate);
        n++;
        if (!maxStamp || at > maxStamp) maxStamp = at;
        if (!lead) continue;   // IC without a lead
        const cur = buf.get(lead);
        const reason = rec.Reason__c == null ? null : String(rec.Reason__c).replace(/^[\s\u2060\u00a0]+/, '').trim();   // some picklist values carry invisible leading chars
        const comment = rec.Activity_Comments__c == null ? null : String(rec.Activity_Comments__c).trim().slice(0, 255) || null;
        if (!cur) buf.set(lead, { lead_id: lead, calls: 1, first_call_at: at, last_call_at: at, last_reason: reason, last_call_status: rec.Call_Status__c == null ? null : String(rec.Call_Status__c), last_owner_id: rec.OwnerId == null ? null : String(rec.OwnerId), last_subject: rec.Subject == null ? null : String(rec.Subject), last_comment: comment, call_days: [istDay(at)], _synced_at: new Date() });
        else {
          cur.calls++;
          const day = istDay(at); if (!cur.call_days.includes(day)) cur.call_days.push(day);
          if (at < cur.first_call_at) cur.first_call_at = at;
          if (at >= cur.last_call_at) { cur.last_call_at = at; cur.last_reason = reason; cur.last_call_status = rec.Call_Status__c == null ? null : String(rec.Call_Status__c); cur.last_owner_id = rec.OwnerId == null ? null : String(rec.OwnerId); cur.last_subject = rec.Subject == null ? null : String(rec.Subject); cur.last_comment = comment; }
        }
        if (buf.size >= BATCH) { await flush(buf); buf = new Map(); }
      }
      if (n % 50000 < 2000) console.log(`[${CALLS_KEY}] ${n} calls...`);
    }
    await flush(buf);
    await setState(CALLS_KEY, maxStamp, n, null);
    console.log(`[${CALLS_KEY}] done: ${n} calls in ${((Date.now() - t0) / 1000).toFixed(1)}s (watermark ${maxStamp})`);
  } catch (e) {
    await setState(CALLS_KEY, null, n, e instanceof Error ? e.message : String(e));
    throw e;
  }
}

// ---------------------------------------------------------------- production app DB -> app.*
interface AppTableSpec { name: string; select: (src: Sql, since: Date | null) => AsyncIterable<Record<string, unknown>[]>; stampCol: string; }

// Minimal copy (Supabase free tier): only payments that can ever count as valid + the users behind them,
// and only the columns the analytics views read. Every payment_method is copied (0 = Tableau rule, 1 = gateway EMI
// instalments; the Converted page can switch). Validity is still evaluated in the analytics views, so a payment
// that is refunded / deleted later is corrected by the 45-day incremental tail. enrollment_batch_id = the batch of the payment's
// enrollment (course / grade of a purchase follow the enrollment, like the Metabase sales query); a batch move is picked up inside the same tail.
const VALID = `p.deleted = false AND p.is_success = true AND p.payment_success = true`;
const APP_TABLES: AppTableSpec[] = [
  {
    name: 'home_payment', stampCol: 'created',
    select: (src, since) => (since
      ? src`SELECT p.id, p.user_id, p.payment_method, p.payment_type, p.deleted, p.is_success, p.payment_success, p.payment_date, p.payment_time, p.created,
                   -- course_id was dropped from the production table on 2026-10-22 (course_new_id remains); our column stays, as NULL
                   p.amount, p.total, p.tuition_fees, p.discount, p.refund_amount, NULL::integer AS course_id, p.course_new_id, p.batch_id, p.sales_person_id, p.enrollment_id,
                   he.batch_id AS enrollment_batch_id, he.fee AS enrollment_fee, he.discount AS enrollment_discount
            FROM public.home_payment p LEFT JOIN public.home_enrollment he ON he.id = p.enrollment_id
            WHERE p.created > ${since}::timestamptz - interval '45 days' OR p.payment_date >= (${since}::date - 45)
            ORDER BY p.id`.cursor(5000)
      : src.unsafe(`SELECT p.id, p.user_id, p.payment_method, p.payment_type, p.deleted, p.is_success, p.payment_success, p.payment_date, p.payment_time, p.created,
                   p.amount, p.total, p.tuition_fees, p.discount, p.refund_amount, NULL::integer AS course_id, p.course_new_id, p.batch_id, p.sales_person_id, p.enrollment_id,
                   he.batch_id AS enrollment_batch_id, he.fee AS enrollment_fee, he.discount AS enrollment_discount
            FROM public.home_payment p LEFT JOIN public.home_enrollment he ON he.id = p.enrollment_id WHERE ${VALID} ORDER BY p.id`).cursor(5000)),
  },
  {
    // every app account with a phone number, paying or not (until 2026-10-27 only paying accounts were copied, so the EPS ID of a
    // freshly installed account showed "-"); ~770k rows, increment by created / updated_at
    name: 'home_customuser', stampCol: 'updated_at',
    select: (src, since) => (since
      ? src`SELECT u.id, u.phone, u.alternative_number, u.is_deleted, u.created, u.updated_at
            FROM public.home_customuser u
            WHERE (u.updated_at > ${since}::timestamptz - interval '1 day' OR u.created > ${since}::timestamptz - interval '1 day')
              AND u.phone IS NOT NULL AND u.phone <> ''
            ORDER BY u.id`.cursor(5000)
      : src.unsafe(`SELECT u.id, u.phone, u.alternative_number, u.is_deleted, u.created, u.updated_at
            FROM public.home_customuser u WHERE u.phone IS NOT NULL AND u.phone <> '' ORDER BY u.id`).cursor(5000)),
  },
  {
    // batch / course lookup (~3.6k rows) so the dashboard can show names instead of ids
    name: 'core_batch', stampCol: 'updated_at',
    select: (src, since) => (since
      ? src`SELECT b.id, b.title, b.course_id, s.title AS course_title, g.title AS grade_title, s.academic_year, b.course_fee, b.is_premium, b.is_deleted, b.expiry_date, b.updated_at
            FROM public.core_batch b LEFT JOIN public.core_syllabusstructure s ON s.id = b.course_id LEFT JOIN public.core_grade g ON g.id = s.grade_id
            WHERE b.updated_at > ${since}::timestamptz OR s.updated_at > ${since}::timestamptz ORDER BY b.id`.cursor(2000)
      : src`SELECT b.id, b.title, b.course_id, s.title AS course_title, g.title AS grade_title, s.academic_year, b.course_fee, b.is_premium, b.is_deleted, b.expiry_date, b.updated_at
            FROM public.core_batch b LEFT JOIN public.core_syllabusstructure s ON s.id = b.course_id LEFT JOIN public.core_grade g ON g.id = s.grade_id ORDER BY b.id`.cursor(2000)),
  },
];

// ---------------------------------------------------------------- Ujra (residential Integrated programmes) -> app.ujra_*
// Everything is small (~5k students, ~5k bookings, ~30k payments), so each table is copied whole on the first run and by a
// 45-day updated_at tail afterwards. Validity (status success, not deleted, category) is decided in analytics.v_ujra_payment.
const UJRA_TABLES: AppTableSpec[] = [
  {
    name: 'ujra_student', stampCol: 'updated_at',
    select: (src, since) => src`
      SELECT s.id, s.name, s.number, s.whatsapp, s.parent_number, s.alternate_number, s.alternate_number_two, s.eps_id, s.is_deleted, s.created_at, s.updated_at
      FROM public.core_student s
      WHERE ${since ? src`s.updated_at > ${since}::timestamptz - interval '45 days'` : src`true`}
      ORDER BY s.id`.cursor(2000),
  },
  {
    name: 'ujra_booking', stampCol: 'updated_at',
    select: (src, since) => src`
      SELECT b.id, b.student_id, b.status, c.title AS course_title, ca.title AS campus_title, b.advance_amount,
             -- proposed fee per component = fee - discount - concession - scholarship - special request (the Ujra proposed_* columns are always 0)
             (COALESCE(d.course_fee, 0) - COALESCE(d.course_discount, 0) - COALESCE(d.course_concession, 0) - COALESCE(d.course_scholarship, 0) - COALESCE(d.course_special_request, 0)) AS proposed_course_fee,
             (COALESCE(d.registration_fee, 0) - COALESCE(d.registration_fee_discount, 0) - COALESCE(d.registration_fee_scholarship, 0) - COALESCE(d.registration_fee_special_request, 0)) AS proposed_registration_fee,
             (COALESCE(d.material_fee, 0) - COALESCE(d.material_fee_discount, 0) - COALESCE(d.material_fee_scholarship, 0) - COALESCE(d.material_fee_special_request, 0)) AS proposed_material_fee,
             (COALESCE(d.hostel_fee, 0) - COALESCE(d.hostel_discount, 0) - COALESCE(d.hostel_concession, 0) - COALESCE(d.hostel_scholarship, 0) - COALESCE(d.hostel_special_request, 0)) AS proposed_hostel_fee,
             b.is_deleted, b.created_at, GREATEST(b.updated_at, d.updated_at) AS updated_at
      FROM public.booking_booking b
      LEFT JOIN public.hostel_room_course c ON c.id = b.course_id
      LEFT JOIN public.hostel_room_campus ca ON ca.id = b.campus_id
      LEFT JOIN LATERAL (SELECT d.* FROM public.payment_paymentdetails d WHERE d.booking_id = b.id AND d.is_deleted = false ORDER BY d.updated_at DESC NULLS LAST, d.id DESC LIMIT 1) d ON true
      WHERE ${since ? src`GREATEST(b.updated_at, d.updated_at) > ${since}::timestamptz - interval '45 days'` : src`true`}
      ORDER BY b.id`.cursor(2000),
  },
  {
    name: 'ujra_payment', stampCol: 'updated_at',
    select: (src, since) => src`
      SELECT p.id, p.student_id, p.booking_id, p.amount, p.payment_date, p.payment_status, p.payment_category, p.payment_mode, p.payment_success,
             p.refund_amount, p.academic_year_id, p.is_deleted, p.created_at, p.updated_at
      FROM public.payment_payment p
      WHERE ${since ? src`(p.updated_at > ${since}::timestamptz - interval '45 days' OR p.payment_date >= ${since}::timestamptz - interval '45 days')` : src`true`}
      ORDER BY p.id`.cursor(2000),
  },
];

async function syncAppTables(): Promise<void> {
  await syncFrom('SOURCE_DATABASE_URL', APP_TABLES, 'app');
  if (process.env.UJRA_DATABASE_URL) await syncFrom('UJRA_DATABASE_URL', UJRA_TABLES, 'ujra');
  else if (process.env.METABASE_URL && process.env.METABASE_API_KEY) await syncUjraViaMetabase();
  else await seedUjraFromFiles();
}

// ---------------------------------------------------------------- Ujra through Metabase (no direct database login)
// The API key's group may only VIEW saved questions, so three saved questions in the Metabase collection "Ujra" do the reading:
// each returns one page of 2000 rows ordered by id, with the template tags after_id (paging) and since (updated_at lower bound).
// Metabase returns JSON rows with real booleans and numbers. Questions 6973 / 6974 / 6975 were created on 2026-10-06; their
// template-tag ids change if the question's SQL is edited, so override them here when that happens (6975 edited 2026-10-29: proposed
// fees = fee - discount - concession - scholarship - special request per component, same formula as the direct-DB path above).
interface UjraCard { card: number; afterId: string; since: string }
const UJRA_CARDS: Record<string, UjraCard> = {
  ujra_payment: { card: 6973, afterId: '442b7d61-d700-4ae8-8b82-c86bc87e7fba', since: 'cd389254-8bbd-4d56-98c1-d5c0f370fecd' },
  ujra_student: { card: 6974, afterId: '67cca53b-018f-40d6-a561-dccdc70c2d5b', since: '316ba16a-b531-47bc-8c1f-af1691efdf74' },
  ujra_booking: { card: 6975, afterId: '8603e085-9312-4d81-aa1d-1721dd26d1ee', since: '684237bf-3279-43f5-8421-817c4960f9d6' },
};
const UJRA_PAGE = 2000;

async function syncUjraViaMetabase(): Promise<void> {
  const base = (process.env.METABASE_URL ?? '').replace(/\/$/, '');
  const headers = { 'X-API-KEY': process.env.METABASE_API_KEY ?? '', 'Content-Type': 'application/json' };
  for (const t of ['ujra_student', 'ujra_booking', 'ujra_payment']) {
    if (!wanted(t)) continue;
    const c = UJRA_CARDS[t];
    const since = await getState(t);
    const sinceText = since ? new Date(since.getTime() - 45 * 86400 * 1000).toISOString() : '2000-01-01';
    console.log(`[ujra] ${t} via Metabase question ${c.card} ${since ? `incremental since ${since.toISOString()}` : 'FULL copy'}`);
    const t0 = Date.now(); let n = 0; let afterId = 0; let maxStamp: Date | null = since;
    try {
      for (let page = 0; page < 200; page++) {
        const body = JSON.stringify({ parameters: [
          { id: c.afterId, type: 'text', target: ['variable', ['template-tag', 'after_id']], value: String(afterId) },
          { id: c.since, type: 'text', target: ['variable', ['template-tag', 'since']], value: sinceText },
        ] });
        const res = await fetch(`${base}/api/card/${c.card}/query`, { method: 'POST', headers, body });
        const text = await res.text();
        let json: { status?: string; error?: string; data?: { cols: { name: string }[]; rows: unknown[][] } } = {};
        try { json = JSON.parse(text); } catch { /* not json */ }
        if (!res.ok || json.status !== 'completed' || !json.data) throw new Error(`Metabase question ${c.card} failed: HTTP ${res.status} ${(json.error ?? text).slice(0, 300)}`);
        const cols = json.data.cols.map((x) => x.name);
        const rows: Record<string, unknown>[] = json.data.rows.map((r) => ({ ...Object.fromEntries(cols.map((name, idx) => [name, r[idx]])), _synced_at: new Date() }));
        if (!rows.length) break;
        for (let b = 0; b < rows.length; b += BATCH) await upsert(`app.${t}`, rows.slice(b, b + BATCH));
        n += rows.length;
        for (const r of rows) { const d = r.updated_at ? new Date(r.updated_at as string) : null; if (d && (!maxStamp || d > maxStamp)) maxStamp = d; }
        afterId = Number(rows[rows.length - 1].id);
        if (rows.length < UJRA_PAGE) break;
      }
      await setState(t, maxStamp ?? new Date(), n, null);
      console.log(`[ujra] ${t}: ${n} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (e) {
      await setState(t, null, n, e instanceof Error ? e.message : String(e));
      throw e;
    }
  }
}

/** minimal RFC 4180 reader: quoted fields, doubled quotes, newlines inside quotes; empty = NULL */
function parseCsv(text: string): Record<string, string | boolean | null>[] {
  const rows: string[][] = []; let row: string[] = []; let field = ''; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(field); field = ''; rows.push(row); row = []; }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift() ?? [];
  const cell = (v: string): string | boolean | null => (v === '' ? null : v === 'true' ? true : v === 'false' ? false : v);
  return rows.filter((r) => r.length === header.length && r.some((v) => v !== '')).map((r) => Object.fromEntries(header.map((h, i) => [h, cell(r[i])])));
}

/** Ujra snapshot from a LOCAL sync/seed/ujra/*.csv (Metabase exports), only when neither the Ujra database nor Metabase is configured. Not in the repository. */
async function seedUjraFromFiles(): Promise<void> {
  const dir = process.env.UJRA_SEED_DIR ?? new URL('../seed/ujra/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  for (const t of ['ujra_student', 'ujra_booking', 'ujra_payment']) {
    if (!wanted(t)) continue;
    const file = `${dir}${t}.csv`;
    if (!fs.existsSync(file)) { console.log(`[ujra] no seed file ${file} - skipping`); continue; }
    const t0 = Date.now();
    const rows: Record<string, unknown>[] = parseCsv(fs.readFileSync(file, 'utf8')).map((r) => ({ ...r, _synced_at: new Date() }));
    for (let i = 0; i < rows.length; i += BATCH) await upsert(`app.${t}`, rows.slice(i, i + BATCH));
    const maxStamp = rows.reduce<Date | null>((m, r) => { const d = r.updated_at ? new Date(r.updated_at as string) : null; return d && (!m || d > m) ? d : m; }, null);
    await setState(t, maxStamp ?? new Date(), rows.length, null);
    console.log(`[ujra] ${t}: ${rows.length} rows from the seed file in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
}

async function syncFrom(urlEnv: string, tables: AppTableSpec[], label: string): Promise<void> {
  const url = process.env[urlEnv];
  if (!url) { console.log(`[${label}] ${urlEnv} not set - skipping`); return; }
  const src = postgres(url, { max: 2, idle_timeout: 30, connection: { application_name: 'lead-touch-sync-ro' } });
  try {
    for (const t of tables) {
      if (!wanted(t.name)) continue;
      const since = await getState(t.name);
      console.log(`[${t.name}] ${since ? `incremental since ${since.toISOString()}` : 'FULL copy'}`);
      let n = 0; let maxStamp: Date | null = since; const t0 = Date.now();
      try {
        for await (const batch of t.select(src, since)) {
          const rows: Record<string, unknown>[] = batch.map((r) => ({ ...(r as Record<string, unknown>), _synced_at: new Date() }));
          for (const r of rows) { const st = r[t.stampCol] as Date | null; if (st && (!maxStamp || st > maxStamp)) maxStamp = st; }
          for (let i = 0; i < rows.length; i += BATCH) await upsert(`app.${t.name}`, rows.slice(i, i + BATCH));   // stay under the 65,534-parameter limit
          n += rows.length;
          if (n % 50000 < 5000) console.log(`[${t.name}] ${n} rows...`);
        }
        await setState(t.name, maxStamp ?? new Date(), n, null);
        console.log(`[${t.name}] done: ${n} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      } catch (e) {
        await setState(t.name, null, n, e instanceof Error ? e.message : String(e));
        throw e;
      }
    }
  } finally {
    await src.end({ timeout: 5 });
  }
}

// ---------------------------------------------------------------- late leads (2026-11-25)
/**
 * An old lead (created before LEAD_SINCE) is held once it has a touch, but the lead increment reads only leads CHANGED since its watermark:
 * when a touch is added to (or moved onto, by a merge) an old lead without the lead itself changing, the touch arrives and its lead
 * never does. Fetch every lead a held touch points to that is missing, by Id, so the lead and (now kept) its courses, calls and stage
 * history show up together. Normally a handful per day.
 */
async function syncMissingLeads(s: SfSession): Promise<void> {
  const spec = OBJECTS.find((o) => o.object === 'Lead_Master__c' && !o.key)!;
  const missing = (await sql<{ id: string }[]>`
    SELECT DISTINCT t.lead_master__c AS id FROM salesforce.lead_touch__c t
    WHERE NOT t.isdeleted AND t.lead_master__c IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM salesforce.lead_master__c l WHERE l.id = t.lead_master__c)`).map((r) => r.id);
  if (!missing.length) { console.log('[late leads] none missing'); return; }
  let n = 0;
  for (let i = 0; i < missing.length; i += 200) {
    const ids = missing.slice(i, i + 200).map((x) => `'${x.replace(/'/g, '')}'`).join(',');
    for await (const page of soql(s, `SELECT ${spec.fields.join(', ')} FROM Lead_Master__c WHERE Id IN (${ids})`, true)) {
      const rows = page.map((rec) => toRow(spec, rec));
      if (rows.length) { await upsert(`salesforce.${spec.table}`, rows); n += rows.length; }
    }
  }
  console.log(`[late leads] ${missing.length} leads referenced by touches were missing; fetched ${n}`);
}

// ---------------------------------------------------------------- keep the replica minimal
// queryAll delivers deleted rows (isdeleted = true) so watermarks stay correct; we then purge them,
// together with anything outside the lead window, so storage stays small (Supabase free tier).
async function cleanup(): Promise<void> {
  const leadSince = process.env.LEAD_SINCE?.slice(0, 10) ?? '2025-04-01';
  await sql.begin(async (sql) => {
  await sql`SET LOCAL statement_timeout = 0`;
  const r1 = await sql`DELETE FROM salesforce.lead_master__c l WHERE l.isdeleted OR l.is_deleted__c
    OR (l.createddate < ${leadSince}::date AND COALESCE(l.is_converted__c, false) = false AND COALESCE(l.lead_stage__c, '') <> 'Converted'
        AND NOT EXISTS (SELECT 1 FROM salesforce.lead_touch__c t WHERE t.lead_master__c = l.id AND NOT t.isdeleted))`;
  // Interested Courses, stage rows and call summaries are KEPT when their lead is not held (yet) (2026-11-25). Until then they were deleted
  // as orphans, and because every increment reads only records changed since its watermark, they never came back when the lead entered
  // the dashboard later (an old lead's first touch, a merge moving touches onto it): 3,666 courses of 3,650 held leads were missing
  // on 25 Nov 2026, and late leads showed "(no call)" / no stage history. Only records deleted in Salesforce are purged now. The extra rows
  // (courses, calls and stage of leads outside the lead window) are small; every dashboard view joins them to a held lead anyway.
  const r2 = await sql`DELETE FROM salesforce.interested_course__c ic WHERE ic.isdeleted`;
  const r3 = await sql`DELETE FROM salesforce.lead_touch__c WHERE isdeleted`;
  const r4 = await sql`DELETE FROM salesforce.task WHERE isdeleted`;
  console.log(`[cleanup] removed leads=${r1.count} ics=${r2.count} touches=${r3.count} tasks=${r4.count} (window >= ${leadSince}, deleted rows purged; courses / calls / stage of leads not held are kept)`);
  });
}

// ---------------------------------------------------------------- refresh
async function refreshViews(): Promise<void> {
  console.log('[refresh] analytics.refresh_all()');
  const t0 = Date.now();
  // Supabase applies a per-role statement timeout; the refresh can legitimately take minutes.
  // Web sessions that died mid-transaction keep locks on the views; they are never legitimately older than a few minutes.
  const stale = await sql<{ pid: number }[]>`SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()
    AND application_name = 'postgres.js' AND xact_start < now() - interval '5 minutes'`;   // still useful: stuck web transactions
  for (const { pid } of stale) await sql`SELECT pg_terminate_backend(${pid})`;
  if (stale.length) console.log(`[refresh] terminated ${stale.length} stale web session(s) holding old transactions`);
  const rows = await sql.begin(async (tx) => {
    await tx`SET LOCAL statement_timeout = 0`;
    await tx`SET LOCAL lock_timeout = '2min'`;
    return tx<{ view_name: string; row_count: number; seconds: number }[]>`SELECT * FROM analytics.refresh_all()`;
  });
  for (const r of rows) console.log(`[refresh] ${r.view_name}: ${r.row_count} rows in ${r.seconds}s`);
  // Date order (sql/057, 2026-11-28): the two views the dashboard reads most are kept in date order so a date window reads only its own
  // pages (random order made every Overview statement read ~150 MB). REFRESH CONCURRENTLY changes rows in place and the order decays, so
  // the nightly run rewrites them with CLUSTER (exclusive lock while it runs, so a manual daytime "Sync now" skips it). The VACUUM below
  // then rebuilds their visibility maps.
  if (process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch') {
    for (const [view, index] of [['analytics.mv_touch_flat', 'mv_touch_flat_date'], ['analytics.mv_lead_lite', 'mv_lead_lite_created_inc']] as const) {
      const t1 = Date.now();
      await sql.begin(async (tx) => {
        await tx`SET LOCAL statement_timeout = 0`;
        await tx`SET LOCAL lock_timeout = '1min'`;
        await tx.unsafe(`CLUSTER ${view} USING ${index}`);
      }).then(() => console.log(`[refresh] clustered ${view} in ${((Date.now() - t1) / 1000).toFixed(1)}s`))
        .catch((e: unknown) => console.log(`[refresh] cluster ${view} failed: ${e instanceof Error ? e.message : String(e)}`));
    }
  } else console.log('[refresh] date-order cluster skipped on a manual run');
  // A concurrent refresh rewrites most rows and leaves the visibility map stale, so the Overview's index-only counts fall back to
  // heap fetches (392k of them on mv_lead_lite, 12 s instead of 0.3 s) until the view is vacuumed; autovacuum does not trigger for
  // days (dead rows stay under its 20% threshold). VACUUM must run outside a transaction, one statement each.
  // + interested courses (sql/058, 2026-11-28): the Overview IC cards read them through a covering index, which answers from the index
  // alone only while the visibility map is current; the daily upserts clear it and autovacuum comes days later
  for (const r of [...rows, { view_name: 'salesforce.interested_course__c' }]) {
    const t1 = Date.now();
    await sql.unsafe(`VACUUM (ANALYZE) ${r.view_name}`).catch((e: unknown) => console.log(`[refresh] vacuum ${r.view_name} failed: ${e instanceof Error ? e.message : String(e)}`));
    console.log(`[refresh] vacuumed ${r.view_name} in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  }
  console.log(`[refresh] total ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// ---------------------------------------------------------------- compaction (free tier: 500 MB hard limit)
// REFRESH CONCURRENTLY and the daily upserts leave dead space that only VACUUM FULL returns. Run it whenever
// the database passes COMPACT_ABOVE_MB (default 3000; the Pro plan holds 8 GB) so usage never creeps up to the quota.
// VACUUM FULL holds exclusive locks (~25 s in which every dashboard query waits), so a manual daytime "Sync now" never compacts.
async function compactIfNeeded(): Promise<void> {
  if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch') { console.log('[compact] skipped on a manual run'); return; }
  const limit = Number(process.env.COMPACT_ABOVE_MB ?? 3000);
  const [{ mb }] = await sql<{ mb: number }[]>`SELECT round(pg_database_size(current_database())/1048576.0)::int AS mb`;
  console.log(`[compact] database size ${mb} MB (threshold ${limit} MB)`);
  if (mb < limit) return;
  for (const t of ['salesforce.lead_master__c', 'salesforce.interested_course__c', 'salesforce.lead_touch__c', 'app.home_payment', 'app.home_customuser']) {
    const t0 = Date.now();
    await sql.unsafe(`VACUUM FULL ANALYZE ${t}`);
    console.log(`[compact] ${t} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
  const [{ mb: after }] = await sql<{ mb: number }[]>`SELECT round(pg_database_size(current_database())/1048576.0)::int AS mb`;
  console.log(`[compact] done: ${mb} MB -> ${after} MB`);
}

// ---------------------------------------------------------------- main
async function main(): Promise<void> {
  // role-level statement_timeout (set for the web app's protection) must not cut the bulk load or the refresh
  await sql`SET statement_timeout = 0`;
  await sql`SET default_transaction_read_only = off`;
  if (!REFRESH_ONLY) {
    const specs = OBJECTS.filter((o) => wanted(o.key ?? o.object) || (o.key && wanted(o.object)));
    if (specs.length) {
      const s = await login();
      for (const spec of specs) await syncSalesforceObject(s, spec);
      if (specs.some((o) => o.table === 'lead_touch__c' || o.table === 'lead_master__c')) await syncMissingLeads(s);
    }
    if (wanted(STAGE_HISTORY_KEY)) {
      const s = await login();
      await syncStageHistory(s);
    }
    if (wanted(IC_HISTORY_KEY)) {
      const s = await login();
      await syncIcStatusHistory(s);
    }
    if (wanted(CALLS_KEY)) {
      const s = await login();
      await syncCallSummary(s);
    }
    await syncAppTables();
    await cleanup();
  }
  if (REFRESH_ONLY || REFRESH_AFTER) await refreshViews();
  await compactIfNeeded();
}

main()
  .then(() => sql.end({ timeout: 5 }))
  .catch(async (e) => { console.error(e); await sql.end({ timeout: 5 }); process.exit(1); });
