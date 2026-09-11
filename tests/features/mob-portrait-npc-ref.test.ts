import 'fake-indexeddb/auto';

import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact, getAnyArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { putChunks } from '@/db/chunkRepo';
import { db } from '@/db/db';
import { createRulebook } from '@/db/rulebookRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { updateSettings } from '@/db/settingsRepo';
import { getOrCreateMobArtifact } from '@/db/mobArtifacts';
import {
  newId,
  ruleChunkSchema,
  stampNewEntity,
  statBlockSchema,
  type Id,
} from '@/domain';
import {
  enqueueInventedCreaturePortraits,
  enqueueMobPortraits,
  planMobPortraitBatch,
  useMobPortraitQueue,
} from '@/features/campaign/mob-portrait-queue';
import { sha256Hex } from '@/lib/hash';
import { useProgressStore } from '@/lib/progress';
import { clearDatabase } from '../db/helpers';

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
 * What is pinned here:
 * - every roster participant that can own a portrait is enumerated, routed by
 *   what its artifact IS (chunk-backed = the shared bestiary portrait; no
 *   chunk marker = a LOCAL portrait of its own);
 * - the canonical-portrait firewall: a local invented job carries NO chunkId,
 *   so it can never read or write the global `mobPortraits` cache — and a
 *   distinct invented creature never inherits a rulebook creature's art;
 * - an artifact that already carries art is reported imaged and never
 *   re-generated, detached or replaced by enumeration (a named NPC standing in
 *   the fight keeps her portrait);
 * - the existing `inline` lane is unchanged (non-regression).
 *
 * Revert-proof: restore the two `if (entry.source.type !== …) continue;`
 * guards in `enumerateBatchKinds` (i.e. drop the routing) and every npc-ref
 * test below fails — the plan is empty, `enqueueInventedCreaturePortraits`
 * enqueues nothing, and the owner's "No creatures to illustrate" state comes
 * back.
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
  const book = await createRulebook({ title: 'Bestiary', system: 'dnd5e', filename: 'bestiary.pdf' });
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
  monsters: { name: string; count: number; source: Record<string, unknown>; notes?: string }[],
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
      artWithoutCover: [],
      sharedRows: 0,
      creates: 0,
      sharedPortraitNames: [],
      unreadableCitations: [],
    });

    const result = await enqueueInventedCreaturePortraits(encounter, campaignId);
    // `created` counts the on-demand artifacts this lane materialized: an
    // npc-ref row already HAS its artifact, so it is enumerated, not created.
    expect(result).toEqual({ created: 0, enqueued: 1, alreadyImaged: [] });
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
    await enqueueInventedCreaturePortraits(encounter, campaignId);
    await waitFor(async () => {
      expect((await getAnyArtifact(lumberjack))?.coverImageId).not.toBeNull();
    });
    const coverAfterFirst = (await getAnyArtifact(lumberjack))?.coverImageId ?? null;
    useMobPortraitQueue.getState().reset();

    const plan = await planMobPortraitBatch(encounter, campaignId);
    expect(plan.missing).toEqual([]);
    expect(plan.imaged).toEqual(['Risen Lumberjack']);
    expect(plan.artWithoutCover).toEqual([]);

    const result = await enqueueInventedCreaturePortraits(encounter, campaignId);
    expect(result).toEqual({ created: 0, enqueued: 0, alreadyImaged: ['Risen Lumberjack'] });
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
    await enqueueInventedCreaturePortraits(encounter, campaignId);
    await waitFor(async () => {
      expect((await getAnyArtifact(npc.id))?.coverImageId).not.toBeNull();
    });
    const cover = (await getAnyArtifact(npc.id))?.coverImageId ?? null;
    expect(generateImagesMock).toHaveBeenCalledTimes(1);
    useMobPortraitQueue.getState().reset();

    const plan = await planMobPortraitBatch(encounter, campaignId);
    expect(plan.imaged).toEqual(['Captain Vell']);
    const again = await enqueueInventedCreaturePortraits(encounter, campaignId);
    expect(again).toEqual({ created: 0, enqueued: 0, alreadyImaged: ['Captain Vell'] });
    expect(generateImagesMock).toHaveBeenCalledTimes(1);
    expect((await getAnyArtifact(npc.id))?.coverImageId).toBe(cover);
  });
});

describe('rulebook-backed npc-ref rows share the bestiary portrait (no second local job)', () => {
  it('routes an npc-ref to a mob artifact into the rulebook lane, deduped with the citation', async () => {
    const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
    const mobArtifactId = await getOrCreateMobArtifact(campaignId, chunkId, 'Goblin Boss');
    const encounter = await addEncounter([
      { name: 'Goblin Boss', count: 1, source: { type: 'rulebook', chunkId } },
      // The same creature cited a second time through its artifact — the shape
      // an encounter ends up with when a roster row is linked directly.
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
    expect(queued[0]?.artifactId).toBe(mobArtifactId);

    await waitFor(async () => {
      expect((await getAnyArtifact(mobArtifactId))?.coverImageId).not.toBeNull();
    });
    // The canonical citation published the shared slot — the bestiary art is
    // ONE image per creature, and the invented lane enqueued nothing for it.
    expect(await db.mobPortraits.count()).toBe(1);
    const localAgain = await enqueueInventedCreaturePortraits(encounter, campaignId);
    expect(localAgain).toEqual({ created: 0, enqueued: 0, alreadyImaged: [] });
  });

  it('does not re-illustrate locally a rulebook creature that already has shared art', async () => {
    const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
    const mobArtifactId = await getOrCreateMobArtifact(campaignId, chunkId, 'Goblin Boss');
    await enqueueMobPortraits(
      await (async () => {
        const encounter = await addEncounter([
          { name: 'Goblin Boss', count: 1, source: { type: 'rulebook', chunkId } },
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
    const result = await enqueueInventedCreaturePortraits(second, campaignId);
    // The invented lane owns nothing here: the row's creature is chunk-backed.
    expect(result).toEqual({ created: 0, enqueued: 0, alreadyImaged: [] });
    const rulebook = await enqueueMobPortraits(second, campaignId);
    expect(rulebook).toEqual({ enqueued: 0, alreadyImaged: ['Goblin Boss'] });
    expect(generateImagesMock).not.toHaveBeenCalled();
  });
});

describe('the existing lanes are untouched (non-regression)', () => {
  it('an inline entry and a rulebook creature still enumerate exactly as before', async () => {
    const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
    const encounter = await addEncounter([
      { name: 'Goblin Boss', count: 1, source: { type: 'rulebook', chunkId } },
      { name: 'Gloom Ooze', count: 2, source: { type: 'inline', statBlock: creatureBlock('1') }, notes: 'drips gloom' },
    ]);
    if (encounter.kind !== 'encounter') throw new Error('not an encounter');

    const plan = await planMobPortraitBatch(encounter, campaignId);
    expect(plan.missing).toEqual(['Goblin Boss', 'Gloom Ooze']);
    expect(plan.imaged).toEqual([]);

    const rulebook = await enqueueMobPortraits(encounter, campaignId);
    expect(rulebook.enqueued).toBe(1);
    const invented = await enqueueInventedCreaturePortraits(encounter, campaignId);
    expect(invented).toEqual({ created: 1, enqueued: 1, alreadyImaged: [] });

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

    const result = await enqueueInventedCreaturePortraits(encounter, campaignId, [1]);
    expect(result).toEqual({ created: 0, enqueued: 1, alreadyImaged: [] });
    const queued = inFlight();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.name).toBe('Risen Lumberjack');
    expect(queued[0]?.artifactId).toBe(lumberjack);
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
    await expect(enqueueInventedCreaturePortraits(encounter, campaignId)).rejects.toThrow(
      /the artifact for "Risen Lumberjack" no longer exists/,
    );
    expect(inFlight()).toHaveLength(0);
  });
});
