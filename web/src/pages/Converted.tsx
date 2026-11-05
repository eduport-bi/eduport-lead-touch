import { useState, type ReactNode } from 'react';
import { useApi } from '../lib/api';
import { useFilters, type ListDim } from '../lib/filters';
import { fmt1, fmtINR, fmtInt, fmtPct, fmtDateTime } from '../lib/format';
import { ChartCard } from '../components/ChartCard';
import { DataTable, type Col } from '../components/DataTable';
import { DailyLines, Donut, HBars } from '../charts';
import { CardSearch, Icon, Note, PageHeader, Popover, Segmented, Skeleton } from '../components/ui';
import { KpiTile } from '../components/KpiTile';
import { DrillDrawer, type Drill } from '../components/DrillDrawer';

interface Dim { key: string; users: number; touches: number; revenue: number; new_users: number; share_pct: number | null }
interface Resp {
  period: { from: string; to: string };
  kpis: { users: number; new_users: number; no_touch: number; no_lead: number; payments_all: number; revenue_all: number; sales: number; sales_app: number; sales_ujra: number; touches: number; no_touch_pct: number | null; no_lead_pct: number | null; };
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
  { key: 'lead_source', header: 'Primary source' }, { key: 'owner_name', header: 'Owner' }, { key: 'no_lead', header: 'No lead', render: yesNo }, { key: 'lead_id', header: 'Salesforce Id' },
];
const USER_SORTS: [string, string][] = [['last_payment_date', 'Last payment'], ['first_payment_date', 'First payment'], ['revenue', 'Revenue'], ['payments', 'Payments'], ['touches_before_payment', 'Touches before payment'], ['last_touch_at', 'Last touch time'], ['lead_name', 'Lead ID'], ['lead_stage', 'Stage']];

function Kpi(p: { title: string; value: string; sub?: string; def?: string; tone: string; icon: ReactNode; onClick?: () => void }) { return <KpiTile {...p} />; }

type Pick = { selected: string[]; toggle: (key: string) => void; set: (keys: string[]) => void };
type ConvCardOpts = { filterDim?: ListDim; pick?: Pick; asTable?: boolean; height?: number; limit?: number; help?: string; cols?: Col<Dim>[] };

function ConvCard({ title, rows, tone, opts, cols, loading, error, onRetry, help, selected, onRow, onApply }: {
  title: string; rows: Dim[] | undefined; tone: string; opts: ConvCardOpts; cols: Col<Dim>[]; loading: boolean; error: unknown; onRetry: () => void; help: string;
  selected: string[]; onRow: (key: string) => void; onApply?: (keys: string[]) => void;
}) {
  const [search, setSearch] = useState('');
  const s = search.trim().toLowerCase();
  const all = rows ?? [];
  const filtered = s ? all.filter((r) => r.key.toLowerCase().includes(s)) : all;
  const data = filtered.slice(0, opts.limit ?? 14);
  return (
    <ChartCard title={title} tone={tone} subtitle={rows ? `${fmtInt(filtered.reduce((x, r) => x + r.users, 0))} users${s ? ` in ${filtered.length} matching rows` : ''} · ${opts.filterDim || opts.pick ? `click rows to filter every card (multi-select)${selected.length ? ` · ${selected.length} selected` : ''}` : 'click a row for the users'}` : undefined}
      loading={loading} error={error} onRetry={onRetry} rows={filtered} columns={cols} height={opts.height ?? 280} help={help}
      actions={<CardSearch value={search} onChange={setSearch} count={filtered.length} onApply={onApply ? () => onApply(filtered.map((r) => r.key)) : undefined} />}>
      {opts.asTable
        ? <DataTable rows={filtered} compact maxHeight="100%" initialSort={{ id: 'users', desc: true }} onRowClick={(r) => onRow(r.key)} columns={cols} highlight={(r) => selected.includes(r.key)} />
        : <HBars colorful data={data.map((r) => ({ key: r.key, value: r.users, secondary: r.share_pct, selected: selected.includes(r.key), extra: { Revenue: fmtINR(r.revenue), 'Touches before payment': fmtInt(r.touches) } }))}
            valueLabel="Converted (users)" secondaryLabel="Share" onClick={onRow} />}
    </ChartCard>
  );
}

/** Tableau "Lead Touch - Converted": paying users by payment date, credited to their last touch before the payment. */
export default function Converted() {
  const { f, params, toggleValue, setList } = useFilters();
  const [grades, setGrades] = useState<string[]>([]);
  const grade = grades.join('|');   // the API takes a pipe-separated list
  // purchased course picked on the course table (multi-select), like the grade
  const [courses, setCourses] = useState<string[]>([]);
  const course = courses.join('|');
  const toggleIn = (list: string[], set: (v: string[]) => void) => (key: string) => set(list.includes(key) ? list.filter((x) => x !== key) : [...list, key]);
  const [pm, setPm] = useState<'all' | 'm0' | 'm1'>(() => { try { return (localStorage.getItem('lt-pm') as 'all' | 'm0' | 'm1') || 'all'; } catch { return 'all'; } });
  const changePm = (v: 'all' | 'm0' | 'm1') => { setPm(v); try { localStorage.setItem('lt-pm', v); } catch { /* ignore */ } };
  const q = useApi<Resp>('/converted', { ...params, grade, course, pm });
  const [tat, setTat] = useState<'created' | 'touch'>('created');
  const d = q.data?.data;
  const k = d?.kpis;
  const def = d?.definitions ?? {};
  const [drill, setDrill] = useState<Drill | null>(null);
  const open = (title: string, dim?: string, value?: string, subtitle?: string) =>
    setDrill({ metric: 'leads', title, dim, value, subtitle: subtitle ?? 'paying users with a valid payment in the window · click a row for the lead record', path: '/converted/users', csvPath: '/converted/users.csv', columns: USER_COLS, sortOptions: USER_SORTS, defaultSort: 'last_payment_date', extra: { pm, ...(course ? { course } : {}), ...(grade ? { grade } : {}) }, noun: 'users' });

  const dimCols: Col<Dim>[] = [
    { key: 'key', header: '' }, { key: 'users', header: 'Converted (users)', bar: true }, { key: 'share_pct', header: 'Share', render: (v) => fmtPct(v as number) },
    { key: 'new_users', header: 'New customers' }, { key: 'touches', header: 'Touches before payment' }, { key: 'revenue', header: 'Revenue', render: (v) => fmtINR(v as number) },
  ];
  const payCols: Col<Dim>[] = [
    { key: 'key', header: '' }, { key: 'users', header: 'Converted (users)', bar: true }, { key: 'touches', header: 'Payments' }, { key: 'revenue', header: 'Revenue (window)', render: (v) => fmtINR(v as number) },
  ];

  const card = (title: string, rows: Dim[] | undefined, drillDim: string, tone: string, opts: ConvCardOpts = {}) => (
    <ConvCard key={title} title={title} rows={rows} tone={tone} opts={opts} cols={opts.cols ?? dimCols} loading={q.isLoading} error={q.error} onRetry={q.refetch}
      help={opts.help ?? `${title}. ${def.credit ?? ''}`} selected={opts.pick ? opts.pick.selected : opts.filterDim ? (f.lists[opts.filterDim] ?? []) : []}
      onRow={(key) => (opts.pick ? opts.pick.toggle(key) : opts.filterDim ? toggleValue(opts.filterDim, key) : open(`${title} · ${key}`, drillDim, key))}
      onApply={opts.pick ? opts.pick.set : opts.filterDim ? (keys) => setList(opts.filterDim!, keys) : undefined} />
  );

  return (
    <div className="space-y-4">
      <PageHeader title="Converted" subtitle={`payment date ${f.from} → ${f.to} · paying users by PAYMENT date, whatever their touch dates · credited to the last touch before payment`}
        right={<div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-ink-2" title={def.pm}>Payment method
            <Segmented size="xs" value={pm} onChange={changePm} options={[{ value: 'all', label: 'All', title: 'Every successful payment, any payment method' }, { value: 'm0', label: 'Method 0', title: 'payment_method = 0 only: the rule the Overview uses' }, { value: 'm1', label: 'Method 1', title: 'payment_method = 1: gateway EMI instalments' }]} />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-ink-2">Purchased grade
            <GradePicker all={d?.grades ?? []} value={grades} onChange={setGrades} />
          </label>
          {courses.length > 0 && (
            <span className="chip" title={courses.join(', ')}><b>Purchased course</b>: {courses.length === 1 ? courses[0] : `${courses.length} selected`}
              <button className="ml-1 text-ink-3 hover:text-ink" title="Clear the course selection" onClick={() => setCourses([])}>×</button></span>
          )}</div>} />
      {q.error && <Note>⚠ {q.error.message}</Note>}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-5">
        {q.isLoading && Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-[92px]" />)}
        {k && <>
          <Kpi tone="tone-orange" icon={<Icon.Check />} title={pm === 'm0' ? 'Sales (courses)' : 'Courses paid'} value={fmtInt(k.sales)} sub={`app ${fmtInt(k.sales_app)} · Ujra ${fmtInt(k.sales_ujra)}`} def={def.sales} onClick={() => open('Converted users')} />
          <Kpi tone="tone-green" icon={<Icon.Spark />} title="New customers" value={fmtInt(k.new_users)} sub={`${fmtPct(k.users ? Math.round((k.new_users / k.users) * 10000) / 100 : null)} first ever payment in window`} def={def.new_users} onClick={() => open('New customers', 'new_customer', '1', 'paying users whose FIRST ever valid payment is inside the window · click a row for the lead record')} />
          <Kpi tone="tone-violet" icon={<Icon.Avg />} title="Revenue (window)" value={fmtINR(k.revenue_all)} sub="payment amounts dated in the window" def={def.revenue} onClick={() => open('Revenue (window)', undefined, undefined, 'paying users of the selection with their payments and revenue inside the window · sort by Revenue · click a row for the lead record')} />
          <Kpi tone="tone-pink" icon={<Icon.Touch />} title="No touch before payment" value={fmtInt(k.no_touch)} sub={`${fmtPct(k.no_touch_pct)} of users`} def={def.no_touch} onClick={() => open('No touch before payment', 'last_touch_point', 'No Touch Before Payment')} />
          <Kpi tone="tone-slate" icon={<Icon.Users />} title="No Salesforce lead" value={fmtInt(k.no_lead)} sub={`${fmtPct(k.no_lead_pct)} of users`} def={def.no_lead} onClick={() => open('Users with no Salesforce lead', 'lead_stage', '(null)')} />
        </>}
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard title="Lead stage distribution" tone="tone-brand" subtitle="converted users by lead stage · click a slice to filter" loading={q.isLoading} error={q.error} rows={d?.by_stage ?? []} columns={dimCols} height={260} help={def.stage}>
          <Donut data={(d?.by_stage ?? []).map((s) => ({ key: s.key === '(null)' ? 'No Salesforce lead' : s.key, value: s.users, selected: (f.lists.lead_stage ?? []).includes(s.key) }))} valueLabel="Converted (users)" centerLabel="users" onClick={(key) => toggleValue('lead_stage', key === 'No Salesforce lead' ? '(null)' : key)} />
        </ChartCard>
        {card('Touch point analysis (last touch)', d?.by_last_touch_point, 'last_touch_point', 'tone-teal', { filterDim: 'touch_point', height: 260 })}
        {card('Touch point analysis (first touch)', d?.by_first_touch_point, 'first_touch_point', 'tone-teal', { height: 260, help: def.first_credit })}
        {card('Class wise conversion (purchased course)', d?.by_course, 'course', 'tone-violet', { asTable: true, cols: payCols, help: def.course, pick: { selected: courses, toggle: toggleIn(courses, setCourses), set: setCourses } })}
        {card('Purchased grade', d?.by_grade, 'grade', 'tone-amber', { cols: payCols, help: def.grade, height: 280, pick: { selected: grades, toggle: toggleIn(grades, setGrades), set: setGrades } })}
        {card('Lead source distribution (last touch)', d?.by_last_source, 'last_touch_source', 'tone-orange', { filterDim: 'source', asTable: true })}
        {card('Lead source distribution (first touch)', d?.by_first_source, 'first_touch_source', 'tone-orange', { asTable: true, help: def.first_credit })}
        {card('Staff-wise (last touch)', d?.by_last_staff, 'last_touch_staff', 'tone-pink', { filterDim: 'staff', asTable: true })}
        {card('Staff-wise (first touch)', d?.by_first_staff, 'first_touch_staff', 'tone-pink', { asTable: true, help: def.first_credit })}
        {card('Medium wise conversion (last touch)', d?.by_last_medium, 'last_touch_medium', 'tone-green', { filterDim: 'medium', asTable: true })}
        {card('Medium wise conversion (first touch)', d?.by_first_medium, 'first_touch_medium', 'tone-green', { asTable: true, help: def.first_credit })}
        {card('Campaign wise conversion (last touch)', d?.by_last_campaign, 'last_touch_campaign', 'tone-brand', { filterDim: 'campaign', asTable: true })}
        {card('Campaign wise conversion (first touch)', d?.by_first_campaign, 'first_touch_campaign', 'tone-brand', { asTable: true, help: def.first_credit })}
        {card('App Installed (last touch) · the touch before it', d?.by_app_prev_source, 'app_prev_source', 'tone-orange', { asTable: true, help: def.app_prev })}
        <ChartCard title="Turnaround time" tone="tone-green" help={def.tat} loading={q.isLoading} error={q.error} rows={d?.tat?.[tat]?.buckets ?? []} height={240}
          subtitle={d?.tat ? `${fmtInt(d.tat[tat].leads)} paying users · median ${d.tat[tat].median_days == null ? '–' : fmt1(d.tat[tat].median_days)} d · average ${d.tat[tat].avg_days == null ? '–' : fmt1(d.tat[tat].avg_days)} d` : 'days to the first payment'}
          actions={<Segmented size="xs" value={tat} onChange={setTat} options={[
            { value: 'created', label: 'Lead created → paid', title: 'days from the lead\'s creation day to the user\'s first valid payment day' },
            { value: 'touch', label: 'Last touch → paid', title: 'days from the latest touch on or before the first payment to that payment day' },
          ]} />}>
          <HBars data={(d?.tat?.[tat]?.buckets ?? []).map((b) => ({ key: b.key, value: b.leads, secondary: d?.tat?.[tat]?.leads ? (b.leads / d.tat[tat].leads) * 100 : null }))} valueLabel="Paying users" secondaryLabel="share" />
        </ChartCard>
        <ChartCard title="Payments per day" tone="tone-teal" subtitle="paying users and payments by payment date" loading={q.isLoading} error={q.error} rows={d?.daily ?? []} height={260}>
          <DailyLines data={(d?.daily ?? []).map((r) => ({ d: r.d.slice(5), users: r.users, payments: r.payments }))} xKey="d" lines={[{ key: 'users', label: 'Users' }, { key: 'payments', label: 'Payments' }]} />
        </ChartCard>
      </div>

      {drill && <DrillDrawer drill={drill} onClose={() => setDrill(null)} />}
      <Note>This page counts <b>paying app users</b>, not Salesforce leads, and its date range is the <b>payment date</b>, whatever the basis switch says. Each user is credited to one touch: the latest touch dated on or before the last payment day, across every lead sharing the phone (an Eduport App touch less than 2 hours before the payment passes the credit to the touch before it, unless it is the only touch); users without such a touch are grouped as "No Touch Before Payment", and users whose phone matches no lead as "No Salesforce lead". Purchased grade and course come from the batch that was bought, so they can differ from the lead's class. The Class Group chip in the filter bar applies to the lead's class; use the Purchased grade selector above to filter by the grade that was bought.</Note>
    </div>
  );
}

/** Multi-select for the purchased grade: checkboxes in a popover, "All grades" when nothing is ticked. */
function GradePicker({ all, value, onChange }: { all: string[]; value: string[]; onChange: (v: string[]) => void }) {
  const label = value.length === 0 ? 'All grades' : value.length <= 2 ? value.join(', ') : `${value.length} grades`;
  const toggle = (g: string) => onChange(value.includes(g) ? value.filter((x) => x !== g) : [...value, g]);
  return (
    <Popover align="right" width="w-64" trigger={<button className={`btn !py-1 ${value.length ? 'border-accent/40 text-accent' : ''}`}>{label} <Icon.Chevron open /></button>}>
      {(close) => (
        <div className="text-xs">
          <div className="mb-1 flex items-center justify-between">
            <span className="font-semibold">Purchased grade</span>
            <button className="text-ink-3 hover:text-ink disabled:opacity-40" onClick={() => onChange([])} disabled={!value.length}>Clear</button>
          </div>
          <div className="max-h-72 space-y-0.5 overflow-y-auto">
            {all.map((g) => (
              <label key={g} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-surface-2">
                <input type="checkbox" checked={value.includes(g)} onChange={() => toggle(g)} />
                <span className="truncate">{g}</span>
              </label>
            ))}
          </div>
          <div className="mt-2 flex justify-end"><button className="btn btn-primary" onClick={close}>Done</button></div>
        </div>
      )}
    </Popover>
  );
}
