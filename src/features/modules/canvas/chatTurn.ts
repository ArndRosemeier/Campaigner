import type { Id } from '@/domain';
import {
  NO_PARTS_MESSAGE,
  canvasChatChangeLabel,
  canvasChatThreadPersists,
  chatProseSoFar,
  isArtifactChange,
  sendCanvasChatMessage,
  type CanvasChatChangeOutcome,
  type CanvasChatFraming,
  type CanvasEditCommand,
} from '@/llm/canvasChat';
import { ModuleBusyError } from '@/llm/moduleGen';
import { getModule } from '@/db/moduleRepo';
import {
  newChatId,
  useCanvasChatStore,
  type CanvasChatMessage,
  type CanvasChatOutcome,
  type CanvasChatOutcomePart,
} from '@/features/modules/canvas/chatStore';
import {
  applyChatCommands,
  MAX_CARD_SNIPPET,
  type ChatDocumentHandle,
} from '@/features/modules/canvas/chatApply';
import {
  executeChatChange,
  reportChatChangeOutcome,
} from '@/features/modules/canvas/chatChanges';
import { saveWholeModuleDocument } from '@/features/modules/canvas/saveDoc';
import { scheduleChatPersist } from '@/features/modules/canvas/chatPersist';
import { toastError } from '@/lib/toast';

/**
 * ONE canvas chat turn controller (08-MODULE-DESIGNER §Module canvas chat):
 * send → stream → parse → apply → persist → thread, for EVERY canvas chat
 * surface.
 *
 * There are TWO axes of surface, and neither forks this flow. (1) The DOCUMENT:
 * the EDITOR (the live whole-document CM6 view, `chatController`) and the
 * PREVIEW SNAPSHOT STRING (the editor is unmounted in preview,
 * `snapshotChat`) — those were two ~87%-identical copies of this flow (266 of
 * 306 code lines verbatim), and unlike the applier pair they DID diverge — on
 * their failure paths (see below). The flow lives here once; the two modules
 * are thin surface wrappers that hand in a `ChatDocumentHandle`
 * (`chatApply.ts`) and a `ChatTurnSurface` naming where their unsaved edits
 * live. (2) The CHAT: the module co-editor and GM assist (docs/17 row 362),
 * which are the SAME turn over the SAME document with a different FRAMING
 * (`CanvasChatFraming`) and a different store key — one controller, one
 * applier, one busy registry, never a second pipeline.
 *
 * The turn owns: the LIVE document as the model's context (read at send time
 * through the handle — unsaved edits in EVERY part ride along), the streamed
 * prose bubble, command application AFTER the reply completes, the split-save
 * (`saveWholeModuleDocument` — only the parts whose text changed hit the row),
 * the report-to-LLM loop, the thread persist, and every loud failure surface.
 *
 * Loudness map (AGENTS 2):
 * - busy (`ModuleBusyError`) THROWS to the caller → page toast,
 * - parse failures / transport errors / a doc whose scaffolding no longer
 *   parses become a LOUD failed message card (error + Report-to-LLM button),
 * - a user abort marks the partial reply `aborted` in place — a stop is
 *   not an error, but nothing is applied and the card says so.
 *
 * THE REQUEST ROUND TRIP (docs/17 row 103): a reply carrying `<request>`
 * blocks makes the engine answer them from the stored rows and call the model
 * ONCE more in the same turn. That follow-up reply lands as its OWN assistant
 * message (its own bubble, its own outcomes, its own `writerModel` — one
 * provenance id per call, row 93) and its commands are applied as a SECOND
 * batch over the same document, in reply order. A follow-up that failed or did
 * not parse is a LOUD failed card and never touches the first reply's work; a
 * request made in the SECOND reply is not served and says so through
 * `toastError` (never a third call). The write half (`<change>`, row 104) is
 * wired identically on both surfaces: each outcome is reported to the owner
 * the moment it SETTLES, inside the turn.
 *
 * THE FAILURE-PATH DECISION (docs/17 row 150). The two copies disagreed about
 * what a failed turn leaves behind: the editor returned the LIVE document
 * (edits included) while the preview returned the PRE-TURN document with
 * `docChanged: false` — contradicting the preview's own refusal, which tells
 * the user "the edits are still in the preview, switch to Edit and use Save to
 * retry". The truthful reading is the one the user is TOLD: the applied edits
 * are in the document, so they are returned (`handle.read()`) and `docChanged`
 * reports that they are. The consequence at the preview surface is the
 * caller's existing one for a turn whose text is in the doc: the page mirrors
 * the document, exactly as it already did for a save whose PARTS failed (the
 * split-save toasts per part and continues, so a partially-persisted doc has
 * always been mirrored) — never a silent discard of what the card says is
 * still there.
 *
 * Persistence is two lanes: PART TEXT rides THE one part-text save path
 * (saveModulePartText, via saveWholeModuleDocument) — the chat never writes
 * part text directly — and the THREAD (messages + outcomes) persists on the
 * module row's `chatThread` field after every SETTLED turn (debounced via
 * `chatPersist.scheduleChatPersist`; a write failure toasts loudly but
 * never blocks chatting).
 */

export interface CanvasChatTurnResult {
  /** The document after the turn (the edits that ARE in it, applied or not). */
  doc: string;
  /** True when any command changed the document this turn. */
  docChanged: boolean;
  /** The LAST command's FIRST applied range in the returned doc (null when
   * nothing applied) — the last-replacement highlight. */
  lastApplied: { from: number; to: number } | null;
}

/**
 * What a surface says about ITSELF — only the places where the two chat
 * surfaces legitimately differ, so the divergence is data, not a second copy.
 */
export interface ChatTurnSurface {
  /** Where this surface holds chat edits the user can still see and save. */
  unsavedEditsLocation: string;
  /** The step that sentence tells the user to take, for THIS surface. */
  unsavedEditsRetryHint: string;
}

/** The editor surface (the canvas editor holds the doc and its CM history). */
export const EDITOR_TURN_SURFACE: ChatTurnSurface = {
  unsavedEditsLocation: 'the editor',
  unsavedEditsRetryHint: 'use Save to retry',
};

/** The preview surface (the snapshot string holds the doc; the editor is unmounted). */
export const PREVIEW_TURN_SURFACE: ChatTurnSurface = {
  unsavedEditsLocation: 'the preview',
  unsavedEditsRetryHint: 'switch to Edit and use Save to retry',
};

export interface CanvasChatTurnOptions {
  moduleId: Id;
  /**
   * The surface's chat key (`canvasChatKeyFor(moduleId, framing)`) — one
   * conversation per module per SURFACE (docs/17 row 362): the module chat and
   * GM assist never share a message.
   */
  key: string;
  /**
   * WHICH surface this turn is (docs/17 row 362). It decides the system
   * prompt's framing and whether the thread reaches the module row: the
   * GM-assist thread is SESSION-ONLY in this slice (slice 2 persists it), so
   * its key must never reach `scheduleChatPersist`, which would write it into
   * the module's ONE `chatThread` field — over the module chat's own history.
   */
  framing: CanvasChatFraming;
  /** Pre-flight: a module without planned parts must not send an empty
   * context (`llm/canvasChat.NO_PARTS_MESSAGE` — the ONE sentence, declared
   * beside the engine guard that raises it). */
  hasPlannedParts: boolean;
  /** THE document this turn works over: the live editor handle, or the
   * preview snapshot handle. Read at send time; applied through; the
   * post-turn doc is its `read()`. */
  handle: ChatDocumentHandle;
  /** Where this surface's unsaved edits live (the two-surface data above). */
  surface: ChatTurnSurface;
  /** The session model selection; null = Settings defaultChatModel. */
  modelSelection: string | null;
  /** The caller's per-turn controller — handed to the turn so Stop all can
   * reach this canvas generation (canvasBusy's abort registry). */
  turn: AbortController;
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
 * ONE adversarial review outcome as the chat's OUTCOME CARD (docs/17 row 360):
 * the critique's findings on top, the edit's before→after below — the SAME card
 * the `<edit>` commands render, so the review needs no second surface. A
 * `clean` review is the quiet success card: no edit, no write, and no claim
 * that anything changed.
 */
function adversarialReviewCard(
  outcome: CanvasChatChangeOutcome,
  parts: readonly { planIndex: number; title: string }[],
): CanvasChatOutcome {
  const change = outcome.change;
  const targetParts: CanvasChatOutcomePart[] = (() => {
    if (isArtifactChange(change) || change.adversarial.kind !== 'part') return [];
    const planIndex = change.adversarial.planIndex;
    const section = parts.find((part) => part.planIndex === planIndex);
    return section === undefined ? [] : [{ planIndex: section.planIndex, title: section.title }];
  })();
  const edit = outcome.edit;
  const command: CanvasEditCommand =
    edit === undefined
      ? { search: '', replace: '', all: false }
      : { search: edit.originalText, replace: edit.replacement, all: false };
  const base = {
    id: newChatId('outcome'),
    command,
    targetParts,
    closest: null,
    failureFrom: null,
    reported: false,
    findings: outcome.findings ?? [],
  };
  if (outcome.status === 'changed') {
    return {
      ...base,
      kind: 'applied',
      occurrences: 1,
      from: outcome.appliedToDocument?.from ?? null,
      to: outcome.appliedToDocument?.to ?? null,
      // The card's before→after is the review's own evidence: what the critic
      // read, and what the editor replaced it with.
      before: edit === undefined ? null : edit.originalText.slice(0, MAX_CARD_SNIPPET),
      reason: null,
    };
  }
  return {
    ...base,
    kind: outcome.status === 'clean' ? 'clean' : 'failed',
    occurrences: null,
    from: null,
    to: null,
    before: null,
    reason: outcome.detail,
  };
}

/**
 * Runs one chat turn. Throws BEFORE any message lands for pre-flight
 * guards (empty instruction / no planned parts) — those are the caller's
 * toasts. Everything after the user message lands becomes a message-card
 * outcome (see the loudness map above). Resolves with the post-turn document,
 * whether it changed, and the last applied range (the last-replacement
 * highlight; null when nothing applied).
 */
export async function runCanvasChatTurn(
  options: CanvasChatTurnOptions,
  instruction: string,
): Promise<CanvasChatTurnResult> {
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
  let docChanged = false;
  let lastApplied: { from: number; to: number } | null = null;
  try {
    // The LIVE whole-document doc — read at send time through the surface's
    // handle (never a cached copy, never re-assembled from the row). Unsaved
    // edits in every part ride the context.
    const document = options.handle.read();
    const result = await sendCanvasChatMessage({
      moduleId: options.moduleId,
      document,
      instruction: text,
      history,
      model: options.modelSelection ?? undefined,
      framing: options.framing,
      turn: options.turn,
      // THE WRITE HALF (docs/17 row 104): a `<change>` block runs the specialist
      // for the resolved row's kind through the ONE changeArtifact seam, and
      // each outcome is announced to the owner the moment it SETTLES — inside
      // the turn, not after it, so a later stop or failure can never hide a
      // change that already happened. The turn's OWN document handle rides
      // along (docs/17 row 360): an adversarial PART review applies its edit to
      // the document the owner is looking at, through the chat's one applier.
      executeChange: (change, context) => executeChatChange(change, context, options.handle),
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
    // Commands apply ONLY after the reply completed — never mid-stream.
    useCanvasChatStore.getState().updateMessage(options.key, assistantMessage.id, {
      status: 'ok',
      text: result.parse.prose,
      raw: result.raw,
    });
    /**
     * Persists the turn's document through THE one split-save: only the parts
     * whose text changed hit the row; a failed part save is a loud toast
     * naming the part (`saveWholeModuleDocument` fires it) while the rest
     * land — the doc keeps every in-doc edit either way. ONE save per settled
     * batch, whether the bytes came from `<edit>` commands or from an
     * adversarial part review's applied edit (docs/17 row 360).
     */
    const persistDoc = async (writerModel: string): Promise<void> => {
      const module = await getModule(options.moduleId);
      if (module === undefined) {
        throw new Error(
          `Module no longer exists — the edits are still in ${options.surface.unsavedEditsLocation}, ${options.surface.unsavedEditsRetryHint}`,
        );
      }
      await saveWholeModuleDocument({
        moduleId: options.moduleId,
        doc: options.handle.read(),
        module,
        origin: 'ai',
        label: `Chat: ${text.slice(0, 60)}`,
        // Durable pre-change snapshot (docs/18 §2.3): the whole document as
        // it stood before this batch — the simple undo for chat edits (the
        // preview surface's ONLY undo: it has no CM history).
        version: { source: 'chat', label: `Chat: ${text.slice(0, 60)}` },
        // PROVENANCE (docs/17 row 93): a chat-written passage belongs to the
        // CHAT model — the id the turn's own call reported (`modelUsed`),
        // which is the selected/session model or the escalation tier that
        // actually served the reply, never a settings lookup. Supplying it is
        // ALSO the machine-write signature the part write reads to stamp
        // `origin: 'model'` (row 113) — dropping it here would silently stamp
        // model text as the user's.
        writerModel,
      });
    };
    /**
     * Applies ONE reply's commands to the surface's document and persists the
     * changed parts through the ONE split-save. Called once per reply of the
     * turn (a request turn has two), each with the model that served THAT
     * reply — provenance is per call, never one id for two calls (row 93).
     */
    const applyCommandsFor = async (
      message: CanvasChatMessage,
      commands: readonly CanvasEditCommand[],
      writerModel: string,
    ): Promise<void> => {
      if (commands.length === 0) return;
      const applied = applyChatCommands({
        commands: [...commands],
        partPlan: result.parts.map((part) => ({ title: part.title })),
        handle: options.handle,
      });
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
      await persistDoc(writerModel);
    };
    // --- the adversarial reviews (docs/17 row 360) ---------------------------
    // Each review's CRITIQUE rides the assistant message as its OWN outcome
    // card — the owner asked for the review to SEE what the critic found — and
    // a part edit the executor already applied to the live document is flagged
    // here so the ONE split-save persists it and the highlight follows it. The
    // cards land BEFORE the edit batch below so the batch's outcome spread
    // keeps them.
    let adversarialDocApplied = false;
    if (result.changes !== null) {
      const reviews: CanvasChatOutcome[] = [];
      for (const outcome of result.changes.outcomes) {
        if (isArtifactChange(outcome.change)) continue;
        const card = adversarialReviewCard(outcome, result.parts);
        reviews.push(card);
        if (outcome.appliedToDocument !== undefined) {
          docChanged = true;
          adversarialDocApplied = true;
          lastApplied = outcome.appliedToDocument;
        }
      }
      if (reviews.length > 0) {
        useCanvasChatStore.getState().updateMessage(options.key, assistantMessage.id, {
          outcomes: [
            ...(useCanvasChatStore.getState().module(options.key).messages.find(
              (candidate) => candidate.id === assistantMessage.id,
            )?.outcomes ?? []),
            ...reviews,
          ],
        });
      }
    }
    await applyCommandsFor(assistantMessage, result.parse.commands, result.modelUsed);
    // A part review landed an edit and this reply carried no <edit> batch, so
    // nothing has persisted it yet: save it through the SAME split-save with
    // the EDITOR's own model (the text now in the doc was written by the pass's
    // editor, and provenance is never invented — row 93).
    if (adversarialDocApplied && result.parse.commands.length === 0) {
      const editorModel =
        result.changes?.outcomes.find((outcome) => outcome.appliedToDocument !== undefined)?.edit
          ?.modelUsed ?? result.modelUsed;
      await persistDoc(editorModel);
    }
    // --- the request round trip (docs/17 row 103) ---------------------------
    // Present ONLY when the reply carried a <request>: the app answered from
    // the stored rows and made exactly ONE further call. Its reply lands as
    // its OWN message and its commands apply as their OWN batch; a follow-up
    // that failed or did not parse is a LOUD failed card and never touches
    // the first reply's work.
    if (result.details !== null) {
      const followUpMessage = ensureFollowUpMessage();
      // What the follow-up turn answered, said exactly (the read half's copy
      // for a details-only turn, extended by the write half — row 104).
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
    // --- the change half's own loudness (docs/17 row 104) --------------------
    // Each OUTCOME was already reported to the owner the moment it settled
    // (`reportChatChangeOutcome`, called inside the turn) — never twice here.
    // What is reported HERE is what the turn could not do with them:
    if (result.changes !== null) {
      if (result.changes.status === 'failed') {
        // The results did not reach the model. Dangerous to leave silent: the
        // model does not know the change happened and may ask for it AGAIN.
        toastError(
          `The chat's change results did not reach the model: ${result.changes.error} — the changes above still stand, but the model was NOT told about them, so check its next reply before letting it repeat a change.`,
        );
      } else if (result.changes.ignoredChanges.length > 0) {
        // A change in the SECOND reply is NOT executed (one change round trip
        // per message) — named LOUDLY, never a silent drop and never a third
        // call. The owner must know nothing ran for it.
        toastError(
          `The chat asked for another artifact change in the same turn: ${result.changes.ignoredChanges
            .map((change) => canvasChatChangeLabel(change))
            .join(', ')} — one change round trip is served per message and a change is a real generation, so NOTHING was changed for it. Ask again in your next message if you want it.`,
        );
      }
    }
    return { doc: options.handle.read(), docChanged, lastApplied };
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
      // The doc that stands: whatever an EARLIER reply of this turn already
      // applied (and saved) is still in it — the cut-off reply's own edits
      // are not. `lastApplied` is dropped: the highlight belongs to a batch
      // the user just stopped.
      return { doc: options.handle.read(), docChanged, lastApplied: null };
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
    // THE TRUTHFUL FAILURE RETURN (docs/17 row 150): the refusal above told
    // the user the edits are still in this surface — so the document that
    // carries them IS the return value, and `docChanged` reports it. The
    // editor copy already did this; the preview copy returned the PRE-TURN
    // doc with `docChanged: false`, i.e. it discarded exactly what its own
    // sentence promised was still there.
    return { doc: options.handle.read(), docChanged, lastApplied: null };
  } finally {
    useCanvasChatStore.getState().setInFlight(options.key, false);
    // Write-after-settled-turn: the turn landed above as ok / failed /
    // aborted (or never landed for pre-flight throws — then the store is
    // unchanged and the writer is a no-op). Debounced; failures toast
    // loudly inside the writer and never reach the caller.
    //
    // ONLY the surface whose thread persists asks for it (docs/17 row 362):
    // the GM-assist thread is session-only in this slice, and `chatPersist`
    // writes whatever the store holds for the key into the module row's ONE
    // `chatThread` field — so a GM key reaching it would both persist a thread
    // this slice keeps session-only AND overwrite the module chat's history.
    if (canvasChatThreadPersists(options.framing)) {
      scheduleChatPersist(options.moduleId, options.key);
    }
  }
}
