import { useEffect } from 'react';
import type { JSX } from 'react';
import { RouterProvider } from 'react-router-dom';

import { DatabaseGate } from '@/app/DatabaseGate';
import { GlobalErrorBoundary } from '@/app/GlobalErrorBoundary';
import { router } from '@/app/router';
import { installGlobalErrorHandlers } from '@/lib/globalErrors';

/**
 * Application root: global error surface + the boot gate + the central data
 * router. The gate opens (and, if the stored database is older, upgrades) the
 * database BEFORE any route component can touch a table, so the ONE
 * `version(31)` clean-cut purge runs exactly once and a failure lands on its
 * named recovery card instead of a route crash (docs/17 row 278).
 */
export function App(): JSX.Element {
  useEffect(() => {
    installGlobalErrorHandlers();
  }, []);

  return (
    <GlobalErrorBoundary>
      <DatabaseGate>
        <RouterProvider router={router} />
      </DatabaseGate>
    </GlobalErrorBoundary>
  );
}
