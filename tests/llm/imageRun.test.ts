import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

import { createArtifact, getAnyArtifact, getArtifact, publishToLibrary } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { createImage, getImage, listImagesByIds } from '@/db/imageRepo';
import { getRun } from '@/db/runRepo';
import { saveSettings, updateSettings } from '@/db/settingsRepo';
import { createPersona, defaultSettings, type Id, type Persona } from '@/domain';
import { IMAGE_TEXT_NEGATIVE, IMAGE_TEXT_SPARING_CLAUSE } from '@/llm/imagePromptDraft';
import { runEngine } from '@/llm/runEngine';
import { clearDatabase, recentsAfterSettlingWrites } from '../db/helpers';
import { generatedImagesFor } from '../helpers/imageRunFixtures';

/**
 * Illustrator persona (07-MILESTONE-3 M3-A): image-mode pipeline — prompt
 * draft (DETERMINISTIC buildImagePrompt — the LLM prompt-crafting call is
 * gone; chat is asserted never called) → generate (image API, mocked) → pick
 * (ALWAYS pauses; the user's pick decorates the target artifact and discards
 * candidates).
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
    summary: 'A storm-lashed beacon on a black cliff.',
    body: 'Windswept rocks, gulls, one tower of black stone.',
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
      coverImageId: null,
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

/**
 * The image-API mock for the count pins: it answers with EXACTLY the number of
 * images the run requested (`n`), so the run's OWN stored candidates reveal the
 * count it asked for — the observable pin survives a refactor of the call
 * (docs/17 row 307).
 */
function mockImageApiHonoringCount(): void {
  generateImagesMock.mockImplementation((_prompt: string, n: number) =>
    Promise.resolve(generatedImagesFor(n, 'candidate')),
  );
}

/**
 * Starts an image run on `targetId` and drives it to the pick pause, returning
 * the run and the candidates ITS OWN pick step offered (the row-306 pins need
 * more than one run in a test).
 */
async function startToPick(
  campaignId: Id,
  persona: Persona,
  targetId: Id,
): Promise<{ runId: Id; candidates: Id[] }> {
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
    const run = await getRun(runId);
    expect(run?.steps).toHaveLength(3);
    expect(run?.status).toBe('awaiting_user');
  });
  const pick = (await getRun(runId))?.steps.find((step) => step.name === 'pick');
  const raw = (pick?.output as { candidates?: unknown } | null | undefined)?.candidates;
  return { runId, candidates: Array.isArray(raw) ? (raw as Id[]) : [] };
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

  it('an image run leaves the recents UNCHANGED: the image tier is not the global chat model (docs/17 rows 198/203)', async () => {
    const { campaignId, persona, targetId } = await seed();
    // The image persona answers on `settings.imageModel`, a NON-GLOBAL tier, so
    // neither it nor the global chat model may enter `recentChatModels` — the
    // list means "the global first-try chat model was in play".
    await updateSettings({ defaultChatModel: 'global/chat', recentChatModels: ['older/model'] });
    mockImageApiHonoringCount();

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
      const run = await getRun(runId);
      expect(run?.steps).toHaveLength(3);
      expect(run?.status).toBe('awaiting_user');
    });
    // The image call really happened on the image model, asking for ONE
    // candidate (docs/17 row 307)…
    expect(generateImagesMock).toHaveBeenCalledWith(
      expect.any(String),
      1,
      expect.objectContaining({ model: 'google/gemini-2.5-flash-image' }),
    );
    // …and the recents list is UNCHANGED (whole array, after the
    // fire-and-forget recorder had its chance to land).
    expect(await recentsAfterSettlingWrites()).toEqual(['older/model']);
  });

  it('manual flow: pauses at prompt-draft, stores exactly ONE candidate on continue, pauses at pick (docs/17 row 307)', async () => {
    const { campaignId, persona, targetId } = await seed();
    // The mock answers with the count it was ASKED for, so the run's own
    // stored candidates are the observable pin: a generate step that went back
    // to asking for two would store two and red this test.
    generateImagesMock.mockImplementation((_prompt: string, n: number) =>
      Promise.resolve({ ...generatedImagesFor(n, 'candidate'), costUsd: 0.021 }),
    );

    const runId = await runEngine.startRun(input(campaignId, persona, targetId));
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('awaiting_user');
    });
    let run = await getRun(runId);
    expect(run?.steps.map((step) => step.name)).toEqual(['prompt-draft']);
    expect(run?.steps[0]?.status).toBe('done');
    // Headline pin (owner amendment): the prompt draft is deterministic —
    // the openrouter chat mock receives NO prompt-draft call during the run.
    expect(chatMock).not.toHaveBeenCalled();
    expect(run?.steps[0]?.output).toEqual({
      parsed: {
        prompt: [
          'A Generic d20 illustration of The Lighthouse (location).',
          'Summary: A storm-lashed beacon on a black cliff.',
          'Description: Windswept rocks, gulls, one tower of black stone.',
          IMAGE_TEXT_SPARING_CLAUSE,
        ].join('\n'),
        negative: IMAGE_TEXT_NEGATIVE,
        styleNotes: '',
      },
    });
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

    // generateImages received the edited prompt and asked for n=1 with the
    // settings model.
    expect(generateImagesMock).toHaveBeenCalledWith(
      expect.stringContaining('Edited prompt'),
      1,
      expect.objectContaining({ model: 'google/gemini-2.5-flash-image' }),
    );
    // THE OBSERVABLE PIN: the run stored exactly ONE candidate — one image
    // row, and the pick step's candidate list holds that same single id.
    const output = run?.steps[1]?.output as { imageIds: Id[]; costUsd: number };
    expect(output.imageIds).toHaveLength(1);
    expect(output.costUsd).toBe(0.021);
    const candidates = await listImagesByIds(output.imageIds);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.source).toBe('generated');
    expect(candidates[0]?.prompt).toContain('Edited prompt');

    // The pick step paused with the candidates and NEVER auto-continued.
    expect(run?.steps[2]?.name).toBe('pick');
    expect((run?.steps[2]?.output as { candidates: Id[] }).candidates).toEqual(output.imageIds);
  });

  it('pickImages appends keeps to the artifact, sets cover, and deletes discards', async () => {
    const { campaignId, persona, targetId } = await seed();
    // OVER-DELIVERY, deliberate: the request asks for ONE candidate (row 307),
    // so only a response that carries MORE than was asked for can exercise the
    // pick's prune of a candidate the user did NOT keep. `imageGen.filteredCount`
    // already models the API answering with more entries than requested.
    generateImagesMock.mockResolvedValue(generatedImagesFor(2, 'over-delivered'));

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
    // Over-delivery again, for the same reason as the test above: this arm
    // asserts the un-kept candidate is pruned.
    generateImagesMock.mockResolvedValue(generatedImagesFor(2, 'library'));

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

  it('pickImages with an empty keep discards the single candidate and keeps the artifact untouched', async () => {
    const { campaignId, persona, targetId } = await seed();
    generateImagesMock.mockResolvedValue(generatedImagesFor(1, 'only'));

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

  it('REFUSES a keep naming ids another run offered — loudly, and writes nothing (docs/17 row 306)', async () => {
    const { campaignId, persona, targetId } = await seed();
    const otherTarget = await createArtifact({
      campaignId,
      kind: 'location',
      name: 'The Second Lighthouse',
      summary: 'A second storm-lashed beacon.',
      body: 'Another tower of black stone.',
    });
    mockImageApiHonoringCount();

    // Run 1 on the first artifact: keep its own candidate, so its id is a
    // STORED image by the time run 2 asks for a pick.
    const first = await startToPick(campaignId, persona, targetId);
    expect(first.candidates).toHaveLength(1);
    await runEngine.pickImages(first.runId, first.candidates);
    await waitFor(async () => {
      expect((await getRun(first.runId))?.status).toBe('completed');
    });
    expect((await getArtifact(targetId))?.imageIds).toEqual(first.candidates);

    // Run 2 on the OTHER artifact, kept with run 1's ids — the owner's exact
    // shape. The backstop refuses it BY NAME, before any write: the target is
    // untouched, the run still pauses, and run 2's OWN candidate rows were NOT
    // pruned away (the corruption this row exists for).
    const second = await startToPick(campaignId, persona, otherTarget.id);
    expect(second.candidates).toHaveLength(1);
    const foreignFailure = await runEngine.pickImages(second.runId, first.candidates).then(
      () => new Error('expected the foreign keep to be refused'),
      (error: unknown) => error,
    );
    expect((await getArtifact(otherTarget.id))?.imageIds).toEqual([]);
    expect((await getArtifact(otherTarget.id))?.coverImageId).toBeNull();
    expect((await getRun(second.runId))?.status).toBe('awaiting_user');
    for (const id of second.candidates) expect(await getImage(id)).toBeDefined();

    // …and it said so LOUDLY, naming the run and every offending id.
    expect(foreignFailure).toBeInstanceOf(Error);
    const foreignMessage = (foreignFailure as Error).message;
    expect(foreignMessage).toMatch(/image pick was refused/i);
    expect(foreignMessage).toContain(second.runId);
    for (const id of first.candidates) expect(foreignMessage).toContain(id);

    // The repeat-run shape: a SUPERSEDED candidate from an earlier attempt on
    // the SAME artifact is refused the same way, and its rows survive too.
    const third = await startToPick(campaignId, persona, otherTarget.id);
    const supersededId = second.candidates[0] ?? '';
    const supersededFailure = await runEngine.pickImages(third.runId, [supersededId]).then(
      () => new Error('expected the superseded candidate to be refused'),
      (error: unknown) => error,
    );
    expect((await getArtifact(otherTarget.id))?.imageIds).toEqual([]);
    for (const id of third.candidates) expect(await getImage(id)).toBeDefined();
    expect((supersededFailure as Error).message).toMatch(/image pick was refused/i);
    expect((supersededFailure as Error).message).toContain(supersededId);
  });

  it('fails with a clear message when image generation is disabled in Settings', async () => {
    const { campaignId, persona, targetId } = await seed();
    await saveSettings({
      ...defaultSettings(),
      openRouterApiKey: 'test-key',
      imagesEnabled: false,
    });

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

  it('presents ONE candidate with NO cap or partial notice (docs/17 row 307)', async () => {
    // Before row 307 the illustrate step asked for two candidates, so a
    // single-candidate answer was a DEGRADATION (x-ai/grok-imagine-image-2.0
    // caps n at 1) and had to be named. Now the request itself is one, so a
    // single candidate is the normal result: `imageGen` only raises
    // `cappedToOne` when `n > 1` (pinned in tests/llm/image-caps.test.ts), and
    // the step must persist NO notice and NO "single candidate" apology.
    const { campaignId, persona, targetId } = await seed();
    generateImagesMock.mockResolvedValue(generatedImagesFor(1, 'single'));

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
    // No spurious degradation: neither the cap sentence nor a filtered line.
    expect(output.notice).toBeNull();
    expect((run?.steps[2]?.output as { candidates: Id[] }).candidates).toHaveLength(1);
  });

  it('persists the fallback and partial-filter notices on the generate step', async () => {
    // The fallback model produced the image after a content filter on the
    // first-try model, and one of the returned candidates was filtered —
    // both degradations must be visible (AGENTS rule 1) even on the
    // one-candidate path (the API answered with more entries than asked for).
    const { campaignId, persona, targetId } = await seed();
    generateImagesMock.mockResolvedValue({
      ...generatedImagesFor(1, 'kept'),
      costUsd: 0.03,
      modelUsed: 'potent/image',
      fallback: { from: 'cheap/image', to: 'potent/image', reason: 'filter' },
      filteredCount: 1,
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
    expect(output.notice).toContain('Content filter on “cheap/image”');
    expect(output.notice).toContain('the fallback model “potent/image” produced this image');
    expect(output.notice).toContain('1 of 2 candidates was filtered');
  });

  it('leaves the generate-step notice null when the run was clean', async () => {
    const { campaignId, persona, targetId } = await seed();
    mockImageApiHonoringCount();

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

    const output = (await getRun(runId))?.steps[1]?.output as { notice: string | null };
    expect(output.notice).toBeNull();
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
    generateImagesMock.mockResolvedValue(generatedImagesFor(1, 'pf'));

    const runInput = {
      campaign: {
        id: campaign.id,
        name: 'PF2e Campaign',
        system: 'pathfinder2e' as const,
        description: '',
        coverImageId: null,
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

    // Image generator received the system prefix + appearance AND the
    // default-on text-render guard assembled onto the final prompt.
    const appearanceCall = generateImagesMock.mock.calls[0]?.[0] ?? '';
    expect(appearanceCall).toContain(
      'Pathfinder 2e=>A tall elf with silver hair, dark leather armor, holding a rapier',
    );
    expect(appearanceCall).toContain(`Avoid: ${IMAGE_TEXT_NEGATIVE}`);
    expect(generateImagesMock.mock.calls[0]?.[1]).toBe(1);

    const pickRun = await getRun(runId);
    expect(pickRun?.steps[0]?.output).toEqual({
      parsed: {
        prompt: `Pathfinder 2e=>A tall elf with silver hair, dark leather armor, holding a rapier\n${IMAGE_TEXT_SPARING_CLAUSE}`,
        negative: IMAGE_TEXT_NEGATIVE,
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
        coverImageId: null,
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
        prompt: `D&D 5e=>Small, soot-stained, goggles.\n${IMAGE_TEXT_SPARING_CLAUSE}`,
        negative: IMAGE_TEXT_NEGATIVE,
        styleNotes: '',
      },
    });
  });

  it('auto mode grounds the prompt on body/summary/name deterministically without calling LLM chat', async () => {
    // The headline amendment pin, non-appearance side: a fresh artifact with
    // no appearance still drafts its prompt from its OWN data — the run goes
    // prompt-draft → generate → pick with the openrouter chat mock silent.
    await saveSettings({
      ...defaultSettings(),
      openRouterApiKey: 'test-key',
      imagesEnabled: true,
    });
    const campaign = await createCampaign({ name: 'PF Campaign', system: 'pathfinder2e' });
    const persona = createPersona({
      slug: 'illustrator-test-grounding',
      name: 'Illustrator',
      description: 'test',
      systemPrompt: 'You draft image prompts.',
      mode: 'image',
      builtIn: true,
    });
    const keep = await createArtifact({
      campaignId: campaign.id,
      kind: 'location',
      name: 'Duskhollow Keep',
      summary: 'A ruined border keep.',
      body: '## Courtyard\n**Collapsed** walls, bramble-choked wells.',
    });
    mockImageApiHonoringCount();

    const runId = await runEngine.startRun({
      campaign: {
        id: campaign.id,
        name: 'PF Campaign',
        system: 'pathfinder2e' as const,
        description: '',
        coverImageId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      persona,
      autonomy: 'auto' as const,
      brief: '',
      pinnedChunkIds: [],
      targetArtifactId: keep.id,
    });
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.steps).toHaveLength(3);
      expect(run?.steps[0]?.status).toBe('done');
      expect(run?.steps[1]?.status).toBe('done');
    });

    // NO chat call anywhere in the image-prompt path.
    expect(chatMock).not.toHaveBeenCalled();

    const run = await getRun(runId);
    const draft = {
      prompt: [
        'A Pathfinder 2e illustration of Duskhollow Keep (location).',
        'Summary: A ruined border keep.',
        'Description: Courtyard\nCollapsed walls, bramble-choked wells.',
        IMAGE_TEXT_SPARING_CLAUSE,
      ].join('\n'),
      negative: IMAGE_TEXT_NEGATIVE,
      styleNotes: '',
    };
    expect(run?.steps[0]?.output).toEqual({ parsed: draft });
    // The image API received the assembled deterministic prompt — grounding
    // plus the default-on text-render guard — asking for ONE candidate.
    expect(generateImagesMock).toHaveBeenCalledWith(
      `${draft.prompt}\nAvoid: ${IMAGE_TEXT_NEGATIVE}`,
      1,
      expect.anything(),
    );
  });
});
