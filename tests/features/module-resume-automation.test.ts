import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact, listArtifactsByCampaign, updateArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { getModule, saveModule } from '@/db/moduleRepo';
import { listModuleVersions } from '@/db/moduleVersionRepo';
import { saveSettings } from '@/db/settingsRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import {
  createModule,
  defaultSettings,
  modulePartSchema,
  moduleSpineSchema,
  type Campaign,
  type Module,
} from '@/domain';
import { resumeModuleAutomation } from '@/features/modules/resume-automation';
import { chainRunner } from '@/llm/chainRunner';
import { bumpStopEpoch } from '@/lib/stopEpoch';
import { useProgressStore } from '@/lib/progress';
import type * as ModuleGenModule from '@/llm/moduleGen';
import { clearDatabase } from '../db/helpers';

/**
 * "Resume automatic module creation" (docs/08 §M4-B-3, docs/05 §Module canvas).
 *
 * The owner's requirement is that this works AFTER manual edits, and that it is
 * ADDITIVE: it generates only what is missing and never touches what already
 * exists. Everything here is therefore driven through the real seams (the real
 * entity chain, the real queues, real Dexie) with only the model, the queue
 * suspensions and the toasts mocked — the point is what the resume does to the
 * owner's data.
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

// The queues are suspended (spied, never pumped) — the resume's contract is the
// ENQUEUE, exactly like post-generation's own tests.
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

vi.mock('@/llm/moduleGen', async (importOriginal) => {
  const original = await importOriginal<typeof ModuleGenModule>();
  return {
    ...original,
    // The classification pass is an LLM round-trip; its identity is pinned by
    // its own suite. Here it is spied so the ORDER of the resume's units (and
    // "nothing ran" for the no-op) is observable — the real pass still runs for
    // the classification-required case through this wrapper.
    classifyNewModuleEntityNames: vi.fn(original.classifyNewModuleEntityNames),
  };
});

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);
const { toastError, toastSuccess } = await import('@/lib/toast');
const toastErrorMock = vi.mocked(toastError);
const toastSuccessMock = vi.mocked(toastSuccess);
const { classifyNewModuleEntityNames } = await import('@/llm/moduleGen');
const classifyMock = vi.mocked(classifyNewModuleEntityNames);

const npcDraft = {
  name: 'Kael',
  summary: 'The watchful keeper of the tide gate.',
  suggestedTags: ['warden'],
  body: '# Kael\nKael keeps the gate.',
  appearance: 'Weathered leathers.',
  personality: 'Quiet.',
  needsStatBlock: false,
};

const npcData = { appearance: '', personality: '', statBlock: null };

const INTENT = {
  autoGenerateKinds: ['npc' as const],
  autoImageKinds: ['npc' as const],
  autoGenerateBattlemaps: false,
  autoGenerateMobImages: false,
};

/** A ready module whose intent asks for npc entities + their images. */
async function seedModule(overrides: Partial<Module> = {}): Promise<{
  campaign: Campaign;
  module: Module;
}> {
  const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
  const base = createModule({
    campaignId: campaign.id,
    title: 'Ember Crypt',
    concept: 'A drowned crypt beneath the harbor.',
    levelMin: 1,
    levelMax: 1,
    sizeDial: 'sketch',
    autoGenerateKinds: INTENT.autoGenerateKinds,
    autoImageKinds: INTENT.autoImageKinds,
  });
  const module = await saveModule({
    ...base,
    status: 'ready',
    entityNamesNormalized: true,
    entityKinds: [
      { name: 'Kael', kind: 'npc', absorbed: [] },
      { name: 'Ember Crypt', kind: 'location', absorbed: [] },
    ],
    spine: moduleSpineSchema.parse({
      premise: 'The gate of [[Ember Crypt]] opens at dusk.',
      themes: [],
      partPlan: [{ title: 'The Tide Gate', levelBand: '1', synopsis: '', levelUpTrigger: '' }],
    }),
    parts: [
      modulePartSchema.parse({
        planIndex: 0,
        status: 'ready',
        markdown: '## The Tide Gate\n\n[[Kael]] watches the gate and counts every visitor.',
        edited: false,
        errorMessage: '',
      }),
    ],
    ...overrides,
  });
  return { campaign, module };
}

/** One resolved npc with an image (the owner's finished work). */
async function seedFinishedNpc(campaignId: string, moduleId: string, name: string, imageId: string) {
  return createArtifact({
    campaignId,
    moduleId,
    kind: 'npc',
    name,
    summary: 'already here',
    body: 'Do not touch me.',
    coverImageId: imageId,
    data: npcData,
  });
}

beforeEach(async () => {
  await clearDatabase();
  await seedBuiltInPersonas();
  chatMock.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
  classifyMock.mockClear();
  enqueueImageJobs.mockReset();
  enqueueEncounterMaps.mockReset();
  enqueueMobPortraits.mockReset();
  chainRunner.reset();
  useProgressStore.getState().reset();
});

afterEach(() => {
  chainRunner.reset();
  useProgressStore.getState().reset();
  vi.restoreAllMocks();
});

describe('resumeModuleAutomation', () => {
  it('generates only what is missing, and never touches what already exists', async () => {
    const { campaign, module } = await seedModule();
    // [[Ember Crypt]] is finished (and imaged); only [[Kael]] is missing.
    const crypt = await seedFinishedNpc(
      campaign.id,
      module.id,
      'Ember Crypt',
      '00000000-0000-4000-8000-00000000b001',
    );
    await saveSettings({ ...defaultSettings(), imagesEnabled: true });
    chatMock.mockResolvedValueOnce({
      text: JSON.stringify(npcDraft),
      modelUsed: 'test-model',
      fallback: null,
    });

    const report = await resumeModuleAutomation(module.id, campaign);

    expect(report.empty).toBe(false);
    expect(report.refused).toBeNull();
    expect(report.swept).toBe(true);
    const artifacts = await listArtifactsByCampaign(campaign.id);
    const npcs = artifacts.filter((artifact) => artifact.kind === 'npc');
    expect(npcs.map((artifact) => artifact.name).sort()).toEqual(['Ember Crypt', 'Kael']);
    // The existing artifact is byte-for-byte untouched (no re-detail, no new
    // revision, its image intact).
    const after = artifacts.find((artifact) => artifact.id === crypt.id);
    expect(after?.body).toBe('Do not touch me.');
    expect(after?.currentRevision).toBe(1);
    expect(after?.coverImageId).toBe('00000000-0000-4000-8000-00000000b001');
    // Only the newly generated entity is queued for an image.
    expect(enqueueImageJobs).toHaveBeenCalledWith([
      { campaignId: campaign.id, moduleId: module.id, name: 'Kael' },
    ]);
    // No work ⇒ no snapshot of a text change (this action never rewrites prose).
    expect(await listModuleVersions(module.id)).toHaveLength(0);
    expect(toastErrorMock).not.toHaveBeenCalled();
  }, 30_000);

  it('resumes after a manual edit: the name the owner typed by hand is classified and generated', async () => {
    const { campaign, module } = await seedModule();
    await seedFinishedNpc(campaign.id, module.id, 'Kael', '00000000-0000-4000-8000-00000000b002');
    // The owner hand-edits the prose (the one part-text save path stamps
    // `edited: true`, clears nothing) and links a name no pass has seen.
    const edited = await saveModule({
      ...module,
      parts: [
        modulePartSchema.parse({
          planIndex: 0,
          status: 'ready',
          markdown:
            '## The Tide Gate\n\n[[Kael]] watches the gate. [[Mira]] sells the tide charts.',
          edited: true,
          errorMessage: '',
        }),
      ],
    });
    await saveSettings({ ...defaultSettings(), imagesEnabled: false });
    // The classification pass (real) records the kind, then the entity chain
    // details it.
    chatMock
      .mockResolvedValueOnce({
        text: JSON.stringify({ entities: [{ name: 'Mira', canonical: 'Mira', kind: 'npc' }] }),
        modelUsed: 'test-model',
        fallback: null,
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({ ...npcDraft, name: 'Mira' }),
        modelUsed: 'test-model',
        fallback: null,
      });

    const report = await resumeModuleAutomation(edited.id, campaign);

    expect(report.classified).toEqual(['Mira']);
    expect(report.swept).toBe(true);
    const artifacts = await listArtifactsByCampaign(campaign.id);
    // Kael was NOT regenerated (he exists, with his image).
    const kael = artifacts.filter((artifact) => artifact.name === 'Kael');
    expect(kael).toHaveLength(1);
    expect(kael[0]?.currentRevision).toBe(1);
    const mira = artifacts.find((artifact) => artifact.name === 'Mira');
    expect(mira?.kind).toBe('npc');
    expect(mira?.moduleId).toBe(module.id);
    // The hand-written prose is untouched by the resume.
    const after = await getModule(edited.id);
    expect(after?.parts[0]?.markdown).toContain('[[Mira]] sells the tide charts.');
    expect(after?.parts[0]?.edited).toBe(true);
  }, 30_000);

  it('is a no-op with no side effects when nothing is missing', async () => {
    const { campaign, module } = await seedModule();
    await seedFinishedNpc(campaign.id, module.id, 'Kael', '00000000-0000-4000-8000-00000000b003');
    await seedFinishedNpc(
      campaign.id,
      module.id,
      'Ember Crypt',
      '00000000-0000-4000-8000-00000000b004',
    );
    const before = await getModule(module.id);
    await saveSettings({ ...defaultSettings(), imagesEnabled: true });

    const report = await resumeModuleAutomation(module.id, campaign);

    expect(report).toEqual({
      empty: true,
      refused: null,
      classified: [],
      normalized: false,
      swept: false,
      stopped: false,
    });
    expect(chatMock).not.toHaveBeenCalled();
    expect(classifyMock).not.toHaveBeenCalled();
    expect(enqueueImageJobs).not.toHaveBeenCalled();
    expect(enqueueEncounterMaps).not.toHaveBeenCalled();
    expect(enqueueMobPortraits).not.toHaveBeenCalled();
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(await listModuleVersions(module.id)).toHaveLength(0);
    const after = await getModule(module.id);
    expect(after?.updatedAt).toBe(before?.updatedAt);
  }, 30_000);

  it('stops where it is when a Stop all lands before the sweep', async () => {
    const { campaign, module } = await seedModule({
      // A name the text picked up with no record: the resume's FIRST unit is the
      // classification call, so the stop can land inside a real unit.
      parts: [
        modulePartSchema.parse({
          planIndex: 0,
          status: 'ready',
          markdown: '## The Tide Gate\n\n[[Kael]] watches the gate. [[Mira]] waits.',
          edited: true,
          errorMessage: '',
        }),
      ],
    });
    await saveSettings({ ...defaultSettings(), imagesEnabled: true });
    // The stop lands WHILE the classification unit runs (the owner pressing
    // Stop all during the resume): no normalization, no sweep, no job.
    chatMock.mockImplementationOnce(() => {
      bumpStopEpoch();
      return Promise.resolve({
        text: JSON.stringify({ entities: [{ name: 'Mira', canonical: 'Mira', kind: 'npc' }] }),
        modelUsed: 'test-model',
        fallback: null,
      });
    });

    const report = await resumeModuleAutomation(module.id, campaign);

    expect(report.stopped).toBe(true);
    expect(report.swept).toBe(false);
    expect(report.normalized).toBe(false);
    // The classification call itself ran (it was in flight), and nothing AFTER
    // it started: "a stopped orchestration must not start its next unit".
    expect(chatMock).toHaveBeenCalledTimes(1);
    expect(enqueueImageJobs).not.toHaveBeenCalled();
    expect(enqueueEncounterMaps).not.toHaveBeenCalled();
    expect(enqueueMobPortraits).not.toHaveBeenCalled();
    // Nothing generated, nothing toasted as done.
    const artifacts = await listArtifactsByCampaign(campaign.id);
    expect(artifacts.filter((artifact) => artifact.kind === 'npc')).toHaveLength(0);
    expect(toastSuccessMock).not.toHaveBeenCalled();
  }, 30_000);

  it('refuses a module whose parts pass is not complete, instead of sweeping silently', async () => {
    const { campaign, module } = await seedModule({
      status: 'failed',
      errorMessage: 'Encounter floor not met: …',
    });
    await saveSettings({ ...defaultSettings(), imagesEnabled: true });

    const report = await resumeModuleAutomation(module.id, campaign);

    expect(report.refused).toContain('parts pass did not finish');
    expect(report.swept).toBe(false);
    expect(chatMock).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledWith(expect.stringContaining('parts pass did not finish'));
    expect(enqueueImageJobs).not.toHaveBeenCalled();
  }, 30_000);

  it('refuses loudly when the closed normalization gate cannot be reopened', async () => {
    const { campaign, module } = await seedModule({
      entityNamesNormalized: false,
      entityNormalizationError: 'invalid reply',
      // A name with no record would normally need the classification pass, but
      // the gate is closed, so the full pass owns that state.
      entityKinds: [{ name: 'Ember Crypt', kind: 'location', absorbed: [] }],
    });
    await saveSettings({ ...defaultSettings(), imagesEnabled: true });
    // The full normalization pass fails again (an invalid reply).
    chatMock.mockResolvedValueOnce({ text: 'not json at all', modelUsed: 'test-model', fallback: null });

    const report = await resumeModuleAutomation(module.id, campaign);

    expect(report.normalized).toBe(true);
    expect(report.refused).toContain('normalization failed');
    expect(report.swept).toBe(false);
    const after = await getModule(module.id);
    expect(after?.entityNamesNormalized).toBe(false);
    // Nothing was generated and no queue was fed — a half-run would have been
    // the silent no-op this refusal exists to prevent.
    const artifacts = await listArtifactsByCampaign(campaign.id);
    expect(artifacts.filter((artifact) => artifact.kind === 'npc')).toHaveLength(0);
    expect(enqueueImageJobs).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledWith(expect.stringContaining('normalization failed'), expect.anything());
  }, 30_000);

  it('refuses a row whose automation fields no longer match the recorded intent', async () => {
    const { campaign, module } = await seedModule();
    const drifted = await saveModule({ ...module, autoGenerateKinds: [] });
    await saveSettings({ ...defaultSettings(), imagesEnabled: true });

    const report = await resumeModuleAutomation(drifted.id, campaign);

    expect(report.refused).toContain('no longer match');
    expect(report.swept).toBe(false);
    expect(chatMock).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledWith(expect.stringContaining('no longer match'));
  }, 30_000);

  it('refuses a legacy row (no recorded intent) instead of inferring one', async () => {
    const { campaign, module } = await seedModule();
    const legacy = await saveModule({ ...module, automationIntent: null });

    const report = await resumeModuleAutomation(legacy.id, campaign);

    expect(report.empty).toBe(true);
    expect(report.refused).toContain('no recorded automation intent');
    expect(report.swept).toBe(false);
    expect(chatMock).not.toHaveBeenCalled();
  }, 30_000);

  it('re-derives after a hand-deleted image and regenerates only that image', async () => {
    const { campaign, module } = await seedModule({
      autoGenerateKinds: [],
      autoImageKinds: ['npc'],
      automationIntent: {
        autoGenerateKinds: [],
        autoImageKinds: ['npc'],
        autoGenerateBattlemaps: false,
        autoGenerateMobImages: false,
      },
    });
    const kael = await seedFinishedNpc(
      campaign.id,
      module.id,
      'Kael',
      '00000000-0000-4000-8000-00000000b005',
    );
    await seedFinishedNpc(
      campaign.id,
      module.id,
      'Ember Crypt',
      '00000000-0000-4000-8000-00000000b006',
    );
    await saveSettings({ ...defaultSettings(), imagesEnabled: true });
    // The owner deletes ONE image by hand (their delete is its own revision).
    await updateArtifact(kael.id, { coverImageId: null });
    const afterDelete = (await listArtifactsByCampaign(campaign.id)).find(
      (artifact) => artifact.id === kael.id,
    );

    const report = await resumeModuleAutomation(module.id, campaign);

    expect(report.swept).toBe(true);
    // Only the missing image is queued; the entity itself is not re-detailed.
    expect(enqueueImageJobs).toHaveBeenCalledWith([
      { campaignId: campaign.id, moduleId: module.id, name: 'Kael' },
    ]);
    expect(chatMock).not.toHaveBeenCalled();
    const artifacts = await listArtifactsByCampaign(campaign.id);
    // The entity itself was NOT re-detailed: no new revision from the resume.
    const after = artifacts.find((artifact) => artifact.id === kael.id);
    expect(after?.currentRevision).toBe(afterDelete?.currentRevision);
    expect(after?.body).toBe('Do not touch me.');
  }, 30_000);
});
