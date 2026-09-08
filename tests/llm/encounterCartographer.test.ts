import 'fake-indexeddb/auto';

import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact, getAnyArtifact, getArtifact, listArtifactsByCampaign } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { getImage } from '@/db/imageRepo';
import { putChunks } from '@/db/chunkRepo';
import { createPackBook, finalizePackBook } from '@/db/rulebookRepo';
import { getRun, updateRun } from '@/db/runRepo';
import { saveSettings } from '@/db/settingsRepo';
import { encounterRunAdapters, rejectionIssues, runEngine, type StartRunInput } from '@/llm/runEngine';
import { chat } from '@/llm/openrouter';
import { createPersona, defaultSettings, newId, ruleChunkSchema, stampNewEntity, statBlockSchema, type Id, type Persona } from '@/domain';
import { sha256Hex } from '@/lib/hash';
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

const chatMock = vi.mocked(chat);
const { searchRules } = await import('@/search');
const searchRulesMock = vi.mocked(searchRules);

function waitForRun(assertion: () => void | Promise<void>) {
  return waitFor(assertion, { timeout: 15000 });
}

const INLINE_STATBLOCK = {
  system: 'dnd5e', level: '1', size: 'Medium', creatureType: 'humanoid', ac: 12,
  acNote: '', hp: 7, hpFormula: '2d6', speed: '30 ft.',
  abilities: { str: 10, dex: 12, con: 10, int: 10, wis: 10, cha: 10 },
  saves: '', skills: '', senses: '', languages: '', traits: [], actions: [], reactions: [], legendary: [], extras: {},
};

const BRIEF = {
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
  negative: 'text, labels, tokens',
  monsters: [{ name: 'Ash Cultist', count: 2, notes: '', treasure: 'Robes: 2 gp, an ash charm', statBlock: INLINE_STATBLOCK }],
  rooms: [
    { name: 'Entry', description: 'Broken doors', size: 'medium', monsterIndexes: [0], adjacentRoomIndexes: [], key: 'Cracked doors hang off one hinge.', keyTreasure: 'Fallen banner: 15 gp' },
  ],
  entryRoomIndex: 0,
};

function persona(): Persona {
  return createPersona({
    slug: 'encounter-cartographer-test',
    name: 'Encounter Cartographer',
    description: '',
    systemPrompt: 'Return encounter JSON.',
    mode: 'encounter',
    producesKind: 'encounter',
    builtIn: true,
  });
}

async function setup(system: 'dnd5e' | 'pathfinder2e' = 'dnd5e') {
  const campaign = await createCampaign({ name: 'Map Campaign', system });
  const cartographer = persona();
  const { db } = await import('@/db');
  await db.personas.put(cartographer);
  await saveSettings({ ...defaultSettings(), openRouterApiKey: 'test-key', imagesEnabled: true });
  return { campaign, cartographer };
}

/** Seeds a ready pack book with one validated creature chunk (12-BESTIARY-PACKS). */
async function seedPackBook(): Promise<string> {
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

/**
 * Seeds a ready pack book that imported ITEMS (12-BESTIARY-PACKS §13):
 * one validated item chunk (a dnd5e Bag of Beans) with itemsImported > 0 —
 * the collectItemPool book filter's positive case.
 */
async function seedItemPackBook(): Promise<string> {
  const book = await createPackBook({ title: 'Dnd5e Equipment Pack', system: 'dnd5e', filename: 'equipment.zip' });
  await finalizePackBook(book.id, {
    sourceId: 'foundry-dnd5e-equipment',
    license: 'CC-BY-4.0',
    entriesImported: 1,
    entriesSkipped: 0,
    entriesFailed: 0,
    itemsImported: 1,
  });
  const text = 'Bag of Beans — equipment · 2000 gp · rare';
  await putChunks([
    ruleChunkSchema.parse({
      ...stampNewEntity(),
      bookId: book.id,
      pageStart: 1,
      pageEnd: 1,
      chunkType: 'item',
      headingPath: ['Bag of Beans'],
      text,
      statBlock: null,
      itemData: {
        system: 'dnd5e',
        category: 'equipment',
        level: null,
        priceDisplay: '2000 gp',
        priceCp: 200000,
        rarity: 'rare',
        traits: [],
        rulesEdition: '2024',
      },
      contentHash: await sha256Hex(text),
    }),
  ]);
  return book.id;
}

function input(
  campaign: Awaited<ReturnType<typeof createCampaign>>,
  cartographer: Persona,
  targetArtifactId?: string,
): StartRunInput {
  return {
    campaign,
    persona: cartographer,
    autonomy: 'manual',
    brief: 'A temple gate encounter',
    pinnedChunkIds: [],
    encounterMapAspect: '4:3',
    ...(targetArtifactId === undefined ? {} : { targetArtifactId }),
  };
}

beforeEach(async () => {
  await clearDatabase();
  useProgressStore.getState().reset();
  chatMock.mockReset();
  searchRulesMock.mockReset();
  searchRulesMock.mockResolvedValue([]);
  vi.spyOn(encounterRunAdapters, 'renderSchematic').mockReturnValue({ dataUrl: 'data:image/png;base64,schematic', width: 2304, height: 1728 });
  vi.spyOn(encounterRunAdapters, 'generateImages').mockResolvedValue({ images: [new Blob(['one']), new Blob(['two'])], costUsd: 0.02, cappedToOne: false, modelUsed: 'test-image-model', fallback: null, filteredCount: 0 });
  vi.spyOn(encounterRunAdapters, 'normalizeImageAspect').mockImplementation((blob) => Promise.resolve({ blob, width: 1200, height: 900, action: 'none' }));
  vi.spyOn(encounterRunAdapters, 'intakeImage').mockImplementation((blob) => Promise.resolve({ blob, width: 1200, height: 900, mimeType: 'image/webp' }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function approveUntilPick(runId: string, runInput: StartRunInput): Promise<string[]> {
  await waitForRun(async () => {
    const run = await getRun(runId);
    expect(run?.status).toBe('awaiting_user');
    expect(run?.steps.at(-1)?.name).toBe('brief');
  });
  await runEngine.approve(runId, runInput);
  await waitForRun(async () => {
    const run = await getRun(runId);
    expect(run?.status).toBe('awaiting_user');
    expect(run?.steps.at(-1)?.name).toBe('pick');
  });
  const run = await getRun(runId);
  return (run?.steps.find((step) => step.name === 'pick')?.output as { candidates: string[] }).candidates;
}

/** The pick step's index by name (the 6-step plan keeps no verify step). */
async function pickIndexOf(runId: string): Promise<number> {
  const run = await getRun(runId);
  const index = run?.steps.find((step) => step.name === 'pick')?.index;
  if (index === undefined) throw new Error('run has no pick step');
  return index;
}


/** Looks up THE mob artifact created for `chunkId` — the get-or-create is
 *  idempotent, so at most one exists per campaign (the arc's core pin). */
async function mobArtifactIdOf(campaignId: Id, chunkId: Id): Promise<Id> {
  const mob = (await listArtifactsByCampaign(campaignId)).find(
    (row) => row.kind === 'npc' && row.data.monsterChunkId === chunkId,
  );
  if (mob === undefined) throw new Error(`no mob artifact for chunk ${chunkId}`);
  return mob.id;
}

describe('Encounter Cartographer run', () => {
  it('pauses at brief and pick and finalizes one complete encounter', async () => {
    const { campaign, cartographer } = await setup();
    chatMock.mockResolvedValueOnce({ text: JSON.stringify(BRIEF), modelUsed: 'test-model', fallback: null });
    const runInput = input(campaign, cartographer);
    const runId = await runEngine.startRun(runInput);
    const candidates = await approveUntilPick(runId, runInput);
    expect(candidates).toHaveLength(2);
    expect(useProgressStore.getState().jobs[0]?.detail).toContain('Waiting');

    // The pipeline is brief→layout→schematic→stylize→pick→finalize — NO
    // verify step (docs/11 D14): a manual run's last pause is the pick.
    const paused = await getRun(runId);
    expect(paused?.steps.map((step) => step.name)).toEqual([
      'brief', 'layout', 'schematic', 'stylize', 'pick',
    ]);

    await runEngine.editStep(runId, await pickIndexOf(runId), { keep: [candidates[0]] }, runInput);
    await waitForRun(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });
    const run = await getRun(runId);
    const artifact = await getArtifact(run?.resultArtifactId ?? newId());
    if (artifact?.kind !== 'encounter') throw new Error('encounter missing');
    expect(artifact.data.layout?.rooms).toHaveLength(1);
    // The budget loop stamped the encounter's parsed levelHint onto the room.
    expect(artifact.data.layout?.rooms[0]?.targetLevel).toBe(4);
    expect(artifact.data.budgetAdvisory).toBe('');
    expect(artifact.data.mapImageId).toBe(candidates[0]);
    expect(artifact.data.monsters[0]?.source.type).toBe('inline');
    expect(artifact.imageIds).toContain(candidates[0]);
    expect((await getImage(candidates[0] ?? ''))?.role).toBe('map');
    expect(await getImage(candidates[1] ?? '')).toBeUndefined();
    expect(useProgressStore.getState().jobs).toEqual([]);
  });

  it('persists the fallback notice on the stylize step (map degradations are visible)', async () => {
    const { campaign, cartographer } = await setup();
    chatMock.mockResolvedValueOnce({ text: JSON.stringify(BRIEF), modelUsed: 'test-model', fallback: null });
    // The stylize image call escalates to the fallback image model after a
    // content filter on the primary — the step must name both models
    // (AGENTS rule 1: a fallback is never silent).
    vi.mocked(encounterRunAdapters.generateImages).mockResolvedValueOnce({
      images: [new Blob(['map-one']), new Blob(['map-two'])],
      costUsd: 0.02,
      cappedToOne: false,
      modelUsed: 'potent/image',
      fallback: { from: 'cheap/image', to: 'potent/image', reason: 'filter' },
      filteredCount: 0,
    });
    const runInput = input(campaign, cartographer);
    const runId = await runEngine.startRun(runInput);
    await approveUntilPick(runId, runInput);

    const run = await getRun(runId);
    const output = run?.steps.find((step) => step.name === 'stylize')?.output as {
      notice?: string | null;
    };
    expect(output.notice).toContain('Content filter on “cheap/image”');
    expect(output.notice).toContain('the fallback model “potent/image” produced this image');
  });

  it('grounds the brief in the pack roster and resolves sourceName through map finalize (§7)', async () => {
    const { campaign, cartographer } = await setup();
    const goblinChunkId = await seedPackBook();
    await seedItemPackBook();
    const rosterBrief = {
      ...BRIEF,
      monsters: [{ name: 'Goblin Boss', count: 2, notes: '', sourceName: 'Goblin Boss' }],
    };
    chatMock.mockResolvedValueOnce({ text: JSON.stringify(rosterBrief), modelUsed: 'test-model', fallback: null });
    const runInput = input(campaign, cartographer);
    const runId = await runEngine.startRun(runInput);

    // The brief prompt carries the roster section listing the pack creature.
    await waitFor(() => {
      expect(chatMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    });
    const briefContent =
      chatMock.mock.calls[0]?.[0].find((message) => message.role === 'user')?.content ?? '';
    expect(briefContent).toContain('Bestiary roster');
    expect(briefContent).toContain('Goblin Boss (1, humanoid, goblinoid)');
    // §13: the item pool grounds the brief's treasure field too (the item
    // pack book was seeded alongside the bestiary pack).
    expect(briefContent).toContain('Item pool — equipment available in the imported pack books:');
    expect(briefContent).toContain('Bag of Beans (equipment, 2000 gp, rare)');

    const candidates = await approveUntilPick(runId, runInput);
    await runEngine.editStep(runId, await pickIndexOf(runId), { keep: [candidates[0]] }, runInput);
    await waitForRun(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });
    const run = await getRun(runId);
    const artifact = await getArtifact(run?.resultArtifactId ?? newId());
    if (artifact?.kind !== 'encounter') throw new Error('encounter missing');
    // The map finalize remapped the roster citation to the pack chunk —
    // stamped with content identity at birth (chunk-hash-fallback arc).
    expect(artifact.data.monsters[0]?.source).toEqual({ type: 'rulebook', chunkId: goblinChunkId, mobArtifactId: await mobArtifactIdOf(campaign.id, goblinChunkId), contentHash: await sha256Hex('Goblin Boss, humanoid, agile commander.'), creatureName: 'Goblin Boss' });
  });

  it('finalizes a brief citing a pinned statblock chunk to {type:"rulebook", chunkId}', async () => {
    const { campaign, cartographer } = await setup();
    const goblinChunkId = await seedPackBook();
    // The pinned chunk does NOT rank (searches are mocked empty) — only the
    // pin makes it citable.
    const pinnedBrief = {
      ...BRIEF,
      monsters: [{ name: 'Goblin Boss', count: 2, notes: '', sourceChunkIndex: 0 }],
    };
    chatMock.mockResolvedValueOnce({ text: JSON.stringify(pinnedBrief), modelUsed: 'test-model', fallback: null });
    const runInput = { ...input(campaign, cartographer), pinnedChunkIds: [goblinChunkId] };
    const runId = await runEngine.startRun(runInput);

    // The brief prompt lists the PINNED chunk as citation excerpt [0].
    await waitFor(() => {
      expect(chatMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    });
    const briefContent =
      chatMock.mock.calls[0]?.[0].find((message) => message.role === 'user')?.content ?? '';
    expect(briefContent).toContain('Stat-block excerpts');
    expect(briefContent).toContain('[0] Dnd5e Bestiary Pack p.1 — Goblin Boss');

    const candidates = await approveUntilPick(runId, runInput);
    await runEngine.editStep(runId, await pickIndexOf(runId), { keep: [candidates[0]] }, runInput);
    await waitForRun(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });
    const run = await getRun(runId);
    const artifact = await getArtifact(run?.resultArtifactId ?? newId());
    if (artifact?.kind !== 'encounter') throw new Error('encounter missing');
    // The pinned citation (persisted with the brief through the pick pause)
    // resolved in map finalize to the pinned chunk — stamped with content
    // identity at birth (chunk-hash-fallback arc).
    expect(artifact.data.monsters[0]?.source).toEqual({ type: 'rulebook', chunkId: goblinChunkId, mobArtifactId: await mobArtifactIdOf(campaign.id, goblinChunkId), contentHash: await sha256Hex('Goblin Boss, humanoid, agile commander.'), creatureName: 'Goblin Boss' });
  });

  it('does not approve a rejected brief into an opaque downstream failure', async () => {
    const { campaign, cartographer } = await setup();
    // Both the initial reply and automatic repair fail the brief schema.
    chatMock.mockResolvedValue({ text: '{}', modelUsed: 'test-model', fallback: null });
    const runInput = input(campaign, cartographer);
    const runId = await runEngine.startRun(runInput);
    await waitForRun(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('awaiting_user');
      expect(run?.steps.at(-1)?.name).toBe('brief');
      expect(run?.steps.at(-1)?.status).toBe('rejected');
    });

    await expect(runEngine.approve(runId, runInput)).rejects.toThrow(
      'Encounter brief step has no valid approved output',
    );
    const run = await getRun(runId);
    expect(run?.status).toBe('awaiting_user');
    expect(run?.steps).toHaveLength(1);
  });

  it('tells the model and the user exactly why a brief was rejected', async () => {
    const { campaign, cartographer } = await setup();
    // First reply: a monster with neither excerpt nor inline stat block and a
    // room pointing outside the roster. Repair reply: the same, so the step
    // is rejected with the reasons persisted on the step.
    const broken = {
      ...BRIEF,
      monsters: [{ name: 'Ash Cultist', count: 2, notes: '' }],
      // Two rooms so the out-of-roster index at rooms[1] is what fails.
      rooms: [
        { ...BRIEF.rooms[0], monsterIndexes: [] },
        { name: 'Sanctum', description: '', size: 'large', monsterIndexes: [3], adjacentRoomIndexes: [0], key: '', keyTreasure: '' },
      ],
    };
    chatMock.mockResolvedValue({ text: JSON.stringify(broken), modelUsed: 'test-model', fallback: null });
    const runInput = input(campaign, cartographer);
    const runId = await runEngine.startRun(runInput);
    await waitForRun(async () => {
      expect((await getRun(runId))?.status).toBe('awaiting_user');
    });

    expect(chatMock).toHaveBeenCalledTimes(2);
    const repairMessages = chatMock.mock.calls[1]?.[0] ?? [];
    const repairTurn = repairMessages.at(-1);
    expect(repairTurn?.role).toBe('user');
    expect(typeof repairTurn?.content).toBe('string');
    expect(repairTurn?.content).toContain('rooms.1.monsterIndexes: monster index is outside roster');

    const step = (await getRun(runId))?.steps[0];
    expect(step?.status).toBe('rejected');
    expect(rejectionIssues(step ?? { output: null })).toEqual([
      'rooms.1.monsterIndexes: monster index is outside roster',
    ]);
  });

  it('reports a missing stat-block source by monster instead of a bare schema failure', async () => {
    const { campaign, cartographer } = await setup();
    const missingSource = {
      ...BRIEF,
      monsters: [{ name: 'Ash Cultist', count: 2, notes: '' }],
    };
    chatMock.mockResolvedValue({ text: JSON.stringify(missingSource), modelUsed: 'test-model', fallback: null });
    const runInput = input(campaign, cartographer);
    const runId = await runEngine.startRun(runInput);
    await waitForRun(async () => {
      expect((await getRun(runId))?.status).toBe('awaiting_user');
    });
    const step = (await getRun(runId))?.steps[0];
    expect(rejectionIssues(step ?? { output: null })).toEqual([
      'monsters[0] "Ash Cultist": add sourceChunkIndex citing a listed stat-block excerpt, sourceName citing a bestiary roster entry, or an inline statBlock',
    ]);
  });

  it('accepts numeric strings and a missing guidance field from the model', async () => {
    const { campaign, cartographer } = await setup();
    const loose: Record<string, unknown> = {
      ...BRIEF,
      monsters: [{ ...BRIEF.monsters[0], count: '2' }],
      rooms: BRIEF.rooms.map((room) => ({
        ...room,
        monsterIndexes: room.monsterIndexes.map(String),
        adjacentRoomIndexes: room.adjacentRoomIndexes.map(String),
      })),
      entryRoomIndex: '0',
    };
    delete loose.negative;
    chatMock.mockResolvedValueOnce({ text: JSON.stringify(loose), modelUsed: 'test-model', fallback: null });
    const runInput = input(campaign, cartographer);
    const runId = await runEngine.startRun(runInput);
    await waitForRun(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('awaiting_user');
      expect(run?.steps[0]?.status).toBe('done');
    });
    expect(chatMock).toHaveBeenCalledTimes(1);
    const output = (await getRun(runId))?.steps[0]?.output as {
      parsed: { monsters: { count: number }[]; entryRoomIndex: number; negative: string };
    };
    expect(output.parsed.monsters[0]?.count).toBe(2);
    expect(output.parsed.entryRoomIndex).toBe(0);
    expect(output.parsed.negative).toBe('');
  });

  it('validates a layout edit before downstream steps can observe it', async () => {
    const { campaign, cartographer } = await setup();
    chatMock.mockResolvedValueOnce({ text: JSON.stringify(BRIEF), modelUsed: 'test-model', fallback: null });
    const runInput = input(campaign, cartographer);
    const runId = await runEngine.startRun(runInput);
    await approveUntilPick(runId, runInput);

    await expect(runEngine.editStep(runId, 1, {}, runInput)).rejects.toThrow(
      'Encounter layout step has no valid approved output',
    );
    const run = await getRun(runId);
    expect(run?.status).toBe('awaiting_user');
    expect(run?.steps[1]?.status).toBe('done');
  });

  it('checks brief/layout prerequisites again when the user approves a map', async () => {
    const { campaign, cartographer } = await setup();
    chatMock.mockResolvedValueOnce({ text: JSON.stringify(BRIEF), modelUsed: 'test-model', fallback: null });
    const runInput = input(campaign, cartographer);
    const runId = await runEngine.startRun(runInput);
    const candidates = await approveUntilPick(runId, runInput);
    const run = await getRun(runId);
    if (run === undefined) throw new Error('run missing');
    await updateRun(runId, {
      steps: run.steps.map((step) =>
        step.name === 'layout' ? { ...step, output: {} } : step,
      ),
    });

    await expect(runEngine.editStep(runId, await pickIndexOf(runId), { keep: [candidates[0]] }, runInput)).rejects.toThrow(
      'Encounter layout step has no valid approved output',
    );
    const after = await getRun(runId);
    expect(after?.status).toBe('awaiting_user');
    expect(after?.steps.find((step) => step.name === 'pick')?.userEdit).toBeNull();
  });

  it('auto autonomy selects candidate one and completes without a pick pause', async () => {
    const { campaign, cartographer } = await setup();
    chatMock.mockResolvedValueOnce({ text: JSON.stringify(BRIEF), modelUsed: 'test-model', fallback: null });
    const runId = await runEngine.startRun({ ...input(campaign, cartographer), autonomy: 'auto' });
    await waitForRun(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });
    const run = await getRun(runId);
    const pick = run?.steps.find((step) => step.name === 'pick');
    const first = (pick?.output as { candidates?: string[] } | undefined)?.candidates?.[0];
    expect((pick?.userEdit as { keep?: string[] } | null)?.keep).toEqual([first]);
    expect(run?.resultArtifactId).not.toBeNull();
  });

  it('regenerates layout/map while preserving identity, prose, links and roster', async () => {
    const { campaign, cartographer } = await setup();
    const target = await createArtifact({
      campaignId: campaign.id,
      kind: 'encounter',
      name: 'Keep This Name',
      body: 'Keep this prose.',
      links: [{ targetId: newId(), relation: 'at' }],
      data: {
        difficulty: 'old', levelHint: '2',
        monsters: [{ name: 'Original Ogre', count: 1, notes: 'keep', treasure: 'Ogre pocket: 4 gp', source: { type: 'none' } }],
        terrain: 'old terrain', tactics: 'old tactics', treasure: 'old treasure',
        mapImageId: null, layout: null, preset: 'standard', locationKind: 'other', siteShape: 'single', budgetAdvisory: '',
      },
    });
    if (target.kind !== 'encounter') throw new Error('encounter target missing');
    chatMock.mockResolvedValueOnce({ text: JSON.stringify({ ...BRIEF, monsters: [{ name: 'Wrong Rename', count: 9, notes: '' }] }), modelUsed: 'test-model', fallback: null });
    const runInput = input(campaign, cartographer, target.id);
    const runId = await runEngine.startRun(runInput);
    const candidates = await approveUntilPick(runId, runInput);
    await runEngine.editStep(runId, await pickIndexOf(runId), { keep: [candidates[0]] }, runInput);
    await waitForRun(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });

    const updated = await getArtifact(target.id);
    expect(updated?.name).toBe(target.name);
    expect(updated?.body).toBe(target.body);
    expect(updated?.links).toEqual(target.links);
    if (updated?.kind !== 'encounter') throw new Error('encounter missing');
    expect(updated.data.monsters).toEqual(target.data.monsters);
    expect(updated.data.layout).not.toBeNull();
    expect(updated.data.mapImageId).toBe(candidates[0]);
    // Map regeneration replaces the room keys with the fresh brief's keys —
    // an accepted consequence, stated in the UI regeneration copy and the
    // prompt clause (owner-ratified).
    const freshKeys = updated.data.layout?.rooms.map((room) => room.key) ?? [];
    expect(freshKeys).toEqual(['Cracked doors hang off one hinge.']);
    // The encounter-scoped roster treasure survives the map run verbatim.
    expect(updated.data.monsters[0]?.treasure).toBe('Ogre pocket: 4 gp');
  });

  it('regenerate onto a global target is atomic: a post-reanchor failure rolls everything back', async () => {
    const { campaign, cartographer } = await setup();
    const { db } = await import('@/db');
    // Library-scoped encounter target with no map yet.
    const globalId = newId();
    await db.artifacts.put({
      id: globalId,
      createdAt: 1,
      updatedAt: 1,
      campaignId: null,
      moduleId: null,
      kind: 'encounter',
      name: 'Library Encounter',
      tags: [],
      aliases: [],
      summary: '',
      body: 'Keep this prose.',
      links: [],
      currentRevision: 1,
      imageIds: [],
      coverImageId: null,
      data: {
        difficulty: 'old', levelHint: '2',
        monsters: [{ name: 'Original Ogre', count: 1, notes: 'keep', treasure: '', source: { type: 'none' } }],
        terrain: 'old terrain', tactics: 'old tactics', treasure: 'old treasure',
        mapImageId: null, layout: null, preset: 'standard', locationKind: 'other', siteShape: 'single', budgetAdvisory: '',
      },
    });
    chatMock.mockResolvedValueOnce({ text: JSON.stringify({ ...BRIEF, monsters: [{ name: 'Wrong Rename', count: 9, notes: '' }] }), modelUsed: 'test-model', fallback: null });
    const runInput = input(campaign, cartographer, globalId);
    const runId = await runEngine.startRun(runInput);
    const candidates = await approveUntilPick(runId, runInput);

    // Structural pin (the attach-seam tx-wrapper pattern — NOT
    // vi.spyOn(db, 'transaction'), which breaks Dexie's PSD zone): the
    // regenerate finalize must ride exactly one array-form
    // images+artifacts+revisions transaction.
    let seamTxCount = 0;
    const originalTransaction = db.transaction.bind(db) as (...args: unknown[]) => unknown;
    const txTarget = db as unknown as { transaction: (...args: unknown[]) => unknown };
    txTarget.transaction = (...args: unknown[]) => {
      if (args[0] === 'rw' && Array.isArray(args[1]) && (args[1] as unknown[]).includes(db.images)) {
        seamTxCount += 1;
      }
      return originalTransaction(...args);
    };
    // The content write explodes AFTER the re-anchor — before the seam this
    // stranded the kept image in the library while the artifact kept the
    // old map.
    const putSpy = vi.spyOn(db.artifacts, 'put').mockRejectedValueOnce(new Error('injected post-reanchor failure'));
    try {
      await runEngine.editStep(runId, await pickIndexOf(runId), { keep: [candidates[0]] }, runInput);
      await waitForRun(async () => {
        expect((await getRun(runId))?.status).toBe('failed');
      });
    } finally {
      putSpy.mockRestore();
      txTarget.transaction = originalTransaction;
    }

    expect((await getRun(runId))?.errorMessage).toContain('injected post-reanchor failure');
    // The finalize rode the seam exactly once.
    expect(seamTxCount).toBe(1);
    // Atomic rollback: the artifact keeps the old (empty) map AND the fresh
    // image stayed campaign-anchored — no stranded library orphan.
    const unchanged = await getAnyArtifact(globalId);
    if (unchanged?.kind !== 'encounter') throw new Error('encounter missing');
    expect(unchanged.imageIds).toEqual([]);
    expect(unchanged.data.mapImageId).toBeNull();
    expect(unchanged.data.layout).toBeNull();
    expect((await getImage(candidates[0] ?? ''))?.campaignId).toBe(campaign.id);
  });

  it('persists brief room keys and monster treasure onto the finalized artifact', async () => {
    const { campaign, cartographer } = await setup();
    // The brief prompt teaches the room-key contract and the treasure
    // structure (fresh encounter: the Cartographer authors both).
    chatMock.mockResolvedValueOnce({ text: JSON.stringify(BRIEF), modelUsed: 'test-model', fallback: null });
    const runInput = input(campaign, cartographer);
    const runId = await runEngine.startRun(runInput);
    await waitFor(() => {
      expect(chatMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    });
    const briefContent =
      chatMock.mock.calls[0]?.[0].find((message) => message.role === 'user')?.content ?? '';
    expect(briefContent).toContain('Room keys: every room carries a "key"');
    expect(briefContent).toContain('Outdoor encounters get room keys too');
    expect(briefContent).toContain('key:string,keyTreasure:string');
    expect(briefContent).toContain('Treasure structure (owner-ratified)');

    const candidates = await approveUntilPick(runId, runInput);
    await runEngine.editStep(runId, await pickIndexOf(runId), { keep: [candidates[0]] }, runInput);
    await waitForRun(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });
    const run = await getRun(runId);
    const artifact = await getArtifact(run?.resultArtifactId ?? newId());
    if (artifact?.kind !== 'encounter') throw new Error('encounter missing');
    // Keys ride their rooms through packing; treasure rides the entry.
    const entry = artifact.data.layout?.rooms.find((room) => room.name === 'Entry');
    expect(entry?.key).toBe('Cracked doors hang off one hinge.');
    expect(entry?.keyTreasure).toBe('Fallen banner: 15 gp');
    expect(artifact.data.monsters[0]?.treasure).toBe('Robes: 2 gp, an ash charm');
  });

  it('ignores inline stat-block stubs when regenerating an existing encounter', async () => {
    const { campaign, cartographer } = await setup();
    const target = await createArtifact({
      campaignId: campaign.id,
      kind: 'encounter',
      name: 'Stub Source Encounter',
      body: 'Existing prose.',
      links: [],
      data: {
        difficulty: 'old', levelHint: '2',
        monsters: [{ name: 'Original Ogre', count: 1, notes: 'keep', treasure: '', source: { type: 'none' } }],
        terrain: 'old terrain', tactics: 'old tactics', treasure: 'old treasure',
        mapImageId: null, layout: null, preset: 'standard', locationKind: 'other', siteShape: 'single', budgetAdvisory: '',
      },
    });
    // The model echoes the roster but decorates it with a stub inline stat
    // block — irrelevant in regenerate mode, where sources are preserved.
    chatMock.mockResolvedValueOnce({ text: JSON.stringify({
      ...BRIEF,
      monsters: [{ name: 'Wrong Rename', count: 9, notes: '', statBlock: {} }],
    }), modelUsed: 'test-model', fallback: null });
    const runInput = input(campaign, cartographer, target.id);
    const runId = await runEngine.startRun(runInput);
    await waitForRun(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('awaiting_user');
      expect(run?.steps[0]?.status).toBe('done');
    });
    expect(chatMock).toHaveBeenCalledTimes(1);
    const output = (await getRun(runId))?.steps[0]?.output as {
      parsed: { monsters: { name: string; count: number; notes: string; treasure: string }[] };
    };
    // Regenerate mode copies the target roster verbatim INCLUDING treasure.
    expect(output.parsed.monsters).toEqual([{ name: 'Original Ogre', count: 1, notes: 'keep', treasure: '' }]);
  });

  it('rejects a regenerate brief whose roster length diverges from the target', async () => {
    const { campaign, cartographer } = await setup();
    const target = await createArtifact({
      campaignId: campaign.id,
      kind: 'encounter',
      name: 'Roster Length Encounter',
      body: 'Existing prose.',
      links: [],
      data: {
        difficulty: 'old', levelHint: '2',
        monsters: [{ name: 'Original Ogre', count: 1, notes: 'keep', treasure: '', source: { type: 'none' } }],
        terrain: 'old terrain', tactics: 'old tactics', treasure: 'old treasure',
        mapImageId: null, layout: null, preset: 'standard', locationKind: 'other', siteShape: 'single', budgetAdvisory: '',
      },
    });
    chatMock.mockResolvedValue({ text: JSON.stringify({
      ...BRIEF,
      monsters: [
        { name: 'Cultist A', count: 1, notes: '' },
        { name: 'Cultist B', count: 1, notes: '' },
      ],
    }), modelUsed: 'test-model', fallback: null });
    const runInput = input(campaign, cartographer, target.id);
    const runId = await runEngine.startRun(runInput);
    await waitForRun(async () => {
      expect((await getRun(runId))?.status).toBe('awaiting_user');
    });
    const step = (await getRun(runId))?.steps[0];
    expect(rejectionIssues(step ?? { output: null })).toEqual([
      'monsters: the target roster has exactly 1 entries — copy it verbatim in the same order (your reply listed 2)',
    ]);
  });

  it('reports unplaced roster entries as a repairable issue instead of a layout failure', async () => {
    const { campaign, cartographer } = await setup();
    chatMock.mockResolvedValue({ text: JSON.stringify({
      ...BRIEF,
      rooms: BRIEF.rooms.map((room) => ({ ...room, monsterIndexes: [] })),
    }), modelUsed: 'test-model', fallback: null });
    const runInput = input(campaign, cartographer);
    const runId = await runEngine.startRun(runInput);
    await waitForRun(async () => {
      expect((await getRun(runId))?.status).toBe('awaiting_user');
    });
    const step = (await getRun(runId))?.steps[0];
    expect(rejectionIssues(step ?? { output: null })).toEqual([
      'rooms: roster entry 0 must belong to exactly one room',
    ]);
  });

  it('regenerates candidates: re-runs stylize only, layout and keys byte-identical', async () => {
    const { campaign, cartographer } = await setup();
    chatMock.mockResolvedValueOnce({ text: JSON.stringify(BRIEF), modelUsed: 'test-model', fallback: null });
    const runInput = input(campaign, cartographer);
    const runId = await runEngine.startRun(runInput);
    const firstBatch = await approveUntilPick(runId, runInput);
    const before = await getRun(runId);
    if (before === undefined) throw new Error('run missing');
    const layoutBefore = JSON.stringify(before.steps.find((step) => step.name === 'layout'));
    const briefBefore = JSON.stringify(before.steps.find((step) => step.name === 'brief'));

    // Fresh batch: the generate adapter is called again (a NEW image call),
    // the previous pick output is replaced and the run pauses at pick again.
    vi.mocked(encounterRunAdapters.generateImages).mockResolvedValueOnce({
      images: [new Blob(['fresh-one']), new Blob(['fresh-two'])],
      costUsd: 0.02,
      cappedToOne: false,
      modelUsed: 'test-image-model', fallback: null, filteredCount: 0,
    });
    await runEngine.regenerateEncounterCandidates(runId, runInput);
    await waitForRun(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('awaiting_user');
      expect(run?.steps.at(-1)?.name).toBe('pick');
    });

    // The regenerate made exactly one new image call (stylize re-ran; brief
    // and layout are untouched — the LLM was not called again).
    expect(chatMock).toHaveBeenCalledTimes(1);
    const after = await getRun(runId);
    expect(after?.steps.find((step) => step.name === 'layout')).toBeTruthy();
    expect(JSON.stringify(after?.steps.find((step) => step.name === 'layout'))).toBe(layoutBefore);
    expect(JSON.stringify(after?.steps.find((step) => step.name === 'brief'))).toBe(briefBefore);
    const secondBatch = (after?.steps.find((step) => step.name === 'pick')?.output as { candidates: string[] }).candidates;
    expect(secondBatch).toHaveLength(2);
    // New candidates replace the old ones — no id carries over.
    expect(secondBatch.some((id) => firstBatch.includes(id))).toBe(false);
    // The discarded batch's unattached images were pruned.
    for (const id of firstBatch) {
      expect(await getImage(id)).toBeUndefined();
    }

    // The run continues coherently from the fresh batch's pick.
    await runEngine.editStep(runId, await pickIndexOf(runId), { keep: [secondBatch[0] ?? ''] }, runInput);
    await waitForRun(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });
    const run = await getRun(runId);
    const artifact = await getArtifact(run?.resultArtifactId ?? newId());
    if (artifact?.kind !== 'encounter') throw new Error('encounter missing');
    expect(artifact.data.mapImageId).toBe(secondBatch[0]);
    expect(artifact.data.layout?.rooms[0]?.key).toBe('Cracked doors hang off one hinge.');
  });

  it('completes a legacy run row that carries verify steps (parse drops them coherently)', async () => {
    const { campaign, cartographer } = await setup();
    chatMock.mockResolvedValueOnce({ text: JSON.stringify(BRIEF), modelUsed: 'test-model', fallback: null });
    const runInput = input(campaign, cartographer);
    const runId = await runEngine.startRun(runInput);
    const candidates = await approveUntilPick(runId, runInput);

    // Rewrite the row into the OLD 7-step shape: a verify step between
    // stylize and pick, later steps re-indexed (what pre-deletion runs
    // persisted). Put directly via Dexie — updateRun's parse now heals.
    const { db } = await import('@/db');
    const row = await db.runs.get(runId);
    if (row === undefined) throw new Error('run row missing');
    const legacy = [...row.steps];
    const pickAt = legacy.findIndex((step) => step.name === 'pick');
    if (pickAt === -1) throw new Error('run has no pick step');
    legacy.splice(pickAt, 0, {
      index: pickAt,
      name: 'verify',
      status: 'done',
      input: {},
      output: { verifications: [{ mismatchRatio: 0, needsReview: false, mismatchedIndexes: [], expected: { cols: 12, rows: 9 } }] },
      userEdit: null,
    });
    await db.runs.put({
      ...row,
      steps: legacy.map((step, index) => ({ ...step, index })),
    });

    // Parse-on-read tolerance: the verify step is dropped and the remainder
    // re-indexed, so the run still renders and continues from pick.
    const healed = await getRun(runId);
    expect(healed?.steps.map((step) => step.name)).toEqual([
      'brief', 'layout', 'schematic', 'stylize', 'pick',
    ]);
    expect(healed?.steps.every((step, index) => step.index === index)).toBe(true);

    // The pick → finalize continuation runs finalize (index-coherent): the
    // legacy shape would have skipped it entirely (completed without an
    // artifact).
    await runEngine.editStep(runId, await pickIndexOf(runId), { keep: [candidates[0] ?? ''] }, runInput);
    await waitForRun(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });
    const run = await getRun(runId);
    expect(run?.resultArtifactId).not.toBeNull();
    const artifact = await getArtifact(run?.resultArtifactId ?? newId());
    if (artifact?.kind !== 'encounter') throw new Error('encounter missing');
    expect(artifact.data.mapImageId).toBe(candidates[0]);
  });

  it('refuses map generation while the encounter has no roster', async () => {
    const { campaign, cartographer } = await setup();
    const target = await createArtifact({
      campaignId: campaign.id,
      kind: 'encounter',
      name: 'Empty Stub',
      body: '',
      links: [],
      data: {
        difficulty: '', levelHint: '', monsters: [], terrain: '', tactics: '', treasure: '',
        mapImageId: null, layout: null, preset: 'standard', locationKind: 'other', siteShape: 'single', budgetAdvisory: '',
      },
    });
    const runInput = input(campaign, cartographer, target.id);
    const runId = await runEngine.startRun(runInput);
    await waitForRun(async () => {
      expect((await getRun(runId))?.status).toBe('failed');
    });
    expect((await getRun(runId))?.errorMessage).toContain('no monsters yet');
    expect(chatMock).not.toHaveBeenCalled();
  });

  it('resumes a failed encounter run from stylize step without re-generating brief or layout', async () => {
    const { campaign, cartographer } = await setup();
    chatMock.mockResolvedValueOnce({ text: JSON.stringify(BRIEF), modelUsed: 'test-model', fallback: null });
    // Simulate image model failure on first attempt
    vi.mocked(encounterRunAdapters.generateImages).mockRejectedValueOnce(
      new Error('Image model temporarily unavailable (503)'),
    );

    const runInput = { ...input(campaign, cartographer), autonomy: 'auto' as const };
    const runId = await runEngine.startRun(runInput);

    await waitForRun(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('failed');
      expect(run?.errorMessage).toContain('Image model temporarily unavailable (503)');
    });

    const failedRun = await getRun(runId);
    expect(failedRun?.steps.find((s) => s.name === 'brief')?.status).toBe('done');
    expect(failedRun?.steps.find((s) => s.name === 'layout')?.status).toBe('done');
    expect(failedRun?.steps.find((s) => s.name === 'schematic')?.status).toBe('done');

    // Image model recovers
    vi.mocked(encounterRunAdapters.generateImages).mockResolvedValueOnce({
      images: [new Blob(['resumed-image'])],
      costUsd: 0.02,
      cappedToOne: false, modelUsed: 'test-image-model', fallback: null, filteredCount: 0,
    });

    await runEngine.resumeRun(runId);

    await waitForRun(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('completed');
    });

    const completedRun = await getRun(runId);
    expect(completedRun?.resultArtifactId).not.toBeNull();
    // Brief was NOT re-drafted — chat was called only once!
    expect(chatMock).toHaveBeenCalledTimes(1);
  });

  describe('stylize prompt contract (marker path deleted, docs/11 D7)', () => {
    it('keeps the entrance preserve-clause and drops every disc-painting clause', async () => {
      const { campaign, cartographer } = await setup();
      chatMock.mockResolvedValueOnce({ text: JSON.stringify(BRIEF), modelUsed: 'test-model', fallback: null });
      const runInput = input(campaign, cartographer);
      const runId = await runEngine.startRun(runInput);
      await approveUntilPick(runId, runInput);

      const prompt = vi.mocked(encounterRunAdapters.generateImages).mock.calls[0]?.[0] ?? '';
      // The painted schematic triangle keeps its preserve-clause...
      expect(prompt).toContain(
        "Entrance marker: The party enters the map through a single open gap in the entry room's outer wall",
      );
      expect(prompt).toContain('solid neon cyan triangle');
      expect(prompt).toContain('exactly as in the reference image');
      // ...and no room-disc / plaque painting is requested anywhere.
      expect(prompt).not.toContain('staging markers');
      expect(prompt).not.toContain('disc on open floor');
      expect(prompt).not.toContain('plaque labeled');
    });

    it('bans hallucinated label-like geometry (white/pale boxes, plaques, discs, signposts)', async () => {
      // Owner-observed failure: a jungle map came back with white rectangles
      // baked into the floors — the image model read the schematic's pale
      // room fills as geometry to preserve. The stylize prompt's hard-ban
      // list is the only lever we own, so it pins these negatives (the
      // contract pin IS the test — image generation itself is unmockable).
      const { campaign, cartographer } = await setup();
      chatMock.mockResolvedValueOnce({ text: JSON.stringify(BRIEF), modelUsed: 'test-model', fallback: null });
      const runInput = input(campaign, cartographer);
      const runId = await runEngine.startRun(runInput);
      await approveUntilPick(runId, runInput);

      const prompt = vi.mocked(encounterRunAdapters.generateImages).mock.calls[0]?.[0] ?? '';
      // Every pre-existing ban stays intact...
      for (const ban of [
        'no title banner',
        'no compass rose',
        'no map legend',
        'no scale bar',
        'no grid lines',
        'no text labels',
        'no characters',
        'no monsters',
        'no tokens',
        'no miniatures',
      ]) {
        expect(prompt.toLowerCase()).toContain(ban);
      }
      // ...plus the anti-hallucination negatives...
      for (const negative of [
        'white or pale boxes',
        'rectangles',
        'plaques',
        'discs',
        'signposts',
        'label-like geometry',
        'continuous natural terrain',
        'no discrete light-colored sub-rectangles',
      ]) {
        expect(prompt.toLowerCase()).toContain(negative);
      }
      // ...while the keep-structure instruction and the entrance
      // preserve-clause survive untouched.
      expect(prompt).toContain('Keep walls, openings, the entrance gap and overall structure exactly as in the reference image.');
      expect(prompt).toContain(
        "Entrance marker: The party enters the map through a single open gap in the entry room's outer wall",
      );
    });
  });

  describe('natural-site mode (docs/11: outdoor maps are prose-led)', () => {
    /** An outdoor variant of the fixture: the Cartographer classifies the
     * site honestly and writes site prose the prompt can lead with. */
    const OUTDOOR_BRIEF = {
      ...BRIEF,
      environment: 'outdoor',
      theme: 'mossy riverbank ambush',
      terrain: 'mossy riverbank thick with reeds',
      summary: 'Cultists hold a reed-choked riverbank at a fallen gate.',
    };

    function expectSharedBans(prompt: string): void {
      for (const ban of [
        'no title banner',
        'no compass rose',
        'no map legend',
        'no scale bar',
        'no grid lines',
        'no text labels',
        'no characters',
        'no monsters',
        'no tokens',
        'no miniatures',
        'white or pale boxes',
        'no discrete light-colored sub-rectangles',
      ]) {
        expect(prompt.toLowerCase()).toContain(ban);
      }
    }

    it('rebuilds the prompt from the encounter prose and drops the architectural clauses', async () => {
      const { campaign, cartographer } = await setup();
      chatMock.mockResolvedValueOnce({ text: JSON.stringify(OUTDOOR_BRIEF), modelUsed: 'test-model', fallback: null });
      const runInput = input(campaign, cartographer);
      const runId = await runEngine.startRun(runInput);
      await approveUntilPick(runId, runInput);

      // The placement overlay is the schematic the image model references.
      expect(vi.mocked(encounterRunAdapters.renderSchematic).mock.calls[0]?.[3]).toBe('natural');

      const prompt = vi.mocked(encounterRunAdapters.generateImages).mock.calls[0]?.[0] ?? '';
      // Prose-led: theme + terrain + summary lead the prompt…
      expect(prompt).toContain('Theme: mossy riverbank ambush');
      expect(prompt).toContain('Site: mossy riverbank thick with reeds.');
      expect(prompt).toContain('Scene: Cultists hold a reed-choked riverbank at a fallen gate.');
      expect(prompt).toContain(OUTDOOR_BRIEF.styleNotes);
      // …with NO architectural contract: no materials line, no keep-walls.
      expect(prompt).not.toContain('Environment materials');
      expect(prompt).not.toContain('Keep walls, openings');
      expect(prompt).not.toContain("open gap in the entry room's outer wall");
      // The reference is explained as placement-only, the entrance clause
      // softens to the approach path (marker mechanics unchanged)…
      expect(prompt).toContain('only marks placement');
      expect(prompt).toContain('visible approach path at the marked spot');
      expect(prompt).toContain('solid neon cyan triangle');
      // …and the usability hard-bans stay verbatim.
      expectSharedBans(prompt);
      expect(prompt).toContain(`Avoid: ${OUTDOOR_BRIEF.negative}`);
    });

    it('keeps the dungeon contract byte-identical for a dungeon brief', async () => {
      const { campaign, cartographer } = await setup();
      chatMock.mockResolvedValueOnce({ text: JSON.stringify(BRIEF), modelUsed: 'test-model', fallback: null });
      const runInput = input(campaign, cartographer);
      const runId = await runEngine.startRun(runInput);
      await approveUntilPick(runId, runInput);

      expect(vi.mocked(encounterRunAdapters.renderSchematic).mock.calls[0]?.[3]).toBe('architectural');

      const prompt = vi.mocked(encounterRunAdapters.generateImages).mock.calls[0]?.[0] ?? '';
      // The pre-mode architectural prompt, clause for clause.
      expect(prompt).toContain(
        'Environment materials: desaturated stone, wood, dirt. Water is dark navy, never cyan. Fungus is olive. Metal is bronze or rust, never yellow.',
      );
      expect(prompt).toContain('Keep walls, openings, the entrance gap and overall structure exactly as in the reference image.');
      expect(prompt).toContain(
        "Entrance marker: The party enters the map through a single open gap in the entry room's outer wall",
      );
      expectSharedBans(prompt);
    });

    it('stamps the target owner override and locationKind so the override flips the mode', async () => {
      const { campaign, cartographer } = await setup();
      // A ruin in the woods: the run classifies outdoor AND the persisted
      // row says wilderness — the owner's architectural override wins.
      const forestRuin = await createArtifact({
        campaignId: campaign.id,
        kind: 'encounter',
        name: 'Ruin in the Woods',
        body: 'Keep this prose.',
        data: {
          difficulty: 'hard', levelHint: '4',
          monsters: [{ name: 'Ash Cultist', count: 2, notes: '', treasure: '', source: { type: 'none' } }],
          terrain: 'old terrain', tactics: '', treasure: '',
          mapImageId: null, layout: null, preset: 'standard',
          locationKind: 'wilderness', mapMode: 'architectural', siteShape: 'single', budgetAdvisory: '',
        },
      });
      chatMock.mockResolvedValueOnce({ text: JSON.stringify(OUTDOOR_BRIEF), modelUsed: 'test-model', fallback: null });
      const runInput = input(campaign, cartographer, forestRuin.id);
      const runId = await runEngine.startRun(runInput);
      await approveUntilPick(runId, runInput);

      // The override rode the brief step output and wins the derivation.
      const briefStep = (await getRun(runId))?.steps.find((step) => step.name === 'brief');
      expect(briefStep?.output).toMatchObject({ mapModeOverride: 'architectural', mapLocationKind: 'wilderness' });
      expect(vi.mocked(encounterRunAdapters.renderSchematic).mock.calls[0]?.[3]).toBe('architectural');
      const prompt = vi.mocked(encounterRunAdapters.generateImages).mock.calls[0]?.[0] ?? '';
      expect(prompt).toContain('Environment materials');
      expect(prompt).toContain('Keep walls, openings');
    });

    it('forces a natural-site map for a dungeon-classified open cave (override the other way)', async () => {
      const { campaign, cartographer } = await setup();
      const openCave = await createArtifact({
        campaignId: campaign.id,
        kind: 'encounter',
        name: 'Open Cave Mouth',
        body: 'Keep this prose.',
        data: {
          difficulty: 'hard', levelHint: '4',
          monsters: [{ name: 'Ash Cultist', count: 2, notes: '', treasure: '', source: { type: 'none' } }],
          terrain: 'old terrain', tactics: '', treasure: '',
          mapImageId: null, layout: null, preset: 'standard',
          locationKind: 'dungeon', mapMode: 'natural', siteShape: 'single', budgetAdvisory: '',
        },
      });
      chatMock.mockResolvedValueOnce({ text: JSON.stringify(BRIEF), modelUsed: 'test-model', fallback: null });
      const runInput = input(campaign, cartographer, openCave.id);
      const runId = await runEngine.startRun(runInput);
      await approveUntilPick(runId, runInput);

      expect(vi.mocked(encounterRunAdapters.renderSchematic).mock.calls[0]?.[3]).toBe('natural');
      const prompt = vi.mocked(encounterRunAdapters.generateImages).mock.calls[0]?.[0] ?? '';
      expect(prompt).not.toContain('Environment materials');
      expect(prompt).not.toContain('Keep walls, openings');
      expect(prompt).toContain('only marks placement');
      expectSharedBans(prompt);
    });

    it('tells the Cartographer to set environment honestly from the site nature', async () => {
      const { campaign, cartographer } = await setup();
      chatMock.mockResolvedValueOnce({ text: JSON.stringify(BRIEF), modelUsed: 'test-model', fallback: null });
      await runEngine.startRun(input(campaign, cartographer));
      await waitFor(() => {
        expect(chatMock.mock.calls.length).toBeGreaterThanOrEqual(1);
      });
      const briefContent =
        chatMock.mock.calls[0]?.[0].find((message) => message.role === 'user')?.content ?? '';
      expect(briefContent).toContain('Environment: set "environment" honestly from the site');
      expect(briefContent).toContain('"outdoor"');
      expect(briefContent).toContain('"dungeon" only when it plays inside an enclosed built complex');
    });
  });

  describe('dungeon preset (docs/11 D10)', () => {
    it('persists the preset, biases the brief contract, generates the x2 layout and stamps the artifact', async () => {
      const { campaign, cartographer } = await setup();
      chatMock.mockResolvedValueOnce({ text: JSON.stringify(BRIEF), modelUsed: 'test-model', fallback: null });
      const runInput = { ...input(campaign, cartographer), encounterPreset: 'dungeon' as const };
      const runId = await runEngine.startRun(runInput);
      // Persisted on the run row for pause/resume (aspect pattern).
      expect((await getRun(runId))?.encounterPreset).toBe('dungeon');

      // The brief prompt carries the dungeon-complex clause (soft bias — the
      // geometry itself is deterministic packer output, not model output).
      await waitFor(() => {
        expect(chatMock.mock.calls.length).toBeGreaterThanOrEqual(1);
      });
      const briefContent =
        chatMock.mock.calls[0]?.[0].find((message) => message.role === 'user')?.content ?? '';
      expect(briefContent).toContain('Preset: Dungeon');
      expect(briefContent).toContain('connected dungeon complex of 4\u201310 rooms');

      const candidates = await approveUntilPick(runId, runInput);
      await runEngine.editStep(runId, await pickIndexOf(runId), { keep: [candidates[0]] }, runInput);
      await waitForRun(async () => {
        expect((await getRun(runId))?.status).toBe('completed');
      });
      const run = await getRun(runId);
      const artifact = await getArtifact(run?.resultArtifactId ?? newId());
      if (artifact?.kind !== 'encounter') throw new Error('encounter missing');
      // The fixed x2 tier for 4:3: 48x36 (standard would be 24x18).
      expect(artifact.data.layout?.gridW).toBe(48);
      expect(artifact.data.layout?.gridH).toBe(36);
      expect(artifact.data.preset).toBe('dungeon');
    });

    it('defaults to standard: no dungeon clause, base-tier layout, standard artifact stamp', async () => {
      const { campaign, cartographer } = await setup();
      chatMock.mockResolvedValueOnce({ text: JSON.stringify(BRIEF), modelUsed: 'test-model', fallback: null });
      const runInput = input(campaign, cartographer);
      const runId = await runEngine.startRun(runInput);
      // D10 amendment: no explicit choice means Auto — the run row persists
      // null and the brief's resolution chain decides (no target here, no
      // Settings choice → the 'standard' terminal default).
      expect((await getRun(runId))?.encounterPreset).toBeNull();

      await waitFor(() => {
        expect(chatMock.mock.calls.length).toBeGreaterThanOrEqual(1);
      });
      const briefContent =
        chatMock.mock.calls[0]?.[0].find((message) => message.role === 'user')?.content ?? '';
      expect(briefContent).not.toContain('Preset: Dungeon');

      const candidates = await approveUntilPick(runId, runInput);
      await runEngine.editStep(runId, await pickIndexOf(runId), { keep: [candidates[0]] }, runInput);
      await waitForRun(async () => {
        expect((await getRun(runId))?.status).toBe('completed');
      });
      const run = await getRun(runId);
      const artifact = await getArtifact(run?.resultArtifactId ?? newId());
      if (artifact?.kind !== 'encounter') throw new Error('encounter missing');
      expect(artifact.data.layout?.gridW).toBe(24);
      expect(artifact.data.layout?.gridH).toBe(18);
      expect(artifact.data.preset).toBe('standard');
    });
  });

  describe('asymmetric per-room budget loop (docs/11 D12)', () => {
    /** A single-arena brief whose arena badly overruns its band. */
    function overBrief(level: string, levelHint: string): typeof BRIEF {
      return {
        ...BRIEF,
        levelHint,
        monsters: [{ name: 'Ash Cultist', count: 1, notes: '', treasure: '', statBlock: { ...INLINE_STATBLOCK, level } }],
      };
    }

    it('runs the too-hard repair through the EXISTING single repair turn', async () => {
      const { campaign, cartographer } = await setup();
      // First reply: one level-10 creature against a level-1 band of 3.
      // Repair reply: the same arena with a level-1 creature — fits.
      chatMock
        .mockResolvedValueOnce({ text: JSON.stringify(overBrief('10', '1')), modelUsed: 'test-model', fallback: null })
        .mockResolvedValueOnce({ text: JSON.stringify(overBrief('1', '1')), modelUsed: 'test-model', fallback: null });
      const runInput = input(campaign, cartographer);
      const runId = await runEngine.startRun(runInput);
      await waitForRun(async () => {
        expect((await getRun(runId))?.status).toBe('awaiting_user');
      });

      expect(chatMock).toHaveBeenCalledTimes(2);
      const repairTurn = (chatMock.mock.calls[1]?.[0] ?? []).at(-1);
      expect(repairTurn?.role).toBe('user');
      expect(repairTurn?.content).toContain('sum to 10 creature-levels');
      expect(repairTurn?.content).toContain('"targetLevel": 1');

      const step = (await getRun(runId))?.steps[0];
      const parsed = (step?.output as { parsed: { rooms: { targetLevel?: number }[] } }).parsed;
      expect(parsed.rooms[0]?.targetLevel).toBe(1);
    });

    it('lowers the target a step and ships the LOUD advisory after the bounded retry', async () => {
      const { campaign, cartographer } = await setup();
      // The model never fixes the overrun: the bounded retry is spent, the
      // room ships with its target lowered (2 → 1) and the advisory.
      chatMock.mockResolvedValue({ text: JSON.stringify(overBrief('10', '2')), modelUsed: 'test-model', fallback: null });
      const runInput = { ...input(campaign, cartographer), autonomy: 'auto' as const };
      const runId = await runEngine.startRun(runInput);
      await waitForRun(async () => {
        expect((await getRun(runId))?.status).toBe('completed');
      });
      const run = await getRun(runId);
      const artifact = await getArtifact(run?.resultArtifactId ?? newId());
      if (artifact?.kind !== 'encounter') throw new Error('encounter missing');
      expect(artifact.data.layout?.rooms[0]?.targetLevel).toBe(1);
      expect(artifact.data.budgetAdvisory).toContain('ships over its challenge budget');
      const brief = run?.steps.find((step) => step.name === 'brief');
      expect((brief?.output as { budgetAdvisory?: string }).budgetAdvisory).toContain('challenge budget');
    });

    it('rejects a 2–3-room brief at the site-shape boundary (docs/11 D11)', async () => {
      const { campaign, cartographer } = await setup();
      const twoRooms = {
        ...BRIEF,
        rooms: [
          { name: 'Entry', description: '', size: 'small', monsterIndexes: [], adjacentRoomIndexes: [1], key: '', keyTreasure: '' },
          { name: 'Sanctum', description: '', size: 'large', monsterIndexes: [0], adjacentRoomIndexes: [0], key: '', keyTreasure: '' },
        ],
        entryRoomIndex: 0,
      };
      chatMock.mockResolvedValue({ text: JSON.stringify(twoRooms), modelUsed: 'test-model', fallback: null });
      const runInput = input(campaign, cartographer);
      const runId = await runEngine.startRun(runInput);
      await waitForRun(async () => {
        expect((await getRun(runId))?.status).toBe('awaiting_user');
      });
      const step = (await getRun(runId))?.steps[0];
      expect(step?.status).toBe('rejected');
      expect(rejectionIssues(step ?? { output: null })).toEqual([
        'rooms: an encounter is either a single arena (exactly 1 room) or a dungeon complex (4–10 rooms) — your reply listed 2 rooms',
      ]);
    });

    it('replaces the numeric band with the loud advisory for pf2e', async () => {
      const { campaign, cartographer } = await setup('pathfinder2e');
      chatMock.mockResolvedValueOnce({ text: JSON.stringify(BRIEF), modelUsed: 'test-model', fallback: null });
      const runInput = { ...input(campaign, cartographer), autonomy: 'auto' as const };
      const runId = await runEngine.startRun(runInput);
      await waitForRun(async () => {
        expect((await getRun(runId))?.status).toBe('completed');
      });
      const run = await getRun(runId);
      const artifact = await getArtifact(run?.resultArtifactId ?? newId());
      if (artifact?.kind !== 'encounter') throw new Error('encounter missing');
      expect(artifact.data.budgetAdvisory).toContain('not deterministically budget-checked');
      expect(artifact.data.layout?.rooms[0]?.targetLevel).toBe(4);
    });
  });
});
