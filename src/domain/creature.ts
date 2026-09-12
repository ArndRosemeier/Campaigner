import type { AnyArtifact, NpcArtifact } from '@/domain/artifact';
import { z } from 'zod';

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
 * display and prompt grounding only, never a resolution key.
 */
export const creatureRefSchema = z.object({
  chunkId: z.uuid().optional(),
  contentHash: sha256HexSchema.optional(),
  creatureName: z.string().optional(),
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
 */
export function contentCreatureKey(name: string, statBlock: unknown): string {
  const trimmed = name.trim().toLowerCase();
  if (trimmed === '') {
    throw new Error('creature identity: a creature with no name has no content identity');
  }
  return `content:${JSON.stringify([trimmed, statBlock ?? null])}`;
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
