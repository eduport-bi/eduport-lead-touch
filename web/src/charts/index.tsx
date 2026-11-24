/**
 * Chart primitives (Recharts) styled per the validated palette:
 * thin marks, 2px lines, recessive grid, tooltips with absolute + %, single axis per plot.
 */
import type { ReactNode } from 'react';
import {
  Bar, BarChart, CartesianGrid, Cell, ComposedChart, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer,
  Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis, LabelList, Pie, PieChart,
} from 'recharts';
import { seqColor, seqInk, useTheme } from '../lib/palette';
import { fmtCompact, fmtInt, fmtPct, DOW } from '../lib/format';

// ---------------------------------------------------------------- tooltip
export function Tip({ active, payload, label, rows }: { active?: boolean; payload?: { payload: Record<string, unknown> }[]; label?: string; rows: (d: Record<string, unknown>) => [string, string][] }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded-xl border border-line bg-surface px-3 py-2 text-xs shadow-pop">
      {label !== undefined && <div className="mb-1 font-semibold text-ink">{String(label)}</div>}
      {rows(d).map(([k, v]) => <div key={k} className="flex justify-between gap-4"><span className="text-ink-3">{k}</span><span className="tabular-nums text-ink">{v}</span></div>)}
    </div>
  );
}

const axis = { tickLine: false, axisLine: false } as const;

// ---------------------------------------------------------------- trend (two stacked panels, one axis each)
export interface TrendDatum { d: string; leads: number; converted: number; conv_rate: number | null; touches: number; prev_leads?: number | null; prev_conv_rate?: number | null }
export function TrendChart({ data, compare }: { data: TrendDatum[]; compare?: boolean }) {
  const { series, ink } = useTheme();
  const tipRows = (d: Record<string, unknown>): [string, string][] => [
    ['Leads', fmtInt(d.leads as number)], ['Converted', fmtInt(d.converted as number)], ['Conversion', fmtPct(d.conv_rate as number)], ['Touches', fmtInt(d.touches as number)],
    ...(compare ? ([['Prev leads', fmtInt(d.prev_leads as number)], ['Prev conversion', fmtPct(d.prev_conv_rate as number)]] as [string, string][]) : []),
  ];
  return (
    <div className="flex h-full flex-col">
      <div className="text-[11px] text-ink-3">Leads</div>
      <ResponsiveContainer width="100%" height="55%">
        <ComposedChart data={data} margin={{ top: 4, right: 8, left: -18, bottom: 0 }} barCategoryGap={2}>
          <CartesianGrid vertical={false} stroke={ink.grid} />
          <XAxis dataKey="d" {...axis} tickFormatter={(v) => String(v).slice(5)} minTickGap={24} hide />
          <YAxis {...axis} tickFormatter={fmtCompact} width={48} />
          <Tooltip content={<Tip rows={tipRows} />} cursor={{ fill: ink.grid, opacity: 0.4 }} />
          <Bar dataKey="leads" name="Leads" fill={series[0]} radius={[6, 6, 0, 0]} maxBarSize={28} isAnimationActive={false} />
          {compare && <Line dataKey="prev_leads" name="Previous leads" stroke={ink.muted} strokeDasharray="4 3" strokeWidth={1.5} dot={false} isAnimationActive={false} />}
        </ComposedChart>
      </ResponsiveContainer>
      <div className="text-[11px] text-ink-3">Conversion %</div>
      <ResponsiveContainer width="100%" height="45%">
        <LineChart data={data} margin={{ top: 4, right: 8, left: -18, bottom: 0 }} syncId="trend">
          <CartesianGrid vertical={false} stroke={ink.grid} />
          <XAxis dataKey="d" {...axis} tickFormatter={(v) => String(v).slice(5)} minTickGap={24} />
          <YAxis {...axis} tickFormatter={(v) => `${v}%`} width={48} />
          <Tooltip content={<Tip rows={tipRows} />} />
          <Line dataKey="conv_rate" name="Conversion %" stroke={series[1]} strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} connectNulls />
          {compare && <Line dataKey="prev_conv_rate" name="Previous conversion %" stroke={ink.muted} strokeDasharray="4 3" strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls />}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------------------------------------------------------------- horizontal bars (click = cross-filter)
export interface BarDatum { key: string; value: number; secondary?: number | null; label?: string; selected?: boolean; extra?: Record<string, unknown> }
export function HBars({ data, format = fmtInt, secondaryLabel, secondaryFormat = fmtPct, onClick, color, maxLabel = 22, valueLabel = 'Value', colorful }: {
  data: BarDatum[]; format?: (v: number) => string; secondaryLabel?: string; secondaryFormat?: (v: number) => string; onClick?: (key: string) => void; color?: string; maxLabel?: number; valueLabel?: string; colorful?: boolean;
}) {
  const { series, ink } = useTheme();
  const c = color ?? series[0];
  const anySel = data.some((d) => d.selected);
  const h = Math.max(110, data.length * 22);
  return (
    <div className="h-full overflow-y-auto">
      <ResponsiveContainer width="100%" height={h}>
        <BarChart data={data} layout="vertical" margin={{ top: 2, right: 56, left: 8, bottom: 2 }} barCategoryGap={3}>
          <CartesianGrid horizontal={false} stroke={ink.grid} />
          <XAxis type="number" {...axis} tickFormatter={fmtCompact} hide />
          <YAxis type="category" dataKey="key" {...axis} width={128} interval={0} tick={{ fontSize: 10 }} tickFormatter={(v: string) => (v.length > maxLabel ? `${v.slice(0, maxLabel - 1)}…` : v)} />
          <Tooltip cursor={{ fill: ink.grid, opacity: 0.4 }} content={<Tip rows={(d) => [[valueLabel, format(d.value as number)], ...(secondaryLabel && d.secondary != null ? ([[secondaryLabel, secondaryFormat(d.secondary as number)]] as [string, string][]) : []), ...Object.entries((d.extra as Record<string, unknown>) ?? {}).map(([k, v]) => [k, String(v)] as [string, string])]} />} />
          <Bar dataKey="value" radius={[6, 6, 6, 6]} maxBarSize={13} isAnimationActive={false} onClick={(d) => onClick?.((d as unknown as BarDatum).key)} cursor={onClick ? 'pointer' : undefined}>
            {data.map((d, i) => <Cell key={d.key} fill={colorful ? series[i % series.length] : c} fillOpacity={anySel && !d.selected ? 0.35 : 1} />)}
            <LabelList dataKey="value" position="right" formatter={(v: number) => format(v)} style={{ fontSize: 10, fill: ink.secondary }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------------------------------------------------------------- vertical bars + optional line on a second panel
export function VBars({ data, xKey, bars, format = fmtInt, onClick, stacked, minBarWidth = 34 }: { data: Record<string, unknown>[]; xKey: string; bars: { key: string; label: string }[]; format?: (v: number) => string; onClick?: (key: string) => void; stacked?: boolean; minBarWidth?: number }) {
  const { series, ink } = useTheme();
  // each category gets at least `minBarWidth` px; when that exceeds the card the chart scrolls sideways instead of squeezing the labels
  return (
    <div className="h-full w-full overflow-x-auto overflow-y-hidden">
    <div className="h-full" style={{ width: `max(100%, ${data.length * minBarWidth}px)` }}>
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }} barCategoryGap={4} barGap={2}>
        <CartesianGrid vertical={false} stroke={ink.grid} />
        <XAxis dataKey={xKey} {...axis} tick={{ fontSize: 10 }} interval={0} angle={-40} textAnchor="end" height={36} />
        <YAxis {...axis} tickFormatter={fmtCompact} width={48} />
        <Tooltip cursor={{ fill: ink.grid, opacity: 0.4 }} content={<Tip rows={(d) => bars.map((b) => [b.label, format(d[b.key] as number)])} />} />
        {bars.length > 1 && <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />}
        {bars.map((b, i) => <Bar key={b.key} dataKey={b.key} name={b.label} fill={series[i]} stackId={stacked ? 's' : undefined} radius={stacked && i < bars.length - 1 ? 0 : [6, 6, 0, 0]} maxBarSize={40} isAnimationActive={false} onClick={(d) => onClick?.(String((d as Record<string, unknown>)[xKey]))} cursor={onClick ? 'pointer' : undefined} />)}
      </BarChart>
    </ResponsiveContainer>
    </div>
    </div>
  );
}

// ---------------------------------------------------------------- daily lines: one label every 2nd day, no scrolling, click a point to pick that day
export function DailyLines({ data, xKey, lines, format = fmtInt, onClick }: { data: Record<string, unknown>[]; xKey: string; lines: { key: string; label: string }[]; format?: (v: number) => string; onClick?: (x: string) => void }) {
  const { series, ink } = useTheme();
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 8, right: 12, left: -14, bottom: 0 }} onClick={(e) => { const l = (e as { activeLabel?: unknown } | null)?.activeLabel; if (l != null) onClick?.(String(l)); }} style={{ cursor: onClick ? 'pointer' : undefined }}>
        <CartesianGrid vertical={false} stroke={ink.grid} />
        <XAxis dataKey={xKey} {...axis} interval={1} tick={{ fontSize: 10 }} angle={-35} textAnchor="end" height={34} />
        <YAxis {...axis} tickFormatter={fmtCompact} width={44} />
        <Tooltip content={<Tip rows={(d) => lines.map((l) => [l.label, format(d[l.key] as number)])} />} />
        {lines.length > 1 && <Legend iconType="plainline" wrapperStyle={{ fontSize: 11 }} />}
        {lines.map((l, i) => <Line key={l.key} dataKey={l.key} name={l.label} stroke={series[i]} strokeWidth={2} dot={{ r: 2.5, strokeWidth: 0, fill: series[i] }} activeDot={{ r: 4 }} isAnimationActive={false} />)}
      </LineChart>
    </ResponsiveContainer>
  );
}

// ---------------------------------------------------------------- multi-series line (touch curve etc.)
export function Lines({ data, xKey, lines, format = fmtPct, yLabel }: { data: Record<string, unknown>[]; xKey: string; lines: { key: string; label: string }[]; format?: (v: number) => string; yLabel?: string }) {
  const { series, ink } = useTheme();
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke={ink.grid} />
        <XAxis dataKey={xKey} {...axis} tick={{ fontSize: 11 }} />
        <YAxis {...axis} tickFormatter={(v) => format(v)} width={52} label={yLabel ? { value: yLabel, angle: -90, position: 'insideLeft', fontSize: 10, fill: ink.muted } : undefined} />
        <Tooltip content={<Tip rows={(d) => lines.map((l) => [l.label, d[l.key] == null ? '–' : format(d[l.key] as number)])} />} />
        {lines.length > 1 && <Legend iconType="plainline" wrapperStyle={{ fontSize: 11 }} />}
        {lines.slice(0, 8).map((l, i) => <Line key={l.key} dataKey={l.key} name={l.label} stroke={series[i]} strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} connectNulls />)}
      </LineChart>
    </ResponsiveContainer>
  );
}

// ---------------------------------------------------------------- heatmap (CSS grid, sequential blue)
export function Heatmap({ rows, cols, get, format = fmtInt, rowLabel, colLabel, onClick, cellTitle, mark, colText, verticalCols }: {
  rows: string[]; cols: string[]; get: (r: string, c: string) => number | null; format?: (v: number) => string; rowLabel?: string; colLabel?: string; onClick?: (r: string, c: string) => void; cellTitle?: (r: string, c: string, v: number | null) => string;
  /** shorter text for a column header (the full name stays in its tooltip) */
  colText?: (c: string) => string;
  /** write the column headers vertically, full names (many long columns, e.g. the class matrix) */
  verticalCols?: boolean;
  /** cells to outline (e.g. the diagonal of a lead class vs purchased class matrix) */
  mark?: (r: string, c: string) => boolean;
}) {
  const { dark } = useTheme();
  let max = 0;
  for (const r of rows) for (const c of cols) max = Math.max(max, get(r, c) ?? 0);
  return (
    <div className="h-full overflow-auto text-[10px]">
      {colLabel && <div className="mb-1 text-ink-3">{colLabel} →</div>}
      <div className="grid gap-[2px]" style={{ gridTemplateColumns: `${verticalCols ? 'max-content' : 'minmax(70px,auto)'} repeat(${cols.length}, minmax(${verticalCols ? 30 : 38}px, 1fr))` }}>
        <div className="flex items-end text-ink-3">{rowLabel}</div>
        {/* column names: written vertically (bottom to top) when asked, so long names such as "Class 11 Science CBSE" stay whole and
            readable in a narrow column; otherwise they wrap. Never cut. */}
        {cols.map((c) => verticalCols
          ? <div key={c} className="flex min-w-0 items-end justify-center pb-1" title={c}>
              <span className="whitespace-nowrap text-[11px] font-medium text-ink-2 [transform:rotate(180deg)] [writing-mode:vertical-rl]">{colText ? colText(c) : c}</span>
            </div>
          : <div key={c} className="flex min-w-0 items-end justify-center pb-0.5 text-center leading-tight text-ink-3 [overflow-wrap:anywhere]" title={c}>{colText ? colText(c) : c}</div>)}
        {rows.map((r) => (
          <RowCells key={r} r={r} cols={cols} get={get} max={max} dark={dark} format={format} onClick={onClick} cellTitle={cellTitle} mark={mark} fullLabel={verticalCols} />
        ))}
      </div>
    </div>
  );
}
function RowCells({ r, cols, get, max, dark, format, onClick, cellTitle, mark, fullLabel }: { r: string; cols: string[]; get: (r: string, c: string) => number | null; max: number; dark: boolean; format: (v: number) => string; onClick?: (r: string, c: string) => void; cellTitle?: (r: string, c: string, v: number | null) => string; mark?: (r: string, c: string) => boolean; fullLabel?: boolean }) {
  return (
    <>
      <div className={`${fullLabel ? 'whitespace-nowrap text-[11px] font-medium' : 'truncate'} pr-2 text-ink-2`} title={r}>{r}</div>
      {cols.map((c) => {
        const v = get(r, c);
        const t = v == null || !max ? NaN : v / max;
        return (
          <div key={c} title={cellTitle ? cellTitle(r, c, v) : `${r} × ${c}: ${v == null ? '–' : format(v)}`} onClick={() => onClick?.(r, c)}
            className={`flex h-5 items-center justify-center rounded-sm tabular-nums ${onClick ? 'cursor-pointer' : ''} ${mark?.(r, c) ? 'font-bold ring-2 ring-inset ring-ink/60' : ''}`}
            style={{ background: seqColor(t, dark), color: Number.isNaN(t) ? (dark ? '#898781' : '#898781') : seqInk(t) }}>
            {v == null ? '' : format(v)}
          </div>
        );
      })}
    </>
  );
}

export const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
export const DOW_LABELS = DOW;

// ---------------------------------------------------------------- scatter with quadrants
export interface ScatterDatum { key: string; x: number; y: number; z?: number; quadrant?: string }
export function QuadrantScatter({ data, xLabel, yLabel, xMid, yMid, onClick, xFormat = fmtInt, yFormat = fmtPct }: { data: ScatterDatum[]; xLabel: string; yLabel: string; xMid: number; yMid: number; onClick?: (k: string) => void; xFormat?: (v: number) => string; yFormat?: (v: number) => string }) {
  const { series, ink } = useTheme();
  const colorFor = (q?: string) => (q === 'Scale winners' ? series[2] : q === 'Fix or kill' ? series[7] : q === 'Nurture' ? series[0] : series[3]);
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ScatterChart margin={{ top: 12, right: 24, left: -6, bottom: 8 }}>
        <CartesianGrid stroke={ink.grid} />
        <XAxis type="number" dataKey="x" name={xLabel} {...axis} tickFormatter={fmtCompact} scale="sqrt" label={{ value: xLabel, position: 'insideBottom', offset: -4, fontSize: 10, fill: ink.muted }} />
        <YAxis type="number" dataKey="y" name={yLabel} {...axis} tickFormatter={(v) => `${v}%`} width={44} label={{ value: yLabel, angle: -90, position: 'insideLeft', fontSize: 10, fill: ink.muted }} />
        <ZAxis type="number" dataKey="z" range={[40, 400]} />
        <ReferenceLine x={xMid} stroke={ink.axis} strokeDasharray="3 3" />
        <ReferenceLine y={yMid} stroke={ink.axis} strokeDasharray="3 3" />
        <Tooltip cursor={{ strokeDasharray: '3 3' }} content={<Tip rows={(d) => [['Segment', String(d.key)], [xLabel, xFormat(d.x as number)], [yLabel, yFormat(d.y as number)], ['Quadrant', String(d.quadrant ?? '')]]} />} />
        <Scatter data={data} isAnimationActive={false} onClick={(d) => onClick?.((d as unknown as ScatterDatum).key)} cursor={onClick ? 'pointer' : undefined}>
          {data.map((d) => <Cell key={d.key} fill={colorFor(d.quadrant)} fillOpacity={0.85} stroke={ink.grid} />)}
          <LabelList dataKey="key" position="top" style={{ fontSize: 9, fill: ink.secondary }} formatter={(v: string) => (v.length > 14 ? `${v.slice(0, 13)}…` : v)} />
        </Scatter>
      </ScatterChart>
    </ResponsiveContainer>
  );
}

// ---------------------------------------------------------------- donut (share of a total; click = cross-filter)
export function Donut({ data, valueLabel = 'Value', secondaryLabel, format = fmtInt, secondaryFormat = fmtInt, onClick, centerLabel }: {
  data: BarDatum[]; valueLabel?: string; secondaryLabel?: string; format?: (v: number) => string; secondaryFormat?: (v: number) => string; onClick?: (key: string) => void; centerLabel?: string;
}) {
  const { series, ink } = useTheme();
  const total = data.reduce((s, d) => s + d.value, 0);
  const anySel = data.some((d) => d.selected);
  return (
    <div className="flex h-full items-center gap-3">
      <div className="relative h-full min-w-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
            <Tooltip content={<Tip rows={(d) => [[valueLabel, format(d.value as number)], ['Share', fmtPct(total ? ((d.value as number) / total) * 100 : null)], ...(secondaryLabel && d.secondary != null ? ([[secondaryLabel, secondaryFormat(d.secondary as number)]] as [string, string][]) : [])]} />} />
            <Pie data={data} dataKey="value" nameKey="key" innerRadius="58%" outerRadius="92%" paddingAngle={2} cornerRadius={6} stroke="none" isAnimationActive={false}
              onClick={(d) => onClick?.((d as unknown as BarDatum).key)} cursor={onClick ? 'pointer' : undefined}>
              {data.map((d, i) => <Cell key={d.key} fill={series[i % series.length]} fillOpacity={anySel && !d.selected ? 0.3 : 1} />)}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <div className="text-lg font-extrabold leading-none tabular-nums" style={{ color: ink.primary }}>{format(total)}</div>
          {centerLabel && <div className="mt-0.5 text-[10px]" style={{ color: ink.muted }}>{centerLabel}</div>}
        </div>
      </div>
      <ul className="max-h-full w-[46%] shrink-0 space-y-1 overflow-auto pr-1 text-[11px]">
        {data.map((d, i) => (
          <li key={d.key} className={`flex cursor-pointer items-center gap-1.5 rounded-lg px-1.5 py-0.5 hover:bg-surface-2 ${anySel && !d.selected ? 'opacity-50' : ''}`} onClick={() => onClick?.(d.key)} title={d.key}>
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: series[i % series.length] }} />
            <span className="min-w-0 flex-1 break-words leading-tight text-ink-2">{d.key}</span>
            <span className="tabular-nums font-semibold text-ink">{format(d.value)}</span>
            <span className="w-10 text-right tabular-nums text-ink-3">{fmtPct(total ? (d.value / total) * 100 : null)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- legend swatches for custom layouts
export function Swatch({ color, label }: { color: string; label: ReactNode }) {
  return <span className="inline-flex items-center gap-1 text-[11px] text-ink-2"><span className="inline-block h-2 w-2 rounded-full" style={{ background: color }} />{label}</span>;
}
