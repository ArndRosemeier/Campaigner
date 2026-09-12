import 'fake-indexeddb/auto';

import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact, getAnyArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { creatureCoverImageId } from '@/db/creatureRepo';
import { putChunks } from '@/db/chunkRepo';
import { db } from '@/db/db';
import { createRulebook } from '@/db/rulebookRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { updateSettings } from '@/db/settingsRepo';
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
          creatureRef: { chunkId, creatureName: 'Goblin Boss' },
        },
      })
    ).id;
    const encounter = await addEncounter([
      { name: 'Goblin Boss', count: 1, source: { type: 'rulebook', chunkId } },
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
          creatureRef: { chunkId, creatureName: 'Goblin Boss' },
        },
      })
    ).id;
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
