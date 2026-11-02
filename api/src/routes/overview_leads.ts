import { Hono } from 'hono';
import type { Sql } from 'postgres';
import type { AppEnv, Role } from '../env';
import { handle, intParam, maskEmail, maskName, maskPhone, csvStream } from '../http';
import { parseFilters, resolvePeriods, icCourseIn, type Filters, type Frag, type Period } from '../filters';
import { flatWhere, FLAT_COLS, convCond, convFirstCond, tatBucket, activityBucket, activityDays } from './overview';
import { paymentPeriod } from '../filters';

/**
 * Drill-down for the Overview: the leads behind any KPI, bar, donut slice or table row.
 *   GET /api/overview/leads?metric=leads|touches|converted|converted_first|sf_converted|avg_alltime|avg_window
 *                          [&dim=touch_point&value=Eduport%20App] [&q=search] [&page&limit&sort&dir]
 *   GET /api/overview/leads.csv  (same params, streamed, capped by EXPORT_ROW_CAP)
 *   GET /api/overview/leads/summary (same params): the same leads split by purchased grade / course, stage, class, source, touch point ...
 * One row per lead; touch columns summarise that lead's touches inside the selection.
 * Two steps: (1) a light GROUP BY over the selection picks + sorts + pages the lead ids, (2) the page is enriched
 * per lead (lead_master join + a LATERAL aggregate over that lead's touches), so a 25k-lead list pages in well under a second.
 */
export const overviewLeads = new Hono<AppEnv>();

type Rec = Record<string, unknown>;
const METRICS = ['leads', 'touches', 'converted', 'first_touch', 'last_touch', 'stale_new', 'stale_not_connected', 'converted_first', 'converted_before', 'sf_converted', 'stage_conv_unpaid', 'paid_other_stage', 'stage_react', 'revised_new', 'avg_alltime', 'avg_window', 'fee_paid'] as const;
type Metric = (typeof METRICS)[number];

const SORTABLE: Record<string, string> = {
  lead_name: 'lead_name', created_date: 'lead_created_date', lead_stage: 'lead_stage', class_raw: 'class_raw', lead_source: 'lead_source',
  owner_name: 'owner_name', touches_in_window: 'touches_in_window', n_touches_all: 'n_touches_all', last_touch_in_window: 'last_touch_in_window',
  converted_at: 'converted_at', last_payment_date: 'last_payment_date', revenue: 'revenue', district: 'district',
};

const COLS = [
  'lead_id', 'lead_name', 'eps_id', 'first_name', 'last_name', 'mobile', 'email', 'lead_created_date', 'lead_source', 'lead_stage', 'lead_type', 'priority',
  'class_raw', 'class_group', 'district', 'city', 'owner_name', 'best_ic_status', 'lm_reason', 'is_duplicate',
  'touches_in_window', 'n_touches_all', 'first_touch_in_window', 'last_touch_in_window', 'last_touch_any', 'days_since_last_touch', 'touch_points', 'sources', 'staff',
  'tab_converted', 'first_touch_point', 'last_any_touch_point', 'last_touch_point', 'converted_first', 'converted', 'converted_at', 'last_payment_date', 'revenue', 'courses', 'sf_is_converted', 'sf_touch_count',
  'stage_since', 'touches_after_stage', 'calls', 'first_call_at', 'last_call_at', 'last_call_reason', 'last_call_status',
  'payments_in_range', 'fee_received', 'proposed_fee',
];

const VALID_PAY = (sql: Sql) => sql`hp.payment_method = 0 AND hp.deleted = false AND hp.is_success = true AND hp.payment_success = true`;

function dimCond(sql: Sql, q: Record<string, string>, f?: Filters, p?: Period | null): Frag {
  const dim = q.dim; const value = q.value;
  if (!dim || value === undefined) return sql`true`;
  if (dim === 'call_reason') {
    if (value === '(no call)') return sql`NOT EXISTS (SELECT 1 FROM salesforce.lead_calls c WHERE c.lead_id = t.lead_id)`;
    if (value === '(no reason recorded)' || value === '(null)') return sql`EXISTS (SELECT 1 FROM salesforce.lead_calls c WHERE c.lead_id = t.lead_id AND c.last_reason IS NULL)`;
    return sql`t.lead_id IN (SELECT c.lead_id FROM salesforce.lead_calls c WHERE c.last_reason = ${value})`;
  }
  if (dim === 'tat_created' || dim === 'tat_touch') {
    // turnaround band of a converted lead: first valid payment day minus the creation day / the latest touch day on or before the payment
    const days = dim === 'tat_created'
      ? sql`(t.converted_at - t.lead_created_date)`
      : sql`(t.converted_at - (SELECT max(t2.touch_date) FROM analytics.mv_touch_flat t2 WHERE t2.lead_id = t.lead_id AND t2.is_pre_conversion))`;
    return sql`(t.converted_at IS NOT NULL AND ${tatBucket(sql, days)} = ${value})`;
  }
  if (dim === 'ic_status') {
    return sql`t.lead_id IN (SELECT ic.lead_master__c FROM salesforce.interested_course__c ic WHERE NOT ic.isdeleted AND btrim(ic.status__c) = ${value})`;
  }
  if (dim === 'ic_course') return icCourseIn(sql, 't', [value]);
  if (dim === 'tat_activity') {
    // first touch -> first activity band (Overview Turnaround card; activity = first Task on the LM / its ICs on or after that touch, any later
    // date), evaluated once per lead of the selection
    const w = f ? flatWhere(sql, f, p ?? null) : sql`true`;
    return sql`t.lead_id IN (
      SELECT x.lead_id FROM (SELECT t.lead_id, min(t.touch_date) AS first_touch FROM analytics.mv_touch_flat t WHERE ${w} GROUP BY t.lead_id) x
      LEFT JOIN salesforce.lead_calls lc ON lc.lead_id = x.lead_id
      WHERE ${activityBucket(sql, activityDays(sql, sql`x.first_touch`))} = ${value})`;
  }
  if (dim === 'academic_year') {
    // academic year of the course of the lead's LATEST valid payment (same lookup as the Overview's conv_ay split); value = a year such as 2026-27,
    // or 'other:<year>,<year>,...' = every year NOT in that list (older years and '(no academic year)').
    // Evaluated ONCE PER CONVERTED LEAD of the selection (a semi-join), not per touch row: the per-row form with the lead lookup inside the
    // correlated subquery was planned badly and hit the 90 s statement timeout.
    const ay = sql`COALESCE((SELECT NULLIF(btrim(b.academic_year), '')
                             FROM analytics.v_valid_payment_x vp LEFT JOIN app.core_batch b ON b.id = vp.batch_id
                             WHERE vp.phone_key = m.phone_key AND NULLIF(btrim(b.academic_year), '') IS NOT NULL
                             ORDER BY vp.payment_date DESC, vp.payment_time DESC NULLS LAST, vp.payment_id DESC LIMIT 1), '(no academic year)')`;
    const w = f ? flatWhere(sql, f, p ?? null) : sql`true`;
    let test: Frag;
    if (value.startsWith('other:')) {
      const list = value.slice(6).split(',').map((x) => x.trim()).filter(Boolean);
      test = list.length ? sql`${ay} NOT IN ${sql(list)}` : sql`true`;
    } else test = sql`${ay} = ${value}`;
    return sql`(t.converted AND t.lead_id IN (
      SELECT x.lead_id FROM (SELECT DISTINCT t.lead_id FROM analytics.mv_touch_flat t WHERE ${w} AND t.converted) x
      JOIN analytics.mv_lead_lite m ON m.lead_id = x.lead_id WHERE ${test}))`;
  }
  if (dim === 'course' || dim === 'grade') {
    // purchased course / grade: any valid payment of the lead's app user on that batch
    const keyExpr = dim === 'course' ? sql`COALESCE(hp.course_label, analytics.course_label(b.title, b.course_title, COALESCE(hp.enrollment_batch_id, hp.batch_id)))` : sql`COALESCE(hp.grade_label, b.grade_title, 'No Grade On Batch')`;
    return sql`EXISTS (SELECT 1 FROM analytics.v_payment_all hp LEFT JOIN app.core_batch b ON b.id = COALESCE(hp.enrollment_batch_id, hp.batch_id)
                       WHERE hp.user_id = t.app_user_id AND ${VALID_PAY(sql)} AND ${keyExpr} = ${value})`;
  }
  const col = FLAT_COLS[dim as keyof typeof FLAT_COLS] ?? (dim === 'touch_date' ? 'touch_date' : undefined);
  if (!col) throw Object.assign(new Error(`unknown dim ${dim}`), { status: 400 });
  if (q.metric === 'stage_react' && ['touch_point', 'source', 'medium', 'campaign', 'staff'].includes(dim)) {
    const r3 = sql`t3.${sql(col)}`;
    return sql`EXISTS (SELECT 1 FROM analytics.mv_touch_flat t3 WHERE t3.lead_id = t.lead_id AND t3.touch_at > analytics.stage_since(t.lead_id, t.lead_stage, t.lead_created_date::timestamptz)
                       AND ${value === '(null)' ? sql`${r3} IS NULL` : sql`${r3}::text = ${value}`})`;
  }
  const ref = sql`t.${sql(col)}`;
  return value === '(null)' ? sql`${ref} IS NULL` : sql`${ref}::text = ${value}`;
}

function metricHaving(sql: Sql, metric: Metric, p: Period, f?: Filters, q: Record<string, string> = {}): Frag {
  const conv = f ? convCond(sql, f) : sql`t.tab_converted`;
  switch (metric) {
    case 'stale_new': case 'stale_not_connected': {
      const days = Math.max(1, Math.min(365, Number.parseInt(q.stale_days ?? '5', 10) || 5));
      const stage = metric === 'stale_new' ? 'New' : 'Not Connected';
      return sql`max(t.lead_stage) = ${stage} AND max(t.lead_created_date) <= (now() AT TIME ZONE 'Asia/Kolkata')::date - ${days}::int
        AND (SELECT x.last_touch_at FROM analytics.mv_lead_last_touch x WHERE x.lead_id = t.lead_id) < now() - make_interval(days => ${days})`;
    }
    case 'converted': return sql`bool_or(${conv})`;
    case 'first_touch': return sql`bool_or(t.tab_is_first_touch AND ${conv})`;
    case 'last_touch': return sql`bool_or(t.tab_is_last_touch AND ${conv})`;
    // Total converted: first valid payment on/after a touch AND not before the window start (same rule as the Overview KPI)
    case 'converted_first': return sql`bool_or(${f ? convFirstCond(sql, f) : sql`(t.converted AND t.is_pre_conversion)`} AND t.converted_at >= ${(f && paymentPeriod(f))?.from ?? p.from})`;
    // already a customer when the window started: first valid payment before the window start (payment window when it is on)
    case 'converted_before': return sql`bool_or(t.converted AND t.converted_at < ${(f && paymentPeriod(f))?.from ?? p.from})`;
    case 'sf_converted': return sql`bool_or(t.lead_sf_is_converted)`;
    case 'stage_conv_unpaid': return sql`max(t.lead_stage) = 'Converted' AND NOT bool_or(t.converted)`;
    case 'stage_react': return sql`max(t.lead_stage) IN ('Not Willing Now', 'Disqualified', 'Not Connected', 'P2 Completed')
        AND (SELECT x.last_touch_at FROM analytics.mv_lead_last_touch x WHERE x.lead_id = t.lead_id) > analytics.stage_since(t.lead_id, max(t.lead_stage), max(t.lead_created_date)::timestamptz)`;
    case 'paid_other_stage': return sql`bool_or(${conv}) AND max(t.lead_stage) IS DISTINCT FROM 'Converted'`;
    // Yet to connect (the Overview "yet_new" card): no contact on/after the lead's first touch in the selection: no call Task (call_days),
    // no Lead Stage change (New excepted), no IC status change (a course in status New excepted; Converted leads: calls only);
    // scope=new = still in New, scope=converted = Converted, scope=revised = any other stage
    case 'revised_new': {
      const scope = q.scope === 'new' ? sql`max(t.lead_stage) = 'New'` : q.scope === 'converted' ? sql`max(t.lead_stage) = 'Converted'`
        : q.scope === 'revised' ? sql`max(t.lead_stage) IS DISTINCT FROM 'New' AND max(t.lead_stage) IS DISTINCT FROM 'Converted'` : sql`true`;
      return sql`${scope}
        AND NOT EXISTS (SELECT 1 FROM salesforce.lead_calls lc, unnest(lc.call_days) AS d WHERE lc.lead_id = t.lead_id AND d >= min(t.touch_date))
        AND (max(t.lead_stage) IN ('New', 'Converted') OR NOT COALESCE((SELECT d.lm_since FROM analytics.mv_lead_decision d WHERE d.lead_id = t.lead_id) >= (min(t.touch_date)::timestamp AT TIME ZONE 'Asia/Kolkata'), false))
        AND (max(t.lead_stage) = 'Converted' OR NOT EXISTS (SELECT 1 FROM analytics.mv_ic_decision i WHERE i.lead_id = t.lead_id AND i.status <> 'New' AND i.ic_since >= (min(t.touch_date)::timestamp AT TIME ZONE 'Asia/Kolkata')))`;
    }
    case 'avg_alltime': case 'avg_window': return sql`bool_or(t.converted)`;
    case 'fee_paid': return sql`true`;   // the payment condition is part of the row selection (feeLeads)
    default: return sql`true`;
  }
}

function searchCond(sql: Sql, s: string): Frag {
  s = s.trim();
  if (!s) return sql`true`;
  const digits = s.replace(/\D/g, '');
  let inner: Frag;
  if (digits.length >= 5 && digits.length === s.length) inner = sql`l.mobile_number__c LIKE ${'%' + digits + '%'}`;
  else if (/^a02[a-zA-Z0-9]{12,15}$/.test(s)) inner = sql`l.id = ${s}`;
  else if (/^LM-\d+$/i.test(s)) inner = sql`upper(l.name) = ${s.toUpperCase()}`;
  else { const like = `%${s.toLowerCase()}%`; inner = sql`(lower(l.name) LIKE ${like} OR lower(l.first_name__c) LIKE ${like} OR lower(l.last_name__c) LIKE ${like} OR lower(l.email__c) LIKE ${like})`; }
  return sql`t.lead_id IN (SELECT l.id FROM salesforce.lead_master__c l WHERE ${inner})`;
}

function maskRow(r: Rec, role: Role): Rec {
  return { ...r, mobile: maskPhone(r.mobile as string | null, role), phone_key: maskPhone(r.phone_key as string | null, role), email: maskEmail(r.email as string | null, role), first_name: maskName(r.first_name as string | null, role), last_name: maskName(r.last_name as string | null, role) };
}

/** fee KPIs: the payment window = the payment-date window when it is on, else the main date range */
const feeWindow = (f: Filters, p: Period): Period => paymentPeriod(f) ?? p;

/** leads whose app accounts have a valid payment (payment_method 0) inside the fee window; built from the payments side (a few thousand rows) */
function feeLeads(sql: Sql, win: Period): Frag {
  return sql`t.lead_id IN (
    SELECT m.id
    FROM analytics.v_payment_all hp
    JOIN app.home_customuser u ON u.id = hp.user_id AND u.is_deleted = false
    CROSS JOIN LATERAL (VALUES (analytics.phone_key(u.phone)),
                               (CASE WHEN analytics.phone_key_valid(u.alternative_number) THEN analytics.phone_key(u.alternative_number) END)) AS v(pk)
    JOIN salesforce.lead_master__c m ON analytics.phone_key(m.mobile_number__c) = v.pk
    WHERE ${VALID_PAY(sql)} AND hp.payment_date BETWEEN ${win.from} AND ${win.to} AND v.pk IS NOT NULL)`;
}

/** the selection shared by the list, the CSV and the summary: touch-row condition + per-lead GROUP BY / HAVING */
function selection(sql: Sql, f: Filters, periods: { current: Period }, q: Record<string, string>) {
  const metric = (METRICS as readonly string[]).includes(q.metric ?? '') ? (q.metric as Metric) : 'leads';
  const w = flatWhere(sql, f, metric === 'avg_alltime' ? null : periods.current);
  const sel = sql`${w} AND ${dimCond(sql, q, f, metric === 'avg_alltime' ? null : periods.current)} AND ${searchCond(sql, q.q ?? '')}`;
  // pick = the condition that chooses the leads (evaluated once); sel alone is reused per lead for the touch columns
  const pick = metric === 'fee_paid' ? sql`${sel} AND ${feeLeads(sql, feeWindow(f, periods.current))}` : sel;
  const having = metricHaving(sql, metric, periods.current, f, q);
  return { metric, sel, pick, having };
}

/** the lead list; `page` null = no paging (export) */
function leadQuery(sql: Sql, f: Filters, periods: { current: Period }, q: Record<string, string>, page: { limit: number; offset: number } | null) {
  const { metric, sel, pick, having } = selection(sql, f, periods, q);
  const sortCol = SORTABLE[q.sort ?? ''] ?? (metric.startsWith('stale') ? 'last_touch_in_window' : 'touches_in_window');
  const dir = q.dir === 'asc' ? sql`ASC NULLS FIRST` : sql`DESC NULLS LAST`;
  return sql<Rec[]>`
    WITH sel AS (
      SELECT t.lead_id, count(*)::int AS touches_in_window, max(t.n_touches_all)::int AS n_touches_all,
             min(t.touch_at) AS first_touch_in_window, max(t.touch_at) AS last_touch_in_window,
             max(t.lead_name) AS lead_name, max(t.lead_created_date) AS lead_created_date, max(t.lead_stage) AS lead_stage, max(t.class_raw) AS class_raw,
             max(t.lead_source) AS lead_source, max(t.owner_name) AS owner_name, max(t.district) AS district,
             max(t.converted_at) AS converted_at, max(t.last_payment_date) AS last_payment_date, max(t.revenue) AS revenue
      FROM analytics.mv_touch_flat t
      WHERE ${pick}
      GROUP BY t.lead_id
      HAVING ${having}
    ),
    pg AS (
      SELECT sel.*, count(*) OVER ()::int AS total_rows FROM sel
      ORDER BY ${sql(sortCol)} ${dir}, lead_id
      ${page ? sql`LIMIT ${page.limit} OFFSET ${page.offset}` : sql``}
    )
    SELECT pg.lead_id, pg.lead_name,
           COALESCE(x.eps_id, (SELECT min(up.user_id) FROM analytics.mv_user_phone up WHERE up.phone_key = analytics.phone_key(l.mobile_number__c)))::int AS eps_id,
           l.first_name__c AS first_name, l.last_name__c AS last_name, l.mobile_number__c AS mobile, l.email__c AS email,
           pg.lead_created_date::text AS lead_created_date, pg.lead_source, pg.lead_stage, x.lead_type, x.priority, pg.class_raw, x.class_group,
           pg.district, x.city, pg.owner_name, x.best_ic_status, x.lm_reason, x.is_duplicate,
           pg.touches_in_window, pg.n_touches_all, pg.first_touch_in_window::text AS first_touch_in_window, pg.last_touch_in_window::text AS last_touch_in_window,
           la.last_touch_any::text AS last_touch_any, floor(EXTRACT(epoch FROM now() - la.last_touch_any) / 86400)::int AS days_since_last_touch,
           x.touch_points, x.sources, x.staff, x.tab_converted, x.first_touch_point, x.last_any_touch_point, x.last_touch_point, x.converted_first, x.converted,
           pg.converted_at::text AS converted_at, pg.last_payment_date::text AS last_payment_date, pg.revenue::float8 AS revenue, x.courses,
           x.sf_is_converted, x.sf_touch_count,
           ss.stage_since::text AS stage_since,
           (SELECT count(*)::int FROM analytics.mv_touch_flat t3 WHERE t3.lead_id = pg.lead_id AND t3.touch_at > ss.stage_since) AS touches_after_stage,
           lc.calls, lc.first_call_at::text AS first_call_at, lc.last_call_at::text AS last_call_at, lc.last_reason AS last_call_reason, lc.last_call_status,
           fp.payments_in_range, fp.fee_received, fp.proposed_fee,
           pg.total_rows
    FROM pg
    LEFT JOIN salesforce.lead_calls lc ON lc.lead_id = pg.lead_id
    JOIN LATERAL (SELECT analytics.stage_since(pg.lead_id, pg.lead_stage, pg.lead_created_date::timestamptz) AS stage_since) ss ON true
    JOIN salesforce.lead_master__c l ON l.id = pg.lead_id
    JOIN LATERAL (SELECT max(t2.touch_at) AS last_touch_any FROM analytics.mv_touch_flat t2 WHERE t2.lead_id = pg.lead_id) la ON true
    LEFT JOIN LATERAL (
      -- payments of the lead's app accounts inside the fee window; proposed fee = fee - discount, each enrollment once
      SELECT count(*)::int AS payments_in_range, COALESCE(sum(x.amount), 0)::float8 AS fee_received,
             COALESCE(sum(x.prop) FILTER (WHERE x.rn = 1), 0)::float8 AS proposed_fee
      FROM (SELECT hp.amount, hp.enrollment_fee - COALESCE(hp.enrollment_discount, 0) AS prop,
                   row_number() OVER (PARTITION BY COALESCE(hp.enrollment_id::text, 'p' || hp.id::text) ORDER BY hp.id) AS rn
            FROM analytics.mv_user_phone up JOIN analytics.v_payment_all hp ON hp.user_id = up.user_id
            WHERE up.phone_key = analytics.phone_key(l.mobile_number__c) AND ${VALID_PAY(sql)}
              AND hp.payment_date BETWEEN ${feeWindow(f, periods.current).from} AND ${feeWindow(f, periods.current).to}) x) fp ON true
    JOIN LATERAL (
      SELECT max(t.lead_type) AS lead_type, max(t.priority) AS priority, max(t.class_group) AS class_group, max(t.city) AS city,
             max(t.best_ic_status) AS best_ic_status,
             max(t.lm_reason) AS lm_reason, bool_or(t.is_duplicate) AS is_duplicate,
             string_agg(DISTINCT t.touch_point, ', ') AS touch_points, string_agg(DISTINCT t.source, ', ') AS sources,
             string_agg(DISTINCT t.staff, ', ') FILTER (WHERE t.staff IS NOT NULL) AS staff,
             bool_or(t.tab_converted) AS tab_converted, bool_or(t.converted AND t.is_pre_conversion) AS converted_first, bool_or(t.converted) AS converted,
             max(t.courses) AS courses,
             (array_agg(t.touch_point ORDER BY t.touch_at, t.touch_id))[1] AS first_touch_point,
             (array_agg(t.touch_point ORDER BY t.touch_at DESC, t.touch_id DESC))[1] AS last_any_touch_point,   -- the lead's latest touch of any kind (within the selection)   -- the lead's very first touch (within the selection), not the attribution window's selected first touch
             max(t.touch_point) FILTER (WHERE t.tab_is_last_touch) AS last_touch_point,
             bool_or(t.lead_sf_is_converted) AS sf_is_converted, max(t.sf_touch_count)::int AS sf_touch_count,
             max(t.app_user_id)::int AS eps_id
      FROM analytics.mv_touch_flat t WHERE t.lead_id = pg.lead_id AND ${sel}
    ) x ON true
    ORDER BY pg.${sql(sortCol)} ${dir}, pg.lead_id`;
}

overviewLeads.get('/overview/leads', (c) =>
  handle(c, async ({ sql, f, periods, q, role }) => {
    const limit = intParam(q, 'limit', 50, 1, 200);
    const page = intParam(q, 'page', 1, 1, 100000);
    const rows = await leadQuery(sql, f, periods, q, { limit, offset: (page - 1) * limit });
    const total = rows.length ? (rows[0].total_rows as number) : 0;
    return { page, limit, total, rows: rows.map((r) => { const { total_rows: _t, ...rest } = maskRow(r, role); return rest; }), masked: role === 'viewer', columns: COLS };
  }, 0),
);

const SPLITS: { dim: string; label: string; kind: 'lead' | 'touch' | 'pay' }[] = [
  { dim: 'grade', label: 'Purchased grade', kind: 'pay' }, { dim: 'course', label: 'Purchased course', kind: 'pay' },
  { dim: 'lead_stage', label: 'Lead stage', kind: 'lead' }, { dim: 'class_group', label: 'Lead class', kind: 'lead' }, { dim: 'lead_source', label: 'Lead source', kind: 'lead' },
  { dim: 'touch_point', label: 'Touch point', kind: 'touch' }, { dim: 'source', label: 'Source', kind: 'touch' }, { dim: 'medium', label: 'Medium', kind: 'touch' },
  { dim: 'call_reason', label: 'Last call reason', kind: 'lead' },
  { dim: 'owner', label: 'Owner', kind: 'lead' }, { dim: 'district', label: 'District', kind: 'lead' }, { dim: 'ic_status', label: 'IC status', kind: 'lead' }, { dim: 'lm_reason', label: 'LM reason', kind: 'lead' },
];

/** GET /overview/leads/summary : the selected leads split by purchase + lead + touch dimensions (for the drill drawer's overview) */
overviewLeads.get('/overview/leads/summary', (c) =>
  handle(c, async ({ sql, f, periods, q }) => {
    const { sel, pick, having } = selection(sql, f, periods, q);
    const pp = paymentPeriod(f);
    const payWin = pp ? sql`AND hp.payment_date BETWEEN ${pp.from} AND ${pp.to}` : sql``;
    // after-stage mode (re-touched KPI): every touch-level figure counts only touches AFTER the lead entered its current stage
    const afterStage = q.metric === 'stage_react';
    const touchJoin = afterStage ? sql`t.lead_id = s.lead_id AND t.touch_at > s.since` : sql`t.lead_id = s.lead_id AND ${sel}`;
    // One statement. The lead-level splits count the rows of sel (one per lead); only the touch-level splits re-read the touch rows.
    // The three after-stage figures (paid / called after the stage change, days to the first re-touch) and the stage moment itself are
    // computed only for the re-touched drill: the drawer shows them in that mode alone, and together they cost ~13 s of a 21 s statement
    // on a 28k-lead selection (a per-lead stage_since() call, a merge join over every call record, a correlated min() per lead).
    const rows = await sql<{ dim: string; key: string | null; leads: number; revenue: number | null }[]>`
      WITH sel AS (
        SELECT t.lead_id, max(t.app_user_id) AS app_user_id, max(t.revenue) AS revenue, count(*)::int AS touches_in_window,
               max(t.lead_stage) AS lead_stage, max(t.class_group) AS class_group, max(t.lead_source) AS lead_source, max(t.owner_name) AS owner,
               max(t.district) AS district, max(t.best_ic_status) AS ic_status, max(t.lm_reason) AS lm_reason,
               ${afterStage ? sql`analytics.stage_since(t.lead_id, max(t.lead_stage), max(t.lead_created_date)::timestamptz)` : sql`NULL::timestamptz`} AS since
        FROM analytics.mv_touch_flat t WHERE ${pick} GROUP BY t.lead_id HAVING ${having}
      )
      SELECT '_total' AS dim, NULL AS key, count(*)::int AS leads, sum(revenue)::float8 AS revenue FROM sel
      UNION ALL
      SELECT '_touches' AS dim, NULL AS key, ${afterStage
        ? sql`(SELECT count(*) FROM analytics.mv_touch_flat t JOIN sel s ON t.lead_id = s.lead_id AND t.touch_at > s.since)::int`
        : sql`sum(touches_in_window)::int`} AS leads, NULL::float8 AS revenue FROM sel
      ${afterStage ? sql`
      UNION ALL
      SELECT '_paid_after' AS dim, NULL AS key, count(*)::int AS leads,
             (SELECT sum(hp.amount) FROM sel s2 JOIN analytics.v_payment_all hp ON hp.user_id = s2.app_user_id WHERE ${VALID_PAY(sql)} AND hp.payment_date >= s2.since::date)::float8 AS revenue
      FROM sel s WHERE EXISTS (SELECT 1 FROM analytics.v_payment_all hp WHERE hp.user_id = s.app_user_id AND ${VALID_PAY(sql)} AND hp.payment_date >= s.since::date)
      UNION ALL
      SELECT '_called_after' AS dim, NULL AS key, count(*)::int AS leads, NULL::float8 AS revenue
      FROM sel s WHERE EXISTS (SELECT 1 FROM salesforce.lead_calls c WHERE c.lead_id = s.lead_id AND c.last_call_at > s.since)
      UNION ALL
      SELECT '_days_to_retouch' AS dim, NULL AS key, count(*)::int AS leads,
             avg(EXTRACT(epoch FROM x.first_after - x.since) / 86400)::float8 AS revenue
      FROM (SELECT s.since, min(t.touch_at) AS first_after FROM sel s JOIN analytics.mv_touch_flat t ON t.lead_id = s.lead_id AND t.touch_at > s.since GROUP BY s.lead_id, s.since) x` : sql``}
      UNION ALL
      SELECT '_payers' AS dim, NULL AS key, count(*)::int AS leads, NULL::float8 AS revenue FROM sel s
      WHERE EXISTS (SELECT 1 FROM analytics.v_payment_all hp WHERE hp.user_id = s.app_user_id AND ${VALID_PAY(sql)} ${payWin})
      UNION ALL
      -- lead-level splits: one row per lead in sel, so a plain count
      SELECT d.dim, d.key, count(*)::int AS leads, NULL::float8 AS revenue
      FROM sel s LEFT JOIN salesforce.lead_calls c ON c.lead_id = s.lead_id
      CROSS JOIN LATERAL (VALUES ('lead_stage', s.lead_stage), ('class_group', s.class_group), ('lead_source', s.lead_source),
                                 ('owner', s.owner), ('district', s.district), ('ic_status', s.ic_status), ('lm_reason', s.lm_reason),
                                 ('call_reason', CASE WHEN c.lead_id IS NULL THEN '(no call)' WHEN c.last_reason IS NULL THEN '(no reason recorded)' ELSE c.last_reason END)) AS d(dim, key)
      GROUP BY d.dim, d.key
      UNION ALL
      -- touch-level splits: the selection's touch rows (after-stage mode: only the touches after the stage change)
      SELECT d.dim, d.key, count(DISTINCT t.lead_id)::int AS leads, NULL::float8 AS revenue
      FROM analytics.mv_touch_flat t JOIN sel s ON ${touchJoin}
      CROSS JOIN LATERAL (VALUES ('touch_point', t.touch_point), ('source', t.source), ('medium', t.medium), ('campaign', t.campaign), ('staff', t.staff)) AS d(dim, key)
      GROUP BY d.dim, d.key
      UNION ALL
      SELECT p.dim, p.key, count(DISTINCT p.lead_id)::int AS leads, sum(p.amount)::float8 AS revenue
      FROM (
        SELECT s.lead_id, hp.amount, 'course' AS dim, COALESCE(hp.course_label, analytics.course_label(b.title, b.course_title, COALESCE(hp.enrollment_batch_id, hp.batch_id))) AS key
        FROM sel s JOIN analytics.v_payment_all hp ON hp.user_id = s.app_user_id LEFT JOIN app.core_batch b ON b.id = COALESCE(hp.enrollment_batch_id, hp.batch_id)
        WHERE ${VALID_PAY(sql)} ${payWin}
        UNION ALL
        SELECT s.lead_id, hp.amount, 'grade' AS dim, COALESCE(hp.grade_label, b.grade_title, 'No Grade On Batch') AS key
        FROM sel s JOIN analytics.v_payment_all hp ON hp.user_id = s.app_user_id LEFT JOIN app.core_batch b ON b.id = COALESCE(hp.enrollment_batch_id, hp.batch_id)
        WHERE ${VALID_PAY(sql)} ${payWin}
      ) p
      GROUP BY p.dim, p.key`;
    const total = rows.find((r) => r.dim === '_total');
    const touches = rows.find((r) => r.dim === '_touches');
    const payers = rows.find((r) => r.dim === '_payers');
    const paidAfter = rows.find((r) => r.dim === '_paid_after');
    const retouch = rows.find((r) => r.dim === '_days_to_retouch');
    const calledAfter = rows.find((r) => r.dim === '_called_after');
    const order = afterStage ? ['lead_stage', 'call_reason', 'touch_point', 'source', 'medium', 'campaign', 'staff', 'class_group', 'grade', 'course', 'lead_source', 'owner', 'district', 'ic_status', 'lm_reason'] : SPLITS.map((s) => s.dim);
    const splits = order.map((dim) => {
      const s = SPLITS.find((x) => x.dim === dim) ?? { dim, label: dim === 'campaign' ? 'Campaign' : 'Staff', kind: 'touch' as const };
      const list = rows.filter((r) => r.dim === s.dim).map((r) => ({ key: r.key ?? '(blank)', leads: r.leads, revenue: r.revenue })).sort((a, b) => b.leads - a.leads);
      const label = afterStage && s.kind === 'touch' ? `${s.label} · after the stage change` : afterStage && s.dim === 'lead_stage' ? 'Closed stage the lead sits in' : s.label;
      return { ...s, label, rows: list, distinct: list.length };   // every value: the table scrolls, nothing is cut off
    });
    return {
      mode: afterStage ? 'after_stage' : 'window', leads: total?.leads ?? 0, revenue: total?.revenue ?? 0, touches: touches?.leads ?? 0, payers: payers?.leads ?? 0, payment_window: pp, splits,
      paid_after: paidAfter?.leads ?? 0, paid_after_revenue: paidAfter?.revenue ?? 0, retouched: retouch?.leads ?? 0, avg_days_to_retouch: retouch?.revenue ?? null, called_after: calledAfter?.leads ?? 0,
    };
  }, 0),
);

overviewLeads.get('/overview/leads.csv', async (c) => {
  const q = c.req.query();
  const f = parseFilters(q);
  const periods = resolvePeriods(f);
  const role = c.get('user').role;
  const cap = Number.parseInt(c.env.EXPORT_ROW_CAP ?? '50000', 10) || 50000;
  return csvStream(c, { cols: COLS, cap, filename: `leads_${q.metric ?? 'leads'}_${periods.current.from}_${periods.current.to}.csv`, mask: (r) => maskRow(r, role),
    fetchPage: (sql, limit, offset) => leadQuery(sql, f, periods, q, { limit, offset }) });
});
