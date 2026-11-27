import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useApi } from '../lib/api';
import { useFilters, type ListDim } from '../lib/filters';
import { fmt1, fmt2, fmtInt, fmtINR, fmtPct } from '../lib/format';
import { ChartCard } from '../components/ChartCard';
import { DataTable, type Col } from '../components/DataTable';
import { DailyLines, Donut, HBars } from '../charts';
import { CardSearch, Icon, Note, PageHeader, Segmented, Skeleton, useDebounce } from '../components/ui';
import { KpiTile, type KpiSplit } from '../components/KpiTile';
import { DrillDrawer, FEE_COLS, NEW_LEAD_COLS, NEW_LEAD_SORTS, type Drill, type DrillMetric } from '../components/DrillDrawer';

interface DimRow { key: string; touches: number; leads: number; converted: number; converted_first: number; conv_rate?: number | null }
interface OverviewResponse {
  period: { from: string; to: string }; payment_period: { from: string; to: string } | null; basis: 'created' | 'touch';
  kpis: {
    touches: number; leads: number; leads_touched: number; converted: number; converted_first: number; sf_converted: number; stage_conv_total: number; stage_conv_unpaid: number; paid_other_stage: number; touches_of_converted: number; revenue: number;
    conv_rate: number | null; conv_rate_first: number | null; conv_rate_before: number | null; converted_before: number; window_from: string;
    converted_untouched: number; converted_before_untouched: number; class_on: 'lead' | 'bought';
    conv_ay: Record<'after' | 'before', { key: string; leads: number }[]>;
    touches_per_lead: number | null;
    avg_touches_alltime: number | null; avg_touches_alltime_per_lead: number | null; avg_touches_alltime_n: number;
    avg_touches_window: number | null; avg_touches_window_per_lead: number | null; avg_touches_window_n: number; avg_touches_window_touches: number; avg_touches_alltime_touches: number;
    stale_new: number; stale_new_untouched: number; new_total: number; stale_days: number;
    stale_nc: number; stale_nc_untouched: number; nc_total: number;
    stage_react: number; stage_react_total: number; stage_react_by: { stage: string; total: number; reactivated: number }[];
    new_leads: number; new_leads_touched: number;
    yet_new: number; yet_new_already: number; yet_new_revised: number; yet_new_converted: number; yet_new_by: { stage: string; leads: number; revised: number }[];
    proposed_fee: number; fee_received: number; fee_payers: number; fee_payments: number; fee_enrollments: number; fee_enrollments_unknown: number; fee_window: { from: string; to: string };
  };
  stages: { key: string; leads: number; converted: number }[];
  tat: Record<'created' | 'touch' | 'activity', { leads: number; avg_days: number | null; median_days: number | null; buckets: { key: string; leads: number }[] }>;
  ic_status: { key: string; leads: number; ics: number }[];
  ic_course: DimRow[];
  touch_point: DimRow[]; lead_source: DimRow[]; last_touch: DimRow[]; class_raw: DimRow[]; reason: DimRow[]; lm_reason: DimRow[]; medium: DimRow[]; campaign: DimRow[]; staff: DimRow[];
  daily: { d: string; touches: number; leads: number; converted: number }[];
  definitions: Record<string, string>;
}

// tables show unique leads only (no touches); Conv % = Converted ÷ Total leads; Converted - First Purchase Ever = the Total converted rule (user, 2026-11-27)
type Measure = 'leads' | 'converted';
const MEASURE_LABEL: Record<Measure, string> = { leads: 'Total leads', converted: 'Converted' };

const ALL_COLS: Col<DimRow>[] = [
  // long values (course and campaign names) wrap onto a second line instead of being cut (2026-11-27)
  { key: 'key', header: '', render: (v) => <span className="block min-w-[9rem] max-w-[16rem] whitespace-normal leading-snug [overflow-wrap:anywhere]">{String(v ?? '')}</span> }, { key: 'leads', header: 'Total leads', bar: true },
  { key: 'converted', header: 'Converted' }, { key: 'conv_rate', header: 'Conv %', render: (v) => fmtPct(v as number) },
  { key: 'converted_first', header: 'Converted - First Purchase Ever' },
];

/** Colourful KPI tile: tinted card, solid icon disc, big number */
function Kpi(p: { title: string; value: string; sub?: string; def?: string; tone: string; icon: ReactNode; small?: boolean; onClick?: () => void; split?: KpiSplit[]; className?: string }) { return <KpiTile {...p} />; }

type DimCardOpts = { asTable?: boolean; height?: number; limit?: number; help?: string; subtitle?: string; colorful?: boolean; className?: string };

/** One dimension card (bars or table) with a search box; rows can be applied as a page filter one by one or all matches at once. */
function DimCard({ title, rows, dim, measures, tone, opts, loading, error, onRetry, def, selected, toggleValue, setList }: {
  title: string; rows: DimRow[] | undefined; dim: ListDim; measures: [Measure, Measure?]; tone: string; opts: DimCardOpts; loading: boolean; error: unknown; onRetry: () => void;
  def: Record<string, string>; selected: string[]; toggleValue: (dim: ListDim, v: string) => void; setList: (dim: ListDim, v: string[]) => void;
}) {
  const [search, setSearch] = useState('');
  const s = search.trim().toLowerCase();
  // a card whose dim is filtered shows only the picked values (2026-11-26)
  const all = (rows ?? []).filter((r) => !selected.length || selected.includes(r.key))
    .map((r) => ({ ...r, conv_rate: r.leads ? (r.converted / r.leads) * 100 : null }));
  const filtered = s ? all.filter((r) => r.key.toLowerCase().includes(s)) : all;
  const data = filtered.slice(0, opts.limit ?? 12);
  const [m1, m2] = measures;
  const cols = ALL_COLS;
  return (
    <ChartCard title={title} tone={tone} subtitle={opts.subtitle ?? (rows ? `${fmtInt(filtered.reduce((x, r) => x + r[m1], 0))} ${MEASURE_LABEL[m1].toLowerCase()}${s ? ` in ${filtered.length} matching rows` : ''}${selected.length ? ` · ${selected.length} selected` : ''} · click rows to filter the other cards (multi-select)` : undefined)}
      loading={loading} error={error} onRetry={onRetry} rows={filtered} columns={ALL_COLS} height={opts.asTable ? opts.height ?? 250 : Math.max(opts.height ?? 250, data.length * 24 + 16)} className={opts.className}
      actions={<CardSearch value={search} onChange={setSearch} count={filtered.length} onApply={() => setList(dim, filtered.map((r) => r.key))} />}
      help={opts.help ?? `Leads by ${title.toLowerCase()}. ${def.dim_converted ?? ''}`}>
      {opts.asTable
        ? <DataTable rows={filtered} compact maxHeight="100%" initialSort={{ id: m1, desc: true }} onRowClick={(r) => { if (r.key !== '(no touch)') toggleValue(dim, r.key); }} columns={cols} highlight={(r) => selected.includes(r.key)} />
        : <HBars colorful={opts.colorful} data={data.map((r) => ({ key: r.key, value: r[m1], secondary: m2 ? r[m2] : null, selected: selected.includes(r.key), extra: { 'Conv %': fmtPct(r.conv_rate), 'Converted - First Purchase Ever': fmtInt(r.converted_first) } }))}
            valueLabel={MEASURE_LABEL[m1]} secondaryLabel={m2 ? MEASURE_LABEL[m2] : undefined} secondaryFormat={fmtInt} onClick={(key) => { if (key !== '(no touch)') toggleValue(dim, key); }} />}
    </ChartCard>
  );
}

/** Mirrors the Tableau "Lead Touch - Overview" dashboard: touch-date window, touch grain. */
export default function Overview() {
  const { f, params, toggleValue, setList, set } = useFilters();
  // Yet to connect: only leads whose touch is at least this many days old (2026-11-27; 0 = all; remembered per browser)
  const [yetDays, setYetDays] = useState<number>(() => { try { const v = Number.parseInt(localStorage.getItem('lt-yet-days') ?? '', 10); return v >= 0 && v <= 365 ? v : 5; } catch { return 5; } });
  const changeYet = (v: number) => { const n = Math.max(0, Math.min(365, Math.round(v) || 0)); setYetDays(n); try { localStorage.setItem('lt-yet-days', String(n)); } catch { /* ignore */ } };
  const yetQ = useDebounce(yetDays, 500);
  // Two halves (2026-11-26): the first screen (tiles, Yet to connect, the funnels) loads at once; the cards further down load when the
  // page is scrolled near them (400 px ahead), so the first screen does not wait behind statements nobody is looking at yet.
  const q = useApi<OverviewResponse>('/overview', { ...params, part: 'top', yet_days: yetQ });
  const restRef = useRef<HTMLDivElement>(null);
  const [restNear, setRestNear] = useState(false);
  useEffect(() => {
    const el = restRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') { setRestNear(true); return; }
    // near = the marker is within 400 px of the screen OR already above it (scrolled past, or jumped to the bottom); once near it stays on
    const io = new IntersectionObserver(([e]) => { if (e && (e.isIntersecting || e.boundingClientRect.top < 0)) setRestNear(true); }, { rootMargin: '400px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  // the lower half starts only once the top half has its answer (2026-11-26): the two at once doubled the database connections of one
  // visit, and the session pooler (15 clients) then refused requests ("internal error")
  const topDone = q.isSuccess && !q.isFetching;
  const r = useApi<OverviewResponse>('/overview', { ...params, part: 'rest' }, { enabled: restNear && topDone });
  const d = q.data?.data;
  const rd = r.data?.data;
  const k = d?.kpis;
  const rk = rd?.kpis;
  const def = { ...(rd?.definitions ?? {}), ...(d?.definitions ?? {}) };
  // lower-half cards: a placeholder until their half has an answer (also while it waits to be scrolled to)
  const restLoading = r.isPending;
  const [drill, setDrill] = useState<Drill | null>(null);
  const [tat, setTat] = useState<'created' | 'touch' | 'activity'>('created');
  const tatIsCall = tat === 'activity';
  const tatData = rd?.tat?.[tat];
  const open = (metric: DrillMetric, title: string, dim?: string, value?: string, subtitle?: string) => setDrill({ metric, title, dim, value, subtitle, summary: !dim, ...(metric === 'revised_new' ? { extra: { yet_days: yetQ } } : {}) });
  // academic-year split under a conversion KPI: the three latest years, the rest folded into "other" (sorted by year, latest first)
  // click = the lead list of that KPI restricted to the academic year ('other' = every year not shown)
  const aySplit = (rows: { key: string; leads: number }[], metric: DrillMetric, title: string) => {
    const isYear = (k: string) => /^\d{4}-\d{2}$/.test(k);
    const known = rows.filter((r) => isYear(r.key)).sort((a, b) => b.key.localeCompare(a.key));
    const top = known.slice(0, 3);
    const rest = known.slice(3).reduce((a, r) => a + r.leads, 0) + rows.filter((r) => !isYear(r.key)).reduce((a, r) => a + r.leads, 0);
    const out = top.map((r) => ({ label: r.key, value: fmtInt(r.leads), title: `latest paid course with an academic year is in ${r.key} · click for the leads`,
      onClick: () => open(metric, title, 'academic_year', r.key, `latest paid course with an academic year is in ${r.key}`) }));
    if (rest) out.push({ label: 'other', value: fmtInt(rest), title: 'latest paid course with an academic year is in an earlier year, or no payment of the lead has an academic year (Ujra bookings, old payments without a batch) · click for the leads',
      onClick: () => open(metric, title, 'academic_year', 'other:' + top.map((r) => r.key).join(','), 'latest paid course with an academic year is in an earlier year, or no payment has one') });
    return out;
  };
  const openFee = (title: string) => setDrill({ metric: 'fee_paid', title, columns: FEE_COLS, summary: true,
    subtitle: `leads of the selection whose app account paid ${k?.fee_window.from ?? f.from} → ${k?.fee_window.to ?? f.to} · fee received and proposed fee per lead` });
  // the never-touched part of Total converted / Converted before the window: created in the window, no touch on record, first valid payment
  // on/after the creation day (after) or before the window start (before); listed from the lead table like New leads
  // Yet to connect (2026-11-27): leads of Total leads nobody has contacted since they came into the window; stage = one bar of the card
  // the card's three groups (user, 2026-11-27): New, Converted, Revised to New = every other stage
  const yetGroups = (by: { stage: string; leads: number; revised: number }[]) => {
    const g = (keep: (st: string) => boolean) => by.filter((r) => keep(r.stage)).reduce((a, r) => ({ yet: a.yet + r.revised, leads: a.leads + r.leads }), { yet: 0, leads: 0 });
    return [
      { key: 'New', stage: 'New', ...g((st) => st === 'New') },
      { key: 'Converted', stage: 'Converted', ...g((st) => st === 'Converted') },
      { key: 'Revised to New', stage: '(revised)', ...g((st) => st !== 'New' && st !== 'Converted') },
    ];
  };
  const openYet = (stage?: string) => setDrill({
    metric: 'new_leads', title: stage ? `Yet to Connect · ${stage === '(revised)' ? 'Revised to New' : stage}` : 'Yet to Connect',
    subtitle: `${stage ? (stage === '(revised)' ? 'every stage other than New and Converted · ' : `stage ${stage} · `) : ''}no call, stage or course status change since the lead came into the window${yetQ ? ` (${yetQ}+ days ago)` : ''}`,
    extra: f.basis === 'created' ? undefined : { scope: 'union' },
    path: '/overview/new_leads', csvPath: '/overview/new_leads.csv', summaryPath: '/overview/new_leads/summary', columns: NEW_LEAD_COLS, sortOptions: NEW_LEAD_SORTS, defaultSort: 'created_date',
    dim: 'yet_connect', value: stage ? `${yetQ}|${stage}` : String(yetQ), summary: !stage,
  });
  const openUntouched = (kind: 'after' | 'before') => setDrill({
    metric: 'new_leads', title: kind === 'after' ? 'Total converted · no touch' : 'Converted before the window · no touch',
    subtitle: kind === 'after'
      ? `leads created ${f.from} → ${f.to} with no touch on record whose first valid payment is on/after the day they were created (and not before ${k?.window_from ?? f.from})`
      : `leads created ${f.from} → ${f.to} with no touch on record whose first valid payment is before ${k?.window_from ?? f.from}`,
    path: '/overview/new_leads', csvPath: '/overview/new_leads.csv', summaryPath: '/overview/new_leads/summary', columns: NEW_LEAD_COLS, sortOptions: NEW_LEAD_SORTS, defaultSort: 'created_date',
    dim: 'conv_untouched', value: kind, summary: true,
  });
  // New leads live on the lead table (not the touch table): own list / CSV / summary endpoints
  const openNew = (touched?: 'Touched' | 'No touch yet', title = 'New leads', union = false) => setDrill({
    metric: 'new_leads', title, subtitle: union ? `leads created ${f.from} → ${f.to} (touched or not) plus older leads touched in those dates` : `Salesforce leads created ${f.from} → ${f.to}, touched or not`,
    extra: union ? { scope: 'union' } : undefined,
    path: '/overview/new_leads', csvPath: '/overview/new_leads.csv', summaryPath: '/overview/new_leads/summary', columns: NEW_LEAD_COLS, sortOptions: NEW_LEAD_SORTS, defaultSort: 'created_date',
    dim: touched ? 'touched' : undefined, value: touched, summary: !touched,
  });

  const dimCard = (title: string, rows: DimRow[] | undefined, dim: ListDim, measures: [Measure, Measure?], tone: string, opts: DimCardOpts = {}) => (
    <DimCard key={title} title={title} rows={rows} dim={dim} measures={measures} tone={tone} opts={opts} loading={restLoading} error={r.error} onRetry={r.refetch}
      def={def} selected={f.lists[dim] ?? []} toggleValue={toggleValue} setList={setList} />
  );

  return (
    <div className="space-y-4">
      <PageHeader title="Overview" subtitle={`${f.basis === 'created' ? 'lead created' : 'touch date'} ${f.from} → ${f.to}${f.pay ? ` · payment date ${f.pfrom} → ${f.pto}` : ''} · touch-level view of every lead touched in the range`} />
      {q.error && <Note>⚠ {q.error.message}</Note>}

      {/* 12 equal tiles -> two rows of 6 on wide screens */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 xl:grid-cols-6">
        {q.isLoading && Array.from({ length: 12 }).map((_, i) => <Skeleton key={i} className="h-[92px]" />)}
        {k && <>
          <Kpi tone="tone-green" icon={<Icon.Plus />} title="New leads" value={fmtInt(k.new_leads)} sub={`created ${f.from} → ${f.to} · touched or not`} def={def.new_leads} onClick={() => openNew()}
            split={[
              { label: 'with a touch', value: fmtInt(k.new_leads_touched), title: 'at least one lead touch on record (any date) · click for the list', onClick: () => openNew('Touched') },
              { label: 'no touch yet', value: fmtInt(k.new_leads - k.new_leads_touched), title: 'no lead touch on record · click for the list', onClick: () => openNew('No touch yet') },
            ]} />
          <Kpi tone="tone-brand" icon={<Icon.Users />} title="Total leads" value={fmtInt(k.leads)}
            sub={f.basis === 'created' ? `created ${f.from} → ${f.to} · ${fmtInt(k.new_leads_touched)} touched · ${fmtInt(Math.max(0, k.new_leads - k.new_leads_touched))} not touched yet` : `${fmtInt(k.new_leads)} created in the window + ${fmtInt(Math.max(0, k.leads - k.new_leads))} older leads touched in it`}
            def={`${def.leads_basis ?? ''} ${def.leads ?? ''}`} onClick={() => openNew(undefined, 'Total leads', f.basis !== 'created')} />
          <Kpi tone="tone-teal" icon={<Icon.Touch />} title="Total lead touches" value={fmtInt(k.touches)} sub={`${fmt2(k.touches_per_lead)} touches per lead = ${fmtInt(k.touches)} touches ÷ ${fmtInt(k.leads_touched)} touched leads`} def={def.touches} onClick={() => open('touches', 'Total lead touches')} />
          <Kpi tone="tone-orange" icon={<Icon.Check />} title="Total converted" value={fmtInt(k.converted_first)} sub={f.pay ? `${fmtPct(k.conv_rate_first)} of leads · paid ${f.pfrom} → ${f.pto}` : `${fmtPct(k.conv_rate_first)} of leads · paid after a touch`} def={`${def.converted_first} ${def.conv_ay}`} onClick={() => open('converted_first', 'Total converted', undefined, undefined, 'touched leads of the selection with a first valid payment on/after a touch · the never-touched converted leads are under the "no touch" split')}
            split={[...aySplit(k.conv_ay.after, 'converted_first', 'Total converted'), { label: 'no touch', value: fmtInt(k.converted_untouched), title: 'leads of the selection never touched, first valid payment on/after the day they were created · click for the leads', onClick: () => openUntouched('after') }]} />
          <Kpi tone="tone-slate" icon={<Icon.Check />} title="Converted before last touch" value={fmtInt(k.converted_before)}
            sub={k.class_on === 'bought' ? `${fmtPct(k.conv_rate_before)} of leads · paid for the class before their last touch` : `${fmtPct(k.conv_rate_before)} of leads · paid before their last touch`}
            def={`${def.converted_before} ${k.class_on === 'bought' ? def.class_on ?? '' : ''} ${def.conv_ay}`} onClick={() => open('converted_before', 'Converted before last touch', undefined, undefined, 'leads whose first valid payment came before their last touch in the selection')}
            split={aySplit(k.conv_ay.before, 'converted_before', 'Converted before last touch')} />
          <Kpi tone="tone-violet" icon={<Icon.Avg />} title="Avg touches before conversion" value={fmt2(k.avg_touches_alltime)} sub={`${fmtInt(k.avg_touches_alltime_touches)} touches before paying ÷ ${fmtInt(k.avg_touches_alltime_n)} converted leads · any date`} def={`${def.avg_touches_alltime} ${def.avg_per_lead}`} onClick={() => open('avg_alltime', 'Avg touches before conversion', undefined, undefined, 'leads in Total converted, with their touches on or before the payment (any date)')} />
          <Kpi tone="tone-green" icon={<Icon.Calendar />} title="Avg touches before conversion (date-wise)" value={fmt2(k.avg_touches_window)} sub={`${fmtInt(k.avg_touches_window_touches)} touches before paying, in the dates ÷ ${fmtInt(k.avg_touches_window_n)} converted leads`} def={`${def.avg_touches_window} ${def.avg_per_lead}`} onClick={() => open('avg_window', 'Avg touches before conversion (date-wise)', undefined, undefined, 'leads in Total converted, with their touches on or before the payment dated in the range')} />
          <Kpi tone="tone-slate" icon={<Icon.Spark />} title="Stage Converted · not paid" value={fmtInt(k.stage_conv_unpaid)} sub={`of ${fmtInt(k.stage_conv_total)} leads in stage Converted`} def={def.stage_conv_unpaid} onClick={() => open('stage_conv_unpaid', 'Stage Converted · not paid')} />
          <Kpi tone="tone-teal" icon={<Icon.Check />} title="Paid · stage not Converted" value={fmtInt(k.paid_other_stage)} sub="counted in Total converted, but the Salesforce stage was never moved to Converted" def={def.paid_other_stage} onClick={() => open('paid_other_stage', 'Paid · stage not Converted')} />
          <Kpi tone="tone-violet" icon={<Icon.Touch />} title="Lost leads with new activity" value={fmtInt(k.stage_react)} sub={`of ${fmtInt(k.stage_react_total)} lost leads · touched again`} def={def.stage_react}
            onClick={() => open('stage_react', 'Lost leads with new activity')} />
          <Kpi tone="tone-red" icon={<Icon.Spark />} title="Proposed fee" value={fmtINR(k.proposed_fee)} def={def.proposed_fee} onClick={() => openFee('Proposed fee')}
            sub={`fee − discount of ${fmtInt(k.fee_enrollments)} enrollments paid ${k.fee_window.from} → ${k.fee_window.to}${k.fee_enrollments_unknown ? ` · ${fmtInt(k.fee_enrollments_unknown)} without a fee on record` : ''}`} />
          <Kpi tone="tone-amber" icon={<Icon.Check />} title="Fee received" value={fmtINR(k.fee_received)} def={def.fee_received} onClick={() => openFee('Fee received')}
            sub={`${fmtInt(k.fee_payments)} payments by ${fmtInt(k.fee_payers)} users · ${k.fee_window.from} → ${k.fee_window.to}${k.proposed_fee ? ` · ${fmtPct((k.fee_received / k.proposed_fee) * 100)} of the proposed fee` : ''}`} />
        </>}
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard title="Yet to connect" tone="tone-violet" subtitle={`leads of Total leads not contacted since ${f.basis === 'created' ? 'they were created' : 'they were created or last touched'}${yetDays ? ` · ${yetDays}+ days ago` : ''}`}
          loading={q.isLoading} error={q.error} rows={k?.yet_new_by ?? []} height={240} help={def.yet_new}
          actions={<div className="flex items-center gap-1 text-[11px] text-ink-2">
            <span>Days</span>
            {[0, 3, 5, 7, 10].map((n) => <button key={n} title={n ? `came into the window ${n} or more days ago` : 'every lead, whatever the day'} className={`rounded border px-1.5 py-0.5 ${yetDays === n ? 'border-accent bg-accent/10 font-semibold text-accent' : 'border-line hover:bg-surface-2'}`} onClick={() => changeYet(n)}>{n || 'All'}</button>)}
            <input type="number" min={0} max={365} className="input !w-16 !py-0.5" title="any number of days" value={yetDays} onChange={(e) => changeYet(Number(e.target.value))} />
          </div>}>
          {k && (
            <div className="flex h-full flex-col">
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <button className="text-3xl font-extrabold tracking-tight hover:text-accent" title="click for the leads" onClick={() => openYet()}>{fmtInt(k.yet_new)}</button>
                {yetGroups(k.yet_new_by).map((g) => (
                  <button key={g.key} className="rounded px-1 text-xs text-ink-3 hover:bg-tone hover:text-ink" title={`${fmtInt(g.leads)} leads in ${g.key === 'Revised to New' ? 'other stages' : `stage ${g.key}`} · click for the leads`} onClick={() => openYet(g.stage)}>
                    {g.key} <b className="text-ink">{fmtInt(g.yet)}</b></button>
                ))}
              </div>
              <div className="mt-2 min-h-0 flex-1">
                <HBars colorful data={yetGroups(k.yet_new_by).map((g) => ({ key: g.key, value: g.yet, secondary: g.leads }))} valueLabel="Yet to connect" secondaryLabel="Leads in the stage" secondaryFormat={fmtInt}
                  onClick={(key) => openYet(yetGroups(k.yet_new_by).find((g) => g.key === key)?.stage)} />
              </div>
            </div>
          )}
        </ChartCard>
        <ChartCard title="Lead funnel · LM stage" tone="tone-brand" subtitle="Total leads by current Lead Stage · click a slice to filter" loading={q.isLoading} error={q.error} rows={d?.stages ?? []} height={240}
          help="Current Lead Stage of every lead in Total leads.">
          <Donut data={(d?.stages ?? []).map((s) => ({ key: s.key, value: s.leads, secondary: s.converted, selected: (f.lists.lead_stage ?? []).includes(s.key) }))} valueLabel="Total leads" secondaryLabel="Converted" centerLabel="leads" onClick={(key) => toggleValue('lead_stage', key)} />
        </ChartCard>
      </div>

      <div ref={restRef} />
      {r.error && <Note>⚠ {r.error.message}</Note>}
      <div className="grid gap-4 xl:grid-cols-2">
        {/* IC status opens the card grid (2026-11-27): it moved down from the top row */}
        <ChartCard title="Lead funnel · IC status" tone="tone-pink" subtitle="Total leads by Interested Course status · click a bar to filter (IC status)" loading={q.isLoading} error={q.error} rows={d?.ic_status ?? []} height={240}
          help="Interested Course status of the leads in Total leads. A lead with several courses appears under each.">
          <HBars colorful data={(d?.ic_status ?? []).map((s) => ({ key: s.key, value: s.leads, secondary: s.ics }))} valueLabel="Total leads" secondaryLabel="Interested courses" secondaryFormat={fmtInt} onClick={(key) => toggleValue('ic_status', key)} />
        </ChartCard>
        {dimCard('Touch point analysis', rd?.touch_point, 'touch_point', ['leads', 'converted'], 'tone-teal', { colorful: true, height: 270 })}
        {dimCard('Lead source distribution', rd?.lead_source, 'lead_source', ['leads', 'converted'], 'tone-orange', { asTable: true, height: 270, subtitle: 'Total leads by the Lead Source on the lead record · each lead once · click rows to filter the other cards', help: def.lead_source })}
        {dimCard('Last touch distribution', rd?.last_touch, 'touch_point', ['leads', 'converted'], 'tone-brand', { asTable: true, height: 270, subtitle: 'Total leads by the touch point of their LAST touch · an app touch less than 2 hours before the payment is passed over · click rows to filter by touch point', help: def.last_touch })}
        {dimCard('Class (Lead Master)', rd?.class_raw, 'class_raw', ['leads', 'converted'], 'tone-violet', { limit: 14, height: 300, colorful: true, help: 'The Class on the lead record, not the course bought. Purchased classes are on the Converted page.' })}
        {dimCard('LM Reason', rd?.lm_reason, 'lm_reason', ['leads', 'converted'], 'tone-amber', { limit: 14, height: 300, help: def.lm_reason, subtitle: 'Total leads by the LM Reason field on the lead · click a row to filter every card' })}
        {dimCard('Interested course', rd?.ic_course, 'ic_course', ['leads', 'converted'], 'tone-pink', { asTable: true, height: 300, help: def.ic_course, subtitle: 'Total leads by the course on their Interested Course records (interest, not purchase) · a lead with several courses appears under each · click rows to filter every page (multi-select)' })}
        {dimCard('Last call reason', rd?.reason, 'call_reason', ['leads', 'converted'], 'tone-amber', { limit: 14, height: 300, help: def.reason, subtitle: 'Total leads by the reason recorded on their last call · click a row to filter every card' })}
        {dimCard('Medium', rd?.medium, 'medium', ['leads', 'converted'], 'tone-green', { asTable: true, height: 260, subtitle: 'Total leads by the medium of their FIRST touch in the selection · each lead once', help: 'Each lead once, under the medium of its first touch. Touches = every touch with that medium.' })}
        {dimCard('Campaign name', rd?.campaign, 'campaign', ['leads', 'converted'], 'tone-brand', { asTable: true, height: 260, subtitle: 'Total leads by the campaign of their FIRST touch in the selection · each lead once', help: 'Each lead once, under the campaign of its first touch. Touches = every touch of that campaign.' })}
        {dimCard('Staff-wise', rd?.staff, 'staff', ['leads', 'converted'], 'tone-pink', { asTable: true, height: 300, subtitle: 'Total leads by the staff of their FIRST touch in the selection · each lead once', help: 'Each lead once, under the staff on its first touch. Touches = every touch by that staff.' })}
        <ChartCard title="Turnaround time" tone="tone-green" help={def.tat} loading={restLoading} error={r.error} rows={tatData?.buckets ?? []} height={240}
          subtitle={tatData ? `${fmtInt(tatData.leads)} ${tatIsCall ? 'leads' : 'converted leads'} · median ${tatData.median_days == null ? '–' : fmt1(tatData.median_days)} d · average ${tatData.avg_days == null ? '–' : fmt1(tatData.avg_days)} d${tatIsCall ? ' (leads with an activity)' : ''} · click a band for the leads` : tatIsCall ? 'days from the first touch in the range to the first activity on or after it' : 'days to the first payment, converted leads only'}
          actions={<Segmented size="xs" value={tat} onChange={setTat} options={[
            { value: 'created', label: 'Lead created → paid', title: 'days from the lead\'s creation day to its first valid payment day' },
            { value: 'touch', label: 'Last touch → paid', title: 'days from the latest touch on or before the payment to the payment day' },
            { value: 'activity', label: 'Last touch → first activity', title: 'every lead of the selection: days from its latest touch in the range to the first activity (Task on the Lead Master or one of its Interested Courses) on or after that touch, any later date' },
          ]} />}>
          <HBars data={(tatData?.buckets ?? []).map((b) => ({ key: b.key, value: b.leads, secondary: tatData?.leads ? (b.leads / tatData.leads) * 100 : null }))} valueLabel={tatIsCall ? 'Leads' : 'Converted leads'} secondaryLabel="share"
            onClick={(key) => tatIsCall
              ? open('leads', `Turnaround · ${key}`, 'tat_activity', key, key === 'no activity' ? 'leads of the selection with no activity (Task) on or after their last touch' : `leads whose first activity (Task on the lead or its interested courses) after their last touch came ${key} later`)
              : open('converted', `Turnaround · ${key}`, tat === 'created' ? 'tat_created' : 'tat_touch', key, tat === 'created' ? `converted leads whose first payment came ${key} after the lead was created` : `converted leads whose first payment came ${key} after their last touch`)} />
        </ChartCard>
      </div>

      {/* Touches per day takes the whole row (2026-11-26) */}
      <div>
        <ChartCard title="Touches per day" tone="tone-teal" subtitle="touches, distinct leads and converted leads by touch date · click a point to zoom the date range to that day" loading={restLoading} error={r.error} rows={rd?.daily ?? []} height={260}>
          <DailyLines data={(rd?.daily ?? []).map((r) => ({ d: r.d.slice(5), touches: r.touches, leads: r.leads, converted: r.converted }))} xKey="d" lines={[{ key: 'touches', label: 'Touches' }, { key: 'leads', label: 'Leads' }, { key: 'converted', label: 'Converted' }]} onClick={(key) => { const row = (rd?.daily ?? []).find((r) => r.d.slice(5) === key); if (row) set({ preset: 'custom', from: row.d, to: row.d }); }} />
        </ChartCard>
      </div>

      {drill && <DrillDrawer drill={drill} onClose={() => setDrill(null)} />}
      <Note>The main date range applies to the <b>lead created</b> date or the <b>touch date</b>, whichever is selected in the filter bar. Switch on <b>Payment date</b> to add a second window: Converted then counts only valid payments dated inside it. Filters on top apply to every card. Click a KPI tile to list the leads behind it (with CSV download). Clicking a bar, slice or table row filters every card by that value; a filtered card then shows only the picked values. Add more values from the filter bar; remove the chip on top or clear the box to undo. Every card also has a chart/table toggle. Hover the help icon on a card or KPI for the exact definition.</Note>
    </div>
  );
}
