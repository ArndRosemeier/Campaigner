/**
 * MERGED same-background cluster (docs/17 row 177, extending row 176's pilot):
 * eight `tests/features` image/portrait-queue files that share ONE background —
 * fake-indexeddb + `clearDatabase()` per test, the IDENTICAL `vi.mock` target
 * set (`@/llm/openrouter`, `@/llm/imageGen`, `@/lib/imageIntake`, `@/lib/toast`)
 * and the same `useMobPortraitQueue` / `useEntityImageQueue` Dexie-mounted
 * pumps — now run in ONE file, so the import/transform/jsdom-environment/setup
 * cost is paid once instead of eight times.
 *
 * Merged from (one `describe` per original file, so each stays findable; test
 * names and every `expect` assertion site is byte-identical):
 *   - tests/features/cover-image-queue.test.ts (11)
 *   - tests/features/post-run-extras.test.ts (12)
 *   - tests/features/invented-creature-portraits.test.ts (10)
 *   - tests/features/entity-image-queue.test.ts (6)
 *   - tests/features/mob-portrait-npc-ref.test.ts (8)
 *   - tests/features/mob-portrait-queue.test.ts (15)
 *   - tests/features/single-mob-portrait-queue.test.ts (12)
 *   - tests/features/mob-portrait-regen.test.ts (17)
 *   = 96 tests (under the ~120 cap).
 *
 * The counts above are RE-MEASURED (docs/17 row 269): the merged total had
 * drifted to 91 before this landing added the five `a CONVERTED copy needs no
 * pack` arms, because per-file counts are prose that nothing checks.
 *
 * `tests/features/entity-panel.test.tsx` shares the same mock set but is
 * deliberately NOT merged: it is the one file in the cluster that relies on the
 * console guard's FILE-SCOPED `ALLOWED_NOISE` entry (`entity-panel.test.` for
 * the deliberate batch-failure records). A merged file loses every original's
 * file-scoped allowance (the guard scopes by `ctx.task.file.name`), and the
 * sweep rule forbids widening the allowance for the merged file because that
 * would silently cover every other describe in it.
 */

import 'fake-indexeddb/auto';
import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { createCampaign, updateCampaign } from '@/db/campaignRepo';
import { createImage, getImage } from '@/db/imageRepo';
import {
  createModule as saveModuleRow,
  getModule,
  createModule as saveModule,
  createModule as createModule__2,
} from '@/db/moduleRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { updateSettings } from '@/db/settingsRepo';
import {
  createModule,
  newId,
  contentCreatureKey,
  createModule as createModuleSchema,
  statBlockSchema,
  ruleChunkSchema,
  stampNewEntity,
  libraryCreatureKey,
  moduleCreationPool,
} from '@/domain';
import type { Id, Campaign, Persona, EncounterArtifactData } from '@/domain';
import {
  attachCover,
  enqueueCampaignCover,
  enqueueModuleCover,
  regenerateCampaignCover,
  regenerateModuleCover,
  useCoverImageQueue,
} from '@/features/covers/cover-image-queue';
import { useProgressStore } from '@/lib/progress';
import { clearDatabase } from '../db/helpers';
import '@/features/campaign/post-run-extras';
import {
  createArtifact,
  getAnyArtifact,
  listArtifactsByCampaign,
  updateArtifact,
} from '@/db/artifactRepo';
import { db } from '@/db/db';
import { createPersona, listPersonas } from '@/db/personaRepo';
import { listRunsByCampaign, getRun } from '@/db/runRepo';
import { runEngine, encounterRunAdapters } from '@/llm/runEngine';
import { bumpStopEpoch } from '@/lib/stopEpoch';
import {
  useMobPortraitQueue,
  enqueueEncounterPortraitFill,
  enqueueInventedCreaturePortraits,
  enqueueMobPortraits,
  planMobPortraitBatch,
  enqueueSingleMobPortrait,
  regenerateSingleMobPortrait,
  regenerateInventedCreaturePortraits,
  regenerateMobPortraits,
} from '@/features/campaign/mob-portrait-queue';
import { presentationArtOfCampaign } from '@/features/campaign/mob-portrait-participants';
import { encountersNeedingMobPortraits } from '@/features/modules/post-generation';
import { restockModuleEncounters } from '@/features/modules/module-restock';
import { useEncounterMapQueue } from '@/features/modules/encounter-map-queue';
import { creatureCoverImageId, creaturePortraitArt, setCreatureCover } from '@/db/creatureRepo';
import { useEntityImageQueue } from '@/features/modules/entity-image-queue';
import { putChunks } from '@/db/chunkRepo';
import { createRulebook } from '@/db/rulebookRepo';
import { sha256Hex } from '@/lib/hash';
import { getMobPortraitCacheEntry, storeCanonicalPortraitIfAbsent } from '@/db/mobPortraitCache';
import { copyCreatureStatsFromDb } from '@/db/libraryCopy';
import { __clearPendingMobPortraitGenerationsForTests } from '@/features/campaign/mob-portrait-cache-queue';

const { chat } = await import('@/llm/openrouter');
const { generateImages } = await import('@/llm/imageGen');
const { intakeImage } = await import('@/lib/imageIntake');
const { toastError } = await import('@/lib/toast');

vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {},
  OpenRouterError: class OpenRouterError extends Error {},
  listModels: vi.fn(),
  fetchWithHeadersTimeout: vi.fn(),
}));

vi.mock('@/llm/imageGen', () => ({ generateImages: vi.fn() }));

vi.mock('@/lib/imageIntake', () => ({ intakeImage: vi.fn() }));

vi.mock('@/lib/toast', () => ({
  toastError: vi.fn(),
  toastErrorPersistent: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
}));

/**
 * Cross-describe mock isolation for the merge: each original owned its own mock
 * instance, so its own teardown sufficed. A merged file shares ONE instance per
 * mocked module (the point of the merge), so a leftover `mockImplementation` or
 * call history from an earlier describe would answer a later test's `...Once`
 * queue overflow and change its call counts. Reset before every test; each
 * describe's own hooks then install what it needs.
 */
beforeEach(() => {
  vi.resetAllMocks();
});

describe('cover-image-queue.test.ts', () => {
  /**
   * Module/campaign cover queue (cover-generation arc): unattended generation
   * for the cover slots — real Dexie rows, LLM/image entry points mocked.
   * The prompt draft is deterministic (buildImagePrompt): the openrouter chat
   * mock must stay silent through every queue path. Regen is
   * delete-after-replace: the old cover survives until the fresh one commits.
   */

  const chatMock = vi.mocked(chat);

  const generateImagesMock = vi.mocked(generateImages);

  const intakeImageMock = vi.mocked(intakeImage);

  const toastErrorMock = vi.mocked(toastError);

  function blobOf(text: string): Blob {
    return new Blob([text], { type: 'image/png' });
  }

  beforeEach(async () => {
    await clearDatabase();
    await seedBuiltInPersonas();
    await updateSettings({ imagesEnabled: true, imageModel: 'test-image-model' });
    chatMock.mockReset();
    generateImagesMock.mockReset();
    intakeImageMock.mockReset();
    toastErrorMock.mockReset();
    useCoverImageQueue.getState().reset();
    useProgressStore.getState().reset();
    generateImagesMock.mockResolvedValue({
      images: [blobOf('gen')],
      costUsd: 0.01,
      cappedToOne: false,
      modelUsed: 'test-image-model',
      fallback: null,
      filteredCount: 0,
    });
    intakeImageMock.mockResolvedValue({
      blob: blobOf('intake'),
      mimeType: 'image/webp',
      width: 320,
      height: 240,
    });
  });

  async function seedModule(campaignId: Id, title = 'Vault of Whispers'): Promise<Id> {
    const module = await saveModuleRow(
      createModule({
        campaignId,
        title,
        concept: 'A whispering vault under the mill.',
        levelMin: 1,
        levelMax: 3,
        sizeDial: 'standard',
      }),
    );
    return module.id;
  }

  describe('cover image queue', () => {
    it('generates a module cover grounded in title/concept, lands the slot, anchors to the campaign', async () => {
      const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
      const moduleId = await seedModule(campaign.id);

      enqueueModuleCover(moduleId, campaign.id, 'Vault of Whispers');

      await waitFor(async () => {
        const module = await getModule(moduleId);
        expect(module?.coverImageId).not.toBeNull();
      });

      expect(generateImagesMock).toHaveBeenCalledTimes(1);
      // n=1: the queue only ever asks for one image.
      expect(generateImagesMock.mock.calls[0]?.[1]).toBe(1);
      expect(chatMock).not.toHaveBeenCalled();
      const prompt = generateImagesMock.mock.calls[0]?.[0] ?? '';
      expect(prompt).toContain('Vault of Whispers');
      expect(prompt).toContain('whispering vault');

      const module = await getModule(moduleId);
      const { getImage } = await import('@/db/imageRepo');
      const stored = await getImage(module?.coverImageId ?? '');
      expect(stored?.campaignId).toBe(campaign.id);
      expect(stored?.source).toBe('generated');
      expect(stored?.model).toBe('test-image-model');
      // The queue drains and the dock job finishes.
      expect(useCoverImageQueue.getState().queued).toHaveLength(0);
      expect(useCoverImageQueue.getState().active).toEqual([]);
      expect(
        useProgressStore.getState().jobs.find((job) => job.id === `module-cover-${moduleId}`),
      ).toBeUndefined();
    });

    it('generates a campaign cover grounded in name/description', async () => {
      const campaign = await createCampaign({
        name: 'Ember',
        description: 'A city of ash and bells.',
        system: 'dnd5e',
      });

      enqueueCampaignCover(campaign.id, campaign.name);

      await waitFor(async () => {
        const { getCampaign } = await import('@/db/campaignRepo');
        expect((await getCampaign(campaign.id))?.coverImageId).not.toBeNull();
      });

      const prompt = generateImagesMock.mock.calls[0]?.[0] ?? '';
      expect(prompt).toContain('Ember');
      expect(prompt).toContain('ash and bells');
      const { getCampaign } = await import('@/db/campaignRepo');
      const updated = await getCampaign(campaign.id);
      const { getImage } = await import('@/db/imageRepo');
      const stored = await getImage(updated?.coverImageId ?? '');
      expect(stored?.campaignId).toBe(campaign.id);
    });

    it('skips imaged slots and dedupes concurrent same-slot jobs', async () => {
      const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
      const moduleId = await seedModule(campaign.id);

      // Two identical jobs in one batch collapse to one generation.
      useCoverImageQueue.getState().enqueue([
        { kind: 'module', campaignId: campaign.id, moduleId, name: 'Vault of Whispers' },
        { kind: 'module', campaignId: campaign.id, moduleId, name: 'Vault of Whispers' },
      ]);

      await waitFor(async () => {
        expect((await getModule(moduleId))?.coverImageId).not.toBeNull();
      });
      expect(generateImagesMock).toHaveBeenCalledTimes(1);

      // A later job against the now-imaged slot skips without generating.
      generateImagesMock.mockClear();
      enqueueModuleCover(moduleId, campaign.id, 'Vault of Whispers');
      await waitFor(() => {
        expect(useCoverImageQueue.getState().queued).toHaveLength(0);
        expect(useCoverImageQueue.getState().active).toEqual([]);
      });
      expect(generateImagesMock).not.toHaveBeenCalled();
      expect(toastErrorMock).not.toHaveBeenCalled();
    });

    it('regen replaces the slot delete-after-replace and prunes the old blob', async () => {
      const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
      const moduleId = await seedModule(campaign.id);
      enqueueModuleCover(moduleId, campaign.id, 'Vault of Whispers');
      await waitFor(async () => {
        expect((await getModule(moduleId))?.coverImageId).not.toBeNull();
      });
      const oldCover = (await getModule(moduleId))?.coverImageId ?? '';
      generateImagesMock.mockClear();
      generateImagesMock.mockResolvedValue({
        images: [blobOf('gen-2')],
        costUsd: 0.01,
        cappedToOne: false,
        modelUsed: 'test-image-model',
        fallback: null,
        filteredCount: 0,
      });

      regenerateModuleCover(moduleId, campaign.id, 'Vault of Whispers');

      await waitFor(async () => {
        expect((await getModule(moduleId))?.coverImageId).not.toBe(oldCover);
      });
      expect(generateImagesMock).toHaveBeenCalledTimes(1);
      const { getImage } = await import('@/db/imageRepo');
      // The superseded blob is freed only after the fresh cover committed.
      expect(await getImage(oldCover)).toBeUndefined();
      expect((await getModule(moduleId))?.coverImageId).not.toBeNull();
    });

    it('a failed regen keeps the old cover and fails loud', async () => {
      const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
      const moduleId = await seedModule(campaign.id);
      enqueueModuleCover(moduleId, campaign.id, 'Vault of Whispers');
      await waitFor(async () => {
        expect((await getModule(moduleId))?.coverImageId).not.toBeNull();
      });
      const oldCover = (await getModule(moduleId))?.coverImageId ?? '';
      generateImagesMock.mockRejectedValueOnce(new Error('model exploded'));

      regenerateModuleCover(moduleId, campaign.id, 'Vault of Whispers');

      await waitFor(() => {
        expect(useCoverImageQueue.getState().failed).toHaveLength(1);
      });
      expect(toastErrorMock).toHaveBeenCalledTimes(1);
      expect(toastErrorMock.mock.calls[0]?.[0]).toMatch(/Vault of Whispers/);
      // The old cover — blob and slot — is intact.
      expect((await getModule(moduleId))?.coverImageId).toBe(oldCover);
      const { getImage } = await import('@/db/imageRepo');
      expect(await getImage(oldCover)).toBeDefined();
    });

    it('fails loud when the slot was deleted while queued', async () => {
      const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
      const moduleId = await seedModule(campaign.id);
      const { deleteModule } = await import('@/db/moduleRepo');
      await deleteModule(moduleId, 'keep');

      enqueueModuleCover(moduleId, campaign.id, 'Vault of Whispers');

      await waitFor(() => {
        expect(useCoverImageQueue.getState().failed).toHaveLength(1);
      });
      expect(generateImagesMock).not.toHaveBeenCalled();
      expect(toastErrorMock).toHaveBeenCalledTimes(1);
    });

    it('refuses empty grounding instead of generating a blank cover', async () => {
      const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
      // No concept, no spine, no parts: nothing to ground the prompt.
      const empty = await saveModuleRow(
        createModule({
          campaignId: campaign.id,
          title: 'Blank',
          concept: '',
          levelMin: 1,
          levelMax: 1,
          sizeDial: 'sketch',
        }),
      );
      enqueueModuleCover(empty.id, campaign.id, 'Blank');
      // A campaign without a description has no grounding either.
      const nodesc = await createCampaign({ name: 'Nodesc', system: 'dnd5e' });
      enqueueCampaignCover(nodesc.id, nodesc.name);

      await waitFor(() => {
        expect(useCoverImageQueue.getState().failed).toHaveLength(2);
      });
      expect(generateImagesMock).not.toHaveBeenCalled();
      expect((await getModule(empty.id))?.coverImageId).toBeNull();
    });

    it('fails loud when image generation is disabled', async () => {
      await updateSettings({ imagesEnabled: false });
      const campaign = await createCampaign({
        name: 'Ember',
        description: 'A city of ash.',
        system: 'dnd5e',
      });
      enqueueCampaignCover(campaign.id, campaign.name);

      await waitFor(() => {
        expect(useCoverImageQueue.getState().failed).toHaveLength(1);
      });
      expect(generateImagesMock).not.toHaveBeenCalled();
      expect(toastErrorMock).toHaveBeenCalledTimes(1);
    });

    it('campaign regen replaces the slot and prunes the old blob', async () => {
      const campaign = await createCampaign({
        name: 'Ember',
        description: 'A city of ash.',
        system: 'dnd5e',
      });
      enqueueCampaignCover(campaign.id, campaign.name);
      const { getCampaign } = await import('@/db/campaignRepo');
      await waitFor(async () => {
        expect((await getCampaign(campaign.id))?.coverImageId).not.toBeNull();
      });
      const oldCover = (await getCampaign(campaign.id))?.coverImageId ?? '';
      generateImagesMock.mockClear();

      regenerateCampaignCover(campaign.id, campaign.name);

      await waitFor(async () => {
        expect((await getCampaign(campaign.id))?.coverImageId).not.toBe(oldCover);
      });
      const { getImage } = await import('@/db/imageRepo');
      expect(await getImage(oldCover)).toBeUndefined();
    });

    it('the writer refuses a missing row loudly (no dangling cover)', async () => {
      const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
      const image = await createImage({
        campaignId: campaign.id,
        blob: blobOf('orphan'),
        mimeType: 'image/png',
        width: 10,
        height: 10,
        prompt: '',
        model: '',
        source: 'uploaded',
      });
      const missingModule = newId();
      await expect(
        attachCover(
          { kind: 'module', campaignId: campaign.id, moduleId: missingModule, name: 'Gone' },
          image,
        ),
      ).rejects.toThrow();
      await expect(
        attachCover({ kind: 'campaign', campaignId: newId(), name: 'Gone' }, image),
      ).rejects.toThrow();
      // The orphaned blob is untouched by the refusal (the next prune owns it).
      const { getImage } = await import('@/db/imageRepo');
      expect(await getImage(image.id)).toBeDefined();
    });

    it('updating a campaign cover through the writer lands the slot', async () => {
      const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
      const image = await createImage({
        campaignId: campaign.id,
        blob: blobOf('cover'),
        mimeType: 'image/png',
        width: 10,
        height: 10,
        prompt: '',
        model: '',
        source: 'uploaded',
      });
      await attachCover({ kind: 'campaign', campaignId: campaign.id, name: campaign.name }, image);
      const { getCampaign } = await import('@/db/campaignRepo');
      expect((await getCampaign(campaign.id))?.coverImageId).toBe(image.id);
      // The repo patch path carries the same loud check.
      await expect(updateCampaign(newId(), { coverImageId: image.id })).rejects.toThrow();
    });
  });
});

describe('post-run-extras.test.ts', () => {
  // Side-effect module under test: registers the run-completion listener.

  /**
   * Ratified: the creation dialog's ticked extras execute AFTER the run
   * completes, in the queue layer — a cover portrait is enqueued (and, with
   * image generation enabled, attached as cover) without reopening or failing
   * the finished run. Unticked extras enqueue nothing.
   */

  const chatMock = vi.mocked(chat);

  const generateImagesMock = vi.mocked(generateImages);

  const intakeImageMock = vi.mocked(intakeImage);

  const VALID_DRAFT = {
    name: 'Grix',
    summary: 'A goblin alchemist boss.',
    suggestedTags: ['goblin'],
    body: '# Grix\nShe brews. She throws.',
    appearance: 'Small, soot-stained, goggles.',
    personality: 'Manic, cheerful, volatile.',
    needsStatBlock: false,
  };

  function blobOf(): Blob {
    return new Blob(['fake-png'], { type: 'image/png' });
  }

  const ENCOUNTER_STATBLOCK = {
    system: 'dnd5e',
    level: '1',
    size: 'Medium',
    creatureType: 'humanoid',
    ac: 12,
    acNote: '',
    hp: 7,
    hpFormula: '2d6',
    speed: '30 ft.',
    abilities: { str: 10, dex: 12, con: 10, int: 10, wis: 10, cha: 10 },
    saves: '',
    skills: '',
    senses: '',
    languages: '',
    traits: [],
    actions: [],
    reactions: [],
    legendary: [],
    extras: {},
  };
  /** A fresh-create Smith encounter draft that classifies itself as a dungeon. */
  const ENCOUNTER_DRAFT = {
    name: 'The Drowned Cellars',
    summary: 'Flooded smuggling cellars.',
    suggestedTags: ['dungeon'],
    body: '# The Drowned Cellars',
    difficulty: 'deadly',
    levelHint: '5',
    monsters: [{ name: 'Kuo-toa', count: 3, notes: 'ambushers', statBlock: ENCOUNTER_STATBLOCK }],
    terrain: 'flooded cellars',
    tactics: 'drag intruders under',
    treasure: 'none',
    locationKind: 'dungeon',
  };
  /** The Cartographer brief the mocked chat returns when a map job runs: a
   * fresh 4-room stocking (first generation briefs fresh — one fight per
   * room, every entry source-cited). Sized to fit any drawn fill grade at
   * levelHint 5 (2 creature-levels per room against a ≥2.1 minimum share). */
  const CARTOGRAPHER_BRIEF = {
    // Minimum-content contract: summary/body carry substance.
    name: 'Ignored regeneration name',
    summary: 'Kuo-toa in flooded cellars.',
    body: '# The Drowned Cellars\nRoom prose.',
    difficulty: 'deadly',
    levelHint: '5',
    terrain: 'flooded cellars',
    tactics: '',
    treasure: '',
    theme: 'drowned cellars',
    styleNotes: '',
    negative: '',
    monsters: [
      { name: 'Kuo-toa', count: 2, notes: '', treasure: '', statBlock: ENCOUNTER_STATBLOCK },
      { name: 'Kuo-toa', count: 2, notes: '', treasure: '', statBlock: ENCOUNTER_STATBLOCK },
      { name: 'Kuo-toa', count: 2, notes: '', treasure: '', statBlock: ENCOUNTER_STATBLOCK },
      { name: 'Kuo-toa', count: 2, notes: '', treasure: '', statBlock: ENCOUNTER_STATBLOCK },
    ],
    rooms: [
      {
        name: 'Entry',
        description: '',
        size: 'medium',
        monsterIndexes: [0],
        adjacentRoomIndexes: [1],
        targetLevel: 5,
      },
      {
        name: 'Flooded Hall',
        description: '',
        size: 'medium',
        monsterIndexes: [1],
        adjacentRoomIndexes: [0, 2],
        targetLevel: 5,
      },
      {
        name: 'Sunken Chapel',
        description: '',
        size: 'medium',
        monsterIndexes: [2],
        adjacentRoomIndexes: [1, 3],
        targetLevel: 5,
      },
      {
        name: 'Drowned Vault',
        description: '',
        size: 'medium',
        monsterIndexes: [3],
        adjacentRoomIndexes: [2],
        targetLevel: 5,
      },
    ],
    entryRoomIndex: 0,
  };

  beforeEach(async () => {
    await clearDatabase();
    chatMock.mockReset();
    generateImagesMock.mockReset();
    intakeImageMock.mockReset();
    useMobPortraitQueue.getState().reset();
    useEncounterMapQueue.getState().reset();
    await updateSettings({ imagesEnabled: true });
    // Green-path map runs: the unattended Cartographer's image step runs on
    // adapters, spied exactly like tests/features/encounter-map-queue.
    vi.spyOn(encounterRunAdapters, 'renderSchematic').mockReturnValue({
      dataUrl: 'data:image/png;base64,schematic',
      width: 240,
      height: 180,
    });
    vi.spyOn(encounterRunAdapters, 'generateImages').mockResolvedValue({
      images: [blobOf()],
      costUsd: null,
      cappedToOne: false,
      modelUsed: 'test-image-model',
      fallback: null,
      filteredCount: 0,
    });
    vi.spyOn(encounterRunAdapters, 'normalizeImageAspect').mockImplementation((blob) =>
      Promise.resolve({ blob, width: 800, height: 600, action: 'none' }),
    );
    vi.spyOn(encounterRunAdapters, 'intakeImage').mockImplementation((blob) =>
      Promise.resolve({ blob, width: 800, height: 600, mimeType: 'image/webp' }),
    );
  });

  /**
   * TEARDOWN WAITS: settles the unattended queues the tests below start, and
   * pins that no run is left `running` when the test ends.
   *
   * Every test here drives the REAL orchestration — `runEngine.startRun`'s
   * pipeline is FIRE-AND-FORGET (it resolves once the row is written), and a
   * fresh encounter additionally hands the encounter-map queue an unattended
   * Cartographer run through the `post-run-extras` completion listener. A test
   * that returns while such a run is still `running` leaves a live pipeline
   * mid-write, and the NEXT test's `clearDatabase()` deletes the row it is
   * writing: its next `updateRun` hits runRepo's row-must-exist guard, nothing
   * awaits it, and the engine's own failure chain
   * (`void executeFrom(...).catch((error) => void this.fail(...))`) rejects
   * with that NotFoundError — vitest reports `Errors 1 error` and the run exits
   * 1 with every test green (docs/08-TESTING.md §the pending-continuation
   * flake; ledger 97). Measured with the cause delayed (250ms on that test's
   * chat replies): RED without this helper — `Errors 1 error`, exit 1, all 12
   * tests green — and green with it under the same delay.
   *
   * The wait rides the queues' own state — the same seam the app's unattended
   * callers use (`waitForRunStatus`) and the mid-test settle calls below: a
   * drained queue means its run reached a terminal status, so nothing is left
   * to write. The `running` census is the pin: a row still running at the end
   * of a test is exactly the state that turned a green gate red.
   */
  async function settleStartedQueues(): Promise<void> {
    await waitFor(
      () => {
        expect(useEncounterMapQueue.getState().queued).toEqual([]);
        expect(useEncounterMapQueue.getState().active).toEqual([]);
        expect(useMobPortraitQueue.getState().queued).toEqual([]);
        expect(useMobPortraitQueue.getState().active).toEqual([]);
      },
      { timeout: 15000 },
    );
    const running = await db.runs.where('status').equals('running').toArray();
    expect(running.map((run) => run.id)).toEqual([]);
  }

  afterEach(async () => {
    await settleStartedQueues();
    useEncounterMapQueue.getState().reset();
    vi.restoreAllMocks();
  });

  async function seed(): Promise<{ campaignId: string; personaId: string }> {
    await seedBuiltInPersonas();
    const campaign = await createCampaign({ name: 'Test Campaign', system: 'dnd5e' });
    const persona = await createPersona({
      slug: 'npc-smith-extras-test',
      name: 'NPC Smith',
      description: 'test',
      systemPrompt: 'You are a test persona. Reply with JSON only.',
      producesKind: 'npc',
      builtIn: true,
    });
    return { campaignId: campaign.id, personaId: persona.id };
  }

  const RUN_INPUT = (campaignId: string, personaId: string) => ({
    campaign: {
      id: campaignId,
      name: 'Test Campaign',
      system: 'dnd5e' as const,
      description: '',
      coverImageId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    persona: {
      id: personaId,
      slug: 'npc-smith-extras-test',
      name: 'NPC Smith',
      description: 'test',
      systemPrompt: 'You are a test persona. Reply with JSON only.',
      model: '',
      reasoningEffort: 'default' as const,
      temperature: 0.8,
      producesKind: 'npc' as const,
      mode: 'generate' as const,
      builtIn: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    autonomy: 'auto' as const,
    brief: 'a goblin alchemist boss',
    pinnedChunkIds: [],
  });

  describe('post-run extras', () => {
    it('the image extra attaches a cover portrait after the run completes', async () => {
      const { campaignId, personaId } = await seed();
      // The image extra's portrait draft is deterministic (the artifact has an
      // appearance — the shortcut wins) and never calls chat.
      chatMock.mockResolvedValueOnce({
        text: JSON.stringify(VALID_DRAFT),
        modelUsed: 'test-model',
        fallback: null,
      });
      generateImagesMock.mockResolvedValue({
        images: [blobOf()],
        modelUsed: 'image-model',
        costUsd: null,
        cappedToOne: false,
        fallback: null,
        filteredCount: 0,
      });
      intakeImageMock.mockResolvedValue({
        blob: blobOf(),
        mimeType: 'image/png',
        width: 64,
        height: 64,
      });

      const runId = await runEngine.startRun({
        ...RUN_INPUT(campaignId, personaId),
        extras: { image: true, statBlock: false, mobPortraits: false, battlemap: false },
      });
      await waitFor(async () => {
        const run = await getRun(runId);
        expect(run?.status).toBe('completed');
      });
      const run = await getRun(runId);
      await waitFor(async () => {
        const artifact = await getAnyArtifact(run?.resultArtifactId ?? '');
        expect(artifact?.coverImageId).not.toBeNull();
      });
      // The completed run was not reopened by the extras execution.
      expect((await getRun(runId))?.status).toBe('completed');
    }, 20000);

    it('enqueues nothing for a run that completed after a stop (the epoch gate)', async () => {
      // Owner report: "Stop all should stop all generations, but it only stops
      // the current type loop". A run already finishing when the sweep
      // snapshotted the engine registry still lands here as 'completed' — its
      // automatic battlemap and portraits must NOT be enqueued after the user
      // pressed Stop all (a queue's cancelAll exits its pump, but any later
      // enqueue starts a fresh one). The run row itself stays completed.
      const { campaignId, personaId } = await seed();
      // Chat stays pending so the run is still in flight when the stop lands.
      let _releaseChat: (() => void) | undefined;
      chatMock.mockImplementation(
        () =>
          new Promise((resolve) => {
            _releaseChat = () => {
              resolve({
                text: JSON.stringify(VALID_DRAFT),
                modelUsed: 'test-model',
                fallback: null,
              });
            };
          }),
      );

      const runId = await runEngine.startRun({
        ...RUN_INPUT(campaignId, personaId),
        extras: { image: true, statBlock: false, mobPortraits: false, battlemap: false },
      });
      await waitFor(() => {
        expect(chatMock).toHaveBeenCalled();
      });
      // The user stops while the run is finishing…
      bumpStopEpoch();
      // …then the run completes normally.
      await waitFor(() => {
        expect(_releaseChat).toBeDefined();
      });
      _releaseChat?.();
      await waitFor(async () => {
        expect((await getRun(runId))?.status).toBe('completed');
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Nothing was handed to the queues after the stop.
      expect(useMobPortraitQueue.getState().queued).toEqual([]);
      expect(useMobPortraitQueue.getState().active).toEqual([]);
      expect(useEncounterMapQueue.getState().queued).toEqual([]);
      expect(useEncounterMapQueue.getState().active).toEqual([]);
      // The finished run is untouched — a stop is not a run failure.
      expect((await getRun(runId))?.status).toBe('completed');
    }, 20000);

    it('unticked extras enqueue nothing', async () => {
      const { campaignId, personaId } = await seed();
      chatMock.mockResolvedValue({
        text: JSON.stringify(VALID_DRAFT),
        modelUsed: 'test-model',
        fallback: null,
      });

      const runId = await runEngine.startRun({
        ...RUN_INPUT(campaignId, personaId),
        extras: { image: false, statBlock: false, mobPortraits: false, battlemap: false },
      });
      await waitFor(async () => {
        const run = await getRun(runId);
        expect(run?.status).toBe('completed');
      });
      await new Promise((resolve) => {
        setTimeout(resolve, 150);
      });
      expect(useMobPortraitQueue.getState().queued).toHaveLength(0);
      expect(useMobPortraitQueue.getState().active).toHaveLength(0);
    }, 20000);

    it('a statblock-extra run whose statblock step is skipped persists the loud finalize notice', async () => {
      const { campaignId, personaId } = await seed();
      // VALID_DRAFT sets needsStatBlock: false → the statblock step is
      // skipped and data.statBlock stays null. The extra is verification-only:
      // the finalize step must carry the visible notice, never fabricate one.
      chatMock.mockResolvedValue({
        text: JSON.stringify(VALID_DRAFT),
        modelUsed: 'test-model',
        fallback: null,
      });

      const runId = await runEngine.startRun({
        ...RUN_INPUT(campaignId, personaId),
        extras: { image: false, statBlock: true, mobPortraits: false, battlemap: false },
      });
      await waitFor(async () => {
        const run = await getRun(runId);
        expect(run?.status).toBe('completed');
      });
      const run = await getRun(runId);
      const finalize = run?.steps.find((step) => step.name === 'finalize');
      expect((finalize?.output as { notice?: string } | null)?.notice).toBe(
        'No stat block was generated — add one in the artifact editor.',
      );
    }, 20000);

    /**
     * The `mobPortraits` extra runs BOTH portrait lanes (docs/17 row 90). A
     * fresh Smith encounter whose monsters were materialized from inline stat
     * blocks has no `rulebook` entries at all — the rulebook lane alone enqueued
     * nothing, so the ticked extra silently produced no portraits for exactly the
     * monsters the encounter had just created.
     *
     * Revert-proof: drop the `enqueueInventedCreaturePortraits` call from
     * `runPostCreateExtras` and this test fails — the queue is empty while the
     * encounter's roster holds an `npc-ref` monster.
     */
    it("the mobPortraits extra illustrates a fresh encounter's materialized monsters", async () => {
      await seedBuiltInPersonas();
      const campaign = await createCampaign({ name: 'Cellars', system: 'dnd5e' });
      const smith = await createPersona({
        slug: 'encounter-smith-portraits-test',
        name: 'Encounter Smith',
        description: 'test',
        systemPrompt: 'You are a test persona. Reply with JSON only.',
        producesKind: 'encounter',
        mode: 'generate',
        builtIn: true,
      });
      chatMock.mockResolvedValue({
        text: JSON.stringify(ENCOUNTER_DRAFT),
        modelUsed: 'test-model',
        fallback: null,
      });

      // RUN_INPUT carries the NPC-shaped persona object; this run needs the
      // encounter persona's own shape (mode/producesKind drive the step plan).
      const runId = await runEngine.startRun({
        ...RUN_INPUT(campaign.id, smith.id),
        persona: { ...smith, producesKind: 'encounter', mode: 'generate' },
        extras: { image: false, statBlock: false, mobPortraits: true, battlemap: false },
      });
      await waitFor(async () => {
        expect((await getRun(runId))?.status).toBe('completed');
      });

      // The fresh roster's monster is a materialized npc-ref artifact…
      const run = await getRun(runId);
      const encounter = await getAnyArtifact(run?.resultArtifactId ?? '');
      if (encounter?.kind !== 'encounter') throw new Error('no encounter artifact');
      expect(encounter.data.monsters[0]?.source.type).toBe('npc-ref');

      // …and the portraits extra illustrates it through the invented lane (the
      // lane the pre-fix extra never reached). The queue drains fast under the
      // image mock, so the pin is the outcome: the monster's cover lands, and the
      // prompt was built from the artifact's OWN content (a local, chunk-less
      // job) — never from a bestiary chunk.
      const entry = encounter.data.monsters[0];
      if (entry?.source.type !== 'npc-ref') throw new Error('no npc-ref entry');
      const monsterArtifactId: string = entry.source.artifactId;
      await waitFor(
        async () => {
          expect((await getAnyArtifact(monsterArtifactId))?.coverImageId).not.toBeNull();
        },
        { timeout: 15000 },
      );
      expect(generateImagesMock).toHaveBeenCalled();
      expect(generateImagesMock.mock.calls[0]?.[1]).toBe(1);
      // The invented portrait stays off the shared cache (firewall).
      expect(await db.mobPortraits.count()).toBe(0);
    }, 20000);

    it('a completed npc run without the statblock extra attaches no notice', async () => {
      const { campaignId, personaId } = await seed();
      chatMock
        .mockResolvedValueOnce({
          text: JSON.stringify(VALID_DRAFT),
          modelUsed: 'test-model',
          fallback: null,
        })
        .mockResolvedValueOnce({
          text: JSON.stringify({
            system: 'dnd5e',
            level: '3',
            size: 'Small',
            creatureType: 'humanoid (goblinoid)',
            ac: 14,
            acNote: '',
            hp: 22,
            hpFormula: '5d6',
            speed: '30 ft.',
            abilities: { str: 8, dex: 16, con: 13, int: 14, wis: 10, cha: 12 },
            saves: '',
            skills: '',
            senses: '',
            languages: 'Common, Goblin',
            traits: [],
            actions: [],
            reactions: [],
            legendary: [],
            extras: {},
          }),
          modelUsed: 'test-model',
          fallback: null,
        });

      const runId = await runEngine.startRun(RUN_INPUT(campaignId, personaId));
      await waitFor(async () => {
        const run = await getRun(runId);
        expect(run?.status).toBe('completed');
      });
      const run = await getRun(runId);
      const finalize = run?.steps.find((step) => step.name === 'finalize');
      expect((finalize?.output as { notice?: string } | null)?.notice ?? '').toBe('');
    }, 20000);
  });

  describe('automatic battlemaps for automated encounter creation (owner request)', () => {
    /** Seeds the built-ins plus a content-only Encounter Smith and a Cartographer. */
    async function seedEncounterPersonas(): Promise<{
      campaign: Campaign;
      smith: Persona;
      cartographer: Persona;
    }> {
      await seedBuiltInPersonas();
      const campaign = await createCampaign({ name: 'Cellars', system: 'dnd5e' });
      const smith = await createPersona({
        slug: 'encounter-smith-auto-test',
        name: 'Encounter Smith',
        description: 'test',
        systemPrompt: 'You are a test persona. Reply with JSON only.',
        producesKind: 'encounter',
        mode: 'generate',
        builtIn: true,
      });
      const cartographer = await createPersona({
        slug: 'encounter-cartographer-auto-test',
        name: 'Encounter Cartographer',
        description: 'test',
        systemPrompt: 'You are a test persona. Reply with JSON only.',
        producesKind: 'encounter',
        mode: 'encounter',
        builtIn: true,
      });
      return { campaign, smith, cartographer };
    }

    it('a fresh module-owned Smith encounter is auto-enqueued on the module queue and mapped with resolved defaults', async () => {
      const { campaign, smith } = await seedEncounterPersonas();
      const module = await saveModule(
        createModule({
          campaignId: campaign.id,
          title: 'Ruins',
          concept: '',
          levelMin: 1,
          levelMax: 3,
          sizeDial: 'sketch',
          // The dialog passes the master switch explicitly (default ON there).
          autoGenerateBattlemaps: true,
        }),
      );
      chatMock
        .mockResolvedValue({
          text: JSON.stringify(ENCOUNTER_DRAFT),
          modelUsed: 'test-model',
          fallback: null,
        })
        .mockResolvedValueOnce({
          text: JSON.stringify(ENCOUNTER_DRAFT),
          modelUsed: 'test-model',
          fallback: null,
        })
        .mockResolvedValueOnce({
          text: JSON.stringify(CARTOGRAPHER_BRIEF),
          modelUsed: 'test-model',
          fallback: null,
        });

      const runId = await runEngine.startRun({
        campaign,
        persona: smith,
        autonomy: 'auto',
        brief: 'a flooded cellar ambush',
        pinnedChunkIds: [],
        placementModuleId: module.id,
      });
      await waitFor(async () => {
        expect((await getRun(runId))?.status).toBe('completed');
      });
      const run = await getRun(runId);
      const artifact = await getAnyArtifact(run?.resultArtifactId ?? '');
      if (artifact?.kind !== 'encounter') throw new Error('encounter missing');
      expect(artifact.moduleId).toBe(module.id);

      // The unattended Cartographer ran on the encounter and mapped it.
      await settleStartedQueues();
      const mapped = await getAnyArtifact(artifact.id);
      if (mapped?.kind !== 'encounter') throw new Error('encounter missing');
      expect(mapped.data.layout).not.toBeNull();
      expect(mapped.data.mapImageId).not.toBeNull();
      // First generation stocks the dungeon: a multi-room layout with a
      // fresh roster (one fight per room), not the Smith stub's one fight.
      expect(mapped.data.layout?.rooms).toHaveLength(4);
      expect(mapped.data.monsters).toHaveLength(4);
      // The queue's run carried the encounter's own moduleId.
      const runs = await listRunsByCampaign(campaign.id);
      const mapRun = runs.find(
        (entry) => entry.targetArtifactId === artifact.id && entry.personaId !== smith.id,
      );
      expect(mapRun?.status).toBe('completed');
      // Defaults resolved through the D10 chain: the draft's dungeon kind put
      // the map on the dungeon tier (48x36 for the 4:3 aspect default).
      expect(mapRun?.encounterPreset).toBe('dungeon');
      expect(mapped.data.layout?.gridW).toBe(48);
      // The Smith run itself was never reopened by the extras execution.
      expect((await getRun(runId))?.status).toBe('completed');
    }, 30000);

    it('a campaign-level encounter auto-enqueues a campaign-level (moduleId null) job', async () => {
      const { campaign, smith } = await seedEncounterPersonas();
      chatMock
        .mockResolvedValueOnce({
          text: JSON.stringify(ENCOUNTER_DRAFT),
          modelUsed: 'test-model',
          fallback: null,
        })
        .mockResolvedValueOnce({
          text: JSON.stringify(CARTOGRAPHER_BRIEF),
          modelUsed: 'test-model',
          fallback: null,
        });

      const runId = await runEngine.startRun({
        campaign,
        persona: smith,
        autonomy: 'auto',
        brief: 'a flooded cellar ambush',
        pinnedChunkIds: [],
      });
      await waitFor(async () => {
        expect((await getRun(runId))?.status).toBe('completed');
      });
      const run = await getRun(runId);
      const artifact = await getAnyArtifact(run?.resultArtifactId ?? '');
      expect(artifact?.moduleId ?? null).toBeNull();

      await settleStartedQueues();
      const runs = await listRunsByCampaign(campaign.id);
      const mapRun = runs.find(
        (entry) => entry.targetArtifactId === artifact?.id && entry.personaId !== smith.id,
      );
      // The map run exists and the JOB was campaign-level (moduleId null —
      // pinned via the run's campaign-level artifact and the queue's empty
      // module dock state after settle).
      expect(mapRun?.status).toBe('completed');
      expect(useEncounterMapQueue.getState().failed).toEqual([]);
    }, 30000);

    it('a targeted content regeneration never auto-enqueues a map', async () => {
      const { campaign, smith } = await seedEncounterPersonas();
      const stub = await createArtifact({
        campaignId: campaign.id,
        kind: 'encounter',
        name: 'Ford Ambush',
        data: {
          difficulty: '',
          levelHint: '',
          monsters: [],
          terrain: '',
          tactics: '',
          treasure: '',
          mapImageId: null,
          layout: null,
          preset: 'standard',
          locationKind: 'other',
          siteShape: 'single',
          budgetAdvisory: '',
        },
      });
      chatMock.mockResolvedValue({
        text: JSON.stringify(ENCOUNTER_DRAFT),
        modelUsed: 'test-model',
        fallback: null,
      });

      const runId = await runEngine.startRun({
        campaign,
        persona: smith,
        autonomy: 'auto',
        brief: 'refill the stub',
        pinnedChunkIds: [],
        targetArtifactId: stub.id,
      });
      await waitFor(async () => {
        expect((await getRun(runId))?.status).toBe('completed');
      });
      await new Promise((resolve) => {
        setTimeout(resolve, 150);
      });
      expect(useEncounterMapQueue.getState().queued).toEqual([]);
      expect(useEncounterMapQueue.getState().active).toEqual([]);
      expect(useEncounterMapQueue.getState().failed).toEqual([]);
      // Regenerating an existing map stays an EXPLICIT user action.
    }, 30000);

    it('the module master switch off keeps the encounter maps manual', async () => {
      const { campaign, smith } = await seedEncounterPersonas();
      const module = await saveModule({
        ...createModule({
          campaignId: campaign.id,
          title: 'Quiet',
          concept: '',
          levelMin: 1,
          levelMax: 3,
          sizeDial: 'sketch',
        }),
        autoGenerateBattlemaps: false,
      });
      chatMock.mockResolvedValue({
        text: JSON.stringify(ENCOUNTER_DRAFT),
        modelUsed: 'test-model',
        fallback: null,
      });

      const runId = await runEngine.startRun({
        campaign,
        persona: smith,
        autonomy: 'auto',
        brief: 'a flooded cellar ambush',
        pinnedChunkIds: [],
        placementModuleId: module.id,
      });
      await waitFor(async () => {
        expect((await getRun(runId))?.status).toBe('completed');
      });
      await new Promise((resolve) => {
        setTimeout(resolve, 150);
      });
      expect(useEncounterMapQueue.getState().queued).toEqual([]);
      expect(useEncounterMapQueue.getState().active).toEqual([]);
      expect(useEncounterMapQueue.getState().failed).toEqual([]);
    }, 30000);

    it('a Cartographer run never auto-enqueues (it maps its own encounter in-run)', async () => {
      const { campaign, cartographer } = await seedEncounterPersonas();
      chatMock.mockResolvedValue({
        text: JSON.stringify(CARTOGRAPHER_BRIEF),
        modelUsed: 'test-model',
        fallback: null,
      });

      const runId = await runEngine.startRun({
        campaign,
        persona: cartographer,
        autonomy: 'auto',
        brief: 'a flooded cellar ambush',
        pinnedChunkIds: [],
        encounterMapAspect: '4:3',
      });
      await waitFor(async () => {
        expect((await getRun(runId))?.status).toBe('completed');
      });
      await new Promise((resolve) => {
        setTimeout(resolve, 150);
      });
      expect(useEncounterMapQueue.getState().queued).toEqual([]);
      expect(useEncounterMapQueue.getState().active).toEqual([]);
      expect(useEncounterMapQueue.getState().failed).toEqual([]);
    }, 30000);

    it('a failed map job toasts loudly per artifact and never fails the completed run', async () => {
      const { campaign, smith } = await seedEncounterPersonas();
      const module = await saveModule(
        createModule({
          campaignId: campaign.id,
          title: 'Ruins',
          concept: '',
          levelMin: 1,
          levelMax: 3,
          sizeDial: 'sketch',
          // The dialog passes the master switch explicitly (default ON there).
          autoGenerateBattlemaps: true,
        }),
      );
      chatMock
        .mockResolvedValueOnce({
          text: JSON.stringify(ENCOUNTER_DRAFT),
          modelUsed: 'test-model',
          fallback: null,
        })
        .mockResolvedValueOnce({
          text: JSON.stringify(CARTOGRAPHER_BRIEF),
          modelUsed: 'test-model',
          fallback: null,
        });
      // The stylize step collapses — the map run fails, the queue reports it.
      vi.spyOn(encounterRunAdapters, 'generateImages').mockRejectedValue(new Error('image drift'));

      const runId = await runEngine.startRun({
        campaign,
        persona: smith,
        autonomy: 'auto',
        brief: 'a flooded cellar ambush',
        pinnedChunkIds: [],
        placementModuleId: module.id,
      });
      await waitFor(async () => {
        expect((await getRun(runId))?.status).toBe('completed');
      });
      const run = await getRun(runId);
      const artifact = await getAnyArtifact(run?.resultArtifactId ?? '');
      await waitFor(
        () => {
          expect(useEncounterMapQueue.getState().failed.map((job) => job.artifactId)).toEqual([
            artifact?.id,
          ]);
        },
        { timeout: 15000 },
      );
      const { toastError } = await import('@/lib/toast');
      expect(toastError).toHaveBeenCalledWith(
        expect.stringContaining('Drowned Cellars'),
        expect.any(Error),
      );
      // The queue contract holds: the completed Smith run was never reopened.
      expect((await getRun(runId))?.status).toBe('completed');
    }, 30000);
  });

  describe('automatic roster portraits for a restocked encounter (row 196)', () => {
    /**
     * The owner's report, verbatim: *"There is still a small problem that
     * encounters can have mobs without images even when \"generate mob
     * encounter images\" is selected in the module creator. When selecting the
     * image generation button inside the encounter, those images get created
     * successfully."*
     *
     * The mechanism: the module sweep illustrated the Encounter Smith's STUB
     * roster, then the unattended Cartographer restock (auto-enqueued by this
     * very module) REPLACED it, and nothing re-enqueued the creatures that only
     * exist after the restock. The fix is the run-completion trigger in
     * `post-run-extras`: a completed run whose result artifact is an encounter
     * that carried a `targetArtifactId` re-reads the row and runs both lanes
     * over it. These tests drive the REAL flow (Smith run -> automatic
     * battlemap -> Cartographer restock) and never call the sweep, so the only
     * thing that can illustrate the fresh roster is the trigger.
     */

    const blob = (): Blob => new Blob(['fake-png'], { type: 'image/png' });

    /**
     * The shared `CARTOGRAPHER_BRIEF` with GROUNDED monsters. The restocked
     * creatures are inline-statblock entries, so they materialize into authored
     * `npc` artifacts whose `summary` IS the roster `notes` — and the portrait
     * prompt refuses to illustrate an artifact with no appearance, summary or
     * body. A non-empty `notes` is therefore what makes the fresh roster a
     * legitimate portrait target, exactly like a real stocked dungeon's prose
     * (`materializeMonsterNpc` writes `summary: notes`).
     */
    const RESTOCK_BRIEF = {
      ...CARTOGRAPHER_BRIEF,
      monsters: CARTOGRAPHER_BRIEF.monsters.map((monster) => ({
        ...monster,
        notes: 'a bog-drowned ambusher trailing weed and a barbed spear',
      })),
    };

    function armPortraitGeneration(): void {
      generateImagesMock.mockResolvedValue({
        images: [blob()],
        costUsd: null,
        cappedToOne: false,
        modelUsed: 'test-image-model',
        fallback: null,
        filteredCount: 0,
      });
      intakeImageMock.mockResolvedValue({
        blob: blob(),
        mimeType: 'image/webp',
        width: 320,
        height: 240,
      });
    }

    async function createRestockedEncounter(options?: {
      autoGenerateMobImages?: boolean;
    }): Promise<{
      campaign: Campaign;
      moduleId: Id;
      artifactId: Id;
    }> {
      await seedBuiltInPersonas();
      const campaign = await createCampaign({ name: 'Cellars', system: 'dnd5e' });
      const smith = (await listPersonas()).find((persona) => persona.slug === 'encounter-smith');
      if (smith === undefined) throw new Error('the built-in Encounter Smith is missing');
      const module = await saveModule(
        createModule({
          campaignId: campaign.id,
          title: 'Ruins',
          concept: '',
          levelMin: 1,
          levelMax: 3,
          sizeDial: 'sketch',
          autoGenerateBattlemaps: true,
          autoGenerateMobImages: options?.autoGenerateMobImages ?? true,
        }),
      );
      // Same proven reply sequence as the automatic-battlemap tests above: the
      // Smith draft, then the Cartographer's 4-room fresh stocking.
      chatMock
        .mockResolvedValue({
          text: JSON.stringify(ENCOUNTER_DRAFT),
          modelUsed: 'test-model',
          fallback: null,
        })
        .mockResolvedValueOnce({
          text: JSON.stringify(ENCOUNTER_DRAFT),
          modelUsed: 'test-model',
          fallback: null,
        })
        .mockResolvedValueOnce({
          text: JSON.stringify(RESTOCK_BRIEF),
          modelUsed: 'test-model',
          fallback: null,
        });
      const runId = await runEngine.startRun({
        campaign,
        persona: smith,
        autonomy: 'auto',
        brief: 'a flooded cellar ambush',
        pinnedChunkIds: [],
        placementModuleId: module.id,
      });
      await waitFor(async () => {
        expect((await getRun(runId))?.status).toBe('completed');
      });
      const run = await getRun(runId);
      const artifact = await getAnyArtifact(run?.resultArtifactId ?? '');
      if (artifact?.kind !== 'encounter') throw new Error('encounter missing');
      return { campaign, moduleId: module.id, artifactId: artifact.id };
    }

    /** The restock landed: the Smith stub's single fight is replaced by the
     * Cartographer's 4-room, 4-entry population (the shape the existing
     * automatic-battlemap pin already asserts at `:1032-1041`). */
    async function waitForRestock(artifactId: Id): Promise<void> {
      await waitFor(
        async () => {
          const mapped = await getAnyArtifact(artifactId);
          if (mapped?.kind !== 'encounter') throw new Error('encounter missing');
          expect(mapped.data.layout?.rooms).toHaveLength(4);
          expect(mapped.data.monsters).toHaveLength(4);
        },
        { timeout: 15000 },
      );
    }

    it('P1 — the FINAL restocked roster is illustrated by the completion trigger (revert-proof)', async () => {
      armPortraitGeneration();
      const { campaign, artifactId } = await createRestockedEncounter();
      await waitForRestock(artifactId);

      // The trigger re-reads the row the restock just wrote and fills it
      // through the shared enumeration. REVERT-PROOF: delete the automatic
      // branch from `runPostCreateExtras` and nothing in this test enqueues a
      // portrait (the sweep never runs here), so this wait never converges —
      // RED. Before the fix the ONLY portraits in this flow belonged to the
      // stub roster, which no longer matches the final one.
      await waitFor(
        async () => {
          const mapped = await getAnyArtifact(artifactId);
          if (mapped?.kind !== 'encounter') throw new Error('encounter missing');
          const plan = await planMobPortraitBatch(mapped, campaign.id);
          expect(plan.missing).toEqual([]);
          expect(plan.imaged.length).toBeGreaterThan(0);
        },
        { timeout: 15000 },
      );

      const mapped = await getAnyArtifact(artifactId);
      if (mapped?.kind !== 'encounter') throw new Error('encounter missing');
      const plan = await planMobPortraitBatch(mapped, campaign.id);
      // Every distinct creature kind the restock landed carries art.
      expect(plan.missing).toEqual([]);
      expect(plan.imaged.length).toBeGreaterThan(0);
      // The completed runs were never reopened by the extras execution.
      expect((await listRunsByCampaign(campaign.id)).every((entry) => entry.status !== 'running')).toBe(
        true,
      );
    }, 40000);

    it('P2 DIFFERENTIAL — the module trigger and the editor plan agree over the same post-restock state', async () => {
      // Block the portrait lane's image call so NOTHING has committed art yet
      // while both arms are read: the module arm is the trigger's actual
      // enqueue set, the editor arm is `planMobPortraitBatch` (the read-only
      // half of the editor's own enumeration) over the identical DB state.
      type GenResult = Awaited<ReturnType<typeof generateImages>>;
      const genResult: GenResult = {
        images: [blob()],
        costUsd: null,
        cappedToOne: false,
        modelUsed: 'test-image-model',
        fallback: null,
        filteredCount: 0,
      };
      let releaseImages: ((value: GenResult) => void) | undefined;
      const gate = new Promise<GenResult>((resolve) => {
        releaseImages = resolve;
      });
      // The run engine and the portrait lane share ONE `generateImages`
      // function (`encounterRunAdapters.generateImages` IS this mock), so the
      // gate must block ONLY the portrait call: the map run's own stylize call
      // carries a battlemap prompt and resolves immediately, while every
      // creature-portrait call parks on `gate` — leaving the restock landed
      // and no portrait committed.
      generateImagesMock.mockImplementation((prompt: string) =>
        prompt.includes('battlemap') ? Promise.resolve(genResult) : gate,
      );
      intakeImageMock.mockResolvedValue({
        blob: blob(),
        mimeType: 'image/webp',
        width: 320,
        height: 240,
      });

      const { campaign, artifactId } = await createRestockedEncounter();
      await waitForRestock(artifactId);
      // The map queue drains (the restock is on the row)…
      await waitFor(
        () => {
          expect(useEncounterMapQueue.getState().queued).toEqual([]);
          expect(useEncounterMapQueue.getState().active).toEqual([]);
        },
        { timeout: 15000 },
      );
      // …and the trigger's jobs sit BLOCKED on the image call, so no art has
      // committed and the two arms are read over the same state.
      await waitFor(
        () => {
          const jobs = [
            ...useMobPortraitQueue.getState().queued,
            ...useMobPortraitQueue.getState().active,
          ].filter((job) => job.encounterId === artifactId);
          expect(jobs.length).toBeGreaterThan(0);
        },
        { timeout: 15000 },
      );

      try {
        const mapped = await getAnyArtifact(artifactId);
        if (mapped?.kind !== 'encounter') throw new Error('encounter missing');
        const triggerJobs = [
          ...useMobPortraitQueue.getState().queued,
          ...useMobPortraitQueue.getState().active,
        ].filter((job) => job.encounterId === artifactId);
        const moduleArm = [...new Set(triggerJobs.map((job) => job.name))].sort();
        const editorArm = (await planMobPortraitBatch(mapped, campaign.id)).missing.slice().sort();
        // Two non-empty arms that DO differ from the empty set — a differential,
        // never a VOID probe.
        expect(moduleArm.length).toBeGreaterThan(0);
        expect(editorArm.length).toBeGreaterThan(0);
        expect(moduleArm).toEqual(editorArm);
        // The additive trigger never sets `regen` (it replaces nothing).
        expect(triggerJobs.every((job) => job.regen !== true)).toBe(true);
      } finally {
        releaseImages?.(genResult);
      }
      await settleStartedQueues();
    }, 40000);

    it('P3 — the fill is idempotent: a second pass and the sweep enqueue nothing for imaged kinds', async () => {
      armPortraitGeneration();
      const { campaign, moduleId, artifactId } = await createRestockedEncounter();
      await waitFor(
        async () => {
          const mapped = await getAnyArtifact(artifactId);
          if (mapped?.kind !== 'encounter') throw new Error('encounter missing');
          const plan = await planMobPortraitBatch(mapped, campaign.id);
          expect(plan.missing).toEqual([]);
        },
        { timeout: 15000 },
      );
      await settleStartedQueues();

      const mapped = await getAnyArtifact(artifactId);
      if (mapped?.kind !== 'encounter') throw new Error('encounter missing');
      const generationsBefore = generateImagesMock.mock.calls.length;

      // The trigger's own body, over the illustrated roster, TWICE.
      const first = await enqueueEncounterPortraitFill(mapped, campaign.id);
      const second = await enqueueEncounterPortraitFill(mapped, campaign.id);
      expect(first.enqueued).toBe(0);
      expect(second.enqueued).toBe(0);
      expect(second.alreadyImaged.length).toBeGreaterThan(0);
      // Zero additional generations were asked for, and nothing was detached
      // or replaced.
      expect(generateImagesMock.mock.calls.length).toBe(generationsBefore);
      expect(
        [...useMobPortraitQueue.getState().queued, ...useMobPortraitQueue.getState().active].every(
          (job) => job.regen !== true,
        ),
      ).toBe(true);

      // The module sweep's own detector agrees: the encounter is not in its
      // work list, so the automatic sweep and the completion trigger cannot
      // double-book it either.
      const module = await getModule(moduleId);
      if (module === undefined) throw new Error('module missing');
      const sweepTargets = encountersNeedingMobPortraits(
        module,
        moduleCreationPool(await listArtifactsByCampaign(campaign.id)),
        await presentationArtOfCampaign(campaign.id),
      );
      expect(sweepTargets.map((encounter) => encounter.id)).not.toContain(artifactId);
    }, 40000);

    it('the owning module switch OFF keeps the automatic roster portraits manual', async () => {
      armPortraitGeneration();
      const { campaign, artifactId } = await createRestockedEncounter({
        autoGenerateMobImages: false,
      });
      await waitForRestock(artifactId);
      // The restock landed, the trigger ran — and the switch stopped it: no
      // portrait job was ever enqueued and no creature portrait was committed
      // (the map run's OWN image calls are not portraits; the presentation
      // table is the portrait pin).
      await settleStartedQueues();
      expect(await db.creatureImages.where('campaignId').equals(campaign.id).count()).toBe(0);
      expect(useMobPortraitQueue.getState().failed).toEqual([]);
      const mapped = await getAnyArtifact(artifactId);
      if (mapped?.kind !== 'encounter') throw new Error('encounter missing');
      const plan = await planMobPortraitBatch(mapped, campaign.id);
      // The final roster genuinely lacks art — the editor button is its route,
      // exactly as before the fix (the switch is the module's promise).
      expect(plan.missing.length).toBeGreaterThan(0);
    }, 40000);

    it('the MODULE SWEEP leaves its fresh roster illustrated — the row-196 trigger fires for the run the sweep started (docs/17 row 195)', async () => {
      // The owner's outcome: "new fights at the new difficulty, illustrated".
      // The sweep starts the repopulate run, so the SAME completion trigger
      // row 196 added must enqueue the roster THAT run wrote — a distinct
      // creature identity makes the fresh roster unambiguous.
      armPortraitGeneration();
      const { campaign, moduleId, artifactId } = await createRestockedEncounter();
      await waitForRestock(artifactId);

      // A SECOND repopulate, this time started by the module-level sweep, with
      // a roster of a DIFFERENT creature identity than the first restock.
      const SWEEP_BRIEF = {
        ...RESTOCK_BRIEF,
        monsters: RESTOCK_BRIEF.monsters.map((monster) => ({ ...monster, name: 'Sahuagin' })),
      };
      chatMock.mockResolvedValue({
        text: JSON.stringify(SWEEP_BRIEF),
        modelUsed: 'test-model',
        fallback: null,
      });

      const report = await restockModuleEncounters(moduleId);
      expect(report.total).toBe(1);
      expect(report.restocked).toEqual([artifactId]);
      expect(report.failed).toEqual([]);
      expect(report.stopped).toBe(false);

      const swept = await getAnyArtifact(artifactId);
      if (swept?.kind !== 'encounter') throw new Error('encounter missing');
      expect(swept.data.monsters.map((monster) => monster.name)).toContain('Sahuagin');

      // The completion trigger re-reads the row the sweep just wrote and fills
      // it. REVERT-PROOF for the sweep's own interaction: nothing else in this
      // test enqueues a portrait for the Sahuagin roster, so a trigger that did
      // not fire leaves `missing` non-empty and this wait never converges.
      await waitFor(
        async () => {
          const mapped = await getAnyArtifact(artifactId);
          if (mapped?.kind !== 'encounter') throw new Error('encounter missing');
          const plan = await planMobPortraitBatch(mapped, campaign.id);
          expect(plan.missing).toEqual([]);
          expect(plan.imaged.length).toBeGreaterThan(0);
        },
        { timeout: 15000 },
      );
    }, 40000);
  });
});

describe('invented-creature-portraits.test.ts', () => {
  /**
   * On-demand invented creatures (docs/11 D5 amendment / ledger row 106):
   * uncited roster entries (inline / none) are ILLUSTRATED, never authored — no
   * artifact is created for them (docs/11 D1). Each becomes one local-only job
   * (no chunkId, no artifactId) keyed by its content identity, grounded on the
   * roster notes the encounter's model wrote, and never touching the global
   * `mobPortraits` cache. The prompt draft stays deterministic: the openrouter
   * chat mock must stay silent through every path below.
   */

  const chatMock = vi.mocked(chat);

  const generateImagesMock = vi.mocked(generateImages);

  const intakeImageMock = vi.mocked(intakeImage);

  const OOZE_NOTES = 'drips gloom, hates torchlight';

  function blobOf(text: string): Blob {
    return new Blob([text], { type: 'image/png' });
  }

  function oozeBlock() {
    return statBlockSchema.parse({
      system: 'dnd5e',
      level: '2',
      size: 'Medium',
      creatureType: 'ooze',
      ac: 8,
      acNote: '',
      hp: 45,
      hpFormula: '6d10 + 12',
      speed: '20 ft.',
      abilities: { str: 14, dex: 6, con: 16, int: 1, wis: 6, cha: 1 },
      saves: '',
      skills: '',
      senses: 'blindsight 60 ft.',
      languages: '',
      traits: [],
      actions: [],
      reactions: [],
      legendary: [],
      extras: {},
    });
  }

  let campaignId = '';

  async function addEncounter(
    monsters: {
      name: string;
      count: number;
      source: Record<string, unknown>;
      notes?: string;
      treasure?: string;
      /** A copy's provenance: the stamped origin line and the opaque identity
       * token (docs/17 rows 255a/255b). */
      sourceLine?: string;
      originToken?: string;
    }[],
    moduleId?: string,
    writerModel?: string,
  ) {
    return createArtifact({
      campaignId,
      ...(moduleId === undefined ? {} : { moduleId }),
      kind: 'encounter',
      name: 'Ooze warren',
      ...(writerModel === undefined ? {} : { writerModel }),
      data: {
        difficulty: 'medium',
        levelHint: '1',
        monsters: monsters.map((monster) => ({
          name: monster.name,
          count: monster.count,
          notes: monster.notes ?? '',
          treasure: monster.treasure ?? '',
          source: monster.source,
          ...(monster.sourceLine === undefined ? {} : { sourceLine: monster.sourceLine }),
          ...(monster.originToken === undefined ? {} : { originToken: monster.originToken }),
        })) as never,
        terrain: '',
        tactics: '',
        treasure: '',
        mapImageId: null,
        layout: null,
        preset: 'standard',
        locationKind: 'other',
        siteShape: 'single',
        budgetAdvisory: '',
      },
    });
  }

  /** Every npc row in the campaign. The invented lane must leave this at zero:
   * an uncited roster creature is illustrated, never authored into a row
   * (docs/11 D1/D5). `npc` alone is the complete check — a `mob` row is not a
   * kind the artifact union has any more, so the compiler rejects the attempt to
   * look for one (which is the point of deleting the kind rather than ignoring
   * it). */
  async function npcArtifacts(): Promise<string[]> {
    return (await listArtifactsByCampaign(campaignId))
      .filter((artifact) => artifact.kind === 'npc')
      .map((artifact) => artifact.id);
  }

  /** Table names in every Dexie transaction scope while `run` executes. */
  async function transactionTablesDuring(run: () => Promise<unknown>): Promise<string[]> {
    const original = db.transaction.bind(db) as (...args: unknown[]) => unknown;
    const target = db as unknown as { transaction: (...args: unknown[]) => unknown };
    const seen: string[] = [];
    target.transaction = (...args: unknown[]) => {
      for (const part of args.slice(1, -1)) {
        const tables = (Array.isArray(part) ? part : [part]) as { name?: unknown }[];
        for (const table of tables) {
          if (typeof table.name === 'string') seen.push(table.name);
        }
      }
      return original(...args);
    };
    try {
      await run();
    } finally {
      target.transaction = original;
    }
    return seen;
  }

  beforeEach(async () => {
    await clearDatabase();
    await db.mobPortraits.clear();
    await seedBuiltInPersonas();
    await updateSettings({ imagesEnabled: true, imageModel: 'test-image-model' });
    chatMock.mockReset();
    generateImagesMock.mockReset();
    intakeImageMock.mockReset();
    useMobPortraitQueue.getState().reset();
    useProgressStore.getState().reset();
    generateImagesMock.mockResolvedValue({
      images: [blobOf('gen')],
      costUsd: 0.01,
      cappedToOne: false,
      modelUsed: 'test-image-model',
      fallback: null,
      filteredCount: 0,
    });
    intakeImageMock.mockResolvedValue({
      blob: blobOf('intake'),
      mimeType: 'image/webp',
      width: 320,
      height: 240,
    });
    campaignId = (await createCampaign({ name: 'Invented creatures', system: 'dnd5e' })).id;
  });

  describe('enqueueInventedCreaturePortraits (the batch action)', () => {
    it('creates NOTHING and queues one local job per uncited creature, grounded on its notes', async () => {
      const encounter = await addEncounter([
        {
          name: 'Gloom Ooze',
          count: 2,
          source: { type: 'inline', statBlock: oozeBlock() },
          notes: OOZE_NOTES,
          treasure: 'a swallowed ring',
        },
        { name: 'Whisper Wisp', count: 1, source: { type: 'none' as const }, notes: 'barely a rumor' },
      ]);
      if (encounter.kind !== 'encounter') throw new Error('not an encounter');

      const result = await enqueueInventedCreaturePortraits(encounter, campaignId);
      expect(result).toEqual({ enqueued: 2, alreadyImaged: [] });
      const queued = useMobPortraitQueue.getState().queued;
      expect(queued).toHaveLength(2);
      // Local-only jobs: no chunkId AND no artifactId — an invented creature has
      // neither, so the worker can reach neither the cache nor a row.
      for (const job of queued) {
        expect(job.chunkId).toBeUndefined();
        expect(job.artifactId).toBeUndefined();
      }
      // The roster notes ARE the description (docs/11 D5 amendment): with no
      // artifact and no chunk, they are the only grounding the prompt can have.
      expect(queued.map((job) => job.grounding)).toEqual([OOZE_NOTES, 'barely a rumor']);
      expect(queued.map((job) => job.creatureKey)).toEqual([
        contentCreatureKey('Gloom Ooze', oozeBlock()),
        contentCreatureKey('Whisper Wisp', null),
      ]);

      await waitFor(() => {
        expect(generateImagesMock).toHaveBeenCalledTimes(2);
      });

      // REWRITTEN (ledger row 106): this lane used to MATERIALIZE one `npc`
      // artifact per uncited row and hang the portrait on it. Nothing is created
      // now (docs/11 D1/D5) — the portraits land on the campaign's presentation
      // rows for the two content identities.
      expect(await npcArtifacts()).toHaveLength(0);
      expect(await db.creatureImages.where('campaignId').equals(campaignId).count()).toBe(2);

      // Two local generations, grounded on the entry's own description —
      // never the rulebook chunk text, never a chat call.
      const prompts = generateImagesMock.mock.calls.map((call) => call[0]);
      expect(prompts.some((prompt) => prompt.includes(OOZE_NOTES))).toBe(true);
      expect(prompts.some((prompt) => prompt.includes('barely a rumor'))).toBe(true);
      // The global cache stays empty: invented covers are LOCAL ONLY.
      expect(await db.mobPortraits.count()).toBe(0);
    });

    it('carries the ENCOUNTER’s recorded model as provenance on the job it queues', async () => {
      // PROVENANCE (docs/17 row 93): the creature's description is text the
      // encounter's model wrote (its name and notes). No artifact records that
      // any more, so the job — and the prompt it grounds — is where the
      // encounter's own recorded id has to travel.
      const encounter = await addEncounter(
        [
          {
            name: 'Gloom Ooze',
            count: 1,
            source: { type: 'inline', statBlock: oozeBlock() },
            notes: OOZE_NOTES,
          },
        ],
        undefined,
        'staged/encounter-model',
      );
      if (encounter.kind !== 'encounter') throw new Error('not an encounter');

      await enqueueInventedCreaturePortraits(encounter, campaignId);

      const [job] = useMobPortraitQueue.getState().queued;
      expect(job?.grounding).toBe(OOZE_NOTES);
      // Nothing was created to carry the id — and the run's provenance is still
      // recorded on the encounter itself, which is the row that owns it.
      expect(await npcArtifacts()).toHaveLength(0);
      expect((await getAnyArtifact(encounter.id))?.writerModel).toBe('staged/encounter-model');
    });

    it('leaves the job without a chunk or artifact when the encounter records neither', async () => {
      // The negative half: a hand-typed encounter (no recorded model, a `none`
      // citation) must not produce a settings-derived id or a fabricated row.
      const encounter = await addEncounter([
        { name: 'Whisper Wisp', count: 1, source: { type: 'none' as const }, notes: 'barely a rumor' },
      ]);
      if (encounter.kind !== 'encounter') throw new Error('not an encounter');

      await enqueueInventedCreaturePortraits(encounter, campaignId);

      const [job] = useMobPortraitQueue.getState().queued;
      expect(job?.chunkId).toBeUndefined();
      expect(job?.artifactId).toBeUndefined();
      expect((await getAnyArtifact(encounter.id))?.writerModel).toBe('');
      expect(await npcArtifacts()).toHaveLength(0);
    });

    it('never touches the mobPortraits table — enqueue and generate stay off-seam', async () => {
      const encounter = await addEncounter([
        {
          name: 'Gloom Ooze',
          count: 1,
          source: { type: 'inline', statBlock: oozeBlock() },
          notes: OOZE_NOTES,
        },
      ]);
      if (encounter.kind !== 'encounter') throw new Error('not an encounter');

      const tables = await transactionTablesDuring(async () => {
        await enqueueInventedCreaturePortraits(encounter, campaignId);
        await waitFor(async () => {
          expect(await db.creatureImages.where('campaignId').equals(campaignId).count()).toBe(1);
        });
      });
      expect(tables).not.toContain('mobPortraits');
      expect(await db.mobPortraits.count()).toBe(0);
    });

    it('dedupes duplicate roster rows of one creature onto ONE job', async () => {
      const encounter = await addEncounter([
        {
          name: 'Gloom Ooze',
          count: 2,
          source: { type: 'inline', statBlock: oozeBlock() },
          notes: OOZE_NOTES,
        },
        {
          name: 'Gloom Ooze',
          count: 1,
          source: { type: 'inline', statBlock: oozeBlock() },
          notes: OOZE_NOTES,
        },
      ]);
      if (encounter.kind !== 'encounter') throw new Error('not an encounter');

      const result = await enqueueInventedCreaturePortraits(encounter, campaignId);
      // ONE identity, ONE job: the entries share a creatureKey, the queue's key is
      // the identity, so a second job would be dropped by the queue while the
      // count claimed work that never ran (and the confirm dialog, which counts
      // deduped kinds, would disagree with the run).
      expect(result).toEqual({ enqueued: 1, alreadyImaged: [] });
      expect(useMobPortraitQueue.getState().queued).toHaveLength(1);
      await waitFor(() => {
        expect(generateImagesMock).toHaveBeenCalledTimes(1);
      });
      expect(await npcArtifacts()).toHaveLength(0);
    });

    /**
     * The lane split (docs/11 D4/D5): `enqueueInventedCreaturePortraits` owns the
     * `invented` lane and NOTHING else. An `npc-ref` row is an AUTHORED NPC — it
     * already has a row and a cover of its own — so it belongs to
     * `enqueueMobPortraits` and must never appear here. The asymmetry is the
     * owner's mandate made structural: the encounter path cites, it never casts.
     *
     * Revert-proof: widen this lane back to `npc-ref` and the Captain Vane job
     * reappears in `queued`, failing the name pin below.
     */
    it('walks uncited entries ONLY — an authored npc-ref row is the other lane’s work', async () => {
      const npc = await createArtifact({
        campaignId,
        kind: 'npc',
        name: 'Captain Vane',
        data: { appearance: 'scarred', personality: 'bold', statBlock: null },
      });
      const chunkId = newId();
      const encounter = await addEncounter([
        {
          name: 'Goblin Boss',
          count: 1,
          source: { type: 'none' as const },
          originToken: libraryCreatureKey(chunkId),
        },
        { name: 'Captain Vane', count: 1, source: { type: 'npc-ref', artifactId: npc.id } },
        { name: 'Whisper Wisp', count: 1, source: { type: 'none' as const }, notes: 'barely a rumor' },
      ]);
      if (encounter.kind !== 'encounter') throw new Error('not an encounter');

      const result = await enqueueInventedCreaturePortraits(encounter, campaignId);
      expect(result).toEqual({ enqueued: 1, alreadyImaged: [] });
      expect(useMobPortraitQueue.getState().queued.map((job) => job.name)).toEqual([
        'Whisper Wisp',
      ]);
      for (const job of useMobPortraitQueue.getState().queued) {
        expect(job.chunkId).toBeUndefined();
      }
      // The chunk-backed row is equally not this lane's.
      expect(useMobPortraitQueue.getState().queued.map((job) => job.creatureKey)).not.toContain(
        `chunk:${chunkId}`,
      );
    });

    it('per-entry indexes enqueue only that row', async () => {
      const encounter = await addEncounter([
        {
          name: 'Gloom Ooze',
          count: 1,
          source: { type: 'inline', statBlock: oozeBlock() },
          notes: OOZE_NOTES,
        },
        { name: 'Whisper Wisp', count: 1, source: { type: 'none' as const }, notes: 'barely a rumor' },
      ]);
      if (encounter.kind !== 'encounter') throw new Error('not an encounter');

      const result = await enqueueInventedCreaturePortraits(encounter, campaignId, [1]);
      expect(result).toEqual({ enqueued: 1, alreadyImaged: [] });
      expect(useMobPortraitQueue.getState().queued).toHaveLength(1);
      expect(useMobPortraitQueue.getState().queued[0]?.name).toBe('Whisper Wisp');
      expect(await npcArtifacts()).toHaveLength(0);
    });

    it('reports already-imaged creatures instead of re-enqueueing', async () => {
      const encounter = await addEncounter([
        { name: 'Whisper Wisp', count: 1, source: { type: 'none' as const }, notes: 'barely a rumor' },
      ]);
      if (encounter.kind !== 'encounter') throw new Error('not an encounter');

      const first = await enqueueInventedCreaturePortraits(encounter, campaignId, [0]);
      expect(first.enqueued).toBe(1);
      await waitFor(async () => {
        expect(
          await creatureCoverImageId({
            campaignId,
            creatureKey: contentCreatureKey('Whisper Wisp', null),
          }),
        ).not.toBeNull();
      });
      useMobPortraitQueue.getState().reset();

      // A second click sees the presentation row and enumerates the creature away.
      const second = await enqueueInventedCreaturePortraits(encounter, campaignId, [0]);
      expect(second).toEqual({ enqueued: 0, alreadyImaged: ['Whisper Wisp'] });
      expect(useMobPortraitQueue.getState().queued).toHaveLength(0);
      expect(generateImagesMock).toHaveBeenCalledTimes(1);
    });

    it('adds nothing to the module it is asked about — the encounter stays the only row it owns', async () => {
      const vault = await createModule__2(
        createModuleSchema({
          campaignId,
          title: 'The Sunless Vault',
          concept: '',
          levelMin: 1,
          levelMax: 3,
          sizeDial: 'sketch',
        }),
      );
      const encounter = await addEncounter(
        [
          {
            name: 'Gloom Ooze',
            count: 1,
            source: { type: 'inline', statBlock: oozeBlock() },
            notes: OOZE_NOTES,
          },
        ],
        vault.id,
      );
      if (encounter.kind !== 'encounter') throw new Error('not an encounter');

      const before = (await listArtifactsByCampaign(campaignId)).length;
      await enqueueInventedCreaturePortraits(encounter, campaignId);
      // An illustration pass is not an authoring pass: it may not grow the
      // module's artifact list (docs/11 D5 — the lane cites, it never creates).
      expect((await listArtifactsByCampaign(campaignId)).length).toBe(before);
      expect(await npcArtifacts()).toHaveLength(0);
    });

    it('fails loudly on an empty roster name with nothing enqueued (no silent skip)', async () => {
      const encounter = await addEncounter([{ name: '   ', count: 1, source: { type: 'none' as const } }]);
      if (encounter.kind !== 'encounter') throw new Error('not an encounter');

      await expect(enqueueInventedCreaturePortraits(encounter, campaignId)).rejects.toThrow(
        'creature identity: a creature with no name has no content identity',
      );
      expect(useMobPortraitQueue.getState().queued).toHaveLength(0);
      expect(await npcArtifacts()).toHaveLength(0);
    });
  });
});

describe('entity-image-queue.test.ts', () => {
  /**
   * Entity image queue (08-MODULE-DESIGNER M4-C): background generation for the
   * panel's image checkboxes — real Dexie rows, LLM/image entry points mocked.
   * The prompt draft is deterministic (buildImagePrompt): the openrouter chat
   * mock must stay silent through every queue path.
   */

  const chatMock = vi.mocked(chat);

  const generateImagesMock = vi.mocked(generateImages);

  const intakeImageMock = vi.mocked(intakeImage);

  const toastErrorMock = vi.mocked(toastError);

  function blobOf(text: string): Blob {
    return new Blob([text], { type: 'image/png' });
  }

  beforeEach(async () => {
    await clearDatabase();
    await seedBuiltInPersonas();
    await updateSettings({ imagesEnabled: true, imageModel: 'test-image-model' });
    chatMock.mockReset();
    generateImagesMock.mockReset();
    intakeImageMock.mockReset();
    toastErrorMock.mockReset();
    useEntityImageQueue.getState().reset();
    useProgressStore.getState().reset();
    generateImagesMock.mockResolvedValue({
      images: [blobOf('gen')],
      costUsd: 0.01,
      cappedToOne: false,
      modelUsed: 'test-image-model',
      fallback: null,
      filteredCount: 0,
    });
    intakeImageMock.mockResolvedValue({
      blob: blobOf('intake'),
      mimeType: 'image/webp',
      width: 320,
      height: 240,
    });
  });

  describe('entity image queue', () => {
    it('generates one image per queued entity, grounded in the artifact text, attached as the cover', async () => {
      const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
      const campaignId = campaign.id;
      const moduleId = newId();
      await createArtifact({
        campaignId,
        kind: 'npc',
        name: 'Kael',
        summary: 'Ember\u2019s gate warden.',
      });
      await createArtifact({ campaignId, kind: 'npc', name: 'Bram', summary: 'A quiet farrier.' });

      useEntityImageQueue.getState().enqueue([
        { campaignId, moduleId, name: 'Kael' },
        { campaignId, moduleId, name: 'Bram' },
      ]);

      await waitFor(async () => {
        const artifacts = await listArtifactsByCampaign(campaignId);
        const kael = artifacts.find((artifact) => artifact.name === 'Kael');
        const bram = artifacts.find((artifact) => artifact.name === 'Bram');
        expect(kael?.imageIds).toHaveLength(1);
        expect(kael?.coverImageId).toBe(kael?.imageIds[0] ?? null);
        expect(bram?.imageIds).toHaveLength(1);
      });

      expect(generateImagesMock).toHaveBeenCalledTimes(2);
      // Headline pin (owner amendment): NO prompt-draft chat call — the prompt
      // is built deterministically from the artifact's own data.
      expect(chatMock).not.toHaveBeenCalled();
      expect(generateImagesMock.mock.calls[0]?.[0]).toContain('Kael (npc)');
      expect(generateImagesMock.mock.calls[0]?.[0]).toContain('Summary: Ember\u2019s gate warden.');

      // The stored row records provenance…
      const kael = (await listArtifactsByCampaign(campaignId)).find((a) => a.name === 'Kael');
      const stored = await getImage(kael?.imageIds[0] ?? '');
      expect(stored?.source).toBe('generated');
      expect(stored?.model).toBe('test-image-model');
      expect(stored?.prompt).toContain('gate warden');
      // …the queue drains, and the dock job finishes.
      expect(useEntityImageQueue.getState().queued).toHaveLength(0);
      expect(useEntityImageQueue.getState().active).toEqual([]);
      expect(
        useProgressStore
          .getState()
          .jobs.find((job) => job.id === `module-entity-images-${moduleId}`),
      ).toBeUndefined();
    });

    it('skips entities that already have an image, fails loud without an artifact, keeps going', async () => {
      const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
      const campaignId = campaign.id;
      const moduleId = newId();
      await createArtifact({
        campaignId,
        kind: 'npc',
        name: 'Kael',
        summary: 'Ember\u2019s gate warden.',
      });
      const bram = await createArtifact({
        campaignId,
        kind: 'npc',
        name: 'Bram',
        summary: 'A quiet farrier.',
      });
      const existing = await createImage({
        campaignId,
        blob: blobOf('old'),
        mimeType: 'image/png',
        width: 10,
        height: 10,
        source: 'uploaded',
      });
      await updateArtifact(bram.id, { imageIds: [existing.id], coverImageId: existing.id });

      useEntityImageQueue.getState().enqueue([
        { campaignId, moduleId, name: 'Bram' },
        { campaignId, moduleId, name: 'Kael' },
        { campaignId, moduleId, name: 'Ghost' },
      ]);

      await waitFor(() => {
        expect(toastErrorMock).toHaveBeenCalled();
      });
      await waitFor(async () => {
        const kael = (await listArtifactsByCampaign(campaignId)).find((a) => a.name === 'Kael');
        expect(kael?.imageIds).toHaveLength(1);
      });

      // Bram was skipped (already had an image); only Kael generated.
      expect(generateImagesMock).toHaveBeenCalledTimes(1);
      const call = toastErrorMock.mock.calls[0];
      expect(call?.[0]).toBe('Could not generate an image for "Ghost"');
      expect((call?.[1] as Error).message).toContain('no artifact exists');
      // The queue drains despite the failure.
      expect(useEntityImageQueue.getState().queued).toHaveLength(0);
      expect(useEntityImageQueue.getState().active).toEqual([]);
    });

    it('dequeue aborts in-flight jobs silently and drops pending ones', async () => {
      const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
      const campaignId: Id = campaign.id;
      const moduleId = newId();
      await createArtifact({
        campaignId,
        kind: 'npc',
        name: 'Kael',
        summary: 'Ember\u2019s gate warden.',
      });
      await createArtifact({ campaignId, kind: 'npc', name: 'Mira', summary: 'A tide-watcher.' });
      await createArtifact({ campaignId, kind: 'npc', name: 'Ruth', summary: 'A net-mender.' });

      // Hold every image call until the test releases it — with the default
      // parallel limit of 2 both slots fill, and the third job stays pending.
      // (The prompt draft is deterministic and instant; the abort gate lives on
      // the image API call, which carries the job's abort signal.)
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      generateImagesMock.mockImplementation((_prompt, _n, opts) => {
        const signal = opts.signal;
        if (signal === undefined) return Promise.reject(new Error('no abort signal passed'));
        return new Promise((resolve, reject) => {
          const abort = (): void => {
            reject(new DOMException('Aborted', 'AbortError'));
          };
          if (signal.aborted) {
            abort();
            return;
          }
          signal.addEventListener('abort', abort);
          void gate.then(() => {
            signal.removeEventListener('abort', abort);
            if (signal.aborted) {
              abort();
              return;
            }
            resolve({
              images: [blobOf('gen')],
              costUsd: 0.01,
              cappedToOne: false,
              modelUsed: 'test-image-model',
              fallback: null,
              filteredCount: 0,
            });
          });
        });
      });

      useEntityImageQueue.getState().enqueue([
        { campaignId, moduleId, name: 'Kael' },
        { campaignId, moduleId, name: 'Mira' },
        { campaignId, moduleId, name: 'Ruth' },
      ]);
      await waitFor(() => {
        expect(useEntityImageQueue.getState().active).toHaveLength(2);
      });
      expect(useEntityImageQueue.getState().queued.some((job) => job.name === 'Ruth')).toBe(true);

      // Dequeue the two IN-FLIGHT jobs (abort) and the PENDING one (drop).
      useEntityImageQueue.getState().dequeue({ campaignId, moduleId, name: 'Kael' });
      useEntityImageQueue.getState().dequeue({ campaignId, moduleId, name: 'Mira' });
      useEntityImageQueue.getState().dequeue({ campaignId, moduleId, name: 'Ruth' });
      release();

      await waitFor(() => {
        expect(useEntityImageQueue.getState().active).toEqual([]);
      });
      expect(useEntityImageQueue.getState().queued).toEqual([]);
      expect(toastErrorMock).not.toHaveBeenCalled();
      const artifacts = await listArtifactsByCampaign(campaignId);
      expect(artifacts.find((a) => a.name === 'Kael')?.imageIds).toHaveLength(0);
      expect(artifacts.find((a) => a.name === 'Mira')?.imageIds).toHaveLength(0);
      expect(useProgressStore.getState().jobs).toHaveLength(0);
    });

    it('uses game system prefix and appearance directly without calling LLM chat when entity has appearance', async () => {
      const campaign = await createCampaign({ name: 'Golarion', system: 'pathfinder2e' });
      const campaignId = campaign.id;
      const moduleId = newId();
      await createArtifact({
        campaignId,
        kind: 'npc',
        name: 'Seoni',
        data: {
          appearance: 'Varisian sorceress with blue robes and tattoos',
          personality: 'Enigmatic',
          statBlock: null,
        },
      });

      useEntityImageQueue.getState().enqueue([{ campaignId, moduleId, name: 'Seoni' }]);

      await waitFor(async () => {
        const artifacts = await listArtifactsByCampaign(campaignId);
        const seoni = artifacts.find((artifact) => artifact.name === 'Seoni');
        expect(seoni?.imageIds).toHaveLength(1);
      });

      // The appearance shortcut wins AND carries the default-on text-render
      // guard (the negative reaches the final prompt on both builder
      // branches).
      const finalPrompt = generateImagesMock.mock.calls[0]?.[0] ?? '';
      expect(finalPrompt).toContain(
        'Pathfinder 2e=>Varisian sorceress with blue robes and tattoos',
      );
      expect(finalPrompt).toContain('Avoid: long paragraphs of text');
      expect(finalPrompt).toContain('speech bubbles');
      expect(generateImagesMock.mock.calls[0]?.[1]).toBe(1);
      expect(chatMock).not.toHaveBeenCalled();
    });

    it('dedupes concurrent same-name jobs (createJobQueue invariant) — one job, one image', async () => {
      const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
      const campaignId = campaign.id;
      const moduleId = newId();
      await createArtifact({
        campaignId,
        kind: 'npc',
        name: 'Kael',
        summary: 'Ember\u2019s gate warden.',
      });

      // The entity panel's checkbox could tick twice in quick succession
      // (double click, rapid re-render): the pre-factory queue enqueued both,
      // generated a double image and silently overwrote the cover.
      useEntityImageQueue.getState().enqueue([{ campaignId, moduleId, name: 'Kael' }]);
      useEntityImageQueue.getState().enqueue([{ campaignId, moduleId, name: 'Kael' }]);
      expect(useEntityImageQueue.getState().queued).toHaveLength(1);

      await waitFor(async () => {
        const kael = (await listArtifactsByCampaign(campaignId)).find((a) => a.name === 'Kael');
        expect(kael?.imageIds).toHaveLength(1);
      });
      expect(generateImagesMock).toHaveBeenCalledTimes(1);
      expect(useEntityImageQueue.getState().queued).toHaveLength(0);
      expect(useEntityImageQueue.getState().active).toEqual([]);
      expect(useEntityImageQueue.getState().failed).toEqual([]);
    });

    it('cancelAll aborts the in-flight image job and withdraws the queued one silently (stop-all seam)', async () => {
      const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
      const campaignId = campaign.id;
      const moduleId = newId();
      await createArtifact({
        campaignId,
        kind: 'npc',
        name: 'Kael',
        summary: 'Ember\u2019s gate warden.',
      });
      await createArtifact({ campaignId, kind: 'npc', name: 'Bram', summary: 'A quiet farrier.' });
      // Serial pump: Kael in flight (held on the image call's abort signal),
      // Bram still queued.
      await updateSettings({ maxParallelRequests: 1 });
      generateImagesMock.mockImplementation((_prompt, _count, opts) => {
        const signal = (opts as { signal?: AbortSignal } | undefined)?.signal;
        if (signal === undefined) return Promise.reject(new Error('no abort signal passed'));
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      });
      useEntityImageQueue.getState().enqueue([
        { campaignId, moduleId, name: 'Kael' },
        { campaignId, moduleId, name: 'Bram' },
      ]);
      await waitFor(() => {
        expect(useEntityImageQueue.getState().active).toHaveLength(1);
        expect(useEntityImageQueue.getState().queued).toHaveLength(1);
      });

      const withdrawn = await useEntityImageQueue.getState().cancelAll();
      expect(withdrawn).toBe(2);
      expect(useEntityImageQueue.getState().active).toEqual([]);
      expect(useEntityImageQueue.getState().queued).toEqual([]);
      expect(useEntityImageQueue.getState().failed).toEqual([]);
      expect(useProgressStore.getState().jobs).toEqual([]);
      // Silent + non-destructive: no failure toast, no image attached.
      expect(toastErrorMock).not.toHaveBeenCalled();
      const kael = (await listArtifactsByCampaign(campaignId)).find((a) => a.name === 'Kael');
      expect(kael?.coverImageId).toBeNull();
    });
  });
});

describe('mob-portrait-npc-ref.test.ts', () => {
  /**
   * Roster routing for the portrait batch (owner report, docs/17 row 90; owner
   * decision: *"A special look for a special zombie is ok."*).
   *
   * The owner repopulated his German scene — two risen lumberjacks the prose
   * staged — and the encounter, bound by the assertion rule (docs/11 §The scene
   * is the truth), materialized them as REAL `npc` artifacts linked from the
   * roster as `{ type: 'npc-ref' }`. The portrait batch then told him
   * *"No creatures to illustrate — add roster entries first"*: the enumeration
   * walked `rulebook` entries in one lane and `inline`/`none` entries in the
   * other, so an `npc-ref` monster fell through BOTH and could never be
   * illustrated.
   *
   * What is pinned here (rewritten for the two-writer model, ledger row 106):
   * - every roster participant that can own a portrait is enumerated, routed by
   *   what its artifact IS: a CAST npc (`creatureRef`) or a direct citation is
   *   the CREATURE lane and shares the bestiary portrait; a plain authored NPC
   *   is the AUTHORED lane and keeps its own cover; an uncited row is the
   *   INVENTED lane and gets a local portrait of its own;
   * - WHICH batch owns which lane is structural, not incidental: the encounter
   *   side may cite but never cast (docs/11 D4/D5), so an `npc-ref` row is never
   *   the invented lane's work;
   * - the canonical-portrait firewall: a local invented job carries NO chunkId,
   *   so it can never read or write the global `mobPortraits` cache — and a
   *   distinct invented creature never inherits a rulebook creature's art;
   * - an artifact that already carries art is reported imaged and never
   *   re-generated, detached or replaced by enumeration (a named NPC standing in
   *   the fight keeps her portrait);
   * - the existing `inline` lane is unchanged (non-regression).
   *
   * Revert-proof: restore the retired `npc-ref`-into-the-invented-lane routing in
   * `enumerateBatchKinds` and the lane-ownership pins below fail — the invented
   * batch reports the authored row as its own work while the authored lane
   * reports it too.
   */

  const chatMock = vi.mocked(chat);

  const generateImagesMock = vi.mocked(generateImages);

  const intakeImageMock = vi.mocked(intakeImage);

  const GOBLIN_TEXT = 'Goblin Boss, humanoid, agile commander. HP 21, AC 17.';
  const LUMBERJACK_NOTES = 'axe still in hand, motionless, bog water on the boots';

  /** In-flight + pending jobs: the pump starts as soon as a job is enqueued, so
   * a fast assertion can find the job active rather than queued. */
  function inFlight(): ReturnType<typeof useMobPortraitQueue.getState>['queued'] {
    const state = useMobPortraitQueue.getState();
    return [...state.queued, ...state.active];
  }

  function blobOf(text: string): Blob {
    return new Blob([text], { type: 'image/png' });
  }

  function creatureBlock(level = '3') {
    return statBlockSchema.parse({
      system: 'dnd5e',
      level,
      size: 'Medium',
      creatureType: 'undead',
      ac: 12,
      acNote: '',
      hp: 22,
      hpFormula: '4d8 + 4',
      speed: '30 ft.',
      abilities: { str: 15, dex: 10, con: 13, int: 6, wis: 8, cha: 5 },
      saves: '',
      skills: '',
      senses: 'darkvision 60 ft.',
      languages: 'understands Common',
      traits: [],
      actions: [],
      reactions: [],
      legendary: [],
      extras: {},
    });
  }

  let campaignId = '';

  async function seedCreatureChunk(creatureName: string, text: string): Promise<Id> {
    const book = await createRulebook({
      title: 'Bestiary',
      system: 'dnd5e',
      filename: 'bestiary.pdf',
    });
    await putChunks([
      ruleChunkSchema.parse({
        ...stampNewEntity(),
        bookId: book.id,
        pageStart: 12,
        pageEnd: 12,
        chunkType: 'statblock',
        headingPath: [creatureName],
        text,
        statBlock: creatureBlock('2'),
        contentHash: await sha256Hex(text),
      }),
    ]);
    const { db: database } = await import('@/db/db');
    const chunk = await database.chunks.where('bookId').equals(book.id).first();
    if (chunk === undefined) throw new Error('chunk missing');
    return chunk.id;
  }

  async function addEncounter(
    monsters: {
      name: string;
      count: number;
      source: Record<string, unknown>;
      notes?: string;
      originToken?: string;
    }[],
  ) {
    return createArtifact({
      campaignId,
      kind: 'encounter',
      name: 'The boggy footbridge',
      data: {
        difficulty: 'medium',
        levelHint: '3',
        monsters: monsters.map((monster) => ({
          name: monster.name,
          count: monster.count,
          notes: monster.notes ?? '',
          treasure: '',
          source: monster.source,
          ...(monster.originToken === undefined ? {} : { originToken: monster.originToken }),
        })) as never,
        terrain: '',
        tactics: '',
        treasure: '',
        mapImageId: null,
        layout: null,
        preset: 'standard',
        locationKind: 'other',
        siteShape: 'single',
        budgetAdvisory: '',
      },
    });
  }

  /**
   * The artifact the encounter's finalize path creates for a monster it
   * materialized from a model-authored inline stat block
   * (`runEngine.materializeMonsterNpc`): a REAL `npc` row with `statBlock` and NO
   * `monsterChunkId` marker.
   */
  async function materializedMonster(name: string, level = '3'): Promise<string> {
    const artifact = await createArtifact({
      campaignId,
      kind: 'npc',
      name,
      summary: LUMBERJACK_NOTES,
      data: { appearance: '', personality: '', statBlock: creatureBlock(level) },
    });
    return artifact.id;
  }

  beforeEach(async () => {
    await clearDatabase();
    await db.mobPortraits.clear();
    await seedBuiltInPersonas();
    await updateSettings({ imagesEnabled: true, imageModel: 'test-image-model' });
    chatMock.mockReset();
    generateImagesMock.mockReset();
    intakeImageMock.mockReset();
    useMobPortraitQueue.getState().reset();
    useProgressStore.getState().reset();
    generateImagesMock.mockResolvedValue({
      images: [blobOf('gen')],
      costUsd: 0.01,
      cappedToOne: false,
      modelUsed: 'test-image-model',
      fallback: null,
      filteredCount: 0,
    });
    intakeImageMock.mockResolvedValue({
      blob: blobOf('intake'),
      mimeType: 'image/webp',
      width: 320,
      height: 240,
    });
    campaignId = (await createCampaign({ name: 'Footbridge', system: 'dnd5e' })).id;
  });

  describe('an npc-ref monster is visible to the portrait batch (the owner report)', () => {
    it('plans exactly the materialized monster as missing, then illustrates it locally', async () => {
      const lumberjack = await materializedMonster('Risen Lumberjack');
      const encounter = await addEncounter([
        { name: 'Risen Lumberjack', count: 2, source: { type: 'npc-ref', artifactId: lumberjack } },
      ]);
      if (encounter.kind !== 'encounter') throw new Error('not an encounter');

      // The count the section reads before the owner chooses: the monster IS the
      // enumeration (the exact state that used to report nothing to illustrate).
      const plan = await planMobPortraitBatch(encounter, campaignId);
      expect(plan).toEqual({
        missing: ['Risen Lumberjack'],
        imaged: [],
        sharedRows: 0,
        sharedPortraitNames: [],
        unreadableCitations: [],
      });

      // REWRITTEN (ledger row 106): the lane that owns this row is
      // `enqueueMobPortraits`. The retired model routed every `npc-ref` that was
      // not a hidden mob artifact into the INVENTED lane, which also MATERIALIZED
      // a creature row for it; the lane split made that lane cite-only (the
      // encounter path may never cast, docs/11 D4/D5), so an authored NPC is the
      // `authored` lane's work — and the owner-visible outcome is unchanged: the
      // monster IS enumerated and DOES get its portrait.
      const result = await enqueueMobPortraits(encounter, campaignId);
      expect(result).toEqual({ enqueued: 1, alreadyImaged: [] });
      const queued = inFlight();
      expect(queued).toHaveLength(1);
      // LOCAL job: no chunkId — the artifact's OWN content grounds the prompt,
      // and nothing about this job can reach the global portrait cache.
      expect(queued[0]?.chunkId).toBeUndefined();
      expect(queued[0]?.artifactId).toBe(lumberjack);

      await waitFor(async () => {
        expect((await getAnyArtifact(lumberjack))?.coverImageId).not.toBeNull();
      });
      expect(generateImagesMock).toHaveBeenCalledTimes(1);
      const prompt = generateImagesMock.mock.calls[0]?.[0] ?? '';
      expect(prompt).toContain(LUMBERJACK_NOTES);
      // The cache firewall: nothing was read from it (a clone would have taken
      // the canonical branch) and nothing was written to it.
      expect(await db.mobPortraits.count()).toBe(0);
      expect(chatMock).not.toHaveBeenCalled();
    });

    it('reports an already-illustrated npc-ref creature as imaged and never replaces its art', async () => {
      const lumberjack = await materializedMonster('Risen Lumberjack');
      const encounter = await addEncounter([
        { name: 'Risen Lumberjack', count: 2, source: { type: 'npc-ref', artifactId: lumberjack } },
      ]);
      if (encounter.kind !== 'encounter') throw new Error('not an encounter');

      // First pass: the local portrait lands.
      await enqueueMobPortraits(encounter, campaignId);
      await waitFor(async () => {
        expect((await getAnyArtifact(lumberjack))?.coverImageId).not.toBeNull();
      });
      const coverAfterFirst = (await getAnyArtifact(lumberjack))?.coverImageId ?? null;
      useMobPortraitQueue.getState().reset();

      const plan = await planMobPortraitBatch(encounter, campaignId);
      expect(plan.missing).toEqual([]);
      expect(plan.imaged).toEqual(['Risen Lumberjack']);
      // No `artWithoutCover` state exists any more: art IS the portrait row, so
      // "the creature is imaged" and "its portrait is attached" are one fact.

      const result = await enqueueMobPortraits(encounter, campaignId);
      expect(result).toEqual({ enqueued: 0, alreadyImaged: ['Risen Lumberjack'] });
      expect(inFlight()).toHaveLength(0);
      // One generation, one cover — enumeration never detaches or regenerates.
      expect(generateImagesMock).toHaveBeenCalledTimes(1);
      expect((await getAnyArtifact(lumberjack))?.coverImageId).toBe(coverAfterFirst);
    });

    it('never offers a portrait for a named NPC that already carries one (no overwrite, no regen)', async () => {
      const npc = await createArtifact({
        campaignId,
        kind: 'npc',
        name: 'Captain Vell',
        data: { appearance: 'scarred', personality: 'bold', statBlock: null },
      });
      const encounter = await addEncounter([
        { name: 'Captain Vell', count: 1, source: { type: 'npc-ref', artifactId: npc.id } },
      ]);
      if (encounter.kind !== 'encounter') throw new Error('not an encounter');

      // The portrait the roster row's owner already has (uploaded by hand, the
      // ordinary npc path): one local pass lays it down, the batch then leaves it
      // alone.
      await enqueueMobPortraits(encounter, campaignId);
      await waitFor(async () => {
        expect((await getAnyArtifact(npc.id))?.coverImageId).not.toBeNull();
      });
      const cover = (await getAnyArtifact(npc.id))?.coverImageId ?? null;
      expect(generateImagesMock).toHaveBeenCalledTimes(1);
      useMobPortraitQueue.getState().reset();

      const plan = await planMobPortraitBatch(encounter, campaignId);
      expect(plan.imaged).toEqual(['Captain Vell']);
      const again = await enqueueMobPortraits(encounter, campaignId);
      expect(again).toEqual({ enqueued: 0, alreadyImaged: ['Captain Vell'] });
      expect(generateImagesMock).toHaveBeenCalledTimes(1);
      expect((await getAnyArtifact(npc.id))?.coverImageId).toBe(cover);
    });
  });

  describe('rulebook-backed npc-ref rows share the bestiary portrait (no second local job)', () => {
    it('routes an npc-ref to a mob artifact into the rulebook lane, deduped with the citation', async () => {
      const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
      // REWRITTEN (ledger row 106): the second row used to link a hidden `npc`
      // artifact that WAS the creature (`libraryCreatureKey`). A creature is not
      // an artifact any more — the shape that exists is the CAST npc (docs/11
      // D3/D4): an authored row carrying `creatureRef`, its own prose, the
      // library's stats. It must therefore route to the SAME creature kind as the
      // direct citation, which is what this test is about.
      const mobArtifactId = (
        await createArtifact({
          campaignId,
          kind: 'npc',
          name: 'Goblin Boss',
          data: {
            appearance: '',
            personality: '',
            statBlock: null,
            originToken: libraryCreatureKey(chunkId),
          },
        })
      ).id;
      const encounter = await addEncounter([
        {
          name: 'Goblin Boss',
          count: 1,
          source: { type: 'none' as const },
          originToken: libraryCreatureKey(chunkId),
        },
        // The same creature cited a second time through its row — the shape an
        // encounter ends up with when a roster row is linked to a cast NPC.
        { name: 'Goblin Boss', count: 2, source: { type: 'npc-ref', artifactId: mobArtifactId } },
      ]);
      if (encounter.kind !== 'encounter') throw new Error('not an encounter');

      const plan = await planMobPortraitBatch(encounter, campaignId);
      // ONE kind, counted once: the second row collapsed onto the shared kind.
      expect(plan.missing).toEqual(['Goblin Boss']);
      expect(plan.sharedRows).toBe(1);

      const result = await enqueueMobPortraits(encounter, campaignId);
      expect(result).toEqual({ enqueued: 1, alreadyImaged: [] });
      const queued = inFlight();
      // Never a second job, and never a LOCAL one: the job is chunk-grounded, so
      // it goes through the canonical cache path exactly as before.
      expect(queued).toHaveLength(1);
      expect(queued[0]?.chunkId).toBe(chunkId);
      // ONE creature, ONE portrait slot: the kind's name and route come from the
      // FIRST roster row that cites it (the direct citation here), so the job
      // carries no artifactId and the art lands on the campaign's presentation
      // row for the identity — the cast row's own cover is NOT a second slot, or
      // the same goblin would have two portraits that can drift apart.
      expect(queued[0]?.artifactId).toBeUndefined();
      expect(queued[0]?.creatureKey).toBe(`chunk:${chunkId}`);

      await waitFor(async () => {
        expect(
          await creatureCoverImageId({ campaignId, creatureKey: `chunk:${chunkId}` }),
        ).not.toBeNull();
      });
      // The cast row keeps its own cover slot for its OWN portrait, untouched by
      // this pass: nothing wrote to the artifact.
      expect((await getAnyArtifact(mobArtifactId))?.coverImageId).toBeNull();
      // The canonical citation published the shared slot — the bestiary art is
      // ONE image per creature, and the invented lane enqueued nothing for it.
      expect(await db.mobPortraits.count()).toBe(1);
      const localAgain = await enqueueInventedCreaturePortraits(encounter, campaignId);
      expect(localAgain).toEqual({ enqueued: 0, alreadyImaged: [] });
    });

    it('does not re-illustrate locally a rulebook creature that already has shared art', async () => {
      const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
      const mobArtifactId = (
        await createArtifact({
          campaignId,
          kind: 'npc',
          name: 'Goblin Boss',
          data: {
            appearance: '',
            personality: '',
            statBlock: null,
            originToken: libraryCreatureKey(chunkId),
          },
        })
      ).id;
      await enqueueMobPortraits(
        await (async () => {
          const encounter = await addEncounter([
            {
              name: 'Goblin Boss',
              count: 1,
              source: { type: 'none' as const },
              originToken: libraryCreatureKey(chunkId),
            },
          ]);
          if (encounter.kind !== 'encounter') throw new Error('not an encounter');
          return encounter;
        })(),
        campaignId,
      );
      await waitFor(async () => {
        expect(await db.mobPortraits.count()).toBe(1);
      });
      useMobPortraitQueue.getState().reset();
      generateImagesMock.mockClear();

      // A SECOND encounter citing the same creature through its artifact.
      const second = await addEncounter([
        { name: 'Goblin Boss', count: 3, source: { type: 'npc-ref', artifactId: mobArtifactId } },
      ]);
      if (second.kind !== 'encounter') throw new Error('not an encounter');

      const plan = await planMobPortraitBatch(second, campaignId);
      expect(plan.missing).toEqual([]);
      expect(plan.imaged).toEqual(['Goblin Boss']);
      // The invented lane owns nothing here: the row's creature is chunk-backed
      // (a CAST npc, docs/11 D3), so it is the creature lane's kind — and the
      // bestiary lane has nothing left to do either.
      const result = await enqueueInventedCreaturePortraits(second, campaignId);
      expect(result).toEqual({ enqueued: 0, alreadyImaged: [] });
      const rulebook = await enqueueMobPortraits(second, campaignId);
      expect(rulebook).toEqual({ enqueued: 0, alreadyImaged: ['Goblin Boss'] });
      expect(generateImagesMock).not.toHaveBeenCalled();
    });
  });

  describe('the existing lanes are untouched (non-regression)', () => {
    it('an inline entry and a rulebook creature still enumerate exactly as before', async () => {
      const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
      const encounter = await addEncounter([
        {
          name: 'Goblin Boss',
          count: 1,
          source: { type: 'none' as const },
          originToken: libraryCreatureKey(chunkId),
        },
        {
          name: 'Gloom Ooze',
          count: 2,
          source: { type: 'inline', statBlock: creatureBlock('1') },
          notes: 'drips gloom',
        },
      ]);
      if (encounter.kind !== 'encounter') throw new Error('not an encounter');

      const plan = await planMobPortraitBatch(encounter, campaignId);
      expect(plan.missing).toEqual(['Goblin Boss', 'Gloom Ooze']);
      expect(plan.imaged).toEqual([]);

      const rulebook = await enqueueMobPortraits(encounter, campaignId);
      expect(rulebook.enqueued).toBe(1);
      const invented = await enqueueInventedCreaturePortraits(encounter, campaignId);
      expect(invented).toEqual({ enqueued: 1, alreadyImaged: [] });

      const queued = inFlight();
      expect(queued).toHaveLength(2);
      const chunkJob = queued.find((job) => job.name === 'Goblin Boss');
      const localJob = queued.find((job) => job.name === 'Gloom Ooze');
      expect(chunkJob?.chunkId).toBe(chunkId);
      expect(localJob?.chunkId).toBeUndefined();

      await waitFor(() => {
        expect(useMobPortraitQueue.getState().queued).toHaveLength(0);
        expect(useMobPortraitQueue.getState().active).toEqual([]);
      });
      // Two generations; the shared slot holds the canonical creature only — the
      // invented cover stays local.
      expect(generateImagesMock).toHaveBeenCalledTimes(2);
      expect(await db.mobPortraits.count()).toBe(1);
    });

    it('per-entry indexes still address one roster row, now including an npc-ref row', async () => {
      const lumberjack = await materializedMonster('Risen Lumberjack');
      const encounter = await addEncounter([
        { name: 'Gloom Ooze', count: 1, source: { type: 'inline', statBlock: creatureBlock('1') } },
        { name: 'Risen Lumberjack', count: 2, source: { type: 'npc-ref', artifactId: lumberjack } },
      ]);
      if (encounter.kind !== 'encounter') throw new Error('not an encounter');

      // REWRITTEN (ledger row 106): the per-entry index used to reach the
      // npc-ref row through the INVENTED lane (which routed every non-mob npc-ref
      // there and materialized a creature for it). The lane split means the index
      // addresses this lane's OWN rows, so index 1 (the authored row) selects
      // nothing here — and the authored lane, asked for the same roster, is where
      // that row is illustrated. Both halves are pinned, so a regression that
      // re-widens either lane fails.
      const result = await enqueueInventedCreaturePortraits(encounter, campaignId, [1]);
      expect(result).toEqual({ enqueued: 0, alreadyImaged: [] });
      expect(inFlight()).toHaveLength(0);

      // The invented lane's own row IS selectable by index.
      const local = await enqueueInventedCreaturePortraits(encounter, campaignId, [0]);
      expect(local).toEqual({ enqueued: 1, alreadyImaged: [] });
      const queued = inFlight();
      expect(queued).toHaveLength(1);
      expect(queued[0]?.name).toBe('Gloom Ooze');
      expect(queued[0]?.artifactId).toBeUndefined();
      useMobPortraitQueue.getState().reset();

      // And the authored lane illustrates the npc-ref row through its own seam.
      const authored = await enqueueMobPortraits(encounter, campaignId);
      expect(authored).toEqual({ enqueued: 1, alreadyImaged: [] });
      expect(inFlight()[0]?.name).toBe('Risen Lumberjack');
      expect(inFlight()[0]?.artifactId).toBe(lumberjack);
    });
  });

  describe('a dangling npc-ref is loud, never a silent skip', () => {
    it('throws naming the creature when the linked artifact is gone (the owner-report failure state)', async () => {
      const encounter = await addEncounter([
        {
          name: 'Risen Lumberjack',
          count: 2,
          source: { type: 'npc-ref', artifactId: newId() },
        },
      ]);
      if (encounter.kind !== 'encounter') throw new Error('not an encounter');

      // BOTH halves of the enumeration promise the same thing — the read-only
      // count must never promise a fill the enqueue would refuse to perform.
      await expect(planMobPortraitBatch(encounter, campaignId)).rejects.toThrow(
        /the artifact for "Risen Lumberjack" no longer exists/,
      );
      await expect(enqueueMobPortraits(encounter, campaignId)).rejects.toThrow(
        /the artifact for "Risen Lumberjack" no longer exists/,
      );
      expect(inFlight()).toHaveLength(0);
    });
  });
});

describe('mob-portrait-queue.test.ts', () => {
  /**
   * Creature portrait queue (owner-ratified core-mob arc, docs/11 D5 amendment):
   * one click generates n=1 portrait per cover-less creature kind, keyed by
   * CREATURE IDENTITY (`CreatureIdentity.key`) and grounded stat-exempt in the
   * cited chunk's parsed prose (portraitGroundingForChunk) — entity-image-queue
   * mechanics, creature flavor. NO artifact is created or required: the portrait
   * lands as this campaign's presentation row (`db/creatureImages`).
   *
   * REWRITTEN for the ratified model (ledger row 106): the old fixture created a
   * hidden `npc` artifact per cited creature (`getOrCreateMobArtifact`) and
   * asserted the portrait landed on that artifact's cover. Under the model there
   * is no such artifact — the citation IS the reference — so every assertion now
   * reads the campaign's presentation row for the creature's identity, and the
   * "skips imaged" pin seats its portrait on that row directly (the D6 pin: a
   * portrait exists with no artifact anywhere).
   *
   * The prompt draft is deterministic (buildImagePrompt): the openrouter chat
   * mock must stay silent through every queue path.
   */

  const chatMock = vi.mocked(chat);

  const generateImagesMock = vi.mocked(generateImages);

  const intakeImageMock = vi.mocked(intakeImage);

  const toastErrorMock = vi.mocked(toastError);

  const GOBLIN_TEXT = 'Goblin Boss, humanoid, agile commander. HP 21, AC 17.';

  /** The creature's portrait image id, read through the ONE identity seam. */
  async function creatureCoverIdOf(
    campaignId: string,
    creatureKey: string,
  ): Promise<string | null> {
    const { creatureCoverImageId } = await import('@/db/creatureRepo');
    return creatureCoverImageId({ campaignId, creatureKey });
  }

  function blobOf(text: string): Blob {
    return new Blob([text], { type: 'image/png' });
  }

  let campaignId = '';
  let encounterId = '';

  async function seedCreatureChunk(creatureName: string, text: string): Promise<string> {
    const book = await createRulebook({
      title: 'Bestiary',
      system: 'dnd5e',
      filename: 'bestiary.pdf',
    });
    await putChunks([
      ruleChunkSchema.parse({
        ...stampNewEntity(),
        bookId: book.id,
        pageStart: 12,
        pageEnd: 12,
        chunkType: 'statblock',
        headingPath: [creatureName],
        text,
        statBlock: statBlockSchema.parse({
          system: 'dnd5e',
          level: '2',
          size: 'Large',
          creatureType: 'giant',
          ac: 11,
          acNote: '',
          hp: 59,
          hpFormula: '7d10 + 21',
          speed: '40 ft.',
          abilities: { str: 20, dex: 8, con: 16, int: 5, wis: 7, cha: 7 },
          saves: '',
          skills: '',
          senses: 'darkvision 60 ft.',
          languages: 'Common, Giant',
          traits: [],
          actions: [],
          reactions: [],
          legendary: [],
          extras: {},
        }),
        contentHash: await sha256Hex(text),
      }),
    ]);
    const { db } = await import('@/db/db');
    const chunk = await db.chunks.where('bookId').equals(book.id).first();
    if (chunk === undefined) throw new Error('chunk missing');
    return chunk.id;
  }

  async function addEncounter(
    monsters: {
      name: string;
      count: number;
      source: Record<string, unknown>;
      notes?: string;
      /** A CONVERTED copy's stamped fields (docs/17 row 269): the origin label
       * and the opaque identity token the migration/write paths write beside an
       * `inline` copied block. */
      sourceLine?: string;
      originToken?: string;
    }[],
  ) {
    return createArtifact({
      campaignId,
      kind: 'encounter',
      name: 'Goblin warren',
      data: {
        difficulty: 'medium',
        levelHint: '1',
        monsters: monsters.map((monster) => ({
          name: monster.name,
          count: monster.count,
          notes: monster.notes ?? '',
          source: monster.source,
          ...(monster.sourceLine === undefined ? {} : { sourceLine: monster.sourceLine }),
          ...(monster.originToken === undefined ? {} : { originToken: monster.originToken }),
        })) as never,
        terrain: '',
        tactics: '',
        treasure: '',
        mapImageId: null,
        layout: null,
        preset: 'standard',
        locationKind: 'other',
        siteShape: 'single',
        budgetAdvisory: '',
      },
    });
  }

  beforeEach(async () => {
    await clearDatabase();
    await seedBuiltInPersonas();
    await updateSettings({ imagesEnabled: true, imageModel: 'test-image-model' });
    chatMock.mockReset();
    generateImagesMock.mockReset();
    intakeImageMock.mockReset();
    toastErrorMock.mockReset();
    useMobPortraitQueue.getState().reset();
    useProgressStore.getState().reset();
    generateImagesMock.mockResolvedValue({
      images: [blobOf('gen')],
      costUsd: 0.01,
      cappedToOne: false,
      modelUsed: 'test-image-model',
      fallback: null,
      filteredCount: 0,
    });
    intakeImageMock.mockResolvedValue({
      blob: blobOf('intake'),
      mimeType: 'image/webp',
      width: 320,
      height: 240,
    });
    campaignId = (await createCampaign({ name: 'Mob portraits', system: 'dnd5e' })).id;
    encounterId = newId();
  });

  describe('mob portrait queue', () => {
    it('generates n=1 per queued mob, grounded stat-exempt, attached as cover', async () => {
      const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
      const creatureKey = libraryCreatureKey(chunkId);
      useMobPortraitQueue
        .getState()
        .enqueue([{ campaignId, encounterId, creatureKey, name: 'Goblin Boss', chunkId }]);

      await waitFor(async () => {
        expect(await creaturePortraitArt(campaignId, creatureKey)).toBe('cover');
      });

      expect(generateImagesMock).toHaveBeenCalledTimes(1);
      // n=1 (owner-ratified): one portrait per creature kind.
      expect(generateImagesMock.mock.calls[0]?.[1]).toBe(1);
      // Headline pin (owner amendment): NO prompt-draft chat call — the prompt
      // is built deterministically from the artifact's own data.
      expect(chatMock).not.toHaveBeenCalled();
      // Stat-exempt grounding: the deterministic prompt carries size/type
      // identity — never the raw stat-block text (models render stat digits
      // into portraits) — plus the text-render negative.
      const finalPrompt = generateImagesMock.mock.calls[0]?.[0] ?? '';
      expect(finalPrompt).not.toContain(GOBLIN_TEXT);
      expect(finalPrompt).not.toContain('HP 21');
      expect(finalPrompt).not.toContain('AC 17');
      expect(finalPrompt).toContain('Large');
      expect(finalPrompt).toContain('giant');
      expect(finalPrompt).toContain('Avoid: long paragraphs of text');
      // Provenance lands on the image row; the queue and dock drain.
      const coverId = await creatureCoverIdOf(campaignId, creatureKey);
      const stored = await getImage(coverId ?? '');
      expect(stored?.source).toBe('generated');
      expect(stored?.prompt).not.toContain(GOBLIN_TEXT);
      expect(stored?.prompt).toContain('Avoid: long paragraphs of text');
      expect(useMobPortraitQueue.getState().queued).toHaveLength(0);
      expect(useMobPortraitQueue.getState().active).toEqual([]);
      expect(
        useProgressStore
          .getState()
          .jobs.find((job) => job.id === `encounter-mob-portraits-${encounterId}`),
      ).toBeUndefined();
    });

    it('grounds a flavored citation stat-exempt with the text-render negative', async () => {
      const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
      const creatureKey = libraryCreatureKey(chunkId);
      useMobPortraitQueue.getState().enqueue([
        // Non-canonical citing name: the local flavored branch (never the cache).
        { campaignId, encounterId, creatureKey, name: 'sickly goblin boss', chunkId },
      ]);

      await waitFor(async () => {
        expect(await creaturePortraitArt(campaignId, creatureKey)).toBe('cover');
      });

      expect(generateImagesMock).toHaveBeenCalledTimes(1);
      expect(chatMock).not.toHaveBeenCalled();
      const finalPrompt = generateImagesMock.mock.calls[0]?.[0] ?? '';
      // The roster flavor names the portrait; the chunk contributes identity
      // prose only — no stat digits from the fixture chunk.
      expect(finalPrompt).toContain('sickly goblin boss');
      expect(finalPrompt).toContain('Large');
      expect(finalPrompt).toContain('giant');
      expect(finalPrompt).not.toContain(GOBLIN_TEXT);
      expect(finalPrompt).not.toContain('59');
      expect(finalPrompt).not.toContain('7d10');
      expect(finalPrompt).not.toContain('darkvision 60 ft.');
      expect(finalPrompt).toContain('Avoid: long paragraphs of text');
    });

    it('skips imaged creatures (no re-generation) and drains — with no artifact in sight (D6)', async () => {
      const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
      const creatureKey = libraryCreatureKey(chunkId);
      // The D6 pin: the portrait exists as THIS campaign's presentation row with
      // no artifact anywhere holding it — exactly the shape the old model could
      // not express.
      const existing = await createImage({
        campaignId,
        blob: blobOf('old'),
        mimeType: 'image/png',
        width: 10,
        height: 10,
        source: 'uploaded',
      });
      await setCreatureCover({ campaignId, creatureKey, imageId: existing.id });

      useMobPortraitQueue
        .getState()
        .enqueue([{ campaignId, encounterId, creatureKey, name: 'Goblin Boss', chunkId }]);
      await waitFor(() => {
        expect(useMobPortraitQueue.getState().active).toEqual([]);
        expect(useMobPortraitQueue.getState().queued).toHaveLength(0);
      });
      expect(generateImagesMock).not.toHaveBeenCalled();
      expect(chatMock).not.toHaveBeenCalled();
      expect(toastErrorMock).not.toHaveBeenCalled();
    });

    it('fails loud per mob (name + reason) and keeps generating the others', async () => {
      const goblinChunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
      const good = libraryCreatureKey(goblinChunkId);
      const ghostChunkId = await seedCreatureChunk('Ghost Boss', 'Ghost Boss, spectral and cold.');
      const ghost = libraryCreatureKey(ghostChunkId);
      useMobPortraitQueue.getState().enqueue([
        // A citation whose stat-block chunk is gone: loud failure, never a prompt
        // built from nothing.
        { campaignId, encounterId, creatureKey: ghost, name: 'Ghost Boss', chunkId: newId() },
        { campaignId, encounterId, creatureKey: good, name: 'Goblin Boss', chunkId: goblinChunkId },
      ]);

      await waitFor(async () => {
        expect(await creaturePortraitArt(campaignId, good)).toBe('cover');
      });
      await waitFor(() => {
        expect(toastErrorMock).toHaveBeenCalled();
      });
      const call = toastErrorMock.mock.calls[0];
      expect(call?.[0]).toBe('Could not generate a portrait for "Ghost Boss"');
      expect((call?.[1] as Error).message).toContain('stat-block chunk no longer exists');
      expect(useMobPortraitQueue.getState().queued).toHaveLength(0);
      expect(useMobPortraitQueue.getState().active).toEqual([]);
    });

    it('drops duplicate jobs for the same creature identity instead of generating concurrently', async () => {
      const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
      const creatureKey = libraryCreatureKey(chunkId);
      const job = { campaignId, encounterId, creatureKey, name: 'Goblin Boss', chunkId };
      useMobPortraitQueue.getState().enqueue([job, { ...job }]);
      expect(useMobPortraitQueue.getState().queued).toHaveLength(1);
      await waitFor(async () => {
        expect(await creaturePortraitArt(campaignId, creatureKey)).toBe('cover');
      });
      expect(generateImagesMock).toHaveBeenCalledTimes(1);
    });

    it('records failures on the retry list and retryFailed re-enqueues them (createJobQueue invariant)', async () => {
      const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
      const creatureKey = libraryCreatureKey(chunkId);
      // Generation disabled: the job fails loud per creature AND lands on the
      // retry list (the pre-factory queue only toasted and dropped it).
      await updateSettings({ imagesEnabled: false });
      useMobPortraitQueue
        .getState()
        .enqueue([{ campaignId, encounterId, creatureKey, name: 'Goblin Boss', chunkId }]);
      await waitFor(() => {
        expect(toastErrorMock).toHaveBeenCalled();
        expect(useMobPortraitQueue.getState().failed).toHaveLength(1);
      });
      expect(useMobPortraitQueue.getState().queued).toHaveLength(0);
      expect(useMobPortraitQueue.getState().active).toEqual([]);

      // The explicit retry re-runs the same job once the setting heals.
      await updateSettings({ imagesEnabled: true });
      useMobPortraitQueue.getState().retryFailed();
      expect(useMobPortraitQueue.getState().queued).toHaveLength(1);
      expect(useMobPortraitQueue.getState().failed).toHaveLength(0);
      await waitFor(async () => {
        expect(await creaturePortraitArt(campaignId, creatureKey)).toBe('cover');
      });
      expect(generateImagesMock).toHaveBeenCalledTimes(1);
    });

    it('cancelAll aborts the in-flight image job and withdraws the queued one silently (stop-all seam)', async () => {
      const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
      const creatureKey = libraryCreatureKey(chunkId);
      const otherKey = libraryCreatureKey(await seedCreatureChunk('Ogre', 'Ogre, big and rude.'));
      // Serial pump: job 1 in flight (held on the image call's abort signal),
      // job 2 still queued.
      await updateSettings({ maxParallelRequests: 1 });
      generateImagesMock.mockImplementation((_prompt, _count, opts) => {
        const signal = (opts as { signal?: AbortSignal } | undefined)?.signal;
        if (signal === undefined) return Promise.reject(new Error('no abort signal passed'));
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      });
      useMobPortraitQueue.getState().enqueue([
        { campaignId, encounterId, creatureKey, name: 'Goblin Boss', chunkId },
        { campaignId, encounterId, creatureKey: otherKey, name: 'Ogre' },
      ]);
      await waitFor(() => {
        expect(useMobPortraitQueue.getState().active).toHaveLength(1);
        expect(useMobPortraitQueue.getState().queued).toHaveLength(1);
      });

      const withdrawn = await useMobPortraitQueue.getState().cancelAll();
      expect(withdrawn).toBe(2);
      expect(useMobPortraitQueue.getState().active).toEqual([]);
      expect(useMobPortraitQueue.getState().queued).toEqual([]);
      expect(useMobPortraitQueue.getState().failed).toEqual([]);
      expect(useProgressStore.getState().jobs).toEqual([]);
      // Silent + non-destructive: no failure toast, no portrait written.
      expect(toastErrorMock).not.toHaveBeenCalled();
      expect(await creaturePortraitArt(campaignId, creatureKey)).toBe('none');
    });
  });

  describe('enqueueMobPortraits (the batch action)', () => {
    it('enumerates only cover-less cited creatures, deduped by IDENTITY, retro-filling old rows', async () => {
      const goblinChunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
      const ogreChunkId = await seedCreatureChunk('Ogre', 'Ogre, big and rude. HP 59, AC 11.');
      // The goblin creature already carries a campaign portrait.
      const goblinKey = libraryCreatureKey(goblinChunkId);
      const cover = await createImage({
        campaignId,
        blob: blobOf('cover'),
        mimeType: 'image/png',
        width: 10,
        height: 10,
        source: 'uploaded',
      });
      await setCreatureCover({ campaignId, creatureKey: goblinKey, imageId: cover.id });

      const encounter = await addEncounter([
        // An OLD row with no citation stamp beyond the chunk: nothing has to be
        // created for it — the citation IS the reference (docs/11 D5).
        {
          name: 'Ogre',
          count: 2,
          source: { type: 'none' as const },
          originToken: libraryCreatureKey(ogreChunkId),
        },
        // Same chunk again: the SAME identity — no second job, and the share is
        // reported rather than silently dropped.
        {
          name: 'Ogre',
          count: 1,
          source: { type: 'none' as const },
          originToken: libraryCreatureKey(ogreChunkId),
        },
        // Pre-imaged goblin: enumerated away.
        {
          name: 'Goblin Boss',
          count: 2,
          source: { type: 'none' as const },
          originToken: libraryCreatureKey(goblinChunkId),
        },
        // An uncited entry is not a library citation — its ROSTER NOTES are its
        // only description (docs/11 D5; the owner's "special zombie" decision).
        {
          name: 'Troll',
          count: 1,
          notes: 'A hulking troll with mossy green hide and one cracked tusk.',
          source: { type: 'none' as const },
        },
      ]);
      if (encounter.kind !== 'encounter') throw new Error('not an encounter');

      const result = await enqueueMobPortraits(encounter, campaignId);
      // The cited lane only: ONE job for the two Ogre rows (identity dedupe), and
      // the imaged goblin enumerated away. The UNCITED Troll belongs to the other
      // batch — a lane claimed by both would enqueue every invented mob twice and
      // charge the image model for it.
      expect(result).toEqual({ enqueued: 1, alreadyImaged: ['Goblin Boss'] });
      expect(useMobPortraitQueue.getState().queued).toHaveLength(1);
      const job = useMobPortraitQueue.getState().queued[0];
      expect(job?.chunkId).toBe(ogreChunkId);
      expect(job?.creatureKey).toBe(libraryCreatureKey(ogreChunkId));
      expect(job?.name).toBe('Ogre');
      expect(job?.encounterId).toBe(encounter.id);

      await waitFor(async () => {
        expect(await creaturePortraitArt(campaignId, libraryCreatureKey(ogreChunkId))).toBe(
          'cover',
        );
      });
      // The batch created NOTHING: one portrait row per creature, zero artifacts.
      expect(await listArtifactsByCampaign(campaignId)).toHaveLength(1);
      expect(generateImagesMock).toHaveBeenCalledTimes(1);

      // The invented lane's own batch picks up exactly the uncited row, keyed on
      // its own content (nothing to cite, no row to create).
      const invented = await enqueueInventedCreaturePortraits(encounter, campaignId);
      expect(invented).toEqual({ enqueued: 1, alreadyImaged: [] });
      const inventedJob = useMobPortraitQueue.getState().queued.find((row) => row.name === 'Troll');
      expect(inventedJob?.chunkId).toBeUndefined();
      expect(inventedJob?.creatureKey).toBe(contentCreatureKey('Troll', null));
      await waitFor(async () => {
        expect(await creaturePortraitArt(campaignId, contentCreatureKey('Troll', null))).toBe(
          'cover',
        );
      });
      expect(generateImagesMock).toHaveBeenCalledTimes(2);
      expect(await listArtifactsByCampaign(campaignId)).toHaveLength(1);
    });

    it('refuses to illustrate an invented mob nobody described (no picture of a name)', async () => {
      const encounter = await addEncounter([
        { name: 'Nameless Thing', count: 1, source: { type: 'none' as const } },
      ]);
      if (encounter.kind !== 'encounter') throw new Error('not an encounter');
      const result = await enqueueInventedCreaturePortraits(encounter, campaignId);
      expect(result.enqueued).toBe(1);
      await waitFor(() => {
        expect(toastErrorMock).toHaveBeenCalled();
      });
      const call = toastErrorMock.mock.calls[0];
      expect(call?.[0]).toBe('Could not generate a portrait for "Nameless Thing"');
      expect((call?.[1] as Error).message).toContain('no appearance, summary, or body');
      expect(generateImagesMock).not.toHaveBeenCalled();
      expect(
        await creaturePortraitArt(campaignId, contentCreatureKey('Nameless Thing', null)),
      ).toBe('none');
    });

    it('fails loudly when a roster row cites an npc-ref that no longer exists (no silent divergence)', async () => {
      const goblinChunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
      const encounter = await addEncounter([
        {
          name: 'Goblin Boss',
          count: 1,
          source: { type: 'npc-ref', artifactId: newId() },
        },
      ]);
      if (encounter.kind !== 'encounter') throw new Error('not an encounter');
      await expect(enqueueMobPortraits(encounter, campaignId)).rejects.toThrow('no longer exists');
      expect(useMobPortraitQueue.getState().queued).toHaveLength(0);
      void goblinChunkId;
    });
  });

  /**
   * A CONVERTED copy needs no pack (docs/17 row 269).
   *
   * The owner's rule is complete library isolation, and this was the last
   * portrait path that broke it: an `inline` roster row carrying the opaque
   * `originToken` was mapped back to a chunk id, so the worker read the pack's
   * chunk and THREW once it was gone — even though the row already owned the
   * library's bytes. The grounding now comes off the copy.
   *
   * WHAT THESE PINS PROVE, AND WHAT THEY CANNOT. jsdom generates no real
   * portrait (the image call is mocked), so they prove the GROUNDING SOURCE
   * (the copy's own block, with the chunk row DELETED so every library read
   * fails), the LOCAL-ONLY rule (a copy never reads or writes the global
   * `mobPortraits` slot, even when the slot is populated), the IDENTITY (the
   * copy keeps its `chunk:`-keyed portrait and its row) and the FAILURE ARM (an
   * UNCONVERTED pointer still reads the library, loudly, naming its missing
   * chunk). Image quality is not, and cannot be, asserted here.
   */
  describe('a CONVERTED copy needs no pack (docs/17 row 269)', () => {
    it('illustrates a copied roster mob with the library chunk DELETED, grounded on its own block', async () => {
      const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
      const copy = await copyCreatureStatsFromDb({ chunkId }, 'Goblin Boss');
      if (copy.status !== 'copied') throw new Error('the fixture chunk must copy');
      // THE PACK IS UNINSTALLED: the chunk row is gone, so ANY library read
      // fails. A portrait that still depends on it cannot pass this test.
      await db.chunks.delete(chunkId);
      const encounter = await addEncounter([
        {
          name: 'Goblin Boss',
          count: 1,
          source: { type: 'inline', statBlock: copy.copy.statBlock },
          sourceLine: copy.copy.sourceLine,
          originToken: copy.copy.originToken,
        },
      ]);
      if (encounter.kind !== 'encounter') throw new Error('not an encounter');

      const result = await enqueueMobPortraits(encounter, campaignId);
      expect(result).toEqual({ enqueued: 1, alreadyImaged: [] });
      const creatureKey = libraryCreatureKey(chunkId);
      // The job carries the copy's OWN block and NO chunkId: the pack is not a
      // fallback, it is absent from the job.
      const job = useMobPortraitQueue.getState().queued.find((row) => row.name === 'Goblin Boss');
      expect(job?.chunkId).toBeUndefined();
      expect(job?.statBlock).toEqual(copy.copy.statBlock);
      // IDENTITY UNCHANGED: the token stays the portrait key, exactly the key a
      // citation of this chunk wrote before the conversion.
      expect(job?.creatureKey).toBe(creatureKey);

      await waitFor(async () => {
        expect(await creaturePortraitArt(campaignId, creatureKey)).toBe('cover');
      });
      expect(generateImagesMock).toHaveBeenCalledTimes(1);
      // The grounding came off the COPY's parsed block (size/type identity plus
      // the text-render negative) — never the deleted chunk's raw text.
      const finalPrompt = generateImagesMock.mock.calls[0]?.[0] ?? '';
      expect(finalPrompt).toContain('Large');
      expect(finalPrompt).toContain('giant');
      expect(finalPrompt).not.toContain(GOBLIN_TEXT);
      expect(finalPrompt).not.toContain('59');
      expect(finalPrompt).toContain('Avoid: long paragraphs of text');
      // LOCAL-ONLY: a copy cannot know whether its citation was canonical
      // without the pack, so it never touches the global slot (docs/18 §5).
      expect(await getMobPortraitCacheEntry(creatureKey)).toBeUndefined();
      expect(await creatureCoverIdOf(campaignId, creatureKey)).not.toBeNull();
    });

    it('regenerates a copied mob’s EXISTING portrait with the chunk DELETED — identity stable, nothing republished', async () => {
      const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
      const copy = await copyCreatureStatsFromDb({ chunkId }, 'Goblin Boss');
      if (copy.status !== 'copied') throw new Error('the fixture chunk must copy');
      const creatureKey = libraryCreatureKey(chunkId);
      // The campaign ALREADY shows this creature's portrait — the identity the
      // copy kept. A regen must replace THOSE bytes, never abandon the row.
      const existing = await createImage({
        campaignId,
        blob: blobOf('old-copy-cover'),
        mimeType: 'image/png',
        width: 10,
        height: 10,
        source: 'uploaded',
      });
      await setCreatureCover({ campaignId, creatureKey, imageId: existing.id });
      await db.chunks.delete(chunkId);
      const encounter = await addEncounter([
        {
          name: 'Goblin Boss',
          count: 1,
          source: { type: 'inline', statBlock: copy.copy.statBlock },
          sourceLine: copy.copy.sourceLine,
          originToken: copy.copy.originToken,
        },
      ]);
      if (encounter.kind !== 'encounter') throw new Error('not an encounter');

      const result = await regenerateMobPortraits(encounter, campaignId);
      // LOCAL: the copy cannot claim the shared slot, so nothing is republished
      // (and the pre-phase reads no chunk at all — it does not throw).
      expect(result).toEqual({ regenerated: 1, republishedCanonical: [] });
      await waitFor(async () => {
        const coverId = await creatureCoverIdOf(campaignId, creatureKey);
        expect(coverId).not.toBeNull();
        expect(coverId).not.toBe(existing.id);
      });
      expect(generateImagesMock).toHaveBeenCalledTimes(1);
      const fresh = await creatureCoverIdOf(campaignId, creatureKey);
      const stored = await getImage(fresh ?? '');
      // A FRESH local generation landed (this describe's intake mock names its
      // output 'intake'), replacing the uploaded 'old-copy-cover' bytes.
      expect(new TextDecoder().decode(stored?.bytes ?? new Uint8Array())).toBe('intake');
      expect(await getMobPortraitCacheEntry(creatureKey)).toBeUndefined();

      // The CONFIRM count tells the same truth: not shared, not unreadable.
      const plan = await planMobPortraitBatch(encounter, campaignId);
      expect(plan.imaged).toEqual(['Goblin Boss']);
      expect(plan.missing).toEqual([]);
      expect(plan.sharedPortraitNames).toEqual([]);
      expect(plan.unreadableCitations).toEqual([]);
    });

    it('NEVER clones a POPULATED global slot for a copied row (the rejected alternative, docs/18 §5)', async () => {
      const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
      const copy = await copyCreatureStatsFromDb({ chunkId }, 'Goblin Boss');
      if (copy.status !== 'copied') throw new Error('the fixture chunk must copy');
      const creatureKey = libraryCreatureKey(chunkId);
      // A canonical portrait for this creature EXISTS in the global cache.
      const canonical = await createImage({
        campaignId: null,
        blob: blobOf('canonical-bytes'),
        mimeType: 'image/png',
        width: 8,
        height: 8,
        source: 'generated',
      });
      const seated = await storeCanonicalPortraitIfAbsent(creatureKey, canonical);
      expect(seated.stored).toBe(true);
      await db.chunks.delete(chunkId);
      const encounter = await addEncounter([
        {
          name: 'Goblin Boss',
          count: 1,
          source: { type: 'inline', statBlock: copy.copy.statBlock },
          sourceLine: copy.copy.sourceLine,
          originToken: copy.copy.originToken,
        },
      ]);
      if (encounter.kind !== 'encounter') throw new Error('not an encounter');

      await enqueueMobPortraits(encounter, campaignId);
      await waitFor(async () => {
        expect(await creaturePortraitArt(campaignId, creatureKey)).toBe('cover');
      });
      // A CLONE would have spent no generation and landed the slot's bytes; the
      // copy generates LOCALLY instead (a flavored copy must never be handed the
      // canonical creature's art — the silent wrong-art outcome this rejects).
      expect(generateImagesMock).toHaveBeenCalledTimes(1);
      const coverId = await creatureCoverIdOf(campaignId, creatureKey);
      const stored = await getImage(coverId ?? '');
      const landed = new TextDecoder().decode(stored?.bytes ?? new Uint8Array());
      // This describe's intake mock names its output 'intake' — the discriminating
      // assertion is that the cover is NOT the slot's 'canonical-bytes'.
      expect(landed).toBe('intake');
      expect(landed).not.toBe('canonical-bytes');
      // The slot is untouched — neither read into a cover nor overwritten.
      expect((await getMobPortraitCacheEntry(creatureKey))?.imageId).toBe(canonical.id);
    });

    it('illustrates a COPIED cast NPC with the chunk DELETED — on the artifact’s own cover, no pack', async () => {
      const chunkId = await seedCreatureChunk('Zombie', GOBLIN_TEXT);
      const copy = await copyCreatureStatsFromDb({ chunkId }, 'Zombie');
      if (copy.status !== 'copied') throw new Error('the fixture chunk must copy');
      const npc = await createArtifact({
        campaignId,
        kind: 'npc',
        name: 'Gustav the Zombie',
        data: {
          appearance: '',
          personality: '',
          statBlock: copy.copy.statBlock,
          sourceLine: copy.copy.sourceLine,
          originToken: copy.copy.originToken,
        },
      });
      await db.chunks.delete(chunkId);
      const encounter = await addEncounter([
        { name: 'Gustav the Zombie', count: 1, source: { type: 'npc-ref', artifactId: npc.id } },
      ]);
      if (encounter.kind !== 'encounter') throw new Error('not an encounter');

      const result = await enqueueMobPortraits(encounter, campaignId);
      expect(result).toEqual({ enqueued: 1, alreadyImaged: [] });
      const job = useMobPortraitQueue
        .getState()
        .queued.find((row) => row.name === 'Gustav the Zombie');
      expect(job?.chunkId).toBeUndefined();
      expect(job?.statBlock).toEqual(copy.copy.statBlock);
      // A cast creature's portrait lands on its OWN cover (the artifactId arm).
      expect(job?.artifactId).toBe(npc.id);

      await waitFor(async () => {
        const stored = await getAnyArtifact(npc.id);
        expect(stored?.coverImageId ?? null).not.toBeNull();
      });
      expect(generateImagesMock).toHaveBeenCalledTimes(1);
      expect(await getMobPortraitCacheEntry(libraryCreatureKey(chunkId))).toBeUndefined();
    });
  });
});

describe('single-mob-portrait-queue.test.ts', () => {
  /**
   * Single-creature portrait entry points (battle surface selection card,
   * docs/11 D5 amendment): the SAME queue and the SAME regen phases as the editor
   * batch, for ONE already-resolved token → CREATURE IDENTITY target — no second
   * pipeline, no second replace path. Delete-after-replace (preservation rule):
   * the old portrait survives until the fresh one commits; failures and dropped
   * queues keep it intact with loud errors.
   *
   * REWRITTEN for the ratified model (ledger row 106): the old fixture created a
   * hidden `npc` artifact per creature and asserted on THAT artifact's cover plus
   * its revision snapshots. Under the model the portrait is this campaign's
   * presentation row for the creature identity (`db/creatureImages`), and there
   * are no revisions to snapshot — so preservation is now pinned the way the seam
   * actually guarantees it: the superseded BLOB stays readable (still pinned)
   * while the replacement is in flight, and is freed exactly when the fresh
   * portrait commits. Strictly stronger: it reads the real invariant rather than
   * a revision that happened to name it.
   */

  const chatMock = vi.mocked(chat);

  const generateImagesMock = vi.mocked(generateImages);

  const intakeImageMock = vi.mocked(intakeImage);

  const toastErrorMock = vi.mocked(toastError);

  const GOBLIN_TEXT = 'Goblin Boss, humanoid, agile commander. HP 21, AC 17.';

  function blobOf(text: string): Blob {
    return new Blob([text], { type: 'image/png' });
  }

  let campaignId = '';
  let generationCount = 0;

  async function seedCreatureChunk(creatureName: string, text: string): Promise<string> {
    const book = await createRulebook({
      title: 'Bestiary',
      system: 'dnd5e',
      filename: 'bestiary.pdf',
    });
    await putChunks([
      ruleChunkSchema.parse({
        ...stampNewEntity(),
        bookId: book.id,
        pageStart: 12,
        pageEnd: 12,
        chunkType: 'statblock',
        headingPath: [creatureName],
        text,
        statBlock: statBlockSchema.parse({
          system: 'dnd5e',
          level: '2',
          size: 'Large',
          creatureType: 'giant',
          ac: 11,
          acNote: '',
          hp: 59,
          hpFormula: '7d10 + 21',
          speed: '40 ft.',
          abilities: { str: 20, dex: 8, con: 16, int: 5, wis: 7, cha: 7 },
          saves: '',
          skills: '',
          senses: 'darkvision 60 ft.',
          languages: 'Common, Giant',
          traits: [],
          actions: [],
          reactions: [],
          legendary: [],
          extras: {},
        }),
        contentHash: await sha256Hex(text),
      }),
    ]);
    const { db } = await import('@/db/db');
    const chunk = await db.chunks.where('bookId').equals(book.id).first();
    if (chunk === undefined) throw new Error('chunk missing');
    return chunk.id;
  }

  /** The identity of the creature a cited chunk IS (the citing name is flavor
   * only — identity is the citation). */
  function creatureKeyForChunk(chunkId: string, _citingName: string): string {
    return libraryCreatureKey(chunkId);
  }

  /** Seats an uploaded portrait on the campaign's presentation row for one
   * creature identity — the ONE way a creature carries art, with no artifact in
   * sight (docs/11 D5 amendment, D6). */
  async function attachUploadedCover(creatureKey: string): Promise<string> {
    const existing = await createImage({
      campaignId,
      blob: blobOf('old-cover'),
      mimeType: 'image/png',
      width: 10,
      height: 10,
      source: 'uploaded',
    });
    await setCreatureCover({ campaignId, creatureKey, imageId: existing.id });
    return existing.id;
  }

  /** The creature's CURRENT portrait image id, read through the ONE identity
   * seam (`null` when it has no art). */
  function portraitId(creatureKey: string): Promise<string | null> {
    return creatureCoverImageId({ campaignId, creatureKey });
  }

  async function bytesText(imageId: string): Promise<string | null> {
    const stored = await getImage(imageId);
    if (stored === undefined) return null;
    return new TextDecoder().decode(stored.bytes);
  }

  /** True while the given blob is still on disk — the presentation-tier stand-in
   * for the old revision-snapshot pin: the superseded portrait's bytes stay
   * referenced (readable) until the replacement commits, then are freed. */
  async function blobLive(imageId: string): Promise<boolean> {
    return (await getImage(imageId)) !== undefined;
  }

  /** Hangs the NEXT fresh generation until released (abort still rejects, so
   * `cancelAll` withdraws it silently) — deterministic while-queued pins. */
  function hangGeneration(releaseBytes: string): { release: () => void } {
    let release!: () => void;
    generateImagesMock.mockImplementationOnce((_prompt, _count, opts) => {
      const signal = (opts as { signal?: AbortSignal } | undefined)?.signal;
      return new Promise((resolve, reject) => {
        if (signal === undefined) {
          reject(new Error('no abort signal passed'));
          return;
        }
        if (signal.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        signal.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
        release = () => {
          resolve({
            images: [blobOf(releaseBytes)],
            costUsd: 0.01,
            cappedToOne: false,
            modelUsed: 'test-image-model',
            fallback: null,
            filteredCount: 0,
          });
        };
      });
    });
    return {
      release: () => {
        release();
      },
    };
  }

  beforeEach(async () => {
    await clearDatabase();
    await seedBuiltInPersonas();
    await updateSettings({ imagesEnabled: true, imageModel: 'test-image-model' });
    chatMock.mockReset();
    generateImagesMock.mockReset();
    intakeImageMock.mockReset();
    toastErrorMock.mockReset();
    __clearPendingMobPortraitGenerationsForTests();
    useMobPortraitQueue.getState().reset();
    useProgressStore.getState().reset();
    generationCount = 0;
    generateImagesMock.mockImplementation(() => {
      generationCount += 1;
      return Promise.resolve({
        images: [blobOf(`gen-${String(generationCount)}`)],
        costUsd: 0.01,
        cappedToOne: false,
        modelUsed: 'test-image-model',
        fallback: null,
        filteredCount: 0,
      });
    });
    intakeImageMock.mockImplementation((blob: Blob) =>
      Promise.resolve({
        blob,
        mimeType: 'image/webp',
        width: 320,
        height: 240,
      }),
    );
    campaignId = (await createCampaign({ name: 'Single mob portrait', system: 'dnd5e' })).id;
  });

  describe('enqueueSingleMobPortrait', () => {
    it('enqueues one chunk-grounded job; the worker lands the cover on the artifact', async () => {
      const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
      const creatureKey = creatureKeyForChunk(chunkId, 'Goblin Boss');

      enqueueSingleMobPortrait({ campaignId, creatureKey, chunkId, name: 'Goblin Boss' });

      await waitFor(async () => {
        expect(await portraitId(creatureKey)).not.toBeNull();
      });
      expect(generateImagesMock).toHaveBeenCalledTimes(1);
      expect(chatMock).not.toHaveBeenCalled();
      expect(await bytesText((await portraitId(creatureKey)) ?? '')).toBe('gen-1');
      expect(useMobPortraitQueue.getState().queued).toHaveLength(0);
    });

    it('dedupes against an identical in-flight job (same artifact-keyed dock entry)', () => {
      enqueueSingleMobPortrait({
        campaignId,
        creatureKey: `chunk:${newId()}`,
        chunkId: newId(),
        name: 'Kept',
      });
      expect(useMobPortraitQueue.getState().queued).toHaveLength(1);
    });

    it('throws loud on an empty citing name instead of enqueueing a nameless job', () => {
      expect(() => {
        enqueueSingleMobPortrait({
          campaignId,
          creatureKey: `chunk:${newId()}`,
          chunkId: newId(),
          name: '   ',
        });
      }).toThrow(/citing name is empty/);
      expect(useMobPortraitQueue.getState().queued).toHaveLength(0);
    });
  });

  describe('regenerateSingleMobPortrait', () => {
    it('regenerates a canonical cover delete-after-replace: fresh slot bytes, old cover live until the force-clone commits', async () => {
      const chunkId = await seedCreatureChunk('Ogre', 'Ogre, big and rude. HP 59, AC 11.');
      const creatureKey = creatureKeyForChunk(chunkId, 'Ogre');
      // Populate the slot + cover through the normal canonical flow first.
      enqueueSingleMobPortrait({ campaignId, creatureKey, chunkId, name: 'Ogre' });
      await waitFor(async () => {
        expect(await portraitId(creatureKey)).not.toBeNull();
      });
      const slotBefore = await getMobPortraitCacheEntry(creatureKey);
      if (slotBefore === undefined) throw new Error('slot missing');
      const oldCover = (await portraitId(creatureKey)) ?? '';
      expect(await bytesText(oldCover)).toBe('gen-1');

      // Serialize the pump behind a blocker: the regen's force-clone commits
      // no generation, so only a blocker gates the while-queued pins.
      await updateSettings({ maxParallelRequests: 1 });
      const blocker = hangGeneration('blocker-bytes');
      const decoyChunkId = await seedCreatureChunk(
        'Decoy Drake',
        'Decoy Drake, scaly. HP 10, AC 10.',
      );
      const decoyKey = creatureKeyForChunk(decoyChunkId, 'Decoy Drake');
      enqueueSingleMobPortrait({
        campaignId,
        creatureKey: decoyKey,
        chunkId: decoyChunkId,
        name: 'Decoy Drake',
      });
      await waitFor(() => {
        expect(useMobPortraitQueue.getState().active).toHaveLength(1);
      });

      const result = await regenerateSingleMobPortrait({
        campaignId,
        creatureKey,
        chunkId,
        name: 'Ogre',
      });
      expect(result).toEqual({ regenerated: true, republishedCanonical: true });
      // Fresh bytes were spent (no-op re-clone would have generated nothing).
      expect(generateImagesMock).toHaveBeenCalledTimes(3);
      expect(chatMock).not.toHaveBeenCalled();
      // The slot now points at a fresh row; the superseded slot blob is freed.
      const slotAfter = await getMobPortraitCacheEntry(creatureKey);
      expect(slotAfter?.imageId).not.toBe(slotBefore.imageId);
      expect(await bytesText(slotAfter?.imageId ?? '')).toBe('gen-2');
      expect(await getImage(slotBefore.imageId)).toBeUndefined();
      // …while the old LOCAL cover is still live behind the blocker.
      expect(await portraitId(creatureKey)).toBe(oldCover);
      expect(await bytesText(oldCover)).toBe('gen-1');
      expect(await blobLive(oldCover)).toBe(true);
      expect(useMobPortraitQueue.getState().queued).toHaveLength(1);

      blocker.release();
      // The regen force-clones the NEW slot bytes over the old cover; only
      // then is the superseded local blob freed.
      await waitFor(async () => {
        const cover = await portraitId(creatureKey);
        expect(cover).not.toBeNull();
        expect(cover).not.toBe(oldCover);
      });
      const cover = (await portraitId(creatureKey)) ?? '';
      expect(await bytesText(cover)).toBe('gen-2');
      expect(await getImage(oldCover)).toBeUndefined();
      expect(await blobLive(oldCover)).toBe(false);
    });

    it('regenerates a flavored cover locally: old cover live until the fresh cover commits, cache untouched', async () => {
      const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
      const creatureKey = creatureKeyForChunk(chunkId, 'sickly goblin boss');
      const oldCoverId = await attachUploadedCover(creatureKey);
      // Hang the worker's fresh generation for deterministic while-queued pins.
      const hung = hangGeneration('gen-1');

      const result = await regenerateSingleMobPortrait({
        campaignId,
        creatureKey,
        chunkId,
        name: 'sickly goblin boss',
      });
      expect(result).toEqual({ regenerated: true, republishedCanonical: false });
      expect(await portraitId(creatureKey)).toBe(oldCoverId);
      expect(await bytesText(oldCoverId)).toBe('old-cover');
      expect(await blobLive(oldCoverId)).toBe(true);
      const hungState = useMobPortraitQueue.getState();
      expect(hungState.queued.length + hungState.active.length).toBe(1);
      // The worker is inside the hung generation — now let it commit.
      await waitFor(() => {
        expect(generateImagesMock).toHaveBeenCalledTimes(1);
      });

      hung.release();
      await waitFor(async () => {
        const cover = await portraitId(creatureKey);
        expect(cover).not.toBeNull();
        expect(cover).not.toBe(oldCoverId);
      });
      expect(await bytesText((await portraitId(creatureKey)) ?? '')).toBe('gen-1');
      expect(await getImage(oldCoverId)).toBeUndefined();
      expect(await blobLive(oldCoverId)).toBe(false);
      expect(generateImagesMock).toHaveBeenCalledTimes(1);
      expect(chatMock).not.toHaveBeenCalled();
      expect(await getMobPortraitCacheEntry(creatureKey)).toBeUndefined();
    });

    it('a failed single fresh generation keeps the old cover: loud error, blob + snapshot pins intact', async () => {
      const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
      const creatureKey = creatureKeyForChunk(chunkId, 'sickly goblin boss');
      const oldCoverId = await attachUploadedCover(creatureKey);
      generateImagesMock.mockRejectedValueOnce(new Error('model exploded'));

      const result = await regenerateSingleMobPortrait({
        campaignId,
        creatureKey,
        chunkId,
        name: 'sickly goblin boss',
      });
      expect(result).toEqual({ regenerated: true, republishedCanonical: false });

      await waitFor(() => {
        expect(useMobPortraitQueue.getState().failed).toHaveLength(1);
      });
      expect(toastErrorMock).toHaveBeenCalledWith(
        'Could not generate a portrait for "sickly goblin boss"',
        expect.any(Error),
      );
      expect(await portraitId(creatureKey)).toBe(oldCoverId);
      expect(await bytesText(oldCoverId)).toBe('old-cover');
      expect(await blobLive(oldCoverId)).toBe(true);
    });

    it('a failed canonical republish throws loud BEFORE enqueueing — the old cover stays', async () => {
      const chunkId = await seedCreatureChunk('Ogre', 'Ogre, big and rude. HP 59, AC 11.');
      const creatureKey = creatureKeyForChunk(chunkId, 'Ogre');
      const oldCoverId = await attachUploadedCover(creatureKey);
      generateImagesMock.mockRejectedValueOnce(new Error('slot generation exploded'));

      await expect(
        regenerateSingleMobPortrait({ campaignId, creatureKey, chunkId, name: 'Ogre' }),
      ).rejects.toThrow('slot generation exploded');
      expect(generateImagesMock).toHaveBeenCalledTimes(1);
      expect(useMobPortraitQueue.getState().queued).toHaveLength(0);
      expect(await portraitId(creatureKey)).toBe(oldCoverId);
      expect(await bytesText(oldCoverId)).toBe('old-cover');
      expect(await blobLive(oldCoverId)).toBe(true);
      expect(await getMobPortraitCacheEntry(creatureKey)).toBeUndefined();
    });

    it('a dropped single queue keeps the old cover', async () => {
      const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
      const creatureKey = creatureKeyForChunk(chunkId, 'sickly goblin boss');
      const oldCoverId = await attachUploadedCover(creatureKey);
      hangGeneration('gen-never');

      const result = await regenerateSingleMobPortrait({
        campaignId,
        creatureKey,
        chunkId,
        name: 'sickly goblin boss',
      });
      expect(result).toEqual({ regenerated: true, republishedCanonical: false });
      await waitFor(() => {
        expect(useMobPortraitQueue.getState().active).toHaveLength(1);
      });
      await useMobPortraitQueue.getState().cancelAll();

      expect(toastErrorMock).not.toHaveBeenCalled();
      expect(await portraitId(creatureKey)).toBe(oldCoverId);
      expect(await bytesText(oldCoverId)).toBe('old-cover');
      expect(await blobLive(oldCoverId)).toBe(true);
    });

    it('reports unregenerated (no detach, no job) when the cover already landed elsewhere', async () => {
      const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
      const creatureKey = creatureKeyForChunk(chunkId, 'Goblin Boss');

      const result = await regenerateSingleMobPortrait({
        campaignId,
        creatureKey,
        chunkId,
        name: 'Goblin Boss',
      });
      expect(result).toEqual({ regenerated: false, republishedCanonical: false });
      expect(generateImagesMock).not.toHaveBeenCalled();
      expect(useMobPortraitQueue.getState().queued).toHaveLength(0);
    });

    it('reports no regeneration for a creature identity that holds no portrait (nothing to detach)', async () => {
      const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
      const result = await regenerateSingleMobPortrait({
        campaignId,
        creatureKey: libraryCreatureKey(chunkId),
        chunkId,
        name: 'Goblin Boss',
      });
      expect(result).toEqual({ regenerated: false, republishedCanonical: false });
      expect(generateImagesMock).not.toHaveBeenCalled();
      expect(useMobPortraitQueue.getState().queued).toHaveLength(0);
    });

    it('throws loud, changing nothing, on an empty creature identity', async () => {
      const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
      await expect(
        regenerateSingleMobPortrait({
          campaignId,
          creatureKey: '   ',
          chunkId,
          name: 'Goblin Boss',
        }),
      ).rejects.toThrow(/creature identity is empty/);
      expect(generateImagesMock).not.toHaveBeenCalled();
    });

    it('throws loud with the old cover intact when the chunk is unreadable', async () => {
      const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
      const creatureKey = creatureKeyForChunk(chunkId, 'Goblin Boss');
      const oldCoverId = await attachUploadedCover(creatureKey);

      await expect(
        regenerateSingleMobPortrait({
          campaignId,
          creatureKey,
          chunkId: newId(),
          name: 'Goblin Boss',
        }),
      ).rejects.toThrow(/stat-block chunk.*no longer exists/);
      expect(await portraitId(creatureKey)).toBe(oldCoverId);
      expect(generateImagesMock).not.toHaveBeenCalled();
      expect(useMobPortraitQueue.getState().queued).toHaveLength(0);
    });
  });
});

describe('mob-portrait-regen.test.ts', () => {
  /**
   * Portrait regeneration (owner-ordered, docs/11 D5 amendment + preservation
   * rule): delete-after-replace — regen entries enqueue fresh-generation jobs
   * WITHOUT detaching first; the old cover (blob + snapshot pins) survives
   * until the worker commits the replacement, and only the superseded blob is
   * freed. Canonical slots are republished with FRESH bytes first (a plain
   * re-enqueue would clone identical bytes); flavored and invented covers
   * regenerate locally only. The prompt draft stays deterministic (no chat
   * call) on every regen path.
   */

  const chatMock = vi.mocked(chat);

  const generateImagesMock = vi.mocked(generateImages);

  const intakeImageMock = vi.mocked(intakeImage);

  const toastErrorMock = vi.mocked(toastError);

  const GOBLIN_TEXT = 'Goblin Boss, humanoid, agile commander. HP 21, AC 17.';

  function blobOf(text: string): Blob {
    return new Blob([text], { type: 'image/png' });
  }

  let campaignId = '';
  let generationCount = 0;

  function oozeBlock() {
    return statBlockSchema.parse({
      system: 'dnd5e',
      level: '2',
      size: 'Medium',
      creatureType: 'ooze',
      ac: 8,
      acNote: '',
      hp: 45,
      hpFormula: '6d10 + 12',
      speed: '20 ft.',
      abilities: { str: 14, dex: 6, con: 16, int: 1, wis: 6, cha: 1 },
      saves: '',
      skills: '',
      senses: 'blindsight 60 ft.',
      languages: '',
      traits: [],
      actions: [],
      reactions: [],
      legendary: [],
      extras: {},
    });
  }

  async function seedCreatureChunk(creatureName: string, text: string): Promise<string> {
    const book = await createRulebook({
      title: 'Bestiary',
      system: 'dnd5e',
      filename: 'bestiary.pdf',
    });
    await putChunks([
      ruleChunkSchema.parse({
        ...stampNewEntity(),
        bookId: book.id,
        pageStart: 12,
        pageEnd: 12,
        chunkType: 'statblock',
        headingPath: [creatureName],
        text,
        statBlock: statBlockSchema.parse({
          system: 'dnd5e',
          level: '2',
          size: 'Large',
          creatureType: 'giant',
          ac: 11,
          acNote: '',
          hp: 59,
          hpFormula: '7d10 + 21',
          speed: '40 ft.',
          abilities: { str: 20, dex: 8, con: 16, int: 5, wis: 7, cha: 7 },
          saves: '',
          skills: '',
          senses: 'darkvision 60 ft.',
          languages: 'Common, Giant',
          traits: [],
          actions: [],
          reactions: [],
          legendary: [],
          extras: {},
        }),
        contentHash: await sha256Hex(text),
      }),
    ]);
    const { db } = await import('@/db/db');
    const chunk = await db.chunks.where('bookId').equals(book.id).first();
    if (chunk === undefined) throw new Error('chunk missing');
    return chunk.id;
  }

  async function addEncounter(
    monsters: {
      name: string;
      count: number;
      source: Record<string, unknown>;
      notes?: string;
      originToken?: string;
    }[],
    /** Another campaign (canonical-slot tests build the same shape there). */
    campaign: string = campaignId,
  ) {
    return createArtifact({
      campaignId: campaign,
      kind: 'encounter',
      name: 'Goblin warren',
      data: {
        difficulty: 'medium',
        levelHint: '1',
        monsters: monsters.map((monster) => ({
          name: monster.name,
          count: monster.count,
          // An invented creature's prose IS its roster notes: with no artifact
          // and no chunk to read, the notes are the only description the portrait
          // prompt can be grounded in (docs/11 D5 amendment) — an empty one is
          // refused by the prompt contract, which is why an invented test entry
          // that expects a portrait must carry notes.
          notes: monster.notes ?? '',
          source: monster.source,
          ...(monster.originToken === undefined ? {} : { originToken: monster.originToken }),
        })) as EncounterArtifactData['monsters'],
        terrain: '',
        tactics: '',
        treasure: '',
        mapImageId: null,
        layout: null,
        preset: 'standard',
        locationKind: 'other',
        siteShape: 'single',
        budgetAdvisory: '',
      },
    });
  }

  /**
   * REWRITTEN for the ratified model (ledger row 106): a creature portrait hangs
   * off the campaign's CREATURE IDENTITY (docs/11 D6), so this writes the
   * per-campaign presentation row instead of an artifact cover. The call shape is
   * unchanged — `(key, campaign)` — because the identity IS the key now.
   */
  async function attachUploadedCover(creatureKey: string, campaign: string): Promise<string> {
    const existing = await createImage({
      campaignId: campaign,
      blob: blobOf('old-cover'),
      mimeType: 'image/png',
      width: 10,
      height: 10,
      source: 'uploaded',
    });
    await setCreatureCover({ campaignId: campaign, creatureKey, imageId: existing.id });
    return existing.id;
  }

  /**
   * The creature's portrait IN ONE CAMPAIGN — through the PRODUCTION seam
   * (`creatureCoverImageId`), never by poking the table: a test that reads the
   * store directly can pass while the seam a caller actually uses is broken.
   */
  async function creatureCover(creatureKey: string, campaign: string): Promise<string | null> {
    return creatureCoverImageId({ campaignId: campaign, creatureKey });
  }

  /** Whether an image row still exists — the preservation invariant for a
   * creature portrait. A creature has no artifact and therefore NO revision
   * history, so there is no snapshot to keep the blob alive: the blob itself is
   * the whole proof that "the old art stays until the new art lands" holds. */
  async function blobLive(imageId: string): Promise<boolean> {
    return (await getImage(imageId)) !== undefined;
  }

  async function bytesText(imageId: string): Promise<string | null> {
    const stored = await getImage(imageId);
    if (stored === undefined) return null;
    return new TextDecoder().decode(stored.bytes);
  }

  /** Hangs the NEXT fresh generation until released (abort still rejects, so
   * `cancelAll` withdraws it silently). Lets a test pin the while-queued
   * preservation state deterministically: the worker cannot commit while hung.
   * Resolves with `releaseBytes` so byte assertions stay exact. */
  function hangGeneration(releaseBytes: string): { release: () => void } {
    let release!: () => void;
    generateImagesMock.mockImplementationOnce((_prompt, _count, opts) => {
      const signal = (opts as { signal?: AbortSignal } | undefined)?.signal;
      return new Promise((resolve, reject) => {
        if (signal === undefined) {
          reject(new Error('no abort signal passed'));
          return;
        }
        if (signal.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        signal.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
        release = () => {
          resolve({
            images: [blobOf(releaseBytes)],
            costUsd: 0.01,
            cappedToOne: false,
            modelUsed: 'test-image-model',
            fallback: null,
            filteredCount: 0,
          });
        };
      });
    });
    return {
      release: () => {
        release();
      },
    };
  }

  beforeEach(async () => {
    await clearDatabase();
    await seedBuiltInPersonas();
    await updateSettings({ imagesEnabled: true, imageModel: 'test-image-model' });
    chatMock.mockReset();
    generateImagesMock.mockReset();
    intakeImageMock.mockReset();
    toastErrorMock.mockReset();
    __clearPendingMobPortraitGenerationsForTests();
    useMobPortraitQueue.getState().reset();
    useProgressStore.getState().reset();
    generationCount = 0;
    // Distinct bytes per generation: fresh-byte assertions compare stored bytes.
    generateImagesMock.mockImplementation(() => {
      generationCount += 1;
      return Promise.resolve({
        images: [blobOf(`gen-${String(generationCount)}`)],
        costUsd: 0.01,
        cappedToOne: false,
        modelUsed: 'test-image-model',
        fallback: null,
        filteredCount: 0,
      });
    });
    // Echo intake: stored bytes identify the generation that produced them.
    intakeImageMock.mockImplementation((blob: Blob) =>
      Promise.resolve({
        blob,
        mimeType: 'image/webp',
        width: 320,
        height: 240,
      }),
    );
    campaignId = (await createCampaign({ name: 'Mob portraits', system: 'dnd5e' })).id;
  });

  describe('regenerateMobPortraits (rulebook)', () => {
    it('regenerates a flavored cover locally: old cover survives until the fresh cover commits, only the superseded blob is freed', async () => {
      const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
      const artifactId = libraryCreatureKey(chunkId);
      const oldCoverId = await attachUploadedCover(artifactId, campaignId);
      const encounter = await addEncounter([
        {
          name: 'sickly goblin boss',
          count: 1,
          source: { type: 'none' as const },
          originToken: artifactId,
        },
      ]);
      if (encounter.kind !== 'encounter') throw new Error('not an encounter');
      // Hang the worker's fresh generation: the while-queued pins below are
      // deterministic (the replacement cannot commit before the release).
      const hung = hangGeneration('gen-1');

      const result = await regenerateMobPortraits(encounter, campaignId);
      expect(result).toEqual({ regenerated: 1, republishedCanonical: [] });
      // Delete-after-replace: NOTHING is stripped synchronously — the old
      // cover, its blob, and its snapshot pins are all intact while the regen
      // job is queued (a dropped queue loses nothing).
      expect(await creatureCover(artifactId, campaignId)).toBe(oldCoverId);
      expect(await bytesText(oldCoverId)).toBe('old-cover');
      expect(await blobLive(oldCoverId)).toBe(true);
      // The regen job is queued or already picked up — but cannot have
      // finished while its generation is hung.
      const state = useMobPortraitQueue.getState();
      expect(state.queued.length + state.active.length).toBe(1);
      // The worker is inside the hung generation (its mock call assigned the
      // releaser above) — now let it commit.
      await waitFor(() => {
        expect(generateImagesMock).toHaveBeenCalledTimes(1);
      });

      hung.release();
      await waitFor(async () => {
        expect(await creatureCover(artifactId, campaignId)).not.toBeNull();
        expect(await creatureCover(artifactId, campaignId)).not.toBe(oldCoverId);
      });
      // The fresh cover landed on the campaign's PRESENTATION row (no creature
      // artifact exists to hold it) — the same seam every renderer reads.
      expect(await bytesText((await creatureCover(artifactId, campaignId)) ?? '')).toBe('gen-1');
      // The success path frees ONLY the superseded blob — and only after the
      // fresh cover committed (its snapshot pins are scrubbed with the swap).
      expect(await getImage(oldCoverId)).toBeUndefined();
      expect(await blobLive(oldCoverId)).toBe(false);
      // One local generation, no chat call, and the global slot stays empty
      // (flavored citations never read, populate, or overwrite the cache).
      expect(generateImagesMock).toHaveBeenCalledTimes(1);
      expect(chatMock).not.toHaveBeenCalled();
      expect(await getMobPortraitCacheEntry(libraryCreatureKey(chunkId))).toBeUndefined();
    });

    it('a failed fresh generation keeps the old cover: loud error, blob + snapshot pins intact', async () => {
      const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
      const artifactId = libraryCreatureKey(chunkId);
      const oldCoverId = await attachUploadedCover(artifactId, campaignId);
      const encounter = await addEncounter([
        {
          name: 'sickly goblin boss',
          count: 1,
          source: { type: 'none' as const },
          originToken: artifactId,
        },
      ]);
      if (encounter.kind !== 'encounter') throw new Error('not an encounter');
      generateImagesMock.mockRejectedValueOnce(new Error('model exploded'));

      const result = await regenerateMobPortraits(encounter, campaignId);
      expect(result).toEqual({ regenerated: 1, republishedCanonical: [] });

      // The worker fails LOUD on the queue's per-mob path (name + reason) and
      // lands on the retry list — while the old portrait is untouched.
      await waitFor(() => {
        expect(useMobPortraitQueue.getState().failed).toHaveLength(1);
      });
      expect(toastErrorMock).toHaveBeenCalledWith(
        'Could not generate a portrait for "sickly goblin boss"',
        expect.any(Error),
      );
      expect((toastErrorMock.mock.calls[0]?.[1] as Error).message).toContain('model exploded');
      expect(await creatureCover(artifactId, campaignId)).toBe(oldCoverId);
      expect(await bytesText(oldCoverId)).toBe('old-cover');
      expect(await blobLive(oldCoverId)).toBe(true);
    });

    it('a queue dropped before the worker runs keeps the old cover', async () => {
      const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
      const artifactId = libraryCreatureKey(chunkId);
      const oldCoverId = await attachUploadedCover(artifactId, campaignId);
      const encounter = await addEncounter([
        {
          name: 'sickly goblin boss',
          count: 1,
          source: { type: 'none' as const },
          originToken: artifactId,
        },
      ]);
      if (encounter.kind !== 'encounter') throw new Error('not an encounter');
      // Hang the fresh generation on the abort signal (in-memory queue lost on
      // reload behaves the same: the job never commits).
      hangGeneration('gen-never');

      await regenerateMobPortraits(encounter, campaignId);
      await waitFor(() => {
        expect(useMobPortraitQueue.getState().active).toHaveLength(1);
      });
      await useMobPortraitQueue.getState().cancelAll();

      // Silent withdraw, old portrait intact — no error, no strip, no commit.
      expect(toastErrorMock).not.toHaveBeenCalled();
      expect(await creatureCover(artifactId, campaignId)).toBe(oldCoverId);
      expect(await bytesText(oldCoverId)).toBe('old-cover');
      expect(await blobLive(oldCoverId)).toBe(true);
    });

    it('republishes a canonical slot with fresh bytes; other-campaign covers keep their cloned bytes', async () => {
      const chunkId = await seedCreatureChunk('Ogre', 'Ogre, big and rude. HP 59, AC 11.');
      const campaignB = (await createCampaign({ name: 'Second campaign', system: 'dnd5e' })).id;
      // Campaign B populates the slot through the normal canonical flow (one
      // generation, then a clone into its own cover).
      const artifactB = libraryCreatureKey(chunkId);
      const encounterB = await createArtifact({
        campaignId: campaignB,
        kind: 'encounter',
        name: 'Ogre den',
        data: {
          difficulty: 'medium',
          levelHint: '1',
          monsters: [
            {
              name: 'Ogre',
              count: 1,
              notes: '',
              source: { type: 'none' as const },
              originToken: artifactB,
            },
          ] as never,
          terrain: '',
          tactics: '',
          treasure: '',
          mapImageId: null,
          layout: null,
          preset: 'standard',
          locationKind: 'other',
          siteShape: 'single',
          budgetAdvisory: '',
        },
      });
      if (encounterB.kind !== 'encounter') throw new Error('not an encounter');
      await enqueueMobPortraits(encounterB, campaignB);
      await waitFor(async () => {
        expect(await creatureCover(artifactB, campaignB)).not.toBeNull();
      });
      const slotBefore = await getMobPortraitCacheEntry(libraryCreatureKey(chunkId));
      if (slotBefore === undefined) throw new Error('slot missing');
      const coverB = (await creatureCover(artifactB, campaignB)) ?? '';
      expect(await bytesText(coverB)).toBe('gen-1');

      // Campaign A holds a clone of the same slot bytes.
      const artifactA = libraryCreatureKey(chunkId);
      const encounterA = await addEncounter([
        { name: 'Ogre', count: 1, source: { type: 'none' as const }, originToken: artifactA },
      ]);
      if (encounterA.kind !== 'encounter') throw new Error('not an encounter');
      await enqueueMobPortraits(encounterA, campaignId);
      await waitFor(async () => {
        expect(await creatureCover(artifactA, campaignId)).not.toBeNull();
      });
      const oldCoverA = (await creatureCover(artifactA, campaignId)) ?? '';
      expect(await bytesText(oldCoverA)).toBe('gen-1');

      // Serialize the pump behind a blocker job: the regen job cannot run
      // before the preservation pins below (its force-clone commits no image
      // generation, so nothing else gates it deterministically).
      await updateSettings({ maxParallelRequests: 1 });
      const blocker = hangGeneration('blocker-bytes');
      const decoyChunkId = await seedCreatureChunk(
        'Decoy Drake',
        'Decoy Drake, scaly. HP 10, AC 10.',
      );
      const decoyArtifactId = libraryCreatureKey(decoyChunkId);
      useMobPortraitQueue.getState().enqueue([
        {
          campaignId,
          encounterId: encounterA.id,
          creatureKey: decoyArtifactId,
          artifactId: decoyArtifactId,
          name: 'Decoy Drake',
          chunkId: decoyChunkId,
        },
      ]);
      await waitFor(() => {
        expect(useMobPortraitQueue.getState().active).toHaveLength(1);
      });

      const result = await regenerateMobPortraits(encounterA, campaignId);
      expect(result).toEqual({ regenerated: 1, republishedCanonical: ['Ogre'] });
      // Fresh bytes were spent (no-op re-clone would have generated nothing).
      expect(generateImagesMock).toHaveBeenCalledTimes(3);
      expect(chatMock).not.toHaveBeenCalled();
      // The slot now points at a fresh row; the superseded global blob is gone.
      const slotAfter = await getMobPortraitCacheEntry(libraryCreatureKey(chunkId));
      expect(slotAfter?.imageId).not.toBe(slotBefore.imageId);
      expect(await getImage(slotBefore.imageId)).toBeUndefined();
      expect(await bytesText(slotAfter?.imageId ?? '')).toBe('gen-2');
      // Delete-after-replace: the old LOCAL cover is still live while the
      // regen job waits behind the blocker — blob and snapshot pins intact.
      expect(await creatureCover(artifactA, campaignId)).toBe(oldCoverA);
      expect(await bytesText(oldCoverA)).toBe('gen-1');
      expect(await blobLive(oldCoverA)).toBe(true);
      expect(useMobPortraitQueue.getState().queued).toHaveLength(1);

      blocker.release();

      // The regen job force-clones the NEW slot bytes over the old cover.
      await waitFor(async () => {
        const cover = await creatureCover(artifactA, campaignId);
        expect(cover).not.toBeNull();
        expect(cover).not.toBe(oldCoverA);
      });
      const coverA = (await creatureCover(artifactA, campaignId)) ?? '';
      expect(await bytesText(coverA)).toBe('gen-2');
      // Only now is the superseded local blob freed (snapshot pins scrubbed
      // with the swap).
      expect(await getImage(oldCoverA)).toBeUndefined();
      expect(await blobLive(oldCoverA)).toBe(false);

      // Other-campaign invariance: B's existing cover keeps its cloned bytes.
      expect(await creatureCover(artifactB, campaignB)).toBe(coverB);
      expect(await bytesText(coverB)).toBe('gen-1');

      // Future clones render the new art.
      const campaignC = (await createCampaign({ name: 'Third campaign', system: 'dnd5e' })).id;
      // REWRITTEN (ledger row 106): the old call asked the CREATION seam to
      // pre-fill a NEW artifact's cover from the cache (`fillCoverFromCache`).
      // Nothing is created now, so the equivalent is the citation itself: a
      // fresh campaign's first enumeration clones the canonical slot (D6).
      const artifactC = libraryCreatureKey(chunkId);
      const encounterC = await addEncounter(
        [{ name: 'Ogre', count: 1, source: { type: 'none' as const }, originToken: artifactC }],
        campaignC,
      );
      if (encounterC.kind !== 'encounter') throw new Error('not an encounter');
      await enqueueMobPortraits(encounterC, campaignC);
      // The clone is the WORKER's work, never the enumeration's: the batch clones
      // nothing while it counts (plan/run agreement), so the row appears when the
      // job commits — and the bytes are the slot's, with no fresh generation.
      await waitFor(async () => {
        expect(await creatureCover(artifactC, campaignC)).not.toBeNull();
      });
      expect(await bytesText((await creatureCover(artifactC, campaignC)) ?? '')).toBe('gen-2');
    });

    it('a failed canonical republish throws loud BEFORE enqueueing — the old cover stays', async () => {
      const chunkId = await seedCreatureChunk('Ogre', 'Ogre, big and rude. HP 59, AC 11.');
      const artifactId = libraryCreatureKey(chunkId);
      const oldCoverId = await attachUploadedCover(artifactId, campaignId);
      const encounter = await addEncounter([
        { name: 'Ogre', count: 1, source: { type: 'none' as const }, originToken: artifactId },
      ]);
      if (encounter.kind !== 'encounter') throw new Error('not an encounter');
      generateImagesMock.mockRejectedValueOnce(new Error('slot generation exploded'));

      await expect(regenerateMobPortraits(encounter, campaignId)).rejects.toThrow(
        'slot generation exploded',
      );
      // The fresh-bytes phase failed: no regen job was enqueued and the old
      // portrait — blob and snapshot pins — is intact.
      expect(generateImagesMock).toHaveBeenCalledTimes(1);
      expect(useMobPortraitQueue.getState().queued).toHaveLength(0);
      expect(await creatureCover(artifactId, campaignId)).toBe(oldCoverId);
      expect(await bytesText(oldCoverId)).toBe('old-cover');
      expect(await blobLive(oldCoverId)).toBe(true);
      expect(await getMobPortraitCacheEntry(libraryCreatureKey(chunkId))).toBeUndefined();
    });

    it('fails loud with no side effects when the stat-block chunk is gone — the old cover stays', async () => {
      const missingChunkId = newId();
      const artifactId = libraryCreatureKey(missingChunkId);
      const oldCoverId = await attachUploadedCover(artifactId, campaignId);
      const encounter = await addEncounter([
        {
          name: 'Ghost Boss',
          count: 1,
          source: { type: 'none' as const },
          originToken: artifactId,
        },
      ]);
      if (encounter.kind !== 'encounter') throw new Error('not an encounter');

      await expect(regenerateMobPortraits(encounter, campaignId)).rejects.toThrow(
        'the stat-block chunk for "Ghost Boss" no longer exists',
      );
      expect(generateImagesMock).not.toHaveBeenCalled();
      expect(await creatureCover(artifactId, campaignId)).toBe(oldCoverId);
      expect(await getImage(oldCoverId)).toBeDefined();
      expect(await blobLive(oldCoverId)).toBe(true);
      expect(useMobPortraitQueue.getState().queued).toHaveLength(0);
    });

    it('skip-path regression: the normal batch never strips an imaged mob', async () => {
      const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
      const artifactId = libraryCreatureKey(chunkId);
      const oldCoverId = await attachUploadedCover(artifactId, campaignId);
      const encounter = await addEncounter([
        {
          name: 'Goblin Boss',
          count: 1,
          source: { type: 'none' as const },
          originToken: artifactId,
        },
      ]);
      if (encounter.kind !== 'encounter') throw new Error('not an encounter');

      const result = await enqueueMobPortraits(encounter, campaignId);
      expect(result).toEqual({ enqueued: 0, alreadyImaged: ['Goblin Boss'] });
      expect(await creatureCover(artifactId, campaignId)).toBe(oldCoverId);
      expect(await getImage(oldCoverId)).toBeDefined();
      expect(generateImagesMock).not.toHaveBeenCalled();
      expect(useMobPortraitQueue.getState().queued).toHaveLength(0);
    });
  });

  describe('regenerateInventedCreaturePortraits', () => {
    it('replaces the invented cover delete-after-replace with fresh local bytes', async () => {
      const encounter = await addEncounter([
        {
          name: 'Gloom Ooze',
          count: 1,
          notes: 'A dripping gloom ooze, its body a standing wave of black tar.',
          source: { type: 'inline', statBlock: oozeBlock() },
        },
      ]);
      if (encounter.kind !== 'encounter') throw new Error('not an encounter');
      await enqueueInventedCreaturePortraits(encounter, campaignId);
      // An invented creature owns NO row (docs/11 D5): its portrait is keyed by
      // its own content identity, which is what the batch used to enqueue it.
      const createdKey = contentCreatureKey('Gloom Ooze', oozeBlock());
      await waitFor(async () => {
        expect(await creatureCover(createdKey, campaignId)).not.toBeNull();
      });
      const oldCoverId = (await creatureCover(createdKey, campaignId)) ?? '';
      expect(await bytesText(oldCoverId)).toBe('gen-1');
      // Hang the worker's fresh generation for deterministic while-queued pins.
      const hung = hangGeneration('gen-2');

      const result = await regenerateInventedCreaturePortraits(encounter, campaignId);
      expect(result).toEqual({ regenerated: 1 });
      // Delete-after-replace: the old cover stays live until the worker
      // commits the fresh one (a dropped queue loses nothing).
      expect(await creatureCover(createdKey, campaignId)).toBe(oldCoverId);
      expect(await bytesText(oldCoverId)).toBe('gen-1');
      expect(await blobLive(oldCoverId)).toBe(true);
      const hungState = useMobPortraitQueue.getState();
      expect(hungState.queued.length + hungState.active.length).toBe(1);
      // The initial batch generation (gen-1) plus the hung regen call: the
      // worker is inside the hung generation — now let it commit.
      await waitFor(() => {
        expect(generateImagesMock).toHaveBeenCalledTimes(2);
      });

      hung.release();
      await waitFor(async () => {
        const cover = await creatureCover(createdKey, campaignId);
        expect(cover).not.toBeNull();
        expect(cover).not.toBe(oldCoverId);
      });
      const cover = (await creatureCover(createdKey, campaignId)) ?? '';
      expect(await bytesText(cover)).toBe('gen-2');
      // Only the superseded blob is freed, after the fresh cover committed.
      expect(await getImage(oldCoverId)).toBeUndefined();
      expect(await blobLive(oldCoverId)).toBe(false);
      expect(generateImagesMock).toHaveBeenCalledTimes(2);
      expect(chatMock).not.toHaveBeenCalled();
    });

    it('a failed invented generation keeps the old cover: loud error, blob + snapshot pins intact', async () => {
      const encounter = await addEncounter([
        {
          name: 'Gloom Ooze',
          count: 1,
          notes: 'A dripping gloom ooze, its body a standing wave of black tar.',
          source: { type: 'none' as const },
        },
      ]);
      if (encounter.kind !== 'encounter') throw new Error('not an encounter');
      await enqueueInventedCreaturePortraits(encounter, campaignId);
      // An invented creature owns NO row (docs/11 D5): its portrait is keyed by
      // its own content identity, which is what the batch used to enqueue it.
      // A `none` entry has no stat block, so its identity is the name alone.
      const createdKey = contentCreatureKey('Gloom Ooze', null);
      await waitFor(async () => {
        expect(await creatureCover(createdKey, campaignId)).not.toBeNull();
      });
      const oldCoverId = (await creatureCover(createdKey, campaignId)) ?? '';
      generateImagesMock.mockRejectedValueOnce(new Error('model exploded'));

      const result = await regenerateInventedCreaturePortraits(encounter, campaignId);
      expect(result).toEqual({ regenerated: 1 });

      await waitFor(() => {
        expect(useMobPortraitQueue.getState().failed).toHaveLength(1);
      });
      expect(toastErrorMock).toHaveBeenCalledWith(
        'Could not generate a portrait for "Gloom Ooze"',
        expect.any(Error),
      );
      expect(await creatureCover(createdKey, campaignId)).toBe(oldCoverId);
      expect(await getImage(oldCoverId)).toBeDefined();
      expect(await blobLive(oldCoverId)).toBe(true);
    });

    it('a dropped invented queue keeps the old cover', async () => {
      const encounter = await addEncounter([
        {
          name: 'Gloom Ooze',
          count: 1,
          notes: 'A dripping gloom ooze, its body a standing wave of black tar.',
          source: { type: 'none' as const },
        },
      ]);
      if (encounter.kind !== 'encounter') throw new Error('not an encounter');
      await enqueueInventedCreaturePortraits(encounter, campaignId);
      // An invented creature owns NO row (docs/11 D5): its portrait is keyed by
      // its own content identity, which is what the batch used to enqueue it.
      // A `none` entry has no stat block, so its identity is the name alone.
      const createdKey = contentCreatureKey('Gloom Ooze', null);
      await waitFor(async () => {
        expect(await creatureCover(createdKey, campaignId)).not.toBeNull();
      });
      const oldCoverId = (await creatureCover(createdKey, campaignId)) ?? '';
      const oldBytes = await bytesText(oldCoverId);
      // Hang the fresh generation: the job never commits before the withdraw.
      hangGeneration('gen-never');

      await regenerateInventedCreaturePortraits(encounter, campaignId);
      await waitFor(() => {
        expect(useMobPortraitQueue.getState().active).toHaveLength(1);
      });
      await useMobPortraitQueue.getState().cancelAll();

      expect(toastErrorMock).not.toHaveBeenCalled();
      expect(await creatureCover(createdKey, campaignId)).toBe(oldCoverId);
      expect(await bytesText(oldCoverId)).toBe(oldBytes);
      expect(await blobLive(oldCoverId)).toBe(true);
    });

    it('per-entry regen touches only the selected entry', async () => {
      const encounter = await addEncounter([
        {
          name: 'Gloom Ooze',
          count: 1,
          notes: 'A dripping gloom ooze, its body a standing wave of black tar.',
          source: { type: 'inline', statBlock: oozeBlock() },
        },
        {
          name: 'Whisper Wisp',
          count: 1,
          notes: 'A whisper wisp: a smear of pale light that hums a name.',
          source: { type: 'none' as const },
        },
      ]);
      if (encounter.kind !== 'encounter') throw new Error('not an encounter');
      await enqueueInventedCreaturePortraits(encounter, campaignId);
      // Neither invented creature owns a row: both are keyed by content identity.
      const oozeKey = contentCreatureKey('Gloom Ooze', oozeBlock());
      const wispKey = contentCreatureKey('Whisper Wisp', null);
      await waitFor(async () => {
        expect(await creatureCover(oozeKey, campaignId)).not.toBeNull();
        expect(await creatureCover(wispKey, campaignId)).not.toBeNull();
      });
      const oozeCover = (await creatureCover(oozeKey, campaignId)) ?? '';
      const wispCover = (await creatureCover(wispKey, campaignId)) ?? '';
      // Hang the fresh generation so the while-queued pins are deterministic.
      const hungEntry = hangGeneration('gen-fresh');

      const result = await regenerateInventedCreaturePortraits(encounter, campaignId, [1]);
      expect(result).toEqual({ regenerated: 1 });
      // The unselected entry keeps its cover; the selected one is replaced
      // delete-after-replace (old cover live until the worker commits).
      expect(await creatureCover(oozeKey, campaignId)).toBe(oozeCover);
      expect(await creatureCover(wispKey, campaignId)).toBe(wispCover);
      // Two initial batch generations plus the hung regen call.
      await waitFor(() => {
        expect(generateImagesMock).toHaveBeenCalledTimes(3);
      });
      hungEntry.release();
      await waitFor(async () => {
        const cover = await creatureCover(wispKey, campaignId);
        expect(cover).not.toBeNull();
        expect(cover).not.toBe(wispCover);
      });
      expect(await bytesText((await creatureCover(wispKey, campaignId)) ?? '')).toBe('gen-fresh');
      expect(await getImage(wispCover)).toBeUndefined();
    });

    it('skip-path regression: the normal invented batch never strips an imaged creature', async () => {
      const encounter = await addEncounter([
        {
          name: 'Gloom Ooze',
          count: 1,
          notes: 'A dripping gloom ooze, its body a standing wave of black tar.',
          source: { type: 'none' as const },
        },
      ]);
      if (encounter.kind !== 'encounter') throw new Error('not an encounter');
      const first = await enqueueInventedCreaturePortraits(encounter, campaignId);
      expect(first.enqueued).toBe(1);
      // An invented creature owns NO row (docs/11 D5): its portrait is keyed by
      // its own content identity, which is what the batch used to enqueue it.
      // A `none` entry has no stat block, so its identity is the name alone.
      const createdKey = contentCreatureKey('Gloom Ooze', null);
      await waitFor(async () => {
        expect(await creatureCover(createdKey, campaignId)).not.toBeNull();
      });
      const coverId = (await creatureCover(createdKey, campaignId)) ?? '';
      const calls = generateImagesMock.mock.calls.length;

      const second = await enqueueInventedCreaturePortraits(encounter, campaignId, [0]);
      expect(second).toEqual({ enqueued: 0, alreadyImaged: ['Gloom Ooze'] });
      expect(await creatureCover(createdKey, campaignId)).toBe(coverId);
      expect(generateImagesMock.mock.calls.length).toBe(calls);
    });
  });

  /**
   * The batch confirm's read-only half (owner report: the press offered
   * replace-all in a state the owner read as "2 mobs have a portrait, one does
   * not" — Mob Core/canonical art). `planMobPortraitBatch` walks the SAME
   * enumeration as the batch, the regen paths and the fill, so the counts a
   * surface states are the counts the queue will act on; and the batch never
   * pre-clones a canonical slot while enumerating (a hole is WORK, reported as
   * work, and the worker's canonical branch clones the populated slot — one
   * generation per chunk, no API call for the fill).
   */
  describe('planMobPortraitBatch (the read-only count behind the confirm)', () => {
    it('counts a cover-less canonical citation as work; the fill clones the shared slot with no new generation', async () => {
      const goblin = await seedCreatureChunk('Goblin', 'Goblin, small and mean. HP 7, AC 15.');
      const ogre = await seedCreatureChunk('Ogre', 'Ogre, big and rude. HP 59, AC 11.');
      const troll = await seedCreatureChunk('Troll', 'Troll, huge and hungry. HP 84, AC 15.');

      // Another campaign publishes the SHARED canonical portrait for Troll.
      const campaignB = (await createCampaign({ name: 'Second campaign', system: 'dnd5e' })).id;
      libraryCreatureKey(troll);
      const encounterB = await addEncounter(
        [
          {
            name: 'Troll',
            count: 1,
            source: { type: 'none' as const },
            originToken: libraryCreatureKey(troll),
          },
        ],
        campaignB,
      );
      if (encounterB.kind !== 'encounter') throw new Error('not an encounter');
      await enqueueMobPortraits(encounterB, campaignB);
      await waitFor(async () => {
        expect(await getMobPortraitCacheEntry(libraryCreatureKey(troll))).toBeDefined();
        expect(useMobPortraitQueue.getState().queued).toHaveLength(0);
        expect(useMobPortraitQueue.getState().active).toHaveLength(0);
      });
      const slot = await getMobPortraitCacheEntry(libraryCreatureKey(troll));
      if (slot === undefined) throw new Error('slot missing');

      // This campaign: two kinds imaged, Troll cover-less — rows cited by hand
      // exactly as the roster UI writes them (rulebook citation, NO stamp).
      const goblinArt = libraryCreatureKey(goblin);
      const ogreArt = libraryCreatureKey(ogre);
      const trollArt = libraryCreatureKey(troll);
      await attachUploadedCover(goblinArt, campaignId);
      await attachUploadedCover(ogreArt, campaignId);
      const encounter = await addEncounter([
        { name: 'Goblin', count: 1, source: { type: 'none' as const }, originToken: goblinArt },
        { name: 'Ogre', count: 1, source: { type: 'none' as const }, originToken: ogreArt },
        { name: 'Troll', count: 1, source: { type: 'none' as const }, originToken: trollArt },
      ]);
      if (encounter.kind !== 'encounter') throw new Error('not an encounter');
      // The hole is real: the token for this kind renders initials (cover null).
      expect(await creatureCover(trollArt, campaignId)).toBeNull();
      const generationsBefore = generateImagesMock.mock.calls.length;

      const plan = await planMobPortraitBatch(encounter, campaignId);
      expect(plan).toEqual({
        missing: ['Troll'],
        imaged: ['Goblin', 'Ogre'],
        // No `artWithoutCover`: with ONE portrait seam the art row IS the
        // portrait, so "has art but no cover" cannot be represented at all
        // (docs/18 §4) — the count it used to report is structurally zero.
        sharedRows: 0,
        // Both imaged citations are canonical (Monster Core-style) — replacing
        // them republishes the shared slot, and the confirm must say so.
        sharedPortraitNames: ['Goblin', 'Ogre'],
        unreadableCitations: [],
      });
      // Counting cloned nothing and created nothing.
      expect(await creatureCover(trollArt, campaignId)).toBeNull();
      expect(generateImagesMock.mock.calls.length).toBe(generationsBefore);

      // The batch reports the hole as WORK — never as already-imaged, and it
      // does not pre-clone while enumerating (revert-proof: the read-through
      // returned {enqueued: 0, alreadyImaged: [Goblin, Ogre, Troll]}).
      const result = await enqueueMobPortraits(encounter, campaignId);
      expect(result).toEqual({ enqueued: 1, alreadyImaged: ['Goblin', 'Ogre'] });
      expect(await creatureCover(trollArt, campaignId)).toBeNull();
      // Plan/run agreement: what the confirm promised is what the batch queued.
      expect(result.enqueued).toBe(plan.missing.length);
      expect(result.alreadyImaged).toEqual(plan.imaged);

      // The job fills the hole by CLONING the shared slot: identical bytes,
      // zero fresh generations (one generation per chunk, unchanged).
      await waitFor(async () => {
        expect(await creatureCover(trollArt, campaignId)).not.toBeNull();
      });
      // The fill landed on the campaign's PRESENTATION row for the identity
      // (there is no artifact to hang it on) — and its bytes are the slot's.
      expect(await bytesText((await creatureCover(trollArt, campaignId)) ?? '')).toBe(
        await bytesText(slot.imageId),
      );
      expect(generateImagesMock.mock.calls.length).toBe(generationsBefore);
      expect(chatMock).not.toHaveBeenCalled();
    });

    it('counts both lanes per creature kind and reports a repeated kind as a shared row, never silencing it', async () => {
      const goblin = await seedCreatureChunk('Goblin', 'Goblin, small and mean. HP 7, AC 15.');
      const ogre = await seedCreatureChunk('Ogre', 'Ogre, big and rude. HP 59, AC 11.');
    void ogre;
      const goblinArt = libraryCreatureKey(goblin);
      await attachUploadedCover(goblinArt, campaignId);
      const encounter = await addEncounter([
        {
          name: 'Goblin',
          count: 2,
          source: { type: 'none' as const },
          originToken: goblinArt,
        },
        {
          name: 'Goblin',
          count: 1,
          source: { type: 'none' as const },
          originToken: goblinArt,
        },
        {
          name: 'Ogre',
          count: 1,
          source: { type: 'none' as const },
          originToken: libraryCreatureKey(ogre),
        },
        {
          name: 'Gloom Ooze',
          count: 2,
          notes: 'A dripping gloom ooze, its body a standing wave of black tar.',
          source: { type: 'inline', statBlock: oozeBlock() },
        },
        {
          name: 'Gloom Ooze',
          count: 1,
          notes: 'A dripping gloom ooze, its body a standing wave of black tar.',
          source: { type: 'inline', statBlock: oozeBlock() },
        },
      ]);
      if (encounter.kind !== 'encounter') throw new Error('not an encounter');

      const plan = await planMobPortraitBatch(encounter, campaignId);
      expect(plan.missing).toEqual(['Ogre', 'Gloom Ooze']);
      expect(plan.imaged).toEqual(['Goblin']);
      expect(plan.sharedRows).toBe(2);
      // Neither lane creates anything (docs/11 D5): the two lanes split the
      // SAME missing list, so their enqueued counts must sum to it.

      const rulebook = await enqueueMobPortraits(encounter, campaignId);
      expect(rulebook).toEqual({ enqueued: 1, alreadyImaged: ['Goblin'] });
      const invented = await enqueueInventedCreaturePortraits(encounter, campaignId);
      expect(invented).toEqual({ enqueued: 1, alreadyImaged: [] });
      expect(rulebook.enqueued + invented.enqueued).toBe(plan.missing.length);
      expect([...rulebook.alreadyImaged, ...invented.alreadyImaged]).toEqual(plan.imaged);
    });

    it('counts an imaged creature as imaged and enqueues nothing — the count and the run agree', async () => {
      const ogre = await seedCreatureChunk('Ogre', 'Ogre, big and rude. HP 59, AC 11.');
      const ogreArt = libraryCreatureKey(ogre);
      // REWRITTEN (ledger row 106): this test used to build "gallery art with no
      // cover" on a creature ARTIFACT, and pinned a plan bucket
      // (`artWithoutCover`) for it. With ONE portrait seam the campaign's
      // presentation row IS the art AND the portrait, so "has art, is not
      // imaged" is not a state the model can represent (docs/18 §4) — the
      // bucket is gone, not defaulted to []. What survives, and is pinned here,
      // is the agreement the old bucket existed to protect: whatever the count
      // says, the run does.
      await attachUploadedCover(ogreArt, campaignId);
      const encounter = await addEncounter([
        { name: 'Ogre', count: 1, source: { type: 'none' as const }, originToken: ogreArt },
      ]);
      if (encounter.kind !== 'encounter') throw new Error('not an encounter');

      const plan = await planMobPortraitBatch(encounter, campaignId);
      expect(plan).toEqual({
        missing: [],
        imaged: ['Ogre'],
        sharedRows: 0,
        sharedPortraitNames: ['Ogre'],
        unreadableCitations: [],
      });
      expect(await creatureCover(ogreArt, campaignId)).not.toBeNull();
      const generationsBefore = generateImagesMock.mock.calls.length;
      const result = await enqueueMobPortraits(encounter, campaignId);
      expect(result).toEqual({ enqueued: 0, alreadyImaged: ['Ogre'] });
      expect(result.enqueued).toBe(plan.missing.length);
      expect(result.alreadyImaged).toEqual(plan.imaged);
      expect(generateImagesMock.mock.calls.length).toBe(generationsBefore);
    });

    it('names an unreadable citation instead of quietly calling it flavored, and still never blocks the fill', async () => {
      const ogre = await seedCreatureChunk('Ogre', 'Ogre, big and rude. HP 59, AC 11.');
      const ogreArt = libraryCreatureKey(ogre);
      await attachUploadedCover(ogreArt, campaignId);
      const encounter = await addEncounter([
        { name: 'Ogre', count: 1, source: { type: 'none' as const }, originToken: ogreArt },
      ]);
      if (encounter.kind !== 'encounter') throw new Error('not an encounter');
      const { db } = await import('@/db/db');
      await db.chunks.delete(ogre);

      const plan = await planMobPortraitBatch(encounter, campaignId);
      expect(plan.unreadableCitations).toEqual(['Ogre']);
      expect(plan.sharedPortraitNames).toEqual([]);
      expect(plan.imaged).toEqual(['Ogre']);
      // Replacing fails loud with the cover kept (unchanged behavior) — the
      // count reports it instead of hiding it, and the additive path stands.
      await expect(regenerateMobPortraits(encounter, campaignId)).rejects.toThrow(
        /no longer exists — kept the existing portrait/,
      );
    });

    it('creates nothing while counting: the fill is what creates the artifacts', async () => {
      const kobold = await seedCreatureChunk('Kobold', 'Kobold, yappy. HP 5, AC 12.');
      const encounter = await addEncounter([
        {
          name: 'Kobold',
          count: 1,
          source: { type: 'none' as const },
          originToken: libraryCreatureKey(kobold),
        },
        {
          name: 'Gloom Ooze',
          count: 1,
          notes: 'A dripping gloom ooze, its body a standing wave of black tar.',
          source: { type: 'none' as const },
        },
      ]);
      if (encounter.kind !== 'encounter') throw new Error('not an encounter');

      const before = (await listArtifactsByCampaign(campaignId)).length;
      const plan = await planMobPortraitBatch(encounter, campaignId);
      expect(plan.missing).toEqual(['Kobold', 'Gloom Ooze']);
      expect(plan.imaged).toEqual([]);
      expect((await listArtifactsByCampaign(campaignId)).length).toBe(before);

      const rulebook = await enqueueMobPortraits(encounter, campaignId);
      expect(rulebook).toEqual({ enqueued: 1, alreadyImaged: [] });
      const invented = await enqueueInventedCreaturePortraits(encounter, campaignId);
      expect(invented).toEqual({ enqueued: 1, alreadyImaged: [] });
      expect(rulebook.enqueued + invented.enqueued).toBe(plan.missing.length);
    });
  });
});
