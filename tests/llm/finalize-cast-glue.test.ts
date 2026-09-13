import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { putChunks } from '@/db/chunkRepo';
import { createRulebook } from '@/db/rulebookRepo';
import {
  createArtifact,
  getArtifact,
  listArtifactsByCampaign,
  updateArtifact,
} from '@/db/artifactRepo';
import { saveSettings } from '@/db/settingsRepo';
import { saveModule } from '@/db/moduleRepo';
import { resolveMonsterEntryWithRepos } from '@/db/monsterResolve';
import {
  createModule,
  createPersona,
  defaultSettings,
  moduleDocumentText,
  ruleChunkSchema,
  statBlockSchema,
  stampNewEntity,
  type AnyArtifact,
  type Campaign,
  type Id,
  type Module,
  type MonsterEntry,
  type Persona,
  type StatBlock,
} from '@/domain';
import { sha256Hex } from '@/lib/hash';
import { surroundingParagraphs } from '@/lib/wikilinks';
import { fixedCastForEncounter, partLevelForMention } from '@/llm/roomBudget';
import { buildEntityBrief } from '@/features/modules/persona-request';
import { runEngine, waitForRunStatus } from '@/llm/runEngine';
import { clearDatabase } from '../db/helpers';

/**
 * THE OWNER'S REPORT, VERBATIM (his campaign «Ein delikates Problem», module
 * «New Module», encounter «Tod im Seitenrohr»):
 *
 *   `1 of 2 encounters failed to generate — see the Runs tab ("Tod im
 *   Seitenrohr" — Refused by a data check: data.creatureRef: an npc carries
 *   either an authored stat block or a library creatureRef to derive one
 *   from, never both — clear the stat block or drop the creature reference.
 *   Nothing was written.)`
 *
 * ONE encounter failed while its sibling succeeded, and a FRESH retry
 * reproduced the identical error: deterministic, not a model whim. The chain
 * (docs/17 row 137, docs/11 §A cited row's REFILL and its roster-path
 * paragraph):
 *
 * 1. the encounter's scene wiki-links a member that is a CAST CREATURE row
 *    (`statBlock: null` + `creatureRef`, born in ONE literal by
 *    `db/creatureRepo.castCreatureAsNpc` — the sole creator);
 * 2. `roomBudget.fixedCastForEncounter` resolves that row, and
 *    `fixedCastStatsFor`'s citation branch returns the LIBRARY creature's
 *    block;
 * 3. our brief then ORDERS the model to embed that block as the monster's
 *    complete inline `statBlock` (`fixedCastSectionFor`) — the contract never
 *    mentions `creatureRef`, so the model never learns it exists and obeyed;
 * 4. finalize sees no citation, only that inline block, and
 *    `runEngine.materializeMonsterNpc`'s reuse branch finds the same-named
 *    cast row — which IS stat-less (`existing.data.statBlock === null`) — so
 *    it wrote the block onto it: `creatureRef` + `statBlock` on one row;
 * 5. `anyArtifactSchema.parse` (`db/artifactRepo`) refuses that pair BY NAME.
 *
 * Deterministic on retry because the parse runs BEFORE the write: nothing
 * lands, the cast row stays stat-less, and every retry walks the identical
 * path. The sibling encounter succeeded because its scene named no cast row
 * (`fixedCastForEncounter` → `[]` → no inline order → no collision).
 *
 * THE FIX (docs/17 row 137): the reuse branch LINKS the same-named cast row
 * and writes nothing, reusing the ONE classification `isCastCreatureNpc`
 * (`domain/creature`). The roster entry becomes an `npc-ref` to that row, so
 * the reader takes the numbers through the ONE derived-stats path
 * (`domain/encounterResolve.resolveDerivedNpcStats`, rendered with the
 * "Borrowed from the library" badge) — nothing is lost, because the block the
 * model embedded WAS the library's own block. The schema refusal is untouched:
 * the guard removes the CONSTRUCTOR, the backstop stands.
 *
 * The fixture mirrors the owner's own scene shape, ALIAS included:
 * `## Der Kampf: [[Tod im Seitenrohr]]` plus
 * `Im [[Dreizehnter Ablauf|Dreizehnten Ablauf]] stellt sich der Kampf
 * [[Tod im Seitenrohr]].` — `surroundingParagraphs` canonicalises a wiki token
 * to its TARGET name before matching, so the aliased member is what the cast
 * search finds (pinned in the first block below).
 */

vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {},
  OpenRouterError: class OpenRouterError extends Error {},
  listModels: vi.fn(),
  listImageModels: vi.fn(),
}));

vi.mock('@/llm/imageGen', () => ({ generateImages: vi.fn() }));
vi.mock('@/lib/imageIntake', () => ({ intakeImage: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

vi.mock('@/search', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...(actual as object), searchRules: vi.fn() };
});

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);
const { searchRules } = await import('@/search');
const searchRulesMock = vi.mocked(searchRules);

/** The owner's encounter, spelled as his campaign spells it. */
const ENCOUNTER_NAME = 'Tod im Seitenrohr';
/** The scene member that is a CAST CREATURE row — his ALIASED wiki-link. */
const CAST_NAME = 'Dreizehnter Ablauf';
const CAST_ALIAS = 'Dreizehnten Ablauf';
/** The library creature that cast row borrows from. */
const CREATURE_NAME = 'Bog Zombie';
const CREATURE_TEXT = 'Bog Zombie, a drowned corpse that drags victims under.';

/** The library creature's OWN block — what the brief orders the model to embed. */
const BORROWED_STATS: StatBlock = statBlockSchema.parse({
  system: 'dnd5e',
  level: '3',
  size: 'Medium',
  creatureType: 'undead',
  ac: 11,
  acNote: '',
  hp: 22,
  hpFormula: '4d8+4',
  speed: '20 ft.',
  abilities: { str: 13, dex: 6, con: 16, int: 3, wis: 6, cha: 5 },
  saves: '',
  skills: '',
  senses: 'darkvision 60 ft.',
  languages: 'understands the languages it knew in life',
  traits: [{ name: 'Undead Fortitude', text: 'Drops to 1 HP instead.' }],
  actions: [{ name: 'Slam', text: 'Melee Weapon Attack: +3 to hit.' }],
  reactions: [],
  legendary: [],
  extras: {},
});

/** A block the model authored itself, for a monster NO row answers. */
const AUTHORED_STATS: StatBlock = statBlockSchema.parse({
  ...BORROWED_STATS,
  level: '2',
  ac: 13,
  hp: 17,
  hpFormula: '3d8+3',
  actions: [{ name: 'Claw', text: 'Melee Weapon Attack: +4 to hit.' }],
});

const MODULE_SCENE = [
  `## Der Kampf: [[${ENCOUNTER_NAME}]]`,
  `Im [[${CAST_NAME}|${CAST_ALIAS}]] stellt sich der Kampf [[${ENCOUNTER_NAME}]].`,
].join('\n');

interface OwnerWorld {
  campaign: Campaign;
  module: Module;
  persona: Persona;
  castRowId: Id;
}

/**
 * Seeds the owner's shape: a campaign, a module whose text links the encounter
 * AND an ALIASED cast member, the library chunk the cast borrows from, and the
 * cast creature npc row — `statBlock: null` + `creatureRef`, the exact pair
 * `db/creatureRepo.castCreatureAsNpc` writes in ONE literal.
 */
async function seedOwnerWorld(): Promise<OwnerWorld> {
  const campaign = await createCampaign({ name: 'Ein delikates Problem', system: 'dnd5e' });
  const draft = createModule({
    campaignId: campaign.id,
    title: 'New Module',
    concept: 'concept',
    levelMin: 3,
    levelMax: 3,
    tone: '',
    sizeDial: 'standard',
  });
  const module = await saveModule({
    ...draft,
    spine: {
      premise: 'Premise.',
      themes: [],
      writerModel: '',
      origin: null,
      partPlan: [{ title: 'Der Ablauf', levelBand: '3', synopsis: '', levelUpTrigger: '' }],
    },
    parts: [
      {
        planIndex: 0,
        markdown: MODULE_SCENE,
        status: 'ready',
        errorMessage: '',
        edited: false,
        writerModel: '',
        origin: null,
      },
    ],
  });
  // The library the cast derives from — a REAL statblock chunk, so
  // `fixedCastStatsFor` answers with THE LIBRARY's block rather than null.
  const book = await createRulebook({
    title: 'Bestiary',
    system: 'dnd5e',
    filename: 'bestiary.pdf',
  });
  const chunkId = crypto.randomUUID();
  const contentHash = await sha256Hex(CREATURE_TEXT);
  await putChunks([
    ruleChunkSchema.parse({
      ...stampNewEntity(),
      id: chunkId,
      bookId: book.id,
      pageStart: 132,
      pageEnd: 132,
      chunkType: 'statblock',
      headingPath: [CREATURE_NAME],
      text: CREATURE_TEXT,
      statBlock: BORROWED_STATS,
      contentHash,
    }),
  ]);
  const castRow = await createArtifact({
    campaignId: campaign.id,
    moduleId: module.id,
    kind: 'npc',
    name: CAST_NAME,
    summary: 'The module text names her.',
    body: `Im ${CAST_ALIAS} stellt sie sich dem Kampf.`,
    links: [],
    data: {
      appearance: '',
      personality: '',
      statBlock: null,
      creatureRef: { chunkId, contentHash, creatureName: CREATURE_NAME },
    },
  });
  const persona = createPersona({
    slug: 'finalize-cast-glue-smith',
    name: 'Encounter Smith',
    description: 'test',
    systemPrompt: 'You design encounters.',
    mode: 'generate',
    producesKind: 'encounter',
    builtIn: true,
  });
  await saveSettings({ ...defaultSettings(), openRouterApiKey: 'test-key' });
  return { campaign, module, persona, castRowId: castRow.id };
}

/**
 * The brief the ENTITY BATCH builds for one entity (`features/modules/
 * entity-batch`, docs/11): the module text around the wiki-link, the spine
 * premise, the part level, and the FIXED CAST computed by the real
 * `fixedCastForEncounter` — so the ORDER the model obeys in these pins is
 * produced by production code, never by the test.
 */
async function entityBrief(
  world: OwnerWorld,
  name: string,
): Promise<{ brief: string; castNames: string[] }> {
  const moduleText = moduleDocumentText(world.module);
  const contextParagraphs = surroundingParagraphs(moduleText, name);
  const castPool = await listArtifactsByCampaign(world.campaign.id);
  const cast = await fixedCastForEncounter(name, contextParagraphs, castPool, world.module.id);
  return {
    brief: buildEntityBrief(
      name,
      contextParagraphs,
      world.module.spine?.premise ?? '',
      partLevelForMention(world.module, name),
      cast,
      true,
    ),
    castNames: cast.map((member) => member.name),
  };
}

/** The Smith's draft reply: ONE roster entry carrying an inline stat block. */
function draftReply(monsterName: string, statBlock: StatBlock): string {
  return JSON.stringify({
    name: ENCOUNTER_NAME,
    summary: 'A fight in the flooded pipe.',
    suggestedTags: ['ambush'],
    body: `# ${ENCOUNTER_NAME}`,
    difficulty: 'hard',
    levelHint: '3',
    monsters: [{ name: monsterName, count: 1, notes: 'blocks the way', statBlock }],
    terrain: 'flooded pipe',
    tactics: 'drag them under',
    treasure: 'none',
    locationKind: 'dungeon',
  });
}

/**
 * Drives the REAL engine to finalize, exactly like the entity batch's CREATE
 * arm (module-owned from birth, no target artifact), and answers the terminal
 * run row plus the finished encounter artifact.
 */
async function finalizeThrough(
  world: OwnerWorld,
  brief: string,
  monsterName: string,
  statBlock: StatBlock,
): Promise<{ run: Awaited<ReturnType<typeof waitForRunStatus>>; encounter: AnyArtifact }> {
  chatMock.mockResolvedValue({
    text: draftReply(monsterName, statBlock),
    modelUsed: 'test-model',
    fallback: null,
  });
  const runId = await runEngine.startRun({
    campaign: world.campaign,
    persona: world.persona,
    brief,
    autonomy: 'auto',
    pinnedChunkIds: [],
    placementModuleId: world.module.id,
  });
  const run = await waitForRunStatus(runId);
  const produced =
    run.resultArtifactId === null ? undefined : await getArtifact(run.resultArtifactId);
  if (produced === undefined) {
    throw new Error(
      `the run produced no artifact (status ${run.status}, failureKind ${String(run.failureKind)}: ${run.errorMessage})`,
    );
  }
  return { run, encounter: produced };
}

/** The one roster entry of a finalized encounter, as persisted. */
function firstMonster(encounter: AnyArtifact): MonsterEntry {
  if (encounter.kind !== 'encounter') throw new Error(`not an encounter: ${encounter.kind}`);
  const monster = encounter.data.monsters[0];
  if (monster === undefined) throw new Error('the encounter persisted no roster entry');
  return monster;
}

beforeEach(async () => {
  await clearDatabase();
  chatMock.mockReset();
  searchRulesMock.mockReset();
  searchRulesMock.mockResolvedValue([]);
});

describe('the fixed cast of the owner’s own scene, alias and all', () => {
  it('finds the ALIASED cast member and ORDERS the library block inline', async () => {
    const world = await seedOwnerWorld();
    const { brief, castNames } = await entityBrief(world, ENCOUNTER_NAME);
    // The aliased link is found through the TARGET name, and the encounter's
    // own wiki-linked name never joins its own cast.
    expect(castNames).toEqual([CAST_NAME]);
    // The ORDER the model obeyed — produced by production code.
    expect(brief).toContain(`"${CAST_NAME}"`);
    expect(brief).toContain('use these stats as-is');
    expect(brief).toContain('inline "statBlock"');
    expect(brief).toContain('never substitute a generic equivalent');
    expect(brief).toContain(JSON.stringify(BORROWED_STATS));
  });
});

describe('a roster monster the cast row answers (docs/17 row 137)', () => {
  it('LINKS the cast row and writes NOTHING onto it, instead of building the refused pair', async () => {
    const world = await seedOwnerWorld();
    const before = await getArtifact(world.castRowId);
    if (before === undefined) throw new Error('the cast row is missing');
    const { brief } = await entityBrief(world, ENCOUNTER_NAME);

    // The model obeys the brief exactly: it embeds the LIBRARY's block inline.
    const { run, encounter } = await finalizeThrough(world, brief, CAST_NAME, BORROWED_STATS);

    // RED before the guard: this object carries the owner's own sentence —
    // status 'failed', failureKind 'invalid-output', errorMessage
    // "Refused by a data check: data.creatureRef: an npc carries either an
    // authored stat block or a library creatureRef to derive one from, never
    // both …". GREEN after it: the run completes.
    expect({
      status: run.status,
      failureKind: run.failureKind ?? null,
      errorMessage: run.errorMessage,
    }).toEqual({ status: 'completed', failureKind: null, errorMessage: '' });

    // The roster LINKS the cast row — it is not a second, divergent source.
    const monster = firstMonster(encounter);
    expect(monster.name).toBe(CAST_NAME);
    expect(monster.source).toEqual({ type: 'npc-ref', artifactId: world.castRowId });

    // The cast row is UNCHANGED, byte for byte: the citation still stands and
    // no block was authored beside it.
    const after = await getArtifact(world.castRowId);
    expect(after).toEqual(before);
    expect(after?.kind === 'npc' ? after.data.statBlock : 'not-npc').toBeNull();
    expect(after?.kind === 'npc' ? after.data.creatureRef : undefined).toEqual(
      before.kind === 'npc' ? before.data.creatureRef : undefined,
    );

    // Nothing is lost: the roster entry renders the LIBRARY's own numbers,
    // through the ONE derived-stats path, with the derivation disclosed.
    const entry = encounter.kind === 'encounter' ? encounter.data.monsters[0] : undefined;
    if (entry === undefined) throw new Error('no roster entry to resolve');
    const resolved = await resolveMonsterEntryWithRepos(entry);
    expect(resolved.statBlock).toEqual(BORROWED_STATS);
    expect(resolved.origin).toBe(`NPC: ${CAST_NAME} (stats from Bestiary p.132)`);
  });

  it('LINKS a cast row the model named on its own, with no fixed cast in the brief', async () => {
    // The blast radius the guard also covers: an ordinary caller (no fixed
    // cast anywhere — outside a module, or a scene naming no cast member)
    // whose model-authored block happens to match a campaign-wide cast row by
    // name. Before the guard this walked the identical refused-pair path.
    const world = await seedOwnerWorld();
    const before = await getArtifact(world.castRowId);
    const { run, encounter } = await finalizeThrough(
      world,
      'A fight in the flooded pipe for level 3.',
      CAST_NAME,
      AUTHORED_STATS,
    );
    expect(run.status).toBe('completed');
    expect(firstMonster(encounter).source).toEqual({
      type: 'npc-ref',
      artifactId: world.castRowId,
    });
    // The model's generic equivalent is DISCARDED in favour of the row's own
    // identity: a cast row's numbers are the library's, by definition.
    expect(await getArtifact(world.castRowId)).toEqual(before);
  });
});

describe('the neighbours the guard must not break', () => {
  it('materializes a NEW npc artifact, carrying its block, when no row answers the name', async () => {
    const world = await seedOwnerWorld();
    const { brief } = await entityBrief(world, ENCOUNTER_NAME);
    const { encounter } = await finalizeThrough(world, brief, 'Bog Lurker', AUTHORED_STATS);
    const monster = firstMonster(encounter);
    expect(monster.source.type).toBe('npc-ref');
    if (monster.source.type !== 'npc-ref') throw new Error('the roster entry is not an npc-ref');
    const created = await getArtifact(monster.source.artifactId);
    expect(created?.kind).toBe('npc');
    expect(created?.name).toBe('Bog Lurker');
    expect(created?.moduleId).toBe(world.module.id);
    expect(created?.kind === 'npc' ? created.data.statBlock : undefined).toEqual(AUTHORED_STATS);
    expect(created?.kind === 'npc' ? created.data.creatureRef : undefined).toBeUndefined();
    // Exactly one such row: the materialization created it, it did not reuse.
    const named = (await listArtifactsByCampaign(world.campaign.id)).filter(
      (artifact) => artifact.kind === 'npc' && artifact.name === 'Bog Lurker',
    );
    expect(named).toHaveLength(1);
  });

  it('still writes the block onto a same-named ORDINARY (non-cited) stat-less npc row', async () => {
    const world = await seedOwnerWorld();
    const ordinary = await createArtifact({
      campaignId: world.campaign.id,
      moduleId: world.module.id,
      kind: 'npc',
      name: 'Mira',
      summary: 'A guide.',
      body: 'Mira knows the way down.',
      links: [],
      data: { appearance: '', personality: '', statBlock: null },
    });
    const { brief } = await entityBrief(world, ENCOUNTER_NAME);
    const { encounter } = await finalizeThrough(world, brief, 'Mira', AUTHORED_STATS);
    expect(firstMonster(encounter).source).toEqual({
      type: 'npc-ref',
      artifactId: ordinary.id,
    });
    const filled = await getArtifact(ordinary.id);
    expect(filled?.kind === 'npc' ? filled.data.statBlock : undefined).toEqual(AUTHORED_STATS);
    // No twin was minted for a row that already answered the name.
    const named = (await listArtifactsByCampaign(world.campaign.id)).filter(
      (artifact) => artifact.kind === 'npc' && artifact.name === 'Mira',
    );
    expect(named).toHaveLength(1);
  });
});

describe('the schema refusal is still the backstop it always was', () => {
  it('still refuses the pair if anything else ever constructs it, writing nothing', async () => {
    const world = await seedOwnerWorld();
    const before = await getArtifact(world.castRowId);
    if (before?.kind !== 'npc') throw new Error('the cast row is missing');
    await expect(
      updateArtifact(
        world.castRowId,
        { data: { ...before.data, statBlock: AUTHORED_STATS } },
        { source: 'persona' },
      ),
    ).rejects.toThrow(/an npc carries either an authored stat block or a library creatureRef/);
    // The refusal precedes the write: the row is byte-identical.
    expect(await getArtifact(world.castRowId)).toEqual(before);
  });
});
