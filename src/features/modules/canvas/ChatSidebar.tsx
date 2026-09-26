import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { EditorView } from '@codemirror/view';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  BanIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  EraserIcon,
  LoaderCircleIcon,
  MessageSquareTextIcon,
  SendHorizonalIcon,
} from 'lucide-react';

import type { AnyArtifact, Id } from '@/domain';
import { readSettings } from '@/db/settingsRepo';
import { ModuleBusyError } from '@/llm/moduleGen';
import type { CanvasChatFraming } from '@/llm/canvasChat';
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
import { BlockedControl } from '@/components/blocked-control';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ModelWidget } from '@/features/settings/model-widget';
import { WikiMarkdown } from '@/features/campaign/components/wiki-markdown';
import { activeCanvasView } from '@/features/modules/canvas/canvasView';
import {
  canvasChatKeyFor,
  useCanvasChatStore,
  type CanvasChatMessage,
  type CanvasChatOutcome,
} from '@/features/modules/canvas/chatStore';
import { reportChatMessage, reportChatOutcome, runChatTurn } from '@/features/modules/canvas/chatController';
import { clearModuleChat } from '@/features/modules/canvas/clearChat';
import { toastModuleBusy } from '@/features/modules/module-busy';
import { toastError, toastSuccess } from '@/lib/toast';
import { cn } from '@/lib/utils';

/**
 * The canvas CHAT sidebar (08-MODULE-DESIGNER §Module canvas chat): a wide
 * LEFT column beside the whole-document editor where the LLM co-authors the
 * WHOLE module through XML edit commands. Assistant prose renders as chat
 * markdown; every command renders as an OUTCOME CARD in the flow (applied
 * with a mini before→after and the part it landed in, or failed with the
 * reason, the closest matching text, and a Report-to-LLM button — failures
 * are loud, never skipped). ONE conversation per module (docs/17 row 51).
 * Messages + outcomes persist on the module row and restore on canvas open
 * as history (docs/17 row 57); the model selection stays session-only.
 * The DOC is the truth for part text — applied commands are editor
 * transactions persisted through the split-save (THE one part-text save
 * path, only changed parts hit the row).
 *
 * CLEAR CHAT (panel header → alert-dialog confirm): returns ONE module's chat
 * to a pristine state — the live conversation, the persisted thread on the
 * row, this module's SESSION Versions ledger and the last-replacement
 * highlight (`clearChat.clearModuleChat` + the page's `onChatCleared`). It
 * NEVER touches the module's document text: applied chat edits are saved
 * content and reverting text is the Versions ledger's job — the dialog copy
 * says both halves out loud. While a reply is in flight (or any canvas AI
 * action is live for the module) the control REFUSES LOUDLY with a toast
 * instead of clearing under a running turn.
 *
 * Touch targets: every chat control is 44px (iPad-proportioned).
 */

export interface ChatSidebarProps {
  moduleId: Id;
  /**
   * WHICH canvas chat this sidebar shows (docs/17 row 362): the module
   * co-editor or GM assist. The PAGE owns the selection (its preview/report
   * paths turn it into the same store key), and everything the sidebar derives
   * from it — the store key, the framing it sends, the panel copy — follows
   * from this ONE value. There is no second sidebar.
   */
  surface: CanvasChatFraming;
  /** The user picked the other chat (switcher): the page holds the selection. */
  onSurfaceChange: (framing: CanvasChatFraming) => void;
  /** Pre-flight: a module without planned parts must not send. */
  hasPlannedParts: boolean;
  pool: readonly AnyArtifact[];
  /** Module generating / refine in flight / block proposal pending. */
  aiBusy: boolean;
  /**
   * WHY `aiBusy` is true, in the user's words — the page owns the state that
   * produces it (generating / refine in flight / pending proposal), and the
   * copy must exist once (docs/18 §2.3). It is REQUIRED, and non-null exactly
   * when `aiBusy` is true: a blocked chat control must never have to guess.
   */
  aiBusyReason: string | null;
  /** Preview mode: the editor is unmounted, so sends + reports ride the
   * preview snapshot through the page's snapshot turn runner (the chat is
   * fully live in preview — same protocol, same outcome cards). */
  previewOpen: boolean;
  onPreviewSend: ((text: string) => Promise<void>) | undefined;
  onPreviewReportOutcome:
    | ((messageId: string, outcome: CanvasChatOutcome) => void)
    | undefined;
  onPreviewReportMessage: ((message: CanvasChatMessage) => void) | undefined;
  /**
   * Editor-mode turn settled (applied or not): the page sets the
   * last-replacement highlight from the post-turn doc + range.
   */
  onEditorTurnApplied:
    | ((doc: string, lastApplied: { from: number; to: number } | null) => void)
    | undefined;
  /** Preview-mode Stop: aborts the page-owned snapshot turn. */
  onPreviewStop: (() => void) | undefined;
  /**
   * The chat was cleared (all three store/row slices are already pristine):
   * the page drops its `lastReplacement` state, which is what removes the
   * highlight from BOTH surfaces (the editor's CM6 mark and the preview wash).
   */
  onChatCleared: (() => void) | undefined;
}

export function ChatSidebar({
  moduleId,
  surface,
  onSurfaceChange,
  hasPlannedParts,
  pool,
  aiBusy,
  aiBusyReason,
  previewOpen,
  onPreviewSend,
  onPreviewReportOutcome,
  onPreviewReportMessage,
  onEditorTurnApplied,
  onPreviewStop,
  onChatCleared,
}: ChatSidebarProps): JSX.Element {
  const gmAssist = surface === 'gm-assist';
  const chatKey = canvasChatKeyFor(moduleId, surface);
  const state = useCanvasChatStore((store) => store.byModule[chatKey]);
  const settings = useLiveQuery(() => readSettings(), []);
  const [input, setInput] = useState('');
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
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
  const sendDisabled = aiBusy || inFlight || input.trim() === '';
  // WHY a chat control cannot act (null = it can), stated through the shared
  // blocked-control device. Nothing here is self-evident EXCEPT the two states
  // the control itself shows (a blank input, and the Report button that already
  // reads "Reported"), so those get no wrapper. The render path matters: while a
  // reply is in flight the Send button is REPLACED by Stop, so `sendDisabled`'s
  // in-flight branch is unreachable for Send and only the module-wide block can
  // be its reason — a reason that would never render is not a reason.
  const reportBlockedReason = chatBlockedReason(aiBusyReason, inFlight);
  const sendBlockedReason = chatBlockedReason(aiBusyReason, false);

  async function send(text: string): Promise<void> {
    // Preview mode: the editor is unmounted — the turn runs against the
    // preview snapshot through the page (no view needed).
    if (previewOpen) {
      if (onPreviewSend === undefined) {
        toastError('The editor is not ready — try again', new Error('canvas chat needs a preview snapshot'));
        return;
      }
      setInput('');
      try {
        await onPreviewSend(text);
      } catch (error) {
        if (error instanceof ModuleBusyError) {
          toastModuleBusy(error);
        } else {
          toastError('Chat failed', error);
        }
      }
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setInput('');
    await guardedTurn(controller, (view) =>
      runChatTurn(
        {
          moduleId,
          key: chatKey,
          framing: surface,
          hasPlannedParts,
          modelSelection,
          turn: controller,
          view,
        },
        text,
      ).then((result) => {
        onEditorTurnApplied?.(result.doc, result.lastApplied);
      }));
    if (abortRef.current === controller) abortRef.current = null;
  }

  /**
   * Confirms Clear chat (panel header): the three store/row slices go
   * through `clearModuleChat`, the page then drops its highlight state.
   *
   * REFUSE LOUDLY, never cancel-then-clear: while the chat reply for this
   * module is in flight — or any canvas AI action is live (`aiBusy`: the
   * module generating, a refine streaming, a block proposal pending) — a
   * clear could not promise the pristine state it advertises (the running
   * action would land its own message/ledger entry moments later), so the
   * action is refused with a toast and NOTHING is cleared. A failed row
   * write is the same shape: `clearModuleChat` throws before touching the
   * live store, the toast names it, and the conversation is intact.
   */
  async function confirmClearChat(): Promise<void> {
    setClearConfirmOpen(false);
    if (inFlight || aiBusy) {
      toastError(
        inFlight
          ? 'A chat reply is still in flight — stop it or let it settle before clearing the chat'
          : 'A canvas AI action is running for this module — wait for it or stop it first',
        new Error('canvas chat clear refused while the module is busy'),
      );
      return;
    }
    try {
      await clearModuleChat({ moduleId, key: chatKey, framing: surface });
    } catch (error) {
      toastError(
        'Could not clear the chat — nothing was cleared; the saved thread is still on the module',
        error,
      );
      return;
    }
    onChatCleared?.();
    toastSuccess(
      gmAssist
        ? 'GM assist cleared — the module text and the module chat were not changed'
        : 'Chat cleared — the module text was not changed',
    );
  }

  /** Every editor turn (send + report) needs the live view; busy rethrows from the
   * controller and toasts here (canvasRefine's surface). */
  async function guardedTurn(
    controller: AbortController,
    run: (view: EditorView) => Promise<unknown>,
  ): Promise<void> {
    const view = activeCanvasView.current;
    if (view === null) {
      toastError('The editor is not ready — try again', new Error('canvas chat needs the editor view'));
      return;
    }
    try {
      await run(view);
    } catch (error) {
      if (controller.signal.aborted) {
        // The turn was cancelled — by the user's own stop, or by the
        // app-level Stop all (the canvas abort registry aborts this same
        // controller). A cancel is not an error and needs no surface.
      } else if (error instanceof ModuleBusyError) {
        toastModuleBusy(error);
      } else {
        toastError('Chat failed', error);
      }
    }
  }

  function onReportOutcome(messageId: string, outcome: CanvasChatOutcome): void {
    // Preview mode: the excerpt is cut from the CURRENT snapshot at click
    // time (restored outcomes re-resolve the same way).
    if (previewOpen) {
      onPreviewReportOutcome?.(messageId, outcome);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    void guardedTurn(controller, (view) =>
      reportChatOutcome(
        {
          moduleId,
          key: chatKey,
          framing: surface,
          hasPlannedParts,
          modelSelection,
          turn: controller,
          view,
        },
        messageId,
        outcome,
      ).then((result) => {
        onEditorTurnApplied?.(result.doc, result.lastApplied);
      }));
  }

  function onReportMessage(message: CanvasChatMessage): void {
    if (previewOpen) {
      onPreviewReportMessage?.(message);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    void guardedTurn(controller, (view) =>
      reportChatMessage(
        {
          moduleId,
          key: chatKey,
          framing: surface,
          hasPlannedParts,
          modelSelection,
          turn: controller,
          view,
        },
        message,
      ).then((result) => {
        onEditorTurnApplied?.(result.doc, result.lastApplied);
      }));
  }

  return (
    <aside
      className="flex h-full min-h-0 w-96 shrink-0 flex-col border-r bg-card"
      data-testid="canvas-chat"
    >
      <div className="flex border-b" data-testid="canvas-chat-surface-switcher">
        {(['module', 'gm-assist'] as const).map((option) => (
          <Button
            key={option}
            variant="ghost"
            className={cn(
              'h-11 flex-1 rounded-none text-sm',
              surface === option
                ? 'bg-muted font-semibold text-foreground'
                : 'text-muted-foreground',
            )}
            aria-pressed={surface === option}
            data-testid={`canvas-chat-surface-${option}`}
            onClick={() => {
              onSurfaceChange(option);
            }}
          >
            {option === 'module' ? 'Module chat' : 'GM assist'}
          </Button>
        ))}
      </div>
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <MessageSquareTextIcon aria-hidden className="size-4 text-muted-foreground" />
        <span className="font-heading text-sm font-semibold">
          {gmAssist ? 'GM assist' : 'Chat co-editor'}
        </span>
        {inFlight && <LoaderCircleIcon aria-hidden className="size-3.5 animate-spin text-muted-foreground" />}
        <Button
          variant="ghost"
          size="xs"
          className="ml-auto"
          data-testid="canvas-chat-clear"
          onClick={() => {
            setClearConfirmOpen(true);
          }}
        >
          <EraserIcon aria-hidden data-icon="inline-start" />
          Clear chat
        </Button>
      </div>
      <div className="border-b px-3 py-2.5">
        <ModelWidget
          variant="field"
          id="canvas-chat-model"
          label="Chat model"
          value={effectiveModel}
          placeholder={settings?.defaultChatModel ?? ''}
          canBrowse={(settings?.openRouterApiKey ?? '') !== ''}
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
          gmAssist ? (
            <p
              className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground"
              data-testid="canvas-chat-gm-assist-intro"
            >
              Tell it what just happened — what the party did, said or skipped, how a roll went, what
              an NPC is doing. It keeps the story straight and answers with 2-4 concrete ideas for
              what happens next. It can edit the module text too, when you ask:{' '}
              <code>&lt;edit&gt;</code> commands apply to the document
              {previewOpen ? ' (no undo in preview)' : ' — each one its own undo step'}, and only the
              changed parts are saved to the module row. This chat lives in this browser session only
              for now — it is not saved with the module and is gone after a reload.
            </p>
          ) : (
            <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
              Ask for edits in plain language — the whole module is in context, so edits can land in
              any part. The assistant answers with prose and edit commands (<code>&lt;edit&gt;</code>{' '}
              blocks) that are applied to the document{previewOpen ? ' (no undo in preview)' : ' — each one its own undo step'}, and only the
              changed parts are saved to the module row.
            </p>
          )
        ) : (
          <div className="flex flex-col gap-3">
            {messages.map((message) => (
              <ChatBubble
                key={message.id}
                message={message}
                pool={pool}
                moduleId={moduleId}
                disabled={inFlight || aiBusy}
                disabledReason={reportBlockedReason}
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
      {previewOpen && (
        <p className="border-t px-3 pt-2 text-xs text-muted-foreground">
          Preview mode: edits apply to the preview and save to the module row — with no undo.
        </p>
      )}
      <div className="flex items-end gap-2 border-t p-3">
          <Textarea
            aria-label={gmAssist ? 'GM assist message' : 'Chat message'}
            data-testid="canvas-chat-input"
            placeholder={
              gmAssist
                ? 'e.g. the party refused the Keeper\'s offer and threatened her · they skipped the cellar entirely'
                : 'e.g. make the gate scene rainier · rename every mention of the old lord'
            }
            value={input}
            rows={2}
            className="min-h-11"
            onChange={(event) => {
              setInput(event.target.value);
            }}
            onKeyDown={(event) => {
              // Return sends (Shift+Return keeps the newline): same guards
              // as the send button — busy, in-flight, or blank never sends.
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                if (sendDisabled) return;
                const text = input.trim();
                if (text === '') return;
                void send(text);
              }
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
                if (previewOpen) {
                  onPreviewStop?.();
                } else {
                  abortRef.current?.abort();
                }
              }}
            >
              <BanIcon aria-hidden />
            </Button>
          ) : (
            <BlockedControl
              testId="canvas-chat-send"
              reason={sendBlockedReason}
              side="top"
              className="shrink-0"
            >
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
            </BlockedControl>
          )}
        </div>
      <AlertDialog open={clearConfirmOpen} onOpenChange={setClearConfirmOpen}>
        <AlertDialogContent data-testid="canvas-chat-clear-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {gmAssist ? "Clear this module's GM assist chat?" : "Clear this module's chat?"}
            </AlertDialogTitle>
            <AlertDialogDescription data-testid="canvas-chat-clear-description">
              {gmAssist ? (
                <>
                  Cleared: this module&apos;s GM assist conversation and its outcome cards, in this
                  session — plus the last-replacement highlight.
                  <span className="mt-2 block font-medium text-foreground">
                    NOT cleared: the module chat&apos;s own conversation and its SAVED thread on the
                    module (the two chats never share messages), this module&apos;s session Versions
                    list (it carries BOTH chats&apos; undo and cannot tell them apart), and the
                    module&apos;s DOCUMENT TEXT. GM assist is session-only for now, so there is no
                    saved copy to clear. To put text back, restore a version from Versions
                    (session-only by design).
                  </span>
                </>
              ) : (
                <>
                  Cleared: this module&apos;s conversation and its outcome cards — in this session and
                  in the saved thread on the module — plus this module&apos;s session Versions list and
                  the last-replacement highlight.
                  <span className="mt-2 block font-medium text-foreground">
                    NOT cleared: the module&apos;s DOCUMENT TEXT, and the GM assist chat (its own
                    conversation, session-only for now). Edits the chat already applied are saved
                    content — this is not an undo, and the text will not roll back. To put text back,
                    restore a version from Versions (session-only by design).
                  </span>
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="canvas-chat-clear-cancel">Keep chat</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              data-testid="canvas-chat-clear-confirm"
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
  );
}

function ChatBubble({
  message,
  pool,
  moduleId,
  disabled,
  disabledReason,
  onReportOutcome,
  onReportMessage,
}: {
  message: CanvasChatMessage;
  pool: readonly AnyArtifact[];
  moduleId: Id;
  disabled: boolean;
  /** Why the Report buttons are held (null = they are live). */
  disabledReason: string | null;
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
          <BlockedControl
            testId="canvas-chat-report-error"
            reason={disabled ? disabledReason : null}
            side="top"
            className="self-start"
          >
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
          </BlockedControl>
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
        <OutcomeCard
          key={outcome.id}
          outcome={outcome}
          disabled={disabled}
          disabledReason={disabledReason}
          onReport={onReportOutcome}
        />
      ))}
    </div>
  );
}

function OutcomeCard({
  outcome,
  disabled,
  disabledReason,
  onReport,
}: {
  outcome: CanvasChatOutcome;
  disabled: boolean;
  /** Why the Report button is held (null = it is live). */
  disabledReason: string | null;
  onReport: (outcome: CanvasChatOutcome) => void;
}) {
  const partNames = outcome.targetParts
    .map((part) => `Part ${String(part.planIndex + 1)} — ${part.title}`)
    .join(', ');
  // The adversarial review's findings (docs/17 row 360): the WHOLE reason the
  // owner asked for a chat-triggered pass, so they render above the edit on
  // every kind of card — an outcome that showed only the edit would hide what
  // the critic found.
  const findings = outcome.findings ?? [];
  const findingsBlock =
    findings.length === 0 ? null : (
      <div className="flex flex-col gap-1" data-testid="canvas-chat-outcome-findings">
        <span className="text-xs font-medium text-muted-foreground">
          The critic found {String(findings.length)} {findings.length === 1 ? 'issue' : 'issues'}:
        </span>
        <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
          {findings.map((finding) => (
            <li key={finding} className="whitespace-pre-wrap">
              {finding}
            </li>
          ))}
        </ul>
      </div>
    );
  if (outcome.kind === 'clean') {
    // The quiet success: the critique found NOTHING and nothing was applied.
    // Deliberately not a failure card and not an "applied" one — claiming a
    // change that did not happen is the lie this card exists to avoid.
    return (
      <div
        className="flex flex-col gap-1.5 rounded-lg border bg-muted/40 p-2.5"
        data-testid="canvas-chat-outcome"
        data-kind="clean"
      >
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <CircleCheckIcon aria-hidden className="size-3.5 shrink-0" />
          Nothing to fix — no change was made
        </div>
        {partNames !== '' && (
          <span className="text-xs text-muted-foreground" data-testid="canvas-chat-outcome-part">
            {partNames}
          </span>
        )}
        <span className="text-xs text-muted-foreground" data-testid="canvas-chat-outcome-reason">
          {outcome.reason}
        </span>
      </div>
    );
  }
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
        {findingsBlock}
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
      {findingsBlock}
      {outcome.closest !== null && (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Closest text in the document:</span>
          <span className="whitespace-pre-wrap rounded bg-muted px-1.5 py-1 font-mono text-xs">
            {outcome.closest}
          </span>
        </div>
      )}
      <BlockedControl
        testId="canvas-chat-report-outcome"
        // `reported` is SELF-EVIDENT: the control's own label reads "Reported".
        // Only the held state needs a reason.
        reason={!outcome.reported && disabled ? disabledReason : null}
        side="top"
        className="self-start"
      >
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
      </BlockedControl>
    </div>
  );
}

/**
 * Why a chat control cannot act (null = it can). `aiBusyReason` is the PAGE's
 * reason for the module-wide block (generating / refine in flight / pending
 * proposal) — the sidebar holds neither the state that produces it nor a second
 * copy of the sentence; the in-flight half is the sidebar's own (its Stop
 * button is the way out).
 */
function chatBlockedReason(aiBusyReason: string | null, inFlight: boolean): string | null {
  if (aiBusyReason !== null) return aiBusyReason;
  if (inFlight) return 'A reply is still streaming — wait for it, or press Stop.';
  return null;
}
