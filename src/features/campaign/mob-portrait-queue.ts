import { imageBlob, type AnyArtifact, type Id, type StoredImage } from '@/domain';
import { GAME_SYSTEM_LABELS } from '@/domain/gameSystem';
import { attachImagesToArtifact, getAnyArtifact } from '@/db/artifactRepo';
import { getCampaign } from '@/db/campaignRepo';
import { getChunksByIds } from '@/db/chunkRepo';
import {
  creatureCoverImageId,
  setCreatureCover,
} from '@/db/creatureRepo';
import { creatureImageIdsByKey } from '@/db/creatureImages';
import { canonicalCreatureName, isCanonicalCitation } from '@/db/mobPortraitCache';
import { db } from '@/db/db';
import { createImage } from '@/db/imageRepo';
import { getSettings } from '@/db/settingsRepo';
import { generateOneImage, type GeneratedOneImage } from '@/llm/oneImage';
import {
  buildImagePrompt,
  MOB_PORTRAIT_TEXT_NEGATIVE,
  portraitGroundingForChunk,
} from '@/llm/imagePromptDraft';
import type { ImagePromptDraft } from '@/llm/schemas';
import { createJobQueue } from '@/lib/jobQueue';
import {
  portraitArtIn,
  rosterParticipantRoute,
  type KindArt,
} from '@/features/campaign/mob-portrait-participants';
import {
  ensureCanonicalMobPortrait,
  regenerateCanonicalMobPortrait,
} from '@/features/campaign/mob-portrait-cache-queue';

/**
 * Creature portrait queue (docs/11 D5 amendment; re-based on creature IDENTITY
 * by the owner-ratified core-mob arc): one click on the encounter editor's
 * "Generate mob portraits" enumerates the encounter's creature kinds and
 * generates ONE portrait per creature (n=1), landing as the campaign's
 * PRESENTATION row for that identity (`db/creatureImages`) — or on an authored
 * NPC's own cover when the roster row points at one. Portraits reach the battle
 * tokens through the token's `creatureKey`. No artifact is created, and none
 * has to exist for a portrait to exist.
 *
 * A deliberate variant of the entity image queue (08 §M4-C) with the SAME
 * mechanics — pump with `maxParallelRequests` workers, intake, the shared
 * `buildImagePrompt` contract, skip-if-imaged, loud per-creature toasts
 * (EntityBatchFailure {name, message} style) — but keyed by **creature
 * identity**: the queue's wiki-link name resolution does not fit a creature,
 * and prompt grounding is the cited chunk's stat-exempt portrait grounding
 * (`portraitGroundingForChunk`) (an invented mob has no appearance text — its
 * name plus its roster notes are the only description there is).
 *
 * The pump/dedupe/cancellation/failed-retry/dock-counter machinery is the
 * shared `createJobQueue` factory (F6) — this module is the config plus the
 * per-job body. Like every queue on the factory, it does NOT survive a
 * reload (in-memory by design; see createJobQueue's docs).
 *
 * Global portrait cache (docs/11 D5 amendment, slice A): canonical citations
 * (the citing entry used the chunk's canonical name) generate ONCE through
 * the cache worker (`mob-portrait-cache-queue`, cross-campaign single-flight)
 * and publish into the global slot; every later campaign clones the bytes
 * instead of generating. Flavored citations generate locally and never touch
 * the cache — neither read nor write.
 *
 * ENUMERATION COVERS EVERY ROSTER PARTICIPANT THAT CAN OWN A PORTRAIT
 * (`rosterParticipantRoute`, the ONE spelling of the routing rule): a row that
 * CITES a library creature (a `rulebook` entry, or an authored NPC whose stat
 * block is derived from one) rides the canonical lane; a row pointing at a
 * hand-authored NPC rides the authored lane and is illustrated against that
 * artifact; an uncited entry (`inline` / `none`) is an invented mob keyed on
 * its own content. Nothing is created to hold any of them.
 *
 * The batch NEVER pre-clones while it counts (owner report, one-sided
 * replace-all confirm): a cover-less canonical citation is a NORMAL job — the
 * worker's canonical branch finds the populated slot and CLONES the bytes (no
 * second generation, no API call) — so `alreadyImaged` names only the kinds
 * that already showed a portrait before the press, and a hole is always
 * reported as work. `planMobPortraitBatch` is the read-only half of the same
 * enumeration: it creates nothing, clones nothing and enqueues nothing, so the
 * surface can state the counts before the owner chooses.
 *
 * Single-creature entry points (battle surface selection card): the same queue
 * and the same regen phases for ONE already-resolved target
 * (`enqueueSingleMobPortrait` / `regenerateSingleMobPortrait`) — no second
 * pipeline, no second replace path.
 *
 * Preservation (docs/11 D5 preservation rule): regeneration NEVER detaches
 * first. Every regen entry enqueues delete-after-replace jobs (`regen: true`):
 * the worker generates fresh bytes and swaps the portrait only after they
 * exist, so a failed generation, a skipped job, or an in-memory queue dropped
 * on reload leaves the old portrait intact, with a loud error surfacing on the
 * queue's per-creature failure path.
 */

export interface MobPortraitJob {
  campaignId: Id;
  /** The encounter that owns the roster — groups the progress-dock job.
   * Undefined for the creation-dialog portrait extra (a single artifact,
   * grouped by the artifact itself). */
  encounterId?: Id;
  /** `CreatureIdentity.key` — the portrait identity (ONE per creature). */
  creatureKey: string;
  /** The authored NPC this creature is illustrated ON, when the roster row
   * points at one (a cast or hand-made NPC). Absent ⇒ the campaign's
   * presentation row for `creatureKey` receives the portrait. */
  artifactId?: Id;
  /** Display name (the roster creature name) for progress + failures. */
  name: string;
  /** The creature's cited stat-block chunk — grounds the prompt. Absent for an
   * invented mob (no library row) and for the creation-dialog portrait extra,
   * where the artifact's own data grounds the prompt. */
  chunkId?: Id;
  /**
   * The UNCITED roster row's own description — the roster `notes` the writer
   * wrote about the invented creature (docs/11 D5 amendment; owner decision
   * docs/17 row 90: *"A special look for a special zombie is ok"*). An invented
   * mob has no artifact and no chunk, so these notes ARE its description; the
   * shared prompt contract refuses to illustrate an empty one (`buildImagePrompt`
   * throws on "no appearance, summary, or body"), which is what keeps this from
   * becoming a picture of a name. Absent for every cited/artefact-keyed job,
   * which grounds on its chunk or its row instead. */
  grounding?: string;
  /** Delete-after-replace regen (docs/11 D5 preservation rule): the worker
   * generates FRESH bytes even though the creature is imaged, then swaps the
   * portrait — the old one survives until the fresh one commits.
   * Absent/false = the normal skip-if-imaged path. */
  regen?: boolean;
}

export const useMobPortraitQueue = createJobQueue<MobPortraitJob>({
  name: 'mob-portrait-queue',
  key: (job) => `${job.campaignId}:${job.creatureKey}`,
  dockGroup: (job) => ({ id: jobIdFor(job), label: 'Generating mob portraits' }),
  activeDetail: (job) => `Illustrating "${job.name}"…`,
  settledDetail: (job, outcome) =>
    outcome === 'done' ? `Illustrated "${job.name}"` : `Skipped "${job.name}"`,
  failureTitle: (job) => `Could not generate a portrait for "${job.name}"`,
  workerCount: async () => {
    const settings = await getSettings();
    return Math.max(1, settings.maxParallelRequests);
  },
  process: processJob,
});

function jobIdFor(job: MobPortraitJob): string {
  return job.encounterId === undefined
    ? `artifact-portrait-${job.artifactId ?? job.creatureKey}`
    : `encounter-mob-portraits-${job.encounterId}`;
}

/** The creature's current portrait, whatever holds it: the campaign's
 * presentation row, or — for an authored NPC — that artifact's own cover.
 * `null` when the creature has no art at all. */
async function currentPortrait(job: MobPortraitJob): Promise<Id | null> {
  return creatureCoverImageId({
    campaignId: job.campaignId,
    creatureKey: job.creatureKey,
    ...(job.artifactId === undefined ? {} : { npcArtifactId: job.artifactId }),
  });
}

/**
 * Commits ONE finished image as a creature's portrait — THE one commit seam of
 * this queue, for both the canonical-clone and the local-generation flavors:
 *
 * - an AUTHORED NPC standing in the roster is written on its own artifact
 *   through the attach seam (one transaction, `asCover`), with the regen
 *   flavor releasing the superseded ids ATOMICALLY with the fresh cover's
 *   commit, so a failure leaves the old portrait intact;
 * - every other creature is written as this campaign's presentation row
 *   (`db/creatureRepo.setCreatureCover`, delete-after-replace: the new pin
 *   lands first, the old blob is released only when nothing else references
 *   it). A stored row must already exist — an image is never referenced
 *   before its bytes are on disk.
 */
async function commitCreaturePortrait(options: {
  job: MobPortraitJob;
  /** The stored image row the portrait is (canonical clone or fresh bytes). */
  imageId: Id;
  /** The bytes to attach when the portrait belongs on an artifact's cover. */
  attach: GeneratedOneImage | null;
  /** The stored row to reference when the portrait belongs on the campaign's
   * presentation row. */
  storedRow: StoredImage | null;
}): Promise<void> {
  const { job } = options;
  if (job.artifactId !== undefined) {
    if (options.attach === null) {
      throw new Error(
        `creature portrait: no image bytes to attach for "${job.name}" — regenerate the portrait`,
      );
    }
    const superseded = job.regen === true ? await liveArtifactImages(job.artifactId) : [];
    await attachImagesToArtifact(job.artifactId, {
      createImages: [{ ...options.attach, campaignId: job.campaignId, source: 'generated', asCover: true }],
      ...(superseded.length === 0
        ? {}
        : {
            removeImageIds: superseded,
            scrubImageIds: superseded,
            pruneCandidates: { campaignId: job.campaignId, candidateIds: superseded },
          }),
    });
    return;
  }
  if (options.storedRow === null) {
    throw new Error(
      `creature portrait: no stored image for "${job.name}" — regenerate the portrait`,
    );
  }
  await setCreatureCover({
    campaignId: job.campaignId,
    creatureKey: job.creatureKey,
    imageId: options.storedRow.id,
  });
}

/** Stores a fresh campaign-scoped row from the generated blob. The blob's byte
 * conversion happens in `db/imageRepo.buildStoredImage` — BEFORE any write
 * transaction opens (the Dexie async-transaction trap). */
async function storeGeneratedRow(
  campaignId: Id,
  portrait: GeneratedOneImage,
): Promise<StoredImage> {
  return createImage({ campaignId, source: 'generated', role: 'artwork', ...portrait });
}

/** Every live image reference on an artifact (cover + gallery) — the regen
 * superseded set: the replacement's commit releases exactly these pins. */
async function liveArtifactImages(artifactId: Id): Promise<Id[]> {
  const artifact = await getAnyArtifact(artifactId);
  if (artifact === undefined) return [];
  return [
    ...new Set([
      ...(artifact.coverImageId === null ? [] : [artifact.coverImageId]),
      ...artifact.imageIds,
    ]),
  ];
}

/** The canonical slot's shared bytes as an attachable pair — the clone path a
 * CREATURE citation takes (the global row is never attached itself). */
async function slotBytes(imageId: Id): Promise<GeneratedOneImage> {
  const cached = await db.images.get(imageId);
  if (cached === undefined) {
    throw new Error(
      'creature portrait cache: the cached portrait image is gone — regenerate the portrait',
    );
  }
  return {
    blob: imageBlob(cached),
    mimeType: cached.mimeType,
    width: cached.width,
    height: cached.height,
    prompt: cached.prompt,
    model: cached.model,
  };
}

async function processJob(
  job: MobPortraitJob,
  ctx: { signal: AbortSignal },
): Promise<'done' | 'skipped'> {
  const settings = await getSettings();
  if (!settings.imagesEnabled) {
    throw new Error('Image generation is disabled — enable it in Settings');
  }
  // A portrait may have appeared while the job sat in the queue (an upload,
  // another queue run) — no re-generation of imaged creatures. Regen jobs
  // (`regen: true`) flow past this branch: they generate FRESH bytes and swap
  // the portrait delete-after-replace (the old one stays until the fresh one
  // commits — a failed, skipped, or dropped regen never destroys it).
  if ((await currentPortrait(job)) !== null && job.regen !== true) return 'skipped';

  const artifact = job.artifactId === undefined ? undefined : await getAnyArtifact(job.artifactId);
  // An invented mob (no artifact, no chunk) is described by nothing but the
  // roster row's own notes — passed on the job, never read back off a row that
  // does not exist (docs/11 D5: an uncited creature is never materialized).
  // Chunk-grounded jobs (library citations) carry the text-render negative
  // explicitly; an invented mob and the creation-dialog extra ground on their
  // own text and ride the shared default-on guard (docs/11 D5, generalized).
  let chunkGrounded = false;
  let summary = '';
  let body: string;
  if (job.chunkId !== undefined) {
    const chunk = (await getChunksByIds([job.chunkId]))[0];
    if (chunk === undefined) {
      throw new Error('the creature\u2019s stat-block chunk no longer exists');
    }
    if (chunk.text.trim() === '') {
      throw new Error('the creature\u2019s stat-block chunk has no text to ground the prompt');
    }
    const canonical = canonicalCreatureName(chunk);
    if (canonical !== null && isCanonicalCitation(canonical, job.name)) {
      // Canonical citation (docs/11 D5 amendment, slice A): the citing entry
      // used the chunk's canonical name, so the single generation serves BOTH
      // the rendered portrait and the global cache slot — generate once through
      // the cache worker (cross-campaign single-flight), then clone the bytes.
      const ensured = await ensureCanonicalMobPortrait({
        creatureKey: job.creatureKey,
        chunkId: job.chunkId,
        campaignId: job.campaignId,
        signal: ctx.signal,
      });
      return (await commitCachedPortrait({ job, imageId: ensured.imageId })) === 'done'
        ? 'done'
        : 'skipped';
    }
    // Grounding: the cited chunk's STAT-EXEMPT portrait grounding
    // (portraitGroundingForChunk — size/type identity + traits/actions prose,
    // never raw stat numbers). The text-render negative rides along (belt and
    // braces: models must not letter stat text into the portrait).
    body = portraitGroundingForChunk(chunk);
    chunkGrounded = true;
  } else if (artifact !== undefined) {
    // An authored NPC or an invented mob row: the row's own content grounds the
    // prompt (the appearance shortcut still wins inside the shared contract).
    // Empty summary AND body throw in buildImagePrompt — a blank image of
    // nothing is a placeholder, never a fallback.
    summary = artifact.summary;
    body = artifact.body;
  } else {
    // A pure invented mob: the roster row's notes are the whole description.
    // Empty notes fall through to `buildImagePrompt`, which throws loudly —
    // the creature is described first, never illustrated from its name.
    body = job.grounding ?? '';
  }
  const prompt = await draftPrompt(job, artifact, summary, body, chunkGrounded);
  // n=1 (owner-ratified): ONE portrait per creature kind. The seam owns the
  // prompt contract assembly, the n=1 call (and why its candidate-count caps
  // cannot fire), the empty-result refusal and the EXIF-safe intake.
  const portrait = await generateOneImage(prompt, {
    model: settings.imageModel,
    signal: ctx.signal,
  });
  // A LOCAL generation is this campaign's own portrait: it is stored as a
  // campaign-scoped row and never published to the shared canonical slot (a
  // flavored citation and an invented mob are local-only by construction), and
  // its bytes are what an authored NPC's cover receives.
  const stored = await storeGeneratedRow(job.campaignId, portrait);
  await commitCreaturePortrait({ job, imageId: stored.id, attach: portrait, storedRow: stored });
  return 'done';
}

/**
 * Commits the SHARED canonical slot's bytes as this creature's portrait — a
 * plain clone (no generation) on the normal path, a forced replace on regen.
 * The clone's own row is campaign-scoped; the global slot row is never
 * attached, so one generation serves every campaign. A creature that belongs to
 * an authored NPC has no presentation row at all, so its clone lands on that
 * artifact's cover (skip-if-imaged: an edited portrait is never overwritten).
 */
async function commitCachedPortrait(options: {
  job: MobPortraitJob;
  imageId: Id;
}): Promise<'done' | 'skipped'> {
  const { job } = options;
  if (job.artifactId !== undefined && job.regen !== true) {
    const artifact = await getAnyArtifact(job.artifactId);
    if (artifact === undefined) {
      throw new Error(
        `creature portrait: the artifact for "${job.name}" no longer exists — reopen it and generate again`,
      );
    }
    if (artifact.coverImageId !== null || artifact.imageIds.length > 0) return 'skipped';
  }
  const bytes = await slotBytes(options.imageId);
  const stored = await storeGeneratedRow(job.campaignId, bytes);
  await commitCreaturePortrait({ job, imageId: stored.id, attach: bytes, storedRow: stored });
  return 'done';
}

/** Prompt-draft for one creature — the shared Illustrator prompt contract
 * (buildImagePrompt: appearance shortcut, body/summary/name grounding) with the
 * queue's wiring: no run row, the campaign's rule system for the style hint,
 * and the grounding text as the description. Chunk-grounded jobs pass the
 * text-render negative explicitly; a local job rides the contract default.
 * Deterministic: no chat call, no repair retry. */
async function draftPrompt(
  job: MobPortraitJob,
  artifact: AnyArtifact | undefined,
  summary: string,
  body: string,
  chunkGrounded: boolean,
): Promise<ImagePromptDraft> {
  let systemLabel = 'D&D 5e';
  const campaign = await getCampaign(job.campaignId);
  if (campaign !== undefined) {
    systemLabel = GAME_SYSTEM_LABELS[campaign.system];
  }
  return buildImagePrompt(
    {
      name: artifact?.name ?? job.name,
      kind: 'npc',
      summary,
      body,
      data: artifact?.data ?? null,
    },
    { systemLabel, negative: chunkGrounded ? MOB_PORTRAIT_TEXT_NEGATIVE : undefined },
  );
}

/**
 * Enqueues delete-after-replace regen jobs, upgrading any stale queued or
 * in-flight normal job for the same creature FIRST. The queue dedupes by
 * creature identity: a regen dropped against a stale normal job would strand
 * the regen as a silent no-op (the normal job skips on the still-imaged
 * creature and drains). The stale job is withdrawn before the regen is
 * enqueued — it never committed portrait work over an imaged creature (the
 * skip branch), so withdrawing it destroys nothing. State is probed first so
 * the dock counters move only when a real job is withdrawn.
 */
function enqueueRegenJobs(jobs: MobPortraitJob[]): void {
  const state = useMobPortraitQueue.getState();
  const keys = new Set(jobs.map((job) => `${job.campaignId}:${job.creatureKey}`));
  const stale = [...state.queued, ...state.active].filter((queued) =>
    keys.has(`${queued.campaignId}:${queued.creatureKey}`),
  );
  for (const job of stale) state.dequeue(job);
  state.enqueue(jobs.map((job) => ({ ...job, regen: true })));
}

/** One creature kind of the encounter's roster (the dedupe unit: one portrait
 * per identity, shared by every roster row citing it). */
interface BatchKind {
  /**
   * The ROUTE this kind came in on (`rosterParticipantRoute`'s lane). Load
   * bearing, not bookkeeping: the two batches split the roster between them
   * (`enqueueMobPortraits` owns `creature` + `authored`, the invented batch
   * owns `invented`), and without the lane on the kind the split would have to
   * be re-derived from shape — exactly the kind of second spelling this arc
   * exists to delete. A kind is enqueued by ONE batch, never both.
   */
  lane: 'creature' | 'authored' | 'invented';
  /** The kind's name — the first roster row that cites it wins. */
  name: string;
  /** The creature's portrait identity. */
  creatureKey: string;
  /** The cited stat-block chunk (prompt grounding) — absent for an invented
   * mob and for a content-hash-only citation. */
  chunkId?: Id;
  /** The authored NPC this creature is illustrated ON, when one stands in the
   * roster. */
  artifactId?: Id;
  /** True when the portrait already exists. */
  imaged: boolean;
}

interface BatchEnumeration {
  creatures: BatchKind[];
  /** Roster rows that collapsed onto a kind already counted — the
   * one-portrait-per-creature-kind share. Counted, never silently dropped. */
  sharedRows: number;
}

/**
 * The batch's ONE enumeration, shared by the additive batch, the two regen
 * paths and the read-only count — so what the surface promises and what the
 * queue does can never drift. Every lane resolves through
 * `rosterParticipantRoute` (the ONE spelling of the routing rule the
 * module-level gap detector reads too).
 *
 * A `missing-ref` (dangling `npc-ref`) throws loud — the counts must never
 * promise a fill the enqueue would refuse to perform (the message prefix is
 * the caller's own label).
 */
async function enumerateBatchKinds(
  encounter: AnyArtifact & { kind: 'encounter' },
  campaignId: Id,
  label: string,
): Promise<BatchEnumeration> {
  const enumerated: BatchEnumeration = { creatures: [], sharedRows: 0 };
  /** Kind identity, ONE spelling per kind: the creature identity for a cited
   * creature, the artifact id for an authored NPC. */
  const seenKinds = new Set<string>();
  const presentation = await creatureImageIdsByKey(campaignId);

  const add = (kind: BatchKind): void => {
    if (seenKinds.has(kind.creatureKey)) {
      enumerated.sharedRows += 1;
      return;
    }
    seenKinds.add(kind.creatureKey);
    enumerated.creatures.push(kind);
  };

  for (const entry of encounter.data.monsters) {
    const linked =
      entry.source.type === 'npc-ref' ? await getAnyArtifact(entry.source.artifactId) : undefined;
    const route = rosterParticipantRoute(entry, linked);
    if (route.lane === 'missing-ref') {
      throw new Error(
        `${label}: the artifact for "${entry.name}" no longer exists — re-run the encounter content to restore it`,
      );
    }
    if (route.lane === 'authored') {
      const artifact = await getAnyArtifact(route.artifactId);
      if (artifact === undefined) {
        throw new Error(
          `${label}: the artifact for "${route.name}" no longer exists — re-run the encounter content to restore it`,
        );
      }
      add({
        lane: 'authored',
        name: route.name,
        creatureKey: `artifact:${route.artifactId}`,
        artifactId: route.artifactId,
        imaged: artifact.coverImageId !== null || artifact.imageIds.length > 0,
      });
      continue;
    }
    if (route.lane === 'invented') {
      add({
        lane: 'invented',
        name: route.name,
        creatureKey: route.creatureKey,
        imaged: portraitArtIn(presentation, route.creatureKey) !== 'none',
      });
      continue;
    }
    // A library creature citation, or an authored NPC whose stats derive from
    // one: ONE canonical portrait per identity.
    add({
      lane: 'creature',
      name: route.name,
      creatureKey: route.creatureKey,
      ...(route.chunkId === undefined ? {} : { chunkId: route.chunkId }),
      ...(route.artifactId === null ? {} : { artifactId: route.artifactId }),
      // THE portrait question, asked once through the one seam every renderer
      // asks (docs/11 D6): the campaign's presentation row for the identity,
      // else the CAST npc's own cover. Reading only the presentation row here
      // reported a cast npc that already carries a portrait as MISSING, so the
      // batch would generate a second one over the owner's art — the offer and
      // the render disagreeing in the direction that destroys work.
      imaged:
        (await creatureCoverImageId({
          campaignId,
          creatureKey: route.creatureKey,
          npcArtifactId: route.artifactId,
        })) !== null,
    });
  }
  return enumerated;
}

export interface MobPortraitBatchResult {
  /** Cover-less creatures enqueued for generation (deduped by identity). */
  enqueued: number;
  /** Creature names whose portrait already exists. */
  alreadyImaged: string[];
}

/**
 * The CITING half of an enumeration — the kinds `enqueueMobPortraits` and the
 * cited regen path own: a library citation (with or without a chunk) or an
 * authored NPC standing in the roster. The invented lane is deliberately NOT
 * here: `enqueueInventedCreaturePortraits` owns it, and both callers run both
 * batches — a lane claimed by both would enqueue every uncited mob twice and
 * charge the image model for it.
 */
function citedKinds(kinds: readonly BatchKind[]): BatchKind[] {
  return kinds.filter((kind) => kind.lane !== 'invented');
}

/**
 * The batch action (encounter editor): enumerates the encounter's creature
 * kinds, dedupes by identity, skips imaged ones and enqueues the rest. NOTHING
 * is created: a citation needs no row, and an uncited mob is keyed on its own
 * content (docs/11 D5). A dangling `npc-ref` fails loudly instead of silently
 * diverging identities.
 *
 * NO enumeration-time cache clone (owner report): a cover-less canonical
 * citation is a JOB here, and the worker's canonical branch clones the
 * populated global slot instead of generating (one generation per creature,
 * unchanged) — so `alreadyImaged` names only the kinds that already showed a
 * portrait before this call, and a hole is always reported as work.
 */
export async function enqueueMobPortraits(
  encounter: AnyArtifact & { kind: 'encounter' },
  campaignId: Id,
): Promise<MobPortraitBatchResult> {
  const enumerated = await enumerateBatchKinds(encounter, campaignId, 'Generate mob portraits');
  const jobs: MobPortraitJob[] = [];
  const alreadyImaged: string[] = [];
  for (const kind of citedKinds(enumerated.creatures)) {
    if (kind.imaged) {
      alreadyImaged.push(kind.name);
      continue;
    }
    jobs.push({
      campaignId,
      encounterId: encounter.id,
      creatureKey: kind.creatureKey,
      name: kind.name,
      ...(kind.chunkId === undefined ? {} : { chunkId: kind.chunkId }),
      ...(kind.artifactId === undefined ? {} : { artifactId: kind.artifactId }),
    });
  }
  useMobPortraitQueue.getState().enqueue(jobs);
  return { enqueued: jobs.length, alreadyImaged };
}

/**
 * The read-only half of the batch enumeration — what the confirm dialog needs
 * to state the truth BEFORE the owner chooses. Creates nothing (no artifact,
 * no creature), clones nothing, enqueues nothing; every number it returns is
 * exactly what the additive batch and the two regen paths will do, because it
 * walks the same enumeration (its counts are pinned against the run's own
 * result).
 */
export interface MobPortraitBatchPlan {
  /** Creature kinds with no art at all — exactly what the fill enqueues. */
  missing: string[];
  /** Creature kinds that already carry art (the batch skips these). */
  imaged: string[];
  /** Roster rows that collapsed onto a creature kind already counted (the
   * one-portrait-per-kind share). */
  sharedRows: number;
  /** Imaged library kinds cited canonically (Monster Core): REPLACING them
   * republishes the shared slot, so every future portrait in every campaign
   * uses the new art (existing covers elsewhere keep theirs) — the confirm
   * must say so before the choice. */
  sharedPortraitNames: string[];
  /** Imaged library kinds whose citation can no longer be read: replacing
   * them fails loudly and keeps their portrait (the count never hides it). */
  unreadableCitations: string[];
}

export async function planMobPortraitBatch(
  encounter: AnyArtifact & { kind: 'encounter' },
  campaignId: Id,
): Promise<MobPortraitBatchPlan> {
  const enumerated = await enumerateBatchKinds(encounter, campaignId, 'Generate mob portraits');
  // EVERY participant that can own a portrait — the plan describes the whole
  // press (both lanes run), not one lane's half of it.
  const kinds = enumerated.creatures;
  const imaged = kinds.filter((kind) => kind.imaged);
  const sharedPortraitNames: string[] = [];
  const unreadableCitations: string[] = [];
  for (const kind of imaged) {
    if (kind.chunkId === undefined) continue;
    const chunk = (await getChunksByIds([kind.chunkId]))[0];
    if (chunk === undefined) {
      // The replace path throws loud on this (kept portrait); the count reports
      // it instead of quietly presenting the kind as an ordinary shared one.
      unreadableCitations.push(kind.name);
      continue;
    }
    const canonical = canonicalCreatureName(chunk);
    if (canonical !== null && isCanonicalCitation(canonical, kind.name)) {
      sharedPortraitNames.push(kind.name);
    }
  }
  return {
    missing: kinds.filter((kind) => !kind.imaged).map((kind) => kind.name),
    imaged: imaged.map((kind) => kind.name),
    sharedRows: enumerated.sharedRows,
    sharedPortraitNames,
    unreadableCitations,
  };
}

/**
 * Owner-ordered portrait regeneration (docs/11 D5 amendment) — THE one way to
 * regen a creature portrait (docs/18). Three phases:
 *
 * 1. Resolve + validate with NO side effects: unreadable chunks throw loud
 *    with every old portrait still intact.
 * 2. Fresh canonical bytes FIRST: each canonically-cited creature's global
 *    slot is republished (`regenerateCanonicalMobPortrait` — always generates;
 *    a plain re-enqueue would clone identical bytes, a no-op regen). A failed
 *    republish throws loud here with every old portrait still intact — nothing
 *    is enqueued. Flavored citations skip the cache entirely (local-only
 *    invariant).
 * 3. Enqueue delete-after-replace regen jobs for the imaged kinds (plus the
 *    normal cover-less batch for the remainder). The old portraits stay until
 *    each worker commits its replacement; a failed, skipped, or queue-dropped
 *    regen leaves the old portrait intact (loud error, never silent loss).
 */
export interface MobPortraitRegenResult {
  /** Imaged creatures replaced delete-after-replace (deduped by identity). */
  regenerated: number;
  /** Citing names whose canonical global slot now carries fresh bytes. */
  republishedCanonical: string[];
}

export async function regenerateMobPortraits(
  encounter: AnyArtifact & { kind: 'encounter' },
  campaignId: Id,
): Promise<MobPortraitRegenResult> {
  const enumerated = await enumerateBatchKinds(encounter, campaignId, 'Regenerate mob portraits');
  const imaged = citedKinds(enumerated.creatures).filter((kind) => kind.imaged);
  const republishedCanonical: string[] = [];
  const republishedKeys = new Set<string>();
  for (const target of imaged) {
    if (target.chunkId === undefined) continue;
    const chunk = (await getChunksByIds([target.chunkId]))[0];
    if (chunk === undefined) {
      throw new Error(
        `Regenerate mob portraits: the stat-block chunk for "${target.name}" no longer exists — kept the existing portrait`,
      );
    }
    const canonical = canonicalCreatureName(chunk);
    if (
      canonical !== null &&
      isCanonicalCitation(canonical, target.name) &&
      !republishedKeys.has(target.creatureKey)
    ) {
      republishedKeys.add(target.creatureKey);
      await regenerateCanonicalMobPortrait({
        creatureKey: target.creatureKey,
        chunkId: target.chunkId,
        campaignId,
      });
      republishedCanonical.push(target.name);
    }
  }
  enqueueRegenJobs(
    imaged.map((target) => ({
      campaignId,
      encounterId: encounter.id,
      creatureKey: target.creatureKey,
      name: target.name,
      ...(target.chunkId === undefined ? {} : { chunkId: target.chunkId }),
      ...(target.artifactId === undefined ? {} : { artifactId: target.artifactId }),
    })),
  );
  // The cover-less remainder flows through the normal batch. Imaged targets
  // enumerate away there as already-imaged: no second job.
  await enqueueMobPortraits(encounter, campaignId);
  return { regenerated: imaged.length, republishedCanonical };
}

/**
 * The creation-dialog "Generate a cover image" extra (ratified): ONE
 * artifact-keyed portrait job with the SAME mechanics as the batch —
 * attach-as-cover, skip-if-imaged, loud per-artifact toasts — grounded on
 * the artifact's own content. Works for every artifact kind.
 */
export function enqueueArtifactPortrait(artifact: AnyArtifact, campaignId: Id): void {
  useMobPortraitQueue.getState().enqueue([
    {
      campaignId,
      // The artifact itself is the identity the job dedupes and reports on; it
      // has no creature identity, which is exactly why it belongs here.
      creatureKey: `artifact:${artifact.id}`,
      artifactId: artifact.id,
      name: artifact.name,
    },
  ]);
}

/**
 * A single creature, resolved by a caller that already holds the identity (the
 * battle surface's selection card resolves its token's `creatureKey`).
 */
export interface SingleMobPortraitTarget {
  campaignId: Id;
  /** `CreatureIdentity.key` — the portrait identity. */
  creatureKey: string;
  /** The cited stat-block chunk — grounds the prompt, stat-exempt. Absent for
   * an invented mob (its content identity is the key). */
  chunkId?: Id | undefined;
  /** The authored NPC this creature is illustrated on, when one exists. */
  artifactId?: Id | undefined;
  /** The citing name (roster entry or token label) for the
   * canonical-vs-flavor citation check the worker performs. */
  name: string;
}

/**
 * The battle-card "Generate portrait" action: ONE creature-keyed job through
 * the SAME queue as the editor batch — same dock group shape, same
 * identity-keyed dedupe, same skip-if-imaged worker branch, same loud
 * per-creature failure path. Silent at enqueue time exactly like the batch (the
 * app-wide progress dock carries the feedback).
 */
export function enqueueSingleMobPortrait(target: SingleMobPortraitTarget): void {
  const name = target.name.trim();
  if (name === '') {
    throw new Error(
      'creature portrait: the citing name is empty — name the creature before generating',
    );
  }
  useMobPortraitQueue.getState().enqueue([
    {
      campaignId: target.campaignId,
      creatureKey: target.creatureKey,
      name,
      ...(target.chunkId === undefined ? {} : { chunkId: target.chunkId }),
      ...(target.artifactId === undefined ? {} : { artifactId: target.artifactId }),
    },
  ]);
}

export interface SingleMobPortraitRegenResult {
  /** False when the portrait landed elsewhere between the card read and Confirm
   * (the worker's skip branch would no-op) — the caller replays the
   * already-generated toast instead of detaching nothing. */
  regenerated: boolean;
  /** True when the citation is canonical and the global slot now carries
   * fresh bytes (the caller owes the loud shared-consequence toast). */
  republishedCanonical: boolean;
}

/**
 * The battle-card "Regenerate portrait" action — the single-creature flavor of
 * `regenerateMobPortraits` (docs/18: delete-after-replace is the one way).
 * Same three phases on ONE target: resolve + validate with NO side effects
 * (an unreadable chunk throws loud with the old portrait intact), republish the
 * canonical slot with FRESH bytes first for canonical citations (flavored
 * citations stay local-only; a failed republish throws loud with the old
 * portrait intact and nothing enqueued), then enqueue a delete-after-replace
 * regen job.
 */
export async function regenerateSingleMobPortrait(
  target: SingleMobPortraitTarget,
): Promise<SingleMobPortraitRegenResult> {
  const name = target.name.trim();
  if (name === '') {
    throw new Error(
      'creature portrait: the citing name is empty — name the creature before regenerating',
    );
  }
  const current = await creatureCoverImageId({
    campaignId: target.campaignId,
    creatureKey: target.creatureKey,
    ...(target.artifactId === undefined ? {} : { npcArtifactId: target.artifactId }),
  });
  if (current === null) return { regenerated: false, republishedCanonical: false };
  let isCanonical = false;
  if (target.chunkId !== undefined) {
    const chunk = (await getChunksByIds([target.chunkId]))[0];
    if (chunk === undefined) {
      throw new Error(
        `Regenerate mob portrait: the stat-block chunk for "${name}" no longer exists — kept the existing portrait`,
      );
    }
    const canonical = canonicalCreatureName(chunk);
    isCanonical = canonical !== null && isCanonicalCitation(canonical, name);
    if (isCanonical) {
      await regenerateCanonicalMobPortrait({
        creatureKey: target.creatureKey,
        chunkId: target.chunkId,
        campaignId: target.campaignId,
      });
    }
  }
  enqueueRegenJobs([
    {
      campaignId: target.campaignId,
      creatureKey: target.creatureKey,
      name,
      ...(target.chunkId === undefined ? {} : { chunkId: target.chunkId }),
      ...(target.artifactId === undefined ? {} : { artifactId: target.artifactId }),
    },
  ]);
  return { regenerated: true, republishedCanonical: isCanonical };
}

export interface InventedCreatureBatchResult {
  /** Cover-less invented creatures enqueued for local generation. */
  enqueued: number;
  /** Creature names whose portrait already exists. */
  alreadyImaged: string[];
}

/** The indexes of the encounter's UNCITED roster entries (`inline` / `none`) —
 * the invented lane's own scope, ONE spelling. */
function inventedEntryIndexes(monsters: readonly { source: { type: string } }[]): number[] {
  return monsters
    .map((entry, index) => ({ type: entry.source.type, index }))
    .filter(({ type }) => type === 'inline' || type === 'none')
    .map(({ index }) => index);
}

/**
 * The per-entry / batch-all action for the encounter's UNCITED entries
 * (docs/11 D5 amendment; owner decision 2026-09-10, docs/17 row 90 —
 * *"A special look for a special zombie is ok"*): an invented mob (`inline` /
 * `none`) gets a LOCAL portrait keyed on its own CONTENT. No artifact is
 * created (the previous model materialized one; that is the model this arc
 * deletes), so the action can never introduce an authored NPC into the
 * campaign — the encounter writer may only cite.
 *
 * Local-only by construction: the job carries NO chunkId, so the worker cannot
 * reach the global canonical slot (neither read nor write). One creature, one
 * look: the content key means two encounters inventing the same named thing
 * share its portrait.
 *
 * Pass `entryIndexes` for the per-entry action (a single roster row); omit it
 * for batch-all. Cited creatures ride `enqueueMobPortraits`.
 */
export async function enqueueInventedCreaturePortraits(
  encounter: AnyArtifact & { kind: 'encounter' },
  campaignId: Id,
  entryIndexes?: readonly number[],
): Promise<InventedCreatureBatchResult> {
  const only = entryIndexes === undefined ? undefined : new Set(entryIndexes);
  const kinds = await enumerateBatchKinds(encounter, campaignId, 'Create creature portraits');
  const jobs: MobPortraitJob[] = [];
  const alreadyImaged: string[] = [];
  // ONE creature, ONE job. The roster may cite the same invented creature on
  // several rows (the same inline stat block twice), and the plan the confirm
  // dialog showed counted that creature ONCE (`planMobPortraitBatch` enumerates
  // deduped kinds) — so `enqueued` must count distinct creatures too, or the
  // batch reports work it never does (the queue dedupes by `creatureKey`, so a
  // duplicate job is silently dropped and the count is a lie). `enqueueMobPortraits`
  // iterates the deduped kinds for the same reason; this lane iterates entries
  // only because it needs each row's own `notes` as prompt grounding.
  const seen = new Set<string>();
  for (const index of inventedEntryIndexes(encounter.data.monsters)) {
    if (only !== undefined && !only.has(index)) continue;
    const entry = encounter.data.monsters[index];
    if (entry === undefined) continue;
    const route = rosterParticipantRoute(entry, undefined);
    if (route.lane !== 'invented') continue;
    if (seen.has(route.creatureKey)) continue;
    const kind = kinds.creatures.find((row) => row.creatureKey === route.creatureKey);
    if (kind === undefined) continue;
    seen.add(route.creatureKey);
    if (kind.imaged) {
      alreadyImaged.push(kind.name);
      continue;
    }
    jobs.push({
      campaignId,
      encounterId: encounter.id,
      creatureKey: route.creatureKey,
      name: route.name,
      ...(entry.notes.trim() === '' ? {} : { grounding: entry.notes }),
    });
  }
  useMobPortraitQueue.getState().enqueue(jobs);
  return { enqueued: jobs.length, alreadyImaged };
}

export interface InventedCreatureRegenResult {
  /** Imaged invented creatures re-enqueued (deduped by identity). */
  regenerated: number;
}

/**
 * Owner-ordered portrait regeneration for invented roster entries (docs/11 D5
 * amendment) — THE one way to regen an invented creature's portrait
 * (docs/18). Enqueues delete-after-replace regen jobs for the imaged ones
 * (chunk-less local-only jobs — the canonical firewall holds: an invented
 * portrait never reads, populates, or overwrites the global slot, regen
 * included), then runs the normal invented batch for the cover-less remainder.
 * The old portraits stay until each worker commits its replacement.
 *
 * Pass `entryIndexes` for the per-entry action; omit it for batch-all.
 */
export async function regenerateInventedCreaturePortraits(
  encounter: AnyArtifact & { kind: 'encounter' },
  campaignId: Id,
  entryIndexes?: readonly number[],
): Promise<InventedCreatureRegenResult> {
  const only = entryIndexes === undefined ? undefined : new Set(entryIndexes);
  const kinds = await enumerateBatchKinds(encounter, campaignId, 'Regenerate creature portraits');
  const regen: MobPortraitJob[] = [];
  const seen = new Set<string>();
  for (const index of inventedEntryIndexes(encounter.data.monsters)) {
    if (only !== undefined && !only.has(index)) continue;
    const entry = encounter.data.monsters[index];
    if (entry === undefined) continue;
    const route = rosterParticipantRoute(entry, undefined);
    if (route.lane !== 'invented') continue;
    const kind = kinds.creatures.find((row) => row.creatureKey === route.creatureKey);
    if (kind === undefined || !kind.imaged || seen.has(route.creatureKey)) continue;
    seen.add(route.creatureKey);
    regen.push({
      campaignId,
      encounterId: encounter.id,
      creatureKey: route.creatureKey,
      name: route.name,
      ...(entry.notes.trim() === '' ? {} : { grounding: entry.notes }),
    });
  }
  enqueueRegenJobs(regen);
  // The cover-less remainder flows through the normal invented batch.
  await enqueueInventedCreaturePortraits(encounter, campaignId, entryIndexes);
  return { regenerated: regen.length };
}

/** The `KindArt` vocabulary this queue's counts speak (re-exported so the
 * surfaces import it from one place). */
export type { KindArt };
