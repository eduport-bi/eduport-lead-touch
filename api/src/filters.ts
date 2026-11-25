/**
 * The ONE shared filter parser + SQL builder.
 *
 *  - zod validates every query parameter
 *  - dimension keys are resolved through an allowlist (LEAD_DIMS / TOUCH_DIMS);
 *    column names never come from user input
 *  - all values are bound parameters (postgres.js tagged templates)
 *
 * Lead-level filters apply to analytics.v_lead_base (alias `l`).
 * Touch-level filters (source / medium / touch point / campaign / ad set / ad / staff)
 * mean "lead has at least one such touch" at lead grain, and restrict the touch
 * rows directly at touch grain (alias `t`).
 */
import { z } from 'zod';
import type { Sql, PendingQuery, Row } from 'postgres';

export type Frag = PendingQuery<Row[]>;

// ---------------------------------------------------------------- dimensions
export interface DimSpec { col: string; label: string; kind?: 'text' | 'bool'; boolLabels?: [string, string]; }

const LEAD_DIMS_RAW = {
  lead_source:        { col: 'lead_source',          label: 'Lead Source' },
  lead_stage:         { col: 'lead_stage',           label: 'Lead Stage' },
  class_group:        { col: 'class_group',          label: 'Class Group' },
  class_raw:          { col: 'class_raw',            label: 'Class (raw)' },
  district:           { col: 'district',             label: 'District' },
  city:               { col: 'city',                 label: 'City' },
  priority:           { col: 'priority',             label: 'Priority' },
  lead_type:          { col: 'lead_type',            label: 'Lead Type' },
  owner:              { col: 'owner_name',           label: 'Owner' },
  ic_status:          { col: 'best_ic_status',       label: 'IC Status' },
  ic_course:          { col: 'ic_course',            label: 'Interested course' },
  ad_platform:        { col: 'ad_platform',          label: 'Ad Platform' },
  first_touch_point:  { col: 'first_touch_point',    label: 'First Touch Point' },
  last_touch_point:   { col: 'last_touch_point',     label: 'Last Touch Point' },
  touch_bucket:       { col: 'touch_bucket',         label: 'Touches (bucket)' },
  lm_reason:          { col: 'lm_reason',            label: 'LM Reason' },
  call_reason:        { col: 'call_reason',          label: 'Last call reason' },
  paid:               { col: 'is_paid_lead',         label: 'Paid / Organic', kind: 'bool', boolLabels: ['Paid', 'Organic'] },
  repeat:             { col: 'is_repeat',            label: 'Repeat lead',    kind: 'bool', boolLabels: ['Repeat', 'First'] },
  pre_existing:       { col: 'pre_existing_customer', label: 'Pre-existing customer', kind: 'bool', boolLabels: ['Pre-existing', 'New customer'] },
} as const satisfies Record<string, DimSpec>;

const TOUCH_DIMS_RAW = {
  source:       { col: 'source',        label: 'Source (touch)' },
  medium:       { col: 'medium',        label: 'Medium' },
  touch_point:  { col: 'touch_point',   label: 'Touch Point' },
  campaign:     { col: 'campaign',      label: 'Campaign (touch)' },
  ad_set:       { col: 'adset_name',    label: 'Ad Set (touch)' },
  ad_name:      { col: 'ad_name',       label: 'Ad (touch)' },
  staff:        { col: 'staff',         label: 'Staff (touch)' },
  platform_id:  { col: 'platform_id',   label: 'Platform ID' },
  gap_bucket:   { col: 'gap_bucket',    label: 'Gap since previous touch' },
  paid_touch:   { col: 'is_paid_touch', label: 'Paid touch', kind: 'bool', boolLabels: ['Paid', 'Organic'] },
} as const satisfies Record<string, DimSpec>;

export type LeadDim = keyof typeof LEAD_DIMS_RAW;
export type TouchDim = keyof typeof TOUCH_DIMS_RAW;
export type Dim = LeadDim | TouchDim;
export const LEAD_DIMS: Record<LeadDim, DimSpec> = LEAD_DIMS_RAW;
export const TOUCH_DIMS: Record<TouchDim, DimSpec> = TOUCH_DIMS_RAW;

export const isLeadDim = (d: string): d is LeadDim => Object.prototype.hasOwnProperty.call(LEAD_DIMS, d);
export const isTouchDim = (d: string): d is TouchDim => Object.prototype.hasOwnProperty.call(TOUCH_DIMS, d);
export const dimSpec = (d: Dim): DimSpec => (isLeadDim(d) ? LEAD_DIMS[d] : TOUCH_DIMS[d as TouchDim]);

/** Lead attribute columns that ALSO exist on mv_touch_base (so lead x touch matrices work). */
export const LEAD_DIMS_ON_TOUCH = new Set<LeadDim>([
  'lead_source', 'class_group', 'lead_stage', 'lead_type', 'priority', 'district', 'city', 'owner', 'ic_status', 'paid', 'pre_existing',
]);

/** Multi-select (list) filter keys - every non-boolean dimension. */
export const LIST_KEYS = [
  'lead_source', 'lead_stage', 'class_group', 'class_raw', 'district', 'city', 'priority', 'lead_type', 'owner',
  'ic_status', 'ic_course', 'ad_platform', 'first_touch_point', 'last_touch_point', 'touch_bucket', 'lm_reason', 'call_reason',
  'source', 'medium', 'touch_point', 'campaign', 'ad_set', 'ad_name', 'staff', 'platform_id', 'gap_bucket',
] as const satisfies readonly Dim[];

// ---------------------------------------------------------------- interested course (Salesforce Interested_Course__c, several per lead)
/** course name of an Interested Course row aliased `ic`, with the Course__c lookup aliased `cr` (same rule as the lead detail) */
export const icCourseExpr = (sql: Sql): Frag => sql`COALESCE(NULLIF(ic.course_name__c, ''), cr.name, ic.course__c)`;
/** `<alias>.lead_id` has an interested course named one of `vals` */
export function icCourseIn(sql: Sql, alias: 'l' | 't', vals: string[]): Frag {
  return sql`${sql(alias)}.lead_id IN (SELECT ic.lead_master__c FROM salesforce.interested_course__c ic LEFT JOIN salesforce.course__c cr ON cr.id = ic.course__c
                                     WHERE ic.isdeleted = false AND ${icCourseExpr(sql)} IN ${sql(vals)})`;
}
export type ListKey = (typeof LIST_KEYS)[number];
const BOOL_LEAD_KEYS = ['repeat', 'pre_existing'] as const;

// ---------------------------------------------------------------- schema
const list = z.preprocess(
  // values arrive percent-encoded and comma-joined (web/src/lib/filters.ts encodeListValue): decode each one after splitting
  (v) => (typeof v === 'string' && v.length ? v.split(',').map((s) => { try { return decodeURIComponent(s).trim(); } catch { return s.trim(); } }).filter(Boolean).slice(0, 200) : []),
  z.array(z.string().max(300)),
);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const flag = z.enum(['1', '0']).optional();
const listShape = Object.fromEntries(LIST_KEYS.map((k) => [k, list])) as Record<ListKey, typeof list>;

export const FilterSchema = z.object({
  from: day.optional(),
  to: day.optional(),
  basis: z.enum(['created', 'touch', 'payment']).default('created'),
  compare: z.enum(['none', 'previous']).default('none'),
  pay: flag,                          // 1 = the payment-date window below is active
  pfrom: day.optional(),
  pto: day.optional(),
  converted: flag,
  dups: flag,                         // 1 = include duplicates (default excluded)
  paid: z.enum(['paid', 'organic']).optional(),
  paid_touch: z.enum(['paid', 'organic']).optional(),
  hot: flag, supreme_hot: flag, relogged: flag, repeat: flag, pre_existing: flag,
  class_on: z.enum(['lead', 'bought']).optional(),   // what a picked Class means: the Salesforce lead class (default) or a class paid for
  class_match: flag,                  // 1 = drop buyers whose purchased class differs from their lead class (classMatch below), 2026-11-25
  purchased_grade: list,              // Converted page only: its Class filter = core grade titles of the batch bought (routes/converted.ts withGrade)
  ...listShape,
}).passthrough();

export type Filters = z.infer<typeof FilterSchema>;

export function parseFilters(q: Record<string, string | undefined>): Filters {
  return FilterSchema.parse(q);
}

/** Keys of filters that are actually set (used for cascading + the daily-MV fast path). */
export function activeDimKeys(f: Filters): string[] {
  const keys: string[] = [];
  for (const k of LIST_KEYS) if (f[k]?.length) keys.push(k);
  for (const k of ['paid', 'paid_touch', 'converted', ...BOOL_LEAD_KEYS] as const) if (f[k]) keys.push(k);
  return keys;
}

// ---------------------------------------------------------------- periods
export interface Period { from: string; to: string; }
export interface Periods { current: Period; previous: Period | null; }

const IST_OFFSET_MS = 5.5 * 3600 * 1000;
export function todayIST(): string {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}
const toDate = (s: string) => new Date(`${s}T00:00:00Z`);
const fmt = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => { const d = toDate(s); d.setUTCDate(d.getUTCDate() + n); return fmt(d); };
const daysBetween = (a: string, b: string) => Math.round((toDate(b).getTime() - toDate(a).getTime()) / 86400000);

/** Optional second window on the PAYMENT date (Overview & touch pages): conversions counted only for payments inside it. */
export function paymentPeriod(f: Filters): Period | null {
  if (f.pay !== '1') return null;
  const to = f.pto ?? todayIST();
  const from = f.pfrom ?? addDays(to, -29);
  if (toDate(from) > toDate(to)) throw new z.ZodError([{ code: 'custom', path: ['pfrom'], message: 'payment from is after to' }]);
  return { from, to };
}

export function resolvePeriods(f: Filters): Periods {
  const to = f.to ?? todayIST();
  const from = f.from ?? addDays(to, -29);
  if (toDate(from) > toDate(to)) throw new z.ZodError([{ code: 'custom', path: ['from'], message: 'from is after to' }]);
  if (daysBetween(from, to) > 366 * 3) throw new z.ZodError([{ code: 'custom', path: ['to'], message: 'range longer than 3 years' }]);
  const current = { from, to };
  let previous: Period | null = null;
  if (f.compare === 'previous') {
    const len = daysBetween(from, to) + 1;
    const pTo = addDays(from, -1);
    previous = { from: addDays(pTo, -(len - 1)), to: pTo };
  }
  return { current, previous };
}

// ---------------------------------------------------------------- SQL builders
const NULL_TOKEN = '(null)';

export function inList(sql: Sql, alias: 'l' | 't', col: string, vals: string[]): Frag {
  const hasNull = vals.includes(NULL_TOKEN);
  const real = vals.filter((v) => v !== NULL_TOKEN);
  const colRef = sql`${sql(alias)}.${sql(col)}`;
  if (hasNull && real.length) return sql`(${colRef} IN ${sql(real)} OR ${colRef} IS NULL)`;
  if (hasNull) return sql`${colRef} IS NULL`;
  return sql`${colRef} IN ${sql(real)}`;
}

function boolCond(sql: Sql, alias: 'l' | 't', col: string, truthy: boolean): Frag {
  return truthy ? sql`${sql(alias)}.${sql(col)} = true` : sql`${sql(alias)}.${sql(col)} IS NOT TRUE`;
}

export function andAll(sql: Sql, conds: Frag[]): Frag {
  return conds.reduce((acc, c) => sql`${acc} AND ${c}`, sql`true`);
}

// ---------------------------------------------------------------- purchased class (filter-bar switch class_on=bought, 2026-11-23)
/**
 * With the switch on "Purchased class", a picked Class means "the lead's number PAID for a course of that class" instead of "the Class on
 * the Salesforce lead". Both are compared on the base class ("Class 10 Board" -> "Class 10"). The payments are analytics.mv_lead_class_pay
 * (sql/051: valid app payments, payment_method 0, lead matched on the account's phone or alternative number; Ujra bookings carry no batch).
 * The date that matters is the date of THAT class payment: the lead population = such a payment on any date (inside the payment-date
 * window when it is on); the conversion tiles test the same payment's date against the touch and the window start.
 */
export const classBase = (v: string) => /^Class \d+/.exec(v)?.[0] ?? v;
/**
 * A picked (lead-style) Class -> the purchased classes it matches. Purchased classes carry the same names (analytics.purchase_class, sql/052),
 * so most picks match one name exactly ("Class 10 CBSE" = CBSE courses only). Lead-only names widen: "Class 11 (no stream)" = any Class 11
 * course of the state board, "Class 11 CBSE" = the CBSE Class 11 courses; "Plus Two Completed", "NMMS", "Other", "Unknown" match no course.
 */
export function purchasedMatches(v: string): string[] {
  const ns = /^Class (1[12]) \(no stream\)$/.exec(v);
  if (ns) return ['Science', 'Commerce', 'Humanities', '(no stream)'].map((s) => `Class ${ns[1]} ${s}`);
  const cb = /^Class (1[12]) CBSE$/.exec(v);
  if (cb) return [`Class ${cb[1]} Science CBSE`, `Class ${cb[1]} Commerce CBSE`, `Class ${cb[1]} Humanities CBSE`];
  return [v];
}
/** the purchased classes to match when the switch is on Purchased class and a Class is picked; null = the normal lead-class filter */
export function boughtBases(f: Filters): string[] | null {
  if (f.class_on !== 'bought') return null;
  const vals = (f.class_group ?? []).filter((v) => v !== '(null)');
  return vals.length ? [...new Set(vals.flatMap(purchasedMatches))] : null;
}
/** the lead `leadRef` paid for a course of one of `classes`, with an optional extra condition on that payment (alias cp, cp.payment_date) */
export function classPaid(sql: Sql, leadRef: Frag, classes: string[], extra?: Frag): Frag {
  return sql`EXISTS (SELECT 1 FROM analytics.mv_lead_class_pay cp WHERE cp.lead_id = ${leadRef} AND cp.purchased_class IN ${sql(classes)} ${extra ? sql`AND ${extra}` : sql``})`;
}
/** the class filter as a lead-population condition (purchased-class mode): such a payment on any date, or inside the payment window when it is on */
export function classPopulation(sql: Sql, leadRef: Frag, f: Filters, bases: string[]): Frag {
  const pp = paymentPeriod(f);
  return classPaid(sql, leadRef, bases, pp ? sql`cp.payment_date BETWEEN ${pp.from} AND ${pp.to}` : undefined);
}

/**
 * Tick box "Lead class = purchased class" (filter class_match=1, 2026-11-25): leave out MISMATCHED BUYERS - leads with a known class
 * that paid for courses, none of them of the lead's class. Leads that did not buy stay (so conversion rates keep their base). Same match
 * as the Converted page's "Bought a different class" tile: base class ("Class 10 Board" = a Class 10 batch); a crash / repeater course
 * matches Class 12, Plus Two Completed, Repeater and crash leads; Ujra bookings are not in mv_lead_class_pay, so they never mismatch.
 */
export function classMatchKeep(sql: Sql, leadRef: Frag, leadClass: Frag): Frag {
  const base = sql`COALESCE(substring(${leadClass} from '^Class [0-9]+'), ${leadClass})`;
  return sql`NOT (
    ${leadClass} IS NOT NULL AND ${base} NOT IN ('Unknown', 'Other')
    AND EXISTS (SELECT 1 FROM analytics.mv_lead_class_pay cp WHERE cp.lead_id = ${leadRef})
    AND NOT EXISTS (SELECT 1 FROM analytics.mv_lead_class_pay cp WHERE cp.lead_id = ${leadRef}
                    AND (cp.base_class = ${base}
                         OR (cp.base_class IN ('KEAM/JEE Crash', 'NEET Crash', 'Repeater', 'Plus Two Completed')
                             AND ${base} IN ('Class 12', 'Plus Two Completed', 'Repeater', 'KEAM/JEE Crash', 'NEET Crash')))))`;
}

export interface BuildOpts {
  /** ignore the date window (Lead explorer lists every lead) */
  noPeriod?: boolean; skip?: string; }

/** WHERE for analytics.v_lead_base AS l */
export function leadWhere(sql: Sql, f: Filters, p: Period, opts: BuildOpts = {}): Frag {
  const c: Frag[] = [];
  if (f.dups !== '1') c.push(sql`l.is_duplicate = false`);

  if (!opts.noPeriod) switch (f.basis) {
    case 'created': c.push(sql`l.created_date BETWEEN ${p.from} AND ${p.to}`); break;
    case 'payment': c.push(sql`l.converted AND l.converted_at BETWEEN ${p.from} AND ${p.to}`); break;
    case 'touch':   c.push(sql`EXISTS (SELECT 1 FROM analytics.v_touch_base tx WHERE tx.lead_id = l.lead_id AND tx.touch_date BETWEEN ${p.from} AND ${p.to})`); break;
  }

  if (f.class_match === '1') c.push(classMatchKeep(sql, sql`l.lead_id`, sql`l.class_group`));
  if (f.converted === '1') c.push(sql`l.converted = true`);
  if (f.converted === '0') c.push(sql`l.converted = false`);
  if (f.paid && opts.skip !== 'paid') c.push(boolCond(sql, 'l', 'is_paid_lead', f.paid === 'paid'));
  for (const k of BOOL_LEAD_KEYS) {
    if (f[k] && opts.skip !== k) c.push(boolCond(sql, 'l', LEAD_DIMS[k].col, f[k] === '1'));
  }

  const touchConds: Frag[] = [];
  for (const k of LIST_KEYS) {
    if (k === opts.skip) continue;
    const vals = f[k];
    if (!vals?.length) continue;
    const bb = k === 'class_group' ? boughtBases(f) : null;
    if (bb) { c.push(classPopulation(sql, sql`l.lead_id`, f, bb)); continue; }
    if (isLeadDim(k)) c.push(inList(sql, 'l', LEAD_DIMS[k].col, vals));
    else touchConds.push(inList(sql, 't', TOUCH_DIMS[k as TouchDim].col, vals));
  }
  // touch-level filters at lead grain: lead has >= 1 matching touch
  if (f.paid_touch && opts.skip !== 'paid_touch') touchConds.push(boolCond(sql, 't', 'is_paid_touch', f.paid_touch === 'paid'));
  if (touchConds.length) {
    if (f.basis === 'touch') touchConds.push(sql`t.touch_date BETWEEN ${p.from} AND ${p.to}`);
    c.push(sql`EXISTS (SELECT 1 FROM analytics.v_touch_base t WHERE t.lead_id = l.lead_id AND ${andAll(sql, touchConds)})`);
  }
  return andAll(sql, c);
}

/** WHERE for analytics.v_touch_base AS t (touches of the filtered lead set, plus direct touch filters) */
export function touchWhere(sql: Sql, f: Filters, p: Period, opts: BuildOpts = {}): Frag {
  const c: Frag[] = [
    sql`t.lead_id IN (SELECT l.lead_id FROM analytics.v_lead_base l WHERE ${leadWhere(sql, f, p, opts)})`,
  ];
  if (f.basis === 'touch') c.push(sql`t.touch_date BETWEEN ${p.from} AND ${p.to}`);
  if (f.paid_touch && opts.skip !== 'paid_touch') c.push(boolCond(sql, 't', 'is_paid_touch', f.paid_touch === 'paid'));
  for (const k of LIST_KEYS) {
    if (k === opts.skip || !isTouchDim(k)) continue;
    const vals = f[k];
    if (vals?.length) c.push(inList(sql, 't', TOUCH_DIMS[k].col, vals));
  }
  return andAll(sql, c);
}

/** Group-by expression for a dimension on the given alias (text output, NULL -> '(null)'). */
export function dimExpr(sql: Sql, dim: Dim, alias: 'l' | 't'): Frag {
  const spec = dimSpec(dim);
  const ref = sql`${sql(alias)}.${sql(spec.col)}`;
  if (spec.kind === 'bool') {
    const [yes, no] = spec.boolLabels ?? ['Yes', 'No'];
    return sql`CASE WHEN ${ref} THEN ${yes}::text ELSE ${no}::text END`;
  }
  return sql`COALESCE(${ref}::text, ${NULL_TOKEN}::text)`;
}

/** The daily MV can answer the trend when only these filters are active (created basis). */
const DAILY_MV_DIMS = new Set(['lead_source', 'class_group', 'lead_stage', 'owner', 'district', 'paid']);
export function canUseDailyMv(f: Filters): boolean {
  if (f.basis !== 'created' || f.converted) return false;
  return activeDimKeys(f).every((k) => DAILY_MV_DIMS.has(k));
}
