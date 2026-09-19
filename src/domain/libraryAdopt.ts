import {
  artifactSchema,
  type AnyArtifact,
  type Artifact,
  type ArtifactKind,
  type ArtifactLink,
  type GlobalArtifact,
  type Id,
  type MonsterEntry,
} from '@/domain';
import { stampNewEntity } from '@/domain/entity';
import { repointRosterArtifactIds, rosterArtifactIds } from '@/domain/rosterRefs';

/**
 * THE ONE library-ADOPTION operation — the COPY half (docs/17 row 257).
 *
 * The owner's rule, verbatim: *"i would like to stop all references to core
 * items inside modules. Core items should always ever only be copied. That also
 * gets rid of dependencies when saving/loading campaigns, something that bugs
 * me."* Family E is a module's/campaign's references to GLOBAL LIBRARY
 * ARTIFACTS (`db.artifacts` rows with `campaignId: null`), and the owner has
 * decided the mechanism: ADOPT THEM INTO THE CAMPAIGN AS A REAL COPY, WITH THE
 * LIBRARY ROW SURVIVING (the library is shared; moving a row out of it would
 * strand every other campaign pointing at the same entry).
 *
 * THE SEAM IS ONE OPERATION IN TWO HALVES, and they are named separately
 * because they answer different questions (AGENTS §Centralization obligation 4):
 *
 * 1. THE COPY IS SHAPE-INDEPENDENT. Which reference shape triggered it — a
 *    roster `npc-ref`, an artifact `links[].targetId`, a battle token — changes
 *    NOTHING about the copy: the global row's identity, content, prose, aliases,
 *    links, data and IMAGES are cloned into a campaign-scoped row with a FRESH
 *    id and a STORED ORIGIN id. That is `adoptedArtifactRow` below, and it is
 *    PURE so the Dexie v26 upgrade body (which cannot use the `db` singleton)
 *    and a live write path are literally the same operation.
 *
 * 2. THE REPOINT IS A SMALL DECLARED SET, not a per-site fix list — see
 *    `LIBRARY_ADOPT_HOLDER_SHAPES`. `repointArtifactRow` is the ONE artifact-row
 *    rewrite: roster targets (through the ONE roster rewriter) and `links[]`,
 *    both of which the live app already writes through the ONE
 *    `updateArtifact` patch path.
 *
 * WHY NOT `adoptIntoCampaign`/`moveScope`. That verb MOVES the library row out
 * of the library and empties it (`db/artifactRepo`, whose own doc says "one
 * artifact, always referenced — never copied"); a whole UI is built on it and
 * its meaning is the opposite of the owner's answer. Extending it would
 * silently contradict him, so the copy has its own seam and its own vocabulary.
 *
 * NOTHING HERE IS A SILENT FALLBACK. A copy whose library row is gone, or whose
 * row is not actually global, answers a NAMED refusal
 * (`libraryAdoptRefusal`); the reference is LEFT INTACT rather than repointed
 * at a placeholder, so the existing loud missing-ref arms keep working (AGENTS
 * rule 1).
 */

/**
 * The DECLARED reference-holder shapes adoption repoints — the whole set, so
 * "which writers must this seam teach?" is a list rather than a hunt for call
 * sites. `roster` covers `encounter.data.monsters[].source.artifactId` and
 * `links` covers every artifact row's top-level `links[].targetId`; both are
 * rewritten by `repointArtifactRow`. Battle rows are the ONE remaining writer,
 * deliberately not yet a member (docs/18 §5): the battle card already resolves
 * through the any-scope getter, so an un-repointed token degrades silently
 * rather than loudly — the honest reason it is deferred rather than pretended.
 */
export const LIBRARY_ADOPT_HOLDER_SHAPES = ['roster', 'links'] as const;

export type LibraryAdoptHolderShape = (typeof LIBRARY_ADOPT_HOLDER_SHAPES)[number];

export const MISSING_GLOBAL_ARTIFACT_REASON =
  'the library artifact it points at is gone — nothing can be copied';
export const NOT_GLOBAL_ARTIFACT_REASON =
  'the row it points at is not a global library artifact — adopt it into a campaign directly instead';

/**
 * THE ONE pending-reference channel of the adoption seam (docs/17 row 257): the
 * library ids a WRITE path is ABOUT TO reference. The migration discovers its
 * targets from saved rows; the editor's picker has not saved the reference yet,
 * so it hands the ids in and reads the fresh copy ids back out of the report.
 * Either way the COPY is the same operation, and the adoption happens BEFORE
 * the reference exists — so a global reference is never born.
 */
export interface PendingLibraryReferences {
  campaignId: Id;
  ids: readonly Id[];
}

/** The refusal sentence a write path throws when a library copy cannot be made
 * — one spelling, so the migration's report and a live refusal name the same
 * remedy with the same words. */
export function libraryAdoptRefusal(name: string, reason: string): Error {
  return new Error(`adopt library artifact: refusing to copy «${name}» — ${reason}`);
}

/** The stored origin id of an adopted copy, or `undefined` for every other row
 * (authored, global, or a duplicate that dropped the stamp). */
export function adoptionOriginId(row: AnyArtifact): Id | undefined {
  return row.copiedFromArtifactId;
}

/** The minimal shape the ONE reference collector reads — a stored artifact row
 * and an in-memory editor draft are the same shape here, which is what lets the
 * write path ask the question BEFORE the reference is saved. */
export interface LibraryReferenceHolder {
  kind: ArtifactKind;
  links: readonly ArtifactLink[];
  data: unknown;
}

/**
 * THE ONE collector of a row's family-E reference targets: its `links[].targetId`
 * entries and (for an encounter) its roster `npc-ref` targets, through the ONE
 * roster reader. Callers filter the result against the library they actually
 * have — the migration against the global rows in its transaction, the write
 * path against `getAnyArtifact` — so a gone id is never mistaken for a global
 * one. Order is declaration order (links first, then roster), and duplicates are
 * left in: the callers decide a target once.
 */
export function libraryReferenceIds(holder: LibraryReferenceHolder): Id[] {
  const ids: Id[] = [];
  for (const link of holder.links) ids.push(link.targetId);
  if (holder.kind === 'encounter') {
    const data = holder.data as { monsters?: unknown } | null | undefined;
    if (data !== null && data !== undefined && Array.isArray(data.monsters)) {
      ids.push(...rosterArtifactIds(data.monsters as MonsterEntry[]));
    }
  }
  return ids;
}

/** "Has this campaign already adopted that library artifact?" — the ONE
 * idempotence rule, answered from the STORED origin id (never from names: two
 * library artifacts can share one, which is why aliases exist; and never from
 * bytes, which can coincide). */
export function isAdoptedCopyOf(row: AnyArtifact, globalId: Id): boolean {
  return row.campaignId !== null && row.copiedFromArtifactId === globalId;
}

/**
 * Build the campaign-scoped COPY of a global library artifact. PURE: the images
 * have already been CLONED by the caller (a clone is IO) and are passed in as a
 * mapping's RESULT, so this function never decides to share a blob.
 *
 * The copy keeps the SOURCE's NAME — deliberately, and it is load-bearing:
 * prose `[[Name]]` wikilinks store no id, and `lib/wikilinks.scopeTier` ranks a
 * campaign row ABOVE a global one, so the copy wins every prose reference in
 * its own campaign without a single character of prose being rewritten. The
 * copy is campaign-scoped (`moduleId: null`) because the campaign — not the
 * module — is the unit of save/load.
 *
 * The copy gets its own revision-1 snapshot (the `createArtifact` /
 * `duplicateArtifact` shape), never the library row's history: those snapshots
 * are scope-pinned content history, and restoring one is a content restore that
 * must not time-travel scope.
 */
export function adoptedArtifactRow(
  source: GlobalArtifact,
  campaignId: Id,
  images: { imageIds: readonly Id[]; coverImageId: Id | null },
  now: number = Date.now(),
): Artifact {
  return artifactSchema.parse({
    ...structuredClone(source),
    // Fresh identity + timestamps; the source's own are overwritten.
    ...stampNewEntity(now),
    campaignId,
    moduleId: null,
    imageIds: [...images.imageIds],
    coverImageId: images.coverImageId,
    copiedFromArtifactId: source.id,
    currentRevision: 1,
  });
}

/**
 * Rewrite a reference holder's family-E references to point at their campaign
 * copies: its `links[].targetId` entries and (for an encounter) its roster
 * `npc-ref` targets, both through `resolve`. `resolve` answers `undefined` for
 * a target with no copy — the reference is then LEFT AS IT IS, never pointed at
 * a placeholder, so a gone global keeps its loud missing arm.
 *
 * THE ONE rewriter, used by two callers that hold different things: a stored
 * artifact row (`repointArtifactRow`, which turns the answer into a new
 * revision) and the editor's in-memory draft (which turns it into the patch it
 * is about to save). Answers `null` when nothing changed.
 */
export function repointLibraryReferences(
  holder: LibraryReferenceHolder,
  resolve: (id: Id) => Id | undefined,
): { links: ArtifactLink[]; data: unknown } | null {
  let changed = false;
  const links = holder.links.map((link) => {
    const replacement = resolve(link.targetId);
    if (replacement === undefined || replacement === link.targetId) return link;
    changed = true;
    return { ...link, targetId: replacement };
  });

  let data = holder.data;
  if (holder.kind === 'encounter') {
    const monsters = (holder.data as { monsters?: unknown } | null | undefined)?.monsters;
    if (Array.isArray(monsters)) {
      const repointed = repointRosterArtifactIds(monsters as MonsterEntry[], resolve);
      if (repointed !== null) {
        changed = true;
        data = { ...(holder.data as object), monsters: repointed };
      }
    }
  }

  return changed ? { links, data } : null;
}

/**
 * The STORED-ROW arm of the ONE rewriter: answers the rewritten row as a fresh
 * revision (exactly the `updateArtifact` contract — bumped `currentRevision`,
 * fresh `updatedAt`, one matching snapshot written by the caller), or `null`
 * when nothing changed — which is what makes a second pass write nothing.
 */
export function repointArtifactRow(
  row: Artifact,
  resolve: (id: Id) => Id | undefined,
  now: number = Date.now(),
): Artifact | null {
  const repointed = repointLibraryReferences(row, resolve);
  if (repointed === null) return null;
  return artifactSchema.parse({
    ...row,
    links: repointed.links,
    data: repointed.data,
    currentRevision: row.currentRevision + 1,
    updatedAt: now,
  });
}
