import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createArtifact,
  deleteArtifact,
  getAnyArtifact,
} from '@/db/artifactRepo';
import { createCampaign, deleteCampaign } from '@/db/campaignRepo';
import { putChunks } from '@/db/chunkRepo';
import { db } from '@/db/db';
import {
  deleteImageIfUnreferenced,
  getImage,
  pruneUnreferencedImages,
} from '@/db/imageRepo';
import { getOrCreateMobArtifact } from '@/db/mobArtifacts';
import {
  cacheKeyForMonsterSource,
  cachedMobPortraitImageIds,
  canonicalCreatureName,
  getMobPortraitCacheEntry,
  isCanonicalCitation,
} from '@/db/mobPortraitCache';
import { createRulebook } from '@/db/rulebookRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { updateSettings } from '@/db/settingsRepo';
import {
  mobPortraitCacheSchema,
  newId,
  ruleChunkSchema,
  stampNewEntity,
  statBlockSchema,
} from '@/domain';
import {
  enqueueArtifactPortrait,
  enqueueInventedCreaturePortraits,
  enqueueMobPortraits,
  useMobPortraitQueue,
} from '@/features/campaign/mob-portrait-queue';
import {
  __clearPendingMobPortraitGenerationsForTests,
  ensureCanonicalMobPortrait,
} from '@/features/campaign/mob-portrait-cache-queue';
import { sha256Hex } from '@/lib/hash';
import { useProgressStore } from '@/lib/progress';
import { clearDatabase } from './helpers';

/**
 * Global mob portrait cache (docs/11 D5 amendment, slice A): ONE canonical
 * portrait per rulebook chunk, generated once and reused across campaigns —
 * canonical citations populate, flavored citations stay local, module NPCs
 * and non-rulebook roster rows never touch the seam, and the cached blob is
 * prune-immune. The prompt draft stays deterministic: the openrouter chat
 * mock must stay silent through every path below.
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
const { toastError } = await import('@/lib/toast');
const toastErrorMock = vi.mocked(toastError);

const GIANT_RAT_TEXT = 'Giant Rat, large dire rodent. HP 59, AC 11, darkvision 60 ft.';

function blobOf(text: string): Blob {
  return new Blob([text], { type: 'image/png' });
}

function testStatBlock() {
  return statBlockSchema.parse({
    system: 'dnd5e',
    level: '2',
    size: 'Large',
    creatureType: 'beast',
    ac: 11,
    acNote: '',
    hp: 59,
    hpFormula: '7d10 + 21',
    speed: '40 ft.',
    abilities: { str: 18, dex: 10, con: 16, int: 3, wis: 10, cha: 4 },
    saves: '',
    skills: '',
    senses: 'darkvision 60 ft.',
    languages: '',
    traits: [],
    actions: [],
    reactions: [],
    legendary: [],
    extras: {},
  });
}

async function seedCreatureChunk(
  creatureName: string,
  text: string,
  headingPath?: string[],
  statBlock?: ReturnType<typeof testStatBlock>,
): Promise<string> {
  const book = await createRulebook({ title: 'Bestiary', system: 'dnd5e', filename: 'bestiary.pdf' });
  await putChunks([
    ruleChunkSchema.parse({
      ...stampNewEntity(),
      bookId: book.id,
      pageStart: 12,
      pageEnd: 12,
      chunkType: 'statblock',
      headingPath: headingPath ?? [creatureName],
      text,
      statBlock: statBlock ?? testStatBlock(),
      contentHash: await sha256Hex(text),
    }),
  ]);
  const chunk = await db.chunks.where('bookId').equals(book.id).first();
  if (chunk === undefined) throw new Error('chunk missing');
  return chunk.id;
}

async function addEncounter(
  campaignId: string,
  monsters: { name: string; count: number; source: Record<string, unknown> }[],
) {
  const encounter = await createArtifact({
    campaignId,
    kind: 'encounter',
    name: 'Rat warren',
    data: {
      difficulty: 'medium',
      levelHint: '1',
      monsters: monsters.map((monster) => ({
        name: monster.name,
        count: monster.count,
        notes: '',
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
  if (encounter.kind !== 'encounter') throw new Error('not an encounter');
  return encounter;
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

/** Plain-macrotask polling (this file runs in the node project — no DOM,
 * so @testing-library's waitFor has no container). */
async function pollFor(what: string, check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Drains the mob queue's in-flight jobs (settled jobs leave the store). */
async function drainMobQueue(): Promise<void> {
  await pollFor(
    'mob queue drain',
    () =>
      useMobPortraitQueue.getState().queued.length === 0 &&
      useMobPortraitQueue.getState().active.length === 0,
  );
}

beforeEach(async () => {
  await clearDatabase();
  await db.mobPortraits.clear();
  await seedBuiltInPersonas();
  await updateSettings({ imagesEnabled: true, imageModel: 'test-image-model' });
  chatMock.mockReset();
  generateImagesMock.mockReset();
  intakeImageMock.mockReset();
  toastErrorMock.mockReset();
  useMobPortraitQueue.getState().reset();
  useProgressStore.getState().reset();
  __clearPendingMobPortraitGenerationsForTests();
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

describe('cache row schema (v18)', () => {
  it('registers the mobPortraits store and round-trips a parsed row', async () => {
    expect(db.table('mobPortraits')).toBeDefined();
    const chunkId = await seedCreatureChunk('Giant Rat', GIANT_RAT_TEXT);
    const ensured = await ensureCanonicalMobPortrait({ chunkId, campaignId: 'no-campaign' });
    expect(ensured.generated).toBe(true);
    const entry = await getMobPortraitCacheEntry(chunkId);
    expect(entry?.imageId).toBe(ensured.imageId);
    // Parse-on-read: the stored row validates against the zod schema.
    expect(() => mobPortraitCacheSchema.parse(entry)).not.toThrow();
    // The shared blob lives at global scope (campaignId null).
    const cached = await getImage(ensured.imageId);
    expect(cached?.campaignId).toBeNull();
  });

  it('publishes put-if-absent: a second store for one chunk converges, never overwrites', async () => {
    const chunkId = await seedCreatureChunk('Giant Rat', GIANT_RAT_TEXT);
    const first = await ensureCanonicalMobPortrait({ chunkId, campaignId: 'no-campaign' });
    const second = await ensureCanonicalMobPortrait({ chunkId, campaignId: 'no-campaign' });
    expect(second).toEqual({ imageId: first.imageId, generated: false });
    expect(generateImagesMock).toHaveBeenCalledTimes(1);
    expect(await db.mobPortraits.where('chunkId').equals(chunkId).count()).toBe(1);
  });
});

describe('canonical-only invariant', () => {
  it('canonical citation populates once; a second campaign reuses the clone with no second generation', async () => {
    const chunkId = await seedCreatureChunk('Giant Rat', GIANT_RAT_TEXT);
    const campaignA = (await createCampaign({ name: 'A', system: 'dnd5e' })).id;
    const campaignB = (await createCampaign({ name: 'B', system: 'dnd5e' })).id;

    const encounterA = await addEncounter(campaignA, [
      { name: 'Giant Rat', count: 3, source: { type: 'rulebook', chunkId } },
    ]);
    const resultA = await enqueueMobPortraits(encounterA, campaignA);
    expect(resultA).toEqual({ enqueued: 1, alreadyImaged: [] });
    await drainMobQueue();

    expect(generateImagesMock).toHaveBeenCalledTimes(1);
    // Stat-exempt canonical grounding: size/type identity, never the raw
    // stat-block text (models render stat digits into portraits), plus the
    // text-render negative.
    const finalPrompt = generateImagesMock.mock.calls[0]?.[0] ?? '';
    expect(finalPrompt).not.toContain(GIANT_RAT_TEXT);
    expect(finalPrompt).not.toContain('HP 59');
    expect(finalPrompt).not.toContain('AC 11');
    expect(finalPrompt).not.toContain('darkvision 60 ft.');
    expect(finalPrompt).toContain('Large');
    expect(finalPrompt).toContain('beast');
    expect(finalPrompt).toContain('Avoid: text, letters, numbers');
    expect(chatMock).not.toHaveBeenCalled();
    const entry = await getMobPortraitCacheEntry(chunkId);
    expect(entry).toBeDefined();
    const mobA = await getAnyArtifact(
      await getOrCreateMobArtifact(campaignA, chunkId, 'Giant Rat'),
    );
    expect(mobA?.coverImageId).not.toBeNull();
    expect(mobA?.coverImageId).not.toBe(entry?.imageId);

    // Second campaign: the cover-less canonical citation is a normal JOB
    // whose worker CLONES the populated slot — still ONE generation for the
    // chunk. The batch reports the hole as work instead of calling it
    // already-imaged: the old enumeration-time read-through (`fillCoverFromCache`
    // during get-or-create) filled the cover WHILE counting and then reported
    // { enqueued: 0, alreadyImaged: ['Giant Rat'] } — a visible hole described
    // as existing art, and the trigger for the one-sided replace-all confirm
    // (owner report; ledger 81).
    const encounterB = await addEncounter(campaignB, [
      { name: 'Giant Rat', count: 2, source: { type: 'rulebook', chunkId } },
    ]);
    const resultB = await enqueueMobPortraits(encounterB, campaignB);
    expect(resultB).toEqual({ enqueued: 1, alreadyImaged: [] });
    expect(useMobPortraitQueue.getState().queued).toHaveLength(1);
    await drainMobQueue();
    // Reuse, not regeneration: the fill cloned the slot's bytes.
    expect(generateImagesMock).toHaveBeenCalledTimes(1);

    const mobB = await getAnyArtifact(
      await getOrCreateMobArtifact(campaignB, chunkId, 'Giant Rat'),
    );
    expect(mobB?.coverImageId).not.toBeNull();
    expect(mobB?.coverImageId).not.toBe(entry?.imageId);
    const coverB = await getImage(mobB?.coverImageId ?? '');
    const cached = await getImage(entry?.imageId ?? '');
    expect(coverB?.campaignId).toBe(campaignB);
    expect([...(coverB?.bytes ?? [])]).toEqual([...(cached?.bytes ?? [])]);
  });

  it('canonical grounding carries prose but no stat digits from the fixture chunk', async () => {
    const proseBlock = statBlockSchema.parse({
      ...testStatBlock(),
      traits: [{ name: 'Keen Smell', text: 'a wet snout forever twitching at rot' }],
      actions: [{ name: 'Bite', text: 'yellowed fangs slick with sewer damp' }],
    });
    const chunkId = await seedCreatureChunk(
      'Giant Rat',
      GIANT_RAT_TEXT,
      undefined,
      proseBlock,
    );
    const ensured = await ensureCanonicalMobPortrait({ chunkId, campaignId: 'no-campaign' });
    expect(ensured.generated).toBe(true);
    expect(generateImagesMock).toHaveBeenCalledTimes(1);
    expect(chatMock).not.toHaveBeenCalled();
    const finalPrompt = generateImagesMock.mock.calls[0]?.[0] ?? '';
    // Prose present: identity + named-text sections.
    expect(finalPrompt).toContain('Giant Rat');
    expect(finalPrompt).toContain('Large');
    expect(finalPrompt).toContain('beast');
    expect(finalPrompt).toContain('Keen Smell');
    expect(finalPrompt).toContain('a wet snout forever twitching at rot');
    expect(finalPrompt).toContain('yellowed fangs slick with sewer damp');
    // Numbers absent: every numeric field of the fixture stat block.
    for (const marker of ['11', '59', '7d10 + 21', '40 ft.', '18', 'darkvision 60 ft.']) {
      expect(finalPrompt, `leaked stat marker: ${marker}`).not.toContain(marker);
    }
    expect(finalPrompt).not.toContain(GIANT_RAT_TEXT);
    // Belt and braces: the text-render negative rides the canonical draft.
    expect(finalPrompt).toContain('Avoid: text, letters, numbers');
  });

  it('a case-insensitive canonical match reuses without generating', async () => {
    const chunkId = await seedCreatureChunk('Giant Rat', GIANT_RAT_TEXT);
    const campaignA = (await createCampaign({ name: 'A', system: 'dnd5e' })).id;
    const campaignB = (await createCampaign({ name: 'B', system: 'dnd5e' })).id;

    const encounterA = await addEncounter(campaignA, [
      { name: 'Giant Rat', count: 1, source: { type: 'rulebook', chunkId } },
    ]);
    await enqueueMobPortraits(encounterA, campaignA);
    await drainMobQueue();
    expect(generateImagesMock).toHaveBeenCalledTimes(1);

    const encounterB = await addEncounter(campaignB, [
      { name: '  GIANT RAT ', count: 1, source: { type: 'rulebook', chunkId } },
    ]);
    const resultB = await enqueueMobPortraits(encounterB, campaignB);
    expect(resultB).toEqual({ enqueued: 1, alreadyImaged: [] });
    await drainMobQueue();
    // The case-insensitive canonical match resolves the SAME slot: the fill
    // cloned it, so the chunk still has exactly one generation (ledger 81 —
    // the job replaces the old enumeration-time read-through).
    expect(generateImagesMock).toHaveBeenCalledTimes(1);
    const cacheEntry = await getMobPortraitCacheEntry(chunkId);
    const mobB = await getAnyArtifact(
      await getOrCreateMobArtifact(campaignB, chunkId, 'GIANT RAT'),
    );
    expect(mobB?.coverImageId).not.toBeNull();
    expect(mobB?.coverImageId).not.toBe(cacheEntry?.imageId);
    const coverB = await getImage(mobB?.coverImageId ?? '');
    const cached = await getImage(cacheEntry?.imageId ?? '');
    expect([...(coverB?.bytes ?? [])]).toEqual([...(cached?.bytes ?? [])]);
  });

  it('a flavored variant neither populates nor overwrites the cache', async () => {
    const chunkId = await seedCreatureChunk('Giant Rat', GIANT_RAT_TEXT);
    const campaignA = (await createCampaign({ name: 'A', system: 'dnd5e' })).id;
    const campaignB = (await createCampaign({ name: 'B', system: 'dnd5e' })).id;
    const campaignC = (await createCampaign({ name: 'C', system: 'dnd5e' })).id;

    // Flavored first: local flavored cover, cache slot stays EMPTY.
    const flavoredA = await addEncounter(campaignA, [
      { name: 'slimey giant rat', count: 2, source: { type: 'rulebook', chunkId } },
    ]);
    const resultA = await enqueueMobPortraits(flavoredA, campaignA);
    expect(resultA.enqueued).toBe(1);
    await drainMobQueue();
    expect(generateImagesMock).toHaveBeenCalledTimes(1);
    expect(generateImagesMock.mock.calls[0]?.[0]).toContain('slimey giant rat');
    expect(await db.mobPortraits.count()).toBe(0);
    const mobA = await getAnyArtifact(
      await getOrCreateMobArtifact(campaignA, chunkId, 'slimey giant rat'),
    );
    const flavorCoverA = mobA?.coverImageId;
    expect(flavorCoverA).not.toBeNull();

    // Canonical citation populates the slot once.
    const canonicalB = await addEncounter(campaignB, [
      { name: 'Giant Rat', count: 1, source: { type: 'rulebook', chunkId } },
    ]);
    await enqueueMobPortraits(canonicalB, campaignB);
    await drainMobQueue();
    expect(generateImagesMock).toHaveBeenCalledTimes(2);
    const entry = await getMobPortraitCacheEntry(chunkId);
    expect(entry).toBeDefined();
    const canonicalImageId = entry?.imageId ?? '';

    // A later flavored citation generates locally and does NOT overwrite.
    const flavoredC = await addEncounter(campaignC, [
      { name: 'slimey giant rat', count: 1, source: { type: 'rulebook', chunkId } },
    ]);
    await enqueueMobPortraits(flavoredC, campaignC);
    await drainMobQueue();
    expect(generateImagesMock).toHaveBeenCalledTimes(3);
    const reread = await getMobPortraitCacheEntry(chunkId);
    expect(reread?.imageId).toBe(canonicalImageId);
    const mobC = await getAnyArtifact(
      await getOrCreateMobArtifact(campaignC, chunkId, 'slimey giant rat'),
    );
    expect(mobC?.coverImageId).not.toBeNull();
    expect(mobC?.coverImageId).not.toBe(canonicalImageId);

    // The first flavored cover is grandfathered — the canonical publish
    // never re-touched it.
    const mobAAfter = await getAnyArtifact(
      await getOrCreateMobArtifact(campaignA, chunkId, 'slimey giant rat'),
    );
    expect(mobAAfter?.coverImageId).toBe(flavorCoverA);
  });

  it('a chunk with no usable heading generates locally and never writes the cache', async () => {
    const chunkId = await seedCreatureChunk('Nameless', GIANT_RAT_TEXT, ['  ', '']);
    const campaignId = (await createCampaign({ name: 'A', system: 'dnd5e' })).id;
    const encounter = await addEncounter(campaignId, [
      { name: 'Nameless Horror', count: 1, source: { type: 'rulebook', chunkId } },
    ]);
    const result = await enqueueMobPortraits(encounter, campaignId);
    expect(result.enqueued).toBe(1);
    await drainMobQueue();
    expect(generateImagesMock).toHaveBeenCalledTimes(1);
    expect(await db.mobPortraits.count()).toBe(0);
    expect(toastErrorMock).not.toHaveBeenCalled();
  });
});

describe('generate-once single-flight', () => {
  it('concurrent canonical ensures across campaigns share one generation', async () => {
    const chunkId = await seedCreatureChunk('Giant Rat', GIANT_RAT_TEXT);
    const campaignA = (await createCampaign({ name: 'A', system: 'dnd5e' })).id;
    const campaignB = (await createCampaign({ name: 'B', system: 'dnd5e' })).id;

    const [first, second] = await Promise.all([
      ensureCanonicalMobPortrait({ chunkId, campaignId: campaignA }),
      ensureCanonicalMobPortrait({ chunkId, campaignId: campaignB }),
    ]);
    // One generation shared by both callers: same slot image, one model
    // call, one cache row (joiners share the owner's settled result).
    expect(first.imageId).toBe(second.imageId);
    expect(generateImagesMock).toHaveBeenCalledTimes(1);
    expect(await db.mobPortraits.where('chunkId').equals(chunkId).count()).toBe(1);

    // Settled work leaves no pending entry: the next call is a fast-path hit.
    const third = await ensureCanonicalMobPortrait({ chunkId, campaignId: campaignA });
    expect(third).toEqual({ imageId: first.imageId, generated: false });
    expect(generateImagesMock).toHaveBeenCalledTimes(1);
  });
});

describe('firewall: non-rulebook rows never touch the cache seam', () => {
  it('npc-ref/inline/none roster entries enqueue nothing and open no cache transaction', async () => {
    const chunkId = await seedCreatureChunk('Giant Rat', GIANT_RAT_TEXT);
    const campaignId = (await createCampaign({ name: 'A', system: 'dnd5e' })).id;
    // Populate the cache so a stray read would be observable (this one
    // population generation is the last model call the test allows).
    await ensureCanonicalMobPortrait({ chunkId, campaignId });
    expect(await db.mobPortraits.count()).toBe(1);
    generateImagesMock.mockClear();

    const npc = await createArtifact({
      campaignId,
      kind: 'npc',
      name: 'Captain Vane',
      data: { appearance: 'scarred', personality: 'bold', statBlock: null },
    });
    const encounter = await addEncounter(campaignId, [
      { name: 'Captain Vane', count: 1, source: { type: 'npc-ref', artifactId: npc.id } },
      { name: 'One-off Ooze', count: 1, source: { type: 'inline', statBlock: testStatBlock() } },
      { name: 'Unnamed Horror', count: 1, source: { type: 'none' } },
    ]);

    const tables = await transactionTablesDuring(async () => {
      const result = await enqueueMobPortraits(encounter, campaignId);
      expect(result).toEqual({ enqueued: 0, alreadyImaged: [] });
    });
    expect(useMobPortraitQueue.getState().queued).toHaveLength(0);
    expect(tables).not.toContain('mobPortraits');
    expect(generateImagesMock).not.toHaveBeenCalled();
    expect(await db.mobPortraits.count()).toBe(1);
  });

  it('the creation-dialog extra (module-NPC-shaped, no chunk) generates locally with no cache touch', async () => {
    const campaignId = (await createCampaign({ name: 'A', system: 'dnd5e' })).id;
    // A module-generated NPC: npc kind WITHOUT the monsterChunkId marker.
    const npc = await createArtifact({
      campaignId,
      kind: 'npc',
      name: 'Generated Guard',
      data: { appearance: 'tall guard', personality: 'dutiful', statBlock: null },
    });

    const tables = await transactionTablesDuring(async () => {
      enqueueArtifactPortrait((await getAnyArtifact(npc.id)) ?? npc, campaignId);
      await drainMobQueue();
    });
    expect(generateImagesMock).toHaveBeenCalledTimes(1);
    expect(tables).not.toContain('mobPortraits');
    expect(await db.mobPortraits.count()).toBe(0);
    const after = await getAnyArtifact(npc.id);
    expect(after?.coverImageId).not.toBeNull();
  });

  it('invented creatures (inline/none) stay LOCAL ONLY: no populate, no overwrite, no read', async () => {
    const chunkId = await seedCreatureChunk('Giant Rat', GIANT_RAT_TEXT);
    const campaignId = (await createCampaign({ name: 'A', system: 'dnd5e' })).id;
    // Populate the cache so a stray read or overwrite would be observable.
    await ensureCanonicalMobPortrait({ chunkId, campaignId });
    const entry = await getMobPortraitCacheEntry(chunkId);
    expect(entry).toBeDefined();
    generateImagesMock.mockClear();

    const encounter = await addEncounter(campaignId, [
      { name: 'Gloom Ooze', count: 1, source: { type: 'inline', statBlock: testStatBlock() } },
      { name: 'Whisper Wisp', count: 1, source: { type: 'none' } },
    ]);

    const tables = await transactionTablesDuring(async () => {
      const result = await enqueueInventedCreaturePortraits(encounter, campaignId);
      expect(result.enqueued).toBe(2);
      await drainMobQueue();
    });
    // Two local generations (grounded on the entries' own content), zero
    // cache traffic: neither the materialize nor the worker opens the seam.
    expect(generateImagesMock).toHaveBeenCalledTimes(2);
    expect(tables).not.toContain('mobPortraits');
    expect(await db.mobPortraits.count()).toBe(1);
    expect((await getMobPortraitCacheEntry(chunkId))?.imageId).toBe(entry?.imageId);
  });

  it('gates every source shape: only rulebook-with-chunkId produces a key', () => {
    expect(
      cacheKeyForMonsterSource({ type: 'rulebook', chunkId: newId() }),
    ).not.toBeNull();
    expect(cacheKeyForMonsterSource({ type: 'npc-ref', artifactId: newId() })).toBeNull();
    expect(
      cacheKeyForMonsterSource({ type: 'inline', statBlock: testStatBlock() }),
    ).toBeNull();
    expect(cacheKeyForMonsterSource({ type: 'none' })).toBeNull();
    expect(
      cacheKeyForMonsterSource({ type: 'rulebook', chunkId: undefined } as never),
    ).toBeNull();
  });

  it('derives the canonical name from the last heading and matches citations case-insensitively', () => {
    expect(canonicalCreatureName({ headingPath: ['Giant Rat'] })).toBe('Giant Rat');
    expect(canonicalCreatureName({ headingPath: ['Bestiary', 'Giant Rat'] })).toBe('Giant Rat');
    expect(canonicalCreatureName({ headingPath: ['  ', ''] })).toBeNull();
    expect(canonicalCreatureName({ headingPath: [] })).toBeNull();
    expect(isCanonicalCitation('Giant Rat', 'giant rat')).toBe(true);
    expect(isCanonicalCitation('Giant Rat', '  GIANT RAT ')).toBe(true);
    expect(isCanonicalCitation('Giant Rat', 'slimey giant rat')).toBe(false);
  });

  it('default get-or-create callers (seed/finalize shape) never touch the cache seam', async () => {
    const chunkId = await seedCreatureChunk('Giant Rat', GIANT_RAT_TEXT);
    const campaignId = (await createCampaign({ name: 'A', system: 'dnd5e' })).id;
    const tables = await transactionTablesDuring(async () => {
      await getOrCreateMobArtifact(campaignId, chunkId, 'Giant Rat');
    });
    expect(tables).not.toContain('mobPortraits');
  });
});

describe('cache-blob prune immunity (NEVER-DELETE)', () => {
  it('the cached blob survives campaign prune, global delete-if-unreferenced, clone-owner deletion and campaign deletion', async () => {
    const chunkId = await seedCreatureChunk('Giant Rat', GIANT_RAT_TEXT);
    const campaignA = (await createCampaign({ name: 'A', system: 'dnd5e' })).id;
    const campaignB = (await createCampaign({ name: 'B', system: 'dnd5e' })).id;

    const ensured = await ensureCanonicalMobPortrait({ chunkId, campaignId: campaignA });
    const cachedId = ensured.imageId;
    // The prune-immunity set names the shared blob.
    expect(await cachedMobPortraitImageIds()).toContain(cachedId);

    // A campaign prune with the blob referenced by nothing still keeps it.
    await pruneUnreferencedImages(campaignA);
    expect(await getImage(cachedId)).toBeDefined();

    // The global unreferenced path explicitly refuses the cached blob.
    expect(await deleteImageIfUnreferenced(cachedId)).toBe(false);
    expect(await getImage(cachedId)).toBeDefined();
    expect(await getMobPortraitCacheEntry(chunkId)).toBeDefined();

    // Cloning the cover, then deleting the clone's owner, prunes the clone
    // but never the cached blob.
    const encounterB = await addEncounter(campaignB, [
      { name: 'Giant Rat', count: 1, source: { type: 'rulebook', chunkId } },
    ]);
    await enqueueMobPortraits(encounterB, campaignB);
    const mobB = await getAnyArtifact(
      await getOrCreateMobArtifact(campaignB, chunkId, 'Giant Rat'),
    );
    const cloneId = mobB?.coverImageId ?? '';
    expect(cloneId).not.toBe(cachedId);
    await deleteArtifact(mobB?.id ?? '');
    expect(await getImage(cloneId)).toBeUndefined();
    expect(await getImage(cachedId)).toBeDefined();
    expect(await getMobPortraitCacheEntry(chunkId)).toBeDefined();

    // Deleting a whole campaign only removes its own images.
    await deleteCampaign(campaignB);
    expect(await getImage(cachedId)).toBeDefined();
    expect(await getMobPortraitCacheEntry(chunkId)).toBeDefined();
  });
});

describe('loud failures (no placeholder art)', () => {
  it('a vanished chunk fails loud per mob with no cache write', async () => {
    const campaignId = (await createCampaign({ name: 'A', system: 'dnd5e' })).id;
    const encounter = await addEncounter(campaignId, [
      { name: 'Ghost Boss', count: 1, source: { type: 'rulebook', chunkId: newId() } },
    ]);
    const result = await enqueueMobPortraits(encounter, campaignId);
    expect(result.enqueued).toBe(1);
    await pollFor('failure toast', () => toastErrorMock.mock.calls.length > 0);
    const call = toastErrorMock.mock.calls[0];
    expect(call?.[0]).toBe('Could not generate a portrait for "Ghost Boss"');
    expect((call?.[1] as Error).message).toContain('stat-block chunk no longer exists');
    expect(await db.mobPortraits.count()).toBe(0);
    expect(generateImagesMock).not.toHaveBeenCalled();
    expect(chatMock).not.toHaveBeenCalled();
  });
});
