import { useState, type ReactNode } from 'react';
import { useApi } from '../lib/api';
import { useFilters, type ListDim } from '../lib/filters';
import { fmt1, fmtINR, fmtInt, fmtPct, fmtDateTime } from '../lib/format';
import { ChartCard } from '../components/ChartCard';
import { DataTable, type Col } from '../components/DataTable';
import { DailyLines, Donut, HBars, Heatmap } from '../charts';
import { CardSearch, Icon, Note, PageHeader, Segmented, Skeleton } from '../components/ui';
import { KpiTile } from '../components/KpiTile';
import { DrillDrawer, type Drill } from '../components/DrillDrawer';

interface Dim { key: string; users: number; touches: number; revenue: number; new_users: number; share_pct: number | null }
interface Resp {
  period: { from: string; to: string };
  kpis: { users: number; new_users: number; no_touch: number; no_lead: number; payments_all: number; revenue_all: number; sales: number; sales_app: number; sales_ujra: number; touches: number; no_touch_pct: number | null; no_lead_pct: number | null; };
  class_mix: { lead_class: string; bought_class: string; users: number }[];
  class_kpi: { mismatch_users: number; with_class_users: number; no_class_users: number; no_stream_users: number; mismatch_pct: number | null };
  class_on: 'lead' | 'bought';
  by_stage: Dim[]; by_last_touch_point: Dim[]; by_last_source: Dim[]; by_last_medium: Dim[]; by_last_campaign: Dim[]; by_last_staff: Dim[]; by_course: Dim[]; by_grade: Dim[];
  by_first_touch_point: Dim[]; by_first_source: Dim[]; by_first_medium: Dim[]; by_first_campaign: Dim[]; by_first_staff: Dim[];
  by_app_prev_source: Dim[];
  daily: { d: string; users: number; payments: number; revenue: number }[];
  tat: Record<'created' | 'touch', { leads: number; avg_days: number | null; median_days: number | null; buckets: { key: string; leads: number }[] }>;
  grades: string[];
  definitions: Record<string, string>;
}
type Row = Record<string, unknown>;

const yesNo = (v: unknown) => (v ? 'Yes' : 'No');
const USER_COLS: Col<Row>[] = [
  { key: 'user_id', header: 'EPS ID' }, { key: 'lead_name', header: 'Lead ID' },
  { key: 'first_name', header: 'Name', render: (v, r) => `${v ?? ''} ${r.last_name ?? ''}`.trim() || '–' }, { key: 'mobile', header: 'Phone' },
  { key: 'lead_stage', header: 'Stage' }, { key: 'class_raw', header: 'Lead class' }, { key: 'grades', header: 'Purchased grade (in range)' }, { key: 'courses', header: 'Course / batch (in range)' },
  { key: 'payments', header: 'Payments (in range)', align: 'right' }, { key: 'first_payment_date', header: 'First payment (in range)' }, { key: 'last_payment_date', header: 'Last payment (in range)' },
  { key: 'revenue', header: 'Revenue (in range)', render: (v) => fmtINR(v as number) },
  { key: 'payments_all_time', header: 'Payments (all time)', align: 'right' }, { key: 'revenue_all_time', header: 'Revenue (all time)', render: (v) => fmtINR(v as number) }, { key: 'first_payment_ever', header: 'First ever payment' },
  { key: 'last_touch_point', header: 'Last touch point' }, { key: 'last_touch_source', header: 'Last touch source' }, { key: 'last_touch_medium', header: 'Last touch medium' },
  { key: 'last_touch_campaign', header: 'Last touch campaign' }, { key: 'last_touch_staff', header: 'Last touch staff' },
  { key: 'last_touch_at', header: 'Last touch time', render: (v) => fmtDateTime(v as string) },
  { key: 'first_touch_point', header: 'First touch point' }, { key: 'first_touch_source', header: 'First touch source' }, { key: 'first_touch_at', header: 'First touch time', render: (v) => fmtDateTime(v as string) },
  { key: 'prev_touch_point', header: 'Touch before last' }, { key: 'prev_touch_source', header: 'Source before last' }, { key: 'prev_touch_at', header: 'Touch before last · time', render: (v) => fmtDateTime(v as string) },
  { key: 'touches_before_payment', header: 'Touches before payment', align: 'right' },
  { key: 'last_call_at', header: 'Last call', render: (v) => fmtDateTime(v as string) }, { key: 'last_call_reason', header: 'Last call reason' }, { key: 'calls', header: 'Calls', align: 'right' },
  { key: 'lead_source', header: 'Primary source' }, { key: 'owner_name', header: 'Owner' }, { key: 'no_lead', header: 'No lead', render: yesNo }, { key: 'lead_id', header: 'Salesforce Id' },
];
const USER_SORTS: [string, string][] = [['last_payment_date', 'Last payment'], ['first_payment_date', 'First payment'], ['revenue', 'Revenue'], ['payments', 'Payments'], ['touches_before_payment', 'Touches before payment'], ['last_touch_at', 'Last touch time'], ['lead_name', 'Lead ID'], ['lead_stage', 'Stage']];

function Kpi(p: { title: string; value: string; sub?: string; def?: string; tone: string; icon: ReactNode; onClick?: () => void }) { return <KpiTile {...p} />; }

type Pick = { selected: string[]; toggle: (key: string) => void; set: (keys: string[]) => void };
/** expand: one row of the table gets a "+" that opens `rows` under it (same columns); clicking a sub-row calls onPick with its key */
type ConvCardOpts = { filterDim?: ListDim; pick?: Pick; asTable?: boolean; height?: number; limit?: number; help?: string; cols?: Col<Dim>[]; expand?: { key: string; rows: Dim[]; onPick: (key: string) => void } };

function ConvCard({ title, rows, tone, opts, cols, loading, error, onRetry, help, selected, onRow, onApply, control, fileName }: {
  title: string; rows: Dim[] | undefined; tone: string; opts: ConvCardOpts; cols: Col<Dim>[]; loading: boolean; error: unknown; onRetry: () => void; help: string;
  selected: string[]; onRow: (key: string) => void; onApply?: (keys: string[]) => void; control?: ReactNode; fileName?: string;
}) {
  const [search, setSearch] = useState('');
  const s = search.trim().toLowerCase();
  const all = rows ?? [];
  const filtered = s ? all.filter((r) => r.key.toLowerCase().includes(s)) : all;
  const data = filtered.slice(0, opts.limit ?? 14);
  return (
    <ChartCard title={title} tone={tone} subtitle={rows ? `${fmtInt(filtered.reduce((x, r) => x + r.users, 0))} users${s ? ` in ${filtered.length} matching rows` : ''} · ${opts.filterDim || opts.pick ? `click rows to filter every card (multi-select)${selected.length ? ` · ${selected.length} selected` : ''}` : 'click a row for the users'}` : undefined}
      loading={loading} error={error} onRetry={onRetry} rows={filtered} columns={cols} height={opts.asTable ? opts.height ?? 280 : Math.max(opts.height ?? 280, data.length * 24 + 16)} help={help}
      titleAddon={control} fileName={fileName}
      actions={<div className="flex items-center gap-2"><CardSearch value={search} onChange={setSearch} count={filtered.length} onApply={onApply ? () => onApply(filtered.map((r) => r.key)) : undefined} /></div>}>
      {opts.asTable
        ? <DataTable rows={filtered} compact maxHeight="100%" initialSort={{ id: 'users', desc: true }} onRowClick={(r) => onRow(r.key)} columns={cols} highlight={(r) => selected.includes(r.key)}
            subRows={opts.expand ? (r) => (r.key === opts.expand!.key && opts.expand!.rows.length ? opts.expand!.rows : undefined) : undefined}
            onSubRowClick={opts.expand ? (_p, c) => opts.expand!.onPick(c.key) : undefined} />
        : <HBars colorful data={data.map((r) => ({ key: r.key, value: r.users, secondary: r.share_pct, selected: selected.includes(r.key), extra: { Revenue: fmtINR(r.revenue), 'Touches before payment': fmtInt(r.touches) } }))}
            valueLabel="Converted (users)" secondaryLabel="Share" onClick={onRow} />}
    </ChartCard>
  );
}

/** Tableau "Lead Touch - Converted": paying users by payment date, credited to their last touch before the payment. */
/** Same-class rule of the Bought a different class tile (user rules 2026-11-26; mirrors api/src/filters.ts sameClass) for the matrix: which
 *  cells count as the same class, and why. Outlined cells are not counted as different. */
const num = (v: string) => /^Class (\d+)/.exec(v)?.[1] ?? null;
type Rule = 'excluded' | 'same' | 'no_stream' | 'cbse' | 'no_board' | 'crash' | 'different';
function classRule(lead: string, bought: string): Rule {
  if (['Unknown', 'No Salesforce Lead'].includes(lead) || bought === 'Integrated') return 'excluded';
  if (lead === bought) return 'same';
  if (/^Class 1[12] \(no stream\)$/.test(lead) && num(bought) === num(lead)) return 'no_stream';
  if (/^Class 1[12] CBSE$/.test(lead) && /^Class 1[12] (Science|Commerce|Humanities) CBSE$/.test(bought) && num(bought) === num(lead)) return 'cbse';
  if (/^Class ([7-9]|10)$/.test(bought) && num(bought) === num(lead)) return 'no_board';
  if (['KEAM/JEE Crash', 'NEET Crash', 'Repeater', 'Plus Two Completed'].includes(bought) && (['Plus Two Completed', 'Repeater', 'KEAM/JEE Crash', 'NEET Crash'].includes(lead) || num(lead) === '12')) return 'crash';
  return 'different';
}
const RULE_TEXT: Record<Rule, string> = {
  excluded: 'not counted (no lead class, or an Ujra booking)',
  same: 'same class',
  no_stream: 'counted as the same class: the lead has no stream, so any stream of that class matches',
  cbse: 'counted as the same class: CBSE lead with no stream, CBSE course of that class',
  no_board: 'counted as the same class: the course name gives no board',
  crash: 'counted as the same class: crash / repeater course for a Plus Two track lead',
  different: 'different class',
};

export default function Converted() {
  const [touchMode, setTouchMode] = useState<Record<string, 'last' | 'first'>>({});
  const { f, params, toggleValue, setList } = useFilters();
  // (the Purchased grade picker was removed 2026-11-24: the filter bar's Class filter on Purchased class covers it; the grade card drills instead)
  // purchased course picked on the course table (multi-select)
  const [courses, setCourses] = useState<string[]>([]);
  const course = courses.join('|');
  const toggleIn = (list: string[], set: (v: string[]) => void) => (key: string) => set(list.includes(key) ? list.filter((x) => x !== key) : [...list, key]);
  const [pm, setPm] = useState<'all' | 'm0' | 'm1'>(() => { try { return (localStorage.getItem('lt-pm') as 'all' | 'm0' | 'm1') || 'all'; } catch { return 'all'; } });
  const changePm = (v: 'all' | 'm0' | 'm1') => { setPm(v); try { localStorage.setItem('lt-pm', v); } catch { /* ignore */ } };
  // what the Class filter means comes from the filter bar's Lead class / Purchased class switch (params.class_on, 2026-11-23)
  const q = useApi<Resp>('/converted', { ...params, course, pm });
  const [tat, setTat] = useState<'created' | 'touch'>('created');
  const d = q.data?.data;
  const k = d?.kpis;
  const def = d?.definitions ?? {};
  const [drill, setDrill] = useState<Drill | null>(null);
  const open = (title: string, dim?: string, value?: string, subtitle?: string) =>
    setDrill({ metric: 'leads', title, dim, value, subtitle: subtitle ?? 'paying users with a valid payment in the window · click a row for the lead record', path: '/converted/users', csvPath: '/converted/users.csv', columns: USER_COLS, sortOptions: USER_SORTS, defaultSort: 'last_payment_date', extra: { pm, ...(course ? { course } : {}) }, noun: 'users' });

  // class-mix matrix: classes in school order, then the named groups
  // full names (2026-11-23): Class N first by number, then Board / CBSE / streams in a fixed order
  const SUFFIX = ['', 'Board', 'CBSE', 'Science', 'Science CBSE', 'Commerce', 'Commerce CBSE', 'Humanities', 'Humanities CBSE', '(no stream)'];
  const classOrder = (v: string) => { const n = /^Class (\d+) ?(.*)$/.exec(v); if (n) return Number(n[1]) * 10 + Math.max(0, SUFFIX.indexOf(n[2] ?? '')) / 2; return ['Plus Two Completed', 'Repeater', 'KEAM/JEE Crash', 'NEET Crash', 'NMMS', 'Integrated', 'Other', 'Unknown', 'No Salesforce Lead'].indexOf(v) + 1000; };
  const byClass = (a: string, b: string) => classOrder(a) - classOrder(b) || a.localeCompare(b);
  const mix = d?.class_mix ?? [];
  const mixMap = new Map(mix.map((r) => [`${r.lead_class}||${r.bought_class}`, r.users]));
  const classRows = [...new Set(mix.map((r) => r.lead_class))].sort(byClass);
  const classCols = [...new Set(mix.map((r) => r.bought_class))].sort(byClass);

  const dimCols: Col<Dim>[] = [
    { key: 'key', header: '', render: (v) => <span className="block min-w-[8rem] max-w-[14rem] whitespace-normal leading-snug [overflow-wrap:anywhere]">{String(v ?? '')}</span> }, { key: 'users', header: 'Converted (users)', bar: true }, { key: 'share_pct', header: 'Share', render: (v) => fmtPct(v as number) },
    { key: 'new_users', header: 'New customers' }, { key: 'touches', header: 'Touches before payment' }, { key: 'revenue', header: 'Revenue', render: (v) => fmtINR(v as number) },
  ];
  const payCols: Col<Dim>[] = [
    { key: 'key', header: '', render: (v) => <span className="block min-w-[8rem] max-w-[14rem] whitespace-normal leading-snug [overflow-wrap:anywhere]">{String(v ?? '')}</span> }, { key: 'users', header: 'Converted (users)', bar: true }, { key: 'touches', header: 'Payments' }, { key: 'revenue', header: 'Revenue (window)', render: (v) => fmtINR(v as number) },
  ];

  const card = (title: string, rows: Dim[] | undefined, drillDim: string, tone: string, opts: ConvCardOpts = {}, control?: ReactNode, cardKey?: string, shownTitle?: string) => (
    <ConvCard key={cardKey ?? title} control={control} fileName={title} title={shownTitle ?? title} rows={rows} tone={tone} opts={opts} cols={opts.cols ?? dimCols} loading={q.isLoading} error={q.error} onRetry={q.refetch}
      help={opts.help ?? def.credit} selected={opts.pick ? opts.pick.selected : opts.filterDim ? (f.lists[opts.filterDim] ?? []) : []}
      onRow={(key) => (opts.pick ? opts.pick.toggle(key) : opts.filterDim ? toggleValue(opts.filterDim, key) : open(`${title} · ${key}`, drillDim, key))}
      onApply={opts.pick ? opts.pick.set : opts.filterDim ? (keys) => setList(opts.filterDim!, keys) : undefined} />
  );

  // first / last touch pairs: one card each with a Last touch / First touch switch (user, 2026-11-27); Last touch is the default
  const pair = (name: string, tone: string, last: { rows: Dim[] | undefined; drill: string; opts?: ConvCardOpts }, first: { rows: Dim[] | undefined; drill: string; opts?: ConvCardOpts }) => {
    const m = touchMode[name] ?? 'last';
    const sw = <Segmented size="xs" value={m} onChange={(v) => setTouchMode((o) => ({ ...o, [name]: v }))} options={[
      { value: 'last', label: 'Last touch', title: 'credited to the last touch before the payment' },
      { value: 'first', label: 'First touch', title: 'credited to the first touch before the payment' },
    ]} />;
    return m === 'last'
      ? card(`${name} (last touch)`, last.rows, last.drill, tone, last.opts ?? {}, sw, name, name)
      : card(`${name} (first touch)`, first.rows, first.drill, tone, { help: def.first_credit, ...(first.opts ?? {}) }, sw, name, name);
  };

  // the row of three (2026-11-27): bar cards grow with their bars (24 px each, no inner scroll); Lead stage takes the same height
  const barsH = (n: number | undefined, min: number) => Math.max(min, Math.min(n ?? 0, 14) * 24 + 16);
  const topRowH = Math.max(barsH(d?.by_last_touch_point?.length, 260), barsH(d?.by_first_touch_point?.length, 260), barsH(d?.by_grade?.length, 280));
  return (
    <div className="space-y-4">
      <PageHeader title="Converted" subtitle={`payment date ${f.from} → ${f.to} · paying users by PAYMENT date, whatever their touch dates · credited to the last touch before payment`}
        right={<div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-ink-2" title={def.pm}>Payment method
            <Segmented size="xs" value={pm} onChange={changePm} options={[{ value: 'all', label: 'All', title: 'Every successful payment, any payment method' }, { value: 'm0', label: 'First payment', title: 'The first payment of a course (payment_method 0): the rule the Overview uses' }, { value: 'm1', label: 'Follow-up', title: 'Later instalments of a course (payment_method 1, gateway EMI)' }]} />
          </label>
          {courses.length > 0 && (
            <span className="chip" title={courses.join(', ')}><b>Purchased course</b>: {courses.length === 1 ? courses[0] : `${courses.length} selected`}
              <button className="ml-1 text-ink-3 hover:text-ink" title="Clear the course selection" onClick={() => setCourses([])}>×</button></span>
          )}</div>} />
      {q.error && <Note>⚠ {q.error.message}</Note>}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-6">
        {q.isLoading && Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-[92px]" />)}
        {k && <>
          <Kpi tone="tone-orange" icon={<Icon.Check />} title={pm === 'm0' ? 'Sales (courses)' : 'Courses paid'} value={fmtInt(k.sales)} sub={`app ${fmtInt(k.sales_app)} · Ujra ${fmtInt(k.sales_ujra)}`} def={def.sales} onClick={() => open('Converted users')} />
          <Kpi tone="tone-green" icon={<Icon.Spark />} title="New customers" value={fmtInt(k.new_users)} sub={`${fmtPct(k.users ? Math.round((k.new_users / k.users) * 10000) / 100 : null)} of ${fmtInt(k.users)} paying users · first ever payment in window`} def={def.new_users} onClick={() => open('New customers', 'new_customer', '1', 'paying users whose FIRST ever valid payment is inside the window · click a row for the lead record')} />
          <Kpi tone="tone-violet" icon={<Icon.Avg />} title="Revenue (window)" value={fmtINR(k.revenue_all)} sub="payment amounts dated in the window" def={def.revenue} onClick={() => open('Revenue (window)', undefined, undefined, 'paying users of the selection with their payments and revenue inside the window · sort by Revenue · click a row for the lead record')} />
          <Kpi tone="tone-pink" icon={<Icon.Touch />} title="No touch before payment" value={fmtInt(k.no_touch)} sub={`${fmtPct(k.no_touch_pct)} of users`} def={def.no_touch} onClick={() => open('No touch before payment', 'last_touch_point', 'No Touch Before Payment')} />
          <Kpi tone="tone-slate" icon={<Icon.Users />} title="No Salesforce lead" value={fmtInt(k.no_lead)} sub={`${fmtPct(k.no_lead_pct)} of users`} def={def.no_lead} onClick={() => open('Users with no Salesforce lead', 'lead_stage', '(null)')} />
          <Kpi tone="tone-amber" icon={<Icon.Users />} title="Bought a different class" value={fmtInt(d?.class_kpi.mismatch_users ?? 0)} sub={`${fmtPct(d?.class_kpi.mismatch_pct ?? null)} of ${fmtInt(d?.class_kpi.with_class_users ?? 0)} users with a lead class`} def={def.class_mismatch} onClick={() => open('Bought a different class', 'class_mismatch', '1', 'users whose lead class (Salesforce) differs from the class of a course they bought in the window · click a row for the lead record')} />
        </>}
      </div>

      {/* lead class (Salesforce) vs the class of the course bought (2026-11-23): diagonal = match, anything else = a different class */}
      <ChartCard title="Lead class vs purchased class" tone="tone-amber" loading={q.isLoading} error={q.error} rows={d?.class_mix ?? []} height={Math.max(260, classRows.length * 24 + 170)} fitContent help={def.class_mix}
        subtitle={`paying users · rows = class on the Salesforce lead, columns = class of the course bought in the window · off the diagonal = a different class · click a cell for the users`}>
        <Heatmap rows={classRows} cols={classCols} rowLabel="Lead class ↓" colLabel="Purchased class"
          get={(r, c) => mixMap.get(`${r}||${c}`) ?? null} mark={(r, c) => !['different', 'excluded'].includes(classRule(r, c))}
          verticalCols
          cellTitle={(r, c, v) => `${r} lead → bought ${c}: ${v == null ? 0 : fmtInt(v)} users · ${RULE_TEXT[classRule(r, c)]}`}
          onClick={(r, c) => { if (mixMap.get(`${r}||${c}`)) open(`Lead ${r} · bought ${c}`, 'class_mix', `${r}||${c}`, `users whose Salesforce lead says ${r} and who bought a ${c} course in the window · click a row for the lead record`); }} />
      </ChartCard>

      {/* row of three (user, 2026-11-27): lead stage, touch point, purchased grade; then pairs, Turnaround second in the last row */}
      <div className="grid gap-4 xl:grid-cols-3">
        <ChartCard title="Lead stage distribution" tone="tone-brand" subtitle="converted users by lead stage · click a slice to filter" loading={q.isLoading} error={q.error} rows={d?.by_stage ?? []} columns={dimCols} height={topRowH} help={def.stage}>
          <Donut data={(d?.by_stage ?? []).map((s) => ({ key: s.key === '(null)' ? 'No Salesforce lead' : s.key, value: s.users, selected: (f.lists.lead_stage ?? []).includes(s.key) }))} valueLabel="Converted (users)" centerLabel="users" onClick={(key) => toggleValue('lead_stage', key === 'No Salesforce lead' ? '(null)' : key)} />
        </ChartCard>
        {pair('Touch point analysis', 'tone-teal', { rows: d?.by_last_touch_point, drill: 'last_touch_point', opts: { filterDim: 'touch_point', height: 260 } }, { rows: d?.by_first_touch_point, drill: 'first_touch_point', opts: { height: 260 } })}
        {card('Purchased grade', d?.by_grade, 'grade', 'tone-amber', { cols: payCols, help: def.grade, height: 280, filterDim: 'purchased_grade' })}
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {card('Class wise conversion (purchased course)', d?.by_course, 'course', 'tone-violet', { asTable: true, cols: payCols, help: def.course, pick: { selected: courses, toggle: toggleIn(courses, setCourses), set: setCourses } })}
        {pair('Touch source distribution', 'tone-orange', { rows: d?.by_last_source, drill: 'last_touch_source', opts: { filterDim: 'source', asTable: true,
          help: `${def.credit ?? ''} The "+" on App Installed shows the source of the touch before the install.`,
          expand: { key: 'App Installed', rows: d?.by_app_prev_source ?? [], onPick: (key) => open(`App Installed (last touch) · touch before it: ${key}`, 'app_prev_source', key, 'paying users credited to an App Installed last touch whose touch before the install has this source · click a row for the lead record') } } }, { rows: d?.by_first_source, drill: 'first_touch_source', opts: { asTable: true } })}
        {pair('Staff-wise', 'tone-pink', { rows: d?.by_last_staff, drill: 'last_touch_staff', opts: { filterDim: 'staff', asTable: true } }, { rows: d?.by_first_staff, drill: 'first_touch_staff', opts: { asTable: true } })}
        {pair('Medium wise conversion', 'tone-green', { rows: d?.by_last_medium, drill: 'last_touch_medium', opts: { filterDim: 'medium', asTable: true } }, { rows: d?.by_first_medium, drill: 'first_touch_medium', opts: { asTable: true } })}
        {pair('Campaign wise conversion', 'tone-brand', { rows: d?.by_last_campaign, drill: 'last_touch_campaign', opts: { filterDim: 'campaign', asTable: true } }, { rows: d?.by_first_campaign, drill: 'first_touch_campaign', opts: { asTable: true } })}
        <ChartCard title="Turnaround time" tone="tone-green" help={def.tat} loading={q.isLoading} error={q.error} rows={d?.tat?.[tat]?.buckets ?? []} height={240}
          subtitle={d?.tat ? `${fmtInt(d.tat[tat].leads)} paying users · median ${d.tat[tat].median_days == null ? '–' : fmt1(d.tat[tat].median_days)} d · average ${d.tat[tat].avg_days == null ? '–' : fmt1(d.tat[tat].avg_days)} d` : 'days to the first payment'}
          actions={<Segmented size="xs" value={tat} onChange={setTat} options={[
            { value: 'created', label: 'Lead created → paid', title: 'days from the lead\'s creation day to the user\'s first valid payment day' },
            { value: 'touch', label: 'Last touch → paid', title: 'days from the latest touch on or before the first payment to that payment day' },
          ]} />}>
          <HBars data={(d?.tat?.[tat]?.buckets ?? []).map((b) => ({ key: b.key, value: b.leads, secondary: d?.tat?.[tat]?.leads ? (b.leads / d.tat[tat].leads) * 100 : null }))} valueLabel="Paying users" secondaryLabel="share" />
        </ChartCard>
      </div>

      {/* Payments per day takes the whole row (2026-11-27) */}
      <div>
        <ChartCard title="Payments per day" tone="tone-teal" subtitle="paying users and payments by payment date" loading={q.isLoading} error={q.error} rows={d?.daily ?? []} height={260}>
          <DailyLines data={(d?.daily ?? []).map((r) => ({ d: r.d.slice(5), users: r.users, payments: r.payments }))} xKey="d" lines={[{ key: 'users', label: 'Users' }, { key: 'payments', label: 'Payments' }]} />
        </ChartCard>
      </div>

      {drill && <DrillDrawer drill={drill} onClose={() => setDrill(null)} />}
      <Note>This page counts <b>paying app users</b>, not Salesforce leads, and its date range is the <b>payment date</b>, whatever the basis switch says. Each user is credited to one touch: the latest touch dated on or before the last payment day, across every lead sharing the phone (an Eduport App touch less than 30 minutes before the payment passes the credit to the touch before it; with no touch before it the user is "No Touch Before Payment"); users without such a touch are grouped as "No Touch Before Payment", and users whose phone matches no lead as "No Salesforce lead". Purchased grade and course come from the batch that was bought, so they can differ from the lead's class. On this page the Class filter is the grade of the batch that was bought (the core grade titles, as in Metabase); the class on the Salesforce lead does not filter it.</Note>
    </div>
  );
}
