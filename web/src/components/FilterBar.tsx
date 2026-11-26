import { useState, type MouseEvent, type ReactNode } from 'react';
import { DIM_LABEL, FILTER_MENU, PRESETS, useFilters, type Basis, type ListDim } from '../lib/filters';
import { Icon, Popover, Toggle } from './ui';
import { MultiSelect } from './MultiSelect';
import { FilterViews, SaveView } from './FilterViews';

/** mode "payment": the range IS the payment date (Converted page) - no basis switch, no second payment window */
/** Always-visible pickers on the bar (multi-select). Rows clicked in any card write the same state, so they show up here too. */
const QUICK: { key: ListDim; label: string }[] = [
  { key: 'class_group', label: 'Class' }, { key: 'touch_point', label: 'Touch point' }, { key: 'lead_source', label: 'Lead source' }, { key: 'campaign', label: 'Campaign' }, { key: 'medium', label: 'Medium' },
];
// Converted page (mode payment, 2026-11-25): its Class picker lists the core grade titles of the batch bought (purchased_grade); the lead Class
// does not filter that page, so the Lead class / Purchased class switch and the match tick box are not shown there
const QUICK_PAYMENT: { key: ListDim; label: string }[] = [{ key: 'purchased_grade', label: 'Class' }, ...QUICK.slice(1)];
const QUICK_KEYS = new Set<string>([...QUICK.map((q) => q.key), 'purchased_grade']);

/** One box of the pane (2026-11-26): small label on top, the value / control below; every box the same height. Width = its contents plus an
 *  equal share of the row's spare width (flex 1 1 auto), so no box is mostly empty and every row is full. The label line (16 px) and the
 *  value line (24 px) have FIXED heights and start at the same offset in every box, so labels and values line up across the whole grid. */
function Cell({ label, children, span, onClick, active, title, disabled }: { label: ReactNode; children: ReactNode; span?: string; onClick?: () => void; active?: boolean; title?: string; disabled?: boolean }) {
  const cls = `flex h-[58px] min-w-[7.5rem] flex-col justify-start gap-1 rounded-lg border bg-surface px-3 py-2 text-left ${active ? 'border-accent/60' : 'border-line'} ${disabled ? 'opacity-50' : ''} ${span ?? 'flex-auto'}`;
  const inner = (
    <>
      <span className={`flex h-4 items-center text-[10px] font-semibold uppercase leading-none tracking-wider text-ink-3`}>{label}</span>
      <span className="flex h-6 min-w-0 items-center gap-2 whitespace-nowrap text-[13px] leading-none text-ink">{children}</span>
    </>
  );
  return onClick
    ? <button type="button" className={`${cls} transition hover:border-accent/40`} onClick={onClick} title={title} disabled={disabled}>{inner}</button>
    : <div className={cls} title={title}>{inner}</div>;
}
/** two-option switch in the pane's value line: 24 px high, the same 13 px text as every value, selected = white on orange */
function Seg<T extends string>({ value, onChange, options, stretch }: { value: T; onChange: (v: T) => void; options: { value: T; label: string; title?: string }[]; stretch?: boolean }) {
  return (
    <span className={`${stretch ? 'flex w-full' : 'inline-flex'} h-6 shrink-0 rounded-md bg-surface-2 p-0.5`}>
      {options.map((o) => (
        <button key={o.value} type="button" title={o.title} onClick={() => onChange(o.value)}
          className={`${stretch ? 'flex-1' : ''} rounded px-3 text-[13px] leading-none transition ${value === o.value ? 'bg-accent text-white shadow-sm' : 'text-ink-3 hover:text-ink'}`}>{o.label}</button>
      ))}
    </span>
  );
}
const valueText = (v: string[]) => (v.length === 0 ? 'All' : v.length <= 2 ? v.join(', ') : `${v.length} selected`);

export function FilterBar({ mode }: { mode?: 'payment' } = {}) {
  const { f, set, setList, clearAll, activeCount } = useFilters();
  const [openDim, setOpenDim] = useState<ListDim | null>(null);

  const chips: { label: string; onRemove: () => void }[] = [];
  for (const [k, vals] of Object.entries(f.lists)) if (vals?.length && !QUICK_KEYS.has(k) && !(k === 'class_group' && mode === 'payment')) chips.push({ label: `${DIM_LABEL[k] ?? k}: ${vals.length > 2 ? `${vals.slice(0, 2).join(', ')} +${vals.length - 2}` : vals.join(', ')}`, onRemove: () => setList(k as ListDim, []) });
  for (const [k, v] of Object.entries(f.flags)) if (v) chips.push({ label: `${DIM_LABEL[k] ?? k}: ${v === '1' ? 'yes' : 'no'}`, onRemove: () => set((p) => ({ ...p, flags: { ...p.flags, [k]: undefined } })) });
  const moreCount = FILTER_MENU.filter((m) => !QUICK_KEYS.has(m.key) && f.lists[m.key]?.length).length;
  const quick = mode === 'payment' ? QUICK_PAYMENT : QUICK;
  const picker = (qk: { key: ListDim; label: string }) => {
    const v = f.lists[qk.key] ?? [];
    return (
      <Cell key={qk.key} label={qk.label} active={v.length > 0} onClick={() => setOpenDim(qk.key)}
        title={v.length ? `${qk.label}: ${v.join(', ')}` : `Filter by ${qk.label.toLowerCase()} (multi-select)`}>
        <span className={`min-w-0 flex-1 truncate `}>{valueText(v)}</span><span className="text-ink-3"><Icon.Chevron open /></span>
      </Cell>
    );
  };
  // Date boxes read like every other box (2026-11-26): the range as one line of text plus an icon at the right; the date fields and presets
  // open in a popover, so no native date field sits in the pane
  const dateInput = 'h-8 w-full cursor-pointer rounded-md border border-line bg-surface px-2 text-[13px] text-ink outline-none focus:border-accent/60 [color-scheme:light] dark:[color-scheme:dark]';
  const openPicker = (e: MouseEvent<HTMLInputElement>) => { try { e.currentTarget.showPicker(); } catch { /* older browsers: typing still works */ } };
  // full dates, dd/mm/yyyy, each with its calendar icon: "01/03/2026 📅 → 26/11/2026 📅" (user, 2026-11-26)
  const fmtFull = (d: string) => { const [y, m, dd] = d.split('-'); return y && m && dd ? `${dd}/${m}/${y}` : d; };
  const presetLabel = PRESETS.find((p) => p.key === f.preset)?.label ?? 'Custom';
  // the parts of a date box (from, arrow, to, and the Created / Touch switch when given) are spread with EQUAL gaps across the box
  // (justify-between over siblings), so the spare width is shared evenly instead of piling up in one place. Clicks on the switch do not
  // open the date popover.
  const rangeTrigger = (from: string, to: string, title: string, extra?: ReactNode) => (
    <div role="button" tabIndex={0} className="flex h-6 w-full min-w-0 cursor-pointer items-center justify-between gap-3 whitespace-nowrap text-[13px] tabular-nums text-ink" title={title}>
      <span className="flex items-center gap-2">{fmtFull(from)}<span className="text-ink-3"><Icon.Calendar /></span></span>
      <span className="text-ink-3">→</span>
      <span className="flex items-center gap-2">{fmtFull(to)}<span className="text-ink-3"><Icon.Calendar /></span></span>
      {extra && <span className="flex cursor-default items-center gap-3" onClick={(e) => e.stopPropagation()}>{extra}</span>}
    </div>
  );
  const fromTo = (from: string, to: string, onFrom: (v: string) => void, onTo: (v: string) => void) => (
    <div className="grid grid-cols-2 gap-2">
      <label className="space-y-1"><span className="block text-[10px] font-semibold uppercase tracking-wider text-ink-3">From</span>
        <input type="date" className={dateInput} onClick={openPicker} value={from} max={to} onChange={(e) => onFrom(e.target.value)} /></label>
      <label className="space-y-1"><span className="block text-[10px] font-semibold uppercase tracking-wider text-ink-3">To</span>
        <input type="date" className={dateInput} onClick={openPicker} value={to} min={from} onChange={(e) => onTo(e.target.value)} /></label>
    </div>
  );

  const row = mode === 'payment' ? 'contents' : 'flex flex-wrap gap-2';
  return (
    <div className="sticky top-2 z-30 mb-4 rounded-xl border border-accent/15 bg-accent/5 p-2 shadow-card backdrop-blur">
      {/* Labelled boxes (user layout, 2026-11-26): label on top, value below, all the same height; + and ✕ at the right.
          Rows: Overview etc. = dates, payment date, class | the pickers, views, default. Converted = one row. Each row is full. */}
      <div className="flex gap-2">
        <div className={`flex min-w-0 flex-1 gap-2 ${mode === 'payment' ? 'flex-wrap' : 'flex-col'}`}>
        <div className={row}>
          {/* label = "Dates · Last 30 days", value = the range; presets and the two dates open in a popover */}
          <Cell title={mode === 'payment' ? 'On this page the date range is the payment date; touch dates are not checked' : undefined}
            label={<>{mode === 'payment' ? 'Payment date' : 'Dates'}<span className="ml-1.5 font-normal normal-case tracking-normal">· {presetLabel}</span></>}>
            <div className="min-w-0 flex-1">
            {/* what the dates are (Created / Touch) sits inside the Dates box, spaced like the dates */}
            <Popover width="w-[400px]" block trigger={rangeTrigger(f.from, f.to, 'Change the dates', mode === 'payment' ? undefined : <>
              <span className="h-5 w-px shrink-0 bg-line" />
              <Seg<Basis> value={f.basis} onChange={(basis) => set({ basis })}
                options={[{ value: 'created', label: 'Created', title: 'Dates are the lead created date: leads created in the range (with all their touches)' }, { value: 'touch', label: 'Touch', title: 'Dates are the touch date: touches dated in the range' }]} />
            </>)}>
              {(close) => (
                <div className="space-y-3 text-xs">
                  {/* 8 presets + Custom = 3 × 3; Custom keeps the dates and lets you pick them below */}
                  <div className="grid grid-cols-3 gap-1.5">
                    {PRESETS.map((p) => (
                      <button key={p.key} type="button" title={p.key === 'custom' ? 'Pick your own From and To dates below' : p.label}
                        onClick={() => { if (p.key === 'custom') { set({ preset: 'custom' }); return; } const [from, to] = p.range(); set({ preset: p.key, from, to }); close(); }}
                        className={`truncate rounded-md border px-2.5 py-1.5 text-left text-[13px] ${f.preset === p.key ? 'border-accent/60 text-ink' : 'border-line text-ink-2 hover:border-accent/40 hover:text-ink'}`}>{p.label.replace(' (Apr-Mar)', '')}</button>
                    ))}
                  </div>
                  {fromTo(f.from, f.to, (from) => set({ preset: 'custom', from }), (to) => set({ preset: 'custom', to }))}
                </div>
              )}
            </Popover>
            </div>
          </Cell>
          {mode !== 'payment' && <>
            {/* the on/off switch sits in the label line; when on, the value is the range, which opens the two dates */}
            <Cell active={f.pay} title="When on, Converted counts only valid payments dated inside this second window"
              label={<span className="flex w-full items-center justify-between">Payment date<Toggle checked={f.pay} onChange={(pay) => set({ pay })} label="" /></span>}>
              {f.pay ? (
                <Popover width="w-72" block trigger={rangeTrigger(f.pfrom, f.pto, 'Change the payment dates')}>
                  {fromTo(f.pfrom, f.pto, (pfrom) => set({ pfrom }), (pto) => set({ pto }))}
                </Popover>
              ) : <span className="text-ink-3">Off</span>}
            </Cell>
          </>}
          {mode === 'payment' ? picker(quick[0]!) : (() => {
            // ONE Class card (2026-11-26): the class picker, what the class means (lead / purchased) and the match tick box, side by side
            const v = f.lists.class_group ?? [];
            return (
              <Cell key="class" label="Class" active={v.length > 0 || f.classMatch}>
                <button type="button" className="flex h-6 min-w-0 flex-1 items-center justify-between gap-1"
                  onClick={() => setOpenDim('class_group')} title={v.length ? `Class: ${v.join(', ')}` : 'Filter by class (multi-select)'}>
                  <span className="truncate">{valueText(v)}</span><span className="text-ink-3"><Icon.Chevron open /></span>
                </button>
                <span className="h-5 w-px shrink-0 bg-line" />
                {/* what a picked Class means, on every page (2026-11-23) */}
                <span className="shrink-0" title="What a picked Class means">
                  <Seg<'lead' | 'bought'> value={f.classOn} onChange={(classOn) => set({ classOn })}
                    options={[{ value: 'lead', label: 'Lead class', title: 'Class = the Class on the Salesforce lead' },
                              { value: 'bought', label: 'Purchased', title: 'Class = a class the lead paid for (Class 10 Board matches a Class 10 batch). Conversions use the date of that class payment.' }]} />
                </span>
                <span className="h-5 w-px shrink-0 bg-line" />
                {/* drop buyers whose purchased class differs from their lead class (2026-11-25) */}
                <label className="flex h-6 shrink-0 cursor-pointer items-center gap-1.5"
                  title="Lead class = purchased class: leave out buyers who bought a class other than the Class on their lead. Full class names: streams differ, and so do Board and CBSE. A lead marked Class 11 / 12 with no stream stays when it bought that class in any stream, because its stream is unknown. Leads that did not buy stay.">
                  <input type="checkbox" className="peer sr-only" checked={f.classMatch} onChange={(e) => set({ classMatch: e.target.checked })} />
                  <span className={`flex h-3.5 w-3.5 items-center justify-center rounded-[3px] border text-white ${f.classMatch ? "border-accent bg-accent" : "border-ink-3/60 bg-surface"} peer-focus-visible:ring-2 peer-focus-visible:ring-accent/40`}>{f.classMatch && <Icon.Check />}</span>
                  Lead = purchased
                </label>
              </Cell>
            );
          })()}
        </div>
        <div className={row}>
          {quick.slice(1).map(picker)}
          {/* named filter views (2026-11-26): Views opens / manages them, Save names the current filters as a new view. The single saved
              "Default" filter set was removed at the user's request. */}
          <Cell label="Views"><FilterViews cell /></Cell>
          <Cell label="Save"><SaveView /></Cell>
        </div>
        </div>
        {/* right edge (user, 2026-11-26): + adds a filter, ✕ removes them all. Stacked, each half of the pane's height. */}
        <div className={`grid shrink-0 gap-2 ${mode === "payment" ? "w-24 grid-cols-2" : "w-11 grid-rows-2"}`}>
          <div className="min-h-0">
          <Popover width="w-72" block align="right" trigger={
            <button type="button" className={`relative flex h-full w-full items-center justify-center rounded-lg border bg-surface text-ink-2 transition hover:border-accent/40 hover:text-ink ${moreCount ? 'border-accent/60' : 'border-line'}`}
              title="Add a filter: lead stage, district, owner, LM reason, call reason, interested course …">
              <Icon.Plus />{moreCount > 0 && <span className="absolute right-1 top-1 text-[10px] leading-none text-ink-3">{moreCount}</span>}
            </button>}>
            {(close) => (
              <div className="max-h-80 overflow-auto">
                {['Lead', 'Touch'].map((g) => (
                  <div key={g}>
                    <div className="px-1 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-ink-3">{g}</div>
                    {FILTER_MENU.filter((m) => m.group === g).map((m) => (
                      <button key={m.key} className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs hover:bg-accent/5" onClick={() => { setOpenDim(m.key); close(); }}>
                        <span>{m.label}</span>{f.lists[m.key]?.length ? <span className="chip">{f.lists[m.key]!.length}</span> : null}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </Popover>
          </div>
          <button type="button" className="relative flex min-h-0 items-center justify-center rounded-lg border border-line bg-surface text-ink-2 transition hover:border-accent/40 hover:text-ink disabled:opacity-40"
            disabled={activeCount === 0} onClick={clearAll} title={activeCount ? `Remove ${activeCount} filter${activeCount > 1 ? 's' : ''} (the dates stay)` : 'No filters set'}>
            <Icon.Close />{activeCount > 0 && <span className="absolute right-1 top-1 text-[10px] leading-none text-ink-3">{activeCount}</span>}
          </button>
        </div>
      </div>

      {chips.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {chips.map((c) => (
            <span key={c.label} className="chip bg-surface">
              <button className="hover:text-ink" onClick={() => { const k = Object.keys(DIM_LABEL).find((k) => c.label.startsWith(`${DIM_LABEL[k]}:`)); if (k && FILTER_MENU.some((m) => m.key === k)) setOpenDim(k as ListDim); }}>{c.label}</button>
              <button className="text-ink-3 hover:text-ink" onClick={c.onRemove} title="Remove"><Icon.Close /></button>
            </span>
          ))}
        </div>
      )}

      {openDim && (
        <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/30 p-4 pt-24" onClick={() => setOpenDim(null)}>
          <div className="w-[420px] max-w-full rounded-2xl border border-line bg-surface p-3 shadow-pop" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between"><div className="text-sm font-semibold">{DIM_LABEL[openDim]}</div><button className="text-ink-3 hover:text-ink" onClick={() => setOpenDim(null)}><Icon.Close /></button></div>
            <MultiSelect dim={openDim} onDone={() => setOpenDim(null)} />
          </div>
        </div>
      )}
    </div>
  );
}
