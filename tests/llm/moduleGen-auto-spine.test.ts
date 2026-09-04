import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

import { createCampaign } from '@/db/campaignRepo';
import { getModule, patchModule, saveModule } from '@/db/moduleRepo';
import { updateSettings } from '@/db/settingsRepo';
import { createModule } from '@/domain';
import { createModuleAndRun, retrySpine } from '@/llm/moduleGen';
import { clearDatabase } from '../db/helpers';
import type { ChatResult } from '@/llm/openrouter';
import { useProgressStore } from '@/lib/progress';

/**
 * The opt-in unattended spine flow (08 §M4-B "Generate parts without
 * review"): with `autoApproveSpine` the generated spine is approved as-is —
 * pass 1 (and the post-generation automation) runs right after pass 0, and a
 * retried spine continues unattended too. Without the flag the flow parks on
 * the draft spine exactly as before.
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

const mocks = vi.hoisted(() => ({
  runModulePostGeneration: vi.fn(),
}));

vi.mock('@/features/modules/post-generation', () => ({
  runModulePostGeneration: mocks.runModulePostGeneration,
}));

const runModulePostGenerationMock = mocks.runModulePostGeneration;

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);

const TEST_MODEL = 'test/fixture-model';

/** Spine with `entities: []` so the pass-0 normalization call is skipped. */
const AUTO_SPINE = {
  premise: 'A bell tower that answers questions asked at midnight, at a price.',
  themes: ['curiosity', 'debt'],
  partPlan: [
    {
      title: 'The First Question',
      levelBand: '1',
      synopsis: 'The party climbs the tower and asks their first question.',
      levelUpTrigger: 'The price is named.',
    },
    {
      title: 'The Standing Debt',
      levelBand: '2',
      synopsis: 'Collecting on the price destabilizes the town.',
      levelUpTrigger: 'The tower falls silent.',
    },
  ],
  entities: [],
};

/** Part prose well above the 100-char floor, deliberately without wiki-links
 * (so the post-parts normalization pass makes no model call). */
function partMarkdown(marker: string): ChatResult {
  return {
    text: `${marker}: The tower door opens onto a spiral stair that counts its own steps aloud. `.repeat(4),
    modelUsed: 'test-model',
    fallback: null,
  };
}

beforeEach(async () => {
  await clearDatabase();
  await updateSettings({ defaultChatModel: TEST_MODEL });
  useProgressStore.getState().reset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('autoApproveSpine (unattended pass 0 → pass 1)', () => {
  it('approves the generated spine as-is and runs the parts unattended', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(AUTO_SPINE), modelUsed: 'test-model', fallback: null }) // pass 0
      .mockResolvedValue(partMarkdown('part')); // every pass-1 call

    const moduleId = await createModuleAndRun(campaign, {
      campaignId: campaign.id,
      title: 'The Midnight Tower',
      concept: 'A tower that answers questions for a price.',
      levelMin: 1,
      levelMax: 2,
      tone: '',
      sizeDial: 'sketch',
      autoApproveSpine: true,
    });

    await waitFor(
      async () => {
        expect((await getModule(moduleId))?.status).toBe('ready');
      },
      { timeout: 15_000 },
    );

    const done = await getModule(moduleId);
    // The generated spine was stored untouched (no user edits to merge).
    expect(done?.spine?.premise).toBe(AUTO_SPINE.premise);
    expect(done?.parts).toHaveLength(2);
    expect(done?.parts.every((part) => part.status === 'ready')).toBe(true);
    // The unattended tail fires the post-generation automation exactly once.
    expect(runModulePostGenerationMock).toHaveBeenCalledTimes(1);
    expect(runModulePostGenerationMock).toHaveBeenCalledWith(moduleId, campaign);
    // 1 spine call + 2 part calls — no checkpoint in between.
    expect(chatMock).toHaveBeenCalledTimes(3);
  }, 20000);

  it('stops at the spine checkpoint when the flag is off (default)', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    chatMock.mockResolvedValue({ text: JSON.stringify(AUTO_SPINE), modelUsed: 'test-model', fallback: null });

    const moduleId = await createModuleAndRun(campaign, {
      campaignId: campaign.id,
      title: 'Reviewed Bell',
      concept: 'A module whose spine waits for review.',
      levelMin: 1,
      levelMax: 2,
      tone: '',
      sizeDial: 'sketch',
    });
    // Spine + status are patched atomically — non-null spine means the flow
    // parked on the checkpoint (status `draft`).
    await waitFor(async () => {
      expect((await getModule(moduleId))?.spine).not.toBeNull();
    });

    const module = await getModule(moduleId);
    expect(module?.status).toBe('draft');
    expect(module?.parts).toHaveLength(0);
    expect(runModulePostGenerationMock).not.toHaveBeenCalled();
  }, 20000);

  it('continues unattended after a retried spine for flagged modules', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const draft = createModule({
      campaignId: campaign.id,
      title: 'Retried Tower',
      concept: 'A module whose first spine draft failed.',
      levelMin: 1,
      levelMax: 2,
      tone: '',
      sizeDial: 'sketch',
      autoApproveSpine: true,
    });
    const saved = await saveModule(draft);
    await patchModule(saved.id, { status: 'failed', errorMessage: 'The provider timed out' });

    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(AUTO_SPINE), modelUsed: 'test-model', fallback: null }) // retried pass 0
      .mockResolvedValue(partMarkdown('retry')); // pass 1

    await retrySpine(saved.id, campaign);

    await waitFor(
      async () => {
        expect((await getModule(saved.id))?.status).toBe('ready');
      },
      { timeout: 15_000 },
    );
    const done = await getModule(saved.id);
    expect(done?.parts).toHaveLength(2);
    expect(done?.errorMessage).toBe('');
    expect(runModulePostGenerationMock).toHaveBeenCalledTimes(1);
    expect(runModulePostGenerationMock).toHaveBeenCalledWith(saved.id, campaign);
  }, 20000);
});
