import { z } from 'zod';

import type { LiveMonsterEntry, MonsterEntry, MonsterSource } from '@/domain/artifact';
import { creatureRefForRulebookSource } from '@/domain/creature';
import { sha256HexSchema } from '@/domain/rulebook';
import {
  creatureCitationName,
  derivedStatOrigin,
  missingRefReason,
  resolveCreatureCitation,
  resolveDerivedNpcStats,
  resolveMonsterEntry,
  type CreatureCitation,
  type MonsterLookups,
  type ResolvedMonster,
} from '@/domain/encounterResolve';

/**
 * THE LEGACY-READ SEAM (docs/17 row 248c) — the ONE module that can read a
 * STORED legacy mob pointer and resolve it.
 *
 * Background. The mob-simplification arc (docs/17 row 248) turns every mob into
 * ONE representation: an authored COPY of the library's stats. A roster entry's
 * `rulebook` / `npc-ref` source and an authored NPC's `creatureRef` are the
 * LEGACY pointer form, and they leave the live model. They cannot simply be
 * deleted, though, because of the owner-forced failure arm: a row the v24
 * migration could NOT convert (its pack was uninstalled at upgrade time) KEEPS
 * its pointer, which is the start-up retry's only handle (`db/mobCopyRetry`,
 * `settings.mobCopyRepair.unconverted`). And `anyArtifactSchema` parses EVERY
 * artifact read (`db/artifactRepo.parseArtifactRow`), so a schema that no longer
 * accepts the legacy shape would make exactly those preserved rows THROW — the
 * failure arm destroying the data it exists to preserve.
 *
 * This module is the resolution: the legacy shape is DECLARED here (composed
 * into the read schema by `domain/artifact`), and the ONE resolution of a stored
 * legacy pointer lives here too. `domain/encounterResolve.resolveMonsterEntry`
 * carries NO legacy arm any more; `db/monsterResolve` dispatches through
 * `resolveStoredMonsterEntry` below, and the v24 migration reads its pointers
 * through `storedRulebookCitation` / `storedNpcCitation`. The legacy read exists
 * ONLY to heal what could not be converted.
 *
 * NOTHING HERE IS A SILENT FALLBACK. A row that is neither the live shape nor a
 * legacy pointer still fails the artifact schema loudly at the read boundary
 * (pinned by test); `resolveStoredMonsterEntry` throws rather than guessing for
 * a caller that hands it a source neither branch understands.
 */

/**
 * The LEGACY roster source arms. `rulebook` is a library creature citation
 * (chunk uuid, then the content-hash fallback); `npc-ref` links an authored NPC
 * artifact. Both are persisted spellings that pre-date the one-representation
 * model and exist here so a stored row still PARSES.
 */
export const LEGACY_NPC_REF_SOURCE_SCHEMA = z.object({
  type: z.literal('npc-ref'),
  artifactId: z.uuid(),
});

export const LEGACY_RULEBOOK_SOURCE_SCHEMA = z.object({
  type: z.literal('rulebook'),
  chunkId: z.uuid(),
  contentHash: sha256HexSchema.optional(),
  creatureName: z.string().optional(),
  bookTitle: z.string().optional(),
});

/** The legacy arms as a tuple, so `domain/artifact` composes them into the ONE
 * read union instead of re-spelling the shapes (a second spelling is the drift
 * this seam exists to prevent). */
export const LEGACY_MONSTER_SOURCE_ARMS = [
  LEGACY_NPC_REF_SOURCE_SCHEMA,
  LEGACY_RULEBOOK_SOURCE_SCHEMA,
] as const;

/** The legacy arms as one schema — the parse half of the seam. */
export const legacyMonsterSourceSchema = z.discriminatedUnion('type', [
  LEGACY_NPC_REF_SOURCE_SCHEMA,
  LEGACY_RULEBOOK_SOURCE_SCHEMA,
]);

export type LegacyMonsterSource = Extract<
  MonsterSource,
  { type: 'npc-ref' } | { type: 'rulebook' }
>;

/**
 * Is this a stored LEGACY pointer? THE one predicate: the identifier strings
 * `'rulebook'` and `'npc-ref'` are spelled in this module and nowhere else in
 * the resolution path (`tests/architecture/one-legacy-mob-read.test.ts`).
 */
export function isLegacyMonsterSource(source: MonsterSource): source is LegacyMonsterSource {
  return source.type === 'rulebook' || source.type === 'npc-ref';
}

/** The four citation fields, read off a RAW (never zod-parsed) stored object.
 * A migration body must survive a row no schema ever validated, so every read
 * is a type check and an unknown field is OMITTED rather than coerced. */
function citationFromRaw(raw: unknown): CreatureCitation {
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    ...(typeof source.chunkId === 'string' ? { chunkId: source.chunkId } : {}),
    ...(typeof source.contentHash === 'string' ? { contentHash: source.contentHash } : {}),
    ...(typeof source.creatureName === 'string' ? { creatureName: source.creatureName } : {}),
    ...(typeof source.bookTitle === 'string' ? { bookTitle: source.bookTitle } : {}),
  };
}

/** A stored `rulebook` source's citation, or `undefined` for any other source.
 * THE one raw read of the roster pointer (the v24 migration's handle). */
export function storedRulebookCitation(source: unknown): CreatureCitation | undefined {
  if (typeof source !== 'object' || source === null) return undefined;
  if ((source as { type?: unknown }).type !== 'rulebook') return undefined;
  return citationFromRaw(source);
}

/** A stored NPC's `creatureRef` citation, or `undefined` when the row carries
 * none (or carries a non-object). THE one raw read of the NPC pointer. */
export function storedNpcCitation(data: unknown): CreatureCitation | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const ref = (data as { creatureRef?: unknown }).creatureRef;
  if (typeof ref !== 'object' || ref === null) return undefined;
  return citationFromRaw(ref);
}

/** The row data with the legacy NPC pointer DROPPED — the ONE place the field
 * name is known for a WRITE, so the migration removes it without spelling it.
 * Every other key is copied through verbatim (the migration's own discipline:
 * a converted row must not lose a field it did not touch). */
export function withoutLegacyNpcPointer(data: Record<string, unknown>): Record<string, unknown> {
  const { creatureRef: _dropped, ...rest } = data;
  return rest;
}

/** The live entry a caller narrowed past `isLegacyMonsterSource`, or `undefined`
 * when the entry is a legacy pointer. The narrowing lives here so a caller never
 * silences the type with a cast. */
export function liveMonsterEntry(entry: MonsterEntry): LiveMonsterEntry | undefined {
  if (isLegacyMonsterSource(entry.source)) return undefined;
  return { ...entry, source: entry.source };
}

/**
 * Resolve a STORED legacy roster entry — the moved bodies of
 * `resolveMonsterEntry`'s `rulebook` and `npc-ref` arms, which used to be the
 * app's only way to read a citation. Kept byte-for-byte in behaviour:
 *
 * - `rulebook`: the ONE library-creature read (`resolveCreatureCitation`), so a
 *   citation and an authored NPC's borrowed stats still cannot answer "which
 *   numbers is this creature?" differently.
 * - `npc-ref`: the linked NPC artifact's own row. A missing artifact is the
 *   named missing-ref reason; a non-npc is its own name; a row that still
 *   carries a `creatureRef` resolves through the ONE derived-stats rule; a
 *   MIGRATED cast row shows its stamped disclosure.
 */
export async function resolveLegacyMonsterEntry(
  entry: MonsterEntry,
  lookups: MonsterLookups,
): Promise<ResolvedMonster> {
  const source = entry.source;
  if (source.type === 'rulebook') {
    const citation = creatureRefForRulebookSource(source);
    return resolveCreatureCitation(
      citation,
      creatureCitationName(citation, entry.name),
      lookups,
    );
  }
  if (source.type !== 'npc-ref') {
    // Unreachable through `resolveStoredMonsterEntry`; a direct caller that got
    // here passed a source the seam does not read, and guessing an answer would
    // be the silent fallback AGENTS rule 1 forbids.
    throw new Error(
      `mob copy legacy read: "${entry.name}" carries neither the live shape nor a legacy pointer — nothing can resolve it`,
    );
  }
  const artifact = await lookups.getArtifact(source.artifactId);
  if (artifact === undefined) {
    // An authored NPC whose row is gone is a real dangling reference — a
    // campaign row the GM can see and restore.
    return { statBlock: null, ...missingRefReason(entry.name) };
  }
  if (artifact.kind !== 'npc') return { statBlock: null, origin: `NPC: ${artifact.name}` };
  const creatureRef = artifact.data.creatureRef;
  if (creatureRef !== undefined) {
    // The Aunt Agatha path (docs/11 D3): her prose, the library creature's
    // stats — ONE rule with the row's own details surface.
    return resolveDerivedNpcStats(artifact.name, creatureRef, lookups);
  }
  // A MIGRATED cast row (docs/17 row 248): the library's numbers were COPIED
  // onto the row and the disclosure line stamped with them.
  const npcStamped = artifact.data.sourceLine?.trim();
  return {
    statBlock: artifact.data.statBlock,
    origin:
      npcStamped === undefined || npcStamped === ''
        ? `NPC: ${artifact.name}`
        : derivedStatOrigin(artifact.name, npcStamped),
  };
}

/**
 * THE dispatch every repo-wired reader uses: a stored legacy pointer goes
 * through this seam, everything else through the LIVE resolver. The live path
 * is narrowed by `liveMonsterEntry`, so `domain/encounterResolve` itself never
 * spells a legacy arm (`tests/architecture/one-legacy-mob-read.test.ts`).
 */
export async function resolveStoredMonsterEntry(
  entry: MonsterEntry,
  lookups: MonsterLookups,
): Promise<ResolvedMonster> {
  if (isLegacyMonsterSource(entry.source)) return resolveLegacyMonsterEntry(entry, lookups);
  const live = liveMonsterEntry(entry);
  if (live === undefined) {
    throw new Error(
      `mob copy legacy read: "${entry.name}" has no readable source — refusing to resolve it silently`,
    );
  }
  return resolveMonsterEntry(live);
}
