import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { EditorView } from '@codemirror/view';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  BanIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  LoaderCircleIcon,
  MessageSquareTextIcon,
  SendHorizonalIcon,
} from 'lucide-react';

import type { AnyArtifact, Id } from '@/domain';
import { readSettings } from '@/db/settingsRepo';
import { ModuleBusyError } from '@/llm/moduleGen';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ModelInput } from '@/features/settings/model-input';
import { WikiMarkdown } from '@/features/campaign/components/wiki-markdown';
import { activeCanvasView } from '@/features/modules/canvas/canvasView';
import { useCanvasPreviewStore } from '@/features/modules/canvas/previewStore';
import {
  canvasChatKey,
  useCanvasChatStore,
  type CanvasChatMessage,
  type CanvasChatOutcome,
} from '@/features/modules/canvas/chatStore';
import { reportChatMessage, reportChatOutcome, runChatTurn } from '@/features/modules/canvas/chatController';
import { toastError } from '@/lib/toast';
import { cn } from '@/lib/utils';

/**
 * The canvas CHAT sidebar (08-MODULE-DESIGNER §Module canvas chat): a wide
 * LEFT column beside the whole-document editor where the LLM co-authors the
 * WHOLE module through XML edit commands. Assistant prose renders as chat
 * markdown; every command renders as an OUTCOME CARD in the flow (applied
 * with a mini before→after and the part it landed in, or failed with the
 * reason, the closest matching text, and a Report-to-LLM button — failures
 * are loud, never skipped). ONE conversation per module (docs/17 row 51).
 * Chat state is SESSION-ONLY (dies on reload); the DOC is the truth —
 * applied commands are editor transactions persisted through the split-save
 * (THE one part-text save path, only changed parts hit the row).
 *
 * Touch targets: every chat control is 44px (iPad-proportioned).
 */

export interface ChatSidebarProps {
  moduleId: Id;
  /** Pre-flight: a module without planned parts must not send. */
  hasPlannedParts: boolean;
  pool: readonly AnyArtifact[];
  /** Module generating / refine in flight / block proposal pending. */
  aiBusy: boolean;
}

export function ChatSidebar({ moduleId, hasPlannedParts, pool, aiBusy }: ChatSidebarProps): JSX.Element {
  const chatKey = canvasChatKey(moduleId);
  const state = useCanvasChatStore((store) => store.byModule[chatKey]);
  const previewOpen = useCanvasPreviewStore((store) => store.openByModule[moduleId] ?? false);
  const settings = useLiveQuery(() => readSettings(), []);
  const [input, setInput] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, [chatKey]);

  const messages = state?.messages ?? [];
  const modelSelection = state?.modelSelection ?? null;
  const inFlight = state?.inFlight ?? false;
  const effectiveModel = modelSelection ?? settings?.defaultChatModel ?? '';
  const canBrowse = settings !== undefined && settings.openRouterApiKey !== '';
  const sendDisabled = aiBusy || inFlight || previewOpen || input.trim() === '';

  async function send(text: string): Promise<void> {
    const controller = new AbortController();
    abortRef.current = controller;
    setInput('');
    await guardedTurn((view) =>
      runChatTurn(
        {
          moduleId,
          key: chatKey,
          hasPlannedParts,
          modelSelection,
          signal: controller.signal,
          view,
        },
        text,
      ));
    if (abortRef.current === controller) abortRef.current = null;
  }

  /** Every turn (send + report) needs the live view; busy rethrows from the
   * controller and toasts here (canvasRefine's surface). */
  async function guardedTurn(run: (view: EditorView) => Promise<void>): Promise<void> {
    const view = activeCanvasView.current;
    if (view === null) {
      toastError('The editor is not ready — try again', new Error('canvas chat needs the editor view'));
      return;
    }
    try {
      await run(view);
    } catch (error) {
      if (error instanceof ModuleBusyError) {
        toastError('A generation is already running for this module — wait for it or stop it first', error);
      } else {
        toastError('Chat failed', error);
      }
    }
  }

  function onReportOutcome(messageId: string, outcome: CanvasChatOutcome): void {
    const controller = new AbortController();
    abortRef.current = controller;
    void guardedTurn((view) =>
      reportChatOutcome(
        {
          moduleId,
          key: chatKey,
          hasPlannedParts,
          modelSelection,
          signal: controller.signal,
          view,
        },
        messageId,
        outcome,
      ));
  }

  function onReportMessage(message: CanvasChatMessage): void {
    const controller = new AbortController();
    abortRef.current = controller;
    void guardedTurn((view) =>
      reportChatMessage(
        {
          moduleId,
          key: chatKey,
          hasPlannedParts,
          modelSelection,
          signal: controller.signal,
          view,
        },
        message,
      ));
  }

  return (
    <aside
      className="flex h-full min-h-0 w-96 shrink-0 flex-col border-r bg-card"
      data-testid="canvas-chat"
    >
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <MessageSquareTextIcon aria-hidden className="size-4 text-muted-foreground" />
        <span className="font-heading text-sm font-semibold">Chat co-editor</span>
        {inFlight && <LoaderCircleIcon aria-hidden className="size-3.5 animate-spin text-muted-foreground" />}
      </div>
      <div className="border-b px-3 py-2.5">
        <ModelInput
          id="canvas-chat-model"
          label="Chat model"
          value={effectiveModel}
          placeholder={settings?.defaultChatModel ?? ''}
          canBrowse={canBrowse}
          inputClassName="h-11"
          triggerClassName="h-11 w-11"
          onChange={(value) => {
            useCanvasChatStore.getState().setModelSelection(chatKey, value);
          }}
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Session-only selection — defaults to the Settings first-try model; the fallback chain still applies.
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3" data-testid="canvas-chat-messages">
        {messages.length === 0 ? (
          <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
            Ask for edits in plain language — the whole module is in context, so edits can land in
            any part. The assistant answers with prose and edit commands (<code>&lt;edit&gt;</code>{' '}
            blocks) that are applied to the document — each one its own undo step, and only the
            changed parts are saved to the module row.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {messages.map((message) => (
              <ChatBubble
                key={message.id}
                message={message}
                pool={pool}
                moduleId={moduleId}
                disabled={inFlight || aiBusy}
                onReportOutcome={(outcome) => {
                  onReportOutcome(message.id, outcome);
                }}
                onReportMessage={() => {
                  onReportMessage(message);
                }}
              />
            ))}
          </div>
        )}
      </div>
      {previewOpen ? (
        <div className="border-t p-3 text-sm text-muted-foreground">
          The editor is hidden in preview — switch back to Edit to continue the chat.
        </div>
      ) : (
        <div className="flex items-end gap-2 border-t p-3">
          <Textarea
            aria-label="Chat message"
            data-testid="canvas-chat-input"
            placeholder="e.g. make the gate scene rainier · rename every mention of the old lord"
            value={input}
            rows={2}
            className="min-h-11"
            onChange={(event) => {
              setInput(event.target.value);
            }}
          />
          {inFlight ? (
            <Button
              variant="outline"
              size="icon"
              className="size-11 shrink-0"
              aria-label="Stop chat reply"
              data-testid="canvas-chat-stop"
              onClick={() => {
                abortRef.current?.abort();
              }}
            >
              <BanIcon aria-hidden />
            </Button>
          ) : (
            <Button
              size="icon"
              className="size-11 shrink-0"
              aria-label="Send chat message"
              data-testid="canvas-chat-send"
              disabled={sendDisabled}
              onClick={() => {
                const text = input.trim();
                if (text === '') return;
                void send(text);
              }}
            >
              <SendHorizonalIcon aria-hidden />
            </Button>
          )}
        </div>
      )}
    </aside>
  );
}

function ChatBubble({
  message,
  pool,
  moduleId,
  disabled,
  onReportOutcome,
  onReportMessage,
}: {
  message: CanvasChatMessage;
  pool: readonly AnyArtifact[];
  moduleId: Id;
  disabled: boolean;
  onReportOutcome: (outcome: CanvasChatOutcome) => void;
  onReportMessage: () => void;
}): JSX.Element {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end" data-testid="canvas-chat-user-message">
        <div className="max-w-[85%] rounded-lg rounded-br-sm bg-muted px-3 py-2 text-sm whitespace-pre-wrap">
          {message.text}
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2" data-testid="canvas-chat-assistant-message" data-status={message.status}>
      {message.status === 'aborted' && (
        <div className="flex items-center gap-1.5 rounded-lg border border-amber-500/50 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-300">
          <BanIcon aria-hidden className="size-3.5 shrink-0" />
          Stopped — the reply was cut off and NOTHING was applied.
        </div>
      )}
      {message.status === 'failed' && (
        <div className="flex flex-col gap-2 rounded-lg border border-destructive/50 bg-destructive/5 p-2.5" data-testid="canvas-chat-error-card">
          <div className="flex items-start gap-1.5 text-xs text-destructive">
            <CircleAlertIcon aria-hidden className="size-3.5 shrink-0" />
            <span className="min-w-0 break-words" data-testid="canvas-chat-error-text">
              The reply failed: {message.error}
            </span>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-11 self-start"
            data-testid="canvas-chat-report-error"
            disabled={disabled}
            onClick={onReportMessage}
          >
            Report to LLM
          </Button>
        </div>
      )}
      {message.text !== '' && (
        <div className="rounded-lg rounded-bl-sm border px-3 py-2 text-sm">
          <WikiMarkdown value={message.text} artifacts={pool} moduleId={moduleId} />
        </div>
      )}
      {message.text === '' && message.status === 'streaming' && (
        <div className="rounded-lg border px-3 py-2 text-sm text-muted-foreground">…</div>
      )}
      {message.outcomes.map((outcome) => (
        <OutcomeCard key={outcome.id} outcome={outcome} disabled={disabled} onReport={onReportOutcome} />
      ))}
    </div>
  );
}

function OutcomeCard({
  outcome,
  disabled,
  onReport,
}: {
  outcome: CanvasChatOutcome;
  disabled: boolean;
  onReport: (outcome: CanvasChatOutcome) => void;
}) {
  const partNames = outcome.targetParts
    .map((part) => `Part ${String(part.planIndex + 1)} — ${part.title}`)
    .join(', ');
  if (outcome.kind === 'applied') {
    return (
      <div
        className="flex flex-col gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-2.5"
        data-testid="canvas-chat-outcome"
        data-kind="applied"
        data-occurrences={String(outcome.occurrences ?? 0)}
      >
        <div className="flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
          <CircleCheckIcon aria-hidden className="size-3.5 shrink-0" />
          Applied · {String(outcome.occurrences ?? 1)} occurrence{(outcome.occurrences ?? 1) === 1 ? '' : 's'}
          {(outcome.occurrences ?? 1) > 1 && ' (replace-all)'}
        </div>
        {partNames !== '' && (
          <span className="text-xs text-muted-foreground" data-testid="canvas-chat-outcome-part">
            {partNames}
          </span>
        )}
        <div className="grid gap-1 font-mono text-xs">
          <span className="whitespace-pre-wrap rounded bg-destructive/10 px-1.5 py-1 text-destructive line-through decoration-destructive/50">
            {outcome.before ?? outcome.command.search}
          </span>
          <span className="whitespace-pre-wrap rounded bg-emerald-500/10 px-1.5 py-1 text-emerald-800 dark:text-emerald-200">
            {outcome.command.replace}
          </span>
        </div>
      </div>
    );
  }
  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-destructive/50 bg-destructive/5 p-2.5"
      data-testid="canvas-chat-outcome"
      data-kind="failed"
    >
      <div className="flex items-start gap-1.5 text-xs text-destructive">
        <CircleAlertIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 break-words" data-testid="canvas-chat-outcome-reason">
          Not applied — {outcome.reason}
        </span>
      </div>
      {partNames !== '' && (
        <span className="text-xs text-muted-foreground" data-testid="canvas-chat-outcome-part">
          {partNames}
        </span>
      )}
      {outcome.closest !== null && (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Closest text in the document:</span>
          <span className="whitespace-pre-wrap rounded bg-muted px-1.5 py-1 font-mono text-xs">
            {outcome.closest}
          </span>
        </div>
      )}
      <Button
        variant="outline"
        size="sm"
        className={cn('h-11 self-start')}
        data-testid="canvas-chat-report-outcome"
        disabled={disabled || outcome.reported}
        onClick={() => {
          onReport(outcome);
        }}
      >
        {outcome.reported ? 'Reported' : 'Report to LLM'}
      </Button>
    </div>
  );
}
