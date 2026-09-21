import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  battleSchema,
  campaignSchema,
  encounterDataSchema,
  globalArtifactSchema,
  newId,
  stampNewEntity,
  storedImageSchema,
  type GlobalArtifact,
  type Artifact,
  type Battle,
  type Id,
  type MonsterEntry,
} from '@/domain';
import { defaultSettings } from '@/domain/settings';
import { tokenFromFighter, captureStageSnapshot } from '@/domain/battle/board';
import { adoptLibraryArtifacts } from '@/db/libraryAdopt';
import { adoptDraftLibraryReferences } from '@/db/libraryAdoptLive';
import { buildFighterStatsLookup } from '@/db/fighterStats';
import { seedBattleFromEncounter } from '@/db/battleSeed';
import { getBattleByEncounter, getBattleForEncounter, saveBattleStage } from '@/db/battleRepo';
import {
  adoptedCopyIdOf,
  createArtifact,
  duplicateArtifact,
  getArtifact,
  getAnyArtifact,
  listArtifactsByCampaign,
  listGlobalArtifacts,
  updateArtifact,
} from '@/db/artifactRepo';
import { resolveMonsterEntryWithRepos } from '@/db/monsterResolve';
import { resolveWikiLink } from '@/lib/wikilinks';
import { db } from '@/db/db';
import { clearDatabase } from './helpers';

/**
 * docs/17 row 257 — ADOPT A GLOBAL LIBRARY ARTIFACT INTO A CAMPAIGN AS A REAL
 * COPY, with the LIBRARY ROW SURVIVING (the owner's answer: the library is
 * shared, so nothing may be moved out of it).
 *
 * The declared holder shapes are a roster `npc-ref` target and an artifact
 * `links[].targetId`, both repointed through ONE artifact-row rewrite. The pins
 * below are the brief's own: a second adoption is ONE copy keyed on the STORED
 * origin id; each declared holder shape points at the copy afterwards; images
 * are CLONED with their role (never shared, never re-anchored); prose `[[Name]]`
 * resolves to the copy with no rewrite; a library row that is GONE keeps its
 * loud missing arm and is never replaced by a placeholder.
 */

const CAMPAIGN = '00000000-0000-4000-8000-000000000c57';
const OTHER_CAMPAIGN = '00000000-0000-4000-8000-000000000d57';
const IMAGE = '00000000-0000-4000-8000-000000000157';

const STAT_BLOCK = {
  system: 'dnd5e' as const,
  level: '5',
  size: 'Medium',
  creatureType: 'humanoid',
  ac: 15,
  acNote: '',
  hp: 44,
  hpFormula: '8d8+8',
  speed: '30 ft.',
  abilities: { str: 12, dex: 14, con: 12, int: 16, wis: 13, cha: 11 },
  saves: '',
  skills: '',
  senses: '',
  languages: '',
  traits: [],
  actions: [],
  reactions: [],
  legendary: [],
  extras: {},
};

/** A GLOBAL library NPC (the row the campaign references). */
function globalNpc(name = 'Sage of the Vale'): GlobalArtifact {
  return globalArtifactSchema.parse({
    ...stampNewEntity(),
    campaignId: null,
    moduleId: null,
    kind: 'npc',
    name,
    tags: [],
    aliases: [],
    summary: 'A keeper of the vale.',
    body: 'The [[Sage of the Vale]] waits by the ford.',
    links: [],
    currentRevision: 1,
    imageIds: [],
    coverImageId: null,
    writerModel: '',
    data: { appearance: '', personality: '', statBlock: STAT_BLOCK },
  });
}

/** A GLOBAL library ENCOUNTER — the row a battle seeded from a library card is
 * KEYED by before the row-268 re-key. */
function globalEncounter(name = 'Ford ambush'): GlobalArtifact {
  return globalArtifactSchema.parse({
    ...stampNewEntity(),
    campaignId: null,
    moduleId: null,
    kind: 'encounter',
    name,
    tags: [],
    aliases: [],
    summary: '',
    body: '',
    links: [],
    currentRevision: 1,
    imageIds: [],
    coverImageId: null,
    writerModel: '',
    data: encounterData([
      { name: 'Stamp', count: 1, notes: '', treasure: '', source: { type: 'none' as const } },
    ]),
  });
}

/** A GLOBAL library location whose cover is a MAP-role blob. */
function globalLocation(): GlobalArtifact {
  return globalArtifactSchema.parse({
    ...stampNewEntity(),
    campaignId: null,
    moduleId: null,
    kind: 'location',
    name: 'The Sunken Ford',
    tags: [],
    aliases: [],
    summary: '',
    body: '',
    links: [],
    currentRevision: 1,
    imageIds: [IMAGE],
    coverImageId: IMAGE,
    writerModel: '',
    data: { locationType: 'region', inhabitants: '', pointsOfInterest: [], hooks: [] },
  });
}

function encounterData(monsters: unknown[]) {
  return encounterDataSchema.parse({
    difficulty: 'medium',
    levelHint: '', partyLevel: 5,
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
  });
}

/** One roster entry citing an NPC artifact, with an explicit instance count
 * (a NAMED constructor identical to another test file's would red the row-212
 * duplication tripwire, so this one is parametrized on the count it needs). */
function npcRefEntry(name: string, artifactId: Id, count = 1): MonsterEntry {
  return {
    name,
    count,
    notes: '',
    treasure: '',
    source: { type: 'npc-ref', artifactId },
  };
}

/** The FIRST roster entry of an encounter row, or a loud failure. */
function firstRosterEntry(row: Artifact): MonsterEntry {
  if (row.kind !== 'encounter') throw new Error('the row is not an encounter');
  const entry = row.data.monsters[0];
  if (entry === undefined) throw new Error('the encounter carries no roster entry');
  return entry;
}

/** Run the seam exactly as the live write path does. */
function adopt() {
  return db.transaction(
    'rw',
    [db.artifacts, db.revisions, db.images, db.campaigns, db.settings, db.battles],
    (tx) => adoptLibraryArtifacts({ tx, reason: 'write' }),
  );
}

async function seedCampaign(id: Id, name: string): Promise<void> {
  await db.campaigns.put(
    campaignSchema.parse({ ...stampNewEntity(), id, name, description: '', system: 'dnd5e' }),
  );
}

/** One library image row (fixed id, so a global artifact can name it). */
async function seedLibraryImage(): Promise<void> {
  await db.images.put(
    storedImageSchema.parse({
      ...stampNewEntity(),
      id: IMAGE,
      campaignId: null,
      bytes: new Uint8Array([1, 2, 3, 4]),
      mimeType: 'image/webp',
      width: 12,
      height: 9,
      prompt: '',
      model: '',
      source: 'generated',
      role: 'map',
    }),
  );
}

beforeEach(async () => {
  await clearDatabase();
  await db.settings.put(defaultSettings());
});

describe('library adoption (docs/17 row 257)', () => {
  it('copies the referenced library row into the campaign and repoints BOTH declared holder shapes', async () => {
    const source = globalNpc();
    await db.artifacts.put(source);
    const encounter = await createArtifact({
      campaignId: CAMPAIGN,
      kind: 'encounter',
      name: 'Ambush at the Ford',
      data: encounterData([npcRefEntry('Sage', source.id)]),
    });
    const relation = await createArtifact({
      campaignId: CAMPAIGN,
      kind: 'npc',
      name: 'The Vale',
      links: [{ targetId: source.id, relation: 'guarded by' }],
    });

    const report = await adopt();

    expect(report.adopted).toHaveLength(1);
    const adopted = report.adopted[0];
    expect(adopted?.globalId).toBe(source.id);
    expect(report.repointed).toBe(2);
    expect(report.unresolved).toEqual([]);

    // THE LIBRARY ROW SURVIVES, byte-identical.
    expect(await db.artifacts.get(source.id)).toEqual(source);

    // The copy is campaign-scoped, freshly identified, and says where it came from.
    const copy = await getAnyArtifact(adopted?.copyId ?? '');
    if (copy === undefined) throw new Error('copy missing');
    if (copy.campaignId === null) throw new Error('copy is not campaign-scoped');
    expect(copy.id).not.toBe(source.id);
    expect(copy.campaignId).toBe(CAMPAIGN);
    expect(copy.moduleId).toBeNull();
    expect(copy.name).toBe('Sage of the Vale');
    expect(copy.copiedFromArtifactId).toBe(source.id);
    expect(copy.currentRevision).toBe(1);
    expect(copy.body).toBe(source.body);
    expect(await db.revisions.where('artifactId').equals(copy.id).count()).toBe(1);

    // BOTH holder shapes point at the copy now.
    const repointedEncounter = await getArtifact(encounter.id);
    if (repointedEncounter?.kind !== 'encounter') throw new Error('encounter missing');
    expect(repointedEncounter.data.monsters[0]?.source).toEqual({
      type: 'npc-ref',
      artifactId: copy.id,
    });
    const repointedRelation = await getArtifact(relation.id);
    expect(repointedRelation?.links[0]?.targetId).toBe(copy.id);
    // …and the repoint is a real revision, not a raw put.
    expect(repointedEncounter.currentRevision).toBe(2);
    expect(repointedRelation?.currentRevision).toBe(2);
  });

  it('is IDEMPOTENT on the stored origin id: a second run makes no copy and rewrites nothing', async () => {
    const source = globalNpc();
    await db.artifacts.put(source);
    await createArtifact({
      campaignId: CAMPAIGN,
      kind: 'encounter',
      name: 'Ambush at the Ford',
      data: encounterData([npcRefEntry('Sage', source.id)]),
    });

    const first = await adopt();
    expect(first.adopted).toHaveLength(1);
    const copiesAfterFirst = (await db.artifacts.toArray()).filter(
      (row) => row.copiedFromArtifactId === source.id,
    );
    expect(copiesAfterFirst).toHaveLength(1);

    const second = await adopt();
    expect(second.adopted).toEqual([]);
    expect(second.repointed).toBe(0);
    const copiesAfterSecond = (await db.artifacts.toArray()).filter(
      (row) => row.copiedFromArtifactId === source.id,
    );
    expect(copiesAfterSecond).toHaveLength(1);
  });

  it('CLONES the images with their role, and leaves the library blobs in the library', async () => {
    await seedLibraryImage();
    const source = globalLocation();
    await db.artifacts.put(source);
    await createArtifact({
      campaignId: CAMPAIGN,
      kind: 'location',
      name: 'Ford camp',
      links: [{ targetId: source.id, relation: 'near' }],
    });

    const report = await adopt();
    expect(report.adopted).toHaveLength(1);
    const copy = await getAnyArtifact(report.adopted[0]?.copyId ?? '');
    if (copy === undefined) throw new Error('copy missing');

    expect(copy.coverImageId).not.toBe(IMAGE);
    expect(copy.imageIds).toEqual([copy.coverImageId]);
    const clone = await db.images.get(copy.coverImageId ?? '');
    const libraryBlob = await db.images.get(IMAGE);
    expect(libraryBlob).toBeDefined();
    // The library's own row is untouched — still library-scoped.
    expect(libraryBlob?.campaignId).toBeNull();
    // The clone is campaign-scoped, byte-equal and ROLE-preserving (a map cover
    // demoted to artwork would stop `battleSeed.resolveMapImageId` finding it).
    expect(clone?.campaignId).toBe(CAMPAIGN);
    expect(clone?.role).toBe('map');
    expect(Array.from(clone?.bytes ?? new Uint8Array())).toEqual(
      Array.from(libraryBlob?.bytes ?? new Uint8Array()),
    );
    expect(clone?.bytes).not.toBe(libraryBlob?.bytes);
  });

  it('makes the reference READ again: a global target is missing before adoption and resolves after', async () => {
    const source = globalNpc();
    await db.artifacts.put(source);
    const encounter = await createArtifact({
      campaignId: CAMPAIGN,
      kind: 'encounter',
      name: 'Ambush at the Ford',
      data: encounterData([npcRefEntry('Sage', source.id)]),
    });
    const entry = async (): Promise<MonsterEntry> => {
      const row = await getArtifact(encounter.id);
      if (row === undefined) throw new Error('encounter missing');
      return firstRosterEntry(row);
    };

    // The row-258 defect is FIXED (docs/17 row 263): the repo-wired resolver
    // reads through the any-scope getter, so the GLOBAL target resolves in its
    // own workspace BEFORE any adoption — this arm used to assert the missing
    // arm here, which was the defect stated as an expectation.
    const before = await resolveMonsterEntryWithRepos(await entry());
    expect(before.missingRef).toBeUndefined();
    expect(before.statBlock).toEqual(STAT_BLOCK);
    expect(before.origin).toBe('NPC: Sage of the Vale');

    await adopt();

    const resolved = await resolveMonsterEntryWithRepos(await entry());
    expect(resolved.missingRef).toBeUndefined();
    expect(resolved.statBlock).toEqual(STAT_BLOCK);
    expect(resolved.origin).toBe('NPC: Sage of the Vale');
    // AFTER adoption the reference points at the campaign's OWN copy, so the
    // numbers survive the library row itself being deleted.
    const repointed = await entry();
    expect(repointed.source.type === 'npc-ref' ? repointed.source.artifactId : '').not.toBe(
      source.id,
    );
  });

  it('leaves a reference to a GONE library row untouched — never a placeholder', async () => {
    const missingId = '00000000-0000-4000-8000-00000000dead';
    const encounter = await createArtifact({
      campaignId: CAMPAIGN,
      kind: 'encounter',
      name: 'Ambush at the Ford',
      data: encounterData([npcRefEntry('Ghost', missingId)]),
    });

    const report = await adopt();
    expect(report.adopted).toEqual([]);
    expect(report.repointed).toBe(0);

    const after = await getArtifact(encounter.id);
    if (after === undefined) throw new Error('encounter missing');
    const survivor = firstRosterEntry(after);
    expect(survivor.source).toEqual({ type: 'npc-ref', artifactId: missingId });
    const resolved = await resolveMonsterEntryWithRepos(survivor);
    expect(resolved.statBlock).toBeNull();
    expect(resolved.missingRef).toBeDefined();
  });

  it('resolves a prose [[Name]] to the campaign copy without rewriting one byte of prose', async () => {
    const source = globalNpc();
    await db.artifacts.put(source);
    await createArtifact({
      campaignId: CAMPAIGN,
      kind: 'npc',
      name: 'The Vale',
      body: 'The vale keeps its [[Sage of the Vale]] close.',
      links: [{ targetId: source.id, relation: 'guarded by' }],
    });

    const report = await adopt();
    const copyId = report.adopted[0]?.copyId ?? '';

    const pool = [...(await listArtifactsByCampaign(CAMPAIGN)), ...(await listGlobalArtifacts())];
    const resolution = resolveWikiLink('Sage of the Vale', pool);
    // ONE name now answers in two scopes; the campaign tier wins, which is what
    // makes E4 need no rewrite at all.
    expect(resolution.status).toBe('resolved');
    expect(resolution.artifact?.id).toBe(copyId);

    // The PROSE was not touched: the referring artifact's body is unchanged.
    const vale = pool.find((row) => row.name === 'The Vale');
    expect(vale?.body).toBe('The vale keeps its [[Sage of the Vale]] close.');
    const copy = await getAnyArtifact(copyId);
    expect(copy?.body).toBe('The [[Sage of the Vale]] waits by the ford.');
  });

  it('copies ONE row per campaign — two campaigns get two independent copies', async () => {
    const source = globalNpc();
    await db.artifacts.put(source);
    await seedCampaign(CAMPAIGN, 'First');
    await seedCampaign(OTHER_CAMPAIGN, 'Second');
    for (const campaignId of [CAMPAIGN, OTHER_CAMPAIGN]) {
      await createArtifact({
        campaignId,
        kind: 'encounter',
        name: 'Ambush',
        data: encounterData([npcRefEntry('Sage', source.id)]),
      });
    }

    const report = await adopt();
    expect(report.adopted).toHaveLength(2);
    const copyIds = new Set(report.adopted.map((entry) => entry.copyId));
    expect(copyIds.size).toBe(2);
    // The library row is STILL there, and still the only global row.
    expect((await listGlobalArtifacts()).map((row) => row.id)).toEqual([source.id]);
  });

  it('writes NOTHING and reports zero for a workspace with no library references', async () => {
    await createArtifact({ campaignId: CAMPAIGN, kind: 'npc', name: 'Home-grown' });
    const report = await adopt();
    expect(report.adopted).toEqual([]);
    expect(report.repointed).toBe(0);
    expect(report.unresolved).toEqual([]);
  });

  it('a DUPLICATE of an adopted copy drops the origin stamp (one library row, one adopted copy)', async () => {
    const source = globalNpc();
    await db.artifacts.put(source);
    await createArtifact({
      campaignId: CAMPAIGN,
      kind: 'encounter',
      name: 'Ambush',
      data: encounterData([npcRefEntry('Sage', source.id)]),
    });
    const report = await adopt();
    const copyId = report.adopted[0]?.copyId ?? '';

    const duplicate = await duplicateArtifact(copyId);
    expect(duplicate.copiedFromArtifactId).toBeUndefined();

    // The idempotence scan still finds exactly ONE adopted copy, so a later
    // pass ADDS nothing.
    const second = await adopt();
    expect(second.adopted).toEqual([]);
  });

  it('a library row the COPY itself references is adopted in the SAME pass', async () => {
    const inner = globalNpc('The Ford Keeper');
    const linked = globalArtifactSchema.parse({
      ...globalLocation(),
      links: [{ targetId: inner.id, relation: 'kept by' }],
    });
    await db.artifacts.put(inner);
    await db.artifacts.put(linked);
    await createArtifact({
      campaignId: CAMPAIGN,
      kind: 'location',
      name: 'Camp',
      links: [{ targetId: linked.id, relation: 'near' }],
    });

    const report = await adopt();
    expect(report.adopted).toHaveLength(2);
    const outerCopy = report.adopted.find((entry) => entry.globalId === linked.id);
    const innerCopy = report.adopted.find((entry) => entry.globalId === inner.id);
    const outerRow = await getAnyArtifact(outerCopy?.copyId ?? '');
    expect(outerRow?.links[0]?.targetId).toBe(innerCopy?.copyId);
  });
});

describe('the WRITE-TIME half (the reference is never born)', () => {
  it('adopts the library row a draft is about to cite and hands back the rewritten references', async () => {
    const source = globalNpc();
    await db.artifacts.put(source);

    const rewritten = await adoptDraftLibraryReferences(CAMPAIGN, {
      kind: 'encounter',
      data: encounterData([npcRefEntry('Sage', source.id)]),
      links: [{ targetId: source.id, relation: 'guarded by' }],
    });
    expect(rewritten).not.toBeNull();
    const monsters = (rewritten?.data as { monsters: MonsterEntry[] }).monsters;
    const copyId = monsters[0]?.source.type === 'npc-ref' ? monsters[0].source.artifactId : '';
    expect(copyId).not.toBe(source.id);
    expect(rewritten?.links[0]?.targetId).toBe(copyId);
    expect((await getAnyArtifact(copyId))?.copiedFromArtifactId).toBe(source.id);
    // The library row survives, and the WRITE path never persists a report.
    expect(await db.artifacts.get(source.id)).toEqual(source);
  });

  it('reuses the campaign copy on a second write (one library row, one copy)', async () => {
    const source = globalNpc();
    await db.artifacts.put(source);
    const draft = {
      kind: 'encounter' as const,
      data: encounterData([npcRefEntry('Sage', source.id)]),
      links: [],
    };
    const first = await adoptDraftLibraryReferences(CAMPAIGN, draft);
    const firstId =
      ((first?.data as { monsters: MonsterEntry[] }).monsters[0]?.source as { artifactId: string })
        .artifactId;
    const second = await adoptDraftLibraryReferences(CAMPAIGN, draft);
    const secondId =
      ((second?.data as { monsters: MonsterEntry[] }).monsters[0]?.source as { artifactId: string })
        .artifactId;
    expect(secondId).toBe(firstId);
    expect(
      (await db.artifacts.toArray()).filter((row) => row.copiedFromArtifactId === source.id),
    ).toHaveLength(1);
  });

  it('does nothing at all for a draft that cites no library row', async () => {
    const own = await createArtifact({ campaignId: CAMPAIGN, kind: 'npc', name: 'Home-grown' });
    const result = await adoptDraftLibraryReferences(CAMPAIGN, {
      kind: 'encounter',
      data: encounterData([npcRefEntry('Home-grown', own.id)]),
      links: [{ targetId: own.id, relation: 'knows' }],
    });
    expect(result).toBeNull();
  });
});

describe('the seam stays ONE artifact patch path', () => {
  it('repoints through the shared revisioned write, and the row stays ordinarily editable', async () => {
    const source = globalNpc();
    await db.artifacts.put(source);
    const encounter = await createArtifact({
      campaignId: CAMPAIGN,
      kind: 'encounter',
      name: 'Ambush',
      data: encounterData([npcRefEntry('Sage', source.id)]),
    });
    await adopt();
    const after = await getArtifact(encounter.id);
    expect(after?.currentRevision).toBe(2);
    expect(await db.revisions.where('artifactId').equals(encounter.id).count()).toBe(2);
    // An ordinary update still works on the repointed row (one patch contract).
    const patched = await updateArtifact(encounter.id, { summary: 'still editable' });
    expect(patched.currentRevision).toBe(3);
  });
});

/**
 * docs/17 row 259 — THE BATTLE HOLDERS ARE THE LAST DECLARED SHAPE. A battle
 * token's `artifactId` is a real library reference for an `npc-ref` seed, and
 * the stage snapshot is the same tokens one revision later. The defect being
 * closed is SILENT: `db/creatureRepo.tokenCreature` resolves through the
 * any-scope getter, so deleting the library row leaves the card with nothing
 * and no named reason — unlike the roster/relation arms, whose loud missing
 * surfaces this seam leaves in charge. So the pins are: both token carriers
 * point at the campaign copy afterwards; a second pass writes nothing; and a
 * token that can be answered by NOTHING is NAMED, never dropped.
 */
describe('battle rows adopt their library tokens (docs/17 row 259)', () => {
  /** One real battle token through the production constructor (a null target
   * is a geometric stamp, which carries no artifact reference at all). */
  function tokenFor(artifactId: Id | null, label: string): Battle['board']['tokens'][number] {
    const token = tokenFromFighter(
      artifactId ?? newId(),
      { kind: 'npc', name: label, maxHp: 10 },
      0,
      true,
      null,
    );
    return artifactId === null ? { ...token, artifactId: null } : token;
  }

  /** A stored battle row (the seam reads STORED rows, never a parse). */
  async function putBattle(
    campaignId: Id,
    tokens: Battle['board']['tokens'],
    stageTokens?: Battle['board']['tokens'],
  ): Promise<Battle> {
    const battle = battleSchema.parse({
      ...stampNewEntity(),
      campaignId,
      moduleId: newId(),
      encounterArtifactId: null,
      reseed: null,
      seedFighters: [],
      board: {
        tokens,
        ...(stageTokens === undefined ? {} : { stage: { tokens: stageTokens } }),
      },
    });
    await db.battles.put(battle);
    return battle;
  }

  it('repoints BOTH the board token and its stage snapshot, and the library row survives', async () => {
    const source = globalNpc();
    await db.artifacts.put(source);
    const battle = await putBattle(
      CAMPAIGN,
      [tokenFor(source.id, 'Sage'), tokenFor(null, 'Stamp')],
      [tokenFor(source.id, 'Sage')],
    );

    const report = await adopt();
    expect(report.adopted).toHaveLength(1);
    const copyId = report.adopted[0]?.copyId ?? '';
    // ONE battle row rewritten (the artifact holders are untouched here).
    expect(report.repointed).toBe(1);
    expect(report.unresolved).toEqual([]);

    const after = await db.battles.get(battle.id);
    expect(after?.board.tokens[0]?.artifactId).toBe(copyId);
    // …the stage snapshot is a live token carrier, so it moves too.
    expect(after?.board.stage?.tokens[0]?.artifactId).toBe(copyId);
    // A geometric stamp cites no artifact and is left byte-identical.
    expect(after?.board.tokens[1]?.artifactId).toBeNull();

    // The library row SURVIVES, byte-identical.
    expect(await db.artifacts.get(source.id)).toEqual(source);

    // The card reads what the campaign OWNS: with the library row deleted the
    // token still resolves to the copy's own numbers.
    await db.artifacts.delete(source.id);
    const copy = await getAnyArtifact(copyId);
    expect(copy?.copiedFromArtifactId).toBe(source.id);
    expect(copy?.kind).toBe('npc');
    expect(copy?.kind === 'npc' ? copy.data.statBlock : null).toEqual(STAT_BLOCK);
  });

  it('is IDEMPOTENT: a second pass makes no copy and rewrites no battle row', async () => {
    const source = globalNpc();
    await db.artifacts.put(source);
    const battle = await putBattle(
      CAMPAIGN,
      [tokenFor(source.id, 'Sage')],
      [tokenFor(source.id, 'Sage')],
    );
    const first = await adopt();
    expect(first.repointed).toBe(1);
    const afterFirst = await db.battles.get(battle.id);

    const second = await adopt();
    expect(second.adopted).toEqual([]);
    expect(second.repointed).toBe(0);
    expect(second.unresolved).toEqual([]);
    // Byte-identical: the repoint is not a re-put.
    expect(await db.battles.get(battle.id)).toEqual(afterFirst);
    expect(
      (await db.artifacts.toArray()).filter((row) => row.copiedFromArtifactId === source.id),
    ).toHaveLength(1);
  });

  it('NAMES a token that resolves to nothing — never silent nothing', async () => {
    const missingId = '00000000-0000-4000-8000-00000000dead';
    // The battle's own frozen seed handle: a synthetic id is a legitimate
    // answer, so it must NOT be reported as a dangling reference.
    const frozenHandle = newId();
    const battle = await putBattle(CAMPAIGN, [
      tokenFor(missingId, 'Ghost'),
      { ...tokenFor(frozenHandle, 'Cited'), artifactId: frozenHandle },
    ]);
    await db.battles.update(battle.id, {
      seedFighters: [{ id: frozenHandle, name: 'Cited', maxHp: 3, initiativeBonus: 0 }],
    });

    const report = await adopt();
    expect(report.adopted).toEqual([]);
    expect(report.repointed).toBe(0);
    expect(report.unresolved).toHaveLength(1);
    expect(report.unresolved[0]?.name).toBe('Ghost');
    expect(report.unresolved[0]?.unexpected).toBe(false);
    expect(report.unresolved[0]?.reason).toContain(missingId);
    // The reference is LEFT as it was — nothing is pointed at a placeholder.
    expect((await db.battles.get(battle.id))?.board.tokens[0]?.artifactId).toBe(missingId);

    // LOUD: the report NAMES it (the shell persists it as the live arm's own
    // report; the migration arms that used to store it were deleted).
    expect(report.unresolved[0]?.name).toBe('Ghost');
  });

  it('remaps the frozen seed handle of a DERIVED npc-ref, so the token keeps its stats', async () => {
    // A derived library npc: no stored block of its own, only a `creatureRef`.
    // `db/battleSeed` freezes its resolved block under the ARTIFACT id, so the
    // repoint must move that seed row's id with the token's artifactId.
    const source = globalArtifactSchema.parse({
      ...globalNpc(),
      data: {
        appearance: '',
        personality: '',
        statBlock: null,
        originToken: 'chunk:legacy-ref',
      },
    });
    await db.artifacts.put(source);
    const handle = tokenFor(source.id, 'Derived');
    const battle = await putBattle(CAMPAIGN, [handle]);
    await db.battles.update(battle.id, {
      seedFighters: [{ id: source.id, name: 'Derived', maxHp: 21, initiativeBonus: 2 }],
    });

    const report = await adopt();
    const copyId = report.adopted[0]?.copyId ?? '';
    const after = await db.battles.get(battle.id);
    expect(after?.board.tokens[0]?.artifactId).toBe(copyId);
    // The frozen row the token keys its stats on moved with it — a repoint that
    // left it under the library id would silently lose the battle's numbers.
    expect(after?.seedFighters[0]?.id).toBe(copyId);
    const stats = buildFighterStatsLookup(
      { seedFighters: after?.seedFighters ?? [] },
      await listArtifactsByCampaign(CAMPAIGN),
    );
    expect(stats(copyId)).toMatchObject({ maxHp: 21, initiativeBonus: 2 });
  });

  it('NAMES a GONE seeding encounter — the key is left exactly as it is, never re-keyed to a guess', async () => {
    // docs/17 row 268: the seeding-encounter key IS collected and repointed
    // (row 263's deliberate exception is REVERSED), so the only key left alone
    // is one whose row is in NO table — there is nothing to copy. It keeps its
    // id and is NAMED, because deleting a SHARED library encounter scrubs
    // nothing and the surface would otherwise show nothing with no reason.
    const missingEncounterId = '00000000-0000-4000-8000-00000000e9c0';
    const battle = await putBattle(CAMPAIGN, [tokenFor(null, 'Stamp')]);
    await db.battles.update(battle.id, { encounterArtifactId: missingEncounterId });

    const report = await adopt();
    expect(report.adopted).toEqual([]);
    expect(report.unresolved).toHaveLength(1);
    expect(report.unresolved[0]?.name).toBe(missingEncounterId);
    expect(report.unresolved[0]?.unexpected).toBe(false);
    expect(report.unresolved[0]?.where).toContain(missingEncounterId);
    expect(report.unresolved[0]?.reason).toContain('nothing to adopt');
    expect(report.unresolved[0]?.reason).toContain('re-keyed to a guess');
    // The KEY is KEPT: nothing can be pointed at, so the row is untouched.
    expect((await db.battles.get(battle.id))?.encounterArtifactId).toBe(missingEncounterId);
  });

  it('ADOPTS a LIBRARY seeding encounter and RE-KEYS the battle to the campaign copy (docs/17 row 268)', async () => {
    // THE OWNER'S CORRECTION, verbatim: *"why is there still an identity
    // reference? I do not want any that is stored. I want campaign data
    // completely isolated from libraries, completely, not mostly."* A battle
    // seeded from a LIBRARY-scoped encounter must not keep the library id as
    // its key: it is re-keyed to the campaign's own copy, and the library row
    // survives untouched.
    const libraryEncounter = globalEncounter();
    await db.artifacts.put(libraryEncounter);
    const battle = await putBattle(CAMPAIGN, [tokenFor(null, 'Stamp')]);
    await db.battles.update(battle.id, { encounterArtifactId: libraryEncounter.id });

    const report = await adopt();
    expect(report.adopted).toHaveLength(1);
    const copyId = report.adopted[0]?.copyId ?? '';
    expect(report.repointed).toBe(1);
    expect(report.unresolved).toEqual([]);

    // The LIBRARY row SURVIVES, byte-identical…
    expect(await db.artifacts.get(libraryEncounter.id)).toEqual(libraryEncounter);
    // …and the battle's IDENTITY KEY names the campaign's own copy now.
    const after = await db.battles.get(battle.id);
    expect(after?.encounterArtifactId).toBe(copyId);
    const copy = await getArtifact(copyId);
    expect(copy?.campaignId).toBe(CAMPAIGN);
    expect(copy?.kind).toBe('encounter');

    // IDEMPOTENT: a second pass makes no copy and rewrites nothing.
    const second = await adopt();
    expect(second.adopted).toEqual([]);
    expect(second.repointed).toBe(0);
    expect(second.unresolved).toEqual([]);
    expect(await db.battles.get(battle.id)).toEqual(after);
  });

  it('moves the RE-SEED stamp with the key — the second stored copy of the encounter id', async () => {
    // The destructive re-seed stamps the same encounter id one revision later
    // (`battle.reseed.encounterArtifactId`). Leaving it behind would keep a
    // stored library reference on the row and disagree with the import path,
    // which already remaps it (`lib/exportImport`).
    const libraryEncounter = globalEncounter();
    await db.artifacts.put(libraryEncounter);
    const battle = await putBattle(CAMPAIGN, [tokenFor(null, 'Stamp')]);
    await db.battles.update(battle.id, {
      encounterArtifactId: libraryEncounter.id,
      reseed: { at: 1, encounterArtifactId: libraryEncounter.id, encounterName: 'Ford ambush' },
    });

    const report = await adopt();
    const copyId = report.adopted[0]?.copyId ?? '';
    const after = await db.battles.get(battle.id);
    expect(after?.encounterArtifactId).toBe(copyId);
    expect(after?.reseed?.encounterArtifactId).toBe(copyId);
    // No library id survives anywhere on the row.
    expect(JSON.stringify(after)).not.toContain(libraryEncounter.id);
  });

  it('does NOT adopt or report a seeding encounter the campaign already owns', async () => {
    const encounter = await createArtifact({
      campaignId: CAMPAIGN,
      kind: 'encounter',
      name: 'Ambush at the Ford',
      data: encounterData([{ name: 'Stamp', count: 1, notes: '', treasure: '', source: { type: 'none' as const } }]),
    });
    const battle = await putBattle(CAMPAIGN, [tokenFor(null, 'Stamp')]);
    await db.battles.update(battle.id, { encounterArtifactId: encounter.id });

    const report = await adopt();
    expect(report.adopted).toEqual([]);
    expect(report.repointed).toBe(0);
    expect(report.unresolved).toEqual([]);
    expect((await db.battles.get(battle.id))?.encounterArtifactId).toBe(encounter.id);
  });
});

/**
 * docs/17 row 268 — THE OWNER'S ACCEPTANCE: THE LIBRARY ROW IS DELETED AND THE
 * BATTLE AND ITS ENCOUNTER STILL OPEN.
 *
 * The seed is the real production entry point (`db/battleSeed
 * .seedBattleFromEncounter`, the module picker's action for a `moduleId ===
 * null` encounter) and the reads are the ones the surface and its affordances
 * use, so "the battle opens" is a statement about the real path. The library
 * ENCOUNTER is a real row in the shared library and the campaign owns nothing
 * but the copy the seed adopted.
 */
describe('a battle seeded from a LIBRARY encounter survives the library row (docs/17 row 268)', () => {
  it('keys the battle to the adopted copy, and the battle AND encounter still open with the library row DELETED', async () => {
    const libraryEncounter = globalEncounter('Ford ambush');
    await db.artifacts.put(libraryEncounter);
    const moduleId = newId();

    const { battle } = await seedBattleFromEncounter(CAMPAIGN, moduleId, libraryEncounter.id);

    // THE KEY IS CAMPAIGN-OWNED: not the library row, and its stored origin
    // names it (the ONE idempotence rule).
    expect(battle.encounterArtifactId).not.toBe(libraryEncounter.id);
    const ownedEncounterId = battle.encounterArtifactId ?? '';
    const ownedEncounter = await getArtifact(ownedEncounterId);
    expect(ownedEncounter?.campaignId).toBe(CAMPAIGN);
    expect(ownedEncounter?.copiedFromArtifactId).toBe(libraryEncounter.id);
    // The library row SURVIVES the seed (a copy, never a move).
    expect(await db.artifacts.get(libraryEncounter.id)).toEqual(libraryEncounter);

    // DELETE the library row — the owner's "refetch the pack" story, taken to
    // its extreme: the origin is gone, not merely re-ingested under a new id.
    await db.artifacts.delete(libraryEncounter.id);
    expect(await getAnyArtifact(libraryEncounter.id)).toBeUndefined();

    // THE IDENTITY LOOKUP still resolves the campaign-owned key…
    expect((await getBattleByEncounter(ownedEncounterId))?.id).toBe(battle.id);
    // …the affordance that still holds the LIBRARY card resolves through the
    // campaign's copy (the ONE hop), so "Open battle" stays honest and a second
    // press can never re-seed the live board…
    expect((await getBattleForEncounter(CAMPAIGN, libraryEncounter.id))?.id).toBe(battle.id);
    const copyId = await adoptedCopyIdOf(CAMPAIGN, libraryEncounter.id);
    expect(copyId).toBe(ownedEncounterId);
    // …and the surface's CAMPAIGN-SCOPED provenance read still resolves the
    // encounter itself (docs/17 row 268 replaced the any-scope getter there).
    expect((await getArtifact(battle.encounterArtifactId ?? ''))?.name).toBe('Ford ambush');

    // A battle from ANOTHER campaign never resolves through this campaign's
    // copy — the hop is campaign-scoped, not a global by-origin lookup.
    await seedCampaign('00000000-0000-4000-8000-0000000000ff', 'Other');
    expect(await getBattleForEncounter('00000000-0000-4000-8000-0000000000ff', libraryEncounter.id)).toBeUndefined();
  });

  it('reuses the campaign copy on a second seed (one library row, one copy, one battle)', async () => {
    const libraryEncounter = globalEncounter('Ford ambush');
    await db.artifacts.put(libraryEncounter);
    const moduleId = newId();

    const first = await seedBattleFromEncounter(CAMPAIGN, moduleId, libraryEncounter.id);
    const second = await seedBattleFromEncounter(CAMPAIGN, moduleId, libraryEncounter.id);

    expect(second.battle.id).toBe(first.battle.id);
    expect(second.battle.encounterArtifactId).toBe(first.battle.encounterArtifactId);
    expect(
      (await db.artifacts.toArray()).filter(
        (row) => row.copiedFromArtifactId === libraryEncounter.id,
      ),
    ).toHaveLength(1);
    // The destructive RE-SEED stamp records the CAMPAIGN-owned encounter too —
    // no library id survives on the row.
    expect(second.battle.reseed?.encounterArtifactId).toBe(second.battle.encounterArtifactId);
    expect(JSON.stringify(second.battle)).not.toContain(libraryEncounter.id);
  });
});

/**
 * docs/17 row 270 — THE BATTLE ROW'S OWN COPIES: the MAP IMAGE.
 *
 * `battle.board.mapImageId` / `board.stage.mapImageId` are stored IMAGE ids, a
 * different table (and a different id space) from every artifact reference the
 * adoption seam collected before. `db/battleSeed.resolveMapImageId` freezes
 * them from a LINKED location's `map`-role cover, or from the encounter's own
 * `data.mapImageId` — and when that image is a LIBRARY row the board stores a
 * library id that dangles the moment the pack is re-ingested. The pins below
 * are the brief's: REACHABILITY through the REAL seed path, the clone +
 * repoint (board, its stage snapshot, AND the encounter's own battlemap), the
 * library-being-deletable acceptance, idempotence, and the loud gone arm.
 */
describe('the battle row’s map image is a CAMPAIGN copy (docs/17 row 270)', () => {
  /** A campaign encounter whose ONLY battlemap is a LINKED location's `map`-role
   * cover — exactly the chain `db/battleSeed.resolveMapImageId` walks. */
  async function libraryMappedEncounter(locationId: Id): Promise<Artifact> {
    return createArtifact({
      campaignId: CAMPAIGN,
      kind: 'encounter',
      name: 'Sunken ford',
      data: encounterData([
        { name: 'Stamp', count: 1, notes: '', treasure: '', source: { type: 'none' as const } },
      ]),
      links: [{ targetId: locationId, relation: 'at' }],
    });
  }

  it('REACHABLE: the REAL seed path freezes a LIBRARY image id onto the board', async () => {
    // PROVEN, not hand-built: a GLOBAL location whose cover is a `map`-role
    // LIBRARY image, linked from a CAMPAIGN encounter, battle seeded through the
    // production entry point.
    await seedLibraryImage();
    const location = globalLocation();
    await db.artifacts.put(location);
    const encounter = await libraryMappedEncounter(location.id);

    const { battle } = await seedBattleFromEncounter(CAMPAIGN, newId(), encounter.id);

    // Campaign data now STORES a library image id…
    expect(battle.board.mapImageId).toBe(IMAGE);
    expect((await db.images.get(IMAGE))?.campaignId).toBeNull();
    // …and the encounter it read was the campaign's own row (nothing was
    // adopted on this path, so the freeze is the seed's own doing).
    expect((await getArtifact(encounter.id))?.copiedFromArtifactId).toBeUndefined();
  });

  it('CLONES and REPOINTS the board, its stage snapshot AND the encounter’s own battlemap', async () => {
    await seedLibraryImage();
    const location = globalLocation();
    await db.artifacts.put(location);
    const encounter = await libraryMappedEncounter(location.id);
    // The OTHER reachable shape: a campaign encounter whose OWN designed
    // battlemap names the library image directly (an adopted library encounter
    // before docs/17 row 270 did exactly this). It is the SOURCE a re-seed
    // would freeze again, so leaving it would re-mint the dependency.
    const ownMap = await createArtifact({
      campaignId: CAMPAIGN,
      kind: 'encounter',
      name: 'Ford camp',
      data: { ...encounterData([]), mapImageId: IMAGE },
    });
    const { battle } = await seedBattleFromEncounter(CAMPAIGN, newId(), encounter.id);
    expect(battle.board.mapImageId).toBe(IMAGE);
    // ⚑ Set stage copies the board's map into the SECOND stored carrier.
    const staged = await saveBattleStage(battle.id, captureStageSnapshot(battle.board));
    expect(staged.board.stage?.mapImageId).toBe(IMAGE);

    await adopt();

    const after = await db.battles.get(battle.id);
    const boardMap = after?.board.mapImageId ?? '';
    expect(boardMap).not.toBe(IMAGE);
    // The stage snapshot moved with the board — one map, two carriers.
    expect(after?.board.stage?.mapImageId).toBe(boardMap);
    const clone = await db.images.get(boardMap);
    expect(clone?.campaignId).toBe(CAMPAIGN);
    expect(clone?.role).toBe('map');
    expect(Array.from(clone?.bytes ?? new Uint8Array())).toEqual([1, 2, 3, 4]);
    // The library blob SURVIVES, still library-scoped (a copy, never a move).
    expect((await db.images.get(IMAGE))?.campaignId).toBeNull();
    // The encounter's own designed battlemap names the SAME campaign clone.
    const ownRow = await getArtifact(ownMap.id);
    if (ownRow?.kind !== 'encounter') throw new Error('the encounter row is missing');
    expect(ownRow.data.mapImageId).toBe(boardMap);

    // THE ACCEPTANCE: delete the library artifact AND its image — the board
    // still has its map, from the campaign's own bytes.
    await db.artifacts.delete(location.id);
    await db.images.delete(IMAGE);
    const survivor = await db.images.get((await db.battles.get(battle.id))?.board.mapImageId ?? '');
    expect(survivor?.campaignId).toBe(CAMPAIGN);
    expect(Array.from(survivor?.bytes ?? new Uint8Array())).toEqual([1, 2, 3, 4]);

    // IDEMPOTENT: a second pass makes no copy and rewrites nothing.
    const second = await adopt();
    expect(second.adopted).toEqual([]);
    expect(second.repointed).toBe(0);
    expect(second.unresolved).toEqual([]);
  });

  it('a LIBRARY encounter’s own battlemap is repointed on its COPY — the live arm the seed runs', async () => {
    // THE LIVE ARM, not merely historical: `campaignOwnedEncounter` adopts the
    // global encounter and hands the seed the COPY, and `adoptedArtifactRow`
    // used to spread `data` verbatim — so the copy's `data.mapImageId` still
    // named the LIBRARY image and the FIRST "Run battle" froze that id onto the
    // board. The image is deliberately NOT in the encounter's gallery/cover:
    // `data.mapImageId` is a stored image reference of its own.
    await seedLibraryImage();
    const libraryEncounter = globalEncounter('Ford ambush');
    await db.artifacts.put(libraryEncounter);
    const mapped = globalArtifactSchema.parse({
      ...libraryEncounter,
      id: newId(),
      data: { ...libraryEncounter.data, mapImageId: IMAGE },
    });
    await db.artifacts.put(mapped);

    const { battle } = await seedBattleFromEncounter(CAMPAIGN, newId(), mapped.id);

    const owned = await getArtifact(battle.encounterArtifactId ?? '');
    expect(owned?.copiedFromArtifactId).toBe(mapped.id);
    if (owned?.kind !== 'encounter') throw new Error('the adopted encounter is missing');
    expect(owned.data.mapImageId).not.toBe(IMAGE);
    expect(battle.board.mapImageId).toBe(owned.data.mapImageId);
    expect((await db.images.get(owned.data.mapImageId ?? ''))?.campaignId).toBe(CAMPAIGN);
    // The library row and blob SURVIVE, still library-scoped.
    expect((await db.images.get(IMAGE))?.campaignId).toBeNull();
  });

  it('NAMES a map image that went GONE after the seed — the id is KEPT, never a guess', async () => {
    await seedLibraryImage();
    const location = globalLocation();
    await db.artifacts.put(location);
    const encounter = await libraryMappedEncounter(location.id);
    const { battle } = await seedBattleFromEncounter(CAMPAIGN, newId(), encounter.id);
    expect(battle.board.mapImageId).toBe(IMAGE);
    // The library blob is GONE (re-ingested under a new id, or deleted): there
    // is nothing to copy, and pointing the board at a placeholder is forbidden.
    await db.images.delete(IMAGE);

    const report = await adopt();

    expect(report.unresolved.map((entry) => entry.name)).toContain(IMAGE);
    // The id is LEFT EXACTLY as it was.
    expect((await db.battles.get(battle.id))?.board.mapImageId).toBe(IMAGE);
  });
});
