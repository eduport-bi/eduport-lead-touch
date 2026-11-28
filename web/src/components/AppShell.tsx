import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useMeta } from '../hooks/useMeta';
import { useTheme } from '../lib/palette';
import { fmtDateTime, fmtInt } from '../lib/format';
import { FilterBar } from './FilterBar';
import { ErrorBoundary, Icon, Popover } from './ui';
import { useAuth, ROLE_LABEL, canExplore } from '../lib/auth';
import { UserMenu } from './UserMenu';
import { SyncButton } from './SyncButton';
import { useUpdating } from '../lib/api';

export const NAV = [
  { to: '/', label: 'Overview', icon: <Icon.Home /> },
  { to: '/converted', label: 'Converted', icon: <Icon.Spark /> },
  { to: '/calls', label: 'Lead Call Analytics', icon: <Icon.Touch /> },   // DRAFT, sample data
  { to: '/analysis', label: 'Analysis', icon: <Icon.Table /> },
  { to: '/leads', label: 'Lead Explorer', icon: <Icon.Users /> },
];

export function AppShell() {
  const { data: meta, error } = useMeta();
  const { dark, toggle } = useTheme();
  const { user } = useAuth();
  const base = canExplore(user?.role) ? NAV : NAV.filter((n) => n.to !== '/leads');
  const nav = user?.role === 'admin' ? [...base, { to: '/access', label: 'Access', icon: <Icon.Users /> }] : base;
  const asOf = meta?.dataAsOf;
  // one sync a day (06:00 IST, 2026-11-25): data up to a day old is normal; amber only when the daily refresh was missed
  const stale = asOf?.refreshed_at ? Date.now() - new Date(asOf.refreshed_at).getTime() > 26 * 3600e3 : false;
  const updating = useUpdating();
  const syncErr = meta?.syncState.some((s) => s.last_error);
  const path = useLocation().pathname;
  const noFilters = path.startsWith('/analysis') || path.startsWith('/access');   // Analysis works from the uploaded file, Access is not data

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-56 shrink-0 flex-col border-r border-line bg-surface md:flex">
        <div className="sticky top-0 flex h-screen flex-col p-3">
          <div className="flex items-center gap-2 px-0.5 pb-4 pt-1">
            <img src="/eduport-logo.png" alt="Eduport" className="h-10 w-10 rounded-full border border-line bg-white object-cover" />
            <div>
              <div className="whitespace-nowrap text-xl font-semibold leading-tight tracking-tight text-accent">Eduport</div>
              <div className="whitespace-nowrap text-[13px] font-medium leading-tight tracking-tight text-ink-3">Lead Touch Analytics</div>
            </div>
          </div>
          <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-3">Pages</div>
          <nav className="space-y-0.5">
            {nav.map((n) => (
              <NavLink key={n.to} to={{ pathname: n.to, search: window.location.search }} end={n.to === '/'}
                className={({ isActive }) => `flex items-center gap-2.5 rounded-lg px-3 py-2 text-xs font-medium transition ${isActive ? 'bg-accent/10 text-accent' : 'text-ink-2 hover:bg-surface-2 hover:text-ink'}`}>
                <span className="opacity-80">{n.icon}</span>{n.label}
              </NavLink>
            ))}
          </nav>

          <div className="mt-auto rounded-lg border border-line bg-surface-2 p-3">
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${error ? 'bg-red-500' : stale || syncErr ? 'bg-amber-500' : 'bg-emerald-500'}`} />
              <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">Data freshness</div>
            </div>
            <div className="mt-1 text-sm font-semibold leading-tight">{asOf?.refreshed_at ? fmtDateTime(asOf.refreshed_at) : 'loading…'}</div>
            <div className="mt-0.5 text-[10px] text-ink-3">{fmtInt(asOf?.lead_rows)} leads · {fmtInt(asOf?.touch_rows)} touches</div>
            <div className="mt-1.5 text-[10px] text-ink-3">Salesforce watermark {fmtDateTime(asOf?.salesforce_as_of)}</div>
          </div>
          <div className="mt-2 px-1 text-[10px] text-ink-3">
            {meta && <span>v{meta.version} · {user ? ROLE_LABEL[user.role].toLowerCase() : 'user'}</span>}
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 flex items-center justify-between gap-2 border-b border-line bg-surface px-6 py-2.5">
          <div className="flex items-center gap-2">
            <select className="input md:hidden" value={window.location.pathname} onChange={(e) => (window.location.href = e.target.value + window.location.search)}>
              {nav.map((n) => <option key={n.to} value={n.to}>{n.label}</option>)}
            </select>
            <Popover width="w-96" trigger={
              <button className={`chip ${stale || syncErr ? 'border-amber-400 text-ink' : ''}`} title="Data freshness">
                <span className={`h-1.5 w-1.5 rounded-full ${error ? 'bg-red-500' : stale || syncErr ? 'bg-amber-400' : 'bg-emerald-500'}`} />
                Data as of {asOf?.refreshed_at ? fmtDateTime(asOf.refreshed_at) : '…'}
              </button>}>
              <div className="space-y-2 text-xs">
                <div><span className="text-ink-3">Analytics table refreshed:</span> {fmtDateTime(asOf?.refreshed_at)}</div>
                <div><span className="text-ink-3">Salesforce watermark:</span> {fmtDateTime(asOf?.salesforce_as_of)}</div>
                <div><span className="text-ink-3">Last sync run:</span> {fmtDateTime(asOf?.last_sync_run_at)}</div>
                <div><span className="text-ink-3">Rows:</span> {fmtInt(asOf?.lead_rows)} leads · {fmtInt(asOf?.touch_rows)} touches</div>
                <table className="w-full text-[11px]"><tbody>
                  {meta?.syncState.map((s) => <tr key={s.object_name}><td className="pr-2 text-ink-3">{s.object_name}</td><td>{fmtDateTime(s.last_run_at)}</td><td className="text-right">{fmtInt(s.last_run_rows)}</td><td className="text-red-500">{s.last_error ? '⚠' : ''}</td></tr>)}
                </tbody></table>
              </div>
            </Popover>
            {updating && <span className="chip animate-pulse border-accent/40 text-accent" title="Showing the previous numbers (before the last filter change or data refresh); the new numbers replace them in a moment">Updating…</span>}
          </div>
          <div className="flex items-center gap-2">
            {user?.role === 'admin' && <SyncButton />}
            <button className="btn !px-2" onClick={toggle} title="Toggle theme">{dark ? <Icon.Sun /> : <Icon.Moon />}</button>
            <UserMenu />
          </div>
        </header>
        <main className="flex-1 px-6 pb-10 pt-4">
          {!noFilters && <FilterBar mode={path.startsWith('/converted') ? 'payment' : path.startsWith('/calls') ? 'calls' : undefined} />}
          <ErrorBoundary label="page"><Outlet /></ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
