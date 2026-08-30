import type { JSX } from 'react';
import { Outlet } from 'react-router-dom';

import { TopBar } from '@/app/layout/TopBar';
import { useThemeSync } from '@/app/theme/theme';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';

/**
 * App frame shown on every route: the top bar (app name, campaign switcher,
 * nav links, theme toggle) above the routed page content (05-UI.md §Top bar).
 * Hosts the app-wide TooltipProvider and the single Toaster (errors surface
 * through `lib/toast.ts` only).
 */
export function AppShell(): JSX.Element {
  useThemeSync();

  return (
    <TooltipProvider>
      <div className="flex h-dvh flex-col">
        <TopBar />
        <main className="min-h-0 flex-1">
          <Outlet />
        </main>
        <Toaster position="bottom-right" />
      </div>
    </TooltipProvider>
  );
}
