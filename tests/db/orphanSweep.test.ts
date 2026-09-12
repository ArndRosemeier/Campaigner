import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ArtifactRepo from '@/db/artifactRepo';
import {
  createArtifact,
  getArtifact,
  listArtifactsByCampaign,
  listRevisions,
  publishToLibrary,
} from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { createModule, saveSpine } from '@/db/moduleRepo';
import { AMBIGUITY_KEEP_REASON, sweepOrphanedArtifacts } from '@/db/orphanSweep';
import { clearDatabase } from './helpers';
import {
  battleSchema,
  createModule as createModuleSchema,
  newId,
  stampNewEntity,
  type Battle,
  type BattleBoard,
  type EncounterArtifactData,
  type Id,
  type Module,
  type MonsterEntry,
} from '@/domain';
import { emptyBoard } from '@/domain/battle/board';
import { db } from '@/db/db';

/**
 * Orphan sweep (08-MODULE-DESIGNER §M4-C "Orphaned entities", db surface):
 * ONE rw transaction that re-lists the module's owned rows + every guard
 * carrier INSIDE the tx (recount doctrine, moduleDelete's standard) and
 * deletes exactly the guarded-orphan rows via the frozen `deleteArtifact`.
 * Per-artifact outcomes ride the failed[] convention: deleted N / kept M
 * with reasons — never silent.
 */

let realDeleteArtifact: (id: string) => Promise<void>;

vi.mock('@/db/artifactRepo', async (importOriginal) => {
  const actual = await importOriginal<typeof ArtifactRepo>();
  // Only `deleteArtifact` is replaceable; every other export stays real
  // (the sweep, the guards' fixtures and these tests all use them).
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

/** A module with one premise line (prose is where mentions live). */
async function proseModule(
  campaignId: Id,
  title: string,
  premise: string,
): Promise<Module> {
  const module = await createModule(
    createModuleSchema({
      campaignId,
      title,
      concept: '',
      levelMin: 1,
      levelMax: 3,
      sizeDial: 'sketch',
    }),
  );
  return saveSpine(module.id, {
    premise,
    themes: [],
    writerModel: '',
    partPlan: [
      {
        title: 'The Seal',
        levelBand: '1–2',
        synopsis: 'Reach the seal.',
        levelUpTrigger: 'The seal breaks.',
      },
    ],
  });
}

/** A live battle row carrying the given board/seed fighters (write-normalized). */
async function putBattle(
  campaignId: Id,
  moduleId: Id,
  board: Partial<BattleBoard>,
  seedFighters: Battle['seedFighters'] = [],
): Promise<Battle> {
  const battle = battleSchema.parse({
    ...stampNewEntity(),
    campaignId,
    moduleId,
    encounterArtifactId: null,
    reseed: null,
    board: { ...emptyBoard(), ...board },
    seedFighters,
  });
  await db.battles.put(battle);
  return battle;
}

function tokenFor(artifactId: Id): Battle['board']['tokens'][number] {
  return {
    id: newId(),
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

/** Encounter data with the given roster (the full schema shape, typed). */
function encounterDataWith(monsters: MonsterEntry[]): EncounterArtifactData {
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
  };
}

describe('sweepOrphanedArtifacts — deletion set & outcomes', () => {
  it('deletes exactly the module-owned unmentioned orphans and reports the outcome', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = await proseModule(campaign.id, 'Ember Crypt', 'The crypt of [[Mira]] looms.');
    const mira = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Mira' });
    const wraith = await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'npc',
      name: 'Lonely Wraith',
    });
    const bystander = await createArtifact({
      campaignId: campaign.id,
      kind: 'note',
      name: 'Bystander note',
    });

    const outcome = await sweepOrphanedArtifacts(module.id);

    expect(outcome).toEqual({
      deleted: [{ id: wraith.id, name: 'Lonely Wraith' }],
      kept: [],
    });
    expect(await getArtifact(wraith.id)).toBeUndefined();
    // Its revision history went with it.
    expect(await listRevisions(wraith.id)).toEqual([]);
    // The mentioned row and the campaign-owned row were never touched.
    expect((await getArtifact(mira.id))?.name).toBe('Mira');
    expect((await getArtifact(bystander.id))?.name).toBe('Bystander note');
  });

  it('does not report module-mentioned rows it never offered', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = await proseModule(campaign.id, 'Ember Crypt', '[[Echo]] calls back.');
    await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'npc',
      name: 'Echo',
    });

    const outcome = await sweepOrphanedArtifacts(module.id);

    // Mentioned in the module's own prose → not an orphan, not offered,
    // not reported: the sweep only ever speaks about its offered set.
    expect(outcome).toEqual({ deleted: [], kept: [] });
    expect(await listArtifactsByCampaign(campaign.id)).toHaveLength(1);
  });

  it('keeps a module-zero orphan another module mentions (campaign-wide gate), loudly', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const first = await proseModule(campaign.id, 'Ember Crypt', 'A quiet shore.');
    await proseModule(campaign.id, 'Tide Gate', '[[Echo]] returns at dusk.');
    const echo = await createArtifact({
      campaignId: campaign.id,
      moduleId: first.id,
      kind: 'npc',
      name: 'Echo',
    });

    const outcome = await sweepOrphanedArtifacts(first.id);

    // The panel tagged it module-zero, but the campaign-wide gate keeps it —
    // and the kept row names the mention site (never a silent drop).
    expect(outcome.deleted).toEqual([]);
    expect(outcome.kept).toHaveLength(1);
    expect(outcome.kept[0]?.name).toBe('Echo');
    expect(outcome.kept[0]?.reason).toContain('mentioned in campaign prose');
    expect(outcome.kept[0]?.reason).toContain('Tide Gate');
    expect((await getArtifact(echo.id))?.name).toBe('Echo');
  });

  it('excludes pc, promoted and library rows from the candidate set', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = await proseModule(campaign.id, 'Ember Crypt', 'A quiet shore.');
    await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'pc',
      name: 'Serren',
    });
    const wanderer = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Wanderer' });
    // A promoted (campaign-owned) and a library row are never candidates —
    // publishToLibrary is the sanctioned path to a global row.
    const unowned = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Unowned' });
    await publishToLibrary(unowned.id);

    const outcome = await sweepOrphanedArtifacts(module.id);
    expect(outcome).toEqual({ deleted: [], kept: [] });
    expect((await getArtifact(wanderer.id))?.name).toBe('Wanderer');
    expect((await listArtifactsByCampaign(campaign.id)).map((row) => row.name).sort()).toEqual([
      'Serren',
      'Wanderer',
    ]);
  });
});

describe('sweepOrphanedArtifacts — hard guards (each pinned)', () => {
  it('keeps an artifact tokened on ANY campaign battle board (other module counts)', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const first = await proseModule(campaign.id, 'Ember Crypt', 'A quiet shore.');
    const second = await proseModule(campaign.id, 'Tide Gate', 'The fight begins.');
    const wraith = await createArtifact({
      campaignId: campaign.id,
      moduleId: first.id,
      kind: 'npc',
      name: 'Lonely Wraith',
    });
    await putBattle(campaign.id, second.id, { tokens: [tokenFor(wraith.id)] });

    const outcome = await sweepOrphanedArtifacts(first.id);

    expect(outcome.deleted).toEqual([]);
    expect(outcome.kept[0]?.name).toBe('Lonely Wraith');
    expect(outcome.kept[0]?.reason).toBe('a portrait token on the battle of "Tide Gate"');
    expect((await getArtifact(wraith.id))?.name).toBe('Lonely Wraith');
  });

  it('keeps a mob artifact frozen as a battle seed fighter', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = await proseModule(campaign.id, 'Ember Crypt', 'A quiet shore.');
    const goblin = await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'npc',
      name: 'Goblin Chief',
    });
    await putBattle(campaign.id, module.id, {}, [
      { id: goblin.id, name: 'Goblin Chief', maxHp: 7, initiativeBonus: 1 },
    ]);

    const outcome = await sweepOrphanedArtifacts(module.id);

    expect(outcome.deleted).toEqual([]);
    expect(outcome.kept[0]?.reason).toBe('a frozen seed fighter on the battle of "Ember Crypt"');
  });

  it('keeps an npc cited by a SAME-module surviving encounter roster (npc-ref)', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    // The module's prose mentions the ENCOUNTER, so the encounter survives
    // and its roster citations still guard (the module survives the sweep —
    // deleteModule's cascade exclusion does not apply here).
    const module = await proseModule(campaign.id, 'Ember Crypt', 'Fight the [[Ambush]].');
    const guard = await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'npc',
      name: 'Gate Guard',
    });
    await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'encounter',
      name: 'Ambush',
      data: encounterDataWith([
        {
          name: 'Gate Guard',
          count: 1,
          notes: '',
          treasure: '',
          source: { type: 'npc-ref', artifactId: guard.id },
        },
      ]),
    });

    const outcome = await sweepOrphanedArtifacts(module.id);

    expect(outcome.deleted).toEqual([]);
    expect(outcome.kept[0]?.name).toBe('Gate Guard');
    expect(outcome.kept[0]?.reason).toBe(
      'roster entry "Gate Guard" of the encounter "Ambush"',
    );
  });

  it('a bestiary citation does NOT make a same-named npc row survive the sweep', async () => {
    // REWRITTEN (ledger row 106): the roster reference is the CITATION, so a
    // rulebook entry keeps nothing alive. The old model stamped a
    // `mobArtifactId` on the citation and this sweep had to honor it — the
    // same coupling that left two encounters stuck on a permanent
    // `missing ref` when the artifact was deleted. A same-named authored npc
    // is now an ordinary orphan.
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = await proseModule(campaign.id, 'Ember Crypt', 'Fight the [[Ambush]].');
    const mob = await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'npc',
      name: 'Goblin',
    });
    await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'encounter',
      name: 'Ambush',
      data: encounterDataWith([
        {
          name: 'Goblin',
          count: 2,
          notes: '',
          treasure: '',
          source: { type: 'rulebook', chunkId: newId() },
        },
      ]),
    });

    const outcome = await sweepOrphanedArtifacts(module.id);

    expect(outcome.deleted.map((row) => row.id)).toEqual([mob.id]);
  });

  it('deletes an orphan cited only by an encounter the sweep also deletes', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = await proseModule(campaign.id, 'Ember Crypt', 'A quiet shore.');
    const guard = await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'npc',
      name: 'Gate Guard',
    });
    const encounter = await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'encounter',
      name: 'Doomed Fight',
      data: encounterDataWith([
        {
          name: 'Gate Guard',
          count: 1,
          notes: '',
          treasure: '',
          source: { type: 'npc-ref', artifactId: guard.id },
        },
      ]),
    });

    const outcome = await sweepOrphanedArtifacts(module.id);

    // The doomed encounter takes its citations with it — survivor semantics.
    expect(outcome.deleted.map((row) => row.name).sort()).toEqual([
      'Doomed Fight',
      'Gate Guard',
    ]);
    expect(await getArtifact(encounter.id)).toBeUndefined();
    expect(await getArtifact(guard.id)).toBeUndefined();
  });

  it('excludes ambiguity-shadowed rows from delete-all and refuses them loudly when attempted', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = await proseModule(campaign.id, 'Ember Crypt', 'A quiet shore.');
    const first = await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'npc',
      name: 'Goblin',
    });
    const second = await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'npc',
      name: 'Goblin',
    });

    const offered = await sweepOrphanedArtifacts(module.id);
    expect(offered).toEqual({ deleted: [], kept: [] });
    expect((await getArtifact(first.id))?.name).toBe('Goblin');
    expect((await getArtifact(second.id))?.name).toBe('Goblin');

    const attempted = await sweepOrphanedArtifacts(module.id, { onlyId: first.id });
    expect(attempted.deleted).toEqual([]);
    expect(attempted.kept[0]?.reason).toBe(AMBIGUITY_KEEP_REASON);
  });
});

describe('sweepOrphanedArtifacts — boundaries & atomicity', () => {
  it('fails loudly on a vanished module, a foreign id, and a non-orphan kind', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = await proseModule(campaign.id, 'Ember Crypt', 'A quiet shore.');
    const other = await proseModule(campaign.id, 'Tide Gate', 'Also quiet.');
    const foreign = await createArtifact({
      campaignId: campaign.id,
      moduleId: other.id,
      kind: 'npc',
      name: 'Not Mine',
    });
    const pc = await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'pc',
      name: 'Serren',
    });

    await expect(sweepOrphanedArtifacts(newId())).rejects.toThrow(/Module/);
    await expect(sweepOrphanedArtifacts(module.id, { onlyId: newId() })).rejects.toThrow(
      /Artifact/,
    );
    await expect(
      sweepOrphanedArtifacts(module.id, { onlyId: foreign.id }),
    ).rejects.toThrow(/Not Mine/);
    await expect(sweepOrphanedArtifacts(module.id, { onlyId: pc.id })).rejects.toThrow(
      /Serren/,
    );
  });

  it('a mid-sweep failure rolls the whole sweep back (no half-applied delete)', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = await proseModule(campaign.id, 'Ember Crypt', 'A quiet shore.');
    // Alphabetical delete order is deterministic: 'Aaa' first, then 'Bbb'.
    const first = await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'npc',
      name: 'Aaa Wraith',
    });
    const second = await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'npc',
      name: 'Bbb Wraith',
    });

    deleteArtifactMock.mockImplementation(async (id) => {
      if (id === second.id) throw new Error('simulated sweep failure');
      await realDeleteArtifact(id);
    });

    await expect(sweepOrphanedArtifacts(module.id)).rejects.toThrow(
      /simulated sweep failure/,
    );

    // Everything rolled back: both rows AND their revisions.
    expect(await getArtifact(first.id)).toBeDefined();
    expect(await getArtifact(second.id)).toBeDefined();
    expect((await listRevisions(first.id)).length).toBeGreaterThan(0);
    expect((await listRevisions(second.id)).length).toBeGreaterThan(0);
  });
});
