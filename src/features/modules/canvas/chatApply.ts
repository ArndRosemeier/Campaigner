import type { EditorView } from '@codemirror/view';

import {
  appendLevelText,
  moduleDocumentSections,
  ModuleDocumentError,
  replaceLevelText,
  splitModuleDocument,
  type ModuleDocumentEdit,
  type ModuleDocumentSection,
} from '@/domain/moduleDocument';
import {
  isLevelEditCommand,
  isLevelStatementCommand,
  resolveCanvasEditAcrossParts,
  type CanvasEditCommand,
  type CanvasLevelEditCommand,
} from '@/llm/canvasChat';
import { generatedTextScanForFields } from '@/llm/generatedTextHygiene';
import {
  newChatId,
  type CanvasChatOutcome,
  type CanvasChatOutcomePart,
} from '@/features/modules/canvas/chatStore';

/**
 * THE chat-command applier (canvas v3, 08-MODULE-DESIGNER §Module canvas
 * chat): ONE algorithm over an injected DOCUMENT HANDLE, plus the two handles
 * the two chat surfaces need.
 *
 * The canvas has TWO places a chat batch lands, and they are the same
 * algorithm over different documents:
 *
 * - the whole-document EDITOR (the canvas editor doc IS the module's parts
 *   document) — `applyChatCommandsToDocument` over `editorChatHandle(view)`;
 * - the PREVIEW SNAPSHOT STRING (the editor is unmounted in preview, the
 *   default view) — `applyChatCommandsToSnapshot` over `stringChatHandle(doc)`.
 *
 * These were TWO byte-identical copies once (86% of one file verbatim; the
 * preview copy even said so: "Semantics mirror `applyChatCommandsToDocument`
 * (chatApply.ts)"). A measured 3000-case differential fuzz found ZERO
 * divergences, which is exactly why the duplication was pure risk: nothing
 * failed when a copy was born, and nothing would fail when a copy drifts. The
 * applier is ONE function now (`applyChatCommands`) and the two entry points
 * are ~5-line ADAPTERS over it (there is no second implementation to drift).
 * The differential pin that obliges this seam (AGENTS §Centralization item 2)
 * is `tests/features/canvas-chat-apply-differential.test.tsx`, which runs BOTH
 * entry points over one input table and requires identical document text and
 * identical outcome fields.
 *
 * Whatever the handle, the semantics are the editor's, unchanged: command
 * matching stays PER LEVEL SECTION (`resolveCanvasEditAcrossParts` against
 * the per-level texts) and RE-RESOLVED PER COMMAND against the CURRENT
 * document — earlier commands in one reply never shift later ranges (the
 * parse's section ranges are re-derived from the live doc each time, so
 * matched ranges map onto exact whole-document coordinates and can never leak
 * across a section boundary). The caller persists the batch afterwards through
 * the document save (one whole-document write).
 *
 * THE LEVEL-ADDRESSED COMMANDS (docs/17 row 381) ride the SAME applier and the
 * SAME command array. They are adapted here and the EDIT itself is the landed
 * domain seam's (`replaceLevelText`/`appendLevelText` — the level-0 acceptance,
 * the `max + 1` creation rule, the separator formatter and the
 * separator-lookalike refusal all live there); this file only splices the seam's
 * returned text through the handle and renders its outcome. A refused target is
 * the SEAM'S OWN typed `ModuleDocumentError`, converted to a FAILED outcome
 * card naming the reason — the same per-command loudness as a search that does
 * not match, so the other commands in the batch still land.
 *
 * Nothing is ever silently skipped: a command that cannot apply uniquely
 * comes back as a LOUD failed outcome (with the closest candidate snippet
 * across parts on zero matches) — never a guess, never a partial apply
 * (AGENTS 1/2). Every outcome names the part(s) it targets; outcome anchors
 * (`from`/`to`/`failureFrom`) are whole-document coordinates.
 */

export function failedOutcome(command: CanvasEditCommand, reason: string, extra: {
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

export function appliedOutcome(
  command: CanvasEditCommand,
  targetPart: CanvasChatOutcomePart,
  occurrences: number,
  from: number | null,
  to: number | null,
  before: string | null,
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

/** How much of a replaced/candidate span an outcome card shows. */
export const MAX_CARD_SNIPPET = 280;

/**
 * The document the applier works over — the ONE seam between the algorithm
 * and the two surfaces. `read()` is called per command (the doc MOVES between
 * commands), and `replaceRanges` is the surface's single write: the WHOLE
 * command lands as ONE user action, never one action per range.
 */
export interface ChatDocumentHandle {
  /** The whole-document text right now. */
  read(): string;
  /**
   * Replaces every (non-overlapping) whole-document range with `insert`, as
   * ONE user action. The editor adapter dispatches ONE CodeMirror transaction
   * (which is what makes a replace-all one undo step — a real `undo(view)`
   * reverts the whole command, pinned in tests/features/canvas-chat.test.tsx);
   * the string adapter splices from the END backwards, so every earlier
   * offset stays valid.
   */
  replaceRanges(ranges: readonly { from: number; to: number }[], insert: string): void;
}

/** The editor handle: ONE transaction per `replaceRanges` call, normal history. */
export function editorChatHandle(view: EditorView): ChatDocumentHandle {
  return {
    read: () => view.state.doc.toString(),
    replaceRanges: (ranges, insert) => {
      // ONE transaction per command (all its part ranges together) — CM6
      // maps simultaneous changes atomically, so ranges computed against the
      // pre-dispatch doc are exact; normal history: one undo step reverts
      // the whole command. Ranges are non-overlapping, left-to-right.
      view.dispatch({
        changes: [...ranges]
          .sort((a, b) => a.from - b.from)
          .map((range) => ({ from: range.from, to: range.to, insert })),
        userEvent: 'canvas.chat.apply',
      });
    },
  };
}

/** The string handle: pure splices, plus the document they produced. */
export interface ChatStringHandle extends ChatDocumentHandle {
  /** The text after every `replaceRanges` call (=== the input when nothing applied). */
  text(): string;
}

export function stringChatHandle(doc: string): ChatStringHandle {
  let current = doc;
  return {
    read: () => current,
    replaceRanges: (ranges, insert) => {
      // Backwards: splicing the last range first keeps every earlier offset
      // valid, so the result is the same document the editor's atomic
      // transaction produces.
      for (const range of [...ranges].sort((a, b) => b.from - a.from)) {
        current = current.slice(0, range.from) + insert + current.slice(range.to);
      }
    },
    text: () => current,
  };
}

export interface ChatApplyResult {
  outcomes: CanvasChatOutcome[];
  /** True when any command changed the doc (caller persists via the
   * document save; only the levels whose text changed hit the row). */
  docChanged: boolean;
  /** The LAST command's FIRST applied range in POST-apply whole-document
   * coordinates (the last-replacement highlight) — null when nothing
   * applied. A replace writes `command.replace` over the matched span, so
   * the new text is `[from, from + replace.length)`; a fill writes
   * `newText` at the section start. Valid in the doc as of the last
   * command (no later command shifts it). */
  lastApplied: { from: number; to: number } | null;
}

/**
 * ONE level-addressed command through the LANDED domain seam (docs/17 row
 * 381). The applier owns nothing of the edit: `domain/moduleDocument` parses
 * the current text and `replaceLevelText`/`appendLevelText` perform it (level 0
 * is the premise, creation is exactly `max + 1`, the separator is the APP's own
 * formatter, and a body carrying a header-shaped line is refused there). This
 * function adapts their result to the handle and to the outcome card, and
 * converts the seam's typed refusal into a FAILED outcome:
 *
 * - the seam THROWS before writing anything, so a refused target leaves the
 *   document BYTE-IDENTICAL and the owner gets a card whose reason is the
 *   seam's own message (which levels exist, or which level is the next one it
 *   can take) — LOUD and named, never a silently dropped command;
 * - an accepted edit is written as ONE splice of the whole document, because
 *   the seam returns the edited TEXT (with its own parse beside it): that text
 *   IS the command's single user action, and re-deriving a smaller range here
 *   would be a second implementation of the edit.
 *
 * The card names the LEVEL it touched (`planIndex` is level − 1, so level 0
 * reads as the premise) and carries the level's new text range in post-apply
 * coordinates as the last-replacement highlight. `before` is the level's prior
 * text for a `replace_level` (the span that was replaced) and `null` for an
 * append or a creation (nothing was replaced — the text was ADDED).
 */
function applyLevelCommand(
  command: CanvasLevelEditCommand,
  handle: ChatDocumentHandle,
  planTitles: readonly { title: string }[],
): { outcomes: CanvasChatOutcome[]; lastApplied: { from: number; to: number } | null } {
  const before = handle.read();
  let edit: ModuleDocumentEdit;
  try {
    const document = splitModuleDocument(before);
    edit =
      command.kind === 'replace_level'
        ? replaceLevelText(document, command.level, command.replace)
        : appendLevelText(document, command.level, command.replace);
  } catch (error) {
    if (!(error instanceof ModuleDocumentError)) throw error;
    return { outcomes: [failedOutcome(command, error.message)], lastApplied: null };
  }
  handle.replaceRanges([{ from: 0, to: before.length }], edit.document);
  const section = moduleDocumentSections(edit.document, planTitles).find(
    (candidate) => candidate.number === command.level,
  );
  if (section === undefined) {
    // An accepted level edit always leaves the level in the document (the seam
    // creates it at `max + 1`); a miss here is an internal inconsistency and is
    // never papered over.
    throw new Error(
      `the module document seam accepted level ${String(command.level)} but the edited document carries no such section`,
    );
  }
  const previous = moduleDocumentSections(before, planTitles).find(
    (candidate) => candidate.number === command.level,
  );
  return {
    outcomes: [
      appliedOutcome(
        command,
        { planIndex: section.planIndex, title: section.title },
        1,
        section.textFrom,
        section.textTo,
        command.kind === 'replace_level'
          ? (previous?.text ?? '').slice(0, MAX_CARD_SNIPPET)
          : null,
      ),
    ],
    lastApplied: { from: section.textFrom, to: section.textTo },
  };
}

/**
 * Applies commands IN ORDER to the handle's document; outcomes in reply
 * order, one per (command × part) application plus one per failure. Each
 * command re-splits the CURRENT doc against the plan and re-resolves against
 * those per-part texts, the canvasRefine-parity debris scan runs per replace
 * text, and `all="false"` demands EXACTLY ONE match across the WHOLE module.
 * A broken scaffolding mid-batch (a replace faked a section header) throws
 * `ModuleDocumentError` loud — the caller surfaces it; the already-applied
 * commands stay in the doc as unsaved edits.
 */
export function applyChatCommands(input: {
  commands: readonly CanvasEditCommand[];
  /** The plan titles in order (position i IS planIndex i). */
  partPlan: readonly { title: string }[];
  handle: ChatDocumentHandle;
}): ChatApplyResult {
  const { handle } = input;
  const outcomes: CanvasChatOutcome[] = [];
  let docChanged = false;
  let lastApplied: { from: number; to: number } | null = null;

  /** Fresh per-level sections of the CURRENT doc (ranges included). */
  const currentSections = (): ModuleDocumentSection[] =>
    moduleDocumentSections(handle.read(), input.partPlan);

  for (const command of input.commands) {
    // A LEVEL STATEMENT (docs/17 row 401) edits no document text: it is a RECORD
    // write, made by `levelStatements.applyLevelStatements` for the same batch.
    // This applier never sees it as an edit, so the document stays byte-identical.
    if (isLevelStatementCommand(command)) continue;
    // Generated-text hygiene scan (canvasRefine parity): escape debris OR our
    // own prompt scaffolding echoed back fails the command LOUDLY, named —
    // never silent repair (docs/17 row 142).
    const { issues } = generatedTextScanForFields([{ field: 'replace', text: command.replace }]);
    if (issues.length > 0) {
      outcomes.push(
        failedOutcome(command, `unusable generated text in the replace text — ${issues.join('; ')}`),
      );
      continue;
    }
    // The two level-addressed commands (docs/17 row 381): the same scan above
    // already checked their text, and the LANDED domain seam performs the edit.
    if (isLevelEditCommand(command)) {
      const levelResult = applyLevelCommand(command, handle, input.partPlan);
      outcomes.push(...levelResult.outcomes);
      if (levelResult.outcomes.some((outcome) => outcome.kind === 'applied')) docChanged = true;
      if (levelResult.lastApplied !== null) lastApplied = levelResult.lastApplied;
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
      if (section === undefined) throw new Error('level snapshot has no section for the fill target');
      outcomes.push(failedOutcome(command, resolution.reason, {
        targetParts: [{ planIndex: section.planIndex, title: section.title }],
      }));
      continue;
    }
    if (resolution.status === 'filled') {
      // Empty-part label-anchor fill: the label line was the only anchor —
      // the level's new text replaces its (empty) section range.
      const section = parts[resolution.partIndex];
      if (section === undefined) throw new Error('level snapshot has no section for the fill target');
      const before = handle.read().slice(section.textFrom, section.textTo);
      handle.replaceRanges([{ from: section.textFrom, to: section.textTo }], resolution.newText);
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
    const doc = handle.read();
    const ranges: { from: number; to: number }[] = [];
    const perPart: {
      section: ModuleDocumentSection;
      docRanges: { from: number; to: number }[];
      before: string;
    }[] = [];
    for (const match of resolution.matches) {
      const section = parts[match.partIndex];
      if (section === undefined) throw new Error('level snapshot has no section for a match');
      const docRanges = match.ranges.map((range) => ({
        from: section.textFrom + range.from,
        to: section.textFrom + range.to,
      }));
      perPart.push({
        section,
        docRanges,
        before: doc.slice(docRanges[0]?.from ?? 0, docRanges[0]?.to ?? 0),
      });
      ranges.push(...docRanges);
    }
    handle.replaceRanges(ranges, command.replace);
    docChanged = true;
    const firstRange = perPart[0]?.docRanges[0];
    if (firstRange !== undefined) {
      lastApplied = { from: firstRange.from, to: firstRange.from + command.replace.length };
    }
    for (const applied of perPart) {
      outcomes.push(
        appliedOutcome(
          command,
          { planIndex: applied.section.planIndex, title: applied.section.title },
          applied.docRanges.length,
          applied.docRanges[0]?.from ?? null,
          applied.docRanges[0]?.to ?? null,
          applied.before.slice(0, MAX_CARD_SNIPPET),
        ),
      );
    }
  }
  return { outcomes, docChanged, lastApplied };
}

/** `applyChatCommands` with the result type the editor callers use. */
export type ApplyChatCommandsResult = ChatApplyResult;

/**
 * The EDITOR entry point: applies commands to the live whole-document editor
 * through the one applier. Kept as a named function (rather than making every
 * caller build a handle) because it IS the shape the canvas page and the chat
 * controller speak.
 */
export function applyChatCommandsToDocument(input: {
  commands: readonly CanvasEditCommand[];
  /** The plan titles in order (position i IS planIndex i). */
  partPlan: readonly { title: string }[];
  view: EditorView;
}): ApplyChatCommandsResult {
  return applyChatCommands({
    commands: input.commands,
    partPlan: input.partPlan,
    handle: editorChatHandle(input.view),
  });
}

export interface SnapshotApplyResult extends ChatApplyResult {
  /** The snapshot after every command (=== input when nothing applied). */
  doc: string;
}

/**
 * The PREVIEW entry point: the SAME applier over a snapshot string (no
 * view — the editor is unmounted while the preview is open, by contract) and
 * pure splices. Semantics are the editor's by construction, not by mirroring.
 */
export function applyChatCommandsToSnapshot(input: {
  commands: readonly CanvasEditCommand[];
  /** The plan titles in order (position i IS planIndex i). */
  partPlan: readonly { title: string }[];
  /** The snapshot the model saw (send-time string). */
  doc: string;
}): SnapshotApplyResult {
  const handle = stringChatHandle(input.doc);
  const applied = applyChatCommands({
    commands: input.commands,
    partPlan: input.partPlan,
    handle,
  });
  return { doc: handle.text(), ...applied };
}
