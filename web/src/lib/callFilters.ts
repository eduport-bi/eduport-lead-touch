import { useSyncExternalStore } from 'react';

/**
 * The call filters of the Lead Call Analytics page (2026-11-28): which leads count (called or not) and which calls count.
 * They sit in the filter pane on that page only; kept per browser. DRAFT: the page's figures are still sample data.
 */
export type CallFilters = {
  /** lead = the leads in the filters and their calls after the touch or creation; call = every call dated in the range (2026-11-28) */
  basis: 'lead' | 'call';
  /** all = a call by anyone counts; owner = only calls by the lead's owner */
  by: 'all' | 'owner';
  called: 'all' | 'called' | 'not_called' | 'connected';
  callType: 'all' | 'outgoing' | 'incoming' | 'missed';
  minTalk: '0' | '30' | '120';
};
const KEY = 'lt-call-filters-v1';
const DEFAULTS: CallFilters = { basis: 'lead', by: 'all', called: 'all', callType: 'all', minTalk: '0' };

let state: CallFilters = (() => {
  try { return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<CallFilters>) }; } catch { return DEFAULTS; }
})();
const listeners = new Set<() => void>();

export function setCallFilters(patch: Partial<CallFilters>): void {
  state = { ...state, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* storage blocked: keep it in memory */ }
  listeners.forEach((l) => l());
}

export function useCallFilters(): CallFilters {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => state, () => state);
}
