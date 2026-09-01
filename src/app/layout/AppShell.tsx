import { useEffect } from 'react';
import type { JSX } from 'react';
import { Outlet } from 'react-router-dom';

import { TopBar } from '@/app/layout/TopBar';
import { useThemeSync } from '@/app/theme/theme';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { QuickFindHotkey } from '@/features/quickfind/quickfind-hotkey';
import { ProgressDock } from '@/features/progress/progress-dock';
import { failRunningRuns } from '@/db/runRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { toastError } from '@/lib/toast';
import { HelpDialog } from '@/help/HelpDialog';
import { useHelpStore } from '@/help/helpStore';

/**
 * App frame shown on every route: the top bar (app name, campaign switcher,
 * nav links, theme toggle) above the routed page content (05-UI.md §Top bar).
 * Hosts the app-wide TooltipProvider and the single Toaster (errors surface
 * through `lib/toast.ts` only). On start, runs left 'running' by a reload are
 * marked failed (04-LLM-PERSONAS "Interrupted by reload").
 */
export function AppShell(): JSX.Element {
  useThemeSync();
  const openHelp = useHelpStore((state) => state.openHelp);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== '?') return;
      const target = event.target;
      const typing =
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);
      if (typing) return;
      event.preventDefault();
      openHelp();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [openHelp]);

  void failRunningRuns().catch((error: unknown) => {
    // Startup reconciliation failure must be visible, not console-only.
    toastError('Could not reconcile interrupted runs', error);
  });
  // Built-in personas: insert-if-missing on every app start (01-DATA-MODEL).
  // Seeding after mount (not in main.tsx) so failures surface as toasts.
  void seedBuiltInPersonas().catch((error: unknown) => {
    toastError('Could not load built-in personas — generation stays unavailable', error);
  });

  return (
    <TooltipProvider>
      <div className="flex h-dvh flex-col">
        <TopBar />
        <main className="min-h-0 flex-1">
          <Outlet />
        </main>
        <Toaster position="bottom-right" />
        <ProgressDock />
        <HelpDialog />
        <QuickFindHotkey />
      </div>
    </TooltipProvider>
  );
}
