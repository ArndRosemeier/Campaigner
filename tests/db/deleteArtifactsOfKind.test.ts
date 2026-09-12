import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as BattleRepo from '@/db/battleRepo';
import {
  attachImagesToArtifact,
  createArtifact,
  deleteArtifactsOfKind,
  describeArtifactKindRemoval,
  getArtifact,
  listRevisions,
  publishToLibrary,
  updateArtifact,
} from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { createModule } from '@/db/moduleRepo';
import { db } from '@/db/db';
import {
  battleSchema,
  createModule as buildModule,
  stampNewEntity,
  type Battle,
  type BattleBoard,
  type EncounterArtifactData,
  type Id,
  type MonsterEntry,
} from '@/domain';
import { emptyBoard } from '@/domain/battle/board';
import { clearDatabase, expectNotFound, seedModuleVersion } from './helpers';

/**
 * Per-region bulk delete (the campaign tree's "remove all" beside a kind's
 * `+`): `deleteArtifactsOfKind` removes every CAMPAIGN-LEVEL artifact of one
 * kind in ONE campaign — one rw transaction over the tables `deleteArtifact`
 * needs, rows re-listed inside it — and nothing else. The guards pinned here:
 * campaign scope only, the global library untouchable, `pc` refused outright,
 * module-owned rows (and module documents/versions) out of reach, other kinds
 * byte-identical, in-tx recount honesty, and a mid-cascade failure rolling
 * the whole pass back.
 */

let realScrub: (campaignId: Id, artifactId: Id) => Promise<void>;

vi.mock('@/db/battleRepo', async (importOriginal) => {
  const actual = await importOriginal<typeof BattleRepo>();
  // Only the battle scrub is replaceable; every other export stays real
  // (parseBattleRow is used by the code under test, ensureBattle would be
  // used by the fixtures). The seam calls the scrub INTERNALLY, so a module
  // mock of `deleteArtifact` could not intercept the cascade — this is the
  // observable collaborator that sits inside it.
  return { ...actual, scrubArtifactFromBattles: vi.fn() };
});

const { scrubArtifactFromBattles } = await import('@/db/battleRepo');
const scrubMock = vi.mocked(scrubArtifactFromBattles);

beforeEach(async () => {
  const actual = await vi.importActual<typeof BattleRepo>('@/db/battleRepo');
  realScrub = actual.scrubArtifactFromBattles;
  await clearDatabase();
  scrubMock.mockImplementation(realScrub);
});

async function makeModule(campaignId: Id, title: string): Promise<Id> {
  const module = await createModule(
    buildModule({
      campaignId,
      title,
      concept: '',
      levelMin: 1,
      levelMax: 3,
      sizeDial: 'sketch',
    }),
  );
  return module.id;
}

/** Encounter data with the given roster (the full schema shape, typed). */
function encounterDataWith(
  monsters: MonsterEntry[],
  over: Partial<EncounterArtifactData> = {},
): EncounterArtifactData {
  return {
    difficulty: '',
    levelHint: '',
    monsters,
    terrain: '',
    tactics: '',
    treasure: '',
    mapImageId: null,
    layout: null,
    preset: 'standard',
    locationKind: 'other',
    siteShape: 'single',
    budgetAdvisory: '',
    ...over,
  };
}

/** A battle row carrying the given board (write-normalized). */
async function putBattle(
  campaignId: Id,
  moduleId: Id,
  board: Partial<BattleBoard>,
  encounterArtifactId: Id | null = null,
): Promise<Battle> {
  const battle = battleSchema.parse({
    ...stampNewEntity(),
    campaignId,
    moduleId,
    encounterArtifactId,
    reseed: null,
    board: { ...emptyBoard(), ...board },
    seedFighters: [],
  });
  await db.battles.put(battle);
  return battle;
}

function tokenFor(artifactId: Id): Battle['board']['tokens'][number] {
  return {
    id: stampNewEntity().id,
    artifactId,
    label: 'Fighter',
    x: 0.5,
    y: 0.5,
    visible: true,
    scale: 1,
    shape: 'portrait',
    color: null,
    currentHp: 10,
    initiativeRoll: null,
    initiativeBonus: 2,
    treasure: '',
    conditions: [],
  };
}

async function attachOneImage(artifactId: Id, campaignId: Id): Promise<Id> {
  const updated = await attachImagesToArtifact(artifactId, {
    createImages: [
      {
        campaignId,
        blob: new Blob([`bytes-for-${artifactId}`], { type: 'image/png' }),
        mimeType: 'image/png',
        width: 8,
        height: 8,
        source: 'uploaded',
      },
    ],
  });
  const imageId = updated.imageIds[0];
  if (imageId === undefined) throw new Error('attach did not record the image');
  return imageId;
}

/** Row snapshots for the byte-identical guards. */
async function rows(ids: readonly Id[]): Promise<unknown[]> {
  return db.artifacts.bulkGet([...ids]);
}

describe('deleteArtifactsOfKind — scope guards', () => {
  it('sweeps one campaign kind and leaves every other kind, the Party and another campaign byte-identical', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const other = await createCampaign({ name: 'Neighbour', system: 'dnd5e' });
    const moduleId = await makeModule(campaign.id, 'Ember Vault');
    const npc = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Goblin' });
    const secondNpc = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Hobgoblin' });
    const pc = await createArtifact({ campaignId: campaign.id, kind: 'pc', name: 'Serren' });
    const location = await createArtifact({
      campaignId: campaign.id,
      kind: 'location',
      name: 'Old Tower',
    });
    const encounter = await createArtifact({
      campaignId: campaign.id,
      kind: 'encounter',
      name: 'Gate fight',
    });
    const moduleNpc = await createArtifact({
      campaignId: campaign.id,
      moduleId,
      kind: 'npc',
      name: 'Module guard',
    });
    const neighbourNpc = await createArtifact({ campaignId: other.id, kind: 'npc', name: 'Their NPC' });
    const survivors = [pc.id, location.id, encounter.id, moduleNpc.id, neighbourNpc.id];
    const before = await rows(survivors);
    const neighbourRevisions = await listRevisions(neighbourNpc.id);
    const moduleRevisions = await listRevisions(moduleNpc.id);
    // Durable module undo history is module-side content: out of reach.
    await seedModuleVersion(moduleId, 'Chat: module history');

    const removed = await deleteArtifactsOfKind(campaign.id, 'npc');

    expect(removed.kind).toBe('npc');
    expect(removed.artifacts).toBe(2);
    expect(await getArtifact(npc.id)).toBeUndefined();
    expect(await getArtifact(secondNpc.id)).toBeUndefined();
    // Every survivor is byte-identical — including the MODULE-OWNED npc of
    // the very kind being removed (module rows are out of reach).
    expect(await rows(survivors)).toEqual(before);
    expect((await listRevisions(moduleNpc.id)).map((row) => row.revision)).toEqual(
      moduleRevisions.map((row) => row.revision),
    );
    expect((await listRevisions(neighbourNpc.id)).map((row) => row.revision)).toEqual(
      neighbourRevisions.map((row) => row.revision),
    );
    // The module row, its prose and its durable versions are untouched.
    expect(await db.modules.get(moduleId)).toBeDefined();
    expect(await db.moduleVersions.count()).toBe(1);
  });

  it('never reaches another campaign: the neighbour keeps its rows and revisions', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const other = await createCampaign({ name: 'Neighbour', system: 'dnd5e' });
    await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Doomed' });
    const kept = await createArtifact({ campaignId: other.id, kind: 'npc', name: 'Kept' });
    await updateArtifact(kept.id, { body: 'second revision' });
    const before = await rows([kept.id]);

    await deleteArtifactsOfKind(campaign.id, 'npc');

    expect(await rows([kept.id])).toEqual(before);
    expect(await listRevisions(kept.id)).toHaveLength(2);
  });

  it('never touches a global library row of the SAME kind (nor its image)', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Doomed' });
    // A library NPC is structurally a `campaignId === null` row of the same
    // kind: the sweep must not see it, and the campaign image prune must not
    // reach the blob that travelled with it (D2).
    const libraryNpc = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Lib Goblin' });
    const libraryImage = await attachOneImage(libraryNpc.id, campaign.id);
    const published = await publishToLibrary(libraryNpc.id);
    const before = await rows([published.id]);
    const revisionsBefore = await listRevisions(published.id);

    const removed = await deleteArtifactsOfKind(campaign.id, 'npc');

    expect(removed.artifacts).toBe(1);
    expect(removed.imagesPruned).toBe(0);
    expect(published.campaignId).toBeNull();
    expect(await rows([published.id])).toEqual(before);
    expect(await db.images.get(libraryImage)).toBeDefined();
    expect((await listRevisions(published.id)).map((row) => row.revision)).toEqual(
      revisionsBefore.map((row) => row.revision),
    );
  });

  it('refuses the Party outright (seam and census) and never deletes a PC', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const pc = await createArtifact({ campaignId: campaign.id, kind: 'pc', name: 'Serren' });

    await expect(deleteArtifactsOfKind(campaign.id, 'pc')).rejects.toThrow(/Clear workspace/);
    await expect(describeArtifactKindRemoval(campaign.id, 'pc')).rejects.toThrow(/Clear workspace/);
    expect(await getArtifact(pc.id)).toBeDefined();
  });

  it('is idempotent: an empty kind is honest zeros, and an unknown campaign is loud', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    await createArtifact({ campaignId: campaign.id, kind: 'location', name: 'Old Tower' });

    const census = await describeArtifactKindRemoval(campaign.id, 'npc');
    expect(census).toEqual({
      kind: 'npc',
      artifacts: 0,
      revisions: 0,
      backLinkedArtifacts: 0,
      battleTokensScrubbed: 0,
      battlesDeleted: 0,
      battleProvenancesLost: 0,
      imagesPruned: 0,
      rosterRefsDangling: 0,
    });

    const first = await deleteArtifactsOfKind(campaign.id, 'npc');
    expect(first.artifacts).toBe(0);
    const second = await deleteArtifactsOfKind(campaign.id, 'npc');
    expect(second.artifacts).toBe(0);
    expect(await db.artifacts.where('campaignId').equals(campaign.id).count()).toBe(1);

    await expectNotFound(deleteArtifactsOfKind('11111111-1111-4111-8111-111111111111', 'npc'));
  });
});

describe('deleteArtifactsOfKind — the cascade it reports', () => {
  it('counts revisions, scrubbed back-links, battle tokens, freed images and dangling roster refs', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const moduleId = await makeModule(campaign.id, 'Ember Vault');
    // One board per module (the v16 unique `&moduleId` index).
    const secondModuleId = await makeModule(campaign.id, 'Second Vault');
    const pc = await createArtifact({ campaignId: campaign.id, kind: 'pc', name: 'Serren' });
    const goblin = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Goblin' });
    await updateArtifact(goblin.id, { body: 'changed' }); // revision 2
    const hobgoblin = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Hobgoblin' });
    const goblinImage = await attachOneImage(goblin.id, campaign.id);
    const location = await createArtifact({
      campaignId: campaign.id,
      kind: 'location',
      name: 'Old Tower',
      links: [{ targetId: goblin.id, relation: 'ally' }],
    });
    const locationImage = await attachOneImage(location.id, campaign.id);
    // A surviving encounter citing a doomed NPC (`npc-ref`, which WILL dangle)
    // beside a LIBRARY creature citation whose chunk is stamped for this test.
    // REWRITTEN (ledger row 106): the second entry used to be a `rulebook`
    // citation that also reached a doomed mob artifact, so it dangled too. A
    // citation names the bestiary, not a row, so deleting rows cannot dangle it
    // — the census must report ONE dangling roster ref, and the citation must
    // survive byte-identically (pinned below).
    const encounter = await createArtifact({
      campaignId: campaign.id,
      kind: 'encounter',
      name: 'Gate fight',
      data: encounterDataWith([
        { name: 'Goblin', count: 2, notes: '', treasure: '', source: { type: 'npc-ref', artifactId: goblin.id } },
        {
          name: 'Hobgoblin',
          count: 1,
          notes: '',
          treasure: '',
          source: { type: 'rulebook', chunkId: stampNewEntity().id },
        },
      ]),
    });
    const encounterBefore = await rows([encounter.id]);
    // One board holding ONLY a doomed token (empties out and deletes itself)
    // and one holding a PC beside a doomed token (survives, scrubbed).
    const doomedBattle = await putBattle(campaign.id, moduleId, {
      tokens: [tokenFor(goblin.id)],
    });
    const mixedBattle = await putBattle(campaign.id, secondModuleId, {
      tokens: [tokenFor(pc.id), tokenFor(hobgoblin.id)],
    });

    const census = await describeArtifactKindRemoval(campaign.id, 'npc');
    expect(census.artifacts).toBe(2);
    expect(census.revisions).toBe(4); // 3 for Goblin (content edit + image attach), 1 for Hobgoblin
    expect(census.backLinkedArtifacts).toBe(1);
    expect(census.battleTokensScrubbed).toBe(2);
    expect(census.battlesDeleted).toBe(1);
    // ONE: only the `npc-ref` names a row. A `rulebook` citation is a library
    // reference and is untouched by any artifact delete.
    expect(census.rosterRefsDangling).toBe(1);
    expect(census.imagesPruned).toBe(1); // Goblin's gallery blob only

    const removed = await deleteArtifactsOfKind(campaign.id, 'npc');

    // The live census and the executed pass agree here (nothing landed in
    // between) — and the toast's numbers come from the in-tx pass.
    expect(removed).toEqual(census);
    expect(await getArtifact(goblin.id)).toBeUndefined();
    expect(await getArtifact(hobgoblin.id)).toBeUndefined();
    for (const id of [goblin.id, hobgoblin.id]) {
      expect(await db.revisions.where('artifactId').equals(id).count()).toBe(0);
    }
    // The survivor's back-link was scrubbed, the survivor itself kept.
    expect((await getArtifact(location.id))?.links).toEqual([]);
    // The encounter is byte-identical: its roster dangles into the loud
    // `missing ref` badge instead of being silently rewritten, and the library
    // citation beside it was never a candidate in the first place.
    expect(await rows([encounter.id])).toEqual(encounterBefore);
    // Boards: the doomed-token board deleted itself, the mixed one survives
    // with only the PC token.
    expect(await db.battles.get(doomedBattle.id)).toBeUndefined();
    const mixed = await db.battles.get(mixedBattle.id);
    expect(mixed?.board.tokens.map((token) => token.artifactId)).toEqual([pc.id]);
    // Images: only the blob nothing else referenced was freed.
    expect(await db.images.get(goblinImage)).toBeUndefined();
    expect(await db.images.get(locationImage)).toBeDefined();
    expect(await getArtifact(pc.id)).toBeDefined();
  });

  it('reports boards left without their seeding encounter (encounter sweeps keep the board)', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const moduleId = await makeModule(campaign.id, 'Ember Vault');
    const pc = await createArtifact({ campaignId: campaign.id, kind: 'pc', name: 'Serren' });
    const encounter = await createArtifact({
      campaignId: campaign.id,
      kind: 'encounter',
      name: 'Gate fight',
      data: encounterDataWith([]),
    });
    const battle = await putBattle(
      campaign.id,
      moduleId,
      { tokens: [tokenFor(pc.id)] },
      encounter.id,
    );

    const removed = await deleteArtifactsOfKind(campaign.id, 'encounter');

    expect(removed.artifacts).toBe(1);
    expect(removed.battleProvenancesLost).toBe(1);
    expect(removed.battleTokensScrubbed).toBe(0);
    expect(removed.battlesDeleted).toBe(0);
    // The board is live play state: it stays, with a dangling provenance the
    // battle surface names in as many words.
    const survivor = await db.battles.get(battle.id);
    expect(survivor?.encounterArtifactId).toBe(encounter.id);
  });
});

describe('deleteArtifactsOfKind — count honesty and failure discipline', () => {
  it('re-lists inside the transaction: a row created after the census is swept and counted', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Early' });
    const census = await describeArtifactKindRemoval(campaign.id, 'npc');
    expect(census.artifacts).toBe(1);

    // Lands after the dialog counted — the execute path re-lists in its own
    // transaction, so it goes with the same pass and the toast counts it.
    await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Late' });

    const removed = await deleteArtifactsOfKind(campaign.id, 'npc');

    expect(removed.artifacts).toBe(2);
    // The stale census still says 1 — proving the counts came from the
    // execution-time recount, never from the dialog snapshot.
    expect(census.artifacts).toBe(1);
    expect(await db.artifacts.where('campaignId').equals(campaign.id).count()).toBe(0);
  });

  it('a mid-cascade failure rolls every row AND its revisions back', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const moduleId = await makeModule(campaign.id, 'Ember Vault');
    // Alphabetical disposal order is deterministic: 'Aaa' first, then 'Bbb'.
    const first = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Aaa' });
    const second = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Bbb' });
    await updateArtifact(first.id, { body: 'changed' });
    const battle = await putBattle(campaign.id, moduleId, { tokens: [tokenFor(first.id)] });
    const before = await rows([first.id, second.id]);

    // The SECOND cascade step explodes — the first artifact (row, revisions,
    // battle scrub, image prune) really deleted inside the open transaction.
    scrubMock.mockImplementation(async (campaignId, artifactId) => {
      if (artifactId === second.id) throw new Error('simulated cascade failure');
      await realScrub(campaignId, artifactId);
    });

    await expect(deleteArtifactsOfKind(campaign.id, 'npc')).rejects.toThrow(
      /simulated cascade failure/,
    );

    expect(await rows([first.id, second.id])).toEqual(before);
    expect(await listRevisions(first.id)).toHaveLength(2);
    expect(await listRevisions(second.id)).toHaveLength(1);
    expect(await db.battles.get(battle.id)).toBeDefined();
  });
});
