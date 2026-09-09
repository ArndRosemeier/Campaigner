import 'fake-indexeddb/auto';

import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact, getArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { putChunks } from '@/db/chunkRepo';
import { getImage, listImagesByCampaign } from '@/db/imageRepo';
import { createModule as createModuleRepo } from '@/db/moduleRepo';
import { createPackBook, finalizePackBook } from '@/db/rulebookRepo';
import { getRun } from '@/db/runRepo';
import { saveSettings } from '@/db/settingsRepo';
import { seedBattleFromEncounter } from '@/db/battleSeed';
import {
  createModule,
  createPersona,
  defaultSettings,
  newId,
  ruleChunkSchema,
  stampNewEntity,
  statBlockSchema,
  type Artifact,
  type Id,
  type Persona,
} from '@/domain';
import { sha256Hex } from '@/lib/hash';
import { encounterRunAdapters, runEngine, type StartRunInput } from '@/llm/runEngine';
import { chat } from '@/llm/openrouter';
import {
  buildLabeledMapPrompt,
  buildVisionLocateInstruction,
  buildVisionRelocateInstruction,
  labelsForRoomCount,
  locateDungeonLabels,
  parseVisionLocateReply,
  visionLocateReplySchema,
  VisionLocateError,
} from '@/llm/visionDungeon';
import {
  dungeonVisionReplySchema,
  parseDungeonVisionReply,
} from '@/features/lab/experiments/labeledDungeon';
import { repopulateEncounter } from '@/features/campaign/encounterRegen';
import { clearDatabase } from '../db/helpers';
import { useProgressStore } from '@/lib/progress';

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

function waitForRun(assertion: () => void | Promise<void>) {
  return waitFor(assertion, { timeout: 15000 });
}

const INLINE_STATBLOCK = {
  system: 'dnd5e', level: '1', size: 'Medium', creatureType: 'humanoid', ac: 12,
  acNote: '', hp: 7, hpFormula: '2d6', speed: '30 ft.',
  abilities: { str: 10, dex: 12, con: 10, int: 10, wis: 10, cha: 10 },
  saves: '', skills: '', senses: '', languages: '', traits: [], actions: [], reactions: [], legendary: [], extras: {},
};

/** A full 4-room dungeon brief with inline statblocks (no pack book needed). */
const COMPLEX_BRIEF = {
  name: 'Ash Temple Undercroft',
  summary: 'A four-room crypt under the ash temple.',
  body: '# Ash Temple\nFour rooms of cultists.',
  difficulty: 'hard',
  levelHint: '4',
  terrain: 'crypt stone',
  tactics: 'hold the lines',
  treasure: 'cult hoard',
  theme: 'ash-choked crypt',
  styleNotes: 'inked fantasy map',
  negative: 'text, labels, tokens',
  environment: 'dungeon',
  monsters: [
    { name: 'Ash Cultist', count: 2, notes: '', treasure: '', statBlock: { ...INLINE_STATBLOCK, level: '2' } },
    { name: 'Crypt Ghoul', count: 1, notes: '', treasure: '', statBlock: { ...INLINE_STATBLOCK, level: '4' } },
    { name: 'Bone Acolyte', count: 2, notes: '', treasure: '', statBlock: { ...INLINE_STATBLOCK, level: '2' } },
    { name: 'Ash Priest', count: 1, notes: '', treasure: '', statBlock: { ...INLINE_STATBLOCK, level: '4' } },
  ],
  rooms: [
    { name: 'Entry', description: 'Broken doors.', size: 'medium', monsterIndexes: [0], adjacentRoomIndexes: [1], key: '', keyTreasure: '', targetLevel: 4 },
    { name: 'Ossuary', description: 'Stacked bones.', size: 'medium', monsterIndexes: [1], adjacentRoomIndexes: [0, 2], key: '', keyTreasure: '', targetLevel: 4 },
    { name: 'Ritual Chamber', description: 'A carved circle.', size: 'large', monsterIndexes: [2], adjacentRoomIndexes: [1, 3], key: '', keyTreasure: '', targetLevel: 4 },
    { name: 'Sanctum', description: 'A dark altar.', size: 'large', monsterIndexes: [3], adjacentRoomIndexes: [2], key: '', keyTreasure: '', targetLevel: 5 },
  ],
  entryRoomIndex: 0,
};

const SINGLE_BRIEF = {
  ...COMPLEX_BRIEF,
  monsters: [COMPLEX_BRIEF.monsters[0]],
  rooms: [
    { name: 'Entry', description: 'Broken doors.', size: 'medium', monsterIndexes: [0], adjacentRoomIndexes: [], key: '', keyTreasure: '', targetLevel: 4 },
  ],
  entryRoomIndex: 0,
};

function locateReply(marks: readonly { label: string; x: number; y: number }[]): string {
  return JSON.stringify({ marks });
}

const FULL_MARKS = [
  { label: 'A', x: 100, y: 200 },
  { label: 'B', x: 400, y: 200 },
  { label: 'C', x: 400, y: 600 },
  { label: 'D', x: 700, y: 600 },
];

function persona(slug = 'encounter-cartographer-test'): Persona {
  return createPersona({
    slug,
    name: 'Encounter Cartographer',
    description: '',
    systemPrompt: 'Return encounter JSON.',
    mode: 'encounter',
    producesKind: 'encounter',
    builtIn: true,
  });
}

function smithPersona(): Persona {
  return createPersona({
    slug: 'encounter-smith',
    name: 'Encounter Smith',
    description: '',
    systemPrompt: 'Return encounter JSON.',
    mode: 'generate',
    producesKind: 'encounter',
    builtIn: true,
  });
}

async function setup(settingsPath: 'classic' | 'vision' = 'classic') {
  const campaign = await createCampaign({ name: 'Vision Campaign', system: 'dnd5e' });
  const cartographer = persona();
  const { db } = await import('@/db');
  await db.personas.put(cartographer);
  // The regen entry points resolve the built-in slugs (repopulate test).
  await db.personas.put(persona('encounter-cartographer'));
  await db.personas.put(smithPersona());
  await saveSettings({
    ...defaultSettings(),
    openRouterApiKey: 'test-key',
    imagesEnabled: true,
    dungeonMapPath: settingsPath,
  });
  return { campaign, cartographer };
}

function input(
  campaign: Awaited<ReturnType<typeof createCampaign>>,
  cartographer: Persona,
): StartRunInput {
  return {
    campaign,
    persona: cartographer,
    autonomy: 'manual',
    brief: 'A four-room crypt encounter',
    pinnedChunkIds: [],
    encounterMapAspect: '4:3',
  };
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
  vi.spyOn(encounterRunAdapters, 'generateImages').mockResolvedValue({
    images: [new Blob(['vision-map'])],
    costUsd: 0.02,
    cappedToOne: false,
    modelUsed: 'test-image-model',
    fallback: null,
    filteredCount: 0,
  });
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

async function waitForBriefPause(runId: string): Promise<void> {
  await waitForRun(async () => {
    const run = await getRun(runId);
    expect(run?.status).toBe('awaiting_user');
    expect(run?.steps.at(-1)?.name).toBe('brief');
  });
}

describe('vision dungeon label helpers (docs/11 vision path)', () => {
  it('assigns letters A..N in room order for 4–10 rooms', () => {
    expect(labelsForRoomCount(4)).toEqual(['A', 'B', 'C', 'D']);
    expect(labelsForRoomCount(10)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']);
    expect(labelsForRoomCount(14)).toHaveLength(14);
    expect(labelsForRoomCount(14)[13]).toBe('N');
    expect(() => labelsForRoomCount(15)).toThrow('1–14 only');
  });

  it('builds the labeled-map prompt from rooms + concept with a natural-shape rule and no global shape clause', () => {
    const prompt = buildLabeledMapPrompt(
      [
        { label: 'A', name: 'Entry', description: 'Broken doors' },
        { label: 'B', name: 'Ossuary', description: 'Stacked bones' },
      ],
      'ash-choked crypt dungeon',
      'A ↔ B',
    );
    expect(prompt).toContain('Room A: Entry — Broken doors.');
    expect(prompt).toContain('Room B: Ossuary — Stacked bones.');
    expect(prompt).toContain('ash-choked crypt dungeon');
    expect(prompt).toContain('Rooms connect: A ↔ B.');
    expect(prompt).toContain('engraved or carved');
    expect(prompt).toContain('no monsters');
    // The binding clarification: NO regular/irregular distinction or toggle
    // in the vision path — shape follows each room's description.
    expect(prompt).not.toMatch(/regular|irregular/i);
    expect(prompt).toContain("follow its description");
  });

  it('renders the designated entry chamber as the visual entrance, naming its letter', () => {
    const prompt = buildLabeledMapPrompt(
      [
        { label: 'A', name: 'Entry', description: 'Broken doors' },
        { label: 'B', name: 'Ossuary', description: 'Stacked bones', isEntry: true },
      ],
      'ash-choked crypt dungeon',
      'A ↔ B',
    );
    expect(prompt).toContain('Room B is the dungeon entrance');
    expect(prompt).toContain('plaque included');
    // Non-entry rooms get no entrance clause.
    expect(prompt).not.toContain('Room A is the dungeon entrance');
    // The natural-shape rule is unchanged by the entrance clause.
    expect(prompt).not.toMatch(/regular|irregular/i);
  });

  it('renders no entrance clause without a designation and refuses two entrances loud', () => {
    const plain = buildLabeledMapPrompt(
      [{ label: 'A', name: 'Entry', description: 'Broken doors' }],
      'ash-choked crypt dungeon',
    );
    expect(plain).not.toContain('dungeon entrance');
    expect(() =>
      buildLabeledMapPrompt(
        [
          { label: 'A', name: 'Entry', description: 'Broken doors', isEntry: true },
          { label: 'B', name: 'Ossuary', description: 'Stacked bones', isEntry: true },
        ],
        'ash-choked crypt dungeon',
      ),
    ).toThrow('exactly one room is the way in');
  });

  it('locates every plaque in one pass when all letters are seen', async () => {
    const seen: string[] = [];
    const marks = await locateDungeonLabels(
      {
        visionPass: (imageDataUrl, instruction) => {
          seen.push(instruction);
          expect(imageDataUrl).toBe('data:map');
          return Promise.resolve({ text: locateReply(FULL_MARKS) });
        },
      },
      { imageDataUrl: 'data:map', labels: ['A', 'B', 'C', 'D'] },
    );
    expect(marks).toEqual(FULL_MARKS);
    // No re-ask when nothing is missing.
    expect(seen).toHaveLength(1);
  });

  it('re-asks for ONLY the miss with the found points as context, then returns label order', async () => {
    const instructions: string[] = [];
    let calls = 0;
    const marks = await locateDungeonLabels(
      {
        visionPass: (_imageDataUrl, instruction) => {
          instructions.push(instruction);
          calls += 1;
          return Promise.resolve({
            text: calls === 1
              ? locateReply(FULL_MARKS.slice(0, 3))
              : locateReply([FULL_MARKS[3] ?? { label: 'D', x: 0, y: 0 }]),
          });
        },
      },
      { imageDataUrl: 'data:map', labels: ['A', 'B', 'C', 'D'] },
    );
    expect(marks).toEqual(FULL_MARKS);
    expect(instructions).toHaveLength(2);
    expect(instructions[1]).toContain('You missed these room plaques: D.');
    expect(instructions[1]).toContain('Already located (context only');
    expect(instructions[1]).toContain('A at (100, 200)');
  });

  it('fails loud naming the still-missing letter when the re-ask cannot find it', async () => {
    await expect(
      locateDungeonLabels(
        {
          visionPass: () => Promise.resolve({ text: locateReply(FULL_MARKS.slice(0, 3)) }),
        },
        { imageDataUrl: 'data:map', labels: ['A', 'B', 'C', 'D'] },
      ),
    ).rejects.toThrow(VisionLocateError);
    await expect(
      locateDungeonLabels(
        {
          visionPass: () => Promise.resolve({ text: locateReply(FULL_MARKS.slice(0, 3)) }),
        },
        { imageDataUrl: 'data:map', labels: ['A', 'B', 'C', 'D'] },
      ).catch((error: unknown) => {
        if (!(error instanceof VisionLocateError)) throw new Error('expected a VisionLocateError');
        return error.missing;
      }),
    ).resolves.toEqual(['D']);
  });

  it('keeps the first validated mark per letter when the model repeats a sighting', async () => {
    const marks = await locateDungeonLabels(
      {
        visionPass: () =>
          Promise.resolve({
            text: locateReply([
              { label: 'A', x: 100, y: 200 },
              { label: 'A', x: 999, y: 999 },
              ...FULL_MARKS.slice(1),
            ]),
          }),
      },
      { imageDataUrl: 'data:map', labels: ['A', 'B', 'C', 'D'] },
    );
    expect(marks[0]).toEqual({ label: 'A', x: 100, y: 200 });
  });

  it('reuses the lab recipe schema and parser (production-hardened research path)', () => {
    // The lab aliases the shared contract — same reference, not a copy.
    expect(dungeonVisionReplySchema).toBe(visionLocateReplySchema);
    const sample = locateReply([{ label: 'A', x: 1, y: 2 }]);
    expect(parseDungeonVisionReply(sample)).toEqual(parseVisionLocateReply(sample));
    expect(buildVisionLocateInstruction(['A', 'B'])).toContain('A through B');
    expect(buildVisionRelocateInstruction(['B'], [{ label: 'A', x: 1, y: 2 }])).toContain(
      'You missed these room plaques: B.',
    );
  });
});

describe('vision-map pipeline (docs/11 vision path)', () => {
  it('maps a complex brief through brief→vision-map→finalize with letters + observed points and no geometry', async () => {
    const { campaign, cartographer } = await setup('classic');
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(COMPLEX_BRIEF), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: locateReply(FULL_MARKS), modelUsed: 'test-model', fallback: null });
    const runInput = { ...input(campaign, cartographer), dungeonMapPath: 'vision' as const };
    const runId = await runEngine.startRun(runInput);
    await waitForBriefPause(runId);
    // The brief stamps the resolved path from the room count + the override.
    expect((await getRun(runId))?.steps.find((step) => step.name === 'brief')?.output).toMatchObject({
      mapPath: 'vision',
    });
    await runEngine.approve(runId, runInput);
    await waitForRun(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });
    // The pipeline is brief→vision-map→finalize — no layout/schematic/
    // stylize/pick steps exist on a vision run, and no pick pause: the
    // single map is selected by contract (locate+verify was the gate).
    expect((await getRun(runId))?.steps.map((step) => step.name)).toEqual([
      'brief', 'vision-map', 'finalize',
    ]);

    // ONE map candidate by contract — no pick step, no aspect normalization
    // crop (the image IS the map).
    expect(vi.mocked(encounterRunAdapters.generateImages)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(encounterRunAdapters.generateImages).mock.calls[0]?.[1]).toBe(1);
    expect(encounterRunAdapters.normalizeImageAspect).not.toHaveBeenCalled();
    const prompt = vi.mocked(encounterRunAdapters.generateImages).mock.calls[0]?.[0] ?? '';
    // Sidecar-first reuse: the prompt renders the brief's rooms + graph.
    expect(prompt).toContain('Room A: Entry — Broken doors.');
    expect(prompt).toContain('Room D: Sanctum — A dark altar.');
    expect(prompt).toContain('A ↔ B');
    // The sidecar carried the brief's entryRoomIndex (0 → A): the prompt
    // draws room A as the visual entrance, and no other room gets the clause.
    expect(prompt).toContain('Room A is the dungeon entrance');
    expect(prompt).not.toContain('Room B is the dungeon entrance');

    const run = await getRun(runId);
    const artifact = await getArtifact(run?.resultArtifactId ?? newId());
    if (artifact?.kind !== 'encounter') throw new Error('encounter missing');
    const layout = artifact.data.layout;
    if (layout === null) throw new Error('vision run persisted no layout');
    expect(layout.mapPath).toBe('vision');
    expect(layout.rooms.map((room) => room.letter)).toEqual(['A', 'B', 'C', 'D']);
    expect(layout.rooms.map((room) => [room.observedX, room.observedY])).toEqual([
      [0.1, 0.2], [0.4, 0.2], [0.4, 0.6], [0.7, 0.6],
    ]);
    // The entry room id/letter matches the entryRoomIndex resolution: room A
    // carries the spawn flag and the stored path leads with it.
    expect(layout.rooms.map((room) => room.spawn)).toEqual([true, false, false, false]);
    expect(layout.path?.[0]).toBe(layout.rooms[0]?.id);
    // Geometry posture: NO packed geometry on vision rooms.
    for (const room of layout.rooms) {
      expect(room.rects).toBeUndefined();
      expect(room.mobsRect).toBeUndefined();
      expect(room.entrance).toBeUndefined();
    }
    // Connectivity is the sidecar's declared room graph.
    const pairs = layout.corridors.map((corridor) => {
      const a = layout.rooms.findIndex((room) => room.id === corridor.a);
      const b = layout.rooms.findIndex((room) => room.id === corridor.b);
      return [Math.min(a, b), Math.max(a, b)].join('<>');
    });
    expect(pairs.sort()).toEqual(['0<>1', '1<>2', '2<>3']);
    for (const corridor of layout.corridors) {
      expect(corridor.rects).toBeUndefined();
    }
    // The stored map image is the run's single candidate.
    const stored = await getImage(artifact.data.mapImageId ?? '');
    expect(stored?.role).toBe('map');
    expect(artifact.imageIds).toEqual([artifact.data.mapImageId]);
  });

  it('re-asks a missed plaque mid-run and completes when the re-ask finds it', async () => {
    const { campaign, cartographer } = await setup('classic');
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(COMPLEX_BRIEF), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: locateReply(FULL_MARKS.slice(0, 3)), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: locateReply([FULL_MARKS[3] ?? { label: 'D', x: 0, y: 0 }]), modelUsed: 'test-model', fallback: null });
    const runInput = { ...input(campaign, cartographer), dungeonMapPath: 'vision' as const };
    const runId = await runEngine.startRun(runInput);
    await waitForBriefPause(runId);
    await runEngine.approve(runId, runInput);
    await waitForRun(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });
    // Brief + locate + focused re-ask — exactly one re-ask, no new map.
    expect(chatMock).toHaveBeenCalledTimes(3);
    expect(vi.mocked(encounterRunAdapters.generateImages)).toHaveBeenCalledTimes(1);
    const run = await getRun(runId);
    const artifact = await getArtifact(run?.resultArtifactId ?? newId());
    if (artifact?.kind !== 'encounter') throw new Error('encounter missing');
    expect(artifact.data.layout?.rooms.map((room) => room.letter)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('fails the map step loud with nothing persisted when a plaque stays missing', async () => {
    const { campaign, cartographer } = await setup('classic');
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(COMPLEX_BRIEF), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: locateReply(FULL_MARKS.slice(0, 3)), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: locateReply(FULL_MARKS.slice(0, 3)), modelUsed: 'test-model', fallback: null });
    const runInput = {
      ...input(campaign, cartographer),
      autonomy: 'auto' as const,
      dungeonMapPath: 'vision' as const,
    };
    const runId = await runEngine.startRun(runInput);
    await waitForRun(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('failed');
      expect(run?.errorMessage).toContain('D');
    });
    const failed = await getRun(runId);
    expect(failed?.resultArtifactId).toBeNull();
    // Nothing persisted: the unattached candidate was pruned before the
    // throw — no invented coordinate, no orphaned image.
    expect(await listImagesByCampaign(campaign.id)).toEqual([]);
    expect(vi.mocked(encounterRunAdapters.generateImages)).toHaveBeenCalledTimes(1);
  });

  it('designates a non-zero entry room: the entrance names its letter, spawn + path + ingress follow', async () => {
    const { campaign, cartographer } = await setup('classic');
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify({ ...COMPLEX_BRIEF, entryRoomIndex: 2 }), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: locateReply(FULL_MARKS), modelUsed: 'test-model', fallback: null });
    const runInput = { ...input(campaign, cartographer), dungeonMapPath: 'vision' as const };
    const runId = await runEngine.startRun(runInput);
    await waitForBriefPause(runId);
    await runEngine.approve(runId, runInput);
    await waitForRun(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });
    // The sidecar carried entryRoomIndex 2 through: room C is drawn as the
    // entrance, and no other room gets the clause.
    const prompt = vi.mocked(encounterRunAdapters.generateImages).mock.calls[0]?.[0] ?? '';
    expect(prompt).toContain('Room C is the dungeon entrance');
    expect(prompt).not.toContain('Room A is the dungeon entrance');
    const run = await getRun(runId);
    const artifact = await getArtifact(run?.resultArtifactId ?? newId());
    if (artifact?.kind !== 'encounter') throw new Error('encounter missing');
    const layout = artifact.data.layout;
    if (layout === null) throw new Error('vision run persisted no layout');
    expect(layout.rooms[2]?.letter).toBe('C');
    expect(layout.rooms.map((room) => room.spawn)).toEqual([false, false, true, false]);
    expect(layout.path?.[0]).toBe(layout.rooms[2]?.id);
    // Party ingress resolves to the entry point: the table stages at C's plaque.
    const moduleRow = await createModuleRepo(
      createModule({ campaignId: campaign.id, title: 'Seed Module', concept: '', levelMin: 1, levelMax: 3, sizeDial: 'sketch' }),
    );
    const { battle } = await seedBattleFromEncounter(campaign.id, moduleRow.id, artifact.id);
    expect(battle.board.stagingGround?.x).toBeCloseTo(0.4, 9);
    expect(battle.board.stagingGround?.y).toBeCloseTo(0.6, 9);
  });

  it('fails the map step loud with nothing persisted when the ENTRY plaque stays missing', async () => {
    const { campaign, cartographer } = await setup('classic');
    // The entry plaque (A) is never seen — the existing miss policy covers
    // its absence exactly like any other letter, naming it loud.
    const withoutEntry = FULL_MARKS.slice(1);
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(COMPLEX_BRIEF), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: locateReply(withoutEntry), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: locateReply(withoutEntry), modelUsed: 'test-model', fallback: null });
    const runInput = {
      ...input(campaign, cartographer),
      autonomy: 'auto' as const,
      dungeonMapPath: 'vision' as const,
    };
    const runId = await runEngine.startRun(runInput);
    await waitForRun(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('failed');
      expect(run?.errorMessage).toContain('A');
    });
    const failed = await getRun(runId);
    expect(failed?.resultArtifactId).toBeNull();
    expect(await listImagesByCampaign(campaign.id)).toEqual([]);
    expect(vi.mocked(encounterRunAdapters.generateImages)).toHaveBeenCalledTimes(1);
  });

  it('lets an explicit classic override beat a vision setting', async () => {
    const { campaign, cartographer } = await setup('vision');
    chatMock.mockResolvedValueOnce({ text: JSON.stringify(COMPLEX_BRIEF), modelUsed: 'test-model', fallback: null });
    const runInput = { ...input(campaign, cartographer), dungeonMapPath: 'classic' as const };
    const runId = await runEngine.startRun(runInput);
    await waitForBriefPause(runId);
    expect((await getRun(runId))?.steps.find((step) => step.name === 'brief')?.output).toMatchObject({
      mapPath: 'classic',
    });
    await runEngine.approve(runId, runInput);
    await waitForRun(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('awaiting_user');
      expect(run?.steps.at(-1)?.name).toBe('pick');
    });
    expect((await getRun(runId))?.steps.map((step) => step.name)).toEqual([
      'brief', 'layout', 'schematic', 'stylize', 'pick',
    ]);
  });

  it('ignores the vision setting for a single arena (always classic)', async () => {
    const { campaign, cartographer } = await setup('vision');
    chatMock.mockResolvedValueOnce({ text: JSON.stringify(SINGLE_BRIEF), modelUsed: 'test-model', fallback: null });
    const runInput = input(campaign, cartographer);
    const runId = await runEngine.startRun(runInput);
    await waitForBriefPause(runId);
    expect((await getRun(runId))?.steps.find((step) => step.name === 'brief')?.output).toMatchObject({
      mapPath: 'classic',
    });
    await runEngine.approve(runId, runInput);
    await waitForRun(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('awaiting_user');
      expect(run?.steps.at(-1)?.name).toBe('pick');
    });
    expect(encounterRunAdapters.generateImages).toHaveBeenCalled();
  });

  it('keeps repopulation path-independent under a vision setting (map + rooms preserved)', async () => {
    const { campaign } = await setup('vision');
    const goblinChunkId = await seedRepopulatePackBook();
    const before = await seedComplexTarget(campaign.id, goblinChunkId);
    chatMock.mockResolvedValueOnce({ text: JSON.stringify(REPOPULATE_BRIEF), modelUsed: 'test-model', fallback: null });
    await repopulateEncounter(before.id, { redesignProse: false });
    const after = await getArtifact(before.id);
    if (after?.kind !== 'encounter') throw new Error('encounter missing');
    // Room geometry, keys, corridors, path and the battlemap ride along
    // untouched — only monsterIndexes (re-partitioned onto the new roster)
    // and stamped targetLevels change.
    expect(after.data.layout?.rooms.map((room) => ({
      id: room.id, name: room.name, rects: room.rects, mobsRect: room.mobsRect,
      description: room.description, spawn: room.spawn, key: room.key, keyTreasure: room.keyTreasure,
    }))).toEqual(before.data.layout?.rooms.map((room) => ({
      id: room.id, name: room.name, rects: room.rects, mobsRect: room.mobsRect,
      description: room.description, spawn: room.spawn, key: room.key, keyTreasure: room.keyTreasure,
    })));
    expect(after.data.layout?.corridors).toEqual(before.data.layout?.corridors);
    expect(after.data.layout?.path).toEqual(before.data.layout?.path);
    expect(after.data.mapImageId).toBe(before.data.mapImageId);
    expect(after.data.monsters.map((entry) => entry.name)).toEqual([
      'Goblin Boss', 'Goblin Boss', 'Goblin Boss', 'Goblin Boss',
    ]);
    // No map work ran at all.
    expect(encounterRunAdapters.generateImages).not.toHaveBeenCalled();
  });

  it('seeds the table at the spawn room observed point with no geometry', async () => {
    const { campaign, cartographer } = await setup('classic');
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(COMPLEX_BRIEF), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({ text: locateReply(FULL_MARKS), modelUsed: 'test-model', fallback: null });
    const runInput = { ...input(campaign, cartographer), dungeonMapPath: 'vision' as const };
    const runId = await runEngine.startRun(runInput);
    await waitForBriefPause(runId);
    await runEngine.approve(runId, runInput);
    await waitForRun(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });
    const run = await getRun(runId);
    const artifact = await getArtifact(run?.resultArtifactId ?? newId());
    if (artifact?.kind !== 'encounter') throw new Error('encounter missing');
    const moduleRow = await createModuleRepo(
      createModule({ campaignId: campaign.id, title: 'Seed Module', concept: '', levelMin: 1, levelMax: 3, sizeDial: 'sketch' }),
    );
    const { battle } = await seedBattleFromEncounter(campaign.id, moduleRow.id, artifact.id);
    // The observed point IS the spawn: the party stages AT plaque A.
    expect(battle.board.stagingGround?.x).toBeCloseTo(0.1, 9);
    expect(battle.board.stagingGround?.y).toBeCloseTo(0.2, 9);
    // Every monster spawn group is covered (one fog veil per room group).
    expect(battle.board.veils).toHaveLength(4);
    // All four rooms' monsters reached the board around their plaques.
    expect(battle.board.tokens.length).toBeGreaterThan(0);
  });
});

/** A repopulation brief: four sourced fights, one per mirrored room. */
const REPOPULATE_BRIEF = {
  name: 'Ash Temple Undercroft',
  summary: 'A four-room crypt under the ash temple.',
  body: '# Ash Temple\nFour rooms of cultists.',
  difficulty: 'hard',
  levelHint: '4',
  terrain: 'crypt stone',
  tactics: 'hold the lines',
  treasure: 'cult hoard',
  theme: 'ash-choked crypt',
  styleNotes: 'inked fantasy map',
  negative: 'text, labels, tokens',
  environment: 'dungeon',
  monsters: [
    { name: 'Goblin Boss', count: 2, notes: 'entry guards', treasure: '', sourceName: 'Goblin Boss' },
    { name: 'Goblin Boss', count: 2, notes: 'ossuary pack', treasure: '', sourceName: 'Goblin Boss' },
    { name: 'Goblin Boss', count: 2, notes: 'ritual circle', treasure: '', sourceName: 'Goblin Boss' },
    { name: 'Goblin Boss', count: 2, notes: 'sanctum guard', treasure: '', sourceName: 'Goblin Boss' },
  ],
  rooms: [
    { name: 'Entry', description: '', size: 'medium', monsterIndexes: [0], adjacentRoomIndexes: [1], key: '', keyTreasure: '', targetLevel: 4 },
    { name: 'Ossuary', description: '', size: 'medium', monsterIndexes: [1], adjacentRoomIndexes: [0, 2], key: '', keyTreasure: '', targetLevel: 4 },
    { name: 'Ritual Chamber', description: '', size: 'large', monsterIndexes: [2], adjacentRoomIndexes: [1, 3], key: '', keyTreasure: '', targetLevel: 4 },
    { name: 'Sanctum', description: '', size: 'large', monsterIndexes: [3], adjacentRoomIndexes: [2], key: '', keyTreasure: '', targetLevel: 4 },
  ],
  entryRoomIndex: 0,
};

async function seedRepopulatePackBook(): Promise<string> {
  const book = await createPackBook({ title: 'Dnd5e Bestiary Pack', system: 'dnd5e', filename: 'pack.zip' });
  await finalizePackBook(book.id, {
    sourceId: 'foundry-pf2e',
    license: 'Community Use Policy',
    entriesImported: 1,
    entriesSkipped: 0,
    entriesFailed: 0,
  });
  const text = 'Goblin Boss, humanoid, agile commander.';
  await putChunks([
    ruleChunkSchema.parse({
      ...stampNewEntity(),
      bookId: book.id,
      pageStart: 1,
      pageEnd: 1,
      chunkType: 'statblock',
      headingPath: ['Goblin Boss'],
      text,
      statBlock: statBlockSchema.parse({
        system: 'dnd5e',
        level: '1',
        size: 'Small',
        creatureType: 'humanoid (goblinoid)',
        ac: 17,
        acNote: '',
        hp: 21,
        hpFormula: '3d6 + 11',
        speed: '30 ft.',
        abilities: { str: 14, dex: 14, con: 10, int: 10, wis: 8, cha: 8 },
        saves: '',
        skills: '',
        senses: 'darkvision 60 ft.',
        languages: 'Common, Goblin',
        traits: [],
        actions: [],
        reactions: [],
        legendary: [],
        extras: { Traits: 'humanoid, goblinoid' },
      }),
      contentHash: await sha256Hex(text),
    }),
  ]);
  const { db } = await import('@/db');
  const chunk = await db.chunks.where('bookId').equals(book.id).first();
  return chunk?.id ?? '';
}

/** A valid persisted 4-room complex layout (rooms on file to restock). */
function complexLayoutFixture() {
  const ids = [newId(), newId(), newId(), newId()];
  const names = ['Entry', 'Ossuary', 'Ritual Chamber', 'Sanctum'];
  return {
    gridW: 40,
    gridH: 12,
    theme: 'ash temple',
    rooms: ids.map((id, index) => ({
      id,
      name: names[index] ?? `Room ${String(index)}`,
      rects: [{ x: 2 + index * 10, y: 2, w: 6, h: 6 }],
      mobsRect: { x: 3 + index * 10, y: 3, w: 3, h: 3 },
      description: '',
      monsterIndexes: index === 0 ? [0] : [],
      spawn: index === 0,
      key: index === 1 ? 'A cracked altar.' : '',
      keyTreasure: '',
    })),
    corridors: [
      { a: ids[0] ?? newId(), b: ids[1] ?? newId(), rects: [{ x: 8, y: 5, w: 4, h: 1 }] },
      { a: ids[1] ?? newId(), b: ids[2] ?? newId(), rects: [{ x: 18, y: 5, w: 4, h: 1 }] },
      { a: ids[2] ?? newId(), b: ids[3] ?? newId(), rects: [{ x: 28, y: 5, w: 4, h: 1 }] },
    ],
    path: ids,
  };
}

async function seedComplexTarget(
  campaignId: Id,
  goblinChunkId: Id,
): Promise<Artifact & { kind: 'encounter' }> {
  const target = await createArtifact({
    campaignId,
    kind: 'encounter',
    name: 'Old Undercroft',
    summary: 'Old summary.',
    body: 'Existing prose.',
    links: [],
    data: {
      difficulty: 'old', levelHint: '4',
      monsters: [{ name: 'Tomb Ogre', count: 4, notes: 'keep', treasure: 'Ogre pocket: 4 gp', source: { type: 'rulebook', chunkId: goblinChunkId } }],
      terrain: '', tactics: '', treasure: '',
      mapImageId: newId(), preset: 'dungeon', locationKind: 'dungeon',
      siteShape: 'complex', budgetAdvisory: 'STALE ADVISORY',
      layout: complexLayoutFixture(),
      fillGrade: 100,
    },
  });
  if (target.kind !== 'encounter') throw new Error('encounter target missing');
  return target;
}
