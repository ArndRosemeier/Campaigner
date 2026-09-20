import 'fake-indexeddb/auto';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAppRouter } from '@/app/router';
import { ROUTES } from '@/app/routes';
import { defaultSettings, type CleanCutReport } from '@/domain';
import { formatCleanCut } from '@/domain/cleanCut';
import { readSettings, saveSettings } from '@/db/settingsRepo';
import { useOnboardingStore } from '@/features/onboarding/onboardingStore';
import { useHelpStore } from '@/help/helpStore';
import { clearDatabase } from '../db/helpers';
import { actDrained, flushAsyncUpdates } from '../helpers/flush';

/**
 * THE CLEAN-CUT NOTICE MUST REACH THE OWNER — and the report must outlive the
 * mount (docs/17 rows 278 and 280).
 *
 * THE OWNER'S REPORT, as a pin. On his ONLY real run of the `version(31)` clean
 * cut the purge DID run (campaign rows removed, library and settings kept,
 * `settings.cleanCut` written inside the same `versionchange` transaction — the
 * half `tests/db/clean-cut.test.ts` already measures). He still never saw the
 * sentence naming what was removed, and there was no record left to read: the
 * notice was a 4-second `toastInfo` fired from `AppShell`'s mount effect, on the
 * same condition that auto-opens the FIRST-RUN WIZARD (a purge keeps `settings`,
 * so `onboarding.status` is still `'fresh'` while the campaign count is zero —
 * `features/onboarding/onboardingState.maybeAutoOpenWizard`), and the SAME effect
 * then nulled `settings.cleanCut`. The one notification a DESTRUCTIVE operation
 * produces expired under a modal and was erased with no second chance and no
 * record — the SILENCE class AGENTS rules 1-2 forbid.
 *
 * WHAT THESE PINS HOLD, and why each would have caught it:
 *
 * 1. the notice is raised through the EXISTING persistent seam, so it carries
 *    sonner's own close control (`duration: Infinity` + `closeButton: true`,
 *    `lib/toast.ts`'s row-136 row) — a transient notice has no closer, which is
 *    the observable difference between "the owner can still read it" and "it is
 *    already gone";
 * 2. `settings.cleanCut` SURVIVES the mount and every other write until the
 *    owner dismisses the notice — clearing it on the way past is the defect;
 * 3. with onboarding `'fresh'` and ZERO campaigns (the wizard's exact
 *    condition) BOTH surfaces fire, and neither the wizard's presence nor its
 *    own `settings` write can hide or consume the notice;
 * 4. a report the owner never saw is re-said on the NEXT launch, because
 *    nothing but acknowledgement clears the row.
 *
 * REVERT-PROOF (both halves, watched RED in-turn with the changed files'
 * sha256 printed): restoring `toastInfo(...)` + `updateSettings({ cleanCut:
 * null })` in the mount effect reds (1), (2) and (4); the non-vacuity arm below
 * is the control that proves the assertions are not passing on an empty tree.
 *
 * Queries are by ROLE + accessible name on purpose, the row-136 convention: a
 * pin keyed to a CSS class or sonner's `data-close-button` would survive the
 * control becoming unreachable, which is the bug.
 */

/** The accessible name sonner gives its own close button (row 136's contract). */
const CLOSE_NAME = /^close toast$/i;

/** A report with every counted store non-zero, so the sentence is unmistakable
 * and every clause of `formatCleanCut` (which this slice does NOT touch) is
 * exercised through the real mount. */
const REPORT: CleanCutReport = {
  campaignsPurged: 3,
  modulesPurged: 2,
  battlesPurged: 1,
  runsPurged: 1,
  moduleVersionsPurged: 2,
  creatureImagesPurged: 1,
  artifactsPurged: 5,
  imagesPurged: 2,
  revisionsPurged: 5,
  libraryArtifactsKept: 7,
  libraryLegacyCitationsDropped: 2,
};

/** The sentence the owner must be able to read — built by the REAL formatter,
 * so this pin can never disagree with the copy it is measuring. */
const NOTICE = formatCleanCut(REPORT);

function renderApp(): void {
  window.history.replaceState(null, '', ROUTES.campaignPicker);
  render(<RouterProvider router={createAppRouter()} />);
}

/** A settled onboarding row: the wizard must not open and steal the assertions. */
function settledOnboarding(): { status: 'complete'; stepState: [] } {
  return { status: 'complete' as const, stepState: [] };
}

beforeEach(async () => {
  await clearDatabase();
  useOnboardingStore.setState({ open: false, focusStep: null });
  useHelpStore.setState({ topic: null });
});

afterEach(() => {
  // ORDER MATTERS: unmount BEFORE dismissing. A persistent notice's dismissal
  // runs its acknowledgement hook, and the hook writes to Dexie — dismissing a
  // still-mounted toast here would fire a settings write outside any test's act
  // window. Unmounting first makes the store clear a no-op for React.
  cleanup();
  toast.dismiss();
});

describe('the clean-cut notice reaches the owner (docs/17 row 280)', () => {
  it('says what was removed and KEEPS the report until the owner acknowledges the notice', async () => {
    await saveSettings({
      ...defaultSettings(),
      cleanCut: REPORT,
      onboarding: settledOnboarding(),
    });
    renderApp();

    // 1. The notice is up, and it is the PERSISTENT seam: a real closer is
    // reachable. RED-PROOF: `toastInfo(NOTICE)` (no `closeButton`) renders the
    // text with NO button of this name.
    expect(await screen.findByText(NOTICE)).toBeInTheDocument();
    const closer = screen.getByRole('button', { name: CLOSE_NAME });

    // 2. The report is STILL THERE. This is the half the first real run lost:
    // the old effect nulled it in the same turn as the toast. RED-PROOF:
    // `await updateSettings({ cleanCut: null })` right after raising the notice.
    expect((await actDrained(() => readSettings())).cleanCut).toEqual(REPORT);

    // 3. Acknowledgement is the ONLY thing that clears it.
    const user = userEvent.setup();
    await user.click(closer);
    await waitFor(() => {
      expect(screen.queryByText(NOTICE)).toBeNull();
    });
    await waitFor(async () => {
      expect((await readSettings()).cleanCut).toBeNull();
    });
    await flushAsyncUpdates();
  }, 20000);

  it('re-says an unacknowledged report on the NEXT launch instead of losing it', async () => {
    await saveSettings({
      ...defaultSettings(),
      cleanCut: REPORT,
      onboarding: settledOnboarding(),
    });
    renderApp();
    expect(await screen.findByText(NOTICE)).toBeInTheDocument();
    await flushAsyncUpdates();

    // The owner never acknowledged it (a closed tab, a crash, another tab):
    // the next launch says it AGAIN. RED-PROOF: the old one-shot clear leaves
    // the second mount with nothing to say.
    cleanup();
    renderApp();
    expect(await screen.findByText(NOTICE)).toBeInTheDocument();
    expect((await actDrained(() => readSettings())).cleanCut).toEqual(REPORT);
    await flushAsyncUpdates();
  }, 20000);
});

describe('the wizard cannot swallow the notice (docs/17 row 280)', () => {
  it('delivers the notice with the wizard OPEN, and keeps it through the wizard\'s own dismissal', async () => {
    // THE OWNER'S EXACT CONDITION: settings survive the purge, so onboarding is
    // still 'fresh' and every campaign row is gone.
    await saveSettings({ ...defaultSettings(), cleanCut: REPORT });
    renderApp();

    // Both surfaces fire from the ONE condition.
    expect(await screen.findByTestId('setup-wizard')).toBeInTheDocument();
    expect(await screen.findByText(NOTICE)).toBeInTheDocument();

    // The notice is not the wizard's, and it is not behind it: the close control
    // is reachable by ROLE while the modal is up, and the report is untouched.
    // RED-PROOF: a transient notice, or one deferred until the wizard closes.
    expect(screen.getByRole('button', { name: CLOSE_NAME })).toBeInTheDocument();
    expect((await actDrained(() => readSettings())).cleanCut).toEqual(REPORT);

    // Dismissing the wizard is a `settings` write of its own. It must neither
    // clear nor consume the notice — the two effects are independent.
    const user = userEvent.setup();
    await user.click(screen.getByTestId('wizard-dismiss'));
    await waitFor(() => {
      expect(useOnboardingStore.getState().open).toBe(false);
    });

    expect(screen.getByText(NOTICE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: CLOSE_NAME })).toBeInTheDocument();
    const settings = await actDrained(() => readSettings());
    expect(settings.onboarding.status).toBe('dismissed');
    expect(settings.cleanCut).toEqual(REPORT);
    await flushAsyncUpdates();
  }, 20000);

  it('says nothing and writes nothing when there was no clean cut', async () => {
    // THE CONTROL. Without it, every assertion above could pass on a tree where
    // the notice is unconditional and the report is irrelevant.
    await saveSettings({ ...defaultSettings(), onboarding: settledOnboarding() });
    renderApp();
    await flushAsyncUpdates();

    expect(screen.queryByText(NOTICE)).toBeNull();
    expect(screen.queryByRole('button', { name: CLOSE_NAME })).toBeNull();
    expect((await actDrained(() => readSettings())).cleanCut).toBeNull();
    await flushAsyncUpdates();
  }, 20000);
});
