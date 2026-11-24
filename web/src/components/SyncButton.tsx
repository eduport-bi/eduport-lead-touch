import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiFetch, authHeaders, ApiError } from '../lib/api';
import { fmtDateTime } from '../lib/format';

interface Run { id: number; status: string; conclusion: string | null; started_at: string; html_url: string; event: string }
interface Status { configured: boolean; run: Run | null }

/** "Sync now": starts the GitHub Actions sync (Salesforce + payments -> Supabase -> views) and shows its progress. Admins only (AppShell, api/src/routes/sync.ts). */
export function SyncButton() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<Status | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const running = status?.run && ['in_progress', 'queued', 'pending', 'waiting'].includes(status.run.status);

  const load = async () => { try { const r = await apiFetch<Status>('/sync/status'); setStatus(r.data); } catch { /* ignore */ } };
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(async () => {
      await load();
    }, 20_000);
    return () => clearInterval(t);
  }, [running]);
  // when a run finishes, refetch every query so the new numbers show up
  useEffect(() => { if (status?.run && !running && status.run.conclusion) qc.invalidateQueries(); }, [status?.run?.id, running]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch('/api/sync', { method: 'POST', headers: await authHeaders() });
      const body = (await res.json()) as { data?: { expected_minutes: number }; error?: { message: string } };
      if (!res.ok) throw new ApiError(res.status, body.error?.message ?? res.statusText);
      setMsg(`Sync started - new data in about ${body.data?.expected_minutes ?? 5} minutes`);
      setTimeout(load, 8000);
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };

  if (status && !status.configured) return <button className="btn" disabled title="Set the GITHUB_TOKEN secret on the Worker to enable">Sync now</button>;
  const r = status?.run;
  const dot = running ? 'bg-[#fab219] animate-pulse' : r?.conclusion === 'success' ? 'bg-[#0ca30c]' : r?.conclusion ? 'bg-[#d03b3b]' : 'bg-ink/30';
  return (
    <div className="flex items-center gap-2">
      <button className="btn btn-dark" onClick={start} disabled={busy || !!running} title={r ? `Last run: ${r.status} ${r.conclusion ?? ''} at ${fmtDateTime(r.started_at)}` : 'Start a sync'}>
        <span className={`h-1.5 w-1.5 rounded-full ${dot}`} /> {running ? 'Syncing…' : busy ? 'Starting…' : 'Sync now'}
      </button>
      {msg && <span className="text-[11px] text-ink-3">{msg}</span>}
      {r && !msg && <a className="text-[11px] text-ink-3 hover:text-ink" href={r.html_url} target="_blank" rel="noreferrer">last run {fmtDateTime(r.started_at)} · {r.conclusion ?? r.status}</a>}
    </div>
  );
}
