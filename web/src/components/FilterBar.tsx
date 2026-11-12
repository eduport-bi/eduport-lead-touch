import { useState } from 'react';
import { DIM_LABEL, FILTER_MENU, PRESETS, useFilters, type Basis, type ListDim } from '../lib/filters';
import { Icon, Popover, Segmented, Toggle } from './ui';
import { MultiSelect } from './MultiSelect';

/** mode "payment": the range IS the payment date (Converted page) - no basis switch, no second payment window */
/** Always-visible pickers on the bar (multi-select). Rows clicked in any card write the same state, so they show up here too. */
const QUICK: { key: ListDim; label: string }[] = [
  { key: 'class_group', label: 'Class' }, { key: 'touch_point', label: 'Touch point' }, { key: 'source', label: 'Lead source' }, { key: 'campaign', label: 'Campaign' }, { key: 'medium', label: 'Medium' },
];
const QUICK_KEYS = new Set<string>(QUICK.map((q) => q.key));

export function FilterBar({ mode }: { mode?: 'payment' } = {}) {
  const { f, set, setList, clearAll, activeCount, saveFilter, forgetFilter, savedQuery, isSaved } = useFilters();
  const [openDim, setOpenDim] = useState<ListDim | null>(null);
  const [saving, setSaving] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const onSave = async () => { setSaving('busy'); try { await saveFilter(); setSaving('done'); setTimeout(() => setSaving('idle'), 1500); } catch { setSaving('error'); setTimeout(() => setSaving('idle'), 2500); } };
  const onForget = async () => { setSaving('busy'); try { await forgetFilter(); setSaving('idle'); } catch { setSaving('error'); setTimeout(() => setSaving('idle'), 2500); } };

  const chips: { label: string; onRemove: () => void }[] = [];
  for (const [k, vals] of Object.entries(f.lists)) if (vals?.length && !QUICK_KEYS.has(k)) chips.push({ label: `${DIM_LABEL[k] ?? k}: ${vals.length > 2 ? `${vals.slice(0, 2).join(', ')} +${vals.length - 2}` : vals.join(', ')}`, onRemove: () => setList(k as ListDim, []) });
  for (const [k, v] of Object.entries(f.flags)) if (v) chips.push({ label: `${DIM_LABEL[k] ?? k}: ${v === '1' ? 'yes' : 'no'}`, onRemove: () => set((p) => ({ ...p, flags: { ...p.flags, [k]: undefined } })) });

  return (
    <div className="sticky top-2 z-30 mb-4 rounded-xl border border-line bg-surface/95 px-4 py-2.5 shadow-card backdrop-blur">
      <div className="flex flex-wrap items-center gap-1.5">
        {/* date preset */}
        {mode === 'payment' && <span className="chip border-accent/40 font-medium text-accent" title="On this page the date range is the payment date; touch dates are not checked">Payment date</span>}
        <select className="input !py-1 text-xs" value={f.preset} onChange={(e) => { const p = PRESETS.find((x) => x.key === e.target.value)!; const [from, to] = p.range(); set({ preset: p.key, from, to }); }}>
          {PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
        <input type="date" className="input !py-1 text-xs" value={f.from} max={f.to} onChange={(e) => set({ preset: 'custom', from: e.target.value })} />
        <span className="text-xs text-ink-3">to</span>
        <input type="date" className="input !py-1 text-xs" value={f.to} min={f.from} onChange={(e) => set({ preset: 'custom', to: e.target.value })} />

        {mode !== 'payment' && <>
        <Segmented<Basis> value={f.basis} onChange={(basis) => set({ basis })} size="xs"
          options={[{ value: 'created', label: 'Lead created', title: 'Leads created in the range (with all their touches)' }, { value: 'touch', label: 'Touch date', title: 'Touches dated in the range' }]} />

        <span className="mx-1 h-5 w-px bg-line" />
        <Toggle checked={f.pay} onChange={(pay) => set({ pay })} label="Payment date" title="When on, Converted counts only valid payments dated inside this second window" />
        {f.pay && <>
          <input type="date" className="input !py-1 text-xs" value={f.pfrom} max={f.pto} onChange={(e) => set({ pfrom: e.target.value })} />
          <span className="text-xs text-ink-3">to</span>
          <input type="date" className="input !py-1 text-xs" value={f.pto} min={f.pfrom} onChange={(e) => set({ pto: e.target.value })} />
        </>}
        </>}


        {/* quick pickers: Class (grouped, sql/050: Class 7 / 8 / 9 / 10 split CBSE vs Board (state syllabus, Malayalam + English medium), SSLC -> Class 10, Class 11 / 12 split by stream (Science / Commerce / Humanities / no stream) plus CBSE where recorded, CUET -> Class 12 (no stream), repeaters -> Repeater ...), Touch point, Lead source, Campaign */}
        {QUICK.map((qk) => { const v = f.lists[qk.key] ?? []; return (
          <button key={qk.key} className={`btn max-w-[240px] ${v.length ? 'border-accent/40 text-accent' : ''}`} title={`Filter by ${qk.label.toLowerCase()} (multi-select)`} onClick={() => setOpenDim(qk.key)}>
            <span className="text-ink-3">{qk.label}</span> <span className="truncate">{v.length === 0 ? 'All' : v.length <= 2 ? v.join(', ') : `${v.length} selected`}</span> <Icon.Chevron open />
          </button>
        ); })}

        <Popover width="w-72" trigger={<button className="btn"><Icon.Plus /> Add filter</button>}>
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
        {activeCount > 0 && <button className="btn" onClick={clearAll}><Icon.Close /> Clear {activeCount}</button>}
        {/* saved filter set: one per user (server side); applied automatically on the next visit */}
        <button className={`btn ${isSaved ? 'border-accent/40 text-accent' : ''}`} disabled={saving === 'busy' || isSaved} onClick={onSave}
          title={isSaved ? 'This filter set is your saved default: it is applied every time you open the dashboard' : 'Save the current filters (dates, class, touch point ...) as your default: they are applied every time you open the dashboard'}>
          <Icon.Check /> {saving === 'busy' ? 'Saving…' : saving === 'done' || isSaved ? 'Saved filter' : saving === 'error' ? 'Could not save' : 'Save filter'}
        </button>
        {savedQuery != null && !isSaved && <button className="btn" onClick={onForget} title="Remove your saved default filters (the dashboard then opens with the browser's last filters)"><Icon.Close /> Forget saved</button>}
      </div>

      {chips.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {chips.map((c) => (
            <span key={c.label} className="chip">
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
