import { Hono } from 'hono';
import type { Sql } from 'postgres';
import type { AppEnv, Role } from '../env';
import { handle, intParam, maskEmail, maskName, maskPhone, csvStream } from '../http';
import { activeDimKeys, parseFilters, resolvePeriods, type Frag } from '../filters';
import { newLeadWhere } from './new_leads';

export const leads = new Hono<AppEnv>();

const SORTABLE: Record<string, string> = {
  created_at: 'created_at', lead_name: 'lead_name', lead_source: 'lead_source', lead_stage: 'lead_stage', class_group: 'class_group',
  owner_name: 'owner_name', total_touches: 'total_touches', valid_touches: 'valid_touches', converted_at: 'converted_at',
  revenue: 'revenue', days_to_convert: 'days_to_convert', first_touch_at: 'first_touch_at', last_touch_any_at: 'last_touch_any_at',
  response_hours: 'response_hours', district: 'district', priority: 'priority',
};

const LIST_COLS = sql_cols([
  'lead_id', 'lead_name', 'first_name', 'last_name', 'mobile', 'email', 'created_at', 'created_date', 'lead_source',
  'lead_stage', 'lead_type', 'priority', 'class_raw', 'class_group', 'district', 'city', 'owner_name', 'is_duplicate',
  'is_paid_lead', 'total_touches', 'valid_touches', 'touch_bucket', 'first_touch_at', 'first_touch_point', 'first_touch_source', 'last_touch_at',
  'last_touch_point', 'last_touch_any_at', 'response_hours', 'converted', 'converted_at', 'days_to_convert', 'pre_existing_customer', 'revenue',
  'payment_count', 'best_ic_status', 'lm_reason', 'sf_is_converted', 'sf_touch_count', 'is_open',
]);
function sql_cols(cols: string[]) { return cols; }

/** sort columns that live on the lead itself: page first, then enrich only the page */
const LEAD_SORT = new Set(['created_at', 'lead_name', 'lead_source', 'lead_stage', 'class_group', 'owner_name', 'district', 'priority']);
/** sort columns computed from the touches (the rest of SORTABLE comes from the payments) */
const TOUCH_SORT = new Set(['total_touches', 'valid_touches', 'first_touch_at', 'last_touch_any_at', 'response_hours']);

/**
 * The explorer list. It used to read analytics.v_lead_base, which recomputes every lead's touch history (window functions over
 * all touches) and payments on each call: ~40 s per page, enough to starve the database when several pages were open.
 * Now: leads from the light lead view, touches from the materialized touch table, payments from the valid-payment view.
 * `page` = { limit, offset }; offset 0 + a large limit serves the CSV export.
 */
function explorerQuery(sql: Sql, where: Frag, sortCol: string, dirIn: Frag, page: { limit: number; offset: number }, asc = false) {
  // creation time is never null: a plain ASC / DESC lets the newest-first page walk the creation-date index instead of sorting every lead
  const dir = sortCol === 'created_at' ? (asc ? sql`ASC` : sql`DESC`) : dirIn;

  // step 1: pick the page's lead ids on a narrow row (id + sort key). Only the side the sort needs is computed for every lead.
  let sortExpr: Frag; let sortJoin: Frag = sql``;
  if (LEAD_SORT.has(sortCol)) sortExpr = sql`l.${sql(sortCol)}`;
  else if (TOUCH_SORT.has(sortCol)) {
    sortJoin = sql`LEFT JOIN (SELECT t.lead_id, count(*)::int AS total_touches, count(*) FILTER (WHERE t.is_pre_conversion)::int AS valid_touches,
                                     min(t.touch_at) AS first_touch_at, max(t.touch_at) AS last_touch_any_at
                              FROM analytics.mv_touch_flat t GROUP BY t.lead_id) ta ON ta.lead_id = l.lead_id`;
    sortExpr = sortCol === 'total_touches' ? sql`COALESCE(ta.total_touches, 0)` : sortCol === 'valid_touches' ? sql`COALESCE(ta.valid_touches, 0)`
      : sortCol === 'response_hours' ? sql`EXTRACT(epoch FROM ta.first_touch_at - l.created_at)` : sql`ta.${sql(sortCol)}`;
  } else {
    sortJoin = sql`LEFT JOIN (SELECT vp.phone_key, min(vp.payment_date) AS converted_at, sum(vp.amount) AS revenue
                              FROM analytics.v_valid_payment_x vp WHERE vp.phone_key IS NOT NULL GROUP BY vp.phone_key) pay ON pay.phone_key = l.phone_key`;
    sortExpr = sortCol === 'revenue' ? sql`COALESCE(pay.revenue, 0)` : sortCol === 'days_to_convert' ? sql`(pay.converted_at - l.created_date)` : sql`pay.converted_at`;
  }
  const ids = sql`SELECT l.lead_id, ${sortExpr} AS sk FROM analytics.v_lead_conv l ${sortJoin} WHERE ${where}
                  ORDER BY sk ${dir}, l.lead_id LIMIT ${page.limit} OFFSET ${page.offset}`;

  // step 2: the page's rows, with touches and payments looked up per lead (index probes)
  const rows = sql`
    SELECT l.lead_id, l.lead_name, l.first_name, l.last_name, l.mobile, l.email, l.phone_key, l.created_at, l.created_date, l.lead_source, l.lead_stage,
           l.lead_type, l.priority, l.class_raw, l.class_group, l.district, l.city, l.owner_name, l.is_duplicate, l.is_paid_lead,
           l.best_ic_status, l.lm_reason, l.sf_is_converted, l.sf_touch_count
    FROM (${ids}) k JOIN analytics.v_lead_conv l ON l.lead_id = k.lead_id`;
  const inner = sql`
    SELECT s.*, COALESCE(ta.total_touches, 0) AS total_touches, COALESCE(ta.valid_touches, 0) AS valid_touches, analytics.touch_bucket(COALESCE(ta.valid_touches, 0)) AS touch_bucket,
           ta.first_touch_at, ta.first_touch_point, ta.first_touch_source, ta.last_touch_at, ta.last_touch_point, ta.last_touch_any_at,
           round((EXTRACT(epoch FROM ta.first_touch_at - s.created_at) / 3600)::numeric, 2) AS response_hours,
           (COALESCE(pay.payment_count, 0) > 0) AS converted, pay.converted_at, (pay.converted_at - s.created_date)::int AS days_to_convert,
           (pay.converted_at < s.created_date) AS pre_existing_customer, COALESCE(pay.revenue, 0) AS revenue, COALESCE(pay.payment_count, 0) AS payment_count,
           (COALESCE(pay.payment_count, 0) = 0 AND s.lead_stage NOT IN ('Converted', 'Disqualified')) AS is_open
    FROM (${rows}) s
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS total_touches, count(*) FILTER (WHERE t.is_pre_conversion)::int AS valid_touches,
             min(t.touch_at) AS first_touch_at, max(t.touch_at) FILTER (WHERE t.is_pre_conversion) AS last_touch_at, max(t.touch_at) AS last_touch_any_at,
             (array_agg(t.touch_point ORDER BY t.touch_at, t.touch_id))[1] AS first_touch_point, (array_agg(t.source ORDER BY t.touch_at, t.touch_id))[1] AS first_touch_source,
             (array_agg(t.touch_point ORDER BY t.touch_at DESC, t.touch_id DESC) FILTER (WHERE t.is_pre_conversion))[1] AS last_touch_point
      FROM analytics.mv_touch_flat t WHERE t.lead_id = s.lead_id) ta ON true
    LEFT JOIN LATERAL (
      SELECT min(vp.payment_date) AS converted_at, count(*)::int AS payment_count, sum(vp.amount) AS revenue
      FROM analytics.v_valid_payment_x vp WHERE vp.phone_key = s.phone_key) pay ON true`;
  return sql<Rec[]>`SELECT ${sql(LIST_COLS)} FROM (${inner}) x ORDER BY ${sql(sortCol)} ${dir}, lead_id`;
}

function searchCond(sql: Sql, q: string): Frag {
  const s = q.trim();
  if (!s) return sql`true`;
  const digits = s.replace(/\D/g, '');
  if (digits.length >= 10) return sql`l.phone_key = ${digits.slice(-10)}`;
  if (digits.length >= 5 && digits.length === s.length) return sql`l.phone_key LIKE ${'%' + digits}`;
  if (/^a02[a-zA-Z0-9]{12,15}$/.test(s)) return sql`l.lead_id = ${s}`;
  if (/^LM-\d+$/i.test(s)) return sql`upper(l.lead_name) = ${s.toUpperCase()}`;
  const like = `${s.toLowerCase()}%`;
  return sql`(lower(l.lead_name) LIKE ${like} OR lower(l.first_name) LIKE ${like} OR lower(l.email) LIKE ${like})`;
}

type Rec = Record<string, unknown>;
function maskRow(r: Rec, role: Role): Rec {
  return {
    ...r,
    mobile: maskPhone(r.mobile as string | null, role),
    phone_key: maskPhone(r.phone_key as string | null, role),
    email: maskEmail(r.email as string | null, role),
    first_name: maskName(r.first_name as string | null, role),
    last_name: maskName(r.last_name as string | null, role),
  };
}

/** GET /api/leads?page=1&limit=50&sort=created_at&dir=desc&q=... (+ all filters) */
leads.get('/leads', (c) =>
  handle(c, async ({ sql, f, periods, q, role }) => {
    const limit = intParam(q, 'limit', 50, 1, 200);
    const page = intParam(q, 'page', 1, 1, 100000);
    const sortCol = SORTABLE[q.sort ?? ''] ?? 'created_at';
    const dir = q.dir === 'asc' ? sql`ASC NULLS FIRST` : sql`DESC NULLS LAST`;
    // the explorer is not limited by the date window: every lead in the replica, narrowed by the filter pickers and the search box
    void periods;
    const where = sql`${newLeadWhere(sql, f, null, { validPay: true })} AND ${searchCond(sql, q.q ?? '')}`;
    // no filter, no search: count on the base table
    const plain = !(q.q ?? '').trim() && activeDimKeys(f).length === 0 && !f.converted && !f.paid && !f.paid_touch;
    const countQ = plain
      ? sql<{ n: number }[]>`SELECT count(*)::int AS n FROM salesforce.lead_master__c l WHERE COALESCE(l.is_deleted__c, false) = false AND COALESCE(l.isdeleted, false) = false ${f.dups !== '1' ? sql`AND COALESCE(l.is_duplicate__c, false) = false` : sql``}`
      : sql<{ n: number }[]>`SELECT count(*)::int AS n FROM analytics.v_lead_conv l WHERE ${where}`;
    const [rows, [tot]] = await Promise.all([
      explorerQuery(sql, where, sortCol, dir, { limit, offset: (page - 1) * limit }, q.dir === 'asc'),
      countQ,
    ]);
    return { page, limit, total: tot.n, rows: rows.map((r) => maskRow(r, role)), masked: role === 'viewer' };
  }, 0),
);

/** GET /api/leads/:id : full lead + touch timeline + ICs + payments + calls */
// the id pattern keeps this route from swallowing /leads/export.csv (registered below)
leads.get('/leads/:id{[a-zA-Z0-9]+}', (c) =>
  handle(c, async ({ sql, role }) => {
    const id = c.req.param('id');
    if (!/^[a-zA-Z0-9]{15,18}$/.test(id)) throw Object.assign(new Error('bad lead id'), { status: 400 });
    // One lead = indexed lookups only. v_lead_base / v_touch_base recompute aggregates over EVERY lead and touch before
    // filtering, which took 30-80 s on the throttled database; here each statement touches only this lead's rows.
    // the lead's phone key and first valid payment, as fragments, so all six statements can run at the same time
    const pk = sql`(SELECT analytics.phone_key(mobile_number__c) FROM salesforce.lead_master__c WHERE id = ${id} AND analytics.phone_key_valid(mobile_number__c))`;
    const convAt = sql`(SELECT min(vp.payment_date) FROM analytics.v_valid_payment_x vp WHERE vp.phone_key = ${pk})`;
    const leadQ = sql<Rec[]>`
      WITH l AS (
        SELECT l.id AS lead_id, l.name AS lead_name, l.createddate AS created_at, analytics.ist_date(l.createddate) AS created_date,
               l.first_name__c AS first_name, l.last_name__c AS last_name, l.mobile_number__c AS mobile, l.email__c AS email,
               analytics.phone_key(l.mobile_number__c) AS phone_key, analytics.phone_key_valid(l.mobile_number__c) AS phone_valid,
               l.class__c AS class_raw, analytics.class_group(l.class__c) AS class_group,
               COALESCE(NULLIF(btrim(l.lead_source__c), ''), '(blank)') AS lead_source,
               COALESCE(NULLIF(btrim(l.lead_stage__c), ''), '(blank)') AS lead_stage, l.lead_type__c AS lead_type, l.priority__c AS priority,
               l.district__c AS district, l.city__c AS city, l.ownerid AS owner_id, COALESCE(u.name, l.ownerid::text) AS owner_name,
               l.touch_count__c AS sf_touch_count, COALESCE(l.is_converted__c, false) AS sf_is_converted, l.best_ic_status__c AS best_ic_status,
               COALESCE(l.is_duplicate__c, false) AS is_duplicate, l.parent_lead_master__c AS parent_lead_id, l.lm_reason__c AS lm_reason
        FROM salesforce.lead_master__c l LEFT JOIN salesforce."user" u ON u.id::text = l.ownerid::text
        WHERE l.id = ${id} AND COALESCE(l.is_deleted__c, false) = false AND COALESCE(l.isdeleted, false) = false),
      p AS (
        SELECT min(vp.payment_date) AS converted_at, count(*)::int AS payment_count, COALESCE(sum(vp.amount), 0)::float8 AS revenue,
               max(vp.payment_date) AS last_payment_date, min(vp.user_id)::int AS app_user_id
        FROM l JOIN analytics.v_valid_payment_x vp ON vp.phone_key = l.phone_key AND l.phone_valid),
      t AS (
        SELECT count(*)::int AS total_touches, count(*) FILTER (WHERE m.is_pre_conversion)::int AS valid_touches,
               min(m.touch_at) AS first_touch_at, max(m.touch_at) AS last_touch_any_at
        FROM analytics.mv_touch_flat m WHERE m.lead_id = ${id}),
      -- EPS ID = the app account on the lead's phone or alternative number (the paying account first, else any account, as on the Analysis page)
      a AS (SELECT min(cu.user_id)::int AS acct_user_id FROM l JOIN analytics.mv_user_phone cu ON cu.phone_key = l.phone_key AND l.phone_valid)
      SELECT l.*, (p.payment_count > 0) AS converted, p.converted_at::text, p.payment_count, p.revenue, p.last_payment_date::text, p.app_user_id,
             COALESCE(p.app_user_id, a.acct_user_id) AS eps_id,
             (p.converted_at - l.created_date) AS days_to_convert, (p.converted_at < l.created_date) AS pre_existing_customer,
             t.total_touches, t.valid_touches, t.first_touch_at::text, t.last_touch_any_at::text
      FROM l CROSS JOIN p CROSS JOIN t CROSS JOIN a`;
    const [leadRows, touches, ics, payments, calls, siblings] = await Promise.all([
      leadQ,
      // this lead's touches straight from the touch table (index on lead + date); sequence, gaps and credits computed over these rows only
      sql<Rec[]>`
        WITH c AS (SELECT ${convAt} AS converted_at),
        t AS (
          SELECT t.id AS touch_id, t.touch_date__c AS touch_at, analytics.ist_date(t.touch_date__c) AS touch_date,
                 COALESCE(NULLIF(btrim(t.touch_point__c), ''), '(blank)') AS touch_point, COALESCE(NULLIF(btrim(t.source__c), ''), '(blank)') AS source,
                 COALESCE(NULLIF(btrim(t.medium__c), ''), '(blank)') AS medium, COALESCE(NULLIF(btrim(t.campaign__c), ''), '(blank)') AS campaign,
                 t.adset_name__c AS adset_name, t.ad_name__c AS ad_name, t.platform_id__c AS platform_id, NULLIF(btrim(t.staff__c), '') AS staff,
                 t.is_first_touch__c AS sf_is_first_touch, t.is_last_touch__c AS sf_is_last_touch, COALESCE(t.is_converted__c, false) AS sf_is_converted,
                 COALESCE(t.was_customer_at_touch__c, false) AS sf_was_customer_at_touch, t.ic_status__c AS ic_status, t.ic_course__c AS touch_ic_course,
                 analytics.is_paid_touch(t.touch_point__c, t.source__c, t.medium__c) AS is_paid_touch,
                 (c.converted_at IS NULL OR analytics.ist_date(t.touch_date__c) <= c.converted_at) AS is_pre_conversion,
                 (c.converted_at IS NOT NULL) AS converted
          FROM salesforce.lead_touch__c t CROSS JOIN c
          WHERE t.lead_master__c = ${id} AND t.isdeleted = false AND t.touch_date__c IS NOT NULL),   -- isdeleted = false matches the partial index lead_touch_lead_date; COALESCE() would not
        s AS (
          SELECT t.*, row_number() OVER w AS touch_seq_all, lag(touch_at) OVER w AS prev_touch_at,
                 CASE WHEN is_pre_conversion THEN row_number() OVER (PARTITION BY is_pre_conversion ORDER BY touch_at, touch_id) END AS touch_seq,
                 CASE WHEN is_pre_conversion THEN count(*) OVER (PARTITION BY is_pre_conversion) END AS n_pre_touches
          FROM t WINDOW w AS (ORDER BY touch_at, touch_id))
        SELECT touch_id, touch_at::text, touch_date::text, touch_point, source, medium, campaign, adset_name, ad_name, platform_id, staff,
               is_pre_conversion, touch_seq::int, touch_seq_all::int, (touch_seq = 1) AS is_first_touch, (touch_seq = n_pre_touches) AS is_last_touch,
               round((EXTRACT(epoch FROM touch_at - prev_touch_at) / 3600)::numeric, 2)::float8 AS gap_hours_from_prev,
               analytics.gap_bucket((EXTRACT(epoch FROM touch_at - prev_touch_at) / 3600)::numeric) AS gap_bucket,
               CASE WHEN converted AND is_pre_conversion AND touch_seq = 1 THEN 1.0 ELSE 0 END::float8 AS credit_first,
               CASE WHEN converted AND is_pre_conversion AND touch_seq = n_pre_touches THEN 1.0 ELSE 0 END::float8 AS credit_last,
               CASE WHEN converted AND is_pre_conversion THEN 1.0 / n_pre_touches ELSE 0 END::float8 AS credit_linear,
               CASE WHEN converted AND is_pre_conversion THEN
                      CASE WHEN n_pre_touches = 1 THEN 1.0 WHEN n_pre_touches = 2 THEN 0.5
                           WHEN touch_seq = 1 OR touch_seq = n_pre_touches THEN 0.4 ELSE 0.2 / (n_pre_touches - 2) END
                    ELSE 0 END::float8 AS credit_position,
               sf_is_first_touch, sf_is_last_touch, sf_is_converted, sf_was_customer_at_touch, ic_status, touch_ic_course, is_paid_touch
        FROM s ORDER BY touch_at, touch_id`,
      // interested courses straight from the table: the partial index interested_course_lead needs isdeleted = false (v_ic_base uses COALESCE and scans)
      sql<Rec[]>`SELECT ic.id AS ic_id, COALESCE(NULLIF(ic.course_name__c, ''), cr.name, ic.course__c) AS course_name,
                        COALESCE(NULLIF(btrim(ic.status__c), ''), '(blank)') AS status, COALESCE(ic.is_enrolled__c, false) AS is_enrolled, ic.createddate::text AS ic_created_at
                 FROM salesforce.interested_course__c ic LEFT JOIN salesforce.course__c cr ON cr.id = ic.course__c
                 WHERE ic.lead_master__c = ${id} AND ic.isdeleted = false ORDER BY ic.createddate`,
      // every successful payment of the accounts on this number (any payment method, app + Ujra). counted = the dashboard's conversion rule
      // (payment_method 0); the other methods are shown so the lead's payment history is complete, e.g. a renewal paid through method 1
      sql<Rec[]>`SELECT vp.payment_id, vp.payment_date::text, COALESCE(b.course_title, vp.course_label) AS course,
                            COALESCE(b.title, CASE WHEN vp.source = 'ujra' THEN 'Ujra (' || vp.matched_by || ')' END) AS batch, vp.source,
                            CASE WHEN vp.source = 'ujra' THEN 'ujra' WHEN vp.payment_method = 0 THEN 'app' ELSE 'app method ' || vp.payment_method::text END AS method,
                            (vp.payment_method = 0) AS counted,
                            vp.amount::float8, vp.total::float8, hp.discount::float8, hp.refund_amount::float8,
                            vp.payment_time::text, hp.course_new_id, vp.batch_id, hp.sales_person_id, vp.enrollment_id, vp.payment_type
                     FROM analytics.v_paid_any_x vp
                     LEFT JOIN app.home_payment hp ON vp.source = 'app' AND hp.id = vp.payment_id
                     LEFT JOIN app.core_batch b ON b.id = vp.batch_id
                     WHERE vp.phone_key = ${pk} ORDER BY vp.payment_date, vp.payment_id LIMIT 100`,
      // per-lead call summary (salesforce.lead_calls, reduced from the Salesforce call log since May 2026)
      sql<Rec[]>`SELECT c.calls, c.first_call_at::text AS first_call_at, c.last_call_at::text AS last_call_at, c.last_reason, c.last_comment, c.last_call_status, c.last_subject, u.name AS last_owner
                 FROM salesforce.lead_calls c LEFT JOIN salesforce."user" u ON u.id = c.last_owner_id WHERE c.lead_id = ${id}`,
      // other leads of the same person: on this number, or on any other number of the app / Ujra accounts that carry this number
      // (alternative number, Ujra numbers). matched_on says which number; converted is per lead's own number.
      sql<Rec[]>`WITH keys AS (
                       SELECT ${pk}::text AS phone_key, 'same number'::text AS matched_on
                       UNION
                       SELECT up2.phone_key, up2.kind FROM analytics.mv_user_phone up JOIN analytics.mv_user_phone up2 ON up2.user_id = up.user_id
                       WHERE up.phone_key = ${pk} AND up2.phone_key <> ${pk})
                     SELECT l.id AS lead_id, l.name AS lead_name, analytics.ist_date(l.createddate)::text AS created_date,
                            COALESCE(NULLIF(btrim(l.lead_source__c), ''), '(blank)') AS lead_source, COALESCE(NULLIF(btrim(l.lead_stage__c), ''), '(blank)') AS lead_stage,
                            COALESCE(l.is_duplicate__c, false) AS is_duplicate,
                            EXISTS (SELECT 1 FROM analytics.v_valid_payment_x vp WHERE vp.phone_key = k.phone_key) AS converted,
                            l.mobile_number__c AS mobile, k.matched_on
                     FROM keys k JOIN salesforce.lead_master__c l ON analytics.phone_key(l.mobile_number__c) = k.phone_key
                     WHERE l.id <> ${id} AND COALESCE(l.is_deleted__c, false) = false AND COALESCE(l.isdeleted, false) = false
                     ORDER BY l.createddate LIMIT 20`,
    ]);
    const lead = leadRows[0];
    if (!lead) throw Object.assign(new Error('lead not found'), { status: 404 });
    const l = maskRow(lead, role);
    for (const s of siblings) s.mobile = maskPhone(s.mobile as string | null, role);
    return { lead: l, touches, ics, payments, calls: [] as Rec[], call_summary: calls[0] ?? null, siblings, masked: role === 'viewer' };
  }, 0),
);

/** GET /api/leads/export.csv : streamed CSV of the current explorer view (capped) */
leads.get('/leads/export.csv', async (c) => {
  const q = c.req.query();
  const f = parseFilters(q);
  const periods = resolvePeriods(f);
  const role = c.get('user').role;
  const cap = Number.parseInt(c.env.EXPORT_ROW_CAP ?? '50000', 10) || 50000;
  const sortCol = SORTABLE[q.sort ?? ''] ?? 'created_at';
  const asc = q.dir === 'asc';
  return csvStream(c, { cols: LIST_COLS, cap, filename: `leads_${periods.current.from}_${periods.current.to}.csv`, mask: (r) => maskRow(r, role),
    fetchPage: (sql, limit, offset) => explorerQuery(sql, sql`${newLeadWhere(sql, f, null, { validPay: true })} AND ${searchCond(sql, q.q ?? '')}`, sortCol, asc ? sql`ASC NULLS FIRST` : sql`DESC NULLS LAST`, { limit, offset }, asc) });
});
