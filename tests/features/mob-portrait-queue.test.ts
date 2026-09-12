import 'fake-indexeddb/auto';

import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact, listArtifactsByCampaign } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { putChunks } from '@/db/chunkRepo';
import { creaturePortraitArt, setCreatureCover } from '@/db/creatureRepo';
import { createImage, getImage } from '@/db/imageRepo';
import { createRulebook } from '@/db/rulebookRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { updateSettings } from '@/db/settingsRepo';
import {
  contentCreatureKey,
  libraryCreatureKey,
  newId,
  ruleChunkSchema,
  stampNewEntity,
  statBlockSchema,
} from '@/domain';
import {
  enqueueInventedCreaturePortraits,
  enqueueMobPortraits,
  useMobPortraitQueue,
} from '@/features/campaign/mob-portrait-queue';
import { sha256Hex } from '@/lib/hash';
import { useProgressStore } from '@/lib/progress';
import { clearDatabase } from '../db/helpers';

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

const GOBLIN_TEXT = 'Goblin Boss, humanoid, agile commander. HP 21, AC 17.';

/** The creature's portrait image id, read through the ONE identity seam. */
async function creatureCoverIdOf(campaignId: string, creatureKey: string): Promise<string | null> {
  const { creatureCoverImageId } = await import('@/db/creatureRepo');
  return creatureCoverImageId({ campaignId, creatureKey });
}

function blobOf(text: string): Blob {
  return new Blob([text], { type: 'image/png' });
}

let campaignId = '';
let encounterId = '';

async function seedCreatureChunk(creatureName: string, text: string): Promise<string> {
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
  generateImagesMock.mockResolvedValue({ images: [blobOf('gen')], costUsd: 0.01, cappedToOne: false, modelUsed: 'test-image-model', fallback: null, filteredCount: 0 });
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
    useMobPortraitQueue.getState().enqueue([
      { campaignId, encounterId, creatureKey, name: 'Goblin Boss', chunkId },
    ]);

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
    expect(finalPrompt).toContain('Avoid: text, letters, numbers');
    // Provenance lands on the image row; the queue and dock drain.
    const coverId = await creatureCoverIdOf(campaignId, creatureKey);
    const stored = await getImage(coverId ?? '');
    expect(stored?.source).toBe('generated');
    expect(stored?.prompt).not.toContain(GOBLIN_TEXT);
    expect(stored?.prompt).toContain('Avoid: text, letters, numbers');
    expect(useMobPortraitQueue.getState().queued).toHaveLength(0);
    expect(useMobPortraitQueue.getState().active).toEqual([]);
    expect(
      useProgressStore.getState().jobs.find((job) => job.id === `encounter-mob-portraits-${encounterId}`),
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
    expect(finalPrompt).toContain('Avoid: text, letters, numbers');
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

    useMobPortraitQueue.getState().enqueue([
      { campaignId, encounterId, creatureKey, name: 'Goblin Boss', chunkId },
    ]);
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
    useMobPortraitQueue.getState().enqueue([
      { campaignId, encounterId, creatureKey, name: 'Goblin Boss', chunkId },
    ]);
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
      { name: 'Ogre', count: 2, source: { type: 'rulebook', chunkId: ogreChunkId } },
      // Same chunk again: the SAME identity — no second job, and the share is
      // reported rather than silently dropped.
      { name: 'Ogre', count: 1, source: { type: 'rulebook', chunkId: ogreChunkId } },
      // Pre-imaged goblin: enumerated away.
      { name: 'Goblin Boss', count: 2, source: { type: 'rulebook', chunkId: goblinChunkId } },
      // An uncited entry is not a library citation — its ROSTER NOTES are its
      // only description (docs/11 D5; the owner's "special zombie" decision).
      {
        name: 'Troll',
        count: 1,
        notes: 'A hulking troll with mossy green hide and one cracked tusk.',
        source: { type: 'none' },
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
      expect(await creaturePortraitArt(campaignId, libraryCreatureKey(ogreChunkId))).toBe('cover');
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
      expect(await creaturePortraitArt(campaignId, contentCreatureKey('Troll', null))).toBe('cover');
    });
    expect(generateImagesMock).toHaveBeenCalledTimes(2);
    expect(await listArtifactsByCampaign(campaignId)).toHaveLength(1);
  });

  it('refuses to illustrate an invented mob nobody described (no picture of a name)', async () => {
    const encounter = await addEncounter([{ name: 'Nameless Thing', count: 1, source: { type: 'none' } }]);
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
    expect(await creaturePortraitArt(campaignId, contentCreatureKey('Nameless Thing', null))).toBe(
      'none',
    );
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
