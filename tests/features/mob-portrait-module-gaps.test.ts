import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact, listArtifactsByCampaign } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { inventedCreatureMarker } from '@/db/mobArtifacts';
import { saveModule } from '@/db/moduleRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { saveSettings } from '@/db/settingsRepo';
import {
  createModule,
  defaultSettings,
  modulePartSchema,
  moduleSpineSchema,
  type AnyArtifact,
  type Artifact,
  type Module,
  type EncounterArtifactData,
  type ModuleAutomationIntent,
  type MonsterEntry,
} from '@/domain';
import {
  FULL_AUTOMATION_TARGET,
  encountersNeedingMobPortraits,
  runModulePostGeneration,
} from '@/features/modules/post-generation';
import {
  deriveAutomationDeviation,
  deviationIsEmpty,
  deviationLines,
} from '@/features/modules/automation-deviation';
import type * as MobPortraitQueueModule from '@/features/campaign/mob-portrait-queue';
import { clearDatabase } from '../db/helpers';

/**
 * The MODULE-level portrait gap (owner report, verbatim: *"When telling the
 * module generator to generate all, including encounter mob images, images for
 * mobs from the core that do not have them are still not generated. Same with
 * the generate all button, its not there although some encounter mobs do not
 * have images."*; docs/17 row 96).
 *
 * What is pinned here — the two halves of that one defect, and their agreement:
 *
 * 1. the module-level detector (`encountersNeedingMobPortraits`, and through it
 *    the "Generate everything" deviation) sees EVERY roster participant that can
 *    own a portrait — a chunk-backed `npc-ref` (the artifact the encounter
 *    materialized a core creature into, `data.monsterChunkId` set) and an
 *    uncited entry included — instead of rulebook citations only;
 * 2. the sweep enqueues BOTH lanes for such an encounter (the rulebook batch
 *    entry AND the invented one), so a counted encounter really gets its
 *    portraits;
 * 3. the offer and the work AGREE: the detector's verdict is compared against
 *    the REAL queue's own read-only enumeration (`planMobPortraitBatch`, reached
 *    through `vi.importActual`) over the same live DB, in both directions —
 *    nothing missing ⇒ no offer, and a hole ⇒ the plan names it;
 * 4. a dangling `npc-ref` neither crashes the detector nor goes silent: the
 *    encounter is offered, the enqueue fails loudly for THAT encounter, and the
 *    remaining encounters still enqueue.
 *
 * The queues are spied (never pumped) — the contract here is the enqueue;
 * the queue's own enumeration/routing behaviour is pinned by its own suites.
 */

vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {},
  OpenRouterError: class OpenRouterError extends Error {},
  listModels: vi.fn(),
}));

vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

const { enqueueImageJobs, enqueueEncounterMaps, enqueueMobPortraits, enqueueInventedPortraits } =
  vi.hoisted(() => ({
    enqueueImageJobs: vi.fn(),
    enqueueEncounterMaps: vi.fn(),
    enqueueMobPortraits: vi.fn(),
    enqueueInventedPortraits: vi.fn(),
  }));

vi.mock('@/features/modules/entity-image-queue', () => ({
  useEntityImageQueue: { getState: () => ({ enqueue: enqueueImageJobs }) },
}));

vi.mock('@/features/modules/encounter-map-queue', () => ({
  useEncounterMapQueue: { getState: () => ({ enqueue: enqueueEncounterMaps }) },
}));

vi.mock('@/features/campaign/mob-portrait-queue', () => ({
  enqueueMobPortraits,
  enqueueInventedCreaturePortraits: enqueueInventedPortraits,
}));

const { toastError, toastSuccess } = await import('@/lib/toast');
const toastErrorMock = vi.mocked(toastError);
const toastSuccessMock = vi.mocked(toastSuccess);

/** The REAL queue module, for the agreement pin (the mock above never touches
 * `planMobPortraitBatch`, which is read-only: no artifact, no clone, no job). */
async function realQueue(): Promise<typeof MobPortraitQueueModule> {
  return vi.importActual<typeof MobPortraitQueueModule>(
    '@/features/campaign/mob-portrait-queue',
  );
}

const CHUNK_ID = '00000000-0000-4000-8000-00000000c001';
const COVER_ID = '00000000-0000-4000-8000-00000000d001';

const npcData = { appearance: '', personality: '', statBlock: null };

/** A core/bestiary creature: the campaign's mob artifact for one chunk — the
 * artifact the encounter materializes a cited creature into. Campaign-scoped
 * and NOT module-owned (the real shape), which is why the detector reads the
 * campaign pool the sweep itself reads. */
async function seedMobArtifact(
  campaignId: string,
  options: { name: string; coverImageId?: string | null },
): Promise<Artifact> {
  return createArtifact({
    campaignId,
    kind: 'npc',
    name: options.name,
    summary: '',
    body: '',
    coverImageId: options.coverImageId ?? null,
    data: { ...npcData, monsterChunkId: CHUNK_ID },
  });
}

/** An uncited (`none`) roster entry's on-demand creature, as the invented lane
 * materializes it (marker + name are the whole identity rule). */
async function seedInventedCreature(
  campaignId: string,
  moduleId: string,
  encounterId: string,
  name: string,
  coverImageId: string | null,
): Promise<Artifact> {
  return createArtifact({
    campaignId,
    moduleId,
    kind: 'npc',
    name,
    summary: `On-demand creature created for encounter "Ash Gate" ${inventedCreatureMarker(encounterId)}`,
    body: '',
    coverImageId,
    data: npcData,
  });
}

/** The encounter data shape, typed ONCE: an inline literal against the
 * artifact-data union narrows its members to `never`, so the repo's own test
 * helpers name the type too. */
function encounterData(monsters: EncounterArtifactData['monsters']): EncounterArtifactData {
  return {
    difficulty: 'medium',
    levelHint: '3',
    monsters,
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
}

/** A module-owned encounter with the given roster; no map, no images. */
async function seedEncounter(
  campaignId: string,
  moduleId: string,
  monsters: EncounterArtifactData['monsters'],
  name = 'Ash Gate',
): Promise<Artifact> {
  return createArtifact({
    campaignId,
    moduleId,
    kind: 'encounter',
    name,
    summary: '',
    body: '',
    data: encounterData(monsters),
  });
}

/** Portraits are the ONLY thing this target asks for, so a deviation or a
 * toast it produces is about portraits and nothing else. */
const PORTRAIT_ONLY: ModuleAutomationIntent = {
  autoGenerateKinds: [],
  autoImageKinds: [],
  autoGenerateBattlemaps: false,
  autoGenerateMobImages: true,
};

/** The loud narrowing this suite needs (never a cast): the encounter artifact
 * a roster lives on. */
function asEncounter(artifact: Artifact): AnyArtifact & { kind: 'encounter' } {
  if (artifact.kind !== 'encounter') {
    throw new Error(`expected an encounter artifact, got a ${artifact.kind}`);
  }
  return artifact;
}

/** A ready module with NO text-named entities: every deviation it reports is
 * about artifacts, never about entity work (the module row configures nothing,
 * so only the explicit target decides what the sweep looks at). */
async function seedModule(campaignId: string, overrides: Partial<Module> = {}): Promise<Module> {
  const base = createModule({
    campaignId,
    title: 'Ember Crypt',
    concept: 'A drowned crypt beneath the harbor.',
    levelMin: 1,
    levelMax: 4,
    sizeDial: 'sketch',
    autoGenerateKinds: [],
  });
  return saveModule({
    ...base,
    status: 'ready',
    entityNamesNormalized: true,
    entityKinds: [],
    spine: moduleSpineSchema.parse({
      premise: 'The gate of the Ember Crypt opens at dusk.',
      themes: [],
      partPlan: [{ title: 'The Tide Gate', levelBand: '1–4', synopsis: '', levelUpTrigger: '' }],
    }),
    parts: [
      modulePartSchema.parse({
        planIndex: 0,
        status: 'ready',
        markdown: '## The Tide Gate\n\nThe gate opens at dusk.',
        edited: false,
        errorMessage: '',
      }),
    ],
    ...overrides,
  });
}

/** Roster rows are built through TYPED helpers: an inline literal widens
 * `source.type` to `string` and stops matching the discriminated union. */
function npcRefEntry(name: string, artifactId: string, count = 1): MonsterEntry {
  return { name, count, notes: '', treasure: '', source: { type: 'npc-ref', artifactId } };
}

function uncitedEntry(name: string, count = 1, notes = ''): MonsterEntry {
  return { name, count, notes, treasure: '', source: { type: 'none' } };
}

/** The owner's roster shape: a chunk-backed `npc-ref` (a materialized CORE
 * creature) PLUS an uncited entry — no rulebook citation anywhere. */
function ownerRoster(mobArtifactId: string): MonsterEntry[] {
  return [
    npcRefEntry('Gelatinous Cube', mobArtifactId),
    uncitedEntry('Bog Lurker', 2, 'Reeks of the fen.'),
  ];
}

async function campaignArtifacts(campaignId: string): Promise<AnyArtifact[]> {
  return listArtifactsByCampaign(campaignId);
}

beforeEach(async () => {
  await clearDatabase();
  await seedBuiltInPersonas();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
  enqueueImageJobs.mockReset();
  enqueueEncounterMaps.mockReset();
  enqueueMobPortraits.mockReset();
  enqueueInventedPortraits.mockReset();
  enqueueMobPortraits.mockResolvedValue({ enqueued: 0, alreadyImaged: [] });
  enqueueInventedPortraits.mockResolvedValue({ created: 0, enqueued: 0, alreadyImaged: [] });
  await saveSettings({ ...defaultSettings(), imagesEnabled: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the module-level portrait gap (docs/17 row 96)', () => {
  it('offers an encounter whose roster is ONLY npc-ref + uncited, and the queue agrees it has work', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = await seedModule(campaign.id);
    const mob = await seedMobArtifact(campaign.id, { name: 'Gelatinous Cube' });
    const encounter = await seedEncounter(campaign.id, module.id, ownerRoster(mob.id));
    const artifacts = await campaignArtifacts(campaign.id);

    // (1) The detector sees it — the old rulebook-only rule returned false here,
    //    which is why the sweep never ran and the sidebar control never appeared.
    const targets = encountersNeedingMobPortraits(module, artifacts);
    expect(targets.map((target) => target.id)).toEqual([encounter.id]);

    // (2) The "Generate everything" derivation is not empty and its line NAMES
    //    the encounter (the line the entity panel renders verbatim).
    const deviation = deriveAutomationDeviation(module, artifacts, FULL_AUTOMATION_TARGET);
    expect(deviation.mobPortraits.map((target) => target.id)).toEqual([encounter.id]);
    expect(deviationIsEmpty(deviation)).toBe(false);
    expect(deviationLines(deviation)).toContain(
      'Mob portraits missing for 1 encounter: Ash Gate',
    );

    // (3) The offer and the work AGREE: the queue's OWN read-only enumeration
    //    (reached through importActual — the real module, real Dexie) names the
    //    same two creature kinds as missing, across BOTH lanes.
    const real = await realQueue();
    const plan = await real.planMobPortraitBatch(asEncounter(encounter), campaign.id);
    expect(plan.missing.sort()).toEqual(['Bog Lurker', 'Gelatinous Cube']);
    expect(plan.imaged).toEqual([]);
    // The chunk-backed `npc-ref` rides the rulebook lane (`creates` counts the
    // uncited one only: the mob artifact already exists).
    expect(plan.creates).toBe(1);
  }, 30_000);

  it('enqueues BOTH lanes for it, and the completion toast counts both truthfully', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    // The module ROW's `autoGenerateMobImages` is OFF (createModule's default,
    // which is also the owner's case) while the target asks for it: the RUN's
    // own switch decides, exactly as the confirmation's does — reading the row
    // here is what made "Generate everything" offer portraits and then enqueue
    // none (owner report, second symptom).
    const module = await seedModule(campaign.id);
    const mob = await seedMobArtifact(campaign.id, { name: 'Gelatinous Cube' });
    const encounter = await seedEncounter(campaign.id, module.id, ownerRoster(mob.id));
    enqueueMobPortraits.mockResolvedValue({ enqueued: 1, alreadyImaged: [] });
    enqueueInventedPortraits.mockResolvedValue({ created: 1, enqueued: 1, alreadyImaged: [] });

    expect(module.autoGenerateMobImages).toBe(false);
    await runModulePostGeneration(module.id, campaign, FULL_AUTOMATION_TARGET);

    // The rulebook lane for the chunk-backed participant...
    expect(enqueueMobPortraits).toHaveBeenCalledTimes(1);
    expect(enqueueMobPortraits.mock.calls[0]?.[0]).toMatchObject({
      id: encounter.id,
      kind: 'encounter',
    });
    expect(enqueueMobPortraits.mock.calls[0]?.[1]).toBe(campaign.id);
    // ...and the invented lane for the uncited one (the half that was missing).
    expect(enqueueInventedPortraits).toHaveBeenCalledTimes(1);
    expect(enqueueInventedPortraits.mock.calls[0]?.[0]).toMatchObject({ id: encounter.id });
    expect(enqueueInventedPortraits.mock.calls[0]?.[1]).toBe(campaign.id);
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).toHaveBeenCalledWith(
      expect.stringContaining('2 mob portraits queued'),
    );
  }, 30_000);

  it('yields no work at all once every participant is imaged (no over-offering)', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = await seedModule(campaign.id);
    const mob = await seedMobArtifact(campaign.id, {
      name: 'Gelatinous Cube',
      coverImageId: COVER_ID,
    });
    const encounter = await seedEncounter(campaign.id, module.id, ownerRoster(mob.id));
    await seedInventedCreature(campaign.id, module.id, encounter.id, 'Bog Lurker', COVER_ID);
    const artifacts = await campaignArtifacts(campaign.id);

    const deviation = deriveAutomationDeviation(module, artifacts, PORTRAIT_ONLY);
    expect(deviation.mobPortraits).toEqual([]);
    expect(deviationIsEmpty(deviation)).toBe(true);

    // The same verdict from the queue's own enumeration: everything imaged.
    const real = await realQueue();
    const plan = await real.planMobPortraitBatch(asEncounter(encounter), campaign.id);
    expect(plan.missing).toEqual([]);
    expect(plan.imaged.sort()).toEqual(['Bog Lurker', 'Gelatinous Cube']);

    // ...and the sweep enqueues nothing (the target encounters are empty).
    await runModulePostGeneration(module.id, campaign, PORTRAIT_ONLY);
    expect(enqueueMobPortraits).not.toHaveBeenCalled();
    expect(enqueueInventedPortraits).not.toHaveBeenCalled();
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).not.toHaveBeenCalled();
  }, 30_000);

  it('treats a gallery-only artifact as imaged on BOTH sides (one art reading)', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = await seedModule(campaign.id);
    // Art that is NOT a cover: the batch counts the kind imaged (there is real
    // art, and setting the cover is the owner's call) — the detector must say
    // the same, or the offer would disagree with the work again.
    const mob = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Gelatinous Cube',
      summary: '',
      body: '',
      imageIds: ['00000000-0000-4000-8000-00000000e001'],
      data: { ...npcData, monsterChunkId: CHUNK_ID },
    });
    const encounter = await seedEncounter(campaign.id, module.id, [
      npcRefEntry('Gelatinous Cube', mob.id),
    ]);
    const artifacts = await campaignArtifacts(campaign.id);

    expect(encountersNeedingMobPortraits(module, artifacts)).toEqual([]);
    const real = await realQueue();
    const plan = await real.planMobPortraitBatch(asEncounter(encounter), campaign.id);
    expect(plan.missing).toEqual([]);
    expect(plan.imaged).toEqual(['Gelatinous Cube']);
  }, 30_000);

  it('never lets a dangling npc-ref crash the detector — and reports it loudly, not silently', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = await seedModule(campaign.id);
    const gone = '00000000-0000-4000-8000-00000000f001';
    const dangling = await seedEncounter(
      campaign.id,
      module.id,
      [npcRefEntry('Ghost Lumberjack', gone)],
      'Ash Gate',
    );
    const mob = await seedMobArtifact(campaign.id, { name: 'Gelatinous Cube' });
    const healthy = await seedEncounter(
      campaign.id,
      module.id,
      [npcRefEntry('Gelatinous Cube', mob.id)],
      'Flooded Stair',
    );
    const artifacts = await campaignArtifacts(campaign.id);

    // The detector does not throw and does not hide the row: a linked artifact
    // the snapshot cannot see is WORK (the enqueue is where the loud error is).
    const targets = encountersNeedingMobPortraits(module, artifacts);
    expect(targets.map((target) => target.name).sort()).toEqual(['Ash Gate', 'Flooded Stair']);
    expect(targets.map((target) => target.id)).toContain(dangling.id);

    // The sweep aggregates the queue's own loud per-encounter failure (the real
    // message, verbatim from `enumerateBatchKinds`) and still enqueues the rest.
    enqueueMobPortraits.mockImplementation((encounter: { name: string }) => {
      if (encounter.name === 'Ash Gate') {
        throw new Error(
          'Generate mob portraits: the artifact for "Ghost Lumberjack" no longer exists — re-run the encounter content to restore it',
        );
      }
      return Promise.resolve({ enqueued: 1, alreadyImaged: [] });
    });
    await runModulePostGeneration(module.id, campaign, FULL_AUTOMATION_TARGET);

    expect(enqueueMobPortraits).toHaveBeenCalledTimes(2);
    expect(enqueueMobPortraits).toHaveBeenCalledWith(
      expect.objectContaining({ id: healthy.id }),
      campaign.id,
    );
    const failureToast = toastErrorMock.mock.calls[0]?.[0];
    expect(failureToast).toContain('1 of 2 encounters failed to enqueue mob portraits');
    expect(failureToast).toContain('"Ash Gate"');
    expect(failureToast).toContain('Ghost Lumberjack');
    expect(toastSuccessMock).toHaveBeenCalledWith(
      expect.stringContaining('1 mob portrait queued'),
    );
  }, 30_000);

  it('keeps the loud one-toast skip when image generation is disabled, in both lanes', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = await seedModule(campaign.id);
    const mob = await seedMobArtifact(campaign.id, { name: 'Gelatinous Cube' });
    await seedEncounter(campaign.id, module.id, ownerRoster(mob.id));
    await saveSettings({ ...defaultSettings(), imagesEnabled: false });

    // The portrait-only target: with battlemaps in the target too, the map
    // block's own loud skip toast would be the first one (both are correct;
    // this case is about the portrait half).
    await runModulePostGeneration(module.id, campaign, PORTRAIT_ONLY);

    expect(enqueueMobPortraits).not.toHaveBeenCalled();
    expect(enqueueInventedPortraits).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).toHaveBeenCalledWith(
      'Auto mob portrait generation skipped — image generation is disabled in Settings',
    );
  }, 30_000);
});
