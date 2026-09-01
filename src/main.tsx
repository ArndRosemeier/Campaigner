import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@/index.css';
import { App } from '@/app/App';

// Built-in personas are seeded (insert-if-missing) from AppShell's mount
// effect so a seeding failure surfaces as a visible toast — console-only
// errors are forbidden (00-OVERVIEW §Global conventions).

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element #root not found — check index.html.');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Service worker (05-UI.md §Tablet): caches the built app shell so a reload
// works offline and the installed home-screen app starts instantly. Data
// lives in IndexedDB and is untouched. Production only — under `vite dev` a
// SW would serve stale pre-bundle chunks.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  // Relative to the Vite base so non-root deployments scope correctly.
  const swUrl = `${import.meta.env.BASE_URL}sw.js`;
  void navigator.serviceWorker.register(swUrl).catch((error: unknown) => {
    // Offline support is an enhancement; a registration failure must not
    // break startup, but it must not vanish silently either — the global
    // error boundary reports it.
    window.dispatchEvent(
      new ErrorEvent('error', { message: `Service worker registration failed: ${String(error)}` }),
    );
  });
}
