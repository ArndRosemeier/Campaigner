import type { Id } from '@/domain';
import { splitPartsDocument, type ModulePartsSection } from '@/domain/modulePartsDocument';
import {
  chatProseSoFar,
  composeFailureReport,
  resolveCanvasEditAcrossParts,
  sendCanvasChatMessage,
  type CanvasEditCommand,
} from '@/llm/canvasChat';
import { ModuleBusyError } from '@/llm/moduleGen';
import { getModule } from '@/db/moduleRepo';
import { debrisIssuesForFields } from '@/lib/encodingHygiene';
import {
  newChatId,
  useCanvasChatStore,
  type CanvasChatMessage,
  type CanvasChatOutcome,
  type CanvasChatOutcomePart,
} from '@/features/modules/canvas/chatStore';
import { saveWholeModuleDocument } from '@/features/modules/canvas/saveDoc';
import { scheduleChatPersist } from '@/features/modules/canvas/chatPersist';
import { toastError } from '@/lib/toast';

/**
 * Chat command application onto the PREVIEW SNAPSHOT STRING (preview-default
 * arc, 08-MODULE-DESIGNER §Module canvas): the editor is unmounted while the
 * preview is open (v3 contract — never remounted hidden), so preview-applied
 * chat edits target the snapshot string the preview renders from instead of
 * a CM6 view. Matching rides the EXISTING per-part ladder
 * (`resolveCanvasEditAcrossParts` — no second matcher): each command
 * re-splits the CURRENT snapshot and re-resolves against those per-part
 * texts, so earlier commands in one reply never shift later ranges and a
 * replace faked as a section header fails the batch loudly through the
 * existing `ModulePartsDocumentError` path. Persistence rides the existing
 * split-save (`saveWholeModuleDocument` — headless row writes, no editor).
 *
 * DOCUMENTED CAVEAT (no undo): preview-applied edits have no CM history
 * while the editor is unmounted — they cannot be undone. Outcome cards are
 * unchanged (before→after still shown per command).
 */

function failedOutcome(command: CanvasEditCommand, reason: string, extra: {
  closest?: string | null;
  failureFrom?: number | null;
  targetParts?: CanvasChatOutcomePart[];
} = {}): CanvasChatOutcome {
  return {
    id: newChatId('outcome'),
    kind: 'failed',
    command,
    targetParts: extra.targetParts ?? [],
    occurrences: null,
    from: null,
    to: null,
    before: null,
    reason,
    closest: extra.closest ?? null,
    failureFrom: extra.failureFrom ?? null,
    reported: false,
  };
}

function appliedOutcome(
  command: CanvasEditCommand,
  targetPart: CanvasChatOutcomePart,
  occurrences: number,
  from: number | null,
  to: number | null,
  before: string,
): CanvasChatOutcome {
  return {
    id: newChatId('outcome'),
    kind: 'applied',
    command,
    targetParts: [targetPart],
    occurrences,
    from,
    to,
    before,
    reason: null,
    closest: null,
    failureFrom: null,
    reported: false,
  };
}

const MAX_CARD_SNIPPET = 280;

export interface SnapshotApplyResult {
  /** The snapshot after every command (=== input when nothing applied). */
  doc: string;
  outcomes: CanvasChatOutcome[];
  docChanged: boolean;
  /** The LAST command's FIRST applied range in POST-apply whole-document
   * coordinates (the last-replacement highlight) — null when nothing
   * applied. Valid in the returned doc (no later command shifts it). */
  lastApplied: { from: number; to: number } | null;
}

/**
 * Applies commands IN ORDER to a whole-document snapshot string; outcomes
 * in reply order, one per (command × part) application plus one per
 * failure. Semantics mirror `applyChatCommandsToDocument` (chatApply.ts):
 * the debris scan, the empty-search guard, per-part ladder resolution,
 * `all="false"` demanding exactly one match across the whole module, the
 * empty-part label-anchor fill, and loud failed outcomes (closest candidate
 * on zero matches) — never a guess, never a partial apply (AGENTS 1/2).
 * Outcome anchors are whole-document coordinates, same as the editor path.
 */
export function applyChatCommandsToSnapshot(input: {
  commands: readonly CanvasEditCommand[];
  /** The plan titles in order (position i IS planIndex i). */
  partPlan: readonly { title: string }[];
  /** The snapshot the model saw (send-time string). */
  doc: string;
}): SnapshotApplyResult {
  let doc = input.doc;
  const outcomes: CanvasChatOutcome[] = [];
  let docChanged = false;
  let lastApplied: { from: number; to: number } | null = null;

  /** Fresh per-part sections of the CURRENT snapshot (ranges included). */
  const currentSections = (): ModulePartsSection[] =>
    splitPartsDocument(doc, input.partPlan);

  /** Splices non-overlapping whole-doc ranges (left-to-right) with one insert. */
  const spliceRanges = (ranges: readonly { from: number; to: number }[], insert: string): void => {
    const ordered = [...ranges].sort((a, b) => b.from - a.from);
    for (const range of ordered) {
      doc = doc.slice(0, range.from) + insert + doc.slice(range.to);
    }
  };

  for (const command of input.commands) {
    const issues = debrisIssuesForFields([{ field: 'replace', text: command.replace }]);
    if (issues.length > 0) {
      outcomes.push(failedOutcome(command, `escape debris in the replace text — ${issues.join('; ')}`));
      continue;
    }
    if (command.search.trim() === '') {
      outcomes.push(
        failedOutcome(
          command,
          'the search text is empty — every command must copy the text it replaces from the current document',
        ),
      );
      continue;
    }
    const parts = currentSections();
    const resolution = resolveCanvasEditAcrossParts(command, parts);
    if (resolution.status === 'none') {
      const anchor =
        resolution.closestPartIndex === null ? undefined : parts[resolution.closestPartIndex];
      outcomes.push(
        failedOutcome(command, 'the search text does not appear in the current document', {
          closest: resolution.closest === '' ? null : resolution.closest.slice(0, MAX_CARD_SNIPPET),
          failureFrom:
            resolution.closestFrom === null || anchor === undefined
              ? null
              : anchor.textFrom + resolution.closestFrom,
          targetParts: anchor === undefined ? [] : [{ planIndex: anchor.planIndex, title: anchor.title }],
        }),
      );
      continue;
    }
    if (resolution.status === 'fill-failed') {
      const section = parts[resolution.partIndex];
      if (section === undefined) throw new Error('parts snapshot has no section for the fill target');
      outcomes.push(failedOutcome(command, resolution.reason, {
        targetParts: [{ planIndex: section.planIndex, title: section.title }],
      }));
      continue;
    }
    if (resolution.status === 'filled') {
      const section = parts[resolution.partIndex];
      if (section === undefined) throw new Error('parts snapshot has no section for the fill target');
      const before = doc.slice(section.textFrom, section.textTo);
      spliceRanges([{ from: section.textFrom, to: section.textTo }], resolution.newText);
      docChanged = true;
      lastApplied = { from: section.textFrom, to: section.textFrom + resolution.newText.length };
      outcomes.push(
        appliedOutcome(
          command,
          { planIndex: section.planIndex, title: section.title },
          1,
          section.textFrom,
          section.textTo,
          before.slice(0, MAX_CARD_SNIPPET),
        ),
      );
      continue;
    }
    // status 'found'.
    if (resolution.totalRanges > 1 && !command.all) {
      const first = resolution.matches[0];
      const firstSection = first === undefined ? undefined : parts[first.partIndex];
      const firstRange = first?.ranges[0];
      outcomes.push(
        failedOutcome(
          command,
          `${String(resolution.totalRanges)} matches — add surrounding context to the search or set all="true"`,
          {
            failureFrom:
              firstSection === undefined || firstRange === undefined
                ? null
                : firstSection.textFrom + firstRange.from,
            targetParts:
              firstSection === undefined
                ? []
                : [{ planIndex: firstSection.planIndex, title: firstSection.title }],
          },
        ),
      );
      continue;
    }
    const docRanges: { from: number; to: number }[] = [];
    const perPart: { section: ModulePartsSection; ranges: { from: number; to: number }[]; before: string }[] = [];
    for (const match of resolution.matches) {
      const section = parts[match.partIndex];
      if (section === undefined) throw new Error('parts snapshot has no section for a match');
      const ranges = match.ranges.map((range) => ({
        from: section.textFrom + range.from,
        to: section.textFrom + range.to,
      }));
      perPart.push({
        section,
        ranges,
        before: doc.slice(ranges[0]?.from ?? 0, ranges[0]?.to ?? 0),
      });
      docRanges.push(...ranges);
    }
    spliceRanges(docRanges, command.replace);
    docChanged = true;
    const firstRange = perPart[0]?.ranges[0];
    if (firstRange !== undefined) {
      lastApplied = { from: firstRange.from, to: firstRange.from + command.replace.length };
    }
    for (const applied of perPart) {
      outcomes.push(
        appliedOutcome(
          command,
          { planIndex: applied.section.planIndex, title: applied.section.title },
          applied.ranges.length,
          applied.ranges[0]?.from ?? null,
          applied.ranges[0]?.to ?? null,
          applied.before.slice(0, MAX_CARD_SNIPPET),
        ),
      );
    }
  }
  return { doc, outcomes, docChanged, lastApplied };
}

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
    throw new Error('no parts to chat about — generate the module first');
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
    return { doc, docChanged, lastApplied };
  } catch (error) {
    if (streamRafRef.current !== null) cancelAnimationFrame(streamRafRef.current);
    if (followUpRafRef.current !== null) cancelAnimationFrame(followUpRafRef.current);
    if (options.turn.signal.aborted) {
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
