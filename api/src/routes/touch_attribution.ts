import { Hono } from 'hono';
import type { Sql } from 'postgres';
import type { AppEnv } from '../env';
import { handle, pct } from '../http';
import type { Frag } from '../filters';
import { flatWhere, convCond, appQuickTouch, appOnlyQuick } from './overview';

/**
 * GET /api/touch-attribution?mode=first|last  - the Tableau "Lead Touch - First Touch" / "Lead Touch - Last Touch" dashboards.
 * Touch grain, touch-date window, same per-dimension sheets (touch point, class, source, medium, campaign) with
 *   Total leads  = COUNTD(lead) over touches in the window with that value
 *   Converted    = COUNTD(lead) with any valid payment on/after such a touch           (workbook "Converted")
 *   first touch  = COUNTD(lead) whose *selected first touch* is such a touch and converted (workbook "first touch")
 *   last touch   = COUNTD(lead) whose *last valid touch* (latest touch made before the moment of its last valid payment) is such a touch.
 *                  Deviation from the workbook's "lasttouch point count", which excludes every payment-day touch (it reads the payment date as midnight).
 *   percentage   = first touch / Total leads   |   % = Converted / Total leads
 * Selected first touch = the lead's earliest touch on/after 2026-03-01, else its latest touch (workbook LODs).
 */
export const touchAttribution = new Hono<AppEnv>();

export interface AttrRow { key: string; touches: number; leads: number; converted: number; attributed: number; conv_pct: number | null; attr_pct: number | null; share_pct: number | null }

async function byDim(sql: Sql, w: Frag, col: string, flag: Frag, conv: Frag, limit = 2000): Promise<AttrRow[]> {
  const rows = await sql<{ key: string; touches: number; leads: number; converted: number; attributed: number }[]>`
    SELECT COALESCE(t.${sql(col)}::text, '(null)') AS key, count(*)::int AS touches, count(DISTINCT t.lead_id)::int AS leads,
           -- an Eduport App touch less than 2 h before the payment does not make the lead converted under its values (2026-11-27)
           count(DISTINCT t.lead_id) FILTER (WHERE ${conv} AND NOT ${appQuickTouch(sql)})::int AS converted,
           count(DISTINCT t.lead_id) FILTER (WHERE ${flag})::int AS attributed
    FROM analytics.mv_touch_flat t WHERE ${w} GROUP BY 1 ORDER BY attributed DESC, leads DESC LIMIT ${limit}`;
  const totalAttr = rows.reduce((s, r) => s + r.attributed, 0);
  return rows.map((r) => ({ ...r, conv_pct: pct(r.converted, r.leads), attr_pct: pct(r.attributed, r.leads), share_pct: pct(r.attributed, totalAttr) }));
}

touchAttribution.get('/touch-attribution', (c) =>
  handle(c, async ({ sql, f, periods, q }) => {
    const mode = q.mode === 'last' ? 'last' : 'first';
    const w = flatWhere(sql, f, periods.current);
    const wx = (skip: string) => flatWhere(sql, f, periods.current, skip);   // a card never filters itself
    const conv = convCond(sql, f);
    // an only-touch app install less than 30 min before the payment gets no credit (appOnlyQuick)
    const flag = mode === 'first' ? sql`t.tab_is_first_touch AND ${conv} AND NOT ${appOnlyQuick(sql)}` : sql`t.tab_is_last_touch AND ${conv} AND NOT ${appOnlyQuick(sql)}`;
    const [[k], touchPoint, classRaw, source, medium, campaign, daily] = await Promise.all([
      sql<{ touches: number; leads: number; converted: number; attributed: number; attributed_touches: number }[]>`
        SELECT count(*)::int AS touches, count(DISTINCT t.lead_id)::int AS leads,
               count(DISTINCT t.lead_id) FILTER (WHERE ${conv})::int AS converted,
               count(DISTINCT t.lead_id) FILTER (WHERE ${flag})::int AS attributed,
               count(*) FILTER (WHERE ${mode === 'first' ? sql`t.tab_is_first_touch` : sql`t.tab_is_last_touch`})::int AS attributed_touches
        FROM analytics.mv_touch_flat t WHERE ${w}`,
      byDim(sql, wx('touch_point'), 'touch_point', flag, conv), byDim(sql, wx('class_raw'), 'class_raw', flag, conv), byDim(sql, wx('source'), 'source', flag, conv), byDim(sql, wx('medium'), 'medium', flag, conv), byDim(sql, wx('campaign'), 'campaign', flag, conv),
      sql<{ d: string; leads: number; attributed: number }[]>`
        SELECT t.touch_date::text AS d, count(DISTINCT t.lead_id)::int AS leads, count(DISTINCT t.lead_id) FILTER (WHERE ${flag})::int AS attributed
        FROM analytics.mv_touch_flat t WHERE ${w} GROUP BY 1 ORDER BY 1`,
    ]);
    const label = mode === 'first' ? 'First-touch conversions' : 'Last-touch conversions';
    return {
      mode, period: periods.current,
      kpis: { ...k, conv_pct: pct(k.converted, k.leads), attr_pct: pct(k.attributed, k.leads), attr_of_converted_pct: pct(k.attributed, k.converted) },
      touch_point: touchPoint, class_raw: classRaw, source, medium, campaign, daily,
      definitions: {
        leads: 'Leads with a touch in the date range.',
        converted: 'Touched leads that paid on or after a touch.',
        attributed: mode === 'first'
          ? 'Converted leads credited to their first touch (the earliest since 1 Mar 2026). Each lead counted once.'
          : 'Converted leads credited to their last touch before the payment. An app install less than 2 hours before the payment is skipped, unless it is the only touch. Each lead counted once.',
        attr_pct: mode === 'first' ? 'First-touch conversions ÷ Total leads.' : 'Last-touch conversions ÷ Total leads.',
        share_pct: `Share of all ${label.toLowerCase()} in the table.`,
        conv_pct: 'Converted ÷ Total leads.',
      },
    };
  }),
);
