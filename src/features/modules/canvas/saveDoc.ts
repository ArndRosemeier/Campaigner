import type { Id, Module, ModuleVersionSource } from '@/domain';
import { splitPartsDocument } from '@/domain/modulePartsDocument';
import { saveModulePartText } from '@/features/modules/partText';
import { canvasLedgerKey, useCanvasLedgerStore } from '@/features/modules/canvas/canvasStore';
import { snapshotModuleVersion } from '@/db/moduleVersionRepo';
import { toastError } from '@/lib/toast';

/**
 * The canvas split-save (canvas v3, 08-MODULE-DESIGNER §Module canvas): ONE
 * save action for the whole-document editor — manual Save, accepted AI
 * proposals and applied chat batches all land here. The doc is split by the
 * shared `splitPartsDocument` (loud typed error when the scaffolding no
 * longer parses — the editor keeps its text and the caller toasts), and ONLY
 * the parts whose text changed vs the module row hit
 * `saveModulePartText` (THE one part-text save path) — a part whose planned
 * section is empty and unchanged saves nothing. Each saved part appends its
 * session-ledger entry (per part, same label). A failed part save is LOUD
 * per part (a toast naming the part) while the remaining parts still land —
 * never a silent partial: the return value reports exactly what did and did
 * not persist, and the editor keeps every in-doc edit so Save can retry.
 *
 * SIMPLE UNDO (owner-directed, docs/18 §2.3): an `origin: 'ai'` save FIRST
 * takes the durable whole-document snapshot of the row as it stands — the
 * exact pre-change text this save is about to replace (`snapshotModuleVersion`)
 * — and that snapshot is REQUIRED: a caller must name the AI action's `source`,
 * because an AI write whose pre-state was not recorded is exactly the bug this
 * seam exists to prevent (a missing source throws loudly, and the throw lands
 * in the caller's existing loud-failure surface — nothing is written).
 * `origin: 'user'` saves (manual typing / manual Save) never snapshot: CM6's
 * own history covers hand edits, and a hand edit is not an AI change. The
 * snapshot happens BEFORE the first part write, never after, and a snapshot
 * failure aborts the whole save (the editor keeps its text; the caller toasts).
 */

export interface SaveWholeDocResult {
  /** The planIndexes that were persisted (changed + saved successfully). */
  savedPlanIndexes: number[];
  /** The parts whose save FAILED (loud toasts already fired). */
  failedParts: { planIndex: number; title: string; error: unknown }[];
}

export async function saveWholeModuleDocument(input: {
  moduleId: Id;
  /** The live whole-document editor doc. */
  doc: string;
  /** The module row (spine plan drives the split; parts drive the diff). */
  module: Module;
  origin: 'user' | 'ai';
  /** The ledger label for every part this save changes. */
  label: string;
  /**
   * REQUIRED for `origin: 'ai'`: the durable pre-change snapshot this save
   * must take first (docs/18 §2.3) — the AI action's kind (`source`) and the
   * honest label the Versions menu shows for the captured text. A restore
   * labels its snapshot with what is about to happen ("Restore from 14:32"),
   * which is why this carries its own label rather than reusing `label`.
   */
  version?: { source: ModuleVersionSource; label: string } | undefined;
}): Promise<SaveWholeDocResult> {
  if (input.origin === 'ai') {
    if (input.version === undefined) {
      throw new Error(
        'an AI document save must name its version snapshot — the durable pre-change capture is required (docs/18 §2.3)',
      );
    }
    await snapshotModuleVersion(input.moduleId, input.version.source, input.version.label);
  }
  const sections = splitPartsDocument(input.doc, input.module.spine?.partPlan ?? []);
  const savedPlanIndexes: number[] = [];
  const failedParts: SaveWholeDocResult['failedParts'] = [];
  for (const section of sections) {
    const rowPart = input.module.parts.find((part) => part.planIndex === section.planIndex);
    if ((rowPart?.markdown ?? '') === section.text) continue; // unchanged — no write
    try {
      await saveModulePartText(input.moduleId, section.planIndex, section.text);
      useCanvasLedgerStore.getState().append(canvasLedgerKey(input.moduleId, section.planIndex), {
        markdown: section.text,
        origin: input.origin,
        label: input.label,
      });
      savedPlanIndexes.push(section.planIndex);
    } catch (error) {
      failedParts.push({ planIndex: section.planIndex, title: section.title, error });
      toastError(
        `Could not save part "${section.title}" — the edit did not land on the module row`,
        error,
      );
    }
  }
  return { savedPlanIndexes, failedParts };
}
