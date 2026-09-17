import 'fake-indexeddb/auto';

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact, listArtifactsByCampaign } from '@/db/artifactRepo';
import { creaturePortraitArt } from '@/db/creatureRepo';
import { createCampaign, getCampaign } from '@/db/campaignRepo';
import { putChunks } from '@/db/chunkRepo';
import { createRulebook } from '@/db/rulebookRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { saveSettings, updateSettings } from '@/db/settingsRepo';
import { getRun } from '@/db/runRepo';
import {
  createPersona,
  defaultSettings,
  newId,
  ruleChunkSchema,
  stampNewEntity,
  statBlockSchema,
  libraryCreatureKey,
} from '@/domain';
import { enqueueCampaignCover, useCoverImageQueue } from '@/features/covers/cover-image-queue';
import { useEntityImageQueue } from '@/features/modules/entity-image-queue';
import { useMobPortraitQueue } from '@/features/campaign/mob-portrait-queue';
import { assembleImagePrompt, buildImagePrompt, IMAGE_TEXT_NEGATIVE, IMAGE_TEXT_SPARING_CLAUSE, MOB_PORTRAIT_TEXT_NEGATIVE } from '@/llm/imagePromptDraft';
import { encounterRunAdapters, runEngine, type StartRunInput } from '@/llm/runEngine';
import { buildLabeledMapPrompt } from '@/llm/visionDungeon';
import { sha256Hex } from '@/lib/hash';
import { useProgressStore } from '@/lib/progress';
import { clearDatabase } from '../db/helpers';

/**
 * Image text-render guard default-on (owner report: the image model "tends
 * to render lots of text, explaining the whole plot in the image").
 *
 * The proven `Avoid:`-list mechanism is the default `negative` of the
 * shared Illustrator contract (`buildImagePrompt`) — every caller family is
 * captured here, plus a fail-closed registry so no FUTURE caller slips
 * through unguarded. The vision dungeon path is the ONE documented
 * carve-out: it needs its room plaques, so it carries its own tailored
 * clause instead of the blanket list.
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
vi.mock('@/search', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...(actual as object), searchRules: vi.fn() };
});

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);
const { generateImages } = await import('@/llm/imageGen');
const generateImagesMock = vi.mocked(generateImages);
const { intakeImage } = await import('@/lib/imageIntake');
const intakeImageMock = vi.mocked(intakeImage);
const { searchRules } = await import('@/search');
const searchRulesMock = vi.mocked(searchRules);

function blobOf(text: string): Blob {
  return new Blob([text], { type: 'image/png' });
}

beforeEach(async () => {
  await clearDatabase();
  await seedBuiltInPersonas();
  await updateSettings({ imagesEnabled: true, imageModel: 'test-image-model' });
  chatMock.mockReset();
  generateImagesMock.mockReset();
  intakeImageMock.mockReset();
  searchRulesMock.mockReset();
  searchRulesMock.mockResolvedValue([]);
  useCoverImageQueue.getState().reset();
  useEntityImageQueue.getState().reset();
  useMobPortraitQueue.getState().reset();
  useProgressStore.getState().reset();
  generateImagesMock.mockResolvedValue({ images: [blobOf('gen')], costUsd: 0.01, cappedToOne: false, modelUsed: 'test-image-model', fallback: null, filteredCount: 0 });
  intakeImageMock.mockResolvedValue({
    blob: blobOf('intake'),
    mimeType: 'image/webp',
    width: 320,
    height: 240,
  });
  vi.spyOn(encounterRunAdapters, 'renderSchematic').mockReturnValue({ dataUrl: 'data:image/png;base64,schematic', width: 2304, height: 1728 });
  vi.spyOn(encounterRunAdapters, 'generateImages').mockResolvedValue({ images: [new Blob(['one']), new Blob(['two'])], costUsd: 0.02, cappedToOne: false, modelUsed: 'test-image-model', fallback: null, filteredCount: 0 });
  vi.spyOn(encounterRunAdapters, 'normalizeImageAspect').mockImplementation((blob) => Promise.resolve({ blob, width: 1200, height: 900, action: 'none' }));
  vi.spyOn(encounterRunAdapters, 'intakeImage').mockImplementation((blob) => Promise.resolve({ blob, width: 1200, height: 900, mimeType: 'image/webp' }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('shared text-render guard', () => {
  it('still names the proven failure modes (the original incident cannot return unguarded)', () => {
    for (const item of [
      'long paragraphs of text',
      'captions',
      'explanatory text',
      'plot summary',
      'stat block',
      'character sheet',
      'diagram',
      'speech bubbles',
      'watermark',
      'signature',
      'illegible or garbled or misspelled lettering',
    ]) {
      expect(IMAGE_TEXT_NEGATIVE).toContain(item);
    }
  });

  /**
   * PIN 2 (docs/17 row 224) — the pin that would have stopped the reported
   * defect. The list is asserted STRUCTURALLY (split on commas), because
   * `toContain` over the whole string is not enough: `long paragraphs of
   * text` contains the substring "text" while forbidding nothing wholesale.
   */
  it('forbids no text wholesale: no bare text/letters/numbers/words/label item', () => {
    const items = IMAGE_TEXT_NEGATIVE.split(',').map((item) => item.trim());
    expect(items.length).toBeGreaterThan(5); // non-vacuity
    for (const bare of ['text', 'letters', 'numbers', 'words', 'label']) {
      expect(items, `a blanket no-text item came back: ${bare}`).not.toContain(bare);
    }
  });

  /**
   * PIN 1 (docs/17 row 224) — the owner's own wording rides the COMPOSED
   * prompt of both builder branches, verbatim, and never the Avoid list.
   */
  it('rides the composed prompt in BOTH builder branches, verbatim', () => {
    const grounded = buildImagePrompt(
      { name: 'The Lighthouse', kind: 'location', summary: 'A storm-lashed beacon.', body: 'Black cliffs.', data: {} },
      { systemLabel: 'D&D 5e' },
    );
    expect(grounded.prompt).toContain(IMAGE_TEXT_SPARING_CLAUSE);
    expect(grounded.prompt).toContain('Unless requested otherwise, use text sparingly.');
    expect(grounded.negative).not.toContain(IMAGE_TEXT_SPARING_CLAUSE);
    const shortcut = buildImagePrompt(
      { name: 'Grix', kind: 'npc', summary: '', body: '', data: { appearance: 'Small, soot-stained, goggles.' } },
      { systemLabel: 'D&D 5e' },
    );
    expect(shortcut.prompt).toContain(IMAGE_TEXT_SPARING_CLAUSE);
    expect(shortcut.prompt).toContain('Unless requested otherwise, use text sparingly.');
    expect(shortcut.negative).not.toContain(IMAGE_TEXT_SPARING_CLAUSE);
  });

  /**
   * PIN 3 (docs/17 row 224) — a request that ASKS for text coexists with the
   * guard: the clause is the mechanism ("unless requested otherwise"), and
   * nothing in the Avoid list overrides the request. Both branches are
   * exercised, because the request rides `extraInstruction` on either.
   */
  it('lets a requested treasure map / legend / letter coexist with the guard', () => {
    const requests = [
      'Draw this as a treasure map.',
      'A labelled map with a legend down one side.',
      'A confession letter with visible handwriting.',
    ];
    for (const request of requests) {
      for (const data of [{}, { appearance: 'A ragged chart with a torn corner.' }]) {
        const draft = buildImagePrompt(
          { name: 'Ash Gate', kind: 'location', summary: 'A ruined gate.', body: 'Cultists hold it.', data },
          { systemLabel: 'D&D 5e', extraInstruction: request },
        );
        const final = assembleImagePrompt(draft);
        expect(final).toContain(request);
        expect(final).toContain(IMAGE_TEXT_SPARING_CLAUSE);
        // The ESCAPE HATCH is the mechanism, so assert its exact words — a
        // clause without "unless requested otherwise" would contradict the
        // request it shares the prompt with.
        expect(final).toContain('Unless requested otherwise, use text sparingly.');
        const items = draft.negative.split(',').map((item) => item.trim());
        for (const bare of ['text', 'letters', 'numbers', 'words', 'label']) {
          expect(items, `the requested text is forbidden by: ${bare}`).not.toContain(bare);
        }
      }
    }
  });

  it('unifies the mob portrait name as an alias (identical-or-stronger holds by identity)', () => {
    expect(MOB_PORTRAIT_TEXT_NEGATIVE).toBe(IMAGE_TEXT_NEGATIVE);
  });

  it('guards the grounded branch by default and reaches the assembled Avoid line', () => {
    const draft = buildImagePrompt(
      { name: 'The Lighthouse', kind: 'location', summary: 'A storm-lashed beacon.', body: 'Black cliffs.', data: {} },
      { systemLabel: 'D&D 5e' },
    );
    expect(draft.negative).toBe(IMAGE_TEXT_NEGATIVE);
    const final = assembleImagePrompt(draft);
    expect(final).toContain(`Avoid: ${IMAGE_TEXT_NEGATIVE}`);
    expect(final).toContain('long paragraphs of text');
  });

  it('guards the appearance-shortcut branch by default too', () => {
    const draft = buildImagePrompt(
      { name: 'Grix', kind: 'npc', summary: '', body: '', data: { appearance: 'Small, soot-stained, goggles.' } },
      { systemLabel: 'D&D 5e' },
    );
    expect(draft.prompt).toBe(`D&D 5e=>Small, soot-stained, goggles.\n${IMAGE_TEXT_SPARING_CLAUSE}`);
    expect(draft.negative).toBe(IMAGE_TEXT_NEGATIVE);
    expect(assembleImagePrompt(draft)).toContain(`Avoid: ${IMAGE_TEXT_NEGATIVE}`);
  });

  it('keeps an explicit negative as the override (the option stays the seam)', () => {
    const draft = buildImagePrompt(
      { name: 'Bare', kind: 'note', summary: 's', body: '', data: null },
      { systemLabel: 'D&D 5e', negative: 'custom avoid' },
    );
    expect(draft.negative).toBe('custom avoid');
  });
});

describe('guarded caller families (prompt capture)', () => {
  it('covers carry the Avoid list in the final assembled prompt', async () => {
    const campaign = await createCampaign({ name: 'Ember', description: 'A city of ash and bells.', system: 'dnd5e' });
    enqueueCampaignCover(campaign.id, 'Ember');
    await waitFor(async () => {
      const updated = await getCampaign(campaign.id);
      expect(updated?.coverImageId).not.toBeNull();
    });
    expect(chatMock).not.toHaveBeenCalled();
    const finalPrompt = generateImagesMock.mock.calls[0]?.[0] ?? '';
    expect(finalPrompt).toContain(`Avoid: ${IMAGE_TEXT_NEGATIVE}`);
    expect(finalPrompt).toContain('speech bubbles');
  });

  it('entity images carry the Avoid list in the final assembled prompt', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const moduleId = newId();
    await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Kael', summary: 'Ember’s gate warden.' });
    useEntityImageQueue.getState().enqueue([{ campaignId: campaign.id, moduleId, name: 'Kael' }]);
    await waitFor(async () => {
      const kael = (await listArtifactsByCampaign(campaign.id)).find((a) => a.name === 'Kael');
      expect(kael?.imageIds).toHaveLength(1);
    });
    expect(chatMock).not.toHaveBeenCalled();
    const finalPrompt = generateImagesMock.mock.calls[0]?.[0] ?? '';
    expect(finalPrompt).toContain(`Avoid: ${IMAGE_TEXT_NEGATIVE}`);
    expect(finalPrompt).toContain('plot summary');
  });

  it('mob portraits carry the Avoid list (canonical path, unified with the general guard)', async () => {
    const campaign = await createCampaign({ name: 'Mob portraits', system: 'dnd5e' });
    const text = 'Goblin Boss, humanoid, agile commander. HP 21, AC 17.';
    const book = await createRulebook({ title: 'Bestiary', system: 'dnd5e', filename: 'bestiary.pdf' });
    await putChunks([
      ruleChunkSchema.parse({
        ...stampNewEntity(),
        bookId: book.id,
        pageStart: 12,
        pageEnd: 12,
        chunkType: 'statblock',
        headingPath: ['Goblin Boss'],
        text,
        statBlock: statBlockSchema.parse({
          system: 'dnd5e',
          level: '2',
          size: 'Large',
          creatureType: 'giant',
          ac: 11,
          acNote: '',
          hp: 59,
          hpFormula: '7d10 + 21',
          speed: '40 ft.',
          abilities: { str: 20, dex: 8, con: 16, int: 5, wis: 7, cha: 7 },
          saves: '',
          skills: '',
          senses: 'darkvision 60 ft.',
          languages: 'Common, Giant',
          traits: [],
          actions: [],
          reactions: [],
          legendary: [],
          extras: {},
        }),
        contentHash: await sha256Hex(text),
      }),
    ]);
    const { db } = await import('@/db/db');
    const chunk = await db.chunks.where('bookId').equals(book.id).first();
    if (chunk === undefined) throw new Error('chunk missing');
    // The portrait is keyed by creature IDENTITY (docs/11 D6): no artifact is
    // created for a bestiary creature, and the guard is about the PROMPT.
    const creatureKey = libraryCreatureKey(chunk.id);
    useMobPortraitQueue.getState().enqueue([
      {
        campaignId: campaign.id,
        encounterId: newId(),
        name: 'Goblin Boss',
        creatureKey,
        chunkId: chunk.id,
      },
    ]);
    await waitFor(async () => {
      expect(await creaturePortraitArt(campaign.id, creatureKey)).toBe('cover');
    });
    expect(chatMock).not.toHaveBeenCalled();
    const finalPrompt = generateImagesMock.mock.calls[0]?.[0] ?? '';
    expect(finalPrompt).toContain(`Avoid: ${IMAGE_TEXT_NEGATIVE}`);
    expect(finalPrompt).toContain('speech bubbles');
  });

  it('classic stylize falls back to the guard when the brief wrote no negative', async () => {
    const campaign = await createCampaign({ name: 'Map Campaign', system: 'dnd5e' });
    const cartographer = createPersona({
      slug: 'encounter-cartographer-guard',
      name: 'Encounter Cartographer',
      description: '',
      systemPrompt: 'Return encounter JSON.',
      mode: 'encounter',
      producesKind: 'encounter',
      builtIn: true,
    });
    const { db } = await import('@/db');
    await db.personas.put(cartographer);
    await saveSettings({ ...defaultSettings(), openRouterApiKey: 'test-key', imagesEnabled: true });
    // The brief carries NO negative (empty string): the stylize step must
    // still guard — only an explicit custom list overrides. (A custom brief
    // negative is pinned by the existing cartographer contract tests.)
    chatMock.mockResolvedValueOnce({
      text: JSON.stringify({
        name: 'Ash Gate Ambush',
        summary: 'Cultists guard a ruined gate.',
        body: '# Ash Gate\nA room-by-room battle.',
        difficulty: 'hard',
        levelHint: '4',
        terrain: 'broken pillars',
        tactics: 'fall back through the gate',
        treasure: 'obsidian key',
        theme: 'ash-choked temple',
        styleNotes: 'inked fantasy map, volcanic stone',
        negative: '',
        monsters: [
          {
            name: 'Ash Cultist',
            count: 2,
            notes: '',
            treasure: 'Robes: 2 gp',
            statBlock: {
              system: 'dnd5e', level: '1', size: 'Medium', creatureType: 'humanoid', ac: 12,
              acNote: '', hp: 7, hpFormula: '2d6', speed: '30 ft.',
              abilities: { str: 10, dex: 12, con: 10, int: 10, wis: 10, cha: 10 },
              saves: '', skills: '', senses: '', languages: '', traits: [], actions: [], reactions: [], legendary: [], extras: {},
            },
          },
        ],
        rooms: [
          { name: 'Entry', description: 'Broken doors', size: 'medium', monsterIndexes: [0], adjacentRoomIndexes: [], key: 'Cracked doors hang off one hinge.', keyTreasure: 'Fallen banner: 15 gp' },
        ],
        entryRoomIndex: 0,
      }),
      modelUsed: 'test-model',
      fallback: null,
    });
    const runInput: StartRunInput = {
      campaign,
      persona: cartographer,
      autonomy: 'manual',
      brief: 'A temple gate encounter',
      pinnedChunkIds: [],
      encounterMapAspect: '4:3',
    };
    const runId = await runEngine.startRun(runInput);
    await waitFor(
      async () => {
        const run = await getRun(runId);
        expect(run?.status).toBe('awaiting_user');
        expect(run?.steps.at(-1)?.name).toBe('brief');
      },
      { timeout: 15000 },
    );
    await runEngine.approve(runId, runInput);
    await waitFor(
      async () => {
        const run = await getRun(runId);
        expect(run?.status).toBe('awaiting_user');
        expect(run?.steps.at(-1)?.name).toBe('pick');
      },
      { timeout: 15000 },
    );
    const prompt = vi.mocked(encounterRunAdapters.generateImages).mock.calls[0]?.[0] ?? '';
    expect(prompt).toContain(`Avoid: ${IMAGE_TEXT_NEGATIVE}`);
    expect(prompt).toContain('speech bubbles');
    // The owner's text budget (docs/17 row 224) rides the classic battlemap
    // template too. Its own "no map legend / no text labels" hard-ban is the
    // separate owner-ratified VTT rule (docs/11 D17), asserted as still
    // present so the boundary is pinned rather than implied.
    expect(prompt).toContain(IMAGE_TEXT_SPARING_CLAUSE);
    expect(prompt).toContain('no map legend, no scale bar');
    expect(prompt).toContain('no text labels');
  });
});

describe('vision carve-out (binding)', () => {
  it('keeps the room plaques while the blanket list stays ABSENT', () => {
    const prompt = buildLabeledMapPrompt(
      [
        { label: 'A', name: 'Entry', description: 'Broken doors', isEntry: true },
        { label: 'B', name: 'Ossuary', description: 'Bone piles' },
      ],
      'ash-choked crypt dungeon',
      'A ↔ B',
    );
    // The tailored negative is present…
    expect(prompt).toContain('plaque');
    expect(prompt).toContain('no written text anywhere except the 2 letter plaques');
    // …while the blanket guard is absent (it would fight the plaques), and
    // the sparing clause is deliberately absent too: this path's plaque
    // clause is load-bearing for the locate pass (docs/17 row 224).
    expect(prompt).not.toContain('Avoid:');
    expect(prompt).not.toContain(IMAGE_TEXT_SPARING_CLAUSE);
    for (const blanket of ['speech bubbles', 'watermark', 'signature', 'plot summary', 'explanatory text']) {
      expect(prompt, `blanket item leaked into the vision path: ${blanket}`).not.toContain(blanket);
    }
    expect(prompt).not.toContain(IMAGE_TEXT_NEGATIVE);
  });
});

describe('image-prompt caller registry (fail-closed)', () => {
  function srcFilesContaining(snippet: string): string[] {
    const root = join(process.cwd(), 'src');
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
        if (readFileSync(full, 'utf8').includes(snippet)) {
          found.push(full.slice(root.length + 1).replace(/\\/g, '/'));
        }
      }
    };
    walk(root);
    return found.sort();
  }

  it('every buildImagePrompt call site is a known guarded caller', () => {
    // Fail-closed: a new image-prompt call site outside this list fails the
    // test. Guard it (ride the contract default or pass an explicit
    // negative), or document the carve-out in code + docs/11 + docs/18 —
    // then extend this list.
    expect(srcFilesContaining('buildImagePrompt(')).toEqual(
      [
        'features/campaign/mob-portrait-cache-queue.ts',
        'features/campaign/mob-portrait-queue.ts',
        'features/covers/cover-image-queue.ts',
        'features/modules/entity-image-queue.ts',
        'llm/imagePromptDraft.ts',
        'llm/runEngine.ts',
      ].sort(),
    );
  });

  it('every direct image producer is known (no hand-rolled prompt bypasses the guard)', () => {
    // Fail-closed: routing a new prompt around the contract (a generateImages
    // call whose prompt never saw the guard) fails the test. The vision path
    // and the lab bench are the documented carve-out family (their prompts
    // carry the tailored plaque clause, pinned above).
    //
    // The four one-image queues LEFT this list in ledger 126: their
    // `generateImages(finalPrompt, 1, …)` tails are ONE seam now
    // (`llm/oneImage.generateOneImage`, which takes the DRAFT and assembles
    // the contract itself), so the seam is the direct producer those files
    // used to be — and the seam's own source scan pins that they cannot go
    // back to calling the client directly.
    expect(srcFilesContaining('generateImages(')).toEqual(
      [
        'features/lab/labClients.ts',
        'llm/imageGen.ts',
        'llm/oneImage.ts',
        'llm/runEngine.ts',
      ].sort(),
    );
  });

  it('every labeled-map prompt routes through the shared vision builder (the carve-out family)', () => {
    expect(srcFilesContaining('buildLabeledMapPrompt(')).toEqual(
      ['features/lab/experiments/labeledDungeon.ts', 'llm/runEngine.ts', 'llm/visionDungeon.ts'].sort(),
    );
  });
});
