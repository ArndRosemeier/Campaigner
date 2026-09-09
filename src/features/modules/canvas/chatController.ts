import type { Id } from '@/domain';
import type { EditorView } from '@codemirror/view';
import {
  chatProseSoFar,
  composeFailureReport,
  sendCanvasChatMessage,
  type CanvasEditCommand,
} from '@/llm/canvasChat';
import { ModuleBusyError } from '@/llm/moduleGen';
import { getModule } from '@/db/moduleRepo';
import {
  newChatId,
  useCanvasChatStore,
  type CanvasChatMessage,
  type CanvasChatOutcome,
} from '@/features/modules/canvas/chatStore';
import { applyChatCommandsAcrossParts } from '@/features/modules/canvas/chatApply';
import { canvasLedgerKey, useCanvasLedgerStore } from '@/features/modules/canvas/canvasStore';
import { saveModulePartText } from '@/features/modules/partText';
import { toastError } from '@/lib/toast';

/**
 * Canvas chat flow controller (08-MODULE-DESIGNER §Module canvas chat):
 * owns ONE chat turn end-to-end — send (context contract: the WHOLE
 * module's parts document assembled from the row at send time, the OPEN
 * part's text read from the CM6 view), stream into the bubble (prose only,
 * best-effort display split), parse + apply AFTER the reply completes
 * (per part: the open part via CM6 transactions, other parts spliced and
 * SAVED FIRST through the one part-text save path), and the report-to-LLM
 * loop. Loudness map (AGENTS 2):
 * - busy (`ModuleBusyError`) THROWS to the caller → page toast (the
 *   canvasRefine surface),
 * - parse failures / transport errors become a LOUD failed message card
 *   (error + Report-to-LLM button) inside the chat flow,
 * - a failed save for a NON-open part is a LOUD failed outcome card (the
 *   edit did not land) plus a toast naming the part — never a silent drop,
 * - a user abort marks the partial reply `aborted` in place — a stop is
 *   not an error, but nothing is applied and the card says so.
 * Persistence rides THE one part-text save path (saveModulePartText) — the
 * chat never writes the row directly.
 */

export interface ChatTurnOptions {
  moduleId: Id;
  /** The OPEN part's planIndex (its text rides from the live view). */
  openPlanIndex: number;
  /** Per-MODULE chat key (canvasChatKey) — one conversation per module. */
  key: string;
  /** Pre-flight: a module without planned parts must not send an empty
   * context ("no parts to chat about — generate the module first"). */
  hasPlannedParts: boolean;
  /** The live canvas editor view of the OPEN part (the doc string is the
   * truth for that part). */
  view: EditorView;
  /** The session model selection; null = Settings defaultChatModel. */
  modelSelection: string | null;
  signal: AbortSignal;
}

export const NO_PARTS_MESSAGE = 'no parts to chat about — generate the module first';

function historyFor(key: string): { role: 'user' | 'assistant'; text: string }[] {
  return useCanvasChatStore
    .getState()
    .module(key)
    .messages.filter((message) => message.status !== 'streaming')
    .map((message) => ({
      role: message.role,
      text: message.role === 'assistant' ? (message.raw ?? message.text) : message.text,
    }));
}

/**
 * Runs one chat turn. Throws BEFORE any message lands for pre-flight
 * guards (busy / empty instruction / missing view / no planned parts) —
 * those are the caller's toasts. Everything after the user message lands
 * becomes a message-card outcome (see the loudness map above).
 */
export async function runChatTurn(options: ChatTurnOptions, instruction: string): Promise<void> {
  const text = instruction.trim();
  if (text === '') {
    throw new Error('the chat instruction is empty');
  }
  if (!options.hasPlannedParts) {
    throw new Error(NO_PARTS_MESSAGE);
  }
  const store = useCanvasChatStore.getState();
  // The user turn + streaming placeholder land BEFORE the engine's
  // synchronous busy claim: a ModuleBusyError then surfaces BOTH as a
  // failed card in the flow AND the caller's toast (never queued, never
  // silent).
  const userMessage: CanvasChatMessage = {
    id: newChatId('msg'),
    role: 'user',
    text,
    raw: null,
    status: 'ok',
    error: null,
    outcomes: [],
    createdAt: Date.now(),
  };
  const assistantMessage: CanvasChatMessage = {
    id: newChatId('msg'),
    role: 'assistant',
    text: '',
    raw: null,
    status: 'streaming',
    error: null,
    outcomes: [],
    createdAt: Date.now(),
  };
  const history = historyFor(options.key);
  store.addMessage(options.key, userMessage);
  store.addMessage(options.key, assistantMessage);
  store.setInFlight(options.key, true);
  // Streamed deltas coalesce per animation frame (the suggestion ghost
  // precedent): onDelta reports cumulative RAW text; the store keeps the
  // best-effort prose display.
  let latestRaw = '';
  const streamRafRef: { current: number | null } = { current: null };
  const flushStream = (): void => {
    streamRafRef.current = null;
    const { prose } = chatProseSoFar(latestRaw);
    useCanvasChatStore.getState().updateMessage(options.key, assistantMessage.id, { text: prose });
  };
  try {
    const openPartText = options.view.state.doc.toString();
    const result = await sendCanvasChatMessage({
      moduleId: options.moduleId,
      openPlanIndex: options.openPlanIndex,
      openPartText,
      instruction: text,
      history,
      model: options.modelSelection ?? undefined,
      signal: options.signal,
      onDelta: (raw) => {
        latestRaw = raw;
        streamRafRef.current ??= requestAnimationFrame(flushStream);
      },
    });
    if (streamRafRef.current !== null) cancelAnimationFrame(streamRafRef.current);
    // Commands apply ONLY after the reply completed — never mid-stream.
    useCanvasChatStore.getState().updateMessage(options.key, assistantMessage.id, {
      status: 'ok',
      text: result.parse.prose,
      raw: result.raw,
    });
    let finalOutcomes: CanvasChatOutcome[] = [];
    if (result.parse.commands.length > 0) {
      const applied = applyChatCommandsAcrossParts({
        commands: result.parse.commands,
        parts: result.parts,
        openPlanIndex: options.openPlanIndex,
        view: options.view,
      });
      finalOutcomes = [...applied.outcomes];
      // OTHER parts have no editor holding them — SAVE FIRST, then the
      // applied outcomes render. A failed save is LOUD: the edit did not
      // land, so its outcomes flip to failed and the part is named.
      for (const edit of applied.changedParts) {
        try {
          await saveModulePartText(options.moduleId, edit.partIndex, edit.text);
          useCanvasLedgerStore.getState().append(canvasLedgerKey(options.moduleId, edit.partIndex), {
            markdown: edit.text,
            origin: 'ai',
            label: `Chat: ${text.slice(0, 60)}`,
          });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          finalOutcomes = finalOutcomes.map((outcome) =>
            outcome.kind === 'applied' && outcome.targetParts[0]?.planIndex === edit.partIndex
              ? {
                  ...outcome,
                  kind: 'failed',
                  occurrences: null,
                  from: null,
                  to: null,
                  before: null,
                  reason: `save failed — the edit did not land: ${reason}`,
                  failureFrom: outcome.from,
                }
              : outcome,
          );
          toastError(
            `Could not save the chat edits to part "${edit.title}" — the edit did not land`,
            error,
          );
        }
      }
      useCanvasChatStore.getState().updateMessage(options.key, assistantMessage.id, {
        outcomes: [
          ...(useCanvasChatStore.getState().module(options.key).messages.find(
            (message) => message.id === assistantMessage.id,
          )?.outcomes ?? []),
          ...finalOutcomes,
        ],
      });
      // Open part: unchanged CM6 semantics — the transactions already
      // landed; persist the resulting doc through THE one save path.
      if (applied.openPartChanged) {
        await persistChatApplied(options, text);
      }
    }
  } catch (error) {
    if (streamRafRef.current !== null) cancelAnimationFrame(streamRafRef.current);
    if (options.signal.aborted) {
      // User stop: the partial reply is marked aborted in place — loud,
      // nothing applied, no toast (a stop is not an error).
      const { prose } = chatProseSoFar(latestRaw);
      useCanvasChatStore.getState().updateMessage(options.key, assistantMessage.id, {
        status: 'aborted',
        text: prose,
        error: 'stopped — the reply was cut off and nothing was applied',
      });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    useCanvasChatStore.getState().updateMessage(options.key, assistantMessage.id, {
      status: 'failed',
      text: latestRaw === '' ? '' : chatProseSoFar(latestRaw).prose,
      raw: latestRaw === '' ? null : latestRaw,
      error: message,
    });
    if (error instanceof ModuleBusyError) {
      // Surface busy through the caller's toast too (canvasRefine surface).
      throw error;
    }
  } finally {
    useCanvasChatStore.getState().setInFlight(options.key, false);
  }
}

/** The save seam: applied chat edits land through THE one part-text path. */
async function persistChatApplied(options: ChatTurnOptions, instruction: string): Promise<void> {
  const doc = options.view.state.doc.toString();
  try {
    await saveModulePartText(options.moduleId, options.openPlanIndex, doc);
    useCanvasLedgerStore.getState().append(canvasLedgerKey(options.moduleId, options.openPlanIndex), {
      markdown: doc,
      origin: 'ai',
      label: `Chat: ${instruction.slice(0, 60)}`,
    });
  } catch (error) {
    toastError('Could not save the chat edits — use Save part to retry', error);
  }
}

export interface ReportTarget {
  /** The error text surfaced on the card. */
  errorText: string;
  command: CanvasEditCommand | null;
  /** Anchor offset in the TARGET part's CURRENT text (null when nothing
   * in any part corresponds). */
  failureFrom: number | null;
  /** The part the outcome anchors on (null = no part applies). */
  targetPlanIndex: number | null;
}

/**
 * The target part's CURRENT text for the report excerpt: the open part's
 * live view doc; any other part re-reads the ROW at report time.
 */
async function targetPartText(options: ChatTurnOptions, planIndex: number | null): Promise<string> {
  if (planIndex === null) return '';
  if (planIndex === options.openPlanIndex) {
    return options.view.state.doc.toString();
  }
  const module = await getModule(options.moduleId);
  return module?.parts.find((part) => part.planIndex === planIndex)?.markdown ?? '';
}

/** Builds the report-to-LLM user turn (the current doc rides the request). */
export async function composeReportTurn(options: ChatTurnOptions, target: ReportTarget): Promise<string> {
  const document = await targetPartText(options, target.targetPlanIndex);
  return composeFailureReport({
    errorText: target.errorText,
    command: target.command,
    document,
    failureFrom: target.failureFrom,
  });
}

/** Report a FAILED COMMAND back to the LLM (outcome card button). */
export function reportChatOutcome(
  options: ChatTurnOptions,
  messageId: string,
  outcome: CanvasChatOutcome,
): Promise<void> {
  useCanvasChatStore.getState().markOutcomeReported(options.key, messageId, outcome.id);
  return composeReportTurn(options, {
    errorText: outcome.reason ?? 'the edit command failed',
    command: outcome.command,
    failureFrom: outcome.failureFrom,
    targetPlanIndex: outcome.targetParts[0]?.planIndex ?? null,
  }).then((report) => runChatTurn(options, report));
}

/** Report a FAILED REPLY (parse/transport card) back to the LLM. */
export function reportChatMessage(options: ChatTurnOptions, message: CanvasChatMessage): Promise<void> {
  return composeReportTurn(options, {
    errorText: message.error ?? 'the reply could not be parsed',
    command: null,
    failureFrom: null,
    targetPlanIndex: null,
  }).then((report) => runChatTurn(options, report));
}
