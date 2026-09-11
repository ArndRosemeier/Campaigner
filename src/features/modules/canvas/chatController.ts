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
import { applyChatCommandsToDocument } from '@/features/modules/canvas/chatApply';
import { saveWholeModuleDocument } from '@/features/modules/canvas/saveDoc';
import { scheduleChatPersist } from '@/features/modules/canvas/chatPersist';
import { toastError } from '@/lib/toast';

/**
 * Canvas chat flow controller (08-MODULE-DESIGNER §Module canvas chat):
 * owns ONE chat turn end-to-end — send (context contract: the LIVE
 * whole-document editor doc, read at send time — unsaved edits in EVERY
 * part ride along; the per-part snapshot is its split), stream into the
 * bubble (prose only, best-effort display split), parse + apply AFTER the
 * reply completes (every command is ONE undoable transaction over the whole
 * doc, per part via mapped section ranges), then persist the batch through
 * the split-save (only the parts whose text changed hit the row — a failed
 * part save is a LOUD toast naming the part and the ledger reflects what
 * actually landed). The report-to-LLM loop composes error + failed command
 * + the current doc excerpt. Loudness map (AGENTS 2):
 * - busy (`ModuleBusyError`) THROWS to the caller → page toast (the
 *   canvasRefine surface),
 * - parse failures / transport errors / a doc whose scaffolding no longer
 *   parses become a LOUD failed message card (error + Report-to-LLM button)
 *   inside the chat flow,
 * - a user abort marks the partial reply `aborted` in place — a stop is
 *   not an error, but nothing is applied and the card says so.
 * THE REQUEST ROUND TRIP (docs/17 row 103): a reply carrying `<request>`
 * blocks makes the engine answer them from the stored rows and call the model
 * ONCE more in the same turn. That follow-up reply lands as its OWN assistant
 * message (its own bubble, its own outcomes, its own `writerModel` — one
 * provenance id per call, row 93) and its commands are applied as a SECOND
 * batch over the same live doc, in reply order. A follow-up that failed or did
 * not parse is a LOUD failed card and never touches the first reply's work; a
 * request made in the SECOND reply is not served and says so through
 * `toastError` (never a third call).
 * Persistence is two lanes: PART TEXT rides THE one part-text save path
 * (saveModulePartText, via saveWholeModuleDocument) — the chat never writes
 * part text directly — and the THREAD (messages + outcomes) persists on the
 * module row's `chatThread` field after every SETTLED turn (debounced via
 * `chatPersist.scheduleChatPersist`; a write failure toasts loudly but
 * never blocks chatting).
 */

export interface ChatTurnOptions {
  moduleId: Id;
  /** Per-MODULE chat key (canvasChatKey) — one conversation per module. */
  key: string;
  /** Pre-flight: a module without planned parts must not send an empty
   * context ("no parts to chat about — generate the module first"). */
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
 * becomes a message-card outcome (see the loudness map above). Resolves
 * with the post-turn doc + the last applied range (the last-replacement
 * highlight; null when nothing applied).
 */
export async function runChatTurn(
  options: ChatTurnOptions,
  instruction: string,
): Promise<{ doc: string; lastApplied: { from: number; to: number } | null }> {
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
  // best-effort prose display. The request round trip (docs/17 row 103)
  // streams its OWN reply into its own bubble: the follow-up message is
  // created lazily on the first follow-up delta (or when the engine returns
  // one), so a reply that asked nothing ever produces a second bubble.
  let latestRaw = '';
  const streamRafRef: { current: number | null } = { current: null };
  const flushStream = (): void => {
    streamRafRef.current = null;
    const { prose } = chatProseSoFar(latestRaw);
    useCanvasChatStore.getState().updateMessage(options.key, assistantMessage.id, { text: prose });
  };
  let followUpRaw = '';
  const followUpMessageRef: { current: CanvasChatMessage | null } = { current: null };
  const followUpRafRef: { current: number | null } = { current: null };
  const flushFollowUpStream = (): void => {
    followUpRafRef.current = null;
    const message = followUpMessageRef.current;
    if (message === null) return;
    const { prose } = chatProseSoFar(followUpRaw);
    useCanvasChatStore.getState().updateMessage(options.key, message.id, { text: prose });
  };
  const ensureFollowUpMessage = (): CanvasChatMessage => {
    if (followUpMessageRef.current !== null) return followUpMessageRef.current;
    const message: CanvasChatMessage = {
      id: newChatId('msg'),
      role: 'assistant',
      text: '',
      raw: null,
      status: 'streaming',
      error: null,
      outcomes: [],
      createdAt: Date.now(),
    };
    followUpMessageRef.current = message;
    useCanvasChatStore.getState().addMessage(options.key, message);
    return message;
  };
  try {
    // The LIVE whole-document editor doc — read at send time (never a
    // cached copy, never re-assembled from the row). Unsaved edits in
    // every part ride the context.
    const document = options.view.state.doc.toString();
    const result = await sendCanvasChatMessage({
      moduleId: options.moduleId,
      document,
      instruction: text,
      history,
      model: options.modelSelection ?? undefined,
      turn: options.turn,
      onDelta: (raw) => {
        latestRaw = raw;
        streamRafRef.current ??= requestAnimationFrame(flushStream);
      },
      onFollowUpDelta: (raw) => {
        followUpRaw = raw;
        ensureFollowUpMessage();
        followUpRafRef.current ??= requestAnimationFrame(flushFollowUpStream);
      },
    });
    if (streamRafRef.current !== null) cancelAnimationFrame(streamRafRef.current);
    if (followUpRafRef.current !== null) cancelAnimationFrame(followUpRafRef.current);
    // Commands apply ONLY after the reply completed — never mid-stream.
    useCanvasChatStore.getState().updateMessage(options.key, assistantMessage.id, {
      status: 'ok',
      text: result.parse.prose,
      raw: result.raw,
    });
    /**
     * Applies ONE reply's commands to the live editor doc and persists the
     * changed parts through the ONE split-save. Called once per reply of the
     * turn (a request turn has two), each with the model that served THAT
     * reply — provenance is per call, never one id for two calls (row 93).
     */
    const applyCommandsFor = async (
      message: CanvasChatMessage,
      commands: readonly CanvasEditCommand[],
      writerModel: string,
    ): Promise<{ lastApplied: { from: number; to: number } | null }> => {
      if (commands.length === 0) return { lastApplied: null };
      const applied = applyChatCommandsToDocument({
        commands: [...commands],
        partPlan: result.parts.map((part) => ({ title: part.title })),
        view: options.view,
      });
      useCanvasChatStore.getState().updateMessage(options.key, message.id, {
        outcomes: [
          ...(useCanvasChatStore.getState().module(options.key).messages.find(
            (candidate) => candidate.id === message.id,
          )?.outcomes ?? []),
          ...applied.outcomes,
        ],
      });
      // Persist the batch through the split-save: only the parts whose
      // text changed hit the row; a failed part save is a loud toast
      // naming the part (saveWholeModuleDocument fires it) while the rest
      // land — the doc keeps every in-doc edit either way.
      if (applied.docChanged) {
        const module = await getModule(options.moduleId);
        if (module === undefined) {
          throw new Error('Module no longer exists — the edits are still in the editor, use Save to retry');
        }
        await saveWholeModuleDocument({
          moduleId: options.moduleId,
          doc: options.view.state.doc.toString(),
          module,
          origin: 'ai',
          label: `Chat: ${text.slice(0, 60)}`,
          // Durable pre-change snapshot (docs/18 §2.3): the whole document as
          // it stood before this batch — the simple undo for chat edits.
          version: { source: 'chat', label: `Chat: ${text.slice(0, 60)}` },
          // PROVENANCE (docs/17 row 93): a chat-written passage belongs to the
          // CHAT model — the id the turn's own call reported (`modelUsed`),
          // which is the selected/session model or the escalation tier that
          // actually served the reply, never a settings lookup.
          writerModel,
        });
      }
      return { lastApplied: applied.lastApplied };
    };
    const first = await applyCommandsFor(assistantMessage, result.parse.commands, result.modelUsed);
    let lastApplied = first.lastApplied;
    // --- the request round trip (docs/17 row 103) ---------------------------
    // Present ONLY when the reply carried a <request>: the app answered from
    // the stored rows and made exactly ONE further call. Its reply lands as
    // its OWN message and its commands apply as their OWN batch; a follow-up
    // that failed or did not parse is a LOUD failed card and never touches
    // the first reply's work.
    if (result.details !== null) {
      const followUpMessage = ensureFollowUpMessage();
      if (result.details.status === 'failed') {
        useCanvasChatStore.getState().updateMessage(options.key, followUpMessage.id, {
          status: 'failed',
          text: followUpRaw === '' ? '' : chatProseSoFar(followUpRaw).prose,
          raw: followUpRaw === '' ? null : followUpRaw,
          error: `the follow-up reply after your requested details failed: ${result.details.error}`,
        });
      } else {
        useCanvasChatStore.getState().updateMessage(options.key, followUpMessage.id, {
          status: 'ok',
          text: result.details.parse.prose,
          raw: result.details.raw,
        });
        const second = await applyCommandsFor(followUpMessage, result.details.parse.commands, result.details.modelUsed);
        if (second.lastApplied !== null) lastApplied = second.lastApplied;
        if (result.details.ignoredRequests.length > 0) {
          // A request in the SECOND reply is not served (one round trip per
          // message) — named LOUDLY, never a silent drop and never a third call.
          toastError(
            `The chat asked for artifact details a second time in one turn: ${result.details.ignoredRequests
              .map((request) => `«${request.name}»`)
              .join(', ')} — one details round trip is served per message, so it was NOT answered. Ask again in your next message to fetch it.`,
          );
        }
      }
    }
    return { doc: options.view.state.doc.toString(), lastApplied };
  } catch (error) {
    if (streamRafRef.current !== null) cancelAnimationFrame(streamRafRef.current);
    if (followUpRafRef.current !== null) cancelAnimationFrame(followUpRafRef.current);
    if (options.turn.signal.aborted) {
      // User stop: the partial reply is marked aborted in place — loud,
      // nothing applied, no toast (a stop is not an error). A round trip in
      // flight is settled the same way (its bubble must never stay spinning).
      const { prose } = chatProseSoFar(latestRaw);
      useCanvasChatStore.getState().updateMessage(options.key, assistantMessage.id, {
        status: 'aborted',
        text: prose,
        error: 'stopped — the reply was cut off and nothing was applied',
      });
      if (followUpMessageRef.current !== null) {
        useCanvasChatStore.getState().updateMessage(options.key, followUpMessageRef.current.id, {
          status: 'aborted',
          text: followUpRaw === '' ? '' : chatProseSoFar(followUpRaw).prose,
          error: 'stopped — the reply after your requested details was cut off and nothing was applied',
        });
      }
      return { doc: options.view.state.doc.toString(), lastApplied: null };
    }
    const message = error instanceof Error ? error.message : String(error);
    useCanvasChatStore.getState().updateMessage(options.key, assistantMessage.id, {
      status: 'failed',
      text: latestRaw === '' ? '' : chatProseSoFar(latestRaw).prose,
      raw: latestRaw === '' ? null : latestRaw,
      error: message,
    });
    if (followUpMessageRef.current !== null) {
      useCanvasChatStore.getState().updateMessage(options.key, followUpMessageRef.current.id, {
        status: 'failed',
        text: followUpRaw === '' ? '' : chatProseSoFar(followUpRaw).prose,
        raw: followUpRaw === '' ? null : followUpRaw,
        error: message,
      });
    }
    if (error instanceof ModuleBusyError) {
      // Surface busy through the caller's toast too (canvasRefine surface).
      throw error;
    }
    return { doc: options.view.state.doc.toString(), lastApplied: null };
  } finally {
    useCanvasChatStore.getState().setInFlight(options.key, false);
    // Write-after-settled-turn: the turn landed above as ok / failed /
    // aborted (or never landed for pre-flight throws — then the store is
    // unchanged and the writer is a no-op). Debounced; failures toast
    // loudly inside the writer and never reach the caller.
    scheduleChatPersist(options.moduleId, options.key);
  }
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
): Promise<{ doc: string; lastApplied: { from: number; to: number } | null }> {
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
): Promise<{ doc: string; lastApplied: { from: number; to: number } | null }> {
  const report = composeReportTurn(options, {
    errorText: message.error ?? 'the reply could not be parsed',
    command: null,
    failureFrom: null,
  });
  return runChatTurn(options, report);
}
