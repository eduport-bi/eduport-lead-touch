import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { onAuthError } from '../lib/api';
import { AuthContext, authCall, type Account, type AuthStatus } from '../lib/auth';

/**
 * Password login (AUTH_MODE=password). Wraps the whole app:
 *  - no accounts yet  -> "create the first admin" screen (e-mail must be in ADMIN_EMAILS on the Worker)
 *  - no session       -> sign-in form
 *  - otherwise        -> children, with useAuth() giving the account + logout
 * Any API 401 later (expired session, password reset by an admin) drops back to the sign-in form.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<AuthStatus | null | 'error'>(null);

  const refresh = useCallback(async () => {
    try { setStatus(await authCall<AuthStatus>('/auth/status')); } catch { setStatus('error'); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => onAuthError((code) => { if (code === 401) setStatus((s) => (s && s !== 'error' ? { ...s, user: null } : s)); }), []);

  const logout = useCallback(async () => {
    await authCall('/auth/logout', { method: 'POST', body: {} }).catch(() => undefined);
    qc.clear();
    setStatus((s) => (s && s !== 'error' ? { ...s, user: null } : s));
  }, [qc]);
  const signedIn = (u: Account) => { qc.clear(); setStatus((s) => (s && s !== 'error' ? { ...s, setup_required: false, user: u } : { mode: 'password', setup_required: false, user: u })); };

  if (status === null) return <Center><div className="py-6 text-center text-sm text-ink-3">Loading…</div></Center>;
  if (status === 'error') return <Center><div className="text-sm font-semibold">Cannot Reach the Server</div><p className="mt-1 text-xs text-ink-3">Check the connection and reload the page.</p><button className="btn btn-primary mt-4" onClick={refresh}>Retry</button></Center>;
  if (status.mode === 'password' && status.setup_required) return <Setup onDone={signedIn} />;
  if (status.mode === 'password' && !status.user) return <Login onDone={signedIn} />;
  return <AuthContext.Provider value={{ user: status.user, mode: status.mode, refresh, logout }}>{children}</AuthContext.Provider>;
}

function Center({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-5 flex items-center justify-center gap-2.5">
          <img src="/eduport-logo.png" alt="Eduport" className="h-11 w-11 rounded-full border border-line bg-white object-cover" />
          <div><div className="text-base font-semibold tracking-tight text-accent">eduport</div><div className="-mt-0.5 text-[11px] font-medium text-ink-3">Lead Touch analytics</div></div>
        </div>
        <div className="card">{children}</div>
      </div>
    </div>
  );
}

function Login({ onDone }: { onDone: (u: Account) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { const r = await authCall<{ user: Account }>('/auth/login', { body: { email, password } }); onDone(r.user); }
    catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  return (
    <Center>
      <div className="mb-4"><div className="text-sm font-semibold">Sign In</div><div className="text-xs text-ink-3">Use the e-mail and password your admin gave you</div></div>
      <form className="space-y-3" onSubmit={submit}>
        <label className="block text-[11px] font-medium text-ink-3">E-mail<input className="input mt-1 w-full" type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" placeholder="you@eduport.ai" /></label>
        <label className="block text-[11px] font-medium text-ink-3">Password<input className="input mt-1 w-full" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></label>
        {err && <div className="rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">{err}</div>}
        <button className="btn btn-primary w-full justify-center py-1.5" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
      <p className="mt-4 text-[11px] text-ink-3">Forgot the password? Ask an admin to set a new one on the Access page.</p>
    </Center>
  );
}

function Setup({ onDone }: { onDone: (u: Account) => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null);
    if (password !== confirm) { setErr('Passwords do not match'); return; }
    setBusy(true);
    try { const r = await authCall<{ user: Account }>('/auth/setup', { body: { email, name, password } }); onDone(r.user); }
    catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  return (
    <Center>
      <div className="mb-4"><div className="text-sm font-semibold">Create the First Admin Account</div><div className="text-xs text-ink-3">No accounts exist yet. This one-time step creates the admin who will add everyone else.</div></div>
      <form className="space-y-3" onSubmit={submit}>
        <label className="block text-[11px] font-medium text-ink-3">Admin e-mail<input className="input mt-1 w-full" type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" placeholder="bi_team@eduport.ai" /></label>
        <label className="block text-[11px] font-medium text-ink-3">Name<input className="input mt-1 w-full" value={name} onChange={(e) => setName(e.target.value)} placeholder="BI Team" /></label>
        <label className="block text-[11px] font-medium text-ink-3">Password<input className="input mt-1 w-full" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" /></label>
        <label className="block text-[11px] font-medium text-ink-3">Confirm password<input className="input mt-1 w-full" type="password" required minLength={8} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" /></label>
        <div className="text-[11px] text-ink-3">At least 8 characters with letters and a number.</div>
        {err && <div className="rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">{err}</div>}
        <button className="btn btn-primary w-full justify-center py-1.5" disabled={busy}>{busy ? 'Creating…' : 'Create admin account'}</button>
      </form>
    </Center>
  );
}
