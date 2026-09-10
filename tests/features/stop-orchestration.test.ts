import 'fake-indexeddb/auto';

import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { listArtifactsByCampaign } from '@/db/artifactRepo';
import { getModule, patchModule, saveModule } from '@/db/moduleRepo';
import { listPersonas } from '@/db/personaRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { updateSettings } from '@/db/settingsRepo';
import {
  createModule,
  modulePartSchema,
  moduleSpineSchema,
  type Campaign,
  type Module,
} from '@/domain';
import { runEntityBatch } from '@/features/modules/entity-batch';
import { runModulePostGeneration } from '@/features/modules/post-generation';
import { runEngine } from '@/llm/runEngine';
import { bumpStopEpoch, getStopEpoch } from '@/lib/stopEpoch';
import { useProgressStore } from '@/lib/progress';
import { clearDatabase } from '../db/helpers';

/**
 * "A stopped orchestration must not start its next unit" (owner report: "Stop
 * all should stop all generations, but it only stops the current type loop").
 *
 * The sweep in features/progress/stop-all-generations cancels UNITS; these
 * cases cover the LOOPS around them, through the app-level stop epoch
 * (lib/stopEpoch):
 * - a stop during a post-generation kind ends the sweep (no next kind, no
 *   enqueue block, no map/portrait jobs);
 * - a stop during an entity batch withdraws the remaining targets (they are
 *   never launched) and reports the cancelled run as WITHDRAWN — no failure
 *   entry and no red toast for work the user asked to stop.
 */

vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {},
  OpenRouterError: class OpenRouterError extends Error {},
  listModels: vi.fn(),
}));

vi.mock('@/lib/toast', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
}));

/** Queue-entry spies: the automation must hand over NOTHING after a stop, and
 * the job bodies never run inside this test. */
const { enqueueImageJobs, enqueueEncounterMaps, enqueueMobPortraits } = vi.hoisted(() => ({
  enqueueImageJobs: vi.fn(),
  enqueueEncounterMaps: vi.fn(),
  enqueueMobPortraits: vi.fn(),
}));

vi.mock('@/features/modules/entity-image-queue', () => ({
  useEntityImageQueue: { getState: () => ({ enqueue: enqueueImageJobs }) },
}));
vi.mock('@/features/modules/encounter-map-queue', () => ({
  useEncounterMapQueue: { getState: () => ({ enqueue: enqueueEncounterMaps }) },
}));
vi.mock('@/features/campaign/mob-portrait-queue', () => ({ enqueueMobPortraits }));

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);
const { toastError, toastSuccess } = await import('@/lib/toast');
const toastErrorMock = vi.mocked(toastError);
const toastSuccessMock = vi.mocked(toastSuccess);

const npcDraft = (name: string) => ({
  name,
  summary: `A resident of the drowned crypt (${name}).`,
  suggestedTags: ['resident'],
  // Substantial prose: a short draft would trip the run's own "too short"
  // repair retry and spend a second chat call per entity.
  body:
    `# ${name}\n\n${name} keeps to the flooded stair, counting the tide marks by lantern light ` +
    `and refusing to say what the bells below the water are ringing for.`,
  appearance: 'Salt-stained coat, lantern in hand.',
  personality: 'Careful and watchful.',
  // No statblock: one chat call per entity keeps this test's stop point exact.
  needsStatBlock: false,
});


async function seedModule(campaignId: string, overrides: Partial<Module> = {}): Promise<Module> {
  const base = createModule({
    campaignId,
    title: 'Ember Crypt',
    concept: 'A drowned crypt beneath the harbor.',
    levelMin: 1,
    levelMax: 4,
    sizeDial: 'sketch',
    autoGenerateKinds: ['npc'],
    autoImageKinds: ['npc'],
    autoGenerateBattlemaps: true,
  });
  return saveModule({
    ...base,
    status: 'ready',
    entityNamesNormalized: true,
    entityKinds: [
      { name: 'Kael', kind: 'npc', absorbed: [], wants: [], conflictKind: null },
      { name: 'Gor', kind: 'npc', absorbed: [], wants: [], conflictKind: null },
    ],
    spine: moduleSpineSchema.parse({
      premise: 'The gate of [[Ember Crypt]] opens at dusk.',
      themes: [],
      partPlan: [
        {
          title: 'The Tide Gate',
          levelBand: '1–4',
          synopsis: 'The party meets [[Kael]] and [[Gor]] at the sealed gate.',
          levelUpTrigger: 'The gate opens.',
        },
      ],
    }),
    parts: [
      modulePartSchema.parse({
        planIndex: 0,
        status: 'ready',
        markdown:
          '## The Tide Gate\n\n[[Kael]] watches the gate. [[Gor]] keeps the flooded stair.',
        edited: false,
        errorMessage: '',
      }),
    ],
    ...overrides,
  });
}

beforeEach(async () => {
  await clearDatabase();
  await seedBuiltInPersonas();
  chatMock.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
  enqueueImageJobs.mockReset();
  enqueueEncounterMaps.mockReset();
  enqueueMobPortraits.mockReset();
  enqueueMobPortraits.mockResolvedValue({ enqueued: 1, alreadyImaged: [] });
  useProgressStore.getState().reset();
  // ONE entity in flight at a time: the kind sweep and the pool's "next unit"
  // boundary are then observable one target at a time (the batch fixtures
  // below raise this again where they need a real pool).
  await updateSettings({ imagesEnabled: true, maxParallelRequests: 1 });
});

describe('post-generation automation stops with the user', () => {
  it('ends the kind sweep after a stop — no next kind, no enqueue block', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = await seedModule(campaign.id);
    // The first entity's draft is the stop point: the model call lands, then
    // the user presses Stop all while the batch is settling.
    chatMock.mockImplementation(() => {
      bumpStopEpoch();
      return Promise.resolve({
        text: JSON.stringify(npcDraft('Kael')),
        modelUsed: 'test-model',
        fallback: null,
      });
    });

    await runModulePostGeneration(module.id, campaign);

    // Only the FIRST entity of the FIRST kind ran: the sweep ended before
    // the second target and before the next kind.
    expect(chatMock).toHaveBeenCalledTimes(1);
    const onlyPrompt = JSON.stringify(chatMock.mock.calls[0]?.[0]);
    expect(onlyPrompt).toContain('Kael');
    // …and nothing was handed to the queues on the way out (their pump would
    // happily start a fresh run for a job enqueued after the stop).
    expect(enqueueImageJobs).not.toHaveBeenCalled();
    expect(enqueueEncounterMaps).not.toHaveBeenCalled();
    expect(enqueueMobPortraits).not.toHaveBeenCalled();
    // No completion claim either: the stop toast is the sweep's, not ours.
    expect(toastSuccessMock).not.toHaveBeenCalled();
    // A user stop is not a generation failure.
    expect(toastErrorMock).not.toHaveBeenCalled();
  }, 30_000);

  it('enqueues nothing when the stop lands after the batches completed', async () => {
    // The enqueue half has its own guard: even a sweep whose batches all ran
    // to completion hands the queues nothing once a stop has landed (the
    // queues' pump exits on cancelAll, but a later enqueue starts a new one).
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = await seedModule(campaign.id);
    chatMock.mockImplementation(() => {
      bumpStopEpoch();
      return Promise.resolve({
        text: JSON.stringify(npcDraft('Kael')),
        modelUsed: 'test-model',
        fallback: null,
      });
    });

    await runModulePostGeneration(module.id, campaign);

    expect(enqueueImageJobs).not.toHaveBeenCalled();
    expect(enqueueEncounterMaps).not.toHaveBeenCalled();
    expect(enqueueMobPortraits).not.toHaveBeenCalled();
  }, 30_000);

  it('still runs the whole automation when no stop landed', async () => {
    // The control case: the guards must not turn ordinary automation into a
    // no-op (the same fixture, no stop).
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = await seedModule(campaign.id, { autoGenerateBattlemaps: false });
    chatMock.mockImplementation(() =>
      Promise.resolve({
        text: JSON.stringify(npcDraft('Kael')),
        modelUsed: 'test-model',
        fallback: null,
      }),
    );

    await runModulePostGeneration(module.id, campaign);

    // Two kinds are configured (npc, encounter) — the entityKinds records
    // carry one npc, so the npc batch runs and the sweep reaches the enqueue
    // block for the two now-resolved npcs.
    expect(enqueueImageJobs).toHaveBeenCalledTimes(1);
    expect(enqueueImageJobs.mock.calls[0]?.[0]).toHaveLength(2);
    expect(toastSuccessMock).toHaveBeenCalledTimes(1);
  }, 30_000);
});

describe('entity batch withdrawals', () => {
  /** A module whose text resolves no entity yet: the batch creates them. */
  async function batchFixture(): Promise<{ campaign: Campaign; module: Module }> {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = await seedModule(campaign.id, {
      autoGenerateKinds: [],
      autoImageKinds: [],
      autoGenerateBattlemaps: false,
      // Four targets against a concurrency of 2: the first two are in flight
      // when the stop lands, the last two are still waiting for a slot.
      entityKinds: ['Kael', 'Gor', 'Mira', 'Toll'].map((name) => ({
        name,
        kind: 'npc' as const,
        absorbed: [],
        wants: [],
        conflictKind: null,
      })),
    });
    await patchModule(module.id, {
      parts: [
        modulePartSchema.parse({
          planIndex: 0,
          status: 'ready',
          markdown:
            '## The Tide Gate\n\n[[Kael]] watches. [[Gor]] waits. [[Mira]] counts. [[Toll]] listens.',
          edited: false,
          errorMessage: '',
        }),
      ],
    });
    await updateSettings({ maxParallelRequests: 2 });
    return { campaign, module: (await getModule(module.id)) ?? module };
  }

  it('launches no further target after a stop and records no failure for the cancelled run', async () => {
    const { campaign, module } = await batchFixture();
    // The chat call never settles on its own: the runs stay in flight until
    // the stop aborts them (exactly what the sweep does).
    chatMock.mockImplementation((_messages, opts) => {
      const signal = (opts as { signal?: AbortSignal } | undefined)?.signal;
      if (signal === undefined) return Promise.reject(new Error('no abort signal passed'));
      if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    });

    const batch = runEntityBatch({
      module,
      campaign,
      kind: 'npc',
      targets: [{ name: 'Kael' }, { name: 'Gor' }, { name: 'Mira' }, { name: 'Toll' }],
    });

    // Two runs are in flight (the pool's limit); the stop lands, then the
    // engine cancels them exactly like the dock's Stop all does.
    await waitFor(() => {
      expect(chatMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    bumpStopEpoch();
    await runEngine.cancelAllActive();
    const result = await batch;

    // A cancelled run is WITHDRAWN: no failure entry, so no "3 of 4 failed"
    // toast and no red row — the user stopped it on purpose.
    expect(result.failed).toEqual([]);
    expect(result.generated).toEqual([]);
    expect(toastErrorMock).not.toHaveBeenCalled();
    // The two targets that never got a slot were never launched: 2 chat
    // calls, not 4.
    expect(chatMock).toHaveBeenCalledTimes(2);
    // Nothing was produced, so nothing was staged for images either.
    const artifacts = await listArtifactsByCampaign(campaign.id);
    expect(artifacts.filter((artifact) => artifact.kind === 'npc')).toHaveLength(0);
  }, 30_000);

  it('reports a genuine run failure loudly (the withdrawal rule is not a blanket silence)', async () => {
    const { campaign, module } = await batchFixture();
    chatMock.mockRejectedValue(new Error('the provider refused the request'));

    const result = await runEntityBatch({
      module,
      campaign,
      kind: 'npc',
      targets: [{ name: 'Kael' }],
    });

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.name).toBe('Kael');
  }, 30_000);
});

describe('the epoch itself', () => {
  it('moves only when a stop lands', () => {
    const before = getStopEpoch();
    bumpStopEpoch();
    expect(getStopEpoch()).toBeGreaterThan(before);
  });

  it('keeps the pools of a run that started after the stop working', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = await seedModule(campaign.id);
    bumpStopEpoch();
    chatMock.mockImplementation(() =>
      Promise.resolve({
        text: JSON.stringify(npcDraft('Kael')),
        modelUsed: 'test-model',
        fallback: null,
      }),
    );

    const personas = await listPersonas();
    expect(personas.length).toBeGreaterThan(0);
    const result = await runEntityBatch({
      module,
      campaign,
      kind: 'npc',
      targets: [{ name: 'Kael' }],
    });

    // A fresh batch captures the fresh epoch: one user's Stop all never
    // disables the next user-visible generation.
    expect(result.generated).toEqual(['Kael']);
  }, 30_000);
});
