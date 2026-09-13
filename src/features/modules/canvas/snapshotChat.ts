import type { Id } from '@/domain';
import {
  NO_PARTS_MESSAGE,
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
import { saveWholeModuleDocument } from '@/features/modules/canvas/saveDoc';
import {
  executeChatChange,
  reportChatChangeOutcome,
} from '@/features/modules/canvas/chatChanges';
import { scheduleChatPersist } from '@/features/modules/canvas/chatPersist';
import { applyChatCommandsToSnapshot } from '@/features/modules/canvas/chatApply';
import { toastError } from '@/lib/toast';

/**
 * The PREVIEW surface of the chat applier (preview-default arc,
 * 08-MODULE-DESIGNER §Module canvas): the editor is unmounted while the
 * preview is open (v3 contract — never remounted hidden), so preview-applied
 * chat edits target the snapshot string the preview renders from instead of a
 * CM6 view.
 *
 * THE ALGORITHM IS NOT HERE. Both surfaces go through ONE applier —
 * `chatApply.applyChatCommands` over an injected `ChatDocumentHandle` — and
 * this module used to carry a byte-identical COPY of the editor's
 * `applyChatCommandsToDocument` (166 of 192 code lines verbatim). A measured
 * 3000-case differential fuzz found ZERO divergences, which is what made the
 * copy pure risk: nothing fails when a copy is born, and a later edit to one
 * side would silently split the two behaviours. The two entry points are
 * adapters over the one algorithm now, and
 * `tests/features/canvas-chat-apply-differential.test.ts` runs them over one
 * input table requiring identical documents and identical outcome fields
 * (AGENTS §Centralization item 2).
 *
 * DOCUMENTED CAVEAT (no undo): preview-applied edits have no CM history
 * while the editor is unmounted — they cannot be undone. Outcome cards are
 * unchanged (before→after still shown per command).
 *
 * Re-exported here so the preview callers keep ONE import path for their
 * surface; the seam itself lives in `chatApply.ts`.
 */
export { applyChatCommandsToSnapshot, type SnapshotApplyResult } from '@/features/modules/canvas/chatApply';

// --- preview turn controller ----------------------------------------------------

export interface SnapshotChatTurnOptions {
  moduleId: Id;
  /** Per-MODULE chat key (canvasChatKey) — one conversation per module. */
  key: string;
  /** Pre-flight: a module without planned parts must not send an empty context. */
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

export interface SnapshotChatTurnResult {
  /** The snapshot after the turn (=== input when nothing applied). */
  doc: string;
  docChanged: boolean;
  /** The LAST command's FIRST applied range in the returned doc (null when
   * nothing applied) — the last-replacement highlight. */
  lastApplied: { from: number; to: number } | null;
}

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
 * Runs one chat turn against the PREVIEW SNAPSHOT (the editor is unmounted):
 * send (context contract: the snapshot string at send time — the SAME
 * whole-document format the editor holds), stream into the bubble (prose
 * only), parse + apply AFTER the reply completes (string splices via the
 * shared ladder), then persist the batch through the existing split-save
 * (only the parts whose text changed hit the row — headless, no editor).
 * Loudness mirrors the editor turn controller: busy (`ModuleBusyError`)
 * THROWS to the caller, parse/transport/scaffolding failures become LOUD
 * failed message cards, a user abort marks the partial reply `aborted` with
 * nothing applied. Preview-applied edits have NO undo (no CM history while
 * the editor is unmounted) — the outcome cards still show before→after.
 *
 * The REQUEST round trip (docs/17 row 103) runs here too, through the SAME
 * engine: the follow-up reply lands as its own message and its commands are
 * applied as a SECOND batch of string splices (the shared ladder, the same
 * split-save), with that reply's own `modelUsed` as provenance.
 */
export async function runSnapshotChatTurn(
  options: SnapshotChatTurnOptions,
  instruction: string,
): Promise<SnapshotChatTurnResult> {
  const text = instruction.trim();
  if (text === '') {
    throw new Error('the chat instruction is empty');
  }
  if (!options.hasPlannedParts) {
    throw new Error(NO_PARTS_MESSAGE);
  }
  const store = useCanvasChatStore.getState();
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
  let latestRaw = '';
  const streamRafRef: { current: number | null } = { current: null };
  const flushStream = (): void => {
    streamRafRef.current = null;
    const { prose } = chatProseSoFar(latestRaw);
    useCanvasChatStore.getState().updateMessage(options.key, assistantMessage.id, { text: prose });
  };
  // The request round trip (docs/17 row 103): the follow-up reply streams into
  // its OWN bubble, created lazily — a reply that asked nothing never produces
  // a second message.
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
    const result = await sendCanvasChatMessage({
      moduleId: options.moduleId,
      document: options.doc,
      instruction: text,
      history,
      model: options.modelSelection ?? undefined,
      turn: options.turn,
      // THE WRITE HALF (docs/17 row 104): the preview flow wires the SAME
      // executor and the SAME settle-time owner report as the editor flow.
      executeChange: executeChatChange,
      reportChange: reportChatChangeOutcome,
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
    useCanvasChatStore.getState().updateMessage(options.key, assistantMessage.id, {
      status: 'ok',
      text: result.parse.prose,
      raw: result.raw,
    });
    let doc = options.doc;
    let lastApplied: { from: number; to: number } | null = null;
    let docChanged = false;
    /**
     * Applies ONE reply's commands to the snapshot string and persists the
     * changed parts through the ONE split-save (headless). Called once per
     * reply of the turn, each with the model that served THAT reply (row 93).
     */
    const applyCommandsFor = async (
      message: CanvasChatMessage,
      commands: readonly CanvasEditCommand[],
      writerModel: string,
    ): Promise<void> => {
      if (commands.length === 0) return;
      const applied = applyChatCommandsToSnapshot({
        commands,
        partPlan: result.parts.map((part) => ({ title: part.title })),
        doc,
      });
      doc = applied.doc;
      if (applied.docChanged) docChanged = true;
      if (applied.lastApplied !== null) lastApplied = applied.lastApplied;
      useCanvasChatStore.getState().updateMessage(options.key, message.id, {
        outcomes: [
          ...(useCanvasChatStore.getState().module(options.key).messages.find(
            (candidate) => candidate.id === message.id,
          )?.outcomes ?? []),
          ...applied.outcomes,
        ],
      });
      if (!applied.docChanged) return;
      const module = await getModule(options.moduleId);
      if (module === undefined) {
        throw new Error('Module no longer exists — the edits are still in the preview, switch to Edit and use Save to retry');
      }
      await saveWholeModuleDocument({
        moduleId: options.moduleId,
        doc,
        module,
        origin: 'ai',
        label: `Chat: ${text.slice(0, 60)}`,
        // Durable pre-change snapshot (docs/18 §2.3): preview-applied chat
        // edits have no CM history, so the snapshot is their undo.
        version: { source: 'chat', label: `Chat: ${text.slice(0, 60)}` },
        // PROVENANCE (docs/17 row 93): the chat model that wrote the applied
        // text — the SAME rule as the edit-mode controller (the preview path
        // persists through the one split-save).
        writerModel,
      });
    };
    await applyCommandsFor(assistantMessage, result.parse.commands, result.modelUsed);
    // --- the request round trip (docs/17 row 103) ---------------------------
    if (result.details !== null) {
      const followUpMessage = ensureFollowUpMessage();
      // What the follow-up turn answered, said exactly (the read half's copy for
      // a details-only turn, extended by the write half — row 104).
      const followed =
        result.changes === null
          ? 'your requested details'
          : result.details.answers.length > 0
            ? 'your requested details and changes'
            : 'your requested changes';
      if (result.details.status === 'failed') {
        useCanvasChatStore.getState().updateMessage(options.key, followUpMessage.id, {
          status: 'failed',
          text: followUpRaw === '' ? '' : chatProseSoFar(followUpRaw).prose,
          raw: followUpRaw === '' ? null : followUpRaw,
          error: `the follow-up reply after ${followed} failed: ${result.details.error}`,
        });
      } else {
        useCanvasChatStore.getState().updateMessage(options.key, followUpMessage.id, {
          status: 'ok',
          text: result.details.parse.prose,
          raw: result.details.raw,
        });
        await applyCommandsFor(followUpMessage, result.details.parse.commands, result.details.modelUsed);
        if (result.details.ignoredRequests.length > 0) {
          // One details round trip per message — named LOUDLY, never a silent
          // drop and never a third call.
          toastError(
            `The chat asked for artifact details a second time in one turn: ${result.details.ignoredRequests
              .map((request) => `«${request.name}»`)
              .join(', ')} — one details round trip is served per message, so it was NOT answered. Ask again in your next message to fetch it.`,
          );
        }
      }
    }
    // --- the change half's own loudness (docs/17 row 104) ---------------------
    // Each OUTCOME was reported to the owner the moment it settled (inside the
    // turn), never twice here; what is reported here is what the turn could not
    // do with them.
    if (result.changes !== null) {
      if (result.changes.status === 'failed') {
        toastError(
          `The chat's change results did not reach the model: ${result.changes.error} — the changes above still stand, but the model was NOT told about them, so check its next reply before letting it repeat a change.`,
        );
      } else if (result.changes.ignoredChanges.length > 0) {
        toastError(
          `The chat asked for another artifact change in the same turn: ${result.changes.ignoredChanges
            .map((change) => `«${change.name}»`)
            .join(', ')} — one change round trip is served per message and a change is a real generation, so NOTHING was changed for it. Ask again in your next message if you want it.`,
        );
      }
    }
    return { doc, docChanged, lastApplied };
  } catch (error) {
    if (streamRafRef.current !== null) cancelAnimationFrame(streamRafRef.current);
    if (followUpRafRef.current !== null) cancelAnimationFrame(followUpRafRef.current);
    if (options.turn.signal.aborted) {
      const { prose } = chatProseSoFar(latestRaw);
      useCanvasChatStore.getState().updateMessage(options.key, assistantMessage.id, {
        status: 'aborted',
        text: prose,
        error:
          'stopped — the reply was cut off and its edits were not applied (any artifact change already reported keeps its own notice)',
      });
      if (followUpMessageRef.current !== null) {
        useCanvasChatStore.getState().updateMessage(options.key, followUpMessageRef.current.id, {
          status: 'aborted',
          text: followUpRaw === '' ? '' : chatProseSoFar(followUpRaw).prose,
          error:
            'stopped — the reply after your requested details or changes was cut off and its edits were not applied (any artifact change already reported keeps its own notice)',
        });
      }
      return { doc: options.doc, docChanged: false, lastApplied: null };
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
      throw error;
    }
    return { doc: options.doc, docChanged: false, lastApplied: null };
  } finally {
    useCanvasChatStore.getState().setInFlight(options.key, false);
    scheduleChatPersist(options.moduleId, options.key);
  }
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
