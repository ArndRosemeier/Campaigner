import type { Transaction } from 'dexie';

import {
  artifactRevisionRow,
  globalArtifactSchema,
  stampNewEntity,
  type AnyArtifact,
  type Artifact,
  type GlobalArtifact,
  type Id,
  type LibraryAdoptReport,
  type StoredImage,
} from '@/domain';
import {
  NOT_GLOBAL_ARTIFACT_REASON,
  adoptedArtifactRow,
  battleLibraryReferenceIds,
  danglingBattleTokens,
  libraryReferenceIds,
  repointArtifactRow,
  repointBattleRow,
  type LibraryBattleRefs,
  type PendingLibraryReferences,
} from '@/domain/libraryAdopt';
import { errorMessage } from '@/lib/errors';

/**
 * THE ONE live, transaction-taking library-ADOPTION seam (docs/17 row 257) —
 * the IO half of `domain/libraryAdopt`'s pure COPY + REPOINT.
 *
 * WHAT IT DOES, for every campaign in the database: find the artifact rows
 * whose references still point at a GLOBAL library artifact (a roster `npc-ref`
 * target, a `links[].targetId`) AND the BATTLE rows whose tokens still do (the
 * board list, the stage snapshot and a derived seed row's id — docs/17 row
 * 259), COPY each referenced library row into that campaign with a fresh id,
 * CLONED images and a stored origin (`copiedFromArtifactId`), and REWRITE the
 * references to point at the copy — all in the caller's transaction, so a
 * reference is never left without its target.
 *
 * WHY IT TAKES A TRANSACTION AND IMPORTS NO `db`. The v26 upgrade body runs
 * before the upgraded `db` instance is usable, and a nested `db.transaction`
 * there fails (the v20/v24 precedent). This module therefore reaches every
 * table through `options.tx.table(...)`, exactly as `db/mobCopyRepair` does,
 * which is what lets the migration, the startup retry and the idempotency pin
 * call literally the same operation.
 *
 * IDEMPOTENT, keyed on the STORED ORIGIN, never on names or bytes. A campaign
 * that already adopted a library row REUSES its existing copy (a second pass
 * makes no new row), and a row whose references already point at a copy is left
 * byte-identical (`repointArtifactRow`/`repointBattleRow` answer `null`), so a
 * second run writes nothing and reports all-zero.
 *
 * THE FAILURE ARM IS LOUD AND NON-DESTRUCTIVE. A reference whose library row is
 * GONE is never collected and therefore never touched: the existing missing-ref
 * surfaces stay in charge (the export manifest's `status:'missing'`, the
 * roster's named reason, the relation's red line), because adoption cannot
 * invent bytes and pointing at a placeholder is forbidden (AGENTS rule 1). A
 * row that throws for a reason the seam did not predict is isolated PER ROW and
 * named with the error text (`unexpected: true`), never a silently aborted
 * upgrade. THE BATTLE TOKENS ARE THE ONE ARM THAT HAD NO LOUD SURFACE OF ITS
 * OWN (docs/17 row 259): a token whose artifact is gone shows nothing on the
 * card with no named reason, and deleting a SHARED library row scrubs no
 * campaign's tokens, so this seam NAMES each such token in `unresolved` rather
 * than leaving the silence the previous writer flagged.
 */

export interface LibraryAdoptOptions {
  /** The Dexie upgrade transaction (or an ordinary one for the retry/tests). */
  tx: Transaction;
  /**
   * `upgrade` — a Dexie version bump (v26 for the artifact holders, v27 for the
   * battle rows): persist the report whenever there was anything to say (copies
   * OR unresolved references).
   * `retry` — the startup heal: persist ONLY when it actually copied or
   * repointed something, so a workspace whose library row is still missing does
   * not re-report on every launch while the unresolved list stays readable.
   * `write` — the live write path (`db/libraryAdoptLive`): NEVER persists. The
   * adoption there is a consequence of the owner's own edit, not a migration to
   * announce.
   */
  reason: 'upgrade' | 'retry' | 'write';
  /**
   * Library ids a write path is ABOUT TO reference (docs/17 row 257). They are
   * adopted in the same pass and reported on `adopted`, so the caller can point
   * its new reference at the copy instead of the library. The idempotence rule
   * is unchanged: a campaign that already owns the copy reuses it.
   */
  pendingRefs?: PendingLibraryReferences;
}

/** The library ids a row's family-E references point at, filtered to the ids
 * that actually ARE global rows in this transaction. A gone id is therefore
 * never mistaken for a global one and its reference is left untouched. */
function globalRefsOf(row: AnyArtifact, globals: ReadonlyMap<Id, unknown>): Id[] {
  return libraryReferenceIds(row).filter((id) => globals.has(id));
}

/** The stored battle row's reference-bearing fields, as this seam reads them.
 * Nothing is parsed: a legacy row may predate any field, and the upgrade path
 * must not throw on it. `campaignId` is what groups the pass; the rest is the
 * battle holder `domain/libraryAdopt` owns. */
interface StoredBattleRefs extends LibraryBattleRefs {
  campaignId?: unknown;
  encounterArtifactId?: unknown;
}

export async function adoptLibraryArtifacts(
  options: LibraryAdoptOptions,
): Promise<LibraryAdoptReport> {
  const artifacts = options.tx.table('artifacts');
  const revisions = options.tx.table('revisions');
  const images = options.tx.table('images');
  const campaigns = options.tx.table('campaigns');
  const settings = options.tx.table('settings');
  const battles = options.tx.table('battles');

  const report: LibraryAdoptReport = {
    adopted: [],
    repointed: 0,
    unresolved: [],
    notified: false,
  };

  const rows = (await artifacts.toArray()) as AnyArtifact[];
  const rowsById = new Map<Id, AnyArtifact>(rows.map((row) => [row.id, row]));
  const globals = new Map<Id, unknown>();
  const byCampaign = new Map<Id, Artifact[]>();
  for (const row of rows) {
    const campaignId = row.campaignId;
    if (campaignId === null) {
      globals.set(row.id, row);
      continue;
    }
    const list = byCampaign.get(campaignId) ?? [];
    // `campaignId` is a non-null string here, so the row is an owned artifact
    // row (the null anchor is the ONLY global marker) and TS narrows it.
    list.push(row);
    byCampaign.set(campaignId, list);
  }
  // THE BATTLE HOLDERS (docs/17 row 259): a battle row's tokens cite artifacts
  // exactly as an artifact row's `links`/roster do, and they are grouped by the
  // same `campaignId` anchor.
  const battleRows = (await battles.toArray()) as StoredBattleRefs[];
  const battlesByCampaign = new Map<Id, StoredBattleRefs[]>();
  for (const row of battleRows) {
    const campaignId = row.campaignId;
    if (typeof campaignId !== 'string') continue;
    const list = battlesByCampaign.get(campaignId) ?? [];
    list.push(row);
    battlesByCampaign.set(campaignId, list);
  }
  // Deterministic order: the report and the ids minted must not depend on
  // IndexedDB's internal row order. A pending write path's campaign joins the
  // pass even when it owns no rows yet.
  const pendingCampaignId = options.pendingRefs?.campaignId;
  const campaignIds = [
    ...new Set([
      ...byCampaign.keys(),
      ...battlesByCampaign.keys(),
      ...(pendingCampaignId === undefined ? [] : [pendingCampaignId]),
    ]),
  ].sort();

  /** Every campaign row that carries an adoption origin, for idempotence. */
  const existingCopies = (campaignRows: readonly AnyArtifact[]): Map<Id, Artifact> => {
    const found = new Map<Id, Artifact>();
    for (const row of campaignRows) {
      const origin = row.copiedFromArtifactId;
      if (typeof origin === 'string' && !found.has(origin)) found.set(origin, row as Artifact);
    }
    return found;
  };

  /** How the report names one battle: its seeding encounter when that row still
   * exists, else the id — never a bare "a battle". */
  const battleWhere = (battle: StoredBattleRefs): string => {
    const encounterId = battle.encounterArtifactId;
    if (typeof encounterId !== 'string') return 'a battle with no seeding encounter';
    const encounter = rowsById.get(encounterId);
    return encounter === undefined
      ? `the battle whose seeding encounter ${encounterId} is gone`
      : `the battle for encounter “${encounter.name}”`;
  };

  for (const campaignId of campaignIds) {
    const campaignRows = byCampaign.get(campaignId) ?? [];
    const campaignBattles = battlesByCampaign.get(campaignId) ?? [];
    const campaignRow = (await campaigns.get(campaignId)) as { name?: unknown } | undefined;
    const campaignName =
      typeof campaignRow?.name === 'string' ? campaignRow.name : `campaign ${campaignId}`;
    const reportWhere = `campaign “${campaignName}”`;
    const completed = existingCopies(campaignRows);

    const copies = new Map<Id, Id>();
    const created: Artifact[] = [];

    /**
     * THE COPY HALF, for one referenced library row. Answers the campaign copy
     * (existing or fresh), or `undefined` when no copy could be made — in which
     * case the reference is LEFT INTACT and the reason is named.
     */
    const copyGlobal = async (
      globalId: Id,
    ): Promise<{ copy: Artifact; reused: boolean } | undefined> => {
      const existing = completed.get(globalId);
      if (existing !== undefined) {
        copies.set(globalId, existing.id);
        report.adopted.push({
          globalId,
          copyId: existing.id,
          name: existing.name,
          kind: existing.kind,
          reused: true,
        });
        return { copy: existing, reused: true };
      }
      const parsed = globalArtifactSchema.safeParse(globals.get(globalId));
      if (!parsed.success) {
        report.unresolved.push({
          where: reportWhere,
          name: globalId,
          reason: NOT_GLOBAL_ARTIFACT_REASON,
          unexpected: false,
        });
        return undefined;
      }
      const source: GlobalArtifact = parsed.data;
      const now = Date.now();
      // IMAGES ARE CLONED, NEVER SHARED. Reusing a library `imageId` would make
      // the campaign export re-scope the LIBRARY's blob to the importing
      // campaign (`lib/exportImport` writes image rows with their original id
      // and the new campaignId), i.e. silently steal the shared art. The bytes
      // are copied, the ROLE is preserved (a library location's `map` cover must
      // stay a map or `battleSeed.resolveMapImageId` stops finding the board).
      const imageMapping = new Map<Id, Id>();
      const missingImages: Id[] = [];
      const sourceImageIds = [
        ...new Set([
          ...source.imageIds,
          ...(source.coverImageId === null ? [] : [source.coverImageId]),
        ]),
      ];
      for (const imageId of sourceImageIds) {
        const image = (await images.get(imageId)) as StoredImage | undefined;
        if (image === undefined) {
          missingImages.push(imageId);
          continue;
        }
        const clone: StoredImage = {
          ...stampNewEntity(now),
          campaignId,
          bytes: new Uint8Array(image.bytes),
          mimeType: image.mimeType,
          width: image.width,
          height: image.height,
          prompt: image.prompt,
          model: image.model,
          source: image.source,
          role: image.role,
        };
        await images.put(clone);
        imageMapping.set(imageId, clone.id);
      }
      if (missingImages.length > 0) {
        report.unresolved.push({
          where: `the library entry “${source.name}”`,
          name: source.name,
          reason: `its artwork is gone from the library (${String(missingImages.length)} image row(s) missing) — the copy was made without it`,
          unexpected: false,
        });
      }
      const copy = adoptedArtifactRow(
        source,
        campaignId,
        {
          imageIds: source.imageIds
            .map((id) => imageMapping.get(id))
            .filter((id): id is Id => id !== undefined),
          coverImageId:
            source.coverImageId === null ? null : (imageMapping.get(source.coverImageId) ?? null),
        },
        now,
      );
      await artifacts.put(copy);
      await revisions.put(artifactRevisionRow(copy, 'user', null));
      report.adopted.push({
        globalId,
        copyId: copy.id,
        name: copy.name,
        kind: copy.kind,
        reused: false,
      });
      return { copy, reused: false };
    };

    /**
     * THE DISCOVERY + COPY PASS. The queue starts at the campaign's own rows and
     * GROWS with each copy, so a copied artifact's own library references are
     * adopted in the same pass rather than left as fresh family-E references.
     * A library id is decided at most once per campaign.
     *
     * ONE copy path for every caller: the pending write path's ids, the BATTLE
     * tokens' ids (docs/17 row 259) and every artifact row's references all go
     * through `adoptOne`, so a fourth source can never grow a fourth copy
     * mechanism (or a fourth copy of the failure arm).
     */
    const queue: AnyArtifact[] = [...campaignRows];
    const decided = new Set<Id>();

    const adoptOne = async (globalId: Id): Promise<void> => {
      if (decided.has(globalId)) return;
      decided.add(globalId);
      let adopted: { copy: Artifact; reused: boolean } | undefined;
      try {
        adopted = await copyGlobal(globalId);
      } catch (error) {
        report.unresolved.push({
          where: reportWhere,
          name: globalId,
          reason: `copying the library entry threw an unexpected error: ${errorMessage(error)}`,
          unexpected: true,
        });
        return;
      }
      if (adopted === undefined) return;
      copies.set(globalId, adopted.copy.id);
      // A REUSED copy is already one of `campaignRows`, so it is already in the
      // queue and in the repoint set — pushing it again would repoint (and
      // re-revision) the same row twice with the same stale in-memory object.
      if (adopted.reused) return;
      created.push(adopted.copy);
      queue.push(adopted.copy);
    };

    /**
     * THE PENDING WRITE PATH'S IDS (docs/17 row 257): a reference the editor is
     * about to save. They take the SAME copy path, decided first so the caller's
     * ids always reach `report.adopted` (a reused copy included).
     */
    if (pendingCampaignId === campaignId && options.pendingRefs !== undefined) {
      for (const globalId of options.pendingRefs.ids) await adoptOne(globalId);
    }

    /**
     * THE BATTLE HOLDERS (docs/17 row 259): every library id a battle's tokens
     * cite — the board list AND its stage snapshot — enters the SAME pass, so the
     * battle's copy and its repoint land in this one transaction. The frozen
     * `seedFighters` handles are not collected here (they are not references);
     * `repointBattleRow` remaps the one that is a repointed artifact id.
     */
    for (const battle of campaignBattles) {
      for (const globalId of battleLibraryReferenceIds(battle)) {
        if (globals.has(globalId)) await adoptOne(globalId);
      }
    }

    while (queue.length > 0) {
      const row = queue.shift();
      if (row === undefined) break;
      for (const globalId of globalRefsOf(row, globals)) await adoptOne(globalId);
    }

    /**
     * THE REPOINT PASS — the declared holder set, one rewrite per row. It runs
     * AFTER every copy exists and inside the SAME transaction, so no reference
     * is ever left pointing at a row that was just removed from its reach. The
     * created copies are included: a copy's own `links`/roster entries are
     * family-E references too.
     */
    const resolve = (id: Id): Id | undefined => copies.get(id);
    for (const row of [...campaignRows, ...created]) {
      let next: Artifact | null;
      try {
        next = repointArtifactRow(row, resolve);
      } catch (error) {
        report.unresolved.push({
          where: reportWhere,
          name: row.name,
          reason: `repointing its library references threw an unexpected error: ${errorMessage(error)}`,
          unexpected: true,
        });
        continue;
      }
      if (next === null) continue;
      await artifacts.put(next);
      await revisions.put(artifactRevisionRow(next, 'user', null));
      report.repointed += 1;
    }

    /**
     * THE BATTLE REPOINT (docs/17 row 259) — the same operation at the
     * `db.battles` address, in the SAME transaction as the copy. The dangling
     * arm is computed from the rows as they arrived (before repointing): a
     * token that already points at a copy is a known artifact, so it is not
     * reported, and one that points at nothing is named here rather than
     * silently rendering nothing.
     */
    const knownArtifactIds = new Set(rowsById.keys());
    for (const battle of campaignBattles) {
      for (const dangling of danglingBattleTokens(battle, knownArtifactIds)) {
        report.unresolved.push({
          where: battleWhere(battle),
          name: dangling.label,
          reason: `its token points at artifact ${dangling.artifactId}, which is in no campaign and not in the shared library, and is not one of the battle's frozen seed rows — nothing can be copied and the token card has no stats to read`,
          unexpected: false,
        });
      }
    }
    for (const battle of campaignBattles) {
      let next: StoredBattleRefs | null;
      try {
        next = repointBattleRow(battle, resolve);
      } catch (error) {
        report.unresolved.push({
          where: battleWhere(battle),
          name: 'its battle tokens',
          reason: `repointing them threw an unexpected error: ${errorMessage(error)}`,
          unexpected: true,
        });
        continue;
      }
      if (next === null) continue;
      await battles.put(next);
      report.repointed += 1;
    }
  }

  const changed = report.adopted.some((entry) => !entry.reused) || report.repointed > 0;
  const shouldPersist =
    options.reason === 'upgrade'
      ? changed || report.adopted.length > 0 || report.unresolved.length > 0
      : options.reason === 'retry'
        ? changed
        : false;
  if (!shouldPersist) return report;
  const existing = (await settings.get('settings')) as Record<string, unknown> | undefined;
  if (existing === undefined) {
    // No settings row and yet there was something to say means the report has
    // nowhere to be READ. Losing it would be the silent-repair shape AGENTS
    // rule 1 forbids, so the transaction fails loudly instead (the v20/v24
    // precedent): an unreportable migration is worse than no migration.
    throw new Error(
      'library adopt: this workspace has library references to copy but no settings row to report the outcome in — refusing to migrate silently',
    );
  }
  await settings.put({
    ...existing,
    id: 'settings',
    libraryAdopt: { ...report, notified: false },
    updatedAt: Date.now(),
  });
  return report;
}
