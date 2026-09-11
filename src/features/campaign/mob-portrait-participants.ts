import type { AnyArtifact, Artifact, Id, MonsterEntry } from '@/domain';
import { inventedCreatureArtifactIn, mobArtifactIn } from '@/db/mobArtifacts';

/**
 * THE routing and art rules of the mob-portrait batch — one home, three
 * readers: the queue's own enumeration (`features/campaign/mob-portrait-queue`,
 * which imports them and re-derives nothing), and the module-level
 * portrait-gap detector (`features/modules/post-generation`
 * `encountersNeedingMobPortraits`, read by "Resume automatic module creation"
 * and the entity sidebar's "Generate everything").
 *
 * Why a shared module rather than a re-derivation on either side (docs/17 row
 * 96, applying row 92's rule to this seam): the module path used to answer
 * "does this encounter need portraits?" with its OWN predicate — roster rows
 * whose `source.type === 'rulebook'` — so a roster of `npc-ref` rows (the
 * artifacts the encounter actually materialized its creatures into, INCLUDING
 * bestiary creatures, which carry the `monsterChunkId` marker) and of uncited
 * entries was invisible to it. The sweep then enqueued only the rulebook lane
 * on top of that, so even a counted encounter got half its portraits, and the
 * deviation that gates the "Generate everything" control came out EMPTY — the
 * control was not rendered at all. Two walks of one rule is the bug class rows
 * 90/92 fixed; the fix is one walk.
 *
 * The rules themselves are the row-90 verdict, unchanged:
 * - routing is by what a row's creature IS, never by the shape of its
 *   `source`: a chunk-backed creature (a `rulebook` citation, or an `npc-ref`
 *   to an artifact carrying `data.monsterChunkId`) is a RULEBOOK kind and
 *   shares the one bestiary portrait; everything else (`inline` / `none`, and
 *   an `npc-ref` to an artifact without the marker) is an INVENTED kind whose
 *   job carries no `chunkId` and can therefore never reach the global
 *   `mobPortraits` cache;
 * - a kind's art is `coverImageId` ⇒ imaged, else `imageIds.length > 0` ⇒
 *   imaged-but-not-cover, else `'none'` — ONE reading, `portraitArtOf`;
 * - a kind's identity is the artifact it resolves to, or — when no artifact
 *   exists yet — the cited chunk / the roster name, ONE spelling each
 *   (`chunkKindKey` / `inventedKindKey`), so rows sharing a creature kind
 *   collapse onto one portrait.
 */

/**
 * Where one creature kind's art stands. THE classification the additive
 * batch, its regen, the read-only count AND the module-level gap detector
 * share (docs/18: one way to read a kind's portrait state). `gallery-only` =
 * the artifact holds art that is NOT set as its cover: the batch counts the
 * kind imaged (the art is real, and setting the cover is the owner's call in
 * the artifact's Images section) and never re-generates over it — but the
 * battle token renders `coverImageId` alone, so the surface names these kinds
 * instead of letting the count imply a portrait the board is not showing.
 */
export type KindArt = 'none' | 'cover' | 'gallery-only';

/** The one art reading: `coverImageId` first, then the gallery. */
export function portraitArtOf(artifact: AnyArtifact): KindArt {
  if (artifact.coverImageId !== null) return 'cover';
  return artifact.imageIds.length > 0 ? 'gallery-only' : 'none';
}

/**
 * Which lane one roster participant rides, and the artifact identity it
 * resolves to. `artifactId: null` means "no artifact yet": for a rulebook kind
 * the batch get-or-creates the campaign's mob artifact from `chunkId`, for an
 * uncited entry the invented lane materializes the creature — both are holes
 * the batch fills, never a skip.
 *
 * `missing-ref` is the `npc-ref` whose linked artifact is not there (deleted,
 * or simply invisible to the snapshot the caller reads). It is a FIRST-CLASS
 * verdict so no caller can turn it into a silent skip: the queue throws
 * loudly with the walked lane's own label, and the gap detector reports work
 * (the enqueue is where the loud error belongs). Callers resolve `linked`
 * themselves — the queue reads it from the DB, the detector from the artifact
 * snapshot it holds — and pass `undefined` when the row is not an `npc-ref`.
 */
export type MobPortraitRoute =
  | { lane: 'rulebook'; chunkId: Id; artifactId: Id | null }
  | { lane: 'invented'; artifactId: Id | null }
  | { lane: 'missing-ref' };

export function rosterParticipantRoute(
  entry: MonsterEntry,
  linked: AnyArtifact | undefined,
): MobPortraitRoute {
  const source = entry.source;
  if (source.type === 'rulebook') {
    // The stamped mob artifact is the citation's own identity; when the row
    // predates the marker the batch resolves it by chunk (lazy retro-fill).
    return { lane: 'rulebook', chunkId: source.chunkId, artifactId: source.mobArtifactId ?? null };
  }
  if (source.type === 'npc-ref') {
    if (linked === undefined) return { lane: 'missing-ref' };
    const linkedChunkId = linked.kind === 'npc' ? linked.data.monsterChunkId : undefined;
    if (linkedChunkId === undefined) {
      // A materialized model-authored monster (what the assertion rule's
      // collision path produces for a creature the prose stages that exists in
      // no imported bestiary), or an ordinary named NPC standing in the roster
      // — the artifact ALREADY EXISTS and the portrait belongs on it.
      return { lane: 'invented', artifactId: linked.id };
    }
    // A bestiary creature is the SAME creature kind every other row citing
    // that chunk shares — one portrait, never a second one.
    return { lane: 'rulebook', chunkId: linkedChunkId, artifactId: linked.id };
  }
  // `inline` / `none`: an uncited, model-invented mob — the invented lane
  // materializes its creature first.
  return { lane: 'invented', artifactId: null };
}

/** Kind identity when a rulebook kind has NO artifact yet: the cited chunk. */
export function chunkKindKey(chunkId: Id): string {
  return `chunk:${chunkId}`;
}

/** Kind identity when an uncited kind has NO artifact yet: the roster name. */
export function inventedKindKey(name: string): string {
  return `name:${name.trim().toLowerCase()}`;
}

/**
 * Does this encounter's roster still hold portrait work? — the SYNC twin of
 * the queue's own enumeration, read over the artifact snapshot the module
 * sweep already has (no DB read, no write, no art mutation), and built from
 * the SAME routing, art and kind-identity rules above so the offer
 * ("Generate everything" / "Resume automatic module creation") and the work
 * (the two enqueue lanes) can never disagree again (docs/17 rows 90/92/96).
 *
 * The answer is EXACT for every roster row whose artifacts are in the
 * snapshot, which is the snapshot the sweep reads (`moduleCreationPool` over
 * `listArtifactsByCampaign`; only `pc` rows are dropped and a creature row is
 * never a `pc`). The one honest residue: a row that points OUTSIDE the
 * snapshot — a dangling stamped `mobArtifactId`, a dangling `npc-ref`, or a
 * link to a row this campaign does not own — is reported as WORK. That is the
 * loud direction on purpose: the enqueue resolves those from the DB, enqueues
 * the portrait when it finds one, and THROWS with the citing name when the row
 * is really gone (aggregated into the sweep's one loud per-encounter toast).
 * Reporting them as "nothing to do" would be the silent miss this seam exists
 * to remove.
 */
export function encounterNeedsMobPortraitWork(
  encounter: Artifact & { kind: 'encounter' },
  artifacts: readonly AnyArtifact[],
): boolean {
  const byId = new Map<Id, AnyArtifact>();
  for (const artifact of artifacts) byId.set(artifact.id, artifact);
  /** One portrait per creature kind, not per roster row — the queue's own
   * identity set, so a second row on the same kind cannot produce a second
   * answer here either. */
  const seenKinds = new Set<string>();
  /** The chunk → artifact memo the rulebook lane keeps, so a later row citing
   * an already-resolved chunk collapses onto that artifact exactly as the
   * queue does. */
  const artifactIdByChunk = new Map<Id, Id>();
  const linkedOf = (entry: MonsterEntry): AnyArtifact | undefined =>
    entry.source.type === 'npc-ref' ? byId.get(entry.source.artifactId) : undefined;

  // The rulebook lane first, then the invented lane — the queue's own order.
  for (const entry of encounter.data.monsters) {
    const route = rosterParticipantRoute(entry, linkedOf(entry));
    if (route.lane === 'missing-ref') return true;
    if (route.lane !== 'rulebook') continue;
    const { chunkId } = route;
    const artifactId =
      artifactIdByChunk.get(chunkId) ??
      route.artifactId ??
      mobArtifactIn(artifacts, chunkId)?.id ??
      null;
    if (artifactId === null) {
      // No artifact yet: the batch creates the campaign's mob artifact and
      // queues its portrait — a real hole, which the read-only count reports
      // as `missing`/`creates` too.
      if (seenKinds.has(chunkKindKey(chunkId))) continue;
      seenKinds.add(chunkKindKey(chunkId));
      return true;
    }
    artifactIdByChunk.set(chunkId, artifactId);
    if (seenKinds.has(artifactId)) continue;
    seenKinds.add(artifactId);
    const artifact = byId.get(artifactId);
    if (artifact === undefined) return true;
    if (portraitArtOf(artifact) === 'none') return true;
  }

  for (const entry of encounter.data.monsters) {
    const route = rosterParticipantRoute(entry, linkedOf(entry));
    if (route.lane !== 'invented') continue;
    const artifactId =
      route.artifactId ??
      inventedCreatureArtifactIn(artifacts, encounter.id, entry.name)?.id ??
      null;
    const key = artifactId ?? inventedKindKey(entry.name);
    if (seenKinds.has(key)) continue;
    seenKinds.add(key);
    if (artifactId === null) {
      // An uncited entry with no creature yet: the batch materializes it and
      // queues its portrait.
      return true;
    }
    const artifact = byId.get(artifactId);
    if (artifact === undefined) return true;
    if (portraitArtOf(artifact) === 'none') return true;
  }
  return false;
}
