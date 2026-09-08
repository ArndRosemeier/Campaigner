import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

import { createCampaign } from '@/db/campaignRepo';
import { createPersona } from '@/db/personaRepo';
import { listArtifactsByCampaign } from '@/db/artifactRepo';
import { getRun } from '@/db/runRepo';
import { getModule, patchModule, saveModule } from '@/db/moduleRepo';
import { createModule, moduleSpineSchema, type Id, type Persona } from '@/domain';
import { runEngine } from '@/llm/runEngine';
import { runParts } from '@/llm/moduleGen';
import { clearDatabase } from '../db/helpers';

/**
 * Escape-debris hygiene backstop (detection for the UTF-8 contract):
 * debris in a persona draft rejects finalize with nothing persisted, and
 * debris in module part prose fails that part while the chain continues.
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
}));

vi.mock('@/lib/toast', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);

const VALID_STATBLOCK = {
  system: 'dnd5e',
  level: '3',
  size: 'Small',
  creatureType: 'humanoid (goblinoid)',
  ac: 14,
  acNote: 'leather armor',
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
  extras: { CR: '1' },
};

async function seedPersona(): Promise<{ campaignId: Id; persona: Persona }> {
  const campaign = await createCampaign({ name: 'Test Campaign', system: 'dnd5e' });
  const persona = await createPersona({
    slug: 'npc-smith-debris-test',
    name: 'NPC Smith',
    description: 'test',
    systemPrompt: 'You are a test persona. Reply with JSON only.',
    producesKind: 'npc',
    builtIn: true,
  });
  return { campaignId: campaign.id, persona };
}

const INPUT = (campaignId: Id, persona: Persona) => ({
  campaign: {
    id: campaignId,
    name: 'Test Campaign',
    system: 'dnd5e' as const,
    description: '',
    coverImageId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  persona,
  autonomy: 'manual' as const,
  brief: 'a goblin alchemist boss for a level 3 party',
  pinnedChunkIds: [],
});

const VALID_SPINE = {
  premise: 'A harbor town raised its bell to warn of the drownings; now the bell rings by itself.',
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
  ],
  entities: [],
};

/** Module prose well above the 100-char floor, with a findable marker. */
function partMarkdown(marker: string): string {
  return `${marker}: The tide withdraws and the streets shine wet under a pale sun. `.repeat(4);
}

beforeEach(clearDatabase);
afterEach(() => {
  chatMock.mockReset();
  vi.restoreAllMocks();
});

describe('escape debris in persona finalize', () => {
  it('rejects the finalize step with the debris named and persists nothing', async () => {
    const { campaignId, persona } = await seedPersona();
    const debrisDraft = {
      name: 'Grix',
      summary: 'A goblin alchemist boss.',
      suggestedTags: ['goblin'],
      body: '# Grix\nShe brews by the Flussm?fcndung. She throws.',
      appearance: 'Small, soot-stained, goggles.',
      personality: 'Manic, cheerful, volatile.',
      needsStatBlock: true,
    };
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(debrisDraft), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_STATBLOCK), modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun(INPUT(campaignId, persona));
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('awaiting_user');
    });
    await runEngine.approve(runId, INPUT(campaignId, persona));
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('awaiting_user');
    });
    await runEngine.approve(runId, INPUT(campaignId, persona));
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('awaiting_user');
      expect(run?.steps.at(-1)?.name).toBe('finalize');
    });

    const run = await getRun(runId);
    const finalize = run?.steps.at(-1);
    expect(finalize?.status).toBe('rejected');
    const issues = (finalize?.output as { issues?: unknown }).issues;
    expect(Array.isArray(issues)).toBe(true);
    expect((issues as string[]).join('\n')).toContain('"?fc"');
    expect((issues as string[]).join('\n')).toContain('draft.body');
    // Nothing persisted: no artifact, no result link.
    expect(run?.resultArtifactId).toBeNull();
    expect(await listArtifactsByCampaign(campaignId)).toHaveLength(0);
  }, 20000);

  it('rejects debris hidden in a literal \\uXXXX escape', async () => {
    const { campaignId, persona } = await seedPersona();
    const debrisDraft = {
      name: 'Grix',
      summary: 'Die K\\u00fcche des Alchemisten.',
      suggestedTags: [],
      body: '# Grix\nShe brews. She throws.',
      appearance: 'Small.',
      personality: 'Manic.',
      needsStatBlock: false,
    };
    chatMock.mockResolvedValueOnce({ text: JSON.stringify(debrisDraft), modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun(INPUT(campaignId, persona));
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('awaiting_user');
    });
    // needsStatBlock: false skips the statblock step — approve straight into finalize.
    await runEngine.approve(runId, INPUT(campaignId, persona));
    await waitFor(async () => {
      expect((await getRun(runId))?.steps.at(-1)?.name).toBe('finalize');
    });

    const run = await getRun(runId);
    expect(run?.steps.at(-1)?.status).toBe('rejected');
    const issues = (run?.steps.at(-1)?.output as { issues?: unknown }).issues;
    expect((issues as string[]).join('\n')).toContain('"\\u00fc"');
    expect(await listArtifactsByCampaign(campaignId)).toHaveLength(0);
  }, 20000);
});

describe('escape debris in module parts', () => {
  it('fails the debris part with the debris named and continues the chain', async () => {
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
    await patchModule(saved.id, { spine: moduleSpineSchema.parse(VALID_SPINE) });
    chatMock
      .mockResolvedValueOnce({ text: partMarkdown('PART-ONE'), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({
        text: `${partMarkdown('PART-TWO')} The chapel stands by the Flussm?fcndung.`,
        modelUsed: 'test-model',
        fallback: null,
      });

    const finished = await runParts(saved.id, campaign, { planIndexes: [0, 1] });

    expect(finished.status).toBe('ready');
    const [one, two] = finished.parts;
    expect(one?.status).toBe('ready');
    expect(one?.markdown).toContain('PART-ONE');
    expect(two?.status).toBe('failed');
    expect(two?.markdown).toBe('');
    expect(two?.errorMessage).toContain('?fc');
    // The debris is never persisted as ready prose.
    const stored = await getModule(saved.id);
    const storedTwo = stored?.parts.find((part) => part.planIndex === 1);
    expect(storedTwo?.status).toBe('failed');
    expect(storedTwo?.markdown).not.toContain('?fc');
  }, 20000);
});
