import type { JSX } from 'react';
import { Outlet } from 'react-router-dom';

import { TopBar } from '@/app/layout/TopBar';
import { useThemeSync } from '@/app/theme/theme';

/**
 * App frame shown on every route: the top bar (app name, campaign switcher,
 * nav links, theme toggle) above the routed page content (05-UI.md §Top bar).
 */
export function AppShell(): JSX.Element {
  useThemeSync();

  return (
    <div className="flex h-dvh flex-col">
      <TopBar />
      <main className="min-h-0 flex-1">
        <Outlet />
      </main>
    </div>
  );
}
