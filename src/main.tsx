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
