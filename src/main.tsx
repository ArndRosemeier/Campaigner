import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@/index.css';
import { App } from '@/app/App';
import { seedBuiltInPersonas } from '@/db/seed';

// Built-in personas: insert-if-missing on every app start (01-DATA-MODEL).
// Failures must not block the app from rendering.
void seedBuiltInPersonas().catch((error: unknown) => {
  console.error('[campaigner] failed to seed built-in personas:', error);
});

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element #root not found — check index.html.');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
