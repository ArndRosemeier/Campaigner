import type { JSX } from 'react';
import { RouterProvider } from 'react-router-dom';

import { router } from '@/app/router';

/** Application root: mounts the central data router. */
export function App(): JSX.Element {
  return <RouterProvider router={router} />;
}
