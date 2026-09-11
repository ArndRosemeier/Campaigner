import type { AnyArtifact, Id } from '@/domain';
import { GAME_SYSTEM_LABELS } from '@/domain/gameSystem';
import { getAnyArtifact, attachImagesToArtifact } from '@/db/artifactRepo';
import { getCampaign } from '@/db/campaignRepo';
import { getChunksByIds } from '@/db/chunkRepo';
import {
  findInventedCreatureArtifact,
  findMobArtifactByChunk,
  getOrCreateMobArtifact,
  materializeInventedCreatureArtifact,
} from '@/db/mobArtifacts';
import {
  canonicalCreatureName,
  cloneCachedPortraitToArtifact,
  isCanonicalCitation,
  supersededCoverIds,
} from '@/db/mobPortraitCache';
import { getSettings } from '@/db/settingsRepo';
import { generateImages } from '@/llm/imageGen';
import {
  assembleImagePrompt,
  buildImagePrompt,
  MOB_PORTRAIT_TEXT_NEGATIVE,
  portraitGroundingForChunk,
} from '@/llm/imagePromptDraft';
import type { ImagePromptDraft } from '@/llm/schemas';
import { createJobQueue } from '@/lib/jobQueue';
import { intakeImage } from '@/lib/imageIntake';
import { ensureCanonicalMobPortrait, regenerateCanonicalMobPortrait } from '@/features/campaign/mob-portrait-cache-queue';

/**
 * Mob portrait queue (owner-ratified mob-artifact arc): one click on the
 * encounter editor's "Generate mob portraits" enumerates the encounter's
 * rulebook-cited creature kinds and generates ONE portrait per mob artifact
 * (n=1), attached as its cover. Portraits then reach the battle tokens
 * through the existing `coverImageId` path — zero BattleSurface changes.
 *
 * A deliberate variant of the entity image queue (08 §M4-C) with the SAME
 * mechanics — pump with `maxParallelRequests` workers, intake, the shared
 * `buildImagePrompt` contract, attach-as-cover, skip-if-imaged, loud
 * per-mob toasts (EntityBatchFailure {name, message} style) — but keyed by
 * **artifactId**: the queue's wiki-link name resolution does not fit mob
 * artifacts, and prompt grounding is the creature chunk's stat-exempt portrait grounding (`portraitGroundingForChunk`)
 * (a fresh mob artifact has empty appearance/body — the chunk is the only
 * source; the artifact's own `appearance` shortcut still wins when the user
 * filled it). Never rides the persona run pipeline (the Illustrator's pick
 * step always pauses; an unattended batch cannot).
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
 * (owner report, docs/17 row 90 — a materialized monster was invisible to this
 * batch and could never be illustrated). Routing is by what a row's creature
 * IS, never by the shape of its `source`: a row whose creature is chunk-backed
 * (a `rulebook` citation, or an `npc-ref` to a mob artifact carrying
 * `data.monsterChunkId`) is a RULEBOOK kind and shares the one bestiary
 * portrait; every other participant — `inline`, `none`, and an `npc-ref` to an
 * artifact with no chunk marker (the encounter's materialized inline-statblock
 * monster, or a named NPC standing in the roster) — is an INVENTED kind with a
 * local, artifact-grounded job that can never reach the cache.
 *
 * The batch NEVER pre-clones while it counts (owner report, one-sided
 * replace-all confirm): enumerating with `getOrCreateMobArtifact`'s
 * cache read-through made a cover-less citation arrive already imaged, so a
 * hole the owner could see was reported as `alreadyImaged` and the press
 * opened the replace-all confirm — a claim about art that did not exist
 * before the press. A cover-less canonical citation is now a NORMAL job: the
 * worker's canonical branch finds the populated slot and CLONES the bytes
 * (no second generation, no API call) — the same one-generation rule, with
 * honest counts. `planMobPortraitBatch` is the read-only half of the same
 * enumeration: it creates nothing, clones nothing and enqueues nothing, so
 * the surface can state the counts before the owner chooses.
 *
 * Single-mob entry points (battle surface selection card, docs/11 D5): the
 * same queue and the same regen phases for ONE already-resolved target
 * (`enqueueSingleMobPortrait` / `regenerateSingleMobPortrait`) — no second
 * pipeline, no second replace path.
 *
 * Preservation (docs/11 D5 preservation rule): regeneration NEVER detaches
 * first. Every regen entry enqueues delete-after-replace jobs (`regen: true`):
 * the worker generates fresh bytes, then swaps the cover in ONE attach-seam
 * transaction (fresh cover commits, ONLY the superseded ids are scrubbed
 * from this artifact's snapshots and refcount-pruned). A failed generation,
 * a skipped job, or an in-memory queue dropped on reload leaves the old
 * portrait — blob and restore path — intact, with a loud error surfacing on
 * the queue's per-mob failure path.
 */

export interface MobPortraitJob {
  campaignId: Id;
  /** The encounter that owns the roster — groups the progress-dock job.
   * Undefined for the creation-dialog portrait extra (a single artifact,
   * grouped by the artifact itself). */
  encounterId?: Id;
  /** The mob artifact to illustrate (ONE per creature kind per campaign). */
  artifactId: Id;
  /** Display name (the roster creature name) for progress + failures. */
  name: string;
  /** The creature's stat-block chunk — grounds the prompt. Undefined for
   * the creation-dialog portrait extra, which grounds on the artifact's own
   * data (name/summary/body + the appearance shortcut). */
  chunkId?: Id;
  /** Delete-after-replace regen (docs/11 D5 preservation rule): the worker
   * generates FRESH bytes even though the artifact is imaged, then swaps
   * the cover atomically — the old cover (blob + snapshot pins) survives
   * until the fresh cover commits, and only the superseded blob is freed.
   * Absent/false = the normal skip-if-imaged path. */
  regen?: boolean;
}

export const useMobPortraitQueue = createJobQueue<MobPortraitJob>({
  name: 'mob-portrait-queue',
  key: (job) => `${job.campaignId}:${job.artifactId}`,
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
    ? `artifact-portrait-${job.artifactId}`
    : `encounter-mob-portraits-${job.encounterId}`;
}

async function processJob(
  job: MobPortraitJob,
  ctx: { signal: AbortSignal },
): Promise<'done' | 'skipped'> {
  const settings = await getSettings();
  if (!settings.imagesEnabled) {
    throw new Error('Image generation is disabled — enable it in Settings');
  }
  const artifact = await getAnyArtifact(job.artifactId);
  if (artifact === undefined) {
    throw new Error('the mob artifact no longer exists — regenerate the encounter');
  }
  // A cover may have appeared while the job sat in the queue (editor
  // upload, another queue run) — no re-generation of imaged mobs. Regen
  // jobs (`regen: true`) flow past this branch: they generate FRESH bytes
  // and swap the cover delete-after-replace (the old cover stays until the
  // fresh one commits — a failed, skipped, or dropped regen never destroys
  // the existing portrait).
  const superseded = supersededCoverIds(artifact);
  if (superseded.length > 0 && job.regen !== true) {
    return 'skipped';
  }
  const summary = artifact.summary;
  let body: string;
  // Chunk-grounded jobs (rulebook citations) carry the text-render
  // negative explicitly; the creation-dialog extra grounds on user content
  // and rides the shared default-on guard (docs/11 D5, generalized — the
  // contract defaults `negative` when the caller passes none).
  let chunkGrounded: boolean;
  if (job.chunkId !== undefined) {
    const chunk = (await getChunksByIds([job.chunkId]))[0];
    if (chunk === undefined) {
      throw new Error('the creature\u2019s stat-block chunk no longer exists');
    }
    if (chunk.text.trim() === '') {
      throw new Error('the creature\u2019s stat-block chunk has no text to ground the prompt');
    }
    // Canonical citation (docs/11 D5 amendment, slice A): the citing entry
    // used the chunk's canonical name, so the single normal generation
    // serves BOTH the cover and the global cache slot — generate once via
    // the cache worker (cross-campaign single-flight), then clone the bytes
    // into this artifact's cover. A flavored citation falls through to the
    // local-only path below: its flavored cover and NOTHING ELSE (no cache
    // write, no overwrite, no behind-the-back canonical generation).
    const canonical = canonicalCreatureName(chunk);
    if (canonical !== null && isCanonicalCitation(canonical, job.name)) {
      const ensured = await ensureCanonicalMobPortrait({
        chunkId: job.chunkId,
        campaignId: job.campaignId,
        signal: ctx.signal,
      });
      // Regen clones with `force` (the slot already carries FRESH bytes from
      // the entry's republish phase): the clone commits as the new cover
      // FIRST, then the superseded blob is freed — never detached first.
      const outcome = await cloneCachedPortraitToArtifact({
        artifactId: artifact.id,
        campaignId: job.campaignId,
        imageId: ensured.imageId,
        ...(job.regen === true ? { force: true } : {}),
      });
      return outcome === 'cloned' ? 'done' : 'skipped';
    }
    // Grounding: the creature chunk's STAT-EXEMPT portrait grounding
    // (portraitGroundingForChunk — size/type identity + traits/actions
    // prose, never raw stat numbers) — the only description a fresh mob
    // artifact has. The text-render negative rides along (belt and braces:
    // models must not letter stat text into the portrait).
    body = portraitGroundingForChunk(chunk);
    chunkGrounded = true;
  } else {
    // Creation-dialog portrait extra: the artifact's own content grounds
    // the prompt (the appearance shortcut still wins inside the shared
    // contract). Empty summary AND body throw in buildImagePrompt —
    // a blank image of nothing is a placeholder, never a fallback.
    body = artifact.body;
    chunkGrounded = false;
  }
  const prompt = await draftPrompt(artifact, summary, body, job.campaignId, {
    negative: chunkGrounded ? MOB_PORTRAIT_TEXT_NEGATIVE : undefined,
  });
  const finalPrompt = assembleImagePrompt(prompt);
  // n=1 (owner-ratified): one portrait per creature kind — candidate-count
  // caps (imageGen's n-retry, cappedToOne) cannot trigger on this path.
  const generated = await generateImages(finalPrompt, 1, {
    model: settings.imageModel,
    signal: ctx.signal,
  });
  const blob = generated.images[0];
  if (blob === undefined) throw new Error('the image API returned no image');
  const intake = await intakeImage(blob);
  // Store + attach (as cover) is ONE repo transaction — a crash between
  // the image write and the artifact update must not leak the blob as an
  // unreferenced orphan or leave the artifact pointing at nothing. Regen
  // jobs ride the same transaction as a delete-after-replace: the fresh
  // cover commits FIRST (gallery swap + snapshot scrub of ONLY the
  // superseded ids + refcount prune), so the old portrait survives until
  // the replacement lands and a failed job leaves it untouched.
  await attachImagesToArtifact(artifact.id, {
    createImages: [
      {
        campaignId: job.campaignId,
        blob: intake.blob,
        mimeType: intake.mimeType,
        width: intake.width,
        height: intake.height,
        prompt: finalPrompt,
        model: generated.modelUsed,
        source: 'generated',
        // The skip branch above guarantees the artifact had no image yet —
        // unless this is a regen job replacing the superseded set below.
        asCover: true,
      },
    ],
    ...(superseded.length === 0
      ? {}
      : {
          removeImageIds: superseded,
          scrubImageIds: superseded,
          pruneCandidates: { campaignId: job.campaignId, candidateIds: superseded },
        }),
  });
  return 'done';
}

/** Prompt-draft for one mob artifact — the shared Illustrator prompt contract
 * (buildImagePrompt: appearance shortcut, body/summary/name grounding) with
 * the queue's wiring: no run row, the campaign's rule system for the style
 * hint, and the grounding text as the description (the chunk's stat-exempt
 * portrait grounding, or — for the creation-dialog portrait extra — the
 * artifact's own content, guarded by the contract default). Chunk-grounded
 * jobs pass the text-render negative explicitly (identical to the default
 * via the alias); the creation-dialog extra passes none and rides the
 * default. Deterministic: no chat call, no repair retry. */
async function draftPrompt(
  artifact: AnyArtifact,
  summary: string,
  body: string,
  campaignId: Id,
  opts?: { negative?: string | undefined },
): Promise<ImagePromptDraft> {
  let systemLabel = 'D&D 5e';
  const campaign = await getCampaign(campaignId);
  if (campaign !== undefined) {
    systemLabel = GAME_SYSTEM_LABELS[campaign.system];
  }
  return buildImagePrompt(
    {
      name: artifact.name,
      kind: artifact.kind,
      summary,
      body,
      data: artifact.data,
    },
    { systemLabel, negative: opts?.negative },
  );
}

/**
 * Enqueues delete-after-replace regen jobs, upgrading any stale queued or
 * in-flight normal job for the same artifact FIRST. The queue dedupes by
 * artifact key: a regen dropped against a stale normal job would strand the
 * regen as a silent no-op (the normal job skips on the still-imaged
 * artifact and drains). The stale job is withdrawn before the regen is
 * enqueued — it never committed cover work over an imaged artifact (the
 * skip branch), so withdrawing it destroys nothing. State is probed first
 * so the dock counters move only when a real job is withdrawn.
 */
function enqueueRegenJobs(jobs: MobPortraitJob[]): void {
  const state = useMobPortraitQueue.getState();
  const keys = new Set(jobs.map((job) => `${job.campaignId}:${job.artifactId}`));
  const stale = [...state.queued, ...state.active].filter((queued) =>
    keys.has(`${queued.campaignId}:${queued.artifactId}`),
  );
  for (const job of stale) state.dequeue(job);
  state.enqueue(jobs.map((job) => ({ ...job, regen: true })));
}

/**
 * Where one creature kind's art stands. THE classification the additive
 * batch, its regen and the read-only count all share (docs/18: one way to
 * read a kind's portrait state). `gallery-only` = the artifact holds art
 * that is NOT set as its cover: the batch counts the kind imaged (the art is
 * real, and setting the cover is the owner's call in the artifact's Images
 * section) and never re-generates over it — but the battle token renders
 * `coverImageId` alone, so the surface names these kinds instead of letting
 * the count imply a portrait the board is not showing.
 */
type KindArt = 'none' | 'cover' | 'gallery-only';

/** One creature kind of the encounter's roster (the dedupe unit: one
 * portrait per kind, shared by every roster row citing it). */
interface BatchKind {
  lane: 'rulebook' | 'invented';
  /** The kind's name — the first roster row that cites it wins. */
  name: string;
  /** The kind's mob artifact; null only when nothing exists yet and the
   * caller asked for no creation (the read-only count). */
  artifactId: Id | null;
  /** Rulebook kinds: the cited stat-block chunk (prompt grounding). */
  chunkId?: Id;
  art: KindArt;
}

interface BatchEnumeration {
  rulebook: BatchKind[];
  invented: BatchKind[];
  /** Roster rows that collapsed onto a kind already counted — the
   * one-portrait-per-creature-kind share. Counted, never silently dropped. */
  sharedRows: number;
  /** Roster rows the invented lane walked (its materialize count): uncited
   * entries plus `npc-ref` rows whose artifact carries no chunk marker. */
  inventedRows: number;
}

/**
 * The batch's ONE enumeration (both lanes), shared by the additive batch, the
 * two regen paths and the read-only count — so what the surface promises and
 * what the queue does can never drift. `create: false` is the read-only mode:
 * it resolves artifacts that EXIST (`findMobArtifactByChunk` /
 * `findInventedCreatureArtifact`) and creates nothing, clones nothing,
 * enqueues nothing.
 *
 * A dangling stamped `mobArtifactId` (its artifact was deleted) throws loud
 * in BOTH modes — the count must never promise a fill the enqueue would
 * refuse to perform (the message prefixes are per-lane and verbatim). The
 * same holds for a dangling `npc-ref`: the linked row is READ for its chunk
 * marker in both modes (one `getAnyArtifact` per roster row, no writes), so a
 * vanished row names itself instead of being counted as a hole.
 */
async function enumerateBatchKinds(
  encounter: AnyArtifact & { kind: 'encounter' },
  campaignId: Id,
  options: {
    lanes: readonly ('rulebook' | 'invented')[];
    /** Run mode creates the artifacts the batch needs; the read-only count
     * passes false and reports what it finds. */
    create: boolean;
    /** The per-entry invented action: only these roster indexes. */
    inventedIndexes?: readonly number[] | undefined;
    rulebookLabel: string;
    inventedLabel: string;
  },
): Promise<BatchEnumeration> {
  const enumerated: BatchEnumeration = { rulebook: [], invented: [], sharedRows: 0, inventedRows: 0 };
  /** Kind identity: the artifact id, or — when no artifact exists yet — the
   * citation's chunk (rulebook) / the roster name (invented), so a kind
   * without an artifact still collapses instead of double-counting. */
  const seenKinds = new Set<string>();

  if (options.lanes.includes('rulebook')) {
    const artifactIdByChunk = new Map<Id, Id>();
    for (const entry of encounter.data.monsters) {
      // ROUTING (owner report: a materialized monster was invisible to this
      // batch, so it could never get a cover). Every roster participant that
      // can own a portrait rides the RULEBOOK lane when its creature is
      // chunk-backed, and the invented lane otherwise:
      // - `rulebook` entries cite a stat-block chunk directly;
      // - `npc-ref` entries point at the artifact the encounter finalized for
      //   them — a chunk-backed MOB artifact (a bestiary-cited creature) is
      //   the SAME creature kind every other row citing that chunk shares, so
      //   it must not produce a second job or a second cover (dedupe is by
      //   artifact + chunk handle below); an artifact WITHOUT the
      //   `monsterChunkId` marker (a materialized `inline` monster, or a named
      //   NPC standing in the roster) belongs to the invented lane, whose jobs
      //   carry no `chunkId` and can therefore never read or write the global
      //   portrait cache — the canonical firewall stays intact.
      let chunkId: Id | undefined;
      let artifactId: Id | null;
      if (entry.source.type === 'rulebook') {
        chunkId = entry.source.chunkId;
        const known = artifactIdByChunk.get(chunkId);
        artifactId =
          known ??
          entry.source.mobArtifactId ??
          (options.create
            ? await getOrCreateMobArtifact(campaignId, chunkId, entry.name)
            : ((await findMobArtifactByChunk(campaignId, chunkId))?.id ?? null));
      } else if (entry.source.type === 'npc-ref') {
        // The linked artifact is read for its marker (kindArtOf re-reads it
        // for its art state — one extra read per distinct row, never a
        // second interpretation of the marker).
        const linked = await getAnyArtifact(entry.source.artifactId);
        if (linked === undefined) {
          throw new Error(
            `${options.rulebookLabel}: the artifact for "${entry.name}" no longer exists — re-run the encounter content to restore it`,
          );
        }
        const linkedChunkId = linked.kind === 'npc' ? linked.data.monsterChunkId : undefined;
        if (linkedChunkId === undefined) continue;
        chunkId = linkedChunkId;
        artifactId = linked.id;
      } else {
        continue;
      }
      if (artifactId === null) {
        // No artifact yet: a real hole the fill creates first (read-only mode
        // only — `create` mode always returns one). The chunk handle is the
        // kind identity, so a citation and an `npc-ref` on the same chunk
        // still collapse onto one kind.
        const key = `chunk:${chunkId}`;
        if (seenKinds.has(key)) enumerated.sharedRows += 1;
        else {
          seenKinds.add(key);
          enumerated.rulebook.push({
            lane: 'rulebook',
            name: entry.name,
            artifactId: null,
            chunkId,
            art: 'none',
          });
        }
        continue;
      }
      artifactIdByChunk.set(chunkId, artifactId);
      // One portrait per creature kind, not per roster entry.
      if (seenKinds.has(artifactId)) {
        enumerated.sharedRows += 1;
        continue;
      }
      seenKinds.add(artifactId);
      enumerated.rulebook.push({
        lane: 'rulebook',
        name: entry.name,
        artifactId,
        chunkId,
        art: await kindArtOf(artifactId, entry.name, options.rulebookLabel),
      });
    }
  }

  if (options.lanes.includes('invented')) {
    const only = options.inventedIndexes === undefined ? undefined : new Set(options.inventedIndexes);
    const materialized = new Map<string, Id>();
    for (const [index, entry] of encounter.data.monsters.entries()) {
      if (only !== undefined && !only.has(index)) continue;
      // Uncited entries (`inline` / `none`) materialize their on-demand
      // creature; an `npc-ref` whose artifact is NOT chunk-backed (a
      // materialized model-authored monster, or a named NPC standing in the
      // roster) already HAS the artifact the portrait belongs on — it is
      // enumerated against that artifact, never re-materialized. The
      // rulebook lane already claimed every chunk-backed `npc-ref`, so the
      // two lanes can never both list one artifact.
      let artifactId: Id | null;
      if (entry.source.type === 'inline' || entry.source.type === 'none') {
        enumerated.inventedRows += 1;
        artifactId = options.create
          ? await materializeInventedCreatureArtifact({
              campaignId,
              encounterId: encounter.id,
              encounterName: encounter.name,
              moduleId: encounter.moduleId,
              name: entry.name,
              notes: entry.notes,
              treasure: entry.treasure,
              statBlock: entry.source.type === 'inline' ? entry.source.statBlock : null,
              cache: materialized,
            })
          : ((await findInventedCreatureArtifact(campaignId, encounter.id, entry.name))?.id ?? null);
      } else if (entry.source.type === 'npc-ref') {
        const linked = await getAnyArtifact(entry.source.artifactId);
        if (linked === undefined) {
          throw new Error(
            `${options.inventedLabel}: the artifact for "${entry.name}" no longer exists — re-run the encounter content to restore it`,
          );
        }
        const linkedChunkId = linked.kind === 'npc' ? linked.data.monsterChunkId : undefined;
        // A chunk-backed artifact is a rulebook kind (the other lane).
        if (linkedChunkId !== undefined) continue;
        artifactId = linked.id;
      } else {
        continue;
      }
      const key = artifactId ?? `name:${entry.name.trim().toLowerCase()}`;
      if (seenKinds.has(key)) {
        enumerated.sharedRows += 1;
        continue;
      }
      seenKinds.add(key);
      enumerated.invented.push({
        lane: 'invented',
        name: entry.name,
        artifactId,
        art:
          artifactId === null ? 'none' : await kindArtOf(artifactId, entry.name, options.inventedLabel),
      });
    }
  }
  return enumerated;
}

/** The artifact behind one enumerated kind, read for its art state. A
 * dangling id is loud (AGENTS rule 1) — never a silent "assume cover-less". */
async function kindArtOf(artifactId: Id, name: string, label: string): Promise<KindArt> {
  const artifact = await getAnyArtifact(artifactId);
  if (artifact === undefined) {
    throw new Error(
      `${label}: the artifact for "${name}" no longer exists — re-run the encounter content to restore it`,
    );
  }
  if (artifact.coverImageId !== null) return 'cover';
  return artifact.imageIds.length > 0 ? 'gallery-only' : 'none';
}

/** Run mode always resolves an artifact; null is impossible there and a loud
 * error rather than a cast (AGENTS rule 1). */
function artifactOfKind(kind: BatchKind): Id {
  if (kind.artifactId === null) {
    throw new Error(`mob portrait batch: "${kind.name}" resolved without an artifact while enqueueing`);
  }
  return kind.artifactId;
}

/** Rulebook kinds always carry their citation chunk (loud, never a cast). */
function chunkOfKind(kind: BatchKind): Id {
  if (kind.chunkId === undefined) {
    throw new Error(`mob portrait batch: "${kind.name}" is a rulebook kind with no citation chunk`);
  }
  return kind.chunkId;
}

export interface MobPortraitBatchResult {
  /** Cover-less mobs enqueued for generation (deduped by artifact). */
  enqueued: number;
  /** Creature names whose mob artifact already carries an image. */
  alreadyImaged: string[];
}

/**
 * The batch action (encounter editor): enumerates the encounter's CHUNK-BACKED
 * creature kinds — `rulebook` citations and `npc-ref` rows pointing at a mob
 * artifact (docs/17 row 90 routing) — get-or-creates each mob artifact (lazy
 * retro-fill for encounters written before `mobArtifactId` — the same shared
 * helper the finalize and seed paths use), dedupes by artifact, skips imaged
 * mobs and enqueues the rest. A dangling stamped `mobArtifactId` (its artifact
 * was deleted) fails loudly instead of silently diverging identities, exactly
 * like a dangling `npc-ref`.
 *
 * NO enumeration-time cache clone (owner report): a cover-less canonical
 * citation is a JOB here, and the worker's canonical branch clones the
 * populated global slot instead of generating (one generation per chunk,
 * unchanged) — so `alreadyImaged` names only the kinds that already showed a
 * portrait before this call, and a hole is always reported as work. A shared
 * portrait already on a mob artifact is therefore never re-illustrated: the
 * `npc-ref` row that reaches it is skipped as imaged (the owner's rule for a
 * bestiary creature cited by two roster shapes — one image per creature).
 */
export async function enqueueMobPortraits(
  encounter: AnyArtifact & { kind: 'encounter' },
  campaignId: Id,
): Promise<MobPortraitBatchResult> {
  const enumerated = await enumerateBatchKinds(encounter, campaignId, {
    lanes: ['rulebook'],
    create: true,
    rulebookLabel: 'Generate mob portraits',
    inventedLabel: 'Create creature portraits',
  });
  const jobs: MobPortraitJob[] = [];
  const alreadyImaged: string[] = [];
  for (const kind of enumerated.rulebook) {
    if (kind.art !== 'none') {
      alreadyImaged.push(kind.name);
      continue;
    }
    jobs.push({
      campaignId,
      encounterId: encounter.id,
      artifactId: artifactOfKind(kind),
      name: kind.name,
      chunkId: chunkOfKind(kind),
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
 * result). Its one read beyond the roster is the `npc-ref` marker lookup
 * (`getAnyArtifact` per linked row) — never a write, never an art mutation.
 */
export interface MobPortraitBatchPlan {
  /** Creature kinds with no art at all — exactly what the fill enqueues. */
  missing: string[];
  /** Creature kinds that already carry art (the batch skips these). */
  imaged: string[];
  /** Subset of `imaged`: art on the artifact that is NOT set as its cover —
   * the battle board still shows initials until the owner sets it (open the
   * creature artifact → Images → Set as cover). Never silently skipped. */
  artWithoutCover: string[];
  /** Roster rows that collapsed onto a creature kind already counted (the
   * one-portrait-per-kind share). */
  sharedRows: number;
  /** Missing kinds with no artifact yet: the fill creates the creature
   * (rulebook artifact / on-demand invented creature) before its portrait. */
  creates: number;
  /** Imaged rulebook kinds that are Monster Core (canonical) citations:
   * REPLACING them republishes the shared bestiary slot, so every future
   * portrait in every campaign uses the new art (existing covers elsewhere
   * keep theirs) — the confirm must say so before the choice. */
  sharedPortraitNames: string[];
  /** Imaged rulebook kinds whose citation can no longer be read: replacing
   * them fails loudly and keeps their cover (the count never hides it). */
  unreadableCitations: string[];
}

export async function planMobPortraitBatch(
  encounter: AnyArtifact & { kind: 'encounter' },
  campaignId: Id,
): Promise<MobPortraitBatchPlan> {
  const enumerated = await enumerateBatchKinds(encounter, campaignId, {
    lanes: ['rulebook', 'invented'],
    create: false,
    rulebookLabel: 'Generate mob portraits',
    inventedLabel: 'Create creature portraits',
  });
  const kinds = [...enumerated.rulebook, ...enumerated.invented];
  const imaged = kinds.filter((kind) => kind.art !== 'none');
  const sharedPortraitNames: string[] = [];
  const unreadableCitations: string[] = [];
  for (const kind of imaged) {
    if (kind.lane !== 'rulebook' || kind.chunkId === undefined) continue;
    const chunk = (await getChunksByIds([kind.chunkId]))[0];
    if (chunk === undefined) {
      // The replace path throws loud on this (kept cover); the count reports
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
    missing: kinds.filter((kind) => kind.art === 'none').map((kind) => kind.name),
    imaged: imaged.map((kind) => kind.name),
    artWithoutCover: imaged
      .filter((kind) => kind.art === 'gallery-only')
      .map((kind) => kind.name),
    sharedRows: enumerated.sharedRows,
    creates: kinds.filter((kind) => kind.art === 'none' && kind.artifactId === null).length,
    sharedPortraitNames,
    unreadableCitations,
  };
}

/**
 * Owner-ordered portrait regeneration for rulebook-cited mobs (docs/11 D5
 * amendment) — THE one way to regen a mob portrait (docs/18). Three phases:
 *
 * 1. Resolve + validate with NO side effects: unknown artifacts and
 *    unreadable chunks throw loud with every old cover still intact.
 * 2. Fresh canonical bytes FIRST: each canonically-cited chunk's global slot
 *    is republished (`regenerateCanonicalMobPortrait` — always generates;
 *    a plain re-enqueue would clone identical bytes, a no-op regen). A
 *    failed republish throws loud here with every old cover still intact —
 *    nothing is enqueued. Flavored citations skip the cache entirely
 *    (local-only invariant).
 * 3. Enqueue delete-after-replace regen jobs for the imaged artifacts (plus
 *    the normal cover-less batch for the remainder, which resolves unstamped
 *    rows and lets the worker clone a populated canonical slot). The old
 *    covers stay
 *    until each worker commits its replacement; a failed, skipped, or
 *    queue-dropped regen leaves the old portrait intact (loud error, never
 *    silent loss). Only the superseded blob is freed, and only after the
 *    fresh cover commits.
 */
export interface MobPortraitRegenResult {
  /** Imaged mob artifacts replaced delete-after-replace (deduped by artifact). */
  regenerated: number;
  /** Citing names whose canonical global slot now carries fresh bytes. */
  republishedCanonical: string[];
}

export async function regenerateMobPortraits(
  encounter: AnyArtifact & { kind: 'encounter' },
  campaignId: Id,
): Promise<MobPortraitRegenResult> {
  const enumerated = await enumerateBatchKinds(encounter, campaignId, {
    lanes: ['rulebook'],
    create: true,
    // Pure resolve (NO read-through anywhere on this path: cloning here
    // would defeat the detach).
    rulebookLabel: 'Regenerate mob portraits',
    inventedLabel: 'Regenerate creature portraits',
  });
  const imaged = enumerated.rulebook.filter((kind) => kind.art !== 'none');
  const republishedCanonical: string[] = [];
  const republishedChunks = new Set<Id>();
  for (const target of imaged) {
    const chunkId = chunkOfKind(target);
    const chunk = (await getChunksByIds([chunkId]))[0];
    if (chunk === undefined) {
      throw new Error(
        `Regenerate mob portraits: the stat-block chunk for "${target.name}" no longer exists — kept the existing cover`,
      );
    }
    const canonical = canonicalCreatureName(chunk);
    if (
      canonical !== null &&
      isCanonicalCitation(canonical, target.name) &&
      !republishedChunks.has(chunkId)
    ) {
      republishedChunks.add(chunkId);
      await regenerateCanonicalMobPortrait({ chunkId, campaignId });
      republishedCanonical.push(target.name);
    }
  }
  enqueueRegenJobs(
    imaged.map((target) => ({
      campaignId,
      encounterId: encounter.id,
      artifactId: artifactOfKind(target),
      name: target.name,
      chunkId: chunkOfKind(target),
    })),
  );
  // The cover-less remainder (including unstamped rows the resolve above
  // retro-filled) flows through the normal batch. Imaged targets enumerate
  // away there as already-imaged: no second job.
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
      artifactId: artifact.id,
      name: artifact.name,
    },
  ]);
}

/**
 * A single rulebook-cited mob, resolved by a caller that already holds the
 * identity (the battle surface's selection card resolves its token →
 * mob artifact via `data.monsterChunkId`, preferring the provenance
 * encounter's roster entry name for the canonical-vs-flavor citation and
 * falling back to the artifact name).
 */
export interface SingleMobPortraitTarget {
  campaignId: Id;
  /** The mob artifact to illustrate (npc with a `monsterChunkId` marker). */
  artifactId: Id;
  /** The cited stat-block chunk — grounds the prompt, stat-exempt. */
  chunkId: Id;
  /** The citing name (roster entry or artifact name) for the
   * canonical-vs-flavor citation check the worker performs. */
  name: string;
}

/**
 * The battle-card "Generate portrait" action: ONE chunk-grounded job through
 * the SAME queue as the editor batch — same dock group shape, same
 * artifact-keyed dedupe, same skip-if-imaged worker branch, same loud
 * per-mob failure path. Silent at enqueue time exactly like the batch (the
 * app-wide progress dock carries the feedback).
 */
export function enqueueSingleMobPortrait(target: SingleMobPortraitTarget): void {
  const name = target.name.trim();
  if (name === '') {
    throw new Error('mob portrait: the citing name is empty — name the creature before generating');
  }
  useMobPortraitQueue.getState().enqueue([
    {
      campaignId: target.campaignId,
      artifactId: target.artifactId,
      name,
      chunkId: target.chunkId,
    },
  ]);
}

export interface SingleMobPortraitRegenResult {
  /** False when the cover landed elsewhere between the card read and Confirm
   * (the worker's skip branch would no-op) — the caller replays the
   * already-generated toast instead of detaching nothing. */
  regenerated: boolean;
  /** True when the citation is canonical and the global slot now carries
   * fresh bytes (the caller owes the loud shared-consequence toast). */
  republishedCanonical: boolean;
}

/**
 * The battle-card "Regenerate portrait" action — the single-mob flavor of
 * `regenerateMobPortraits` (docs/18: delete-after-replace is the one way).
 * Same three phases on ONE target: resolve + validate with NO side effects
 * (unknown artifact / unreadable chunk throw loud with the old cover
 * intact), republish the canonical slot with FRESH bytes first for canonical
 * citations (flavored citations stay local-only; a failed republish throws
 * loud with the old cover intact and nothing enqueued), then enqueue a
 * delete-after-replace regen job (canonical clones the NEW slot bytes,
 * flavored generates locally — the old cover stays until the fresh one
 * commits).
 */
export async function regenerateSingleMobPortrait(
  target: SingleMobPortraitTarget,
): Promise<SingleMobPortraitRegenResult> {
  const name = target.name.trim();
  if (name === '') {
    throw new Error('mob portrait: the citing name is empty — name the creature before regenerating');
  }
  const artifact = await getAnyArtifact(target.artifactId);
  if (artifact === undefined) {
    throw new Error(
      `Regenerate mob portrait: the artifact for "${name}" no longer exists — re-run the encounter content to restore it`,
    );
  }
  if (artifact.coverImageId === null && artifact.imageIds.length === 0) {
    return { regenerated: false, republishedCanonical: false };
  }
  const chunk = (await getChunksByIds([target.chunkId]))[0];
  if (chunk === undefined) {
    throw new Error(
      `Regenerate mob portrait: the stat-block chunk for "${name}" no longer exists — kept the existing cover`,
    );
  }
  const canonical = canonicalCreatureName(chunk);
  const isCanonical = canonical !== null && isCanonicalCitation(canonical, name);
  if (isCanonical) {
    await regenerateCanonicalMobPortrait({ chunkId: target.chunkId, campaignId: target.campaignId });
  }
  enqueueRegenJobs([
    {
      campaignId: target.campaignId,
      artifactId: target.artifactId,
      name,
      chunkId: target.chunkId,
    },
  ]);
  return { regenerated: true, republishedCanonical: isCanonical };
}

export interface InventedCreatureBatchResult {
  /** On-demand npc artifacts materialized (created or reused) for uncited entries. */
  created: number;
  /** Cover-less invented creatures enqueued for local generation. */
  enqueued: number;
  /** Creature names whose invented artifact already carries an image. */
  alreadyImaged: string[];
}

/**
 * The on-demand creature batch (docs/11 D5 amendment; owner decision
 * 2026-09-10, docs/17 row 90 — *"A special look for a special zombie is ok"*):
 * the encounter's roster participants whose creature is NOT chunk-backed get
 * ONE creature artifact each and a LOCAL portrait job per cover-less
 * creature. Two entry shapes ride it:
 *
 * - uncited roster entries (`inline` / `none` — model-invented mobs with no
 *   bestiary citation): the artifact is materialized on demand;
 * - `npc-ref` entries pointing at an artifact WITHOUT the `monsterChunkId`
 *   marker: a monster the encounter materialized from a model-authored inline
 *   stat block (what the assertion rule's collision path produces for a
 *   creature the prose stages that exists in no imported bestiary), or an
 *   ordinary named NPC standing in the roster. The artifact ALREADY EXISTS —
 *   it is enumerated against that row, never re-materialized, and a cover it
 *   already carries is reported as `alreadyImaged`, never detached, never
 *   regenerated (enumeration has no side effects on art).
 *
 * Local-only by construction: the job carries NO chunkId, so the worker
 * grounds the prompt on the artifact's own content (appearance seeded from
 * the entry's notes/treasure) and can never reach the global `mobPortraits`
 * cache — neither read nor write (the canonical-cache firewall,
 * `db/mobPortraitCache`). The firewall is enforced by the ABSENCE of the
 * chunkId on the job, not by the lane label: an `npc-ref` monster is a real
 * `npc` row with no `monsterChunkId`, so nothing about it can produce a
 * `cacheKeyForMonsterSource` (the same structural argument as
 * `materializeInventedCreatureArtifact`'s). One creature, one look: a
 * distinct invented monster keeps its own art and never inherits a rulebook
 * creature's shared portrait.
 *
 * A failed materialize throws loudly (no silent skip, no placeholder); a
 * failed generation lands on the queue's loud per-mob failure path like every
 * other job.
 *
 * Pass `entryIndexes` for the per-entry action (a single roster row);
 * omit it for batch-all. Chunk-backed creatures belong to
 * `enqueueMobPortraits` — the two lanes never both list one artifact.
 */
export async function enqueueInventedCreaturePortraits(
  encounter: AnyArtifact & { kind: 'encounter' },
  campaignId: Id,
  entryIndexes?: readonly number[],
): Promise<InventedCreatureBatchResult> {
  const enumerated = await enumerateBatchKinds(encounter, campaignId, {
    lanes: ['invented'],
    create: true,
    ...(entryIndexes === undefined ? {} : { inventedIndexes: entryIndexes }),
    rulebookLabel: 'Generate mob portraits',
    inventedLabel: 'Create creature portraits',
  });
  const jobs: MobPortraitJob[] = [];
  const alreadyImaged: string[] = [];
  for (const kind of enumerated.invented) {
    if (kind.art !== 'none') {
      alreadyImaged.push(kind.name);
      continue;
    }
    jobs.push({
      campaignId,
      encounterId: encounter.id,
      artifactId: artifactOfKind(kind),
      name: kind.name,
    });
  }
  useMobPortraitQueue.getState().enqueue(jobs);
  return { created: enumerated.inventedRows, enqueued: jobs.length, alreadyImaged };
}

export interface InventedCreatureRegenResult {
  /** On-demand npc artifacts materialized (created or reused) for the selection. */
  created: number;
  /** Imaged invented creatures detached and re-enqueued (deduped by artifact). */
  regenerated: number;
}

/**
 * Owner-ordered portrait regeneration for uncited (invented) roster entries
 * (docs/11 D5 amendment) — THE one way to regen an invented cover (docs/18).
 * Materializes (reuses) the selection's npc artifacts, enqueues
 * delete-after-replace regen jobs for the imaged ones (chunk-less
 * local-only jobs — the canonical-cache firewall holds: invented covers
 * never read, populate, or overwrite the global cache — regen included),
 * and runs the normal invented batch for the cover-less remainder. The old
 * covers stay until each worker commits its replacement; a failed, skipped,
 * or queue-dropped regen leaves the old portrait intact.
 *
 * Pass `entryIndexes` for the per-entry action; omit it for batch-all.
 */
export async function regenerateInventedCreaturePortraits(
  encounter: AnyArtifact & { kind: 'encounter' },
  campaignId: Id,
  entryIndexes?: readonly number[],
): Promise<InventedCreatureRegenResult> {
  const enumerated = await enumerateBatchKinds(encounter, campaignId, {
    lanes: ['invented'],
    create: true,
    ...(entryIndexes === undefined ? {} : { inventedIndexes: entryIndexes }),
    rulebookLabel: 'Regenerate mob portraits',
    inventedLabel: 'Regenerate creature portraits',
  });
  const imaged = enumerated.invented.filter((kind) => kind.art !== 'none');
  enqueueRegenJobs(
    imaged.map((target) => ({
      campaignId,
      encounterId: encounter.id,
      artifactId: artifactOfKind(target),
      name: target.name,
    })),
  );
  // The cover-less remainder flows through the normal invented batch.
  // Imaged targets enumerate away there as already-imaged: no second job.
  await enqueueInventedCreaturePortraits(encounter, campaignId, entryIndexes);
  return { created: enumerated.inventedRows, regenerated: imaged.length };
}
