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
 *    `updateArtifact` patch path. `repointBattleRow` is the battle row's
 *    rewriter (`board.tokens`, the stage snapshot and a derived seed row's id),
 *    whose write address is `db.battles` — the same operation at a second
 *    address, never a second copy mechanism.
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
 * rewritten by `repointArtifactRow`. `battle` covers a battle row's TOKENS —
 * `board.tokens[].artifactId` AND the saved stage snapshot
 * (`board.stage.tokens[].artifactId`), which is the same tokens one revision
 * later — rewritten by `repointBattleRow`. The battle's writer differs in the
 * WRITE ADDRESS (`db.battles`, not an artifact revision), which is why the
 * repoint half is a declared set of writers rather than one generic patch: the
 * COPY half above stays shape-independent either way.
 *
 * `battle` is the LAST writer (docs/17 row 259): a battle seeded from a
 * library npc kept a pointer to the LIBRARY row, and because the card resolves
 * through the any-scope getter its degradation was SILENT (the library row
 * deleted ⇒ nothing on the card, no named reason) rather than the loud arm
 * this seam preserves. Every shape a battle can cite is now a member, so the
 * set is closed.
 */
export const LIBRARY_ADOPT_HOLDER_SHAPES = ['roster', 'links', 'battle'] as const;

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

/**
 * THE image half of the ONE artifact collector (docs/17 row 270): the library
 * IMAGE ids an artifact row cites — an encounter's DESIGNED battlemap
 * (`encounter.data.mapImageId`), which `db/battleSeed.resolveMapImageId` reads
 * and freezes onto the board. Empty for every other kind: an image id is not
 * reachable from a location/event/npc row's stored data.
 *
 * It is deliberately SEPARATE from `libraryReferenceIds` (artifact ids): images
 * live in the `images` table, so the two answers are filtered against different
 * tables and merging them would make one collector that must be read twice to
 * be understood. Same operation, two id spaces.
 */
export function libraryImageIds(holder: LibraryReferenceHolder): Id[] {
  if (holder.kind !== 'encounter') return [];
  const mapImageId = (holder.data as { mapImageId?: unknown } | null | undefined)?.mapImageId;
  return typeof mapImageId === 'string' ? [mapImageId] : [];
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
 * mapping's RESULT, so this function never decides to share a blob. The same is
 * true of `images.data`: when the caller repointed a stored IMAGE id inside the
 * row's `data` (an encounter's `data.mapImageId`, docs/17 row 270) it passes the
 * rewritten block in; otherwise the source's own `data` is cloned verbatim.
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
  images: { imageIds: readonly Id[]; coverImageId: Id | null; data?: unknown },
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
    // The `data` block is the source's OWN unless the caller repointed a stored
    // IMAGE id inside it (an encounter's `data.mapImageId`, docs/17 row 270) —
    // a `structuredClone` cannot know which of its keys was a library reference.
    data: images.data ?? source.data,
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
    const encounterData = holder.data as
      | { monsters?: unknown; mapImageId?: unknown }
      | null
      | undefined;
    const monsters = encounterData?.monsters;
    if (Array.isArray(monsters)) {
      const repointed = repointRosterArtifactIds(monsters as MonsterEntry[], resolve);
      if (repointed !== null) {
        changed = true;
        data = { ...(holder.data as object), monsters: repointed };
      }
    }
    // THE ENCOUNTER'S DESIGNED BATTLEMAP (docs/17 row 270): `data.mapImageId` is
    // a stored IMAGE reference — the SOURCE `db/battleSeed.resolveMapImageId`
    // freezes onto every battle board. Leaving it pointing at a library image
    // would re-mint the board's library id on the next re-seed, so it is
    // repointed through the SAME `resolve` as every other reference.
    const mapImageId = encounterData?.mapImageId;
    if (typeof mapImageId === 'string') {
      const replacement = resolve(mapImageId);
      if (replacement !== undefined && replacement !== mapImageId) {
        changed = true;
        data = { ...(data as object), mapImageId: replacement };
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

/**
 * THE BATTLE HALF of the adoption seam (docs/17 rows 259/268) — the LAST
 * declared holder shape, and the one whose write address is not an artifact row.
 *
 * A battle token's `artifactId` is a real artifact reference for an `npc-ref`
 * seed (docs/11 D5 amendment) and a synthetic seed handle for a `rulebook`
 * citation or an inline mob; a PC token cites its pc artifact. The board list
 * AND its stage snapshot (`⚑ Set stage` copies the tokens) are both live token
 * carriers, so a stage snapshot that keeps the old reference would be the same
 * defect one revision later. The row's SEEDING ENCOUNTER (`encounterArtifactId`)
 * and its re-seed stamp are references of the same kind and are collected and
 * repointed too (docs/17 row 268, the reversal of row 263's exception).
 *
 * These functions read the STORED row's shape (every field optional: a legacy
 * battle row may predate any of them), never a parsed `Battle`, because the
 * seam runs inside a Dexie upgrade where a parse of historical rows is the one
 * thing that must not throw.
 */
export interface LibraryBattleTokenRef {
  artifactId?: Id | null | undefined;
  label?: string | undefined;
}

export interface LibraryBattleRefs {
  board?:
    | {
        /**
         * The board's battlemap — an IMAGE id, so it is not an artifact
         * reference and rides the image half of this seam (docs/17 row 270)
         * rather than the token collector.
         */
        mapImageId?: Id | null | undefined;
        tokens?: readonly LibraryBattleTokenRef[] | undefined;
        stage?:
          | (Record<string, unknown> & {
              /** The stage snapshot's copy of `board.mapImageId`. */
              mapImageId?: Id | null | undefined;
              tokens?: readonly LibraryBattleTokenRef[] | undefined;
            })
          | null
          | undefined;
      }
    | null
    | undefined;
  seedFighters?: readonly { id: Id }[] | undefined;
  /**
   * The battle's SEEDING encounter. It is the battle's IDENTITY key
   * (`db/battleRepo.getBattleByEncounter`) AND, when it names a LIBRARY row, a
   * stored save/load dependency — so it IS collected and repointed at the
   * campaign's adopted copy (docs/17 row 268). Row 263's DELIBERATE EXCEPTION
   * is REVERSED by the owner's own correction, verbatim: *"why is there still
   * an identity reference? I do not want any that is stored. I want campaign
   * data completely isolated from libraries, completely, not mostly. because
   * if there is still a reference, saving and loading get dependencies."* A
   * reference to a LIBRARY row is a library dependency whichever field it sits
   * in, and re-keying it to the CAMPAIGN's own copy keeps the field's meaning
   * ("the encounter this battle was seeded from") while the thing it names is
   * campaign-owned. A gone row is NAMED, never re-keyed to a guess.
   */
  encounterArtifactId?: Id | null | undefined;
  /**
   * The last destructive RE-SEED's stamped provenance (encounter-resume arc) —
   * the SAME encounter id one revision later, so it moves with the key
   * (docs/17 row 268).
   */
  reseed?: { encounterArtifactId?: Id | null | undefined } | null | undefined;
}

/** THE battle half of the ONE collector: every artifact id the battle's ROW
 * cites — the board tokens (the list AND the saved stage snapshot), the SEEDING
 * ENCOUNTER key and the re-seed stamp (docs/17 row 268). The frozen
 * `seedFighters` rows are deliberately NOT collected: their `id` is a synthetic
 * per-expansion handle that only coincides with an artifact id for a DERIVED
 * `npc-ref`, and that token already names the reference — collecting it twice
 * would decide one library row twice. `repointBattleRow` still REMAPS a seed row
 * whose id is a repointed id, so the frozen row a token keys its stats on
 * survives. */
export function battleLibraryReferenceIds(battle: LibraryBattleRefs): Id[] {
  const ids: Id[] = [];
  const collect = (tokens: readonly LibraryBattleTokenRef[]): void => {
    for (const token of tokens) {
      const artifactId = token.artifactId;
      if (artifactId !== null && artifactId !== undefined) ids.push(artifactId);
    }
  };
  collect(battle.board?.tokens ?? []);
  collect(battle.board?.stage?.tokens ?? []);
  // The battle's IDENTITY key (docs/17 row 268): a LIBRARY-scoped encounter IS
  // runnable, and a stored key naming a library row is exactly the dependency
  // the owner corrected row 263 over. Duplicates with the re-seed stamp are
  // harmless — the pass decides each library id once.
  const encounterArtifactId = battle.encounterArtifactId;
  if (encounterArtifactId !== null && encounterArtifactId !== undefined) {
    ids.push(encounterArtifactId);
  }
  const reseedEncounterId = battle.reseed?.encounterArtifactId;
  if (reseedEncounterId !== null && reseedEncounterId !== undefined) ids.push(reseedEncounterId);
  return ids;
}

/**
 * THE battle's IMAGE references (docs/17 row 270): its `board.mapImageId` and
 * the saved stage snapshot's copy of it — the map slot the table renders.
 *
 * A SEPARATE id space from `battleLibraryReferenceIds` (artifact ids), because
 * an image lives in the `images` table: the caller filters this list against
 * the image rows and the artifact list against the artifact rows. The two
 * carriers are BOTH live (`⚑ Set stage` copies the board's map into the stage,
 * and `resetBattleToStage` restores it), so a stage snapshot left behind would
 * be the same defect one revision later.
 */
export function battleMapImageIds(battle: LibraryBattleRefs): Id[] {
  const ids: Id[] = [];
  const board = battle.board?.mapImageId;
  if (board !== null && board !== undefined) ids.push(board);
  const stage = battle.board?.stage?.mapImageId;
  if (stage !== null && stage !== undefined) ids.push(stage);
  return ids;
}

/**
 * Rewrite a battle row's library references to their campaign copies: the
 * board tokens, the stage snapshot's tokens, the frozen seed rows whose id is a
 * repointed handle (a derived `npc-ref` freezes its seed row under the artifact
 * id, so the token must keep finding it), the SEEDING ENCOUNTER key and the
 * re-seed stamp's copy of it (docs/17 row 268). Answers `null` when nothing
 * changed — the arm that makes a second pass write nothing. Immutable: an
 * unchanged token/seed/key keeps its identity.
 */
export function repointBattleRow<T extends LibraryBattleRefs>(
  battle: T,
  resolve: (id: Id) => Id | undefined,
): T | null {
  // Change is detected by IDENTITY, never by a captured boolean flag: TS's
  // control-flow analysis cannot see an assignment made inside a `.map`
  // callback, so a flag reads as always-false here (`no-unnecessary-condition`)
  // — the same trap rows 255a/257 hit. Returning the changed bit alongside the
  // mapped list keeps the truth inside the value.
  const repointTokens = (
    tokens: readonly LibraryBattleTokenRef[],
  ): { tokens: readonly LibraryBattleTokenRef[]; changed: boolean } => {
    let touched = false;
    const next = tokens.map((token) => {
      const artifactId = token.artifactId;
      if (artifactId === null || artifactId === undefined) return token;
      const replacement = resolve(artifactId);
      if (replacement === undefined || replacement === artifactId) return token;
      touched = true;
      return { ...token, artifactId: replacement };
    });
    return { tokens: next, changed: touched };
  };
  const repointSeeds = (
    seeds: readonly { id: Id }[],
  ): { seeds: readonly { id: Id }[]; changed: boolean } => {
    let touched = false;
    const next = seeds.map((seed) => {
      const replacement = resolve(seed.id);
      if (replacement === undefined || replacement === seed.id) return seed;
      touched = true;
      return { ...seed, id: replacement };
    });
    return { seeds: next, changed: touched };
  };

  const board = battle.board;
  const live = board ?? null;
  const boardTokens = live === null ? null : repointTokens(live.tokens ?? []);
  const stage = live?.stage ?? null;
  const stageTokens = stage === null ? null : repointTokens(stage.tokens ?? []);
  // THE MAP SLOT (docs/17 row 270): an image id is not an artifact id, but it
  // rides the SAME `resolve` — the caller's copy map holds both id spaces, and
  // an id with no copy answers `undefined`, so a gone library image is LEFT as
  // it is (named by the caller) rather than pointed at a guess.
  const repointMap = (
    mapImageId: Id | null | undefined,
  ): { mapImageId: Id | null | undefined; changed: boolean } => {
    if (mapImageId === null || mapImageId === undefined) return { mapImageId, changed: false };
    const replacement = resolve(mapImageId);
    if (replacement === undefined || replacement === mapImageId) {
      return { mapImageId, changed: false };
    }
    return { mapImageId: replacement, changed: true };
  };
  const boardMap = repointMap(live?.mapImageId);
  const stageMap = repointMap(stage?.mapImageId);
  const seeds = repointSeeds(battle.seedFighters ?? []);
  // THE SEEDING ENCOUNTER (docs/17 row 268): a LIBRARY-scoped key is re-keyed
  // onto the campaign's own copy, and the re-seed stamp's copy of the same id
  // moves with it. `resolve` answers `undefined` for an id with no copy (a gone
  // library row), so the key is LEFT as it is and named by the caller.
  const encounterId = battle.encounterArtifactId;
  const encounterReplacement =
    encounterId === null || encounterId === undefined ? undefined : resolve(encounterId);
  const encounterChanged =
    encounterReplacement !== undefined && encounterReplacement !== encounterId;
  const reseed = battle.reseed ?? null;
  const reseedEncounterId = reseed?.encounterArtifactId;
  const reseedReplacement =
    reseedEncounterId === null || reseedEncounterId === undefined
      ? undefined
      : resolve(reseedEncounterId);
  const reseedChanged =
    reseed !== null && reseedReplacement !== undefined && reseedReplacement !== reseedEncounterId;
  const changed =
    (boardTokens?.changed ?? false) ||
    (stageTokens?.changed ?? false) ||
    boardMap.changed ||
    stageMap.changed ||
    seeds.changed ||
    encounterChanged ||
    reseedChanged;
  if (!changed) return null;
  const nextBoard =
    live === null
      ? null
      : {
          ...live,
          ...(boardMap.changed ? { mapImageId: boardMap.mapImageId } : {}),
          tokens: boardTokens?.tokens ?? [],
          ...(stage === null
            ? {}
            : {
                stage: {
                  ...stage,
                  ...(stageMap.changed ? { mapImageId: stageMap.mapImageId } : {}),
                  tokens: stageTokens?.tokens ?? [],
                },
              }),
        };
  const next = {
    ...battle,
    ...(live === null ? {} : { board: nextBoard }),
    seedFighters: seeds.seeds,
    ...(encounterChanged ? { encounterArtifactId: encounterReplacement } : {}),
    ...(reseedChanged ? { reseed: { ...reseed, encounterArtifactId: reseedReplacement } } : {}),
  } as T;
  return next;
}

/** One token whose target resolves to NOTHING — the genuinely-unresolvable
 * arm: not an artifact row in any scope, and not one of the battle's own frozen
 * seed handles. Named in the report, never dropped, because the deletion path
 * that produces it (`db/artifactRepo.deleteArtifact` scrubs tokens only for an
 * OWNED row, so deleting a SHARED library row leaves every campaign's tokens
 * dangling) has no loud surface of its own for battle tokens. */
export interface DanglingBattleToken {
  label: string;
  artifactId: Id;
}

/**
 * The battle's tokens whose cite resolves to nothing, board list and stage
 * snapshot, deduped by label+id. `knownArtifactIds` is every artifact row the
 * caller can see (any scope) and the seed handles come from the row itself —
 * the two ways a token's `artifactId` is legitimately answered without a
 * library read. Everything left is a reference no copy can heal.
 */
export function danglingBattleTokens(
  battle: LibraryBattleRefs,
  knownArtifactIds: ReadonlySet<Id>,
): DanglingBattleToken[] {
  const seedIds = new Set((battle.seedFighters ?? []).map((seed) => seed.id));
  const seen = new Set<string>();
  const out: DanglingBattleToken[] = [];
  const examine = (tokens: readonly LibraryBattleTokenRef[]): void => {
    for (const token of tokens) {
      const artifactId = token.artifactId;
      if (artifactId === null || artifactId === undefined) continue;
      if (knownArtifactIds.has(artifactId) || seedIds.has(artifactId)) continue;
      const label = token.label ?? '(unlabelled token)';
      const key = `${label}\u0000${artifactId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ label, artifactId });
    }
  };
  examine(battle.board?.tokens ?? []);
  examine(battle.board?.stage?.tokens ?? []);
  return out;
}

/**
 * The battle's SEEDING-ENCOUNTER id when it resolves to NOTHING — the loud arm
 * that survives the row-268 reversal.
 *
 * A battle is KEYED by its seeding encounter (`db/battleRepo.getBattleByEncounter`),
 * and since docs/17 row 268 that key is ADOPTED onto the campaign's own copy
 * like every other library reference. Adoption cannot invent bytes, though: a
 * key whose row is in NO table (not a campaign's, not the shared library's) has
 * nothing to copy, so it is LEFT AS IT IS — never re-keyed to a guess — and
 * NAMED here, because deletion of a SHARED library row scrubs no campaign's
 * rows (`db/artifactRepo.deleteArtifact` scrubs only for an OWNED row) and the
 * surface would otherwise show nothing with no reason. Returned to the caller
 * so the id reaches `settings.libraryAdopt.unresolved` beside the dangling
 * tokens.
 */
export function danglingBattleEncounter(
  battle: LibraryBattleRefs,
  knownArtifactIds: ReadonlySet<Id>,
): Id | undefined {
  const encounterArtifactId = battle.encounterArtifactId;
  if (encounterArtifactId === null || encounterArtifactId === undefined) return undefined;
  return knownArtifactIds.has(encounterArtifactId) ? undefined : encounterArtifactId;
}

/**
 * THE battle map's GONE arm (docs/17 row 270): a `board.mapImageId` (or its
 * stage copy) whose blob is in NO image table — the library was re-ingested, or
 * the image was deleted, after the battle froze the id.
 *
 * Adoption cannot invent bytes, so the id is LEFT EXACTLY as it is and NAMED
 * here rather than repointed to a placeholder (AGENTS rule 1). The surface
 * itself is SILENT about this (a missing map image renders a blank board with
 * no reason), which is why the adoption report carries the name — the same
 * reasoning as `danglingBattleTokens`. Deduped: the board and its stage
 * snapshot legitimately carry the SAME id, and one gone image is one fact.
 */
export function danglingBattleMapImages(
  battle: LibraryBattleRefs,
  knownImageIds: ReadonlySet<Id>,
): Id[] {
  const out: Id[] = [];
  for (const imageId of battleMapImageIds(battle)) {
    if (!knownImageIds.has(imageId) && !out.includes(imageId)) out.push(imageId);
  }
  return out;
}
