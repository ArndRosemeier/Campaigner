import type { EditorView } from '@codemirror/view';

import { splitPartsDocument, type ModulePartsSection } from '@/domain/modulePartsDocument';
import type { CanvasEditCommand } from '@/llm/canvasChat';
import { resolveCanvasEditAcrossParts } from '@/llm/canvasChat';
import { generatedTextIssuesForFields } from '@/llm/generatedTextHygiene';
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
 * matching stays PER PART (`resolveCanvasEditAcrossParts` against the
 * per-part texts) and RE-RESOLVED PER COMMAND against the CURRENT document —
 * earlier commands in one reply never shift later ranges (the split's section
 * ranges are re-derived from the live doc each time, so matched ranges map
 * onto exact whole-document coordinates and can never leak across a section
 * boundary). The caller persists the batch afterwards through the split-save
 * (only the parts whose text changed hit the row).
 *
 * Nothing is ever silently skipped: a command that cannot apply uniquely
 * comes back as a LOUD failed outcome (with the closest candidate snippet
 * across parts on zero matches) — never a guess, never a partial apply
 * (AGENTS 1/2). Every outcome names the part(s) it targets; outcome anchors
 * (`from`/`to`/`failureFrom`) are whole-document coordinates.
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
   * split-save; unchanged parts never hit the row). */
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
 * Applies commands IN ORDER to the handle's document; outcomes in reply
 * order, one per (command × part) application plus one per failure. Each
 * command re-splits the CURRENT doc against the plan and re-resolves against
 * those per-part texts, the canvasRefine-parity debris scan runs per replace
 * text, and `all="false"` demands EXACTLY ONE match across the WHOLE module.
 * A broken scaffolding mid-batch (a replace faked a section header) throws
 * `ModulePartsDocumentError` loud — the caller surfaces it; the already-
 * applied commands stay in the doc as unsaved edits.
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

  /** Fresh per-part sections of the CURRENT doc (ranges included). */
  const currentSections = (): ModulePartsSection[] =>
    splitPartsDocument(handle.read(), input.partPlan);

  for (const command of input.commands) {
    // Generated-text hygiene scan (canvasRefine parity): escape debris OR our
    // own prompt scaffolding echoed back fails the command LOUDLY, named —
    // never silent repair (docs/17 row 142).
    const issues = generatedTextIssuesForFields([{ field: 'replace', text: command.replace }]);
    if (issues.length > 0) {
      outcomes.push(
        failedOutcome(command, `unusable generated text in the replace text — ${issues.join('; ')}`),
      );
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
      // Empty-part label-anchor fill: the label line was the only anchor —
      // the part's new text replaces its (empty) section range.
      const section = parts[resolution.partIndex];
      if (section === undefined) throw new Error('parts snapshot has no section for the fill target');
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
      section: ModulePartsSection;
      docRanges: { from: number; to: number }[];
      before: string;
    }[] = [];
    for (const match of resolution.matches) {
      const section = parts[match.partIndex];
      if (section === undefined) throw new Error('parts snapshot has no section for a match');
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
