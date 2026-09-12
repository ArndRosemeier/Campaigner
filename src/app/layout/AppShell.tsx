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
import { reconcileInterruptedModuleGens } from '@/llm/moduleGenReconcile';
import { onPageResumed } from '@/lib/pageLiveness';
import {
  applyBackgroundTitle,
  clearFinishedBackgroundActivities,
} from '@/lib/backgroundTitle';
import { seedBuiltInPersonas } from '@/db/seed';
import { ensurePersistentStorage } from '@/lib/deviceCapabilities';
import { toastError, toastInfo } from '@/lib/toast';
import { readSettings, updateSettings } from '@/db/settingsRepo';
import { HelpDialog } from '@/help/HelpDialog';
import { useHelpStore } from '@/help/helpStore';
import { useLibraryCreaturePool } from '@/app/use-library-creatures';
import { formatCreatureCitationRepair } from '@/domain/creatureCitationRepair';
import { SetupWizardDialog } from '@/features/onboarding/SetupWizardDialog';
import { useOnboardingStore } from '@/features/onboarding/onboardingStore';
import { maybeAutoOpenWizard } from '@/features/onboarding/onboardingState';

/**
 * App frame shown on every route: the top bar (app name, campaign switcher,
 * Rules/Settings nav, theme toggle) above the campaign bar (campaign-level
 * tabs + breadcrumb), above the routed page content (05-UI.md §Top bar).
 * Hosts the app-wide TooltipProvider and the single Toaster (errors surface
 * through `lib/toast.ts` only). On START (a mount effect, never the render
 * body — docs/17 row 110) it reconciles rows a previous page left behind: runs
 * still 'running' are marked failed (04-LLM-PERSONAS "Interrupted by reload")
 * and module rows still 'generating' with no live pass are failed LOUDLY with a
 * named recovery instruction (`llm/moduleGenReconcile`); the same module
 * reconciliation runs on the way back into a tab that was hidden, frozen or
 * discarded, and the shell owns restoring the app's own `document.title` when
 * the tab is visible again (the background line belongs to the trip away).
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
  // THE library creature pool (docs/11 D10): published here because every
  // reader surface resolves wiki-links through `lib/wikilinks`, and a mention
  // of a bestiary creature must read as a CITATION rather than a broken link.
  useLibraryCreaturePool();
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
    // The v21 migration notice (docs/17 row 108): the Dexie upgrade DROPPED
    // the `deliverables` table, because the module is now the PDF's document
    // model and the outline has no reader left. The upgrade body cannot toast
    // (it runs before React exists, inside Dexie), so it wrote the removed row
    // count into settings; this reads it ONCE and says what happened, in the
    // open. Those rows were the owner's own work — a table that vanished
    // without a word is the silent-loss shape AGENTS rule 1 forbids.
    void readSettings()
      .then(async (settings) => {
        const removed = settings.deliverablesRemoved;
        if (removed === 0) return;
        toastInfo(
          `The deliverables table was removed — its ${String(removed)} saved module ${removed === 1 ? 'outline' : 'outlines'} ${
            removed === 1 ? 'is' : 'are'
          } gone. A module PDF is now generated from the module itself, so no outline is needed; nothing else changed.`,
        );
        await updateSettings({ deliverablesRemoved: 0 });
      })
      .catch((error: unknown) => {
        toastError('Could not report the deliverables migration', error);
      });
  }, []);

  useEffect(() => {
    // ONE loud migration report (docs/11 D7): the core-mob arc's Dexie upgrade
    // rewrote citations that pointed at a retired bestiary creature row and
    // deleted those rows as cache. The upgrade body cannot toast (it runs
    // before React, inside Dexie), so it writes what it did into settings and
    // this reads it ONCE — the counts the owner needs to trust their
    // encounters, and the names of anything it could NOT convert, stated in as
    // many words rather than swallowed (AGENTS rule 2).
    void readSettings()
      .then(async (settings) => {
        const report = settings.creatureCitationRepair;
        if (report === null) return;
        toastInfo(formatCreatureCitationRepair(report));
        await updateSettings({ creatureCitationRepair: null });
      })
      .catch((error: unknown) => {
        toastError('Could not report the bestiary citation repair', error);
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

  useEffect(() => {
    // Startup reconciliation, in a MOUNT EFFECT and never in the render body
    // (docs/17 row 110). It used to run inline, which meant EVERY render — a
    // theme toggle, opening help, the wizard store — called
    // `failRunningRuns()` again, and a live streaming run whose row said
    // 'running' was marked failed with 'Interrupted by reload' by a user who
    // only switched the theme. The engine restores 'running' at its next step
    // write and clears the stale verdict with it (runEngine.executeFrom), but
    // the defect was the call site: reconciliation is a STARTUP act.
    void failRunningRuns().catch((error: unknown) => {
      // Startup reconciliation failure must be visible, not console-only.
      toastError('Could not reconcile interrupted runs', error);
    });
    // The module twin of that reconciliation (docs/17 row 110): a module row
    // left at 'generating' by a discarded/reloaded tab has NO engine to restore
    // it — without this it stayed 'generating' forever, with a Stop button that
    // did nothing and every retry affordance gated behind `!busy`. Loud, and
    // never touching a row a live pass (or another tab's lock) still owns.
    void reconcileInterruptedModuleGens().catch((error: unknown) => {
      toastError('Could not reconcile interrupted module generations', error);
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
  }, []);

  useEffect(() => {
    // Coming back IN is the second reconciliation moment (docs/17 row 110): a
    // tab that was frozen or discarded while a module was generating returns
    // with a dead 'generating' row, and this is the first instant the app can
    // see it — the same guard makes it safe (a live pass is never touched).
    // Runs are deliberately NOT reconciled here: a merely hidden tab keeps
    // running its engine, so failing 'running' rows on a tab switch would
    // invent exactly the defect this slice removes.
    const unsubscribe = onPageResumed(() => {
      void reconcileInterruptedModuleGens().catch((error: unknown) => {
        toastError('Could not reconcile interrupted module generations', error);
      });
      // The visible app owns its own title again: the background line (and the
      // ✓/⚠ it was carrying) is news for the trip away, not for now.
      clearFinishedBackgroundActivities();
      applyBackgroundTitle();
    });
    return unsubscribe;
  }, []);

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
