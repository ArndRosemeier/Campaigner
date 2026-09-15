import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { saveIdeaBoard } from '@/db/ideaBoardRepo';
import { newIdeaBoard } from '@/domain/ideaBoard';
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
// (no wiki parsing, no markdown) are the thing under test here.
vi.mock('@uiw/react-codemirror', () => ({
  default: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (value: string) => void;
  }) => (
    <textarea
      aria-label="Idea Board document"
      value={value}
      onChange={(event) => {
        onChange(event.target.value);
      }}
    />
  ),
}));

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

beforeEach(() => {
  vi.clearAllMocks();
  const board = newIdeaBoard();
  useIdeaBoard.setState({
    board,
    saved: board,
    busy: false,
    loading: false,
    saving: false,
    error: null,
    proposal: null,
  });
  vi.mocked(saveIdeaBoard).mockImplementation((next) => Promise.resolve(next));
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
