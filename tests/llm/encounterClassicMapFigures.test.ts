import 'fake-indexeddb/auto';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { listImagesByCampaign } from '@/db/imageRepo';
import { getRun } from '@/db/runRepo';
import { saveSettings } from '@/db/settingsRepo';
import { createPersona, defaultSettings, type Persona } from '@/domain';
import { encounterRunAdapters, runEngine, type StartRunInput } from '@/llm/runEngine';
import { chat } from '@/llm/openrouter';
import { schemaResponseFormat } from '@/llm/strictSchema';
import {
  BATTLEMAP_EMPTY_TERRAIN_CLAUSE,
  BattlemapFiguresError,
  assertBattlemapHasNoFigures,
  buildVisionFiguresInstruction,
  visionLocateReplySchema,
} from '@/llm/visionDungeon';
import { useProgressStore } from '@/lib/progress';
import { clearDatabase } from '../db/helpers';
import { generatedImagesFor } from '../helpers/imageRunFixtures';

/**
 * THE CLASSIC PATH'S FIGURE CHECK (docs/11, docs/17 row 341).
 *
 * The owner decided the empty-battlemap rule must run EVERYWHERE — verbatim:
 * *"yes everywhere. You see, mobs are placed ON TOP of the map, makes no sense
 * that the picture has them"*. Row 337 enforced it only on the complex/
 * `vision-map` path; this file pins its enforcement on the CLASSIC stylize
 * path: EVERY generated classic map is read through the SAME
 * `visionDungeon` reply contract and the SAME assertion BEFORE any intake or
 * store, and a map that depicts a figure fails the step loud by name.
 *
 * HONEST LIMIT, part of the deliverable (docs/11, docs/17 row 341): this is a
 * MODEL judgement about the image, not a pixel proof. A small or stylized
 * figure can be missed, so the guarantee is "verified by a vision read, and
 * refused by name when seen" — NEVER "impossible to depict". Nothing here
 * claims the picture is provably figure-free.
 */

vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {},
  OpenRouterError: class OpenRouterError extends Error {},
}));

vi.mock('@/search', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...(actual as object), searchRules: vi.fn() };
});

import type * as domainArtifact from '@/domain/artifact';

vi.mock('@/domain/artifact', async (importOriginal) => {
  const actual = await importOriginal<typeof domainArtifact>();
  return { ...actual, drawFillGrade: vi.fn(actual.drawFillGrade) };
});

const chatMock = vi.mocked(chat);
const { searchRules } = await import('@/search');
const searchRulesMock = vi.mocked(searchRules);
const { drawFillGrade } = await import('@/domain/artifact');
const drawFillGradeMock = vi.mocked(drawFillGrade);

const INLINE_STATBLOCK = {
  system: 'dnd5e', level: '1', size: 'Medium', creatureType: 'humanoid', ac: 12,
  acNote: '', hp: 7, hpFormula: '2d6', speed: '30 ft.',
  abilities: { str: 10, dex: 12, con: 10, int: 10, wis: 10, cha: 10 },
  saves: '', skills: '', senses: '', languages: '', traits: [], actions: [], reactions: [], legendary: [], extras: {},
};

/** A four-room classic encounter brief (multi-room ⇒ classic is legal). */
const CLASSIC_BRIEF = {
  name: 'Cinder Vault',
  summary: 'A four-room vault under a burned keep.',
  body: '# Cinder Vault\nFour rooms of ash cultists.',
  difficulty: 'hard',
  levelHint: '', partyLevel: 4,
  terrain: 'scorched stone',
  tactics: 'hold the vault door',
  treasure: 'vault hoard',
  theme: 'cinder-choked crypt',
  styleNotes: 'inked fantasy map',
  negative: 'text, labels, tokens',
  environment: 'dungeon',
  monsters: [
    { name: 'Cinder Cultist', count: 2, notes: '', treasure: '', statBlock: { ...INLINE_STATBLOCK, level: '2' } },
    { name: 'Slag Ghoul', count: 1, notes: '', treasure: '', statBlock: { ...INLINE_STATBLOCK, level: '4' } },
    { name: 'Ash Acolyte', count: 2, notes: '', treasure: '', statBlock: { ...INLINE_STATBLOCK, level: '2' } },
    { name: 'Ember Priest', count: 1, notes: '', treasure: '', statBlock: { ...INLINE_STATBLOCK, level: '4' } },
  ],
  rooms: [
    { name: 'Entry', description: 'A charred stair.', size: 'medium', monsterIndexes: [0], adjacentRoomIndexes: [1], key: '', keyTreasure: '', targetLevel: 4 },
    { name: 'Kiln', description: 'Banked coals.', size: 'medium', monsterIndexes: [1], adjacentRoomIndexes: [0, 2], key: '', keyTreasure: '', targetLevel: 4 },
    { name: 'Ash Hall', description: 'Waist-deep ash.', size: 'large', monsterIndexes: [2], adjacentRoomIndexes: [1, 3], key: '', keyTreasure: '', targetLevel: 4 },
    { name: 'Vault', description: 'A sealed door.', size: 'large', monsterIndexes: [3], adjacentRoomIndexes: [2], key: '', keyTreasure: '', targetLevel: 5 },
  ],
  entryRoomIndex: 0,
};

async function prepareClassicRun() {
  const campaign = await createCampaign({ name: 'Classic Map Figures', system: 'dnd5e' });
  const cartographer = createPersona({
    slug: 'encounter-cartographer-classic-figures',
    name: 'Encounter Cartographer',
    description: '',
    systemPrompt: 'Return encounter JSON.',
    mode: 'encounter',
    producesKind: 'encounter',
    builtIn: true,
  });
  const { db } = await import('@/db');
  await db.personas.put(cartographer);
  await saveSettings({
    ...defaultSettings(),
    openRouterApiKey: 'test-key',
    imagesEnabled: true,
    dungeonMapPath: 'classic',
  });
  return { campaign, cartographer };
}

function classicRunInput(
  campaign: Awaited<ReturnType<typeof createCampaign>>,
  cartographer: Persona,
): StartRunInput {
  return {
    campaign,
    persona: cartographer,
    autonomy: 'auto',
    brief: 'A four-room cinder vault encounter',
    pinnedChunkIds: [],
    encounterPartyLevel: 4,
    encounterMapAspect: '4:3',
    dungeonMapPath: 'classic',
  };
}

function figuresReply(figures: readonly string[]): string {
  return JSON.stringify({ marks: [], figures });
}

beforeEach(async () => {
  await clearDatabase();
  useProgressStore.getState().reset();
  chatMock.mockReset();
  searchRulesMock.mockReset();
  searchRulesMock.mockResolvedValue([]);
  drawFillGradeMock.mockReset();
  drawFillGradeMock.mockReturnValue(70);
  vi.spyOn(encounterRunAdapters, 'renderSchematic').mockReturnValue({ dataUrl: 'data:image/png;base64,schematic', width: 2304, height: 1728 });
  vi.spyOn(encounterRunAdapters, 'generateImages').mockImplementation((_prompt, n) =>
    Promise.resolve(generatedImagesFor(n, 'map')),
  );
  vi.spyOn(encounterRunAdapters, 'normalizeImageAspect').mockImplementation((blob) =>
    Promise.resolve({ blob, width: 1200, height: 900, action: 'none' }),
  );
  vi.spyOn(encounterRunAdapters, 'intakeImage').mockImplementation((blob) =>
    Promise.resolve({ blob, width: 1200, height: 900, mimeType: 'image/webp' }),
  );
  vi.spyOn(encounterRunAdapters, 'blobToDataUrl').mockResolvedValue('data:image/webp;base64,bWFw');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('classic battlemap figure check — the ONE vision seam (docs/17 row 341)', () => {
  it('asks the ONE emptiness question and names "marks": [] for a plaqueless classic map', () => {
    const instruction = buildVisionFiguresInstruction();
    // The positive rule the prompt carries rides the READ too.
    expect(instruction).toContain(BATTLEMAP_EMPTY_TERRAIN_CLAUSE);
    // The figures answer is asked for BY NAME and `[]` is the expected answer.
    expect(instruction).toContain('"figures"');
    expect(instruction).toContain('"figures": []');
    expect(instruction).toContain('an empty list is the expected answer');
    // A classic map has NO plaques, so the SAME contract is asked with an
    // explicit empty marks list (never a second reply schema).
    expect(instruction).toContain('"marks": []');
    expect(instruction).toContain('no letter plaques');
  });

  it('throws BattlemapFiguresError by name when the read sees figures, and passes an honest empty answer', async () => {
    const seen: string[] = [];
    await expect(
      assertBattlemapHasNoFigures(
        {
          visionPass: (imageDataUrl, instruction) => {
            seen.push(`${imageDataUrl}|${instruction}`);
            return Promise.resolve({ text: figuresReply([]) });
          },
        },
        { imageDataUrl: 'data:classic-map' },
      ),
    ).resolves.toBeUndefined();
    expect(seen[0]).toContain('data:classic-map');
    expect(seen[0]).toContain('"figures"');

    const error = await assertBattlemapHasNoFigures(
      { visionPass: () => Promise.resolve({ text: figuresReply(['a goblin', 'a wolf']) }) },
      { imageDataUrl: 'data:classic-map' },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BattlemapFiguresError);
    if (!(error instanceof BattlemapFiguresError)) throw new Error('expected BattlemapFiguresError');
    expect(error.figures).toEqual(['a goblin', 'a wolf']);
    expect(error.message).toContain('depicts 2 figures (a goblin, a wolf)');
    expect(error.message).toContain(
      'a battlemap is empty terrain and its creatures are tokens placed on it, so this map is not used',
    );
  });

  it('keeps ONE reply contract — no second reply schema beside the shared one', () => {
    const source = readFileSync(join(process.cwd(), 'src/llm/visionDungeon.ts'), 'utf8');
    const replySchemaExports = [...source.matchAll(/export const (\w*ReplySchema)\b/g)].map((match) => match[1]);
    expect(replySchemaExports).toEqual(['visionLocateReplySchema']);
    // Exactly ONE `figures` field exists in the module: a classic-path copy of
    // the contract would add a second.
    expect([...source.matchAll(/figures:\s*z\.array\(/g)]).toHaveLength(1);
    // The classic check parses through the shared contract and asserts through
    // the SAME shared assertion the locate path uses.
    expect(source).toContain('parseVisionLocateReply(');
    expect(source).toContain('assertEmptyBattlemap(reply.figures)');
  });

  it('composes the vision client in ONE place, called by BOTH map paths', () => {
    const engine = readFileSync(join(process.cwd(), 'src/llm/runEngine.ts'), 'utf8');
    // ONE client factory: a second inline `visionPass` wiring would make two.
    expect([...engine.matchAll(/this\.visionLocatePass\(/g)]).toHaveLength(1);
    // The classic path reaches the figure check; the vision path reaches the
    // plaque locate. Both through the SAME client factory.
    expect([...engine.matchAll(/assertBattlemapHasNoFigures\(/g)]).toHaveLength(1);
    expect([...engine.matchAll(/locateDungeonLabels\(/g)]).toHaveLength(1);
    expect(engine).toContain('this.visionLocateClients(chatModel)');
  });

  it('fails a CLASSIC map that depicts figures BEFORE any intake or store, naming them', async () => {
    const { campaign, cartographer } = await prepareClassicRun();
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(CLASSIC_BRIEF), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: figuresReply(['a goblin', 'a wolf']), modelUsed: 'test-model', fallback: null });
    const runId = await runEngine.startRun(classicRunInput(campaign, cartographer));
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('failed');
      expect(run?.errorMessage).toContain('depicts 2 figures (a goblin, a wolf)');
      expect(run?.errorMessage).toContain('a battlemap is empty terrain and its creatures are tokens placed on it');
    }, { timeout: 15000 });
    const failed = await getRun(runId);
    expect(failed?.resultArtifactId).toBeNull();
    expect(await listImagesByCampaign(campaign.id)).toEqual([]);
    // BEFORE anything is stored: the RAW generated blob went straight to the
    // data URL and the check — no aspect normalization, no intake, no row.
    expect(encounterRunAdapters.blobToDataUrl).toHaveBeenCalledTimes(1);
    expect(encounterRunAdapters.normalizeImageAspect).not.toHaveBeenCalled();
    expect(encounterRunAdapters.intakeImage).not.toHaveBeenCalled();
    // ONE candidate by contract, ONE vision read.
    expect(vi.mocked(encounterRunAdapters.generateImages)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(encounterRunAdapters.generateImages).mock.calls[0]?.[1]).toBe(1);
    expect(chatMock).toHaveBeenCalledTimes(2);
  });

  it('proceeds exactly as before when the read answers "figures": [], on the SAME provider and contract', async () => {
    const { campaign, cartographer } = await prepareClassicRun();
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(CLASSIC_BRIEF), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: figuresReply([]), modelUsed: 'test-model', fallback: null });
    const runId = await runEngine.startRun(classicRunInput(campaign, cartographer));
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('completed');
    }, { timeout: 15000 });
    const run = await getRun(runId);
    // The classic pipeline runs exactly as before: the check neither skipped
    // a step nor stopped the run.
    expect(run?.steps.map((step) => step.name)).toEqual([
      'brief', 'layout', 'schematic', 'stylize', 'pick', 'finalize',
    ]);
    const stylize = run?.steps.find((step) => step.name === 'stylize')?.output as { imageIds?: string[] } | undefined;
    expect(stylize?.imageIds).toHaveLength(1);
    expect(run?.resultArtifactId).not.toBeNull();
    const images = await listImagesByCampaign(campaign.id);
    expect(images).toHaveLength(1);
    expect(images[0]?.role).toBe('map');
    // The check DID run — one vision read — and did not block the store.
    expect(chatMock).toHaveBeenCalledTimes(2);
    const visionCall = chatMock.mock.calls[1];
    const visionContent = (visionCall?.[0] as unknown as { content: { type: string; text?: string }[] }[])[0]?.content ?? [];
    const visionText = visionContent.find((part) => part.type === 'text')?.text ?? '';
    expect(visionText).toContain('"figures"');
    expect(visionText).toContain('"marks": []');
    const visionOptions = visionCall?.[1];
    // SAME model resolution as the vision path (`resolveChatModel(settings)`)
    // and the SAME strict contract `visionLocatePass` sends.
    expect(visionOptions?.model).toBe(defaultSettings().defaultChatModel);
    expect(visionOptions?.temperature).toBe(0);
    expect(visionOptions?.responseFormat).toEqual(
      schemaResponseFormat('vision-dungeon-locate', visionLocateReplySchema),
    );
  });

  it('refuses the classic map LOUD when the vision call cannot run — never a silent skip', async () => {
    const { campaign, cartographer } = await prepareClassicRun();
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(CLASSIC_BRIEF), modelUsed: 'test-model', fallback: null })
      .mockRejectedValueOnce(new Error('model "test-chat" cannot read images'));
    const runId = await runEngine.startRun(classicRunInput(campaign, cartographer));
    await waitFor(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('failed');
      expect(run?.errorMessage).toContain('cannot read images');
    }, { timeout: 15000 });
    const failed = await getRun(runId);
    expect(failed?.resultArtifactId).toBeNull();
    expect(await listImagesByCampaign(campaign.id)).toEqual([]);
    expect(encounterRunAdapters.intakeImage).not.toHaveBeenCalled();
  });
});
