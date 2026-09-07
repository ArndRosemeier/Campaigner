import 'fake-indexeddb/auto';

import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { createModule as saveModule, patchModule } from '@/db/moduleRepo';
import { listPersonas } from '@/db/personaRepo';
import { listRunsByCampaign } from '@/db/runRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { updateSettings } from '@/db/settingsRepo';
import { createModule } from '@/domain';
import { stopAllGenerations } from '@/features/progress/stop-all-generations';
import { useEntityImageQueue } from '@/features/modules/entity-image-queue';
import { useMobPortraitQueue } from '@/features/campaign/mob-portrait-queue';
import { useProgressStore } from '@/lib/progress';
import { runEngine } from '@/llm/runEngine';
import { clearDatabase } from '../db/helpers';

/**
 * Stop-all generations (owner request): ONE sweep over the job queues, the
 * in-flight run-engine runs and the module forge. Non-destructive — stopped
 * runs stay resumable ('cancelled'), queue jobs settle silently, and the
 * summary toast reports the distinct stopped count.
 */

vi.mock('@/llm/moduleGen', () => ({ cancelModuleGen: vi.fn() }));
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
const { cancelModuleGen } = await import('@/llm/moduleGen');
const cancelModuleGenMock = vi.mocked(cancelModuleGen);
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
  toastSuccessMock.mockReset();
  toastInfoMock.mockReset();
  toastErrorMock.mockReset();
  useMobPortraitQueue.getState().reset();
  useEntityImageQueue.getState().reset();
  useProgressStore.getState().reset();
  chatMock.mockImplementation((_messages, opts) => holdUntilAborted(_messages, opts));
  generateImagesMock.mockImplementation((_prompt, _count, opts) => holdUntilAborted(_prompt, opts));
});

describe('stopAllGenerations', () => {
  it('stops mixed active work — queue jobs, the in-flight run, the module forge — and reports the count', async () => {
    const campaign = await createCampaign({ name: 'Stop all', system: 'dnd5e' });
    const module = await saveModule(createModule({
      campaignId: campaign.id,
      title: 'The Drowned Vault',
      concept: '',
      levelMin: 1,
      levelMax: 3,
      sizeDial: 'sketch',
    }));
    await patchModule(module.id, { status: 'generating' });
    const goblin = await createArtifact({
      campaignId: campaign.id, kind: 'npc', name: 'Goblin Boss', summary: 'A mean goblin commander.',
    });
    // The entity queue resolves its target by exact wiki-link name.
    await createArtifact({
      campaignId: campaign.id, moduleId: module.id, kind: 'npc', name: 'Kael', summary: 'Ember\u2019s gate warden.',
    });
    useMobPortraitQueue.getState().enqueue([
      { campaignId: campaign.id, artifactId: goblin.id, name: 'Goblin Boss' },
    ]);
    useEntityImageQueue.getState().enqueue([
      { campaignId: campaign.id, moduleId: module.id, name: 'Kael' },
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
    });

    const result = await stopAllGenerations();

    // 2 queue jobs + 1 in-flight run + 1 module forge — distinct units.
    expect(result).toEqual({ stopped: 4 });
    expect(toastSuccessMock).toHaveBeenCalledWith('Stopped 4 generations');
    expect(toastInfoMock).not.toHaveBeenCalled();
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(useMobPortraitQueue.getState().active).toEqual([]);
    expect(useMobPortraitQueue.getState().queued).toEqual([]);
    expect(useMobPortraitQueue.getState().failed).toEqual([]);
    expect(useEntityImageQueue.getState().active).toEqual([]);
    expect(useEntityImageQueue.getState().queued).toEqual([]);
    expect(useEntityImageQueue.getState().failed).toEqual([]);
    const run = (await listRunsByCampaign(campaign.id)).find((row) => row.id === runId);
    expect(run?.status).toBe('cancelled');
    expect(cancelModuleGenMock).toHaveBeenCalledWith(module.id);
  });

  it('reports "Nothing was running" when there is no work to stop', async () => {
    const result = await stopAllGenerations();
    expect(result).toEqual({ stopped: 0 });
    expect(toastInfoMock).toHaveBeenCalledWith('Nothing was running');
    expect(toastSuccessMock).not.toHaveBeenCalled();
  });
});
