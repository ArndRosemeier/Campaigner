import type { Id, ModuleChatRetryUndo } from '@/domain';
import { splitModuleDocument } from '@/domain';
import { getModule } from '@/db/moduleRepo';
import { getModuleVersion } from '@/db/moduleVersionRepo';
import { saveWholeModuleDocument } from '@/features/modules/canvas/saveDoc';
import {
  useCanvasChatStore,
  type CanvasChatMessage,
} from '@/features/modules/canvas/chatStore';

/**
 * THE chat RETRY seam (docs/17 row 408, 08-MODULE-DESIGNER §Module canvas
 * chat): what the Retry control on the LAST answer of a conversation asks, and
 * the ONE place that answers it.
 *
 * RETRY = UNDO THAT ANSWER, THEN ASK AGAIN. The owner's request was literally
 * *"a retry button in the AI chat for the last answer the LLM gave"*, and the
 * honest core of it is the UNDO: an answer that edited the document cannot
 * simply be asked again, because the old edits would still be applied and the
 * new reply would land on top of them (a double apply). So this module answers
 * three questions, each ONCE, for both chat surfaces (the module co-editor and
 * GM assist) and both views (the live editor and the preview snapshot):
 *
 * 1. **WHICH answer** — the LAST settled, non-advisor assistant message, with
 *    the user instruction it answered. Never a user message, never an advisor
 *    card, never a second-to-last answer (`chatRetryTarget`).
 * 2. **WHAT a retry would do** — undo the DOCUMENT (restore the durable
 *    pre-answer snapshot the turn itself took), or nothing at all when the
 *    answer changed nothing, or REFUSE when the answer changed something a
 *    retry cannot undo (`chatRetryPlan` → `chatRetryLabel` / the refusal).
 * 3. **THE UNDO ITSELF** — `performRetryUndo`: restore through the EXISTING
 *    restore write (`saveWholeModuleDocument` with `source: 'restore'`, which
 *    takes the pre-restore snapshot first, so the retry is itself undoable from
 *    the Versions menu), never a hand-rolled row write and never a skipped
 *    snapshot.
 *
 * WHY THE TURN RECORDS THE FACTS. The undo needs two things that cannot be
 * re-derived afterwards: which durable version the answer's changes were taken
 * against (a version row cannot be attributed to a turn by its label — several
 * turns share the label `Chat: …`) and what the document looked like once the
 * answer was done. Both are captured WHILE the turn runs and ride the answer
 * message as `retryUndo` (see `chatTurn`), persisted with the thread.
 *
 * THE STALENESS GATE (the honest half). A retry may only put the old text back
 * if the document is STILL exactly what that answer left: if the owner restored
 * an older version, edited by hand, or a later AI write moved it, restoring the
 * pre-answer snapshot could overwrite newer work. That check is a fingerprint
 * of the live document against the recorded one, and a mismatch REFUSES LOUDLY
 * with nothing written and nothing re-asked — the same idiom as the canvas's
 * `STALE_SELECTION_REASON` ("the document changed since …"), applied to an
 * answer instead of a selection. It is deliberately strict: "already undone by
 * other means" is also a mismatch, because the retry cannot know that the
 * difference is benign.
 */

/**
 * The answer a retry would replace: the LAST settled, non-advisor assistant
 * message, the instruction it answered, and every message the retry drops.
 */
export interface ChatRetryTarget {
  /** The conversation's store key (`canvasChatKeyFor(moduleId, framing)`). */
  readonly key: string;
  /**
   * The instruction to send again, VERBATIM from the user message that produced
   * the answer — the same bytes a first send carried, so the re-run is framed
   * and modelled exactly like the original (the caller passes the surface's own
   * model selection and framing, unchanged).
   */
  readonly instruction: string;
  /**
   * What the retry REMOVES from the thread: the user message AND the answer's
   * assistant messages. The re-send through the existing turn path re-adds the
   * user instruction verbatim, so the conversation ends with ONE instruction
   * and ONE answer — never an accumulating pile, never an orphaned question.
   * Advisor cards in the exchange are NOT in this list: a critique is not part
   * of the answer.
   */
  readonly messageIds: readonly string[];
  /** The message the Retry control renders on (the LAST answer of the turn). */
  readonly lastAnswer: CanvasChatMessage;
  /** What a retry must undo; `null` = the answer changed nothing. */
  readonly undo: ModuleChatRetryUndo | null;
}

/**
 * The ONE answer finder: the last settled non-advisor assistant message in a
 * conversation, plus the user instruction it answered. Returns `null` when the
 * conversation has no answer yet, no instruction before it, or the "answer" is
 * a streaming turn still in flight.
 */
export function chatRetryTarget(key: string): ChatRetryTarget | null {
  const messages = useCanvasChatStore.getState().module(key).messages;
  let answerIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message?.role === 'assistant' &&
      message.advisor == null &&
      message.status !== 'streaming'
    ) {
      answerIndex = index;
      break;
    }
  }
  if (answerIndex < 0) return null;
  let userIndex = -1;
  for (let index = answerIndex - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      userIndex = index;
      break;
    }
  }
  if (userIndex < 0) return null;
  const instruction = messages[userIndex]?.text ?? '';
  if (instruction.trim() === '') return null;
  const answer = messages[answerIndex];
  if (answer === undefined) return null;
  return {
    key,
    instruction,
    messageIds: messages
      .slice(userIndex, answerIndex + 1)
      .filter((message) => message.advisor == null)
      .map((message) => message.id),
    lastAnswer: answer,
    undo: answer.retryUndo ?? null,
  };
}

/**
 * What a retry of one answer will do, decided ONCE for the label and for the
 * click — so the sentence on the button and the act behind it cannot disagree.
 */
export interface ChatRetryPlan {
  /**
   * Non-null = the retry is REFUSED for this answer, in the owner's words.
   * The control is gated off with this reason, naming what a retry cannot undo.
   */
  readonly refusal: string | null;
  /**
   * TRUE when the retry puts the document back — the label MUST say so. A
   * retry that re-asked while the old edits stayed applied would double-apply,
   * and one that promised an undo it did not perform would lie.
   */
  readonly undoesDocument: boolean;
  /**
   * The level statements this answer wrote into entity records: they STAY
   * applied (no snapshot of a record's prior value exists), and the label says
   * so. Never a refusal — re-stating a level is an idempotent overwrite.
   */
  readonly keptStatements: readonly string[];
}

/** The refusal for an answer whose non-document changes a retry cannot undo. */
export function irreversibleRetryRefusal(changes: readonly string[]): string {
  return `Retry is not possible for this answer: it changed ${changes.join(', ')}, and a retry can only undo the campaign DOCUMENT. Re-asking would leave that change applied, so nothing was undone and nothing was asked again — undo it where it lives, then ask again in a new message.`;
}

export function chatRetryPlan(target: ChatRetryTarget): ChatRetryPlan {
  const undo = target.undo;
  if (undo !== null && undo.irreversible.length > 0) {
    return {
      refusal: irreversibleRetryRefusal(undo.irreversible),
      undoesDocument: false,
      keptStatements: undo.keptStatements,
    };
  }
  return {
    refusal: null,
    // `documentChanged` is what makes this claim true: an answer that only
    // stated a level (or changed a stored row) has a record but NO document to
    // put back, and its label must not promise an undo.
    undoesDocument: undo?.documentChanged === true,
    keptStatements: undo?.keptStatements ?? [],
  };
}

/**
 * The control's own words — and the ONE place a retry says what it will do.
 * The variants say exactly what the click does: the document is undone, or only
 * a record-level statement stays applied, or both. A plan that is refused has no
 * label — the control is gated off and `refusal` is the sentence the owner
 * reads.
 *
 * The statements are NAMED IN THE LABEL rather than in a `title`: a title on a
 * control a `BlockedControl` wraps is unreachable when the control is held and
 * is the second place a sentence can drift (`blocked-control-title-scan` pins
 * that rule with no allowance), and "which level did it state?" is exactly what
 * a wrong read must be able to correct. Three or more are capped to two names
 * plus a count, so one reply can never produce an unreadable button.
 */
export function chatRetryLabel(plan: ChatRetryPlan): string {
  const names = plan.keptStatements;
  const named =
    names.length <= 2
      ? names.join(', ')
      : `${names.slice(0, 2).join(', ')} and ${String(names.length - 2)} more`;
  const statements =
    names.length === 0 ? '' : `; ${named} stay${names.length === 1 ? 's' : ''} applied`;
  if (plan.undoesDocument) return `Retry (undoes the changes this answer made${statements})`;
  if (statements !== '') return `Retry (${statements.slice(2)})`;
  return 'Retry';
}

/**
 * The refusal a retry hits at CLICK time: the document is not what the answer
 * left (the owner restored an older version, edited by hand, or a later AI
 * write moved it). Same idiom as the canvas's stale-selection refusal, applied
 * to an answer — nothing is undone and nothing is re-asked.
 */
export const RETRY_STALE_REASON =
  'The document changed since that answer — retry would put back the text from before those changes, so nothing was undone and nothing was asked again. Use Versions if you want that older text.';

/** The refusal when the durable version a retry would restore no longer exists
 * (the saved versions were cleared): loudly named, nothing written. */
export const RETRY_VERSION_GONE_REASON =
  'The saved version this retry would restore is gone (this campaign’s saved versions were cleared) — nothing was undone and nothing was asked again.';

/**
 * The refusal for a surface that has no undo seam at all: the answer may be
 * perfectly retryable elsewhere, but HERE the app cannot put the document back,
 * and offering a live-looking Retry would be a control that can only refuse.
 * The control is gated off with this reason instead (docs/17 row 408).
 */
export const RETRY_UNAVAILABLE_REASON =
  'Retry is not available on this surface — the canvas cannot undo an answer here, so re-asking would leave its changes applied.';

/**
 * The document's identity as ONE string: its length plus two independent FNV-1a
 * 32-bit passes (different offsets and mixing constants), hex-joined. It
 * answers exactly one question — "is this the text that answer left behind?" —
 * for the staleness gate above. Two passes plus the length make an accidental
 * collision (which would let a retry restore over newer work) astronomically
 * unlikely; the check is a guard, not a security boundary, and the honest
 * failure is a refusal, never a silent overwrite.
 */
export function documentFingerprint(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ (code + index), 0x85ebca6b) >>> 0;
  }
  return `${String(text.length)}:${a.toString(16)}:${b.toString(16)}`;
}

/**
 * The live document a retry works over, and the ONE way it is put back: the
 * surface's own whole-document write. The editor adapter dispatches ONE
 * CodeMirror transaction (so the undo is one undo step, exactly like a chat
 * apply); the preview adapter advances the page's snapshot state. Both callers
 * keep the ROW and the live text in step (the row write happens in
 * `performRetryUndo` through the restore seam).
 */
export interface ChatRetrySurface {
  /** The whole document the owner is looking at right now. */
  read(): string;
  /** Replaces it with the restored text as ONE action. */
  write(text: string): void;
}

/** Thrown for every LOUD refusal of a retry; the caller toasts the message. */
export class ChatRetryRefusedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ChatRetryRefusedError';
  }
}

/**
 * UNDOES one answer's document changes, through the existing restore write.
 *
 * The order is deliberate and load-bearing:
 * 1. the STALENESS gate first (nothing has been touched if it refuses);
 * 2. the restored text resolved and VALIDATED (`documentFormat` and the
 *    parse) BEFORE any write — a version that cannot be read is refused
 *    loudly, never half-applied;
 * 3. the ROW write through `saveWholeModuleDocument` with `source: 'restore'`,
 *    which snapshots the text it is about to replace FIRST (docs/18 §2.3), so
 *    the undo is itself undoable from the Versions menu;
 * 4. only then the LIVE document is put back through the surface's own write,
 *    so a failed row write can never leave the editor and the campaign
 *    disagreeing.
 *
 * Returns the restored text, so a caller can mirror it (the preview page state
 * rides the same string).
 */
export async function performRetryUndo(input: {
  moduleId: Id;
  target: ChatRetryTarget;
  surface: ChatRetrySurface;
}): Promise<{ restored: string }> {
  const undo = input.target.undo;
  if (undo?.documentChanged !== true) return { restored: input.surface.read() };
  if (undo.irreversible.length > 0) {
    throw new ChatRetryRefusedError(irreversibleRetryRefusal(undo.irreversible));
  }
  const current = input.surface.read();
  if (documentFingerprint(current) !== undo.afterFingerprint) {
    throw new ChatRetryRefusedError(RETRY_STALE_REASON);
  }
  const restored = await resolveRetryDocument(input.moduleId, undo);
  const row = await getModule(input.moduleId);
  if (row === undefined) {
    throw new ChatRetryRefusedError(
      'This campaign no longer exists, so the answer could not be undone — nothing was changed.',
    );
  }
  const label = `Retry: undo the answer to “${input.target.instruction.slice(0, 60)}”`;
  await saveWholeModuleDocument({
    moduleId: input.moduleId,
    doc: restored,
    module: row,
    origin: 'ai',
    label,
    // THE EXISTING RESTORE WRITE (docs/18 §2.3): the same source the Versions
    // menu's restore lands with, which is what makes this undo appear in the
    // stack as a restore — and what makes the retry itself reversible.
    version: { source: 'restore', label },
  });
  input.surface.write(restored);
  return { restored };
}

/**
 * The text an answer's undo restores: the recorded durable version's document,
 * VALIDATED at this boundary (the same two refusals the Versions menu's restore
 * makes — a legacy `parts-document` entry and an unparseable one), or the EMPTY
 * document when the answer started from nothing.
 */
async function resolveRetryDocument(
  moduleId: Id,
  undo: ModuleChatRetryUndo,
): Promise<string> {
  if (undo.snapshotId === null) return '';
  const version = await getModuleVersion(undo.snapshotId);
  if (version === undefined) throw new ChatRetryRefusedError(RETRY_VERSION_GONE_REASON);
  if (version.moduleId !== moduleId) {
    throw new ChatRetryRefusedError(
      'The saved version this retry would restore belongs to another campaign module — nothing was undone and nothing was asked again.',
    );
  }
  if (version.documentFormat !== 'module-document') {
    throw new ChatRetryRefusedError(
      'The saved version this retry would restore was written in the old parts-document format, which is not the module document — restoring it would damage the campaign, so nothing was undone.',
    );
  }
  try {
    splitModuleDocument(version.docText);
  } catch (error) {
    throw new ChatRetryRefusedError(
      `The saved version this retry would restore no longer reads as a module document (${
        error instanceof Error ? error.message : String(error)
      }) — nothing was undone.`,
    );
  }
  return version.docText;
}
