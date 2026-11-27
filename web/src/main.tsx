import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { AuthGate } from './components/AuthGate';
import { ExportGateProvider } from './lib/exportGate';
import './index.css';

// After a deploy the old build's page files are gone, so a tab opened before it fails to open a page ("Failed to fetch dynamically
// imported module"). Reload once to pick up the new build; the session flag stops a reload loop if the file is really missing (2026-11-27).
window.addEventListener('vite:preloadError', (e) => {
  try {
    if (sessionStorage.getItem('lt-reloaded-for-build')) return;
    sessionStorage.setItem('lt-reloaded-for-build', '1');
  } catch { /* storage blocked: still reload once */ }
  e.preventDefault();
  window.location.reload();
});
window.addEventListener('load', () => { setTimeout(() => { try { sessionStorage.removeItem('lt-reloaded-for-build'); } catch { /* ignore */ } }, 10_000); });

const queryClient = new QueryClient({
  defaultQueries: undefined,
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,       // aggregates change only when the MVs refresh
      gcTime: 30 * 60 * 1000,
      retry: (count, err) => count < 2 && !(err as { status?: number }).status,
      refetchOnWindowFocus: false,
    },
  },
} as ConstructorParameters<typeof QueryClient>[0]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthGate>
        <BrowserRouter>
          <ExportGateProvider>
            <App />
          </ExportGateProvider>
        </BrowserRouter>
      </AuthGate>
    </QueryClientProvider>
  </React.StrictMode>,
);
