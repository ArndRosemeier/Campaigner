import 'fake-indexeddb/auto';

import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact, getArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { getImage } from '@/db/imageRepo';
import { getRun, updateRun } from '@/db/runRepo';
import { saveSettings } from '@/db/settingsRepo';
import { coarseStructure } from '@/llm/encounterVision';
import { encounterRunAdapters, runEngine, type StartRunInput } from '@/llm/runEngine';
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
  vi.spyOn(encounterRunAdapters, 'generateImages').mockResolvedValue({ images: [new Blob(['one']), new Blob(['two'])], costUsd: 0.02, cappedToOne: false });
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
    expect(run?.steps.at(-1)?.name).toBe('layout');
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
  it('pauses at brief/layout/pick and finalizes one complete encounter', async () => {
    const { campaign, cartographer } = await setup();
    chatMock.mockResolvedValueOnce(JSON.stringify(BRIEF));
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
    chatMock.mockResolvedValue('{}');
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

  it('validates a layout edit before downstream steps can observe it', async () => {
    const { campaign, cartographer } = await setup();
    chatMock.mockResolvedValueOnce(JSON.stringify(BRIEF));
    const runInput = input(campaign, cartographer);
    const runId = await runEngine.startRun(runInput);
    await waitForRun(async () => {
      expect((await getRun(runId))?.steps.at(-1)?.name).toBe('brief');
    });
    await runEngine.approve(runId, runInput);
    await waitForRun(async () => {
      expect((await getRun(runId))?.steps.at(-1)?.name).toBe('layout');
    });

    await expect(runEngine.editStep(runId, 1, {}, runInput)).rejects.toThrow(
      'Encounter layout step has no valid approved output',
    );
    const run = await getRun(runId);
    expect(run?.status).toBe('awaiting_user');
    expect(run?.steps.at(-1)?.status).toBe('done');
  });

  it('checks brief/layout prerequisites again when the user approves a map', async () => {
    const { campaign, cartographer } = await setup();
    chatMock.mockResolvedValueOnce(JSON.stringify(BRIEF));
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
    chatMock.mockResolvedValueOnce(JSON.stringify(BRIEF));
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
    chatMock.mockResolvedValueOnce(JSON.stringify({ ...BRIEF, monsters: [{ name: 'Wrong Rename', count: 9, notes: '' }] }));
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

  it('stops a manual run for review when the map drifts', async () => {
    const { campaign, cartographer } = await setup();
    chatMock.mockResolvedValueOnce(JSON.stringify(BRIEF));
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
      expect((await getRun(runId))?.steps.at(-1)?.name).toBe('layout');
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
    chatMock.mockResolvedValueOnce(JSON.stringify(BRIEF));
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
});
