import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { handle, intParam } from '../http';
import { dimExpr, isLeadDim, isTouchDim, leadWhere, touchWhere, type Dim, icCourseExpr } from '../filters';
import { flatWhere, FLAT_COLS } from './overview';

export const filters = new Hono<AppEnv>();

/**
 * GET /api/filters?dim=lead_source&q=goo&limit=100&...all other filters
 * Cascading option list: counts are computed under every OTHER active filter
 * (the requested dim itself is skipped so already-selected values stay visible).
 */
filters.get('/filters', (c) =>
  handle(c, async ({ sql, f, periods, q }) => {
    const dim = q.dim;
    // Converted page's Class picker (2026-11-25): the core grade titles of the batches bought (app.core_batch.grade_title = production's
    // core_grade.title; Ujra bookings are "Integrated"), with the paying users of the date range (the page's range is the payment date).
    // Every grade on a batch is listed, also those with no payment in the range, so a selection never disappears from the list.
    if (dim === 'purchased_grade') {
      const p = periods.current;
      const rows = await sql<{ value: string; leads: number; converted: number }[]>`
        WITH paid AS (
          SELECT COALESCE(hp.grade_label, b.grade_title, 'No Grade On Batch') AS value, count(DISTINCT hp.user_id)::int AS users
          FROM analytics.v_payment_all hp LEFT JOIN app.core_batch b ON b.id = COALESCE(hp.enrollment_batch_id, hp.batch_id)
          WHERE hp.deleted = false AND hp.is_success = true AND hp.payment_success = true AND hp.payment_date BETWEEN ${p.from} AND ${p.to}
          GROUP BY 1),
        all_grades AS (SELECT DISTINCT grade_title AS value FROM app.core_batch WHERE grade_title IS NOT NULL UNION SELECT value FROM paid)
        SELECT a.value, COALESCE(paid.users, 0) AS leads, COALESCE(paid.users, 0) AS converted
        FROM all_grades a LEFT JOIN paid ON paid.value = a.value
        ${q.q?.trim() ? sql`WHERE lower(a.value) LIKE ${'%' + q.q.trim().toLowerCase() + '%'}` : sql``}
        ORDER BY 2 DESC, 1`;
      return { dim, options: rows };
    }
    if (!dim || !(isLeadDim(dim) || isTouchDim(dim))) {
      throw Object.assign(new Error(`unknown dim "${dim ?? ''}"`), { status: 400 });
    }
    const limit = intParam(q, 'limit', 100, 1, 5000);   // the pickers ask for everything
    const search = (q.q ?? '').trim().toLowerCase();
    const p = periods.current;
    const d = dim as Dim;

    if (d === 'ic_course') {
      const expr = icCourseExpr(sql);
      const rows = await sql<{ value: string; leads: number; converted: number }[]>`
        SELECT ${expr} AS value, count(DISTINCT t.lead_id)::int AS leads, count(DISTINCT t.lead_id) FILTER (WHERE t.tab_converted)::int AS converted
        FROM analytics.mv_touch_flat t
        JOIN salesforce.interested_course__c ic ON ic.lead_master__c = t.lead_id AND ic.isdeleted = false
        LEFT JOIN salesforce.course__c cr ON cr.id = ic.course__c
        WHERE ${flatWhere(sql, f, p, d)} AND ${expr} IS NOT NULL ${search ? sql`AND lower(${expr}) LIKE ${'%' + search + '%'}` : sql``}
        GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT ${limit}`;
      if (search && rows.length < 20) {
        // a search also looks outside the current filters / date range (every interested course ever recorded)
        const outside = await sql<{ value: string; leads: number }[]>`
          SELECT ${expr} AS value, count(DISTINCT ic.lead_master__c)::int AS leads
          FROM salesforce.interested_course__c ic LEFT JOIN salesforce.course__c cr ON cr.id = ic.course__c
          WHERE ic.isdeleted = false AND lower(${expr}) LIKE ${'%' + search + '%'} GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 500`;
        const seen = new Set(rows.map((r) => r.value));
        return { dim: d, options: [...rows, ...outside.filter((o) => !seen.has(o.value)).map((o) => ({ value: o.value, leads: 0, converted: 0, outside: true, leads_all: o.leads }))] };
      }
      return { dim: d, options: rows };
    }
    if (d === 'call_reason') {
      const rows = await sql<{ value: string; leads: number; converted: number }[]>`
        SELECT CASE WHEN c.lead_id IS NULL THEN '(no call)' WHEN c.last_reason IS NULL THEN '(no reason recorded)' ELSE c.last_reason END AS value, count(DISTINCT t.lead_id)::int AS leads, count(DISTINCT t.lead_id) FILTER (WHERE t.tab_converted)::int AS converted
        FROM analytics.mv_touch_flat t LEFT JOIN salesforce.lead_calls c ON c.lead_id = t.lead_id
        WHERE ${flatWhere(sql, f, p, d)} ${search ? sql`AND lower(CASE WHEN c.lead_id IS NULL THEN '(no call)' WHEN c.last_reason IS NULL THEN '(no reason recorded)' ELSE c.last_reason END) LIKE ${'%' + search + '%'}` : sql``}
        GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT ${limit}`;
      return { dim: d, options: rows };
    }
    // Fast path: dims that live on the precomputed touch table are answered from it (same filters as the Overview cards)
    const flatCol = FLAT_COLS[d as keyof typeof FLAT_COLS];
    if (flatCol) {
      const ref = sql`COALESCE(t.${sql(flatCol)}::text, '(null)')`;
      const rows = await sql<{ value: string; leads: number; converted: number }[]>`
        SELECT ${ref} AS value, count(DISTINCT t.lead_id)::int AS leads, count(DISTINCT t.lead_id) FILTER (WHERE t.tab_converted)::int AS converted
        FROM analytics.mv_touch_flat t
        WHERE ${flatWhere(sql, f, p, d)}
          ${search ? sql`AND lower(${ref}) LIKE ${'%' + search + '%'}` : sql`AND true`}
        GROUP BY 1 ORDER BY ${d === 'class_group' ? sql`min(analytics.class_group_order(t.class_group)), 1` : sql`2 DESC, 1`} LIMIT ${limit}`;
      // a search also looks OUTSIDE the current filters and date range, so a value that exists is never answered with "No options":
      // those matches come back flagged, with their all-time lead count and touch dates
      if (search && rows.length < 20) {
        const outside = await sql<{ value: string; leads: number; first_touch: string; last_touch: string }[]>`
          SELECT ${ref} AS value, count(DISTINCT t.lead_id)::int AS leads, min(t.touch_date)::text AS first_touch, max(t.touch_date)::text AS last_touch
          FROM analytics.mv_touch_flat t WHERE lower(${ref}) LIKE ${'%' + search + '%'}
          GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 500`;
        const seen = new Set(rows.map((r) => r.value));
        return { dim: d, options: [...rows, ...outside.filter((o) => !seen.has(o.value)).map((o) => ({ value: o.value, leads: 0, converted: 0, outside: true, leads_all: o.leads, first_touch: o.first_touch, last_touch: o.last_touch }))] };
      }
      return { dim: d, options: rows };
    }

    if (isLeadDim(d)) {
      const expr = dimExpr(sql, d, 'l');
      const rows = await sql<{ value: string; leads: number; converted: number }[]>`
        SELECT ${expr} AS value, count(*)::int AS leads, count(*) FILTER (WHERE l.converted)::int AS converted
        FROM analytics.v_lead_base l
        WHERE ${leadWhere(sql, f, p, { skip: d })}
          ${search ? sql`AND lower(${expr}) LIKE ${'%' + search + '%'}` : sql`AND true`}
        GROUP BY 1 ORDER BY ${d === 'class_group' ? sql`min(analytics.class_group_order(l.class_group)), 1` : sql`2 DESC, 1`} LIMIT ${limit}`;   // class groups in class order, others by size
      return { dim: d, options: rows };
    }
    const expr = dimExpr(sql, d, 't');
    const rows = await sql<{ value: string; leads: number; converted: number }[]>`
      SELECT ${expr} AS value, count(DISTINCT t.lead_id)::int AS leads,
             count(DISTINCT t.lead_id) FILTER (WHERE t.converted AND t.is_pre_conversion)::int AS converted
      FROM analytics.v_touch_base t
      WHERE ${touchWhere(sql, f, p, { skip: d })}
        ${search ? sql`AND lower(${expr}) LIKE ${'%' + search + '%'}` : sql`AND true`}
      GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT ${limit}`;
    return { dim: d, options: rows };
  }, 120),
);
