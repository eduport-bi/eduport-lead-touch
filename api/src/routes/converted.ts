import { Hono } from 'hono';
import type { Sql } from 'postgres';
import type { AppEnv, Role } from '../env';
import { handle, intParam, maskEmail, maskName, maskPhone, pct, csvStream, timedAll } from '../http';
import { LIST_KEYS, parseFilters, resolvePeriods, type Filters, type Frag, type Period } from '../filters';
import { shapeTat, tatBucket, type TatRow } from './overview';

/**
 * "Converted" page = Tableau workbook "Converted", dashboard "Lead Touch - Converted".
 *   grain   : paying app user with a valid payment whose PAYMENT DATE is in the window (the page's date range is the payment date)
 *   credit  : the user's last touch on/before its last valid payment date (same day included), across all leads on the same phone;
 *             users with no touch before the payment are shown as "No Touch Before Payment"
 *   class   : grade of the purchased course (core_grade.title) -> the in-page "Purchased grade" filter and table
 *   sheets  : CONVERTED (users), Lead stage distribution, Class wise conversion (purchased course), STAFF-WISE,
 *             Lead source / Touch point / Medium / Campaign / Staff by LAST touch, and the same five by FIRST touch (2026-11-05)
 * Reads analytics.mv_payer (one row per paying user) + app.home_payment/app.core_batch for per-payment course & grade.
 */
export const converted = new Hono<AppEnv>();

type Rec = Record<string, unknown>;
/** pm = all | m0 (Tableau rule, payment_method 0) | m1 (payment_method 1 = gateway EMI instalments) */
export type PayMethod = 'all' | 'm0' | 'm1';
export const payMethod = (q: Record<string, string>): PayMethod => (q.pm === 'm0' || q.pm === 'm1' ? q.pm : 'all');
const VALID = (sql: Sql, pm: PayMethod = 'all') => sql`hp.deleted = false AND hp.is_success = true AND hp.payment_success = true ${pm === 'm0' ? sql`AND hp.payment_method = 0` : pm === 'm1' ? sql`AND hp.payment_method <> 0` : sql``}`;

/** global filter chips that make sense on the payer grain */
const PAYER_COLS: Partial<Record<(typeof LIST_KEYS)[number], string>> = {
  lead_stage: 'lead_stage', lead_source: 'lead_source', class_raw: 'class_raw', class_group: 'class_group', owner: 'owner_name',
  medium: 'last_touch_medium', source: 'last_touch_source', touch_point: 'last_touch_point', campaign: 'last_touch_campaign', staff: 'last_touch_staff',
};
const DIMS: Record<string, string> = {
  last_touch_point: 'last_touch_point', last_touch_source: 'last_touch_source', last_touch_medium: 'last_touch_medium', last_touch_campaign: 'last_touch_campaign',
  last_touch_staff: 'last_touch_staff', lead_stage: 'lead_stage', lead_source: 'lead_source', class_raw: 'class_raw', owner_name: 'owner_name',
};

/**
 * First touch of a paying user (2026-11-05): the EARLIEST touch, across the Salesforce leads on the account's own phone or alternative number
 * (mv_user_phone, the same lead set mv_payer uses), dated on/before the user's last valid payment day; users whose touches all came after the
 * payment (or with no lead) are "No Touch Before Payment", like the last-touch credit. mv_payer stores the last touch only, so this is computed
 * precomputed in analytics.mv_payer_first_touch (sql/048, one row per payer, refreshed right after mv_payer): computed per request it cost
 * 8-28 s for a month of payers. A payer missing there (new since the last refresh) reads as "No Touch Before Payment" until the next refresh.
 * `w` = the payer selection; the rows carry user_id, the five first-touch values and the measures the cards sum.
 */
function firstTouchSet(sql: Sql, w: Frag, firstPay: Frag): Frag {
  return sql`
    SELECT m.user_id, m.touches_before_payment, m.revenue, ${firstPay} AS first_pay, ft.first_touch_at,
           COALESCE(ft.first_touch_point, 'No Touch Before Payment') AS first_touch_point, COALESCE(ft.first_touch_source, 'No Touch Before Payment') AS first_touch_source,
           COALESCE(ft.first_touch_medium, 'No Touch Before Payment') AS first_touch_medium, COALESCE(ft.first_touch_campaign, 'No Touch Before Payment') AS first_touch_campaign,
           COALESCE(ft.first_touch_staff, 'No Touch Before Payment') AS first_touch_staff
    FROM analytics.mv_payer m LEFT JOIN analytics.mv_payer_first_touch ft ON ft.user_id = m.user_id WHERE ${w}`;
}
const FIRST_DIMS = ['first_touch_point', 'first_touch_source', 'first_touch_medium', 'first_touch_campaign', 'first_touch_staff'] as const;
/** the touch before the credited last touch (sql/049): 'No Earlier Touch' when the credited one was the only touch, or there was none */
const PREV_SOURCE = (sql: Sql) => sql`COALESCE((SELECT ft.prev_touch_source FROM analytics.mv_payer_first_touch ft WHERE ft.user_id = m.user_id), 'No Earlier Touch')`;

/** payments-in-window semi-join (+ optional grade / course restriction) */
function payWindow(sql: Sql, p: Period, grades: string[], courses: string[], pm: PayMethod = 'all'): Frag {
  const gradeCond = grades.length ? sql`AND COALESCE(hp.grade_label, b.grade_title, 'No Grade On Batch') IN ${sql(grades)}` : sql``;
  const courseCond = courses.length ? sql`AND COALESCE(hp.course_label, analytics.course_label(b.title, b.course_title, COALESCE(hp.enrollment_batch_id, hp.batch_id))) IN ${sql(courses)}` : sql``;
  return sql`EXISTS (SELECT 1 FROM analytics.v_payment_all hp LEFT JOIN app.core_batch b ON b.id = COALESCE(hp.enrollment_batch_id, hp.batch_id)
                     WHERE hp.user_id = m.user_id AND ${VALID(sql, pm)} AND hp.payment_date BETWEEN ${p.from} AND ${p.to} ${gradeCond} ${courseCond})`;
}

/** grade / course restriction on a payment row (hp + b aliases): the page selector and the grade / course drill */
function payRestrict(sql: Sql, q: Record<string, string>, skip?: string): Frag {
  // skip = 'grade' / 'course': the card of that dimension ignores its own selection, so more rows can be picked
  const grades = skip === 'grade' ? [] : (q.grade ?? '').split('|').map((s) => s.trim()).filter(Boolean);
  const courses = skip === 'course' ? [] : (q.course ?? '').split('|').map((s) => s.trim()).filter(Boolean);
  if (q.dim === 'grade' && q.value !== undefined) grades.push(q.value);
  if (q.dim === 'course' && q.value !== undefined) courses.push(q.value);
  const c: Frag[] = [];
  if (grades.length) c.push(sql`COALESCE(hp.grade_label, b.grade_title, 'No Grade On Batch') IN ${sql(grades)}`);
  if (courses.length) c.push(sql`COALESCE(hp.course_label, analytics.course_label(b.title, b.course_title, COALESCE(hp.enrollment_batch_id, hp.batch_id))) IN ${sql(courses)}`);
  return c.reduce((a, x) => sql`${a} AND ${x}`, sql`true`);
}

function payerWhere(sql: Sql, f: Filters, p: Period, q: Record<string, string>, skip?: string): Frag {
  const grades = skip === 'grade' ? [] : (q.grade ?? '').split('|').map((s) => s.trim()).filter(Boolean);
  const courses = skip === 'course' ? [] : (q.course ?? '').split('|').map((s) => s.trim()).filter(Boolean);
  const pm = payMethod(q);
  const c: Frag[] = [payWindow(sql, p, grades, courses, pm)];
  if (f.dups !== '1') c.push(sql`true`);
  for (const k of LIST_KEYS) {
    const col = PAYER_COLS[k]; const vals = f[k];
    if (!col || !vals?.length || k === skip) continue;
    const hasNull = vals.includes('(null)'); const real = vals.filter((v) => v !== '(null)');
    const ref = sql`m.${sql(col)}`;
    if (hasNull && real.length) c.push(sql`(${ref} IN ${sql(real)} OR ${ref} IS NULL)`);
    else if (hasNull) c.push(sql`${ref} IS NULL`);
    else c.push(sql`${ref} IN ${sql(real)}`);
  }
  // drill-down dimension
  if (q.dim && q.value !== undefined) {
    if (q.dim === 'grade') c.push(payWindow(sql, p, [q.value], [], pm));
    else if (q.dim === 'course') c.push(payWindow(sql, p, [], [q.value], pm));
    // App Installed as the last touch, split by the source of the touch before it (the "what came before the install" card)
    else if (q.dim === 'app_prev_source') c.push(sql`m.last_touch_source = 'App Installed' AND ${PREV_SOURCE(sql)} = ${q.value}`);
    else if (q.dim === 'new_customer') c.push(sql`${pm === 'm0' ? sql`m.first_payment_date_m0` : sql`m.first_payment_date`} BETWEEN ${p.from} AND ${p.to}`);
    else if ((FIRST_DIMS as readonly string[]).includes(q.dim)) {
      c.push(q.value === 'No Touch Before Payment'
        ? sql`COALESCE((SELECT ft.${sql(q.dim)} FROM analytics.mv_payer_first_touch ft WHERE ft.user_id = m.user_id), 'No Touch Before Payment') = 'No Touch Before Payment'`
        : sql`m.user_id IN (SELECT ft.user_id FROM analytics.mv_payer_first_touch ft WHERE ft.${sql(q.dim)}::text = ${q.value})`);
    }
    else {
      const col = DIMS[q.dim];
      if (!col) throw Object.assign(new Error(`unknown dim ${q.dim}`), { status: 400 });
      c.push(q.value === '(null)' ? sql`m.${sql(col)} IS NULL` : sql`m.${sql(col)}::text = ${q.value}`);
    }
  }
  return c.reduce((a, x) => sql`${a} AND ${x}`, sql`true`);
}

export interface PayerDim { key: string; users: number; touches: number; revenue: number; new_users: number; share_pct: number | null }
async function byDim(sql: Sql, w: Frag, col: string, p: Period, limit = 2000): Promise<PayerDim[]> {
  const rows = await sql<Omit<PayerDim, 'share_pct'>[]>`
    SELECT COALESCE(m.${sql(col)}::text, '(null)') AS key, count(*)::int AS users, COALESCE(sum(m.touches_before_payment), 0)::int AS touches,
           COALESCE(sum(m.revenue), 0)::float8 AS revenue, count(*) FILTER (WHERE m.first_payment_date BETWEEN ${p.from} AND ${p.to})::int AS new_users
    FROM analytics.mv_payer m WHERE ${w} GROUP BY 1 ORDER BY users DESC LIMIT ${limit}`;
  const tot = rows.reduce((s, r) => s + r.users, 0);
  return rows.map((r) => ({ ...r, share_pct: pct(r.users, tot) }));
}

converted.get('/converted', (c) =>
  handle(c, async ({ sql, f, periods, q }) => {
    const p = periods.current;
    const w = payerWhere(sql, f, p, q);
    const wx = (skip: string) => payerWhere(sql, f, p, q, skip);   // a card never filters itself
    const pm = payMethod(q);
    const V = VALID(sql, pm);
    const R = payRestrict(sql, q);   // payments / revenue / course / grade / daily count only payments matching the grade or course selection
    const firstPay = pm === 'm0' ? sql`m.first_payment_date_m0` : sql`m.first_payment_date`;
    // first-touch cards (one statement for the five dims; they drill, they do not filter, so no self-skip is needed)
    const firstP = sql<{ dim: string; key: string; users: number; touches: number; revenue: number; new_users: number }[]>`
      WITH ft AS (${firstTouchSet(sql, w, firstPay)})
      SELECT d.dim, d.key, count(*)::int AS users, COALESCE(sum(ft.touches_before_payment), 0)::int AS touches, COALESCE(sum(ft.revenue), 0)::float8 AS revenue,
             count(*) FILTER (WHERE ft.first_pay BETWEEN ${p.from} AND ${p.to})::int AS new_users
      FROM ft CROSS JOIN LATERAL (VALUES ('first_touch_point', ft.first_touch_point), ('first_touch_source', ft.first_touch_source), ('first_touch_medium', ft.first_touch_medium),
                                         ('first_touch_campaign', ft.first_touch_campaign), ('first_touch_staff', ft.first_touch_staff)) AS d(dim, key)
      GROUP BY 1, 2`;
    // users credited to an App Installed last touch, by the source of the touch BEFORE it (sql/049 prev_touch_source)
    const appPrevP = sql<Omit<PayerDim, 'share_pct'>[]>`
      SELECT COALESCE(ft.prev_touch_source, 'No Earlier Touch') AS key, count(*)::int AS users, COALESCE(sum(m.touches_before_payment), 0)::int AS touches,
             COALESCE(sum(m.revenue), 0)::float8 AS revenue, count(*) FILTER (WHERE ${firstPay} BETWEEN ${p.from} AND ${p.to})::int AS new_users
      FROM analytics.mv_payer m LEFT JOIN analytics.mv_payer_first_touch ft ON ft.user_id = m.user_id
      WHERE ${wx('source')} AND m.last_touch_source = 'App Installed'
      GROUP BY 1 ORDER BY users DESC LIMIT 2000`;
    const [[k], [pk], byStage, byPoint, bySource, byMedium, byCampaign, byStaff, byCourse, byGrade, daily, grades, tatRows, firstRows, appPrevRows] = await timedAll(
      ['kpis', 'payments', 'stage', 'touch_point', 'source', 'medium', 'campaign', 'staff', 'course', 'grade', 'daily', 'grades', 'tat', 'first_touch', 'app_prev'], [
      sql<{ users: number; new_users: number; no_touch: number; no_lead: number; revenue: number; touches: number }[]>`
        SELECT count(*)::int AS users, count(*) FILTER (WHERE ${pm === 'm0' ? sql`m.first_payment_date_m0` : sql`m.first_payment_date`} BETWEEN ${p.from} AND ${p.to})::int AS new_users,
               count(*) FILTER (WHERE m.last_touch_id IS NULL)::int AS no_touch, count(*) FILTER (WHERE m.no_lead)::int AS no_lead,
               COALESCE(sum(m.revenue), 0)::float8 AS revenue, COALESCE(sum(m.touches_before_payment), 0)::int AS touches
        FROM analytics.mv_payer m WHERE ${w}`,
      // sales = courses paid for: one per enrollment (app) / booking (Ujra, enrollment_id = -booking_id) with a payment in the window; a payment
      // without an enrollment counts as its own sale. With "Method 0" this is the Metabase "Total Sales - 1st payment" unit (first payments only).
      sql<{ payments_all: number; revenue_all: number; sales: number; sales_app: number; sales_ujra: number }[]>`
        SELECT count(*)::int AS payments_all, COALESCE(sum(hp.amount), 0)::float8 AS revenue_all,
               count(DISTINCT COALESCE(hp.enrollment_id::text, 'p' || hp.id::text))::int AS sales,
               count(DISTINCT COALESCE(hp.enrollment_id::text, 'p' || hp.id::text)) FILTER (WHERE hp.source = 'app')::int AS sales_app,
               count(DISTINCT COALESCE(hp.enrollment_id::text, 'p' || hp.id::text)) FILTER (WHERE hp.source = 'ujra')::int AS sales_ujra
        FROM analytics.v_payment_all hp LEFT JOIN app.core_batch b ON b.id = COALESCE(hp.enrollment_batch_id, hp.batch_id) WHERE ${V} AND ${R} AND hp.payment_date BETWEEN ${p.from} AND ${p.to}
          AND hp.user_id IN (SELECT m.user_id FROM analytics.mv_payer m WHERE ${w})`,
      byDim(sql, wx('lead_stage'), 'lead_stage', p), byDim(sql, wx('touch_point'), 'last_touch_point', p), byDim(sql, wx('source'), 'last_touch_source', p), byDim(sql, wx('medium'), 'last_touch_medium', p),
      byDim(sql, wx('campaign'), 'last_touch_campaign', p), byDim(sql, wx('staff'), 'last_touch_staff', p),
      sql<PayerDim[]>`
        SELECT COALESCE(hp.course_label, analytics.course_label(b.title, b.course_title, COALESCE(hp.enrollment_batch_id, hp.batch_id))) AS key, count(DISTINCT hp.user_id)::int AS users, count(*)::int AS touches,
               COALESCE(sum(hp.amount), 0)::float8 AS revenue, 0::int AS new_users, NULL::float8 AS share_pct
        FROM analytics.v_payment_all hp LEFT JOIN app.core_batch b ON b.id = COALESCE(hp.enrollment_batch_id, hp.batch_id)
        WHERE ${V} AND ${payRestrict(sql, q, 'course')} AND hp.payment_date BETWEEN ${p.from} AND ${p.to} AND hp.user_id IN (SELECT m.user_id FROM analytics.mv_payer m WHERE ${wx('course')})
        GROUP BY 1 ORDER BY users DESC LIMIT 2000`,
      sql<PayerDim[]>`
        SELECT COALESCE(hp.grade_label, b.grade_title, 'No Grade On Batch') AS key, count(DISTINCT hp.user_id)::int AS users, count(*)::int AS touches,
               COALESCE(sum(hp.amount), 0)::float8 AS revenue, 0::int AS new_users, NULL::float8 AS share_pct
        FROM analytics.v_payment_all hp LEFT JOIN app.core_batch b ON b.id = COALESCE(hp.enrollment_batch_id, hp.batch_id)
        WHERE ${V} AND ${payRestrict(sql, q, 'grade')} AND hp.payment_date BETWEEN ${p.from} AND ${p.to} AND hp.user_id IN (SELECT m.user_id FROM analytics.mv_payer m WHERE ${wx('grade')})
        GROUP BY 1 ORDER BY users DESC`,
      sql<{ d: string; users: number; payments: number; revenue: number }[]>`
        SELECT hp.payment_date::text AS d, count(DISTINCT hp.user_id)::int AS users, count(*)::int AS payments, COALESCE(sum(hp.amount), 0)::float8 AS revenue
        FROM analytics.v_payment_all hp LEFT JOIN app.core_batch b ON b.id = COALESCE(hp.enrollment_batch_id, hp.batch_id) WHERE ${V} AND ${R} AND hp.payment_date BETWEEN ${p.from} AND ${p.to} AND hp.user_id IN (SELECT m.user_id FROM analytics.mv_payer m WHERE ${w})
        GROUP BY 1 ORDER BY 1`,
      sql<{ key: string }[]>`SELECT DISTINCT COALESCE(grade_title, 'No Grade On Batch') AS key FROM app.core_batch ORDER BY 1`,
      // Turnaround time of the paying users in the selection: lead created -> the user's first valid payment day, and the latest touch
      // on/before that day -> that day (same bands as the Overview card). "created" needs a Salesforce lead on the phone.
      sql<TatRow[]>`
        WITH c AS (
          SELECT m.user_id, ${firstPay} AS paid, ll.created_date AS created,
                 (SELECT max(t.touch_date) FROM analytics.mv_touch_flat t WHERE t.lead_id = m.lead_id AND t.touch_date <= ${firstPay}) AS last_touch
          FROM analytics.mv_payer m LEFT JOIN analytics.mv_lead_lite ll ON ll.lead_id = m.lead_id
          WHERE ${w} AND ${firstPay} IS NOT NULL),
        d AS (SELECT 'created' AS kind, (paid - created)::int AS days FROM c WHERE created IS NOT NULL
              UNION ALL SELECT 'touch', (paid - last_touch)::int FROM c)
        SELECT kind, ${tatBucket(sql, sql`days`)} AS key, count(*)::int AS leads, NULL::float8 AS avg_days, NULL::float8 AS median_days FROM d GROUP BY 1, 2
        UNION ALL
        SELECT kind, '_all', count(*)::int, avg(days)::float8, percentile_cont(0.5) WITHIN GROUP (ORDER BY days)::float8 FROM d GROUP BY 1`,
      firstP, appPrevP,
    ]);
    const appPrevTot = appPrevRows.reduce((s, r) => s + r.users, 0);
    const byAppPrev: PayerDim[] = appPrevRows.map((r) => ({ ...r, share_pct: pct(r.users, appPrevTot) }));
    const byFirst = (dim: (typeof FIRST_DIMS)[number]): PayerDim[] => {
      const rows = firstRows.filter((r) => r.dim === dim).sort((a, b) => b.users - a.users);
      const tot = rows.reduce((s, r) => s + r.users, 0);
      return rows.map(({ dim: _d, ...r }) => ({ ...r, share_pct: pct(r.users, tot) }));
    };
    return {
      period: p, pm,
      kpis: { ...k, ...pk, no_touch_pct: pct(k.no_touch, k.users), no_lead_pct: pct(k.no_lead, k.users) },
      by_stage: byStage, by_last_touch_point: byPoint, by_last_source: bySource, by_last_medium: byMedium, by_last_campaign: byCampaign, by_last_staff: byStaff,
      by_first_touch_point: byFirst('first_touch_point'), by_first_source: byFirst('first_touch_source'), by_first_medium: byFirst('first_touch_medium'),
      by_first_campaign: byFirst('first_touch_campaign'), by_first_staff: byFirst('first_touch_staff'),
      by_app_prev_source: byAppPrev,
      by_course: byCourse, by_grade: byGrade, daily, grades: grades.map((g) => g.key),
      tat: { created: shapeTat(tatRows, 'created'), touch: shapeTat(tatRows, 'touch') },
      definitions: {
        users: pm === 'm0'
          ? 'Distinct paying app users with a valid payment (payment_method 0, not deleted, is_success, payment_success) whose payment date is in the window. This counts paying app accounts, including people with no Salesforce lead.'
          : pm === 'm1'
            ? 'Paying users with a valid payment of payment_method 1 (gateway EMI instalments; every such row carries an emi_id) dated in the window.'
            : 'Distinct paying app users with ANY valid payment (any payment_method; not deleted, is_success, payment_success) dated in the window. Switch to "Method 0" to count payment_method 0 only, as the Overview does.',
        sales: pm === 'm0'
          ? 'Courses sold: one per enrollment (app) or booking (Ujra) with a Method 0 payment - the first payment of that course - dated in the window, made by a user of the selection. The same unit as Metabase "Total Sales - 1st payment" (which additionally requires a sales person). A user buying two courses counts twice; an instalment on an older course does not count.'
          : pm === 'm1'
            ? 'Courses with a Method 1 payment (an instalment) dated in the window, one per enrollment or booking.'
            : 'Courses with any valid payment dated in the window, one per enrollment (app) or booking (Ujra): new sales and courses receiving an instalment alike. Switch to "Method 0" for sales only.',
        new_users: 'Paying users whose FIRST ever valid payment is inside the window (new customers).',
        tat: 'Turnaround time of the paying users in the selection, in calendar days, measured to the user\'s FIRST valid payment day (first method-0 payment in M0 mode). "Lead created → paid": from the creation day of the user\'s Salesforce lead (the most recent lead on the phone) to that payment day; users with no lead are left out; "before lead created" = the lead was created after the first payment. "Last touch → paid": from the latest lead touch on or before that payment day to the payment day; "no prior touch" = no touch before the first payment. Median = half the users were faster.',
        no_touch: 'Users with no lead touch on/before their payment: no Salesforce lead on that phone, or all touches came after the payment. Shown as "No Touch Before Payment" in the tables.',
        no_lead: 'Paying users whose phone matches no Salesforce lead.',
        credit: 'Every user is credited to ONE touch: the latest touch dated on/before its last valid payment day, across all Salesforce leads with the same phone. If that last touch is an Eduport App touch made less than 2 hours before the payment, the credit goes to the touch before it; when the app touch is the only touch, it keeps the credit. Touch point, source, medium, campaign and staff come from that touch.',
        touches: 'Number of touches on/before the payment for the users in the row.',
        app_prev: 'Users whose credited LAST touch is an App Installed touch (the rows of the last-touch source card under "App Installed"), split by the source of the touch just before it: the latest earlier touch, dated on/before the last valid payment day, across the Salesforce leads on the account\'s phone or alternative number. "No Earlier Touch" = the app install was the user\'s only touch before paying. Share = of these App Installed users. Rows open the list of those users; the card follows every filter except the source filter (like the source card itself).',
        first_credit: 'First-touch view: every user is credited to its EARLIEST touch dated on/before its last valid payment day, across all Salesforce leads on the account\'s phone or alternative number - the touch that brought the lead in. "No Touch Before Payment" = no lead on the phone, or every touch came after the payment. The last-touch cards credit the latest such touch instead; the same users appear in both, under possibly different values. Rows open the list of those users.',
        course: 'Users by the course they bought; a user buying two courses appears under both. The course is the one of the batch on the payment\x27s ENROLLMENT (where the student is enrolled now), with " - Fastrack" / " - Booster" added from the batch name; the batch written on the payment is used only when the enrollment has none.',
        grade: 'Grade of the course that was bought (batch of the payment\x27s enrollment), not the class recorded on the lead.',
        stage: 'Lead stage of the user\'s most recently created Salesforce lead (one lead per user).',
        revenue: 'Sum of payment amounts of the users in the row (all their valid payments, any method, any date).',
        pm: 'Payment method: "All" counts every successful payment; "Method 0" counts payment_method 0 only (the first payment of a course; for Ujra the booking payment), the rule the Overview uses; "Method 1" is the rest (gateway EMI instalments). In the user list, course / grade / payments / revenue cover the payments inside the selected dates; the all-time columns cover every payment of the user.',
      },
    };
  }),
);

// ---------------------------------------------------------------- payer list (drill-down + CSV)
const SORTABLE: Record<string, string> = { last_payment_date: 'last_payment_date', first_payment_date: 'first_payment_date', revenue: 'revenue', payments: 'payments', touches_before_payment: 'touches_before_payment', last_touch_at: 'last_touch_at', lead_name: 'lead_name', lead_stage: 'lead_stage', class_raw: 'class_raw' };
const COLS = ['user_id', 'lead_name', 'first_name', 'last_name', 'mobile', 'email', 'lead_stage', 'class_raw', 'lead_source', 'owner_name', 'courses', 'grades', 'payments', 'first_payment_date', 'last_payment_date', 'revenue', 'payments_all_time', 'revenue_all_time', 'first_payment_ever',
  'last_touch_point', 'last_touch_source', 'last_touch_medium', 'last_touch_campaign', 'last_touch_staff', 'last_touch_at', 'first_touch_point', 'first_touch_source', 'first_touch_at', 'prev_touch_point', 'prev_touch_source', 'prev_touch_at', 'touches_before_payment', 'no_lead', 'lead_id'];

function maskRow(r: Rec, role: Role): Rec {
  return { ...r, mobile: maskPhone(r.mobile as string | null, role), phone_key: maskPhone(r.phone_key as string | null, role), email: maskEmail(r.email as string | null, role), first_name: maskName(r.first_name as string | null, role), last_name: maskName(r.last_name as string | null, role) };
}
function searchCond(sql: Sql, s: string): Frag {
  s = s.trim(); if (!s) return sql`true`;
  const digits = s.replace(/\D/g, '');
  if (digits.length >= 5 && digits.length === s.length) return sql`(m.phone_key LIKE ${'%' + digits} OR m.user_id::text = ${digits})`;
  if (/^LM-\d+$/i.test(s)) return sql`upper(m.lead_name) = ${s.toUpperCase()}`;
  const like = `%${s.toLowerCase()}%`;
  return sql`(lower(l.first_name__c) LIKE ${like} OR lower(l.last_name__c) LIKE ${like} OR lower(l.email__c) LIKE ${like} OR lower(m.lead_name) LIKE ${like})`;
}
function listQuery(sql: Sql, f: Filters, p: Period, q: Record<string, string>, page: { limit: number; offset: number } | null) {
  const w = payerWhere(sql, f, p, q);
  const sortCol = SORTABLE[q.sort ?? ''] ?? 'last_payment_date';
  const dir = q.dir === 'asc' ? sql`ASC NULLS FIRST` : sql`DESC NULLS LAST`;
  // courses / grades / payments / dates / revenue = the user's payments INSIDE the selected dates (payment method switch and purchased grade /
  // course selection applied); the *_all_time columns keep the lifetime figures, so a returning customer is still recognisable
  return sql<Rec[]>`
    SELECT x.user_id, x.lead_name, x.first_name, x.last_name, x.mobile, x.email, x.lead_stage, x.class_raw, x.lead_source, x.owner_name,
           x.courses, x.grades, x.payments, x.first_payment_date::text AS first_payment_date, x.last_payment_date::text AS last_payment_date, x.revenue,
           x.payments_all_time, x.revenue_all_time, x.first_payment_ever::text AS first_payment_ever,
           x.last_touch_point, x.last_touch_source, x.last_touch_medium, x.last_touch_campaign, x.last_touch_staff, x.last_touch_at::text AS last_touch_at,
           COALESCE(x.first_touch_point, 'No Touch Before Payment') AS first_touch_point, COALESCE(x.first_touch_source, 'No Touch Before Payment') AS first_touch_source, x.first_touch_at::text AS first_touch_at,
           COALESCE(x.prev_touch_point, 'No Earlier Touch') AS prev_touch_point, COALESCE(x.prev_touch_source, 'No Earlier Touch') AS prev_touch_source, x.prev_touch_at::text AS prev_touch_at,
           x.touches_before_payment, x.no_lead, x.lead_id, count(*) OVER ()::int AS total_rows
    FROM (
      SELECT m.user_id, m.lead_name, l.first_name__c AS first_name, l.last_name__c AS last_name, u.phone AS mobile, l.email__c AS email,
             m.lead_stage, m.class_raw, m.lead_source, m.owner_name,
             pw.courses, pw.grades, pw.payments, pw.first_payment_date, pw.last_payment_date, pw.revenue,
             m.payments AS payments_all_time, m.revenue::float8 AS revenue_all_time, m.first_payment_date AS first_payment_ever,
             m.last_touch_point, m.last_touch_source, m.last_touch_medium, m.last_touch_campaign, m.last_touch_staff, m.last_touch_at,
             ft.first_touch_point, ft.first_touch_source, ft.first_touch_at, ft.prev_touch_point, ft.prev_touch_source, ft.prev_touch_at,
             m.touches_before_payment, m.no_lead, m.lead_id
      FROM analytics.mv_payer m
      LEFT JOIN analytics.mv_payer_first_touch ft ON ft.user_id = m.user_id
      LEFT JOIN salesforce.lead_master__c l ON l.id = m.lead_id
      LEFT JOIN app.home_customuser u ON u.id = m.user_id
      LEFT JOIN LATERAL (
        SELECT string_agg(DISTINCT COALESCE(b.title, hp.course_label, 'batch ' || COALESCE(hp.enrollment_batch_id, hp.batch_id)::text), ' | ') AS courses,
               string_agg(DISTINCT COALESCE(hp.grade_label, b.grade_title, 'No Grade On Batch'), ' | ') AS grades,
               count(*)::int AS payments, min(hp.payment_date) AS first_payment_date, max(hp.payment_date) AS last_payment_date, sum(hp.amount)::float8 AS revenue
        FROM analytics.v_payment_all hp LEFT JOIN app.core_batch b ON b.id = COALESCE(hp.enrollment_batch_id, hp.batch_id)
        WHERE hp.user_id = m.user_id AND ${VALID(sql, payMethod(q))} AND hp.payment_date BETWEEN ${p.from} AND ${p.to} AND ${payRestrict(sql, q)}) pw ON true
      WHERE ${w} AND ${searchCond(sql, q.q ?? '')}
    ) x
    ORDER BY x.${sql(sortCol)} ${dir}, x.user_id
    ${page ? sql`LIMIT ${page.limit} OFFSET ${page.offset}` : sql``}`;
}

converted.get('/converted/users', (c) =>
  handle(c, async ({ sql, f, periods, q, role }) => {
    const limit = intParam(q, 'limit', 50, 1, 200);
    const page = intParam(q, 'page', 1, 1, 100000);
    const rows = await listQuery(sql, f, periods.current, q, { limit, offset: (page - 1) * limit });
    const total = rows.length ? (rows[0].total_rows as number) : 0;
    return { page, limit, total, rows: rows.map((r) => { const { total_rows: _t, ...rest } = maskRow(r, role); return rest; }), masked: role === 'viewer', columns: COLS };
  }, 0),
);

converted.get('/converted/users.csv', async (c) => {
  const q = c.req.query(); const f = parseFilters(q); const periods = resolvePeriods(f); const role = c.get('user').role;
  const cap = Number.parseInt(c.env.EXPORT_ROW_CAP ?? '50000', 10) || 50000;
  return csvStream(c, { cols: COLS, cap, filename: `converted_users_${periods.current.from}_${periods.current.to}.csv`, mask: (r) => maskRow(r, role),
    fetchPage: (sql, limit, offset) => listQuery(sql, f, periods.current, q, { limit, offset }) });
});
