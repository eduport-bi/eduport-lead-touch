import { Hono } from 'hono';
import type { Sql } from 'postgres';
import type { AppEnv } from '../env';
import { handle, pct, timedAll } from '../http';
import { LIST_KEYS, paymentPeriod, icCourseExpr, icCourseIn, boughtBases, classPaid, classPopulation, classMatchKeep, type Filters, type Frag, type Period } from '../filters';
import { newLeadWhere, yetRows } from './new_leads';

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

// Purchased class (filter-bar switch class_on=bought with a Class picked, 2026-11-23): every conversion rule below tests the date of the
// payment FOR THAT CLASS (analytics.mv_lead_class_pay, sql/051) instead of the lead's first payment of any course. See filters.ts boughtBases.
const payWin = (sql: Sql, f: Filters) => { const pp = paymentPeriod(f); return pp ? sql`AND cp.payment_date BETWEEN ${pp.from} AND ${pp.to}` : sql``; };

export function convCond(sql: Sql, f: Filters): Frag {
  const bb = boughtBases(f);
  if (bb) return classPaid(sql, sql`t.lead_id`, bb, sql`cp.payment_date >= t.touch_date ${payWin(sql, f)}`);
  const pp = paymentPeriod(f);
  if (!pp) return sql`t.tab_converted`;
  return sql`EXISTS (SELECT 1 FROM analytics.v_payment_all hp WHERE hp.user_id = t.app_user_id AND hp.payment_method = 0 AND hp.deleted = false
                     AND hp.is_success = true AND hp.payment_success = true AND hp.payment_date BETWEEN ${pp.from} AND ${pp.to}
                     AND hp.payment_date >= t.touch_date)`;   // still on/after the touch day, as in the workbook
}
/** first valid payment on/after a touch (brief definition), within the payment window when it is on */
export function convFirstCond(sql: Sql, f: Filters): Frag {
  const bb = boughtBases(f);
  if (bb) return classPaid(sql, sql`t.lead_id`, bb, sql`cp.payment_date >= t.touch_date ${payWin(sql, f)}`);
  const pp = paymentPeriod(f);
  return pp ? sql`(t.converted AND t.is_pre_conversion AND t.converted_at BETWEEN ${pp.from} AND ${pp.to})` : sql`(t.converted AND t.is_pre_conversion)`;
}
/** Total converted (touch row t): first valid payment on/after a touch and not before the window start; purchased class: the class payment */
export function convAfterCond(sql: Sql, f: Filters, winFrom: string): Frag {
  const bb = boughtBases(f);
  if (bb) return classPaid(sql, sql`t.lead_id`, bb, sql`cp.payment_date >= t.touch_date AND cp.payment_date >= ${winFrom} ${payWin(sql, f)}`);
  return sql`(${convFirstCond(sql, f)} AND t.converted_at >= ${winFrom})`;
}
/** Converted before the window (touch row t): first valid payment before the window start; purchased class: a class payment before it */
/** Converted before the last touch (user, 2026-11-27; was "before the window"): the lead's first valid payment is dated before one of its
 *  touches in the selection, i.e. before its last touch there - a customer who was touched again. Row condition on a touch row t;
 *  bool_or over the lead's rows. Payment window on: that payment must also be inside it. Purchased class: the date of the class payment. */
export function convBeforeCond(sql: Sql, f: Filters, pp: Period | null): Frag {
  const bb = boughtBases(f);
  if (bb) return classPaid(sql, sql`t.lead_id`, bb, pp ? sql`cp.payment_date < t.touch_date AND cp.payment_date BETWEEN ${pp.from} AND ${pp.to}` : sql`cp.payment_date < t.touch_date`);
  return pp ? sql`(t.converted AND t.converted_at < t.touch_date AND t.converted_at BETWEEN ${pp.from} AND ${pp.to})` : sql`(t.converted AND t.converted_at < t.touch_date)`;
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
  if (f.class_match === '1') c.push(classMatchKeep(sql, sql`t.lead_id`, sql`t.class_group`));
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
    const bb = k === 'class_group' ? boughtBases(f) : null;   // purchased class: the lead paid for that class (filters.ts)
    if (bb) { c.push(classPopulation(sql, sql`t.lead_id`, f, bb)); continue; }
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
const CARD_DIMS = ['touch_point', 'class_raw', 'lm_reason', 'lead_source'] as const;
type CardDim = (typeof CARD_DIMS)[number];
const joinFrags = (sql: Sql, parts: Frag[], sep: Frag) => parts.reduce((a, x) => sql`${a}${sep}${x}`);

/**
 * Every card whose dim is not in the filter bar shares the same WHERE, so they are answered by a single scan of the window's touch rows
 * (GROUPING SETS) instead of one statement per card: ~0.4 s for seven cards instead of 7 x 0.13 s plus seven pooled connections.
 * A card whose own dim IS filtered keeps its separate byDim (its WHERE drops that filter).
 */
/** The 2-hour app rule on the touch cards (user, 2026-11-27): an Eduport App touch made less than 2 hours before the lead's last valid
 *  payment does not make the lead "converted" under that touch's values (touch point, source, medium, campaign, staff) - the same rule as
 *  the last-touch credit (sql/021), including its exception: when the app touch is the lead's only touch up to then, it still counts -
 *  unless it came less than 30 minutes before the payment (appOnlyQuick, 2026-11-27). */
export function appQuickTouch(sql: Sql): Frag {
  return sql`(t.touch_point = 'Eduport App' AND t.last_payment_at IS NOT NULL AND t.touch_at > t.last_payment_at - interval '2 hours'
           AND t.touch_at <= t.last_payment_at
           AND (t.touch_at > t.last_payment_at - interval '30 minutes'
                OR EXISTS (SELECT 1 FROM analytics.mv_touch_flat t3 WHERE t3.lead_id = t.lead_id AND t3.touch_at < t.touch_at)))`;
}
/** The 30-minute rule (user, 2026-11-27): when the Eduport App touch is the lead's ONLY touch up to the payment and was made less than
 *  30 minutes before it, nobody gets the credit - the lead counts as "no touch" (the 2-hour exception no longer saves it). Touch row t. */
export function appOnlyQuick(sql: Sql): Frag {
  return sql`(t.touch_point = 'Eduport App' AND t.last_payment_at IS NOT NULL AND t.touch_at > t.last_payment_at - interval '30 minutes'
           AND t.touch_at <= t.last_payment_at
           AND NOT EXISTS (SELECT 1 FROM analytics.mv_touch_flat t3 WHERE t3.lead_id = t.lead_id AND t3.touch_at < t.touch_at))`;
}

async function byDims(sql: Sql, w: Frag, cols: CardDim[], conv: Frag, convFirst: Frag): Promise<Record<string, DimRow[]>> {
  const out: Record<string, DimRow[]> = Object.fromEntries(cols.map((c) => [c, []]));
  const quick = appQuickTouch(sql);
  if (!cols.length) return out;
  const dimCase = joinFrags(sql, cols.map((c) => sql`WHEN GROUPING(t.${sql(c)}) = 0 THEN ${c}`), sql` `);
  const keyCase = joinFrags(sql, cols.map((c) => sql`WHEN GROUPING(t.${sql(c)}) = 0 THEN COALESCE(t.${sql(c)}::text, '(null)')`), sql` `);
  const sets = joinFrags(sql, cols.map((c) => sql`(t.${sql(c)})`), sql`, `);
  const rows = await sql<(DimRow & { dim: string })[]>`
    SELECT CASE ${dimCase} END AS dim, CASE ${keyCase} END AS key,
           count(*)::int AS touches, count(DISTINCT t.lead_id)::int AS leads,
           count(DISTINCT t.lead_id) FILTER (WHERE ${conv} AND NOT ${quick})::int AS converted,
           count(DISTINCT t.lead_id) FILTER (WHERE ${convFirst} AND NOT ${quick})::int AS converted_first
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
    // (purchased class: both test the date of the payment for the picked class, see convAfterCond / convBeforeCond)
    const convFirst = convAfterCond(sql, f, winFrom);
    // "Converted before the window": leads of the selection whose FIRST valid payment is dated before the window start (already customers);
    // the two KPIs never overlap (converted_at >= winFrom vs < winFrom). Purchased class: a payment for the class before the window start
    // (a lead can then be in both: Class 10 bought last year and again this month).
    const convBefore = convBeforeCond(sql, f, pp);
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
    // first valid payment of the lead's number: precomputed per phone (analytics.mv_phone_pay, sql/054), one index lookup per lead
    const untouched = sql`SELECT l.lead_id, l.created_date, (SELECT pp.first_pay FROM analytics.mv_phone_pay pp WHERE pp.phone_key = l.phone_key) AS first_pay
                          FROM analytics.mv_lead_lite l WHERE ${newLeadWhere(sql, f, periods.current)} AND l.phone_valid
                            AND NOT EXISTS (SELECT 1 FROM analytics.mv_touch_flat t WHERE t.lead_id = l.lead_id)`;
    // never-touched conversions (alias u: lead_id, created_date, first_pay); purchased class: the class payment's date instead of first_pay
    const bb = boughtBases(f);
    const ppWin = pp ? sql`AND cp.payment_date BETWEEN ${pp.from} AND ${pp.to}` : sql``;
    const uAfter = bb ? classPaid(sql, sql`u.lead_id`, bb, sql`cp.payment_date >= u.created_date AND cp.payment_date >= ${winFrom} ${ppWin}`)
      : pp ? sql`(u.first_pay >= u.created_date AND u.first_pay BETWEEN ${pp.from} AND ${pp.to})` : sql`(u.first_pay >= u.created_date AND u.first_pay >= ${winFrom})`;
    // never-touched leads have no last touch, so none of them is "converted before the last touch" (2026-11-27)
    const uBefore = sql`false`;
    const uConvAny = bb ? classPaid(sql, sql`u.lead_id`, bb, sql`cp.payment_date >= u.created_date`) : sql`(u.first_pay >= u.created_date)`;
    // The lead-level cards (LM stage, IC status, class, LM reason, last call reason, interested course) and the two stage tiles count the
    // never-touched leads of the selection as well, so they add up to Total leads (user rule 2026-11-04). One statement over that lead set
    // answers every card; a card whose own dim is filtered gets its own statement without that filter (like the touch cards). The touch-level
    // cards (touch point, source, medium, campaign, staff) cannot include them: there is no touch to classify. "Converted" for these leads =
    // first valid payment on/after the creation day (any date); converted_first adds the window-start rule like the tile.
    const U_DIMS = ['lead_stage', 'ic_status', 'class_raw', 'lm_reason', 'lead_source', 'call_reason', 'ic_course'] as const;
    const untouchedDims = (skip?: string) => sql<{ dim: string; key: string; leads: number; converted: number; converted_first: number; ics: number }[]>`
      WITH u AS (
        SELECT l.lead_id, l.created_date, l.lead_stage, l.class_raw, l.lm_reason, l.lead_source,
               CASE WHEN l.phone_valid THEN (SELECT pp.first_pay FROM analytics.mv_phone_pay pp WHERE pp.phone_key = l.phone_key) END AS first_pay
        FROM analytics.mv_lead_lite l WHERE ${newLeadWhere(sql, f, periods.current, { skip })}
          AND ${noTouch}),
      c AS (SELECT u.*, ${uConvAny} AS conv, ${uAfter} AS conv_first FROM u)
      SELECT d.dim, COALESCE(d.key, '(null)') AS key, count(DISTINCT c.lead_id)::int AS leads,
             count(DISTINCT c.lead_id) FILTER (WHERE c.conv)::int AS converted, count(DISTINCT c.lead_id) FILTER (WHERE c.conv_first)::int AS converted_first, 0::int AS ics
      FROM c CROSS JOIN LATERAL (VALUES ('lead_stage', c.lead_stage), ('class_raw', c.class_raw), ('lm_reason', c.lm_reason), ('lead_source', c.lead_source)) AS d(dim, key)
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
    // Yet to connect: only leads whose touch is at least this many days old (2026-11-27; 0 = every lead)
    const yetDays = Math.max(0, Math.min(365, Number.parseInt(q.yet_days ?? '5', 10) || 0));
    // part=top | rest (2026-11-26): the page asks for the first screen (tiles, Yet to connect, the two funnels) and the cards further down
    // separately, the lower part only when it is scrolled near, so the first screen does not queue behind 12 statements nobody looks at yet.
    // No part = everything (older pages, exports). The never-touched lead rows (untouched_dims) feed both halves, so both run them.
    const part = q.part === 'top' || q.part === 'rest' ? q.part : null;
    const REST = new Set(['stale', 'touch_point', 'lead_source', 'class_raw', 'call_reason', 'medium', 'campaign', 'staff', 'daily', 'lm_reason', 'tat', 'last_touch', 'ic_course']);
    const want = (n: string) => !part || n === 'untouched_dims' || (part === 'rest') === REST.has(n);
    const none = (): Promise<never[]> => Promise.resolve([]);
    // cards: one grouping-sets scan for every dim without its own filter; a filtered dim keeps its separate statement (its WHERE skips that filter)
    const sharedDims = CARD_DIMS.filter((d) => !f[d]?.length);
    // started on first use (a card of the lower half asks for it), not when the top half is answered
    let cardsMemo: ReturnType<typeof byDims> | null = null;
    const cardsP = () => (cardsMemo ??= byDims(sql, w, sharedDims, conv, convFirst));
    const card = (d: CardDim) => (f[d]?.length ? byDim(sql, wx(d), d, conv, convFirst, 2000, f[d] ?? []) : cardsP().then((x) => x[d] ?? []));
    // Lead source / Medium / Campaign / Staff as a split of Total leads (user rule 2026-11-04): each lead counted ONCE, under the value of its
    // FIRST touch in the selection (earliest touch); "touches" stays the number of touches carrying that value (a lead's later touches count
    // there, not in leads). The never-touched leads of the selection are folded in afterwards as a "(no touch)" row, so the leads column adds
    // up to Total leads. Same self-skip rule as the other cards: a filtered dim gets its own statement without that filter.
    const FT_DIMS = ['medium', 'campaign', 'staff'] as const;   // (the touch Source card became the lead's Lead Source, 2026-11-26)
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
    let ftMemo: ReturnType<typeof firstTouchDims> | null = null;
    const ftShared = () => (ftMemo ??= firstTouchDims(w, FT_DIMS.filter((d) => !f[d]?.length)));
    const ftCard = (d: FtDim): Promise<DimRow[]> => (f[d]?.length ? firstTouchDims(wx(d), [d]) : ftShared())
      .then((rows) => rows.filter((r) => r.dim === d).map(({ dim: _dim, ...r }) => ({ ...r, conv_rate: pct(r.converted, r.leads) })).sort((a, b) => b.leads - a.leads));
    const QN = ['kpis', 'stale', 'avg_window', 'avg_alltime', 'stages', 'ic_status', 'touch_point', 'lead_source', 'class_raw', 'call_reason', 'medium', 'campaign', 'staff', 'daily', 'stage_react', 'lm_reason', 'new_leads', 'revised_new', 'tat', 'leads_union', 'fees', 'ic_course', 'conv_ay', 'conv_untouched', 'untouched_dims', 'last_touch'];
    const [[k], [stale], [avgWin], [avgAll], stages, icStatus, touchPoint, leadSource, classRaw, reason, medium, campaign, staff, daily, reactRows, lmReason, [newLeads], revisedNew, tatRows, [leadsUnion], [fees], icCourse, convAy, [convU], uRows, lastTouch] = await timedAll(QN, [
      want('kpis') ? sql<{ touches: number; leads: number; converted: number; converted_first: number; converted_before: number; sf_converted: number; stage_conv_total: number; stage_conv_unpaid: number; paid_other_stage: number; touches_of_converted: number }[]>`
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
        FROM analytics.mv_touch_flat t WHERE ${w}` : none(),
      // leads in the selection still in stage New, created more than N days ago and not touched in the last N days
      (false as boolean) && want('stale') ? sql<{ stale_new: number; stale_new_untouched: number; new_total: number; stale_nc: number; stale_nc_untouched: number; nc_total: number }[]>`
        WITH n AS (
          SELECT t.lead_id, max(t.lead_stage) AS stage, max(t.lead_created_date) AS created, max(x.last_touch_at) AS last_touch
          FROM analytics.mv_touch_flat t LEFT JOIN analytics.mv_lead_last_touch x ON x.lead_id = t.lead_id
          WHERE ${w} AND t.lead_stage IN ('New', 'Not Connected') GROUP BY t.lead_id),
        s AS (SELECT stage, (created <= (now() AT TIME ZONE 'Asia/Kolkata')::date - ${staleDays}::int AND last_touch < now() - make_interval(days => ${staleDays})) AS stale,
                     (last_touch < created::timestamp AT TIME ZONE 'Asia/Kolkata' + interval '1 day') AS untouched FROM n)
        SELECT count(*) FILTER (WHERE stage = 'New' AND stale)::int AS stale_new, count(*) FILTER (WHERE stage = 'New' AND stale AND untouched)::int AS stale_new_untouched, count(*) FILTER (WHERE stage = 'New')::int AS new_total,
               count(*) FILTER (WHERE stage = 'Not Connected' AND stale)::int AS stale_nc, count(*) FILTER (WHERE stage = 'Not Connected' AND stale AND untouched)::int AS stale_nc_untouched, count(*) FILTER (WHERE stage = 'Not Connected')::int AS nc_total
        FROM s` : none(),
      // Tableau formula: AVG over touch rows (of leads with any valid payment) of the lead's all-time touch count
      // Avg touches before conversion (user, 2026-11-27): the touched leads of Total converted, each counted once; touches on or before the
      // first valid payment (is_pre_conversion). Overall = those touches on any date; date-wise = only the ones dated inside the range. The
      // same leads in both, so overall >= date-wise. (Was: all-time touch count incl. touches after paying, weighted by touch rows, and the
      // overall one ignored the date range: every converted lead in the database.)
      want('avg_window') ? sql<{ avg_rows: number | null; avg_leads: number | null; n_leads: number; n_touches: number }[]>`
        WITH c AS (SELECT DISTINCT t.lead_id FROM analytics.mv_touch_flat t WHERE ${w} AND ${convFirst})
        SELECT avg(n)::float8 AS avg_rows, avg(n)::float8 AS avg_leads, count(*)::int AS n_leads, COALESCE(sum(n), 0)::int AS n_touches
        FROM (SELECT (SELECT count(*) FROM analytics.mv_touch_flat t2 WHERE t2.lead_id = c.lead_id AND t2.is_pre_conversion
                        AND t2.touch_date BETWEEN ${periods.current.from} AND ${periods.current.to}) AS n FROM c) q` : none(),
      want('avg_alltime') ? sql<{ avg_rows: number | null; avg_leads: number | null; n_leads: number; n_touches: number }[]>`
        WITH c AS (SELECT DISTINCT t.lead_id FROM analytics.mv_touch_flat t WHERE ${w} AND ${convFirst})
        SELECT avg(n)::float8 AS avg_rows, avg(n)::float8 AS avg_leads, count(*)::int AS n_leads, COALESCE(sum(n), 0)::int AS n_touches
        FROM (SELECT (SELECT count(*) FROM analytics.mv_touch_flat t2 WHERE t2.lead_id = c.lead_id AND t2.is_pre_conversion) AS n FROM c) q` : none(),
      want('stages') ? sql<{ key: string; leads: number; converted: number }[]>`
        SELECT t.lead_stage AS key, count(DISTINCT t.lead_id)::int AS leads, count(DISTINCT t.lead_id) FILTER (WHERE ${conv})::int AS converted
        FROM analytics.mv_touch_flat t WHERE ${wx('lead_stage')} GROUP BY 1 ORDER BY leads DESC` : none(),
      want('ic_status') ? sql<{ key: string; leads: number; ics: number }[]>`
        SELECT btrim(ic.status__c) AS key, count(DISTINCT ic.lead_master__c)::int AS leads, count(*)::int AS ics
        FROM (SELECT DISTINCT t.lead_id FROM analytics.mv_touch_flat t WHERE ${wx('ic_status')}) k
        JOIN salesforce.interested_course__c ic ON ic.lead_master__c = k.lead_id AND ic.isdeleted = false
        WHERE NULLIF(btrim(ic.status__c),'') IS NOT NULL
        GROUP BY 1 ORDER BY leads DESC` : none(),
      want('touch_point') ? card('touch_point') : none(), want('lead_source') ? card('lead_source') : none(), want('class_raw') ? card('class_raw') : none(), want('call_reason') ? sql<DimRow[]>`
        SELECT CASE WHEN c.lead_id IS NULL THEN '(no call)' WHEN c.last_reason IS NULL THEN '(no reason recorded)' ELSE c.last_reason END AS key, count(*)::int AS touches, count(DISTINCT t.lead_id)::int AS leads,
               count(DISTINCT t.lead_id) FILTER (WHERE ${conv})::int AS converted, count(DISTINCT t.lead_id) FILTER (WHERE ${convFirst})::int AS converted_first
        FROM analytics.mv_touch_flat t LEFT JOIN salesforce.lead_calls c ON c.lead_id = t.lead_id
        WHERE ${wx('call_reason')} GROUP BY 1 ORDER BY leads DESC LIMIT 500` : none(),
      want('medium') ? ftCard('medium') : none(), want('campaign') ? ftCard('campaign') : none(), want('staff') ? ftCard('staff') : none(),
      want('daily') ? sql<{ d: string; touches: number; leads: number; converted: number }[]>`
        SELECT t.touch_date::text AS d, count(*)::int AS touches, count(DISTINCT t.lead_id)::int AS leads,
               count(DISTINCT t.lead_id) FILTER (WHERE ${conv})::int AS converted
        FROM analytics.mv_touch_flat t WHERE ${w} GROUP BY 1 ORDER BY 1` : none(),
      // leads parked in a closed stage that were touched AGAIN after entering it (stage moment from the Salesforce history log)
      want('stage_react') ? sql<{ stage: string; total: number; reactivated: number }[]>`
        WITH r AS (
          SELECT t.lead_id, max(t.lead_stage) AS stage, max(t.lead_created_date)::timestamptz AS created,
                 max(x.last_touch_at) AS last_touch   -- the lead's all-time last touch, precomputed (analytics.mv_lead_last_touch, sql/044)
          FROM analytics.mv_touch_flat t LEFT JOIN analytics.mv_lead_last_touch x ON x.lead_id = t.lead_id
          WHERE ${w} AND t.lead_stage IN ('Not Willing Now', 'Disqualified', 'P2 Completed') GROUP BY t.lead_id)   -- lost stages (Not Connected is not lost, 2026-11-27)
        SELECT r.stage, count(*)::int AS total,
               count(*) FILTER (WHERE r.last_touch > COALESCE(ls.changed_at, GREATEST(r.created, '2026-03-01 00:00:00+00'::timestamptz)))::int AS reactivated
        FROM r LEFT JOIN salesforce.lead_stage ls ON ls.lead_id = r.lead_id AND ls.stage = r.stage
        GROUP BY r.stage ORDER BY reactivated DESC` : none(),
      want('lm_reason') ? card('lm_reason') : none(),
      // New leads: every Salesforce lead created inside the window (most have no touch yet, so this reads the lead view, not the touch table).
      // Keep the touched test as a correlated EXISTS (index probe, ~0.1 s): `lead_id IN (SELECT ...)` inside the FILTER ran row by row (150 s).
      want('new_leads') ? sql<{ new_leads: number; new_leads_touched: number }[]>`
        SELECT count(*)::int AS new_leads,
               count(*) FILTER (WHERE EXISTS (SELECT 1 FROM analytics.mv_touch_flat t WHERE t.lead_id = l.lead_id))::int AS new_leads_touched
        FROM analytics.mv_lead_lite l WHERE ${newLeadWhere(sql, f, periods.current)}` : none(),   // narrow materialized copy (sql/035): the count scans a fraction of the lead table
      // Yet to connect: leads of the selection (every stage, Converted included) with NO contact on or after their FIRST TOUCH IN THE SELECTION: no call Task
      // (the Turnaround card's "activity", salesforce.lead_calls.call_days) AND no Lead Stage change AND no Interested Course status change
      // from that day on (a status is only changed after a call, so a change counts as contact even without a Task). "New" is never a
      // decision, on the lead or on a course: a new Interested Course created in status New after the touch is not contact. For Converted
      // leads only calls count: the stage Converted and the course statuses Enrolled / Already Enrolled are set by the payment, not by a
      // call. With a campaign selected the touch is that campaign's.
      // Leads in New are "already New", Converted leads their own split, the others "revised to New" (parked in a stage, touched again, nobody contacted them).
      // Yet to connect (2026-11-27): every lead of Total leads, by current LM stage; revised = nobody contacted it since whatever brought it
      // into the window (creation day, or its first touch in the window for an older lead on the touch-date basis), see yetToConnect
      want('revised_new') ? sql<{ stage: string; leads: number; revised: number }[]>`
        SELECT COALESCE(y.stage, '(blank)') AS stage, count(*)::int AS leads, count(*) FILTER (WHERE y.yet)::int AS revised
        FROM (${yetRows(sql, f, periods.current, yetDays)}) y
        GROUP BY 1 ORDER BY revised DESC, leads DESC` : none(),
      // Turnaround time of the converted leads in the selection: lead created -> first valid payment day, and latest touch on/before that day -> payment day
      want('tat') ? sql<{ kind: string; key: string; leads: number; avg_days: number | null; median_days: number | null }[]>`
        WITH c AS (
          SELECT t.lead_id, max(t.converted_at) AS paid, max(t.lead_created_date) AS created,
                 (SELECT max(t2.touch_date) FROM analytics.mv_touch_flat t2 WHERE t2.lead_id = t.lead_id AND t2.is_pre_conversion) AS last_touch
          FROM analytics.mv_touch_flat t WHERE ${w} AND ${conv} AND t.converted_at IS NOT NULL GROUP BY t.lead_id),
        d AS (SELECT 'created' AS kind, (paid - created)::int AS days FROM c
              UNION ALL SELECT 'touch', (paid - last_touch)::int FROM c),
        -- last touch -> first activity (user, 2026-11-27; was first touch), for EVERY lead of the selection (touch = the lead's latest touch among the selection's touch rows;
        -- activity = the lead's first Task on the Lead Master or its Interested Courses ON OR AFTER that touch, any later date,
        -- salesforce.lead_calls.call_days); none -> days NULL ('no activity')
        a AS (
          SELECT x.lead_id, ${activityDays(sql, sql`x.first_touch`)} AS days
          FROM (SELECT t.lead_id, max(t.touch_date) AS first_touch FROM analytics.mv_touch_flat t WHERE ${w} GROUP BY t.lead_id) x
          LEFT JOIN salesforce.lead_calls lc ON lc.lead_id = x.lead_id)
        SELECT kind, ${tatBucket(sql, sql`days`)} AS key, count(*)::int AS leads, NULL::float8 AS avg_days, NULL::float8 AS median_days FROM d GROUP BY 1, 2
        UNION ALL
        SELECT kind, '_all', count(*)::int, avg(days)::float8, percentile_cont(0.5) WITHIN GROUP (ORDER BY days)::float8 FROM d GROUP BY 1
        UNION ALL
        SELECT 'activity', ${activityBucket(sql, sql`days`)}, count(*)::int, NULL::float8, NULL::float8 FROM a GROUP BY 2
        UNION ALL
        SELECT 'activity', '_all', count(*)::int, avg(days)::float8, percentile_cont(0.5) WITHIN GROUP (ORDER BY days)::float8 FROM a` : none(),
      // Total leads on the TOUCH-date basis: leads created in the window OR touched in the window (on the lead-created basis Total leads
      // = the leads created in the window, touched or not = New leads)
      want('leads_union') ? f.basis !== 'created'
        ? sql<{ n: number }[]>`SELECT count(*)::int AS n FROM analytics.mv_lead_lite l WHERE ${newLeadWhere(sql, f, periods.current, { scope: 'union' })}`
        : Promise.resolve([{ n: 0 }]) : none(),
      // Proposed fee / fee received: valid payments (payment_method 0) dated inside the window, made by the app accounts of the leads in the
      // selection (own phone or alternative number). Proposed fee = fee - discount of the enrollments those payments belong to, each once.
      want('fees') ? sql<{ fee_payers: number; fee_payments: number; fee_received: number; proposed_fee: number; fee_enrollments: number; fee_enrollments_unknown: number }[]>`
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
               (SELECT count(*) FROM enr WHERE enrollment_fee IS NULL)::int AS fee_enrollments_unknown` : none(),
      // Interested course: the leads of the selection by the course name on their Interested Course records (a lead with several appears under each)
      want('ic_course') ? sql<DimRow[]>`
        WITH lk AS (
          SELECT t.lead_id, count(*)::int AS touches, bool_or(${conv}) AS conv, bool_or(${convFirst}) AS conv_first
          FROM analytics.mv_touch_flat t WHERE ${wx('ic_course')} GROUP BY t.lead_id)
        SELECT ${icCourseExpr(sql)} AS key, sum(lk.touches)::int AS touches, count(DISTINCT lk.lead_id)::int AS leads,
               count(DISTINCT lk.lead_id) FILTER (WHERE lk.conv)::int AS converted, count(DISTINCT lk.lead_id) FILTER (WHERE lk.conv_first)::int AS converted_first
        FROM lk JOIN salesforce.interested_course__c ic ON ic.lead_master__c = lk.lead_id AND ic.isdeleted = false
        LEFT JOIN salesforce.course__c cr ON cr.id = ic.course__c
        WHERE ${icCourseExpr(sql)} IS NOT NULL
        GROUP BY 1 ORDER BY leads DESC LIMIT 2000` : none(),
      // Academic-year split of the two conversion KPIs: the academic year of the course (core_syllabusstructure.academic_year, copied onto
      // app.core_batch) of the lead's LATEST valid payment THAT HAS one; Ujra bookings and old payments without a batch carry no year, so
      // a lead whose only payments are such = '(no academic year)'. The year written in a batch title is NOT used. Lookup on the lead's phone key.
      // Only app payments can carry a batch, so the lookup reads home_payment through mv_user_phone (the app branch of v_valid_payment_x)
      // once for the whole set of phone keys (DISTINCT ON) instead of a correlated subquery per converted lead (that form took ~15 s
      // inside the fan-out; this one ~2 s).
      want('conv_ay') ? sql<{ kind: string; key: string; leads: number }[]>`
        WITH c AS (
          SELECT t.lead_id, bool_or(${convFirst}) AS after_touch, bool_or(${convBefore}) AS before_win
          FROM analytics.mv_touch_flat t WHERE ${w} GROUP BY t.lead_id
          HAVING bool_or(${convFirst}) OR bool_or(${convBefore})
          UNION ALL
          SELECT u.lead_id, ${uAfter}, ${uBefore} FROM (${untouched}) u WHERE ${uAfter} OR ${uBefore}),
        cm AS (SELECT c.after_touch, c.before_win, m.phone_key FROM c JOIN analytics.mv_lead_lite m ON m.lead_id = c.lead_id),
        -- the latest academic year of the number is precomputed per phone (analytics.mv_phone_pay.latest_ay, sql/054: the same DISTINCT ON
        -- over home_payment -> core_batch, built once per refresh instead of once per Overview)
        a AS (SELECT cm.after_touch, cm.before_win, COALESCE(pp.latest_ay, '(no academic year)') AS ay FROM cm LEFT JOIN analytics.mv_phone_pay pp ON pp.phone_key = cm.phone_key)
        SELECT 'after' AS kind, ay AS key, count(*)::int AS leads FROM a WHERE after_touch GROUP BY 2
        UNION ALL
        SELECT 'before', ay, count(*)::int FROM a WHERE before_win GROUP BY 2
        ORDER BY 1, 2 DESC` : none(),
      // the never-touched leads of the selection that count as converted (after) / already customers (before), see `untouched` above
      want('conv_untouched') ? sql<{ after: number; before: number }[]>`SELECT count(*) FILTER (WHERE ${uAfter})::int AS after, count(*) FILTER (WHERE ${uBefore})::int AS before FROM (${untouched}) u` : none(),
      want('untouched_dims') ? untouchedCards : none(),
      want('last_touch') ? sql<DimRow[]>`
        WITH s AS (
          SELECT t.lead_id, t.touch_point, COALESCE(t.tab_is_last_touch, false) AS is_last, t.touch_at, t.touch_id, (${conv}) AS c, (${convFirst}) AS cf,
                 (COALESCE(t.tab_is_last_touch, false) AND ${appOnlyQuick(sql)}) AS nc
          FROM analytics.mv_touch_flat t WHERE ${wx('touch_point')}),
        pick AS (SELECT DISTINCT ON (s.lead_id) s.lead_id, s.touch_point FROM s ORDER BY s.lead_id, s.is_last DESC, s.touch_at DESC, s.touch_id DESC),
        a AS (SELECT s.lead_id, bool_or(s.c) AS c, bool_or(s.cf) AS cf, bool_or(s.nc) AS nc FROM s GROUP BY s.lead_id)
        SELECT CASE WHEN a.nc THEN '(no touch)' ELSE COALESCE(p.touch_point, '(null)') END AS key, count(*)::int AS touches, count(*)::int AS leads,
               count(*) FILTER (WHERE a.c)::int AS converted, count(*) FILTER (WHERE a.cf)::int AS converted_first
        FROM pick p JOIN a ON a.lead_id = p.lead_id GROUP BY 1` : none(),
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
    }).map((r) => ({ ...r, conv_rate: pct(r.converted, r.leads) }))   // every row gets its rate, not only the folded ones (2026-11-27)
      .sort((a, b) => b[sortBy] - a[sortBy]);
    const stagesAll = fold(stages, 'lead_stage', (r, u) => ({ key: r?.key ?? u.key, leads: (r?.leads ?? 0) + u.leads, converted: (r?.converted ?? 0) + u.converted })).sort((a, b) => b.leads - a.leads);
    const icStatusAll = fold(icStatus, 'ic_status', (r, u) => ({ key: r?.key ?? u.key, leads: (r?.leads ?? 0) + u.leads, ics: (r?.ics ?? 0) + u.ics })).sort((a, b) => b.leads - a.leads);
    const classRawAll = foldDim(classRaw, 'class_raw', 'touches'), lmReasonAll = foldDim(lmReason, 'lm_reason', 'touches');
    const reasonAll = foldDim(reason, 'call_reason'), icCourseAll = foldDim(icCourse, 'ic_course');
    const leadSourceAll = foldDim(leadSource, 'lead_source'), lastTouchAll = foldDim(lastTouch, 'no_touch'), mediumAll = foldDim(medium, 'no_touch'), campaignAll = foldDim(campaign, 'no_touch'), staffAll = foldDim(staff, 'no_touch');
    const uStage = (key: string) => uBy('stage_conv').find((r) => r.key === key)?.leads ?? 0;
    const defs = (): Record<string, string> => ({
        leads: f.basis === 'created'
          ? 'Leads created in the date range, touched or not. Deleted and duplicate leads are left out (duplicates can be switched on).'
          : 'Leads with a touch dated in the range. Deleted and duplicate leads are left out (duplicates can be switched on).',
        touches: 'Touches dated in the range: app installs, webinars, forms, ads, community joins. One lead can have many.',
        converted: pp
          ? `Leads with a valid payment between ${pp.from} and ${pp.to}.`
          : 'Leads with a valid payment on or after one of their touches. Payments match on the phone number or the alternative number.',
        proposed_fee: 'Proposed fee = course fee minus discount, for courses paid in the range. Each course counted once. It is the agreed price, so it is higher than the fee received while instalments are open.',
        fee_received: 'Fee received = the payments made in the range, for the same leads.',
        tat: 'Days from one step to the next. Lead created → paid = creation day to first payment. Last touch → paid = last touch before the payment to the payment. Last touch → first activity = touch day to the first call Task after it. Median = half the leads were faster. Click a band to see the leads.',
        ic_course: 'Leads by the course they showed interest in (not what they bought). A lead with several courses appears under each. Purchased courses are on the Converted page.',
        new_leads: 'Leads created in the range, touched or not. With a touch = at least one touch on record.',
        leads_basis: f.basis === 'created' ? 'Dates = lead created date.' : 'Dates = touch date.',
        converted_first: 'Leads whose first payment came on or after a touch, and inside the window. Never-touched leads count when they paid after the lead was created ("no touch" split).',
        sf_converted: 'Touched leads marked Converted in Salesforce (reference only).',
        yet_new: `Leads of Total leads nobody has contacted since they came into the window: no call, no stage change and no course status change since the lead was created${f.basis === 'created' ? '' : ', or since its last touch in the range when that is later'}${yetDays ? `, ${yetDays} or more days ago` : ''}. New and Converted = current LM stage. Revised to New = every other stage: worked before, came back, not contacted since.`,
        stage_react: 'Lost = Not Willing Now, Disqualified or P2 Completed. Counts the lost leads that got a new touch after entering that stage. "Of N lost leads" = those three stages in the LM funnel.',
        stage_conv_unpaid: 'Leads in stage Converted with no valid payment.',
        paid_other_stage: 'Leads that paid but are not in stage Converted.',
        converted_before: 'Leads that paid before their last touch in the range: customers who were touched again. A lead can also be in Total converted.',
        class_on: 'Class filter = purchased class: the lead paid for a course of the picked class. One lead can be in both conversion tiles.',
        conv_ay: 'Academic year = the academic year of the course in the lead\x27s latest payment. Ujra bookings have none.',
        avg_touches_alltime: 'Leads in Total converted: average touches on or before the payment, any date.',
        avg_touches_window: 'Leads in Total converted: average touches on or before the payment, dated inside the range.',
        avg_per_lead: 'Each lead counted once.',
        lead_source: 'The Lead Source on the lead record. Each lead counted once, so the column adds up to Total leads.',
        last_touch: 'Each lead under its last touch point. For a paying lead, the last touch before the payment; an app install less than 2 hours before the payment is skipped. When the app install is the only touch and came less than 30 minutes before the payment, the lead counts as no touch.',
        lm_reason: 'The LM Reason on the lead record, set by the salesperson.',
        reason: 'The reason on the lead\'s last call. No call = no call logged since May 2026.',
        stale_new: `Leads still in stage New, created over ${staleDays} days ago, with no touch in the last ${staleDays} days.`,
        stale_nc: `Same for stage Not Connected.`,
        dim_converted: 'Converted = leads with a touch of that value that paid. A lead can appear in several rows. An Eduport App touch less than 2 hours before the payment does not count, unless it is the only touch.',
    });
    if (part === 'rest') return {
      period: periods.current, payment_period: pp, basis: f.basis === 'created' ? 'created' : 'touch', part,
      kpis: {
        stale_new: stale?.stale_new ?? 0, stale_new_untouched: stale?.stale_new_untouched ?? 0, new_total: stale?.new_total ?? 0, stale_days: staleDays,
        stale_nc: stale?.stale_nc ?? 0, stale_nc_untouched: stale?.stale_nc_untouched ?? 0, nc_total: stale?.nc_total ?? 0,
      },
      ic_course: icCourseAll, tat: { created: tatShape('created'), touch: tatShape('touch'), activity: tatShape('activity') },
      touch_point: touchPoint, lead_source: leadSourceAll, last_touch: lastTouchAll, class_raw: classRawAll, reason: reasonAll, lm_reason: lmReasonAll, medium: mediumAll, campaign: campaignAll, staff: staffAll, daily,
      definitions: defs(),
    };
    const leadsAll = f.basis === 'created' ? (newLeads?.new_leads ?? k.leads) : (leadsUnion?.n ?? k.leads);
    return {
      period: periods.current, payment_period: pp, basis: f.basis === 'created' ? 'created' : 'touch',
      kpis: {
        ...k,
        // Lead-created basis: Total leads = leads created in the window (touched or not) + leads touched in the window; New leads = the created ones.
        // Touch-date basis: leads with a touch dated in the window. leads_touched = leads of the selection that have a touch (base of the rates).
        leads: leadsAll, leads_touched: k.leads,
        // the two conversion KPIs cover the whole Total leads population: touched leads (payment on/after a touch) + never-touched leads
        converted_first: k.converted_first + (convU?.after ?? 0),
        converted_before: k.converted_before + (convU?.before ?? 0),
        converted_untouched: convU?.after ?? 0, converted_before_untouched: convU?.before ?? 0,
        // the filter-bar class switch as applied: 'bought' only when it is on AND a Class is picked
        class_on: bb ? 'bought' : 'lead',
        stage_conv_total: k.stage_conv_total + uStage('total'), stage_conv_unpaid: k.stage_conv_unpaid + uStage('unpaid'), paid_other_stage: k.paid_other_stage + uStage('paid_other'),
        stage_react: reactRows.reduce((a, r) => a + r.reactivated, 0),
        // the lost leads of Total leads (touched or not) = the three lost slices of the LM funnel
        stage_react_total: stagesAll.filter((s) => ['Not Willing Now', 'Disqualified', 'P2 Completed'].includes(s.key)).reduce((a, s) => a + s.leads, 0),
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
        avg_touches_alltime_n: avgAll?.n_leads ?? 0, avg_touches_alltime_touches: avgAll?.n_touches ?? 0,
        avg_touches_window: avgWin?.avg_rows ?? null,
        avg_touches_window_per_lead: avgWin?.avg_leads ?? null,
        avg_touches_window_n: avgWin?.n_leads ?? 0, avg_touches_window_touches: avgWin?.n_touches ?? 0,
        stale_new: stale?.stale_new ?? 0, stale_new_untouched: stale?.stale_new_untouched ?? 0, new_total: stale?.new_total ?? 0, stale_days: staleDays,
        stale_nc: stale?.stale_nc ?? 0, stale_nc_untouched: stale?.stale_nc_untouched ?? 0, nc_total: stale?.nc_total ?? 0,
        new_leads: newLeads?.new_leads ?? 0, new_leads_touched: newLeads?.new_leads_touched ?? 0,
        // Yet to connect over Total leads (2026-11-27), split by current LM stage
        yet_new: revisedNew.reduce((a, r) => a + r.revised, 0),
        yet_new_by: revisedNew, yet_days: yetDays,
        ...(fees ?? { fee_payers: 0, fee_payments: 0, fee_received: 0, proposed_fee: 0, fee_enrollments: 0, fee_enrollments_unknown: 0 }), fee_window: feeWin,
      },
      stages: stagesAll, ic_status: icStatusAll, ic_course: icCourseAll, tat: { created: tatShape('created'), touch: tatShape('touch'), activity: tatShape('activity') },
      touch_point: touchPoint, lead_source: leadSourceAll, last_touch: lastTouchAll, class_raw: classRawAll, reason: reasonAll, lm_reason: lmReasonAll, medium: mediumAll, campaign: campaignAll, staff: staffAll, daily,
      definitions: defs(),
    };
  }),
);
