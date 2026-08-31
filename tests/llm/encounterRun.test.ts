import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { putChunks } from '@/db/chunkRepo';
import { createRulebook } from '@/db/rulebookRepo';
import { getArtifact } from '@/db/artifactRepo';
import { getRun } from '@/db/runRepo';
import { saveSettings } from '@/db/settingsRepo';
import {
  createPersona,
  defaultSettings,
  ruleChunkSchema,
  stampNewEntity,
  statBlockSchema,
  type Id,
  type Persona,
} from '@/domain';
import { sha256Hex } from '@/lib/hash';
import { runEngine } from '@/llm/runEngine';
import { clearDatabase } from '../db/helpers';

/**
 * Encounter Designer rulebook citations (07-MILESTONE-3 M3-B): the retrieve
 * step adds a statblock-restricted second search; a draft monster citing
 * `sourceChunkIndex` persists as { type: 'rulebook', chunkId }, an embedded
 * statBlock persists as { type: 'inline' }.
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
const DRAFT = {
  name: 'Ambush at the ford',
  summary: 'A bridge ambush.',
  suggestedTags: ['ambush'],
  body: '# Ambush at the ford',
  difficulty: 'deadly',
  levelHint: '5',
  monsters: [
    { name: 'Troll', count: 2, notes: 'cut off the retreat', sourceChunkIndex: 0 },
    {
      name: 'Cultist',
      count: 4,
      notes: 'netters',
      statBlock: {
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
      },
    },
    { name: 'Fodder', count: 8, notes: 'unnamed rabble' },
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
    chatMock.mockResolvedValue(JSON.stringify(DRAFT));

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
    expect(monsters[1]?.source.type).toBe('inline');
    if (monsters[1]?.source.type === 'inline') {
      expect(monsters[1].source.statBlock.creatureType).toBe('humanoid (cultist)');
    }
    expect(monsters[2]?.source).toEqual({ type: 'none' });
  });
});
