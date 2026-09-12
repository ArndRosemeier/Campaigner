import 'fake-indexeddb/auto';

import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact, getAnyArtifact, listArtifactsByCampaign } from '@/db/artifactRepo';
import { creatureCoverImageId } from '@/db/creatureRepo';
import { createCampaign } from '@/db/campaignRepo';
import { db } from '@/db/db';
import { createModule } from '@/db/moduleRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { updateSettings } from '@/db/settingsRepo';
import { contentCreatureKey, createModule as createModuleSchema, newId, statBlockSchema } from '@/domain';
import {
  enqueueInventedCreaturePortraits,
  useMobPortraitQueue,
} from '@/features/campaign/mob-portrait-queue';
import { useProgressStore } from '@/lib/progress';
import { clearDatabase } from '../db/helpers';

/**
 * On-demand invented creatures (docs/11 D5 amendment / ledger row 106):
 * uncited roster entries (inline / none) are ILLUSTRATED, never authored — no
 * artifact is created for them (docs/11 D1). Each becomes one local-only job
 * (no chunkId, no artifactId) keyed by its content identity, grounded on the
 * roster notes the encounter's model wrote, and never touching the global
 * `mobPortraits` cache. The prompt draft stays deterministic: the openrouter
 * chat mock must stay silent through every path below.
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
      { name: 'Gloom Ooze', count: 2, source: { type: 'inline', statBlock: oozeBlock() }, notes: OOZE_NOTES, treasure: 'a swallowed ring' },
      { name: 'Whisper Wisp', count: 1, source: { type: 'none' }, notes: 'barely a rumor' },
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
    expect(
      await db.creatureImages.where('campaignId').equals(campaignId).count(),
    ).toBe(2);

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
      [{ name: 'Gloom Ooze', count: 1, source: { type: 'inline', statBlock: oozeBlock() }, notes: OOZE_NOTES }],
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
      { name: 'Whisper Wisp', count: 1, source: { type: 'none' }, notes: 'barely a rumor' },
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
      { name: 'Gloom Ooze', count: 1, source: { type: 'inline', statBlock: oozeBlock() }, notes: OOZE_NOTES },
    ]);
    if (encounter.kind !== 'encounter') throw new Error('not an encounter');

    const tables = await transactionTablesDuring(async () => {
      await enqueueInventedCreaturePortraits(encounter, campaignId);
      await waitFor(async () => {
        expect(
          await db.creatureImages.where('campaignId').equals(campaignId).count(),
        ).toBe(1);
      });
    });
    expect(tables).not.toContain('mobPortraits');
    expect(await db.mobPortraits.count()).toBe(0);
  });

  it('dedupes duplicate roster rows of one creature onto ONE job', async () => {
    const encounter = await addEncounter([
      { name: 'Gloom Ooze', count: 2, source: { type: 'inline', statBlock: oozeBlock() }, notes: OOZE_NOTES },
      { name: 'Gloom Ooze', count: 1, source: { type: 'inline', statBlock: oozeBlock() }, notes: OOZE_NOTES },
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
      { name: 'Goblin Boss', count: 1, source: { type: 'rulebook', chunkId } },
      { name: 'Captain Vane', count: 1, source: { type: 'npc-ref', artifactId: npc.id } },
      { name: 'Whisper Wisp', count: 1, source: { type: 'none' }, notes: 'barely a rumor' },
    ]);
    if (encounter.kind !== 'encounter') throw new Error('not an encounter');

    const result = await enqueueInventedCreaturePortraits(encounter, campaignId);
    expect(result).toEqual({ enqueued: 1, alreadyImaged: [] });
    expect(useMobPortraitQueue.getState().queued.map((job) => job.name)).toEqual(['Whisper Wisp']);
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
      { name: 'Gloom Ooze', count: 1, source: { type: 'inline', statBlock: oozeBlock() }, notes: OOZE_NOTES },
      { name: 'Whisper Wisp', count: 1, source: { type: 'none' }, notes: 'barely a rumor' },
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
      { name: 'Whisper Wisp', count: 1, source: { type: 'none' }, notes: 'barely a rumor' },
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
    const vault = await createModule(
      createModuleSchema({ campaignId, title: 'The Sunless Vault', concept: '', levelMin: 1, levelMax: 3, sizeDial: 'sketch' }),
    );
    const encounter = await addEncounter(
      [{ name: 'Gloom Ooze', count: 1, source: { type: 'inline', statBlock: oozeBlock() }, notes: OOZE_NOTES }],
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
    const encounter = await addEncounter([
      { name: '   ', count: 1, source: { type: 'none' } },
    ]);
    if (encounter.kind !== 'encounter') throw new Error('not an encounter');

    await expect(enqueueInventedCreaturePortraits(encounter, campaignId)).rejects.toThrow(
      'creature identity: a creature with no name has no content identity',
    );
    expect(useMobPortraitQueue.getState().queued).toHaveLength(0);
    expect(await npcArtifacts()).toHaveLength(0);
  });
});
