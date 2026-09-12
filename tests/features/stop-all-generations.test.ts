import 'fake-indexeddb/auto';

import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { createModule as saveModule, getModule, patchModule } from '@/db/moduleRepo';
import { listPersonas } from '@/db/personaRepo';
import { listRunsByCampaign } from '@/db/runRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { updateSettings } from '@/db/settingsRepo';
import { createModule } from '@/domain';
import { stopAllGenerations } from '@/features/progress/stop-all-generations';
import { cancelCanvasGenerations, registerCanvasAbort } from '@/llm/canvasBusy';
import { useCoverImageQueue } from '@/features/covers/cover-image-queue';
import { useEntityImageQueue } from '@/features/modules/entity-image-queue';
import { useEncounterMapQueue } from '@/features/modules/encounter-map-queue';
import { useMobPortraitQueue } from '@/features/campaign/mob-portrait-queue';
import { useProgressStore } from '@/lib/progress';
import { runEngine } from '@/llm/runEngine';
import { clearDatabase } from '../db/helpers';

/**
 * Stop-all generations (owner request): ONE sweep over the FOUR job queues
 * (mob portraits, entity images, encounter maps, covers), the in-flight
 * run-engine runs, the module forge and live CANVAS AI turns. Non-destructive
 * — stopped runs stay resumable ('cancelled'), queue jobs settle silently, and
 * the summary toast reports the distinct stopped count.
 *
 * The count pin in the mixed-work case is deliberately EXACT: every surface
 * the sweep claims to cover must contribute, so a surface that silently stops
 * being swept (the cover queue was the real miss — it had a working
 * `cancelAll` and was simply never called) fails this test instead of
 * under-reporting to the user.
 */

// The liveness guard the sweep now reads (docs/17 row 110): `cancelModuleGen`
// alone cannot tell a live forge from a row a reloaded tab left behind, so the
// sweep asks. Per-test value; the default below is "nobody owns it".
vi.mock('@/llm/moduleGen', () => ({
  cancelModuleGen: vi.fn(),
  hasLiveModuleGen: vi.fn(() => false),
}));
vi.mock('@/llm/imageGen', () => ({ generateImages: vi.fn() }));
vi.mock('@/lib/imageIntake', () => ({ intakeImage: vi.fn() }));
vi.mock('@/lib/toast', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
}));
vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {},
  OpenRouterError: class OpenRouterError extends Error {},
}));

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);
const { generateImages } = await import('@/llm/imageGen');
const generateImagesMock = vi.mocked(generateImages);
const { cancelModuleGen, hasLiveModuleGen } = await import('@/llm/moduleGen');
const cancelModuleGenMock = vi.mocked(cancelModuleGen);
const hasLiveModuleGenMock = vi.mocked(hasLiveModuleGen);
const { toastSuccess, toastInfo, toastError } = await import('@/lib/toast');
const toastSuccessMock = vi.mocked(toastSuccess);
const toastInfoMock = vi.mocked(toastInfo);
const toastErrorMock = vi.mocked(toastError);

/** Holds a call open until the abort signal fires — the stopped work must
 * react to the sweep, not race it. An already-aborted signal rejects
 * immediately (like a real fetch would), so a run cancelled between steps
 * never strands its controller on a promise that can never settle. */
function holdUntilAborted(_args: unknown, opts: unknown): Promise<never> {
  const signal = (opts as { signal?: AbortSignal } | undefined)?.signal;
  if (signal === undefined) return Promise.reject(new Error('no abort signal passed'));
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });
}

beforeEach(async () => {
  await clearDatabase();
  await seedBuiltInPersonas();
  await updateSettings({ imagesEnabled: true, imageModel: 'test-image-model' });
  chatMock.mockReset();
  generateImagesMock.mockReset();
  cancelModuleGenMock.mockReset();
  hasLiveModuleGenMock.mockReset();
  hasLiveModuleGenMock.mockReturnValue(false);
  toastSuccessMock.mockReset();
  toastInfoMock.mockReset();
  toastErrorMock.mockReset();
  useMobPortraitQueue.getState().reset();
  useEntityImageQueue.getState().reset();
  useEncounterMapQueue.getState().reset();
  useCoverImageQueue.getState().reset();
  useProgressStore.getState().reset();
  chatMock.mockImplementation((_messages, opts) => holdUntilAborted(_messages, opts));
  generateImagesMock.mockImplementation((_prompt, _count, opts) => holdUntilAborted(_prompt, opts));
});

describe('stopAllGenerations', () => {
  it('stops mixed active work — queue jobs, the in-flight run, the module forge — and reports the count', async () => {
    const campaign = await createCampaign({
      name: 'Stop all',
      system: 'dnd5e',
      description: 'A drowned harbor town, its bell tower still ringing under the tide.',
    });
    const module = await saveModule(createModule({
      campaignId: campaign.id,
      title: 'The Drowned Vault',
      concept: '',
      levelMin: 1,
      levelMax: 3,
      sizeDial: 'sketch',
    }));
    await patchModule(module.id, { status: 'generating' });
    // "A forge is in flight" is now TWO facts: the row says 'generating' and a
    // live pass owns it (the guard). Both are declared here, in the fixture, so
    // the sweep's count below is a count of real work.
    hasLiveModuleGenMock.mockReturnValue(true);
    const goblin = await createArtifact({
      campaignId: campaign.id, kind: 'npc', name: 'Goblin Boss', summary: 'A mean goblin commander.',
    });
    // The entity queue resolves its target by exact wiki-link name.
    await createArtifact({
      campaignId: campaign.id, moduleId: module.id, kind: 'npc', name: 'Kael', summary: 'Ember\u2019s gate warden.',
    });
    useMobPortraitQueue.getState().enqueue([
      {
        campaignId: campaign.id,
        creatureKey: `artifact:${goblin.id}`,
        artifactId: goblin.id,
        name: 'Goblin Boss',
      },
    ]);
    useEntityImageQueue.getState().enqueue([
      { campaignId: campaign.id, moduleId: module.id, name: 'Kael' },
    ]);
    // The fourth queue: a cover generation, the surface the sweep used to
    // leave running (working `cancelAll`, never called). A CAMPAIGN cover
    // keeps this case on the fixture it already has — the prompt draft needs
    // real grounding text, which the module fixture does not carry.
    useCoverImageQueue.getState().enqueue([
      { kind: 'campaign', campaignId: campaign.id, name: campaign.name },
    ]);
    const personas = await listPersonas();
    const smith = personas.find((persona) => persona.slug === 'npc-smith');
    if (smith === undefined) throw new Error('npc-smith persona missing');
    const runId = await runEngine.startRun({
      campaign,
      persona: smith,
      autonomy: 'auto',
      brief: 'Detail the gate warden',
      pinnedChunkIds: [],
    });
    // The engine registry is the sweep source: wait until the run is truly
    // in flight — the draft step's chat call is held open, so the run's
    // controller is registered and the sweep will find it.
    await waitFor(() => {
      expect(chatMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(useMobPortraitQueue.getState().active).toHaveLength(1);
      expect(useEntityImageQueue.getState().active).toHaveLength(1);
      expect(useCoverImageQueue.getState().active).toHaveLength(1);
    });
    // A live canvas AI turn on the SAME module whose forge is in flight: the
    // sweep drives both abort seams (canvasBusy + cancelModuleGen) and counts
    // the module ONCE — the canvas turn is not a second unit of work.
    const canvasTurn = new AbortController();
    const canvasHandle = registerCanvasAbort(module.id, canvasTurn);

    const result = await stopAllGenerations();

    // 3 queue jobs (mob portrait, entity image, cover) + 1 in-flight run +
    // 1 module forge (whose live canvas turn counts inside that same unit) —
    // distinct units.
    expect(result).toEqual({ stopped: 5, reconciled: 0 });
    expect(toastSuccessMock).toHaveBeenCalledWith('Stopped 5 generations');
    expect(toastInfoMock).not.toHaveBeenCalled();
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(useMobPortraitQueue.getState().active).toEqual([]);
    expect(useMobPortraitQueue.getState().queued).toEqual([]);
    expect(useMobPortraitQueue.getState().failed).toEqual([]);
    expect(useEntityImageQueue.getState().active).toEqual([]);
    expect(useEntityImageQueue.getState().queued).toEqual([]);
    expect(useEntityImageQueue.getState().failed).toEqual([]);
    // The cover queue settles silently too — no failed entry for a job the
    // user just stopped.
    expect(useCoverImageQueue.getState().active).toEqual([]);
    expect(useCoverImageQueue.getState().queued).toEqual([]);
    expect(useCoverImageQueue.getState().failed).toEqual([]);
    const run = (await listRunsByCampaign(campaign.id)).find((row) => row.id === runId);
    expect(run?.status).toBe('cancelled');
    expect(cancelModuleGenMock).toHaveBeenCalledWith(module.id);
    // The canvas turn was reached: its model signal AND the caller's own
    // controller are aborted (the UI's "the user stopped this" branch).
    expect(canvasHandle.signal.aborted).toBe(true);
    expect(canvasTurn.signal.aborted).toBe(true);
    canvasHandle.releaseHandle();
    expect(cancelCanvasGenerations()).toEqual([]);
  });

  it('reports "Nothing was running" when there is no work to stop', async () => {
    const result = await stopAllGenerations();
    expect(result).toEqual({ stopped: 0, reconciled: 0 });
    expect(toastInfoMock).toHaveBeenCalledWith('Nothing was running');
    expect(toastSuccessMock).not.toHaveBeenCalled();
  });

  it('never counts a row nobody owns as stopped — it reconciles it loudly instead', async () => {
    const campaign = await createCampaign({ name: 'Dead forge', system: 'dnd5e' });
    const module = await saveModule(
      createModule({
        campaignId: campaign.id,
        title: 'The Drowned Vault',
        concept: '',
        levelMin: 1,
        levelMax: 3,
        sizeDial: 'sketch',
      }),
    );
    // Exactly the state a reloaded tab leaves: the row says 'generating' and
    // no live pass and no other tab owns it.
    await patchModule(module.id, { status: 'generating' });
    hasLiveModuleGenMock.mockReturnValue(false);

    const result = await stopAllGenerations();

    // The count is the honest one the owner never got before: nothing was
    // STOPPED, and the dead row was FAILED with its recovery sentence.
    expect(result).toEqual({ stopped: 0, reconciled: 1 });
    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(toastInfoMock).not.toHaveBeenCalledWith('Nothing was running');
    expect(String(toastErrorMock.mock.calls[0]?.[0])).toContain('Interrupted 1 module generation');
    expect(cancelModuleGenMock).not.toHaveBeenCalled();
    const row = await getModule(module.id);
    expect(row?.status).toBe('failed');
    expect(row?.errorMessage).toContain('Resume module generation');
  });
});
