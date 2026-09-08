import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { getModule, patchModule, saveModule } from '@/db/moduleRepo';
import {
  createModule,
  modulePartSchema,
  moduleSpineSchema,
  type Campaign,
  type Id,
} from '@/domain';
import { clearDatabase } from '../db/helpers';

/**
 * The per-run prior-modules override (08-MODULE-DESIGNER §Module canvas):
 * the canvas rewrite dialog can turn the continuity context on or off for
 * ONE run without touching the module row's `includePriorModules` flag. The
 * context itself is the engine's verbatim `priorModulesContext` (caps 4k/8k/
 * 24k untouched); only the flag's source gains a per-run override.
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

import { runParts } from '@/llm/moduleGen';
import type { ChatResult } from '@/llm/openrouter';

const TEST_MODEL = 'test/fixture-model';

function partReply(): ChatResult {
  return {
    text:
      'The ambush springs at the ford. The party fights through. '.repeat(6) +
      ' Trials faced: [[Ember Ambush]].',
    modelUsed: 'test-model',
    fallback: null,
  };
}

function normReply(): ChatResult {
  return {
    text: JSON.stringify({
      entities: [
        {
          name: 'Ember Ambush',
          canonical: 'Ember Ambush',
          kind: 'encounter',
          wants: ['seize the ford', 'hold the ford'],
          conflictKind: 'combat',
        },
      ],
    }),
    modelUsed: 'test-model',
    fallback: null,
  };
}

async function seedWorld(): Promise<{ campaign: Campaign; targetId: Id; priorId: Id }> {
  const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
  const priorDraft = createModule({
    campaignId: campaign.id,
    title: 'The Earlier Module',
    concept: 'earlier',
    levelMin: 1,
    levelMax: 2,
    sizeDial: 'standard',
  });
  const prior = await saveModule({
    ...priorDraft,
    spine: moduleSpineSchema.parse({
      premise: 'The prior module premise with [[Ember Ambush]] history.',
      themes: [],
      partPlan: [{ title: 'Old', levelBand: '1', synopsis: '', levelUpTrigger: '' }],
    }),
    parts: [
      modulePartSchema.parse({
        planIndex: 0,
        markdown: 'The prior part text that continuity context must carry.',
        status: 'ready',
        errorMessage: '',
        edited: false,
      }),
    ],
  });
  const targetDraft = createModule({
    campaignId: campaign.id,
    title: 'The Target',
    concept: 'target',
    levelMin: 1,
    levelMax: 2,
    sizeDial: 'standard',
    includePriorModules: false,
  });
  const target = await saveModule({
    ...targetDraft,
    spine: moduleSpineSchema.parse({
      premise: 'The target premise.',
      themes: [],
      // TWO plan entries: a subset run [0] stays a subset (bands only) and
      // never owns the whole-module floor total or the declared mix.
      partPlan: [
        { title: 'First', levelBand: '1', synopsis: '', levelUpTrigger: '' },
        { title: 'Second', levelBand: '2', synopsis: '', levelUpTrigger: '' },
      ],
    }),
    parts: [],
  });
  await updateDefaultModel();
  return { campaign, targetId: target.id, priorId: prior.id };
}

async function updateDefaultModel(): Promise<void> {
  const { updateSettings } = await import('@/db/settingsRepo');
  await updateSettings({ defaultChatModel: TEST_MODEL });
}

async function seedReadyPart(moduleId: Id): Promise<void> {
  await patchModule(moduleId, {
    parts: [
      modulePartSchema.parse({
        planIndex: 0,
        markdown: 'Old ready text. '.repeat(20),
        status: 'ready',
        errorMessage: '',
        edited: false,
      }),
    ],
  });
}

function partCallText(): string {
  const call = chatMock.mock.calls.find((messages) =>
    messages[0].some(
      (message) =>
        message.role === 'user' &&
        typeof message.content === 'string' &&
        message.content.includes('Write part'),
    ),
  );
  if (call === undefined) throw new Error('no part call made');
  const user = call[0].find((message) => message.role === 'user');
  return typeof user?.content === 'string' ? user.content : '';
}

beforeEach(async () => {
  await clearDatabase();
  chatMock.mockReset();
});

describe('prior-modules per-run override', () => {
  it('includePriorModules: true on the run includes prior context while the row flag stays false', async () => {
    const { campaign, targetId } = await seedWorld();
    await seedReadyPart(targetId);
    chatMock.mockResolvedValueOnce(partReply()).mockResolvedValueOnce(normReply());

    await runParts(targetId, campaign, { planIndexes: [0], includePriorModules: true });

    expect(partCallText()).toContain('Previous modules of this campaign');
    // The run lands ready: the subset owns its band only (part 1 is out of
    // scope), and the declared encounter satisfies band 1.
    const row = await getModule(targetId);
    if (row?.status !== 'ready') {
      throw new Error(`status=${String(row?.status)} error=${row?.errorMessage}`);
    }
    // The ROW is untouched by the override.
    expect(row.includePriorModules).toBe(false);
  }, 30000);

  it('includePriorModules: false on the run omits prior context even when the row flag is on', async () => {
    const { campaign, targetId, priorId } = await seedWorld();
    await patchModule(targetId, { includePriorModules: true });
    void priorId;
    await seedReadyPart(targetId);
    chatMock.mockResolvedValueOnce(partReply()).mockResolvedValueOnce(normReply());

    await runParts(targetId, campaign, { planIndexes: [0], includePriorModules: false });

    expect(partCallText()).not.toContain('Previous modules of this campaign');
    expect((await getModule(targetId))?.includePriorModules).toBe(true);
  }, 30000);

  it('no override reads the row flag (subset rewrite default — byte-for-byte)', async () => {
    const { campaign, targetId } = await seedWorld();
    await patchModule(targetId, { includePriorModules: true });
    await seedReadyPart(targetId);
    chatMock.mockResolvedValueOnce(partReply()).mockResolvedValueOnce(normReply());

    await runParts(targetId, campaign, { planIndexes: [0] });

    expect(partCallText()).toContain('Previous modules of this campaign');
  }, 30000);
});
