import { useMemo, useState, type ReactNode } from 'react';
import { flexRender, getCoreRowModel, getSortedRowModel, useReactTable, type ColumnDef, type SortingState, type Row } from '@tanstack/react-table';

export interface Col<R> {
  key: keyof R & string;
  header: string;
  render?: (v: unknown, row: R) => ReactNode;
  align?: 'left' | 'right';
  width?: number;
  /** relative bar behind the number (0..1 given max) */
  bar?: boolean;
}

interface Props<R extends object> {
  rows: R[];
  columns?: Col<R>[];
  compact?: boolean;
  onRowClick?: (row: R) => void;
  renderExpanded?: (row: R) => ReactNode;
  initialSort?: { id: string; desc: boolean };
  maxHeight?: number | string;
  rowKey?: (r: R) => string;
  highlight?: (r: R) => boolean;
  /** rows that have children get a "+" in their first cell; the children render under the parent (same columns, bars relative to the parent) */
  subRows?: (r: R) => R[] | undefined;
  onSubRowClick?: (parent: R, child: R) => void;
}

const isNum = (v: unknown): v is number => typeof v === 'number';

export function DataTable<R extends object>({ rows, columns, compact, onRowClick, renderExpanded, initialSort, maxHeight, rowKey, highlight, subRows, onSubRowClick }: Props<R>) {
  const [sorting, setSorting] = useState<SortingState>(initialSort ? [initialSort] : []);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [openKeys, setOpenKeys] = useState<Set<string>>(() => new Set());
  const toggleOpen = (k: string) => setOpenKeys((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const fmtCell = (c: Col<R>, row: R): ReactNode => {
    const v = (row as Record<string, unknown>)[c.key];
    return c.render ? c.render(v, row) : isNum(v) ? new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(v) : v == null ? '–' : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v);
  };

  const cols = useMemo<Col<R>[]>(() => columns ?? (rows[0] ? (Object.keys(rows[0] as object) as (keyof R & string)[]).map((k) => ({ key: k, header: k })) : []), [columns, rows]);
  const maxes = useMemo(() => {
    const m: Record<string, number> = {};
    for (const c of cols) if (c.bar) m[c.key] = Math.max(0, ...rows.map((r) => { const v = (r as Record<string, unknown>)[c.key]; return isNum(v) ? v : 0; }));
    return m;
  }, [cols, rows]);

  const defs = useMemo<ColumnDef<R>[]>(() => cols.map((c) => ({
    id: c.key,
    accessorFn: (r) => (r as Record<string, unknown>)[c.key],
    header: c.header,
    size: c.width,
    cell: (info) => {
      const v = info.getValue();
      const out = c.render ? c.render(v, info.row.original) : isNum(v) ? new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(v) : v == null ? '–' : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v);
      if (c.bar && isNum(v) && maxes[c.key]) {
        return (
          <div className="relative">
            <div className="absolute inset-y-0 right-0 rounded-md bg-accent/15" style={{ width: `${(v / maxes[c.key]) * 100}%` }} />
            <span className="relative">{out}</span>
          </div>
        );
      }
      return out;
    },
    sortingFn: 'basic',
  })), [cols, maxes]);

  const table = useReactTable({ data: rows, columns: defs, state: { sorting }, onSortingChange: setSorting, getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel() });

  const key = (r: Row<R>) => (rowKey ? rowKey(r.original) : r.id);
  return (
    <div className="overflow-auto rounded-xl border border-line" style={{ maxHeight }}>
      <table className="w-full border-collapse">
        <thead>
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {renderExpanded && <th className="th w-6" />}
              {hg.headers.map((h) => {
                const c = cols.find((x) => x.key === h.id);
                const dir = h.column.getIsSorted();
                return (
                  <th key={h.id} className={`th cursor-pointer select-none ${c?.align === 'right' || isNum((rows[0] as Record<string, unknown> | undefined)?.[h.id]) ? 'text-right' : ''}`} style={{ width: c?.width }} onClick={h.column.getToggleSortingHandler()}>
                    {flexRender(h.column.columnDef.header, h.getContext())} {dir === 'asc' ? '▲' : dir === 'desc' ? '▼' : ''}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((r) => {
            const k = key(r);
            const open = expanded === k;
            const kids = subRows?.(r.original);
            const hasKids = !!kids?.length;
            const kidsOpen = hasKids && openKeys.has(k);
            return (
              <FragmentRow key={k}>
                <tr className={`${onRowClick || renderExpanded ? 'cursor-pointer hover:bg-accent/5' : ''} ${highlight?.(r.original) ? 'bg-[#fab219]/10' : ''}`}
                  onClick={() => { onRowClick?.(r.original); if (renderExpanded) setExpanded(open ? null : k); }}>
                  {renderExpanded && <td className="td text-ink-3">{open ? '▾' : '▸'}</td>}
                  {r.getVisibleCells().map((cell, ci) => {
                    const c = cols.find((x) => x.key === cell.column.id);
                    const v = cell.getValue();
                    return (
                      <td key={cell.id} className={`td ${compact ? '!py-1 text-xs' : ''} ${c?.align === 'right' || isNum(v) ? 'text-right' : ''}`}>
                        {ci === 0 && hasKids && (
                          <button className="mr-1.5 inline-flex h-4 w-4 items-center justify-center rounded border border-line text-[11px] font-bold leading-none text-ink-2 hover:border-accent hover:text-accent"
                            title={kidsOpen ? 'Hide the split' : 'Split this row'} onClick={(e) => { e.stopPropagation(); toggleOpen(k); }}>{kidsOpen ? '−' : '+'}</button>
                        )}
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    );
                  })}
                </tr>
                {kidsOpen && kids!.map((child, i) => (
                  <tr key={`${k}/${i}`} className={`bg-surface-2 ${onSubRowClick ? 'cursor-pointer hover:bg-accent/5' : ''}`} onClick={() => onSubRowClick?.(r.original, child)}>
                    {renderExpanded && <td className="td" />}
                    {cols.map((c, ci) => {
                      const v = (child as Record<string, unknown>)[c.key];
                      const pv = (r.original as Record<string, unknown>)[c.key];
                      const barW = c.bar && isNum(v) && isNum(pv) && pv > 0 ? Math.min(100, (v / pv) * 100) : null;
                      return (
                        <td key={c.key} className={`td ${compact ? '!py-1 text-xs' : ''} ${c.align === 'right' || isNum(v) ? 'text-right' : ''} ${ci === 0 ? 'pl-7 text-ink-2' : ''}`}>
                          {barW != null
                            ? <div className="relative"><div className="absolute inset-y-0 right-0 rounded-md bg-accent/10" style={{ width: `${barW}%` }} /><span className="relative">{fmtCell(c, child)}</span></div>
                            : <>{ci === 0 ? '↳ ' : ''}{fmtCell(c, child)}</>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
                {open && renderExpanded && (
                  <tr><td colSpan={cols.length + 1} className="border-b border-line bg-surface-2 p-3">{renderExpanded(r.original)}</td></tr>
                )}
              </FragmentRow>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && <div className="p-6 text-center text-xs text-ink-3">No rows</div>}
    </div>
  );
}

function FragmentRow({ children }: { children: ReactNode }) { return <>{children}</>; }
