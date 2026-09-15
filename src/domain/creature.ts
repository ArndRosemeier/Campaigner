import type { AnyArtifact, MonsterEntry, MonsterSource, NpcArtifact } from '@/domain/artifact';
import { z } from 'zod';

import { comparableName } from '@/domain/artifactAlias';
import { sha256HexSchema } from '@/domain/rulebook';

/**
 * Creature identity (owner-ratified core-mob arc, docs/11 D5 amendment /
 * docs/18 §2).
 *
 * A creature is NOT an artifact. A bestiary creature lives in the library
 * tier (read-only `chunks`, docs/12) and is addressed by IDENTITY, never by a
 * row this app owns. This module is the ONE spelling of that identity and of
 * the portrait key derived from it — every consumer (the resolver, the
 * portrait cache, the queue, the battle board, the wiki graph) reads it here
 * and re-derives nothing.
 *
 * Why identity and not an id (the incident this arc closes, docs/17 row 106):
 * a creature used to be represented by a hidden `npc` artifact carrying
 * `data.monsterChunkId`. Adopting and then deleting two such rows left two
 * encounter roster entries on a permanent `missing ref`. Nothing about a
 * creature citation names a campaign row any more, so no campaign deletion
 * can break one (docs/11 D9).
 */

/**
 * A pointer to a library creature. `chunkId` is the cited stat-block chunk;
 * `contentHash` is the same chunk's SHA-256 at citation birth, the fallback
 * that survives a re-ingest under a new row id. `creatureName` is the
 * creature's own name (the chunk's innermost heading), where one is known —
 * display and prompt grounding only, never a resolution key. `bookTitle` is
 * the book the chunk came from, stamped at citation birth (docs/17 row 155):
 * also display-only, and what a report of a STRANDED citation names as the
 * pack to install (`domain/encounterResolve.contentIdentityFor`).
 */
export const creatureRefSchema = z.object({
  chunkId: z.uuid().optional(),
  contentHash: sha256HexSchema.optional(),
  creatureName: z.string().optional(),
  bookTitle: z.string().optional(),
});

export type CreatureRef = z.infer<typeof creatureRefSchema>;

/** True when a ref carries nothing a library read could use — a dead pointer,
 * never something to resolve silently to nothing (AGENTS rule 1). */
export function creatureRefIsEmpty(ref: CreatureRef): boolean {
  return ref.chunkId === undefined && ref.contentHash === undefined;
}

/**
 * ONE creature identity, tagged by where it was derived from. The tag is
 * CACHE IDENTITY, never a resolution rule (docs/17 row 96: one walk, one
 * rule): a citation that resolves through the content-hash fallback lands on
 * the SAME key as a citation that used the chunk uuid, because
 * `creatureIdentityForCitation` composes the uuid key at citation birth and
 * the fallback reproduces it from the resolved row's own id.
 */
export type CreatureIdentity =
  | { kind: 'library'; key: string; ref: CreatureRef }
  | { kind: 'content'; key: string; ref: CreatureRef };

/**
 * A LIBRARY CREATURE a wiki-link name may resolve to (docs/11 D10): a DERIVED
 * node — computed from the bestiary chunk, never a database row and never an
 * artifact. Lives here (the identity layer) because the identity IS the chunk;
 * `lib/wikilinks` resolves against it and `db/creatureRepo` builds the pool.
 */
export interface WikiLinkCreature {
  /** The creature's identity: its stat-block chunk. */
  chunkId: string;
  /** The library's own spelling of the creature's name. */
  name: string;
}

/**
 * Is this NPC a CAST CREATURE — an authored NPC that carries a library
 * creature's stats (`domain/artifact`'s `npcDataSchema.creatureRef`)? The ONE
 * classification of "this npc stands for a library creature", used where a
 * surface must not silently take such an NPC over (a rename would sever the
 * citation), and nowhere else. There is deliberately no counterpart for
 * "is this a creature ROW": under the ratified model no such row exists
 * (docs/11 D1/D8), so a caller that asks the question has the wrong model.
 */
export function isCastCreatureNpc(artifact: AnyArtifact | NpcArtifact): boolean {
  return artifact.kind === 'npc' && artifact.data.creatureRef !== undefined;
}

/**
 * How a CAST CREATURE NPC is named in user-facing copy: the house «Name»
 * quoting convention plus the fact that the row is a creature's. ONE spelling,
 * so every refusal and toast about such a row reads the same.
 */
export function castCreatureLabel(name: string): string {
  return `the cast creature «${name}»`;
}

/**
 * The ONE refusal sentence for a write that would take a CAST CREATURE NPC
 * over. Shared by the entity batch's name-alignment and the generation routes'
 * destination checks, so the reason a run stopped is worded identically
 * wherever it is read — and it names the remedy, because the writer is a person
 * looking at a toast.
 */
export function castCreatureWriteRefusal(artifactName: string, wouldBeName: string): string {
  return `${castCreatureLabel(artifactName)} is this campaign's own npc for a library creature — its stats are derived from that creature and its name is the citation's. Renaming or overwriting it as «${wouldBeName}» would stop every encounter and battle that cites the creature from finding it. Edit its prose instead, or make a separate npc of that name.`;
}

/** The `creatureRef` an NPC carries, or undefined — the ONE read of the field
 * (callers never reach into `data` for it). */
export function npcCreatureRef(artifact: AnyArtifact | NpcArtifact): CreatureRef | undefined {
  return artifact.kind === 'npc' ? artifact.data.creatureRef : undefined;
}

/** The ONE portrait key for a library creature: its cited chunk. */
export function libraryCreatureKey(chunkId: string): string {
  return `chunk:${chunkId}`;
}

/**
 * The ONE portrait key for a creature with NO library row behind it — an
 * encounter-invented mob (an inline stat block or a name-only roster entry,
 * docs/11 D5) or any other creature the bestiary does not carry. Derived from
 * the creature's CONTENT (its name plus its stat block), so:
 *
 * - two encounters inventing the same thing share one portrait (one creature,
 *   one look — docs/11 D6);
 * - the key can never collide with a library key, and there is no id in it
 *   that anything could cite, so nothing can be deleted out from under it;
 * - nothing is ever written to the database to hold it — the key IS the
 *   identity.
 *
 * `JSON.stringify` over a fixed key order is the hashing discipline (the same
 * one `encounterShapeKey`-class helpers use): `undefined` and `null` collapse
 * so an absent stat block and a null one agree.
 *
 * KEY SPACE `CREATURE_CONTENT_IDENTITY_KEY` (docs/17 rows 167 and 168) — and the
 * ONE key space on this list whose key is PERSISTED: it is written onto battle
 * tokens and it is a Dexie INDEX value (`mobPortraits: 'id, &creatureKey'`,
 * `creatureImages: '[campaignId+creatureKey]'`), so the STRING is an existing
 * identity rather than a per-call memo. Its name half is therefore the
 * comparable form (`comparableName`, docs/18 §2.1 — NFC + trim + case-fold),
 * the owner-ratified fold of docs/17 row 168: a Mac-authored (decomposed)
 * spelling and a precomposed one are ONE creature, so they share one portrait
 * slot ("one creature, one look", docs/11 D6). Because the bytes are an
 * EXISTING identity, the fold ships with a Dexie upgrade (version 22 in
 * `src/db/db.ts`) that re-keys stored rows, and `foldCreatureKey` below is the
 * seam that migrates and imports a pre-fold key. The source scan in
 * `tests/domain/name-key-spaces.test.ts` holds this spelling in place.
 */
export function contentCreatureKey(name: string, statBlock: unknown): string {
  const folded = comparableName(name);
  if (folded === '') {
    throw new Error('creature identity: a creature with no name has no content identity');
  }
  return `content:${JSON.stringify([folded, statBlock ?? null])}`;
}

/**
 * Fold an ALREADY-PERSISTED creature key through the comparable form — the
 * migration/import seam beside the mint (docs/17 row 168), and the ONE way
 * pre-fold bytes become current bytes.
 *
 * A `content:` key carries a `[name, statBlock]` pair JSON-stringified exactly
 * as `contentCreatureKey` minted it; this parses that pair, folds element 0
 * through `comparableName`, and rebuilds the key byte-for-byte otherwise. Every
 * other key space — `chunk:` (a library creature's cited row), `artifact:` (an
 * authored row's own cover) and anything unrecognised — is returned UNCHANGED:
 * those keys are ids, not names, and no composition relation exists in them.
 *
 * A `content:` key that does not parse as a `[string, unknown]` pair THROWS,
 * never returns itself silently: silently keeping it would leave a legacy
 * spelling in the schema AFTER the migration was declared to have removed it,
 * which is exactly the silent-loss shape AGENTS rule 1 forbids. The migration
 * that calls this fails loudly with the offending key named.
 *
 * HONEST LIMIT (docs/17 row 168): a stored key's name half was already
 * lowercased when it was minted (`name.trim().toLowerCase()`, the pre-fold
 * mint), so this folds `lowercase(name)`. That equals the new mint — which
 * folds `NFC(name)` then lowercases — for every name whose lowercase commutes
 * with NFC composition, which is every realistic name. A name whose lowercase
 * does NOT commute (none is known in practice) would fold to a different key
 * than the mint produces. This is the whole reason the migration is a no-op for
 * typical data, and it is the limit of what the upgrade can promise.
 */
export function foldCreatureKey(key: string): string {
  if (!key.startsWith('content:')) return key;
  let parsed: unknown;
  try {
    parsed = JSON.parse(key.slice('content:'.length));
  } catch {
    throw new Error(`creature identity: cannot fold a content: key that is not JSON — ${key}`);
  }
  if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string') {
    throw new Error(
      `creature identity: cannot fold a content: key that is not a [name, statBlock] pair — ${key}`,
    );
  }
  const storedName = parsed[0];
  return `content:${JSON.stringify([comparableName(storedName), parsed[1]])}`;
}

/**
 * The identity of a LIBRARY CITATION, resolved against the library read that
 * satisfied it. `citation` is the citation as written; `resolvedChunkId` is
 * the chunk row that actually answered it (the cited uuid, or the row the
 * content-hash fallback found). The key always follows the resolved row, so a
 * citation healed by the fallback shares the portrait of every citation that
 * cites the row directly.
 */
export function creatureIdentityForCitation(
  citation: CreatureRef,
  resolvedChunkId: string,
): CreatureIdentity {
  return {
    kind: 'library',
    key: libraryCreatureKey(resolvedChunkId),
    ref: { ...citation, chunkId: resolvedChunkId },
  };
}

/**
 * The identity of a creature with no library row: its content. Used by the
 * encounter's invented-mob portraits (docs/11 D5) — never by a citation,
 * because a citation's identity is always the library row it points at.
 */
export function contentCreatureIdentity(name: string, statBlock: unknown): CreatureIdentity {
  return {
    kind: 'content',
    key: contentCreatureKey(name, statBlock),
    ref: {},
  };
}

/**
 * The library citation a roster row's own `rulebook` source spells — the ONE
 * conversion, so the roster's citation shape and the authored NPC's
 * `creatureRef` shape cannot drift apart (they are the same four fields, and
 * this is where that is written down).
 */
export function creatureRefForRulebookSource(
  source: Extract<MonsterSource, { type: 'rulebook' }>,
): CreatureRef {
  return {
    chunkId: source.chunkId,
    ...(source.contentHash === undefined ? {} : { contentHash: source.contentHash }),
    ...(source.creatureName === undefined ? {} : { creatureName: source.creatureName }),
    ...(source.bookTitle === undefined ? {} : { bookTitle: source.bookTitle }),
  };
}

/**
 * THE creature identity of one encounter ROSTER ENTRY (docs/11 D5 amendment /
 * D6) — ONE rule for every shape a roster row can take, whether or not its
 * numbers resolved:
 *
 * - `rulebook` (a library CITATION, docs/11 D1/D5): the identity is the chunk
 *   the roster row cites;
 * - `npc-ref` to an AUTHORED NPC carrying a `creatureRef` (the cast creature,
 *   docs/11 D3/D4): the identity is the creature that row BORROWS its numbers
 *   from — the ref's own chunk, or the row's name when the ref names no chunk
 *   (a stranded citation has no library id to key on);
 * - `npc-ref` to a hand-authored NPC, or to a row that is not there: NO
 *   creature identity — the portrait belongs to that artifact's own cover;
 * - `inline` / `none` (an uncited, invented mob): the identity is the entry's
 *   OWN content — its name plus the stat block the roster row itself carries.
 *
 * WHY one function and not a rule per caller (docs/17 row 165): the creature
 * identity IS the key of the campaign's presentation row (`db/creatureImages`),
 * the global canonical slot (`db/mobPortraitCache`) and every battle token
 * (`BattleToken.creatureKey`). While seeding, the portrait batch, the module
 * gap detector and the board each derived it for themselves, one shape at a
 * time, a citation the library healed by its content hash got two identities —
 * the token's row and the portrait's row were different creatures as far as the
 * app was concerned. There is now one spelling, so the token, the presentation
 * row, the cache and the predicate agree BY CONSTRUCTION.
 *
 * The `statBlock` an invented entry keys on is the one ON THE ROW, never the
 * one a resolver handed back: the roster row is what every surface reads, and
 * a key derived from a re-parsed block would drift the moment the read path
 * changed. `null` for `none` is the same rule — a name-only mob has no block
 * and never gains one from a lookup.
 */
export function rosterEntryCreatureIdentity(
  entry: MonsterEntry,
  linked: AnyArtifact | undefined,
): CreatureIdentity | null {
  const source = entry.source;
  if (source.type === 'rulebook') {
    const citation = creatureRefForRulebookSource(source);
    return creatureIdentityForCitation(citation, source.chunkId);
  }
  if (source.type === 'npc-ref') {
    if (linked?.kind !== 'npc') return null;
    const ref = npcCreatureRef(linked);
    if (ref === undefined) return null;
    return ref.chunkId === undefined
      ? contentCreatureIdentity(linked.name, undefined)
      : creatureIdentityForCitation(ref, ref.chunkId);
  }
  return contentCreatureIdentity(entry.name, source.type === 'inline' ? source.statBlock : null);
}
