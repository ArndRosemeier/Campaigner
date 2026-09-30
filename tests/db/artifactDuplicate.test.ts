import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { newId } from '@/domain/entity';
import { createArtifact, duplicateArtifact, listRevisions, updateArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { clearDatabase, expectNotFound } from './helpers';

beforeEach(clearDatabase);

describe('duplicateArtifact', () => {
  it('copies content under a fresh identity with "(copy)" suffix and revision 1', async () => {
    const campaign = await createCampaign({
      name: 'C',
      description: '',
      system: 'dnd5e',
    });
    const original = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Gorim',
      tags: ['blacksmith'],
      body: 'A gruff dwarf.',
      data: {
        appearance: '',
        personality: '',
        statBlock: null,
      },
    });
    await updateArtifact(original.id, { body: 'A gruff dwarf with a secret.' });

    const copy = await duplicateArtifact(original.id);

    expect(copy.id).not.toBe(original.id);
    expect(copy.name).toBe('Gorim (copy)');
    expect(copy.currentRevision).toBe(1);
    expect(copy.tags).toEqual(['blacksmith']);
    expect(copy.body).toBe('A gruff dwarf with a secret.');
    expect(copy.createdAt).toBe(copy.updatedAt);

    const copyRevisions = await listRevisions(copy.id);
    expect(copyRevisions).toHaveLength(1);
    expect(copyRevisions[0]?.revision).toBe(1);
    expect(copyRevisions[0]?.snapshot.name).toBe('Gorim (copy)');

    // The original is untouched: still 2 revisions, same name.
    const originalRevisions = await listRevisions(original.id);
    expect(originalRevisions).toHaveLength(2);
    expect(originalRevisions.every((row) => row.artifactId === original.id)).toBe(true);
  });

  it('rejects duplicating a missing artifact with NotFoundError', async () => {
    await expectNotFound(duplicateArtifact(newId()));
  });
});
