import 'fake-indexeddb/auto';

import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Side-effect module under test: registers the run-completion listener.
import '@/features/campaign/post-run-extras';
import { getAnyArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { createPersona } from '@/db/personaRepo';
import { getRun } from '@/db/runRepo';
import { updateSettings } from '@/db/settingsRepo';
import { runEngine } from '@/llm/runEngine';
import { useMobPortraitQueue } from '@/features/campaign/mob-portrait-queue';
import { seedBuiltInPersonas } from '@/db/seed';
import { clearDatabase } from '../db/helpers';

/**
 * Ratified: the creation dialog's ticked extras execute AFTER the run
 * completes, in the queue layer — a cover portrait is enqueued (and, with
 * image generation enabled, attached as cover) without reopening or failing
 * the finished run. Unticked extras enqueue nothing.
 */

vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {},
  OpenRouterError: class OpenRouterError extends Error {},
  listModels: vi.fn(),
  fetchWithHeadersTimeout: vi.fn(),
}));
vi.mock('@/llm/imageGen', () => ({ generateImages: vi.fn() }));
vi.mock('@/lib/imageIntake', () => ({ intakeImage: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn(), toastInfo: vi.fn() }));

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);
const { generateImages } = await import('@/llm/imageGen');
const generateImagesMock = vi.mocked(generateImages);
const { intakeImage } = await import('@/lib/imageIntake');
const intakeImageMock = vi.mocked(intakeImage);


const VALID_DRAFT = {
  name: 'Grix',
  summary: 'A goblin alchemist boss.',
  suggestedTags: ['goblin'],
  body: '# Grix\nShe brews. She throws.',
  appearance: 'Small, soot-stained, goggles.',
  personality: 'Manic, cheerful, volatile.',
  needsStatBlock: false,
};

const PROMPT_DRAFT = {
  prompt: 'A soot-stained goblin alchemist over a bubbling retort',
  negative: 'text, watermark',
  styleNotes: 'inked bestiary plate',
};

function blobOf(): Blob {
  return new Blob(['fake-png'], { type: 'image/png' });
}

beforeEach(async () => {
  await clearDatabase();
  chatMock.mockReset();
  generateImagesMock.mockReset();
  intakeImageMock.mockReset();
  useMobPortraitQueue.setState({ queued: [], activeJobs: [] });
  await updateSettings({ imagesEnabled: true });
});

async function seed(): Promise<{ campaignId: string; personaId: string }> {
  await seedBuiltInPersonas();
  const campaign = await createCampaign({ name: 'Test Campaign', system: 'dnd5e' });
  const persona = await createPersona({
    slug: 'npc-smith-extras-test',
    name: 'NPC Smith',
    description: 'test',
    systemPrompt: 'You are a test persona. Reply with JSON only.',
    producesKind: 'npc',
    builtIn: true,
  });
  return { campaignId: campaign.id, personaId: persona.id };
}

const RUN_INPUT = (campaignId: string, personaId: string) => ({
  campaign: {
    id: campaignId,
    name: 'Test Campaign',
    system: 'dnd5e' as const,
    description: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  persona: {
    id: personaId,
    slug: 'npc-smith-extras-test',
    name: 'NPC Smith',
    description: 'test',
    systemPrompt: 'You are a test persona. Reply with JSON only.',
    model: '',
    reasoningEffort: 'default' as const,
    temperature: 0.8,
    producesKind: 'npc' as const,
    mode: 'generate' as const,
    builtIn: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  autonomy: 'auto' as const,
  brief: 'a goblin alchemist boss',
  pinnedChunkIds: [],
});

describe('post-run extras', () => {
  it('the image extra attaches a cover portrait after the run completes', async () => {
    const { campaignId, personaId } = await seed();
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: JSON.stringify(PROMPT_DRAFT), modelUsed: 'test-model', fallback: null });
    generateImagesMock.mockResolvedValue({
      images: [blobOf()],
      modelUsed: 'image-model',
      costUsd: null,
      cappedToOne: false,
    });
    intakeImageMock.mockResolvedValue({
      blob: blobOf(),
      mimeType: 'image/png',
      width: 64,
      height: 64,
    });

    const runId = await runEngine.startRun({
      ...RUN_INPUT(campaignId, personaId),
      extras: { image: true, statBlock: false, mobPortraits: false, battlemap: false },
    });
    console.log('RUN', JSON.stringify(await getRun(runId)));
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('completed');
    });
    const run = await getRun(runId);
    await waitFor(async () => {
      const artifact = await getAnyArtifact(run?.resultArtifactId ?? '');
      expect(artifact?.coverImageId).not.toBeNull();
    });
    // The completed run was not reopened by the extras execution.
    expect((await getRun(runId))?.status).toBe('completed');
  }, 20000);

  it('unticked extras enqueue nothing', async () => {
    const { campaignId, personaId } = await seed();
    chatMock.mockResolvedValue({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun({
      ...RUN_INPUT(campaignId, personaId),
      extras: { image: false, statBlock: false, mobPortraits: false, battlemap: false },
    });
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('completed');
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });
    expect(useMobPortraitQueue.getState().queued).toHaveLength(0);
    expect(useMobPortraitQueue.getState().activeJobs).toHaveLength(0);
  }, 20000);

  it('a statblock-extra run whose statblock step is skipped persists the loud finalize notice', async () => {
    const { campaignId, personaId } = await seed();
    // VALID_DRAFT sets needsStatBlock: false → the statblock step is
    // skipped and data.statBlock stays null. The extra is verification-only:
    // the finalize step must carry the visible notice, never fabricate one.
    chatMock.mockResolvedValue({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun({
      ...RUN_INPUT(campaignId, personaId),
      extras: { image: false, statBlock: true, mobPortraits: false, battlemap: false },
    });
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('completed');
    });
    const run = await getRun(runId);
    const finalize = run?.steps.find((step) => step.name === 'finalize');
    expect((finalize?.output as { notice?: string } | null)?.notice).toBe(
      'No stat block was generated — add one in the artifact editor.',
    );
  }, 20000);

  it('a completed npc run without the statblock extra attaches no notice', async () => {
    const { campaignId, personaId } = await seed();
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          system: 'dnd5e',
          level: '3',
          size: 'Small',
          creatureType: 'humanoid (goblinoid)',
          ac: 14,
          acNote: '',
          hp: 22,
          hpFormula: '5d6',
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
        }),
        modelUsed: 'test-model',
        fallback: null,
      });

    const runId = await runEngine.startRun(RUN_INPUT(campaignId, personaId));
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('completed');
    });
    const run = await getRun(runId);
    const finalize = run?.steps.find((step) => step.name === 'finalize');
    expect((finalize?.output as { notice?: string } | null)?.notice ?? '').toBe('');
  }, 20000);
});
