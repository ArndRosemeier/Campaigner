import { db } from '@/db/db';
import { adoptLibraryArtifacts } from '@/db/libraryAdopt';
import { listArtifactsByIds } from '@/db/artifactRepo';
import {
  libraryReferenceIds,
  repointLibraryReferences,
  type LibraryReferenceHolder,
} from '@/domain/libraryAdopt';
import type { ArtifactLink, Id } from '@/domain';

/**
 * THE LIVE WRITE-TIME HALF of library adoption (docs/17 row 257) — the half
 * that makes the owner's rule STRUCTURAL rather than a cleanup.
 *
 * The migration alone can never satisfy *"core items should always ever only be
 * copied"*: the app keeps minting references at write time (the encounter
 * editor's "Link NPC…" picker, the Relations editor, the battle spawn picker),
 * and a start-up retry only runs on a report that already lists work. So a
 * reference to a library artifact must not be BORN: before the editor saves a
 * draft, this adopts every library row the draft cites and hands back the
 * rewritten references, so what is written points at the campaign's own copy —
 * and before a battle is KEYED to a LIBRARY-scoped encounter, it adopts that
 * encounter, so the key names a row the campaign owns (docs/17 row 268).
 *
 * It calls the SAME seam the migration and the retry call (`db/libraryAdopt
 * .adoptLibraryArtifacts`, with `pendingRefs`), so there is no second copy
 * operation — only a second caller. The common case costs TWO READS and no
 * transaction at all: a draft that cites no library row returns an empty map
 * before anything is opened.
 *
 * It is deliberately db-BOUND and therefore separate from `db/libraryAdopt`:
 * that module is imported by the Dexie version definition (`db/db.ts`) and must
 * not touch the `db` singleton. Nothing in the version chain imports this file.
 */

/** The referenced library ids of a holder that are ACTUALLY global rows. */
async function globalReferenceIds(holder: LibraryReferenceHolder): Promise<Id[]> {
  const candidates = [...new Set(libraryReferenceIds(holder))];
  if (candidates.length === 0) return [];
  const rows = await listArtifactsByIds(candidates);
  return rows.filter((row) => row.campaignId === null).map((row) => row.id);
}

/**
 * Adopt a DECLARED SET of library ids into `campaignId` in ONE transaction and
 * answer the global→copy map (a reused copy included).
 *
 * THE ONE live adoption call: the editor's autosave hands it the ids its draft
 * cites, and the battle seed hands it the LIBRARY encounter it is about to key a
 * battle to (docs/17 row 268) — the SAME seam, `reason:'write'`, with the ids
 * adopted BEFORE the reference is born. An empty set opens no transaction.
 */
export async function adoptLibraryIds(
  campaignId: Id,
  ids: readonly Id[],
): Promise<Map<Id, Id>> {
  if (ids.length === 0) return new Map();
  const report = await db.transaction(
    'rw',
    [db.artifacts, db.revisions, db.images, db.campaigns, db.settings, db.battles],
    (tx) => adoptLibraryArtifacts({ tx, reason: 'write', pendingRefs: { campaignId, ids } }),
  );
  return new Map(report.adopted.map((entry) => [entry.globalId, entry.copyId]));
}

/**
 * Adopt every library artifact `holder` cites into `campaignId` and answer the
 * rewritten references — or `null` when the holder cites no library row (the
 * editor then saves its draft unchanged).
 */
export async function adoptDraftLibraryReferences(
  campaignId: Id,
  holder: LibraryReferenceHolder,
): Promise<{ links: ArtifactLink[]; data: unknown } | null> {
  const copies = await adoptLibraryIds(campaignId, await globalReferenceIds(holder));
  if (copies.size === 0) return null;
  return repointLibraryReferences(holder, (id) => copies.get(id));
}
