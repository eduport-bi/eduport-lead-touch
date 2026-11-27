import { titleCase, capFirst } from '../lib/format';
import React, { Component, type ReactNode, useEffect, useRef, useState } from 'react';

export function Skeleton({ className = 'h-6 w-full' }: { className?: string }) { return <div className={`skeleton ${className}`} />; }

export function EmptyState({ title = 'No data for this selection', hint }: { title?: string; hint?: string }) {
  return (
    <div className="flex h-full min-h-[160px] flex-col items-center justify-center gap-1 text-center">
      <div className="text-sm font-medium text-ink-2">{title}</div>
      {hint && <div className="max-w-xs text-xs text-ink-3">{hint}</div>}
    </div>
  );
}

export function ErrorNote({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className="flex min-h-[120px] flex-col items-center justify-center gap-2 rounded-md border border-dashed border-[#d03b3b]/50 p-4 text-center">
      <div className="text-sm font-medium text-[#d03b3b]">⚠ Could not load</div>
      <div className="max-w-md break-words text-xs text-ink-3">{msg}</div>
      {onRetry && <button className="btn" onClick={onRetry}>Retry</button>}
    </div>
  );
}

interface EBState { error: Error | null }
export class ErrorBoundary extends Component<{ children: ReactNode; label?: string }, EBState> {
  state: EBState = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error('ErrorBoundary', this.props.label, error); }
  render() {
    if (this.state.error) return <ErrorNote error={this.state.error} onRetry={() => this.setState({ error: null })} />;
    return this.props.children;
  }
}

/** Minimal popover anchored to its trigger */
export function Popover({ trigger, children, align = 'left', width = 'w-80', block = false }: { trigger: ReactNode; children: ReactNode | ((close: () => void) => ReactNode); align?: 'left' | 'right'; width?: string;
  /** fill the parent's width (a box of the filter pane grid) instead of shrinking to the trigger */
  block?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return (
    <div className={`relative ${block ? 'block h-full w-full min-w-0' : 'inline-block'}`} ref={ref}>
      <span className={block ? 'block h-full w-full' : undefined} onClick={() => setOpen((o) => !o)}>{trigger}</span>
      {open && (
        <div className={`absolute z-40 mt-1 ${align === 'right' ? 'right-0' : 'left-0'} ${width} rounded-xl border border-line bg-surface p-3 shadow-pop`}>
          {typeof children === 'function' ? children(() => setOpen(false)) : children}
        </div>
      )}
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, options, size = 'sm' }: { value: T; onChange: (v: T) => void; options: { value: T; label: string; title?: string }[]; size?: 'sm' | 'xs' }) {
  return (
    <div className="inline-flex rounded-lg border border-line bg-surface-2 p-0.5">
      {options.map((o) => (
        <button key={o.value} title={o.title} onClick={() => onChange(o.value)}
          className={`rounded-md px-2.5 ${size === 'xs' ? 'py-0.5 text-[11px]' : 'py-1 text-xs'} font-medium transition ${value === o.value ? 'bg-surface text-accent shadow-sm' : 'text-ink-2 hover:text-ink'}`}>
          {titleCase(o.label)}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label, title }: { checked: boolean; onChange: (v: boolean) => void; label: string; title?: string }) {
  return (
    <label className="inline-flex cursor-pointer select-none items-center gap-1.5 text-xs text-ink-2" title={title}>
      <span onClick={() => onChange(!checked)} className={`relative inline-block h-4 w-7 rounded-full transition ${checked ? 'bg-accent' : 'bg-ink/20'}`}>
        <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition ${checked ? 'left-3.5' : 'left-0.5'}`} />
      </span>
      {label}
    </label>
  );
}

/** Search box for a card's rows; "Filter n" applies every matching value as a page filter */
export function CardSearch({ value, onChange, count, onApply, placeholder = 'Search…' }: { value: string; onChange: (v: string) => void; count: number; onApply?: () => void; placeholder?: string }) {
  return (
    <span className="flex items-center gap-1">
      <input className="input w-32 !py-0.5 text-[11px]" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
      {value && <button className="btn !px-1.5 !py-0.5 text-[10px]" onClick={() => onChange('')} title="Clear search"><Icon.Close /></button>}
      {value && onApply && count > 0 && <button className="btn btn-dark !px-2 !py-0.5 text-[10px]" onClick={onApply} title="Filter every card by all the values that match">Filter {count}</button>}
    </span>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-line bg-surface px-3 py-2 text-[11px] leading-snug text-ink-2">{children}</div>;
}

export function PageHeader({ title, subtitle, right }: { title: string; subtitle?: string; right?: ReactNode }) {
  return (
    <div className="mb-1 flex flex-wrap items-end justify-between gap-2">
      <div className="min-w-0">
        <h1 className="text-lg font-semibold tracking-tight text-ink">{titleCase(title)}</h1>
        {subtitle && <p className="mt-0.5 text-[11px] text-ink-3">{capFirst(subtitle)}</p>}
      </div>
      {right}
    </div>
  );
}

export const Icon = {
  Help: () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01" /></svg>,
  Table: () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M3 15h18M9 3v18" /></svg>,
  Chart: () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18M7 14v4M12 9v9M17 5v13" /></svg>,
  Download: () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v3h16v-3" /></svg>,
  Close: () => <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M6 6l12 12M18 6 6 18" /></svg>,
  Sun: () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>,
  Moon: () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" /></svg>,
  Plus: () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 5v14M5 12h14" /></svg>,
  Home: () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 11 12 3l9 8v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z" /></svg>,
  Users: () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4.5-6.2" /></svg>,
  Touch: () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 11V5a2 2 0 1 1 4 0v6m0-3a2 2 0 1 1 4 0v4m0-2a2 2 0 1 1 4 0v4a7 7 0 0 1-7 7h-1.6a6 6 0 0 1-4.6-2.2L3.6 15a1.8 1.8 0 0 1 2.7-2.4L9 15" /></svg>,
  Check: () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="m4 12.5 5 5L20 6.5" /></svg>,
  Avg: () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 17c3 0 3-10 6-10s3 10 6 10 3-10 6-10M3 12h18" /></svg>,
  Calendar: () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M3 10h18M8 3v4m8-4v4" /></svg>,
  Spark: () => <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2Zm7 12 .9 3.1L23 18l-3.1.9L19 22l-.9-3.1L15 18l3.1-.9L19 14ZM5 15l.7 2.3L8 18l-2.3.7L5 21l-.7-2.3L2 18l2.3-.7L5 15Z" /></svg>,
  Chevron: ({ open }: { open?: boolean }) => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ transform: open ? 'rotate(90deg)' : undefined }}><path d="m9 6 6 6-6 6" /></svg>,
};

export function useDebounce<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

export function Kbd({ children }: { children: React.ReactNode }) { return <kbd className="rounded border border-line bg-surface-2 px-1 text-[10px] text-ink-3">{children}</kbd>; }
