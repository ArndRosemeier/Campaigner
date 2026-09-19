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
import { formatLibraryAdopt } from '@/domain/libraryAdoptRepair';
import { tokenFromFighter } from '@/domain/battle/board';
import { adoptLibraryArtifacts } from '@/db/libraryAdopt';
import { adoptDraftLibraryReferences } from '@/db/libraryAdoptLive';
import { retryLibraryAdoptions } from '@/db/libraryAdoptRetry';
import { buildFighterStatsLookup } from '@/db/fighterStats';
import {
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
    levelHint: '5',
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

/** Run the seam exactly as a Dexie upgrade body does. */
function adopt(reason: 'upgrade' | 'retry' = 'upgrade') {
  return db.transaction(
    'rw',
    [db.artifacts, db.revisions, db.images, db.campaigns, db.settings, db.battles],
    (tx) => adoptLibraryArtifacts({ tx, reason }),
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

    // The report is persisted for the shell's one-shot toast.
    const settings = await db.settings.get('settings');
    expect(settings?.libraryAdopt?.notified).toBe(false);
    expect(settings?.libraryAdopt?.adopted).toHaveLength(1);
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

    // The live defect (board row 258): a global npc-ref resolves as missing in
    // its own workspace even though the row exists.
    const before = await resolveMonsterEntryWithRepos(await entry());
    expect(before.statBlock).toBeNull();
    expect(before.missingRef).toBeDefined();

    await adopt();

    const resolved = await resolveMonsterEntryWithRepos(await entry());
    expect(resolved.missingRef).toBeUndefined();
    expect(resolved.statBlock).toEqual(STAT_BLOCK);
    expect(resolved.origin).toBe('NPC: Sage of the Vale');
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

  it('refuses LOUDLY when there is no settings row to report in', async () => {
    await db.settings.clear();
    const source = globalNpc();
    await db.artifacts.put(source);
    await createArtifact({
      campaignId: CAMPAIGN,
      kind: 'encounter',
      name: 'Ambush',
      data: encounterData([npcRefEntry('Sage', source.id)]),
    });

    await expect(adopt()).rejects.toThrow(/refusing to migrate silently/);
  });

  it('writes NOTHING and reports zero for a workspace with no library references', async () => {
    await createArtifact({ campaignId: CAMPAIGN, kind: 'npc', name: 'Home-grown' });
    const report = await adopt();
    expect(report.adopted).toEqual([]);
    expect(report.repointed).toBe(0);
    expect(report.unresolved).toEqual([]);
    // Nothing to say ⇒ nothing persisted.
    expect((await db.settings.get('settings'))?.libraryAdopt).toBeNull();
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
    expect((await db.settings.get('settings'))?.libraryAdopt).toBeNull();
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

    // LOUD: the persisted report carries it to the shell, and the ONE sentence
    // prints it by name and reason.
    const settings = await db.settings.get('settings');
    const persisted = settings?.libraryAdopt;
    expect(persisted?.unresolved[0]?.name).toBe('Ghost');
    if (persisted === undefined || persisted === null) throw new Error('no report persisted');
    expect(formatLibraryAdopt(persisted)).toContain('Ghost');
    expect(formatLibraryAdopt(persisted)).toContain(missingId);
  });

  it('the RETRY path heals a battle row, and its second run reports all-zero', async () => {
    const source = globalNpc();
    await db.artifacts.put(source);
    const battle = await putBattle(CAMPAIGN, [tokenFor(source.id, 'Sage')]);

    const first = await retryLibraryAdoptions();
    expect(first.adopted).toHaveLength(1);
    expect(first.repointed).toBe(1);
    const copyId = first.adopted[0]?.copyId ?? '';
    expect((await db.battles.get(battle.id))?.board.tokens[0]?.artifactId).toBe(copyId);
    const persisted = (await db.settings.get('settings'))?.libraryAdopt;

    const second = await retryLibraryAdoptions();
    expect(second.adopted).toEqual([]);
    expect(second.repointed).toBe(0);
    expect(second.unresolved).toEqual([]);
    // A retry that changed nothing persists nothing: the first run's report is
    // left exactly as it was rather than re-stamped (the shell is not re-toasted).
    expect((await db.settings.get('settings'))?.libraryAdopt).toEqual(persisted);
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
        creatureRef: { chunkId: '00000000-0000-4000-8000-00000000cafe' },
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
});
