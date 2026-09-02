import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { createArtifact, getArtifact } from '@/db/artifactRepo';
import { newId } from '@/domain';
import { clearDatabase } from './helpers';

/** M2 surviving artifact kinds after M6-E retires session notes. */
describe('encounter / plotarc kinds', () => {
  beforeEach(clearDatabase);

  it('creates artifacts of each surviving kind with blank data', async () => {
    for (const kind of ['encounter', 'plotarc'] as const) {
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

  it('rejects kind/data mismatches', async () => {
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
});
