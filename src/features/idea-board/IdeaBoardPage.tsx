import { useEffect, useRef, useState, type JSX } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import type { EditorView } from '@codemirror/view';
import { redo, undo } from '@codemirror/commands';
import { CopyIcon, EraserIcon } from 'lucide-react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ModelWidget } from '@/features/settings/model-widget';
import { ideaBoardEditorExtensions } from '@/features/idea-board/editor';
import {
  clearIdeaBoardChat,
  discardIdeaProposal,
  editIdeaBoard,
  flushIdeaBoard,
  loadIdeaBoard,
  replaceIdeaDocument,
  sendIdeaBoard,
  stopIdeaBoard,
  useIdeaBoard,
  watchIdeaBoard,
} from '@/features/idea-board/store';
import { copyText } from '@/lib/clipboard';
import { toastError, toastSuccess } from '@/lib/toast';

/**
 * Idea Board (`docs/21-IDEA-BOARD.md`): ONE app-level plain-text writing
 * surface — a refinement sidebar on the LEFT, the document filling the rest.
 *
 * Deliberately NOT the module canvas: no wiki-links are interpreted (a
 * `[[token]]` is the literal characters the owner typed), the document has no
 * parts or scaffolding, and a refinement NEVER writes the board by itself. The
 * model's replacement arrives as a suggestion the owner accepts or discards,
 * and accepting snapshots the draft it replaced into Previous drafts.
 *
 * CLEAR CHAT (chat column header → alert-dialog confirm): returns the board's
 * CONVERSATION to a pristine state through the one seam,
 * `clearIdeaBoardChat` — the persisted transcript on the row first (awaited,
 * aborting the whole action on failure), then the live store. It NEVER touches
 * the DOCUMENT or Previous drafts: those are content, not conversation (the
 * dialog copy says so), and a reply in flight REFUSES the clear loudly instead
 * of clearing under a running turn.
 */

/** Plain text only — the extension set lives in `idea-board/editor.ts` so it
 * can be mounted for real in a test (the page-level test mocks CodeMirror,
 * which can never catch a broken extension list). */

export function IdeaBoardPage(): JSX.Element {
  const state = useIdeaBoard();
  const [instruction, setInstruction] = useState('');
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const editorRef = useRef<EditorView | null>(null);

  useEffect(() => {
    void loadIdeaBoard();
    // The unregister also flushes the debounced write and stops a request
    // still in flight, so leaving the page can never strand either.
    return watchIdeaBoard();
  }, []);

  const board = state.board;
  if (board === null) {
    return (
      <div className="flex flex-col items-start gap-3 p-6" role="status">
        <p>{state.error ?? 'Loading the Idea Board…'}</p>
        {state.error !== null && (
          <Button
            onClick={() => {
              void loadIdeaBoard();
            }}
          >
            Retry loading
          </Button>
        )}
      </div>
    );
  }

  const saved = state.error === null && !state.saving && board === state.saved;
  // Captured so the accept handler narrows to a non-null proposal (the block
  // is only rendered for one, and an accept must never be able to write '').
  const proposal = state.proposal;
  const status = state.error !== null
    ? 'Not saved'
    : state.saving
      ? 'Saving…'
      : saved
        ? 'Saved'
        : 'Unsaved changes';

  /**
   * Confirms Clear chat (the chat column's header): the transcript goes
   * through `clearIdeaBoardChat`, which writes the row FIRST and awaited.
   *
   * REFUSE LOUDLY, never cancel-then-clear: while a refinement reply is in
   * flight a clear could not promise the pristine conversation it advertises
   * (the reply would land its own message moments later), so the action is
   * refused with a toast and NOTHING is cleared. A failed row write is the
   * same shape: `clearIdeaBoardChat` throws before touching the live store,
   * the toast names it, and the conversation is intact.
   */
  async function confirmClearChat(): Promise<void> {
    setClearConfirmOpen(false);
    if (state.busy) {
      toastError(
        'A reply is still in flight — stop it or let it settle before clearing the chat',
        new Error('idea board chat clear refused while a reply is in flight'),
      );
      return;
    }
    try {
      await clearIdeaBoardChat();
    } catch (error) {
      toastError(
        'Could not clear the chat — nothing was cleared; the saved conversation is still on the board',
        error,
      );
      return;
    }
    toastSuccess('Chat cleared — the board document was not changed');
  }

  return (
    // `h-full` (not `flex-1`): the shell's <main> is a plain block that only
    // HAS a height — it is not a flex container — so a `flex-1` root resolved
    // to nothing and the board sat at its floor height, leaving the viewport
    // unused. `h-full` is the chain CanvasPage uses to fill the same slot.
    <main className="flex h-full min-h-0 flex-col" aria-label="Idea Board">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b p-3">
        <h1 className="font-heading text-lg font-semibold">Idea Board</h1>
        <span role="status" className="text-sm text-muted-foreground">
          {status}
        </span>
        {state.error !== null && (
          <Button size="sm" onClick={flushIdeaBoard}>
            Retry saving
          </Button>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              if (editorRef.current !== null) undo(editorRef.current);
            }}
          >
            Undo
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              if (editorRef.current !== null) redo(editorRef.current);
            }}
          >
            Redo
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Copy document"
            data-testid="idea-board-copy"
            onClick={() => {
              void copyText(board.document)
                .then(() => {
                  toastSuccess('Document copied to the clipboard');
                })
                .catch((error: unknown) => {
                  toastError('Could not copy — select the text and copy it manually', error);
                });
            }}
          >
            <CopyIcon aria-hidden />
          </Button>
        </div>
      </header>

      {state.error !== null && (
        <p role="alert" className="shrink-0 border-b bg-destructive/5 p-3 text-sm text-destructive">
          {state.error} Your draft is still here — copy anything you need before reloading.
        </p>
      )}

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside
          aria-label="Idea Board chat"
          className="flex min-h-0 w-full flex-col gap-3 overflow-auto border-b p-3 md:w-80 md:shrink-0 md:border-r md:border-b-0"
          data-testid="idea-board-chat"
        >
          <div className="flex items-center gap-2">
            <span className="font-heading text-sm font-semibold">Refinement chat</span>
            <Button
              variant="ghost"
              size="xs"
              className="ml-auto"
              data-testid="idea-board-clear"
              onClick={() => {
                setClearConfirmOpen(true);
              }}
            >
              <EraserIcon aria-hidden data-icon="inline-start" />
              Clear chat
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            Write freely. Ask for ideas, talk them through, or ask for a new draft — a
            suggested draft is never applied until you accept it.
          </p>
          <ModelWidget
            variant="field"
            id="idea-board-model"
            label="Model"
            value={board.model}
            placeholder="Settings default"
            canBrowse={true}
            onChange={(model) => {
              editIdeaBoard({ model });
            }}
          />
          <div aria-label="Conversation" className="min-h-24 flex-1 space-y-3 overflow-auto">
            {board.messages.length === 0 ? (
              <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
                Nothing asked yet.
              </p>
            ) : (
              board.messages.map((message) => (
                <article key={message.id} className="rounded-lg border p-2">
                  <div className="text-xs font-semibold">
                    {message.role === 'user' ? 'You' : 'Assistant'}
                    {message.modelUsed === null ? '' : ` · ${message.modelUsed}`}
                  </div>
                  <p className="text-sm whitespace-pre-wrap">{message.text}</p>
                </article>
              ))
            )}
          </div>
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              const text = instruction.trim();
              if (text === '') return;
              setInstruction('');
              void sendIdeaBoard(text);
            }}
          >
            <Textarea
              aria-label="Message to Idea Board"
              value={instruction}
              rows={2}
              placeholder="What would you like to write?"
              onChange={(event) => {
                setInstruction(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.shiftKey) return;
                event.preventDefault();
                const text = instruction.trim();
                if (text === '' || state.busy) return;
                setInstruction('');
                void sendIdeaBoard(text);
              }}
            />
            {state.busy ? (
              <Button type="button" variant="outline" onClick={stopIdeaBoard}>
                Stop
              </Button>
            ) : (
              <Button type="submit" disabled={instruction.trim() === ''}>
                Send
              </Button>
            )}
          </form>
          <AlertDialog open={clearConfirmOpen} onOpenChange={setClearConfirmOpen}>
            <AlertDialogContent data-testid="idea-board-clear-dialog">
              <AlertDialogHeader>
                <AlertDialogTitle>Clear the Idea Board chat?</AlertDialogTitle>
                <AlertDialogDescription data-testid="idea-board-clear-description">
                  Cleared: the whole conversation with the model — in this session and in the
                  saved conversation on the board.
                  <span className="mt-2 block font-medium text-foreground">
                    NOT cleared: the board&apos;s DOCUMENT (the text you wrote), its Previous
                    drafts, or a suggested replacement you have not accepted. Those are content,
                    not conversation — clearing the chat is not an undo and never deletes your
                    writing.
                  </span>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel data-testid="idea-board-clear-cancel">Keep chat</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  data-testid="idea-board-clear-confirm"
                  onClick={() => {
                    void confirmClearChat();
                  }}
                >
                  Clear chat
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </aside>

        <section
          className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-auto p-3"
          aria-label="Writing surface"
        >
          {proposal !== null && (
            <div className="rounded-lg border border-primary/40 bg-primary/5 p-3" data-testid="idea-board-proposal">
              <h2 className="font-heading font-semibold">Suggested replacement</h2>
              <p className="text-sm text-muted-foreground">
                Accepting replaces the current text; the text it replaces is kept in Previous
                drafts.
              </p>
              <pre className="my-3 max-h-64 overflow-auto font-sans text-sm whitespace-pre-wrap">
                {proposal.document}
              </pre>
              <div className="flex gap-2">
                <Button
                  onClick={() => {
                    replaceIdeaDocument(proposal.document, proposal.modelUsed);
                  }}
                >
                  Accept replacement
                </Button>
                <Button variant="ghost" onClick={discardIdeaProposal}>
                  Discard suggestion
                </Button>
              </div>
            </div>
          )}

          {/* The board fills the leftover height (`flex-1`) and scrolls its own
              text; `min-h-64` only keeps it usable on a short viewport. The
              edge is the app's Card convention (`ring-1 ring-foreground/10`)
              rather than a `border`: in LIGHT mode `--card` and `--background`
              are both pure white, and the very light `--border` left the
              surface reading as a featureless white block (the owner's "big
              white square, white on white"). */}
          <div
            className="min-h-64 flex-1 overflow-hidden rounded-lg bg-card ring-1 ring-foreground/10"
            data-testid="idea-board-surface"
          >
            <CodeMirror
              value={board.document}
              extensions={ideaBoardEditorExtensions}
              height="100%"
              // 'none' disables the wrapper's default light chrome — the board
              // theme extension owns ALL colors from the app's CSS vars. This
              // prop is THE fix for the owner-reported white slab (the same one
              // canvasEditor carries), and the style height is what makes the
              // editor fill the box rather than collapse to its content.
              theme="none"
              style={{ height: '100%', fontSize: '0.9375rem' }}
              basicSetup={false}
              onCreateEditor={(view) => {
                editorRef.current = view;
              }}
              onChange={(document) => {
                editIdeaBoard({ document });
              }}
            />
          </div>

          <details className="shrink-0 rounded-lg border p-3">
            <summary className="cursor-pointer text-sm">
              Previous drafts ({board.versions.length})
            </summary>
            {board.versions.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">
                No earlier drafts yet — accepting a suggestion saves the text it replaced here.
              </p>
            ) : (
              // Newest first: the most likely thing to want back is on top.
              [...board.versions].reverse().map((version) => (
                <div key={version.id} className="my-2 rounded-lg border p-2">
                  <p className="text-xs text-muted-foreground">
                    {new Date(version.createdAt).toLocaleString()}
                    {version.modelUsed === null ? '' : ` · ${version.modelUsed}`}
                  </p>
                  <pre className="max-h-32 overflow-auto font-sans text-sm whitespace-pre-wrap">
                    {version.document === '' ? '(Empty document)' : version.document}
                  </pre>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      replaceIdeaDocument(version.document, version.modelUsed);
                    }}
                  >
                    Restore this draft
                  </Button>
                </div>
              ))
            )}
          </details>
        </section>
      </div>
    </main>
  );
}
