/**
 * Callyzer -> callyzer.employees / callyzer.calls (sql/059), SALES ONLY (user rule 2026-11-28).
 *
 * Callyzer's analysis feed (https://api-educallyzer.eduport.in, header X-API-Key, 60 requests a minute):
 *   GET /v1/external/analysis/employees                    everyone, with their department TODAY
 *   GET /v1/external/analysis/calls?from&to&employee_code  calls in [from, to), oldest first, paged by cursor (limit <= 5000), range <= 366 days
 * Only the staff whose department is Sales are asked for, so nobody else's calls reach the database. Callyzer keeps no department
 * history: a call counts under the caller's department on the day it is pulled.
 *
 * Each run pulls the last two days again (calls arrive late from phones; call_id makes the upsert idempotent), and the whole history since
 * CALLYZER_START for any Sales person not seen before (new to Sales, or the first run). CALLYZER_SINCE (an ISO time) overrides the start of
 * the regular window, e.g. for a re-pull.
 *
 * Env: CALLYZER_API_KEY (GitHub secret; locally lead-touch-local/callyzer.env). Missing key = the step is skipped. The key and phone
 * numbers are never logged.
 */
import type { Sql } from 'postgres';

const BASE = 'https://api-educallyzer.eduport.in';
/** Callyzer's first call (2026-10-10); nothing earlier exists */
const START = process.env.CALLYZER_START ?? '2026-10-10T00:00:00+05:30';
const CODES_PER_REQUEST = 80;   // employee_code is repeated in the query string; keep the URL short
const PAGE = 5000;
const BATCH = 1000;

interface Employee {
  employee_code: string; name: string | null; company_email: string | null; phone: string | null; role: string | null; department: string | null;
  reports_to_code: string | null; status: string | null; is_remote: boolean | null; accepted_at: string | null; removed_at: string | null; created_at: string | null;
}
interface Call {
  call_id: string; employee_code: string; number_e164: string | null; number_last10: string | null; started_at: string; duration_sec: number | null;
  call_type: string; raw_call_type: number | null; is_connected: boolean | null; has_recording: boolean | null; received_at: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let lastRequest = 0;
async function get<T>(key: string, path: string, params: [string, string][] = []): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const wait = lastRequest + 1100 - Date.now();   // <= 55 requests a minute
    if (wait > 0) await sleep(wait);
    const u = new URL(BASE + path);
    for (const [k, v] of params) u.searchParams.append(k, v);
    lastRequest = Date.now();
    const r = await fetch(u, { headers: { 'X-API-Key': key, accept: 'application/json' } });
    if (r.status === 429) { await sleep(1000 * Math.max(1, Number(r.headers.get('retry-after') ?? 5))); continue; }
    if (r.status >= 500 && attempt < 3) { await sleep(5000 * (attempt + 1)); continue; }
    if (!r.ok) throw new Error(`Callyzer ${path}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    return (await r.json()) as T;
  }
}

const isSales = (e: Employee) => (e.department ?? '').trim().toLowerCase() === 'sales';

async function upsertCalls(sql: Sql, rows: Call[]): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH).map((c) => ({
      call_id: c.call_id, employee_code: c.employee_code, number_last10: c.number_last10, number_e164: c.number_e164, started_at: c.started_at,
      duration_sec: c.duration_sec ?? 0, call_type: c.call_type, raw_call_type: c.raw_call_type, is_connected: c.is_connected ?? false,
      has_recording: c.has_recording, received_at: c.received_at,
    }));
    await sql`
      INSERT INTO callyzer.calls ${sql(chunk)}
      ON CONFLICT (call_id) DO UPDATE SET employee_code = EXCLUDED.employee_code, number_last10 = EXCLUDED.number_last10, number_e164 = EXCLUDED.number_e164,
        started_at = EXCLUDED.started_at, duration_sec = EXCLUDED.duration_sec, call_type = EXCLUDED.call_type, raw_call_type = EXCLUDED.raw_call_type,
        is_connected = EXCLUDED.is_connected, has_recording = EXCLUDED.has_recording, received_at = EXCLUDED.received_at, synced_at = now()`;
  }
}

/** every call of these staff in [from, to), page by page, upserted as it arrives; returns the number of calls */
async function pullCalls(sql: Sql, key: string, codes: string[], from: string, to: string): Promise<number> {
  let n = 0;
  for (let i = 0; i < codes.length; i += CODES_PER_REQUEST) {
    const group = codes.slice(i, i + CODES_PER_REQUEST);
    let cursor: string | null = null;
    do {
      const params: [string, string][] = [['from', from], ['to', to], ['limit', String(PAGE)], ...group.map((c): [string, string] => ['employee_code', c])];
      if (cursor) params.push(['cursor', cursor]);
      const page: { calls: Call[]; next_cursor: string | null } = await get(key, '/v1/external/analysis/calls', params);
      // only the codes asked for (an unknown code returns nothing, but never trust a feed to filter for us)
      const keep = page.calls.filter((c) => group.includes(c.employee_code));
      await upsertCalls(sql, keep);
      n += keep.length;
      cursor = page.next_cursor;
    } while (cursor);
  }
  return n;
}

export async function syncCallyzer(sql: Sql): Promise<{ staff: number; calls: number }> {
  const key = process.env.CALLYZER_API_KEY;
  if (!key) { console.log('[callyzer] skipped: CALLYZER_API_KEY not set'); return { staff: 0, calls: 0 }; }
  const t0 = Date.now();
  const resp = await get<Employee[] | { employees?: Employee[]; data?: Employee[] }>(key, '/v1/external/analysis/employees');
  const people: Employee[] = Array.isArray(resp) ? resp : (resp.employees ?? resp.data ?? []);
  const sales = people.filter(isSales);
  const known = new Set((await sql<{ c: string }[]>`SELECT employee_code AS c FROM callyzer.employees`).map((r) => r.c));
  // staff list: the Sales staff, plus anyone stored before who has left Sales (their department is updated, their old calls stay but no
  // new ones are pulled; the dashboard counts only staff in Sales today)
  const keepRows = people.filter((e) => isSales(e) || known.has(e.employee_code)).map((e) => ({
    employee_code: e.employee_code, name: e.name, company_email: e.company_email, phone: e.phone, role: e.role, department: e.department,
    reports_to_code: e.reports_to_code, status: e.status, is_remote: e.is_remote, accepted_at: e.accepted_at, removed_at: e.removed_at, created_at: e.created_at,
  }));
  if (keepRows.length) {
    await sql`
      INSERT INTO callyzer.employees ${sql(keepRows)}
      ON CONFLICT (employee_code) DO UPDATE SET name = EXCLUDED.name, company_email = EXCLUDED.company_email, phone = EXCLUDED.phone, role = EXCLUDED.role,
        department = EXCLUDED.department, reports_to_code = EXCLUDED.reports_to_code, status = EXCLUDED.status, is_remote = EXCLUDED.is_remote,
        accepted_at = EXCLUDED.accepted_at, removed_at = EXCLUDED.removed_at, created_at = EXCLUDED.created_at, synced_at = now()`;
  }
  const to = new Date(Date.now() + 60_000).toISOString();
  const newCodes = sales.map((e) => e.employee_code).filter((c) => !known.has(c));
  const oldCodes = sales.map((e) => e.employee_code).filter((c) => known.has(c));
  // staff new to Sales (or the first run): their whole history
  const nNew = newCodes.length ? await pullCalls(sql, key, newCodes, START, to) : 0;
  // everyone else: the last two days again (or CALLYZER_SINCE)
  const [{ last }] = await sql<{ last: Date | null }[]>`SELECT max(started_at) AS last FROM callyzer.calls`;
  const since = process.env.CALLYZER_SINCE || (last ? new Date(last.getTime() - 2 * 86400_000).toISOString() : START);
  const nOld = oldCodes.length ? await pullCalls(sql, key, oldCodes, since, to) : 0;
  console.log(`[callyzer] ${sales.length} Sales staff of ${people.length} (${newCodes.length} new: history from ${START}); ${nNew + nOld} calls upserted (window from ${since}) in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  return { staff: sales.length, calls: nNew + nOld };
}
