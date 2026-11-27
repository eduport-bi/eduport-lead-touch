import { titleCase, capFirst } from '../lib/format';
import type { ReactNode } from 'react';
import { Icon, Popover } from './ui';

export interface KpiSplit { label: string; value: string; onClick?: () => void; title?: string }

/**
 * KPI tile: label on top, big number, caption below, icon at the right — one consistent layout everywhere.
 * `split` shows one or two secondary figures under the caption.
 */
export function KpiTile({ title, value, sub, def, tone, icon, onClick, split, small, className }: {
  title: string; value: string; sub?: string; def?: string; tone: string; icon: ReactNode; onClick?: () => void; split?: KpiSplit[]; small?: boolean; className?: string;
}) {
  return (
    <div className={`card ${tone} flex h-full flex-col ${className ?? ''} ${onClick ? 'cursor-pointer transition hover:border-accent/40 hover:shadow-pop' : ''}`} onClick={onClick} title={onClick ? 'Click to see the leads' : undefined}>
      <div className="flex items-start justify-between gap-2">
        <div className="line-clamp-2 text-[11px] font-medium leading-tight text-ink-3" title={title}>{titleCase(title)}</div>
        {def && <span onClick={(e) => e.stopPropagation()}><Popover align="right" width="w-80" trigger={<button className="rounded p-0.5 text-ink-3 hover:text-ink"><Icon.Help /></button>}><div className="text-xs leading-relaxed text-ink-2">{def}</div></Popover></span>}
      </div>
      <div className="mt-2 flex items-end justify-between gap-2">
        <div className="min-w-0">
          <div className={`font-semibold leading-none tabular-nums tracking-tight ${small ? 'text-xl' : 'text-2xl'}`}>{value}</div>
          {sub && <div className="mt-1.5 text-[10.5px] leading-snug text-ink-3">{capFirst(sub)}</div>}
        </div>
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-tone text-tone">{icon}</span>
      </div>
      {split && split.length > 0 && (
        <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-t border-line pt-2 text-[11px] leading-tight">
          {split.map((s) => (
            <button key={s.label} title={s.title} className="rounded px-0.5 text-left text-ink-3 hover:bg-tone hover:text-ink" onClick={(e) => { e.stopPropagation(); s.onClick?.(); }}>
              {titleCase(s.label)} <b className="tabular-nums text-ink">{s.value}</b>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
