import { useState, type ReactNode } from 'react';
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
    conv_ay: Record<'after' | 'before', { key: string; leads: number }[]>;
    touches_per_lead: number | null;
    avg_touches_alltime: number | null; avg_touches_alltime_per_lead: number | null; avg_touches_alltime_n: number;
    avg_touches_window: number | null; avg_touches_window_per_lead: number | null; avg_touches_window_n: number;
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
  touch_point: DimRow[]; source: DimRow[]; class_raw: DimRow[]; reason: DimRow[]; lm_reason: DimRow[]; medium: DimRow[]; campaign: DimRow[]; staff: DimRow[];
  daily: { d: string; touches: number; leads: number; converted: number }[];
  definitions: Record<string, string>;
}

type Measure = 'touches' | 'leads' | 'converted';
const MEASURE_LABEL: Record<Measure, string> = { touches: 'Total lead touches', leads: 'Total leads', converted: 'Converted' };

const ALL_COLS: Col<DimRow>[] = [
  { key: 'key', header: '' }, { key: 'leads', header: 'Total leads' }, { key: 'touches', header: 'Total lead touches', bar: true },
  { key: 'converted', header: 'Converted' }, { key: 'conv_rate', header: 'Conv %', render: (v) => fmtPct(v as number) },
  { key: 'converted_first', header: 'Converted (first payment)' },
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
  const all = rows ?? [];
  const filtered = s ? all.filter((r) => r.key.toLowerCase().includes(s)) : all;
  const data = filtered.slice(0, opts.limit ?? 12);
  const [m1, m2] = measures;
  const cols = ALL_COLS.filter((c) => c.key === 'key' || measures.includes(c.key as Measure) || c.key === 'conv_rate');
  return (
    <ChartCard title={title} tone={tone} subtitle={opts.subtitle ?? (rows ? `${fmtInt(filtered.reduce((x, r) => x + r[m1], 0))} ${MEASURE_LABEL[m1].toLowerCase()}${s ? ` in ${filtered.length} matching rows` : ''}${selected.length ? ` · ${selected.length} selected` : ''} · click rows to filter the other cards (multi-select)` : undefined)}
      loading={loading} error={error} onRetry={onRetry} rows={filtered} columns={ALL_COLS} height={opts.height ?? 250} className={opts.className}
      actions={<CardSearch value={search} onChange={setSearch} count={filtered.length} onApply={() => setList(dim, filtered.map((r) => r.key))} />}
      help={opts.help ?? `${title}: touches in the window grouped by this value. ${def.dim_converted ?? ''}`}>
      {opts.asTable
        ? <DataTable rows={filtered} compact maxHeight="100%" initialSort={{ id: m1, desc: true }} onRowClick={(r) => toggleValue(dim, r.key)} columns={cols} highlight={(r) => selected.includes(r.key)} />
        : <HBars colorful={opts.colorful} data={data.map((r) => ({ key: r.key, value: r[m1], secondary: m2 ? r[m2] : null, selected: selected.includes(r.key), extra: { 'Total leads': fmtInt(r.leads), 'Conv %': fmtPct(r.conv_rate) } }))}
            valueLabel={MEASURE_LABEL[m1]} secondaryLabel={m2 ? MEASURE_LABEL[m2] : undefined} secondaryFormat={fmtInt} onClick={(key) => toggleValue(dim, key)} />}
    </ChartCard>
  );
}

/** Mirrors the Tableau "Lead Touch - Overview" dashboard: touch-date window, touch grain. */
export default function Overview() {
  const { f, params, toggleValue, setList, set } = useFilters();
  // days a lead may sit in New / Not Connected before it counts as waiting (remembered per browser)
  const [staleDays, setStaleDays] = useState<number>(() => { try { const v = Number.parseInt(localStorage.getItem('lt-stale-days') ?? '', 10); return v >= 1 && v <= 365 ? v : 5; } catch { return 5; } });
  const changeStale = (v: number) => { const n = Math.max(1, Math.min(365, Math.round(v) || 1)); setStaleDays(n); try { localStorage.setItem('lt-stale-days', String(n)); } catch { /* ignore */ } };
  const staleQ = useDebounce(staleDays, 500);
  const q = useApi<OverviewResponse>('/overview', { ...params, stale_days: staleQ });
  const d = q.data?.data;
  const k = d?.kpis;
  const def = d?.definitions ?? {};
  const [drill, setDrill] = useState<Drill | null>(null);
  const [tat, setTat] = useState<'created' | 'touch' | 'activity'>('created');
  const tatIsCall = tat === 'activity';
  const tatData = d?.tat?.[tat];
  const staleRows: { stage: string; metric: DrillMetric; total: number; stale: number; share: number | null; untouched: number }[] = k ? [
    { stage: 'New', metric: 'stale_new', total: k.new_total, stale: k.stale_new, share: k.new_total ? (k.stale_new / k.new_total) * 100 : null, untouched: k.stale_new_untouched },
    { stage: 'Not Connected', metric: 'stale_not_connected', total: k.nc_total, stale: k.stale_nc, share: k.nc_total ? (k.stale_nc / k.nc_total) * 100 : null, untouched: k.stale_nc_untouched },
  ] : [];
  const open = (metric: DrillMetric, title: string, dim?: string, value?: string, subtitle?: string) => setDrill({ metric, title, dim, value, subtitle, summary: !dim });
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
  // New leads live on the lead table (not the touch table): own list / CSV / summary endpoints
  const openNew = (touched?: 'Touched' | 'No touch yet', title = 'New leads', union = false) => setDrill({
    metric: 'new_leads', title, subtitle: union ? `leads created ${f.from} → ${f.to} (touched or not) plus older leads touched in those dates` : `Salesforce leads created ${f.from} → ${f.to}, touched or not`,
    extra: union ? { scope: 'union' } : undefined,
    path: '/overview/new_leads', csvPath: '/overview/new_leads.csv', summaryPath: '/overview/new_leads/summary', columns: NEW_LEAD_COLS, sortOptions: NEW_LEAD_SORTS, defaultSort: 'created_date',
    dim: touched ? 'touched' : undefined, value: touched, summary: !touched,
  });

  const dimCard = (title: string, rows: DimRow[] | undefined, dim: ListDim, measures: [Measure, Measure?], tone: string, opts: DimCardOpts = {}) => (
    <DimCard key={title} title={title} rows={rows} dim={dim} measures={measures} tone={tone} opts={opts} loading={q.isLoading} error={q.error} onRetry={q.refetch}
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
          <Kpi tone="tone-teal" icon={<Icon.Touch />} title="Total lead touches" value={fmtInt(k.touches)} sub={`${fmt2(k.touches_per_lead)} touches per lead`} def={def.touches} onClick={() => open('touches', 'Total lead touches')} />
          <Kpi tone="tone-orange" icon={<Icon.Check />} title="Total converted" value={fmtInt(k.converted_first)} sub={f.pay ? `${fmtPct(k.conv_rate_first)} of leads · first payment after a touch · paid ${f.pfrom} → ${f.pto}` : `${fmtPct(k.conv_rate_first)} of leads · first payment after a touch`} def={`${def.converted_first} ${def.conv_ay}`} onClick={() => open('converted_first', 'Total converted')}
            split={aySplit(k.conv_ay.after, 'converted_first', 'Total converted')} />
          <Kpi tone="tone-slate" icon={<Icon.Check />} title="Converted before the window" value={fmtInt(k.converted_before)} sub={`${fmtPct(k.conv_rate_before)} of leads · already customers · first payment before ${k.window_from}`} def={`${def.converted_before} ${def.conv_ay}`} onClick={() => open('converted_before', 'Converted before the window')}
            split={aySplit(k.conv_ay.before, 'converted_before', 'Converted before the window')} />
          <Kpi tone="tone-violet" icon={<Icon.Avg />} title="Avg touches before conversion" value={fmt2(k.avg_touches_alltime)} def={`${def.avg_touches_alltime} ${def.avg_per_lead}`} onClick={() => open('avg_alltime', 'Avg touches before conversion', undefined, undefined, 'converted leads with their all-time touch counts (no date filter)')} />
          <Kpi tone="tone-green" icon={<Icon.Calendar />} title="Avg touches before conversion (date-wise)" value={fmt2(k.avg_touches_window)} def={`${def.avg_touches_window} ${def.avg_per_lead}`} onClick={() => open('avg_window', 'Avg touches before conversion (date-wise)', undefined, undefined, 'converted leads touched in the window, with their all-time touch counts')} />
          <Kpi tone="tone-slate" icon={<Icon.Spark />} title="Stage Converted · not paid" value={fmtInt(k.stage_conv_unpaid)} sub={`of ${fmtInt(k.stage_conv_total)} leads in stage Converted · no payment on record`} def={def.stage_conv_unpaid} onClick={() => open('stage_conv_unpaid', 'Stage Converted · not paid')} />
          <Kpi tone="tone-teal" icon={<Icon.Check />} title="Paid · stage not Converted" value={fmtInt(k.paid_other_stage)} sub="counted in Total converted, but the Salesforce stage was never moved to Converted" def={def.paid_other_stage} onClick={() => open('paid_other_stage', 'Paid · stage not Converted')} />
          <Kpi tone="tone-violet" icon={<Icon.Touch />} title="Lost leads with new activity" value={fmtInt(k.stage_react)} sub={`of ${fmtInt(k.stage_react_total)} leads in Not Willing Now / Disqualified / Not Connected / P2 Completed · new touch after the stage was set`} def={def.stage_react}
            onClick={() => open('stage_react', 'Lost leads with new activity')} />
          <Kpi tone="tone-red" icon={<Icon.Spark />} title="Proposed fee" value={fmtINR(k.proposed_fee)} def={def.proposed_fee} onClick={() => openFee('Proposed fee')}
            sub={`fee − discount of ${fmtInt(k.fee_enrollments)} enrollments paid ${k.fee_window.from} → ${k.fee_window.to}${k.fee_enrollments_unknown ? ` · ${fmtInt(k.fee_enrollments_unknown)} without a fee on record` : ''}`} />
          <Kpi tone="tone-amber" icon={<Icon.Check />} title="Fee received" value={fmtINR(k.fee_received)} def={def.fee_received} onClick={() => openFee('Fee received')}
            sub={`${fmtInt(k.fee_payments)} payments by ${fmtInt(k.fee_payers)} users · ${k.fee_window.from} → ${k.fee_window.to}${k.proposed_fee ? ` · ${fmtPct((k.fee_received / k.proposed_fee) * 100)} of the proposed fee` : ''}`} />
        </>}
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <ChartCard title="Yet to connect (New)" tone="tone-violet" subtitle="leads with no call, stage change or IC status change on or after their touch in the selection: in New, parked in another stage, or already Converted and touched again · click a bar for the leads"
          loading={q.isLoading} error={q.error} rows={k?.yet_new_by ?? []} height={240} help={def.yet_new}>
          {k && (
            <div className="flex h-full flex-col">
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <button className="text-3xl font-extrabold tracking-tight hover:text-accent" title="click for the leads"
                  onClick={() => open('revised_new', 'Yet to connect (New)', undefined, undefined, 'leads with no call Task, Lead Stage change or IC status change on or after their first touch in the selection')}>{fmtInt(k.yet_new)}</button>
                <button className="rounded px-1 text-xs text-ink-3 hover:bg-tone hover:text-ink" title="Lead Stage is New, no call Task and no IC status change after the touch · click for the leads"
                  onClick={() => setDrill({ metric: 'revised_new', title: 'Yet to connect · already New', summary: true, extra: { scope: 'new' }, subtitle: 'leads in stage New with no call Task and no IC status change on or after their first touch in the selection' })}>already New <b className="text-ink">{fmtInt(k.yet_new_already)}</b></button>
                <button className="rounded px-1 text-xs text-ink-3 hover:bg-tone hover:text-ink" title="parked in another stage, touched again, no call, stage change or IC status change since · click for the leads"
                  onClick={() => setDrill({ metric: 'revised_new', title: 'Yet to connect · revised to New', summary: true, extra: { scope: 'revised' }, subtitle: 'leads in a stage other than New / Converted with no call Task, Lead Stage change or IC status change on or after their first touch in the selection' })}>revised to New <b className="text-ink">{fmtInt(k.yet_new_revised)}</b></button>
                <button className="rounded px-1 text-xs text-ink-3 hover:bg-tone hover:text-ink" title="Lead Stage is Converted, touched in the selection, no call logged since · click for the leads"
                  onClick={() => setDrill({ metric: 'revised_new', title: 'Yet to connect · Converted', summary: true, extra: { scope: 'converted' }, subtitle: 'leads in stage Converted with no call Task on or after their first touch in the selection' })}>Converted <b className="text-ink">{fmtInt(k.yet_new_converted)}</b></button>
              </div>
              <div className="mt-2 min-h-0 flex-1">
                <HBars colorful data={k.yet_new_by.filter((r) => r.revised > 0).map((r) => ({ key: r.stage, value: r.revised, secondary: r.leads }))} valueLabel="Yet to connect" secondaryLabel="Leads in the stage" secondaryFormat={fmtInt}
                  onClick={(key) => open('revised_new', `Yet to connect · ${key}`, 'lead_stage', key, key === 'New' ? 'leads in stage New with no call Task and no IC status change on or after their first touch in the selection' : key === 'Converted' ? 'leads in stage Converted with no call Task on or after their first touch in the selection' : `leads parked in ${key} with no call Task, Lead Stage change or IC status change on or after their first touch in the selection`)} />
              </div>
            </div>
          )}
        </ChartCard>
        <ChartCard title="Lead funnel · LM stage" tone="tone-brand" subtitle="Total leads by current Lead Stage · click a slice to filter" loading={q.isLoading} error={q.error} rows={d?.stages ?? []} height={240}
          help="Current Lead Stage of the distinct leads that have a touch in the window.">
          <Donut data={(d?.stages ?? []).map((s) => ({ key: s.key, value: s.leads, secondary: s.converted, selected: (f.lists.lead_stage ?? []).includes(s.key) }))} valueLabel="Total leads" secondaryLabel="Converted" centerLabel="leads" onClick={(key) => toggleValue('lead_stage', key)} />
        </ChartCard>
        <ChartCard title="Lead funnel · IC status" tone="tone-pink" subtitle="Total leads by Interested Course status · click a bar to filter (IC status)" loading={q.isLoading} error={q.error} rows={d?.ic_status ?? []} height={240}
          help="Interested Course status for the leads touched in the window, blank status excluded. A lead with several interested courses appears under each status.">
          <HBars colorful data={(d?.ic_status ?? []).map((s) => ({ key: s.key, value: s.leads, secondary: s.ics }))} valueLabel="Total leads" secondaryLabel="Interested courses" secondaryFormat={fmtInt} onClick={(key) => toggleValue('ic_status', key)} />
        </ChartCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {dimCard('Touch point analysis', d?.touch_point, 'touch_point', ['touches', 'converted'], 'tone-teal', { colorful: true, height: 270 })}
        {dimCard('Lead source distribution', d?.source, 'source', ['touches', 'converted'], 'tone-orange', { asTable: true, height: 270, help: 'Source recorded on the touch: total lead touches, converted leads and total leads per source.' })}
        {dimCard('Class (Lead Master)', d?.class_raw, 'class_raw', ['touches', 'converted'], 'tone-violet', { limit: 14, height: 300, colorful: true, help: 'The Class field on the Salesforce lead record (Lead Master), not the interested course and not the purchased course: lead touches in the window of converted leads, grouped by that class. Purchased course and grade are on the Converted page; interested courses have their own card and filter.' })}
        {dimCard('LM Reason', d?.lm_reason, 'lm_reason', ['leads'], 'tone-amber', { limit: 14, height: 300, help: def.lm_reason, subtitle: 'Total leads by the LM Reason field on the lead · click a row to filter every card' })}
        {dimCard('Interested course', d?.ic_course, 'ic_course', ['leads', 'converted'], 'tone-pink', { asTable: true, height: 300, help: def.ic_course, subtitle: 'Total leads by the course on their Interested Course records (interest, not purchase) · a lead with several courses appears under each · click rows to filter every page (multi-select)' })}
        {dimCard('Last call reason', d?.reason, 'call_reason', ['leads', 'converted'], 'tone-amber', { limit: 14, height: 300, help: def.reason, subtitle: 'Total leads by the reason recorded on their last call · click a row to filter every card' })}
        {dimCard('Medium', d?.medium, 'medium', ['leads', 'converted'], 'tone-green', { asTable: true, height: 260 })}
        {dimCard('Campaign name', d?.campaign, 'campaign', ['leads', 'touches'], 'tone-brand', { asTable: true, height: 260 })}
        {dimCard('Staff-wise', d?.staff, 'staff', ['leads', 'touches'], 'tone-pink', { asTable: true, height: 300 })}
        <ChartCard title="Leads still waiting in a stage" tone="tone-red" loading={q.isLoading} error={q.error} rows={staleRows} height={240}
          subtitle={`still in the stage, created more than ${k?.stale_days ?? staleDays} days ago and not touched in the last ${k?.stale_days ?? staleDays} days · click a row for the leads`}
          help={`${def.stale_new ?? ''} ${def.stale_nc ?? ''}`}
          actions={<div className="flex items-center gap-1 text-[11px] text-ink-2">
            <span>Days</span>
            {[3, 5, 7, 10, 15].map((n) => <button key={n} className={`rounded border px-1.5 py-0.5 ${staleDays === n ? 'border-accent bg-accent/10 font-semibold text-accent' : 'border-line hover:bg-surface-2'}`} onClick={() => changeStale(n)}>{n}</button>)}
            <input type="number" min={1} max={365} className="input !w-16 !py-0.5" title="any number of days" value={staleDays} onChange={(e) => changeStale(Number(e.target.value))} />
          </div>}>
          <DataTable rows={staleRows} compact maxHeight="100%" rowKey={(r) => r.stage}
            onRowClick={(r) => setDrill({ metric: r.metric, title: `Still ${r.stage} after ${k?.stale_days ?? staleDays} days`, extra: { stale_days: k?.stale_days ?? staleDays }, summary: true,
              subtitle: `leads still in stage ${r.stage}, created more than ${k?.stale_days ?? staleDays} days ago and not touched in the last ${k?.stale_days ?? staleDays} days · sorted by last touch` })}
            columns={[
              { key: 'stage', header: 'Stage' },
              { key: 'total', header: 'Leads in the stage', align: 'right' },
              { key: 'stale', header: `Still there after ${k?.stale_days ?? staleDays} days`, align: 'right', bar: true },
              { key: 'share', header: 'Share', align: 'right', render: (v) => fmtPct(v as number) },
              { key: 'untouched', header: 'Never touched after creation', align: 'right' },
            ]} />
        </ChartCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard title="Touches per day" tone="tone-teal" subtitle="touches, distinct leads and converted leads by touch date · click a point to zoom the date range to that day" loading={q.isLoading} error={q.error} rows={d?.daily ?? []} height={260}>
          <DailyLines data={(d?.daily ?? []).map((r) => ({ d: r.d.slice(5), touches: r.touches, leads: r.leads, converted: r.converted }))} xKey="d" lines={[{ key: 'touches', label: 'Touches' }, { key: 'leads', label: 'Leads' }, { key: 'converted', label: 'Converted' }]} onClick={(key) => { const row = (d?.daily ?? []).find((r) => r.d.slice(5) === key); if (row) set({ preset: 'custom', from: row.d, to: row.d }); }} />
        </ChartCard>
        <ChartCard title="Turnaround time" tone="tone-green" help={def.tat} loading={q.isLoading} error={q.error} rows={tatData?.buckets ?? []} height={240}
          subtitle={tatData ? `${fmtInt(tatData.leads)} ${tatIsCall ? 'leads' : 'converted leads'} · median ${tatData.median_days == null ? '–' : fmt1(tatData.median_days)} d · average ${tatData.avg_days == null ? '–' : fmt1(tatData.avg_days)} d${tatIsCall ? ' (leads with an activity)' : ''} · click a band for the leads` : tatIsCall ? 'days from the first touch in the range to the first activity on or after it' : 'days to the first payment, converted leads only'}
          actions={<Segmented size="xs" value={tat} onChange={setTat} options={[
            { value: 'created', label: 'Lead created → paid', title: 'days from the lead\'s creation day to its first valid payment day' },
            { value: 'touch', label: 'Last touch → paid', title: 'days from the latest touch on or before the payment to the payment day' },
            { value: 'activity', label: 'First touch → first activity', title: 'every lead of the selection: days from its earliest touch in the range to the first activity (Task on the Lead Master or one of its Interested Courses) on or after that touch, any later date' },
          ]} />}>
          <HBars data={(tatData?.buckets ?? []).map((b) => ({ key: b.key, value: b.leads, secondary: tatData?.leads ? (b.leads / tatData.leads) * 100 : null }))} valueLabel={tatIsCall ? 'Leads' : 'Converted leads'} secondaryLabel="share"
            onClick={(key) => tatIsCall
              ? open('leads', `Turnaround · ${key}`, 'tat_activity', key, key === 'no activity' ? 'leads of the selection with no activity (Task) on or after their first touch' : `leads whose first activity (Task on the lead or its interested courses) after their first touch came ${key} later`)
              : open('converted', `Turnaround · ${key}`, tat === 'created' ? 'tat_created' : 'tat_touch', key, tat === 'created' ? `converted leads whose first payment came ${key} after the lead was created` : `converted leads whose first payment came ${key} after their last touch`)} />
        </ChartCard>
      </div>

      {drill && <DrillDrawer drill={drill} onClose={() => setDrill(null)} />}
      <Note>The main date range applies to the <b>lead created</b> date or the <b>touch date</b>, whichever is selected in the filter bar. Switch on <b>Payment date</b> to add a second window: Converted then counts only valid payments dated inside it. Filters on top apply to every card. Click a KPI tile to list the leads behind it (with CSV download). Clicking a bar, slice or table row filters every other card by that value; click more rows to add them (a card never filters itself, so its rows stay visible and highlighted); remove the chip on top or click the row again to undo. Every card also has a chart/table toggle. Hover the help icon on a card or KPI for the exact definition.</Note>
    </div>
  );
}
