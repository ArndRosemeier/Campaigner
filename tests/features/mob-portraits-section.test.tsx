import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AnyArtifact } from '@/domain';
import type { MobPortraitBatchPlan } from '@/features/campaign/mob-portrait-queue';
import { MobPortraitsSection } from '@/features/campaign/components/mob-portraits-section';
import { flushAsyncUpdates } from '../helpers/flush';

/**
 * Mob portraits section (docs/11 D5 amendment): rulebook-cited kinds keep
 * the "Generate mob portraits" batch, while uncited entries (inline/none)
 * get a per-entry and batch-all "Create creature + portrait" action — no
 * more dead-end disabled button when zero rulebook entries exist.
 *
 * The batch confirm (owner report: "2 mobs already have an image and I just
 * want to fill a hole" — Monster Core art from the shared canonical slot):
 * the press counts READ-ONLY first and then
 * - fills immediately when nothing is imaged yet (pure gaps, unchanged),
 * - offers BOTH ways when some kinds are imaged and some are not — "Fill the
 *   missing N" (primary, additive, existing art kept) and "Replace all M"
 *   (secondary, today's delete-after-replace regen) — with the shared
 *   Monster Core consequence stated BEFORE the choice,
 * - offers only replace-all (with the reason) when nothing is missing.
 * The per-entry invented action keeps its own confirm, unchanged.
 */

vi.mock('@/features/campaign/mob-portrait-queue', () => ({
  enqueueMobPortraits: vi.fn(),
  enqueueInventedCreaturePortraits: vi.fn(),
  planMobPortraitBatch: vi.fn(),
  regenerateMobPortraits: vi.fn(),
  regenerateInventedCreaturePortraits: vi.fn(),
}));
vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn(), toastInfo: vi.fn() }));

const {
  enqueueMobPortraits,
  enqueueInventedCreaturePortraits,
  planMobPortraitBatch,
  regenerateMobPortraits,
  regenerateInventedCreaturePortraits,
} = await import('@/features/campaign/mob-portrait-queue');
const enqueueMobPortraitsMock = vi.mocked(enqueueMobPortraits);
const enqueueInventedMock = vi.mocked(enqueueInventedCreaturePortraits);
const planMock = vi.mocked(planMobPortraitBatch);
const regenerateMobPortraitsMock = vi.mocked(regenerateMobPortraits);
const regenerateInventedMock = vi.mocked(regenerateInventedCreaturePortraits);
const { toastSuccess, toastInfo } = await import('@/lib/toast');
const toastSuccessMock = vi.mocked(toastSuccess);
const toastInfoMock = vi.mocked(toastInfo);

type Encounter = AnyArtifact & { kind: 'encounter' };

function enc(
  monsters: { name: string; source: Record<string, unknown>; notes?: string }[],
): Encounter {
  return {
    id: 'encounter-1',
    campaignId: 'campaign-1',
    moduleId: null,
    kind: 'encounter',
    name: 'Ooze warren',
    data: {
      monsters: monsters.map((monster) => ({
        name: monster.name,
        count: 1,
        notes: monster.notes ?? '',
        treasure: '',
        source: monster.source,
      })),
    },
  } as unknown as Encounter;
}

/** A read-only count with nothing to report — the shape every test starts
 * from and then overrides per state. */
function plan(overrides: Partial<MobPortraitBatchPlan> = {}): MobPortraitBatchPlan {
  return {
    missing: [],
    imaged: [],
    artWithoutCover: [],
    sharedRows: 0,
    creates: 0,
    sharedPortraitNames: [],
    unreadableCitations: [],
    ...overrides,
  };
}

const INLINE = { type: 'inline', statBlock: null };
const NONE = { type: 'none' };
const RULEBOOK = { type: 'rulebook', chunkId: 'chunk-1' };
const NPC_REF = { type: 'npc-ref', artifactId: 'npc-1' };

beforeEach(() => {
  enqueueMobPortraitsMock.mockReset();
  enqueueInventedMock.mockReset();
  planMock.mockReset();
  regenerateMobPortraitsMock.mockReset();
  regenerateInventedMock.mockReset();
  toastSuccessMock.mockReset();
  toastInfoMock.mockReset();
  planMock.mockResolvedValue(plan());
  enqueueMobPortraitsMock.mockResolvedValue({ enqueued: 0, alreadyImaged: [] });
  enqueueInventedMock.mockResolvedValue({ created: 0, enqueued: 0, alreadyImaged: [] });
  regenerateMobPortraitsMock.mockResolvedValue({ regenerated: 0, republishedCanonical: [] });
  regenerateInventedMock.mockResolvedValue({ created: 0, regenerated: 0 });
});

describe('MobPortraitsSection invented-creature actions', () => {
  it('lists uncited entries with per-entry create buttons and an enabled create batch when zero rulebook entries exist', async () => {
    const artifact = enc([
      { name: 'Gloom Ooze', source: INLINE },
      { name: 'Whisper Wisp', source: NONE },
    ]);
    render(<MobPortraitsSection artifact={artifact} campaignId="campaign-1" />);

    // The old dead-end copy is gone: the message names the new action.
    expect(
      screen.getByText(/each invented entry gets its own creature artifact plus a portrait/i),
    ).toBeDefined();
    const batch = screen.getByTestId('generate-mob-portraits');
    expect(batch.textContent).toMatch(/Create creatures \+ portraits/);
    expect(batch.hasAttribute('disabled')).toBe(false);

    const list = screen.getByTestId('mob-portraits-uncited');
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toMatch(/Gloom Ooze/);
    expect(rows[0]?.textContent).toMatch(/with stat block/);
    expect(rows[1]?.textContent).toMatch(/name only/);

    const user = userEvent.setup();
    await user.click(screen.getByTestId('create-creature-portrait-1'));
    await waitFor(() => {
      expect(enqueueInventedMock).toHaveBeenCalledTimes(1);
    });
    expect(enqueueInventedMock).toHaveBeenCalledWith(artifact, 'campaign-1', [1]);
    expect(enqueueMobPortraitsMock).not.toHaveBeenCalled();
    // The per-entry action never consults the batch count.
    expect(planMock).not.toHaveBeenCalled();
    await flushAsyncUpdates();
  });

  it('batch-all with both kinds calls both batches; rulebook-only keeps the portrait batch label', async () => {
    const artifact = enc([
      { name: 'Goblin Boss', source: RULEBOOK },
      { name: 'Gloom Ooze', source: INLINE },
    ]);
    // Pure gaps: nothing imaged yet — the press fills immediately, as before.
    planMock.mockResolvedValue(plan({ missing: ['Goblin Boss', 'Gloom Ooze'], creates: 1 }));
    render(<MobPortraitsSection artifact={artifact} campaignId="campaign-1" />);

    expect(screen.getByTestId('generate-mob-portraits').textContent).toMatch(/Generate mob portraits/);
    expect(screen.getByTestId('mob-portraits-uncited')).toBeDefined();

    const user = userEvent.setup();
    await user.click(screen.getByTestId('generate-mob-portraits'));
    await waitFor(() => {
      expect(enqueueMobPortraitsMock).toHaveBeenCalledTimes(1);
      expect(enqueueInventedMock).toHaveBeenCalledTimes(1);
    });
    expect(enqueueMobPortraitsMock).toHaveBeenCalledWith(artifact, 'campaign-1');
    expect(enqueueInventedMock).toHaveBeenCalledWith(artifact, 'campaign-1');
    await flushAsyncUpdates();
  });

  it('rulebook-only roster shows no uncited list', () => {
    render(
      <MobPortraitsSection
        artifact={enc([{ name: 'Goblin Boss', source: RULEBOOK }])}
        campaignId="campaign-1"
      />,
    );
    expect(screen.queryByTestId('mob-portraits-uncited')).toBeNull();
    expect(screen.getByTestId('generate-mob-portraits').textContent).toMatch(/Generate mob portraits/);
  });

  it('empty roster disables the batch with a no-creatures message (never the old dead-end)', () => {
    render(<MobPortraitsSection artifact={enc([])} campaignId="campaign-1" />);
    expect(screen.getByText(/No creatures to illustrate/i)).toBeDefined();
    expect(screen.queryByText(/bestiary-cited roster entries/)).toBeNull();
    expect(screen.getByTestId('generate-mob-portraits').hasAttribute('disabled')).toBe(true);
    expect(screen.queryByTestId('mob-portraits-uncited')).toBeNull();
  });

  it('renders nothing for library (campaign-less) encounters', () => {
    const artifact = {
      ...enc([{ name: 'Gloom Ooze', source: INLINE }]),
      campaignId: null,
      moduleId: null,
    } as unknown as Encounter;
    const { container } = render(<MobPortraitsSection artifact={artifact} campaignId="campaign-1" />);
    expect(container.innerHTML).toBe('');
  });
});

describe('MobPortraitsSection batch confirm (fill vs replace)', () => {
  it('MIXED: offers Fill with the real missing count and enqueues ONLY the missing kinds, replacing nothing', async () => {
    const artifact = enc([
      { name: 'Goblin Boss', source: RULEBOOK },
      { name: 'Gloom Ooze', source: INLINE },
      { name: 'Ogre', source: RULEBOOK },
    ]);
    // 2 kinds already show a portrait (Monster Core art from the shared
    // canonical slot), Ogre has none — the owner's report verbatim.
    planMock.mockResolvedValue(plan({ missing: ['Ogre'], imaged: ['Goblin Boss', 'Gloom Ooze'] }));
    enqueueMobPortraitsMock.mockResolvedValue({ enqueued: 1, alreadyImaged: ['Goblin Boss'] });
    enqueueInventedMock.mockResolvedValue({ created: 1, enqueued: 0, alreadyImaged: ['Gloom Ooze'] });
    render(<MobPortraitsSection artifact={artifact} campaignId="campaign-1" />);

    const user = userEvent.setup();
    await user.click(screen.getByTestId('generate-mob-portraits'));
    const dialog = await screen.findByTestId('mob-portraits-choice-dialog');
    // The counts are the plan's, the choice names both paths, and nothing
    // was queued by looking.
    expect(dialog.textContent).toMatch(/Fill 1 missing portrait or replace 2\?/);
    const copy = screen.getByTestId('mob-portraits-choice-copy').textContent;
    expect(copy).toMatch(/2 of 3 creature kinds already have a portrait/);
    expect(copy).toMatch(/"Goblin Boss", "Gloom Ooze"/);
    expect(copy).toMatch(/1 has none \("Ogre"\)/);
    expect(copy).toMatch(/Filling adds only the missing portrait and keeps the 2 that exist/);
    expect(copy).toMatch(/Replacing regenerates all 2 existing portraits and still fills the missing one/);
    expect(enqueueMobPortraitsMock).not.toHaveBeenCalled();
    expect(regenerateMobPortraitsMock).not.toHaveBeenCalled();

    const fill = screen.getByTestId('mob-portraits-choice-fill');
    expect(fill.textContent).toMatch(/Fill the missing 1/);
    await user.click(fill);
    await waitFor(() => {
      expect(enqueueMobPortraitsMock).toHaveBeenCalledWith(artifact, 'campaign-1');
      expect(enqueueInventedMock).toHaveBeenCalledWith(artifact, 'campaign-1');
    });
    // The imaged kinds are untouched: no regen path ran at all.
    expect(regenerateMobPortraitsMock).not.toHaveBeenCalled();
    expect(regenerateInventedMock).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalledWith(
        'Filling 1 missing portrait — keeping the 2 that exist',
      );
    });
    await flushAsyncUpdates();
  });

  it('MIXED: Replace all still regenerates every portrait (existing behavior preserved)', async () => {
    const artifact = enc([
      { name: 'Goblin Boss', source: RULEBOOK },
      { name: 'Gloom Ooze', source: INLINE },
      { name: 'Ogre', source: RULEBOOK },
    ]);
    planMock.mockResolvedValue(plan({ missing: ['Ogre'], imaged: ['Goblin Boss', 'Gloom Ooze'] }));
    regenerateMobPortraitsMock.mockResolvedValue({ regenerated: 2, republishedCanonical: [] });
    regenerateInventedMock.mockResolvedValue({ created: 1, regenerated: 1 });
    render(<MobPortraitsSection artifact={artifact} campaignId="campaign-1" />);

    const user = userEvent.setup();
    await user.click(screen.getByTestId('generate-mob-portraits'));
    await screen.findByTestId('mob-portraits-choice-dialog');
    expect(screen.getByTestId('mob-portraits-choice-replace').textContent).toMatch(/Replace all 2/);

    await user.click(screen.getByTestId('mob-portraits-choice-replace'));
    await waitFor(() => {
      expect(regenerateMobPortraitsMock).toHaveBeenCalledWith(artifact, 'campaign-1');
      expect(regenerateInventedMock).toHaveBeenCalledWith(artifact, 'campaign-1');
    });
    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalledWith(
        expect.stringMatching(/Regenerating 3 portraits/),
      );
    });
    await flushAsyncUpdates();
  });

  it('MIXED: Cancel queues nothing and says so honestly (the holes are still holes)', async () => {
    const artifact = enc([
      { name: 'Goblin Boss', source: RULEBOOK },
      { name: 'Gloom Ooze', source: INLINE },
      { name: 'Ogre', source: RULEBOOK },
    ]);
    planMock.mockResolvedValue(plan({ missing: ['Ogre'], imaged: ['Goblin Boss', 'Gloom Ooze'] }));
    render(<MobPortraitsSection artifact={artifact} campaignId="campaign-1" />);

    const user = userEvent.setup();
    await user.click(screen.getByTestId('generate-mob-portraits'));
    await screen.findByTestId('mob-portraits-choice-dialog');
    await user.click(screen.getByTestId('mob-portraits-choice-cancel'));

    await waitFor(() => {
      expect(toastInfoMock).toHaveBeenCalledWith('Nothing queued — 1 creature kind still has no portrait');
    });
    // Never the all-generated toast in a state that still has a hole.
    expect(toastSuccessMock).not.toHaveBeenCalledWith('All mob portraits are already generated');
    expect(enqueueMobPortraitsMock).not.toHaveBeenCalled();
    expect(regenerateMobPortraitsMock).not.toHaveBeenCalled();
    await flushAsyncUpdates();
  });

  it('NOTHING MISSING: offers replace-all only, with the reason, and still works; Cancel keeps the old toast', async () => {
    const artifact = enc([{ name: 'Goblin Boss', source: RULEBOOK }]);
    planMock.mockResolvedValue(plan({ imaged: ['Goblin Boss'] }));
    render(<MobPortraitsSection artifact={artifact} campaignId="campaign-1" />);

    const user = userEvent.setup();
    await user.click(screen.getByTestId('generate-mob-portraits'));
    const dialog = await screen.findByTestId('mob-portraits-choice-dialog');
    expect(dialog.textContent).toMatch(/Replace all 1 portrait\?/);
    const copy = screen.getByTestId('mob-portraits-choice-copy').textContent;
    expect(copy).toMatch(/All 1 creature kinds already have a portrait: "Goblin Boss"/);
    expect(copy).toMatch(/Nothing is missing, so there is nothing to fill/);
    // No dead or silently meaningless additive control.
    expect(screen.queryByTestId('mob-portraits-choice-fill')).toBeNull();

    await user.click(screen.getByTestId('mob-portraits-choice-cancel'));
    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalledWith('All mob portraits are already generated');
    });
    expect(regenerateMobPortraitsMock).not.toHaveBeenCalled();

    // And the replace action itself works.
    await user.click(screen.getByTestId('generate-mob-portraits'));
    await screen.findByTestId('mob-portraits-choice-dialog');
    regenerateMobPortraitsMock.mockResolvedValue({ regenerated: 1, republishedCanonical: [] });
    await user.click(screen.getByTestId('mob-portraits-choice-replace'));
    await waitFor(() => {
      expect(regenerateMobPortraitsMock).toHaveBeenCalledWith(artifact, 'campaign-1');
    });
    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalledWith(
        expect.stringMatching(/Regenerating 1 portrait/),
      );
    });
    await flushAsyncUpdates();
  });

  it('states the shared Monster Core consequence of replacing BEFORE the choice, not in a toast', async () => {
    const artifact = enc([
      { name: 'Goblin', source: RULEBOOK },
      { name: 'Troll', source: RULEBOOK },
    ]);
    planMock.mockResolvedValue(
      plan({
        missing: ['Troll'],
        imaged: ['Goblin'],
        creates: 1,
        sharedRows: 1,
        sharedPortraitNames: ['Goblin'],
      }),
    );
    render(<MobPortraitsSection artifact={artifact} campaignId="campaign-1" />);

    const user = userEvent.setup();
    await user.click(screen.getByTestId('generate-mob-portraits'));
    await screen.findByTestId('mob-portraits-choice-dialog');
    const copy = screen.getByTestId('mob-portraits-choice-copy').textContent;
    expect(copy).toMatch(/Monster Core \(bestiary-cited\) portraits are shared/);
    expect(copy).toMatch(/republishing "Goblin" changes the shared portrait every future campaign clones/);
    expect(copy).toMatch(/existing covers elsewhere keep theirs/);
    // The counts carry the same-kind share instead of hiding it.
    expect(copy).toMatch(/1 roster row shares a creature kind with another row/);
    expect(copy).toMatch(/creating 1 creature artifact first/);
    expect(toastSuccessMock).not.toHaveBeenCalled();
    await flushAsyncUpdates();
  });

  it('names art that is not set as a cover instead of counting it as a board portrait', async () => {
    const artifact = enc([{ name: 'Ogre', source: RULEBOOK }]);
    // The batch counts a gallery-only artifact imaged (skip-if-imaged), but
    // the board renders the cover alone — the copy says both, no fake art.
    planMock.mockResolvedValue(
      plan({ imaged: ['Ogre'], artWithoutCover: ['Ogre'], sharedPortraitNames: ['Ogre'] }),
    );
    render(<MobPortraitsSection artifact={artifact} campaignId="campaign-1" />);

    const user = userEvent.setup();
    await user.click(screen.getByTestId('generate-mob-portraits'));
    await screen.findByTestId('mob-portraits-choice-dialog');
    const copy = screen.getByTestId('mob-portraits-choice-copy').textContent;
    expect(copy).toMatch(/"Ogre" already carries art on the creature artifact that is not set as its cover/);
    expect(copy).toMatch(/the battle board still shows initials until you set it/);
    expect(copy).toMatch(/Set as cover/);
    // Nothing missing: the additive action stays absent (there is no hole the
    // batch fills), only replace-all is offered.
    expect(screen.queryByTestId('mob-portraits-choice-fill')).toBeNull();
    await flushAsyncUpdates();
  });

  it('names an unreadable citation instead of hiding the consequence', async () => {
    const artifact = enc([{ name: 'Ogre', source: RULEBOOK }]);
    planMock.mockResolvedValue(plan({ imaged: ['Ogre'], unreadableCitations: ['Ogre'] }));
    render(<MobPortraitsSection artifact={artifact} campaignId="campaign-1" />);

    const user = userEvent.setup();
    await user.click(screen.getByTestId('generate-mob-portraits'));
    await screen.findByTestId('mob-portraits-choice-dialog');
    const copy = screen.getByTestId('mob-portraits-choice-copy').textContent;
    expect(copy).toMatch(/The bestiary citation for "Ogre" can no longer be read/);
    expect(copy).toMatch(/fails loudly and keeps its cover/);
    await flushAsyncUpdates();
  });

  it('pure gaps fill immediately with no dialog, and report what happened', async () => {
    const artifact = enc([{ name: 'Ogre', source: RULEBOOK }]);
    planMock.mockResolvedValue(plan({ missing: ['Ogre'] }));
    enqueueMobPortraitsMock.mockResolvedValue({ enqueued: 1, alreadyImaged: [] });
    render(<MobPortraitsSection artifact={artifact} campaignId="campaign-1" />);

    const user = userEvent.setup();
    await user.click(screen.getByTestId('generate-mob-portraits'));
    await waitFor(() => {
      expect(enqueueMobPortraitsMock).toHaveBeenCalledWith(artifact, 'campaign-1');
    });
    await flushAsyncUpdates();
    expect(screen.queryByTestId('mob-portraits-choice-dialog')).toBeNull();
    expect(regenerateMobPortraitsMock).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalledWith('Filling 1 missing portrait — nothing is replaced');
    });
  });

  it('a roster with nothing this batch owns (npc-ref only) stays a disabled no-creatures control, not a misleading dialog', async () => {
    const artifact = enc([{ name: 'Captain Vell', source: NPC_REF }]);
    render(<MobPortraitsSection artifact={artifact} campaignId="campaign-1" />);

    // npc-ref rows keep their portraits in the entity-image flow: the batch
    // owns no kind here, so it is disabled with the reason on screen.
    expect(screen.getByText(/No creatures to illustrate/i)).toBeDefined();
    const button = screen.getByTestId('generate-mob-portraits');
    expect(button.hasAttribute('disabled')).toBe(true);
    const user = userEvent.setup();
    await user.click(button);
    await flushAsyncUpdates();
    expect(screen.queryByTestId('mob-portraits-choice-dialog')).toBeNull();
    expect(planMock).not.toHaveBeenCalled();
    expect(enqueueMobPortraitsMock).not.toHaveBeenCalled();
  });
});

describe('MobPortraitsSection per-entry invented confirm (unchanged)', () => {
  it('per-entry already-imaged offers regen for that entry; Confirm regenerates, Cancel replays the old toast', async () => {
    const artifact = enc([{ name: 'Gloom Ooze', source: INLINE }]);
    enqueueInventedMock.mockResolvedValue({ created: 1, enqueued: 0, alreadyImaged: ['Gloom Ooze'] });
    regenerateInventedMock.mockResolvedValue({ created: 1, regenerated: 1 });
    render(<MobPortraitsSection artifact={artifact} campaignId="campaign-1" />);

    const user = userEvent.setup();
    await user.click(screen.getByTestId('create-creature-portrait-0'));
    await screen.findByTestId('mob-portraits-regen-dialog');
    expect(screen.getByTestId('mob-portraits-regen-dialog').textContent).toMatch(/Regenerate 1 portrait/);
    expect(screen.getByTestId('mob-portraits-regen-copy').textContent).toMatch(
      /Existing covers are replaced — "Gloom Ooze"/,
    );
    expect(screen.getByTestId('mob-portraits-regen-copy').textContent).toMatch(
      /stays until the new art lands/,
    );
    // The batch choice never appears on the per-entry path.
    expect(screen.queryByTestId('mob-portraits-choice-dialog')).toBeNull();

    await user.click(screen.getByTestId('mob-portraits-regen-confirm'));
    await waitFor(() => {
      expect(regenerateInventedMock).toHaveBeenCalledWith(artifact, 'campaign-1', [0]);
    });
    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalledWith(
        expect.stringMatching(/Regenerating portrait for "Gloom Ooze"/),
      );
    });
    expect(toastInfoMock).not.toHaveBeenCalled();
    await flushAsyncUpdates();
  });

  it('per-entry Cancel keeps the old already-has-portrait toast and regenerates nothing', async () => {
    const artifact = enc([{ name: 'Gloom Ooze', source: INLINE }]);
    enqueueInventedMock.mockResolvedValue({ created: 1, enqueued: 0, alreadyImaged: ['Gloom Ooze'] });
    render(<MobPortraitsSection artifact={artifact} campaignId="campaign-1" />);

    const user = userEvent.setup();
    await user.click(screen.getByTestId('create-creature-portrait-0'));
    await screen.findByTestId('mob-portraits-regen-dialog');

    await user.click(screen.getByTestId('mob-portraits-regen-cancel'));
    await waitFor(() => {
      expect(toastInfoMock).toHaveBeenCalledWith('"Gloom Ooze" already has a portrait');
    });
    expect(regenerateInventedMock).not.toHaveBeenCalled();
    await flushAsyncUpdates();
  });
});
