import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createModule as createModuleSchema, newId } from '@/domain';
import type * as ArtifactRepo from '@/db/artifactRepo';
import { createArtifact, getArtifact, listRevisions } from '@/db/artifactRepo';
import { createModule, deleteModule, getModule, patchModule } from '@/db/moduleRepo';
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
    const beforeRevisions = (await listRevisions(owned.id)).length;

    await deleteModule(module.id, 'keep');

    expect(await getModule(module.id)).toBeUndefined();
    expect((await getArtifact(owned.id))?.moduleId).toBeNull();
    expect((await getArtifact(owned.id))?.campaignId).toBe(campaignId);
    // The bulk release writes the SAME revisioned scope change a single move
    // writes (docs/18 §2.1 `releaseModuleOwnership`), inside this tx.
    expect((await listRevisions(owned.id)).length).toBe(beforeRevisions + 1);
  });

  it("'keep' rolls the whole release back when the module delete fails after it", async () => {
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
    const beforeRevisions = (await listRevisions(owned.id)).length;
    // The module row delete is made to explode: it runs AFTER the release in
    // the same transaction, so a release that leaked out of the tx would
    // leave campaign-level rows belonging to a module that still exists.
    const modules = (await import('@/db/db')).db.modules;
    const originalDelete = modules.delete.bind(modules);
    const target = modules as unknown as { delete: (key: string) => Promise<void> };
    target.delete = async (key: string) => {
      if (key === module.id) throw new Error('simulated module delete failure');
      await originalDelete(key);
    };
    try {
      await expect(deleteModule(module.id, 'keep')).rejects.toThrow(/simulated module delete failure/);
    } finally {
      target.delete = originalDelete;
    }

    expect(await getModule(module.id)).toBeDefined();
    expect((await getArtifact(owned.id))?.moduleId).toBe(module.id);
    expect((await listRevisions(owned.id)).length).toBe(beforeRevisions);
  });

  it("'promote-referenced' shares outside-referenced rows and cascades the rest", async () => {
    const campaignId = newId();
    const doomed = await createModule(
      createModuleSchema({ campaignId, title: 'Doomed Vault', concept: '', levelMin: 1, levelMax: 3, sizeDial: 'sketch' }),
    );
    const reader = await createModule(
      createModuleSchema({ campaignId, title: 'Reader Vault', concept: '', levelMin: 1, levelMax: 3, sizeDial: 'sketch' }),
    );
    const shared = await createArtifact({ campaignId, moduleId: doomed.id, kind: 'npc', name: 'Shared Hexer' });
    const solo = await createArtifact({ campaignId, moduleId: doomed.id, kind: 'npc', name: 'Solo Squire' });
    // The reader module links the hexer in its part text — an outside
    // reference that must survive the delete as a shared row.
    await patchModule(reader.id, {
      parts: [{ planIndex: 0, markdown: 'Hire [[Shared Hexer]].', status: 'ready', errorMessage: '', edited: true, writerModel: '' , origin: null }],
    });

    await deleteModule(doomed.id, 'promote-referenced');

    expect(await getModule(doomed.id)).toBeUndefined();
    expect((await getArtifact(shared.id))?.moduleId).toBeNull();
    expect((await getArtifact(shared.id))?.campaignId).toBe(campaignId);
    expect(await getArtifact(solo.id)).toBeUndefined();
  });
});

/**
 * Last-module shortcut pin (F2 remainder): a module deletion clears
 * settings.lastModule when it pointed at the deleted module — the TopBar
 * shortcut would otherwise navigate to a dead reader route. Both disposal
 * branches (cascade/keep) share the same transaction, so one pin per branch.
 */
describe('deleteModule — last-module shortcut', () => {
  beforeEach(async () => {
    await clearDatabase();
    deleteArtifactMock.mockImplementation(realDeleteArtifact);
  });

  it('clears settings.lastModule when the deleted module was the shortcut (cascade)', async () => {
    const { updateSettings } = await import('@/db/settingsRepo');
    const campaignId = newId();
    const module = await createModule(
      createModuleSchema({ campaignId, title: 'Shortlived Vault', concept: '', levelMin: 1, levelMax: 3, sizeDial: 'sketch' }),
    );
    await updateSettings({
      lastModule: { campaignId, moduleId: module.id, name: module.title },
    });

    await deleteModule(module.id, 'cascade');

    const settings = await (await import('@/db/db')).db.settings.get('settings');
    expect(settings?.lastModule).toBeNull();
  });

  it('keeps settings.lastModule when an unrelated module is deleted (keep)', async () => {
    const { updateSettings } = await import('@/db/settingsRepo');
    const campaignId = newId();
    const survivor = await createModule(
      createModuleSchema({ campaignId, title: 'Survivor Vault', concept: '', levelMin: 1, levelMax: 3, sizeDial: 'sketch' }),
    );
    const other = await createModule(
      createModuleSchema({ campaignId, title: 'Deleted Vault', concept: '', levelMin: 1, levelMax: 3, sizeDial: 'sketch' }),
    );
    await updateSettings({
      lastModule: { campaignId, moduleId: survivor.id, name: survivor.title },
    });

    await deleteModule(other.id, 'keep');

    const settings = await (await import('@/db/db')).db.settings.get('settings');
    expect(settings?.lastModule?.moduleId).toBe(survivor.id);
  });
});
