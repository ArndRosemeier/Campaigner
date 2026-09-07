import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { artifactScope, newId, type AnyArtifact, type ArtifactRevision } from '@/domain';
import {
  adoptIntoCampaign,
  attachImagesToArtifact,
  countArtifactsByCampaign,
  createArtifact,
  deleteArtifact,
  getAnyArtifact,
  getArtifact,
  listArtifactsByCampaign,
  listArtifactsByModule,
  listGlobalArtifacts,
  listRevisions,
  moveToModule,
  publishToLibrary,
  campaignsReferencingArtifact,
  restoreRevision,
  stampModuleOwnership,
  updateArtifact,
} from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { createModule, deleteModule } from '@/db/moduleRepo';
import { pruneUnreferencedImages } from '@/db/imageRepo';
import { createModule as createModuleSchema } from '@/domain';
import { db } from '@/db/db';
import { clearDatabase, expectNotFound } from './helpers';

describe('artifactRepo revisions', () => {
  beforeEach(clearDatabase);

  it('creates revision 1 with a full snapshot on create', async () => {
    const artifact = await createArtifact({
      campaignId: newId(),
      kind: 'npc',
      name: 'Grimm',
      tags: ['goblin'],
    });

    expect(artifact.currentRevision).toBe(1);

    const rows = await db.revisions.where('artifactId').equals(artifact.id).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revision).toBe(1);
    expect(rows[0]?.source).toBe('user');
    expect(rows[0]?.runId).toBeNull();
    expect(rows[0]?.snapshot.name).toBe('Grimm');
    expect(rows[0]?.snapshot.tags).toEqual(['goblin']);
  });

  it('records the persona source and runId when saving for a run', async () => {
    const runId = newId();
    const artifact = await createArtifact(
      { campaignId: newId(), kind: 'npc', name: 'Smithed NPC' },
      { source: 'persona', runId },
    );

    const row = (await listRevisions(artifact.id)).at(0);
    expect(row?.source).toBe('persona');
    expect(row?.runId).toBe(runId);
  });

  it('increments the revision and writes a snapshot per save', async () => {
    const artifact = await createArtifact({
      campaignId: newId(),
      kind: 'location',
      name: 'Ruins',
    });

    const saved = await updateArtifact(artifact.id, { body: 'v2', summary: 'A ruin.' });

    expect(saved.currentRevision).toBe(2);
    expect(saved.body).toBe('v2');

    const row = (await listRevisions(artifact.id)).find((entry) => entry.revision === 2);
    expect(row?.snapshot.body).toBe('v2');
    expect(row?.snapshot.summary).toBe('A ruin.');

    const reread = await getArtifact(artifact.id);
    expect(reread?.currentRevision).toBe(2);
  });

  it('keeps at most 50 revisions per artifact (oldest deleted)', async () => {
    let artifact: AnyArtifact = await createArtifact({
      campaignId: newId(),
      kind: 'note',
      name: 'Journal',
    });

    // 55 saves on top of revision 1 → currentRevision 56, but only 50 rows.
    for (let i = 0; i < 55; i++) {
      artifact = await updateArtifact(artifact.id, { body: `v${i}` });
    }

    expect(artifact.currentRevision).toBe(56);

    const revisions = await listRevisions(artifact.id);
    expect(revisions).toHaveLength(50);
    // Sorted newest first: 56 down to 7.
    expect(revisions[0]?.revision).toBe(56);
    expect(revisions.at(-1)?.revision).toBe(7);
    // Snapshots keep their historical content.
    expect(revisions[0]?.snapshot.body).toBe('v54');
    expect(revisions.at(-1)?.snapshot.body).toBe('v5');
  });

  it('restores an old snapshot as a NEW revision', async () => {
    let artifact: AnyArtifact = await createArtifact({
      campaignId: newId(),
      kind: 'faction',
      name: 'Guild',
    });
    for (let i = 0; i < 55; i++) {
      artifact = await updateArtifact(artifact.id, { body: `v${i}` });
    }

    const restored = await restoreRevision(artifact.id, 7);

    expect(restored.currentRevision).toBe(57);
    expect(restored.body).toBe('v5');

    // The restore itself is a revision; the cap still holds (7 dropped, 57 added).
    const revisions = await listRevisions(artifact.id);
    expect(revisions).toHaveLength(50);
    expect(revisions[0]?.revision).toBe(57);
    expect(revisions[0]?.snapshot.body).toBe('v5');
    expect(revisions.at(-1)?.revision).toBe(8);
  });

  it('rejects saving an artifact whose data does not match its kind', async () => {
    const artifact = await createArtifact({
      campaignId: newId(),
      kind: 'npc',
      name: 'Grimm',
    });

    await expect(
      updateArtifact(artifact.id, {
        data: { goals: '', methods: '', resources: '', ranks: [] },
      }),
    ).rejects.toThrow();
  });

  it('throws NotFoundError for missing artifacts/revisions', async () => {
    // updateArtifact/restoreRevision throw inside transactions, so Dexie
    // wraps the error — match through the guard, not by identity.
    await expectNotFound(updateArtifact('missing', { body: 'x' }));
    await expectNotFound(restoreRevision('missing', 1));
    expect(await listRevisions(newId())).toEqual([]);
  });

  it('deletes the artifact and its revision history', async () => {
    const artifact = await createArtifact({
      campaignId: newId(),
      kind: 'note',
      name: 'Disposable',
    });
    await updateArtifact(artifact.id, { body: 'v2' });

    await deleteArtifact(artifact.id);

    expect(await db.artifacts.get(artifact.id)).toBeUndefined();
    expect(await db.revisions.where('artifactId').equals(artifact.id).count()).toBe(0);
  });

  it('lists artifacts alphabetically and counts per campaign', async () => {
    const campaignId = newId();
    await createArtifact({ campaignId, kind: 'note', name: 'Beta' });
    await createArtifact({ campaignId, kind: 'npc', name: 'Alpha' });
    await createArtifact({ campaignId, kind: 'faction', name: 'Gamma' });

    const names = (await listArtifactsByCampaign(campaignId)).map((a) => a.name);
    expect(names).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(await countArtifactsByCampaign(campaignId)).toBe(3);
  });
});

describe('deleteArtifact', () => {
  it('removes the artifact, its revisions, and dangling links in other artifacts', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const npc = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Gorim' });
    const location = await createArtifact({
      campaignId: campaign.id,
      kind: 'location',
      name: 'Forge',
      links: [{ targetId: npc.id, relation: 'workplace-of' }],
      body: 'x'.repeat(50),
    });
    const note = await createArtifact({
      campaignId: campaign.id,
      kind: 'note',
      name: 'Rumors',
      links: [{ targetId: location.id, relation: 'about' }],
      body: 'y'.repeat(50),
    });

    await deleteArtifact(npc.id);

    const afterLocation = await getArtifact(location.id);
    expect(afterLocation?.links).toEqual([]);
    const afterNote = await getArtifact(note.id);
    expect(afterNote?.links).toEqual([{ targetId: location.id, relation: 'about' }]);
    expect(await getArtifact(npc.id)).toBeUndefined();
    expect(await listRevisions(npc.id)).toEqual([]);
  });
});

describe('restoreRevision scope pinning', () => {
  beforeEach(clearDatabase);

  function moduleInput(campaignId: string, title: string) {
    return createModuleSchema({
      campaignId,
      title,
      concept: '',
      levelMin: 1,
      levelMax: 3,
      sizeDial: 'sketch',
    });
  }

  it('restoring revision 1 of a module-owned artifact keeps module ownership', async () => {
    const campaignId = newId();
    const module = await createModule(moduleInput(campaignId, 'Ember Crypt'));
    const artifact = await createArtifact({
      campaignId,
      moduleId: module.id,
      kind: 'npc',
      name: 'Kael',
      body: 'revision one body',
    });
    await updateArtifact(artifact.id, { body: 'revision two body' });
    await updateArtifact(artifact.id, { body: 'revision three body' });

    const restored = await restoreRevision(artifact.id, 1);

    expect(restored.body).toBe('revision one body');
    // The scope does not time-travel with the snapshot.
    expect(restored.moduleId).toBe(module.id);
    expect(restored.campaignId).toBe(campaignId);
    expect((await getArtifact(artifact.id))?.moduleId).toBe(module.id);
  });

  it('a snapshot whose scope differs restores content-only (explicit scope moves stay the only pathway)', async () => {
    const campaignId = newId();
    const module = await createModule(moduleInput(campaignId, 'Ember Crypt'));
    // Revision 1 is campaign-level; revision 2 moves the row into the module
    // via the sanctioned moveScope pathway.
    const artifact = await createArtifact({
      campaignId,
      kind: 'npc',
      name: 'Kael',
      body: 'campaign-level snapshot body',
    });
    await moveToModule(artifact.id, module.id);
    expect((await getArtifact(artifact.id))?.moduleId).toBe(module.id);

    const restored = await restoreRevision(artifact.id, 1);

    // The pre-move snapshot carries moduleId: null — restoring it must NOT
    // release the artifact back to campaign level; only the body came back.
    expect(restored.body).toBe('campaign-level snapshot body');
    expect(restored.moduleId).toBe(module.id);
    expect(restored.campaignId).toBe(campaignId);
  });
});

describe('stampModuleOwnership', () => {
  beforeEach(clearDatabase);

  function moduleInput(campaignId: string, title: string) {
    return createModuleSchema({
      campaignId,
      title,
      concept: '',
      levelMin: 1,
      levelMax: 3,
      sizeDial: 'sketch',
    });
  }

  it('stamps a campaign-level artifact into an existing module (idempotent tag)', async () => {
    const campaignId = newId();
    const module = await createModule(moduleInput(campaignId, 'Ember Crypt'));
    const artifact = await createArtifact({ campaignId, kind: 'npc', name: 'Kael' });

    const stamped = await stampModuleOwnership(artifact.id, module.id, 'module:Ember Crypt');

    expect(stamped.moduleId).toBe(module.id);
    expect(stamped.tags).toContain('module:Ember Crypt');
    expect(stamped.campaignId).toBe(campaignId);
  });

  it('throws loudly (naming the id) when the module row is gone — no dangling ownership', async () => {
    const campaignId = newId();
    const module = await createModule(moduleInput(campaignId, 'Doomed Vault'));
    const artifact = await createArtifact({ campaignId, kind: 'npc', name: 'Kael' });
    // The module is deleted while its "generation" is between create + stamp.
    await deleteModule(module.id, 'keep');

    await expect(stampModuleOwnership(artifact.id, module.id, 'module:Doomed Vault')).rejects.toThrow(
      `module ${module.id} no longer exists`,
    );
    // The write was refused wholesale — the artifact stays campaign-level.
    expect((await getArtifact(artifact.id))?.moduleId).toBeNull();
  });
});

describe('ownership queries (M6-A)', () => {
  beforeEach(clearDatabase);

  const campaignId = '00000000-0000-4000-8000-000000000c01';
  const moduleId = '00000000-0000-4000-8000-0000000000b1';

  /** Writes a global library npc directly — the publish writer lands in
   * M6-C, but the scope queries/moves must behave around such rows now. */
  async function putGlobalNpc(id: string): Promise<void> {
    const { anyArtifactSchema } = await import('@/domain');
    await db.artifacts.put(
      anyArtifactSchema.parse({
        id,
        createdAt: 1,
        updatedAt: 1,
        campaignId: null,
        moduleId: null,
        kind: 'npc',
        name: 'Library troll',
        tags: [],
        aliases: [],
        summary: '',
        body: '',
        links: [],
        currentRevision: 1,
        imageIds: [],
        coverImageId: null,
        data: {
          appearance: '',
          personality: '',
          statBlock: null,
        },
      }),
    );
  }

  /** Writes rows directly — the scope-move writers land in M6-B/C; the
   * queries must be correct for rows of every scope from day one. */
  async function putRows(rows: unknown[]): Promise<void> {
    const { anyArtifactSchema } = await import('@/domain');
    for (const row of rows) await db.artifacts.put(anyArtifactSchema.parse(row));
  }

  function noteRow(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: newId(),
      createdAt: 1,
      updatedAt: 1,
      campaignId,
      moduleId: null,
      kind: 'note',
      name: 'A note',
      tags: [],
      aliases: [],
      summary: '',
      body: '',
      links: [],
      currentRevision: 1,
      imageIds: [],
      coverImageId: null,
      data: {},
      ...over,
    };
  }

  function globalNpcRow(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: newId(),
      createdAt: 1,
      updatedAt: 1,
      campaignId: null,
      moduleId: null,
      kind: 'npc',
      name: 'Library troll',
      tags: [],
      aliases: [],
      summary: '',
      body: '',
      links: [],
      currentRevision: 1,
      imageIds: [],
      coverImageId: null,
      data: { appearance: '', personality: '', statBlock: null },
      ...over,
    };
  }

  it('listArtifactsByCampaign returns campaign- and module-owned rows, never global', async () => {
    await putRows([
      noteRow({ name: 'Campaign note' }),
      noteRow({ id: newId(), name: 'Module note', moduleId }),
      globalNpcRow(),
    ]);

    const rows = await listArtifactsByCampaign(campaignId);
    expect(rows.map((row) => row.name).sort()).toEqual(['Campaign note', 'Module note']);
    // Module-owned rows are reachable through the module query with the
    // same anchored campaign.
    const moduleRows = await listArtifactsByModule(moduleId);
    expect(moduleRows.map((row) => row.name)).toEqual(['Module note']);
    expect(moduleRows[0]?.campaignId).toBe(campaignId);
  });

  it('listGlobalArtifacts returns only the library rows', async () => {
    await putRows([
      noteRow({ name: 'Campaign note' }),
      globalNpcRow(),
      globalNpcRow({ id: newId(), name: 'Library goblin', kind: 'npc' }),
    ]);

    const globals = await listGlobalArtifacts();
    expect(globals.map((row) => row.name).sort()).toEqual(['Library goblin', 'Library troll']);
    const first = globals[0];
    if (first === undefined) throw new Error('no global rows returned');
    expect(artifactScope(first)).toBe('global');
    // getAnyArtifact sees every scope; getArtifact stays owned-only.
    expect((await getAnyArtifact(first.id))?.campaignId).toBeNull();
    expect(await getArtifact(first.id)).toBeUndefined();
    const owned = await listArtifactsByCampaign(campaignId);
    const ownedFirst = owned[0];
    if (ownedFirst === undefined) throw new Error('no owned rows returned');
    expect((await getArtifact(ownedFirst.id))?.name).toBe(ownedFirst.name);
  });

  it('moveToModule moves within the campaign and refuses everything else', async () => {
    const targetModule = await createModule(
      createModuleSchema({
        campaignId,
        title: 'Ember Crypt',
        concept: '',
        levelMin: 1,
        levelMax: 3,
        sizeDial: 'sketch',
      }),
    );
    const owned = await createArtifact({
      campaignId,
      kind: 'npc',
      name: 'Kael',
    });

    // Happy path: campaign-owned → module-owned, same campaign.
    const moved = await moveToModule(owned.id, targetModule.id);
    expect(moved.moduleId).toBe(targetModule.id);
    expect(moved.campaignId).toBe(campaignId);
    // The move is a user save — revision history records it.
    expect(moved.currentRevision).toBe(2);

    // Cross-campaign modules are refused loudly (images/battles key on the
    // old campaignId).
    const foreignCampaign = await createCampaign({ name: 'X', system: 'dnd5e' });
    const foreignModule = await createModule(
      createModuleSchema({
        campaignId: foreignCampaign.id,
        title: 'Far Away',
        concept: '',
        levelMin: 1,
        levelMax: 3,
        sizeDial: 'sketch',
      }),
    );
    await expect(moveToModule(owned.id, foreignModule.id)).rejects.toThrow(/another campaign/);

    // Global rows have no module to move into.
    const globalId = '00000000-0000-4000-8000-00000000b010';
    await putGlobalNpc(globalId);
    await expect(moveToModule(globalId, targetModule.id)).rejects.toThrow(
      /adopt it into a campaign/,
    );
  });

  it('publishes only library kinds and carries image ownership across publish/adopt', async () => {
    const npc = await createArtifact({ campaignId, kind: 'npc', name: 'Grix' });
    const imageId = newId();
    await db.images.put({
      id: imageId,
      createdAt: 1,
      updatedAt: 1,
      campaignId,
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: 'image/png',
      width: 1,
      height: 1,
      prompt: '',
      model: '',
      source: 'uploaded',
      role: 'artwork',
    });
    await updateArtifact(npc.id, { imageIds: [imageId], coverImageId: imageId });

    const published = await publishToLibrary(npc.id);
    expect(published.id).toBe(npc.id);
    expect(published.campaignId).toBeNull();
    expect(published.moduleId).toBeNull();
    expect((await db.images.get(imageId))?.campaignId).toBeNull();
    expect(await getArtifact(npc.id)).toBeUndefined();

    const adopted = await adoptIntoCampaign(npc.id, campaignId);
    expect(adopted.campaignId).toBe(campaignId);
    expect((await db.images.get(imageId))?.campaignId).toBe(campaignId);

    const note = await createArtifact({ campaignId, kind: 'note', name: 'Private note' });
    await expect(publishToLibrary(note.id)).rejects.toThrow(/only npcs, locations, factions and encounters/);
  });

  it('keeps global images out of campaign prune and removes them with the library row', async () => {
    const npc = await createArtifact({ campaignId, kind: 'npc', name: 'Library image owner' });
    const imageId = newId();
    await db.images.put({
      id: imageId,
      createdAt: 1,
      updatedAt: 1,
      campaignId,
      bytes: new Uint8Array([9]),
      mimeType: 'image/png',
      width: 1,
      height: 1,
      prompt: '',
      model: '',
      source: 'uploaded',
      role: 'artwork',
    });
    await updateArtifact(npc.id, { imageIds: [imageId] });
    await publishToLibrary(npc.id);

    await pruneUnreferencedImages(campaignId);
    expect((await db.images.get(imageId))?.campaignId).toBeNull();
    await deleteArtifact(npc.id);
    expect(await db.images.get(imageId)).toBeUndefined();
  });

  it('lists referencing campaigns before adopting a library row away', async () => {
    const globalId = '00000000-0000-4000-8000-00000000b003';
    await putGlobalNpc(globalId);
    const otherCampaign = await createCampaign({ name: 'Other', system: 'dnd5e' });
    await createArtifact({
      campaignId,
      kind: 'note',
      name: 'Reference one',
      links: [{ targetId: globalId, relation: '' }],
    });
    await createArtifact({
      campaignId: otherCampaign.id,
      kind: 'note',
      name: 'Reference two',
      links: [{ targetId: globalId, relation: '' }],
    });

    expect(new Set(await campaignsReferencingArtifact(globalId))).toEqual(
      new Set([campaignId, otherCampaign.id]),
    );
  });

  it('adoptIntoCampaign clears the module binding; globals need a target', async () => {
    const owned = await createArtifact({
      campaignId,
      moduleId,
      kind: 'npc',
      name: 'Kael',
    });

    const adopted = await adoptIntoCampaign(owned.id);
    expect(adopted.moduleId).toBeNull();
    expect(adopted.campaignId).toBe(campaignId);
    expect(adopted.id).toBe(owned.id);

    // A foreign campaignId is refused — adoption never re-anchors an owned row.
    const otherCampaign = await createCampaign({ name: 'Other', system: 'dnd5e' });
    await expect(adoptIntoCampaign(owned.id, otherCampaign.id)).rejects.toThrow(/another campaign/);

    // A global row adopts INTO a campaign in one write.
    const globalId = '00000000-0000-4000-8000-00000000b001';
    await putGlobalNpc(globalId);
    const adoptedGlobal = await adoptIntoCampaign(globalId, campaignId);
    expect(adoptedGlobal.campaignId).toBe(campaignId);
    expect(adoptedGlobal.moduleId).toBeNull();
    expect(await getAnyArtifact(globalId)).toBeDefined();

    // …and refuses without an explicit target.
    const { anyArtifactSchema: schema } = await import('@/domain');
    const orphanId = '00000000-0000-4000-8000-00000000b002';
    await db.artifacts.put(
      schema.parse({
        id: orphanId,
        createdAt: 1,
        updatedAt: 1,
        campaignId: null,
        moduleId: null,
        kind: 'faction',
        name: 'Library cult',
        tags: [],
        aliases: [],
        summary: '',
        body: '',
        links: [],
        currentRevision: 1,
        imageIds: [],
        coverImageId: null,
        data: { goals: '', methods: '', resources: '', ranks: [] },
      }),
    );
    await expect(adoptIntoCampaign(orphanId)).rejects.toThrow(/pick a campaign/);
  });
});

/**
 * Parse-on-read at the Dexie boundary (the ratified `parseBattleRow`
 * template): rows written by an OLDER app version predate later-arc fields
 * (moduleId, the encounter map/preset/locationKind block, M3 image fields,
 * the revision envelope's source/runId). Every repo getter schema-parses, so
 * the zod defaults materialize instead of handing the UI `undefined` — no
 * Dexie migration rides along (the additive-fields convention).
 */
describe('legacy rows (parse-on-read materializes defaults)', () => {
  beforeEach(clearDatabase);

  it('materializes encounter + ownership defaults on an artifact row lacking them', async () => {
    const campaignId = (await createCampaign({ name: 'Legacy', system: 'dnd5e' })).id;
    const legacyEncounter = {
      id: newId(),
      createdAt: 1,
      updatedAt: 1,
      campaignId,
      kind: 'encounter',
      name: 'Pre-b290f12 ambush',
      tags: [],
      summary: '',
      body: '',
      links: [],
      currentRevision: 1,
      data: {
        difficulty: 'medium',
        levelHint: '3',
        monsters: [{ name: 'Troll', count: 2, notes: 'regenerates', source: { type: 'none' } }],
        terrain: '',
        tactics: '',
        treasure: '',
        // NO mapImageId/layout/preset/locationKind, NO moduleId/imageIds/…
      },
    };
    await db.artifacts.put(legacyEncounter as unknown as AnyArtifact);

    const artifact = await getArtifact(legacyEncounter.id);
    if (artifact?.kind !== 'encounter') {
      throw new Error('legacy encounter vanished or changed kind');
    }
    expect(artifact.data.locationKind).toBe('other');
    expect(artifact.data.preset).toBe('standard');
    expect(artifact.data.mapImageId).toBeNull();
    expect(artifact.data.layout).toBeNull();
    expect(artifact.data.monsters[0]?.treasure).toBe('');
    expect(artifact.moduleId).toBeNull();
    expect(artifact.imageIds).toEqual([]);
    expect(artifact.aliases).toEqual([]);
  });

  it('materializes defaults through the list reads as well', async () => {
    const campaignId = (await createCampaign({ name: 'Legacy list', system: 'dnd5e' })).id;
    await db.artifacts.put({
      id: newId(),
      createdAt: 1,
      updatedAt: 1,
      campaignId,
      kind: 'note',
      name: 'Legacy note',
      tags: [],
      summary: '',
      body: '',
      links: [],
      currentRevision: 1,
      data: {},
    } as unknown as AnyArtifact);
    const [parsed] = await listArtifactsByCampaign(campaignId);
    expect(parsed?.moduleId).toBeNull();
    expect(parsed?.imageIds).toEqual([]);
    expect(parsed?.coverImageId).toBeNull();
    expect(parsed?.aliases).toEqual([]);
  });

  it('materializes revision-envelope and snapshot defaults on listRevisions', async () => {
    const campaignId = (await createCampaign({ name: 'Legacy revs', system: 'dnd5e' })).id;
    const snapshot = {
      id: newId(),
      createdAt: 1,
      updatedAt: 1,
      campaignId,
      kind: 'npc',
      name: 'Old Grimm',
      tags: [],
      summary: '',
      body: '',
      links: [],
      currentRevision: 1,
      data: { appearance: '', personality: '', statBlock: null },
      // NO moduleId/imageIds/coverImageId/aliases (pre-M3/M6 snapshot).
    };
    await db.artifacts.put(snapshot as unknown as AnyArtifact);
    await db.revisions.put({
      id: newId(),
      createdAt: 1,
      updatedAt: 1,
      artifactId: snapshot.id,
      revision: 1,
      snapshot,
      // NO source/runId — added in a later arc.
    } as unknown as ArtifactRevision);

    const [revision] = await listRevisions(snapshot.id);
    expect(revision?.source).toBe('user');
    expect(revision?.runId).toBeNull();
    expect(revision?.snapshot.moduleId).toBeNull();
    if (revision?.snapshot.kind !== 'npc') throw new Error('wrong snapshot kind');
    expect(revision.snapshot.imageIds).toEqual([]);
    expect(revision.snapshot.aliases).toEqual([]);
  });
});

/**
 * Scope-move atomicity (F3): adopt/publish re-anchor their images INSIDE
 * moveScope's transaction (db.images is part of its table list). A crash
 * between the row move and the image re-anchor must be impossible to
 * observe — a library image stranded in a campaign's prune scope is a
 * permanent blob leak (pruneUnreferencedImages deletes it), and the reverse
 * desync hides campaign images from their prune forever.
 */
describe('moveScope owns its image re-anchor (single transaction)', () => {
  beforeEach(clearDatabase);

  const campaignId = '00000000-0000-4000-8000-000000000c01';
  it('rolls the image re-anchor back when the move fails mid-transaction (publish)', async () => {
    const npc = await createArtifact({ campaignId, kind: 'npc', name: 'Atomic Grix' });
    const imageId = newId();
    await db.images.put({
      id: imageId,
      createdAt: 1,
      updatedAt: 1,
      campaignId,
      bytes: new Uint8Array([1]),
      mimeType: 'image/png',
      width: 1,
      height: 1,
      prompt: '',
      model: '',
      source: 'uploaded',
      role: 'artwork',
    });
    await updateArtifact(npc.id, { imageIds: [imageId], coverImageId: imageId });

    // The revision write explodes AFTER the image re-anchor — the whole
    // transaction (image anchor included) must roll back.
    const putSpy = vi.spyOn(db.revisions, 'put').mockRejectedValueOnce(new Error('injected failure'));
    await expect(publishToLibrary(npc.id)).rejects.toThrow('injected failure');
    putSpy.mockRestore();

    // No scope desync: the row stayed campaign-scoped AND the image stayed
    // campaign-anchored.
    expect((await getAnyArtifact(npc.id))?.campaignId).toBe(campaignId);
    expect((await db.images.get(imageId))?.campaignId).toBe(campaignId);

    // After the injection is gone the same call succeeds end to end.
    const published = await publishToLibrary(npc.id);
    expect(published.campaignId).toBeNull();
    expect((await db.images.get(imageId))?.campaignId).toBeNull();
  });

  it('rolls the image re-anchor back when the move fails mid-transaction (adopt)', async () => {
    const globalId = '00000000-0000-4000-8000-00000000c003';
    await db.artifacts.put({
      id: globalId,
      createdAt: 1,
      updatedAt: 1,
      campaignId: null,
      moduleId: null,
      kind: 'npc',
      name: 'Library adoptee',
      tags: [],
      aliases: [],
      summary: '',
      body: '',
      links: [],
      currentRevision: 1,
      imageIds: [],
      coverImageId: null,
      data: { appearance: '', personality: '', statBlock: null },
    });
    const imageId = newId();
    await db.images.put({
      id: imageId,
      createdAt: 1,
      updatedAt: 1,
      campaignId: null,
      bytes: new Uint8Array([2]),
      mimeType: 'image/png',
      width: 1,
      height: 1,
      prompt: '',
      model: '',
      source: 'uploaded',
      role: 'artwork',
    });
    await db.artifacts.update(globalId, { imageIds: [imageId], coverImageId: imageId });

    const putSpy = vi.spyOn(db.revisions, 'put').mockRejectedValueOnce(new Error('injected failure'));
    await expect(adoptIntoCampaign(globalId, campaignId)).rejects.toThrow('injected failure');
    putSpy.mockRestore();

    // The library image was NOT re-anchored into the campaign — the aborted
    // transaction took the image write back with it.
    expect((await db.images.get(imageId))?.campaignId).toBeNull();
    expect((await getAnyArtifact(globalId))?.campaignId).toBeNull();

    const adopted = await adoptIntoCampaign(globalId, campaignId);
    expect(adopted.campaignId).toBe(campaignId);
    expect((await db.images.get(imageId))?.campaignId).toBe(campaignId);
  });
});

/**
 * The image-attach seam (F4): image row + artifact reference (+ cover,
 * re-anchor, prune) happen in ONE rw transaction. The historical call sites
 * (run pick step, mob portrait queue, entity image queue) wrote the image
 * row and the artifact row in unrelated transactions — a crash in between
 * leaked the blob as an unreferenced orphan or left a dangling reference.
 */
describe('attachImagesToArtifact (single-transaction seam)', () => {
  beforeEach(clearDatabase);

  const campaignId = '00000000-0000-4000-8000-000000000c01';

  it('stores and attaches a generated image as cover atomically', async () => {
    const npc = await createArtifact({ campaignId, kind: 'npc', name: 'Portrait target' });
    const next = await attachImagesToArtifact(npc.id, {
      createImages: [
        {
          campaignId,
          blob: new Blob([new Uint8Array([7, 7, 7])]),
          mimeType: 'image/png',
          width: 3,
          height: 3,
          prompt: 'p',
          model: 'm',
          source: 'generated',
          asCover: true,
        },
      ],
    });
    if (next.kind !== 'npc') throw new Error('wrong kind');
    expect(next.imageIds).toHaveLength(1);
    expect(next.coverImageId).toBe(next.imageIds[0]);
    if (next.coverImageId === null) throw new Error('no cover attached');
    // The image row exists and is referenced (a prune cannot touch it).
    const storedImageId = next.coverImageId;
    const stored = await db.images.get(storedImageId);
    expect(stored?.prompt).toBe('p');
    await pruneUnreferencedImages(campaignId);
    expect(await db.images.get(storedImageId)).toBeDefined();
    // The attach is a real revision.
    expect(next.currentRevision).toBe(2);
  });

  it('rolls the image row back when the artifact write fails (no orphan blob)', async () => {
    const npc = await createArtifact({ campaignId, kind: 'npc', name: 'Rollback target' });
    const putSpy = vi.spyOn(db.artifacts, 'put').mockRejectedValueOnce(new Error('injected failure'));
    await expect(
      attachImagesToArtifact(npc.id, {
        createImages: [
          {
            campaignId,
            blob: new Blob([new Uint8Array([1])]),
            mimeType: 'image/png',
            width: 1,
            height: 1,
            prompt: '',
            model: '',
            source: 'generated',
            asCover: true,
          },
        ],
      }),
    ).rejects.toThrow('injected failure');
    putSpy.mockRestore();
    // The injected rejection hit the attach's own artifact write — the
    // created image row rolled back with it. Nothing is left orphaned.
    expect(await db.images.count()).toBe(0);
    const unchanged = await getAnyArtifact(npc.id);
    if (unchanged?.kind !== 'npc') throw new Error('wrong kind');
    expect(unchanged.imageIds).toEqual([]);
    expect(unchanged.coverImageId).toBeNull();
  });

  it('appends kept images and prunes discarded candidates in the same transaction', async () => {
    const npc = await createArtifact({ campaignId, kind: 'npc', name: 'Pick target' });
    const keptId = newId();
    const discardId = newId();
    for (const imageId of [keptId, discardId]) {
      await db.images.put({
        id: imageId,
        createdAt: 1,
        updatedAt: 1,
        campaignId,
        bytes: new Uint8Array([1]),
        mimeType: 'image/png',
        width: 1,
        height: 1,
        prompt: '',
        model: '',
        source: 'generated',
        role: 'artwork',
      });
    }
    const next = await attachImagesToArtifact(npc.id, {
      appendImageIds: [keptId],
      coverImageId: keptId,
      pruneCandidates: { campaignId, candidateIds: [discardId] },
    });
    expect(next.imageIds).toEqual([keptId]);
    expect(next.coverImageId).toBe(keptId);
    expect(await db.images.get(keptId)).toBeDefined();
    expect(await db.images.get(discardId)).toBeUndefined();
  });

  it('re-anchors attached images to the library for a global target (D2/D9)', async () => {
    const globalId = '00000000-0000-4000-8000-00000000c004';
    await db.artifacts.put({
      id: globalId,
      createdAt: 1,
      updatedAt: 1,
      campaignId: null,
      moduleId: null,
      kind: 'npc',
      name: 'Global portrait target',
      tags: [],
      aliases: [],
      summary: '',
      body: '',
      links: [],
      currentRevision: 1,
      imageIds: [],
      coverImageId: null,
      data: { appearance: '', personality: '', statBlock: null },
    });
    const keptId = newId();
    await db.images.put({
      id: keptId,
      createdAt: 1,
      updatedAt: 1,
      campaignId,
      bytes: new Uint8Array([1]),
      mimeType: 'image/png',
      width: 1,
      height: 1,
      prompt: '',
      model: '',
      source: 'generated',
      role: 'artwork',
    });
    await attachImagesToArtifact(globalId, {
      appendImageIds: [keptId],
      anchorImagesTo: null,
      coverImageId: keptId,
    });
    // The kept image followed the global target into the library.
    expect((await db.images.get(keptId))?.campaignId).toBeNull();
  });

  /**
   * The Dexie async-transaction trap (http://bit.ly/2kdckMn): awaiting a
   * NATIVE promise inside a `db.transaction` scope breaks Dexie's PSD zone —
   * the IndexedDB transaction auto-commits at that gap, every later write in
   * the scope lands outside it, and Dexie rejects the scope with
   * "Transaction committed too early". `Blob.prototype.arrayBuffer()` is such
   * a native promise: in a real browser it resolves on a macrotask (a real
   * file read), which is exactly the production failure on the image-creation
   * paths (mob portrait / entity image queues) that store their intake blob
   * through the seam. fake-indexeddb only commits on task boundaries, so the
   * injected setTimeout makes the browser's real gap deterministic here. The
   * byte preparation must run BEFORE the transaction opens — this pin fails
   * if it ever moves back inside.
   */
  it('keeps the blob→bytes preparation out of the attach tx (premature-commit regression)', async () => {
    const npc = await createArtifact({ campaignId, kind: 'npc', name: 'Zone trap target' });
    // Simulate the browser's real async blob read on THIS blob's read path:
    // resolve on a macrotask (a task boundary — what a real file read does).
    const blob = new Blob([new Uint8Array([9, 9, 9])]);
    const realRead = blob.arrayBuffer.bind(blob);
    blob.arrayBuffer = async (): Promise<ArrayBuffer> => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return realRead();
    };
    const next = await attachImagesToArtifact(npc.id, {
      createImages: [
        {
          campaignId,
          blob,
          mimeType: 'image/png',
          width: 3,
          height: 3,
          prompt: 'zone-trap',
          model: 'm',
          source: 'generated',
          asCover: true,
        },
      ],
    });
    // No premature-commit rejection — and the whole attach landed
    // atomically: image row + reference + cover + attach revision.
    if (next.kind !== 'npc') throw new Error('wrong kind');
    expect(next.currentRevision).toBe(2);
    expect(next.coverImageId).toBe(next.imageIds[0]);
    if (next.coverImageId === null) throw new Error('no cover attached');
    const stored = await db.images.get(next.coverImageId);
    expect(stored?.prompt).toBe('zone-trap');
    expect(stored?.source).toBe('generated');
  });

  /** Structural pin (the mobArtifacts tx-wrapper pattern): the attach
   * transaction's scope must never invoke the native-async blob read —
   * byte preparation happens before `db.transaction` opens. */
  it('structurally: the attach tx scope contains no native blob.arrayBuffer await', async () => {
    const npc = await createArtifact({ campaignId, kind: 'npc', name: 'Zone shape target' });
    let insideAttachTx = false;
    let arrayBufferInsideTx = false;
    const originalTransaction = db.transaction.bind(db) as (...args: unknown[]) => unknown;
    const target = db as unknown as { transaction: (...args: unknown[]) => unknown };
    // The probe blob records WHERE its bytes are read from; the read itself
    // stays synchronous-honest (the macrotask gap is the other pin's job).
    const probeBlob = new Blob([new Uint8Array([1, 2, 3])]);
    const realRead = probeBlob.arrayBuffer.bind(probeBlob);
    probeBlob.arrayBuffer = async (): Promise<ArrayBuffer> => {
      if (insideAttachTx) arrayBufferInsideTx = true;
      return realRead();
    };
    target.transaction = (...args: unknown[]) => {
      // Wrap ONLY the attach's own rw tx (the ARRAY form — nested
      // updateArtifact joins variadically and is not the seam's scope).
      if (args[0] === 'rw' && Array.isArray(args[1])) {
        const scopeIndex = args.findIndex((arg) => typeof arg === 'function');
        const scope = args[scopeIndex] as () => Promise<unknown>;
        args[scopeIndex] = async () => {
          insideAttachTx = true;
          try {
            return await scope();
          } finally {
            insideAttachTx = false;
          }
        };
      }
      return originalTransaction(...args);
    };
    await attachImagesToArtifact(npc.id, {
      createImages: [
        {
          campaignId,
          blob: probeBlob,
          mimeType: 'image/png',
          width: 3,
          height: 3,
          source: 'generated',
        },
      ],
    });
    target.transaction = originalTransaction;
    expect(arrayBufferInsideTx).toBe(false);
  });
});
