import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

import { createArtifact, getAnyArtifact, getArtifact, publishToLibrary } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { createImage, getImage, listImagesByIds } from '@/db/imageRepo';
import { getRun } from '@/db/runRepo';
import { saveSettings } from '@/db/settingsRepo';
import { createPersona, defaultSettings, type Id, type Persona } from '@/domain';
import { runEngine } from '@/llm/runEngine';
import { clearDatabase } from '../db/helpers';

/**
 * Illustrator persona (07-MILESTONE-3 M3-A): image-mode pipeline — prompt
 * draft (LLM, mocked) → generate (image API, mocked) → pick (ALWAYS pauses;
 * the user's pick decorates the target artifact and discards candidates).
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

vi.mock('@/llm/imageGen', () => ({
  generateImages: vi.fn(),
}));

vi.mock('@/lib/imageIntake', () => ({
  intakeImage: vi.fn(),
  blobToScaledDataUrl: vi.fn(),
}));

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);
const { generateImages } = await import('@/llm/imageGen');
const generateImagesMock = vi.mocked(generateImages);
const { intakeImage } = await import('@/lib/imageIntake');
const intakeImageMock = vi.mocked(intakeImage);

const VALID_PROMPT_DRAFT = {
  prompt: 'A storm-lashed lighthouse on a black cliff, gulls, cold palette',
  negative: 'text, watermark',
  styleNotes: 'moody oil painting, dramatic lighting',
};

async function seed(): Promise<{ campaignId: Id; persona: Persona; targetId: Id }> {
  const campaign = await createCampaign({ name: 'Image Campaign', system: 'generic-d20' });
  const persona = createPersona({
    slug: 'illustrator-test',
    name: 'Illustrator',
    description: 'test',
    systemPrompt: 'You draft image prompts.',
    mode: 'image',
    builtIn: true,
  });
  const target = await createArtifact({
    campaignId: campaign.id,
    kind: 'location',
    name: 'The Lighthouse',
  });
  await saveSettings({
    ...defaultSettings(),
    openRouterApiKey: 'test-key',
    imagesEnabled: true,
  });
  return { campaignId: campaign.id, persona, targetId: target.id };
}

function input(
  campaignId: Id,
  persona: Persona,
  targetArtifactId: Id | undefined,
): Parameters<typeof runEngine.startRun>[0] {
  return {
    campaign: {
      id: campaignId,
      name: 'Image Campaign',
      system: 'generic-d20' as const,
      description: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    persona,
    autonomy: 'manual' as const,
    brief: '',
    pinnedChunkIds: [],
    ...(targetArtifactId === undefined ? {} : { targetArtifactId }),
  };
}

function fakeImageBytes(seedText: string): Blob {
  return new Blob([seedText], { type: 'image/webp' });
}

beforeEach(async () => {
  await clearDatabase();
  intakeImageMock.mockImplementation((blob: Blob) =>
    Promise.resolve({ blob, width: 64, height: 64, mimeType: 'image/webp' }),
  );
});
afterEach(() => {
  chatMock.mockReset();
  generateImagesMock.mockReset();
  intakeImageMock.mockReset();
  vi.restoreAllMocks();
});

describe('illustrator run (image persona)', () => {
  it('startRun rejects an image persona without a target artifact', async () => {
    const { campaignId, persona } = await seed();
    await expect(runEngine.startRun(input(campaignId, persona, undefined))).rejects.toThrow(
      /target artifact/,
    );
  });

  it('manual flow: pauses at prompt-draft, generates 2 candidates on continue, pauses at pick', async () => {
    const { campaignId, persona, targetId } = await seed();
    chatMock.mockResolvedValueOnce({ text: JSON.stringify(VALID_PROMPT_DRAFT), modelUsed: 'test-model', fallback: null });
    generateImagesMock.mockResolvedValue({
      images: [fakeImageBytes('one'), fakeImageBytes('two')],
      costUsd: 0.021,
    cappedToOne: false, modelUsed: 'test-image-model',
    });

    const runId = await runEngine.startRun(input(campaignId, persona, targetId));
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('awaiting_user');
    });
    let run = await getRun(runId);
    expect(run?.steps.map((step) => step.name)).toEqual(['prompt-draft']);
    expect(run?.steps[0]?.status).toBe('done');
    // The target artifact id is persisted on the run row.
    expect(run?.targetArtifactId).toBe(targetId);

    // Continue with an edited prompt (the user's edit wins over the draft).
    await runEngine.editStep(
      runId,
      0,
      { parsed: { ...VALID_PROMPT_DRAFT, prompt: 'Edited prompt' } },
      input(campaignId, persona, targetId),
    );
    await waitFor(async () => {
      run = await getRun(runId);
      expect(run?.status).toBe('awaiting_user');
      expect(run?.steps).toHaveLength(3);
    });
    expect(run?.steps.map((step) => step.name)).toEqual(['prompt-draft', 'generate', 'pick']);
    expect(run?.steps[1]?.status).toBe('done');

    // generateImages received the edited prompt and n=2 with the settings model.
    expect(generateImagesMock).toHaveBeenCalledWith(
      expect.stringContaining('Edited prompt'),
      2,
      expect.objectContaining({ model: 'google/gemini-2.5-flash-image' }),
    );
    // Candidates were stored through the intake pipeline.
    const output = run?.steps[1]?.output as { imageIds: Id[]; costUsd: number };
    expect(output.imageIds).toHaveLength(2);
    expect(output.costUsd).toBe(0.021);
    const candidates = await listImagesByIds(output.imageIds);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]?.source).toBe('generated');
    expect(candidates[0]?.prompt).toContain('Edited prompt');

    // The pick step paused with the candidates and NEVER auto-continued.
    expect(run?.steps[2]?.name).toBe('pick');
    expect((run?.steps[2]?.output as { candidates: Id[] }).candidates).toEqual(output.imageIds);
  });

  it('pickImages appends keeps to the artifact, sets cover, and deletes discards', async () => {
    const { campaignId, persona, targetId } = await seed();
    chatMock.mockResolvedValueOnce({ text: JSON.stringify(VALID_PROMPT_DRAFT), modelUsed: 'test-model', fallback: null });
    generateImagesMock.mockResolvedValue({
      images: [fakeImageBytes('one'), fakeImageBytes('two')],
      costUsd: null,
    cappedToOne: false, modelUsed: 'test-image-model',
    });

    const runId = await runEngine.startRun(input(campaignId, persona, targetId));
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('awaiting_user');
    });
    await runEngine.editStep(runId, 0, { parsed: VALID_PROMPT_DRAFT }, input(campaignId, persona, targetId));
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.steps).toHaveLength(3);
      expect(run?.status).toBe('awaiting_user');
    });
    const candidates = (await getRun(runId))?.steps[1]?.output as { imageIds: Id[] };
    const [first, second] = candidates.imageIds;
    if (first === undefined || second === undefined) throw new Error('expected 2 candidates');

    await runEngine.pickImages(runId, [first]);
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('completed');
    });

    const run = await getRun(runId);
    expect(run?.resultArtifactId).toBe(targetId);
    const target = await getArtifact(targetId);
    expect(target?.imageIds).toEqual([first]);
    expect(target?.coverImageId).toBe(first);
    expect(await getImage(first)).toBeDefined();
    expect(await getImage(second)).toBeUndefined(); // discard pruned
  });

  it('targets a global artifact while the run stays campaign-anchored', async () => {
    const { campaignId, persona, targetId } = await seed();
    await publishToLibrary(targetId);
    chatMock.mockResolvedValueOnce({ text: JSON.stringify(VALID_PROMPT_DRAFT), modelUsed: 'test-model', fallback: null });
    generateImagesMock.mockResolvedValue({
      images: [fakeImageBytes('library-keep'), fakeImageBytes('library-discard')],
      costUsd: null,
      cappedToOne: false, modelUsed: 'test-image-model',
    });

    const runId = await runEngine.startRun(input(campaignId, persona, targetId));
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('awaiting_user');
    });
    await runEngine.editStep(
      runId,
      0,
      { parsed: VALID_PROMPT_DRAFT },
      input(campaignId, persona, targetId),
    );
    await waitFor(async () => {
      expect((await getRun(runId))?.steps).toHaveLength(3);
    });
    const candidates = (await getRun(runId))?.steps[1]?.output as { imageIds: Id[] };
    const [first, second] = candidates.imageIds;
    if (first === undefined || second === undefined) throw new Error('expected 2 candidates');

    await runEngine.pickImages(runId, [first]);
    const run = await getRun(runId);
    expect(run?.status).toBe('completed');
    expect(run?.campaignId).toBe(campaignId);
    expect(run?.resultArtifactId).toBe(targetId);
    const global = await getAnyArtifact(targetId);
    expect(global?.campaignId).toBeNull();
    expect(global?.imageIds).toEqual([first]);
    expect((await getImage(first))?.campaignId).toBeNull();
    expect(await getImage(second)).toBeUndefined();
  });

  it('pickImages with an empty keep discards all candidates and keeps the artifact untouched', async () => {
    const { campaignId, persona, targetId } = await seed();
    chatMock.mockResolvedValueOnce({ text: JSON.stringify(VALID_PROMPT_DRAFT), modelUsed: 'test-model', fallback: null });
    generateImagesMock.mockResolvedValue({
      images: [fakeImageBytes('only')],
      costUsd: null,
    cappedToOne: false, modelUsed: 'test-image-model',
    });

    const runId = await runEngine.startRun(input(campaignId, persona, targetId));
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('awaiting_user');
    });
    await runEngine.editStep(runId, 0, { parsed: VALID_PROMPT_DRAFT }, input(campaignId, persona, targetId));
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.steps).toHaveLength(3);
    });
    const candidates = (await getRun(runId))?.steps[1]?.output as { imageIds: Id[] };

    await runEngine.pickImages(runId, []);
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('completed');
    });
    const target = await getArtifact(targetId);
    expect(target?.imageIds).toEqual([]);
    expect(target?.coverImageId).toBeNull();
    expect(await getImage(candidates.imageIds[0] ?? '')).toBeUndefined();
  });

  it('fails with a clear message when image generation is disabled in Settings', async () => {
    const { campaignId, persona, targetId } = await seed();
    await saveSettings({
      ...defaultSettings(),
      openRouterApiKey: 'test-key',
      imagesEnabled: false,
    });
    chatMock.mockResolvedValueOnce({ text: JSON.stringify(VALID_PROMPT_DRAFT), modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun(input(campaignId, persona, targetId));
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('awaiting_user');
    });
    await runEngine.editStep(runId, 0, { parsed: VALID_PROMPT_DRAFT }, input(campaignId, persona, targetId));
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('failed');
    });
    expect((await getRun(runId))?.errorMessage).toContain('disabled');
  });

  it('surfaces a candidate-cap notice when the model yields a single image', async () => {
    // x-ai/grok-imagine-image-2.0-class models cap n at 1: imageGen retries
    // and reports cappedToOne — the run must NOT continue silently.
    const { campaignId, persona, targetId } = await seed();
    chatMock.mockResolvedValueOnce({ text: JSON.stringify(VALID_PROMPT_DRAFT), modelUsed: 'test-model', fallback: null });
    generateImagesMock.mockResolvedValue({
      images: [fakeImageBytes('single')],
      costUsd: 0.011,
      cappedToOne: true, modelUsed: 'test-image-model',
    });

    const runId = await runEngine.startRun(input(campaignId, persona, targetId));
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('awaiting_user');
    });
    await runEngine.editStep(runId, 0, { parsed: VALID_PROMPT_DRAFT }, input(campaignId, persona, targetId));
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.steps).toHaveLength(3);
      expect(run?.status).toBe('awaiting_user');
    });

    const run = await getRun(runId);
    const output = run?.steps[1]?.output as { imageIds: Id[]; notice: string | null };
    expect(output.imageIds).toHaveLength(1);
    // The degradation is persisted on the step — the run panel renders it.
    expect(output.notice).toContain('single candidate');
    expect((run?.steps[2]?.output as { candidates: Id[] }).candidates).toHaveLength(1);
  });
});

describe('image persona validation', () => {
  it('image personas need no producesKind; other modes require it', () => {
    const image = createPersona({
      slug: 'img',
      name: 'Img',
      description: '',
      systemPrompt: '',
      mode: 'image',
      builtIn: true,
    });
    expect(image.producesKind).toBeUndefined();

    expect(() =>
      createPersona({
        slug: 'broken',
        name: 'Broken',
        description: '',
        systemPrompt: '',
        builtIn: true,
      }),
    ).toThrow(/producesKind/);
  });

  it('created images survive a full blob round trip with metadata', async () => {
    const { campaignId } = await seed();
    const stored = await createImage({
      campaignId,
      blob: fakeImageBytes('bytes'),
      mimeType: 'image/webp',
      width: 10,
      height: 10,
      prompt: 'p',
      model: 'm',
      source: 'generated',
    });
    const loaded = await getImage(stored.id);
    expect(loaded?.prompt).toBe('p');
    expect(loaded?.mimeType).toBe('image/webp');
  });

  it('prefixes appearance with game system (System=>appearance) without calling LLM chat when target has an appearance', async () => {
    await saveSettings({
      ...defaultSettings(),
      openRouterApiKey: 'test-key',
      imagesEnabled: true,
    });
    const campaign = await createCampaign({ name: 'PF2e Campaign', system: 'pathfinder2e' });
    const persona = createPersona({
      slug: 'illustrator-test-pf',
      name: 'Illustrator',
      description: 'test',
      systemPrompt: 'You draft image prompts.',
      mode: 'image',
      builtIn: true,
    });
    const npc = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Valeros',
      data: {
        appearance: 'A tall elf with silver hair, dark leather armor, holding a rapier',
        personality: 'Brave and calm',
        statBlock: null,
      },
    });
    generateImagesMock.mockResolvedValue({
      images: [fakeImageBytes('pf1'), fakeImageBytes('pf2')],
      costUsd: 0.02,
      cappedToOne: false, modelUsed: 'test-image-model',
    });

    const runInput = {
      campaign: {
        id: campaign.id,
        name: 'PF2e Campaign',
        system: 'pathfinder2e' as const,
        description: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      persona,
      autonomy: 'auto' as const,
      brief: '',
      pinnedChunkIds: [],
      targetArtifactId: npc.id,
    };

    const runId = await runEngine.startRun(runInput);
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.steps).toHaveLength(3);
      expect(run?.steps[0]?.status).toBe('done');
      expect(run?.steps[1]?.status).toBe('done');
    });

    // LLM chat was NEVER called to rewrite or hallucinate a prompt
    expect(chatMock).not.toHaveBeenCalled();

    // Image generator received exact system prefix and appearance
    expect(generateImagesMock).toHaveBeenCalledWith(
      'Pathfinder 2e=>A tall elf with silver hair, dark leather armor, holding a rapier',
      2,
      expect.anything(),
    );

    const pickRun = await getRun(runId);
    expect(pickRun?.steps[0]?.output).toEqual({
      parsed: {
        prompt: 'Pathfinder 2e=>A tall elf with silver hair, dark leather armor, holding a rapier',
        negative: '',
        styleNotes: '',
      },
    });
  });

  it('manual mode pauses at prompt-draft with System=>appearance prefilled without calling LLM chat', async () => {
    const campaign = await createCampaign({ name: 'D&D Campaign', system: 'dnd5e' });
    const persona = createPersona({
      slug: 'illustrator-test-dnd',
      name: 'Illustrator',
      description: 'test',
      systemPrompt: 'You draft image prompts.',
      mode: 'image',
      builtIn: true,
    });
    const npc = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Grix',
      data: {
        appearance: 'Small, soot-stained, goggles.',
        personality: 'Manic',
        statBlock: null,
      },
    });

    const runInput = {
      campaign: {
        id: campaign.id,
        name: 'D&D Campaign',
        system: 'dnd5e' as const,
        description: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      persona,
      autonomy: 'manual' as const,
      brief: '',
      pinnedChunkIds: [],
      targetArtifactId: npc.id,
    };

    const runId = await runEngine.startRun(runInput);
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('awaiting_user');
    });

    expect(chatMock).not.toHaveBeenCalled();

    const pausedRun = await getRun(runId);
    expect(pausedRun?.steps[0]?.output).toEqual({
      parsed: {
        prompt: 'D&D 5e=>Small, soot-stained, goggles.',
        negative: '',
        styleNotes: '',
      },
    });
  });
});
