import { useState, type ReactNode } from 'react';
import { useApi } from '../lib/api';
import { useFilters, type ListDim } from '../lib/filters';
import { fmtInt, fmtPct } from '../lib/format';
import { ChartCard } from '../components/ChartCard';
import { DataTable, type Col } from '../components/DataTable';
import { DailyLines, HBars } from '../charts';
import { CardSearch, Icon, Note, PageHeader, Skeleton } from '../components/ui';
import { KpiTile } from '../components/KpiTile';
import { DrillDrawer, type Drill } from '../components/DrillDrawer';

interface AttrRow { key: string; touches: number; leads: number; converted: number; attributed: number; conv_pct: number | null; attr_pct: number | null; share_pct: number | null }
interface Resp {
  mode: 'first' | 'last'; period: { from: string; to: string };
  kpis: { touches: number; leads: number; converted: number; attributed: number; attributed_touches: number; conv_pct: number | null; attr_pct: number | null; attr_of_converted_pct: number | null };
  touch_point: AttrRow[]; class_raw: AttrRow[]; source: AttrRow[]; medium: AttrRow[]; campaign: AttrRow[];
  daily: { d: string; leads: number; attributed: number }[];
  definitions: Record<string, string>;
}

function Kpi(p: { title: string; value: string; sub?: string; def?: string; tone: string; icon: ReactNode; onClick?: () => void }) { return <KpiTile {...p} />; }

function AttrCard({ title, rows, dim, tone, opts, cols, label, mode, loading, error, onRetry, help, selected, toggleValue, setList }: {
  title: string; rows: AttrRow[] | undefined; dim: ListDim; tone: string; opts: { asTable?: boolean; height?: number; limit?: number }; cols: Col<AttrRow>[]; label: string; mode: 'first' | 'last';
  loading: boolean; error: unknown; onRetry: () => void; help: string; selected: string[]; toggleValue: (dim: ListDim, v: string) => void; setList: (dim: ListDim, v: string[]) => void;
}) {
  const [search, setSearch] = useState('');
  const s = search.trim().toLowerCase();
  const all = rows ?? [];
  const filtered = s ? all.filter((r) => r.key.toLowerCase().includes(s)) : all;
  const data = filtered.slice(0, opts.limit ?? 14);
  return (
    <ChartCard title={title} tone={tone} subtitle={rows ? `${fmtInt(filtered.reduce((x, r) => x + r.attributed, 0))} ${label.toLowerCase()}${s ? ` in ${filtered.length} matching rows` : ''} · click a row to filter every card` : undefined}
      loading={loading} error={error} onRetry={onRetry} rows={filtered} columns={cols} height={opts.height ?? 280} help={help}
      actions={<CardSearch value={search} onChange={setSearch} count={filtered.length} onApply={() => setList(dim, filtered.map((r) => r.key))} />}>
      {opts.asTable
        ? <DataTable rows={filtered} compact maxHeight="100%" initialSort={{ id: 'attributed', desc: true }} onRowClick={(r) => toggleValue(dim, r.key)} columns={cols} highlight={(r) => selected.includes(r.key)} />
        : <HBars colorful data={data.map((r) => ({ key: r.key, value: r.attributed, secondary: r.share_pct, selected: selected.includes(r.key), extra: { 'Total leads': fmtInt(r.leads), Converted: fmtInt(r.converted), [mode === 'first' ? 'Percentage' : 'Last-touch %']: fmtPct(r.attr_pct) } }))}
            valueLabel={label} secondaryLabel="Share" onClick={(key) => toggleValue(dim, key)} />}
    </ChartCard>
  );
}

/** Tableau "Lead Touch - First Touch" / "Lead Touch - Last Touch": every converted lead credited to exactly one touch. */
export default function TouchAttribution({ mode }: { mode: 'first' | 'last' }) {
  const { f, params, toggleValue, setList } = useFilters();
  const q = useApi<Resp>('/touch-attribution', { ...params, mode });
  const d = q.data?.data;
  const k = d?.kpis;
  const def = d?.definitions ?? {};
  const [drill, setDrill] = useState<Drill | null>(null);
  const label = mode === 'first' ? 'First-touch conversions' : 'Last-touch conversions';
  const metric = mode === 'first' ? 'first_touch' : 'last_touch';

  const cols: Col<AttrRow>[] = [
    { key: 'key', header: '' }, { key: 'leads', header: 'Total leads' }, { key: 'converted', header: 'Converted' },
    { key: 'attributed', header: label, bar: true }, { key: 'attr_pct', header: mode === 'first' ? 'Percentage' : 'Last-touch %', render: (v) => fmtPct(v as number) },
    { key: 'conv_pct', header: 'Conv %', render: (v) => fmtPct(v as number) }, { key: 'share_pct', header: 'Share', render: (v) => fmtPct(v as number) },
  ];

  const card = (title: string, rows: AttrRow[] | undefined, dim: ListDim, tone: string, opts: { asTable?: boolean; height?: number; limit?: number; help?: string } = {}) => (
    <AttrCard key={title} title={title} rows={rows} dim={dim} tone={tone} opts={opts} cols={cols} label={label} mode={mode} loading={q.isLoading} error={q.error} onRetry={q.refetch}
      help={opts.help ?? `${title}: ${def.attributed ?? ''}`} selected={f.lists[dim] ?? []} toggleValue={toggleValue} setList={setList} />
  );

  return (
    <div className="space-y-4">
      <PageHeader title={mode === 'first' ? 'First touch' : 'Last touch'}
        subtitle={`touch date ${f.from} → ${f.to} · every converted lead credited to its ${mode === 'first' ? 'first' : 'last'} touch`} />
      {q.error && <Note>⚠ {q.error.message}</Note>}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {q.isLoading && Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[92px]" />)}
        {k && <>
          <Kpi tone="tone-brand" icon={<Icon.Users />} title="Total leads" value={fmtInt(k.leads)} sub="distinct leads touched in the window" def={def.leads} onClick={() => setDrill({ metric: 'leads', title: 'Total leads' })} />
          <Kpi tone="tone-orange" icon={<Icon.Check />} title="Converted" value={fmtInt(k.converted)} sub={`${fmtPct(k.conv_pct)} of touched leads`} def={def.converted} onClick={() => setDrill({ metric: 'converted', title: 'Converted' })} />
          <Kpi tone={mode === 'first' ? 'tone-green' : 'tone-pink'} icon={<Icon.Touch />} title={label} value={fmtInt(k.attributed)} sub={`${fmtPct(k.attr_of_converted_pct)} of converted leads have their ${mode} touch in the window`} def={def.attributed}
            onClick={() => setDrill({ metric, title: label })} />
          <Kpi tone="tone-violet" icon={<Icon.Avg />} title={mode === 'first' ? 'Percentage' : 'Last-touch %'} value={fmtPct(k.attr_pct)} sub={`${label.toLowerCase()} ÷ total leads`} def={def.attr_pct} />
        </>}
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {card('Touch point analysis', d?.touch_point, 'touch_point', 'tone-teal')}
        {card('Class wise distribution', d?.class_raw, 'class_raw', 'tone-violet')}
        {card('Touch source distribution', d?.source, 'source', 'tone-orange', { asTable: true })}
        {card('Medium', d?.medium, 'medium', 'tone-green', { asTable: true })}
        {card('Campaign name', d?.campaign, 'campaign', 'tone-brand', { asTable: true })}
        <ChartCard title={`${label} per day`} tone="tone-pink" subtitle={`distinct leads and ${label.toLowerCase()} by touch date`} loading={q.isLoading} error={q.error} rows={d?.daily ?? []} height={280}>
          <DailyLines data={(d?.daily ?? []).map((r) => ({ d: r.d.slice(5), leads: r.leads, attributed: r.attributed }))} xKey="d" lines={[{ key: 'leads', label: 'Leads' }, { key: 'attributed', label }]} />
        </ChartCard>
      </div>

      {drill && <DrillDrawer drill={drill} onClose={() => setDrill(null)} />}
      <Note>
        {mode === 'first'
          ? <>Each converted lead is credited to <b>one</b> touch: its selected first touch (earliest touch on/after 1 March 2026, or its latest touch if none after that date). </>
          : <>Each lead is credited to <b>one</b> touch: its last valid touch, the latest touch made <b>before the moment of its last valid payment</b>. A touch on the payment day counts when it happened before the payment. If that last touch is an Eduport App touch made less than 2 hours before the payment, the credit goes to the touch before it; when the app touch is the only touch, it keeps the credit. </>}
        So the {label.toLowerCase()} column adds up across rows, unlike Total leads and Converted, where a lead can appear under several values. Clicking a KPI lists the leads; clicking a bar or row filters every card.
      </Note>
    </div>
  );
}
