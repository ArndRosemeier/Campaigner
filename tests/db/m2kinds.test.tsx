import 'fake-indexeddb/auto';

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { createArtifact, getArtifact, updateArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { newId } from '@/domain';
import { ArtifactEditor } from '@/features/campaign/components/artifact-editor';
import { clearDatabase } from './helpers';
import { flushAsyncUpdates } from '../helpers/flush';

/**
 * M2 artifact kinds (06-MILESTONES): encounter / plotarc / session — domain
 * schemas, blank data through the repo, and the editor's kind forms.
 */

describe('encounter / plotarc / session kinds', () => {
  beforeEach(clearDatabase);

  it('creates artifacts of each new kind with blank data (revision 1)', async () => {
    for (const kind of ['encounter', 'plotarc', 'session'] as const) {
      const artifact = await createArtifact({
        campaignId: newId(),
        kind,
        name: `Test ${kind}`,
      });
      expect(artifact.currentRevision).toBe(1);
      expect(artifact.kind).toBe(kind);
    }

    const encounter = await createArtifact({
      campaignId: newId(),
      kind: 'encounter',
      name: 'Ambush at the ford',
      data: {
        difficulty: 'deadly',
        levelHint: '5',
        monsters: [
          { name: 'Troll', count: 2, notes: 'regenerates', source: { type: 'none' } },
        ],
        terrain: 'river crossing',
        tactics: 'hit and run',
        treasure: 'none',
        mapImageId: null,
      },
    });
    const stored = await getArtifact(encounter.id);
    expect(stored?.kind).toBe('encounter');
    if (stored?.kind === 'encounter') {
      expect(stored.data.monsters).toHaveLength(1);
      expect(stored.data.monsters[0]?.count).toBe(2);
    }
  });

  it('rejects kind/data mismatches (encounter data on a note)', async () => {
    await expect(
      createArtifact({
        campaignId: newId(),
        kind: 'note',
        name: 'Wrong',
        data: {
          difficulty: '',
          levelHint: '',
          monsters: [],
          terrain: '',
          tactics: '',
          treasure: '',
          mapImageId: null,
        },
      }),
    ).rejects.toThrow();
  });

  it('edits a session artifact through the editor form and autosaves', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const artifact = await createArtifact({
      campaignId: campaign.id,
      kind: 'session',
      name: 'Session 1',
    });

    render(
      <ArtifactEditor
        artifact={artifact}
        campaignId={campaign.id}
        campaignArtifacts={[artifact]}
        campaignSystem={campaign.system}
      />,
    );

    const recap = screen.getByLabelText('Recap');
    await user.type(recap, 'The party met in a tavern.');

    await waitFor(
      async () => {
        const stored = await getArtifact(artifact.id);
        expect(stored?.summary === undefined ? stored?.body : stored.body).toBeDefined();
        expect(stored?.currentRevision).toBeGreaterThanOrEqual(1);
        expect((stored as { data?: { recap?: string } } | undefined)?.data?.recap).toBe(
          'The party met in a tavern.',
        );
      },
      { timeout: 4000 },
    );

    // A content change appends a revision (source user). The write triggers
    // the editor's revision live query, so run it inside act.
    const after = await getArtifact(artifact.id);
    if (after === undefined) throw new Error('artifact vanished');
    await act(async () => {
      await updateArtifact(after.id, { summary: 'Session one recap recorded' });
    });
    const updated = await getArtifact(artifact.id);
    if (updated === undefined) throw new Error('artifact vanished after update');
    expect(updated.currentRevision).toBe(after.currentRevision + 1);
    await flushAsyncUpdates();
  }, 20000);
});
