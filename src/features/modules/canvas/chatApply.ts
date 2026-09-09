import type { EditorView } from '@codemirror/view';

import { splitPartsDocument, type ModulePartsSection } from '@/domain/modulePartsDocument';
import type { CanvasEditCommand } from '@/llm/canvasChat';
import { resolveCanvasEditAcrossParts } from '@/llm/canvasChat';
import { debrisIssuesForFields } from '@/lib/encodingHygiene';
import {
  newChatId,
  type CanvasChatOutcome,
  type CanvasChatOutcomePart,
} from '@/features/modules/canvas/chatStore';

/**
 * Chat command application onto the WHOLE-document editor (canvas v3,
 * 08-MODULE-DESIGNER §Module canvas chat): the canvas editor doc IS the
 * whole module's parts document, so every command — whatever part it
 * targets — lands as ONE CodeMirror 6 transaction over that doc with NORMAL
 * history (one undo step per command; a replace-all's ranges ride the same
 * transaction). Command matching is still PER PART
 * (`resolveCanvasEditAcrossParts` against the per-part texts) and
 * RE-RESOLVED PER COMMAND against the CURRENT doc — earlier commands in one
 * reply never shift later ranges (the split's section ranges are re-derived
 * from the live doc each time, so matched ranges map onto exact
 * whole-document coordinates and can never leak across a section boundary).
 * The caller persists the batch afterwards through the split-save (only the
 * parts whose text changed hit the row).
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

const MAX_CARD_SNIPPET = 280;

export interface ApplyChatCommandsResult {
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
 * Applies commands IN ORDER to the live whole-document editor; outcomes in
 * reply order, one per (command × part) application plus one per failure.
 * Each command re-splits the CURRENT doc against the plan and re-resolves
 * against those per-part texts, the canvasRefine-parity debris scan runs
 * per replace text, and `all="false"` demands EXACTLY ONE match across the
 * WHOLE module. A broken scaffolding mid-batch (a replace faked a section
 * header) throws `ModulePartsDocumentError` loud — the caller surfaces it;
 * the already-applied commands stay in the doc as unsaved edits.
 */
export function applyChatCommandsToDocument(input: {
  commands: readonly CanvasEditCommand[];
  /** The plan titles in order (position i IS planIndex i). */
  partPlan: readonly { title: string }[];
  view: EditorView;
}): ApplyChatCommandsResult {
  const { view } = input;
  const outcomes: CanvasChatOutcome[] = [];
  let docChanged = false;
  let lastApplied: { from: number; to: number } | null = null;

  /** Fresh per-part sections of the CURRENT doc (ranges included). */
  const currentSections = (): ModulePartsSection[] =>
    splitPartsDocument(view.state.doc.toString(), input.partPlan);

  for (const command of input.commands) {
    // Encoding-hygiene debris scan (canvasRefine parity): a hit fails the
    // command LOUDLY naming the debris — never silent repair.
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
      // Empty-part label-anchor fill: the label line was the only anchor —
      // the part's new text replaces its (empty) section range.
      const section = parts[resolution.partIndex];
      if (section === undefined) throw new Error('parts snapshot has no section for the fill target');
      const before = view.state.doc.sliceString(section.textFrom, section.textTo);
      view.dispatch({
        changes: { from: section.textFrom, to: section.textTo, insert: resolution.newText },
        userEvent: 'canvas.chat.apply',
      });
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
    const doc = view.state.doc.toString();
    // ONE transaction per command (all its part ranges together) — CM6
    // maps simultaneous changes atomically, so ranges computed against the
    // pre-dispatch doc are exact; normal history: one undo step reverts
    // the whole command. Ranges are non-overlapping, left-to-right.
    const changes: { from: number; to: number; insert: string }[] = [];
    const perPart: { section: ModulePartsSection; docRanges: { from: number; to: number }[]; before: string }[] = [];
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
      changes.push(...docRanges.map((range) => ({ from: range.from, to: range.to, insert: command.replace })));
    }
    view.dispatch({ changes, userEvent: 'canvas.chat.apply' });
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
