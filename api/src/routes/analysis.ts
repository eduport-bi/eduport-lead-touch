import { Hono } from 'hono';
import type { AppEnv, Role } from '../env';
import { maskEmail, maskName, maskPhone } from '../http';
import { getSql, release } from '../db';

/**
 * POST /api/analysis/phones   body: { phones: string[] }   (max 2,000 per call; the page sends chunks)
 * Looks up leads, payments and touches for a list of phone numbers. Nothing is written or stored:
 * the spreadsheet stays in the browser, only the normalised numbers travel here, and the response is not kept.
 * Phone matching = last 10 digits (analytics.phone_key), same as everywhere else on the dashboard.
 */
export const analysis = new Hono<AppEnv>();

type Rec = Record<string, unknown>;
const normalise = (v: unknown): string | null => { const d = String(v ?? '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : null; };

function maskRow(r: Rec, role: Role): Rec {
  return { ...r, mobile: maskPhone(r.mobile as string | null, role), email: maskEmail(r.email as string | null, role), first_name: maskName(r.first_name as string | null, role), last_name: maskName(r.last_name as string | null, role) };
}

analysis.post('/analysis/phones', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { phones?: unknown };
  const raw = Array.isArray(body.phones) ? body.phones : [];
  if (raw.length > 2000) return c.json({ error: { code: 'bad_request', message: 'at most 2000 phones per request' } }, 400);
  const phones = [...new Set(raw.map(normalise).filter((x): x is string => !!x))];
  if (!phones.length) return c.json({ data: { rows: [], phones: 0 } });
  const role = c.get('user').role;
  const sql = getSql(c.env);
  try {
    const rows = await sql<Rec[]>`
      WITH p AS (SELECT DISTINCT x AS phone_key FROM unnest(string_to_array(${phones.join(",")}, ',')) AS x),
      leads AS (
        SELECT p.phone_key, l.id AS lead_id, l.name AS lead_name, l.first_name__c AS first_name, l.last_name__c AS last_name, l.mobile_number__c AS mobile, l.email__c AS email,
               l.createddate AS created_at, l.lead_stage__c AS lead_stage, l.class__c AS class_raw, analytics.class_group(l.class__c) AS class_group,
               l.lead_source__c AS lead_source, l.lead_type__c AS lead_type, l.district__c AS district, l.city__c AS city, l.lm_reason__c AS lm_reason,
               l.best_ic_status__c AS best_ic_status, COALESCE(l.is_converted__c, false) AS sf_is_converted, l.touch_count__c AS sf_touch_count,
               COALESCE(l.is_duplicate__c, false) AS is_duplicate, COALESCE(u.name, l.ownerid::text) AS owner_name
        FROM p JOIN salesforce.lead_master__c l ON analytics.phone_key(l.mobile_number__c) = p.phone_key
        LEFT JOIN salesforce."user" u ON u.id::text = l.ownerid::text
        WHERE COALESCE(l.isdeleted, false) = false AND COALESCE(l.is_deleted__c, false) = false),
      pay AS (
        SELECT p.phone_key, min(cu.user_id) AS eps_id, min(hp.payment_date) AS first_payment_date, max(hp.payment_date) AS last_payment_date,
               count(*)::int AS payments, sum(hp.amount)::float8 AS revenue,
               string_agg(DISTINCT COALESCE(b.title, hp.course_label, 'batch ' || COALESCE(hp.enrollment_batch_id, hp.batch_id)::text), ' | ') AS courses,
               -- academic year of a payment: the batch's syllabus academic year (app core_syllabusstructure), else the batch title, else the payment date (April start)
               (array_agg(analytics.academic_year(b.academic_year, COALESCE(b.title, hp.course_label), hp.payment_date) ORDER BY hp.payment_date, hp.id))[1] AS converted_academic_year,
               (array_agg(analytics.academic_year(b.academic_year, COALESCE(b.title, hp.course_label), hp.payment_date) ORDER BY hp.payment_date DESC, hp.id DESC))[1] AS last_paid_academic_year,
               string_agg(DISTINCT analytics.academic_year(b.academic_year, COALESCE(b.title, hp.course_label), hp.payment_date), ' | ') AS academic_years
        -- the paying account's own phone or its alternative number
        FROM p JOIN analytics.mv_user_phone cu ON cu.phone_key = p.phone_key
        JOIN analytics.v_payment_all hp ON hp.user_id = cu.user_id AND hp.payment_method = 0 AND hp.deleted = false AND hp.is_success = true AND hp.payment_success = true
        LEFT JOIN app.core_batch b ON b.id = COALESCE(hp.enrollment_batch_id, hp.batch_id)
        GROUP BY 1),
      -- any app account on the number (paying or not); the EPS ID shown prefers the paying account
      acct AS (SELECT p.phone_key, min(cu.user_id)::int AS eps_id FROM p JOIN analytics.mv_user_phone cu ON cu.phone_key = p.phone_key GROUP BY 1),
      tch AS (
        SELECT t.lead_id, count(*)::int AS touches, min(t.touch_at) AS first_touch_at, max(t.touch_at) AS last_touch_at,
               (array_agg(t.touch_point ORDER BY t.touch_at))[1] AS first_touch_point, (array_agg(t.touch_point ORDER BY t.touch_at DESC))[1] AS last_touch_point,
               (array_agg(t.staff ORDER BY t.touch_at DESC) FILTER (WHERE t.staff IS NOT NULL))[1] AS last_touch_staff,
               string_agg(DISTINCT t.touch_point, ', ') AS touch_points, string_agg(DISTINCT t.campaign, ', ') FILTER (WHERE t.campaign <> '(blank)') AS campaigns
        FROM analytics.mv_touch_flat t WHERE t.lead_id IN (SELECT lead_id FROM leads) GROUP BY 1),
      -- last activity: the latest of the lead's touches, calls and stage change (LM activity) and of its interested courses'
      -- status changes / creation (IC activity). Record edits by automations are not counted (SystemModstamp is noisy).
      act AS (
        SELECT x.lead_id, x.at, x.kind FROM (
          SELECT lead_id, at, kind, row_number() OVER (PARTITION BY lead_id ORDER BY at DESC) AS rn FROM (
            SELECT t.lead_id, max(t.touch_at) AS at, 'LM touch'::text AS kind FROM analytics.mv_touch_flat t WHERE t.lead_id IN (SELECT lead_id FROM leads) GROUP BY 1
            UNION ALL SELECT c.lead_id, c.last_call_at, 'LM call' FROM salesforce.lead_calls c WHERE c.lead_id IN (SELECT lead_id FROM leads)
            UNION ALL SELECT s.lead_id, s.changed_at, 'LM stage change' FROM salesforce.lead_stage s WHERE s.lead_id IN (SELECT lead_id FROM leads)
            UNION ALL SELECT ic.lead_master__c, max(ic.createddate), 'IC created' FROM salesforce.interested_course__c ic WHERE ic.lead_master__c IN (SELECT lead_id FROM leads) AND ic.isdeleted = false GROUP BY 1
            UNION ALL SELECT h.lead_id, max(h.changed_at), 'IC status change' FROM salesforce.ic_status h WHERE h.lead_id IN (SELECT lead_id FROM leads) GROUP BY 1
          ) a WHERE a.at IS NOT NULL) x WHERE x.rn = 1),
      lm AS (
        SELECT lead_id, max(at) AS at FROM (
          SELECT t.lead_id, max(t.touch_at) AS at FROM analytics.mv_touch_flat t WHERE t.lead_id IN (SELECT lead_id FROM leads) GROUP BY 1
          UNION ALL SELECT c.lead_id, c.last_call_at FROM salesforce.lead_calls c WHERE c.lead_id IN (SELECT lead_id FROM leads)
          UNION ALL SELECT s.lead_id, s.changed_at FROM salesforce.lead_stage s WHERE s.lead_id IN (SELECT lead_id FROM leads)) a GROUP BY 1),
      icx AS (
        SELECT lead_id, max(at) AS at FROM (
          SELECT ic.lead_master__c AS lead_id, max(ic.createddate) AS at FROM salesforce.interested_course__c ic WHERE ic.lead_master__c IN (SELECT lead_id FROM leads) AND ic.isdeleted = false GROUP BY 1
          UNION ALL SELECT h.lead_id, max(h.changed_at) FROM salesforce.ic_status h WHERE h.lead_id IN (SELECT lead_id FROM leads) GROUP BY 1) a GROUP BY 1)
      SELECT p.phone_key, (leads.lead_id IS NOT NULL) AS matched,
             leads.lead_id, leads.lead_name, leads.first_name, leads.last_name, leads.mobile, leads.email, leads.created_at::text AS created_at,
             leads.lead_stage, leads.class_raw, leads.class_group, leads.lead_source, leads.lead_type, leads.district, leads.city, leads.owner_name,
             leads.lm_reason, leads.best_ic_status, leads.sf_is_converted, leads.sf_touch_count, leads.is_duplicate,
             COALESCE(pay.eps_id, acct.eps_id)::int AS eps_id, (acct.eps_id IS NOT NULL) AS has_app_account, (pay.payments IS NOT NULL) AS converted, pay.first_payment_date::text AS first_payment_date, pay.last_payment_date::text AS last_payment_date,
             pay.payments, pay.revenue, pay.courses, pay.converted_academic_year, pay.last_paid_academic_year, pay.academic_years,
             tch.touches, tch.first_touch_at::text AS first_touch_at, tch.first_touch_point, tch.last_touch_at::text AS last_touch_at, tch.last_touch_point, tch.last_touch_staff,
             tch.touch_points, tch.campaigns,
             floor(EXTRACT(epoch FROM now() - tch.last_touch_at) / 86400)::int AS days_since_last_touch,
             act.at::text AS last_activity_at, act.kind AS last_activity_type, floor(EXTRACT(epoch FROM now() - act.at) / 86400)::int AS days_since_activity,
             lm.at::text AS lm_last_activity_at, icx.at::text AS ic_last_activity_at,
             lcall.last_call_at::text AS last_call_at, lcall.last_reason AS last_call_reason, COALESCE(lcall.calls, 0) AS calls   -- 2026-11-24
      FROM p
      LEFT JOIN leads ON leads.phone_key = p.phone_key
      LEFT JOIN pay ON pay.phone_key = p.phone_key
      LEFT JOIN acct ON acct.phone_key = p.phone_key
      LEFT JOIN tch ON tch.lead_id = leads.lead_id
      LEFT JOIN act ON act.lead_id = leads.lead_id
      LEFT JOIN lm ON lm.lead_id = leads.lead_id
      LEFT JOIN icx ON icx.lead_id = leads.lead_id
      LEFT JOIN salesforce.lead_calls lcall ON lcall.lead_id = leads.lead_id
      ORDER BY p.phone_key, leads.created_at DESC NULLS LAST`;
    return c.json({ data: { rows: rows.map((r) => maskRow(r, role)), phones: phones.length, masked: role === 'viewer' } }, 200, { 'Cache-Control': 'private, no-store' });
  } finally {
    release(sql, c.executionCtx);
  }
});
