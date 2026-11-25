import { useEffect, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import type { Envelope } from './types';

export class ApiError extends Error {
  constructor(public status: number, message: string, public issues?: unknown) { super(message); }
}

export type Params = Record<string, string | number | boolean | undefined | null>;

export function qs(params: Params): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}

/** Listeners for auth failures (the app shows the login screen) */
const authListeners = new Set<(status: 401 | 403, message: string) => void>();
export function onAuthError(fn: (status: 401 | 403, message: string) => void) { authListeners.add(fn); return () => { authListeners.delete(fn); }; }

/** Kept for call sites that spread it; the session is an HttpOnly cookie now, so nothing to add. */
export async function authHeaders(): Promise<Record<string, string>> { return {}; }

export const FETCH_TIMEOUT_MS = 180_000;
export async function apiFetch<T>(path: string, params: Params = {}): Promise<Envelope<T>> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try { res = await fetch(`/api${path}${qs(params)}`, { headers: { accept: 'application/json' }, credentials: 'same-origin', signal: ctl.signal }); }
  catch (e) { throw new ApiError(0, ctl.signal.aborted ? `No answer within ${FETCH_TIMEOUT_MS / 1000} s - please retry` : (e as Error).message); }
  finally { clearTimeout(timer); }
  const body = (await res.json().catch(() => ({}))) as Envelope<T> & { error?: { message: string; issues?: unknown } };
  if (res.status === 401 || res.status === 403) authListeners.forEach((l) => l(res.status as 401 | 403, body.error?.message ?? res.statusText));
  if (!res.ok) throw new ApiError(res.status, body.error?.message ?? res.statusText, body.error?.issues);
  if (res.headers.get('X-LT-Cache') === 'stale') body.stale = true;
  return body;
}

// ---------------------------------------------------------------- stale answers (2026-11-25)
// After a sync the server answers at once with the last answer of the older data version (stale). The page shows it, asks again with
// revalidate=1 in the background and swaps the fresh answer in. The header shows "Updating…" while any such refresh runs.
let updating = 0; const updatingListeners = new Set<() => void>();
const setUpdating = (d: number) => { updating = Math.max(0, updating + d); updatingListeners.forEach((l) => l()); };
export function useUpdating(): boolean {
  return useSyncExternalStore((cb) => { updatingListeners.add(cb); return () => { updatingListeners.delete(cb); }; }, () => updating > 0);
}
const revalidating = new Set<string>();

export function useApi<T>(path: string, params: Params = {}, opts: Partial<UseQueryOptions<Envelope<T>, ApiError>> = {}) {
  const qc = useQueryClient();
  const queryKey = [path, params];
  const q = useQuery<Envelope<T>, ApiError>({
    queryKey,
    queryFn: () => apiFetch<T>(path, params),
    ...opts,
  });
  const stale = q.data?.stale === true;
  const id = JSON.stringify(queryKey);
  useEffect(() => {
    if (!stale || revalidating.has(id)) return;
    revalidating.add(id); setUpdating(1);
    apiFetch<T>(path, { ...params, revalidate: 1 })
      .then((fresh) => qc.setQueryData(queryKey, fresh))
      .catch(() => undefined)   // keep showing the old answer; the next visit tries again
      .finally(() => { revalidating.delete(id); setUpdating(-1); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stale, id]);
  return q;
}

export function downloadUrl(path: string, params: Params): string {
  return `/api${path}${qs(params)}`;
}

/** Download via fetch so errors surface as JSON instead of a broken file. */
export async function downloadWithAuth(path: string, params: Params, filename: string, exportPassword?: string): Promise<void> {
  const res = await fetch(`/api${path}${qs(params)}`, { credentials: 'same-origin', headers: exportPassword ? { 'x-export-password': exportPassword } : {} });
  if (!res.ok) { const j = (await res.json().catch(() => ({}))) as { error?: { message?: string } }; throw new ApiError(res.status, j.error?.message ?? res.statusText); }
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
