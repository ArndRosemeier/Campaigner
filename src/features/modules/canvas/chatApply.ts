import type { EditorView } from '@codemirror/view';

import type { CanvasEditCommand } from '@/llm/canvasChat';
import { resolveCanvasEdit } from '@/llm/canvasChat';
import { debrisIssuesForFields } from '@/lib/encodingHygiene';
import { newChatId, type CanvasChatOutcome } from '@/features/modules/canvas/chatStore';

/**
 * Chat command application (08-MODULE-DESIGNER §Module canvas chat): each
 * applied command is ONE CodeMirror 6 transaction with NORMAL history —
 * chat applies are NOT `addToHistory: false`; the user must be able to
 * undo the AI's edits one command at a time (a replace-all's multiple
 * ranges ride that ONE transaction, so one undo step reverts the whole
 * command). Nothing is ever silently skipped: a command that cannot apply
 * uniquely comes back as a LOUD failed outcome (with the closest candidate
 * snippet on zero matches) — never a guess, never a partial apply
 * (AGENTS 1/2).
 */

/** Undo an applied command looks like any other doc edit (normal history). */

function failedOutcome(command: CanvasEditCommand, reason: string, extra: {
  closest?: string | null;
  failureFrom?: number | null;
} = {}): CanvasChatOutcome {
  return {
    id: newChatId('outcome'),
    kind: 'failed',
    command,
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

function appliedOutcome(command: CanvasEditCommand, ranges: { from: number; to: number }[], before: string): CanvasChatOutcome {
  return {
    id: newChatId('outcome'),
    kind: 'applied',
    command,
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

/** Applies ONE command against the view's CURRENT doc; returns the outcome. */
export function applyChatCommandToView(view: EditorView, command: CanvasEditCommand): CanvasChatOutcome {
  const doc = view.state.doc.toString();
  // Encoding-hygiene debris scan (canvasRefine parity): a hit fails the
  // command LOUDLY naming the debris — never silent repair.
  const issues = debrisIssuesForFields([{ field: 'replace', text: command.replace }]);
  if (issues.length > 0) {
    return failedOutcome(command, `escape debris in the replace text — ${issues.join('; ')}`);
  }
  if (command.search.trim() === '') {
    return failedOutcome(command, 'the search text is empty — every command must copy the text it replaces from the current document');
  }
  const resolution = resolveCanvasEdit(doc, command.search);
  if (resolution.status === 'none') {
    return failedOutcome(command, 'the search text does not appear in the current document', {
      closest: resolution.closest === '' ? null : resolution.closest.slice(0, MAX_CARD_SNIPPET),
      failureFrom: resolution.closestFrom,
    });
  }
  if (resolution.ranges.length > 1 && !command.all) {
    return failedOutcome(
      command,
      `${String(resolution.ranges.length)} matches — add surrounding context to the search or set all="true"`,
      { failureFrom: resolution.ranges[0]?.from ?? null },
    );
  }
  const before = doc.slice(resolution.ranges[0]?.from ?? 0, resolution.ranges[0]?.to ?? 0);
  // ONE transaction per command — normal history (undoable, one undo step
  // per command). Ranges are non-overlapping and left-to-right.
  view.dispatch({
    changes: resolution.ranges.map((range) => ({ from: range.from, to: range.to, insert: command.replace })),
    userEvent: 'canvas.chat.apply',
  });
  return appliedOutcome(command, resolution.ranges, before.slice(0, MAX_CARD_SNIPPET));
}

/** Applies commands IN ORDER against the live doc; outcomes in reply order. */
export function applyChatCommandsToView(view: EditorView, commands: readonly CanvasEditCommand[]): CanvasChatOutcome[] {
  return commands.map((command) => applyChatCommandToView(view, command));
}
