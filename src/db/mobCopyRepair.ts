import type { Transaction } from 'dexie';

import type { Id, Rulebook, RuleChunk } from '@/domain';
import type { MobCopyRepairReport } from '@/domain/settings';
import { libraryCreatureKey } from '@/domain/creature';
import {
  creatureCitationName,
  creatureOriginLabel,
  resolveCreatureChunk,
  type CreatureCitation,
} from '@/domain/encounterResolve';

/**
 * THE one loud, idempotent mob-COPY migration (docs/17 row 248) — the seam
 * that turns a library CITATION into an authored COPY of the library's stats.
 *
 * Background. A mob used to have TWO representations: an authored stat block,
 * or a pointer into the imported library (an encounter roster entry's
 * `rulebook` source, an NPC's `creatureRef`) resolved at read time. Every
 * consumer had to handle both and they drifted. The owner's decision is ONE
 * representation — an authored copy — with the pointer DELETED for every row
 * that converts.
 *
 * THE SOURCE LINE IS THE HARD HALF. The label a reader sees
 * ("Bestiary p.132", or "Bestiary: Owlbear" for a pack book) is NOT stored
 * today: `creatureOriginLabel` composes it AT READ TIME from a live chunk and
 * its book. So the migration resolves and STAMPS it BEFORE the pointer drops —
 * `monsterEntrySchema.sourceLine` / `npcDataSchema.sourceLine` — and preserves
 * the `chunk:<id>` portrait identity as an opaque ORIGIN TOKEN, so no
 * `mobPortraits`/`creatureImages` row needs remapping.
 *
 * THE FAILURE ARM IS THE OWNER'S (docs/17 row 248): CONVERT WHAT RESOLVES, KEEP
 * THE FAILING POINTER AND NAME IT. A mob whose chunk is gone, whose chunk
 * carries no stat block, or whose pack is uninstalled keeps its `rulebook`
 * source / `creatureRef` and is reported BY NAME with the reason, because the
 * startup retry (`db/mobCopyRetry.retryMobCopies`) needs the pointer to heal
 * the row when the pack is installed later. Deleting the pointer and losing the
 * retry was REJECTED; a placeholder or empty stat block is forbidden (AGENTS
 * rule 1). This is the ONE deliberate exception to "the pointer is gone": it
 * survives on exactly the rows that could not be converted, and only until the
 * retry heals them.
 *
 * PER-ROW ISOLATION. The seam names every KNOWN data condition with an explicit
 * `continue`; anything else — a genuinely unexpected throw inside one row's
 * conversion — used to propagate and abort the Dexie upgrade, which means the
 * app does not open (`db.open()` rejects; the transaction rolls back, so there
 * is no data loss, but the owner is locked out until a fix ships). That is the
 * "refuse to open" shape the owner REJECTED for this arc, so ONE bad row is now
 * isolated: the upgrade COMPLETES, the row keeps its pointer (it is the retry's
 * handle either way) and the report NAMES it with the error's own message.
 *
 * THE TENSION THE GUARD MUST NOT FLATTEN. A caught error may be a DATA
 * condition or a CODE DEFECT, and silently swallowing the second is forbidden
 * (AGENTS rule 1 forbids `catch`-and-continue around parsing). So the guard is
 * deliberately NOT a swallow: the entry carries the error's `message` and it is
 * `unexpected: true`, which the ONE report sentence renders in its own register
 * (`domain/mobCopyRepair.formatMobCopyRepair`) so the owner reads the error text
 * rather than a bland "could not be copied". The guard is also unreachable for
 * the conditions the explicit checks already name — those `continue` BEFORE it —
 * so a row reported `unexpected: true` is, by construction, one the seam did not
 * predict.
 *
 * THE TRANSACTION, NEVER THE `db` SINGLETON. Like the v20 citation repair it
 * mirrors, the function takes the Dexie transaction: a `version(N).upgrade`
 * body runs before the upgraded `db` instance is usable, and a nested
 * `db.transaction` there fails. It is exported separately so the idempotency
 * pin can call it directly in an ordinary transaction.
 *
 * IDEMPOTENT: after a successful run no row carries a `rulebook` source or a
 * `creatureRef` any more (the retry writes only on rows the upgrade could not
 * convert), so a second run finds nothing and reports all-zero. The test that
 * runs it twice pins this.
 */

/** The five fields a citation can carry, read from an untyped stored row. */
interface RawCitation {
  chunkId?: unknown;
  contentHash?: unknown;
  creatureName?: unknown;
  bookTitle?: unknown;
}

/** One roster entry as the migration reads it: the two fields it inspects, with
 * `source` possibly absent on a row no schema ever validated. The spread that
 * writes the entry back copies every ORIGINAL key at runtime — this type only
 * narrows what the seam itself reads. */
interface EncounterEntryLike {
  name: string;
  source?: { type?: unknown } & RawCitation;
}

function citationOf(raw: RawCitation): CreatureCitation {
  return {
    ...(typeof raw.chunkId === 'string' ? { chunkId: raw.chunkId } : {}),
    ...(typeof raw.contentHash === 'string' ? { contentHash: raw.contentHash } : {}),
    ...(typeof raw.creatureName === 'string' ? { creatureName: raw.creatureName } : {}),
    ...(typeof raw.bookTitle === 'string' ? { bookTitle: raw.bookTitle } : {}),
  };
}

/** The error text a caught throw carries — the `message` when it has one, the
 * value's own string otherwise. Never a placeholder: a value with neither is
 * described by `String`, and the entry still names the ROW it came from. */
function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string' && error.trim() !== '') return error;
  return String(error);
}

/**
 * THE book-read fault hook (docs/17 row 248's per-row guard).
 *
 * The guard only ever runs when a row throws for a reason the seam did NOT
 * predict, and no hand-written fixture can produce that on demand: the explicit
 * data conditions are checked first, and the remaining conversion is the same
 * pure domain call the happy path uses. So the guard's own pin injects a throw
 * at the ONE read between a resolved chunk and the stamped line — the book
 * lookup — and asserts BOTH that the run COMPLETES and that the report names the
 * row with the error text. Production never sets it (`null`).
 */
let bookReadFault: (() => Error) | null = null;

/** Install (or clear, with `null`) the book-read fault for the guard's pin.
 * Test-only: no production path calls this. */
export function setBookReadFault(fault: (() => Error) | null): void {
  bookReadFault = fault;
}

export interface MobCopyRepairOptions {
  /** The Dexie upgrade transaction (or an ordinary one for the retry/tests). */
  tx: Transaction;
  /**
   * `upgrade` — the v24 version bump: persist the report whenever there was
   * anything to say (conversions OR unresolved rows), the v20 precedent.
   * `retry` — the startup heal: persist ONLY when it actually copied something,
   * so a workspace whose pack is still missing does not re-report on every
   * launch while the unresolved list stays readable for the next retry.
   */
  reason: 'upgrade' | 'retry';
}

export async function repairMobCopies(
  options: MobCopyRepairOptions,
): Promise<MobCopyRepairReport> {
  const artifacts = options.tx.table('artifacts');
  const chunks = options.tx.table<RuleChunk, Id>('chunks');
  const rulebooks = options.tx.table<Rulebook, Id>('rulebooks');
  const settings = options.tx.table('settings');

  const report: MobCopyRepairReport = {
    rosterMobsCopied: 0,
    npcCreaturesCopied: 0,
    unconverted: [],
    notified: false,
  };

  // TX-BACKED lookups for the DOMAIN resolution rule (LOUD UNKNOWN (a)/(c),
  // resolved by measurement in `tests/db/mobCopyRepair.test.ts`): the pure
  // `resolveCreatureChunk` / `creatureOriginLabel` are awaitable inside the
  // upgrade transaction when their lookups are the transaction's own tables —
  // the `db`-bound wrappers are NOT used here, exactly as the recipe requires.
  const lookups = {
    getChunk: (id: Id): Promise<RuleChunk | undefined> => chunks.get(id),
    getChunkByContentHash: (contentHash: string): Promise<RuleChunk | undefined> =>
      chunks.where('contentHash').equals(contentHash).first(),
  };
  const getRulebook = (bookId: Id): Promise<Rulebook | undefined> => {
    if (bookReadFault !== null) return Promise.reject(bookReadFault());
    return rulebooks.get(bookId);
  };
  const all = (await artifacts.toArray()) as unknown[];

  /**
   * THE PER-ROW GUARD. One row's unexpected throw becomes a NAMED unresolved
   * entry and the pass continues — never an aborted upgrade. The row is handed
   * in so the entry names it (`where`), and the error text is preserved so a
   * CODE defect stays diagnosable rather than hidden behind "could not
   * convert".
   */
  const guard = async (
    where: string,
    name: string,
    convert: () => Promise<void>,
  ): Promise<void> => {
    try {
      await convert();
    } catch (error) {
      report.unconverted.push({
        where,
        name,
        reason:
          'the conversion threw an unexpected error — the row was left untouched and keeps its citation: ' +
          errorText(error),
        unexpected: true,
      });
    }
  };

  // ROSTER ARM — an encounter roster entry citing a library creature.
  for (const raw of all) {
    const row = raw as {
      kind?: unknown;
      name?: unknown;
      data?: { monsters?: unknown } | undefined;
    };
    if (row.kind !== 'encounter') continue;
    if (row.data === undefined || !Array.isArray(row.data.monsters)) continue;
    const encounterName = typeof row.name === 'string' ? row.name : 'unnamed encounter';
    const where = `the encounter “${encounterName}”`;
    let changed = false;
    const monsters: unknown[] = [];
    for (const entryRaw of row.data.monsters) {
      const entry = entryRaw as EncounterEntryLike;
      const source = entry.source;
      if (source?.type !== 'rulebook') {
        monsters.push(entryRaw);
        continue;
      }
      const citation = citationOf(source);
      const chunk = await resolveCreatureChunk(citation, lookups);
      if (chunk?.statBlock == null) {
        report.unconverted.push({
          where,
          name: entry.name,
          reason:
            chunk === undefined
              ? 'the cited stat-block chunk is not in this workspace — install the pack that carries it'
              : 'the cited chunk carries no stat block — re-import the book it came from',
          unexpected: false,
        });
        monsters.push(entryRaw);
        continue;
      }
      // The conversion is the part that can throw for a reason the checks above
      // did not name (`creatureOriginLabel`'s book read, a malformed stored
      // row). Isolated PER ENTRY, so one bad mob does not cost the encounter's
      // other entries and the entry's ORIGINAL bytes are what the catch keeps.
      let converted: Record<string, unknown> | undefined;
      await guard(where, typeof entry.name === 'string' ? entry.name : 'unnamed mob', async () => {
        const sourceLine = await creatureOriginLabel(
          chunk,
          creatureCitationName(citation, entry.name),
          { getRulebook },
        );
        converted = {
          ...entry,
          source: { type: 'inline', statBlock: chunk.statBlock },
          sourceLine,
          originToken: libraryCreatureKey(chunk.id),
        };
      });
      if (converted === undefined) {
        monsters.push(entryRaw);
        continue;
      }
      report.rosterMobsCopied += 1;
      changed = true;
      monsters.push(converted);
    }
    if (!changed) continue;
    // The ROW write is guarded too: a row whose `data` cannot be rewritten must
    // not take the whole upgrade down with it.
    await guard(where, encounterName, async () => {
      await artifacts.put({ ...(row as Record<string, unknown>), data: { ...row.data, monsters } });
    });
  }

  // NPC ARM — an authored NPC whose stats were borrowed from a library
  // creature. The row is rewritten to hold the copies; its `creatureRef` (and
  // therefore the mutual-exclusion refine) is gone.
  for (const raw of all) {
    const row = raw as {
      kind?: unknown;
      name?: unknown;
      data?: Record<string, unknown> | undefined;
    };
    if (row.kind !== 'npc') continue;
    const data = row.data;
    const rawRef = data?.creatureRef;
    if (data === undefined || typeof rawRef !== 'object' || rawRef === null) continue;
    const npcName = typeof row.name === 'string' ? row.name : 'unnamed npc';
    const where = 'an authored NPC';
    const citation = citationOf(rawRef);
    if (citation.chunkId === undefined && citation.contentHash === undefined) {
      report.unconverted.push({
        where,
        name: npcName,
        reason:
          'its creature citation carries neither a chunk id nor a content hash — nothing can be copied',
        unexpected: false,
      });
      continue;
    }
    const chunk = await resolveCreatureChunk(citation, lookups);
    if (chunk?.statBlock == null) {
      report.unconverted.push({
        where,
        name: npcName,
        reason:
          chunk === undefined
            ? 'the cited stat-block chunk is not in this workspace — install the pack that carries it'
            : 'the cited chunk carries no stat block — re-import the book it came from',
        unexpected: false,
      });
      continue;
    }
    await guard(where, npcName, async () => {
      const sourceLine = await creatureOriginLabel(
        chunk,
        creatureCitationName(citation, npcName),
        { getRulebook },
      );
      // `creatureRef` is dropped, never left beside the copied block: the schema
      // refine forbids the pair, and a second reader of the pointer would be the
      // fragmentation this arc removes.
      const { creatureRef: _dropped, ...rest } = data;
      await artifacts.put({
        ...(row as Record<string, unknown>),
        data: { ...rest, statBlock: chunk.statBlock, sourceLine },
      });
      report.npcCreaturesCopied += 1;
    });
  }

  const converted = report.rosterMobsCopied + report.npcCreaturesCopied;
  const shouldPersist =
    options.reason === 'upgrade' ? converted > 0 || report.unconverted.length > 0 : converted > 0;
  if (!shouldPersist) return report;
  const existing = (await settings.get('settings')) as Record<string, unknown> | undefined;
  if (existing === undefined) {
    // No settings row and yet there was something to say means the report has
    // nowhere to be READ. Losing it would be the silent-repair shape AGENTS
    // rule 1 forbids, so the transaction fails loudly instead (the v20
    // precedent): an unreportable migration is worse than no migration.
    throw new Error(
      'mob copy repair: this workspace has mobs to copy but no settings row to report the outcome in — refusing to migrate silently',
    );
  }
  await settings.put({
    ...existing,
    id: 'settings',
    mobCopyRepair: { ...report, notified: false },
    updatedAt: Date.now(),
  });
  return report;
}
