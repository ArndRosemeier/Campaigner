import type { Id } from '@/domain';
import type { EditorView } from '@codemirror/view';
import {
  composeFailureReport,
  type CanvasChatFraming,
  type CanvasEditCommand,
} from '@/llm/canvasChat';
import { useCanvasChatStore, type CanvasChatMessage, type CanvasChatOutcome } from '@/features/modules/canvas/chatStore';
import { editorChatHandle } from '@/features/modules/canvas/chatApply';
import {
  EDITOR_TURN_SURFACE,
  runCanvasChatTurn,
  type CanvasChatTurnResult,
} from '@/features/modules/canvas/chatTurn';

/**
 * The canvas chat's EDITOR surface (08-MODULE-DESIGNER §Module canvas chat):
 * the thin wrapper that binds the ONE turn controller (`chatTurn.ts`) to the
 * live whole-document CM6 view. Everything the turn DOES — send, stream,
 * parse, apply, split-save, the request round trip, the write half, the
 * thread persist and every loud failure surface — lives in the controller;
 * what lives here is the surface's own document handle and its report-to-LLM
 * excerpt, which is cut from the LIVE editor doc (the model's context is that
 * same doc).
 *
 * The `handle` is what makes this surface different from the preview's
 * (`snapshotChat.ts`): `editorChatHandle(view)` reads the live doc at send
 * time (unsaved edits in EVERY part ride along, never a cached copy and never
 * a row re-assembly) and applies every command as ONE CodeMirror transaction
 * — one undo step per command, and undo reverts chat edits.
 */

export type ChatTurnResult = CanvasChatTurnResult;

export interface ChatTurnOptions {
  moduleId: Id;
  /**
   * The surface's chat key (`canvasChatKeyFor(moduleId, framing)`) — one
   * conversation per module per surface (docs/17 row 362).
   */
  key: string;
  /** WHICH chat surface this turn is (docs/17 row 362): the framing the system
   * prompt carries and whether the thread persists on the module row. OPTIONAL
   * here, defaulting to the module chat — the same default the prompt itself
   * carries, so a caller that does not know about GM assist is byte-identical
   * to the pre-362 contract. The canvas surfaces always pass it. */
  framing?: CanvasChatFraming | undefined;
  /** Pre-flight: a module without planned parts must not send an empty
   * context (`llm/canvasChat.NO_PARTS_MESSAGE` — the ONE sentence, declared
   * beside the engine guard that raises it). */
  hasPlannedParts: boolean;
  /** The live canvas editor view of the WHOLE module (the doc string is
   * the truth for every part). */
  view: EditorView;
  /** The session model selection; null = Settings defaultChatModel. */
  modelSelection: string | null;
  /** The caller's per-turn controller — handed to the turn so Stop all can
   * reach this canvas generation (canvasBusy's abort registry). */
  turn: AbortController;
}

/**
 * Runs one chat turn over the live editor doc. Throws BEFORE any message
 * lands for pre-flight guards (empty instruction / no planned parts) — those
 * are the caller's toasts.
 */
export async function runChatTurn(
  options: ChatTurnOptions,
  instruction: string,
): Promise<ChatTurnResult> {
  return runCanvasChatTurn(
    {
      moduleId: options.moduleId,
      key: options.key,
      framing: options.framing ?? 'module',
      hasPlannedParts: options.hasPlannedParts,
      handle: editorChatHandle(options.view),
      surface: EDITOR_TURN_SURFACE,
      modelSelection: options.modelSelection,
      turn: options.turn,
    },
    instruction,
  );
}

export interface ReportTarget {
  /** The error text surfaced on the card. */
  errorText: string;
  command: CanvasEditCommand | null;
  /** Anchor offset in the CURRENT whole-document editor doc (null when
   * nothing corresponds). */
  failureFrom: number | null;
}

/**
 * Builds the report-to-LLM user turn: the error, the failed command
 * verbatim, and the current text around the failure point — the excerpt
 * comes from the LIVE whole-document editor doc (the model's context is
 * that same doc).
 */
export function composeReportTurn(options: ChatTurnOptions, target: ReportTarget): string {
  return composeFailureReport({
    errorText: target.errorText,
    command: target.command,
    document: options.view.state.doc.toString(),
    failureFrom: target.failureFrom,
  });
}

/** Report a FAILED COMMAND back to the LLM (outcome card button). */
export function reportChatOutcome(
  options: ChatTurnOptions,
  messageId: string,
  outcome: CanvasChatOutcome,
): Promise<ChatTurnResult> {
  useCanvasChatStore.getState().markOutcomeReported(options.key, messageId, outcome.id);
  const report = composeReportTurn(options, {
    errorText: outcome.reason ?? 'the edit command failed',
    command: outcome.command,
    failureFrom: outcome.failureFrom,
  });
  return runChatTurn(options, report);
}

/** Report a FAILED REPLY (parse/transport card) back to the LLM. */
export function reportChatMessage(
  options: ChatTurnOptions,
  message: CanvasChatMessage,
): Promise<ChatTurnResult> {
  const report = composeReportTurn(options, {
    errorText: message.error ?? 'the reply could not be parsed',
    command: null,
    failureFrom: null,
  });
  return runChatTurn(options, report);
}
