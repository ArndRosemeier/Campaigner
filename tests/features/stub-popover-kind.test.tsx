import 'fake-indexeddb/auto';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Campaign } from '@/domain';
import { createCampaign } from '@/db/campaignRepo';
import { listArtifactsByCampaign } from '@/db/artifactRepo';
import { StubPopover } from '@/features/modules/stub-popover';
import { clearDatabase } from '../db/helpers';
import { flushAsyncUpdates } from '../helpers/flush';

/**
 * The KIND of a hand-typed entity is the MODEL's to read — never an English
 * keyword pattern, and never a silent `npc` (docs/17 row 293, AGENTS rule 5).
 *
 * THE DEFECT THIS PINS. `features/modules/persona-request.guessKindFromSentence`
 * classified the first-occurrence SENTENCE with two English patterns
 * (`at|in|inside|near|…` ⇒ location; `guild|order|court|…` ⇒ faction; else npc)
 * and `stub-popover.tsx` rendered the answer as the DEFAULT kind:
 * `useState<StubKind>(recordedKind ?? guessKindFromSentence(sentence))`. A German
 * sentence missed both patterns and was shown as `npc` — a wrong guess presented
 * as the answer. The function is DELETED; the source pin is
 * `tests/architecture/one-kind-source.test.ts`.
 *
 * WHAT IS PINNED HERE, in the order the owner meets it:
 * 1. the GERMAN sentence renders NO preselected kind while the classification is
 *    in flight (the select reads "Classifying…"), and the MODEL's verdict then
 *    sets it;
 * 2. the owner's MANUAL pick wins over a later verdict, and it is what the stub
 *    is actually written with;
 * 3. the RECORDED kind is shown immediately and asks the model nothing at all
 *    (the path that is deliberately unchanged);
 * 4. a FAILED classification is visible on this surface and in the toast, leaves
 *    the kind UNSELECTED and blocks Create/Generate — nothing is persisted and
 *    no default kind is invented.
 *
 * The popover is rendered DIRECTLY (the `blocked-reasons-entity-sweep`
 * precedent) so the classification's timing is controlled exactly: a promise the
 * test resolves by hand is the only way to observe the in-flight state.
 */

vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));
vi.mock('@/features/modules/entity-detail', () => ({ generateSingleEntity: vi.fn() }));
vi.mock('@/llm/moduleGen', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  classifyEntityName: vi.fn(),
}));

const { classifyEntityName } = await import('@/llm/moduleGen');
const { generateSingleEntity } = await import('@/features/modules/entity-detail');
const { toastError } = await import('@/lib/toast');

const classifyMock = vi.mocked(classifyEntityName);
const generateMock = vi.mocked(generateSingleEntity);
const toastErrorMock = vi.mocked(toastError);

/** The measured input: BOTH keyword patterns miss it, so the pre-293 regex
 * answered `npc` for a sentence that names a faction in a cellar. */
const GERMAN = 'Die Gilde im Keller';

/** A REAL module id: `createArtifact` parses the row it writes, so a fake one
 * is refused — this file exercises the popover's OWN write path. */
const MODULE_ID = '11111111-1111-4111-8111-111111111111';

let campaign: Campaign;

beforeEach(async () => {
  await clearDatabase();
  vi.clearAllMocks();
  campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
});

afterEach(cleanup);

describe('the stub popover kind comes from the model, never from a keyword pattern', () => {
  it('shows NO preselected kind for a GERMAN sentence until the model answers, then the verdict', async () => {
    let resolveVerdict!: (verdict: { kind: 'faction'; canonical: string }) => void;
    classifyMock.mockReturnValue(
      new Promise((settle) => {
        resolveVerdict = settle;
      }),
    );

    render(
      <StubPopover
        state={{ name: GERMAN, x: 0, y: 0 }}
        sentence={GERMAN}
        contextParagraphs=""
        premise="Ein überfluteter Keller."
        moduleTag="module:Der Keller"
        moduleId={MODULE_ID}
        campaign={campaign}
        onClose={vi.fn()}
        onLinkExisting={vi.fn()}
      />,
    );

    // The classification is in flight: the select is UNSELECTED. The deleted
    // regex's answer (`npc`) must not appear as a value.
    await waitFor(() => {
      expect(classifyMock).toHaveBeenCalled();
    });
    const kindSelect = screen.getByTestId('stub-kind');
    expect(kindSelect).toHaveTextContent('Classifying…');
    expect(screen.queryByText('npc')).toBeNull();

    // The MODEL reads the German sentence and names the faction.
    resolveVerdict({ kind: 'faction', canonical: GERMAN });
    await waitFor(() => {
      expect(kindSelect).toHaveTextContent('faction');
    });
    expect(screen.queryByText('Classifying…')).toBeNull();
    await flushAsyncUpdates();
  }, 20_000);

  it('keeps the owner MANUAL pick when the verdict lands afterwards, and creates with it', async () => {
    const user = userEvent.setup();
    let resolveVerdict!: (verdict: { kind: 'faction'; canonical: string }) => void;
    classifyMock.mockReturnValue(
      new Promise((settle) => {
        resolveVerdict = settle;
      }),
    );

    render(
      <StubPopover
        state={{ name: GERMAN, x: 0, y: 0 }}
        sentence={GERMAN}
        contextParagraphs=""
        premise="Ein überfluteter Keller."
        moduleTag="module:Der Keller"
        moduleId={MODULE_ID}
        campaign={campaign}
        onClose={vi.fn()}
        onLinkExisting={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(classifyMock).toHaveBeenCalled();
    });

    // The owner picks by hand while the model is still thinking.
    await user.click(screen.getByTestId('stub-kind'));
    await user.click(await screen.findByRole('option', { name: 'Location' }));

    // The model's different answer must NOT clobber it. (The trigger renders
    // the raw VALUE, as it does everywhere else in this app.)
    resolveVerdict({ kind: 'faction', canonical: GERMAN });
    await waitFor(() => {
      expect(screen.getByTestId('stub-kind')).toHaveTextContent('location');
    });
    expect(screen.queryByText('faction')).toBeNull();

    // …and the manual pick is what the stub is written with.
    await user.click(screen.getByTestId('stub-create'));
    await flushAsyncUpdates();
    expect(toastErrorMock).not.toHaveBeenCalled();
    await waitFor(
      async () => {
        const rows = await listArtifactsByCampaign(campaign.id);
        expect(rows.find((row) => row.name === GERMAN)?.kind).toBe('location');
      },
      { timeout: 10_000 },
    );
    await flushAsyncUpdates();
  }, 20_000);

  it('shows the RECORDED kind immediately and never asks the model (unchanged path)', async () => {
    render(
      <StubPopover
        state={{ name: GERMAN, x: 0, y: 0 }}
        sentence={GERMAN}
        contextParagraphs=""
        premise="Ein überfluteter Keller."
        moduleTag="module:Der Keller"
        moduleId={MODULE_ID}
        campaign={campaign}
        recordedKind="encounter"
        onClose={vi.fn()}
        onLinkExisting={vi.fn()}
      />,
    );

    expect(screen.getByTestId('stub-kind')).toHaveTextContent('encounter');
    expect(classifyMock).not.toHaveBeenCalled();
    await flushAsyncUpdates();
  }, 20_000);

  it('keeps a FAILED classification UNSELECTED and LOUD, and persists nothing', async () => {
    const user = userEvent.setup();
    classifyMock.mockRejectedValue(new Error('the model is unreachable'));

    render(
      <StubPopover
        state={{ name: GERMAN, x: 0, y: 0 }}
        sentence={GERMAN}
        contextParagraphs=""
        premise="Ein überfluteter Keller."
        moduleTag="module:Der Keller"
        moduleId={MODULE_ID}
        campaign={campaign}
        onClose={vi.fn()}
        onLinkExisting={vi.fn()}
      />,
    );

    // Visible on this surface AND in the toast (AGENTS rule 2).
    await waitFor(() => {
      expect(screen.getByTestId('stub-kind-failed')).toBeInTheDocument();
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      'Could not auto-detect the entity kind — pick one below',
      expect.any(Error),
    );
    // No default kind was invented — not the regex's `npc`, not anything else.
    expect(screen.getByTestId('stub-kind')).toHaveTextContent('Choose a kind…');
    expect(screen.queryByText('npc')).toBeNull();
    // Nothing can persist from a failure: both actions are blocked.
    expect(screen.getByTestId('stub-create')).toBeDisabled();
    expect(screen.getByTestId('stub-generate')).toBeDisabled();
    await user.tab();
    await flushAsyncUpdates();

    expect(await listArtifactsByCampaign(campaign.id)).toHaveLength(0);
    expect(generateMock).not.toHaveBeenCalled();
  }, 20_000);
});
