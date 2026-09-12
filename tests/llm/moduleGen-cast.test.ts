import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { listArtifactsByCampaign } from '@/db/artifactRepo';
import { putChunks } from '@/db/chunkRepo';
import { db } from '@/db/db';
import { getModule, patchModule, saveModule } from '@/db/moduleRepo';
import { createRulebook } from '@/db/rulebookRepo';
import { updateSettings } from '@/db/settingsRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { runEntityBatch } from '@/features/modules/entity-batch';
import { runSpine, spineReplySchema } from '@/llm/moduleGen';
import { sha256Hex } from '@/lib/hash';
import { spineEntityKindsClause } from '@/llm/promptStyles';
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

vi.mock('@/llm/runEngine', () => ({
  runEngine: { on: () => () => undefined, startRun: startRunMock },
  waitForRunStatus: waitForRunStatusMock,
}));

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
      level: '1',
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
async function seedModule(): Promise<{ campaign: Campaign; moduleId: string }> {
  const campaign = await createCampaign({ name: 'Millford', system: 'dnd5e' });
  const saved = await saveModule(
    createModule({
      campaignId: campaign.id,
      title: 'The Walking Mill',
      concept: 'The village dead rise, and one of them is somebody’s aunt.',
      levelMin: 1,
      levelMax: 1,
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
    expect(prompt).not.toContain('bestiary');
  });

  it('the delta with a library is EXACTLY the bestiary clause, appended to the entity-kind bullet', async () => {
    await seedCreature({ bookTitle: 'Bestiary', name: ZOMBIE, hp: 22 });
    const { campaign, moduleId } = await seedModule();
    await runSpineWith(moduleId, campaign);

    const prompt = spinePrompt();
    const withLibrary = spineEntityKindsClause(true);
    const withoutLibrary = spineEntityKindsClause(false);
    expect(prompt).toContain(withLibrary);
    // The vocabulary itself is byte-identical with and without a library: the
    // delta is exactly the appended clause and nothing else.
    expect(withLibrary.startsWith(withoutLibrary)).toBe(true);
    const clause = withLibrary.slice(withoutLibrary.length);
    expect(clause).toContain('bestiary');
    expect(clause).toContain('Aunt Agatha');
    expect(clause).toContain('generic mob that is not a character');
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
