import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { putChunks } from '@/db/chunkRepo';
import { createPackBook, createRulebook, finalizePackBook } from '@/db/rulebookRepo';
import { createArtifact, getArtifact, listArtifactsByCampaign } from '@/db/artifactRepo';
import { getRun } from '@/db/runRepo';
import { saveSettings } from '@/db/settingsRepo';
import { seedBattleFromEncounter } from '@/db/battleSeed';
import { resolveMonsterEntryWithRepos } from '@/db/monsterResolve';
import {
  createPersona,
  defaultSettings,
  ruleChunkSchema,
  stampNewEntity,
  statBlockSchema,
  type Id,
  type Persona,
  type StatBlock,
} from '@/domain';
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

describe('encounter runs (M3-B)', () => {
  beforeEach(async () => {
    await clearDatabase();
    chatMock.mockReset();
    searchRulesMock.mockReset();
  });

  it('cites rulebook chunks, inlines stat blocks, and defaults the rest to name-only', async () => {
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
    expect(monsters[0]?.source).toEqual({ type: 'rulebook', chunkId: trollChunkId });
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
    expect(updated.data.monsters[0]?.source).toEqual({ type: 'rulebook', chunkId: trollChunkId });
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
});
