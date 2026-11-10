import { useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { authHeaders } from '../lib/api';
import { downloadText, fmtDateTime, fmtINR, fmtInt, fmtPct, toCsv } from '../lib/format';
import { DataTable, type Col } from '../components/DataTable';
import { LeadDrawer } from '../components/LeadDrawer';
import { Icon, Note, PageHeader, Segmented, Skeleton } from '../components/ui';
import { ChartCard } from '../components/ChartCard';
import { HBars } from '../charts';
import { useExportGate, verifyExportPassword } from '../lib/exportGate';
import { useAuth, canDownload } from '../lib/auth';

type Row = Record<string, unknown>;
interface Parsed { headers: string[]; rows: Row[]; fileName: string; sheet: string }

const CHUNK = 1000;
/** cell -> text. Numbers are printed in full: Excel shows a 12-digit phone stored as a number as 9.19948E+11 and the sheet's formatted
 *  text would keep that, losing the digits; the raw value is an exact integer. */
const cellText = (v: unknown): unknown => (typeof v === 'number' && Number.isFinite(v) ? (Math.abs(v) >= 1e6 ? Math.round(v).toString() : String(v)) : v);
const normalise = (v: unknown): string | null => { const d = String(cellText(v) ?? '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : null; };
const looksLikePhone = (name: string) => /phone|mobile|contact|number|whatsapp|ph\b/i.test(name);

/** The page is unmounted when another menu opens, which would drop the uploaded file and its results. Its state lives in this
 *  module-level store instead (plain memory, nothing written to disk or storage): it survives menu switches and is gone when the
 *  browser tab is closed or reloaded. */
const kept = new Map<string, unknown>();
function useKept<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [v, setV] = useState<T>(() => (kept.has(key) ? (kept.get(key) as T) : initial));
  const set: Dispatch<SetStateAction<T>> = (next) => setV((cur) => { const n = typeof next === 'function' ? (next as (c: T) => T)(cur) : next; kept.set(key, n); return n; });
  return [v, set];
}

/** Analysis: upload a spreadsheet with phone numbers, get every lead detail back. Parsed in the browser, nothing is stored anywhere. */
export default function Analysis() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useKept<Parsed | null>('parsed', null);
  const [phoneCol, setPhoneCol] = useKept<string>('phoneCol', '');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useKept<Row[] | null>('results', null);
  const [view, setView] = useKept<'all' | 'matched' | 'unmatched' | 'converted' | 'multi'>('view', 'all');
  const [stages, setStages] = useKept<string[]>('stages', []);
  const [ay, setAy] = useKept<{ kind: 'converted_academic_year' | 'last_paid_academic_year'; year: string } | null>('ay', null);
  const requestExport = useExportGate();
  const { user: me } = useAuth();
  const [leadId, setLeadId] = useState<string | null>(null);

  const onFile = async (file: File) => {
    setError(null); setResults(null); setBusy('Reading file…');
    try {
      const XLSX = await import('xlsx');
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const sheet = wb.SheetNames[0];
      // raw values (not Excel's display text): a phone stored as a number would otherwise arrive as "9.19948E+11"
      const grid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheet], { header: 1, defval: null, raw: true })
        .map((r) => r.map(cellText)).filter((r) => r.some((v) => v != null && v !== ''));
      if (!grid.length) throw new Error('The first sheet is empty');
      const width = Math.max(...grid.map((r) => r.length));
      // header row = the first row, unless it already holds a phone number (10+ digits): then there is no header, the columns are
      // named Phone, Column B, Column C, ... and that first row is looked up too
      const noHeader = grid[0].some((v) => /\d{10,}/.test(String(v ?? '').replace(/\D/g, '')));
      const headers = noHeader
        ? Array.from({ length: width }, (_, i) => (i === 0 ? 'Phone' : `Column ${String.fromCharCode(65 + i)}`))
        : Array.from({ length: width }, (_, i) => { const h = String(grid[0][i] ?? '').trim(); return h || `Column ${String.fromCharCode(65 + i)}`; });
      const rows: Row[] = (noHeader ? grid : grid.slice(1)).map((r) => Object.fromEntries(headers.map((n, i) => [n, r[i] ?? null])) as Row);
      if (!rows.length) throw new Error('The first sheet has a header row but no data');
      // pick the phone column: header name first, otherwise the column with most phone-looking values
      let best = headers.find(looksLikePhone) ?? '';
      if (!best) {
        let bestN = 0;
        for (const h of headers) { const n = rows.slice(0, 200).filter((r) => normalise(r[h])).length; if (n > bestN) { bestN = n; best = h; } }
      }
      setParsed({ headers, rows, fileName: file.name, sheet });
      setPhoneCol(best);
    } catch (e) { setError((e as Error).message); setParsed(null); }
    finally { setBusy(null); }
  };

  const phones = useMemo(() => {
    if (!parsed || !phoneCol) return [] as string[];
    return [...new Set(parsed.rows.map((r) => normalise(r[phoneCol])).filter((x): x is string => !!x))];
  }, [parsed, phoneCol]);
  const invalid = parsed && phoneCol ? parsed.rows.filter((r) => !normalise(r[phoneCol])).length : 0;

  const run = async () => {
    if (!parsed || !phones.length) return;
    setBusy(`Looking up ${fmtInt(phones.length)} numbers…`); setError(null); setResults(null);
    try {
      const out: Row[] = [];
      for (let i = 0; i < phones.length; i += CHUNK) {
        setBusy(`Looking up numbers ${fmtInt(i + 1)} to ${fmtInt(Math.min(i + CHUNK, phones.length))} of ${fmtInt(phones.length)}…`);
        const res = await fetch('/api/analysis/phones', { method: 'POST', headers: { 'content-type': 'application/json', ...(await authHeaders()) }, body: JSON.stringify({ phones: phones.slice(i, i + CHUNK) }) });
        const body = (await res.json()) as { data?: { rows: Row[] }; error?: { message: string } };
        if (!res.ok || !body.data) throw new Error(body.error?.message ?? res.statusText);
        out.push(...body.data.rows);
      }
      // attach the original spreadsheet columns to each result row (first input row per phone)
      const byPhone = new Map<string, Row>();
      for (const r of parsed.rows) { const k = normalise(r[phoneCol]); if (k && !byPhone.has(k)) byPhone.set(k, r); }
      const extra = parsed.headers.filter((h) => h !== phoneCol);
      // results in the order of the uploaded file (the API answers sorted by number); a number with several leads keeps them together, newest lead first
      const order = new Map(phones.map((k, i) => [k, i]));
      out.sort((x, y) => (order.get(String(x.phone_key)) ?? 1e9) - (order.get(String(y.phone_key)) ?? 1e9));
      setStages([]); setAy(null);
      setResults(out.map((r) => { const src = byPhone.get(String(r.phone_key)) ?? {}; const o: Row = { input_phone: src[phoneCol] ?? r.phone_key, ...r }; for (const h of extra) o[`file: ${h}`] = src[h]; return o; }));
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };

  const summary = useMemo(() => {
    if (!results) return null;
    const phonesSeen = new Set(results.map((r) => r.phone_key));
    const matchedPhones = new Set(results.filter((r) => r.matched).map((r) => r.phone_key));
    const leads = results.filter((r) => r.matched);
    const converted = new Set(results.filter((r) => r.converted).map((r) => r.phone_key));
    const revenue = [...new Map(results.filter((r) => r.converted).map((r) => [r.phone_key, Number(r.revenue) || 0])).values()].reduce((a, b) => a + b, 0);
    // numbers that own more than one lead record (duplicates in Salesforce)
    const perPhone = new Map<string, number>();
    for (const r of leads) perPhone.set(String(r.phone_key), (perPhone.get(String(r.phone_key)) ?? 0) + 1);
    const multiPhones = [...perPhone.entries()].filter(([, n]) => n > 1);
    const multiLeads = multiPhones.reduce((a, [, n]) => a + n, 0);
    // converted numbers split by academic year (first valid payment = converted in; latest valid payment = last paid), one count per number
    const split = (key: 'converted_academic_year' | 'last_paid_academic_year') => {
      const m = new Map<string, Set<string>>();
      for (const r of results) if (r.converted) { const y = (r[key] as string | null) || '(unknown)'; (m.get(y) ?? m.set(y, new Set()).get(y)!).add(String(r.phone_key)); }
      return [...m.entries()].map(([year, set]) => ({ year, n: set.size })).sort((a, b) => b.year.localeCompare(a.year));
    };
    return { phones: phonesSeen.size, matched: matchedPhones.size, leads: leads.length, converted: converted.size, revenue, multiPhones: multiPhones.length, multiLeads, maxLeads: Math.max(0, ...multiPhones.map(([, n]) => n)),
             byConvertedYear: split('converted_academic_year'), byLastPaidYear: split('last_paid_academic_year') };
  }, [results]);

  // lead stage of every lead record found (one row per lead); converted share inside each stage
  const stageRows = useMemo(() => {
    if (!results) return [];
    const m = new Map<string, { stage: string; leads: number; converted: number; phones: Set<string>; touches: number }>();
    for (const r of results) {
      if (!r.matched) continue;
      const k = (r.lead_stage as string | null) || '(no stage)';
      const e = m.get(k) ?? { stage: k, leads: 0, converted: 0, phones: new Set<string>(), touches: 0 };
      e.leads += 1; if (r.converted) e.converted += 1; e.phones.add(String(r.phone_key)); e.touches += Number(r.touches) || 0;
      m.set(k, e);
    }
    return [...m.values()].sort((a, b) => b.leads - a.leads).map((e) => ({ stage: e.stage, leads: e.leads, numbers: e.phones.size, converted: e.converted, conversion_pct: e.leads ? Math.round((e.converted / e.leads) * 10000) / 100 : 0, avg_touches: e.leads ? Math.round((e.touches / e.leads) * 10) / 10 : 0 }));
  }, [results]);
  const toggleStage = (k: string) => setStages((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]));

  const shown = useMemo(() => {
    if (!results) return [];
    let out = results;
    if (view === 'matched') out = out.filter((r) => r.matched);
    else if (view === 'unmatched') out = out.filter((r) => !r.matched);
    else if (view === 'converted') out = out.filter((r) => r.converted);
    else if (view === 'multi') { const n = new Map<string, number>(); for (const r of results) if (r.matched) n.set(String(r.phone_key), (n.get(String(r.phone_key)) ?? 0) + 1); out = out.filter((r) => r.matched && (n.get(String(r.phone_key)) ?? 0) > 1); }
    if (stages.length) out = out.filter((r) => r.matched && stages.includes((r.lead_stage as string | null) || '(no stage)'));
    if (ay) out = out.filter((r) => r.converted && ((r[ay.kind] as string | null) || '(unknown)') === ay.year);
    return out;
  }, [results, view, stages, ay]);

  const extraCols: Col<Row>[] = (parsed?.headers ?? []).filter((h) => h !== phoneCol).map((h) => ({ key: `file: ${h}`, header: `File · ${h}` }));
  const cols: Col<Row>[] = [
    { key: 'input_phone', header: 'Phone (file)' }, { key: 'matched', header: 'Lead found', render: (v) => (v ? 'Yes' : 'No') },
    { key: 'lead_name', header: 'Lead ID' }, { key: 'eps_id', header: 'EPS ID', render: (v) => (v == null ? '–' : String(v)) }, { key: 'has_app_account', header: 'App account', render: (v) => (v ? 'Yes' : 'No') },
    { key: 'first_name', header: 'Name', render: (v, r) => `${v ?? ''} ${r.last_name ?? ''}`.trim() || '–' }, { key: 'mobile', header: 'Mobile (Salesforce)' },
    { key: 'created_at', header: 'Created', render: (v) => fmtDateTime(v as string) }, { key: 'lead_stage', header: 'Stage' },
    { key: 'last_activity_at', header: 'Last activity', render: (v) => fmtDateTime(v as string) }, { key: 'last_activity_type', header: 'Activity type' }, { key: 'days_since_activity', header: 'Days since activity', align: 'right' }, { key: 'class_raw', header: 'Class' },
    { key: 'lead_source', header: 'Primary source' }, { key: 'owner_name', header: 'Owner' }, { key: 'district', header: 'District' }, { key: 'lm_reason', header: 'LM reason' }, { key: 'best_ic_status', header: 'IC status' },
    { key: 'touches', header: 'Touches', align: 'right' }, { key: 'first_touch_point', header: 'First touch' }, { key: 'last_touch_point', header: 'Last touch' },
    { key: 'last_touch_at', header: 'Last touch time', render: (v) => fmtDateTime(v as string) }, { key: 'days_since_last_touch', header: 'Days since touch', align: 'right' },
    { key: 'lm_last_activity_at', header: 'LM last activity', render: (v) => fmtDateTime(v as string) }, { key: 'ic_last_activity_at', header: 'IC last activity', render: (v) => fmtDateTime(v as string) }, { key: 'last_touch_staff', header: 'Last touch staff' },
    { key: 'touch_points', header: 'All touch points' }, { key: 'campaigns', header: 'Campaigns' },
    { key: 'converted', header: 'Converted', render: (v) => (v ? 'Yes' : 'No') }, { key: 'payments', header: 'Payments', align: 'right' }, { key: 'first_payment_date', header: 'First payment' }, { key: 'converted_academic_year', header: 'Converted in (academic year)' }, { key: 'last_payment_date', header: 'Last payment' }, { key: 'last_paid_academic_year', header: 'Last paid academic year' }, { key: 'academic_years', header: 'Academic years paid' },
    { key: 'revenue', header: 'Revenue', render: (v) => (v == null ? '–' : fmtINR(v as number)) }, { key: 'courses', header: 'Courses bought' },
    { key: 'sf_is_converted', header: 'SF converted flag', render: (v) => (v ? 'Yes' : 'No') }, { key: 'is_duplicate', header: 'Duplicate', render: (v) => (v ? 'Yes' : 'No') }, { key: 'lead_id', header: 'Salesforce Id' },
    ...extraCols,
  ];

  return (
    <div className="space-y-4">
      <PageHeader title="Analysis" subtitle="upload a spreadsheet with phone numbers and get every lead's details back · the file is read in your browser and nothing is stored · the upload and its results stay on this page until the tab is closed" />
      <div className="card text-xs leading-relaxed text-ink-2">
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">Before you upload</div>
        <ul className="list-disc space-y-1 pl-4">
          <li><b>Phone numbers in column A</b> of the first sheet, one per row, with a header such as <b>Phone</b>. Country code, spaces, dashes and +91 are fine: only the last 10 digits are used. If the file has several number columns you can pick the right one after the upload.</li>
          <li><b>Leads start on 1 January 2025, lead touches on 1 March 2026.</b> The dashboard holds every Salesforce lead created since 1 January 2025, plus older leads only if they had a lead touch or a payment. A number whose lead is older and was never touched comes back as <b>not in the dashboard database</b>, even though it exists in Salesforce.</li>
          <li><b>New activity brings a lead in.</b> As soon as an older lead gets a new lead touch it is picked up by the next sync (daily at 6 am, or when an admin presses Sync now) and will show here with its full history.</li>
          <li><b>Call reasons and comments</b> are available for calls logged since <b>1 May 2026</b>; stage-change dates since 1 March 2026.</li>
          <li>Payments are matched on the number, so a paying number shows as converted on every lead that shares it.</li>
          <li><b>Academic year</b> of a payment is the academic year set on the batch's course in the app (syllabus structure); when a course has none (Ujra programmes, older batches) the batch title, then the payment date (year starting in April) decide. "Converted in" is the year of the first valid payment, "Last paid" the year of the latest one.</li>
          <li><b>Last activity</b> = the latest of the lead's touches, logged calls and stage changes (LM activity) and of its interested courses' creation and status changes (IC activity); the type column says which one it was.</li>
        </ul>
      </div>

      <div className="card flex flex-wrap items-center gap-3">
        <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
        <button className="btn btn-dark" onClick={() => fileRef.current?.click()} disabled={!!busy}><Icon.Plus /> Choose Excel / CSV</button>
        <div className="rounded-2xl border-2 border-dashed border-line px-4 py-2 text-xs text-ink-3" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) onFile(f); }}>
          or drop the file here
        </div>
        {parsed && (
          <>
            <span className="chip"><b>{parsed.fileName}</b>&nbsp;· {fmtInt(parsed.rows.length)} rows · sheet "{parsed.sheet}"</span>
            <label className="flex items-center gap-1.5 text-xs text-ink-2">Phone column
              <select className="input !py-1" value={phoneCol} onChange={(e) => setPhoneCol(e.target.value)}>
                {parsed.headers.map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
            </label>
            <span className="text-xs text-ink-3">{fmtInt(phones.length)} unique valid numbers{invalid ? ` · ${fmtInt(invalid)} rows without a 10-digit number` : ''}</span>
            <button className="btn btn-primary" onClick={run} disabled={!!busy || !phones.length}><Icon.Chart /> Look up leads</button>
          </>
        )}
        {busy && <span className="text-xs text-ink-2">{busy}</span>}
        {error && <span className="text-xs text-red-500">⚠ {error}</span>}
      </div>

      {busy && !results && <Skeleton className="h-40" />}

      {summary && results && (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-6">
            {([
              ['Numbers in file', fmtInt(summary.phones), 'unique, valid · click to show all', 'all'],
              ['Leads found', fmtInt(summary.matched), `${fmtPct(summary.phones ? Math.round((summary.matched / summary.phones) * 10000) / 100 : null)} of numbers · ${fmtInt(summary.leads)} lead records`, 'matched'],
              ['Not in the dashboard database', fmtInt(summary.phones - summary.matched), 'no lead here: created before Mar 2026 with no touch, or not in Salesforce', 'unmatched'],
              ['Numbers with several leads', fmtInt(summary.multiPhones), summary.multiPhones ? `${fmtInt(summary.multiLeads)} lead records on these numbers (up to ${fmtInt(summary.maxLeads)} per number) · ${fmtInt(summary.leads - summary.matched)} extra records in total` : 'every number has a single lead', 'multi'],
              ['Converted', fmtInt(summary.converted), `${fmtPct(summary.phones ? Math.round((summary.converted / summary.phones) * 10000) / 100 : null)} of numbers have a valid payment`, 'converted'],
              ['Revenue', fmtINR(summary.revenue), 'all valid payments of these numbers', 'converted'],
            ] as [string, string, string, typeof view][]).map(([t, v, sub, target]) => (
              <div key={t} role="button" tabIndex={0} className={`card !p-2.5 cursor-pointer text-left transition hover:border-accent/40 hover:shadow-pop ${t === 'Converted' ? 'col-span-2' : ''} ${view === target && t !== 'Revenue' ? 'border-accent ring-1 ring-accent/30' : ''}`} onClick={() => { setView(target); if (t !== 'Converted') setAy(null); }} onKeyDown={(e) => { if (e.key === 'Enter') setView(target); }} title="Click to filter the results">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-3">{t}</div><div className="text-xl font-semibold tabular-nums">{v}</div><div className="text-[10px] text-ink-3">{sub}</div>
                {t === 'Converted' && summary.converted > 0 && (
                  <div className="mt-1.5 space-y-1 border-t border-line pt-1.5">
                    {([['converted_academic_year', 'Converted in', summary.byConvertedYear], ['last_paid_academic_year', 'Last paid', summary.byLastPaidYear]] as const).map(([kind, label, rows]) => (
                      <div key={kind} className="flex flex-wrap items-center gap-1">
                        <span className="w-[72px] text-[10px] text-ink-3">{label}</span>
                        {rows.map((r) => {
                          const on = ay?.kind === kind && ay.year === r.year;
                          return (
                            <button key={r.year} className={`chip !py-0 text-[10px] ${on ? 'border-accent bg-accent/10 text-accent' : ''}`} title={`${label} ${r.year}: ${fmtInt(r.n)} numbers · click to filter the results`}
                              onClick={(e) => { e.stopPropagation(); setView('converted'); setAy(on ? null : { kind, year: r.year }); }}>
                              {r.year} <b className="tabular-nums">{fmtInt(r.n)}</b>
                            </button>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          <ChartCard title="Lead stage" tone="tone-blue" height={Math.max(150, Math.min(360, stageRows.length * 24 + 20))} rows={stageRows} fileName="analysis_lead_stage"
              subtitle={`${fmtInt(summary.leads)} lead records found in the file · bar = leads in that stage · click a bar to filter the results (multi-select)${stages.length ? ` · ${stages.length} selected` : ''}`}
              help={<div>Every lead found for the numbers in the file, counted by its current LM stage. The same number can have several leads, so the bars add up to the lead records, not to the numbers. "Converted" inside a stage means the lead's number has a valid payment in the app or in Ujra. Switch to the table (⊞) for numbers, converted share and average touches per stage.</div>}
              columns={[{ key: 'stage', header: 'Stage' }, { key: 'leads', header: 'Leads', align: 'right' }, { key: 'numbers', header: 'Numbers', align: 'right' }, { key: 'converted', header: 'Converted', align: 'right' }, { key: 'conversion_pct', header: 'Conversion %', align: 'right', render: (v) => fmtPct(v as number) }, { key: 'avg_touches', header: 'Avg touches', align: 'right' }]}
              empty={!stageRows.length} emptyHint="No leads found for these numbers"
              actions={stages.length ? <button className="btn" onClick={() => setStages([])}>Clear stages</button> : null}>
              <HBars data={stageRows.map((r) => ({ key: r.stage, value: r.leads, secondary: r.conversion_pct, selected: stages.includes(r.stage), extra: { Converted: fmtInt(r.converted), Numbers: fmtInt(r.numbers), 'Avg touches': r.avg_touches } }))} valueLabel="Leads" secondaryLabel="Converted" onClick={toggleStage} colorful />
          </ChartCard>

          <div className="card flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <h3 className="text-xs font-bold">Results</h3>
                <Segmented size="xs" value={view} onChange={setView} options={[{ value: 'all', label: `All (${fmtInt(results.length)})` }, { value: 'matched', label: 'Leads found' }, { value: 'unmatched', label: 'Not found' }, { value: 'converted', label: 'Converted' }, { value: 'multi', label: 'Several leads' }]} />
                {stages.length > 0 && <button className="chip" onClick={() => setStages([])} title="Clear the stage filter">Stage: {stages.join(', ')} ×</button>}
                {ay && <button className="chip" onClick={() => setAy(null)} title="Clear the academic-year filter">{ay.kind === 'converted_academic_year' ? 'Converted in' : 'Last paid'}: {ay.year} ×</button>}
                <span className="text-[11px] text-ink-3">one row per lead · a number with several leads appears more than once · click a row for the full record</span>
              </div>
              {canDownload(me?.role) && <button className="btn" onClick={() => { const file = `analysis_${(parsed?.fileName ?? 'phones').replace(/\.[^.]+$/, '')}.csv`; requestExport({ title: `${file} · ${fmtInt(shown.length)} rows`, run: async (pw) => { await verifyExportPassword(pw, file); downloadText(file, toCsv(shown as Record<string, unknown>[], cols.map((c) => String(c.key)))); } }); }}><Icon.Download /> CSV ({fmtInt(shown.length)} rows)</button>}
            </div>
            <div style={{ height: 520 }}>
              <DataTable rows={shown} columns={cols} compact maxHeight="100%" rowKey={(r) => `${r.phone_key}-${r.lead_id ?? 'x'}`} onRowClick={(r) => { if (r.lead_id) setLeadId(String(r.lead_id)); }} />
            </div>
          </div>
        </>
      )}

      {leadId && <LeadDrawer leadId={leadId} onClose={() => setLeadId(null)} />}
      <Note>How it works: the spreadsheet is opened in your browser only. Phone numbers are normalised to their last 10 digits and sent to the dashboard's API in batches of 1,000, which looks them up in the same lead, payment and touch data as the rest of the dashboard and answers immediately. Neither the file nor the results are written to the database, so nothing needs deleting and no storage is used. Each lead sharing a number is returned; payments belong to the number, so they repeat on every lead of that number. Coverage: leads created since 1 January 2025 and older leads with a touch or a payment; touches since 1 March 2026; see the notes above the upload button.</Note>
    </div>
  );
}
