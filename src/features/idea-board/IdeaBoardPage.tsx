import { useEffect, useRef, useState, type JSX } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { EditorView } from '@codemirror/view';
import { redo, undo } from '@codemirror/commands';
import { CopyIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ModelInput } from '@/features/settings/model-input';
import {
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
import { plainEditorTheme } from '@/lib/editorTheme';
import { toastError, toastSuccess } from '@/lib/toast';

/**
 * Idea Board (`docs/21-IDEA-BOARD.md`): ONE app-level plain-text writing
 * surface — a document on the left of nothing and a refinement chat beside it.
 *
 * Deliberately NOT the module canvas: no wiki-links are interpreted (a
 * `[[token]]` is the literal characters the owner typed), the document has no
 * parts or scaffolding, and a refinement NEVER writes the board by itself. The
 * model's replacement arrives as a suggestion the owner accepts or discards,
 * and accepting snapshots the draft it replaced into Previous drafts.
 */

/** Plain text only — no markdown language, no wiki decorations. */
const editorExtensions = [
  plainEditorTheme,
  EditorView.lineWrapping,
  EditorView.contentAttributes.of({ 'aria-label': 'Idea Board document' }),
];

export function IdeaBoardPage(): JSX.Element {
  const state = useIdeaBoard();
  const [instruction, setInstruction] = useState('');
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

  return (
    <main className="flex min-h-0 flex-1 flex-col" aria-label="Idea Board">
      <header className="flex flex-wrap items-center gap-3 border-b p-3">
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
        <p role="alert" className="border-b bg-destructive/5 p-3 text-sm text-destructive">
          {state.error} Your draft is still here — copy anything you need before reloading.
        </p>
      )}

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside
          aria-label="Idea Board chat"
          className="flex min-h-0 w-full flex-col gap-3 overflow-auto border-b p-3 md:w-80 md:shrink-0 md:border-r md:border-b-0"
          data-testid="idea-board-chat"
        >
          <p className="text-sm text-muted-foreground">
            Write freely. Ask for ideas, talk them through, or ask for a new draft — a
            suggested draft is never applied until you accept it.
          </p>
          <ModelInput
            id="idea-board-model"
            label="Model"
            value={board.model}
            placeholder="Settings default"
            canBrowse
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

          <div className="min-h-80 flex-1 overflow-hidden rounded-lg border bg-card">
            <CodeMirror
              value={board.document}
              extensions={editorExtensions}
              height="100%"
              minHeight="320px"
              basicSetup={{
                lineNumbers: false,
                foldGutter: false,
                highlightActiveLine: false,
              }}
              onCreateEditor={(view) => {
                editorRef.current = view;
              }}
              onChange={(document) => {
                editIdeaBoard({ document });
              }}
            />
          </div>

          <details className="rounded-lg border p-3">
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
