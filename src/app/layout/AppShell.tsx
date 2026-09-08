import { useEffect } from 'react';
import type { JSX } from 'react';
import { Outlet } from 'react-router-dom';

import { TopBar } from '@/app/layout/TopBar';
import { CampaignBar } from '@/app/layout/CampaignBar';
import { MissingRefsBanner } from '@/features/campaign/components/missing-refs-banner';
import { useThemeSync } from '@/app/theme/theme';
import { useUiScaleSync } from '@/app/theme/uiScale';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { InstallHint } from '@/app/layout/install-hint';
import { QuickFindHotkey } from '@/features/quickfind/quickfind-hotkey';
import { ProgressDock } from '@/features/progress/progress-dock';
import { failRunningRuns } from '@/db/runRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { ensurePersistentStorage } from '@/lib/deviceCapabilities';
import { toastError, toastInfo } from '@/lib/toast';
import { readSettings, updateSettings } from '@/db/settingsRepo';
import { HelpDialog } from '@/help/HelpDialog';
import { useHelpStore } from '@/help/helpStore';
import { SetupWizardDialog } from '@/features/onboarding/SetupWizardDialog';
import { useOnboardingStore } from '@/features/onboarding/onboardingStore';
import { maybeAutoOpenWizard } from '@/features/onboarding/onboardingState';

/**
 * App frame shown on every route: the top bar (app name, campaign switcher,
 * Rules/Settings nav, theme toggle) above the campaign bar (campaign-level
 * tabs + breadcrumb), above the routed page content (05-UI.md §Top bar).
 * Hosts the app-wide TooltipProvider and the single Toaster (errors surface
 * through `lib/toast.ts` only). On start, runs left 'running' by a reload are
 * marked failed (04-LLM-PERSONAS "Interrupted by reload").
 *
 * Tablet/PWA frame (05-UI.md §Tablet): the shell pads itself with the
 * platform safe-area insets on all four sides (landscape iPad notches sit
 * on the left/right edges; the bottom inset keeps content clear of the home
 * indicator when the ProgressDock is empty). The dock and the Toaster carry
 * their own bottom offsets — they apply exactly once (fixed layers ignore
 * this frame padding), so this must stay a plain frame pad, never a
 * dock-sized spacer. Portrait and narrow viewports are NOT gated (owner
 * decision 2026-09-09): the landscape layout simply renders at whatever
 * width the viewport offers — cramped portrait works, just narrowly.
 */
export function AppShell(): JSX.Element {
  useThemeSync();
  useUiScaleSync();
  const openHelp = useHelpStore((state) => state.openHelp);
  const wizardOpen = useOnboardingStore((state) => state.open);

  useEffect(() => {
    // First-run wizard: opens once on a fresh, empty browser (see
    // maybeAutoOpenWizard); re-open affordances live elsewhere. The
    // liveness check stops an unmounted shell from opening it.
    let active = true;
    void maybeAutoOpenWizard(() => active).catch((error: unknown) => {
      toastError('Could not check first-run setup state', error);
    });
    return () => {
      active = false;
    };
  }, []);

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
      <div
        className="flex h-dvh flex-col pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]"
        data-testid="app-shell"
      >
        <InstallHint />
        <TopBar />
        <CampaignBar />
        {/* Campaign-level missing-refs banner (M3-E slice B): null unless
            the open campaign's encounters dangle — so the picker, Rules,
            Settings and clean campaigns render exactly as before. */}
        <MissingRefsBanner />
        <main className="min-h-0 flex-1">
          <Outlet />
        </main>
        <Toaster
          position="bottom-right"
          offset={{ bottom: 'max(env(safe-area-inset-bottom), 1rem)' }}
        />
        <ProgressDock />
        <HelpDialog />
        {wizardOpen && <SetupWizardDialog />}
        <QuickFindHotkey />
      </div>
    </TooltipProvider>
  );
}
