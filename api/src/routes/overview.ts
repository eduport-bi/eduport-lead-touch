import { Hono } from 'hono';
import type { Sql } from 'postgres';
import type { AppEnv } from '../env';
import { handle, pct, timedAll } from '../http';
import { LIST_KEYS, paymentPeriod, icCourseExpr, icCourseIn, type Filters, type Frag, type Period } from '../filters';
import { newLeadWhere } from './new_leads';

/**
 * GET /api/overview  - everything on the Tableau "Lead Touch - Overview" dashboard in one call.
 * Grain = TOUCH, exactly like the workbook (Lead_Touch__c LEFT JOIN Lead_Master__c ... payments):
 *   Total leads        = COUNTD(lead)                    over touches in the window
 *   Total lead touches = COUNTD(touch)                   over touches in the window
 *   Converted          = COUNTD(lead) where the lead has ANY valid payment dated on/after the touch day
 *   Avg touches before conversion = AVG over touch rows of converted leads of {FIXED lead: COUNTD(touch)} (all-time touch count)
 *                        - KPI 1 has no date filter in the workbook, KPI 2 ("date-wise") has the touch-date filter
 * Reads only analytics.mv_touch_flat (+ interested courses for the IC funnel).
 */
export const overview = new Hono<AppEnv>();

/** filter key -> column on mv_touch_flat */
export const FLAT_COLS: Partial<Record<(typeof LIST_KEYS)[number], string>> = {
  lead_source: 'lead_source', lead_stage: 'lead_stage', class_group: 'class_group', class_raw: 'class_raw', district: 'district', city: 'city',
  priority: 'priority', lead_type: 'lead_type', owner: 'owner_name', ic_status: 'best_ic_status',
  lm_reason: 'lm_reason', source: 'source', medium: 'medium', touch_point: 'touch_point', campaign: 'campaign', staff: 'staff',
};

/** "Converted" for the current filters: workbook rule (any valid payment on/after the touch day), or - when the
 *  payment-date window is switched on - a valid payment dated inside that window and on/after the touch day. */
// "Yet to connect (New)" (card, replaced the two revised funnels on 2026-10-31): a lead touched with no contact since is yet to connect, whatever
// its stage (Converted included since 2026-11-02: a lead that bought, was touched again and nobody contacted is yet to connect too). Contact = a call Task (salesforce.lead_calls.call_days, the Turnaround card's activity) OR a Lead Stage change
// OR an Interested Course status change (mv_lead_decision.lm_since / mv_ic_decision.ic_since, sql/045) on/after the lead's FIRST touch IN THE
// SELECTION (filters decide: campaign filter = that campaign's touch).

export function convCond(sql: Sql, f: Filters): Frag {
  const pp = paymentPeriod(f);
  if (!pp) return sql`t.tab_converted`;
  return sql`EXISTS (SELECT 1 FROM analytics.v_payment_all hp WHERE hp.user_id = t.app_user_id AND hp.payment_method = 0 AND hp.deleted = false
                     AND hp.is_success = true AND hp.payment_success = true AND hp.payment_date BETWEEN ${pp.from} AND ${pp.to}
                     AND hp.payment_date >= t.touch_date)`;   // still on/after the touch day, as in the workbook
}
/** first valid payment on/after a touch (brief definition), within the payment window when it is on */
export function convFirstCond(sql: Sql, f: Filters): Frag {
  const pp = paymentPeriod(f);
  return pp ? sql`(t.converted AND t.is_pre_conversion AND t.converted_at BETWEEN ${pp.from} AND ${pp.to})` : sql`(t.converted AND t.is_pre_conversion)`;
}

/** main window: basis=created -> leads created in the range (all their touches); otherwise touches dated in the range */
/** `skip` = a list dim to ignore (option lists cascade from every OTHER filter) */
export function flatWhere(sql: Sql, f: Filters, p: Period | null, skip?: string): Frag {
  const c: Frag[] = [];
  if (p) c.push(f.basis === 'created' ? sql`t.lead_created_date BETWEEN ${p.from} AND ${p.to}` : sql`t.touch_date BETWEEN ${p.from} AND ${p.to}`);
  if (f.dups !== '1') c.push(sql`t.is_duplicate = false`);
  if (f.converted === '1') c.push(sql`${convCond(sql, f)}`);
  if (f.converted === '0') c.push(sql`NOT ${convCond(sql, f)}`);
  if (f.paid) c.push(f.paid === 'paid' ? sql`t.is_paid_lead = true` : sql`t.is_paid_lead IS NOT TRUE`);
  if (f.paid_touch) c.push(f.paid_touch === 'paid' ? sql`t.is_paid_touch = true` : sql`t.is_paid_touch IS NOT TRUE`);
  for (const k of LIST_KEYS) {
    const col = FLAT_COLS[k]; const vals = f[k];
    if (!vals?.length || k === skip) continue;
    if (!col && k !== 'call_reason' && k !== 'ic_course') continue;
    if (k === 'call_reason') {
      // reason recorded on the lead's LAST call (salesforce.lead_calls); '(no call)' = no call logged since May 2026,
      // '(no reason recorded)' = the last call exists but its Reason field is empty
      const real = vals.filter((v) => v !== '(no call)' && v !== '(no reason recorded)' && v !== '(null)');
      const noCall = vals.includes('(no call)'); const noReason = vals.includes('(no reason recorded)') || vals.includes('(null)');
      const parts: Frag[] = [];
      if (real.length) parts.push(sql`t.lead_id IN (SELECT c.lead_id FROM salesforce.lead_calls c WHERE c.last_reason IN ${sql(real)})`);
      if (noCall) parts.push(sql`NOT EXISTS (SELECT 1 FROM salesforce.lead_calls c WHERE c.lead_id = t.lead_id)`);
      if (noReason) parts.push(sql`EXISTS (SELECT 1 FROM salesforce.lead_calls c WHERE c.lead_id = t.lead_id AND c.last_reason IS NULL)`);
      c.push(parts.length === 1 ? parts[0]! : sql`(${parts.reduce((acc, p) => sql`${acc} OR ${p}`)})`);
      continue;
    }
    if (k === 'ic_course') {
      // any interested course of the lead with one of these course names
      const real = vals.filter((v) => v !== '(null)');
      if (real.length) c.push(icCourseIn(sql, 't', real));
      continue;
    }
    if (k === 'ic_status') {
      // same source as the IC-status funnel: any interested course of the lead in one of these statuses
      const real = vals.filter((v) => v !== '(null)');
      if (real.length) c.push(sql`t.lead_id IN (SELECT ic.lead_master__c FROM salesforce.interested_course__c ic WHERE NOT ic.isdeleted AND btrim(ic.status__c) IN ${sql(real)})`);
      continue;
    }
    if (!col) continue;
    const hasNull = vals.includes('(null)'); const real = vals.filter((v) => v !== '(null)');
    const ref = sql`t.${sql(col)}`;
    if (hasNull && real.length) c.push(sql`(${ref} IN ${sql(real)} OR ${ref} IS NULL)`);
    else if (hasNull) c.push(sql`${ref} IS NULL`);
    else c.push(sql`${ref} IN ${sql(real)}`);
  }
  return c.reduce((a, x) => sql`${a} AND ${x}`, sql`true`);
}

/** turnaround-time band for a day count (date - date) */
export function tatBucket(sql: Sql, days: Frag): Frag {
  return sql`CASE WHEN ${days} IS NULL THEN 'no prior touch' WHEN ${days} < 0 THEN 'before lead created' WHEN ${days} = 0 THEN 'same day' WHEN ${days} <= 3 THEN '1–3 d' WHEN ${days} <= 7 THEN '4–7 d'
                WHEN ${days} <= 14 THEN '8–14 d' WHEN ${days} <= 30 THEN '15–30 d' ELSE '31+ d' END`;
}
export const TAT_BUCKETS = ['before lead created', 'same day', '1–3 d', '4–7 d', '8–14 d', '15–30 d', '31+ d', 'no prior touch'];
/** First touch -> first activity: from the lead's earliest touch inside the selection to its first activity (a Task on the Lead Master or
 *  one of its Interested Courses, the Salesforce "Activity" timeline) ON OR AFTER that touch, on any later date
 *  (salesforce.lead_calls.call_days, sql/046). Earlier activity does not count; no later activity at all = 'no activity'. */
export function activityBucket(sql: Sql, days: Frag): Frag {
  return sql`CASE WHEN ${days} IS NULL THEN 'no activity' WHEN ${days} = 0 THEN 'same day' WHEN ${days} <= 3 THEN '1–3 d' WHEN ${days} <= 7 THEN '4–7 d'
                WHEN ${days} <= 14 THEN '8–14 d' WHEN ${days} <= 30 THEN '15–30 d' ELSE '31+ d' END`;
}
export const ACTIVITY_BUCKETS = ['same day', '1–3 d', '4–7 d', '8–14 d', '15–30 d', '31+ d', 'no activity'];
/** days from the lead's first touch (`firstTouch`, a date) to its first activity day on/after it (NULL = none) */
export function activityDays(sql: Sql, firstTouch: Frag): Frag {
  return sql`((SELECT min(d) FROM unnest(lc.call_days) AS d WHERE d >= ${firstTouch}) - ${firstTouch})::int`;
}
export interface TatRow { kind: string; key: string; leads: number; avg_days: number | null; median_days: number | null }
export interface TatShape { leads: number; avg_days: number | null; median_days: number | null; buckets: { key: string; leads: number }[] }
/** Rows of the turnaround statement (one per kind x band plus a kind x '_all' total) -> the chart shape for one kind */
export function shapeTat(rows: TatRow[], kind: 'created' | 'touch' | 'activity'): TatShape {
  const all = rows.find((r) => r.kind === kind && r.key === '_all');
  const names = kind === 'activity' ? ACTIVITY_BUCKETS : TAT_BUCKETS;
  const buckets = names.map((key) => ({ key, leads: rows.find((r) => r.kind === kind && r.key === key)?.leads ?? 0 }))
    .filter((b) => (b.key !== 'before lead created' && b.key !== 'no prior touch') || b.leads > 0);
  return { leads: all?.leads ?? 0, avg_days: all?.avg_days ?? null, median_days: all?.median_days ?? null, buckets };
}

export interface DimRow { key: string; touches: number; leads: number; converted: number; converted_first: number; conv_rate?: number | null }

/** `keep` = the values selected in the filter bar: always returned (first), even when they rank below the row limit */
// every value is returned (2000 is only a safety cap): the cards search and total over all rows, and a rare value must still be findable
async function byDim(sql: Sql, w: Frag, col: string, conv: Frag, convFirst: Frag, limit = 2000, keep: string[] = []): Promise<DimRow[]> {
  const keepFirst = keep.length ? sql`(COALESCE(t.${sql(col)}::text, '(null)') IN ${sql(keep)}) DESC,` : sql``;
  const rows = await sql<DimRow[]>`
    SELECT COALESCE(t.${sql(col)}::text, '(null)') AS key, count(*)::int AS touches, count(DISTINCT t.lead_id)::int AS leads,
           count(DISTINCT t.lead_id) FILTER (WHERE ${conv})::int AS converted,
           count(DISTINCT t.lead_id) FILTER (WHERE ${convFirst})::int AS converted_first
    FROM analytics.mv_touch_flat t WHERE ${w} GROUP BY 1 ORDER BY ${keepFirst} touches DESC LIMIT ${limit + keep.length}`;
  return rows.map((r) => ({ ...r, conv_rate: pct(r.converted, r.leads) }));
}

/** Dimension columns of the Overview cards (one GROUPING SETS statement when they share the main WHERE) */
const CARD_DIMS = ['touch_point', 'class_raw', 'lm_reason'] as const;
type CardDim = (typeof CARD_DIMS)[number];
const joinFrags = (sql: Sql, parts: Frag[], sep: Frag) => parts.reduce((a, x) => sql`${a}${sep}${x}`);

/**
 * Every card whose dim is not in the filter bar shares the same WHERE, so they are answered by a single scan of the window's touch rows
 * (GROUPING SETS) instead of one statement per card: ~0.4 s for seven cards instead of 7 x 0.13 s plus seven pooled connections.
 * A card whose own dim IS filtered keeps its separate byDim (its WHERE drops that filter).
 */
async function byDims(sql: Sql, w: Frag, cols: CardDim[], conv: Frag, convFirst: Frag): Promise<Record<string, DimRow[]>> {
  const out: Record<string, DimRow[]> = Object.fromEntries(cols.map((c) => [c, []]));
  if (!cols.length) return out;
  const dimCase = joinFrags(sql, cols.map((c) => sql`WHEN GROUPING(t.${sql(c)}) = 0 THEN ${c}`), sql` `);
  const keyCase = joinFrags(sql, cols.map((c) => sql`WHEN GROUPING(t.${sql(c)}) = 0 THEN COALESCE(t.${sql(c)}::text, '(null)')`), sql` `);
  const sets = joinFrags(sql, cols.map((c) => sql`(t.${sql(c)})`), sql`, `);
  const rows = await sql<(DimRow & { dim: string })[]>`
    SELECT CASE ${dimCase} END AS dim, CASE ${keyCase} END AS key,
           count(*)::int AS touches, count(DISTINCT t.lead_id)::int AS leads,
           count(DISTINCT t.lead_id) FILTER (WHERE ${conv})::int AS converted,
           count(DISTINCT t.lead_id) FILTER (WHERE ${convFirst})::int AS converted_first
    FROM analytics.mv_touch_flat t WHERE ${w} GROUP BY GROUPING SETS (${sets})`;
  for (const r of rows) { const { dim, ...rest } = r; out[dim]?.push({ ...rest, conv_rate: pct(rest.converted, rest.leads) }); }
  for (const c of cols) out[c] = out[c]!.sort((a, b) => b.touches - a.touches).slice(0, 2000);
  return out;
}

overview.get('/overview', (c) =>
  handle(c, async ({ sql, f, periods, q }) => {
    const w = flatWhere(sql, f, periods.current);
    const wAll = flatWhere(sql, f, null);
    // a card never filters itself: its rows stay visible (highlighted) so more of them can be selected
    const wx = (skip: string) => flatWhere(sql, f, periods.current, skip);
    const pp = paymentPeriod(f);
    const feeWin = pp ?? periods.current;   // payments counted for the fee KPIs: the payment-date window when it is on, else the main date range
    const winFrom = (pp ?? periods.current).from;
    const conv = convCond(sql, f);
    // Total converted: first valid payment on/after a touch of the selection AND not before the window start, so a lead created in the
    // window that had already paid months earlier (an app touch backfilled onto the payment day) is not "converted after a touch" here
    const convFirst = sql`(${convFirstCond(sql, f)} AND t.converted_at >= ${winFrom})`;
    // "Converted before the window": leads of the selection whose FIRST valid payment is dated before the window start (already customers);
    // the two KPIs never overlap (converted_at >= winFrom vs < winFrom)
    const convBefore = sql`(t.converted AND t.converted_at < ${winFrom})`;
    // Leads of the selection with NO touch at all (on both bases: created in the window, never touched) are part of Total leads, so they are
    // part of the two conversion KPIs too (user rule, 2026-11-04). "After a touch" cannot apply to them: a never-touched lead is converted when
    // its FIRST valid payment (dashboard rule, phone or alternative number) is on/after the day it was created and not before the window start,
    // like the touched ones; a first payment before the window start puts it under "Converted before the window". One indexed lookup per lead.
    // "no touch" follows the basis: lead-created basis = no touch at all (all touches of those leads count); touch-date basis = no touch dated
    // inside the window (Total leads there = created in the window OR touched in it, so a lead created in it with touches only outside it is
    // part of Total leads but of no touch-based card)
    const noTouch = f.basis === 'created'
      ? sql`NOT EXISTS (SELECT 1 FROM analytics.mv_touch_flat t WHERE t.lead_id = l.lead_id)`
      : sql`NOT EXISTS (SELECT 1 FROM analytics.mv_touch_flat t WHERE t.lead_id = l.lead_id AND t.touch_date BETWEEN ${periods.current.from} AND ${periods.current.to})`;
    const untouched = sql`SELECT l.lead_id, l.created_date, (SELECT min(vp.payment_date) FROM analytics.v_valid_payment_x vp WHERE vp.phone_key = l.phone_key) AS first_pay
                          FROM analytics.mv_lead_lite l WHERE ${newLeadWhere(sql, f, periods.current)} AND l.phone_valid
                            AND NOT EXISTS (SELECT 1 FROM analytics.mv_touch_flat t WHERE t.lead_id = l.lead_id)`;
    const uAfter = pp ? sql`(u.first_pay >= u.created_date AND u.first_pay BETWEEN ${pp.from} AND ${pp.to})` : sql`(u.first_pay >= u.created_date AND u.first_pay >= ${winFrom})`;
    const uBefore = sql`(u.first_pay < ${winFrom})`;
    // The lead-level cards (LM stage, IC status, class, LM reason, last call reason, interested course) and the two stage tiles count the
    // never-touched leads of the selection as well, so they add up to Total leads (user rule 2026-11-04). One statement over that lead set
    // answers every card; a card whose own dim is filtered gets its own statement without that filter (like the touch cards). The touch-level
    // cards (touch point, source, medium, campaign, staff) cannot include them: there is no touch to classify. "Converted" for these leads =
    // first valid payment on/after the creation day (any date); converted_first adds the window-start rule like the tile.
    const U_DIMS = ['lead_stage', 'ic_status', 'class_raw', 'lm_reason', 'call_reason', 'ic_course'] as const;
    const untouchedDims = (skip?: string) => sql<{ dim: string; key: string; leads: number; converted: number; converted_first: number; ics: number }[]>`
      WITH u AS (
        SELECT l.lead_id, l.created_date, l.lead_stage, l.class_raw, l.lm_reason,
               CASE WHEN l.phone_valid THEN (SELECT min(vp.payment_date) FROM analytics.v_valid_payment_x vp WHERE vp.phone_key = l.phone_key) END AS first_pay
        FROM analytics.mv_lead_lite l WHERE ${newLeadWhere(sql, f, periods.current, { skip })}
          AND ${noTouch}),
      c AS (SELECT u.*, (u.first_pay >= u.created_date) AS conv, ${uAfter} AS conv_first FROM u)
      SELECT d.dim, COALESCE(d.key, '(null)') AS key, count(DISTINCT c.lead_id)::int AS leads,
             count(DISTINCT c.lead_id) FILTER (WHERE c.conv)::int AS converted, count(DISTINCT c.lead_id) FILTER (WHERE c.conv_first)::int AS converted_first, 0::int AS ics
      FROM c CROSS JOIN LATERAL (VALUES ('lead_stage', c.lead_stage), ('class_raw', c.class_raw), ('lm_reason', c.lm_reason)) AS d(dim, key)
      GROUP BY 1, 2
      UNION ALL
      SELECT 'call_reason', CASE WHEN lc.lead_id IS NULL THEN '(no call)' WHEN lc.last_reason IS NULL THEN '(no reason recorded)' ELSE lc.last_reason END,
             count(DISTINCT c.lead_id)::int, count(DISTINCT c.lead_id) FILTER (WHERE c.conv)::int, count(DISTINCT c.lead_id) FILTER (WHERE c.conv_first)::int, 0
      FROM c LEFT JOIN salesforce.lead_calls lc ON lc.lead_id = c.lead_id GROUP BY 2
      UNION ALL
      SELECT 'ic_status', btrim(ic.status__c), count(DISTINCT c.lead_id)::int, 0, 0, count(*)::int
      FROM c JOIN salesforce.interested_course__c ic ON ic.lead_master__c = c.lead_id AND ic.isdeleted = false
      WHERE NULLIF(btrim(ic.status__c), '') IS NOT NULL GROUP BY 2
      UNION ALL
      SELECT 'ic_course', ${icCourseExpr(sql)}, count(DISTINCT c.lead_id)::int, count(DISTINCT c.lead_id) FILTER (WHERE c.conv)::int, count(DISTINCT c.lead_id) FILTER (WHERE c.conv_first)::int, 0
      FROM c JOIN salesforce.interested_course__c ic ON ic.lead_master__c = c.lead_id AND ic.isdeleted = false LEFT JOIN salesforce.course__c cr ON cr.id = ic.course__c
      WHERE ${icCourseExpr(sql)} IS NOT NULL GROUP BY 2
      UNION ALL
      SELECT 'no_touch', '(no touch)', count(*)::int, count(*) FILTER (WHERE c.conv)::int, count(*) FILTER (WHERE c.conv_first)::int, 0 FROM c
      UNION ALL
      SELECT 'stage_conv', k.key, count(*)::int, 0, 0, 0
      FROM c CROSS JOIN LATERAL (VALUES ('total', c.lead_stage = 'Converted'), ('unpaid', c.lead_stage = 'Converted' AND c.first_pay IS NULL),
                                        ('paid_other', c.conv AND c.lead_stage IS DISTINCT FROM 'Converted')) AS k(key, hit)
      WHERE k.hit GROUP BY 2`;
    const uFiltered: string[] = U_DIMS.filter((d) => (f[d] as string[] | undefined)?.length);
    const untouchedCards = Promise.all([untouchedDims(), ...uFiltered.map((d) => untouchedDims(d))]).then(([shared, ...per]) => {
      const rows = (shared ?? []).filter((r) => r.dim === 'stage_conv' || !uFiltered.includes(r.dim));
      uFiltered.forEach((d, i) => rows.push(...(per[i] ?? []).filter((r) => r.dim === d)));
      return rows;
    });
    const staleDays = Math.max(1, Math.min(365, Number.parseInt(q.stale_days ?? '5', 10) || 5));
    // cards: one grouping-sets scan for every dim without its own filter; a filtered dim keeps its separate statement (its WHERE skips that filter)
    const sharedDims = CARD_DIMS.filter((d) => !f[d]?.length);
    const cardsP = byDims(sql, w, sharedDims, conv, convFirst);
    const card = (d: CardDim) => (f[d]?.length ? byDim(sql, wx(d), d, conv, convFirst, 2000, f[d] ?? []) : cardsP.then((x) => x[d] ?? []));
    // Lead source / Medium / Campaign / Staff as a split of Total leads (user rule 2026-11-04): each lead counted ONCE, under the value of its
    // FIRST touch in the selection (earliest touch); "touches" stays the number of touches carrying that value (a lead's later touches count
    // there, not in leads). The never-touched leads of the selection are folded in afterwards as a "(no touch)" row, so the leads column adds
    // up to Total leads. Same self-skip rule as the other cards: a filtered dim gets its own statement without that filter.
    const FT_DIMS = ['source', 'medium', 'campaign', 'staff'] as const;
    type FtDim = (typeof FT_DIMS)[number];
    const firstTouchDims = (ww: Frag, dims: readonly FtDim[]): Promise<(DimRow & { dim: string })[]> => {
      if (!dims.length) return Promise.resolve([]);
      const firsts = joinFrags(sql, dims.map((d) => sql`(array_agg(t.${sql(d)} ORDER BY t.touch_at, t.touch_id))[1] AS ${sql(d)}`), sql`, `);
      const lvals = joinFrags(sql, dims.map((d) => sql`(${d}, lk.${sql(d)}::text)`), sql`, `);
      const tvals = joinFrags(sql, dims.map((d) => sql`(${d}, t.${sql(d)}::text)`), sql`, `);
      return sql<(DimRow & { dim: string })[]>`
        WITH lk AS (SELECT t.lead_id, ${firsts}, bool_or(${conv}) AS conv, bool_or(${convFirst}) AS conv_first FROM analytics.mv_touch_flat t WHERE ${ww} GROUP BY t.lead_id),
        l AS (SELECT d.dim, COALESCE(d.key, '(null)') AS key, count(*)::int AS leads, count(*) FILTER (WHERE lk.conv)::int AS converted, count(*) FILTER (WHERE lk.conv_first)::int AS converted_first
              FROM lk CROSS JOIN LATERAL (VALUES ${lvals}) AS d(dim, key) GROUP BY 1, 2),
        tc AS (SELECT d.dim, COALESCE(d.key, '(null)') AS key, count(*)::int AS touches
               FROM analytics.mv_touch_flat t CROSS JOIN LATERAL (VALUES ${tvals}) AS d(dim, key) WHERE ${ww} GROUP BY 1, 2)
        SELECT COALESCE(l.dim, tc.dim) AS dim, COALESCE(l.key, tc.key) AS key, COALESCE(l.leads, 0)::int AS leads, COALESCE(l.converted, 0)::int AS converted,
               COALESCE(l.converted_first, 0)::int AS converted_first, COALESCE(tc.touches, 0)::int AS touches
        FROM l FULL JOIN tc ON tc.dim = l.dim AND tc.key = l.key`.then((rows) => rows);
    };
    const ftShared = firstTouchDims(w, FT_DIMS.filter((d) => !f[d]?.length));
    const ftCard = (d: FtDim): Promise<DimRow[]> => (f[d]?.length ? firstTouchDims(wx(d), [d]) : ftShared)
      .then((rows) => rows.filter((r) => r.dim === d).map(({ dim: _dim, ...r }) => ({ ...r, conv_rate: pct(r.converted, r.leads) })).sort((a, b) => b.leads - a.leads));
    const QN = ['kpis', 'stale', 'avg_window', 'avg_alltime', 'stages', 'ic_status', 'touch_point', 'source', 'class_raw', 'call_reason', 'medium', 'campaign', 'staff', 'daily', 'stage_react', 'lm_reason', 'new_leads', 'revised_new', 'tat', 'leads_union', 'fees', 'ic_course', 'conv_ay', 'conv_untouched', 'untouched_dims'];
    const [[k], [stale], [avgWin], [avgAll], stages, icStatus, touchPoint, source, classRaw, reason, medium, campaign, staff, daily, reactRows, lmReason, [newLeads], revisedNew, tatRows, [leadsUnion], [fees], icCourse, convAy, [convU], uRows] = await timedAll(QN, [
      sql<{ touches: number; leads: number; converted: number; converted_first: number; converted_before: number; sf_converted: number; stage_conv_total: number; stage_conv_unpaid: number; paid_other_stage: number; touches_of_converted: number }[]>`
        SELECT count(*)::int AS touches,
               count(DISTINCT t.lead_id)::int AS leads,
               count(DISTINCT t.lead_id) FILTER (WHERE ${conv})::int AS converted,
               count(DISTINCT t.lead_id) FILTER (WHERE ${convFirst})::int AS converted_first,
               count(DISTINCT t.lead_id) FILTER (WHERE ${convBefore})::int AS converted_before,
               count(DISTINCT t.lead_id) FILTER (WHERE t.lead_sf_is_converted)::int AS sf_converted,
               count(DISTINCT t.lead_id) FILTER (WHERE t.lead_stage = 'Converted')::int AS stage_conv_total,
               count(DISTINCT t.lead_id) FILTER (WHERE t.lead_stage = 'Converted' AND NOT t.converted)::int AS stage_conv_unpaid,
               count(DISTINCT t.lead_id) FILTER (WHERE ${conv} AND t.lead_stage IS DISTINCT FROM 'Converted')::int AS paid_other_stage,
               count(*) FILTER (WHERE ${conv})::int AS touches_of_converted
        FROM analytics.mv_touch_flat t WHERE ${w}`,
      // leads in the selection still in stage New, created more than N days ago and not touched in the last N days
      sql<{ stale_new: number; stale_new_untouched: number; new_total: number; stale_nc: number; stale_nc_untouched: number; nc_total: number }[]>`
        WITH n AS (
          SELECT t.lead_id, max(t.lead_stage) AS stage, max(t.lead_created_date) AS created, max(x.last_touch_at) AS last_touch
          FROM analytics.mv_touch_flat t LEFT JOIN analytics.mv_lead_last_touch x ON x.lead_id = t.lead_id
          WHERE ${w} AND t.lead_stage IN ('New', 'Not Connected') GROUP BY t.lead_id),
        s AS (SELECT stage, (created <= (now() AT TIME ZONE 'Asia/Kolkata')::date - ${staleDays}::int AND last_touch < now() - make_interval(days => ${staleDays})) AS stale,
                     (last_touch < created::timestamp AT TIME ZONE 'Asia/Kolkata' + interval '1 day') AS untouched FROM n)
        SELECT count(*) FILTER (WHERE stage = 'New' AND stale)::int AS stale_new, count(*) FILTER (WHERE stage = 'New' AND stale AND untouched)::int AS stale_new_untouched, count(*) FILTER (WHERE stage = 'New')::int AS new_total,
               count(*) FILTER (WHERE stage = 'Not Connected' AND stale)::int AS stale_nc, count(*) FILTER (WHERE stage = 'Not Connected' AND stale AND untouched)::int AS stale_nc_untouched, count(*) FILTER (WHERE stage = 'Not Connected')::int AS nc_total
        FROM s`,
      // Tableau formula: AVG over touch rows (of leads with any valid payment) of the lead's all-time touch count
      sql<{ avg_rows: number | null; avg_leads: number | null; n_leads: number }[]>`
        SELECT avg(t.n_touches_all)::float8 AS avg_rows,
               (SELECT avg(x)::float8 FROM (SELECT max(n_touches_all) AS x FROM analytics.mv_touch_flat t WHERE ${w} AND t.converted GROUP BY lead_id) q) AS avg_leads,
               count(DISTINCT t.lead_id)::int AS n_leads
        FROM analytics.mv_touch_flat t WHERE ${w} AND t.converted`,
      sql<{ avg_rows: number | null; avg_leads: number | null; n_leads: number }[]>`
        SELECT avg(t.n_touches_all)::float8 AS avg_rows,
               (SELECT avg(x)::float8 FROM (SELECT max(n_touches_all) AS x FROM analytics.mv_touch_flat t WHERE ${wAll} AND t.converted GROUP BY lead_id) q) AS avg_leads,
               count(DISTINCT t.lead_id)::int AS n_leads
        FROM analytics.mv_touch_flat t WHERE ${wAll} AND t.converted`,
      sql<{ key: string; leads: number; converted: number }[]>`
        SELECT t.lead_stage AS key, count(DISTINCT t.lead_id)::int AS leads, count(DISTINCT t.lead_id) FILTER (WHERE ${conv})::int AS converted
        FROM analytics.mv_touch_flat t WHERE ${wx('lead_stage')} GROUP BY 1 ORDER BY leads DESC`,
      sql<{ key: string; leads: number; ics: number }[]>`
        SELECT btrim(ic.status__c) AS key, count(DISTINCT ic.lead_master__c)::int AS leads, count(*)::int AS ics
        FROM (SELECT DISTINCT t.lead_id FROM analytics.mv_touch_flat t WHERE ${wx('ic_status')}) k
        JOIN salesforce.interested_course__c ic ON ic.lead_master__c = k.lead_id AND ic.isdeleted = false
        WHERE NULLIF(btrim(ic.status__c),'') IS NOT NULL
        GROUP BY 1 ORDER BY leads DESC`,
      card('touch_point'), ftCard('source'), card('class_raw'), sql<DimRow[]>`
        SELECT CASE WHEN c.lead_id IS NULL THEN '(no call)' WHEN c.last_reason IS NULL THEN '(no reason recorded)' ELSE c.last_reason END AS key, count(*)::int AS touches, count(DISTINCT t.lead_id)::int AS leads,
               count(DISTINCT t.lead_id) FILTER (WHERE ${conv})::int AS converted, count(DISTINCT t.lead_id) FILTER (WHERE ${convFirst})::int AS converted_first
        FROM analytics.mv_touch_flat t LEFT JOIN salesforce.lead_calls c ON c.lead_id = t.lead_id
        WHERE ${wx('call_reason')} GROUP BY 1 ORDER BY leads DESC LIMIT 500`,
      ftCard('medium'), ftCard('campaign'), ftCard('staff'),
      sql<{ d: string; touches: number; leads: number; converted: number }[]>`
        SELECT t.touch_date::text AS d, count(*)::int AS touches, count(DISTINCT t.lead_id)::int AS leads,
               count(DISTINCT t.lead_id) FILTER (WHERE ${conv})::int AS converted
        FROM analytics.mv_touch_flat t WHERE ${w} GROUP BY 1 ORDER BY 1`,
      // leads parked in a closed stage that were touched AGAIN after entering it (stage moment from the Salesforce history log)
      sql<{ stage: string; total: number; reactivated: number }[]>`
        WITH r AS (
          SELECT t.lead_id, max(t.lead_stage) AS stage, max(t.lead_created_date)::timestamptz AS created,
                 max(x.last_touch_at) AS last_touch   -- the lead's all-time last touch, precomputed (analytics.mv_lead_last_touch, sql/044)
          FROM analytics.mv_touch_flat t LEFT JOIN analytics.mv_lead_last_touch x ON x.lead_id = t.lead_id
          WHERE ${w} AND t.lead_stage IN ('Not Willing Now', 'Disqualified', 'Not Connected', 'P2 Completed') GROUP BY t.lead_id)
        SELECT r.stage, count(*)::int AS total,
               count(*) FILTER (WHERE r.last_touch > COALESCE(ls.changed_at, GREATEST(r.created, '2026-03-01 00:00:00+00'::timestamptz)))::int AS reactivated
        FROM r LEFT JOIN salesforce.lead_stage ls ON ls.lead_id = r.lead_id AND ls.stage = r.stage
        GROUP BY r.stage ORDER BY reactivated DESC`,
      card('lm_reason'),
      // New leads: every Salesforce lead created inside the window (most have no touch yet, so this reads the lead view, not the touch table).
      // Keep the touched test as a correlated EXISTS (index probe, ~0.1 s): `lead_id IN (SELECT ...)` inside the FILTER ran row by row (150 s).
      sql<{ new_leads: number; new_leads_touched: number }[]>`
        SELECT count(*)::int AS new_leads,
               count(*) FILTER (WHERE EXISTS (SELECT 1 FROM analytics.mv_touch_flat t WHERE t.lead_id = l.lead_id))::int AS new_leads_touched
        FROM analytics.mv_lead_lite l WHERE ${newLeadWhere(sql, f, periods.current)}`,   // narrow materialized copy (sql/035): the count scans a fraction of the lead table
      // Yet to connect: leads of the selection (every stage, Converted included) with NO contact on or after their FIRST TOUCH IN THE SELECTION: no call Task
      // (the Turnaround card's "activity", salesforce.lead_calls.call_days) AND no Lead Stage change AND no Interested Course status change
      // from that day on (a status is only changed after a call, so a change counts as contact even without a Task). "New" is never a
      // decision, on the lead or on a course: a new Interested Course created in status New after the touch is not contact. For Converted
      // leads only calls count: the stage Converted and the course statuses Enrolled / Already Enrolled are set by the payment, not by a
      // call. With a campaign selected the touch is that campaign's.
      // Leads in New are "already New", Converted leads their own split, the others "revised to New" (parked in a stage, touched again, nobody contacted them).
      sql<{ stage: string; leads: number; revised: number }[]>`
        WITH x AS (SELECT t.lead_id, max(t.lead_stage) AS stage, min(t.touch_date) AS first_touch FROM analytics.mv_touch_flat t WHERE ${w} GROUP BY t.lead_id)
        SELECT COALESCE(x.stage, '(blank)') AS stage, count(*)::int AS leads,
               count(*) FILTER (WHERE ${activityDays(sql, sql`x.first_touch`)} IS NULL
                                  AND (x.stage IN ('New', 'Converted') OR NOT COALESCE(d.lm_since >= (x.first_touch::timestamp AT TIME ZONE 'Asia/Kolkata'), false))
                                  AND (x.stage = 'Converted' OR NOT EXISTS (SELECT 1 FROM analytics.mv_ic_decision i WHERE i.lead_id = x.lead_id AND i.status <> 'New' AND i.ic_since >= (x.first_touch::timestamp AT TIME ZONE 'Asia/Kolkata'))))::int AS revised
        FROM x LEFT JOIN salesforce.lead_calls lc ON lc.lead_id = x.lead_id LEFT JOIN analytics.mv_lead_decision d ON d.lead_id = x.lead_id
        GROUP BY 1 ORDER BY revised DESC, leads DESC`,
      // Turnaround time of the converted leads in the selection: lead created -> first valid payment day, and latest touch on/before that day -> payment day
      sql<{ kind: string; key: string; leads: number; avg_days: number | null; median_days: number | null }[]>`
        WITH c AS (
          SELECT t.lead_id, max(t.converted_at) AS paid, max(t.lead_created_date) AS created,
                 (SELECT max(t2.touch_date) FROM analytics.mv_touch_flat t2 WHERE t2.lead_id = t.lead_id AND t2.is_pre_conversion) AS last_touch
          FROM analytics.mv_touch_flat t WHERE ${w} AND ${conv} AND t.converted_at IS NOT NULL GROUP BY t.lead_id),
        d AS (SELECT 'created' AS kind, (paid - created)::int AS days FROM c
              UNION ALL SELECT 'touch', (paid - last_touch)::int FROM c),
        -- first touch -> first activity, for EVERY lead of the selection (touch = the lead's earliest touch among the selection's touch rows;
        -- activity = the lead's first Task on the Lead Master or its Interested Courses ON OR AFTER that touch, any later date,
        -- salesforce.lead_calls.call_days); none -> days NULL ('no activity')
        a AS (
          SELECT x.lead_id, ${activityDays(sql, sql`x.first_touch`)} AS days
          FROM (SELECT t.lead_id, min(t.touch_date) AS first_touch FROM analytics.mv_touch_flat t WHERE ${w} GROUP BY t.lead_id) x
          LEFT JOIN salesforce.lead_calls lc ON lc.lead_id = x.lead_id)
        SELECT kind, ${tatBucket(sql, sql`days`)} AS key, count(*)::int AS leads, NULL::float8 AS avg_days, NULL::float8 AS median_days FROM d GROUP BY 1, 2
        UNION ALL
        SELECT kind, '_all', count(*)::int, avg(days)::float8, percentile_cont(0.5) WITHIN GROUP (ORDER BY days)::float8 FROM d GROUP BY 1
        UNION ALL
        SELECT 'activity', ${activityBucket(sql, sql`days`)}, count(*)::int, NULL::float8, NULL::float8 FROM a GROUP BY 2
        UNION ALL
        SELECT 'activity', '_all', count(*)::int, avg(days)::float8, percentile_cont(0.5) WITHIN GROUP (ORDER BY days)::float8 FROM a`,
      // Total leads on the TOUCH-date basis: leads created in the window OR touched in the window (on the lead-created basis Total leads
      // = the leads created in the window, touched or not = New leads)
      f.basis !== 'created'
        ? sql<{ n: number }[]>`SELECT count(*)::int AS n FROM analytics.mv_lead_lite l WHERE ${newLeadWhere(sql, f, periods.current, { scope: 'union' })}`
        : Promise.resolve([{ n: 0 }]),
      // Proposed fee / fee received: valid payments (payment_method 0) dated inside the window, made by the app accounts of the leads in the
      // selection (own phone or alternative number). Proposed fee = fee - discount of the enrollments those payments belong to, each once.
      sql<{ fee_payers: number; fee_payments: number; fee_received: number; proposed_fee: number; fee_enrollments: number; fee_enrollments_unknown: number }[]>`
        WITH lk AS (SELECT DISTINCT t.lead_id FROM analytics.mv_touch_flat t WHERE ${w}),
        -- payments first: the valid payments dated inside the window (a few thousand) are kept when one of the paying account's numbers
        -- (mv_user_phone, own phone or alternative number) belongs to a lead of the selection. The former lead-first chain
        -- (leads -> numbers -> accounts -> payments) built a 30k-account set before reading a single payment: 4.4 s vs 2.2 s alone.
        pay AS (
          SELECT hp.id, hp.user_id, hp.amount, hp.enrollment_id, hp.enrollment_fee, hp.enrollment_discount
          FROM analytics.v_payment_all hp
          WHERE hp.payment_method = 0 AND hp.deleted = false AND hp.is_success = true AND hp.payment_success = true
            AND hp.payment_date BETWEEN ${feeWin.from} AND ${feeWin.to}
            AND EXISTS (SELECT 1 FROM analytics.mv_user_phone up JOIN analytics.mv_lead_lite m ON m.phone_key = up.phone_key AND m.phone_valid
                        JOIN lk ON lk.lead_id = m.lead_id WHERE up.user_id = hp.user_id)),
        enr AS (
          SELECT DISTINCT ON (COALESCE(enrollment_id::text, 'p' || id::text)) enrollment_id, enrollment_fee, enrollment_discount
          FROM pay ORDER BY COALESCE(enrollment_id::text, 'p' || id::text))
        SELECT (SELECT count(DISTINCT user_id) FROM pay)::int AS fee_payers, (SELECT count(*) FROM pay)::int AS fee_payments,
               (SELECT COALESCE(sum(amount), 0) FROM pay)::float8 AS fee_received,
               (SELECT COALESCE(sum(enrollment_fee - COALESCE(enrollment_discount, 0)), 0) FROM enr)::float8 AS proposed_fee,
               (SELECT count(*) FROM enr WHERE enrollment_fee IS NOT NULL)::int AS fee_enrollments,
               (SELECT count(*) FROM enr WHERE enrollment_fee IS NULL)::int AS fee_enrollments_unknown`,
      // Interested course: the leads of the selection by the course name on their Interested Course records (a lead with several appears under each)
      sql<DimRow[]>`
        WITH lk AS (
          SELECT t.lead_id, count(*)::int AS touches, bool_or(${conv}) AS conv, bool_or(${convFirst}) AS conv_first
          FROM analytics.mv_touch_flat t WHERE ${wx('ic_course')} GROUP BY t.lead_id)
        SELECT ${icCourseExpr(sql)} AS key, sum(lk.touches)::int AS touches, count(DISTINCT lk.lead_id)::int AS leads,
               count(DISTINCT lk.lead_id) FILTER (WHERE lk.conv)::int AS converted, count(DISTINCT lk.lead_id) FILTER (WHERE lk.conv_first)::int AS converted_first
        FROM lk JOIN salesforce.interested_course__c ic ON ic.lead_master__c = lk.lead_id AND ic.isdeleted = false
        LEFT JOIN salesforce.course__c cr ON cr.id = ic.course__c
        WHERE ${icCourseExpr(sql)} IS NOT NULL
        GROUP BY 1 ORDER BY leads DESC LIMIT 2000`,
      // Academic-year split of the two conversion KPIs: the academic year of the course (core_syllabusstructure.academic_year, copied onto
      // app.core_batch) of the lead's LATEST valid payment THAT HAS one; Ujra bookings and old payments without a batch carry no year, so
      // a lead whose only payments are such = '(no academic year)'. The year written in a batch title is NOT used. Lookup on the lead's phone key.
      // Only app payments can carry a batch, so the lookup reads home_payment through mv_user_phone (the app branch of v_valid_payment_x)
      // once for the whole set of phone keys (DISTINCT ON) instead of a correlated subquery per converted lead (that form took ~15 s
      // inside the fan-out; this one ~2 s).
      sql<{ kind: string; key: string; leads: number }[]>`
        WITH c AS (
          SELECT t.lead_id, bool_or(${convFirst}) AS after_touch, bool_or(${convBefore}) AS before_win
          FROM analytics.mv_touch_flat t WHERE ${w} GROUP BY t.lead_id
          HAVING bool_or(${convFirst}) OR bool_or(${convBefore})
          UNION ALL
          SELECT u.lead_id, ${uAfter}, ${uBefore} FROM (${untouched}) u WHERE ${uAfter} OR ${uBefore}),
        cm AS (SELECT c.after_touch, c.before_win, m.phone_key FROM c JOIN analytics.mv_lead_lite m ON m.lead_id = c.lead_id),
        pk AS (SELECT DISTINCT phone_key FROM cm WHERE phone_key IS NOT NULL),
        ay AS (
          SELECT DISTINCT ON (up.phone_key) up.phone_key, NULLIF(btrim(b.academic_year), '') AS ay
          FROM pk JOIN analytics.mv_user_phone up ON up.phone_key = pk.phone_key
          JOIN app.home_payment p ON p.user_id = up.user_id
          JOIN app.core_batch b ON b.id = COALESCE(p.enrollment_batch_id, p.batch_id)
          WHERE p.payment_method = 0 AND p.deleted = false AND p.is_success = true AND p.payment_success = true AND p.payment_date IS NOT NULL
            AND NULLIF(btrim(b.academic_year), '') IS NOT NULL
          ORDER BY up.phone_key, p.payment_date DESC, p.payment_time DESC NULLS LAST, p.id DESC),
        a AS (SELECT cm.after_touch, cm.before_win, COALESCE(ay.ay, '(no academic year)') AS ay FROM cm LEFT JOIN ay ON ay.phone_key = cm.phone_key)
        SELECT 'after' AS kind, ay AS key, count(*)::int AS leads FROM a WHERE after_touch GROUP BY 2
        UNION ALL
        SELECT 'before', ay, count(*)::int FROM a WHERE before_win GROUP BY 2
        ORDER BY 1, 2 DESC`,
      // the never-touched leads of the selection that count as converted (after) / already customers (before), see `untouched` above
      sql<{ after: number; before: number }[]>`SELECT count(*) FILTER (WHERE ${uAfter})::int AS after, count(*) FILTER (WHERE ${uBefore})::int AS before FROM (${untouched}) u`,
      untouchedCards,
    ]);
    const tatShape = (kind: 'created' | 'touch' | 'activity') => shapeTat(tatRows, kind);
    // Total leads: lead-created basis = leads created in the window (touched or not); touch-date basis = created in the window OR touched in it
    // fold the never-touched leads into the lead-level cards: keys matched as text, a value only they have becomes a new row
    type URow = { key: string; leads: number; converted: number; converted_first: number; ics: number };
    const uBy = (dim: string): URow[] => uRows.filter((r) => r.dim === dim);
    const keyOf = (k: unknown) => (k === null || k === undefined ? '(null)' : String(k));
    const fold = <R extends { key: string }>(rows: R[], dim: string, add: (r: R | undefined, u: URow) => R): R[] => {
      const out = rows.map((r) => ({ ...r }));
      for (const u of uBy(dim)) {
        const i = out.findIndex((r) => keyOf(r.key) === u.key);
        if (i >= 0) out[i] = add(out[i]!, u); else out.push(add(undefined, u));
      }
      return out;
    };
    const foldDim = (rows: DimRow[], dim: string, sortBy: 'touches' | 'leads' = 'leads'): DimRow[] => fold(rows, dim, (r, u) => {
      const base = r ?? { key: u.key, touches: 0, leads: 0, converted: 0, converted_first: 0 };
      const leads = base.leads + u.leads, converted = base.converted + u.converted;
      return { ...base, leads, converted, converted_first: base.converted_first + u.converted_first, conv_rate: pct(converted, leads) };
    }).sort((a, b) => b[sortBy] - a[sortBy]);
    const stagesAll = fold(stages, 'lead_stage', (r, u) => ({ key: r?.key ?? u.key, leads: (r?.leads ?? 0) + u.leads, converted: (r?.converted ?? 0) + u.converted })).sort((a, b) => b.leads - a.leads);
    const icStatusAll = fold(icStatus, 'ic_status', (r, u) => ({ key: r?.key ?? u.key, leads: (r?.leads ?? 0) + u.leads, ics: (r?.ics ?? 0) + u.ics })).sort((a, b) => b.leads - a.leads);
    const classRawAll = foldDim(classRaw, 'class_raw', 'touches'), lmReasonAll = foldDim(lmReason, 'lm_reason', 'touches');
    const reasonAll = foldDim(reason, 'call_reason'), icCourseAll = foldDim(icCourse, 'ic_course');
    const sourceAll = foldDim(source, 'no_touch'), mediumAll = foldDim(medium, 'no_touch'), campaignAll = foldDim(campaign, 'no_touch'), staffAll = foldDim(staff, 'no_touch');
    const uStage = (key: string) => uBy('stage_conv').find((r) => r.key === key)?.leads ?? 0;
    const leadsAll = f.basis === 'created' ? (newLeads?.new_leads ?? k.leads) : (leadsUnion?.n ?? k.leads);
    return {
      period: periods.current, payment_period: pp, basis: f.basis === 'created' ? 'created' : 'touch',
      kpis: {
        ...k,
        // Lead-created basis: Total leads = leads created in the window (touched or not) + leads touched in the window; New leads = the created ones.
        // Touch-date basis: leads with a touch dated in the window. leads_touched = leads of the selection that have a touch (base of the rates).
        leads: leadsAll, leads_touched: k.leads,
        // the two conversion KPIs cover the whole Total leads population: touched leads (payment on/after a touch) + never-touched leads
        converted_first: k.converted_first + (convU?.after ?? 0), converted_before: k.converted_before + (convU?.before ?? 0),
        converted_untouched: convU?.after ?? 0, converted_before_untouched: convU?.before ?? 0,
        stage_conv_total: k.stage_conv_total + uStage('total'), stage_conv_unpaid: k.stage_conv_unpaid + uStage('unpaid'), paid_other_stage: k.paid_other_stage + uStage('paid_other'),
        stage_react: reactRows.reduce((a, r) => a + r.reactivated, 0),
        stage_react_total: reactRows.reduce((a, r) => a + r.total, 0),
        stage_react_by: reactRows,
        // rates are against Total leads (leadsAll), not only the touched leads
        conv_rate: pct(k.converted, leadsAll),
        conv_rate_first: pct(k.converted_first + (convU?.after ?? 0), leadsAll),
        conv_rate_before: pct(k.converted_before + (convU?.before ?? 0), leadsAll),
        window_from: winFrom,
        conv_ay: {
          after: convAy.filter((r) => r.kind === 'after').map(({ key, leads }) => ({ key, leads })),
          before: convAy.filter((r) => r.kind === 'before').map(({ key, leads }) => ({ key, leads })),
        },
        touches_per_lead: k.leads ? Math.round((k.touches / k.leads) * 1000) / 1000 : null,
        avg_touches_alltime: avgAll?.avg_rows ?? null,
        avg_touches_alltime_per_lead: avgAll?.avg_leads ?? null,
        avg_touches_alltime_n: avgAll?.n_leads ?? 0,
        avg_touches_window: avgWin?.avg_rows ?? null,
        avg_touches_window_per_lead: avgWin?.avg_leads ?? null,
        avg_touches_window_n: avgWin?.n_leads ?? 0,
        stale_new: stale?.stale_new ?? 0, stale_new_untouched: stale?.stale_new_untouched ?? 0, new_total: stale?.new_total ?? 0, stale_days: staleDays,
        stale_nc: stale?.stale_nc ?? 0, stale_nc_untouched: stale?.stale_nc_untouched ?? 0, nc_total: stale?.nc_total ?? 0,
        new_leads: newLeads?.new_leads ?? 0, new_leads_touched: newLeads?.new_leads_touched ?? 0,
        yet_new: revisedNew.reduce((a, r) => a + r.revised, 0),
        yet_new_already: revisedNew.filter((r) => r.stage === 'New').reduce((a, r) => a + r.revised, 0),
        yet_new_revised: revisedNew.filter((r) => r.stage !== 'New' && r.stage !== 'Converted').reduce((a, r) => a + r.revised, 0),
        yet_new_converted: revisedNew.filter((r) => r.stage === 'Converted').reduce((a, r) => a + r.revised, 0),
        yet_new_by: revisedNew,
        ...(fees ?? { fee_payers: 0, fee_payments: 0, fee_received: 0, proposed_fee: 0, fee_enrollments: 0, fee_enrollments_unknown: 0 }), fee_window: feeWin,
      },
      stages: stagesAll, ic_status: icStatusAll, ic_course: icCourseAll, tat: { created: tatShape('created'), touch: tatShape('touch'), activity: tatShape('activity') },
      touch_point: touchPoint, source: sourceAll, class_raw: classRawAll, reason: reasonAll, lm_reason: lmReasonAll, medium: mediumAll, campaign: campaignAll, staff: staffAll, daily,
      definitions: {
        leads: f.basis === 'created'
          ? 'Leads created (IST) inside the window, touched or not, PLUS older leads that received a touch dated inside the window. New leads is the created part, so it is always a subset of this figure. Deleted leads are excluded; duplicate leads are excluded unless toggled on. The rates, charts and tables below stay touch-level: they cover the leads created in the window that have a touch.'
          : 'Distinct leads that have at least one touch dated (IST) inside the window. Deleted leads are excluded; duplicate leads are excluded unless toggled on.',
        touches: 'Number of distinct touch records dated inside the window (app installs, webinar registrations, forms, ads, community joins). Deleted touches are excluded. One lead can have several touches.',
        converted: pp
          ? `Payment-date filter ON: leads in the selection that have a valid payment (payment_method 0, not deleted, is_success, payment_success) dated between ${pp.from} and ${pp.to}.`
          : 'Distinct leads in the selection that have ANY valid payment (payment_method 0, not deleted, is_success, payment_success) dated on/after one of their touch days. Payments are matched to leads on the phone number (last 10 digits): the own phone of the paying app account, or its alternative number.',
        proposed_fee: 'Proposed fee = fee minus discount of the enrollments that received a payment inside the date range (the payment-date window when it is switched on), each enrollment counted once. Only payments of the app accounts linked to the leads in the selection (own phone or alternative number), valid and payment_method 0. For Ujra (Integrated) bookings the proposed fee is course + registration + material fee, each net of discount, concession, scholarship and special request. It is the agreed price, so it is larger than the fee received while instalments are still open.',
        fee_received: 'Fee received = sum of the payment amounts dated inside the same date range, for the same leads and accounts (valid payments, payment_method 0).',
        tat: 'Turnaround time of the converted leads in the selection (Total converted rule), in calendar days. "Lead created → paid": from the day the lead was created to the day of its FIRST valid payment; "before lead created" = the phone already had a payment before the lead existed. "Last touch → paid": from the latest lead touch on or before that payment day to the payment day; "no prior touch" = the first payment came before any touch (the lead counts as converted because a later payment followed a touch). Median = half the leads were faster. Click a band to list those leads. "First touch → first activity": for EVERY lead of the selection, from the day of its earliest touch inside the selection to the day of its first activity ON OR AFTER that touch, on any later date - an activity is a Task in the Activity timeline of the Lead Master or of one of its Interested Courses (Follow Up, Ready To Pay, calls ...; Tasks are read since May 2026). Activity before the touch is ignored; "no activity" = no Task on or after the touch; "31+ d" = the first later Task came more than 30 days after the touch. Average and median count only leads with an activity.',
        ic_course: 'The leads of the selection grouped by the course name on their Salesforce Interested Course records (interest, not purchase). A lead with several interested courses appears under each. Total leads = distinct leads with that course; touches = those leads\' touches in the window; converted = the dashboard conversion rule. Click a row to filter every page by that course; the filter bar has the same list under "Interested course". What was actually bought is on the Converted page (Purchased course).',
        new_leads: 'Salesforce leads created (IST) inside the date range, whether or not they have a touch yet - the only figure on this page that includes leads without a touch. Deleted leads are excluded; duplicates are excluded unless toggled on. Lead filters (class, lead source, stage, LM reason, owner …) apply to the lead itself; touch filters (touch point, source, campaign, medium, staff) keep only leads with at least one such touch on any date. "With a touch" = at least one lead touch on record, any date.',
        leads_basis: f.basis === 'created' ? 'Main window = LEAD CREATED date: Total leads = only the leads created in the range (touched or not); the cards use all touches of those leads, any date.' : 'Main window = TOUCH date: Total leads = leads created in the range plus leads with a touch dated in the range; the cards use the touches dated in the range.',
        converted_first: 'Leads of the selection (created or touched in the range, per the basis) whose FIRST valid payment (app or Ujra, matched by phone or alternative number) is on/after one of their touches and not before the window start (the payment window start when the Payment date filter is on). A lead that had already paid before the window is in "Converted before the window" instead. Leads of the selection that were never touched (created in the window, no touch on record) count too, because they are part of Total leads: for them the first valid payment must be on/after the day the lead was created (and not before the window start). They are listed under the "no touch" split of the tile; the tile\'s own list shows the touched leads.',
        sf_converted: 'Touched leads with Salesforce Lead_Master__c.Is_Converted__c = true (reference).',
        yet_new: 'Leads of the selection nobody has contacted since their touch: no call Task logged, no Lead Stage change and no Interested Course status change on or after their first touch in the selection, any later date; Converted leads included (bought earlier, touched again in the selection, nobody contacted them since). A call Task is the Turnaround card\'s "activity"; a stage or status change counts as contact too, because a status is only changed after a call. "New" is never a decision: a new Interested Course created in status New after the touch is not contact. For Converted leads only calls count, because the stage Converted and the course statuses Enrolled / Already Enrolled are set by the payment. "Already New" = Lead Stage is New; "revised to New" = parked in another stage (Connected, Not Willing Now, ...), touched again, nobody contacted them since; "Converted" = Lead Stage is Converted and no call was logged after the lead\'s touch in the selection. The touch follows the filters: with a campaign selected it is the lead\'s first touch of that campaign, so a lead contacted after campaign A but only touched by campaign B counts as contacted under A and as yet to connect under B. Stage and status moments come from the Salesforce field-history log (from 1 March 2026); without a logged change, the creation date or 1 March 2026 if older. Click the value, a split or a bar for the leads.',
        stage_react: 'Leads in the selection whose current stage is Not Willing Now, Disqualified, Not Connected or P2 Completed AND that received at least one lead touch AFTER entering that stage. The stage moment comes from the Salesforce field-history log (latest change into the current stage); leads with no logged change since 1 March 2026 use their creation date, or 1 March 2026 if older.',
        stage_conv_unpaid: 'Leads whose Salesforce Lead Stage is "Converted" but with NO valid payment on their phone (any date): marked converted without a purchase.',
        paid_other_stage: 'Leads counted in Total converted (valid payment on/after a touch, inside the payment window when it is on) whose Lead Stage is NOT "Converted": paid, but the stage was never updated.',
        converted_before: 'Leads of the selection (created or touched in the range, per the basis) that were ALREADY customers when the window started: their first valid payment (app or Ujra, matched by phone or alternative number) is dated before the window start (the payment window start when the Payment date filter is on). They are not in Total converted. Never-touched leads of the selection whose first valid payment is before the window start count too ("no touch" split).',
        conv_ay: 'Academic-year split: the academic year of the course (the Academic Year field of the course in the app, as in Metabase) of the lead\x27s LATEST valid payment that has one. Ujra bookings and old payments without a batch carry no academic year and are skipped; "(no academic year)" = none of the lead\x27s payments has one, folded into "other". The year written in a batch title is not used.',
        avg_touches_alltime: 'Average number of touches a paying lead received, no date filter. The headline is weighted by touch rows (a lead with 6 touches counts 6 times), the caption shows the plain per-lead average.',
        avg_touches_window: 'Same as the all-time average, restricted to touches dated inside the window.',
        avg_per_lead: 'Per-lead variant (each converted lead counted once): the honest average number of touches a paying lead received.',
        lm_reason: 'Lead_Master__c.LM_Reason__c: the reason stored on the lead record itself (set by the salesperson on the lead), one value per lead.',
        reason: 'The Reason recorded on the lead\'s LAST call (Salesforce call log, calls since May 2026). "(no call)" = no call logged in that period; "(no reason recorded)" = the last call was logged without a Reason. The lead\'s own LM Reason field is a separate card and filter.',
        stale_new: `Leads in the selection whose Lead Stage is still "New" although they were created more than ${staleDays} days ago and have had no touch in the last ${staleDays} days (any touch, in any month). "Never touched after creation" = their only touches are from the creation day itself. Only leads with at least one touch exist on this page.`,
        stale_nc: `Same rule for Lead Stage "Not Connected": created more than ${staleDays} days ago and no touch in the last ${staleDays} days.`,
        dim_converted: 'Per row: distinct converted leads having a touch of that value in the window. A lead can appear under several rows.',
      },
    };
  }),
);
