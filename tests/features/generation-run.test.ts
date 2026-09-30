import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact, listArtifactsByCampaign } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { patchModule, saveModule } from '@/db/moduleRepo';
import {
  createModule,
  libraryCreatureKey,
  modulePartSchema,
  moduleSpineSchema,
  type Artifact,
  type Campaign,
  type EntityKind,
  type Module,
} from '@/domain';
import type { EntityBatchResult, RunEntityBatchInput } from '@/features/modules/entity-batch';
import { generationRunActive, runGenerationSelection } from '@/features/modules/generation-run';
import { useProgressStore } from '@/lib/progress';
import type * as moduleGenModule from '@/llm/moduleGen';
import { clearDatabase } from '../db/helpers';

/**
 * THE GENERATION DISPATCHER'S POST-PASS RE-DERIVATION (docs/17 row 406).
 *
 * The owner's report: *"I tried to generate everything, including images. But
 * no images were generated, the dialog just finished."* The measured cause is
 * that `selectGenerationTargets` was computed ONCE, BEFORE the detail batch, and
 * every image/map/portrait detector asks what EXISTS — so on a first run the
 * enqueue half started nothing and the summary stayed silent.
 *
 * These pins are about the DISPATCHER, not the seam (that is
 * `tests/features/generation-selection.test.ts`), so the batch is mocked and
 * made to WRITE the artifact it claims to have produced: the fresh read then
 * really finds it. A flag-only mock would pass even if the run never re-read
 * the pool, which is the exact defect.
 */

const { enqueueImageJobs, enqueueEncounterMaps, enqueuePortraitFill, runEntityBatchMock } =
  vi.hoisted(() => ({
    enqueueImageJobs: vi.fn(),
    enqueueEncounterMaps: vi.fn(),
    enqueuePortraitFill: vi.fn(),
    runEntityBatchMock: vi.fn(),
  }));

vi.mock('@/features/modules/entity-image-queue', () => ({
  useEntityImageQueue: { getState: () => ({ enqueue: enqueueImageJobs }) },
}));
vi.mock('@/features/modules/encounter-map-queue', () => ({
  useEncounterMapQueue: { getState: () => ({ enqueue: enqueueEncounterMaps }) },
}));
vi.mock('@/features/campaign/mob-portrait-queue', () => ({
  enqueueEncounterPortraitFill: enqueuePortraitFill,
}));
vi.mock('@/features/modules/entity-batch', () => ({
  runEntityBatch: runEntityBatchMock,
}));
// The name-normalization pass is a model call: faked here to WRITE what the real
// pass records (the kinds + the gate flag), so the run's re-derivation after the
// gate is what these pins observe (docs/17 row 414).
const { normalizeMock } = vi.hoisted(() => ({ normalizeMock: vi.fn() }));
vi.mock('@/llm/moduleGen', async (importOriginal) => ({
  ...(await importOriginal<typeof moduleGenModule>()),
  normalizeModuleEntityNames: normalizeMock,
}));
vi.mock('@/lib/toast', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
  toastErrorPersistent: vi.fn(),
  toastInfoPersistent: vi.fn(),
}));

const { toastSuccess } = await import('@/lib/toast');
const toastSuccessMock = vi.mocked(toastSuccess);

const RANGE = { min: 1, max: 3 };

/** A module whose text names Kael (npc), Old Keep (location) and optionally Ash Fight (encounter). */
function moduleFixture(campaignId: string, withEncounter: boolean): Module {
  const base = createModule({
    campaignId,
    title: 'Ember Crypt',
    concept: '',
    levelMin: 1,
    levelMax: 3,
    sizeDial: 'sketch',
  });
  const entityKinds: Module['entityKinds'] = [
    { name: 'Kael', kind: 'npc', absorbed: [], levelHint: 3 },
    { name: 'Old Keep', kind: 'location', absorbed: [] },
    ...(withEncounter
      ? [{ name: 'Ash Fight', kind: 'encounter' as const, absorbed: [], levelHint: 3 }]
      : []),
  ];
  const sections = [
    '[[Kael]] watches the gate.',
    withEncounter ? 'The party forces [[Ash Fight]] at [[Old Keep]].' : 'They ride to [[Old Keep]].',
  ];
  return {
    ...base,
    status: 'ready',
    entityNamesNormalized: true,
    entityKinds,
    spine: moduleSpineSchema.parse({
      premise: 'The gate opens at dusk.',
      themes: [],
      partPlan: sections.map((_, index) => ({
        title: `Level ${String(index + 1)}`,
        levelBand: String(index + 1),
        synopsis: '',
        levelUpTrigger: '',
      })),
    }),
    parts: sections.map((markdown, planIndex) =>
      modulePartSchema.parse({
        planIndex,
        markdown,
        status: 'ready',
        errorMessage: '',
        edited: false,
      }),
    ),
  };
}

/** The encounter data shape a real encounter artifact carries. */
const ENCOUNTER_DATA: Artifact['data'] = {
  difficulty: 'medium',
  levelHint: '',
  partyLevel: 3,
  monsters: [
    {
      name: 'Goblin',
      count: 2,
      notes: '',
      treasure: '',
      source: { type: 'none' },
      originToken: libraryCreatureKey('00000000-0000-4000-8000-00000000c001'),
    },
  ],
  terrain: '',
  tactics: '',
  treasure: '',
  mapImageId: null,
  layout: null,
  preset: 'standard',
  locationKind: 'other',
  siteShape: 'single',
  budgetAdvisory: '',
};

/** The batch mock: it WRITES each produced artifact, then reports success. */
function makeBatchWriteArtifacts(campaignId: string, moduleId: string): void {
  runEntityBatchMock.mockImplementation(
    async ({ kind, targets }: RunEntityBatchInput): Promise<EntityBatchResult> => {
      const produced: EntityBatchResult['produced'] = [];
      for (const target of targets) {
        const artifact =
          kind === 'encounter'
            ? await createArtifact({
                campaignId,
                moduleId,
                kind: 'encounter',
                name: target.name,
                summary: '',
                body: '',
                data: ENCOUNTER_DATA,
              })
            : await createArtifact({
                campaignId,
                moduleId,
                kind,
                name: target.name,
                summary: '',
                body: '',
              });
        produced.push({ name: target.name, artifactId: artifact.id, statBlock: 'regenerated' });
      }
      return {
        generated: targets.map((target) => target.name),
        cast: [],
        produced,
        failed: [],
        notices: [],
      };
    },
  );
}

async function run(
  campaign: Campaign,
  module: Module,
  options: {
    kinds: EntityKind[];
    imageKinds?: EntityKind[];
    battlemaps?: boolean;
    mobPortraits?: boolean;
  },
) {
  return runGenerationSelection({
    module,
    campaign,
    // The page's artifact pool, read fresh: the plan is derived from what the
    // caller can see at press time, exactly as the dialog hands it over.
    artifacts: await listArtifactsByCampaign(campaign.id),
    kinds: options.kinds,
    imageKinds: options.imageKinds ?? [],
    levelRange: RANGE,
    encounterExtras: {
      battlemaps: options.battlemaps ?? false,
      mobPortraits: options.mobPortraits ?? false,
    },
  });
}

describe('runGenerationSelection re-derives after the detail pass (docs/17 row 406)', () => {
  beforeEach(async () => {
    await clearDatabase();
    enqueueImageJobs.mockReset();
    enqueueEncounterMaps.mockReset();
    enqueuePortraitFill.mockReset();
    runEntityBatchMock.mockReset();
    toastSuccessMock.mockReset();
    enqueuePortraitFill.mockResolvedValue({ enqueued: 1, alreadyImaged: [] });
  });

  it('a first run with images ticked creates the details AND enqueues one image per created entity', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = moduleFixture(campaign.id, false);
    await saveModule(module);
    makeBatchWriteArtifacts(campaign.id, module.id);

    const report = await run(campaign, module, { kinds: ['npc'], imageKinds: ['npc'] });

    expect(report.generated).toBe(1);
    // NOTHING existed before the pass: the actual count is 1 because the pass
    // created the entity and the FRESH read found it.
    expect(report.imageJobs).toBe(1);
    expect(report.notes).toEqual([]);
    const artifacts = await listArtifactsByCampaign(campaign.id);
    expect(artifacts.map((artifact) => artifact.name)).toEqual(['Kael']);
    expect(enqueueImageJobs).toHaveBeenCalledTimes(1);
    expect(enqueueImageJobs).toHaveBeenCalledWith([
      { campaignId: campaign.id, moduleId: module.id, name: 'Kael' },
    ]);
    expect(toastSuccessMock).toHaveBeenCalledWith(
      expect.stringContaining('1 artifact generated'),
    );
    expect(toastSuccessMock).toHaveBeenCalledWith(expect.stringContaining('1 image queued'));
  });

  it('a run that CREATES an encounter enqueues its battlemap and its mob portraits', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = moduleFixture(campaign.id, true);
    await saveModule(module);
    makeBatchWriteArtifacts(campaign.id, module.id);

    const report = await run(campaign, module, {
      kinds: ['encounter'],
      battlemaps: true,
      mobPortraits: true,
    });

    expect(report.generated).toBe(1);
    expect(report.mapJobs).toBe(1);
    expect(report.portraitJobs).toBe(1);
    expect(report.notes).toEqual([]);
    const artifacts = await listArtifactsByCampaign(campaign.id);
    const encounter = artifacts.find((artifact) => artifact.kind === 'encounter');
    expect(encounter?.name).toBe('Ash Fight');
    // The map job carries the artifact the PASS created (never a plan-time id).
    expect(enqueueEncounterMaps).toHaveBeenCalledWith([
      {
        campaignId: campaign.id,
        moduleId: module.id,
        artifactId: encounter?.id,
        name: 'Ash Fight',
      },
    ]);
    // The portrait fill gets the created ROW, resolved from the fresh pool.
    expect(enqueuePortraitFill).toHaveBeenCalledTimes(1);
    expect(enqueuePortraitFill.mock.calls[0]?.[0]).toMatchObject({
      id: encounter?.id,
      kind: 'encounter',
    });
    expect(enqueuePortraitFill.mock.calls[0]?.[1]).toBe(campaign.id);
  });

  it('a ticked kind that produced NOTHING is NAMED with its reason', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = moduleFixture(campaign.id, false);
    await saveModule(module);
    // Kael exists, is detailed and already carries an image; Old Keep still
    // needs its detail. So the run HAS work (Old Keep), yet the ticked npc
    // image kind has none, and there is no encounter for the ticked extras.
    await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'npc',
      name: 'Kael',
      summary: '',
      body: '',
      coverImageId: '00000000-0000-4000-8000-00000000a001',
    });
    makeBatchWriteArtifacts(campaign.id, module.id);

    const report = await run(campaign, module, {
      kinds: ['npc', 'location'],
      imageKinds: ['npc'],
      battlemaps: true,
      mobPortraits: true,
    });

    expect(report.generated).toBe(1);
    expect(report.imageJobs).toBe(0);
    expect(report.mapJobs).toBe(0);
    expect(report.portraitJobs).toBe(0);
    expect(report.notes).toEqual([
      'images were NOT queued — no selected entity without an image exists after this run',
      'battlemaps were NOT queued — no selected encounter needs one',
      'mob portraits were NOT queued — no selected encounter has a creature without a portrait',
    ]);
    // The ticked kinds are spoken in the run's own summary.
    expect(toastSuccessMock).toHaveBeenCalledWith(
      expect.stringContaining('images were NOT queued'),
    );
    expect(toastSuccessMock).toHaveBeenCalledWith(
      expect.stringContaining('battlemaps were NOT queued'),
    );
    expect(toastSuccessMock).toHaveBeenCalledWith(
      expect.stringContaining('mob portraits were NOT queued'),
    );
  });

  it('never enqueues an image for a name whose detail FAILED (the queues fail loudly on a missing artifact)', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = moduleFixture(campaign.id, false);
    await saveModule(module);
    // The batch writes NOTHING — the target simply did not land. The image
    // queue must not be handed a name with no artifact: its own contract is to
    // fail loudly on a missing artifact, and that failure has already been
    // reported by the batch (a double report is the defect this pins against).
    runEntityBatchMock.mockResolvedValue({
      generated: [],
      cast: [],
      produced: [],
      failed: [],
      notices: [],
    });

    const report = await run(campaign, module, { kinds: ['npc'], imageKinds: ['npc'] });

    expect(report.refused).toBeNull();
    expect(report.stopped).toBe(false);
    expect(report.generated).toBe(0);
    expect(report.imageJobs).toBe(0);
    expect(enqueueImageJobs).not.toHaveBeenCalled();
    expect(report.notes).toEqual([
      'images were NOT queued — no selected entity without an image exists after this run',
    ]);
  });
});

describe('a chat-born module is normalized before its first generation (docs/17 row 414)', () => {
  beforeEach(async () => {
    await clearDatabase();
    runEntityBatchMock.mockReset();
    normalizeMock.mockReset();
  });

  it('runs the gate FIRST and generates from the kinds it recorded, not the empty pre-gate plan', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const recorded = moduleFixture(campaign.id, false);
    // The chat creates a document with links and NO recorded kinds, gate closed.
    const module: Module = { ...recorded, entityKinds: [], entityNamesNormalized: false };
    await saveModule(module);
    makeBatchWriteArtifacts(campaign.id, module.id);
    normalizeMock.mockImplementation(async (moduleId: string) => {
      await patchModule(moduleId, { entityKinds: recorded.entityKinds, entityNamesNormalized: true });
    });

    const report = await run(campaign, module, { kinds: ['npc'] });

    expect(normalizeMock).toHaveBeenCalledTimes(1);
    expect(report.refused).toBeNull();
    expect(report.selection.detail.map((target) => target.name)).toEqual(['Kael']);
    expect(report.generated).toBe(1);
    expect(runEntityBatchMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'npc', targets: [{ name: 'Kael' }] }),
    );
  });

  it('spends no model call when no kind is ticked', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module: Module = { ...moduleFixture(campaign.id, false), entityKinds: [], entityNamesNormalized: false };
    await saveModule(module);

    await run(campaign, module, { kinds: [] });

    expect(normalizeMock).not.toHaveBeenCalled();
    expect(runEntityBatchMock).not.toHaveBeenCalled();
  });
});

describe('one run per module, and the run lives in the dock (docs/17 row 419)', () => {
  beforeEach(async () => {
    await clearDatabase();
    runEntityBatchMock.mockReset();
    useProgressStore.getState().reset();
  });

  it('holds a dock entry while it runs, refuses a second start, and clears the entry when it settles', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = moduleFixture(campaign.id, false);
    await saveModule(module);
    let release: () => void = () => undefined;
    runEntityBatchMock.mockImplementation(
      () =>
        new Promise<EntityBatchResult>((resolve) => {
          release = () => {
            resolve({ generated: [], cast: [], produced: [], failed: [], notices: [] });
          };
        }),
    );

    const first = run(campaign, module, { kinds: ['npc'] });
    await vi.waitFor(() => {
      expect(runEntityBatchMock).toHaveBeenCalledTimes(1);
    });
    expect(generationRunActive(module.id)).toBe(true);

    const second = await run(campaign, module, { kinds: ['npc'] });
    expect(second.refused).toContain('already in progress');
    expect(runEntityBatchMock).toHaveBeenCalledTimes(1);

    release();
    await first;
    expect(generationRunActive(module.id)).toBe(false);
  });
});
