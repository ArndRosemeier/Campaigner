import type { EditorView } from '@codemirror/view';

import type { CanvasEditCommand, CanvasPartSnapshot } from '@/llm/canvasChat';
import { resolveCanvasEditAcrossParts } from '@/llm/canvasChat';
import { debrisIssuesForFields } from '@/lib/encodingHygiene';
import {
  newChatId,
  type CanvasChatOutcome,
  type CanvasChatOutcomePart,
} from '@/features/modules/canvas/chatStore';

/**
 * Chat command application across the WHOLE module (08-MODULE-DESIGNER
 * §Module canvas chat): each command is resolved PER PART (never across
 * the assembled string — a search spanning two parts cannot match) against
 * each part's CURRENT text, and applied where it matched:
 * - the OPEN part lands as ONE CodeMirror 6 transaction with NORMAL
 *   history — chat applies are NOT `addToHistory: false`; the user can
 *   undo the AI's edits one command at a time (a replace-all's ranges ride
 *   that ONE transaction, so one undo step reverts the whole command);
 * - OTHER parts are spliced in memory (there is no editor holding them) —
 *   the caller saves each changed part through THE one part-text save path
 *   BEFORE its outcomes render as applied ("save first, then report
 *   applied").
 * Nothing is ever silently skipped: a command that cannot apply uniquely
 * comes back as a LOUD failed outcome (with the closest candidate snippet
 * across parts on zero matches) — never a guess, never a partial apply
 * (AGENTS 1/2). Every outcome names the part(s) it targets.
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
  ranges: { from: number; to: number }[],
  before: string,
): CanvasChatOutcome {
  return {
    id: newChatId('outcome'),
    kind: 'applied',
    command,
    targetParts: [targetPart],
    occurrences: ranges.length,
    from: ranges[0]?.from ?? null,
    to: ranges[0]?.to ?? null,
    before,
    reason: null,
    closest: null,
    failureFrom: null,
    reported: false,
  };
}

const MAX_CARD_SNIPPET = 280;

/** Splices non-overlapping left-to-right ranges into the text (right first). */
function spliceRanges(text: string, ranges: { from: number; to: number }[], insert: string): string {
  let out = text;
  for (const range of [...ranges].sort((a, b) => b.from - a.from)) {
    out = out.slice(0, range.from) + insert + out.slice(range.to);
  }
  return out;
}

export interface AppliedPartEdit {
  partIndex: number;
  title: string;
  /** The part's full new text after all its splices — save this. */
  text: string;
}

export interface ApplyChatCommandsResult {
  outcomes: CanvasChatOutcome[];
  /** Non-open parts changed by this reply with their final text — the
   * caller saves each through saveModulePartText BEFORE rendering the
   * applied outcomes (a failed save flips that part's outcomes loud). */
  changedParts: AppliedPartEdit[];
  /** True when the OPEN part's CM6 doc changed (caller persists it through
   * the save seam with the live doc). */
  openPartChanged: boolean;
}

/**
 * Applies commands IN ORDER across the module's parts; outcomes in reply
 * order, one per (command × part) application plus one per failure. Each
 * command re-resolves against the part's CURRENT text (the open part's is
 * the live view doc — earlier commands in one reply never shift later
 * ranges), the canvasRefine-parity debris scan runs per replace text, and
 * `all="false"` demands EXACTLY ONE match across the WHOLE module.
 */
export function applyChatCommandsAcrossParts(input: {
  commands: readonly CanvasEditCommand[];
  /** The per-part snapshot EXACTLY as the model saw it. */
  parts: readonly CanvasPartSnapshot[];
  openPlanIndex: number;
  view: EditorView;
}): ApplyChatCommandsResult {
  const { view } = input;
  const openIndex = input.parts.findIndex((part) => part.planIndex === input.openPlanIndex);
  if (openIndex === -1) {
    throw new Error(`the open part ${String(input.openPlanIndex)} is not in the parts snapshot`);
  }
  // Working texts per part (open part mirrors the live view; others splice).
  const working: string[] = input.parts.map((part) => part.text);
  const changedParts = new Map<number, AppliedPartEdit>();
  const outcomes: CanvasChatOutcome[] = [];
  let openPartChanged = false;

  const partMeta = (partIndex: number): CanvasChatOutcomePart => ({
    planIndex: input.parts[partIndex]?.planIndex ?? partIndex,
    title: input.parts[partIndex]?.title ?? `Part ${String(partIndex + 1)}`,
  });
  /** Current text of a part: the open part is the LIVE view doc (it moves
   * under us as commands dispatch); others are the working splices. */
  const currentText = (partIndex: number): string =>
    partIndex === openIndex ? view.state.doc.toString() : (working[partIndex] ?? '');

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
    const resolution = resolveCanvasEditAcrossParts(
      command,
      input.parts.map((part, partIndex) => ({ ...part, text: currentText(partIndex) })),
    );
    if (resolution.status === 'none') {
      outcomes.push(
        failedOutcome(command, 'the search text does not appear in the current document', {
          closest: resolution.closest === '' ? null : resolution.closest.slice(0, MAX_CARD_SNIPPET),
          failureFrom: resolution.closestFrom,
          targetParts:
            resolution.closestPartIndex === null ? [] : [partMeta(resolution.closestPartIndex)],
        }),
      );
      continue;
    }
    if (resolution.status === 'fill-failed') {
      outcomes.push(failedOutcome(command, resolution.reason, {
        targetParts: [partMeta(resolution.partIndex)],
      }));
      continue;
    }
    if (resolution.status === 'filled') {
      // Empty-part label-anchor fill: the label line was the only anchor.
      const meta = partMeta(resolution.partIndex);
      if (resolution.partIndex === openIndex) {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.toString().length, insert: resolution.newText },
          userEvent: 'canvas.chat.apply',
        });
        openPartChanged = true;
      } else {
        working[resolution.partIndex] = resolution.newText;
        changedParts.set(resolution.partIndex, {
          partIndex: meta.planIndex,
          title: meta.title,
          text: resolution.newText,
        });
      }
      outcomes.push(
        appliedOutcome(command, meta, [{ from: 0, to: 0 }], ''),
      );
      continue;
    }
    // status 'found'.
    if (resolution.totalRanges > 1 && !command.all) {
      const first = resolution.matches[0];
      const firstRange = first?.ranges[0];
      outcomes.push(
        failedOutcome(
          command,
          `${String(resolution.totalRanges)} matches — add surrounding context to the search or set all="true"`,
          {
            failureFrom: firstRange?.from ?? null,
            targetParts: first === undefined ? [] : [partMeta(first.partIndex)],
          },
        ),
      );
      continue;
    }
    for (const match of resolution.matches) {
      const meta = partMeta(match.partIndex);
      if (match.partIndex === openIndex) {
        const doc = view.state.doc.toString();
        const before = doc.slice(match.ranges[0]?.from ?? 0, match.ranges[0]?.to ?? 0);
        // ONE transaction per command-part — normal history (undoable, one
        // undo step per command). Ranges are non-overlapping, left-to-right.
        view.dispatch({
          changes: match.ranges.map((range) => ({ from: range.from, to: range.to, insert: command.replace })),
          userEvent: 'canvas.chat.apply',
        });
        openPartChanged = true;
        outcomes.push(appliedOutcome(command, meta, match.ranges, before.slice(0, MAX_CARD_SNIPPET)));
      } else {
        const text = currentText(match.partIndex);
        const before = text.slice(match.ranges[0]?.from ?? 0, match.ranges[0]?.to ?? 0);
        const next = spliceRanges(text, match.ranges, command.replace);
        working[match.partIndex] = next;
        changedParts.set(match.partIndex, {
          partIndex: meta.planIndex,
          title: meta.title,
          text: next,
        });
        outcomes.push(appliedOutcome(command, meta, match.ranges, before.slice(0, MAX_CARD_SNIPPET)));
      }
    }
  }
  return { outcomes, changedParts: [...changedParts.values()], openPartChanged };
}
