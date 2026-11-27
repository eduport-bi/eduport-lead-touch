import { useState } from 'react';
import { useApi, type Params } from '../lib/api';
import { fmt1, fmtInt, fmtINR, fmtPct } from '../lib/format';
import { ErrorNote, Icon, Popover, Skeleton } from './ui';

/** which split tables the drawer shows; remembered per browser */
const TABLES_KEY = 'lt-summary-tables';
const DEFAULT_TABLES = ['lead_stage', 'grade', 'touch_point', 'call_reason'];
const DEFAULT_TABLES_CREATED = ['touched', 'lead_stage', 'class_group', 'lead_source'];
function loadTables(key: string, fallback: string[]): string[] { try { const v = JSON.parse(localStorage.getItem(key) ?? 'null'); return Array.isArray(v) && v.length ? v : fallback; } catch { return fallback; } }
function saveTables(key: string, v: string[]) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ } }

interface SplitRow { key: string; leads: number; revenue: number | null }
interface Split { dim: string; label: string; kind: 'lead' | 'touch' | 'pay'; rows: SplitRow[]; distinct: number }
interface Summary { mode: 'after_stage' | 'window' | 'created'; scope?: 'created' | 'union'; touched?: number; called_after: number; paid_after: number; paid_after_revenue: number; retouched: number; avg_days_to_retouch: number | null; leads: number; revenue: number; touches: number; payers: number; payment_window: { from: string; to: string } | null; splits: Split[] }

/**
 * Overview of the leads behind a drill: headline figures + one small "split" card per dimension
 * (purchased grade / course, stage, class, source, touch point ...). Clicking a row narrows the drawer to that value.
 */
export function DrillSummary({ params, onPick, path }: { params: Params; onPick: (dim: string, value: string) => void; path?: string }) {
  const r = useApi<Summary>(path ?? '/overview/leads/summary', params, { placeholderData: (prev) => prev });
  const d = r.data?.data;
  const [store, setStore] = useState<Record<string, string[]>>({});
  if (r.error) return <ErrorNote error={r.error} onRetry={r.refetch} />;
  if (!d) return <div className="grid gap-3 md:grid-cols-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-44" />)}</div>;
  // the New leads drawer (mode created) remembers its own table choice
  const tablesKey = d.mode === 'created' ? `${TABLES_KEY}-created` : TABLES_KEY;
  const defaults = d.mode === 'created' ? DEFAULT_TABLES_CREATED : DEFAULT_TABLES;
  const tables = store[tablesKey] ?? loadTables(tablesKey, defaults);
  const choose = (v: string[]) => { setStore({ ...store, [tablesKey]: v }); saveTables(tablesKey, v); };
  return (
    <div className={`h-full overflow-y-auto pr-1 ${r.isFetching ? 'opacity-70' : ''}`}>
      {d.mode === 'after_stage' ? (
      <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Head label="Leads re-touched" value={fmtInt(d.leads)} sub="in a closed stage, touched after entering it" />
        <Head label="Called after the stage change" value={fmtInt(d.called_after)} sub="last call is later than the stage change" />
        <Head label="Touches after the stage change" value={fmtInt(d.touches)} sub={d.leads ? `${fmt1(d.touches / d.leads)} per lead` : undefined} />
        <Head label="Days to the first re-touch" value={d.avg_days_to_retouch == null ? '–' : fmt1(d.avg_days_to_retouch)} sub="average, from the stage change" />
        <Head label="Paid after the stage change" value={fmtInt(d.paid_after)} sub={fmtINR(d.paid_after_revenue)} />
      </div>
      ) : d.mode === 'created' ? (
      <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Head label={d.scope === 'union' ? 'Total leads' : 'Leads created'} value={fmtInt(d.leads)} sub={d.scope === 'union' ? 'created or touched in the date range' : 'in the date range, touched or not'} />
        <Head label="With a touch" value={fmtInt(d.touched ?? 0)} sub={d.leads ? `${fmtPct(((d.touched ?? 0) / d.leads) * 100)} · ${fmtInt(d.leads - (d.touched ?? 0))} no touch yet` : undefined} />
        <Head label="Touches (all dates)" value={fmtInt(d.touches)} sub={d.touched ? `${fmt1(d.touches / d.touched)} per touched lead` : undefined} />
        <Head label="With a purchase" value={fmtInt(d.payers)} sub={d.payment_window ? `paid ${d.payment_window.from} → ${d.payment_window.to}` : 'any successful payment, any date'} />
        <Head label="Revenue" value={fmtINR(d.revenue)} sub="all payments of the buyers" />
      </div>
      ) : (
      <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Head label="Leads" value={fmtInt(d.leads)} />
        <Head label="Touches in window" value={fmtInt(d.touches)} sub={d.leads ? `${fmt1(d.touches / d.leads)} per lead` : undefined} />
        <Head label="Revenue" value={fmtINR(d.revenue)} sub="all valid payments of these leads" />
        <Head label="With a purchase" value={fmtInt(d.payers)} sub={d.payment_window ? `paid ${d.payment_window.from} → ${d.payment_window.to}` : 'any valid payment, any date'} />
      </div>
      )}
      {(() => {
        const shown = d.splits.filter((s) => tables.includes(s.dim));
        const all = d.splits.map((s) => s.dim);
        return (
          <>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="text-[11px] text-ink-3">{shown.length} of {d.splits.length} tables shown · click a value in a table to see those leads</div>
              <Popover align="right" width="w-64" trigger={<button className="btn"><Icon.Table /> Tables · {shown.length} <Icon.Chevron open /></button>}>
                {(close) => (
                  <div className="text-xs">
                    <div className="mb-1 flex items-center justify-between">
                      <span className="font-semibold">Tables to Show</span>
                      <div className="flex gap-2 text-ink-3"><button className="hover:text-ink" onClick={() => choose(all)}>All</button><button className="hover:text-ink" onClick={() => choose(defaults)}>Default</button></div>
                    </div>
                    <div className="max-h-80 space-y-0.5 overflow-y-auto">
                      {d.splits.map((s) => (
                        <label key={s.dim} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-surface-2">
                          <input type="checkbox" checked={tables.includes(s.dim)} onChange={() => choose(tables.includes(s.dim) ? tables.filter((x) => x !== s.dim) : [...tables, s.dim])} />
                          <span className="truncate">{s.label}</span>
                        </label>
                      ))}
                    </div>
                    <div className="mt-2 flex justify-end"><button className="btn btn-primary" onClick={close}>Done</button></div>
                  </div>
                )}
              </Popover>
            </div>
            {shown.length === 0
              ? <div className="rounded-lg border border-dashed border-line p-6 text-center text-xs text-ink-3">No tables selected. Use the Tables button to pick the splits you want to see.</div>
              : <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{shown.map((s) => <SplitCard key={s.dim} split={s} total={d.leads} onPick={onPick} />)}</div>}
          </>
        );
      })()}
    </div>
  );
}

function Head({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return <div className="rounded-lg border border-line bg-surface-2 px-3 py-2"><div className="text-[11px] font-medium text-ink-3">{label}</div><div className="text-lg font-semibold tabular-nums leading-tight">{value}</div>{sub && <div className="text-[10px] text-ink-3">{sub}</div>}</div>;
}

function SplitCard({ split, total, onPick }: { split: Split; total: number; onPick: (dim: string, value: string) => void }) {
  const max = split.rows[0]?.leads ?? 0;
  const hint = split.kind === 'pay' ? 'a lead buying two counts in both' : split.kind === 'touch' ? (split.label.includes('after') ? 'leads with such a touch after the stage change' : 'leads touched there in the window') : undefined;
  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <div className="text-xs font-semibold">{split.label}</div>
        <div className="text-[10px] text-ink-3">{split.distinct > split.rows.length ? `top ${split.rows.length} of ${split.distinct}` : `${split.distinct} values`}{hint ? ` · ${hint}` : ''}</div>
      </div>
      {split.rows.length === 0 ? <div className="py-4 text-center text-[11px] text-ink-3">No data</div> : (
        <div className="max-h-56 overflow-y-auto">
          <table className="w-full text-[11px]">
            <tbody>
              {split.rows.map((x) => (
                <tr key={x.key} className="cursor-pointer hover:bg-surface-2" title={`Show these ${fmtInt(x.leads)} leads`} onClick={() => onPick(split.dim, x.key)}>
                  <td className="max-w-[190px] truncate py-[3px] pr-2" title={x.key}>{x.key}</td>
                  <td className="w-full py-[3px]"><div className="h-2 rounded-sm bg-accent/15"><div className="h-2 rounded-sm bg-accent" style={{ width: `${max ? Math.max(2, (x.leads / max) * 100) : 0}%` }} /></div></td>
                  <td className="whitespace-nowrap py-[3px] pl-2 text-right tabular-nums font-medium">{fmtInt(x.leads)}</td>
                  <td className="whitespace-nowrap py-[3px] pl-2 text-right tabular-nums text-ink-3">{total ? fmtPct((x.leads / total) * 100) : '–'}</td>
                  {split.kind === 'pay' && <td className="whitespace-nowrap py-[3px] pl-2 text-right tabular-nums text-ink-3" title="revenue">{fmtINR(x.revenue)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
