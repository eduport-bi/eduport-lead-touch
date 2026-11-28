import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell, DRAFT_PAGES } from './components/AppShell';
import { Skeleton } from './components/ui';
import { useAuth, canExplore } from './lib/auth';

/** the Lead explorer is not part of the BDE view */
function ExplorerRoute({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  return canExplore(user?.role) ? <>{children}</> : <Navigate to="/" replace />;
}

const Overview = lazy(() => import('./pages/Overview'));
const Converted = lazy(() => import('./pages/Converted'));
const Calls = lazy(() => import('./pages/Calls'));   // DRAFT, sample data
const Analysis = lazy(() => import('./pages/Analysis'));
const LeadExplorer = lazy(() => import('./pages/LeadExplorer'));
const Access = lazy(() => import('./pages/Access'));

const Fallback = () => <div className="grid gap-3 md:grid-cols-4">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-24" />)}</div>;

export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Suspense fallback={<Fallback />}><Overview /></Suspense>} />
        <Route path="converted" element={<Suspense fallback={<Fallback />}><Converted /></Suspense>} />
        {/* draft, sample data: the live site sends /calls to Overview */}
        <Route path="calls" element={DRAFT_PAGES ? <Suspense fallback={<Fallback />}><Calls /></Suspense> : <Navigate to="/" replace />} />
        <Route path="analysis" element={<Suspense fallback={<Fallback />}><Analysis /></Suspense>} />
        <Route path="leads" element={<ExplorerRoute><Suspense fallback={<Fallback />}><LeadExplorer /></Suspense></ExplorerRoute>} />
        <Route path="access" element={<Suspense fallback={<Fallback />}><Access /></Suspense>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
