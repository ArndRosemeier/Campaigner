import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { saveIdeaBoard } from '@/db/ideaBoardRepo';
import { newIdeaBoard, type IdeaBoard } from '@/domain/ideaBoard';
import { stampNewEntity } from '@/domain/entity';
import { IdeaBoardPage } from '@/features/idea-board/IdeaBoardPage';
import { flushIdeaBoard, stopIdeaBoard, useIdeaBoard } from '@/features/idea-board/store';
import { refineIdeaBoard } from '@/llm/ideaBoard';
import { copyText } from '@/lib/clipboard';
import { toastError, toastSuccess } from '@/lib/toast';

vi.mock('@/db/ideaBoardRepo', () => ({ getIdeaBoard: vi.fn(), saveIdeaBoard: vi.fn() }));
vi.mock('@/llm/ideaBoard', () => ({ refineIdeaBoard: vi.fn() }));
vi.mock('@/lib/clipboard', () => ({ copyText: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));
// The editor is CodeMirror in the app; jsdom drives a plain textarea through
// the same `value`/`onChange` contract, and the board's document semantics
// (no wiki parsing, no markdown) are the thing under test here. The theme and
// height props ride through to the DOM so the owner-reported WHITE SLAB and
// the collapsed-height defect stay pinned (jsdom computes no CSS, so the prop
// IS the evidence — the `canvasThemeSpec` precedent).
vi.mock('@uiw/react-codemirror', async () => {
  // Imported INSIDE the factory: `vi.mock` is hoisted above the file's imports.
  const { ideaBoardEditorExtensions } = await import('@/features/idea-board/editor');
  return {
    default: ({
      value,
      onChange,
      theme,
      height,
      extensions,
    }: {
      value: string;
      onChange: (value: string) => void;
      theme?: string;
      height?: string;
      extensions?: unknown;
    }) => (
      <textarea
        aria-label="Idea Board document"
        data-theme={theme}
        data-height={height}
        data-extensions={extensions === ideaBoardEditorExtensions ? 'seam' : 'other'}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    ),
  };
});

function deferredRefinement(): (value: {
  reply: string;
  document: string | null;
  modelUsed: string;
}) => void {
  let resolve!: (value: { reply: string; document: string | null; modelUsed: string }) => void;
  vi.mocked(refineIdeaBoard).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  return (value) => {
    resolve(value);
  };
}

/**
 * The row the mocked persistence seam has on "disk". The board's repo is mocked
 * at the boundary (`getIdeaBoard`/`saveIdeaBoard`), so THIS is the stored row
 * the reload-survival pins assert against — never just the store.
 */
let persistedRow: IdeaBoard;

/** A board carrying a conversation AND content (the non-vacuity base). */
function seededBoard(): IdeaBoard {
  return {
    ...newIdeaBoard(),
    document: "The owner's ideas — [[literal]]",
    messages: [
      { ...stampNewEntity(), role: 'user', text: 'Talk this through', modelUsed: null },
      { ...stampNewEntity(), role: 'assistant', text: 'Here is a thought', modelUsed: 'test/model' },
    ],
    versions: [{ ...stampNewEntity(), document: 'An earlier idea', modelUsed: null }],
    model: 'board/model',
  };
}

/** Mounts the page over a board with that exact stored row. */
function seedBoard(board: IdeaBoard): void {
  persistedRow = board;
  useIdeaBoard.setState({
    board,
    saved: board,
    busy: false,
    loading: false,
    saving: false,
    error: null,
    proposal: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  seedBoard(newIdeaBoard());
  vi.mocked(saveIdeaBoard).mockImplementation((next) => {
    persistedRow = next;
    return Promise.resolve(next);
  });
  vi.mocked(copyText).mockResolvedValue();
});

afterEach(async () => {
  stopIdeaBoard();
  await act(async () => {
    flushIdeaBoard();
    await Promise.resolve();
  });
});

it('keeps typing during a request, previews replacements, and restores the accepted-over draft', async () => {
  const resolve = deferredRefinement();
  render(<IdeaBoardPage />);
  fireEvent.change(screen.getByLabelText('Idea Board document'), {
    target: { value: 'Original [[literal]]' },
  });
  fireEvent.change(screen.getByLabelText('Message to Idea Board'), {
    target: { value: 'Improve this' },
  });
  fireEvent.click(screen.getByText('Send'));
  // Typing while the model thinks is the owner's text, never the model's to
  // overwrite: the reply only ever becomes a suggestion.
  fireEvent.change(screen.getByLabelText('Idea Board document'), {
    target: { value: 'Typed while thinking' },
  });
  await act(async () => {
    resolve({ reply: 'Here is a draft.', document: 'Suggested text', modelUsed: 'actual/model' });
    await Promise.resolve();
  });
  expect(screen.getByLabelText('Idea Board document')).toHaveValue('Typed while thinking');
  await act(async () => {
    fireEvent.click(screen.getByText('Accept replacement'));
    await Promise.resolve();
  });
  expect(screen.getByLabelText('Idea Board document')).toHaveValue('Suggested text');
  expect(useIdeaBoard.getState().board?.messages).toHaveLength(2);
  await act(async () => {
    fireEvent.click(screen.getByText('Restore this draft'));
    await Promise.resolve();
  });
  expect(screen.getByLabelText('Idea Board document')).toHaveValue('Typed while thinking');
});

it('retains a failed-save draft and retries without clearing the text', async () => {
  vi.mocked(saveIdeaBoard).mockRejectedValueOnce(new Error('disk full'));
  render(<IdeaBoardPage />);
  fireEvent.change(screen.getByLabelText('Idea Board document'), {
    target: { value: 'Keep this draft' },
  });
  await act(async () => {
    flushIdeaBoard();
    await Promise.resolve();
  });
  expect(screen.getByRole('alert')).toHaveTextContent('disk full');
  expect(screen.getByLabelText('Idea Board document')).toHaveValue('Keep this draft');
  fireEvent.click(screen.getByText('Retry saving'));
  await waitFor(() => {
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

it('stops a late reply without applying it, but never discards the typed instruction', async () => {
  const resolve = deferredRefinement();
  render(<IdeaBoardPage />);
  fireEvent.change(screen.getByLabelText('Message to Idea Board'), {
    target: { value: 'Write something' },
  });
  fireEvent.click(screen.getByText('Send'));
  fireEvent.click(screen.getByText('Stop'));
  await act(async () => {
    resolve({ reply: 'Late', document: 'Late text', modelUsed: 'model' });
    await Promise.resolve();
  });
  const messages = useIdeaBoard.getState().board?.messages ?? [];
  // The instruction the owner typed is kept (module-chat parity); the LATENESS
  // is not — no reply is recorded, nothing is proposed, nothing is applied.
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ role: 'user', text: 'Write something' });
  expect(useIdeaBoard.getState().proposal).toBeNull();
  expect(screen.queryByText('Accept replacement')).toBeNull();
  expect(screen.getByLabelText('Idea Board document')).toHaveValue('');
});

it('keeps the instruction and toasts loudly when the reply fails', async () => {
  vi.mocked(refineIdeaBoard).mockRejectedValueOnce(new Error('API failed'));
  render(<IdeaBoardPage />);
  fireEvent.change(screen.getByLabelText('Message to Idea Board'), {
    target: { value: 'Draft the letter' },
  });
  fireEvent.click(screen.getByText('Send'));
  await waitFor(() => {
    expect(toastError).toHaveBeenCalledWith('The Idea Board reply failed', expect.any(Error));
  });
  const messages = useIdeaBoard.getState().board?.messages ?? [];
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ role: 'user', text: 'Draft the letter' });
  expect(useIdeaBoard.getState().proposal).toBeNull();
});

it('mounts the editor on the app theme and fills its column (the owner-reported white slab)', () => {
  render(<IdeaBoardPage />);
  const editor = screen.getByLabelText('Idea Board document');
  // `theme="none"` hands ALL colors to `plainEditorTheme` (app CSS vars); left
  // unset, @uiw's default LIGHT chrome paints a white slab on the dark app.
  expect(editor).toHaveAttribute('data-theme', 'none');
  // The editor is wired to THE seam, not to a private copy of the extension
  // list (identity, so a second set reds here rather than drifting).
  expect(editor).toHaveAttribute('data-extensions', 'seam');
  // The editor fills the box it is given…
  expect(editor).toHaveAttribute('data-height', '100%');
  // …and the box gets a real height: the page root must be `h-full`, because
  // the shell's <main> is a plain block (a `flex-1` root resolves to nothing
  // and the board sat at its floor height, wasting the viewport).
  const root = screen.getByRole('main', { name: 'Idea Board' });
  expect(root.className).toContain('h-full');
  expect(root.className).not.toContain('flex-1');
  // …and the surface it fills has a visible edge. `--card` and `--background`
  // are the SAME pure white in light mode, so the app's Card ring (not the
  // near-invisible `--border`) is what keeps it from reading as one big blank
  // square on a blank page.
  const surface = screen.getByTestId('idea-board-surface');
  expect(surface.className).toContain('bg-card');
  expect(surface.className).toContain('ring-1');
  expect(surface.className).toContain('flex-1');
});

it('copies the document through the one clipboard seam and reports an unavailable clipboard', async () => {
  render(<IdeaBoardPage />);
  fireEvent.change(screen.getByLabelText('Idea Board document'), {
    target: { value: 'Copy [[me]] literally' },
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId('idea-board-copy'));
    await Promise.resolve();
  });
  expect(copyText).toHaveBeenCalledWith('Copy [[me]] literally');
  expect(toastSuccess).toHaveBeenCalledWith('Document copied to the clipboard');

  vi.mocked(copyText).mockRejectedValueOnce(new Error('Clipboard API is unavailable here'));
  await act(async () => {
    fireEvent.click(screen.getByTestId('idea-board-copy'));
    await Promise.resolve();
  });
  expect(toastError).toHaveBeenCalledWith(
    'Could not copy — select the text and copy it manually',
    expect.any(Error),
  );
});

/**
 * Clear chat (docs/21 §The chat's controls; docs/18 §2.3): ONE action returns
 * the board's CONVERSATION to a pristine state — the live transcript and the
 * persisted transcript on the row — while the board's DOCUMENT and Previous
 * drafts are content, not conversation, and survive byte-unchanged.
 */
const CLEARED_TOAST = 'Chat cleared — the board document was not changed';

it('offers a Clear chat control in the chat surface, and its dialog states the boundary', async () => {
  render(<IdeaBoardPage />);
  const chat = screen.getByTestId('idea-board-chat');
  // The accessible label names what it does, and the control lives INSIDE the
  // board's conversation column (not on the header bar, not on the document).
  const clear = within(chat).getByRole('button', { name: 'Clear chat' });
  expect(clear).toHaveAttribute('data-testid', 'idea-board-clear');

  fireEvent.click(clear);
  const description = await screen.findByTestId('idea-board-clear-description');
  // The boundary is unmistakable in the copy: what goes, and what stays.
  expect(description.textContent).toContain('saved conversation on the board');
  expect(description.textContent).toContain('NOT cleared');
  expect(description.textContent).toContain('DOCUMENT');
  expect(description.textContent).toContain('Previous drafts');
  expect(description.textContent).toContain('content, not conversation');
  expect(description.textContent).toContain('not an undo');
});

it('cancelling clears NOTHING — the store AND the persisted row are unchanged', async () => {
  seedBoard(seededBoard());
  render(<IdeaBoardPage />);
  fireEvent.click(screen.getByTestId('idea-board-clear'));
  await screen.findByTestId('idea-board-clear-dialog');
  fireEvent.click(screen.getByTestId('idea-board-clear-cancel'));
  await waitFor(() => {
    expect(screen.queryByTestId('idea-board-clear-dialog')).toBeNull();
  });
  // A dialog that clears on OPEN (the classic bug here) reds both lines.
  expect(useIdeaBoard.getState().board?.messages).toHaveLength(2);
  expect(persistedRow.messages).toHaveLength(2);
  expect(saveIdeaBoard).not.toHaveBeenCalled();
});

it('confirming empties the conversation in memory AND on the persisted row, surviving a later flush', async () => {
  const seeded = seededBoard();
  seedBoard(seeded);
  render(<IdeaBoardPage />);
  fireEvent.click(screen.getByTestId('idea-board-clear'));
  fireEvent.click(await screen.findByTestId('idea-board-clear-confirm'));
  await waitFor(() => {
    expect(useIdeaBoard.getState().board?.messages).toEqual([]);
  });
  // The UI is back to its front door…
  expect(within(screen.getByTestId('idea-board-chat')).getByText('Nothing asked yet.')).toBeInTheDocument();
  // …and the half that survives a reload is cleared too: the ROW write carried
  // `messages: []` against the snapshot the session loaded.
  expect(persistedRow.messages).toEqual([]);
  expect(saveIdeaBoard).toHaveBeenCalledWith(expect.objectContaining({ messages: [] }), seeded);
  // The cancelled debounce can never re-serialize the cleared conversation.
  await act(async () => {
    flushIdeaBoard();
    await Promise.resolve();
  });
  expect(persistedRow.messages).toEqual([]);
  expect(toastSuccess).toHaveBeenCalledWith(CLEARED_TOAST);
});

it('leaves the board DOCUMENT and Previous drafts byte-unchanged (a clear that wipes the board reds)', async () => {
  const seeded = seededBoard();
  seedBoard(seeded);
  render(<IdeaBoardPage />);
  fireEvent.click(screen.getByTestId('idea-board-clear'));
  fireEvent.click(await screen.findByTestId('idea-board-clear-confirm'));
  await waitFor(() => {
    expect(useIdeaBoard.getState().board?.messages).toEqual([]);
  });
  const after = useIdeaBoard.getState().board;
  // Content, not conversation: the writing and its drafts are the same bytes.
  expect(after?.document).toBe(seeded.document);
  expect(after?.versions).toEqual(seeded.versions);
  expect(after?.model).toBe(seeded.model);
  expect(persistedRow.document).toBe(seeded.document);
  expect(persistedRow.versions).toEqual(seeded.versions);
});

it('a failed clear write is LOUD and leaves the conversation intact', async () => {
  const seeded = seededBoard();
  seedBoard(seeded);
  render(<IdeaBoardPage />);
  vi.mocked(saveIdeaBoard).mockRejectedValueOnce(new Error('disk full'));
  fireEvent.click(screen.getByTestId('idea-board-clear'));
  fireEvent.click(await screen.findByTestId('idea-board-clear-confirm'));
  await waitFor(() => {
    expect(toastError).toHaveBeenCalledWith(
      'Could not clear the chat — nothing was cleared; the saved conversation is still on the board',
      expect.any(Error),
    );
  });
  // Row first, AWAITED: the rejected write aborted the whole action, so the
  // store was never emptied and the row still holds the old thread.
  expect(useIdeaBoard.getState().board?.messages).toHaveLength(2);
  expect(persistedRow.messages).toHaveLength(2);
  expect(toastSuccess).not.toHaveBeenCalled();
});

it('refuses LOUDLY while a refinement reply is in flight — nothing is cleared', async () => {
  const resolve = deferredRefinement();
  seedBoard(seededBoard());
  render(<IdeaBoardPage />);
  fireEvent.change(screen.getByLabelText('Message to Idea Board'), {
    target: { value: 'Keep going' },
  });
  fireEvent.click(screen.getByText('Send'));
  expect(useIdeaBoard.getState().busy).toBe(true);

  fireEvent.click(screen.getByTestId('idea-board-clear'));
  fireEvent.click(await screen.findByTestId('idea-board-clear-confirm'));
  await waitFor(() => {
    expect(toastError).toHaveBeenCalledWith(
      'A reply is still in flight — stop it or let it settle before clearing the chat',
      expect.any(Error),
    );
  });
  // The instruction the owner typed (recorded before the call) is still there,
  // the stored conversation is untouched, and no success was reported.
  expect(useIdeaBoard.getState().board?.messages).toHaveLength(3);
  expect(persistedRow.messages).toHaveLength(2);
  expect(toastSuccess).not.toHaveBeenCalled();

  await act(async () => {
    resolve({ reply: 'Settled', document: null, modelUsed: 'test/model' });
    await Promise.resolve();
  });
});
