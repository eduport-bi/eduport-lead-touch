import { useEffect } from 'react';
import { useApi } from '../lib/api';
import type { LeadDetail } from '../lib/types';
import { fmtDateTime, fmtINRfull, fmtInt, fmt2 } from '../lib/format';
import { Icon, Skeleton, ErrorNote } from './ui';

/** Slide-over with a lead's full touch timeline, ICs, payments and calls (every KPI drills down to this). */
export function LeadDrawer({ leadId, onClose }: { leadId: string; onClose: () => void }) {
  const q = useApi<LeadDetail>(`/leads/${leadId}`, {}, { staleTime: 60_000 });
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k); }, [onClose]);
  const d = q.data?.data;
  const l: Record<string, unknown> = d?.lead ?? {};
  const s = (k: string) => (l[k] == null ? '–' : String(l[k]));
  const facts: [string, string][] = d ? [
    ['Name', `${l.first_name ?? ''} ${l.last_name ?? ''}`.trim() || '–'], ['EPS ID', s('eps_id')],
    ['Created', fmtDateTime(l.created_at as string)], ['Source', s('lead_source')], ['Stage', s('lead_stage')], ['Class', `${s('class_group')} (${s('class_raw')})`],
    ['Owner', s('owner_name')], ['District / City', `${s('district')} / ${s('city')}`], ['Priority', s('priority')], ['Lead type', s('lead_type')],
    ['Mobile', s('mobile')], ['Email', s('email')],
    ['Converted', l.converted ? `yes · ${String(l.converted_at ?? '').slice(0, 10)} · ${s('days_to_convert')} days${l.pre_existing_customer ? ' · pre-existing customer' : ''}` : 'no'],
    ['Revenue', fmtINRfull(l.revenue as number)], ['Touches', `${s('total_touches')} total · ${s('valid_touches')} before payment`],
    ['SF flags', `Is_Converted__c=${s('sf_is_converted')} · Touch_Count__c=${s('sf_touch_count')} · duplicate=${s('is_duplicate')}`],
    ['LM reason', s('lm_reason')], ['Best IC status', s('best_ic_status')],
  ] : [];
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div className="flex h-full w-full max-w-3xl flex-col overflow-hidden border-l border-line bg-surface shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div>
            <div className="text-sm font-semibold">{s('lead_name')} <span className="ml-2 text-xs font-normal text-ink-3">{leadId}</span></div>
            <div className="text-xs text-ink-3">{!d ? 'loading…' : d.masked ? 'phone and email are masked on this public site' : 'full detail'}</div>
          </div>
          <button className="btn" onClick={onClose}><Icon.Close /> Close</button>
        </div>
        <div className="flex-1 space-y-4 overflow-auto p-4 text-xs">
          {q.isLoading && <div className="space-y-2"><Skeleton /><Skeleton /><Skeleton className="h-40" /></div>}
          {q.error && <ErrorNote error={q.error} onRetry={q.refetch} />}
          {d && (
            <>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 md:grid-cols-3">
                {facts.map(([k, v]) => <div key={k}><dt className="text-[10px] uppercase tracking-wide text-ink-3">{k}</dt><dd className="truncate" title={v}>{v}</dd></div>)}
              </dl>

              <Section title={`Touch timeline (${d.touches.length})`}>
                <ol className="relative ml-2 border-l border-line pl-4">
                  {d.touches.map((t) => (
                    <li key={String(t.touch_id)} className={`relative mb-2 ${t.is_pre_conversion ? '' : 'opacity-60'}`}>
                      <span className={`absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full border-2 border-surface ${t.is_first_touch ? 'bg-[#1baf7a]' : t.is_last_touch ? 'bg-[#eb6834]' : 'bg-accent'}`} />
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-medium">{fmtDateTime(t.touch_at as string)}</span>
                        <span className="chip">{String(t.touch_point)}</span>
                        <span className="text-ink-2">{String(t.source)}{t.medium != null && t.medium !== '(blank)' ? ` · ${String(t.medium)}` : ''}{t.campaign != null && t.campaign !== '(blank)' ? ` · ${String(t.campaign)}` : ''}</span>
                        {t.staff != null && <span className="text-ink-3">staff: {String(t.staff)}</span>}
                        {!t.is_pre_conversion && <span className="text-[#d03b3b]">after payment</span>}
                        {!!t.is_first_touch && <span className="text-[#1baf7a]">first</span>}{!!t.is_last_touch && <span className="text-[#eb6834]">last</span>}
                        {t.gap_hours_from_prev != null && <span className="text-ink-3">+{fmt2(Number(t.gap_hours_from_prev))} h</span>}
                        {Number(t.credit_linear) > 0 && <span className="text-ink-3">credit L {fmt2(Number(t.credit_linear))} · P {fmt2(Number(t.credit_position))}</span>}
                      </div>
                    </li>
                  ))}
                  {d.touches.length === 0 && <li className="text-ink-3">No touches</li>}
                </ol>
              </Section>

              <Section title={`Interested courses (${d.ics.length})`}>
                <SimpleTable rows={d.ics} cols={['course_name', 'status', 'is_enrolled', 'ic_created_at']} />
              </Section>
              <Section title={`Payments (${d.payments.length} · ${d.payments.filter((p) => p.counted).length} counted as valid)`}>
                <div className="mb-1 text-[10px] text-ink-3">Every successful payment of the accounts on this number, app and Ujra. Converted / revenue count only app payment method 0 and Ujra (counted = yes); other methods are listed for the full history.</div>
                <SimpleTable rows={d.payments} cols={['payment_date', 'method', 'counted', 'course', 'batch', 'amount', 'discount', 'refund_amount', 'total', 'batch_id', 'sales_person_id']} />
              </Section>
              <Section title={d.call_summary ? `Calls (${fmtInt(Number(d.call_summary.calls))} since May 2026)` : 'Calls'}>
                {d.call_summary ? (
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1 md:grid-cols-4">
                    <div><dt className="text-[10px] uppercase tracking-wide text-ink-3">Last call</dt><dd>{fmtDateTime(d.call_summary.last_call_at as string)}</dd></div>
                    <div><dt className="text-[10px] uppercase tracking-wide text-ink-3">Last reason</dt><dd>{(d.call_summary.last_reason as string) ?? '–'}</dd></div>
                    <div><dt className="text-[10px] uppercase tracking-wide text-ink-3">Call status</dt><dd>{(d.call_summary.last_call_status as string) ?? '–'}</dd></div>
                    <div><dt className="text-[10px] uppercase tracking-wide text-ink-3">Called by</dt><dd>{(d.call_summary.last_owner as string) ?? '–'}</dd></div>
                    <div className="col-span-2 md:col-span-4"><dt className="text-[10px] uppercase tracking-wide text-ink-3">Executive's comment on the last call</dt><dd className="whitespace-pre-wrap rounded-lg bg-surface-2 px-2 py-1">{(d.call_summary.last_comment as string) || '–'}</dd></div>
                    <div><dt className="text-[10px] uppercase tracking-wide text-ink-3">First call</dt><dd>{fmtDateTime(d.call_summary.first_call_at as string)}</dd></div>
                  </dl>
                ) : <div className="text-ink-3">No call logged since May 2026</div>}
              </Section>
              {d.siblings.length > 0 && (
                <Section title={`Other leads of the same person (${d.siblings.length})`}>
                  <SimpleTable rows={d.siblings} cols={['lead_name', 'mobile', 'matched_on', 'created_date', 'lead_source', 'lead_stage', 'is_duplicate', 'converted']} />
                </Section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section><h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">{title}</h4>{children}</section>;
}
function SimpleTable({ rows, cols }: { rows: Record<string, unknown>[]; cols: string[] }) {
  if (!rows.length) return <div className="text-ink-3">None</div>;
  return (
    <div className="overflow-auto rounded border border-line">
      <table className="w-full"><thead><tr>{cols.map((c) => <th key={c} className="th !static">{c}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{cols.map((c) => <td key={c} className="td !py-1 text-xs">{fmtCell(r[c])}</td>)}</tr>)}</tbody></table>
    </div>
  );
}
const fmtCell = (v: unknown) => (v == null ? '–' : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : typeof v === 'number' ? fmtInt(v) : /^\d{4}-\d{2}-\d{2}T/.test(String(v)) ? fmtDateTime(String(v)) : String(v));
