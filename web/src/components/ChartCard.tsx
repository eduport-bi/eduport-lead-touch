import { titleCase, capFirst } from '../lib/format';
import { useRef, useState, type ReactNode } from 'react';
import { EmptyState, ErrorBoundary, ErrorNote, Icon, Popover, Skeleton } from './ui';
import { downloadText, toCsv } from '../lib/format';
import { useExportGate, verifyExportPassword } from '../lib/exportGate';
import { useAuth, canDownload } from '../lib/auth';
import { DataTable, type Col } from './DataTable';

export interface ChartCardProps<Row extends object> {
  title: string;
  /** shown in the heading line, right after the title (e.g. the Last / First touch switch) */
  titleAddon?: ReactNode;
  subtitle?: string;
  /** shown in the "?" popover */
  help?: ReactNode;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  rows?: Row[];                       // for CSV + table view
  columns?: Col<Row>[];               // table view columns (defaults to all keys)
  empty?: boolean;
  emptyHint?: string;
  actions?: ReactNode;                // extra controls (segmented, selects)
  height?: number;
  /** size the body to its content once loaded (no empty space under a table-like chart); `height` is then only the loading height */
  fitContent?: boolean;
  className?: string;
  children: ReactNode;                // the chart
  fileName?: string;
  /** colour tone class (tone-blue, tone-pink, ...) shown as a marker before the title */
  tone?: string;
}

/** Every chart lives in a ChartCard: title, "?" help, show-table toggle, PNG/CSV download, skeleton, empty + error states. */
export function ChartCard<Row extends object>(p: ChartCardProps<Row>) {
  const [table, setTable] = useState(false);
  const requestExport = useExportGate();
  const { user } = useAuth();
  const ref = useRef<HTMLDivElement>(null);
  const name = (p.fileName ?? p.title).replace(/[^a-z0-9]+/gi, '_').toLowerCase();
  const h = p.height ?? 220;

  const downloadPng = async () => {
    const svg = ref.current?.querySelector('svg');
    const host = ref.current;
    if (!host) return;
    if (!svg) { alert('This visual is not an SVG chart; use CSV instead.'); return; }
    const clone = svg.cloneNode(true) as SVGSVGElement;
    const bg = getComputedStyle(host).backgroundColor;
    const rect = svg.getBoundingClientRect();
    clone.setAttribute('width', String(rect.width)); clone.setAttribute('height', String(rect.height));
    clone.querySelectorAll('text').forEach((t) => { t.style.fill = getComputedStyle(t).fill; t.style.fontSize = getComputedStyle(t).fontSize; t.style.fontFamily = 'Inter, system-ui, sans-serif'; });
    clone.querySelectorAll('line').forEach((l) => { l.style.stroke = getComputedStyle(l).stroke; });
    const xml = new XMLSerializer().serializeToString(clone);
    const img = new Image();
    const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }));
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('svg render failed')); img.src = url; });
    const scale = 2;
    const cv = document.createElement('canvas'); cv.width = rect.width * scale; cv.height = (rect.height + 28) * scale;
    const ctx = cv.getContext('2d')!;
    ctx.scale(scale, scale);
    ctx.fillStyle = bg && bg !== 'rgba(0, 0, 0, 0)' ? bg : '#fcfcfb'; ctx.fillRect(0, 0, rect.width, rect.height + 28);
    ctx.fillStyle = getComputedStyle(host).color; ctx.font = '600 12px Inter, system-ui, sans-serif'; ctx.fillText(titleCase(p.title), 8, 18);
    ctx.drawImage(img, 0, 28, rect.width, rect.height);
    URL.revokeObjectURL(url);
    const a = document.createElement('a'); a.href = cv.toDataURL('image/png'); a.download = `${name}.png`; a.click();
  };

  const body = () => {
    if (p.error) return <ErrorNote error={p.error} onRetry={p.onRetry} />;
    if (p.loading) return <div className="flex h-full flex-col gap-2 pt-2"><Skeleton className="h-4 w-1/3" /><Skeleton className="h-full w-full" /></div>;
    if (p.empty || (p.rows && p.rows.length === 0)) return <EmptyState hint={p.emptyHint ?? 'Try widening the date range or removing a filter.'} />;
    if (table && p.rows) return <div className="h-full overflow-auto"><DataTable rows={p.rows} columns={p.columns} compact /></div>;
    return <ErrorBoundary label={p.title}>{p.children}</ErrorBoundary>;
  };

  return (
    <section className={`card flex flex-col ${p.tone ?? ''} ${p.className ?? ''}`}>
      <header className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            {p.tone && <span className="h-3 w-1.5 shrink-0 rounded-full bg-tone-solid" />}
            <h3 className="truncate text-[13px] font-semibold text-ink">{titleCase(p.title)}</h3>
            {p.titleAddon && <span className="ml-1 shrink-0">{p.titleAddon}</span>}
            {p.help && (
              <Popover width="w-96" trigger={<button className="rounded p-0.5 text-ink-3 hover:text-ink" title="How is this computed?"><Icon.Help /></button>}>
                <div className="text-xs leading-relaxed text-ink-2">{p.help}</div>
              </Popover>
            )}
          </div>
          {p.subtitle && <div className="mt-0.5 text-[11px] leading-tight text-ink-3">{capFirst(p.subtitle)}</div>}
        </div>
        <div className="flex items-center gap-1">
          {p.actions}
          {p.rows && (
            <button className={`btn !px-1.5 ${table ? 'border-accent text-accent' : ''}`} title={table ? 'Show chart' : 'Show table'} onClick={() => setTable((t) => !t)}>
              {table ? <Icon.Chart /> : <Icon.Table />}
            </button>
          )}
          {canDownload(user?.role) && <Popover align="right" width="w-36" trigger={<button className="btn !px-1.5" title="Download"><Icon.Download /></button>}>
            {(close) => (
              <div className="flex flex-col gap-1">
                <button className="btn justify-start" onClick={() => { downloadPng().catch((e) => alert(String(e))); close(); }}>PNG image</button>
                <button className="btn justify-start" disabled={!p.rows?.length} onClick={() => { close(); requestExport({ title: `${p.title} (CSV)`, run: async (pw) => { await verifyExportPassword(pw, `${name}.csv`); downloadText(`${name}.csv`, toCsv((p.rows ?? []) as unknown as Record<string, unknown>[], p.columns?.map((c) => String(c.key)))); } }); }}>CSV data</button>
              </div>
            )}
          </Popover>}
        </div>
      </header>
      <div ref={ref} className="relative min-h-0 overflow-hidden" style={p.fitContent && !p.loading && !table ? {} : { height: h, flex: `1 1 ${h}px` }}>{body()}</div>
    </section>
  );
}
