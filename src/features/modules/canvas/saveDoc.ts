import {
  ModuleVersionPremiseError,
  moduleDocumentFromView,
  planIndexForLevel,
  splitModuleDocument,
  type Id,
  type Module,
  type ModuleVersionSource,
} from '@/domain';
import { saveModuleDocument, patchModuleSpine } from '@/db/moduleRepo';
import { promoteSecondModuleUses } from '@/db/artifactAutoPromote';
import { snapshotModuleVersion } from '@/db/moduleVersionRepo';
import { canvasLedgerKey, useCanvasLedgerStore } from '@/features/modules/canvas/canvasStore';

/**
 * The canvas document save (docs/23 §2–§4, docs/17 row 384): ONE action for
 * the whole-document editor — manual Save, accepted AI proposals and applied
 * chat batches all land here. The doc IS the module document (level 0 = the
 * premise, then `=====Level N=====` sections), and it is written through THE
 * one DOCUMENT write (`moduleRepo.saveModuleDocument`) — never per part.
 *
 * A WHOLE-DOCUMENT WRITE IS ATOMIC, and that is the contract change this slice
 * makes: the old per-part save could land three parts and fail a fourth, so it
 * had to report `failedParts` and toast per part. The document is ONE text, so
 * there is no such half state — the parse refuses a malformed document LOUDLY
 * (`ModuleDocumentError`, naming the line) and nothing is written, or the write
 * lands whole. The caller keeps its text either way.
 *
 * WHAT CHANGED IS REPORTED PER LEVEL: the write stamps only the levels whose
 * text actually moved (`domain/moduleDocument.moduleRowFromDocument`), and this
 * seam appends ONE session-ledger entry per changed level — keyed by the
 * level's `planIndex` (level − 1), so the premise (level 0) is `-1` and the
 * ledger can now name it like any other section.
 *
 * SIMPLE UNDO (owner-directed, docs/18 §2.3): an `origin: 'ai'` save FIRST
 * takes the durable whole-document snapshot of the row as it stands — the
 * exact pre-change text this save is about to replace (`snapshotModuleVersion`)
 * — and that snapshot is REQUIRED: a caller must name the AI action's `source`,
 * because an AI write whose pre-state was not recorded is exactly the bug this
 * seam exists to prevent (a missing source throws loudly). `origin: 'user'`
 * saves (manual typing / manual Save) never snapshot: CM6's own history covers
 * hand edits. The snapshot happens BEFORE the write, never after, and a
 * snapshot failure aborts the whole save.
 *
 * THE PREMISE HALF OF A RESTORE (docs/17 row 357, superseded by row 384). A
 * durable version's document now CARRIES the premise (level 0), so the restore
 * no longer depends on putting it back separately. `restorePremise` is kept
 * and still applied FIRST when a caller names it — it is byte-equal to the
 * document's own level 0 for a version captured since row 384, so the two
 * writes agree; a premise that cannot be applied still aborts the whole restore
 * loudly with `ModuleVersionPremiseError`, so no half restore is ever reported
 * as a success.
 */

export interface SaveWholeDocResult {
  /** The `planIndex`es whose text changed and were persisted (level − 1; the
   * premise is `-1`). */
  savedPlanIndexes: number[];
  /**
   * The durable pre-change snapshot this save took (docs/18 §2.3), or `null`
   * for a `'user'` save and for an `'ai'` save whose pre-change document was
   * EMPTY (the snapshot seam records nothing to lose). The chat turn keeps the
   * FIRST id it sees for the answer's RETRY record (docs/17 row 408): the first
   * snapshot of a turn is the document as it stood before the answer.
   */
  snapshotId: string | null;
}

export async function saveWholeModuleDocument(input: {
  moduleId: Id;
  /** The live whole-document editor doc. */
  doc: string;
  /** The module row (the diff baseline; the document write reads its own). */
  module: Module;
  origin: 'user' | 'ai';
  /** The ledger label for every level this save changes. */
  label: string;
  /**
   * REQUIRED for `origin: 'ai'`: the durable pre-change snapshot this save
   * must take first (docs/18 §2.3) — the AI action's kind (`source`) and the
   * honest label the Versions menu shows for the captured text. A restore
   * labels its snapshot with what is about to happen ("Restore from 14:32").
   */
  version?: { source: ModuleVersionSource; label: string } | undefined;
  /**
   * PROVENANCE (docs/17 row 93): the model that served the AI turn whose
   * commands this save is landing — the CHAT model, because it wrote the text
   * now on the row (the last writer). Omitted by a `'user'` save and by a
   * restore, where the levels KEEP the id they already carry — a hand edit
   * never erases provenance.
   */
  writerModel?: string | undefined;
  /**
   * THE OTHER HALF OF A LEGACY DURABLE RESTORE (docs/17 row 357): the stored
   * premise to put back before the document is written. Omitted by every save
   * that is not a restore.
   */
  restorePremise?: string | undefined;
}): Promise<SaveWholeDocResult> {
  let snapshotId: string | null = null;
  if (input.origin === 'ai') {
    if (input.version === undefined) {
      throw new Error(
        'an AI document save must name its version snapshot — the durable pre-change capture is required (docs/18 §2.3)',
      );
    }
    const snapshot = await snapshotModuleVersion(
      input.moduleId,
      input.version.source,
      input.version.label,
    );
    snapshotId = snapshot?.id ?? null;
  }
  // THE ONE parse of what is about to be written: a malformed document is
  // refused HERE, by line, before any row write and before any ledger entry —
  // the editor keeps its text so the problem can be fixed.
  const parsed = splitModuleDocument(input.doc);
  if (input.restorePremise !== undefined) {
    // Premise FIRST, and loud: its failure must abort the restore before the
    // document is written, so a failed restore is never a half-restored
    // document wearing a success toast.
    try {
      await patchModuleSpine(input.moduleId, { premise: input.restorePremise });
    } catch (error) {
      throw new ModuleVersionPremiseError(
        `the stored premise could not be put back on the module — ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    // The same LINKS hook a restored level gets: a premise that links another
    // module's artifact promotes it to campaign level.
    await promoteSecondModuleUses(input.moduleId, [input.restorePremise]);
  }
  const previous = splitModuleDocument(moduleDocumentFromView(input.module));
  const previousByLevel = new Map(previous.levels.map((level) => [level.number, level.text]));
  const changed = parsed.levels.filter(
    (level) => previousByLevel.get(level.number) !== level.text,
  );
  const changedPlanIndexes = changed.map((level) => planIndexForLevel(level.number));
  await saveModuleDocument(
    input.moduleId,
    input.doc,
    input.writerModel === undefined || input.writerModel === '' ? undefined : input.writerModel,
  );
  // THE LINKS HOOK, per changed level — the exact behaviour the per-part save
  // path carried (`saveModulePartText` promotes a part's artifact references
  // after its write): a level that now links another module's artifact
  // promotes it to campaign level. It runs AFTER the document write, so a
  // failed write promotes nothing.
  if (changed.length > 0) {
    await promoteSecondModuleUses(
      input.moduleId,
      changed.map((level) => level.text),
    );
  }
  // Only a landed write appends ledger entries (there is no partial write to
  // report: the row either took the whole document or threw).
  for (const level of changed) {
    useCanvasLedgerStore.getState().append(canvasLedgerKey(input.moduleId, planIndexForLevel(level.number)), {
      markdown: level.text,
      origin: input.origin,
      label: input.label,
    });
  }
  return { savedPlanIndexes: changedPlanIndexes, snapshotId };
}
