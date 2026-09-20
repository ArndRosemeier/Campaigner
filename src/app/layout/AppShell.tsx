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
import { reconcileInterruptedPdfImports, reconcileInterruptedPackImports } from '@/ingest/ingestReconcile';
import { onPageResumed } from '@/lib/pageLiveness';
import {
  applyBackgroundTitle,
  clearFinishedBackgroundActivities,
} from '@/lib/backgroundTitle';
import { seedBuiltInPersonas } from '@/db/seed';
import { ensurePersistentStorage } from '@/lib/deviceCapabilities';
import { toastError, toastInfoPersistent } from '@/lib/toast';
import { readSettings, updateSettings } from '@/db/settingsRepo';
import { HelpDialog } from '@/help/HelpDialog';
import { useHelpStore } from '@/help/helpStore';
import { useLibraryCreaturePool } from '@/app/use-library-creatures';
import { formatCleanCut } from '@/domain/cleanCut';
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
 * named recovery instruction (`llm/moduleGenReconcile`); interrupted PDF and
 * PACK imports are reconciled to a named failure too, through the ONE
 * `ingest/ingestReconcile` seam (docs/17 rows 266 and 277); the same module
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
    // THE clean-cut report, PINNED AT LAST (docs/17 rows 278 and 280). The ONE
    // `version(31)` upgrade body removed every campaign-scoped row BEFORE React
    // mounted, so it could not toast: it wrote the counts into settings. This
    // reads them, says exactly what was removed and what was kept, and — since
    // row 280 — KEEPS the report until the owner ACKNOWLEDGES it. The named
    // count (and the `libraryLegacyCitationsDropped` instrument) is the whole
    // point: the owner asked for a clean delete he can SEE, never a silent one.
    //
    // WHAT WENT WRONG THE FIRST TIME, MEASURED ON HIS ONLY REAL RUN: the notice
    // was a 4-second `toastInfo` and `settings.cleanCut` was nulled in the same
    // turn. The first-run wizard auto-opens from ITS OWN effect on the SAME
    // condition (settings untouched by the purge, so `status` is still 'fresh',
    // and every campaign row is now gone — `maybeAutoOpenWizard`), so the modal
    // held the owner's attention while the one sentence a DESTRUCTIVE operation
    // produces expired, and the record went with it. The cure is the EXISTING
    // persistent seam (`toastInfoPersistent`): `duration: Infinity` plus
    // sonner's own close button, so the modal cannot outlast it, and the report
    // row survives a reload, a crash or a closed tab.
    //
    // THE WIZARD INTERACTION, DECIDED (row 280): the two surfaces are
    // INDEPENDENT and the notice is deliberately NOT deferred behind the wizard.
    // A purge is exactly when a first-run wizard appears, and deferring would
    // make the destructive notice conditional on the owner finishing or
    // dismissing setup — the notice names what was DESTROYED, so a modal must
    // never be the reason it is unseen. Nothing had to be re-ordered to get
    // that: the Toaster is an app-level fixed layer above the dialog (sonner's
    // `z-index: 999999999` vs the dialog's `z-50`), and the wizard only writes
    // `settings.onboarding` — through `updateSettings`, which MERGES — so
    // neither opening nor dismissing the wizard can hide or consume this
    // notice. `tests/app/clean-cut-notice.test.tsx` pins the wizard-open case.
    //
    // ACKNOWLEDGED means: the owner activated the notice's own close control
    // (`toastInfoPersistent`'s `onDismiss`). Nothing else clears the row — not
    // a reload, not the wizard, not a second launch. A never-seen report is
    // therefore re-said on every launch until it is seen, and the row itself is
    // the durable record for as long as that lasts.
    let active = true;
    void readSettings()
      .then((settings) => {
        const report = settings.cleanCut;
        if (report === null || !active) return;
        toastInfoPersistent(formatCleanCut(report), () => {
          // The owner has seen it. The write rides the ONE settings write
          // (AGENTS rule 4); a failure is LOUD and leaves the row in place, so
          // the notice is raised again next launch rather than vanishing
          // silently (AGENTS rules 1-2).
          void updateSettings({ cleanCut: null }).catch((error: unknown) => {
            toastError('Could not record the clean-base notice as seen', error);
          });
        });
      })
      .catch((error: unknown) => {
        toastError('Could not report the clean-base update', error);
      });
    return () => {
      active = false;
    };
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
    // The rulebook twin (docs/17 row 266): a PDF import creates its row BEFORE
    // the extraction, so a tab reloaded or discarded mid-import left a book
    // reading 'processing…' forever — and the Rules page offers its Retry…
    // control only for 'error', so nothing could move the row. Start is the
    // load-bearing moment (a discarded tab RELOADS, and this page has started
    // no import yet); it is deliberately NOT wired to `onPageResumed` below,
    // because a merely suspended tab resumes its OWN extraction and failing
    // that row would invent the defect this removes. The write is loud and
    // leaves a row another tab holds the ingest lease on alone.
    void reconcileInterruptedPdfImports().catch((error: unknown) => {
      toastError('Could not reconcile interrupted PDF imports', error);
    });
    // The PACK arm of the same rulebook reconcile (docs/17 row 277): a pack book
    // also carries 'processing' and is left behind by a discarded tab, but it
    // has NO file to re-select — so it rides the SAME reconcile seam with its
    // OWN named remedy sentence ("Import bestiary pack" again). `importPack`
    // holds the same ingest lease, so a live pack import in another tab is left
    // alone exactly like a live PDF extraction.
    void reconcileInterruptedPackImports().catch((error: unknown) => {
      toastError('Could not reconcile interrupted pack imports', error);
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
