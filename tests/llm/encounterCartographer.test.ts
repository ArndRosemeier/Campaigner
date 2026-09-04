import 'fake-indexeddb/auto';

import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact, getArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { getImage } from '@/db/imageRepo';
import { getRun, updateRun } from '@/db/runRepo';
import { saveSettings } from '@/db/settingsRepo';
import { coarseStructure } from '@/llm/encounterVision';
import { encounterRunAdapters, rejectionIssues, runEngine, type StartRunInput } from '@/llm/runEngine';
import { chat } from '@/llm/openrouter';
import { createPersona, defaultSettings, newId, type Persona } from '@/domain';
import { clearDatabase } from '../db/helpers';
import { useProgressStore } from '@/lib/progress';

vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {},
  OpenRouterError: class OpenRouterError extends Error {},
}));

const chatMock = vi.mocked(chat);

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
  monsters: [{ name: 'Ash Cultist', count: 2, notes: '', statBlock: INLINE_STATBLOCK }],
  rooms: [
    { name: 'Entry', description: 'Broken doors', size: 'small', monsterIndexes: [], adjacentRoomIndexes: [1] },
    { name: 'Sanctum', description: 'Ash altar', size: 'large', monsterIndexes: [0], adjacentRoomIndexes: [0] },
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

async function setup() {
  const campaign = await createCampaign({ name: 'Map Campaign', system: 'dnd5e' });
  const cartographer = persona();
  const { db } = await import('@/db');
  await db.personas.put(cartographer);
  await saveSettings({ ...defaultSettings(), openRouterApiKey: 'test-key', imagesEnabled: true });
  return { campaign, cartographer };
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
  vi.spyOn(encounterRunAdapters, 'renderSchematic').mockReturnValue({ dataUrl: 'data:image/png;base64,schematic', width: 2304, height: 1728 });
  vi.spyOn(encounterRunAdapters, 'generateImages').mockResolvedValue({ images: [new Blob(['one']), new Blob(['two'])], costUsd: 0.02, cappedToOne: false, modelUsed: 'test-image-model' });
  vi.spyOn(encounterRunAdapters, 'normalizeImageAspect').mockImplementation((blob) => Promise.resolve({ blob, width: 1200, height: 900, action: 'none' }));
  vi.spyOn(encounterRunAdapters, 'intakeImage').mockImplementation((blob) => Promise.resolve({ blob, width: 1200, height: 900, mimeType: 'image/webp' }));
  vi.spyOn(encounterRunAdapters, 'blobToDataUrl').mockResolvedValue('data:image/webp;base64,map');
  vi.spyOn(encounterRunAdapters, 'verifyEncounterMap').mockImplementation(({ layout }) => {
    const expected = coarseStructure(layout);
    return Promise.resolve({ expected, actual: expected, mismatchedIndexes: [], mismatchRatio: 0, needsReview: false });
  });
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

describe('Encounter Cartographer run', () => {
  it('pauses at brief and pick and finalizes one complete encounter', async () => {
    const { campaign, cartographer } = await setup();
    chatMock.mockResolvedValueOnce({ text: JSON.stringify(BRIEF), modelUsed: 'test-model', fallback: null });
    const runInput = input(campaign, cartographer);
    const runId = await runEngine.startRun(runInput);
    const candidates = await approveUntilPick(runId, runInput);
    expect(candidates).toHaveLength(2);
    expect(useProgressStore.getState().jobs[0]?.detail).toContain('Waiting');

    await runEngine.editStep(runId, 5, { keep: [candidates[0]] }, runInput);
    await waitForRun(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });
    const run = await getRun(runId);
    const artifact = await getArtifact(run?.resultArtifactId ?? newId());
    if (artifact?.kind !== 'encounter') throw new Error('encounter missing');
    expect(artifact.data.layout?.rooms).toHaveLength(2);
    expect(artifact.data.mapImageId).toBe(candidates[0]);
    expect(artifact.data.monsters[0]?.source.type).toBe('inline');
    expect(artifact.imageIds).toContain(candidates[0]);
    expect((await getImage(candidates[0] ?? ''))?.role).toBe('map');
    expect(await getImage(candidates[1] ?? '')).toBeUndefined();
    expect(useProgressStore.getState().jobs).toEqual([]);
  });

  it('does not approve a rejected brief into an opaque downstream failure', async () => {
    const { campaign, cartographer } = await setup();
    // Both the initial reply and automatic repair fail the brief schema.
    chatMock.mockResolvedValue({ text: '{}', modelUsed: 'test-model', fallback: null });
    const runInput = input(campaign, cartographer);
    const runId = await runEngine.startRun(runInput);
    await waitForRun(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('needs_review');
      expect(run?.steps.at(-1)?.name).toBe('brief');
      expect(run?.steps.at(-1)?.status).toBe('rejected');
    });

    await expect(runEngine.approve(runId, runInput)).rejects.toThrow(
      'Encounter brief step has no valid approved output',
    );
    const run = await getRun(runId);
    expect(run?.status).toBe('needs_review');
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
      rooms: [
        { ...BRIEF.rooms[0], monsterIndexes: [] },
        { ...BRIEF.rooms[1], monsterIndexes: [3] },
      ],
    };
    chatMock.mockResolvedValue({ text: JSON.stringify(broken), modelUsed: 'test-model', fallback: null });
    const runInput = input(campaign, cartographer);
    const runId = await runEngine.startRun(runInput);
    await waitForRun(async () => {
      expect((await getRun(runId))?.status).toBe('needs_review');
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
      expect((await getRun(runId))?.status).toBe('needs_review');
    });
    const step = (await getRun(runId))?.steps[0];
    expect(rejectionIssues(step ?? { output: null })).toEqual([
      'monsters[0] "Ash Cultist": add sourceChunkIndex citing a listed stat-block excerpt, or an inline statBlock',
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

    await expect(runEngine.editStep(runId, 5, { keep: [candidates[0]] }, runInput)).rejects.toThrow(
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
        monsters: [{ name: 'Original Ogre', count: 1, notes: 'keep', source: { type: 'none' } }],
        terrain: 'old terrain', tactics: 'old tactics', treasure: 'old treasure',
        mapImageId: null, layout: null,
      },
    });
    if (target.kind !== 'encounter') throw new Error('encounter target missing');
    chatMock.mockResolvedValueOnce({ text: JSON.stringify({ ...BRIEF, monsters: [{ name: 'Wrong Rename', count: 9, notes: '' }] }), modelUsed: 'test-model', fallback: null });
    const runInput = input(campaign, cartographer, target.id);
    const runId = await runEngine.startRun(runInput);
    const candidates = await approveUntilPick(runId, runInput);
    await runEngine.editStep(runId, 5, { keep: [candidates[0]] }, runInput);
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
        monsters: [{ name: 'Original Ogre', count: 1, notes: 'keep', source: { type: 'none' } }],
        terrain: 'old terrain', tactics: 'old tactics', treasure: 'old treasure',
        mapImageId: null, layout: null,
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
      parsed: { monsters: { name: string; count: number; notes: string }[] };
    };
    expect(output.parsed.monsters).toEqual([{ name: 'Original Ogre', count: 1, notes: 'keep' }]);
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
        monsters: [{ name: 'Original Ogre', count: 1, notes: 'keep', source: { type: 'none' } }],
        terrain: 'old terrain', tactics: 'old tactics', treasure: 'old treasure',
        mapImageId: null, layout: null,
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
      expect((await getRun(runId))?.status).toBe('needs_review');
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
      expect((await getRun(runId))?.status).toBe('needs_review');
    });
    const step = (await getRun(runId))?.steps[0];
    expect(rejectionIssues(step ?? { output: null })).toEqual([
      'rooms: roster entry 0 must belong to exactly one room',
    ]);
  });

  it('sends verify to the dedicated vision model, falling back to the chat model', async () => {
    const { campaign, cartographer } = await setup();
    await saveSettings({
      ...defaultSettings(),
      openRouterApiKey: 'test-key',
      imagesEnabled: true,
      encounterVerifyModel: 'vision/verifier',
    });
    chatMock.mockResolvedValueOnce({ text: JSON.stringify(BRIEF), modelUsed: 'test-model', fallback: null });
    const runInput = input(campaign, cartographer);
    const runId = await runEngine.startRun(runInput);
    await approveUntilPick(runId, runInput);
    expect(vi.mocked(encounterRunAdapters.verifyEncounterMap).mock.calls[0]?.[0]?.model).toBe(
      'vision/verifier',
    );

    // Empty setting → the default chat model remains the fallback.
    await saveSettings({ ...defaultSettings(), openRouterApiKey: 'test-key', imagesEnabled: true });
    chatMock.mockResolvedValueOnce({ text: JSON.stringify(BRIEF), modelUsed: 'test-model', fallback: null });
    const fallbackRunId = await runEngine.startRun(runInput);
    await approveUntilPick(fallbackRunId, runInput);
    expect(vi.mocked(encounterRunAdapters.verifyEncounterMap).mock.calls.at(-1)?.[0]?.model).toBe(
      defaultSettings().defaultChatModel,
    );
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
        mapImageId: null, layout: null,
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

  it('stops a manual run for review when the map drifts', async () => {
    const { campaign, cartographer } = await setup();
    chatMock.mockResolvedValueOnce({ text: JSON.stringify(BRIEF), modelUsed: 'test-model', fallback: null });
    vi.mocked(encounterRunAdapters.verifyEncounterMap).mockImplementation(({ layout }) => {
      const expected = coarseStructure(layout);
      return Promise.resolve({ expected, actual: expected, mismatchedIndexes: [0], mismatchRatio: 0.2, needsReview: true });
    });
    const runInput = input(campaign, cartographer);
    const runId = await runEngine.startRun(runInput);
    await waitForRun(async () => {
      expect((await getRun(runId))?.steps.at(-1)?.name).toBe('brief');
    });
    await runEngine.approve(runId, runInput);
    await waitForRun(async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('needs_review');
      expect(run?.steps.at(-1)?.name).toBe('verify');
      expect(run?.steps.at(-1)?.status).toBe('rejected');
    });
    await runEngine.approve(runId, runInput);
    await waitForRun(async () => {
      expect((await getRun(runId))?.steps.at(-1)?.name).toBe('pick');
    });
  });

  it('fails auto generation when verification exceeds the threshold', async () => {
    const { campaign, cartographer } = await setup();
    chatMock.mockResolvedValueOnce({ text: JSON.stringify(BRIEF), modelUsed: 'test-model', fallback: null });
    vi.mocked(encounterRunAdapters.verifyEncounterMap).mockImplementation(({ layout }) => {
      const expected = coarseStructure(layout);
      return Promise.resolve({ expected, actual: expected, mismatchedIndexes: [0], mismatchRatio: 0.2, needsReview: true });
    });
    const runId = await runEngine.startRun({ ...input(campaign, cartographer), autonomy: 'auto' });
    await waitForRun(async () => {
      expect((await getRun(runId))?.status).toBe('failed');
    });
    expect((await getRun(runId))?.errorMessage).toContain('verification threshold');
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
      cappedToOne: false, modelUsed: 'test-image-model',
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
});
