import type { Id } from '@/domain';
import type { EditorView } from '@codemirror/view';
import {
  chatProseSoFar,
  composeFailureReport,
  sendCanvasChatMessage,
  type CanvasEditCommand,
} from '@/llm/canvasChat';
import { ModuleBusyError } from '@/llm/moduleGen';
import {
  newChatId,
  useCanvasChatStore,
  type CanvasChatMessage,
  type CanvasChatOutcome,
} from '@/features/modules/canvas/chatStore';
import { applyChatCommandsToView } from '@/features/modules/canvas/chatApply';
import { canvasLedgerKey, useCanvasLedgerStore } from '@/features/modules/canvas/canvasStore';
import { saveModulePartText } from '@/features/modules/partText';
import { toastError } from '@/lib/toast';

/**
 * Canvas chat flow controller (08-MODULE-DESIGNER §Module canvas chat):
 * owns ONE chat turn end-to-end — send (context contract: the doc read
 * from the CM6 view at send time), stream into the bubble (prose only,
 * best-effort display split), parse + apply AFTER the reply completes, and
 * the report-to-LLM loop. Loudness map (AGENTS 2):
 * - busy (`ModuleBusyError`) THROWS to the caller → page toast (the
 *   canvasRefine surface),
 * - parse failures / transport errors become a LOUD failed message card
 *   (error + Report-to-LLM button) inside the chat flow,
 * - a user abort marks the partial reply `aborted` in place — a stop is
 *   not an error, but nothing is applied and the card says so.
 * Persistence rides THE one part-text save path (saveModulePartText) after
 * a reply's applied batch — the chat never writes the row directly.
 */

export interface ChatTurnOptions {
  moduleId: Id;
  planIndex: number;
  key: string;
  /** The live canvas editor view (the doc string is the truth). */
  view: EditorView;
  /** The session model selection; null = Settings defaultChatModel. */
  modelSelection: string | null;
  signal: AbortSignal;
}

function historyFor(key: string): { role: 'user' | 'assistant'; text: string }[] {
  return useCanvasChatStore
    .getState()
    .part(key)
    .messages.filter((message) => message.status !== 'streaming')
    .map((message) => ({
      role: message.role,
      text: message.role === 'assistant' ? (message.raw ?? message.text) : message.text,
    }));
}

/**
 * Runs one chat turn. Throws BEFORE any message lands for pre-flight
 * guards (busy / empty instruction / missing view) — those are the
 * caller's toasts. Everything after the user message lands becomes a
 * message-card outcome (see the loudness map above).
 */
export async function runChatTurn(options: ChatTurnOptions, instruction: string): Promise<void> {
  const text = instruction.trim();
  if (text === '') {
    throw new Error('the chat instruction is empty');
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
    const doc = options.view.state.doc.toString();
    const result = await sendCanvasChatMessage({
      moduleId: options.moduleId,
      document: doc,
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
    let appliedCount = 0;
    if (result.parse.commands.length > 0) {
      const outcomes = applyChatCommandsToView(options.view, result.parse.commands);
      appliedCount = outcomes.filter((outcome) => outcome.kind === 'applied').length;
      const settled = useCanvasChatStore.getState().part(options.key).messages.find(
        (message) => message.id === assistantMessage.id,
      );
      useCanvasChatStore.getState().updateMessage(options.key, assistantMessage.id, {
        outcomes: [...(settled?.outcomes ?? []), ...outcomes],
      });
    }
    if (appliedCount > 0) {
      await persistChatApplied(options, text);
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
    await saveModulePartText(options.moduleId, options.planIndex, doc);
    useCanvasLedgerStore.getState().append(canvasLedgerKey(options.moduleId, options.planIndex), {
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
  /** Anchor offset in the CURRENT doc for the failure excerpt. */
  failureFrom: number | null;
}

/** Builds the report-to-LLM user turn (the current doc rides the request). */
export function composeReportTurn(options: ChatTurnOptions, target: ReportTarget): string {
  const doc = options.view.state.doc.toString();
  return composeFailureReport({
    errorText: target.errorText,
    command: target.command,
    document: doc,
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
  return runChatTurn(options, composeReportTurn(options, {
    errorText: outcome.reason ?? 'the edit command failed',
    command: outcome.command,
    failureFrom: outcome.failureFrom,
  }));
}

/** Report a FAILED REPLY (parse/transport card) back to the LLM. */
export function reportChatMessage(options: ChatTurnOptions, message: CanvasChatMessage): Promise<void> {
  return runChatTurn(options, composeReportTurn(options, {
    errorText: message.error ?? 'the reply could not be parsed',
    command: null,
    failureFrom: null,
  }));
}
