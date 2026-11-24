import { useState } from 'react';
import { useApi, downloadWithAuth } from '../lib/api';
import { useFilters } from '../lib/filters';
import type { LeadsResponse, LeadRow } from '../lib/types';
import { fmtDateTime, fmtINRfull, fmtInt, fmtPct } from '../lib/format';
import { DataTable } from '../components/DataTable';
import { Icon, Note, PageHeader, Skeleton, useDebounce } from '../components/ui';
import { LeadDrawer } from '../components/LeadDrawer';
import { useExportGate } from '../lib/exportGate';

const SORTS = [['created_at', 'Created'], ['last_call_at', 'Last call'], ['calls', 'Calls'],['converted_at', 'Converted at'], ['revenue', 'Revenue'], ['total_touches', 'Touches'], ['days_to_convert', 'Days to convert'], ['response_hours', 'Response time'], ['last_touch_any_at', 'Last touch'], ['lead_name', 'Name']];

export default function LeadExplorer() {
  const requestExport = useExportGate();
  const { params } = useFilters();
  const [q, setQ] = useState('');
  const dq = useDebounce(q, 350);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(50);
  const [sort, setSort] = useState('created_at');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [open, setOpen] = useState<string | null>(null);
  const res = useApi<LeadsResponse>('/leads', { ...params, q: dq, page, limit, sort, dir }, { staleTime: 60_000 });
  const d = res.data?.data;
  const pages = d ? Math.max(1, Math.ceil(d.total / d.limit)) : 1;
  return (
    <div className="space-y-3">
      <PageHeader title="Lead explorer" subtitle={d ? `${fmtInt(d.total)} leads match · ${d.masked ? 'phone/email masked' : 'full details'}` : 'loading…'}
        right={<button className="btn" title="Server-streamed CSV of the current view (capped at 50,000 rows)" onClick={() => requestExport({ title: `Lead explorer · leads_${params.from}_${params.to}.csv`, run: (pw) => downloadWithAuth('/leads/export.csv', { ...params, q: dq, sort, dir }, `leads_${params.from}_${params.to}.csv`, pw) })}><Icon.Download /> Export CSV</button>} />
      <div className="flex flex-wrap items-center gap-2">
        <input className="input w-72" placeholder="Search name, LM-number, phone (≥5 digits), email…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        <select className="input" value={sort} onChange={(e) => setSort(e.target.value)}>{SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <button className="btn" onClick={() => setDir((x) => (x === 'asc' ? 'desc' : 'asc'))}>{dir === 'asc' ? '↑ asc' : '↓ desc'}</button>
        <select className="input" value={limit} onChange={(e) => { setLimit(Number(e.target.value)); setPage(1); }}>{[25, 50, 100, 200].map((n) => <option key={n} value={n}>{n} / page</option>)}</select>
        <span className="ml-auto flex items-center gap-1 text-xs text-ink-3">page {page} / {pages}
          <button className="btn" disabled={page <= 1} onClick={() => setPage(1)}>«</button><button className="btn" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>‹</button>
          <button className="btn" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>›</button><button className="btn" disabled={page >= pages} onClick={() => setPage(pages)}>»</button></span>
      </div>
      {res.error && <Note>⚠ {res.error.message}</Note>}
      {res.isLoading ? <Skeleton className="h-96" /> : (
        <DataTable<LeadRow> rows={d?.rows ?? []} compact maxHeight="calc(100vh - 260px)" rowKey={(r) => r.lead_id} onRowClick={(r) => setOpen(r.lead_id)} highlight={(r) => !!r.pre_existing_customer}
          columns={[
            { key: 'lead_name', header: 'Lead' }, { key: 'created_at', header: 'Created', render: (v) => fmtDateTime(v as string) }, { key: 'first_name', header: 'Name' }, { key: 'mobile', header: 'Mobile' },
            { key: 'lead_source', header: 'Source' }, { key: 'lead_stage', header: 'Stage' }, { key: 'class_group', header: 'Class' }, { key: 'district', header: 'District' }, { key: 'owner_name', header: 'Owner' },
            { key: 'last_call_at', header: 'Last call', render: (v) => fmtDateTime(v as string) }, { key: 'last_call_reason', header: 'Last call reason' }, { key: 'calls', header: 'Calls' },
            { key: 'total_touches', header: 'Touches' }, { key: 'valid_touches', header: 'Pre-pay touches' }, { key: 'first_touch_point', header: 'First touch' }, { key: 'last_touch_point', header: 'Last touch' },
            { key: 'response_hours', header: 'Response (h)' }, { key: 'converted', header: 'Conv.', render: (v) => (v ? '✓' : '') }, { key: 'converted_at', header: 'Converted at' }, { key: 'days_to_convert', header: 'Days' },
            { key: 'revenue', header: 'Revenue', render: (v) => fmtINRfull(v as number) }, { key: 'priority', header: 'Priority' }, { key: 'best_ic_status', header: 'IC status' },
            { key: 'is_duplicate', header: 'Dup' }, { key: 'sf_is_converted', header: 'SF conv flag' },
          ]} />
      )}
      <div className="text-[11px] text-ink-3">Rows highlighted amber are pre-existing customers (payment before lead creation). Conversion % of this view: {d && d.total ? fmtPct(((d.rows.filter((r) => r.converted).length) / d.rows.length) * 100) : '–'} (this page only). Click a row for the full touch timeline, ICs, payments and calls. This page lists every lead in the database regardless of the date range at the top; the Class / Touch point / Lead source / Campaign pickers, Add filter and the search box narrow it down.</div>
      {open && <LeadDrawer leadId={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
