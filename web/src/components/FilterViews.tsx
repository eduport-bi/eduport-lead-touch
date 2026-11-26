import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { authCall } from '../lib/auth';
import { useFilters } from '../lib/filters';
import { Icon, Popover } from './ui';

/**
 * Named filter views (2026-11-26), like Google Sheets filter views: save the filter bar under a name, apply it with one click, update,
 * rename, share with the team or delete it. Views live on the server per user (app_auth.filter_views, /api/auth/views); a shared view is
 * listed for everyone under "Team views" and only its owner can change it. The single "Save filter" default is separate and unchanged.
 */
interface View { id: string; name: string; query: string; shared: boolean; owner_email: string; owner_name: string | null; updated_at: string; mine: boolean }

export function FilterViews({ cell = false }: { cell?: boolean } = {}) {
  const { currentQuery, applyQuery } = useFilters();
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ['filter-views'], queryFn: () => authCall<{ views: View[] }>('/auth/views'), staleTime: 60_000 });
  const views = data?.views ?? [];
  const mine = views.filter((v) => v.mine);
  const team = views.filter((v) => !v.mine);
  const active = views.find((v) => v.query === currentQuery);

  const [name, setName] = useState('');
  const [share, setShare] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameTo, setRenameTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); await qc.invalidateQueries({ queryKey: ['filter-views'] }); if (done) setMsg(done); }
    catch (e) { setMsg((e as Error).message); }
    finally { setBusy(false); }
  };
  const save = () => run(async () => { await authCall('/auth/views', { method: 'POST', body: { name: name.trim(), query: currentQuery, shared: share } }); setName(''); setShare(false); }, 'Saved');
  const update = (v: View) => run(() => authCall(`/auth/views/${v.id}`, { method: 'PUT', body: { query: currentQuery } }), `"${v.name}" now holds the current filters`);
  const toggleShare = (v: View) => run(() => authCall(`/auth/views/${v.id}`, { method: 'PUT', body: { shared: !v.shared } }));
  const rename = (v: View) => run(async () => { await authCall(`/auth/views/${v.id}`, { method: 'PUT', body: { name: renameTo.trim() } }); setRenaming(null); });
  const remove = (v: View) => { if (window.confirm(`Delete the view "${v.name}"?`)) run(() => authCall(`/auth/views/${v.id}`, { method: 'DELETE' })); };

  const row = (v: View, close: () => void) => (
    <div key={v.id} className={`group rounded px-1.5 py-1 ${active?.id === v.id ? 'bg-accent/10' : 'hover:bg-surface-2'}`}>
      {renaming === v.id ? (
        <div className="flex items-center gap-1">
          <input className="input !py-0.5 flex-1 text-xs" value={renameTo} autoFocus maxLength={80} onChange={(e) => setRenameTo(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && renameTo.trim()) rename(v); if (e.key === 'Escape') setRenaming(null); }} />
          <button className="btn !py-0.5 text-[11px]" disabled={busy || !renameTo.trim()} onClick={() => rename(v)}>Save</button>
          <button className="text-[11px] text-ink-3 hover:text-ink" onClick={() => setRenaming(null)}>Cancel</button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <button className="min-w-0 flex-1 truncate text-left text-xs font-medium" title={`Apply "${v.name}"`} onClick={() => { applyQuery(v.query); close(); }}>
            {v.name}{active?.id === v.id && <span className="ml-1 text-accent">✓</span>}
            {!v.mine && <span className="ml-1 font-normal text-ink-3">· {v.owner_name ?? v.owner_email}</span>}
            {v.mine && v.shared && <span className="ml-1 font-normal text-ink-3">· shared</span>}
          </button>
          {v.mine && (
            <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-ink-3 opacity-70 group-hover:opacity-100">
              <button className="hover:text-ink" disabled={busy} title="Replace this view's filters with the current filters" onClick={() => update(v)}>Update</button>
              <button className="hover:text-ink" title="Rename" onClick={() => { setRenaming(v.id); setRenameTo(v.name); }}>Rename</button>
              <button className="hover:text-ink" disabled={busy} title={v.shared ? 'Stop sharing with the team' : 'Show this view to the team (they can use it, only you can change it)'} onClick={() => toggleShare(v)}>{v.shared ? 'Unshare' : 'Share'}</button>
              <button className="hover:text-red-500" disabled={busy} title="Delete" onClick={() => remove(v)}><Icon.Close /></button>
            </span>
          )}
        </div>
      )}
    </div>
  );

  return (
    <Popover width="w-96" block={cell} align={cell ? 'right' : 'left'} trigger={cell
      ? <button className="flex w-full min-w-0 items-center justify-between gap-1 text-left text-[13px] text-ink" title="Named filter views: save the current filters under a name, apply one with a click">
          <span className="truncate">{active ? active.name : mine.length + team.length ? `${mine.length + team.length} saved` : 'None'}</span> <span className="text-ink-3"><Icon.Chevron open /></span>
        </button>
      : <button className={`btn h-8 max-w-[220px] ${active ? 'border-accent/40 text-accent' : ''}`} title="Named filter views: save the current filters under a name, apply one with a click">
          <span className="text-ink-3">Views</span> <span className="truncate">{active ? active.name : mine.length + team.length ? `${mine.length + team.length}` : 'None'}</span> <Icon.Chevron open />
        </button>}>
      {(close) => (
        <div className="space-y-2 text-xs">
          {error && <div className="text-red-500">{(error as Error).message}</div>}
          {isLoading && <div className="text-ink-3">Loading…</div>}
          <div>
            <div className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-ink-3">My views</div>
            {mine.length ? <div className="max-h-56 overflow-auto">{mine.map((v) => row(v, close))}</div> : <div className="px-1.5 text-ink-3">None yet. Save the current filters below.</div>}
          </div>
          {team.length > 0 && (
            <div>
              <div className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-ink-3">Team views</div>
              <div className="max-h-40 overflow-auto">{team.map((v) => row(v, close))}</div>
            </div>
          )}
          <div className="border-t border-line pt-2">
            <div className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-ink-3">Save current filters as a view</div>
            <div className="flex items-center gap-1.5">
              <input className="input !py-1 flex-1 text-xs" placeholder="View name, e.g. Class 10 CBSE · last 30 days" value={name} maxLength={80}
                onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) save(); }} />
              <button className="btn btn-primary !py-1" disabled={busy || !name.trim()} onClick={save}><Icon.Plus /> Save</button>
            </div>
            <label className="mt-1.5 flex cursor-pointer items-center gap-1.5 px-1 text-ink-2">
              <input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} /> Share with team
            </label>
          </div>
          {msg && <div className="px-1 text-ink-3">{msg}</div>}
        </div>
      )}
    </Popover>
  );
}
