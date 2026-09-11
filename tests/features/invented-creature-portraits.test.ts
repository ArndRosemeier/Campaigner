import 'fake-indexeddb/auto';

import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact, getAnyArtifact, listArtifactsByCampaign } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { db } from '@/db/db';
import { createModule } from '@/db/moduleRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { updateSettings } from '@/db/settingsRepo';
import { createModule as createModuleSchema, newId, statBlockSchema } from '@/domain';
import {
  enqueueInventedCreaturePortraits,
  useMobPortraitQueue,
} from '@/features/campaign/mob-portrait-queue';
import { useProgressStore } from '@/lib/progress';
import { clearDatabase } from '../db/helpers';

/**
 * On-demand invented creatures (docs/11 D5 amendment): uncited roster
 * entries (inline / none) materialize an npc artifact each and flow through
 * the EXISTING portrait queue as local-only jobs (no chunkId) — grounded on
 * the artifact's own content, never touching the global `mobPortraits`
 * cache. The prompt draft stays deterministic: the openrouter chat mock
 * must stay silent through every path below.
 */

vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {},
  OpenRouterError: class OpenRouterError extends Error {},
  listModels: vi.fn(),
  fetchWithHeadersTimeout: vi.fn(),
}));
vi.mock('@/llm/imageGen', () => ({ generateImages: vi.fn() }));
vi.mock('@/lib/imageIntake', () => ({ intakeImage: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn(), toastInfo: vi.fn() }));

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);
const { generateImages } = await import('@/llm/imageGen');
const generateImagesMock = vi.mocked(generateImages);
const { intakeImage } = await import('@/lib/imageIntake');
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
  monsters: { name: string; count: number; source: Record<string, unknown>; notes?: string; treasure?: string }[],
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

async function inventedNpcs(): Promise<string[]> {
  return (await listArtifactsByCampaign(campaignId))
    .filter((artifact) => artifact.kind === 'npc' && artifact.summary.includes('[encounter-creature:'))
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
  it('materializes one npc per uncited entry and portraits each locally, grounded on the entry notes', async () => {
    const encounter = await addEncounter([
      { name: 'Gloom Ooze', count: 2, source: { type: 'inline', statBlock: oozeBlock() }, notes: OOZE_NOTES, treasure: 'a swallowed ring' },
      { name: 'Whisper Wisp', count: 1, source: { type: 'none' }, notes: 'barely a rumor' },
    ]);
    if (encounter.kind !== 'encounter') throw new Error('not an encounter');

    const result = await enqueueInventedCreaturePortraits(encounter, campaignId);
    expect(result).toEqual({ created: 2, enqueued: 2, alreadyImaged: [] });
    expect(useMobPortraitQueue.getState().queued).toHaveLength(2);
    // Local-only jobs: no chunkId, so the worker can never reach the cache.
    for (const job of useMobPortraitQueue.getState().queued) {
      expect(job.chunkId).toBeUndefined();
    }

    await waitFor(async () => {
      const ids = await inventedNpcs();
      expect(ids).toHaveLength(2);
      for (const id of ids) {
        expect((await getAnyArtifact(id))?.coverImageId).not.toBeNull();
      }
    });

    // Two local generations, grounded on the entry's own description —
    // never the rulebook chunk text, never a chat call.
    expect(generateImagesMock).toHaveBeenCalledTimes(2);
    expect(chatMock).not.toHaveBeenCalled();
    const prompts = generateImagesMock.mock.calls.map((call) => call[0]);
    expect(prompts.some((prompt) => prompt.includes(OOZE_NOTES))).toBe(true);
    expect(prompts.some((prompt) => prompt.includes('barely a rumor'))).toBe(true);
    // The global cache stays empty: invented covers are LOCAL ONLY.
    expect(await db.mobPortraits.count()).toBe(0);

    const ooze = (await listArtifactsByCampaign(campaignId)).find(
      (artifact) => artifact.kind === 'npc' && artifact.name === 'Gloom Ooze',
    );
    if (ooze?.kind !== 'npc') throw new Error('ooze artifact missing');
    expect(ooze.data.statBlock).toMatchObject({ hp: 45 });
    expect(ooze.moduleId).toBeNull();
  });

  it('stamps the ENCOUNTER\u2019s recorded model on the creatures it materializes', async () => {
    // PROVENANCE (docs/17 row 93): the creature's row carries text the
    // encounter's model wrote (its name, notes, treasure and the appearance
    // seed built from them). No model call runs in this seam, so the only
    // truthful source is the encounter row's own recorded id.
    const encounter = await addEncounter(
      [{ name: 'Gloom Ooze', count: 1, source: { type: 'inline', statBlock: oozeBlock() }, notes: OOZE_NOTES }],
      undefined,
      'staged/encounter-model',
    );
    if (encounter.kind !== 'encounter') throw new Error('not an encounter');

    await enqueueInventedCreaturePortraits(encounter, campaignId);

    const ooze = (await listArtifactsByCampaign(campaignId)).find(
      (artifact) => artifact.kind === 'npc' && artifact.name === 'Gloom Ooze',
    );
    expect(ooze?.writerModel).toBe('staged/encounter-model');
  });

  it('leaves the creature\u2019s id empty when the encounter records none', async () => {
    // The negative half: an encounter written before the field (or hand-typed)
    // must NOT produce a settings-derived id on the creature either.
    const encounter = await addEncounter([
      { name: 'Whisper Wisp', count: 1, source: { type: 'none' }, notes: 'barely a rumor' },
    ]);
    if (encounter.kind !== 'encounter') throw new Error('not an encounter');

    await enqueueInventedCreaturePortraits(encounter, campaignId);

    const wisp = (await listArtifactsByCampaign(campaignId)).find(
      (artifact) => artifact.kind === 'npc' && artifact.name === 'Whisper Wisp',
    );
    expect(wisp?.writerModel).toBe('');
  });

  it('never touches the mobPortraits table — materialize, enqueue and generate stay off-seam', async () => {
    const encounter = await addEncounter([
      { name: 'Gloom Ooze', count: 1, source: { type: 'inline', statBlock: oozeBlock() }, notes: OOZE_NOTES },
    ]);
    if (encounter.kind !== 'encounter') throw new Error('not an encounter');

    const tables = await transactionTablesDuring(async () => {
      await enqueueInventedCreaturePortraits(encounter, campaignId);
      await waitFor(async () => {
        expect(await inventedNpcs()).toHaveLength(1);
        expect((await getAnyArtifact((await inventedNpcs())[0] ?? ''))?.coverImageId).not.toBeNull();
      });
    });
    expect(tables).not.toContain('mobPortraits');
    expect(await db.mobPortraits.count()).toBe(0);
  });

  it('dedupes duplicate roster names onto one artifact and one job', async () => {
    const encounter = await addEncounter([
      { name: 'Gloom Ooze', count: 2, source: { type: 'inline', statBlock: oozeBlock() }, notes: OOZE_NOTES },
      { name: 'Gloom Ooze', count: 1, source: { type: 'none' } },
    ]);
    if (encounter.kind !== 'encounter') throw new Error('not an encounter');

    const result = await enqueueInventedCreaturePortraits(encounter, campaignId);
    expect(result.created).toBe(2);
    expect(result.enqueued).toBe(1);
    expect(await inventedNpcs()).toHaveLength(1);
  });

  /**
   * Behavior change, docs/17 row 90 (owner decision: *"A special look for a
   * special zombie is ok."*): an `npc-ref` row whose artifact is NOT a mob
   * artifact is a participant of THIS lane now — a named NPC standing in the
   * roster is offered a portrait, and a monster the encounter materialized for
   * a creature the prose staged is no longer invisible. Chunk-backed rows stay
   * with the rulebook lane (pinned in `mob-portrait-npc-ref.test.ts`).
   *
   * Revert-proof: restore the old `entry.source.type !== 'inline' && !== 'none'`
   * guard and the npc-ref row is skipped again — `created` drops back to 1 and
   * the only queued job is the uncited wisp.
   */
  it('walks uncited entries AND npc-ref rows, while chunk-backed and dangling cases stay out', async () => {
    const npc = await createArtifact({
      campaignId,
      kind: 'npc',
      name: 'Captain Vane',
      data: { appearance: 'scarred', personality: 'bold', statBlock: null },
    });
    const encounter = await addEncounter([
      { name: 'Goblin Boss', count: 1, source: { type: 'rulebook', chunkId: newId() } },
      { name: 'Captain Vane', count: 1, source: { type: 'npc-ref', artifactId: npc.id } },
      { name: 'Whisper Wisp', count: 1, source: { type: 'none' } },
    ]);
    if (encounter.kind !== 'encounter') throw new Error('not an encounter');

    const result = await enqueueInventedCreaturePortraits(encounter, campaignId);
    // `created` counts the artifacts this lane materialized (the uncited row);
    // the npc-ref row already has its own.
    expect(result).toEqual({ created: 1, enqueued: 2, alreadyImaged: [] });
    expect(useMobPortraitQueue.getState().queued.map((job) => job.name)).toEqual([
      'Captain Vane',
      'Whisper Wisp',
    ]);
    // The local lane must never hand a chunk to the worker for these rows.
    for (const job of useMobPortraitQueue.getState().queued) {
      expect(job.chunkId).toBeUndefined();
    }
  });

  it('per-entry indexes materialize and enqueue only that row', async () => {
    const encounter = await addEncounter([
      { name: 'Gloom Ooze', count: 1, source: { type: 'inline', statBlock: oozeBlock() }, notes: OOZE_NOTES },
      { name: 'Whisper Wisp', count: 1, source: { type: 'none' } },
    ]);
    if (encounter.kind !== 'encounter') throw new Error('not an encounter');

    const result = await enqueueInventedCreaturePortraits(encounter, campaignId, [1]);
    expect(result).toEqual({ created: 1, enqueued: 1, alreadyImaged: [] });
    expect(useMobPortraitQueue.getState().queued).toHaveLength(1);
    expect(useMobPortraitQueue.getState().queued[0]?.name).toBe('Whisper Wisp');
    expect(await inventedNpcs()).toHaveLength(1);
  });

  it('reports already-imaged creatures instead of re-enqueueing', async () => {
    const encounter = await addEncounter([
      { name: 'Whisper Wisp', count: 1, source: { type: 'none' } },
    ]);
    if (encounter.kind !== 'encounter') throw new Error('not an encounter');

    const first = await enqueueInventedCreaturePortraits(encounter, campaignId, [0]);
    expect(first.enqueued).toBe(1);
    await waitFor(async () => {
      expect((await getAnyArtifact((await inventedNpcs())[0] ?? ''))?.coverImageId).not.toBeNull();
    });
    useMobPortraitQueue.getState().reset();

    // A second click reuses the marked artifact and enumerates it away.
    const second = await enqueueInventedCreaturePortraits(encounter, campaignId, [0]);
    expect(second).toEqual({ created: 1, enqueued: 0, alreadyImaged: ['Whisper Wisp'] });
    expect(useMobPortraitQueue.getState().queued).toHaveLength(0);
    expect(await inventedNpcs()).toHaveLength(1);
    expect(generateImagesMock).toHaveBeenCalledTimes(1);
  });

  it('places the creature in the encounter module when module-owned', async () => {
    const vault = await createModule(
      createModuleSchema({ campaignId, title: 'The Sunless Vault', concept: '', levelMin: 1, levelMax: 3, sizeDial: 'sketch' }),
    );
    const encounter = await addEncounter(
      [{ name: 'Gloom Ooze', count: 1, source: { type: 'inline', statBlock: oozeBlock() }, notes: OOZE_NOTES }],
      vault.id,
    );
    if (encounter.kind !== 'encounter') throw new Error('not an encounter');

    await enqueueInventedCreaturePortraits(encounter, campaignId);
    const ids = await inventedNpcs();
    expect(ids).toHaveLength(1);
    expect((await getAnyArtifact(ids[0] ?? ''))?.moduleId).toBe(vault.id);
  });

  it('fails loudly on an empty roster name with nothing enqueued (no silent skip)', async () => {
    const encounter = await addEncounter([
      { name: '   ', count: 1, source: { type: 'none' } },
    ]);
    if (encounter.kind !== 'encounter') throw new Error('not an encounter');

    await expect(enqueueInventedCreaturePortraits(encounter, campaignId)).rejects.toThrow('empty name');
    expect(useMobPortraitQueue.getState().queued).toHaveLength(0);
    expect(await inventedNpcs()).toHaveLength(0);
  });
});
