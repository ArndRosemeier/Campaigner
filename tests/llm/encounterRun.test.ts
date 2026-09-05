import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { putChunks } from '@/db/chunkRepo';
import { createPackBook, createRulebook, finalizePackBook } from '@/db/rulebookRepo';
import { createArtifact, getArtifact, listArtifactsByCampaign } from '@/db/artifactRepo';
import { getRun, updateRun } from '@/db/runRepo';
import { saveSettings } from '@/db/settingsRepo';
import { seedBattleFromEncounter } from '@/db/battleSeed';
import { resolveMonsterEntryWithRepos } from '@/db/monsterResolve';
import {
  createPersona,
  createModule as buildModule,
  defaultSettings,
  ruleChunkSchema,
  stampNewEntity,
  statBlockSchema,
  type Id,
  type Persona,
  type StatBlock,
} from '@/domain';
import { createModule as persistModule } from '@/db/moduleRepo';
import { sha256Hex } from '@/lib/hash';
import { runEngine } from '@/llm/runEngine';
import { clearDatabase } from '../db/helpers';

/**
 * Encounter Smith stat sources (07-MILESTONE-3 M3-B + fix-02): the retrieve
 * step adds a statblock-restricted search; a draft monster citing
 * `sourceChunkIndex` persists as { type: 'rulebook', chunkId }, and since
 * fix-02 an embedded statBlock is MATERIALIZED into a real NPC artifact and
 * persists as { type: 'npc-ref', artifactId } — a name-only monster is a
 * rejected draft (one repair, then loud per autonomy), never a silent
 * { type: 'none' }.
 */

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
  listImageModels: vi.fn(),
}));

vi.mock('@/search', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...(actual as object), searchRules: vi.fn() };
});

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);
const { searchRules } = await import('@/search');
const searchRulesMock = vi.mocked(searchRules);

const TROLL_TEXT = 'Troll, regenerates unless burned.';

function monsterBlock(overrides: Partial<StatBlock> = {}): StatBlock {
  return statBlockSchema.parse({
    system: 'dnd5e',
    level: '1',
    size: 'Medium',
    creatureType: 'humanoid (cultist)',
    ac: 12,
    acNote: '',
    hp: 9,
    hpFormula: '2d8',
    speed: '30 ft.',
    abilities: { str: 11, dex: 12, con: 10, int: 10, wis: 11, cha: 10 },
    saves: '',
    skills: '',
    senses: '',
    languages: '',
    traits: [],
    actions: [],
    reactions: [],
    legendary: [],
    extras: {},
    ...overrides,
  });
}

const DRAFT = {
  name: 'Ambush at the ford',
  summary: 'A bridge ambush.',
  suggestedTags: ['ambush'],
  body: '# Ambush at the ford',
  difficulty: 'deadly',
  levelHint: '5',
  monsters: [
    { name: 'Troll', count: 2, notes: 'cut off the retreat', sourceChunkIndex: 0 },
    { name: 'Cultist', count: 4, notes: 'netters', statBlock: monsterBlock() },
  ],
  terrain: 'river crossing',
  tactics: 'hit and run',
  treasure: 'none',
};

async function seed(): Promise<{
  campaign: Awaited<ReturnType<typeof createCampaign>>;
  persona: Persona;
  trollChunkId: Id;
}> {
  const campaign = await createCampaign({ name: 'Encounters', system: 'dnd5e' });
  const persona = createPersona({
    slug: 'encounter-smith-test',
    name: 'Encounter Smith',
    description: 'test',
    systemPrompt: 'You design encounters.',
    mode: 'generate',
    producesKind: 'encounter',
    builtIn: true,
  });
  const book = await createRulebook({ title: 'Bestiary', system: 'dnd5e', filename: 'bestiary.pdf' });
  await putChunks([
    ruleChunkSchema.parse({
      ...stampNewEntity(),
      bookId: book.id,
      pageStart: 132,
      pageEnd: 132,
      chunkType: 'statblock',
      headingPath: ['Troll'],
      text: TROLL_TEXT,
      statBlock: statBlockSchema.parse({
        system: 'dnd5e',
        level: '5',
        size: 'Large',
        creatureType: 'giant',
        ac: 15,
        acNote: '',
        hp: 84,
        hpFormula: '',
        speed: '',
        abilities: { str: 18, dex: 10, con: 16, int: 6, wis: 10, cha: 8 },
        saves: '',
        skills: '',
        senses: '',
        languages: '',
        traits: [],
        actions: [],
        reactions: [],
        legendary: [],
        extras: {},
      }),
      contentHash: await sha256Hex(TROLL_TEXT),
    }),
  ]);
  await saveSettings({ ...defaultSettings(), openRouterApiKey: 'test-key' });
  return { campaign, persona, trollChunkId: (await putChunksFirstId()) ?? '' };
}

/** First (only) chunk id — seeded via putChunks above. */
async function putChunksFirstId(): Promise<Id | undefined> {
  const { db } = await import('@/db/db');
  const chunks = await db.chunks.toArray();
  return chunks[0]?.id;
}

/** Seeds a ready pack book (12-BESTIARY-PACKS) with one validated creature chunk. */
async function seedPackBook(title: string): Promise<Id> {
  const book = await createPackBook({ title, system: 'dnd5e', filename: `${title}.zip` });
  await finalizePackBook(book.id, {
    sourceId: 'foundry-pf2e',
    license: 'Community Use Policy',
    entriesImported: 1,
    entriesSkipped: 0,
    entriesFailed: 0,
  });
  const text = 'Goblin Boss, humanoid, agile commander.';
  await putChunks([
    ruleChunkSchema.parse({
      ...stampNewEntity(),
      bookId: book.id,
      pageStart: 1,
      pageEnd: 1,
      chunkType: 'statblock',
      headingPath: ['Goblin Boss'],
      text,
      statBlock: statBlockSchema.parse({
        system: 'dnd5e',
        level: '1',
        size: 'Small',
        creatureType: 'humanoid (goblinoid)',
        ac: 17,
        acNote: '',
        hp: 21,
        hpFormula: '3d6 + 11',
        speed: '30 ft.',
        abilities: { str: 14, dex: 14, con: 10, int: 10, wis: 8, cha: 8 },
        saves: '',
        skills: '',
        senses: 'darkvision 60 ft.',
        languages: 'Common, Goblin',
        traits: [],
        actions: [],
        reactions: [],
        legendary: [],
        extras: { Traits: 'humanoid, goblinoid' },
      }),
      contentHash: await sha256Hex(text),
    }),
  ]);
  const { db } = await import('@/db/db');
  const chunk = (await db.chunks.where('bookId').equals(book.id).first());
  return chunk?.id ?? '';
}

/**
 * Seeds a ready pack book with `count` validated creatures named
 * "Creature 001"… whose printed level (and levelSort) is 1..count — a
 * >ROSTER_LIMIT bestiary import, so the 300-line prompt window's ordering
 * becomes observable in the run's draft prompt.
 */
async function seedLargePackBook(count: number): Promise<void> {
  const book = await createPackBook({ title: 'Huge Bestiary Pack', system: 'dnd5e', filename: 'huge.zip' });
  await finalizePackBook(book.id, {
    sourceId: 'foundry-pf2e',
    license: 'Community Use Policy',
    entriesImported: count,
    entriesSkipped: 0,
    entriesFailed: 0,
  });
  const chunks = [];
  for (let level = 1; level <= count; level += 1) {
    const name = `Creature ${String(level).padStart(3, '0')}`;
    const text = `${name}, a ladder creature at level ${String(level)}.`;
    chunks.push(
      ruleChunkSchema.parse({
        ...stampNewEntity(),
        bookId: book.id,
        pageStart: level,
        pageEnd: level,
        chunkType: 'statblock',
        headingPath: [name],
        text,
        statBlock: statBlockSchema.parse({
          system: 'dnd5e',
          level: String(level),
          size: 'Small',
          creatureType: 'humanoid',
          ac: 10,
          acNote: '',
          hp: 1,
          hpFormula: '',
          speed: '',
          abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
          saves: '',
          skills: '',
          senses: '',
          languages: '',
          traits: [],
          actions: [],
          reactions: [],
          legendary: [],
          extras: {},
        }),
        contentHash: await sha256Hex(text),
      }),
    );
  }
  await putChunks(chunks);
}

type EncounterCampaign = Awaited<ReturnType<typeof createCampaign>>;

/**
 * Runs a stub-fill Smith run against the seeded pack with a stub encounter
 * carrying the given levelHint/module ownership, and resolves with the run id
 * plus the draft prompt's user content (where the roster section renders).
 * The draft cites `sourceName` so the resolution path is exercised too.
 */
async function runSmithAgainst(
  campaign: EncounterCampaign,
  persona: Persona,
  stub: { levelHint: string; moduleId?: Id },
  sourceName: string,
): Promise<{ runId: Id; userContent: string }> {
  const stubArtifact = await createArtifact({
    campaignId: campaign.id,
    kind: 'encounter',
    name: 'Window Probe',
    ...(stub.moduleId === undefined ? {} : { moduleId: stub.moduleId }),
    data: {
      difficulty: '',
      levelHint: stub.levelHint,
      monsters: [],
      terrain: '',
      tactics: '',
      treasure: '',
      mapImageId: null,
      layout: null,
    },
  });
  const callIndex = chatMock.mock.calls.length;
  chatMock.mockResolvedValue({
    text: JSON.stringify({
      ...DRAFT,
      monsters: [{ name: sourceName, count: 1, notes: '', sourceName }],
    }),
    modelUsed: 'test-model',
    fallback: null,
  });
  const runId = await runEngine.startRun({
    campaign,
    persona,
    brief: 'A probe encounter',
    autonomy: 'auto',
    pinnedChunkIds: [],
    targetArtifactId: stubArtifact.id,
  });
  await vi.waitFor(async () => {
    expect((await getRun(runId))?.status).toBe('completed');
  });
  const rawContent =
    chatMock.mock.calls[callIndex]?.[0].find((message) => message.role === 'user')?.content ?? '';
  const userContent = typeof rawContent === 'string' ? rawContent : '';
  return { runId, userContent };
}

/** Index of a roster line inside the prompt — asserting relative order. */
function rosterLineAt(userContent: string, line: string): number {
  const at = userContent.indexOf(line);
  expect(at).toBeGreaterThanOrEqual(0);
  return at;
}


/** Looks up THE mob artifact created for `chunkId` — the get-or-create is
 *  idempotent, so at most one exists per campaign (the arc's core pin). */
async function mobArtifactIdOf(campaignId: Id, chunkId: Id): Promise<Id> {
  const mob = (await listArtifactsByCampaign(campaignId)).find(
    (row) => row.kind === 'npc' && row.data.monsterChunkId === chunkId,
  );
  if (mob === undefined) throw new Error(`no mob artifact for chunk ${chunkId}`);
  return mob.id;
}

describe('encounter runs (M3-B)', () => {
  beforeEach(async () => {
    await clearDatabase();
    chatMock.mockReset();
    searchRulesMock.mockReset();
  });

  it('cites rulebook chunks and materializes inline stat blocks into NPC artifacts (fix-02)', async () => {
    const { campaign, persona, trollChunkId } = await seed();
    const { db } = await import('@/db/db');
    const chunk = await db.chunks.get(trollChunkId);
    expect(chunk).toBeDefined();
    searchRulesMock.mockResolvedValue(
      chunk !== undefined ? [{ chunk, score: 1, source: 'keyword' as const }] : [],
    );
    chatMock.mockResolvedValue({ text: JSON.stringify(DRAFT), modelUsed: 'test-model', fallback: null });

    // startRun resolves with the run id once the row exists.
    const runId = await runEngine.startRun({
      campaign,
      persona,
      brief: 'A bridge ambush for level 5',
      autonomy: 'auto',
      pinnedChunkIds: [],
    });

    // The retrieve step ran a statblock-restricted second search (startRun
    // resolves before async execution, so wait for the search calls).
    await vi.waitFor(() => {
      expect(searchRulesMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    const statblockCall = searchRulesMock.mock.calls.find(
      (call) => call[1]?.chunkTypes?.[0] === 'statblock',
    );
    expect(statblockCall).toBeDefined();
    // fix-02 (decision 3): the citable search excludes unparsed chunks.
    expect(statblockCall?.[1]?.hasStatBlock).toBe(true);
    // The citable pool is campaign-scoped: another system's books (pack or
    // PDF) are never searchable by this run.
    expect(statblockCall?.[1]?.system).toBe('dnd5e');
    expect(searchRulesMock.mock.calls[0]?.[1]?.system).toBe('dnd5e');
    // The draft prompt teaches the citation scheme.
    const draftCall = chatMock.mock.calls[0];
    const userContent = draftCall?.[0].find((message) => message.role === 'user')?.content ?? '';
    expect(userContent).toContain('Stat-block excerpts');
    expect(userContent).toContain('sourceChunkIndex');

    await vi.waitFor(async () => {
      const stored = await getRun(runId);
      expect(stored?.status).toBe('completed');
    });
    const storedRun = await getRun(runId);

    const artifact = await getArtifact(storedRun?.resultArtifactId ?? '');
    expect(artifact?.kind).toBe('encounter');
    if (artifact?.kind !== 'encounter') return;
    const monsters = artifact.data.monsters;
    expect(monsters[0]?.source).toEqual({ type: 'rulebook', chunkId: trollChunkId, mobArtifactId: await mobArtifactIdOf(campaign.id, trollChunkId) });
    // fix-02 (decision 1): the uncited monster's inline block materializes
    // into a REAL NPC artifact linked via npc-ref — never inline, never none.
    expect(monsters[1]?.source.type).toBe('npc-ref');
    if (monsters[1]?.source.type !== 'npc-ref') return;
    const npc = await getArtifact(monsters[1].source.artifactId);
    expect(npc?.kind).toBe('npc');
    expect(npc?.name).toBe('Cultist');
    if (npc?.kind !== 'npc') return;
    expect(npc.data.statBlock?.creatureType).toBe('humanoid (cultist)');
    expect(npc.data.statBlock?.hp).toBe(9);
    expect(npc.summary).toBe('netters');
    // The encounter entry resolves with a full block through the npc-ref case.
    const resolved = await resolveMonsterEntryWithRepos(monsters[1]);
    expect(resolved.origin).toBe('NPC: Cultist');
    expect(resolved.statBlock?.hp).toBe(9);
  });

  it('two runs citing the same chunk share ONE mob artifact (idempotent get-or-create per chunkId)', async () => {
    const { campaign, persona } = await seed();
    const goblinChunkId = await seedPackBook('Dnd5e Bestiary Pack');
    searchRulesMock.mockResolvedValue([]);
    const first = await runSmithAgainst(campaign, persona, { levelHint: '1' }, 'Goblin Boss');
    const second = await runSmithAgainst(campaign, persona, { levelHint: '2' }, 'Goblin Boss');

    async function rulebookSourceOf(runId: Id) {
      const stored = await getRun(runId);
      const artifact = await getArtifact(stored?.resultArtifactId ?? '');
      if (artifact?.kind !== 'encounter') throw new Error('encounter missing');
      const source = artifact.data.monsters[0]?.source;
      if (source?.type !== 'rulebook') throw new Error('not a rulebook source');
      return source;
    }
    const firstSource = await rulebookSourceOf(first.runId);
    const secondSource = await rulebookSourceOf(second.runId);
    expect(firstSource.chunkId).toBe(goblinChunkId);
    expect(secondSource.mobArtifactId).toBe(firstSource.mobArtifactId);

    // Exactly ONE mob artifact exists for the chunk — roster name + marker,
    // with NO stat text copied from the chunk (the chunk stays the truth).
    const mobs = (await listArtifactsByCampaign(campaign.id)).filter(
      (row) => row.kind === 'npc' && row.data.monsterChunkId === goblinChunkId,
    );
    expect(mobs).toHaveLength(1);
    const mob = mobs[0];
    if (mob?.kind !== 'npc') throw new Error('not an npc');
    expect(mob.id).toBe(firstSource.mobArtifactId);
    expect(mob.name).toBe('Goblin Boss');
    expect(mob.data.statBlock).toBeNull();
    expect(mob.body).toBe('');
    expect(mob.summary).toBe('');
  });

  it('a materialized monster seeds fighting tokens backed by the NPC artifact (fix-02)', async () => {
    const { campaign, persona, trollChunkId } = await seed();
    const { db } = await import('@/db/db');
    const chunk = await db.chunks.get(trollChunkId);
    searchRulesMock.mockResolvedValue(
      chunk !== undefined ? [{ chunk, score: 1, source: 'keyword' as const }] : [],
    );
    chatMock.mockResolvedValue({ text: JSON.stringify(DRAFT), modelUsed: 'test-model', fallback: null });
    const runId = await runEngine.startRun({
      campaign,
      persona,
      brief: 'A bridge ambush for level 5',
      autonomy: 'auto',
      pinnedChunkIds: [],
    });
    await vi.waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });
    const storedRun = await getRun(runId);
    const encounterId = storedRun?.resultArtifactId;
    expect(encounterId).not.toBeNull();

    const { battle, statless } = await seedBattleFromEncounter(campaign.id, crypto.randomUUID(), encounterId ?? '');
    const cultist = battle.board.tokens.filter((token) => token.label.startsWith('Cultist'));
    expect(cultist).toHaveLength(4);
    const artifact = await getArtifact(encounterId ?? '');
    if (artifact?.kind !== 'encounter') throw new Error('encounter missing');
    const source = artifact.data.monsters[1]?.source;
    if (source?.type !== 'npc-ref') throw new Error('cultist not npc-ref');
    for (const token of cultist) {
      expect(token.artifactId).toBe(source.artifactId);
      // A fighting token: fresh max HP from the materialized block — not an
      // HP-less statless token (the seed report lists none).
      expect(token.currentHp).toBe(9);
    }
    expect(statless).toEqual([]);
    const troll = battle.board.tokens.filter((token) => token.label.startsWith('Troll'));
    expect(troll).toHaveLength(2);
    expect(troll[0]?.currentHp).toBe(84);
  });

  it('fills a targeted stub encounter in place, preserving identity, links and battlemap', async () => {
    const { campaign, persona, trollChunkId } = await seed();
    const { db } = await import('@/db/db');
    const chunk = await db.chunks.get(trollChunkId);
    searchRulesMock.mockResolvedValue(
      chunk !== undefined ? [{ chunk, score: 1, source: 'keyword' as const }] : [],
    );
    const bridge = await createArtifact({ campaignId: campaign.id, kind: 'location', name: 'Old Bridge' });
    const mapImageId = crypto.randomUUID();
    const stub = await createArtifact({
      campaignId: campaign.id,
      kind: 'encounter',
      name: 'Ford Ambush',
      summary: 'Stub summary',
      tags: ['module:Ruins'],
      links: [{ targetId: bridge.id, relation: 'at' }],
      data: {
        difficulty: '', levelHint: '', monsters: [], terrain: '', tactics: '', treasure: '',
        mapImageId, layout: null,
      },
    });
    chatMock.mockResolvedValue({ text: JSON.stringify(DRAFT), modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun({
      campaign,
      persona,
      brief: 'A bridge ambush for level 5',
      autonomy: 'auto',
      pinnedChunkIds: [],
      targetArtifactId: stub.id,
    });
    await vi.waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });
    expect((await getRun(runId))?.resultArtifactId).toBe(stub.id);

    const updated = await getArtifact(stub.id);
    // Identity survives: the model's name becomes an alias, module ownership
    // and links stay, and no second artifact is created.
    expect(updated?.name).toBe('Ford Ambush');
    expect(updated?.aliases).toContain('Ambush at the ford');
    expect(updated?.tags).toEqual(['module:Ruins']);
    expect(updated?.links).toEqual([{ targetId: bridge.id, relation: 'at' }]);
    if (updated?.kind !== 'encounter') throw new Error('encounter missing');
    expect(updated.summary).toBe(DRAFT.summary);
    expect(updated.body).toBe(DRAFT.body);
    expect(updated.data.difficulty).toBe('deadly');
    expect(updated.data.monsters[0]?.source).toEqual({ type: 'rulebook', chunkId: trollChunkId, mobArtifactId: await mobArtifactIdOf(campaign.id, trollChunkId) });
    // fix-02 (decision 1): the IN-PLACE Smith path materializes too.
    expect(updated.data.monsters[1]?.source.type).toBe('npc-ref');
    const npcsAfter = (await listArtifactsByCampaign(campaign.id)).filter(
      (row) => row.kind === 'npc',
    );
    expect(npcsAfter.map((row) => row.name)).toContain('Cultist');
    // The (not yet generated) battlemap is untouched by a content run.
    expect(updated.data.mapImageId).toBe(mapImageId);
    expect(updated.data.layout).toBeNull();
  });

  it('grounds the draft in the pack roster and resolves a sourceName citation (12-BESTIARY-PACKS §7)', async () => {
    const { campaign, persona } = await seed();
    const goblinChunkId = await seedPackBook('Dnd5e Bestiary Pack');
    const { db } = await import('@/db/db');
    const packChunk = await db.chunks.get(goblinChunkId);
    expect(packChunk).toBeDefined();
    searchRulesMock.mockResolvedValue([]);
    chatMock.mockResolvedValue({
      text: JSON.stringify({
        ...DRAFT,
        monsters: [{ name: 'Goblin Boss', count: 2, notes: 'shields up', sourceName: 'Goblin Boss' }],
      }),
      modelUsed: 'test-model',
      fallback: null,
    });

    const runId = await runEngine.startRun({
      campaign,
      persona,
      brief: 'A goblin ambush for level 1',
      autonomy: 'auto',
      pinnedChunkIds: [],
    });

    // The draft prompt carries the roster section with the pack creature.
    await vi.waitFor(() => {
      expect(chatMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    });
    const userContent =
      chatMock.mock.calls[0]?.[0].find((message) => message.role === 'user')?.content ?? '';
    expect(userContent).toContain('Bestiary roster');
    expect(userContent).toContain('Goblin Boss (1, humanoid, goblinoid)');
    expect(userContent).toContain('sourceName');

    await vi.waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });
    const storedRun = await getRun(runId);
    const artifact = await getArtifact(storedRun?.resultArtifactId ?? '');
    if (artifact?.kind !== 'encounter') throw new Error('encounter missing');
    expect(artifact.data.monsters[0]?.source).toEqual({
      type: 'rulebook',
      chunkId: goblinChunkId,
      mobArtifactId: await mobArtifactIdOf(campaign.id, goblinChunkId),
    });
  });

  it('fails loudly after one repair attempt when a sourceName misses the roster', async () => {
    const { campaign, persona } = await seed();
    await seedPackBook('Dnd5e Bestiary Pack');
    searchRulesMock.mockResolvedValue([]);
    chatMock.mockResolvedValue({
      text: JSON.stringify({
        ...DRAFT,
        monsters: [{ name: 'Shadow Beast', count: 1, notes: '', sourceName: 'Not A Creature' }],
      }),
      modelUsed: 'test-model',
      fallback: null,
    });

    const runId = await runEngine.startRun({
      campaign,
      persona,
      brief: 'A shadow ambush',
      autonomy: 'auto',
      pinnedChunkIds: [],
    });

    await vi.waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('failed');
    });
    const storedRun = await getRun(runId);
    // Exactly one repair attempt, then the run fails with the named issue —
    // never a silent fallback to name-only.
    expect(chatMock).toHaveBeenCalledTimes(2);
    const repairContent =
      chatMock.mock.calls[1]?.[0].at(-1)?.content ?? '';
    expect(repairContent).toContain('left monsters without a resolvable stat-block source');
    expect(repairContent).toContain('Not A Creature');
    expect(storedRun?.errorMessage).toContain('sourceName "Not A Creature" is not in the bestiary roster');
    expect(storedRun?.resultArtifactId).toBeNull();
  });

  it('fails the run loudly when a Smith monster has no stat source at all (fix-02 decision 2)', async () => {
    const { campaign, persona, trollChunkId } = await seed();
    const { db } = await import('@/db/db');
    const chunk = await db.chunks.get(trollChunkId);
    searchRulesMock.mockResolvedValue(
      chunk !== undefined ? [{ chunk, score: 1, source: 'keyword' as const }] : [],
    );
    chatMock.mockResolvedValue({
      text: JSON.stringify({
        ...DRAFT,
        monsters: [
          { name: 'Troll', count: 2, notes: 'cut off the retreat', sourceChunkIndex: 0 },
          { name: 'Fodder', count: 8, notes: 'unnamed rabble' },
        ],
      }),
      modelUsed: 'test-model',
      fallback: null,
    });

    const runId = await runEngine.startRun({
      campaign,
      persona,
      brief: 'A bridge ambush for level 5',
      autonomy: 'auto',
      pinnedChunkIds: [],
    });

    await vi.waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('failed');
    });
    const storedRun = await getRun(runId);
    // One repair attempt naming the offender, then the run fails — never a
    // silent {type:'none'} finalize.
    expect(chatMock).toHaveBeenCalledTimes(2);
    const repairContent = chatMock.mock.calls[1]?.[0].at(-1)?.content ?? '';
    expect(repairContent).toContain('Fodder');
    expect(repairContent).toContain('inline "statBlock"');
    expect(storedRun?.errorMessage).toContain('Fodder');
    expect(storedRun?.resultArtifactId).toBeNull();
    // No NPC artifact was materialized for the failed run.
    expect((await listArtifactsByCampaign(campaign.id)).filter((row) => row.kind === 'npc')).toEqual([]);
  });

  it('a repaired draft that inlines the missing block completes with an npc-ref (fix-02)', async () => {
    const { campaign, persona, trollChunkId } = await seed();
    const { db } = await import('@/db/db');
    const chunk = await db.chunks.get(trollChunkId);
    searchRulesMock.mockResolvedValue(
      chunk !== undefined ? [{ chunk, score: 1, source: 'keyword' as const }] : [],
    );
    chatMock
      .mockResolvedValueOnce({
        text: JSON.stringify({
          ...DRAFT,
          monsters: [
            { name: 'Troll', count: 2, notes: '', sourceChunkIndex: 0 },
            { name: 'Fodder', count: 8, notes: 'unnamed rabble' },
          ],
        }),
        modelUsed: 'test-model',
        fallback: null,
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          ...DRAFT,
          monsters: [
            { name: 'Troll', count: 2, notes: '', sourceChunkIndex: 0 },
            { name: 'Fodder', count: 8, notes: 'unnamed rabble', statBlock: monsterBlock({ creatureType: 'beast (rat swarm)', hp: 2 }) },
          ],
        }),
        modelUsed: 'test-model',
        fallback: null,
      });

    const runId = await runEngine.startRun({
      campaign,
      persona,
      brief: 'A bridge ambush for level 5',
      autonomy: 'auto',
      pinnedChunkIds: [],
    });

    await vi.waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });
    const storedRun = await getRun(runId);
    const artifact = await getArtifact(storedRun?.resultArtifactId ?? '');
    if (artifact?.kind !== 'encounter') throw new Error('encounter missing');
    const source = artifact.data.monsters[1]?.source;
    expect(source?.type).toBe('npc-ref');
    if (source?.type !== 'npc-ref') return;
    const npc = await getArtifact(source.artifactId);
    expect(npc?.name).toBe('Fodder');
    if (npc?.kind !== 'npc') return;
    expect(npc.data.statBlock?.hp).toBe(2);
  });

  it('links an existing same-name NPC instead of duplicating it (fix-02 decision 1)', async () => {
    const { campaign, persona, trollChunkId } = await seed();
    const { db } = await import('@/db/db');
    const chunk = await db.chunks.get(trollChunkId);
    searchRulesMock.mockResolvedValue(
      chunk !== undefined ? [{ chunk, score: 1, source: 'keyword' as const }] : [],
    );
    // A statless twin receives the materialized block; a statful one keeps it.
    const statlessCultist = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Cultist',
      data: { appearance: '', personality: '', statBlock: null },
    });
    const statfulOgre = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Ogre',
      summary: 'The bridge toll keeper',
      data: { appearance: '', personality: '', statBlock: monsterBlock({ hp: 99, creatureType: 'giant' }) },
    });
    chatMock.mockResolvedValue({
      text: JSON.stringify({
        ...DRAFT,
        monsters: [
          { name: 'Cultist', count: 4, notes: 'netters', statBlock: monsterBlock() },
          { name: 'Ogre', count: 1, notes: 'toll keeper', statBlock: monsterBlock({ hp: 1, creatureType: 'wrong' }) },
        ],
      }),
      modelUsed: 'test-model',
      fallback: null,
    });

    const runId = await runEngine.startRun({
      campaign,
      persona,
      brief: 'A bridge ambush for level 5',
      autonomy: 'auto',
      pinnedChunkIds: [],
    });

    await vi.waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });
    const storedRun = await getRun(runId);
    const artifact = await getArtifact(storedRun?.resultArtifactId ?? '');
    if (artifact?.kind !== 'encounter') throw new Error('encounter missing');
    const [cultistSource, ogreSource] = artifact.data.monsters.map((monster) => monster.source);
    expect(cultistSource).toEqual({ type: 'npc-ref', artifactId: statlessCultist.id });
    expect(ogreSource).toEqual({ type: 'npc-ref', artifactId: statfulOgre.id });
    // No duplicates were created.
    const npcs = (await listArtifactsByCampaign(campaign.id)).filter((row) => row.kind === 'npc');
    expect(npcs).toHaveLength(2);
    // The statless twin received the materialized block (revisioned persona save).
    const filledCultist = await getArtifact(statlessCultist.id);
    if (filledCultist?.kind !== 'npc') throw new Error('cultist missing');
    expect(filledCultist.data.statBlock?.hp).toBe(9);
    // An existing stat block is never overwritten.
    const keptOgre = await getArtifact(statfulOgre.id);
    if (keptOgre?.kind !== 'npc') throw new Error('ogre missing');
    expect(keptOgre.data.statBlock?.hp).toBe(99);
    expect(keptOgre.data.statBlock?.creatureType).toBe('giant');
    expect(keptOgre.summary).toBe('The bridge toll keeper');
  });

  it('collapses two same-name monsters onto ONE materialized NPC artifact and resolves both (fix-02)', async () => {
    const { campaign, persona } = await seed();
    // No chunk hits and no pack roster: both monsters must materialize inline.
    searchRulesMock.mockResolvedValue([]);
    chatMock.mockResolvedValue({
      text: JSON.stringify({
        ...DRAFT,
        monsters: [
          { name: 'Orc Brute', count: 2, notes: 'front line', statBlock: monsterBlock({ creatureType: 'humanoid (orc)', hp: 11 }) },
          { name: 'Orc Brute', count: 3, notes: 'flankers', statBlock: monsterBlock({ creatureType: 'humanoid (orc)', hp: 13 }) },
        ],
      }),
      modelUsed: 'test-model',
      fallback: null,
    });

    const runId = await runEngine.startRun({
      campaign,
      persona,
      brief: 'An orc ambush for level 1',
      autonomy: 'auto',
      pinnedChunkIds: [],
    });
    await vi.waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });

    const storedRun = await getRun(runId);
    const artifact = await getArtifact(storedRun?.resultArtifactId ?? '');
    if (artifact?.kind !== 'encounter') throw new Error('encounter missing');
    const [first, second] = artifact.data.monsters;
    expect(first?.source.type).toBe('npc-ref');
    expect(second?.source.type).toBe('npc-ref');
    if (first?.source.type !== 'npc-ref' || second?.source.type !== 'npc-ref') return;
    // fix-02 (decision 1, reuse rule): one name per run materializes ONE NPC —
    // the second entry reuses the first artifact via the materialize cache.
    expect(second.source.artifactId).toBe(first.source.artifactId);
    const npcs = (await listArtifactsByCampaign(campaign.id)).filter((row) => row.kind === 'npc');
    expect(npcs).toHaveLength(1);
    expect(npcs[0]?.name).toBe('Orc Brute');
    // Resolution works for BOTH entries through the shared artifact.
    for (const monster of [first, second]) {
      const resolved = await resolveMonsterEntryWithRepos(monster);
      expect(resolved.origin).toBe('NPC: Orc Brute');
      expect(resolved.statBlock).not.toBeNull();
    }
  });

  it('fails the run loudly when the persisted retrieve output is corrupt instead of materializing from empty maps', async () => {
    const { campaign, persona } = await seed();
    searchRulesMock.mockResolvedValue([]);
    chatMock.mockResolvedValue({
      text: JSON.stringify({
        ...DRAFT,
        monsters: [{ name: 'Cultist', count: 4, notes: 'netters', statBlock: monsterBlock() }],
      }),
      modelUsed: 'test-model',
      fallback: null,
    });

    // Manual autonomy parks the run at the draft checkpoint, so the retrieve
    // output is at rest before finalize consumes it.
    const runId = await runEngine.startRun({
      campaign,
      persona,
      brief: 'A cult ambush',
      autonomy: 'manual',
      pinnedChunkIds: [],
    });
    await vi.waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('awaiting_user');
    });

    // Corrupt the retrieve step's persisted output at rest (a broken hand
    // edit): the citation field finalize consumes is no longer an array.
    const run = await getRun(runId);
    if (run === undefined) throw new Error('run missing');
    const retrieveStep = run.steps.find((step) => step.name === 'retrieve');
    if (retrieveStep === undefined) throw new Error('retrieve step missing');
    await updateRun(runId, {
      steps: run.steps.map((step) =>
        step === retrieveStep
          ? {
              ...retrieveStep,
              output: {
                ...(retrieveStep.output as Record<string, unknown>),
                statblockChunkIds: 'not-an-array',
              },
            }
          : step,
      ),
    });

    await runEngine.approve(runId, {
      campaign,
      persona,
      brief: 'A cult ambush',
      autonomy: 'manual',
      pinnedChunkIds: [],
    });

    await vi.waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('failed');
    });
    const storedRun = await getRun(runId);
    // The zod boundary throws loudly — the run fails with a named error
    // instead of finalizing against silently-empty citation maps.
    expect(storedRun?.errorMessage).toContain('retrieve output');
    expect(storedRun?.resultArtifactId).toBeNull();
    // No NPC was materialized from the garbage.
    expect((await listArtifactsByCampaign(campaign.id)).filter((row) => row.kind === 'npc')).toEqual([]);
  });

  it('a pinned statblock chunk is citable even when it does not rank (pinned-citability gap)', async () => {
    const { campaign, persona, trollChunkId } = await seed();
    // The pinned chunk does NOT rank: both searches come back empty, so only
    // the pin could ever make it citable.
    searchRulesMock.mockResolvedValue([]);
    chatMock.mockResolvedValue({ text: JSON.stringify(DRAFT), modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun({
      campaign,
      persona,
      brief: 'A bridge ambush for level 5',
      autonomy: 'auto',
      pinnedChunkIds: [trollChunkId],
    });

    // The draft prompt lists the PINNED chunk as citation excerpt [0].
    await vi.waitFor(() => {
      expect(chatMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    });
    const userContent =
      chatMock.mock.calls[0]?.[0].find((message) => message.role === 'user')?.content ?? '';
    expect(userContent).toContain('Stat-block excerpts');
    expect(userContent).toContain('[0] Bestiary p.132 — Troll');

    await vi.waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });
    // The pinned chunk persisted as the citable pool (index 0)…
    const storedRun = await getRun(runId);
    const retrieveStep = storedRun?.steps.find((step) => step.name === 'retrieve');
    expect((retrieveStep?.output as { statblockChunkIds?: Id[] }).statblockChunkIds).toEqual([
      trollChunkId,
    ]);
    const artifact = await getArtifact(storedRun?.resultArtifactId ?? '');
    if (artifact?.kind !== 'encounter') throw new Error('encounter missing');
    // …and sourceChunkIndex 0 resolved through finalize to the pinned chunk.
    expect(artifact.data.monsters[0]?.source).toEqual({ type: 'rulebook', chunkId: trollChunkId, mobArtifactId: await mobArtifactIdOf(campaign.id, trollChunkId) });
  });

  it('a pinned null-statBlock chunk stays excerpt-context-only (fix-02 pool exclusion)', async () => {
    const { campaign, persona, trollChunkId } = await seed();
    const { db } = await import('@/db/db');
    const troll = await db.chunks.get(trollChunkId);
    if (troll === undefined) throw new Error('troll chunk missing');
    const sectionText = 'Grapple rules for shoving and pinning.';
    const sectionChunk = ruleChunkSchema.parse({
      ...stampNewEntity(),
      bookId: troll.bookId,
      pageStart: 40,
      pageEnd: 40,
      chunkType: 'section',
      headingPath: ['Appendix', 'Grappling'],
      text: sectionText,
      statBlock: null,
      contentHash: await sha256Hex(sectionText),
    });
    await putChunks([sectionChunk]);
    searchRulesMock.mockResolvedValue([]);
    chatMock.mockResolvedValue({
      text: JSON.stringify({
        ...DRAFT,
        monsters: [{ name: 'Wrestler', count: 1, notes: '', sourceChunkIndex: 0 }],
      }),
      modelUsed: 'test-model',
      fallback: null,
    });

    const runId = await runEngine.startRun({
      campaign,
      persona,
      brief: 'A tavern wrestling match',
      autonomy: 'auto',
      pinnedChunkIds: [sectionChunk.id],
    });

    // The pinned chunk still grounds the draft as an excerpt…
    await vi.waitFor(() => {
      expect(chatMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    });
    const draftUserContent =
      chatMock.mock.calls[0]?.[0].find((message) => message.role === 'user')?.content ?? '';
    expect(draftUserContent).toContain('Grapple rules for shoving and pinning.');
    const parkedRun = await getRun(runId);
    const retrieveStep = parkedRun?.steps.find((step) => step.name === 'retrieve');
    // …but it never joins the citable pool (no citation section; with no
    // roster either, the prompt demands inline blocks instead).
    expect((retrieveStep?.output as { statblockChunkIds?: Id[] }).statblockChunkIds).toEqual([]);
    expect((retrieveStep?.output as { chunkIds?: Id[] }).chunkIds).toContain(sectionChunk.id);

    // A stale sourceChunkIndex citation stays loud: one repair, then fail.
    await vi.waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('failed');
    });
    const storedRun = await getRun(runId);
    expect(chatMock).toHaveBeenCalledTimes(2);
    expect(storedRun?.errorMessage).toContain('is not in the excerpt list');
    expect(storedRun?.resultArtifactId).toBeNull();
  });

  it('pinned chunks lead the citation list; a pinned chunk that also ranks is not duplicated', async () => {
    const { campaign, persona, trollChunkId } = await seed();
    const goblinChunkId = await seedPackBook('Dnd5e Bestiary Pack');
    const { db } = await import('@/db/db');
    const troll = await db.chunks.get(trollChunkId);
    const goblin = await db.chunks.get(goblinChunkId);
    if (troll === undefined || goblin === undefined) throw new Error('seeded chunks missing');
    // The goblin chunk is pinned AND ranks second; the troll ranks first.
    const goblinHit = { chunk: goblin, score: 1, source: 'keyword' as const };
    const trollHit = { chunk: troll, score: 2, source: 'keyword' as const };
    searchRulesMock.mockImplementation((_query, opts) =>
      opts?.chunkTypes?.[0] === 'statblock'
        ? Promise.resolve([trollHit, goblinHit])
        : Promise.resolve([]),
    );
    chatMock.mockResolvedValue({
      text: JSON.stringify({
        ...DRAFT,
        monsters: [
          { name: 'Goblin Boss', count: 2, notes: 'commander', sourceChunkIndex: 0 },
          { name: 'Troll', count: 1, notes: '', sourceChunkIndex: 1 },
        ],
      }),
      modelUsed: 'test-model',
      fallback: null,
    });

    const runId = await runEngine.startRun({
      campaign,
      persona,
      brief: 'A goblin warband with a troll',
      autonomy: 'auto',
      pinnedChunkIds: [goblinChunkId],
    });

    // Citation order is deterministic: pinned first (pin order), then ranked
    // hits — the pinned goblin leads even though the troll outranks it, and
    // the goblin appears once despite also ranking.
    await vi.waitFor(() => {
      expect(chatMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    });
    const userContent = (chatMock.mock.calls[0]?.[0] ?? [])
      .map((message) => (typeof message.content === 'string' ? message.content : ''))
      .join('\n');
    const goblinIndex = userContent.indexOf('[0] Dnd5e Bestiary Pack p.1 — Goblin Boss');
    const trollIndex = userContent.indexOf('[1] Bestiary p.132 — Troll');
    expect(goblinIndex).toBeGreaterThanOrEqual(0);
    expect(trollIndex).toBeGreaterThan(goblinIndex);

    await vi.waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });
    const storedRun = await getRun(runId);
    const retrieveStep = storedRun?.steps.find((step) => step.name === 'retrieve');
    expect((retrieveStep?.output as { statblockChunkIds?: Id[] }).statblockChunkIds).toEqual([
      goblinChunkId,
      trollChunkId,
    ]);
    const artifact = await getArtifact(storedRun?.resultArtifactId ?? '');
    if (artifact?.kind !== 'encounter') throw new Error('encounter missing');
    expect(artifact.data.monsters[0]?.source).toEqual({ type: 'rulebook', chunkId: goblinChunkId, mobArtifactId: await mobArtifactIdOf(campaign.id, goblinChunkId) });
    expect(artifact.data.monsters[1]?.source).toEqual({ type: 'rulebook', chunkId: trollChunkId, mobArtifactId: await mobArtifactIdOf(campaign.id, trollChunkId) });
  });

  describe('roster prompt-window ordering (12-BESTIARY-PACKS §7 ratified chain)', () => {
    it('orders the window by distance to the target encounter levelHint and resolves names outside it', async () => {
      const { campaign, persona } = await seed();
      await seedLargePackBook(305);
      searchRulesMock.mockResolvedValue([]);

      const { runId, userContent } = await runSmithAgainst(
        campaign,
        persona,
        { levelHint: '300' },
        'Creature 001',
      );

      // Closest 300 of levels 1..305 = levels 6..305: the five farthest
      // (1..5) drop out, the near-target 301..305 are in — the ascending
      // window would have shown exactly the opposite tail.
      expect(userContent).toContain('(roster truncated; 5 more)');
      expect(userContent).toContain('Creature 305 (305)');
      expect(userContent).not.toContain('Creature 001 (1)');
      // Distance order around 300; the 299/301 tie breaks by level ascending.
      expect(rosterLineAt(userContent, 'Creature 300 (300)')).toBeLessThan(
        rosterLineAt(userContent, 'Creature 299 (299)'),
      );
      expect(rosterLineAt(userContent, 'Creature 299 (299)')).toBeLessThan(
        rosterLineAt(userContent, 'Creature 301 (301)'),
      );
      expect(rosterLineAt(userContent, 'Creature 301 (301)')).toBeLessThan(
        rosterLineAt(userContent, 'Creature 298 (298)'),
      );

      // Resolution is NOT windowed: the draft cites Creature 001, which is
      // outside the visible window, and the all-entries index resolves it.
      const storedRun = await getRun(runId);
      const artifact = await getArtifact(storedRun?.resultArtifactId ?? '');
      if (artifact?.kind !== 'encounter') throw new Error('encounter missing');
      const { db } = await import('@/db/db');
      const cited = (await db.chunks.toArray()).find((row) => row.headingPath[0] === 'Creature 001');
      expect(artifact.data.monsters[0]?.source).toEqual({ type: 'rulebook', chunkId: cited?.id, mobArtifactId: await mobArtifactIdOf(campaign.id, cited?.id ?? '') });
    });

    it('parses levelHint variants at the run-engine boundary (first digit run wins)', async () => {
      const { campaign, persona } = await seed();
      await seedLargePackBook(305);
      searchRulesMock.mockResolvedValue([]);

      const band = await runSmithAgainst(campaign, persona, { levelHint: '4–6' }, 'Creature 305');
      // "4–6" parses to 4: the window leads with level 4 and its neighbors,
      // and the far tail (301..305) is truncated away.
      expect(rosterLineAt(band.userContent, 'Creature 004 (4)')).toBeLessThan(
        rosterLineAt(band.userContent, 'Creature 003 (3)'),
      );
      expect(rosterLineAt(band.userContent, 'Creature 003 (3)')).toBeLessThan(
        rosterLineAt(band.userContent, 'Creature 005 (5)'),
      );
      expect(band.userContent).toContain('Creature 001 (1)');
      expect(band.userContent).not.toContain('Creature 305 (305)');
      expect(band.userContent).toContain('(roster truncated; 5 more)');

      const cr = await runSmithAgainst(campaign, persona, { levelHint: 'CR 5' }, 'Creature 305');
      // "CR 5" parses to 5 — the first digit run anywhere in the hint.
      expect(rosterLineAt(cr.userContent, 'Creature 005 (5)')).toBeLessThan(
        rosterLineAt(cr.userContent, 'Creature 004 (4)'),
      );
    });

    it('falls back to the owning module level-band midpoint when the levelHint has no digits', async () => {
      const { campaign, persona } = await seed();
      await seedLargePackBook(305);
      searchRulesMock.mockResolvedValue([]);
      const module = await persistModule(
        buildModule({
          campaignId: campaign.id,
          title: 'Endgame Module',
          concept: 'The final chapter of the campaign.',
          levelMin: 18,
          levelMax: 20,
          tone: 'climactic',
          sizeDial: 'standard',
        }),
      );

      const { runId, userContent } = await runSmithAgainst(
        campaign,
        persona,
        { levelHint: '', moduleId: module.id },
        'Creature 001',
      );

      // Midpoint (18+20)/2 = 19: the window leads with level 19 and its
      // neighbors — not the ascending level 1 — while the closest-300 set
      // (levels 1..300) is unchanged and still truncated by 5.
      expect(rosterLineAt(userContent, 'Creature 019 (19)')).toBeLessThan(
        rosterLineAt(userContent, 'Creature 018 (18)'),
      );
      expect(rosterLineAt(userContent, 'Creature 018 (18)')).toBeLessThan(
        rosterLineAt(userContent, 'Creature 020 (20)'),
      );
      expect(rosterLineAt(userContent, 'Creature 020 (20)')).toBeLessThan(
        rosterLineAt(userContent, 'Creature 017 (17)'),
      );
      expect(userContent).toContain('Creature 001 (1)');
      expect(userContent).toContain('(roster truncated; 5 more)');
      await vi.waitFor(async () => {
        expect((await getRun(runId))?.status).toBe('completed');
      });
    });

    it('keeps the ascending window when neither a levelHint nor a module band applies', async () => {
      const { campaign, persona } = await seed();
      await seedLargePackBook(305);
      searchRulesMock.mockResolvedValue([]);

      const { userContent } = await runSmithAgainst(
        campaign,
        persona,
        { levelHint: '' },
        'Creature 305',
      );

      // No target anywhere in the chain: the window is the historical
      // level/name ascending order, byte-identical to the pre-chain behavior.
      expect(rosterLineAt(userContent, 'Creature 001 (1)')).toBeLessThan(
        rosterLineAt(userContent, 'Creature 002 (2)'),
      );
      expect(rosterLineAt(userContent, 'Creature 002 (2)')).toBeLessThan(
        rosterLineAt(userContent, 'Creature 003 (3)'),
      );
      expect(userContent).not.toContain('Creature 305 (305)');
      expect(userContent).toContain('(roster truncated; 5 more)');
    });

    it('fails loudly when a module-scoped target references a module that does not exist', async () => {
      const { campaign, persona } = await seed();
      await seedLargePackBook(305);
      searchRulesMock.mockResolvedValue([]);
      chatMock.mockResolvedValue({ text: JSON.stringify(DRAFT), modelUsed: 'test-model', fallback: null });

      const stub = await createArtifact({
        campaignId: campaign.id,
        kind: 'encounter',
        name: 'Orphaned Probe',
        moduleId: crypto.randomUUID(),
        data: {
          difficulty: '',
          levelHint: '',
          monsters: [],
          terrain: '',
          tactics: '',
          treasure: '',
          mapImageId: null,
          layout: null,
        },
      });
      const runId = await runEngine.startRun({
        campaign,
        persona,
        brief: 'A probe encounter',
        autonomy: 'auto',
        pinnedChunkIds: [],
        targetArtifactId: stub.id,
      });

      await vi.waitFor(async () => {
        expect((await getRun(runId))?.status).toBe('failed');
      });
      const storedRun = await getRun(runId);
      // A dangling module anchor is corrupt data, not a preference state —
      // the run fails with a named error instead of silently ordering
      // without a target.
      expect(storedRun?.errorMessage).toContain('which does not exist');
    });
  });
});
