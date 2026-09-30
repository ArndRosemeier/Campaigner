import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createArtifact,
  listArtifactsByCampaign,
  listRevisions,
  updateArtifact,
} from '@/db/artifactRepo';
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
import { bumpStopEpoch } from '@/lib/stopEpoch';
import { adoptionArenaLayout } from '../helpers/battle-map-fixtures';
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

const {
  enqueueImageJobs,
  replaceImageJobs,
  enqueueEncounterMaps,
  replaceEncounterMaps,
  enqueuePortraitFill,
  regeneratePortraits,
  runEntityBatchMock,
  changeArtifactMock,
} = vi.hoisted(() => ({
  enqueueImageJobs: vi.fn(),
  replaceImageJobs: vi.fn(),
  enqueueEncounterMaps: vi.fn(),
  replaceEncounterMaps: vi.fn(),
  enqueuePortraitFill: vi.fn(),
  regeneratePortraits: vi.fn(),
  runEntityBatchMock: vi.fn(),
  changeArtifactMock: vi.fn(),
}));

vi.mock('@/features/modules/entity-image-queue', () => ({
  useEntityImageQueue: {
    getState: () => ({ enqueue: enqueueImageJobs, enqueueReplacing: replaceImageJobs }),
  },
}));
vi.mock('@/features/modules/encounter-map-queue', () => ({
  useEncounterMapQueue: {
    getState: () => ({ enqueue: enqueueEncounterMaps, enqueueReplacing: replaceEncounterMaps }),
  },
}));
vi.mock('@/features/campaign/mob-portrait-queue', () => ({
  enqueueEncounterPortraitFill: enqueuePortraitFill,
  regenerateEncounterPortraits: regeneratePortraits,
}));
vi.mock('@/features/modules/change-artifact', () => ({ changeArtifact: changeArtifactMock }));
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

const { toastSuccess, toastError } = await import('@/lib/toast');
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
    overwrite?: boolean;
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
    ...(options.overwrite === undefined ? {} : { overwrite: options.overwrite }),
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

/**
 * THE OVERWRITE RUN (docs/17 row 422). Owner decisions: (1) text is REGENERATED
 * IN PLACE — same artifact id, fresh text, the previous text restorable from the
 * revisions; (2) images are REPLACED — delete-after-replace through each queue's
 * own `regen` job. These pins hold the dispatcher to both: an overwrite detail
 * goes to the change seam's in-place engine aimed at its OWN row (never a new
 * artifact), an encounter goes through `changeArtifact`'s repopulate, and the
 * image/map/portrait halves go through the replacing entries.
 */
describe('the overwrite run regenerates in place and replaces (docs/17 row 422)', () => {
  beforeEach(async () => {
    await clearDatabase();
    for (const mock of [
      enqueueImageJobs,
      replaceImageJobs,
      enqueueEncounterMaps,
      replaceEncounterMaps,
      enqueuePortraitFill,
      regeneratePortraits,
      runEntityBatchMock,
      changeArtifactMock,
    ]) {
      mock.mockReset();
    }
    toastSuccessMock.mockReset();
    vi.mocked(toastError).mockReset();
    useProgressStore.getState().reset();
    regeneratePortraits.mockResolvedValue({ regenerated: 2, filled: 0, republishedCanonical: [] });
  });

  it('an existing detail is refilled IN PLACE: same id, fresh text, a revision — never a new artifact', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = moduleFixture(campaign.id, false);
    await saveModule(module);
    const kael = await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'npc',
      name: 'Kael',
      summary: 'The old model wrote this.',
      body: '',
    });
    // The engine's in-place refill, faked at its boundary: a target aimed at an
    // EXISTING row is written onto that row through the repo (which records the
    // revision), exactly as `runEngine`'s refill does.
    runEntityBatchMock.mockImplementation(
      async ({ targets }: RunEntityBatchInput): Promise<EntityBatchResult> => {
        const produced: EntityBatchResult['produced'] = [];
        for (const target of targets) {
          if (target.artifactId === undefined) throw new Error('overwrite must aim at a row');
          await updateArtifact(target.artifactId, { summary: 'The new model wrote this.' });
          produced.push({ name: target.name, artifactId: target.artifactId, statBlock: 'regenerated' });
        }
        return { generated: targets.map((target) => target.name), cast: [], produced, failed: [], notices: [] };
      },
    );

    const report = await run(campaign, module, { kinds: ['npc'], overwrite: true });

    expect(runEntityBatchMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'npc', targets: [{ name: 'Kael', artifactId: kael.id }] }),
    );
    expect(report.regenerated).toBe(1);
    expect(report.generated).toBe(0);
    const after = await listArtifactsByCampaign(campaign.id);
    expect(after.map((artifact) => artifact.id)).toEqual([kael.id]);
    expect(after[0]?.summary).toBe('The new model wrote this.');
    const revisions = await listRevisions(kael.id);
    expect(revisions.some((revision) => revision.snapshot.summary === 'The old model wrote this.')).toBe(true);
    expect(toastSuccessMock).toHaveBeenCalledWith(
      expect.stringContaining('1 detail regenerated in place'),
    );
  });

  it('WITHOUT the box the same world starts nothing for the existing row', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = moduleFixture(campaign.id, false);
    await saveModule(module);
    await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'npc',
      name: 'Kael',
      summary: 'The old model wrote this.',
      body: '',
    });

    const report = await run(campaign, module, { kinds: ['npc'] });

    expect(runEntityBatchMock).not.toHaveBeenCalled();
    expect(report.regenerated).toBe(0);
  });

  it('an existing encounter is REGENERATED IN FULL through changeArtifact (fresh prose, name kept) — its map comes from that regeneration, never a second map job (docs/17 row 423)', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = moduleFixture(campaign.id, true);
    await saveModule(module);
    const cover = '00000000-0000-4000-8000-00000000c0de';
    await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'npc',
      name: 'Kael',
      summary: 'Warden.',
      body: '',
      coverImageId: cover,
      imageIds: [cover],
    });
    const encounter = await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'encounter',
      name: 'Ash Fight',
      summary: 'Goblins.',
      body: '',
      data: ENCOUNTER_DATA,
    });
    // Mapped: a layout and a map image already exist.
    await updateArtifact(encounter.id, {
      data: { ...ENCOUNTER_DATA, layout: adoptionArenaLayout('4:3'), mapImageId: cover },
    });
    runEntityBatchMock.mockImplementation(
      ({ targets }: RunEntityBatchInput): Promise<EntityBatchResult> =>
        Promise.resolve({
          generated: targets.map((target) => target.name),
          cast: [],
          produced: targets.map((target) => ({
            name: target.name,
            artifactId: target.artifactId ?? 'missing',
            statBlock: 'regenerated' as const,
          })),
          failed: [],
          notices: [],
        }),
    );
    // The regeneration, faked at its boundary: it WRITES a new roster, layout
    // and map onto the SAME row (what "regenerate everything" does), so the
    // portrait half below can be seen reading the REGENERATED roster.
    changeArtifactMock.mockImplementation(async () => {
      await updateArtifact(encounter.id, {
        data: {
          ...ENCOUNTER_DATA,
          monsters: [{ name: 'Fresh Ogre', count: 1, notes: '', treasure: '', source: { type: 'none' } }],
          layout: adoptionArenaLayout('4:3'),
          mapImageId: '00000000-0000-4000-8000-0000000fe5e1',
        },
      });
      return {
        status: 'changed',
        artifactId: encounter.id,
        kind: 'encounter',
        operation: 'encounter-regenerate-everything',
      };
    });

    const report = await run(campaign, module, {
      kinds: ['npc', 'encounter'],
      imageKinds: ['npc'],
      battlemaps: true,
      mobPortraits: true,
      overwrite: true,
    });

    // The encounter is NOT an entity-batch target: it is regenerated through the
    // ONE change seam — the FULL regeneration with fresh prose, the name kept
    // (no `redesignProse`, which renames).
    expect(runEntityBatchMock).toHaveBeenCalledTimes(1);
    expect(runEntityBatchMock.mock.calls[0]?.[0]).toMatchObject({ kind: 'npc' });
    expect(changeArtifactMock).toHaveBeenCalledWith({
      artifactId: encounter.id,
      encounter: { operation: 'everything', freshProse: true },
    });
    expect(report.regenerated).toBe(2);
    // Images and portraits go through the REPLACING entries as regen jobs.
    expect(enqueueImageJobs).not.toHaveBeenCalled();
    expect(replaceImageJobs).toHaveBeenCalledWith([
      { campaignId: campaign.id, moduleId: module.id, name: 'Kael', regen: true },
    ]);
    // NO map job at all, although Battlemaps is ticked: the regeneration drew
    // the fresh map, a second job would draw it twice.
    expect(enqueueEncounterMaps).not.toHaveBeenCalled();
    expect(replaceEncounterMaps).not.toHaveBeenCalled();
    expect(report.mapJobs).toBe(0);
    expect(report.notes).toContain('battlemaps were NOT queued — each regenerated encounter redrew its own');
    // The portraits run AFTER the regeneration, on the REGENERATED roster.
    expect(enqueuePortraitFill).not.toHaveBeenCalled();
    expect(regeneratePortraits).toHaveBeenCalledTimes(1);
    expect(regeneratePortraits.mock.calls[0]?.[0]).toMatchObject({
      id: encounter.id,
      data: { monsters: [expect.objectContaining({ name: 'Fresh Ogre' })] },
    });
    expect(report.imageJobs).toBe(1);
    expect(report.portraitJobs).toBe(2);
    // The printed plan is the run's own count: the selection the run used
    // counts no map job for the regenerated encounter either.
    expect(report.selection.overwrites.maps).toEqual([]);
    expect(report.selection.maps).toEqual([]);
  });

  it('a Stop between encounters ends the overwrite without reporting the stop as a failure', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = moduleFixture(campaign.id, true);
    await saveModule(module);
    await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'encounter',
      name: 'Ash Fight',
      summary: 'Goblins.',
      body: '',
      data: ENCOUNTER_DATA,
    });
    changeArtifactMock.mockImplementation(() => {
      bumpStopEpoch();
      return Promise.reject(new Error('Repopulate ended cancelled'));
    });

    const report = await run(campaign, module, { kinds: ['encounter'], overwrite: true });

    expect(changeArtifactMock).toHaveBeenCalledTimes(1);
    expect(report.stopped).toBe(true);
    expect(report.regenerated).toBe(0);
    expect(vi.mocked(toastError)).not.toHaveBeenCalled();
  });
});
