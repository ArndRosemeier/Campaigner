import type { Id } from '@/domain';
import { composeFailureReport, type CanvasEditCommand } from '@/llm/canvasChat';
import { useCanvasChatStore, type CanvasChatMessage, type CanvasChatOutcome } from '@/features/modules/canvas/chatStore';
import { stringChatHandle } from '@/features/modules/canvas/chatApply';
import {
  PREVIEW_TURN_SURFACE,
  runCanvasChatTurn,
  type CanvasChatTurnResult,
} from '@/features/modules/canvas/chatTurn';

/**
 * The canvas chat's PREVIEW surface (preview-default arc, 08-MODULE-DESIGNER
 * §Module canvas): the editor is unmounted while the preview is open (v3
 * contract — never remounted hidden), so the chat works over the snapshot
 * STRING the preview renders from instead of a CM6 view. This module is the
 * thin wrapper that binds the ONE turn controller (`chatTurn.ts`) to that
 * string; everything the turn does lives in the controller.
 *
 * Two things this surface owns, and they are the reasons the controller is
 * parameterized:
 *
 * - THE APPLIER ENTRY POINT. Both chat surfaces go through ONE applier
 *   (`chatApply.applyChatCommands` over an injected `ChatDocumentHandle`).
 *   This module used to carry a byte-identical COPY of the editor's
 *   `applyChatCommandsToDocument` (166 of 192 code lines verbatim); a measured
 *   3000-case differential fuzz found ZERO divergences, which is what made the
 *   copy pure risk — nothing fails when a copy is born, and an edit to one
 *   side would silently split the two behaviours.
 *   `tests/features/canvas-chat-apply-differential.test.tsx` runs both entry
 *   points over one input table requiring identical documents and identical
 *   outcome fields (AGENTS §Centralization item 2). Re-exported here so the
 *   preview callers keep one import path for their surface.
 * - THE SNAPSHOT STRING HANDLE: `stringChatHandle(doc)` reads the snapshot at
 *   send time and splices pure edits (no CM transaction — there is no view).
 *
 * DOCUMENTED CAVEAT (no undo): preview-applied edits have no CM history while
 * the editor is unmounted — they cannot be undone. Their undo is the DURABLE
 * pre-change snapshot the split-save takes first (docs/18 §2.3). Outcome
 * cards are unchanged (before→after still shown per command).
 */
export { applyChatCommandsToSnapshot, type SnapshotApplyResult } from '@/features/modules/canvas/chatApply';

// --- the preview surface's turn wrapper -----------------------------------------

export type SnapshotChatTurnResult = CanvasChatTurnResult;

export interface SnapshotChatTurnOptions {
  moduleId: Id;
  /** Per-MODULE chat key (canvasChatKey) — one conversation per module. */
  key: string;
  /** Pre-flight: a module without planned parts must not send an empty context
   * (`llm/canvasChat.NO_PARTS_MESSAGE` — the ONE sentence). */
  hasPlannedParts: boolean;
  /** The PREVIEW SNAPSHOT at send time (the string the preview renders
   * from — the editor is unmounted, so no view exists). */
  doc: string;
  /** The session model selection; null = Settings defaultChatModel. */
  modelSelection: string | null;
  /** The caller's per-turn controller — handed to the turn so Stop all can
   * reach this canvas generation (canvasBusy's abort registry). */
  turn: AbortController;
}

/**
 * Runs one chat turn against the PREVIEW SNAPSHOT (the editor is unmounted):
 * the ONE controller (`chatTurn.runCanvasChatTurn`) over the string handle —
 * send, stream, apply through the shared ladder, persist through the shared
 * split-save headlessly, and the same loudness map (busy throws to the
 * caller, parse/transport failures become LOUD failed cards, a user abort
 * marks the partial reply `aborted`). Nothing is duplicated from the editor
 * flow any more, including the failure returns: a failed turn hands back the
 * document that carries the applied edits, because that is what the refusal
 * text says happened (docs/17 row 150).
 */
export async function runSnapshotChatTurn(
  options: SnapshotChatTurnOptions,
  instruction: string,
): Promise<SnapshotChatTurnResult> {
  return runCanvasChatTurn(
    {
      moduleId: options.moduleId,
      key: options.key,
      hasPlannedParts: options.hasPlannedParts,
      handle: stringChatHandle(options.doc),
      surface: PREVIEW_TURN_SURFACE,
      modelSelection: options.modelSelection,
      turn: options.turn,
    },
    instruction,
  );
}

export interface SnapshotReportTarget {
  errorText: string;
  command: CanvasEditCommand | null;
  failureFrom: number | null;
}

/** Builds the report-to-LLM user turn against the CURRENT snapshot. */
export function composeSnapshotReportTurn(
  target: SnapshotReportTarget,
  doc: string,
): string {
  return composeFailureReport({
    errorText: target.errorText,
    command: target.command,
    document: doc,
    failureFrom: target.failureFrom,
  });
}

/** Report a FAILED COMMAND back to the LLM (outcome card button, preview). */
export function reportSnapshotOutcome(
  options: SnapshotChatTurnOptions,
  messageId: string,
  outcome: CanvasChatOutcome,
): Promise<SnapshotChatTurnResult> {
  useCanvasChatStore.getState().markOutcomeReported(options.key, messageId, outcome.id);
  const report = composeSnapshotReportTurn(
    {
      errorText: outcome.reason ?? 'the edit command failed',
      command: outcome.command,
      failureFrom: outcome.failureFrom,
    },
    options.doc,
  );
  return runSnapshotChatTurn(options, report);
}

/** Report a FAILED REPLY (parse/transport card) back to the LLM (preview). */
export function reportSnapshotMessage(
  options: SnapshotChatTurnOptions,
  message: CanvasChatMessage,
): Promise<SnapshotChatTurnResult> {
  const report = composeSnapshotReportTurn(
    {
      errorText: message.error ?? 'the reply could not be parsed',
      command: null,
      failureFrom: null,
    },
    options.doc,
  );
  return runSnapshotChatTurn(options, report);
}
