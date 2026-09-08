import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AnyArtifact } from '@/domain';
import { MobPortraitsSection } from '@/features/campaign/components/mob-portraits-section';
import { flushAsyncUpdates } from '../helpers/flush';

/**
 * Mob portraits section (docs/11 D5 amendment): rulebook-cited kinds keep
 * the "Generate mob portraits" batch, while uncited entries (inline/none)
 * get a per-entry and batch-all "Create creature + portrait" action — no
 * more dead-end disabled button when zero rulebook entries exist.
 */

vi.mock('@/features/campaign/mob-portrait-queue', () => ({
  enqueueMobPortraits: vi.fn(),
  enqueueInventedCreaturePortraits: vi.fn(),
}));
vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn(), toastInfo: vi.fn() }));

const { enqueueMobPortraits, enqueueInventedCreaturePortraits } = await import(
  '@/features/campaign/mob-portrait-queue'
);
const enqueueMobPortraitsMock = vi.mocked(enqueueMobPortraits);
const enqueueInventedMock = vi.mocked(enqueueInventedCreaturePortraits);

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

const INLINE = { type: 'inline', statBlock: null };
const NONE = { type: 'none' };
const RULEBOOK = { type: 'rulebook', chunkId: 'chunk-1' };

beforeEach(() => {
  enqueueMobPortraitsMock.mockReset();
  enqueueInventedMock.mockReset();
  enqueueMobPortraitsMock.mockResolvedValue({ enqueued: 0, alreadyImaged: [] });
  enqueueInventedMock.mockResolvedValue({ created: 0, enqueued: 0, alreadyImaged: [] });
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
    await flushAsyncUpdates();
  });

  it('batch-all with both kinds calls both batches; rulebook-only keeps the portrait batch label', async () => {
    const artifact = enc([
      { name: 'Goblin Boss', source: RULEBOOK },
      { name: 'Gloom Ooze', source: INLINE },
    ]);
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
