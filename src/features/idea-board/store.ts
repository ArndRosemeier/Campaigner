import { create } from 'zustand';

import { stampNewEntity } from '@/domain/entity';
import type { IdeaBoard, IdeaBoardPatch } from '@/domain/ideaBoard';
import { getIdeaBoard, saveIdeaBoard } from '@/db/ideaBoardRepo';
import { refineIdeaBoard } from '@/llm/ideaBoard';
import { errorMessage } from '@/lib/errors';
import { registerPageFlush } from '@/lib/pageFlush';
import { useProgressStore } from '@/lib/progress';
import { toastError } from '@/lib/toast';

/**
 * Idea Board session state (`docs/21-IDEA-BOARD.md`): ONE app-level plain-text
 * document plus its refinement conversation, both persisted on the single
 * `ideaBoards` row.
 *
 * The module is a SESSION view over a durable row, deliberately: the editor
 * types into `board` (never into the row) and `flushIdeaBoard` writes the
 * snapshot back, so
 *
 * - typing during a refinement request is never clobbered by the reply
 *   (accepting a suggestion snapshots the CURRENT draft into `versions`, and
 *   the text the model saw is not assumed to be the text on screen), and
 * - a FAILED write keeps the draft in memory with its reason, instead of
 *   dropping work the owner can still copy (the retry control re-flushes).
 *
 * A refinement never writes the document by itself: the reply lands as a
 * `proposal` the owner explicitly accepts (`replaceIdeaDocument`), which is
 * the only path that changes `board.document` from model output.
 */

interface IdeaBoardState {
  /** The live draft (the editor's value) — null until the row loads. */
  board: IdeaBoard | null;
  /** The last row we know is on disk (the save's compare-and-swap base). */
  saved: IdeaBoard | null;
  /** Why the last load or save failed, humanized; null = healthy. */
  error: string | null;
  loading: boolean;
  saving: boolean;
  /** One refinement request is in flight (drives Stop and the dock job). */
  busy: boolean;
  /** A model-authored replacement awaiting the owner's accept/discard. */
  proposal: { document: string; modelUsed: string | null } | null;
}

const IDLE: IdeaBoardState = {
  board: null,
  saved: null,
  error: null,
  loading: false,
  saving: false,
  busy: false,
  proposal: null,
};

export const useIdeaBoard = create<IdeaBoardState>(() => ({ ...IDLE }));

/** The one in-flight request (the board owns a single generation at a time). */
let controller: AbortController | null = null;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

/** Loads the single board row, creating it on first open. */
export async function loadIdeaBoard(): Promise<void> {
  const { board, loading } = useIdeaBoard.getState();
  // A session already holding a draft never re-reads the row: that would
  // discard unsaved edits (the retry control is the only re-entry, and it
  // runs only while `board` is still null).
  if (board !== null || loading) return;
  useIdeaBoard.setState({ loading: true, error: null });
  try {
    const loaded = await getIdeaBoard();
    useIdeaBoard.setState({ board: loaded, saved: loaded });
  } catch (error) {
    useIdeaBoard.setState({ error: errorMessage(error) });
    toastError('Could not load the Idea Board', error);
  } finally {
    useIdeaBoard.setState({ loading: false });
  }
}

/** Applies a draft edit and schedules the debounced write. */
export function editIdeaBoard(patch: IdeaBoardPatch): void {
  const { board } = useIdeaBoard.getState();
  if (board === null) throw new Error('The Idea Board is not loaded yet.');
  useIdeaBoard.setState({ board: { ...board, ...patch } });
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushIdeaBoard, 500);
}

/**
 * Writes the draft when it differs from the last saved row. The draft is kept
 * on failure with a loud reason — there is deliberately NO automatic retry
 * loop, because the compare-and-swap refuses a row another tab changed and a
 * loop would report that refusal forever.
 */
export function flushIdeaBoard(): void {
  clearTimeout(saveTimer);
  const { board, saved, saving } = useIdeaBoard.getState();
  if (board === null || saved === null || board === saved || saving) return;
  useIdeaBoard.setState({ saving: true });
  void saveIdeaBoard(board, saved)
    .then((next) => {
      const current = useIdeaBoard.getState().board;
      // A save that settles while the owner typed keeps the newer draft; the
      // next debounce writes it.
      useIdeaBoard.setState({
        saved: next,
        board: current === board ? next : current,
        saving: false,
        error: null,
      });
      flushIdeaBoard();
    })
    .catch((error: unknown) => {
      useIdeaBoard.setState({ saving: false, error: errorMessage(error) });
      toastError('The Idea Board was not saved — your draft is kept, retry saving', error);
    });
}

/**
 * Registers the page's flushes for ONE mount: the debounced write is
 * flushed when the page goes away (`lib/pageFlush`), and an in-flight
 * refinement is stopped on unmount so it cannot land on a torn-down view.
 */
export function watchIdeaBoard(): () => void {
  const unregister = registerPageFlush(flushIdeaBoard);
  return () => {
    unregister();
    flushIdeaBoard();
    stopIdeaBoard();
  };
}

/** Stops the in-flight refinement; false when there was none (Stop all's count). */
export function stopIdeaBoard(): boolean {
  if (controller === null) return false;
  controller.abort();
  return true;
}

/** Drops a pending suggestion without touching the document. */
export function discardIdeaProposal(): void {
  useIdeaBoard.setState({ proposal: null });
}

/**
 * Clears the board's CONVERSATION — the Idea Board's Clear-chat control
 * (docs/21 §The chat's controls; docs/18 §2.3): the persisted transcript on
 * the row goes to `[]` through the SAME `saveIdeaBoard` compare-and-swap the
 * debounced writer uses (no second persistence path), and only THEN is the
 * live store's transcript emptied.
 *
 * Order is load-bearing, exactly as in the canvas chat's clear
 * (`features/modules/canvas/clearChat.clearModuleChat`): THE ROW GOES FIRST,
 * awaited. The persisted transcript is the half that survives a reload, so a
 * failure there ABORTS the whole clear — the throw propagates, the caller
 * `toastError`s and NOTHING is cleared. Emptying the store first would leave
 * the row holding the old conversation while the screen showed none, and the
 * next board open would restore it whole.
 *
 * Two deliberate details:
 * - a pending debounced `flushIdeaBoard` is CANCELLED first, because its
 *   trailing fire would re-serialize the pre-clear board (transcript AND
 *   document) and put the cleared conversation straight back on the row;
 * - the write carries the LIVE draft, not the last saved row, so unsaved
 *   typing at the moment of the clear survives it.
 *
 * What this does NOT touch (the dialog copy states it): the board's `document`
 * and its `versions` (Previous drafts). The document is the owner's writing —
 * content, not conversation — and Previous drafts is the board's own record of
 * MODEL writes; neither is chat state, so the clear is never an undo. The
 * pending `proposal` is likewise left alone: it is a suggestion about the
 * document, not a message.
 *
 * Deliberately NOT folded onto the canvas seam: `clearPersistedChatThread` is
 * module-row/field-keyed (`patchModule(moduleId, { chatThread: [] })`), while a
 * board has no module id and its one write is a WHOLE-ROW compare-and-swap on
 * the single `ideaBoards` row. A shared parameterisation of those two
 * mechanisms would be vague, so the honest split is: same persistence SEAM
 * (`saveIdeaBoard`), different clear ORCHESTRATION (this store owns every slice
 * of its own state; `clearModuleChat` spans three canvas stores).
 */
export async function clearIdeaBoardChat(): Promise<void> {
  clearTimeout(saveTimer);
  const { board, saved } = useIdeaBoard.getState();
  if (board === null || saved === null) throw new Error('The Idea Board is not loaded yet.');
  const cleared: IdeaBoard = { ...board, messages: [] };
  const next = await saveIdeaBoard(cleared, saved);
  const current = useIdeaBoard.getState().board;
  useIdeaBoard.setState({
    // A save that settles while the owner typed keeps the newer draft (the
    // `flushIdeaBoard` rule), with the transcript still cleared.
    board: current === null || current === board ? next : { ...current, messages: [] },
    saved: next,
    error: null,
  });
}

/**
 * Runs one refinement turn: the owner's instruction is recorded FIRST (so a
 * failed or stopped turn never discards what they typed — the module chat's
 * rule), the model is grounded on the document and conversation AS OF SEND
 * TIME, and the reply lands as an accept-or-discard proposal.
 */
export async function sendIdeaBoard(instruction: string): Promise<void> {
  const text = instruction.trim();
  const { board, busy } = useIdeaBoard.getState();
  if (board === null || busy || text === '') return;
  const active = new AbortController();
  controller = active;
  editIdeaBoard({
    messages: [
      ...board.messages,
      { ...stampNewEntity(), role: 'user', text, modelUsed: null },
    ],
  });
  useIdeaBoard.setState({ busy: true, proposal: null });
  useProgressStore.getState().start('idea-board', 'Idea Board', 'Writing a reply…');
  try {
    // `board` is the pre-send snapshot: the transcript already carries the
    // instruction, so passing the live state would send it twice.
    const reply = await refineIdeaBoard(board, text, active.signal);
    if (active.signal.aborted) return;
    const current = useIdeaBoard.getState().board;
    if (current === null) {
      throw new Error('The Idea Board closed before its reply could be recorded.');
    }
    editIdeaBoard({
      messages: [
        ...current.messages,
        { ...stampNewEntity(), role: 'assistant', text: reply.reply, modelUsed: reply.modelUsed },
      ],
    });
    useIdeaBoard.setState({
      proposal:
        reply.document === null ? null : { document: reply.document, modelUsed: reply.modelUsed },
    });
    flushIdeaBoard();
  } catch (error) {
    // A stop is not a failure (the caller's own Stop, or the app-level sweep).
    if (!active.signal.aborted) toastError('The Idea Board reply failed', error);
  } finally {
    controller = null;
    useIdeaBoard.setState({ busy: false });
    useProgressStore.getState().finish('idea-board');
  }
}

/**
 * Accepts a model-authored document (or restores an earlier draft): the
 * CURRENT draft is snapshotted into `versions` first, so the text replaced
 * here — including edits typed while the request ran — is always recoverable.
 */
export function replaceIdeaDocument(document: string, modelUsed: string | null): void {
  const { board } = useIdeaBoard.getState();
  if (board === null) throw new Error('The Idea Board is not loaded yet.');
  editIdeaBoard({
    document,
    modelUsed,
    versions: [
      ...board.versions,
      { ...stampNewEntity(), document: board.document, modelUsed: board.modelUsed },
    ],
  });
  useIdeaBoard.setState({ proposal: null });
  flushIdeaBoard();
}
