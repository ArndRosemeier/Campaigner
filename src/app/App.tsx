import { useEffect } from 'react';
import type { JSX } from 'react';
import { RouterProvider } from 'react-router-dom';

import { GlobalErrorBoundary } from '@/app/GlobalErrorBoundary';
import { router } from '@/app/router';
import { installGlobalErrorHandlers } from '@/lib/globalErrors';

/** Application root: global error surface + the central data router. */
export function App(): JSX.Element {
  useEffect(() => {
    installGlobalErrorHandlers();
  }, []);

  return (
    <GlobalErrorBoundary>
      <RouterProvider router={router} />
    </GlobalErrorBoundary>
  );
}
