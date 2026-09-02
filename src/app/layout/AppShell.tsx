import { useEffect } from 'react';
import type { JSX } from 'react';
import { Outlet } from 'react-router-dom';

import { TopBar } from '@/app/layout/TopBar';
import { useThemeSync } from '@/app/theme/theme';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { InstallHint } from '@/app/layout/install-hint';
import { OrientationGate } from '@/app/layout/orientation-gate';
import { QuickFindHotkey } from '@/features/quickfind/quickfind-hotkey';
import { ProgressDock } from '@/features/progress/progress-dock';
import { failRunningRuns } from '@/db/runRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { ensurePersistentStorage } from '@/lib/deviceCapabilities';
import { toastError, toastInfo } from '@/lib/toast';
import { readSettings, updateSettings } from '@/db/settingsRepo';
import { HelpDialog } from '@/help/HelpDialog';
import { useHelpStore } from '@/help/helpStore';

/**
 * App frame shown on every route: the top bar (app name, campaign switcher,
 * nav links, theme toggle) above the routed page content (05-UI.md §Top bar).
 * Hosts the app-wide TooltipProvider and the single Toaster (errors surface
 * through `lib/toast.ts` only). On start, runs left 'running' by a reload are
 * marked failed (04-LLM-PERSONAS "Interrupted by reload").
 *
 * Tablet/PWA frame (05-UI.md §Tablet): the shell pads itself with the
 * platform safe-area insets (landscape iPad notches sit on the left/right
 * edges), the OrientationGate hard-blocks portrait/narrow viewports, and the
 * one-time install hint explains home-screen installation.
 */
export function AppShell(): JSX.Element {
  useThemeSync();
  const openHelp = useHelpStore((state) => state.openHelp);

  useEffect(() => {
    void readSettings()
      .then(async (settings) => {
        const removed = settings.retiredSessionNotesRemoved;
        if (removed === 0) return;
        toastInfo(
          `${String(removed)} session ${removed === 1 ? 'note' : 'notes'} from the retired play view ${removed === 1 ? 'was' : 'were'} removed`,
        );
        await updateSettings({ retiredSessionNotesRemoved: 0 });
      })
      .catch((error: unknown) => {
        toastError('Could not report the play-view migration', error);
      });
  }, []);

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
  // Persistence request: best-effort on first run; denial is not an error but
  // its status is shown in Settings → Backup & restore.
  void ensurePersistentStorage().catch((error: unknown) => {
    toastError('Could not request persistent storage', error);
  });

  return (
    <TooltipProvider>
      <div className="flex h-dvh flex-col pt-[env(safe-area-inset-top)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
        <OrientationGate />
        <InstallHint />
        <TopBar />
        <main className="min-h-0 flex-1">
          <Outlet />
        </main>
        <Toaster
          position="bottom-right"
          offset={{ bottom: 'max(env(safe-area-inset-bottom), 1rem)' }}
        />
        <ProgressDock />
        <HelpDialog />
        <QuickFindHotkey />
      </div>
    </TooltipProvider>
  );
}
