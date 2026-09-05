import 'fake-indexeddb/auto';

import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { createArtifact } from '@/db/artifactRepo';
import { createModule as createModuleRow, deleteModule } from '@/db/moduleRepo';
import { createPersona } from '@/db/personaRepo';
import { updateSettings } from '@/db/settingsRepo';
import { getRun, updateRun } from '@/db/runRepo';
import { runEngine, type StartRunInput } from '@/llm/runEngine';
import { noteDraftSchema } from '@/llm/schemas';
import { GAME_SYSTEM_LABELS } from '@/domain/gameSystem';
import {
  createModule,
  moduleSchema,
  type Campaign,
  type Id,
  type Module,
  type Persona,
} from '@/domain';
import { clearDatabase } from '../db/helpers';

/**
 * Campaign grounding end-to-end (15-GRAPH-RETRIEVAL): the retrieve step
 * derives the campaign-grounding blocks and persists them with its output;
 * the draft renders the STORED section byte-identically across
 * pause/resume; the statblock step never renders it; the encounter brief
 * renders it while the fix-02 citable stat-block search stays byte-identical;
 * the whole mechanism adds no search, no embedding, no LLM call.
 */

vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {},
  OpenRouterError: class OpenRouterError extends Error {},
  listModels: vi.fn(),
}));

vi.mock('@/search', () => ({
  searchRules: vi.fn(),
}));

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);
const { searchRules } = await import('@/search');
const searchMock = vi.mocked(searchRules);

const NOTE_DRAFT = {
  name: 'The Ember Ledger',
  summary: 'A smugglers\u2019 ledger.',
  suggestedTags: [],
  body: '# The Ember Ledger\nRecovered from the docks.',
};

const NPC_DRAFT = {
  name: 'Grix',
  summary: 'A goblin alchemist boss.',
  suggestedTags: [],
  body: '# Grix\nShe brews. She throws.',
  appearance: 'Small, soot-stained.',
  personality: 'Manic, cheerful.',
  needsStatBlock: true,
};

const NPC_STATBLOCK = {
  system: 'dnd5e',
  level: '3',
  size: 'Small',
  creatureType: 'humanoid (goblinoid)',
  ac: 14,
  acNote: '',
  hp: 22,
  hpFormula: '5d6 + 5',
  speed: '30 ft.',
  abilities: { str: 8, dex: 16, con: 13, int: 14, wis: 10, cha: 12 },
  saves: '',
  skills: '',
  senses: '',
  languages: 'Common, Goblin',
  traits: [],
  actions: [],
  reactions: [],
  legendary: [],
  extras: {},
};

const ENCOUNTER_BRIEF = {
  name: 'Ash Gate Ambush',
  summary: 'Cultists guard a ruined gate.',
  body: '# Ash Gate\nA room-by-room battle.',
  difficulty: 'hard',
  levelHint: '4',
  terrain: 'broken pillars',
  tactics: 'fall back through the gate',
  treasure: 'obsidian key',
  theme: 'ash-choked temple',
  styleNotes: 'inked fantasy map',
  negative: 'text, labels',
  monsters: [
    {
      name: 'Ash Cultist',
      count: 2,
      notes: '',
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
  ],
  rooms: [
    { name: 'Entry', description: 'Broken doors', size: 'small', monsterIndexes: [], adjacentRoomIndexes: [1] },
    { name: 'Sanctum', description: 'Ash altar', size: 'large', monsterIndexes: [0], adjacentRoomIndexes: [0] },
  ],
  entryRoomIndex: 0,
};

function moduleRow(
  campaignId: Id,
  input: { title: string; premise?: string; parts?: { planIndex: number; markdown: string }[] },
): Module {
  const draft = createModule({
    campaignId,
    title: input.title,
    concept: '',
    levelMin: 1,
    levelMax: 3,
    sizeDial: 'sketch',
  });
  return moduleSchema.parse({
    ...draft,
    spine: {
      premise: input.premise ?? '',
      themes: [],
      partPlan: [{ title: 'Part', levelBand: '1–3', synopsis: '', levelUpTrigger: '' }],
    },
    parts: (input.parts ?? []).map((part) => ({
      planIndex: part.planIndex,
      markdown: part.markdown,
      status: 'ready' as const,
      errorMessage: '',
      edited: false,
    })),
  });
}

async function seedGroundingCampaign(name = 'Test Campaign'): Promise<{
  campaign: Campaign;
  moduleId: Id;
}> {
  const campaign = await createCampaign({ name, system: 'dnd5e' });
  const module = moduleRow(campaign.id, {
    title: 'Ashen Vault',
    premise: '[[Grix]] guards the door. The [[Ashen Cult]] chants below.',
  });
  await createModuleRow(module);
  await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Grix', summary: 'The door guard.' });
  await createArtifact({ campaignId: campaign.id, kind: 'faction', name: 'Ashen Cult', summary: 'Fire worshippers.' });
  return { campaign, moduleId: module.id };
}

function notePersona(): Promise<Persona> {
  return createPersona({
    slug: 'plot-architect-grounding',
    name: 'Plot Architect',
    description: 'test',
    systemPrompt: 'You are a test persona. Reply with JSON only.',
    producesKind: 'note',
    builtIn: true,
  });
}

const INPUT = (campaign: Campaign, persona: Persona, brief: string): StartRunInput => ({
  campaign: {
    id: campaign.id,
    name: campaign.name,
    system: 'dnd5e' as const,
    description: '',
    createdAt: campaign.createdAt,
    updatedAt: campaign.updatedAt,
  },
  persona,
  autonomy: 'auto' as const,
  brief,
  pinnedChunkIds: [],
});

function userMessage(callIndex: number): string {
  const call = chatMock.mock.calls[callIndex];
  const messages = call?.[0] ?? [];
  return messages
    .filter((message) => message.role === 'user')
    .map((message) => (typeof message.content === 'string' ? message.content : ''))
    .join('\n');
}

const HEADER = 'Campaign grounding (derived from wiki-links):';

beforeEach(async () => {
  await clearDatabase();
  searchMock.mockReset();
  searchMock.mockResolvedValue([]);
  chatMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('campaign grounding (15-GRAPH-RETRIEVAL)', () => {
  it('persists the derived blocks on the retrieve step and renders the section after the Task line', async () => {
    const { campaign, moduleId } = await seedGroundingCampaign();
    const persona = await notePersona();
    chatMock.mockResolvedValue({ text: JSON.stringify(NOTE_DRAFT), modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun(INPUT(campaign, persona, 'A scene with [[Grix]].'));
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });

    // Cost invariant: retrieval still runs exactly once (no grounding search).
    expect(searchMock).toHaveBeenCalledTimes(1);

    const run = await getRun(runId);
    const retrieveStep = run?.steps.find((step) => step.name === 'retrieve');
    const stored = retrieveStep?.output as {
      expansionExcerpts?: { entityName: string; source: string; text: string; moduleId?: string }[];
    };
    // Self + top-1 co-mention, both from the same module document.
    expect(stored.expansionExcerpts?.map((block) => block.entityName)).toEqual(['Grix', 'Ashen Cult']);
    expect(stored.expansionExcerpts?.every((block) => block.source === 'Ashen Vault — Premise')).toBe(true);
    expect(stored.expansionExcerpts?.every((block) => block.moduleId === moduleId)).toBe(true);
    expect(stored.expansionExcerpts?.[0]?.text).toContain('[[Grix]] guards the door');

    // The draft prompt renders the section after the Task line, before the
    // rule excerpts.
    const prompt = userMessage(0);
    expect(prompt).toContain(HEADER);
    expect(prompt).toContain('- Grix (Ashen Vault — Premise):');
    expect(prompt).toContain('- Ashen Cult (Ashen Vault — Premise):');
    const taskIndex = prompt.indexOf('Task: A scene with [[Grix]].');
    const headerIndex = prompt.indexOf(HEADER);
    const excerptsIndex = prompt.indexOf('No rule excerpts available.');
    expect(taskIndex).toBeGreaterThanOrEqual(0);
    expect(headerIndex).toBeGreaterThan(taskIndex);
    expect(headerIndex).toBeLessThan(excerptsIndex);
  }, 20000);

  it('re-renders the STORED blocks byte-identically on a later draft pass (no re-derivation, searches-once)', async () => {
    const { campaign } = await seedGroundingCampaign();
    const persona = await notePersona();
    chatMock.mockResolvedValue({ text: JSON.stringify(NOTE_DRAFT), modelUsed: 'test-model', fallback: null });
    const input = { ...INPUT(campaign, persona, 'A scene with [[Grix]].'), autonomy: 'manual' as const };

    const runId = await runEngine.startRun(input);
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('awaiting_user');
    });
    await runEngine.approve(runId, input);
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('awaiting_user');
      expect(chatMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    });
    const firstDraft = userMessage(0);
    expect(firstDraft).toContain(HEADER);

    // A later draft pass (the user touched the retrieve step) renders the
    // same stored blocks — and never re-derives (still exactly one search).
    await runEngine.editStep(runId, 0, {}, input);
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('awaiting_user');
      expect(chatMock.mock.calls.length).toBe(2);
    });
    expect(userMessage(1)).toBe(firstDraft);
    expect(searchMock).toHaveBeenCalledTimes(1);
  }, 20000);

  it('renders the PERSISTED expansionExcerpts verbatim: a sentinel hand-edited into storage is what the prompt shows', async () => {
    const { campaign } = await seedGroundingCampaign();
    const persona = await notePersona();
    chatMock.mockResolvedValue({ text: JSON.stringify(NOTE_DRAFT), modelUsed: 'test-model', fallback: null });
    const input = { ...INPUT(campaign, persona, 'A scene with [[Grix]].'), autonomy: 'manual' as const };

    const runId = await runEngine.startRun(input);
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('awaiting_user');
      expect(chatMock.mock.calls.length).toBe(1);
    });

    // Hand-edit the PERSISTED stored output (the data-at-rest boundary): the
    // derived blocks are replaced by a sentinel block no derivation could
    // produce. No moduleId → no source validation; the text renders verbatim.
    const run = await getRun(runId);
    if (run === undefined) throw new Error('the run vanished before the sentinel hand-edit');
    const steps = run.steps.map((step) =>
      step.name === 'retrieve'
        ? {
            ...step,
            output: {
              ...(step.output as Record<string, unknown>),
              expansionExcerpts: [
                {
                  entityName: 'SENTINEL ENTITY',
                  source: 'hand-edited sentinel provenance',
                  text: 'SENTINEL TEXT: the persisted field renders verbatim.',
                },
              ],
            },
          }
        : step,
    );
    await updateRun(runId, { steps });

    await runEngine.editStep(runId, 0, {}, input);
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('awaiting_user');
      expect(chatMock.mock.calls.length).toBe(2);
    });

    // The prompt shows the sentinel — and none of the derived blocks: the
    // draft renders the stored field, it never re-derives the graph.
    const prompt = userMessage(1);
    expect(prompt).toContain(HEADER);
    expect(prompt).toContain('- SENTINEL ENTITY (hand-edited sentinel provenance):');
    expect(prompt).toContain('SENTINEL TEXT: the persisted field renders verbatim.');
    expect(prompt).not.toContain('- Grix (Ashen Vault — Premise):');
    expect(prompt).not.toContain('- Ashen Cult (Ashen Vault — Premise):');
  }, 20000);

  it('renders the section absent entirely when the global toggle is OFF', async () => {
    const { campaign } = await seedGroundingCampaign();
    const persona = await notePersona();
    await updateSettings({ wikiGroundingEnabled: false });
    chatMock.mockResolvedValue({ text: JSON.stringify(NOTE_DRAFT), modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun(INPUT(campaign, persona, 'A scene with [[Grix]].'));
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });

    const run = await getRun(runId);
    const retrieveStep = run?.steps.find((step) => step.name === 'retrieve');
    expect((retrieveStep?.output as { expansionExcerpts?: unknown[] }).expansionExcerpts).toEqual([]);
    expect(userMessage(0)).not.toContain(HEADER);
    expect(userMessage(0)).not.toContain('guards the door');
  }, 20000);

  it('still renders the persisted section when the toggle is flipped OFF between retrieve and draft', async () => {
    const { campaign } = await seedGroundingCampaign();
    const persona = await notePersona();
    chatMock.mockResolvedValue({ text: JSON.stringify(NOTE_DRAFT), modelUsed: 'test-model', fallback: null });
    const input = { ...INPUT(campaign, persona, 'A scene with [[Grix]].'), autonomy: 'manual' as const };

    const runId = await runEngine.startRun(input);
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('awaiting_user');
      expect(chatMock.mock.calls.length).toBe(1);
    });

    // The blocks were computed and persisted while the toggle was ON.
    const run = await getRun(runId);
    const retrieveStep = run?.steps.find((step) => step.name === 'retrieve');
    const persisted = (retrieveStep?.output as { expansionExcerpts?: unknown[] }).expansionExcerpts;
    expect(persisted?.length ?? 0).toBeGreaterThan(0);

    // The user flips the global toggle OFF, then touches the retrieve step:
    // the re-run draft grounds from the STORED blocks. The render gates read
    // NO toggle — the toggle is consumed ONCE, at compute time
    // (campaignGroundingFor) — so the persisted section still renders: the
    // prompt is a function of the persisted data.
    await updateSettings({ wikiGroundingEnabled: false });
    await runEngine.editStep(runId, 0, {}, input);
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('awaiting_user');
      expect(chatMock.mock.calls.length).toBe(2);
    });

    const prompt = userMessage(1);
    expect(prompt).toContain(HEADER);
    expect(prompt).toContain('- Grix (Ashen Vault — Premise):');
    expect(prompt).toContain('- Ashen Cult (Ashen Vault — Premise):');
  }, 20000);

  it('a no-wiki-links campaign renders the draft prompt byte-identical to today', async () => {
    const campaign = await createCampaign({ name: 'Test Campaign', system: 'dnd5e' });
    const persona = await notePersona();
    const brief = 'a smugglers\u2019 note about the emberwine trade';
    chatMock.mockResolvedValue({ text: JSON.stringify(NOTE_DRAFT), modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun(INPUT(campaign, persona, brief));
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });

    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(userMessage(0)).not.toContain(HEADER);
    // Byte-identical to the pre-grounding prompt structure: the grounding
    // section is simply absent, everything else exactly as before.
    const keys = JSON.stringify(Object.keys(noteDraftSchema.shape));
    expect(userMessage(0)).toBe(
      [
        `Campaign: Test Campaign (${GAME_SYSTEM_LABELS.dnd5e})`,
        `Task: ${brief}`,
        'No rule excerpts available.',
        `Reply with ONLY a JSON object with exactly these fields: ${keys}`,
      ].join('\n\n'),
    );
  }, 20000);

  it('the statblock step never renders the section (rules-only grounding)', async () => {
    const { campaign } = await seedGroundingCampaign();
    const persona = await createPersona({
      slug: 'npc-smith-grounding',
      name: 'NPC Smith',
      description: 'test',
      systemPrompt: 'You are a test persona. Reply with JSON only.',
      producesKind: 'npc',
      builtIn: true,
    });
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(NPC_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(NPC_STATBLOCK), modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun(INPUT(campaign, persona, 'A scene with [[Grix]].'));
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });

    expect(chatMock.mock.calls.length).toBe(2);
    const draftPrompt = userMessage(0);
    const statblockPrompt = userMessage(1);
    expect(draftPrompt).toContain(HEADER);
    expect(statblockPrompt).not.toContain(HEADER);
    expect(statblockPrompt).not.toContain('guards the door');
    expect(statblockPrompt).toContain('No rule excerpts available.');
  }, 20000);

  it('the encounter brief renders the section while the fix-02 citable search stays byte-identical', async () => {
    const { campaign } = await seedGroundingCampaign();
    const persona = await createPersona({
      slug: 'encounter-cartographer-grounding',
      name: 'Encounter Cartographer',
      description: '',
      systemPrompt: 'Return encounter JSON.',
      mode: 'encounter',
      producesKind: 'encounter',
      builtIn: true,
    });
    chatMock.mockResolvedValue({ text: JSON.stringify(ENCOUNTER_BRIEF), modelUsed: 'test-model', fallback: null });
    const input = { ...INPUT(campaign, persona, 'An ambush at the ash gate with the [[Ashen Cult]].'), autonomy: 'manual' as const };

    const runId = await runEngine.startRun(input);
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('awaiting_user');
      expect(chatMock.mock.calls.length).toBe(1);
    });

    // The encounter brief's retrieval is unchanged: the general search and
    // the FROZEN citable stat-block search (limit 6, hasStatBlock, system) —
    // and nothing else.
    expect(searchMock).toHaveBeenCalledTimes(2);
    const generalOptions = searchMock.mock.calls[0]?.[1];
    const citableOptions = searchMock.mock.calls[1]?.[1];
    expect(generalOptions).toMatchObject({ limit: 8, system: 'dnd5e' });
    expect(citableOptions).toMatchObject({
      limit: 6,
      chunkTypes: ['statblock'],
      hasStatBlock: true,
      system: 'dnd5e',
    });

    // The brief prompt renders the grounding section right after the brief
    // line, before the campaign/rules sections.
    const prompt = userMessage(0);
    expect(prompt).toContain(HEADER);
    expect(prompt).toContain('- Ashen Cult (Ashen Vault — Premise):');
    const briefIndex = prompt.indexOf('An ambush at the ash gate with the [[Ashen Cult]].');
    const headerIndex = prompt.indexOf(HEADER);
    const campaignIndex = prompt.indexOf('Campaign: Test Campaign');
    expect(headerIndex).toBeGreaterThan(briefIndex);
    expect(headerIndex).toBeLessThan(campaignIndex);

    await runEngine.cancel(runId);
  }, 20000);

  it('a stored excerpt whose source module vanished mid-run fails loudly on read', async () => {
    const { campaign, moduleId } = await seedGroundingCampaign();
    const persona = await notePersona();
    chatMock.mockResolvedValue({ text: JSON.stringify(NOTE_DRAFT), modelUsed: 'test-model', fallback: null });
    const input = { ...INPUT(campaign, persona, 'A scene with [[Grix]].'), autonomy: 'manual' as const };

    const runId = await runEngine.startRun(input);
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('awaiting_user');
      expect(chatMock.mock.calls.length).toBe(1);
    });

    // The grounding source disappears while the run is paused — the next
    // draft pass re-reads the stored blocks and must throw, never render or
    // skip silently.
    await deleteModule(moduleId, 'keep');
    await runEngine.editStep(runId, 0, {}, input);
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('failed');
      expect(run?.errorMessage ?? '').toMatch(/campaign grounding/);
      expect(run?.errorMessage ?? '').toMatch(/no longer exists/);
    });
  }, 20000);
});
