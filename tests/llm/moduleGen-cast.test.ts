import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { getArtifact, listArtifactsByCampaign } from '@/db/artifactRepo';
import { putChunks } from '@/db/chunkRepo';
import { castCreatureAsNpc } from '@/db/creatureRepo';
import { db } from '@/db/db';
import { getModule, patchModule, saveModule } from '@/db/moduleRepo';
import { createRulebook } from '@/db/rulebookRepo';
import { updateSettings } from '@/db/settingsRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { runEntityBatch } from '@/features/modules/entity-batch';
import type * as runEngineModule from '@/llm/runEngine';
import { runSpine, spineReplySchema } from '@/llm/moduleGen';
import { sha256Hex } from '@/lib/hash';
import { collectCreatorRoster } from '@/llm/creatorRoster';
import { bestiaryVocabularyBlock, spineEntityKindsClause } from '@/llm/promptStyles';
import { strictJsonSchema } from '@/llm/strictSchema';
import {
  createModule,
  entityBestiarySlotSchema,
  moduleEntityKindSchema,
  moduleSpineSchema,
  npcCreatureRef,
  ruleChunkSchema,
  statBlockSchema,
  stampNewEntity,
  withEntityBestiarySlots,
  type Campaign,
  type Module,
  type ModuleEntityKind,
} from '@/domain';
import { clearDatabase } from '../db/helpers';

/**
 * THE MODULE-SIDE CAST — the owner's Aunt Agatha path, verbatim: *"Often
 * modules want lets say a zombie, but its old aunt agatha. So, she will have
 * zombie stats but with prose. This path should be easily available for mob
 * generation (inside the module generator mainly, i think the encounter
 * generated mobs wont need it, they should not introduce important NPCs on
 * their own)."*
 *
 * What this file pins, in the owner's terms:
 *
 * 1. the REQUEST is expressible in the module-generation contract (an optional
 *    `bestiary` slot on an entity record) and the encounter-generation
 *    contracts cannot express one AT ALL (docs/17 row 107, docs/11 D5);
 * 2. finalize CASTS through `castCreatureAsNpc` and nothing else — ONE `npc`
 *    artifact carrying the entity's own prose and the creature's derived stats,
 *    with no authored stat block and no persona run (so no live provider, and
 *    no model call at all on that entity);
 * 3. a second run REUSES that row instead of minting a twin;
 * 4. a creature the library cannot supply — or cannot disambiguate — fails
 *    LOUDLY, naming the entity and the creature, and finalizes nothing;
 * 5. a run that casts NOTHING composes the PRE-CHANGE prompt byte for byte
 *    (the additive discipline, docs/18 §4), measured against the golden fixture
 *    the pre-style builders were captured into.
 */

const { startRunMock, waitForRunStatusMock } = vi.hoisted(() => ({
  startRunMock: vi.fn(),
  waitForRunStatusMock: vi.fn(),
}));

// The engine is faked (this file pins the cast prompts), but the withdrawal
// predicate is the REAL one: `runEntityBatch` reads it to tell an owner stop
// from a failure (docs/17 row 117).
vi.mock('@/llm/runEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof runEngineModule>();
  return {
    isRunWithdrawn: actual.isRunWithdrawn,
    runNotCompletedReason: actual.runNotCompletedReason,
    runEngine: { on: () => () => undefined, startRun: startRunMock },
    waitForRunStatus: waitForRunStatusMock,
  };
});

vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

// The generator's own transport is mocked at the protocol boundary, the same
// seam every moduleGen test uses: the cast path must never reach a provider.
vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {
    constructor() {
      super('No OpenRouter API key configured');
      this.name = 'MissingApiKeyError';
    }
  },
  OpenRouterError: class OpenRouterError extends Error {},
  listModels: vi.fn(),
}));

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);

const TEST_MODEL = 'test/fixture-model';
const ZOMBIE = 'Zombie';
const AGATHA = 'Aunt Agatha';

const SPINE_ENTITIES = [
  { name: AGATHA, kind: 'npc', bestiary: { creature: ZOMBIE } },
  { name: 'The Walking Mill', kind: 'location', bestiary: null },
  { name: 'The Graves Walk', kind: 'encounter', bestiary: null },
];

/** The spine the planner answers with: one memorable character who is really a
 * common creature, plus one named encounter so the pass-0 floor gate is quiet. */
function spineReply(entities: unknown[] = SPINE_ENTITIES, premise = PREMISE): string {
  return JSON.stringify({
    premise,
    themes: ['grief', 'small-town silence'],
    partPlan: [
      {
        title: 'The Walking Mill',
        levelBand: '1',
        synopsis: 'The party arrives as the first of the risen is recognized.',
        levelUpTrigger: 'The party learns whose grave was opened first.',
      },
    ],
    entities,
  });
}

const PREMISE =
  'The graveyard behind the mill has begun to walk. The villagers bar their doors at dusk and ' +
  'count the shapes that shuffle between the stones.';

/** A normalization reply that maps every listed name to itself. */
function selfNormalization(
  entities: { name: string; kind: string }[] = [
    { name: AGATHA, kind: 'npc' },
    { name: 'The Walking Mill', kind: 'location' },
    { name: 'The Graves Walk', kind: 'encounter' },
  ],
): string {
  return JSON.stringify({
    entities: entities.map((entry) => ({
      name: entry.name,
      canonical: entry.name,
      kind: entry.kind,
    })),
  });
}

/** One stat-block chunk in a book, seeded exactly the way the creature tier
 * seeds one (the shape `db/creatureRepo` resolves and `listLibraryCreatures`
 * pools). Returns the chunk id the citation must carry. */
async function seedCreature(options: {
  bookTitle: string;
  name: string;
  hp: number;
  page?: number;
  /** The printed level the window orders by (default '1'). */
  level?: string;
}): Promise<string> {
  const book = await createRulebook({
    title: options.bookTitle,
    system: 'dnd5e',
    filename: `${options.bookTitle.toLowerCase().replaceAll(' ', '-')}.pdf`,
  });
  const text = `${options.name}\nMedium undead, neutral evil\nArmor Class 8\nHit Points ${String(options.hp)}`;
  const chunk = ruleChunkSchema.parse({
    ...stampNewEntity(),
    bookId: book.id,
    pageStart: options.page ?? 316,
    pageEnd: options.page ?? 316,
    chunkType: 'statblock',
    headingPath: [options.name],
    text,
    contentHash: await sha256Hex(text),
    statBlock: statBlockSchema.parse({
      system: 'dnd5e',
      level: options.level ?? '1',
      size: 'Medium',
      creatureType: 'undead',
      ac: 8,
      acNote: '',
      hp: options.hp,
      hpFormula: '3d8+9',
      speed: '20 ft.',
      abilities: { str: 13, dex: 6, con: 16, int: 3, wis: 6, cha: 5 },
      saves: 'Wis +0',
      skills: '',
      senses: 'darkvision 60 ft.',
      languages: 'understands the languages it knew in life but cannot speak',
      traits: [],
      actions: [{ name: 'Slam', text: 'Melee Weapon Attack: +3 to hit, 1d6+1 bludgeoning.' }],
      reactions: [],
      legendary: [],
      extras: {},
    }),
  });
  await putChunks([chunk]);
  return chunk.id;
}

/** A campaign + module row ready for a spine run. */
async function seedModule(levels: { min: number; max: number } = { min: 1, max: 1 }): Promise<{
  campaign: Campaign;
  moduleId: string;
}> {
  const campaign = await createCampaign({ name: 'Millford', system: 'dnd5e' });
  const saved = await saveModule(
    createModule({
      campaignId: campaign.id,
      title: 'The Walking Mill',
      concept: 'The village dead rise, and one of them is somebody’s aunt.',
      levelMin: levels.min,
      levelMax: levels.max,
      tone: 'grief',
      sizeDial: 'sketch',
    }),
  );
  return { campaign, moduleId: saved.id };
}

/** The module row the byte-identity golden was captured against (see
 * `tests/llm/promptStyles-classic-identity.test.ts`): a workspace with NO
 * bestiary is the only variable this file adds to that case. */
const FIXTURE_PREMISE =
  'A harbor town raised its bell to warn of the drownings; now the bell rings by itself.';
const FIXTURE_ENTITIES = [
  { name: 'Warden Bellamy', kind: 'npc' },
  { name: 'The Drowned Cathedral', kind: 'location' },
  { name: 'The Tide Cult', kind: 'faction' },
  { name: 'The Bells Below', kind: 'encounter' },
  { name: 'The Flooded Nave', kind: 'encounter' },
  { name: 'The Wardens Confession', kind: 'encounter' },
];

async function seedFixtureModule(): Promise<{ campaign: Campaign; moduleId: string }> {
  const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
  const saved = await saveModule(
    createModule({
      campaignId: campaign.id,
      title: 'The Drowned Bell',
      concept: 'A harbor bell that rings by itself beneath the water.',
      levelMin: 1,
      levelMax: 3,
      tone: 'eerie',
      sizeDial: 'standard',
    }),
  );
  return { campaign, moduleId: saved.id };
}

/** Runs the spine pass over `entities` and answers the normalization call. */
async function runSpineWith(
  moduleId: string,
  campaign: Campaign,
  entities: unknown[] = SPINE_ENTITIES,
  premise = PREMISE,
): Promise<Module> {
  const kinds = entities.map((entity) => {
    const record = entity as { name: string; kind: string };
    return { name: record.name, kind: record.kind };
  });
  chatMock
    .mockResolvedValueOnce({ text: spineReply(entities, premise), modelUsed: TEST_MODEL, fallback: null })
    .mockResolvedValueOnce({ text: selfNormalization(kinds), modelUsed: TEST_MODEL, fallback: null });
  return runSpine(moduleId, campaign);
}

/** Gives the approved spine a finished part whose text mentions the entity. */
async function seedPart(moduleId: string, markdown: string): Promise<void> {
  await patchModule(moduleId, {
    status: 'ready',
    parts: [
      {
        planIndex: 0,
        markdown,
        status: 'ready',
        errorMessage: '',
        edited: false,
        writerModel: TEST_MODEL,
        origin: null,
      },
    ],
  });
}

const AGATHA_PROSE =
  'The mill wheel turns though the race is dry. [[Aunt Agatha]] stands at the gate with the ' +
  'flour still on her hands, and she does not blink.\n\n' +
  'They buried Aunt Agatha in the spring, and the mill has not turned since.';

/** The same two paragraphs, padded well past the entity-brief substance floor.
 * Both paragraphs name her, so `surroundingParagraphs` (which keeps the
 * paragraphs that mention the entity) returns `AGATHA_PROSE` itself. */
const LONG_ENOUGH_PROSE = `${AGATHA_PROSE}\n\n${'The lane beyond the gate is churned to mud and nobody walks it after dark. '.repeat(3)}`;

beforeEach(async () => {
  await clearDatabase();
  await updateSettings({ defaultChatModel: TEST_MODEL });
});

afterEach(async () => {
  chatMock.mockReset();
  startRunMock.mockReset();
  waitForRunStatusMock.mockReset();
  vi.restoreAllMocks();
  await clearDatabase();
});

describe('the request is expressible in the module-generation contract', () => {
  it('the entity record accepts the bestiary slot, and stays additive when it is absent', () => {
    expect(
      moduleEntityKindSchema.parse({
        name: AGATHA,
        kind: 'npc',
        absorbed: [],
        bestiary: { creature: ZOMBIE },
      }).bestiary,
    ).toEqual({ creature: ZOMBIE });
    expect(
      moduleEntityKindSchema.parse({
        name: AGATHA,
        kind: 'npc',
        absorbed: [],
        bestiary: { creature: ZOMBIE, book: 'Bestiary' },
      }).bestiary,
    ).toEqual({ creature: ZOMBIE, book: 'Bestiary' });

    // ADDITIVE: a record that asks for nothing simply does not carry the key —
    // which is exactly what every record written before the field parses into.
    const withoutSlot = moduleEntityKindSchema.parse({ name: 'The Walking Mill', kind: 'location' });
    expect(withoutSlot).toEqual({ name: 'The Walking Mill', kind: 'location', absorbed: [] });
    expect('bestiary' in withoutSlot).toBe(false);
    // …and an explicit null — the strict contract's way of saying "no cast" —
    // reads the same as an absent key.
    expect(
      moduleEntityKindSchema.parse({ name: 'The Walking Mill', kind: 'location', bestiary: null })
        .bestiary,
    ).toBeUndefined();
  });

  it('REFUSES a malformed slot — an unnamed creature, an unnamed book, a non-object', () => {
    expect(entityBestiarySlotSchema.safeParse({ creature: '' }).success).toBe(false);
    expect(entityBestiarySlotSchema.safeParse({ creature: '   ' }).success).toBe(false);
    expect(entityBestiarySlotSchema.safeParse({ creature: ZOMBIE, book: '' }).success).toBe(false);
    expect(entityBestiarySlotSchema.safeParse({ creature: ZOMBIE, book: '  ' }).success).toBe(false);
    expect(
      moduleEntityKindSchema.safeParse({ name: AGATHA, kind: 'npc', bestiary: ZOMBIE }).success,
    ).toBe(false);
    expect(
      moduleEntityKindSchema.safeParse({ name: AGATHA, kind: 'npc', bestiary: { book: 'Bestiary' } })
        .success,
    ).toBe(false);
  });

  it('the spine reply contract EMITS the slot as a required nullable property', () => {
    // The strict subset has no "optional": the model must answer the key, and
    // `null` is how it says "no cast" — asserted off the SHIPPED emitted schema.
    const emitted = strictJsonSchema('probe-cast', spineReplySchema).schema;
    const properties = emitted.properties as Record<string, Record<string, unknown>>;
    const entities = properties.entities ?? {};
    const items = entities.items as Record<string, unknown>;
    const itemProperties = items.properties as Record<string, Record<string, unknown>>;

    expect(items.required).toContain('bestiary');
    expect(items.required).toContain('name');
    expect(items.required).toContain('kind');
    const bestiary = itemProperties.bestiary ?? {};
    // The key is REQUIRED of the decoder (strict) and NULLABLE in its type:
    // `null` is how a reply that wants no cast answers it.
    expect(bestiary.type).toContain('null');
    expect(bestiary.type).toContain('object');
    expect(bestiary.required).toContain('creature');
    expect(Object.keys((bestiary.properties ?? {}) as Record<string, unknown>)).toEqual([
      'creature',
      'book',
    ]);
    // The disambiguator is optional, so the decoder may answer it null.
    expect(((bestiary.properties ?? {}) as Record<string, Record<string, unknown>>).book?.type).toContain(
      'null',
    );
  });

  it('survives name normalization by carrying the request onto the canonical record', () => {
    const source: ModuleEntityKind[] = [
      { name: 'Aunt Agatha', kind: 'npc', absorbed: ['Old Agatha'], bestiary: { creature: ZOMBIE } },
    ];
    const canonical: ModuleEntityKind[] = [
      { name: 'Aunt Agatha', kind: 'npc', absorbed: ['Old Agatha'] },
    ];
    expect(withEntityBestiarySlots(canonical, source)[0]?.bestiary).toEqual({ creature: ZOMBIE });

    // A name whose spelling the pass CANONICALIZED keeps its request: the
    // variant it was written under still resolves to that canonical.
    const renamed: ModuleEntityKind[] = [{ name: 'Agatha', kind: 'npc', absorbed: ['Old Agatha'] }];
    expect(withEntityBestiarySlots(renamed, source)[0]?.bestiary).toEqual({ creature: ZOMBIE });

    // Nothing to carry ⇒ the record comes back untouched (no key invented).
    expect(withEntityBestiarySlots(canonical, canonical)[0]).toEqual(canonical[0]);
  });

  it('refuses LOUDLY when one canonical is answered by two different creatures', () => {
    // The normalizer folded the variant onto the canonical, and the two source
    // records ask for different creatures: picking one would silently re-stat
    // her, so the carry REFUSES instead (AGENTS rule 1).
    const source: ModuleEntityKind[] = [
      { name: 'Agatha', kind: 'npc', absorbed: ['Aunt Agatha'], bestiary: { creature: ZOMBIE } },
      { name: 'Aunt Agatha', kind: 'npc', absorbed: [], bestiary: { creature: 'Ghoul' } },
    ];
    const canonical: ModuleEntityKind[] = [
      { name: 'Agatha', kind: 'npc', absorbed: ['Aunt Agatha'] },
    ];
    expect(() => withEntityBestiarySlots(canonical, source)).toThrow(
      /two different library creatures/,
    );
  });
});

describe('the encounter-generation side cannot express a cast (docs/11 D5, docs/17 row 107)', () => {
  /**
   * EXTENDS the roster-side absence pin in `tests/db/creatureRepo.test.ts`
   * ("no encounter data can express a cast — the schema drops the field
   * outright", which reads the encounter ARTIFACT's data schema). This one
   * reads the GENERATION contracts the model is asked to answer — the Smith's
   * draft and the Cartographer's brief, roster entries included — because the
   * generator is the side that may ASK for a cast and the encounter side must
   * not even be able to speak it.
   */
  it('no encounter generation contract carries a bestiary slot or a cast flag', async () => {
    const { encounterDraftSchema, encounterGeneratorBriefSchema } = await import('@/llm/schemas');

    /** Every property name anywhere in one emitted contract. */
    const propertyNames = (node: unknown, found = new Set<string>()): Set<string> => {
      if (node === null || typeof node !== 'object') return found;
      if (Array.isArray(node)) {
        for (const member of node) propertyNames(member, found);
        return found;
      }
      const record = node as Record<string, unknown>;
      const properties = record.properties;
      if (properties !== null && typeof properties === 'object') {
        for (const [name, value] of Object.entries(properties as Record<string, unknown>)) {
          found.add(name);
          propertyNames(value, found);
        }
      }
      for (const value of Object.values(record)) propertyNames(value, found);
      return found;
    };

    for (const [name, schema] of [
      ['encounter-draft', encounterDraftSchema],
      ['encounter-brief', encounterGeneratorBriefSchema],
    ] as const) {
      const emitted = strictJsonSchema(name, schema).schema;
      const names = propertyNames(emitted);
      expect([...names]).not.toContain('bestiary');
      expect([...names]).not.toContain('cast');
      // The roster side's whole vocabulary is a CITATION, and it stays that.
      expect([...names]).toContain('sourceChunkIndex');
    }
  });

  it('the cast function has no encounter-path caller (the asymmetry is an ABSENCE)', async () => {
    const fs = await import('node:fs/promises');
    const sources = await Promise.all([
      fs.readFile('src/llm/runEngine.ts', 'utf8'),
      fs.readFile('src/llm/encounterRoster.ts', 'utf8'),
      fs.readFile('src/llm/schemas.ts', 'utf8'),
    ]);
    for (const source of sources) {
      expect(source).not.toContain('castCreatureAsNpc');
      expect(source).not.toContain('bestiarySlotForEntity');
    }
    // The sweep's encounter lane keeps routing to the ROSTER generator, never
    // to a cast: the batch's cast branch is reachable only for `kind === 'npc'`.
    const batch = await fs.readFile('src/features/modules/entity-batch.ts', 'utf8');
    expect(batch).toContain("if (slot !== null && kind === 'npc' && target.artifactId === undefined)");
  });
});

describe('finalize: the cast path', () => {
  it('ONE npc artifact carries the entity’s prose and the creature’s stats, and no authored stat block', async () => {
    const zombieChunkId = await seedCreature({ bookTitle: 'Bestiary', name: ZOMBIE, hp: 22 });
    const { campaign, moduleId } = await seedModule();
    const saved = await runSpineWith(moduleId, campaign);

    // The slot the model asked for RODE the pass AND the normalization call.
    expect(saved.entityKinds.find((entry) => entry.name === AGATHA)?.bestiary).toEqual({
      creature: ZOMBIE,
    });
    expect(
      saved.entityKinds.find((entry) => entry.name === 'The Walking Mill')?.bestiary,
    ).toBeUndefined();

    await seedPart(moduleId, LONG_ENOUGH_PROSE);
    await seedBuiltInPersonas();

    const module = await getModule(moduleId);
    if (module === undefined) throw new Error('module row is missing');
    const result = await runEntityBatch({
      module,
      campaign,
      kind: 'npc',
      targets: [{ name: AGATHA }],
    });

    expect(result.failed).toEqual([]);
    expect(result.cast).toEqual([AGATHA]);
    // A cast is NOT a generated artifact: no persona run produced it, and the
    // batch itself reached no transport at all (the two calls above are the
    // spine pass's own).
    expect(result.generated).toEqual([]);
    expect(startRunMock).not.toHaveBeenCalled();
    expect(chatMock).toHaveBeenCalledTimes(2);

    const npcs = (await listArtifactsByCampaign(campaign.id)).filter((row) => row.name === AGATHA);
    expect(npcs).toHaveLength(1);
    const npc = npcs[0];
    if (npc?.kind !== 'npc') throw new Error('the cast row is missing');
    // Her stats are the LIBRARY creature's, cited by identity — and she carries
    // no stat block of her own (the schema refuses that pair by name).
    const ref = npcCreatureRef(npc);
    expect(ref?.chunkId).toBe(zombieChunkId);
    expect(ref?.creatureName).toBe(ZOMBIE);
    expect(npc.data.statBlock).toBeNull();
    // Her OWN name and the module's prose about her.
    expect(npc.name).toBe(AGATHA);
    expect(npc.body).toContain('the flour still on her hands');
    expect(npc.body).toContain('They buried Aunt Agatha in the spring');
  });

  it('a SECOND run reuses that row — never a twin', async () => {
    await seedCreature({ bookTitle: 'Bestiary', name: ZOMBIE, hp: 22 });
    const { campaign, moduleId } = await seedModule();
    await runSpineWith(moduleId, campaign);
    await seedPart(moduleId, LONG_ENOUGH_PROSE);
    await seedBuiltInPersonas();

    const first = await getModule(moduleId);
    if (first === undefined) throw new Error('module row is missing');
    const firstResult = await runEntityBatch({
      module: first,
      campaign,
      kind: 'npc',
      targets: [{ name: AGATHA }],
    });

    const second = await getModule(moduleId);
    if (second === undefined) throw new Error('module row is missing');
    const secondResult = await runEntityBatch({
      module: second,
      campaign,
      kind: 'npc',
      targets: [{ name: AGATHA }],
    });

    expect(firstResult.failed).toEqual([]);
    expect(secondResult.failed).toEqual([]);
    expect(firstResult.cast).toEqual([AGATHA]);
    expect(secondResult.cast).toEqual([AGATHA]);
    const rows = (await listArtifactsByCampaign(campaign.id)).filter(
      (row) => row.kind === 'npc' && row.name === AGATHA,
    );
    expect(rows).toHaveLength(1);
    expect(secondResult.produced[0]?.artifactId).toBe(firstResult.produced[0]?.artifactId);
    expect(startRunMock).not.toHaveBeenCalled();
  });

  it('an unresolvable creature name fails LOUDLY, naming the entity and the creature, and finalizes nothing', async () => {
    await seedCreature({ bookTitle: 'Bestiary', name: ZOMBIE, hp: 22 });
    const { campaign, moduleId } = await seedModule();
    await runSpineWith(moduleId, campaign, [
      { name: AGATHA, kind: 'npc', bestiary: { creature: 'Bog Shambler' } },
      { name: 'The Walking Mill', kind: 'location', bestiary: null },
      { name: 'The Graves Walk', kind: 'encounter', bestiary: null },
    ]);
    await seedPart(moduleId, LONG_ENOUGH_PROSE);
    await seedBuiltInPersonas();

    const module = await getModule(moduleId);
    if (module === undefined) throw new Error('module row is missing');
    const result = await runEntityBatch({
      module,
      campaign,
      kind: 'npc',
      targets: [{ name: AGATHA }],
    });

    expect(result.cast).toEqual([]);
    expect(result.produced).toEqual([]);
    expect(result.failed).toHaveLength(1);
    const failure = result.failed[0];
    expect(failure?.name).toBe(AGATHA);
    expect(failure?.message).toContain(AGATHA);
    expect(failure?.message).toContain('Bog Shambler');
    expect(failure?.message).toContain('no creature of that name');
    // LOUD through the SAME convention every per-entity failure uses: the batch
    // collects it into `failed` (message + entity name) and its callers surface
    // that list — `entity-panel` toasts it, `post-generation` toasts it and
    // names the kind, `entity-detail`/`change-artifact` put the message in the
    // failure they raise. Never a silent skip, never console-only.
    expect(failure?.message).toContain('bestiary cast');
    // NOTHING was finalized — her prose was not silently dropped into a
    // statless twin.
    expect((await listArtifactsByCampaign(campaign.id)).filter((row) => row.kind === 'npc')).toEqual(
      [],
    );
    expect(startRunMock).not.toHaveBeenCalled();
  });

  it('an AMBIGUOUS creature name is refused by name, and the book slot disambiguates it', async () => {
    await seedCreature({ bookTitle: 'Bestiary', name: ZOMBIE, hp: 22, page: 316 });
    await seedCreature({ bookTitle: 'Tome of Horrors', name: ZOMBIE, hp: 40, page: 12 });

    const ambiguous = await seedModule();
    await runSpineWith(ambiguous.moduleId, ambiguous.campaign);
    await seedPart(ambiguous.moduleId, LONG_ENOUGH_PROSE);
    await seedBuiltInPersonas();
    const ambiguousRow = await getModule(ambiguous.moduleId);
    if (ambiguousRow === undefined) throw new Error('module row is missing');
    const refused = await runEntityBatch({
      module: ambiguousRow,
      campaign: ambiguous.campaign,
      kind: 'npc',
      targets: [{ name: AGATHA }],
    });
    expect(refused.failed).toHaveLength(1);
    expect(refused.failed[0]?.message).toContain('2 creatures of that name');
    expect(refused.failed[0]?.message).toContain('name the book');

    const named = await seedModule();
    await runSpineWith(named.moduleId, named.campaign, [
      { name: AGATHA, kind: 'npc', bestiary: { creature: ZOMBIE, book: 'Tome of Horrors' } },
      { name: 'The Walking Mill', kind: 'location', bestiary: null },
      { name: 'The Graves Walk', kind: 'encounter', bestiary: null },
    ]);
    await seedPart(named.moduleId, LONG_ENOUGH_PROSE);
    const namedRow = await getModule(named.moduleId);
    if (namedRow === undefined) throw new Error('module row is missing');
    const cast = await runEntityBatch({
      module: namedRow,
      campaign: named.campaign,
      kind: 'npc',
      targets: [{ name: AGATHA }],
    });
    expect(cast.failed).toEqual([]);
    expect(cast.cast).toEqual([AGATHA]);
    const npc = (await listArtifactsByCampaign(named.campaign.id)).find(
      (row) => row.name === AGATHA,
    );
    if (npc?.kind !== 'npc') throw new Error('the cast row is missing');
    const tomeChunk = (await db.chunks.toArray()).find((chunk) => chunk.statBlock?.hp === 40);
    expect(npcCreatureRef(npc)?.chunkId).toBe(tomeChunk?.id);
  });

  it('a book that holds no such creature is refused by name, listing what the library has', async () => {
    await seedCreature({ bookTitle: 'Bestiary', name: ZOMBIE, hp: 22 });
    const { campaign, moduleId } = await seedModule();
    await runSpineWith(moduleId, campaign, [
      { name: AGATHA, kind: 'npc', bestiary: { creature: ZOMBIE, book: 'Tome of Horrors' } },
      { name: 'The Walking Mill', kind: 'location', bestiary: null },
      { name: 'The Graves Walk', kind: 'encounter', bestiary: null },
    ]);
    await seedPart(moduleId, LONG_ENOUGH_PROSE);
    await seedBuiltInPersonas();
    const module = await getModule(moduleId);
    if (module === undefined) throw new Error('module row is missing');
    const result = await runEntityBatch({
      module,
      campaign,
      kind: 'npc',
      targets: [{ name: AGATHA }],
    });
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.message).toContain('Tome of Horrors');
    expect(result.failed[0]?.message).toContain('Bestiary');
  });

  it('a module with NO slot is untouched: the entity goes down the persona path', async () => {
    await seedCreature({ bookTitle: 'Bestiary', name: ZOMBIE, hp: 22 });
    const { campaign, moduleId } = await seedModule();
    await runSpineWith(moduleId, campaign, [
      { name: AGATHA, kind: 'npc', bestiary: null },
      { name: 'The Walking Mill', kind: 'location', bestiary: null },
      { name: 'The Graves Walk', kind: 'encounter', bestiary: null },
    ]);
    await seedPart(moduleId, LONG_ENOUGH_PROSE);
    await seedBuiltInPersonas();
    startRunMock.mockResolvedValue('run-1');
    waitForRunStatusMock.mockResolvedValue({
      status: 'completed',
      resultArtifactId: null,
      errorMessage: '',
    });

    const module = await getModule(moduleId);
    if (module === undefined) throw new Error('module row is missing');
    const result = await runEntityBatch({
      module,
      campaign,
      kind: 'npc',
      targets: [{ name: AGATHA }],
    });

    expect(result.cast).toEqual([]);
    // The persona path ran, exactly as it did before this arc.
    expect(startRunMock).toHaveBeenCalledTimes(1);
    expect((await listArtifactsByCampaign(campaign.id)).filter((row) => row.kind === 'npc')).toEqual(
      [],
    );
  });
});

describe('the additive prompt discipline (docs/18 §4)', () => {
  /** The user message of the first (spine) chat call. */
  function spinePrompt(): string {
    const messages = chatMock.mock.calls[0]?.[0] ?? [];
    const content = messages.find((message) => message.role === 'user')?.content;
    return typeof content === 'string' ? content : '';
  }

  it('a run with an EMPTY library composes the pre-change prompt, byte for byte', async () => {
    const { campaign, moduleId } = await seedFixtureModule();
    // The SAME reply the golden fixture was captured from, over the SAME module
    // row, in a workspace that holds no bestiary at all — so the only thing
    // under measurement is the prompt builder itself.
    chatMock
      .mockResolvedValueOnce({
        text: JSON.stringify({
          premise: FIXTURE_PREMISE,
          themes: ['duty', 'decay'],
          partPlan: [
            {
              title: 'The Sunken Quarter',
              levelBand: '1',
              synopsis: 'The party arrives with the low tide and finds the first bodies.',
              levelUpTrigger: 'The bell is found.',
            },
            {
              title: 'The Drowned Cathedral',
              levelBand: '2',
              synopsis: 'Descent beneath the harbor to the flooded nave.',
              levelUpTrigger: 'The warden falls.',
            },
            {
              title: 'The Bell Tower',
              levelBand: '3',
              synopsis: 'Final confrontation at the top of the leaning tower.',
              levelUpTrigger: 'The cult is broken.',
            },
          ],
          entities: FIXTURE_ENTITIES,
        }),
        modelUsed: TEST_MODEL,
        fallback: null,
      })
      .mockResolvedValueOnce({
        text: selfNormalization(FIXTURE_ENTITIES),
        modelUsed: TEST_MODEL,
        fallback: null,
      });
    await runSpine(moduleId, campaign);

    const prompt = spinePrompt();
    const golden = await import('node:fs/promises').then((fs) =>
      fs.readFile('tests/fixtures/promptStyles/spine-classic-default.txt', 'utf8'),
    );
    expect(prompt.trimEnd()).toBe(golden.trimEnd());
    // No library ⇒ no bestiary clause AND no vocabulary: not the field, not the
    // rule, not the listing (docs/17 rows 107/114 — the additive discipline).
    expect(prompt).not.toContain('bestiary');
    expect(prompt).not.toContain('library list below');
    expect(prompt).not.toContain('Creatures this workspace');
  });

  it('the delta with a library is the bestiary clause PLUS its vocabulary block', async () => {
    await seedCreature({ bookTitle: 'Bestiary', name: ZOMBIE, hp: 22 });
    const { campaign, moduleId } = await seedModule();
    await runSpineWith(moduleId, campaign);

    const prompt = spinePrompt();
    const withoutLibrary = spineEntityKindsClause(false);
    const withLibrary = spineEntityKindsClause(await collectCreatorRoster(1));
    expect(prompt).toContain(withLibrary);
    // The vocabulary itself is byte-identical with and without a library: the
    // delta is exactly the appended clause plus the vocabulary it governs.
    expect(withLibrary.startsWith(withoutLibrary)).toBe(true);
    const clause = withLibrary.slice(withoutLibrary.length);
    expect(clause).toContain('bestiary');
    expect(clause).toContain('Aunt Agatha');
    expect(clause).toContain('generic mob that is not a character');
    expect(clause).toContain(ZOMBIE);
    expect(prompt.split('bestiary').length - 1).toBe(clause.split('bestiary').length - 1);
  });

  it('the clause is offered only when the workspace HAS a creature to name', async () => {
    const { campaign, moduleId } = await seedModule();
    await runSpineWith(moduleId, campaign);
    expect(spinePrompt()).not.toContain('"bestiary"');
    // …and the slot still parses on such a run: the field is additive, not
    // conditional on the library the prompt saw.
    expect(moduleSpineSchema.safeParse(JSON.parse(spineReply())).success).toBe(true);
  });
});

describe('the creator is shown the library it may name (docs/17 row 114)', () => {
  /** The user message of the first (spine) chat call. */
  function spinePrompt(): string {
    const messages = chatMock.mock.calls[0]?.[0] ?? [];
    const content = messages.find((message) => message.role === 'user')?.content;
    return typeof content === 'string' ? content : '';
  }

  it('carries the ACTUAL creature names, the rule that governs them and the truncation note', async () => {
    await seedCreature({ bookTitle: 'Bestiary', name: ZOMBIE, hp: 22 });
    await seedCreature({ bookTitle: 'Tome of Horrors', name: 'Ghoul', hp: 22 });
    const { campaign, moduleId } = await seedModule();
    await runSpineWith(moduleId, campaign);

    // The window the prompt carried is the SAME window `collectCreatorRoster`
    // builds for this module — the module's own band midpoint (levels 1–1 ⇒
    // 1) is the ordering target.
    const roster = await collectCreatorRoster(1);
    expect(roster.lines).toEqual(['Ghoul', ZOMBIE]);
    const vocabulary = bestiaryVocabularyBlock(roster);
    if (vocabulary === null) throw new Error('the vocabulary block is missing');

    const prompt = spinePrompt();
    expect(prompt).toContain(vocabulary);
    // Both real names, each on its own line, copied exactly as the library
    // spells them — this is the whole defect: before this arc the prompt named
    // ONE example creature and nothing this workspace actually holds.
    expect(prompt).toContain(`\n${ZOMBIE}\n`);
    expect(prompt).toContain('\nGhoul\n');
    // The rule half: copy from the list, borrow the numbers as they are, and
    // leave the slot OFF rather than invent a name.
    expect(prompt).toContain('copied exactly as it is written there');
    expect(prompt).toContain('NO bestiary slot and write the mob into the scene instead');
    expect(prompt).toContain('never given a level-adapted, renamed or otherwise decorated variant');
    // The advisory block rides INSIDE the entity-kind clause — no new
    // placeholder, no new template line, so the built-in styles are untouched.
    expect(prompt).toContain(spineEntityKindsClause(roster));
  });

  it('notices a TRUNCATED window instead of silently listing 300 of 305 creatures', async () => {
    for (let index = 0; index < 305; index += 1) {
      await seedCreature({
        bookTitle: 'Bestiary',
        name: `Creature ${String(index).padStart(3, '0')}`,
        hp: 22,
      });
    }
    const { campaign, moduleId } = await seedModule();
    await runSpineWith(moduleId, campaign);

    const roster = await collectCreatorRoster(1);
    expect(roster.lines).toHaveLength(300);
    expect(roster.truncated).toBe(5);
    const prompt = spinePrompt();
    expect(prompt).toContain('(roster truncated; 5 more)');
  });

  it('targets the module’s OWN band MIDPOINT, not one of its edges', async () => {
    await seedCreature({ bookTitle: 'Bestiary', name: 'Low Thing', hp: 22, level: '1' });
    await seedCreature({ bookTitle: 'Bestiary', name: 'Mid Thing', hp: 22, level: '4' });
    await seedCreature({ bookTitle: 'Bestiary', name: 'High Thing', hp: 22, level: '7' });
    // Levels 1–6 ⇒ target 3.5: level 4 (0.5), level 1 (2.5), level 7 (3.5).
    // An edge (1 or 6) would order them 1, 4, 7 or 7, 4, 1 — so this pin fails
    // if the chain's spine step is ever replaced by levelMin or levelMax.
    const { campaign, moduleId } = await seedModule({ min: 1, max: 6 });
    await runSpineWith(moduleId, campaign);

    const prompt = spinePrompt();
    const header = 'Creatures this workspace’s library holds (name only — copy it exactly):';
    const listed = prompt.slice(prompt.indexOf(header)).split('\n').slice(1, 4);
    expect(listed).toEqual(['Mid Thing', 'Low Thing', 'High Thing']);
  });

  it('offers NO slot and composes the pre-change prompt when the window is EMPTY', async () => {
    // The library holds nothing castable: a statblock chunk whose own stat
    // block was never validated. The slot must be left off — a slot with no
    // vocabulary is uncastable by construction — and the clause must be the
    // pre-change constant, byte for byte.
    const book = await createRulebook({
      title: 'Broken Import',
      system: 'dnd5e',
      filename: 'broken.pdf',
    });
    const text = 'Not a creature';
    await putChunks([
      ruleChunkSchema.parse({
        ...stampNewEntity(),
        bookId: book.id,
        pageStart: 1,
        pageEnd: 1,
        chunkType: 'statblock',
        headingPath: ['Not a creature'],
        text,
        contentHash: await sha256Hex(text),
        statBlock: null,
      }),
    ]);
    const { campaign, moduleId } = await seedModule();
    await runSpineWith(moduleId, campaign);

    const prompt = spinePrompt();
    // The window is empty ⇒ the clause is the pre-change constant, byte for
    // byte, and the slot is not offered anywhere in the prompt.
    expect(spineEntityKindsClause(await collectCreatorRoster(1))).toBe(
      spineEntityKindsClause(false),
    );
    expect(prompt).toContain(spineEntityKindsClause(false));
    expect(prompt).not.toContain('library list below');
    expect(prompt).not.toContain('roster truncated');
  });
});

describe('the cast path names real creatures (docs/17 row 114 regression)', () => {
  it('casts the creature the WINDOW listed, by the name the window printed', async () => {
    const zombieChunkId = await seedCreature({ bookTitle: 'Bestiary', name: ZOMBIE, hp: 22 });
    const { campaign, moduleId } = await seedModule();
    await runSpineWith(moduleId, campaign);

    // What the prompt showed is what the slot answers with: the line the model
    // copies IS a resolvable name.
    const roster = await collectCreatorRoster(1);
    expect(roster.lines).toContain(ZOMBIE);
    const listed = roster.lines[0];
    if (listed === undefined) throw new Error('the window is empty');

    await seedPart(moduleId, LONG_ENOUGH_PROSE);
    await seedBuiltInPersonas();
    const module = await getModule(moduleId);
    if (module === undefined) throw new Error('module row is missing');
    const result = await runEntityBatch({
      module,
      campaign,
      kind: 'npc',
      targets: [{ name: AGATHA }],
    });

    expect(result.failed).toEqual([]);
    expect(result.cast).toEqual([AGATHA]);
    const npc = (await listArtifactsByCampaign(campaign.id)).find((row) => row.name === AGATHA);
    if (npc?.kind !== 'npc') throw new Error('the cast row is missing');
    expect(npcCreatureRef(npc)?.chunkId).toBe(zombieChunkId);
    expect(npcCreatureRef(npc)?.creatureName).toBe(listed);
  });

  it('refuses a NEAR MISS by naming the nearest creatures, and stays silent when nothing is close', async () => {
    await seedCreature({ bookTitle: 'Bestiary', name: 'Zombie-Schläger', hp: 22 });

    const near = await seedModule();
    await runSpineWith(near.moduleId, near.campaign, [
      { name: AGATHA, kind: 'npc', bestiary: { creature: 'zombie schlager' } },
      { name: 'The Walking Mill', kind: 'location', bestiary: null },
      { name: 'The Graves Walk', kind: 'encounter', bestiary: null },
    ]);
    await seedPart(near.moduleId, LONG_ENOUGH_PROSE);
    await seedBuiltInPersonas();
    const nearRow = await getModule(near.moduleId);
    if (nearRow === undefined) throw new Error('module row is missing');
    const refused = await runEntityBatch({
      module: nearRow,
      campaign: near.campaign,
      kind: 'npc',
      targets: [{ name: AGATHA }],
    });

    expect(refused.failed).toHaveLength(1);
    const message = refused.failed[0]?.message ?? '';
    // The resolution was NOT loosened: the umlaut/hyphen/case variant still
    // fails, and nothing was written.
    expect(message).toContain('no creature of that name');
    // …but the refusal is now ACTIONABLE: it names the creature the library
    // actually holds, with the book it comes from.
    expect(message).toContain('the nearest creatures this library holds: Zombie-Schläger (Bestiary)');
    expect(refused.cast).toEqual([]);
    expect((await listArtifactsByCampaign(near.campaign.id)).filter((row) => row.kind === 'npc')).toEqual(
      [],
    );

    // A query with nothing close keeps the pre-114 sentence: the suggestion is
    // appended only when there is something worth naming.
    const far = await seedModule();
    await runSpineWith(far.moduleId, far.campaign, [
      { name: AGATHA, kind: 'npc', bestiary: { creature: 'Ancient Red Dragon' } },
      { name: 'The Walking Mill', kind: 'location', bestiary: null },
      { name: 'The Graves Walk', kind: 'encounter', bestiary: null },
    ]);
    await seedPart(far.moduleId, LONG_ENOUGH_PROSE);
    const farRow = await getModule(far.moduleId);
    if (farRow === undefined) throw new Error('module row is missing');
    const cleaned = await runEntityBatch({
      module: farRow,
      campaign: far.campaign,
      kind: 'npc',
      targets: [{ name: AGATHA }],
    });
    const cleanedMessage = cleaned.failed[0]?.message ?? '';
    expect(cleanedMessage).toContain('no creature of that name');
    expect(cleanedMessage).not.toContain('the nearest creatures this library holds');
  });
});

/**
 * THE DESCRIPTION A CAST ROW OWES THE MODULE TEXT (docs/17 row 133, docs/11
 * §The module-side cast) — the BATCH's own decision, with the engine faked (the
 * full run through the real engine, and the prose it actually writes, are pinned
 * in `tests/features/entity-batch-cast-description.test.ts`).
 *
 * The owner, verbatim in substance: *"When the module creates an NPC inside the
 * TEXT ... that means that this NPC absolutely needs a description, even if its
 * just a zombie. What happens right now is that those named zombies only get an
 * image on their details, nothing more. No text, no stat block, nothing."* The
 * cast stays — its numbers are the library's and its citation is its identity —
 * and the DESCRIPTION is authored by the entity's own persona, THROUGH the cited
 * row's existing refill (the only sanctioned write into a cast row): the run is
 * aimed at the cast row, never at a new artifact.
 */
const NAMED_ONLY_PROSE = '**The risen:** [[Aunt Agatha]] and [[Zombie]].';

const { toastError } = await import('@/lib/toast');
const toastErrorMock = vi.mocked(toastError);

describe('a cast row the module text only NAMES is given an authored description (docs/17 row 133)', () => {
  it('aims the entity’s own run AT THE CAST ROW: a refill, never a new artifact and never a placement', async () => {
    await seedCreature({ bookTitle: 'Bestiary', name: ZOMBIE, hp: 22 });
    const { campaign, moduleId } = await seedModule();
    await runSpineWith(moduleId, campaign);
    await seedPart(moduleId, NAMED_ONLY_PROSE);
    await seedBuiltInPersonas();
    // The refill answers with the row it filled — the shape `runFinalize` has
    // for a targeted run.
    startRunMock.mockImplementation(
      (input: { targetArtifactId?: string }) => `run-${input.targetArtifactId ?? 'none'}`,
    );
    waitForRunStatusMock.mockImplementation(async () => {
      const row = (await listArtifactsByCampaign(campaign.id)).find(
        (artifact) => artifact.name === AGATHA,
      );
      // Exactly what the engine writes for a refill: the row it filled.
      return { status: 'completed', resultArtifactId: row?.id ?? null, errorMessage: '' };
    });

    const module = await getModule(moduleId);
    if (module === undefined) throw new Error('module row is missing');
    const result = await runEntityBatch({
      module,
      campaign,
      kind: 'npc',
      targets: [{ name: AGATHA }],
    });

    expect(result.failed).toEqual([]);
    // Still a CAST (the artifact is the cast's — library numbers, citation
    // identity), never a `generated` artifact: the run wrote PROSE into a row it
    // did not create.
    expect(result.cast).toEqual([AGATHA]);
    expect(result.generated).toEqual([]);
    const castNpc = (await listArtifactsByCampaign(campaign.id)).find(
      (artifact) => artifact.name === AGATHA,
    );
    if (castNpc?.kind !== 'npc') throw new Error('the cast row is missing');
    expect(result.produced[0]?.artifactId).toBe(castNpc.id);

    expect(startRunMock).toHaveBeenCalledTimes(1);
    const input = startRunMock.mock.calls[0]?.[0] as {
      targetArtifactId?: string;
      placementModuleId?: string;
      brief?: string;
      autonomy?: string;
    };
    // THE ROW, not a new artifact: the refill's own contract.
    expect(input.targetArtifactId).toBe(castNpc.id);
    // …and no placement: a run that carries both is refused by the engine, and
    // an existing artifact's scope changes only through explicit scope moves.
    expect(input.placementModuleId).toBeUndefined();
    expect(input.autonomy).toBe('auto');
    // The entity's own brief (the same one the persona path builds): the mention
    // is what the model is grounded in, and the name rule rides it.
    expect(input.brief).toContain(`Detail the entity "${AGATHA}" for this module.`);
    expect(input.brief).toContain(`must be exactly "${AGATHA}"`);
    // The mention IS handed to the model — it is thin, not absent.
    expect(input.brief).toContain('[[Aunt Agatha]]');
  });

  it('a run the OWNER stopped writes no failure: the cast stands, silently (row 117)', async () => {
    await seedCreature({ bookTitle: 'Bestiary', name: ZOMBIE, hp: 22 });
    const { campaign, moduleId } = await seedModule();
    await runSpineWith(moduleId, campaign);
    await seedPart(moduleId, NAMED_ONLY_PROSE);
    await seedBuiltInPersonas();
    startRunMock.mockResolvedValue('run-1');
    waitForRunStatusMock.mockResolvedValue({
      status: 'cancelled',
      resultArtifactId: null,
      errorMessage: '',
    });

    const module = await getModule(moduleId);
    if (module === undefined) throw new Error('module row is missing');
    const result = await runEntityBatch({
      module,
      campaign,
      kind: 'npc',
      targets: [{ name: AGATHA }],
    });

    // A deliberate stop is not a failure at EITHER arm of the batch.
    expect(result.failed).toEqual([]);
    expect(result.cast).toEqual([AGATHA]);
    expect(result.generated).toEqual([]);
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it('the module’s OWN prose decides: a row cast while the mention was thin is not given a second, invented description', async () => {
    const chunkId = await seedCreature({ bookTitle: 'Bestiary', name: ZOMBIE, hp: 22 });
    const { campaign, moduleId } = await seedModule();
    await runSpineWith(moduleId, campaign);
    // The text DESCRIBES her…
    await seedPart(moduleId, LONG_ENOUGH_PROSE);
    await seedBuiltInPersonas();
    // …and the row for her was cast EARLIER, while that text only named her (or
    // by the bestiary's "spawn into module"): its prose is its birth prose.
    const earlier = await castCreatureAsNpc({
      campaignId: campaign.id,
      moduleId,
      citation: { chunkId, creatureName: ZOMBIE },
      name: AGATHA,
      prose: { body: 'The risen stand in the lane.' },
    });

    const module = await getModule(moduleId);
    if (module === undefined) throw new Error('module row is missing');
    const result = await runEntityBatch({
      module,
      campaign,
      kind: 'npc',
      targets: [{ name: AGATHA }],
    });

    // THE DESIGN, in one line (docs/11): when the module's own paragraphs
    // DESCRIBE the entity, they are her description and NO run is spent — the
    // module text is not replaced by invented prose, and the row the earlier
    // cast made is left exactly as it was.
    expect(startRunMock).not.toHaveBeenCalled();
    expect(result.failed).toEqual([]);
    expect(result.cast).toEqual([AGATHA]);
    expect(result.produced[0]?.artifactId).toBe(earlier.artifactId);
    const after = await getArtifact(earlier.artifactId);
    expect(after?.body).toBe('The risen stand in the lane.');
  });

  it('a description run the PAGE ate is its own class: `interrupted`, never "the generator refused"', async () => {
    await seedCreature({ bookTitle: 'Bestiary', name: ZOMBIE, hp: 22 });
    const { campaign, moduleId } = await seedModule();
    await runSpineWith(moduleId, campaign);
    await seedPart(moduleId, NAMED_ONLY_PROSE);
    await seedBuiltInPersonas();
    startRunMock.mockResolvedValue('run-1');
    // An interruption is status `failed` with the ENGINE's own classification —
    // NOT `cancelled` (that is the withdrawal above, which stays silent).
    waitForRunStatusMock.mockResolvedValue({
      status: 'failed',
      resultArtifactId: null,
      errorMessage: '',
      failureKind: 'cancelled',
    });

    const module = await getModule(moduleId);
    if (module === undefined) throw new Error('module row is missing');
    const result = await runEntityBatch({
      module,
      campaign,
      kind: 'npc',
      targets: [{ name: AGATHA }],
    });

    const [failure] = result.failed;
    // `interrupted` is the class that says "the page reloaded while this ran",
    // and the run's own classification rides the record beside it.
    expect(failure?.kind).toBe('interrupted');
    expect(failure?.failureKind).toBe('cancelled');
    expect(failure?.runId).toBe('run-1');
    expect(result.cast).toEqual([AGATHA]);
  });

  it('a run that completes without writing anything is its OWN sentence, not the artifact one', async () => {
    await seedCreature({ bookTitle: 'Bestiary', name: ZOMBIE, hp: 22 });
    const { campaign, moduleId } = await seedModule();
    await runSpineWith(moduleId, campaign);
    await seedPart(moduleId, NAMED_ONLY_PROSE);
    await seedBuiltInPersonas();
    startRunMock.mockResolvedValue('run-1');
    // Completed, and nothing to show for it: the anomaly a refill can report.
    // The row is ONE object, kept here — the record's `raw` is asserted by
    // IDENTITY below, because a deep-equal copy would prove nothing about what
    // the reporting layer actually receives.
    const completedEmpty = {
      status: 'completed',
      resultArtifactId: null,
      errorMessage: '',
    };
    waitForRunStatusMock.mockResolvedValue(completedEmpty);

    const module = await getModule(moduleId);
    if (module === undefined) throw new Error('module row is missing');
    const result = await runEntityBatch({
      module,
      campaign,
      kind: 'npc',
      targets: [{ name: AGATHA }],
    });

    // The record is the ONE mapping every failed run goes through (docs/17 rows
    // 128/131) — with the sentence for THIS destination: the artifact existed
    // before the run, so "producing an artifact" would be a lie about it.
    const [failure] = result.failed;
    expect(failure).toEqual({
      name: AGATHA,
      kind: 'run-not-completed',
      message: 'the run completed without writing the description',
      runId: 'run-1',
      status: 'completed',
      errorMessage: '',
      raw: completedEmpty,
    });
    expect(failure?.raw).toBe(completedEmpty);
    // The cast still landed: the row exists, and the entity is reported as a
    // cast AND as a failed description — the one case that appears in both.
    expect(result.cast).toEqual([AGATHA]);
    expect(result.produced).toHaveLength(1);
  });
});
