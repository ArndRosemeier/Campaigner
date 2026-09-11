import 'fake-indexeddb/auto';

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ArtifactEditor } from '@/features/campaign/components/artifact-editor';
import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import type { AnyArtifact } from '@/domain';
import type * as ChangeArtifactModule from '@/features/modules/change-artifact';
import type * as ToastModule from '@/lib/toast';
import { clearDatabase } from '../db/helpers';

/**
 * The routed UI call site (docs/17 row 101, docs/18 §2): the artifact editor's
 * two encounter actions must reach the ENGINE — and they must reach it THROUGH
 * the one seam, not around it. Both halves are asserted:
 *
 * - `changeArtifact` is a PASS-THROUGH spy around the real seam, so the click
 *   proves the component's engine call goes through it (a component calling a
 *   specialist directly would leave the spy uncalled);
 * - the specialist behind the seam is a spy too, so the click proves the chain
 *   button → seam → `encounterRegen` still arrives (a seam that swallowed the
 *   request would leave it uncalled).
 *
 * The surface's own behaviour is pinned unchanged: its success sentence, its
 * `Could not …` sentence on a failure, and the fact that a failure stays LOUD
 * (AGENTS 2) now that the engine call is one indirection deeper.
 */

const { repopulateMock, regenerateMock, toastErrorMock, toastSuccessMock } = vi.hoisted(() => ({
  repopulateMock: vi.fn(),
  regenerateMock: vi.fn(),
  toastErrorMock: vi.fn(),
  toastSuccessMock: vi.fn(),
}));

vi.mock('@/features/campaign/encounterRegen', () => ({
  repopulateEncounter: repopulateMock,
  regenerateEncounterEverything: regenerateMock,
}));

vi.mock('@/lib/toast', async (importOriginal) => {
  const actual = await importOriginal<typeof ToastModule>();
  return { ...actual, toastError: toastErrorMock, toastSuccess: toastSuccessMock };
});

vi.mock('@/features/modules/change-artifact', async (importOriginal) => {
  const actual = await importOriginal<typeof ChangeArtifactModule>();
  return { ...actual, changeArtifact: vi.fn(actual.changeArtifact) };
});

const { changeArtifact } = await import('@/features/modules/change-artifact');
const changeArtifactMock = vi.mocked(changeArtifact);

async function seedEncounter(): Promise<{ campaignId: string; encounter: AnyArtifact }> {
  const campaign = await createCampaign({ name: 'Gate Campaign', system: 'dnd5e' });
  const encounter = await createArtifact({
    campaignId: campaign.id,
    kind: 'encounter',
    name: 'Gate Ambush',
    summary: 'A gate fight.',
    body: 'The gate.',
    data: {
      difficulty: 'medium',
      levelHint: '3',
      monsters: [],
      terrain: '',
      tactics: '',
      treasure: '',
      mapImageId: null,
      preset: 'standard',
      locationKind: 'other',
      siteShape: 'single',
      budgetAdvisory: '',
      layout: null,
    },
  });
  return { campaignId: campaign.id, encounter };
}

function renderEditor(encounter: AnyArtifact, campaignId: string): void {
  render(
    <ArtifactEditor
      artifact={encounter}
      campaignId={campaignId}
      campaignArtifacts={[encounter]}
      campaignSystem="dnd5e"
    />,
  );
}

async function clickAction(testId: 'encounter-repopulate' | 'encounter-regenerate-everything'): Promise<void> {
  const user = userEvent.setup();
  const section = screen.getByTestId('encounter-ai-section');
  await user.click(within(section).getByTestId(testId));
  await waitFor(() => {
    expect(changeArtifactMock).toHaveBeenCalled();
  });
}

beforeEach(async () => {
  await clearDatabase();
  repopulateMock.mockReset();
  regenerateMock.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
  changeArtifactMock.mockClear();
  repopulateMock.mockResolvedValue(undefined);
  regenerateMock.mockResolvedValue(undefined);
});

describe('the editor\u2019s encounter actions route through the change seam', () => {
  it('Repopulate goes button → seam → the specialist, and toasts the same sentence', async () => {
    const { campaignId, encounter } = await seedEncounter();
    renderEditor(encounter, campaignId);

    await clickAction('encounter-repopulate');

    expect(changeArtifactMock).toHaveBeenCalledWith({
      artifactId: encounter.id,
      encounter: { operation: 'repopulate', redesignProse: false },
    });
    // …through the seam, into the engine (forwarded untouched).
    expect(repopulateMock).toHaveBeenCalledWith(encounter.id, { redesignProse: false });
    expect(regenerateMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).toHaveBeenCalledWith(
      'Encounter repopulated — a new roster stocks every room, map kept',
    );
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it('Regenerate everything reaches the other specialist, through the same seam', async () => {
    const { campaignId, encounter } = await seedEncounter();
    renderEditor(encounter, campaignId);

    await clickAction('encounter-regenerate-everything');

    expect(changeArtifactMock).toHaveBeenCalledWith({
      artifactId: encounter.id,
      encounter: { operation: 'everything', redesignProse: false },
    });
    expect(regenerateMock).toHaveBeenCalledWith(encounter.id, { redesignProse: false });
    expect(repopulateMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).toHaveBeenCalledWith(
      'Encounter regenerated — new roster, new layout, new map',
    );
  });

  it('a specialist failure still reaches the owner loudly (the surface\u2019s own sentence + the cause)', async () => {
    const { campaignId, encounter } = await seedEncounter();
    repopulateMock.mockRejectedValueOnce(new Error('The Encounter Smith persona is missing'));
    renderEditor(encounter, campaignId);

    await clickAction('encounter-repopulate');

    expect(toastErrorMock).toHaveBeenCalledWith(
      'Could not repopulate the encounter',
      expect.objectContaining({ message: 'The Encounter Smith persona is missing' }),
    );
    expect(toastSuccessMock).not.toHaveBeenCalled();
  });
});
