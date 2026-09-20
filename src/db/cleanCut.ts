import type { Transaction } from 'dexie';

import type { CleanCutReport } from '@/domain/settings';

/**
 * THE ONE clean-cut purge (docs/17 row 278).
 *
 * The owner's decision, verbatim: *"Make sure that after the changes, old
 * campaigns get cleanly deleted. I think the other settings can survive, right?
 * I just don't want to get stuck in an error state."* So the app keeps its
 * database NAME (`campaigner`) and declares ONE version ABOVE the stored one
 * (`31`), whose upgrade body calls THIS function: every campaign-scoped row is
 * removed in the same versionchange transaction that opens the clean base, and
 * the LIBRARY (`rulebooks`/`chunks`/`embeddings`/`pdfFiles`), the GLOBAL
 * presentation rows (`mobPortraits`, `personas`, `ideaBoards`) and `settings`
 * survive untouched.
 *
 * WHY `version(31)` AND NOT `version(1)`. Dexie only runs a declared version
 * `>= oldVersion`; with a single `version(1)` against a stored 30 `versToRun`
 * is EMPTY (`dexie.js:3816-3818`) and the stored version wins through the
 * VersionError fallback — the app compiles, opens, looks healthy, and purges
 * NOTHING. The number in front of this body is load-bearing.
 *
 * NOTHING HERE IS A SILENT FALLBACK, AND NOTHING IS CAUGHT. The body runs
 * inside the IndexedDB `versionchange` transaction, so a throw aborts the WHOLE
 * transaction atomically: the stored version stays where it was, every row
 * survives, and a reload is a clean retry. A `try`/`catch` here would both
 * swallow a real error (AGENTS rule 1) and let a PARTIAL purge commit — it is
 * forbidden, and the atomicity pin proves the abort.
 *
 * THE TRANSACTION, NEVER THE `db` SINGLETON (docs/18 §2.1): the upgrade body
 * runs before the upgraded `db` instance is usable, so this function takes the
 * Dexie transaction and imports nothing that reaches `@/db/db`. It is exported
 * separately so the idempotence pin can call it directly in an ordinary
 * transaction.
 */

/** The version the clean base declares. MUST stay above the last pre-cut
 * version (30) or Dexie runs nothing (see the module doc). */
export const DECLARED_DB_VERSION = 31;

/** The campaign-scoped stores whose every row goes. */
const CLEARED_STORES = [
  'campaigns',
  'modules',
  'battles',
  'runs',
  'moduleVersions',
  'creatureImages',
] as const;

/** A row read from a table this body does not schema-parse (raw by design). */
type RawRow = Record<string, unknown>;

function isRecord(value: unknown): value is RawRow {
  return typeof value === 'object' && value !== null;
}

/**
 * Is this row CAMPAIGN-SCOPED? `campaignId === null` IS the owner's published
 * LIBRARY (docs/10 M6-C) and is KEPT; a row predating the field (`undefined`)
 * is treated as campaign-scoped — the conservative direction.
 *
 * THE INDEX TRAP: a `campaignId: null` row is INVISIBLE to its own index
 * (IndexedDB keys cannot be `null`), so the read MUST be `toArray()` + filter.
 * `where('campaignId').equals(null)` returns NOTHING and silently keeps every
 * campaign row.
 */
function isCampaignScoped(row: RawRow): boolean {
  return row.campaignId !== null;
}

/**
 * Drop the citation spellings the clean base no longer reads from ONE surviving
 * global artifact, counting every drop. Raw rows only: no schema parse, no
 * domain call — an unconvertible `rulebook` roster source becomes `none` (an
 * existing live arm whose reference says no citation was recorded), and an
 * NPC's `creatureRef` is removed. Returns the rewritten data, or `undefined`
 * when nothing changed.
 */
function normaliseLibraryArtifactData(
  data: unknown,
  tally: { dropped: number },
): RawRow | undefined {
  if (!isRecord(data)) return undefined;
  let changed = false;
  let next: RawRow = data;
  const monsters = data.monsters;
  if (Array.isArray(monsters)) {
    const droppedBefore = tally.dropped;
    const rewritten = monsters.map((entry: unknown) => {
      if (!isRecord(entry)) return entry;
      const source = entry.source;
      if (!isRecord(source) || source.type !== 'rulebook') return entry;
      tally.dropped += 1;
      return { ...entry, source: { type: 'none' } };
    });
    // The count delta is the change flag: an assignment inside the map callback
    // is invisible to TypeScript's flow analysis, so a boolean set there reads
    // as "always false" to the linter.
    if (tally.dropped > droppedBefore) {
      next = { ...next, monsters: rewritten };
      changed = true;
    }
  }
  if ('creatureRef' in next) {
    const { creatureRef: _dropped, ...rest } = next;
    next = rest;
    tally.dropped += 1;
    changed = true;
  }
  return changed ? next : undefined;
}

/**
 * THE fault hook the atomicity pin drives (the `db/mobCopyRepair.setBookReadFault`
 * precedent): a test-only injection point that throws from INSIDE the purge, so
 * the pin can prove the versionchange transaction aborts atomically (stored
 * version unchanged, every row intact). `null` in production — nothing sets it
 * outside tests.
 */
let purgeFault: (() => void) | null = null;

/** Arm/disarm the purge fault hook. TEST-ONLY; production leaves it `null`. */
export function setCleanCutFault(hook: (() => void) | null): void {
  purgeFault = hook;
}

/**
 * Purge every CAMPAIGN-scoped row and normalise the surviving library, inside
 * the caller's transaction. Idempotent: a second run finds nothing to delete
 * and reports all-zero.
 */
export async function purgeLegacyCampaignData({
  tx,
}: {
  tx: Transaction;
}): Promise<CleanCutReport> {
  const cleared: Record<string, number> = {};
  for (const name of CLEARED_STORES) {
    const table = tx.table(name);
    cleared[name] = await table.count();
    await table.clear();
    // The atomicity pin's injection point: a throw here MUST abort the whole
    // versionchange transaction. There is deliberately no `try`/`catch` — see
    // the module doc.
    purgeFault?.();
  }

  const artifacts = tx.table('artifacts');
  const allArtifacts = (await artifacts.toArray()) as RawRow[];
  const doomedArtifacts = allArtifacts.filter(isCampaignScoped);
  await artifacts.bulkDelete(doomedArtifacts.map((row) => row.id as string));

  const images = tx.table('images');
  const allImages = (await images.toArray()) as RawRow[];
  const doomedImages = allImages.filter(isCampaignScoped);
  await images.bulkDelete(doomedImages.map((row) => row.id as string));

  const survivingArtifacts = (await artifacts.toArray()) as RawRow[];
  const survivors = new Set(survivingArtifacts.map((row) => row.id as string));
  const revisions = tx.table('revisions');
  const allRevisions = (await revisions.toArray()) as RawRow[];
  const doomedRevisions = allRevisions.filter((row) => !survivors.has(row.artifactId as string));
  await revisions.bulkDelete(doomedRevisions.map((row) => row.id as string));

  // Normalise the surviving LIBRARY in the SAME transaction (inventory §f.9):
  // a global artifact whose roster still carries an unconvertible `rulebook`
  // citation (or whose NPC data still carries a `creatureRef`) would fail the
  // type fork on read. The count is the instrument that reveals the population.
  const tally = { dropped: 0 };
  for (const row of survivingArtifacts) {
    const nextData = normaliseLibraryArtifactData(row.data, tally);
    if (nextData !== undefined) await artifacts.put({ ...row, data: nextData });
  }

  return {
    campaignsPurged: cleared.campaigns ?? 0,
    modulesPurged: cleared.modules ?? 0,
    battlesPurged: cleared.battles ?? 0,
    runsPurged: cleared.runs ?? 0,
    moduleVersionsPurged: cleared.moduleVersions ?? 0,
    creatureImagesPurged: cleared.creatureImages ?? 0,
    artifactsPurged: doomedArtifacts.length,
    imagesPurged: doomedImages.length,
    revisionsPurged: doomedRevisions.length,
    libraryArtifactsKept: survivingArtifacts.length,
    libraryLegacyCitationsDropped: tally.dropped,
  };
}
