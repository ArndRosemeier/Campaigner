import type { AnyArtifact, Artifact, Id, MonsterEntry } from '@/domain';
import {
  chunkIdOfOriginToken,
  rosterEntryCreatureIdentity,
  type CreatureIdentity,
} from '@/domain';
import { db } from '@/db/db';
import { creaturePortraitImageIn } from '@/db/creatureRepo';
import { creatureImageIdsByKey } from '@/db/creatureImages';

/**
 * THE routing and art rules of the creature-portrait batch — one home, three
 * readers: the queue's own enumeration (`features/campaign/mob-portrait-queue`,
 * which imports them and re-derives nothing), and the module-level
 * portrait-gap detector (`features/modules/post-generation`
 * `encountersNeedingMobPortraits`, read by "Resume automatic module creation"
 * and the entity sidebar's "Generate everything").
 *
 * Why a shared module rather than a re-derivation on either side (docs/17 row
 * 96, applying row 92's rule to this seam): the module path used to answer
 * "does this encounter need portraits?" with its OWN predicate — roster rows
 * whose `source.type === 'rulebook'` — so a roster of `npc-ref` rows and of
 * uncited entries was invisible to it. The sweep then enqueued only the
 * rulebook lane on top of that, so even a counted encounter got half its
 * portraits, and the deviation that gates the "Generate everything" control
 * came out EMPTY — the control was not rendered at all. Two walks of one rule
 * is the bug class rows 90/92 fixed; the fix is one walk.
 *
 * The rules themselves are the row-90 verdict, re-based on creature IDENTITY
 * by the owner-ratified core-mob arc (docs/11 D5 amendment):
 * - routing is by what a row's creature IS, never by the shape of its
 *   `source`: a row that CITES a library creature (a `rulebook` citation, or
 *   an authored NPC standing in the roster) is a CREATURE kind and shares the
 *   one canonical portrait for its identity; an uncited entry (`inline` /
 *   `none`) is an INVENTED kind keyed on its OWN content, whose portrait is
 *   local and can therefore never read or write the global `mobPortraits`
 *   canonical slot;
 * - a kind's art is read from the CAMPAIGN'S PRESENTATION ROWS
 *   (`db/creatureImages`), keyed by creature identity — no artifact is
 *   required, and an `npc-ref` row that stands for an authored NPC keeps its
 *   portrait on its own cover;
 * - a kind's identity is `CreatureIdentity.key` (`domain/creature`), ONE
 *   spelling, so rows sharing a creature kind collapse onto one portrait.
 */

/** Where one creature kind's art stands. ONE classification, shared by the
 * additive batch, its regen, the read-only count and the module-level gap
 * detector (docs/18: one way to read a creature's portrait state). */
export type KindArt = 'none' | 'cover';

/** The campaign's presentation rows as a key → imageId map — the ONE snapshot
 * every art reading walks. */
export function presentationArtByKey(rows: readonly { creatureKey: string; imageId: Id }[]): Map<string, Id> {
  return new Map(rows.map((row) => [row.creatureKey, row.imageId]));
}

/** The one art reading over a presentation snapshot. */
export function portraitArtIn(presentation: ReadonlyMap<string, Id>, creatureKey: string): KindArt {
  return presentation.has(creatureKey) ? 'cover' : 'none';
}

/** The same reading, straight from the DB (one creature). */
export async function portraitArtOf(campaignId: Id, creatureKey: string): Promise<KindArt> {
  return (await creatureImageIdsByKey(campaignId)).has(creatureKey) ? 'cover' : 'none';
}

/**
 * Which lane one roster participant rides, and the identity it resolves to.
 *
 * - `creature`: the row cites a LIBRARY CREATURE. `creatureKey` is the
 *   portrait identity, `chunkId` the citation's chunk (prompt grounding), and
 *   `name` the citing name the canonical-vs-flavor check is performed against.
 *   An authored NPC standing in the roster rides this lane too — its stats are
 *   derived from a library creature (docs/11 D3), so it is the same creature
 *   kind and shares the same canonical portrait.
 * - `authored`: the row points at an AUTHORED NPC with no library creature
 *   behind it. The portrait belongs on that artifact's own cover — the batch
 *   reports its state and never touches the canonical cache.
 * - `invented`: an uncited entry (`inline` / `none`): a mob the encounter
 *   invented, identified by its own CONTENT. No artifact is ever created for
 *   it (docs/11 D5).
 * - `missing-ref`: the `npc-ref` whose linked artifact is not there (deleted,
 *   or invisible to the snapshot the caller reads). It is a FIRST-CLASS
 *   verdict so no caller can turn it into a silent skip: the queue throws
 *   loudly with the walked lane's own label, and the gap detector reports
 *   work (the enqueue is where the loud error belongs).
 *
 * `authored` carries the row's own art rather than a creature key, because an
 * authored NPC's portrait is genuinely its own (the owner's "a special look for
 * a special zombie is ok").
 */
export type CreaturePortraitRoute =
  | {
      lane: 'creature';
      creatureKey: string;
      /** The citation's chunk — the prompt's grounding read. Absent when the
       * citation has no chunk (a content-hash-only reference): the job is then
       * LOCAL, grounded on the authored row's own text, and can never touch
       * the canonical cache. */
      chunkId?: Id | undefined;
      name: string;
      /** The authored NPC standing in the roster, when there is one. */
      artifactId: Id | null;
    }
  | { lane: 'authored'; artifactId: Id; name: string }
  | { lane: 'invented'; creatureKey: string; name: string }
  | { lane: 'missing-ref' };

/**
 * The identity of a roster entry that cites a library creature, over the
 * rows the caller already holds. `linked` is the `npc-ref`'s artifact (the
 * caller resolves it — the queue reads it from the DB, the detector from its
 * snapshot — and passes `undefined` when the row is not an `npc-ref`).
 *
 * The identity itself is NOT derived here: it is
 * `domain/creature.rosterEntryCreatureIdentity`, the ONE rule the battle seed
 * stamps its tokens with as well (docs/17 row 165), so a token's
 * `creatureKey` and the key this route's job writes the portrait under cannot
 * be two different creatures.
 */
export function rosterParticipantRoute(
  entry: MonsterEntry,
  linked: AnyArtifact | undefined,
): CreaturePortraitRoute {
  // A MIGRATED COPY's stored origin token is the creature identity (docs/17
  // row 248): the row is `inline` now, so without this check it would be routed
  // to the `invented` lane and its `chunk:`-keyed portrait would be abandoned —
  // the exact cache break the opaque token exists to prevent.
  const token = entry.originToken?.trim();
  if (token !== undefined && token !== '') {
    const chunkId = chunkIdOfOriginToken(token);
    return {
      lane: 'creature',
      creatureKey: token,
      ...(chunkId === null ? {} : { chunkId }),
      name: entry.name,
      artifactId: null,
    };
  }
  const source = entry.source;
  if (source.type === 'npc-ref') {
    if (linked === undefined) return { lane: 'missing-ref' };
    const identity = rosterEntryCreatureIdentity(entry, linked);
    if (identity === null) {
      // A hand-authored NPC (or a row that is not an npc at all) cites no
      // library creature, so it keeps its own cover rather than a creature's.
      return { lane: 'authored', artifactId: linked.id, name: entry.name };
    }
    // An authored NPC whose stat block is DERIVED from a library creature is
    // that creature kind (docs/11 D3): one creature, one look, so it shares the
    // canonical portrait instead of holding a private one.
    return {
      lane: 'creature',
      creatureKey: identity.key,
      // The citation's own chunk grounds the prompt. A `creatureRef` with no
      // chunk at all (a content-hash-only reference) has no chunk to read, so
      // the field is ABSENT rather than defaulted — the job is local and the
      // caller decides that from the route, never from a placeholder id.
      ...(identity.ref.chunkId === undefined ? {} : { chunkId: identity.ref.chunkId }),
      name: linked.name,
      artifactId: linked.id,
    };
  }
  const identity = rosterEntryCreatureIdentity(entry, undefined);
  if (identity === null) {
    // Unreachable by construction: only an `npc-ref` can stand for no
    // creature. Loud rather than a silent skip of a roster row (AGENTS rule 1).
    throw new Error(
      `creature portrait: the roster entry “${entry.name}” stands for no creature`,
    );
  }
  if (source.type === 'rulebook') {
    return {
      lane: 'creature',
      creatureKey: identity.key,
      chunkId: source.chunkId,
      name: entry.name,
      artifactId: null,
    };
  }
  // `inline` / `none`: an uncited, model-invented mob — identified by content,
  // with no artifact and no library row anywhere.
  return { lane: 'invented', creatureKey: identity.key, name: entry.name };
}

/** Kind identity for ONE creature identity — thin, but the ONE spelling every
 * dedupe set uses (a bare template literal at three call sites is how two
 * identities drift). */
export function creatureKindKey(identity: CreatureIdentity): string {
  return identity.key;
}

/**
 * Does this encounter's roster still hold portrait work? — the SYNC twin of
 * the queue's own enumeration, read over the artifact snapshot the module
 * sweep already has plus the campaign's presentation rows (no DB read, no
 * write, no art mutation), built from the SAME routing and art rules above so
 * the offer ("Generate everything" / "Resume automatic module creation") and
 * the work (the enqueue lanes) can never disagree again (docs/17 rows
 * 90/92/96).
 *
 * The answer is EXACT for every roster row whose creature identity is
 * derivable from the row itself — which is EVERY row that cites a library
 * creature (the identity is the citation's chunk, docs/11 D5 amendment) and
 * every invented entry (the identity is its own content). The one honest
 * residue: an `npc-ref` pointing OUTSIDE the snapshot (a dangling link, or a
 * row this campaign does not own) is reported as WORK. That is the loud
 * direction on purpose: the enqueue resolves those from the DB and THROWS with
 * the citing name when the row is really gone. Reporting them as "nothing to
 * do" would be the silent miss this seam exists to remove.
 */
export function encounterNeedsMobPortraitWork(
  encounter: Artifact & { kind: 'encounter' },
  artifacts: readonly AnyArtifact[],
  presentationByKey?: ReadonlyMap<string, Id>,
): boolean {
  // A caller with no presentation snapshot (the module sweep holds an artifact
  // snapshot and no campaign image rows) answers CONSERVATIVELY: a cited or
  // invented creature kind with no entry counts as work. That is the loud
  // direction, and it costs nothing real — the queue itself is skip-if-imaged,
  // so an offer for a creature that already has this campaign's portrait
  // enqueues zero jobs (docs/11 D6: the batch's user-visible behaviour is
  // unchanged either way).

  const byId = new Map<Id, AnyArtifact>();
  for (const artifact of artifacts) byId.set(artifact.id, artifact);
  /** One portrait per creature kind, not per roster row — the queue's own
   * identity set, so a second row on the same kind cannot produce a second
   * answer here either. */
  const seenKinds = new Set<string>();
  /** A caller that holds no presentation rows (the canvas page's lightweight
   * deviation read) answers over an EMPTY one: every creature lane then answers
   * "no art" unless the artifact the row points at carries some — the
   * conservative direction documented above. */
  const presentation = presentationByKey ?? new Map<string, Id>();

  for (const entry of encounter.data.monsters) {
    const linked = entry.source.type === 'npc-ref' ? byId.get(entry.source.artifactId) : undefined;
    const route = rosterParticipantRoute(entry, linked);
    if (route.lane === 'missing-ref') return true;
    const kind = route.lane === 'authored' ? route.artifactId : route.creatureKey;
    if (seenKinds.has(kind)) continue;
    seenKinds.add(kind);
    // THE portrait question, asked over the rows this snapshot holds — the SAME
    // function the surfaces render with (`db/creatureRepo`), so "this creature
    // is imaged" and "the board shows its portrait" are one statement and the
    // offer cannot describe work the board already shows (docs/17 row 165).
    const npcArtifact =
      route.lane === 'invented' || route.artifactId === null
        ? undefined
        : byId.get(route.artifactId);
    // An `authored` row outside the snapshot is WORK (the loud direction
    // above): this detector cannot see its art, and a row that is really gone
    // must not read as "nothing to do".
    if (route.lane === 'authored' && npcArtifact === undefined) return true;
    if (
      creaturePortraitImageIn({
        presentationByKey: presentation,
        ...(route.lane === 'authored' ? {} : { creatureKey: route.creatureKey }),
        npcArtifact,
      }) === null
    ) {
      return true;
    }
  }
  return false;
}

/** The campaign's presentation snapshot, straight from the DB — the async
 * form of what the detector above receives as a prop. */
export async function presentationArtOfCampaign(campaignId: Id): Promise<Map<string, Id>> {
  const rows = await db.creatureImages.where('campaignId').equals(campaignId).toArray();
  return presentationArtByKey(rows);
}
