import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createModule as createModuleSchema, newId } from '@/domain';
import type * as ArtifactRepo from '@/db/artifactRepo';
import { createArtifact, getArtifact, listRevisions } from '@/db/artifactRepo';
import { createModule, deleteModule, getModule } from '@/db/moduleRepo';
import { clearDatabase } from './helpers';

/**
 * deleteModule disposal atomicity (10-MILESTONE-6 D5, integrity-fix arc):
 * the whole cascade/release runs in ONE `rw` transaction over every touched
 * table with the owned rows re-listed INSIDE it — a failure mid-cascade
 * rolls the ENTIRE delete back (module row included), so a half-applied
 * cascade can never persist. The error surfaces loudly to the caller.
 */

let realDeleteArtifact: (id: string) => Promise<void>;

vi.mock('@/db/artifactRepo', async (importOriginal) => {
  const actual = await importOriginal<typeof ArtifactRepo>();
  // Only `deleteArtifact` is replaceable; every other export stays real
  // (listArtifactsByModule, createArtifact, … are used by the code under
  // test AND by these tests' fixtures).
  return { ...actual, deleteArtifact: vi.fn() };
});

const { deleteArtifact } = await import('@/db/artifactRepo');
const deleteArtifactMock = vi.mocked(deleteArtifact);

beforeEach(async () => {
  const actual = await vi.importActual<typeof ArtifactRepo>('@/db/artifactRepo');
  realDeleteArtifact = actual.deleteArtifact;
  await clearDatabase();
  deleteArtifactMock.mockImplementation(realDeleteArtifact);
});

describe('deleteModule — transaction atomicity', () => {
  it('a mid-cascade failure rolls the whole delete back (no half-applied cascade)', async () => {
    const campaignId = newId();
    const module = await createModule(
      createModuleSchema({
        campaignId,
        title: 'Ember Crypt',
        concept: '',
        levelMin: 1,
        levelMax: 3,
        sizeDial: 'sketch',
      }),
    );
    // Alphabetical disposal order is deterministic: 'Aaa' first, then 'Bbb'.
    const first = await createArtifact({ campaignId, moduleId: module.id, kind: 'npc', name: 'Aaa' });
    const second = await createArtifact({ campaignId, moduleId: module.id, kind: 'npc', name: 'Bbb' });
    const uninvolved = await createArtifact({ campaignId, kind: 'note', name: 'Free note' });

    // The SECOND disposal explodes (the first one really deletes inside the
    // doomed transaction).
    deleteArtifactMock.mockImplementation(async (id) => {
      if (id === second.id) {
        throw new Error('simulated cascade failure');
      }
      await realDeleteArtifact(id);
    });

    await expect(deleteModule(module.id, 'cascade')).rejects.toThrow(/simulated cascade failure/);

    // Everything rolled back: the module row AND both owned artifacts
    // (including the one whose cascade "succeeded") with their revisions.
    expect(await getModule(module.id)).toBeDefined();
    expect(await getArtifact(first.id)).toBeDefined();
    expect(await getArtifact(second.id)).toBeDefined();
    expect((await listRevisions(first.id)).length).toBeGreaterThan(0);
    expect((await listRevisions(second.id)).length).toBeGreaterThan(0);
    // The uninvolved campaign row was never touched either.
    expect(await getArtifact(uninvolved.id)).toBeDefined();
  });

  it("'keep' still releases inside the transaction and deletes the module", async () => {
    const campaignId = newId();
    const module = await createModule(
      createModuleSchema({
        campaignId,
        title: 'Tide Gate',
        concept: '',
        levelMin: 1,
        levelMax: 3,
        sizeDial: 'sketch',
      }),
    );
    const owned = await createArtifact({ campaignId, moduleId: module.id, kind: 'npc', name: 'Kael' });

    await deleteModule(module.id, 'keep');

    expect(await getModule(module.id)).toBeUndefined();
    expect((await getArtifact(owned.id))?.moduleId).toBeNull();
    expect((await getArtifact(owned.id))?.campaignId).toBe(campaignId);
  });
});
