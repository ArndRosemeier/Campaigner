import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

import { createCampaign } from '@/db/campaignRepo';
import { getModule, patchModule, saveModule } from '@/db/moduleRepo';
import { updateSettings } from '@/db/settingsRepo';
import { createModule } from '@/domain';
import { cancelModuleGen, createModuleAndRun, retrySpine } from '@/llm/moduleGen';
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

/** Spine with declared encounters so the pass-0 gates stay quiet (08 §M4-B:
 * wants + kind on every encounter, mix covered). */
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
  entities: [
    { name: 'The Midnight Inquiry', kind: 'encounter' },
    { name: 'The Stair Toll', kind: 'encounter' },
    { name: 'The Debtors Audience', kind: 'encounter' },
  ],
};

/** The spine-entity normalization reply: the records map to themselves. */
const AUTO_NORMALIZATION = {
  entities: [
    { name: 'The Midnight Inquiry', canonical: 'The Midnight Inquiry', kind: 'encounter' },
    { name: 'The Stair Toll', canonical: 'The Stair Toll', kind: 'encounter' },
    { name: 'The Debtors Audience', canonical: 'The Debtors Audience', kind: 'encounter' },
  ],
};

/** Part prose well above the 100-char floor, naming distinct encounters
 * (the 08 §M4-B floor gate counts prose wiki-links on normalized canonicals,
 * so the post-parts normalization pass makes exactly one model call). */
function partMarkdown(marker: string, ...encounters: string[]): ChatResult {
  const links = encounters.length === 0 ? '' : ` Trials faced: ${encounters.map((encounter) => `[[${encounter}]]`).join(', ')}.`;
  return {
    text: `${marker}: The tower door opens onto a spiral stair that counts its own steps aloud. `.repeat(4) + links,
    modelUsed: 'test-model',
    fallback: null,
  };
}

/** Normalization reply mapping prose encounters to declared encounters. */
function encounterNormalization(...names: string[]): ChatResult {
  return {
    text: JSON.stringify({
      entities: names.map((name) => ({ name, canonical: name, kind: 'encounter' })),
    }),
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
      .mockResolvedValueOnce({ text: JSON.stringify(AUTO_NORMALIZATION), modelUsed: 'test-model', fallback: null }) // spine entities
      .mockResolvedValueOnce(partMarkdown('part-one', 'First Trial', 'Second Trial')) // pass 1
      .mockResolvedValueOnce(partMarkdown('part-two', 'Third Trial'))
      .mockResolvedValueOnce(encounterNormalization('First Trial', 'Second Trial', 'Third Trial')); // post-parts entities

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
    // 1 spine call + 1 spine normalization + 2 part calls + 1 post-parts
    // normalization — the floor gate passes, so no repair calls.
    expect(chatMock).toHaveBeenCalledTimes(5);
  }, 20000);

  it('stops at the spine checkpoint when the flag is off (default)', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(AUTO_SPINE), modelUsed: 'test-model', fallback: null })
      .mockResolvedValue({ text: JSON.stringify(AUTO_NORMALIZATION), modelUsed: 'test-model', fallback: null });

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
      .mockResolvedValueOnce({ text: JSON.stringify(AUTO_NORMALIZATION), modelUsed: 'test-model', fallback: null }) // spine entities
      .mockResolvedValueOnce(partMarkdown('retry-one', 'First Trial', 'Second Trial')) // pass 1
      .mockResolvedValueOnce(partMarkdown('retry-two', 'Third Trial'))
      .mockResolvedValueOnce(encounterNormalization('First Trial', 'Second Trial', 'Third Trial')); // post-parts entities

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

  it('does not fire the post-generation automation after a CANCELLED parts pass', async () => {
    // The owner's bug, at its source: a cancel leaves the module row 'ready'
    // with parts present (so Retry stays available), which is byte-identical
    // to a completed pass — so the status alone made the automation tail
    // start the whole post-generation sweep about a second after the user
    // pressed Stop all.
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(AUTO_SPINE), modelUsed: 'test-model', fallback: null }) // pass 0
      .mockResolvedValueOnce({ text: JSON.stringify(AUTO_NORMALIZATION), modelUsed: 'test-model', fallback: null }) // spine entities
      .mockImplementationOnce(() => {
        // The stop lands while the FIRST part is being written.
        cancelModuleGen(moduleId);
        return Promise.resolve(partMarkdown('cancelled-part'));
      });
    let moduleId = '';

    moduleId = await createModuleAndRun(campaign, {
      campaignId: campaign.id,
      title: 'Cancelled Tower',
      concept: 'A tower whose parts pass the user stopped.',
      levelMin: 1,
      levelMax: 2,
      tone: '',
      sizeDial: 'sketch',
      autoApproveSpine: true,
    });

    await waitFor(
      async () => {
        const row = await getModule(moduleId);
        // A cancelled pass leaves the row resumable: 'ready' (or 'draft' when
        // no part landed) — never 'generating', never 'failed'.
        expect(row?.status).not.toBe('generating');
      },
      { timeout: 15_000 },
    );

    // The cancelled pass must NOT be read as a completed one by the tail.
    expect(runModulePostGenerationMock).not.toHaveBeenCalled();
  }, 20000);
});
