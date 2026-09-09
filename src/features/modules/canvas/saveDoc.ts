import type { Id, Module } from '@/domain';
import { splitPartsDocument } from '@/domain/modulePartsDocument';
import { saveModulePartText } from '@/features/modules/partText';
import { canvasLedgerKey, useCanvasLedgerStore } from '@/features/modules/canvas/canvasStore';
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
}): Promise<SaveWholeDocResult> {
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
