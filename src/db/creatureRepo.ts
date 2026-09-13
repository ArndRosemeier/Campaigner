import type {
  CreatureIdentity,
  CreatureRef,
  Id,
  NpcArtifact,
  RuleChunk,
  StatBlock,
  WikiLinkCreature,
} from '@/domain';
import {
  contentCreatureIdentity,
  creatureIdentityForCitation,
  creatureRefIsEmpty,
  libraryCreatureKey,
  moduleTagFor,
  npcCreatureRef,
} from '@/domain';
import { setLibraryCreaturePool } from '@/lib/wikilinks';
import {
  creatureCitationName,
  creatureOriginLabel,
  missingCreatureOrigin,
  resolveCreatureChunk,
  resolveDerivedNpcStats as derivedNpcStats,
  type CreatureCitation,
  type MonsterLookups,
  type ResolvedCreature,
} from '@/domain/encounterResolve';
import {
  createArtifact,
  stampModuleOwnership,
  getAnyArtifact,
  listArtifactsByCampaign,
  type RevisionMeta,
} from '@/db/artifactRepo';
import { getChunksByContentHash } from '@/db/chunkRepo';
import {
  documentCoverImageId,
  getCreatureImageRow,
  insertCreatureImageRow,
} from '@/db/creatureImages';
import { db } from '@/db/db';
import { deleteImageIfUnreferenced } from '@/db/imageRepo';
import {
  canonicalCreatureName,
  cloneCachedPortraitToArtifact,
  getMobPortraitCacheEntry,
  isCanonicalCitation,
} from '@/db/mobPortraitCache';

/**
 * THE creature layer (owner-ratified core-mob arc; docs/18 §2). One module
 * owns every question top code is allowed to ask about a creature:
 *
 *  1. `resolveCreatureCitation` — "what are this creature's numbers, and where
 *     did they come from?"
 *  2. `creatureCoverImageId` — "which image is this creature's look?"
 *  3. `setCreatureCover` — the ONE write of that look.
 *  4. `castCreatureAsNpc` — the Aunt Agatha path (docs/11 D4): the ONLY way an
 *     authored NPC is born out of a creature, and the only function that
 *     touches the portrait cache on behalf of an artifact.
 *
 * Layering (the owner's explicit ask): a UI panel passes a CITATION and gets
 * numbers, a name and an image id back. It never sees a chunk id, a content
 * hash or a portrait key. `setCreatureCover` takes a creature KEY and an image
 * id and NO artifact parameter at all, so "does this creature need an artifact
 * for its portrait?" cannot even be typed.
 *
 * The library tier is READ-ONLY structurally (docs/11 D8): nothing here writes
 * a chunk or a creature. The bestiary-creature refusal of the previous arc is
 * gone with the rows it guarded (docs/17 row 106) — not reimplemented, because
 * there is no writer to refuse.
 */

/** The repo-wired library lookups (shared with `db/monsterResolve`). */
export function creatureLookups(): MonsterLookups {
  return {
    getArtifact: (id: Id) => getAnyArtifact(id),
    getChunk: (id: Id) => db.chunks.get(id),
    getChunkByContentHash: async (contentHash: string) => {
      // Several local chunks may share one hash (re-ingests): prefer the one
      // that actually carries stats, mirroring the import verdict's L0 rule
      // (a hash hit on a statless chunk never satisfies).
      const rows = await getChunksByContentHash(contentHash);
      return rows.find((row) => row.statBlock !== null) ?? rows[0];
    },
    getRulebook: (bookId: Id) => db.rulebooks.get(bookId),
  };
}

/**
 * A resolved library creature: the numbers, the disclosed origin, and the
 * IDENTITY every portrait answer keys on. `chunk` is the row that ANSWERED
 * (never necessarily the row the citation named — the content-hash fallback
 * may find a different id for the same bytes, and the identity follows the
 * RESOLVED row so a healed citation shares the direct citation's portrait).
 */
export interface ResolvedCreatureListing {
  /** The creature's own name: the citation's stamped name, else the fallback. */
  name: string;
  statBlock: StatBlock | null;
  /** The disclosed origin label, exactly what a GM sees. */
  origin: string;
  identity: CreatureIdentity;
  /** The resolved library chunk, or null when the library lacks it. */
  chunk: RuleChunk | null;
  /** The resolved chunk's id, or null. */
  chunkId: Id | null;
  /** True when the citing name matches the chunk's canonical creature name —
   * the one generation that may populate the SHARED canonical slot. */
  canonical: boolean;
}

/**
 * Resolves one library creature citation end to end. `fallbackName` is the
 * name the caller knows the creature by (the roster entry, the authored NPC)
 * and is used only where the citation stamps no name of its own.
 *
 * A citation carrying no library pointer at all is a loud error, never a
 * silent empty resolution (AGENTS rule 1): nothing can resolve it, and calling
 * that "missing" would hide a write-side bug behind a read-side label.
 */
export async function resolveCreatureCitation(
  citation: CreatureCitation,
  fallbackName: string,
): Promise<ResolvedCreatureListing> {
  if (creatureRefIsEmpty(citation)) {
    throw new Error(
      `creature citation for "${fallbackName}" carries neither a chunk id nor a content hash — nothing can resolve it`,
    );
  }
  const lookups = creatureLookups();
  const name = creatureCitationName(citation, fallbackName);
  const chunk = await resolveCreatureChunk(citation, lookups);
  if (chunk === undefined) {
    return {
      name,
      statBlock: null,
      origin: missingCreatureOrigin(name),
      // No resolved row: the key still follows the citation's own uuid when it
      // has one (so a re-install that restores the row heals every portrait at
      // once). A citation with only a content hash has no library identity to
      // key on, so its portrait would be the content one — which is why the
      // label above is a named `missing ref` rather than a silent absence.
      identity:
        citation.chunkId === undefined
          ? contentCreatureIdentity(name, undefined)
          : creatureIdentityForCitation(citation, citation.chunkId),
      chunk: null,
      chunkId: null,
      canonical: false,
    };
  }
  const identity = creatureIdentityForCitation(citation, chunk.id);
  const canonicalName = canonicalCreatureName(chunk);
  return {
    name,
    statBlock: chunk.statBlock ?? null,
    origin:
      chunk.statBlock == null
        ? missingCreatureOrigin(name)
        : await creatureOriginLabel(chunk, name, lookups),
    identity,
    chunk,
    chunkId: chunk.id,
    canonical: canonicalName !== null && isCanonicalCitation(canonicalName, name),
  };
}

/**
 * The numbers of an AUTHORED NPC whose number source is DERIVED from a library
 * creature (docs/11 D3), repo-wired for top code: this wrapper only supplies
 * the library lookups — the RULE (the resolution order, the `derivedStatOrigin`
 * label and the `missing ref` failure) lives in
 * `domain/encounterResolve.resolveDerivedNpcStats`, which the encounter
 * roster's `npc-ref` arm reads too, so a row's own details surface and an
 * encounter listing it cannot disagree. Read-only by construction: it derives,
 * and nothing here writes a block onto the row (the `creatureRef` + authored
 * is refused by `npcDataSchema`).
 */
export function resolveDerivedNpcStats(
  npcName: string,
  citation: CreatureRef,
): Promise<ResolvedCreature> {
  return derivedNpcStats(npcName, citation, creatureLookups());
}

/** The identity of a creature with no library row behind it — an invented mob
 * (docs/11 D5). The KEY is the identity; nothing is written anywhere. */
export function inventedCreatureIdentity(
  name: string,
  statBlock: StatBlock | null,
): CreatureIdentity {
  return contentCreatureIdentity(name, statBlock);
}

/**
 * Do these two creature references name the SAME creature? An identity is a
 * chunk uuid when one is known and the content hash otherwise (`domain/creature`
 * — hash fallback tried FIRST only where the uuid is absent, docs/11 D9), so
 * two references agree when their known keys agree and disagree only when both
 * carry a key and the keys differ. A reference with NEITHER key is empty and
 * matches nothing.
 */
export function creatureRefIdentical(
  left: CreatureRef | undefined,
  right: CreatureRef | undefined,
): boolean {
  if (left === undefined || right === undefined) return false;
  if (left.chunkId !== undefined && right.chunkId !== undefined) {
    return left.chunkId === right.chunkId;
  }
  if (left.contentHash !== undefined && right.contentHash !== undefined) {
    return left.contentHash === right.contentHash;
  }
  // One side knows only the name: no identity claim can be made from it, so the
  // comparison refuses rather than guessing (never a silent fallback).
  return false;
}

/**
 * ONE library creature of the pool below — the row-derived facts every caller
 * of `listLibraryCreatures` needs. `statBlock` is the creature's OWN validated
 * block, carried because the chunk row already holds it and because a prompt
 * window that must ORDER the library by level has nowhere else to read it from
 * without a second chunk read (docs/17 row 114).
 */
export interface LibraryCreature {
  chunkId: Id;
  name: string;
  contentHash: string;
  headingPath: readonly string[];
  statBlock: StatBlock | null;
}

/**
 * THE library creature pool (docs/11 D10): every stat-block chunk as a DERIVED
 * creature — its identity (the chunk) and the library's own spelling of its
 * name (the last non-empty `headingPath` element, `canonicalCreatureName`'s one
 * rule). Pure read, computed, never a row: nothing here writes, and no artifact
 * is involved.
 *
 * This is what makes a module's `[[Zombie]]` resolve once no mob artifact stands
 * in for the creature — the mention reads as a CITATION of a library creature,
 * which is exactly what it is. Two chunks carrying the same name yield one entry
 * each (a name is not an identity); the FIRST wins for the name-addressed
 * wiki-link lookup, which is why the list is ordered by name then chunk id (a
 * stable answer rather than a race).
 *
 * It is ALSO the population of the module creator's bestiary window
 * (`llm/creatorRoster`, docs/17 row 114) and therefore the ONE source of truth
 * for "which creature names may a generated module ask to cast": the window
 * lists these names and `features/modules/entity-batch` resolves against them,
 * so the vocabulary a prompt shows and the lookup that judges the reply cannot
 * disagree. Deliberately NOT filtered by book origin — a creature imported from
 * an ordinary rulebook is as castable as a pack one.
 */
export async function listLibraryCreatures(): Promise<LibraryCreature[]> {
  const chunks = await db.chunks.where('chunkType').equals('statblock').toArray();
  const creatures: LibraryCreature[] = [];
  for (const chunk of chunks) {
    if (chunk.statBlock === null) continue;
    const name = canonicalCreatureName(chunk);
    if (name === null) continue;
    creatures.push({
      chunkId: chunk.id,
      name,
      contentHash: chunk.contentHash,
      headingPath: chunk.headingPath,
      statBlock: chunk.statBlock,
    });
  }
  creatures.sort((left, right) => {
    const byName = left.name.trim().toLowerCase().localeCompare(right.name.trim().toLowerCase());
    return byName !== 0 ? byName : left.chunkId.localeCompare(right.chunkId);
  });
  return creatures;
}

/** The same pool in the shape `lib/wikilinks` resolves against (the ONE
 * conversion, so no caller re-derives it). */
export async function wikiLinkCreatures(): Promise<WikiLinkCreature[]> {
  return (await listLibraryCreatures()).map((creature) => ({
    chunkId: creature.chunkId,
    name: creature.name,
  }));
}

/**
 * Publishes the library creature pool to the wiki-link resolver (docs/11 D10)
 * and answers with it. Called by the app shell once per library state
 * (`app/use-library-creatures`) so every reader surface resolves a
 * `[[Zombie]]` mention as a CITATION rather than a dangling link. Returns the
 * published list, so a caller that needs it too does not read the table twice.
 */
export async function publishLibraryCreaturePool(): Promise<WikiLinkCreature[]> {
  const creatures = await wikiLinkCreatures();
  setLibraryCreaturePool(creatures);
  return creatures;
}

/** The library identity of a creature addressed by its chunk id. */
export function identityForChunk(chunkId: Id): CreatureIdentity {
  return { kind: 'library', key: libraryCreatureKey(chunkId), ref: { chunkId } };
}

/**
 * A creature identity is the WHOLE key of a presentation row, so an empty one
 * would collapse every creature in the campaign onto one row (`['camp','']`)
 * and show a stranger's portrait for a monster nobody illustrated. Refused
 * LOUDLY here — the ONE door both reads and writes pass through — rather than
 * silently answering "no art" or, worse, overwriting a shared row.
 */
function requireCreatureKey(creatureKey: string): void {
  if (creatureKey.trim() === '') {
    throw new Error(
      'creature portrait: the creature identity is empty — every creature would share one portrait row; resolve the creature before reading or writing its portrait',
    );
  }
}

/**
 * THE portrait question — the only one top code asks (docs/11 D6): which image
 * is this creature's look IN THIS CAMPAIGN? Resolution order:
 *
 * 1. the campaign's presentation row for the identity (the normal case — a
 *    cited creature, an invented mob, a battle token);
 * 2. else the cover/gallery of the AUTHORED NPC the caller names (an authored
 *    NPC's portrait lives on its own row — cast or hand-made);
 * 3. else null: no art yet, which is a NORMAL state, never an error.
 *
 * No artifact has to exist for 1, and no cache row has to exist for 2.
 */
export async function creatureCoverImageId(options: {
  campaignId: Id;
  creatureKey: string;
  /** The authored NPC whose own cover also answers (the cast path). */
  npcArtifactId?: Id | null | undefined;
}): Promise<Id | null> {
  requireCreatureKey(options.creatureKey);
  const direct = await getCreatureImageRow(options.campaignId, options.creatureKey);
  if (direct !== undefined) return documentCoverImageId(direct);
  if (options.npcArtifactId === undefined || options.npcArtifactId === null) return null;
  const npc = await getAnyArtifact(options.npcArtifactId);
  if (npc === undefined) return null;
  if (npc.coverImageId !== null) return npc.coverImageId;
  return npc.imageIds[0] ?? null;
}

/**
 * What one BATTLE TOKEN stands for (docs/11 D5 amendment / D10): the creature
 * identity the board resolves its portrait and its stat block by, plus the name
 * to show and the stat-block chunk when the token's creature is a library one.
 *
 * The token's OWN `creatureKey` is the answer whenever it has one — seeding
 * stamps it (`db/battleSeed`) for a `rulebook` citation and for an invented
 * creature, so the board never has to re-derive an identity from an artifact
 * that may not exist. An `npc-ref` token resolves through its artifact: a CAST
 * creature npc carries its `creatureRef` (its own prose, the library's stats),
 * a plain authored npc has no creature identity at all and yields `null` — its
 * portrait is its own cover, managed in the editor, never on the board.
 */
export async function tokenCreature(options: {
  campaignId: Id;
  creatureKey?: string | undefined;
  artifactId: Id | null | undefined;
  name: string;
}): Promise<{
  creatureKey: string;
  name: string;
  chunkId: Id | undefined;
  statBlock: StatBlock | null;
  identityLabel: string | null;
} | null> {
  if (options.creatureKey !== undefined && options.creatureKey !== '') {
    const chunkId = chunkIdOfCreatureKey(options.creatureKey);
    if (chunkId === null) {
      return {
        creatureKey: options.creatureKey,
        name: options.name,
        chunkId: undefined,
        statBlock: null,
        identityLabel: null,
      };
    }
    const listing = await resolveCreatureCitation({ chunkId }, options.name);
    return {
      creatureKey: options.creatureKey,
      name: listing.chunk === null ? options.name : listing.name,
      chunkId,
      statBlock: listing.chunk?.statBlock ?? null,
      identityLabel: listing.origin,
    };
  }
  if (options.artifactId === null || options.artifactId === undefined) return null;
  const artifact = await getAnyArtifact(options.artifactId);
  if (artifact?.kind !== 'npc') return null;
  const citation = npcCreatureRef(artifact);
  if (citation === undefined || creatureRefIsEmpty(citation)) return null;
  const listing = await resolveCreatureCitation(citation, artifact.name);
  return {
    creatureKey: listing.identity.key,
    name: artifact.name,
    chunkId: listing.chunk?.id ?? listing.identity.ref.chunkId ?? undefined,
    statBlock: listing.chunk?.statBlock ?? null,
    identityLabel: listing.origin,
  };
}

/** The chunk a library creature identity key names, or null for a content key.
 * The ONE parse of the `chunk:` prefix (`domain/creature`'s spelling). */
export function chunkIdOfCreatureKey(creatureKey: string): Id | null {
  return creatureKey.startsWith('chunk:') ? creatureKey.slice('chunk:'.length) : null;
}

/** Where one creature's portrait stands, for the batch UI's counts. */
export type CreaturePortraitArt = 'none' | 'cover';

/**
 * The ONE reading of a creature's presentation art over a campaign snapshot
 * (`creatureImageIdsByKey`) — the read-only batch count and the module-level
 * gap detector both walk this, so the offer and the work can never disagree.
 * A creature whose identity has no row has no art yet: the count's `missing`.
 */
export function creaturePortraitArtIn(
  presentationByKey: ReadonlyMap<string, Id>,
  creatureKey: string,
): CreaturePortraitArt {
  return presentationByKey.has(creatureKey) ? 'cover' : 'none';
}

/** The same question for ONE creature, straight from the DB. */
export async function creaturePortraitArt(
  campaignId: Id,
  creatureKey: string,
): Promise<CreaturePortraitArt> {
  return (await getCreatureImageRow(campaignId, creatureKey)) === undefined ? 'none' : 'cover';
}

/**
 * Writes the campaign's presentation row for a creature identity — the ONE
 * write of a creature's look (the portrait worker's commit path). Returns the
 * row's image id.
 *
 * Replacement is delete-after-replace (docs/11 D5 preservation rule): the NEW
 * row is written FIRST, so a crash between the two leaves the creature imaged
 * with a stale pin rather than imageless with an orphaned blob; the superseded
 * campaign image is released afterwards, and only when nothing else references
 * it (the presentation row was its only pin).
 */
export async function setCreatureCover(options: {
  campaignId: Id;
  creatureKey: string;
  imageId: Id;
}): Promise<Id> {
  requireCreatureKey(options.creatureKey);
  const existing = await getCreatureImageRow(options.campaignId, options.creatureKey);
  if (existing === undefined) {
    await insertCreatureImageRow(options);
    return options.imageId;
  }
  const superseded = existing.imageId;
  await db.creatureImages.put({ ...existing, imageId: options.imageId });
  if (superseded !== options.imageId) await deleteImageIfUnreferenced(superseded);
  return options.imageId;
}

/* -------------------------------------------------------------------------
 * D4 — THE CAST (the Aunt Agatha path)
 * ---------------------------------------------------------------------- */

export interface CastCreatureOptions {
  campaignId: Id;
  /**
   * The module the NPC belongs to. `null` casts a campaign-level NPC. A module
   * id that no longer exists fails LOUDLY (the ownership-boundary existence
   * check, docs/18 §3) rather than stamping a dangling owner.
   */
  moduleId: Id | null;
  /** The library creature whose stats the NPC borrows. */
  citation: CreatureCitation;
  /** The NPC's own name — the roster/wiki-link identity. */
  name: string;
  /**
   * The authored prose the NPC is FOR (the module's text about them). Omitted
   * ⇒ the NPC is cast as a bare named row (the bestiary roster's "Spawn into
   * module" action): its `creatureRef` and derived stats are complete, and its
   * prose is the module designer's to write — an empty text field is a state,
   * never a placeholder (AGENTS rule 1).
   */
  prose?: { summary?: string; body?: string; appearance?: string; personality?: string };
  /**
   * The run doing the casting. Recorded on the NPC it CREATES as
   * `data.castByRunId` — a marker of "cast but not yet written in", cleared by
   * the generation seam the moment the NPC gets real prose. Idempotency itself
   * is per (campaign, module, name, IDENTITY) and does not depend on this.
   */
  runId?: Id | undefined;
  /** The model that wrote `prose`, when a model did (provenance arc). */
  writerModel?: string | undefined;
  meta?: RevisionMeta;
}

export type CastCreatureOutcome =
  | { status: 'created'; artifactId: Id }
  | { status: 'reused'; artifactId: Id };

/**
 * THE ONE WAY an authored NPC comes out of a creature (docs/11 D4). Given a
 * campaign (and module), a library creature and authored prose, it creates a
 * REAL `npc` artifact carrying that prose plus a `creatureRef` — so the NPC's
 * stat block is DERIVED from the creature and the derivation is disclosed in
 * the origin label. The creature's cached portrait is seeded onto the NPC as
 * its cover when one exists, through the existing clone machinery.
 *
 * Nothing else in the app may create an NPC from a creature: the encounter
 * generator cannot reach this module at all (docs/11 D5), which is how the
 * asymmetry is enforced — by the ABSENCE OF A FUNCTION, not by a prompt rule.
 *
 * REUSE, never duplication (AGENTS rule 1: no silent overwrite): an existing
 * cast of the SAME creature under the same name in the same scope is returned
 * as-is — a second cast writes NOTHING to it, so prose a designer has since
 * written in can never be clobbered by a re-run. A name already taken in that
 * scope by anything else (an authored NPC, or a cast of a different creature)
 * is a LOUD error naming the collision, never a silent merge or takeover.
 */
export async function castCreatureAsNpc(options: CastCreatureOptions): Promise<CastCreatureOutcome> {
  const name = options.name.trim();
  if (name === '') {
    throw new Error('cast creature as npc: an NPC cannot be cast without a name');
  }
  const prose = options.prose ?? {};
  /** The `module:<title>` tag a module-owned row carries — the compatibility
   * tag every module-scoped reader keys on. A cast npc is an ORDINARY npc of
   * that module (docs/11 D4), so it carries it like any other: without it the
   * row existed but no module-scoped predicate could see it as owned. */
  let moduleTag: string | null = null;
  if (options.moduleId !== null) {
    const module = await db.modules.get(options.moduleId);
    if (module === undefined) {
      throw new Error(
        `cast creature as npc: module ${options.moduleId} no longer exists — re-anchor the entity before casting`,
      );
    }
    moduleTag = moduleTagFor(module.title);
  }
  const listing = await resolveCreatureCitation(options.citation, name);
  if (listing.chunk === null) {
    // Loud (AGENTS rule 1): casting a creature the library cannot supply would
    // mint an NPC whose numbers are a silent hole.
    throw new Error(
      `cast creature as npc: refusing to cast «${name}» — the cited library creature is not in this workspace (${listing.origin})`,
    );
  }
  const owned = await listArtifactsByCampaign(options.campaignId);
  const candidates = owned.filter(
    (artifact): artifact is NpcArtifact =>
      artifact.kind === 'npc' &&
      artifact.moduleId === options.moduleId &&
      artifact.name.trim().toLowerCase() === name.toLowerCase(),
  );
  // Idempotency is per (campaign, module, name, IDENTITY): a second cast of the
  // SAME creature reuses its row rather than minting a twin, and a candidate
  // that already points somewhere else is a rival — taking it over would
  // silently re-stat an NPC the owner authored.
  const sameIdentity = (artifact: NpcArtifact): boolean =>
    creatureRefIdentical(artifact.data.creatureRef, listing.identity.ref);
  const match = candidates.find(sameIdentity);

  let artifactId: Id;
  let status: 'created' | 'reused';
  if (match !== undefined) {
    artifactId = match.id;
    status = 'reused';
    // A row this function created already carries the tag. One that does not
    // was cast by an older build (or written by hand): stamping it is the only
    // way the module-scoped readers can see it as owned, and it is done HERE,
    // once, rather than reported as a silent hole.
    const moduleId = options.moduleId;
    if (moduleId !== null && moduleTag !== null && !match.tags.includes(moduleTag)) {
      await stampModuleOwnership(match.id, moduleId, moduleTag);
    }
  } else {
    const rival = candidates[0];
    if (rival !== undefined) {
      throw new Error(
        rival.data.creatureRef !== undefined
          ? `cast creature as npc: «${name}» already exists in this scope drawing its stats from a DIFFERENT library creature — drop one of the two instead of casting over it`
          : `cast creature as npc: «${name}» already exists in this scope as an authored NPC — drop one of the two instead of casting over it`,
      );
    }
    const created = await createArtifact(
      {
        campaignId: options.campaignId,
        ...(moduleTag === null ? {} : { tags: [moduleTag] }),
        ...(options.moduleId === null ? {} : { moduleId: options.moduleId }),
        kind: 'npc',
        name,
        ...(prose.summary === undefined ? {} : { summary: prose.summary }),
        ...(prose.body === undefined ? {} : { body: prose.body }),
        data: {
          appearance: prose.appearance ?? '',
          personality: prose.personality ?? '',
          statBlock: null,
          creatureRef: listing.identity.ref,
          ...(options.runId === undefined ? {} : { castByRunId: options.runId }),
        },
        ...(options.writerModel === undefined ? {} : { writerModel: options.writerModel }),
      },
      options.meta ?? { source: 'user' },
    );
    artifactId = created.id;
    status = 'created';
  }

  // Seed the cover from the creature's canonical portrait when one exists —
  // skip-if-imaged, so a portrait the owner set is never overwritten.
  const slot = await getMobPortraitCacheEntry(listing.identity.key);
  if (slot !== undefined) {
    await cloneCachedPortraitToArtifact({
      artifactId,
      campaignId: options.campaignId,
      imageId: slot.imageId,
    });
  }
  return { status, artifactId };
}
