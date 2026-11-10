import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { fmtDateTime } from '../lib/format';
import { authCall, generatePassword, useAuth, ROLE_LABEL, ROLE_DESC, type AccountRole } from '../lib/auth';
import { Icon, PageHeader } from '../components/ui';

interface Row { id: number; email: string; name: string; role: AccountRole; is_active: boolean; last_login_at: string | null; password_set_at: string; created_at: string; created_by: string | null; locked_until: string | null; active_sessions: number }
interface Audit { at: string; actor: string; action: string; target: string | null; detail: string | null }

/** Admin-only: create accounts, set passwords, promote to admin, disable or delete. */
export default function Access() {
  const { user: me } = useAuth();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [modal, setModal] = useState<{ kind: 'new' } | { kind: 'password'; row: Row } | { kind: 'export' } | null>(null);
  const [exp, setExp] = useState<{ configured: boolean; updated_at: string | null; updated_by: string | null } | null>(null);
  const loadExport = async () => { try { setExp(await authCall('/export/status')); } catch { /* shown as unknown */ } };
  // the current export password, fetched only when an admin asks to see it (the view is written to the activity list)
  const [expPw, setExpPw] = useState<{ password: string | null } | { error: string } | null>(null);
  const [expCopied, setExpCopied] = useState(false);
  const showExport = async () => { try { const r = await authCall<{ configured: boolean; password: string | null }>('/export/password'); setExpPw({ password: r.password }); load(); } catch (x) { setExpPw({ error: (x as Error).message }); } };
  // can passwords be e-mailed? (RESEND_API_KEY + MAIL_FROM on the Worker)
  const [mail, setMail] = useState<{ configured: boolean; from: string | null } | null>(null);
  const loadMail = async () => { try { setMail(await authCall('/auth/mail/status')); } catch { setMail({ configured: false, from: null }); } };
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const mailResult = (what: string, to: string, r: { email_sent?: boolean; email_error?: string }, wanted: boolean) =>
    setNotice(!wanted ? { ok: true, text: `${what} · the password was not e-mailed` } : r.email_sent ? { ok: true, text: `${what} · the password was e-mailed to ${to}` } : { ok: false, text: `${what} · the e-mail could not be sent (${r.email_error ?? 'unknown error'}) - share the password another way` });

  const load = async () => {
    try { const d = await authCall<{ users: Row[]; audit: Audit[] }>('/auth/users'); setRows(d.users); setAudit(d.audit); setErr(null); }
    catch (e) { setErr((e as Error).message); }
  };
  useEffect(() => { if (me?.role === 'admin') { load(); loadExport(); loadMail(); } }, [me?.role]);
  if (me?.role !== 'admin') return <Navigate to="/" replace />;

  const act = async (fn: () => Promise<unknown>) => { try { await fn(); await load(); } catch (e) { alert((e as Error).message); } };
  const patch = (row: Row, body: Partial<Pick<Row, 'role' | 'is_active' | 'name'>>) => act(() => authCall(`/auth/users/${row.id}`, { method: 'PATCH', body }));
  const remove = (row: Row) => { if (confirm(`Delete the account ${row.email}? They will be signed out immediately.`)) act(() => authCall(`/auth/users/${row.id}`, { method: 'DELETE' })); };

  const shown = (rows ?? []).filter((r) => !q || `${r.email} ${r.name}`.toLowerCase().includes(q.toLowerCase()));
  const admins = (rows ?? []).filter((r) => r.role === 'admin' && r.is_active).length;

  return (
    <div className="space-y-4">
      <PageHeader title="Access" subtitle="Who can open this dashboard. Admins create every account and set every password. Manager = every page with full details and downloads; BDE = phone numbers masked, no Lead explorer, no downloads."
        right={<button className="btn btn-primary" onClick={() => setModal({ kind: 'new' })}><Icon.Plus />
      {notice && <div className={`rounded-lg border px-3 py-2 text-xs ${notice.ok ? 'border-emerald-300 bg-emerald-50 text-emerald-800' : 'border-red-300 bg-red-50 text-red-700'}`}>{notice.text} <button className="ml-2 underline" onClick={() => setNotice(null)}>dismiss</button></div>} Add account</button>} />

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
        <Stat label="Accounts" value={rows?.length ?? 0} />
        <Stat label="Admins" value={admins} />
        <Stat label="Managers" value={(rows ?? []).filter((r) => r.role === 'user').length} />
        <Stat label="BDE" value={(rows ?? []).filter((r) => r.role === 'bde').length} />
        <Stat label="Disabled" value={(rows ?? []).filter((r) => !r.is_active).length} />
      </div>

      <div className="card">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[13px] font-semibold">Accounts</h3>
          <input className="input w-56" placeholder="Search name or e-mail…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {err && <div className="mb-2 text-xs text-red-600">{err}</div>}
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead><tr>{['Name', 'E-mail', 'Role', 'Status', 'Last sign-in', 'Password set', 'Created', ''].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
            <tbody>
              {rows === null && <tr><td className="td text-ink-3" colSpan={8}>Loading…</td></tr>}
              {rows !== null && shown.length === 0 && <tr><td className="td text-ink-3" colSpan={8}>No accounts</td></tr>}
              {shown.map((r) => {
                const isMe = r.id === me.id;
                const locked = r.locked_until && new Date(r.locked_until).getTime() > Date.now();
                return (
                  <tr key={r.id} className={!r.is_active ? 'opacity-60' : ''}>
                    <td className="td font-medium">{r.name || '–'}{isMe && <span className="ml-1.5 rounded bg-accent/10 px-1 text-[10px] text-accent">you</span>}</td>
                    <td className="td">{r.email}</td>
                    <td className="td"><span className={`chip ${r.role === 'admin' ? 'border-accent/40 text-accent' : ''}`} title={ROLE_DESC[r.role]}>{ROLE_LABEL[r.role]}</span></td>
                    <td className="td">{!r.is_active ? <span className="text-red-600">Disabled</span> : locked ? <span className="text-amber-600" title={`Locked until ${fmtDateTime(r.locked_until)}`}>Locked</span> : <span className="text-emerald-600">Active</span>}{r.active_sessions > 0 && r.is_active && <span className="ml-1 text-ink-3">· {r.active_sessions} device{r.active_sessions > 1 ? 's' : ''}</span>}</td>
                    <td className="td text-ink-2">{fmtDateTime(r.last_login_at)}</td>
                    <td className="td text-ink-2">{fmtDateTime(r.password_set_at)}</td>
                    <td className="td text-ink-2" title={r.created_by ? `by ${r.created_by}` : undefined}>{fmtDateTime(r.created_at)}</td>
                    <td className="td">
                      <div className="flex flex-wrap justify-end gap-1">
                        <button className="btn" onClick={() => setModal({ kind: 'password', row: r })}>Set password</button>
                        {!isMe && <select className="input !py-1 text-xs" value={r.role} title="Change the account's view" onChange={(e) => patch(r, { role: e.target.value as AccountRole })}>
                          {(['admin', 'user', 'bde'] as const).map((k) => <option key={k} value={k}>{ROLE_LABEL[k]}</option>)}
                        </select>}
                        {!isMe && <button className="btn" onClick={() => patch(r, { is_active: !r.is_active })}>{r.is_active ? 'Disable' : 'Enable'}</button>}
                        {!isMe && <button className="btn text-red-600 hover:text-red-700" onClick={() => remove(r)}>Delete</button>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-[13px] font-semibold">CSV export password</h3>
            <div className="mt-1 text-xs text-ink-2">
              Every CSV download on every page asks for this one shared password, and each download is written to the activity list below with who exported what.
              {exp === null ? ' Checking…' : exp.configured ? <> Set {fmtDateTime(exp.updated_at)}{exp.updated_by ? ` by ${exp.updated_by}` : ''}.</> : <b className="text-red-600"> Not set yet: all CSV downloads are refused until you set one.</b>}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {exp?.configured && (expPw === null
              ? <button className="btn" onClick={showExport} title="Show the current export password (the view is written to the activity list)">Show password</button>
              : <button className="btn" onClick={() => { setExpPw(null); setExpCopied(false); }}>Hide password</button>)}
            <button className={`btn ${exp && !exp.configured ? 'btn-primary' : ''}`} onClick={() => setModal({ kind: 'export' })}>{exp?.configured ? 'Change export password' : 'Set export password'}</button>
          </div>
        </div>
        {expPw && 'error' in expPw && <div className="mt-2 text-xs text-red-600">{expPw.error}</div>}
        {expPw && 'password' in expPw && (expPw.password
          ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <span className="text-ink-3">Current password</span>
              <code className="rounded border border-line bg-surface-2 px-2 py-1 font-mono text-[13px]">{expPw.password}</code>
              <button className="btn !py-0.5" onClick={() => { navigator.clipboard?.writeText(expPw.password!).then(() => setExpCopied(true)).catch(() => undefined); }}>{expCopied ? 'Copied' : 'Copy'}</button>
            </div>)
          : <div className="mt-2 text-xs text-ink-2">This password was set before the dashboard could show it, and it is stored only as a one-way hash, so it cannot be read back. Use <b>Change export password</b> once: from then on the current password can be shown here.</div>)}
      </div>

      <div className="card">
        <h3 className="mb-3 text-[13px] font-semibold">Recent activity</h3>
        {audit.length === 0 ? <div className="text-xs text-ink-3">Nothing yet</div> : (
          <div className="max-h-64 overflow-auto">
            <table className="w-full text-xs">
              <thead><tr>{['When', 'Who', 'Action', 'Account', 'Detail'].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
              <tbody>{audit.map((a, i) => <tr key={i}><td className="td text-ink-2">{fmtDateTime(a.at)}</td><td className="td">{a.actor}</td><td className="td">{a.action.replace(/_/g, ' ')}</td><td className="td">{a.target ?? ''}</td><td className="td text-ink-3">{a.detail ?? ''}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </div>

            {modal?.kind === 'new' && <NewAccount mail={mail} onClose={() => setModal(null)} onDone={(email, r, wanted) => { setModal(null); load(); mailResult(`Account created for ${email}`, email, r, wanted); }} />}
      {modal?.kind === 'export' && <SetExportPassword onClose={() => setModal(null)} onDone={() => { setModal(null); setExpPw(null); setExpCopied(false); loadExport(); load(); }} />}
      {modal?.kind === 'password' && <SetPassword row={modal.row} self={modal.row.id === me.id} mail={mail} onClose={() => setModal(null)} onDone={(r, wanted) => { setModal(null); load(); mailResult(`Password set for ${modal.row.email}`, modal.row.email, r, wanted); }} />}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return <div className="card"><div className="text-[11px] font-medium text-ink-3">{label}</div><div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div></div>;
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k); }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4" onClick={onClose}>
      <div className="card w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between"><h3 className="text-[13px] font-semibold">{title}</h3><button className="rounded p-1 text-ink-3 hover:text-ink" onClick={onClose}><Icon.Close /></button></div>
        {children}
      </div>
    </div>
  );
}

/** Password field with Generate + Copy + show, shared by the two dialogs */
function PasswordField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [show, setShow] = useState(false);
  const [copied, setCopied] = useState(false);
  const copy = async () => { try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ } };
  return (
    <div>
      <div className="flex gap-1.5">
        <input className="input w-full font-mono" type={show ? 'text' : 'password'} value={value} onChange={(e) => onChange(e.target.value)} autoComplete="new-password" minLength={8} required />
        <button type="button" className="btn" onClick={() => setShow((s) => !s)}>{show ? 'Hide' : 'Show'}</button>
        <button type="button" className="btn" onClick={() => { onChange(generatePassword()); setShow(true); }}>Generate</button>
        <button type="button" className="btn" onClick={copy} disabled={!value}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <div className="mt-1 text-[11px] text-ink-3">At least 8 characters with letters and a number. Share it with the person privately; they can change it later from their menu.</div>
    </div>
  );
}

type MailInfo = { configured: boolean; from: string | null } | null;
type MailResult = { email_sent?: boolean; email_error?: string };
/** "E-mail the password" checkbox: on by default when the Worker can send mail, disabled with a hint otherwise */
function MailOption({ mail, checked, onChange, who }: { mail: MailInfo; checked: boolean; onChange: (v: boolean) => void; who: string }) {
  const can = !!mail?.configured;
  return (
    <label className={`flex items-start gap-2 rounded-lg border border-line p-2 text-[11px] ${can ? 'cursor-pointer' : 'opacity-70'}`}>
      <input type="checkbox" className="mt-0.5" checked={can && checked} disabled={!can} onChange={(e) => onChange(e.target.checked)} />
      <span><b className="text-ink">E-mail the password to {who}</b><br />
        <span className="text-ink-3">{can ? `Sent from ${mail?.from} with the dashboard link, the login e-mail and this password.` : 'E-mail is not set up on the server yet (SMTP mailbox secrets), so share the password another way.'}</span></span>
    </label>
  );
}

function NewAccount({ mail, onClose, onDone }: { mail: MailInfo; onClose: () => void; onDone: (email: string, r: MailResult, wanted: boolean) => void }) {
  const [email, setEmail] = useState(''); const [name, setName] = useState(''); const [role, setRole] = useState<AccountRole>('user'); const [password, setPassword] = useState(generatePassword());
  const [sendEmail, setSendEmail] = useState(true);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const wanted = sendEmail && !!mail?.configured;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { const r = await authCall<MailResult>('/auth/users', { body: { email, name, role, password, send_email: wanted } }); onDone(email, r, wanted); }
    catch (x) {
      // the first try may have been created even though its response was lost; treat a duplicate as done
      const e = x as { status?: number; retried?: boolean };
      if (e.status === 409 && e.retried) { onDone(email, { email_sent: false, email_error: 'the account was created on a retried request; the e-mail status is unknown' }, wanted); return; }
      setErr((x as Error).message);
    } finally { setBusy(false); }
  };
  return (
    <Modal title="Add account" onClose={onClose}>
      <form className="space-y-3" onSubmit={submit}>
        <label className="block text-[11px] font-medium text-ink-3">E-mail<input className="input mt-1 w-full" type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@eduport.ai" /></label>
        <label className="block text-[11px] font-medium text-ink-3">Name<input className="input mt-1 w-full" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <div className="text-[11px] font-medium text-ink-3">Role
          <div className="mt-1 flex gap-2">
            {(['user', 'bde', 'admin'] as const).map((r) => <label key={r} className={`flex flex-1 cursor-pointer items-start gap-2 rounded-lg border p-2 ${role === r ? 'border-accent bg-accent/5' : 'border-line'}`}><input type="radio" className="mt-0.5" checked={role === r} onChange={() => setRole(r)} /><span><b className="text-ink">{ROLE_LABEL[r]}</b><br /><span className="text-ink-3">{ROLE_DESC[r]}</span></span></label>)}
          </div>
        </div>
        <div className="text-[11px] font-medium text-ink-3">Password<div className="mt-1"><PasswordField value={password} onChange={setPassword} /></div></div>
        <MailOption mail={mail} checked={sendEmail} onChange={setSendEmail} who={email || 'this person'} />
        {err && <div className="text-xs text-red-600">{err}</div>}
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button></div>
      </form>
    </Modal>
  );
}

function SetExportPassword({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [password, setPassword] = useState(generatePassword()); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await authCall('/export/password', { method: 'PUT', body: { password } }); onDone(); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal title="CSV export password" onClose={onClose}>
      <form className="space-y-3" onSubmit={submit}>
        <PasswordField value={password} onChange={setPassword} />
        <div className="text-[11px] text-ink-3">Share it only with the people allowed to take data out of the dashboard. Changing it takes effect within a minute; nobody is signed out.</div>
        {err && <div className="text-xs text-red-600">{err}</div>}
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save password'}</button></div>
      </form>
    </Modal>
  );
}

function SetPassword({ row, self, mail, onClose, onDone }: { row: Row; self: boolean; mail: MailInfo; onClose: () => void; onDone: (r: MailResult, wanted: boolean) => void }) {
  const [password, setPassword] = useState(generatePassword()); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const [sendEmail, setSendEmail] = useState(!self);
  const wanted = sendEmail && !!mail?.configured;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { const r = await authCall<MailResult>(`/auth/users/${row.id}/password`, { body: { password, send_email: wanted } }); onDone(r, wanted); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal title={`Set password · ${row.email}`} onClose={onClose}>
      <form className="space-y-3" onSubmit={submit}>
        <PasswordField value={password} onChange={setPassword} />
        <MailOption mail={mail} checked={sendEmail} onChange={setSendEmail} who={row.email} />
        <div className="text-[11px] text-ink-3">{self ? 'Your other devices will be signed out.' : 'The person will be signed out everywhere and must use the new password.'}</div>
        {err && <div className="text-xs text-red-600">{err}</div>}
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Set password'}</button></div>
      </form>
    </Modal>
  );
}
