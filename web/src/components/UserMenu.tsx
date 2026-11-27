import { useState } from 'react';
import { Link } from 'react-router-dom';
import { authCall, useAuth, ROLE_LABEL } from '../lib/auth';
import { Icon, Popover } from './ui';

/** Header avatar: name / e-mail / role, Access link (admins), change password, sign out. */
export function UserMenu() {
  const { user, mode, logout } = useAuth();
  const [pw, setPw] = useState(false);
  const initials = (user?.name || user?.email || 'bi').split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((s) => s[0]!.toUpperCase()).join('');
  return (
    <>
      <Popover align="right" width="w-64" trigger={<button className="grid h-8 w-8 place-items-center rounded-full bg-accent/10 text-[11px] font-semibold text-accent" title={user?.email}>{initials}</button>}>
        {(close) => (
          <div className="text-xs">
            <div className="font-semibold text-ink">{user?.name || user?.email}</div>
            <div className="text-ink-3">{user?.email}</div>
            <div className="mt-1"><span className={`chip ${user?.role === 'admin' ? 'border-accent/40 text-accent' : ''}`}>{user ? ROLE_LABEL[user.role] : 'User'}</span></div>
            {mode === 'password' && (
              <div className="mt-3 space-y-1 border-t border-line pt-2">
                {user?.role === 'admin' && <Link to="/access" onClick={close} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-2"><Icon.Users /> Manage access</Link>}
                <button className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-surface-2" onClick={() => { close(); setPw(true); }}><Icon.Help /> Change my password</button>
                <button className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-surface-2" onClick={() => { close(); logout(); }}><Icon.Close /> Sign out</button>
              </div>
            )}
          </div>
        )}
      </Popover>
      {pw && <ChangePassword onClose={() => setPw(false)} />}
    </>
  );
}

function ChangePassword({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState(''); const [next, setNext] = useState(''); const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const [done, setDone] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null);
    if (next !== confirm) { setErr('New passwords do not match'); return; }
    setBusy(true);
    try { await authCall('/auth/password', { body: { current, password: next } }); setDone(true); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4" onClick={onClose}>
      <div className="card w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between"><h3 className="text-[13px] font-semibold">Change My Password</h3><button className="rounded p-1 text-ink-3 hover:text-ink" onClick={onClose}><Icon.Close /></button></div>
        {done ? <div className="text-xs"><div className="text-emerald-600">Password changed. Other devices were signed out.</div><div className="mt-3 flex justify-end"><button className="btn btn-primary" onClick={onClose}>Close</button></div></div> : (
          <form className="space-y-3" onSubmit={submit}>
            <label className="block text-[11px] font-medium text-ink-3">Current password<input className="input mt-1 w-full" type="password" required autoFocus value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" /></label>
            <label className="block text-[11px] font-medium text-ink-3">New password<input className="input mt-1 w-full" type="password" required minLength={8} value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" /></label>
            <label className="block text-[11px] font-medium text-ink-3">Confirm new password<input className="input mt-1 w-full" type="password" required minLength={8} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" /></label>
            <div className="text-[11px] text-ink-3">At least 8 characters with letters and a number.</div>
            {err && <div className="text-xs text-red-600">{err}</div>}
            <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Change password'}</button></div>
          </form>
        )}
      </div>
    </div>
  );
}
