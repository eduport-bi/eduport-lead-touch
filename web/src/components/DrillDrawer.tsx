import { useEffect, useState } from 'react';
import { useApi, downloadWithAuth, type Params } from '../lib/api';
import { useFilters, DIM_LABEL, type ListDim } from '../lib/filters';
import { fmtDateTime, fmtInt, fmtINR } from '../lib/format';
import { DataTable, type Col } from './DataTable';
import { LeadDrawer } from './LeadDrawer';
import { DrillSummary } from './DrillSummary';
import { ErrorNote, Icon, Skeleton, useDebounce } from './ui';
import { useExportGate } from '../lib/exportGate';
import { useAuth, canDownload } from '../lib/auth';

export type DrillMetric = 'leads' | 'touches' | 'converted' | 'first_touch' | 'last_touch' | 'stale_new' | 'stale_not_connected' | 'converted_first' | 'converted_before' | 'sf_converted' | 'stage_conv_unpaid' | 'paid_other_stage' | 'stage_react' | 'revised_new' | 'avg_alltime' | 'avg_window' | 'new_leads' | 'fee_paid';
export interface Drill {
  metric: DrillMetric; title: string; subtitle?: string; dim?: string; value?: string;
  /** alternative list endpoint (default /overview/leads) */
  path?: string; csvPath?: string; summaryPath?: string; columns?: Col<Row>[]; sortOptions?: [string, string][]; defaultSort?: string; extra?: Record<string, string | number>; noun?: string;
  /** open on the split-by-dimension overview instead of the lead list (Overview KPIs) */
  summary?: boolean;
}

const EXTRA_LABEL: Record<string, string> = { academic_year: 'Academic year', touched: 'Touched yet?', conv_untouched: 'Never touched · first payment', first_touch_point: 'First touch point', first_touch_source: 'First touch source', first_touch_medium: 'First touch medium', first_touch_campaign: 'First touch campaign', first_touch_staff: 'First touch staff', new_customer: 'New customer', app_prev_source: 'App Installed last touch · source before it', ic_course: 'Interested course', tat_created: 'Lead created → paid', tat_touch: 'Last touch → paid', tat_activity: 'First touch → first activity', call_reason: 'Last call reason', grade: 'Purchased grade', course: 'Purchased course', owner: 'Owner', ic_status: 'IC status', lm_reason: 'LM reason', class_group: 'Lead class', lead_stage: 'Lead stage', lead_source: 'Lead source', touch_point: 'Touch point', source: 'Source', medium: 'Medium', district: 'District' };

const METRIC_LABEL: Record<DrillMetric, string> = {
  leads: 'leads touched in the window', touches: 'leads touched in the window (with their touch counts)', converted: 'converted leads (valid payment on/after a touch)', first_touch: 'converted leads whose selected first touch is in the selection', stale_new: 'leads still in stage New, created more than 5 days ago and not touched in the last 5 days', stale_not_connected: 'leads still in stage Not Connected, created more than 5 days ago and not touched in the last 5 days', last_touch: 'leads whose last valid touch (latest touch on/before their last payment) is in the selection',
  converted_first: 'leads whose first payment came after a touch',
  revised_new: 'leads yet to connect: no call Task, Lead Stage change or IC status change on or after their first touch in the selection (Converted leads included)',
  converted_before: 'leads already converted before the window started (first payment before the window)',
  sf_converted: 'leads flagged Is_Converted__c in Salesforce', stage_conv_unpaid: 'leads in stage Converted with no valid payment on their phone (any date)', paid_other_stage: 'leads with a valid payment (Total converted rule) whose stage is not Converted', stage_react: 'leads in Not Willing Now / Disqualified / Not Connected / P2 Completed that received a new touch after that stage was set', avg_alltime: 'leads with a valid payment (all touches, no date filter)', avg_window: 'leads with a valid payment touched in the window',
  new_leads: 'Salesforce leads created inside the date range, touched or not',
  fee_paid: 'leads of the selection whose app account paid inside the date range',
};

type Row = Record<string, unknown>;
interface Resp { page: number; limit: number; total: number; rows: Row[]; masked: boolean; columns: string[] }

const yesNo = (v: unknown) => (v ? 'Yes' : 'No');
const COLS: Col<Row>[] = [
  { key: 'lead_name', header: 'Lead ID' },
  { key: 'eps_id', header: 'EPS ID', render: (v) => (v == null ? '–' : String(v)) },
  { key: 'first_name', header: 'Name', render: (v, r) => `${v ?? ''} ${r.last_name ?? ''}`.trim() || '–' },
  { key: 'mobile', header: 'Phone' },
  { key: 'lead_stage', header: 'Stage' },
  { key: 'best_ic_status', header: 'IC status' },
  { key: 'class_raw', header: 'Class' },
  { key: 'lead_source', header: 'Primary source' },
  { key: 'lead_created_date', header: 'Created' },
  { key: 'touches_in_window', header: 'Touches (window)', align: 'right' },
  { key: 'n_touches_all', header: 'Touches (all)', align: 'right' },
  { key: 'touch_points', header: 'Touch points' },
  { key: 'last_any_touch_point', header: 'Last touch point' },
  { key: 'last_touch_point', header: 'Last valid touch' },
  { key: 'last_touch_in_window', header: 'Last touch (window)', render: (v) => fmtDateTime(v as string) },
  { key: 'last_touch_any', header: 'Last touch (any)', render: (v) => fmtDateTime(v as string) },
  { key: 'days_since_last_touch', header: 'Days since last touch', align: 'right' },
  { key: 'stage_since', header: 'In stage since', render: (v) => fmtDateTime(v as string) },
  { key: 'touches_after_stage', header: 'Touches after stage', align: 'right' },
  { key: 'calls', header: 'Calls', align: 'right' },
  { key: 'last_call_at', header: 'Last call', render: (v) => fmtDateTime(v as string) },
  { key: 'last_call_reason', header: 'Last call reason' },
  { key: 'last_call_status', header: 'Last call status' },
  { key: 'tab_converted', header: 'Converted', render: yesNo },
  { key: 'converted_at', header: 'First payment' },
  { key: 'last_payment_date', header: 'Last payment' },
  { key: 'revenue', header: 'Revenue', render: (v) => fmtINR(v as number) },
  { key: 'courses', header: 'Course / batch' },
  { key: 'owner_name', header: 'Owner' },
  { key: 'lm_reason', header: 'LM reason' },
  { key: 'sf_is_converted', header: 'SF converted', render: yesNo },
  { key: 'is_duplicate', header: 'Duplicate', render: yesNo },
  { key: 'email', header: 'Email' },
];

/** columns of the Proposed fee / Fee received list: the money columns first */
export const FEE_COLS: Col<Row>[] = [
  { key: 'lead_name', header: 'Lead ID' },
  { key: 'eps_id', header: 'EPS ID', render: (v) => (v == null ? '–' : String(v)) },
  { key: 'first_name', header: 'Name', render: (v, r) => `${v ?? ''} ${r.last_name ?? ''}`.trim() || '–' },
  { key: 'mobile', header: 'Phone' },
  { key: 'payments_in_range', header: 'Payments (in range)', align: 'right' },
  { key: 'fee_received', header: 'Fee received (in range)', align: 'right', render: (v) => fmtINR(v as number) },
  { key: 'proposed_fee', header: 'Proposed fee', align: 'right', render: (v) => fmtINR(v as number) },
  { key: 'courses', header: 'Course / batch' },
  { key: 'converted_at', header: 'First payment' },
  { key: 'last_payment_date', header: 'Last payment' },
  { key: 'revenue', header: 'Paid (all time)', align: 'right', render: (v) => fmtINR(v as number) },
  { key: 'lead_stage', header: 'Stage' },
  { key: 'class_raw', header: 'Class' },
  { key: 'lead_source', header: 'Primary source' },
  { key: 'lead_created_date', header: 'Created' },
  { key: 'n_touches_all', header: 'Touches (all)', align: 'right' },
  { key: 'last_touch_point', header: 'Last valid touch' },
  { key: 'owner_name', header: 'Owner' },
  { key: 'last_call_at', header: 'Last call', render: (v) => fmtDateTime(v as string) },
  { key: 'last_call_reason', header: 'Last call reason' },
];

/** columns of the New leads list (lead grain; touches and purchases are all-time) */
export const NEW_LEAD_COLS: Col<Row>[] = [
  { key: 'lead_name', header: 'Lead ID' },
  { key: 'eps_id', header: 'EPS ID', render: (v) => (v == null ? '–' : String(v)) },
  { key: 'first_name', header: 'Name', render: (v, r) => `${v ?? ''} ${r.last_name ?? ''}`.trim() || '–' },
  { key: 'mobile', header: 'Phone' },
  { key: 'lead_created_date', header: 'Created' },
  { key: 'lead_stage', header: 'Stage' },
  { key: 'best_ic_status', header: 'IC status' },
  { key: 'class_raw', header: 'Class' },
  { key: 'lead_source', header: 'Primary source' },
  { key: 'n_touches_all', header: 'Touches (all)', align: 'right' },
  { key: 'touch_points', header: 'Touch points' },
  { key: 'first_touch_any', header: 'First touch', render: (v) => fmtDateTime(v as string) },
  { key: 'last_touch_any', header: 'Last touch', render: (v) => fmtDateTime(v as string) },
  { key: 'days_since_last_touch', header: 'Days since last touch', align: 'right' },
  { key: 'calls', header: 'Calls', align: 'right' },
  { key: 'last_call_at', header: 'Last call', render: (v) => fmtDateTime(v as string) },
  { key: 'last_call_reason', header: 'Last call reason' },
  { key: 'last_call_status', header: 'Last call status' },
  { key: 'converted', header: 'Purchased', render: yesNo },
  { key: 'converted_at', header: 'First payment' },
  { key: 'last_payment_date', header: 'Last payment' },
  { key: 'revenue', header: 'Revenue', render: (v) => fmtINR(v as number) },
  { key: 'courses', header: 'Course / batch' },
  { key: 'owner_name', header: 'Owner' },
  { key: 'lm_reason', header: 'LM reason' },
  { key: 'sf_is_converted', header: 'SF converted', render: yesNo },
];
export const NEW_LEAD_SORTS: [string, string][] = [['created_date', 'Created'], ['n_touches_all', 'Touches (all)'], ['last_touch_any', 'Last touch'], ['converted_at', 'First payment'], ['last_payment_date', 'Last payment'], ['revenue', 'Revenue'], ['lead_name', 'Lead ID'], ['lead_stage', 'Stage'], ['class_raw', 'Class'], ['owner_name', 'Owner']];

/** Slide-over listing every lead behind a KPI / bar / slice / table row of the Overview. Click a row for the full lead record. */
export function DrillDrawer({ drill, onClose }: { drill: Drill; onClose: () => void }) {
  const { params, toggleValue } = useFilters();
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(50);
  const [sort, setSort] = useState<{ id: string; desc: boolean }>({ id: drill.defaultSort ?? 'touches_in_window', desc: true });
  const [search, setSearch] = useState('');
  const [leadId, setLeadId] = useState<string | null>(null);
  const [dl, setDl] = useState(false);
  const requestExport = useExportGate();
  const { user } = useAuth();
  const [view, setView] = useState<'summary' | 'list'>(drill.summary ? 'summary' : 'list');
  // a row picked on the summary narrows the drawer to that value (on top of the drill's own dim)
  const [pick, setPick] = useState<{ dim: string; value: string } | null>(null);
  const q = useDebounce(search, 300);
  useEffect(() => { setPage(1); }, [q, drill.metric, drill.dim, drill.value, pick]);
  useEffect(() => { setView(drill.summary ? 'summary' : 'list'); setPick(null); }, [drill]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !leadId) onClose(); }; document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k); }, [onClose, leadId]);

  const dim = pick?.dim ?? drill.dim; const value = pick?.value ?? drill.value;
  const base: Params = { ...params, ...(drill.extra ?? {}), metric: drill.metric, dim, value, q };
  const p: Params = { ...base, page, limit, sort: sort.id, dir: sort.desc ? 'desc' : 'asc' };
  const r = useApi<Resp>(drill.path ?? '/overview/leads', p, { placeholderData: (prev) => prev, enabled: view === 'list' });
  const cols = drill.columns ?? COLS;
  const noun = drill.noun ?? 'leads';
  const d = r.data?.data;
  const pages = d ? Math.max(1, Math.ceil(d.total / d.limit)) : 1;
  const dimLabel = dim ? (DIM_LABEL[dim] ?? EXTRA_LABEL[dim] ?? dim) : null;
  const canFilterPage = !!dim && value !== undefined && dim in DIM_LABEL;

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={onClose}>
      <div className="flex h-full w-full max-w-6xl flex-col overflow-hidden bg-surface shadow-pop" onClick={(e) => e.stopPropagation()}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-2">
              <h2 className="text-base font-extrabold tracking-tight">{drill.title}</h2>
              {dimLabel && <span className="chip"><b>{dimLabel}</b>: {value}{pick && <button className="ml-1 text-ink-3 hover:text-ink" title="Remove" onClick={() => setPick(null)}>×</button>}</span>}
              {view === 'list' && d && <span className="text-xs text-ink-3">{fmtInt(d.total)} {noun}</span>}
            </div>
            <div className="text-[11px] text-ink-3">{drill.subtitle ?? METRIC_LABEL[drill.metric]} · {view === 'summary' ? 'click a value to see those leads' : 'click a row for the full lead record'}{d?.masked ? ' · phone and email are masked on this public site' : ''}</div>
          </div>
          <div className="flex items-center gap-1.5">
            {(!drill.path || drill.summaryPath) && (
              <div className="inline-flex rounded-lg border border-line bg-surface-2 p-0.5 text-[11px] font-medium">
                <button className={`rounded-md px-2.5 py-1 ${view === 'summary' ? 'bg-surface text-accent shadow-sm' : 'text-ink-2 hover:text-ink'}`} onClick={() => setView('summary')}>Summary</button>
                <button className={`rounded-md px-2.5 py-1 ${view === 'list' ? 'bg-surface text-accent shadow-sm' : 'text-ink-2 hover:text-ink'}`} onClick={() => setView('list')}>All leads</button>
              </div>
            )}
            {view === 'list' && <input className="input w-56" placeholder="Search name, phone, LM-id…" value={search} onChange={(e) => setSearch(e.target.value)} />}
            {canFilterPage && (
              <button className="btn" title="Apply this value as a page filter" onClick={() => { toggleValue(dim as ListDim, value!); onClose(); }}><Icon.Plus /> Filter page by this</button>
            )}
            {canDownload(user?.role) && <button className="btn" disabled={dl} onClick={() => requestExport({ title: `${drill.title} · all rows`, run: async (pw) => { setDl(true); try { await downloadWithAuth(drill.csvPath ?? '/overview/leads.csv', { ...p, page: undefined, limit: undefined }, `${drill.title.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}.csv`, pw); } finally { setDl(false); } } })}>
              <Icon.Download /> {dl ? 'Preparing…' : 'CSV (all rows)'}
            </button>}
            <button className="btn btn-dark" onClick={onClose}><Icon.Close /> Close</button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden p-3">
          {view === 'summary' && <DrillSummary params={base} path={drill.summaryPath} onPick={(pd, pv) => { setPick({ dim: pd, value: pv }); setView('list'); }} />}
          {view === 'list' && r.error && <ErrorNote error={r.error} onRetry={r.refetch} />}
          {view === 'list' && !d && r.isLoading && <div className="space-y-2"><Skeleton /><Skeleton /><Skeleton className="h-64" /></div>}
          {view === 'list' && d && (
            <div className={`h-full ${r.isFetching ? 'opacity-70' : ''}`}>
              <DataTable rows={d.rows} columns={cols} compact maxHeight="100%" rowKey={(x) => String(x.lead_id ?? x.user_id)} onRowClick={(x) => { if (x.lead_id) setLeadId(String(x.lead_id)); }}
                initialSort={sort} />
            </div>
          )}
        </div>

        {view === 'list' && <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2 text-xs text-ink-2">
          <div className="flex items-center gap-2">
            <span>Sort</span>
            <select className="input !py-0.5" value={sort.id} onChange={(e) => setSort({ id: e.target.value, desc: sort.desc })}>
              {(drill.sortOptions ?? [['touches_in_window', 'Touches (window)'], ['n_touches_all', 'Touches (all)'], ['last_touch_in_window', 'Last touch'], ['created_date', 'Created'], ['converted_at', 'First payment'], ['last_payment_date', 'Last payment'], ['revenue', 'Revenue'], ['lead_name', 'Lead ID'], ['lead_stage', 'Stage'], ['class_raw', 'Class'], ['owner_name', 'Owner']]).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <button className="btn" onClick={() => setSort({ ...sort, desc: !sort.desc })}>{sort.desc ? '▼ desc' : '▲ asc'}</button>
            <select className="input !py-0.5" value={limit} onChange={(e) => { setLimit(Number(e.target.value)); setPage(1); }}>{[25, 50, 100, 200].map((n) => <option key={n} value={n}>{n} / page</option>)}</select>
          </div>
          <div className="flex items-center gap-1">
            <button className="btn" disabled={page <= 1} onClick={() => setPage(1)}>«</button>
            <button className="btn" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹</button>
            <span className="px-2 tabular-nums">page {page} / {pages}</span>
            <button className="btn" disabled={page >= pages} onClick={() => setPage(page + 1)}>›</button>
            <button className="btn" disabled={page >= pages} onClick={() => setPage(pages)}>»</button>
          </div>
        </div>}
      </div>
      {leadId && <LeadDrawer leadId={leadId} onClose={() => setLeadId(null)} />}
    </div>
  );
}
