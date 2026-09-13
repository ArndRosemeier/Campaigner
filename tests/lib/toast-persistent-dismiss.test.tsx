import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { toast } from 'sonner';

import { Toaster } from '@/components/ui/sonner';
import { createCampaign, createModule, moduleSchema, type Campaign, type Module } from '@/domain';
import type { EntityBatchFailure } from '@/features/modules/entity-batch';
import {
  BATCH_FAILURE_CONSOLE_PREFIX,
  BATCH_FAILURE_RECORD_TAG,
  recordEntityBatchFailure,
  reportEntityBatchFailures,
} from '@/features/modules/entity-batch-report';
import { toastError, toastErrorPersistent } from '@/lib/toast';

/**
 * THE OWNER'S REPORT, as a pin (docs/17 row 136). Verbatim:
 *
 *   "One small bug: That error message is still on my screen and the little
 *    closer it has does not close it."
 *
 * MEASURED, and this is the whole diagnosis: a persistent notice is raised
 * with `duration: Infinity` (`lib/toast.ts`, `toastErrorPersistent`), the app's
 * `Toaster` (`components/ui/sonner.tsx`, mounted by `app/layout/AppShell.tsx`)
 * passed no `closeButton` and sonner draws its close button only when
 * `toast.closeButton ?? toaster.closeButton` is truthy
 * (`node_modules/sonner/dist/index.mjs:521-526`, conditional render at `:842`).
 * So a persistent failure notice had NO exit at all — and the "little closer"
 * the owner was clicking is the ERROR ICON (`OctagonXIcon`, an octagon with an
 * X) that the app's `icons={{ error: … }}` map renders. An icon is not a
 * button; clicking it did nothing, which is exactly what he reported.
 *
 * So these pins mount the REAL `Toaster` and drive the REAL seam — nothing
 * about sonner or `lib/toast` is mocked, because the defect lived in the
 * options object the seam builds and in what the mounted Toaster rendered. And
 * they judge THREE things, not one:
 *
 * 1. the owner's report: a persistent notice carries a reachable dismiss
 *    control, and activating it removes the notice from the DOM;
 * 2. that transient toasts did NOT change (a closer on a 4-second toast would
 *    be a different slice, not this fix);
 * 3. that dismissing NEVER means "evidence gone" — the per-failure console
 *    record (`entity-batch-report`, docs/17 row 131) is written when the
 *    failure HAPPENS, is not a property of the toast, and is untouched by the
 *    dismissal path. The other half of that evidence, the failed run row, is
 *    pinned where it lives (`tests/features/entity-batch-failure-report.test.ts`
 *    asserts the record carries the `runId` + `errorMessage` that find it).
 *
 * Queries are role + accessible name on purpose: a pin keyed to a CSS class or
 * the close glyph's `data-close-button` would survive the control being made
 * unreachable, which is the bug. The accessible name is the contract.
 */

/** The accessible name sonner gives its own close button
 * (`closeButtonAriaLabel`, `dist/index.mjs:495`) — asserted exactly, because a
 * rename that leaves the owner without a findable closer must fail here. */
const CLOSE_NAME = /^close toast$/i;

/** The seam's console entries, captured with a spy (a spy is not noise —
 * `tests/setup.ts` §Console guard; this file is deliberately NOT in
 * `ALLOWED_NOISE`, so an unspied record would fail the console guard and a new
 * file that starts driving failing batches cannot silently join an allowance). */
let consoleSpy: MockInstance<(...data: unknown[]) => void>;

beforeEach(() => {
  consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  // sonner's toast store is module-level state, and these notices never
  // auto-dismiss by design: a leftover one would make the NEXT test's
  // "the notice is gone" assertion pass for the wrong reason.
  toast.dismiss();
  consoleSpy.mockRestore();
});

function campaignFixture(): Campaign {
  return createCampaign({ name: 'Ember Crypt', system: 'dnd5e' });
}

function moduleFixture(campaignId: string): Module {
  const base = createModule({
    campaignId,
    title: 'Ember Crypt',
    concept: 'A crypt guarding an old seal.',
    levelMin: 1,
    levelMax: 4,
    sizeDial: 'standard',
  });
  return moduleSchema.parse({ ...base, parts: [], entityKinds: [], entityNamesNormalized: true });
}

function contextFixture(): { campaign: Campaign; module: Module; kind: 'npc'; total: number } {
  const campaign = campaignFixture();
  return { campaign, module: moduleFixture(campaign.id), kind: 'npc', total: 2 };
}

/** One failed run, as the batch hands it over: the reason lives on the
 * failure's `message`/`errorMessage` and its row is findable by `runId`. */
function failureFixture(): EntityBatchFailure {
  return {
    name: 'Kael',
    kind: 'run-not-completed',
    message: 'gateway down',
    runId: 'run-1',
    status: 'failed',
    errorMessage: 'gateway down',
  };
}

/** The owner-facing sentence the seam raises for one run-not-completed failure
 * of two (`entity-batch-report.batchFailureMessage`). */
const NOTICE = '1 of 2 npcs failed to generate — see the Runs tab ("Kael" — gateway down)';

/** The pasteable per-failure line, read back out of the console spy — the
 * record the owner posts back, tagged so a grep finds it. */
function recordedFailureLine(): string {
  const prefix = `${BATCH_FAILURE_CONSOLE_PREFIX} ${BATCH_FAILURE_RECORD_TAG} `;
  const line = consoleSpy.mock.calls
    .map((call) => call[0])
    .find((arg): arg is string => typeof arg === 'string' && arg.startsWith(prefix));
  if (line === undefined) throw new Error(`no "${prefix}" record was written to the console`);
  return line;
}

describe("the owner's report: a persistent failure notice is dismissible", () => {
  it('the real Toaster renders a reachable close control, and activating it removes the notice', async () => {
    const user = userEvent.setup();
    render(<Toaster position="bottom-right" />);

    reportEntityBatchFailures({ ...contextFixture(), failures: [failureFixture()] });

    // The notice is up (it is persistent, so it stays) …
    await screen.findByText(NOTICE);

    // … and it is not a dead end: the closer is findable by its accessible name
    // and one activation takes it off the screen.
    await user.click(screen.getByRole('button', { name: CLOSE_NAME }));
    await waitFor(() => {
      expect(screen.queryByText(NOTICE)).toBeNull();
    });
  });

  it('the close control comes from the SEAM, so every persistent caller gets it (global handlers too)', async () => {
    const user = userEvent.setup();
    render(<Toaster position="bottom-right" />);

    toastErrorPersistent('Unexpected error', new Error('boom from listener'));

    await screen.findByText('Unexpected error');
    await user.click(screen.getByRole('button', { name: CLOSE_NAME }));
    await waitFor(() => {
      expect(screen.queryByText('Unexpected error')).toBeNull();
    });
  });
});

describe('the fix does not travel: a transient notice keeps its old behaviour', () => {
  it('a 4-second toastError carries no close control', async () => {
    render(<Toaster position="bottom-right" />);

    toastError('Import failed — is this a Campaigner export?', new Error('bad zip'));

    await screen.findByText('Import failed — is this a Campaigner export?');
    // No closer: a toast that leaves on its own needs no dismiss affordance,
    // and adding one would be a UX change to every transient error in the app.
    expect(screen.queryByRole('button', { name: CLOSE_NAME })).toBeNull();
    // The description is untouched by this slice as well.
    expect(screen.getByText('bad zip')).toBeInTheDocument();
  });
});

describe('dismissing a notice never destroys the reason', () => {
  it('the per-failure console record outlives the toast, byte-identical', async () => {
    const user = userEvent.setup();
    render(<Toaster position="bottom-right" />);

    const context = contextFixture();
    const failure = failureFixture();
    // The batch writes the failure down the moment it happens (the seam's one
    // funnel), BEFORE any batch-end reporting exists.
    recordEntityBatchFailure(context, failure);
    reportEntityBatchFailures({ ...context, failures: [failure] });

    await screen.findByText(NOTICE);
    const recordBefore = recordedFailureLine();
    const writesBefore = consoleSpy.mock.calls.length;

    await user.click(screen.getByRole('button', { name: CLOSE_NAME }));
    await waitFor(() => {
      expect(screen.queryByText(NOTICE)).toBeNull();
    });

    // The record is the batch's, not the toast's: dismissing wrote nothing and
    // removed nothing — the line the owner greps/pastes is still there, with
    // the reason and the run id that find the failed row in the Runs tab.
    expect(consoleSpy.mock.calls.length).toBe(writesBefore);
    expect(recordedFailureLine()).toBe(recordBefore);
    const payload = JSON.parse(
      recordBefore.slice(`${BATCH_FAILURE_CONSOLE_PREFIX} ${BATCH_FAILURE_RECORD_TAG} `.length),
    ) as Record<string, unknown>;
    expect(payload.message).toBe('gateway down');
    expect(payload.runId).toBe('run-1');
  });
});
