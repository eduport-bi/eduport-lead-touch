import { Hono } from 'hono';
import type { Sql } from 'postgres';
import type { AppEnv, Role } from '../env';
import { handle, intParam, maskEmail, maskName, maskPhone, csvStream } from '../http';
import { parseFilters, resolvePeriods, paymentPeriod, inList, andAll, isLeadDim, LEAD_DIMS, LIST_KEYS, icCourseIn, type Filters, type Frag, type Period } from '../filters';
import { FLAT_COLS } from './overview';

/**
 * "New leads" KPI of the Overview: every Salesforce lead CREATED (IST) inside the date range, whether or not it has a touch yet.
 * Most leads never get a touch, so this cannot come from the touch table (mv_touch_flat); it reads the lead view directly.
 *   GET /api/overview/new_leads          one row per lead (paged, sortable, searchable) [&dim=touched&value=Touched | any split dim]
 *   GET /api/overview/new_leads.csv      same rows, streamed, capped by EXPORT_ROW_CAP
 *   GET /api/overview/new_leads/summary  headline figures + split tables (touched yet?, stage, class, lead source, owner, ..., touch point, purchased grade / course)
 * Purchases are matched on the phone against the payer table (analytics.mv_payer: every successful payment, any payment method),
 * through the paying account's own phone or its alternative number (analytics.mv_user_phone).
 */
export const newLeads = new Hono<AppEnv>();

type Rec = Record<string, unknown>;

/** lead-level filter columns that exist on analytics.v_lead_conv (the rest - first/last touch point, touch bucket - need touch data and are ignored here) */
const LEAD_CONV_COLS = new Set(['lead_source', 'lead_stage', 'class_group', 'class_raw', 'district', 'city', 'priority', 'lead_type', 'owner_name', 'ad_platform', 'lm_reason']);

/** any successful payment, any payment method (same rule as the payer table) */
const VALID_ANY = (sql: Sql) => sql`hp.deleted = false AND hp.is_success = true AND hp.payment_success = true AND hp.payment_date IS NOT NULL`;

/**
 * WHERE for analytics.v_lead_lite (or v_lead_conv) AS l: leads created inside the window, honouring the filter bar.
 * Lead filters apply to the lead itself; touch filters keep leads with at least one matching touch (any date).
 */
export function newLeadWhere(sql: Sql, f: Filters, p: Period | null, opts: { validPay?: boolean; scope?: string; skip?: string } = {}): Frag {
  // IST calendar days expressed as a range on the raw timestamp, so the creation-date index is used; p = null: no date window (Lead explorer)
  // scope 'union' (Total leads on the lead-created basis): created in the window OR touched in the window
  const c: Frag[] = !p ? []
    : opts.scope === 'union'
      // one semi-join against the union of the two id sets. An OR of "created in range" with "= ANY(array of touched ids)" degraded to a
      // row-by-row array scan once both sides were large (800k leads x 190k ids = 96 s); IN (subquery) at the top level becomes a hash semi-join.
      // both id sets come from covering indexes (mv_lead_lite_created_inc, mv_touch_flat_date): no table pages are read for the union itself
      ? [sql`l.lead_id IN (SELECT m.lead_id FROM analytics.mv_lead_lite m
                            WHERE m.created_at >= (${p.from}::date)::timestamp AT TIME ZONE 'Asia/Kolkata' AND m.created_at < (${p.to}::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'
                            UNION SELECT t.lead_id FROM analytics.mv_touch_flat t WHERE t.touch_date BETWEEN ${p.from} AND ${p.to})`]
      : [sql`l.created_at >= (${p.from}::date)::timestamp AT TIME ZONE 'Asia/Kolkata' AND l.created_at < (${p.to}::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'`];
  if (f.dups !== '1') c.push(sql`l.is_duplicate = false`);
  if (f.paid) c.push(f.paid === 'paid' ? sql`l.is_paid_lead = true` : sql`l.is_paid_lead IS NOT TRUE`);
  if (f.repeat) c.push(f.repeat === '1' ? sql`l.is_repeat = true` : sql`l.is_repeat IS NOT TRUE`);
  // validPay: the dashboard's conversion rule (valid payment, payment_method 0); otherwise any successful payment (payer table)
  const paid = opts.validPay
    ? sql`EXISTS (SELECT 1 FROM analytics.v_valid_payment_x vp WHERE vp.phone_key = l.phone_key)`
    : sql`EXISTS (SELECT 1 FROM analytics.mv_user_phone up JOIN analytics.mv_payer m ON m.user_id = up.user_id WHERE up.phone_key = l.phone_key)`;
  if (f.converted === '1') c.push(paid);
  if (f.converted === '0') c.push(sql`NOT ${paid}`);
  if (f.pre_existing) {
    const pre = sql`EXISTS (SELECT 1 FROM analytics.mv_user_phone up JOIN analytics.mv_payer m ON m.user_id = up.user_id WHERE up.phone_key = l.phone_key AND m.first_payment_date < l.created_date)`;
    c.push(f.pre_existing === '1' ? pre : sql`NOT ${pre}`);
  }
  const touch: Frag[] = [];
  for (const k of LIST_KEYS) {
    const vals = f[k];
    if (!vals?.length || k === opts.skip) continue;   // skip: the card of that dim ignores its own filter (its rows stay visible)
    if (k === 'call_reason') {
      const real = vals.filter((v) => v !== '(no call)' && v !== '(no reason recorded)' && v !== '(null)');
      const noCall = vals.includes('(no call)'); const noReason = vals.includes('(no reason recorded)') || vals.includes('(null)');
      const parts: Frag[] = [];
      if (real.length) parts.push(sql`l.lead_id IN (SELECT c.lead_id FROM salesforce.lead_calls c WHERE c.last_reason IN ${sql(real)})`);
      if (noCall) parts.push(sql`NOT EXISTS (SELECT 1 FROM salesforce.lead_calls c WHERE c.lead_id = l.lead_id)`);
      if (noReason) parts.push(sql`EXISTS (SELECT 1 FROM salesforce.lead_calls c WHERE c.lead_id = l.lead_id AND c.last_reason IS NULL)`);
      c.push(parts.length === 1 ? parts[0]! : sql`(${parts.reduce((acc, p) => sql`${acc} OR ${p}`)})`);
      continue;
    }
    if (k === 'ic_status') {
      const real = vals.filter((v) => v !== '(null)');
      if (real.length) c.push(sql`l.lead_id IN (SELECT ic.lead_master__c FROM salesforce.interested_course__c ic WHERE NOT ic.isdeleted AND btrim(ic.status__c) IN ${sql(real)})`);
      continue;
    }
    if (k === 'ic_course') {
      const real = vals.filter((v) => v !== '(null)');
      if (real.length) c.push(icCourseIn(sql, 'l', real));
      continue;
    }
    if (isLeadDim(k)) {
      const col = LEAD_DIMS[k].col;
      if (LEAD_CONV_COLS.has(col)) c.push(inList(sql, 'l', col, vals));
      continue;
    }
    const col = FLAT_COLS[k as keyof typeof FLAT_COLS];
    if (col) touch.push(inList(sql, 't', col, vals));
  }
  if (f.paid_touch) touch.push(f.paid_touch === 'paid' ? sql`t.is_paid_touch = true` : sql`t.is_paid_touch IS NOT TRUE`);
  if (touch.length) c.push(sql`EXISTS (SELECT 1 FROM analytics.mv_touch_flat t WHERE t.lead_id = l.lead_id AND ${andAll(sql, touch)})`);
  return andAll(sql, c);
}

/** a value picked on the summary (dim=...&value=...) at lead grain */
function dimCond(sql: Sql, q: Record<string, string>, f?: Filters, p?: Period | null): Frag {
  const dim = q.dim; const value = q.value;
  if (!dim || value === undefined) return sql`true`;
  const blank = value === '(null)' || value === '(blank)';
  if (dim === 'conv_untouched') {
    // the never-touched part of the Overview's Total converted (value 'after') / Converted before the window ('before'): no touch on record and
    // the first valid payment (dashboard rule) on/after the lead's creation day and not before the window start / before the window start
    const fp = sql`(SELECT min(vp.payment_date) FROM analytics.v_valid_payment_x vp WHERE vp.phone_key = l.phone_key)`;
    const noTouch = sql`l.phone_valid AND NOT EXISTS (SELECT 1 FROM analytics.mv_touch_flat t WHERE t.lead_id = l.lead_id)`;
    const pp = f ? paymentPeriod(f) : null; const winFrom = pp?.from ?? p?.from ?? '1900-01-01';
    if (value === 'before') return sql`(${noTouch} AND ${fp} < ${winFrom})`;
    return pp ? sql`(${noTouch} AND ${fp} >= l.created_date AND ${fp} BETWEEN ${pp.from} AND ${pp.to})` : sql`(${noTouch} AND ${fp} >= l.created_date AND ${fp} >= ${winFrom})`;
  }
  if (dim === 'touched') {
    const ex = sql`EXISTS (SELECT 1 FROM analytics.mv_touch_flat t WHERE t.lead_id = l.lead_id)`;
    return value === 'Touched' ? ex : sql`NOT ${ex}`;
  }
  if (dim === 'call_reason') {
    if (value === '(no call)') return sql`NOT EXISTS (SELECT 1 FROM salesforce.lead_calls c WHERE c.lead_id = l.lead_id)`;
    if (value === '(no reason recorded)' || blank) return sql`EXISTS (SELECT 1 FROM salesforce.lead_calls c WHERE c.lead_id = l.lead_id AND c.last_reason IS NULL)`;
    return sql`l.lead_id IN (SELECT c.lead_id FROM salesforce.lead_calls c WHERE c.last_reason = ${value})`;
  }
  if (dim === 'ic_course') return icCourseIn(sql, 'l', [value]);
  if (dim === 'ic_status') {
    return blank
      ? sql`l.best_ic_status IS NULL`
      : sql`l.lead_id IN (SELECT ic.lead_master__c FROM salesforce.interested_course__c ic WHERE NOT ic.isdeleted AND btrim(ic.status__c) = ${value})`;
  }
  if (dim === 'course' || dim === 'grade') {
    const keyExpr = dim === 'course' ? sql`COALESCE(hp.course_label, analytics.course_label(b.title, b.course_title, COALESCE(hp.enrollment_batch_id, hp.batch_id)))` : sql`COALESCE(hp.grade_label, b.grade_title, 'No Grade On Batch')`;
    return sql`EXISTS (SELECT 1 FROM analytics.mv_user_phone up JOIN analytics.mv_payer m ON m.user_id = up.user_id JOIN analytics.v_payment_all hp ON hp.user_id = m.user_id LEFT JOIN app.core_batch b ON b.id = COALESCE(hp.enrollment_batch_id, hp.batch_id)
                       WHERE up.phone_key = l.phone_key AND ${VALID_ANY(sql)} AND ${keyExpr} = ${value})`;
  }
  const leadCol: Record<string, string> = { lead_stage: 'lead_stage', class_group: 'class_group', lead_source: 'lead_source', owner: 'owner_name', district: 'district', lm_reason: 'lm_reason', class_raw: 'class_raw', city: 'city' };
  if (leadCol[dim]) {
    const ref = sql`l.${sql(leadCol[dim]!)}`;
    return blank ? sql`(${ref} IS NULL OR ${ref}::text = ${value})` : sql`${ref}::text = ${value}`;
  }
  const tcol = FLAT_COLS[dim as keyof typeof FLAT_COLS];
  if (!tcol) throw Object.assign(new Error(`unknown dim ${dim}`), { status: 400 });
  const ref = sql`t.${sql(tcol)}`;
  return sql`EXISTS (SELECT 1 FROM analytics.mv_touch_flat t WHERE t.lead_id = l.lead_id AND ${blank ? sql`${ref} IS NULL` : sql`${ref}::text = ${value}`})`;
}

function searchCond(sql: Sql, raw: string): Frag {
  const s = raw.trim();
  if (!s) return sql`true`;
  const digits = s.replace(/\D/g, '');
  if (digits.length >= 5 && digits.length === s.length) return sql`l.mobile LIKE ${'%' + digits + '%'}`;
  if (/^a02[a-zA-Z0-9]{12,15}$/.test(s)) return sql`l.lead_id = ${s}`;
  if (/^LM-\d+$/i.test(s)) return sql`upper(l.lead_name) = ${s.toUpperCase()}`;
  const like = `%${s.toLowerCase()}%`;
  return sql`(lower(l.lead_name) LIKE ${like} OR lower(l.first_name) LIKE ${like} OR lower(l.last_name) LIKE ${like} OR lower(l.email) LIKE ${like})`;
}

function maskRow(r: Rec, role: Role): Rec {
  return { ...r, mobile: maskPhone(r.mobile as string | null, role), phone_key: maskPhone(r.phone_key as string | null, role), email: maskEmail(r.email as string | null, role), first_name: maskName(r.first_name as string | null, role), last_name: maskName(r.last_name as string | null, role) };
}

const SORTABLE: Record<string, string> = {
  created_date: 'created_at', lead_name: 'lead_name', lead_stage: 'lead_stage', class_raw: 'class_raw', lead_source: 'lead_source', owner_name: 'owner_name', district: 'district',
  n_touches_all: 'n_touches_all', last_touch_any: 'last_touch_any', converted_at: 'first_payment_date', last_payment_date: 'last_payment_date', revenue: 'revenue',
};
/** sort columns that live on the lead itself: page first, enrich the page only */
const LEAD_SORT = new Set(['created_at', 'lead_name', 'lead_stage', 'class_raw', 'lead_source', 'owner_name', 'district']);

const COLS = [
  'lead_id', 'lead_name', 'eps_id', 'first_name', 'last_name', 'mobile', 'email', 'lead_created_date', 'lead_source', 'lead_stage', 'lead_type', 'priority',
  'class_raw', 'class_group', 'district', 'city', 'owner_name', 'best_ic_status', 'lm_reason', 'is_duplicate',
  'n_touches_all', 'first_touch_any', 'last_touch_any', 'days_since_last_touch', 'touch_points',
  'converted', 'converted_at', 'last_payment_date', 'revenue', 'courses', 'sf_is_converted', 'sf_touch_count',
  'calls', 'first_call_at', 'last_call_at', 'last_call_reason', 'last_call_status',
];

function leadQuery(sql: Sql, f: Filters, p: Period, q: Record<string, string>, page: { limit: number; offset: number } | null) {
  const where = sql`${newLeadWhere(sql, f, p, { scope: q.scope })} AND ${dimCond(sql, q, f, p)} AND ${searchCond(sql, q.q ?? '')}`;
  const sortCol = SORTABLE[q.sort ?? ''] ?? 'created_at';
  const dir = q.dir === 'asc' ? sql`ASC NULLS FIRST` : sql`DESC NULLS LAST`;
  const base = sql`
    SELECT l.lead_id, l.lead_name, l.first_name, l.last_name, l.mobile, l.email, l.phone_key, l.created_at, l.created_date, l.lead_stage, l.class_raw, l.class_group,
           l.lead_source, l.lead_type, l.priority, l.owner_name, l.district, l.city, l.lm_reason, l.best_ic_status, l.is_duplicate, l.sf_is_converted, l.sf_touch_count
    FROM analytics.v_lead_lite l WHERE ${where}`;
  // touches (all dates) + the latest payer account on the phone
  const enrich = (src: Frag) => sql`
    SELECT s.*, ta.n_touches_all, ta.first_touch_any, ta.last_touch_any, ta.touch_points, ta.eps_id,
           pm.user_id AS payer_user_id, pm.first_payment_date, pm.last_payment_date, pm.revenue, pm.courses
    FROM (${src}) s
    LEFT JOIN LATERAL (SELECT count(*)::int AS n_touches_all, min(t.touch_at) AS first_touch_any, max(t.touch_at) AS last_touch_any,
                              string_agg(DISTINCT t.touch_point, ', ') AS touch_points, max(t.app_user_id)::int AS eps_id
                       FROM analytics.mv_touch_flat t WHERE t.lead_id = s.lead_id) ta ON true
    LEFT JOIN (SELECT DISTINCT ON (up.phone_key) up.phone_key, m.user_id, m.first_payment_date, m.last_payment_date, m.revenue, m.courses
               FROM analytics.mv_user_phone up JOIN analytics.mv_payer m ON m.user_id = up.user_id ORDER BY up.phone_key, m.last_payment_date DESC) pm ON pm.phone_key = s.phone_key`;
  const paged = (src: Frag) => sql`
    SELECT s.*, count(*) OVER ()::int AS total_rows FROM (${src}) s
    ORDER BY ${sql(sortCol)} ${dir}, lead_id
    ${page ? sql`LIMIT ${page.limit} OFFSET ${page.offset}` : sql``}`;
  const inner = LEAD_SORT.has(sortCol) ? enrich(paged(base)) : paged(enrich(base));
  return sql<Rec[]>`
    SELECT pg.lead_id, pg.lead_name,
           COALESCE(pg.eps_id, pg.payer_user_id, (SELECT min(up.user_id) FROM analytics.mv_user_phone up WHERE up.phone_key = pg.phone_key))::int AS eps_id, pg.first_name, pg.last_name, pg.mobile, pg.email,
           pg.created_date::text AS lead_created_date, pg.lead_source, pg.lead_stage, pg.lead_type, pg.priority, pg.class_raw, pg.class_group,
           pg.district, pg.city, pg.owner_name, pg.best_ic_status, pg.lm_reason, pg.is_duplicate, pg.sf_is_converted, pg.sf_touch_count,
           COALESCE(pg.n_touches_all, 0) AS n_touches_all, pg.first_touch_any::text AS first_touch_any, pg.last_touch_any::text AS last_touch_any,
           floor(EXTRACT(epoch FROM now() - pg.last_touch_any) / 86400)::int AS days_since_last_touch, pg.touch_points,
           (pg.payer_user_id IS NOT NULL) AS converted, pg.first_payment_date::text AS converted_at, pg.last_payment_date::text AS last_payment_date,
           pg.revenue::float8 AS revenue, pg.courses,
           lc.calls, lc.first_call_at::text AS first_call_at, lc.last_call_at::text AS last_call_at, lc.last_reason AS last_call_reason, lc.last_call_status,
           pg.total_rows
    FROM (${inner}) pg
    LEFT JOIN salesforce.lead_calls lc ON lc.lead_id = pg.lead_id
    ORDER BY pg.${sql(sortCol)} ${dir}, pg.lead_id`;
}

newLeads.get('/overview/new_leads', (c) =>
  handle(c, async ({ sql, f, periods, q, role }) => {
    const limit = intParam(q, 'limit', 50, 1, 200);
    const page = intParam(q, 'page', 1, 1, 100000);
    const rows = await leadQuery(sql, f, periods.current, q, { limit, offset: (page - 1) * limit });
    const total = rows.length ? (rows[0].total_rows as number) : 0;
    return { page, limit, total, rows: rows.map((r) => { const { total_rows: _t, ...rest } = maskRow(r, role); return rest; }), masked: role === 'viewer', columns: COLS };
  }, 0),
);

const SPLITS: { dim: string; label: string; kind: 'lead' | 'touch' | 'pay' }[] = [
  { dim: 'touched', label: 'Touched yet?', kind: 'lead' },
  { dim: 'lead_stage', label: 'Lead stage', kind: 'lead' }, { dim: 'class_group', label: 'Lead class', kind: 'lead' }, { dim: 'lead_source', label: 'Lead source', kind: 'lead' },
  { dim: 'owner', label: 'Owner', kind: 'lead' }, { dim: 'district', label: 'District', kind: 'lead' }, { dim: 'ic_status', label: 'IC status', kind: 'lead' }, { dim: 'lm_reason', label: 'LM reason', kind: 'lead' },
  { dim: 'call_reason', label: 'Last call reason', kind: 'lead' },
  { dim: 'touch_point', label: 'Touch point (any date)', kind: 'touch' }, { dim: 'source', label: 'Source (any date)', kind: 'touch' }, { dim: 'medium', label: 'Medium', kind: 'touch' },
  { dim: 'campaign', label: 'Campaign', kind: 'touch' }, { dim: 'staff', label: 'Staff', kind: 'touch' },
  { dim: 'grade', label: 'Purchased grade', kind: 'pay' }, { dim: 'course', label: 'Purchased course', kind: 'pay' },
];

newLeads.get('/overview/new_leads/summary', (c) =>
  handle(c, async ({ sql, f, periods, q }) => {
    const where = sql`${newLeadWhere(sql, f, periods.current, { scope: q.scope })} AND ${dimCond(sql, q, f, periods.current)} AND ${searchCond(sql, q.q ?? '')}`;
    const pp = paymentPeriod(f);
    const payWin = pp ? sql`AND hp.payment_date BETWEEN ${pp.from} AND ${pp.to}` : sql``;
    const rows = await sql<{ dim: string; key: string | null; leads: number; revenue: number | null }[]>`
      WITH sel AS (
        SELECT l.lead_id, l.phone_key, l.lead_stage, l.class_group, l.lead_source, l.owner_name, l.district, l.best_ic_status, l.lm_reason,
               EXISTS (SELECT 1 FROM analytics.mv_touch_flat t WHERE t.lead_id = l.lead_id) AS touched
        FROM analytics.v_lead_lite l WHERE ${where}),
      pay AS (
        SELECT DISTINCT ON (s.lead_id) s.lead_id, m.user_id, m.revenue
        FROM sel s JOIN analytics.mv_user_phone up ON up.phone_key = s.phone_key JOIN analytics.mv_payer m ON m.user_id = up.user_id
        ORDER BY s.lead_id, m.last_payment_date DESC)
      SELECT '_total' AS dim, NULL::text AS key, count(*)::int AS leads, NULL::float8 AS revenue FROM sel
      UNION ALL
      SELECT '_touched', NULL, count(*) FILTER (WHERE touched)::int, NULL FROM sel
      UNION ALL
      SELECT '_touches', NULL, (SELECT count(*) FROM analytics.mv_touch_flat t WHERE t.lead_id IN (SELECT lead_id FROM sel))::int, NULL
      UNION ALL
      SELECT '_payers', NULL, count(*)::int, sum(p.revenue)::float8 FROM pay p
      ${pp ? sql`WHERE EXISTS (SELECT 1 FROM analytics.v_payment_all hp WHERE hp.user_id = p.user_id AND ${VALID_ANY(sql)} ${payWin})` : sql``}
      UNION ALL
      SELECT d.dim, d.key, count(*)::int, NULL
      FROM sel s LEFT JOIN salesforce.lead_calls c ON c.lead_id = s.lead_id
      CROSS JOIN LATERAL (VALUES ('touched', CASE WHEN s.touched THEN 'Touched' ELSE 'No touch yet' END), ('lead_stage', s.lead_stage), ('class_group', s.class_group),
                                 ('lead_source', s.lead_source), ('owner', s.owner_name), ('district', s.district), ('ic_status', s.best_ic_status),
                                 ('lm_reason', s.lm_reason), ('call_reason', CASE WHEN c.lead_id IS NULL THEN '(no call)' WHEN c.last_reason IS NULL THEN '(no reason recorded)' ELSE c.last_reason END)) AS d(dim, key)
      GROUP BY d.dim, d.key
      UNION ALL
      SELECT d.dim, d.key, count(DISTINCT t.lead_id)::int, NULL
      FROM analytics.mv_touch_flat t JOIN sel s ON s.lead_id = t.lead_id
      CROSS JOIN LATERAL (VALUES ('touch_point', t.touch_point), ('source', t.source), ('medium', t.medium), ('campaign', t.campaign), ('staff', t.staff)) AS d(dim, key)
      GROUP BY d.dim, d.key
      UNION ALL
      SELECT d.dim, d.key, count(DISTINCT pay.lead_id)::int, sum(hp.amount)::float8
      FROM pay JOIN analytics.v_payment_all hp ON hp.user_id = pay.user_id LEFT JOIN app.core_batch b ON b.id = COALESCE(hp.enrollment_batch_id, hp.batch_id)
      CROSS JOIN LATERAL (VALUES ('course', COALESCE(hp.course_label, analytics.course_label(b.title, b.course_title, COALESCE(hp.enrollment_batch_id, hp.batch_id)))), ('grade', COALESCE(hp.grade_label, b.grade_title, 'No Grade On Batch'))) AS d(dim, key)
      WHERE ${VALID_ANY(sql)} ${payWin}
      GROUP BY d.dim, d.key`;
    const one = (dim: string) => rows.find((r) => r.dim === dim);
    const splits = SPLITS.map((s) => {
      const list = rows.filter((r) => r.dim === s.dim).map((r) => ({ key: r.key ?? '(blank)', leads: r.leads, revenue: r.revenue })).sort((a, b) => b.leads - a.leads);
      return { ...s, rows: list, distinct: list.length };   // every value: the table scrolls, nothing is cut off
    });
    return {
      mode: 'created', scope: q.scope === 'union' ? 'union' : 'created', leads: one('_total')?.leads ?? 0, touched: one('_touched')?.leads ?? 0, touches: one('_touches')?.leads ?? 0,
      payers: one('_payers')?.leads ?? 0, revenue: one('_payers')?.revenue ?? 0, payment_window: pp, splits,
    };
  }, 0),
);

newLeads.get('/overview/new_leads.csv', async (c) => {
  const q = c.req.query();
  const f = parseFilters(q);
  const periods = resolvePeriods(f);
  const role = c.get('user').role;
  const cap = Number.parseInt(c.env.EXPORT_ROW_CAP ?? '50000', 10) || 50000;
  return csvStream(c, { cols: COLS, cap, filename: `new_leads_${periods.current.from}_${periods.current.to}.csv`, mask: (r) => maskRow(r, role),
    fetchPage: (sql, limit, offset) => leadQuery(sql, f, periods.current, q, { limit, offset }) });
});
