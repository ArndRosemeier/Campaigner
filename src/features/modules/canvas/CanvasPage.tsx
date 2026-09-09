import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { Transaction } from '@codemirror/state';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeftIcon,
  BanIcon,
  HistoryIcon,
  LoaderCircleIcon,
  NotebookPenIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  SaveIcon,
  TriangleAlertIcon,
  WandSparklesIcon,
} from 'lucide-react';

import { canvasPath, modulePath, modulesPath } from '@/app/routes';
import { Button } from '@/components/ui/button';
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
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { Module } from '@/domain';
import { cancelModuleGen, ModuleBusyError } from '@/llm/moduleGen';
import { enclosingBlockOf, refineModuleText } from '@/llm/canvasRefine';
import { saveModulePartText } from '@/features/modules/partText';
import { useArtifacts, useCampaign, useGlobalArtifacts } from '@/features/campaign/hooks';
import { WikiMarkdown } from '@/features/campaign/components/wiki-markdown';
import { useModule } from '@/features/modules/hooks';
import { CanvasEditor } from '@/features/modules/canvas/canvasEditor';
import { activeCanvasView } from '@/features/modules/canvas/canvasView';
import { ChatSidebar } from '@/features/modules/canvas/ChatSidebar';
import { canvasChatKey, useCanvasChatStore } from '@/features/modules/canvas/chatStore';
import {
  resolveCanvasScope,
  scopeKey,
  scopeParam,
  type CanvasScope,
  type PlannedPart,
} from '@/features/modules/canvas/canvasScope';
import {
  acceptSuggestion,
  canvasShowPreviousField,
  newSuggestionId,
  pendingSuggestions,
  proposeSuggestion,
  rejectSuggestion,
  sealSuggestionText,
  setShowPreviousEffect,
  streamSuggestionText,
} from '@/features/modules/canvas/suggestions';
import type { CanvasSuggestion } from '@/features/modules/canvas/suggestions';
import {
  canvasLedgerKey,
  useCanvasLedgerStore,
  type CanvasVersionEntry,
} from '@/features/modules/canvas/canvasStore';
import { toastError, toastInfo, toastSuccess } from '@/lib/toast';

/**
 * Module canvas (08-MODULE-DESIGNER §Module canvas): ChatGPT-canvas-style
 * document co-authoring for ONE module part — a CodeMirror 6 markdown
 * document (the doc string IS the markdown, byte-exact) with wiki-link chips,
 * AI proposals rendered as suggestions, and every accepted text landing
 * through THE one part-text save path. ONE part is edited at a time; the
 * part selector (premise + parts by planIndex) is the scope control, and
 * deep links open a chosen part (`?part=<planIndex|premise>`, `#part-<n>`
 * honored — the reader's convention).
 *
 * AI actions (canvasRefine contract): selection refine (selection triple →
 * one span replacement) and whole-part rewrite (full-doc proposal). Proposals
 * render as suggestions over the doc (never mutations): spans show the struck
 * original + green ghost + inline Accept/Reject; a whole-part proposal shows
 * the NEW text as-is (no-diff, Board precedent) with Show previous / Apply /
 * Discard. Acceptance IS persistence (save path + session version ledger);
 * the ledger dies on reload by design.
 *
 * Chat co-editor (canvasChat contract): a collapsible wide LEFT sidebar —
 * the LLM answers prose + XML edit commands that are applied to the WHOLE
 * module's parts document (the open part via CM6 transactions, other parts
 * via the save seam), one command = one undo step in the open part. Chat
 * state is session-only, keyed per module (one conversation across part
 * switches).
 */

const EMPTY_VERSIONS: readonly CanvasVersionEntry[] = [];

export function CanvasPage(): JSX.Element {
  const { campaignId = '', moduleId = '' } = useParams<{
    campaignId: string;
    moduleId: string;
  }>();
  const campaign = useCampaign(campaignId === '' ? undefined : campaignId);
  const module = useModule(moduleId === '' ? undefined : moduleId);
  const artifacts = useArtifacts(campaignId === '' ? undefined : campaignId);
  const globalArtifacts = useGlobalArtifacts();
  const location = useLocation();
  const navigate = useNavigate();

  const plans = useMemo<PlannedPart[]>(() => {
    if (module === null || module === undefined) return [];
    if (module.spine === null) return [];
    return module.spine.partPlan.map((plan, planIndex) => ({
      planIndex,
      title: plan.title,
      levelBand: plan.levelBand,
    }));
  }, [module]);

  const scope = useMemo<CanvasScope>(
    () => resolveCanvasScope(location.search, location.hash, plans),
    [location.search, location.hash, plans],
  );

  // Session version ledger: dies on reload by design (Board staging
  // precedent) and resets when the canvas's module changes. The chat
  // store resets with it (its keys embed the module id).
  useEffect(() => {
    useCanvasLedgerStore.getState().resetFor(moduleId);
    useCanvasChatStore.getState().resetFor(moduleId);
  }, [moduleId]);

  // Part text lives in the EDITOR (the doc string is the truth); the page
  // mirrors it only as a render trigger for the Save affordance and the
  // part-switch guard (the guard re-reads the live editor view).
  const [docText, setDocText] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [switchTarget, setSwitchTarget] = useState<CanvasScope | null>(null);
  // Adjusting state during render (React's derive-state pattern): a scope
  // change remounts the editor, so unsaved-edit tracking resets NOW, not a
  // frame later — the guard can never read the previous part's dirtiness.
  const [renderedScopeKey, setRenderedScopeKey] = useState(scopeKey(scope));
  if (renderedScopeKey !== scopeKey(scope)) {
    setRenderedScopeKey(scopeKey(scope));
    setDocText(null);
  }

  // AI proposal state: the page mirrors the editor's suggestion field for
  // reactive chrome (decision bar, disabled rules) and remembers each
  // proposal's instruction for the ledger label on accept.
  const [suggestions, setSuggestions] = useState<readonly CanvasSuggestion[]>([]);
  const [refineInFlight, setRefineInFlight] = useState(false);
  const [instructionTarget, setInstructionTarget] = useState<'selection' | 'part' | null>(null);
  const [instruction, setInstruction] = useState('');
  const refineAbortRef = useRef<AbortController | null>(null);
  const proposalsRef = useRef<
    Map<string, { instruction: string; wholePart: boolean; ledgerLabel: string }>
  >(new Map());
  // The Show-previous toggle is PAGE state mirrored into the editor field —
  // reading it from the view during render would use a stale closure (the
  // dispatch never re-renders React by itself).
  const [showPrevious, setShowPrevious] = useState(false);

  // Chat sidebar visibility — session-only, keyed per MODULE (one
  // conversation across part switches; dies on reload). The premise uses
  // chat-disabled scope.
  const chatKey = canvasChatKey(moduleId);
  const chatOpen = useCanvasChatStore((store) => store.byModule[chatKey]?.open ?? false);

  const ledgerKey =
    scope.kind === 'part' ? canvasLedgerKey(moduleId, scope.planIndex) : '';
  const versions = useCanvasLedgerStore((state) =>
    ledgerKey === '' ? EMPTY_VERSIONS : (state.byPart[ledgerKey]?.versions ?? EMPTY_VERSIONS),
  );

  if (
    campaign === undefined ||
    module === undefined ||
    artifacts === undefined ||
    globalArtifacts === undefined
  ) {
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;
  }
  if (campaign === null) {
    return <MissingCanvas message="This campaign does not exist (it may have been deleted)." campaignId={campaignId} />;
  }
  if (module === null) {
    return <MissingCanvas message="This module does not exist (it may have been deleted)." campaignId={campaignId} />;
  }
  const currentModule: Module = module;
  if (currentModule.spine === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-muted-foreground">
          This module has no spine yet — the canvas edits its parts once the spine exists.
        </p>
        <Button
          variant="outline"
          size="sm"
          render={<Link to={modulesPath(campaignId)} />}
          nativeButton={false}
        >
          Back to modules
        </Button>
      </div>
    );
  }

  const busy = currentModule.status === 'generating';
  const pool = [...artifacts, ...globalArtifacts];
  const scopeIsPart = scope.kind === 'part';
  const part =
    scope.kind === 'part'
      ? currentModule.parts.find((entry) => entry.planIndex === scope.planIndex)
      : undefined;
  const partMarkdown = scope.kind === 'part' ? (part?.markdown ?? '') : '';
  // Dirty = the live doc diverged from the saved row (the mirror updates on
  // every editor change; the save itself re-reads the live editor view).
  const dirty = scopeIsPart && docText !== null && docText !== partMarkdown;
  const wholeProposal = suggestions.find((entry) => entry.wholePart);
  const aiBlocked = busy || refineInFlight || wholeProposal !== undefined;

  function syncSuggestions(): void {
    const view = activeCanvasView.current;
    setSuggestions(view === null ? [] : pendingSuggestions(view.state));
  }

  /** The selector's switch request — a pending proposal or unsaved edits
   * die with the screen, so switching away needs an explicit loud confirm. */
  function requestScopeSwitch(target: CanvasScope): void {
    const sameScope =
      (target.kind === 'premise' && scope.kind === 'premise') ||
      (target.kind === 'part' &&
        scope.kind === 'part' &&
        target.planIndex === scope.planIndex);
    if (sameScope) return;
    const view = activeCanvasView.current;
    const pendingCount = view === null ? 0 : pendingSuggestions(view.state).length;
    if (pendingCount > 0 || dirty) {
      setSwitchTarget(target);
      return;
    }
    navigate(canvasPath(campaignId, moduleId, scopeParam(target)));
  }

  async function savePart(): Promise<void> {
    if (scope.kind !== 'part' || saving) return;
    const doc = activeCanvasView.current?.state.doc.toString();
    if (doc === undefined) return;
    setSaving(true);
    try {
      await saveModulePartText(currentModule.id, scope.planIndex, doc);
      useCanvasLedgerStore.getState().append(canvasLedgerKey(currentModule.id, scope.planIndex), {
        markdown: doc,
        origin: 'user',
        label: 'Manual edit',
      });
      setDocText(doc);
      toastSuccess('Part saved');
    } catch (error) {
      toastError('Could not save the part', error);
    } finally {
      setSaving(false);
    }
  }

  /**
   * Runs one canvas refine (canvasRefine contract): proposes the suggestion
   * overlay immediately, streams extracted content deltas into it, seals it
   * with the validated reply — or drops it loudly. User aborts are silent
   * (a stop is not an error); ModuleBusyError surfaces the one-generation-
   * per-module rule; every other failure drops the proposal with a toast.
   */
  function beginProposal(target: 'selection' | 'part', instructionText: string): void {
    const view = activeCanvasView.current;
    if (view === null || scope.kind !== 'part') return;
    const doc = view.state.doc.toString();
    const selection = view.state.selection.main;
    const isSelection = target === 'selection';
    if (isSelection && selection.from === selection.to) {
      toastInfo('Select the text to refine first, then run Refine selection.');
      return;
    }
    const controller = new AbortController();
    refineAbortRef.current = controller;
    setRefineInFlight(true);
    const id = newSuggestionId();
    const from = isSelection ? selection.from : 0;
    const to = isSelection ? selection.to : doc.length;
    proposalsRef.current.set(id, {
      instruction: instructionText,
      wholePart: !isSelection,
      ledgerLabel: `${isSelection ? 'Refine' : 'Rewrite'}: ${instructionText}`,
    });
    proposeSuggestion(view, {
      id,
      from,
      to,
      originalText: doc.slice(from, to),
      proposedText: '',
      instruction: instructionText,
      streaming: true,
      wholePart: !isSelection,
    });
    // Streamed deltas coalesce per animation frame (the board ghost-buffer
    // precedent): onDelta reports the CUMULATIVE text, so a dropped frame
    // never loses content — the latest value always wins.
    let latestStreamed = '';
    const streamRafRef: { current: number | null } = { current: null };
    let sealed = false;
    const flushStream = (): void => {
      streamRafRef.current = null;
      if (sealed || latestStreamed === '') return;
      streamSuggestionText(view, id, latestStreamed);
    };
    void (async () => {
      try {
        const replacement = await refineModuleText({
          moduleId: currentModule.id,
          scope: target,
          instruction: instructionText,
          fullMarkdown: doc,
          selectedText: isSelection ? doc.slice(selection.from, selection.to) : '',
          enclosingBlock: isSelection ? enclosingBlockOf(doc, selection.from) : '',
          signal: controller.signal,
          onDelta: (soFar) => {
            latestStreamed = soFar;
            // rAF coalescing (board ghost-buffer precedent).
            streamRafRef.current ??= requestAnimationFrame(flushStream);
          },
        });
        sealed = true;
        if (streamRafRef.current !== null) cancelAnimationFrame(streamRafRef.current);
        sealSuggestionText(view, id, replacement);
      } catch (error) {
        sealed = true;
        if (streamRafRef.current !== null) cancelAnimationFrame(streamRafRef.current);
        rejectSuggestion(view, id);
        proposalsRef.current.delete(id);
        if (controller.signal.aborted) {
          // The user stopped the proposal — cancellation is not an error
          // and the overlay drop is the whole surface.
        } else if (error instanceof ModuleBusyError) {
          // ONE generation per module — surface busy LOUDLY, never queue.
          toastError(
            'A generation is already running for this module — wait for it or stop it first',
            error,
          );
        } else {
          toastError('Canvas refine failed — nothing was applied', error);
        }
      } finally {
        if (refineAbortRef.current === controller) refineAbortRef.current = null;
        setRefineInFlight(false);
        syncSuggestions();
      }
    })();
  }

  /**
   * Acceptance IS persistence: the accept dispatch already replaced the doc
   * (ONE undo unit), so the page lands the resulting text through THE one
   * part-text save path and appends the session ledger entry. A failed save
   * toasts loudly and leaves the editor text (Save part retries from there).
   */
  async function handleSuggestionAccepted(id: string): Promise<void> {
    const meta = proposalsRef.current.get(id);
    proposalsRef.current.delete(id);
    if (scope.kind !== 'part') return;
    const view = activeCanvasView.current;
    if (view === null) return;
    const doc = view.state.doc.toString();
    try {
      await saveModulePartText(currentModule.id, scope.planIndex, doc);
      useCanvasLedgerStore.getState().append(canvasLedgerKey(currentModule.id, scope.planIndex), {
        markdown: doc,
        origin: 'ai',
        label: meta?.ledgerLabel ?? 'AI proposal',
      });
      toastSuccess(meta?.wholePart === true ? 'Rewrite applied' : 'Proposal applied');
    } catch (error) {
      toastError('Could not save the accepted proposal — use Save part to retry', error);
    } finally {
      syncSuggestions();
    }
  }

  /** Restore proposes an older version through the SAME suggestion
   * machinery — accepting it rides undo and the save path like any AI
   * proposal (no side-door write). */
  function restoreVersion(entry: CanvasVersionEntry): void {
    const view = activeCanvasView.current;
    if (view === null || scope.kind !== 'part') return;
    if (pendingSuggestions(view.state).length > 0) {
      toastInfo('Discard the pending proposal first.');
      return;
    }
    const doc = view.state.doc.toString();
    const id = newSuggestionId();
    proposalsRef.current.set(id, {
      instruction: `Restore version #${String(entry.seq)}`,
      wholePart: true,
      ledgerLabel: `Restored version #${String(entry.seq)}`,
    });
    proposeSuggestion(view, {
      id,
      from: 0,
      to: doc.length,
      originalText: doc,
      proposedText: entry.markdown,
      instruction: `Restore version #${String(entry.seq)}`,
      streaming: false,
      wholePart: true,
    });
    syncSuggestions();
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="module-canvas">
      <header className="flex flex-wrap items-center gap-2 border-b bg-card px-4 py-2.5">
        <Button
          variant="ghost"
          size="icon"
          className="size-11"
          aria-label={chatOpen ? 'Close chat sidebar' : 'Open chat sidebar'}
          data-testid="canvas-chat-toggle"
          onClick={() => {
            useCanvasChatStore.getState().setOpen(chatKey, !chatOpen);
          }}
        >
          {chatOpen ? <PanelLeftCloseIcon aria-hidden /> : <PanelLeftOpenIcon aria-hidden />}
        </Button>
        <Button
          variant="ghost"
          size="xs"
          render={<Link to={modulePath(campaignId, moduleId)} />}
          nativeButton={false}
        >
          <ArrowLeftIcon aria-hidden data-icon="inline-start" />
          Reader
        </Button>
        <span className="font-heading text-sm font-semibold" data-testid="canvas-module-title">
          {currentModule.title}
        </span>
        {busy ? (
          <>
            <Badge variant="secondary">
              <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />
              generating
            </Badge>
            <Button
              variant="outline"
              size="xs"
              data-testid="canvas-stop"
              onClick={() => {
                cancelModuleGen(currentModule.id);
              }}
            >
              <BanIcon aria-hidden data-icon="inline-start" />
              Stop
            </Button>
          </>
        ) : (
          <Badge variant="secondary">{currentModule.status}</Badge>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Select
            value={scope.kind === 'premise' ? 'premise' : String(scope.planIndex)}
            items={{
              premise: 'Premise',
              ...Object.fromEntries(
                plans.map((plan) => [
                  String(plan.planIndex),
                  `Part ${String(plan.planIndex + 1)}: ${plan.title}`,
                ]),
              ),
            }}
            onValueChange={(value) => {
              requestScopeSwitch(
                value === 'premise' ? { kind: 'premise' } : { kind: 'part', planIndex: Number(value) },
              );
            }}
          >
            <SelectTrigger aria-label="Part" className="w-64" data-testid="canvas-part-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="premise">Premise (read-only)</SelectItem>
              {plans.map((plan) => (
                <SelectItem key={String(plan.planIndex)} value={String(plan.planIndex)}>
                  {`Part ${String(plan.planIndex + 1)}: ${plan.title}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {scope.kind === 'part' && (
            <>
              <Button
                variant="outline"
                size="xs"
                disabled={aiBlocked}
                data-testid="canvas-refine-selection"
                onClick={() => {
                  setInstruction('');
                  setInstructionTarget('selection');
                }}
              >
                <WandSparklesIcon aria-hidden data-icon="inline-start" />
                Refine selection
              </Button>
              <Button
                variant="outline"
                size="xs"
                disabled={aiBlocked}
                data-testid="canvas-rewrite-part"
                onClick={() => {
                  setInstruction('');
                  setInstructionTarget('part');
                }}
              >
                <NotebookPenIcon aria-hidden data-icon="inline-start" />
                Rewrite part
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button variant="ghost" size="xs" data-testid="canvas-versions">
                      <HistoryIcon aria-hidden data-icon="inline-start" />
                      Versions
                    </Button>
                  }
                />
                <DropdownMenuContent align="end" className="max-h-80 w-80 overflow-y-auto">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Session versions — dies on reload</DropdownMenuLabel>
                    {versions.length === 0 ? (
                      <p className="px-2 py-3 text-sm text-muted-foreground" data-testid="canvas-versions-empty">
                        Nothing accepted yet — accepted proposals and saves land here.
                      </p>
                    ) : (
                      [...versions].reverse().map((entry) => (
                        <DropdownMenuItem
                          key={String(entry.seq)}
                          data-testid={`canvas-version-${String(entry.seq)}`}
                          onClick={() => {
                            restoreVersion(entry);
                          }}
                        >
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate text-sm">
                              #{String(entry.seq)} · {entry.label}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {entry.origin === 'ai' ? 'AI' : 'you'} ·{' '}
                              {new Date(entry.createdAt).toLocaleTimeString()}
                            </span>
                          </span>
                        </DropdownMenuItem>
                      ))
                    )}
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              {refineInFlight && (
                <Button
                  variant="outline"
                  size="xs"
                  data-testid="canvas-stop-proposal"
                  onClick={() => {
                    refineAbortRef.current?.abort();
                  }}
                >
                  <BanIcon aria-hidden data-icon="inline-start" />
                  Stop proposal
                </Button>
              )}
              <Button
                variant="outline"
                size="xs"
                disabled={!dirty || saving || busy}
                data-testid="canvas-save"
                onClick={() => {
                  void savePart();
                }}
              >
                <SaveIcon aria-hidden data-icon="inline-start" />
                {saving ? 'Saving…' : 'Save part'}
              </Button>
            </>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {chatOpen && (
          <ChatSidebar
            moduleId={currentModule.id}
            scope={scope.kind === 'part' ? scope : { kind: 'premise' }}
            hasPlannedParts={plans.length > 0}
            pool={pool}
            aiBusy={aiBlocked}
          />
        )}
        <div className="flex min-h-0 flex-1 flex-col">
          {scope.kind === 'premise' ? (
            <div className="min-h-0 flex-1 overflow-y-auto p-6">
              <div className="mx-auto max-w-3xl">
                <p
                  className="mb-4 flex items-center gap-2 rounded-lg border border-dashed p-3 text-sm text-muted-foreground"
                  data-testid="canvas-premise-notice"
                >
                  <TriangleAlertIcon aria-hidden className="size-4 shrink-0" />
                  The premise is read-only in canvas v1 — it is generated with the spine. Switch to a
                  part to co-author its markdown.
                </p>
                <article className="prose-module" data-testid="canvas-premise-body">
                  <WikiMarkdown
                    value={currentModule.spine.premise}
                    artifacts={pool}
                    moduleId={currentModule.id}
                  />
                </article>
              </div>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-2 p-4">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span className="font-medium text-foreground">
                  {plans.find((plan) => plan.planIndex === scope.planIndex)?.title ??
                    `Part ${String(scope.planIndex + 1)}`}
                </span>
                <span>
                  Levels {plans.find((plan) => plan.planIndex === scope.planIndex)?.levelBand ?? '?'}
                </span>
                {part?.edited === true && <Badge variant="outline">edited</Badge>}
                {wholeProposal !== undefined && (
                  <span
                    className="ml-auto flex items-center gap-1.5"
                    data-testid="canvas-proposal-bar"
                    data-streaming={refineInFlight ? 'true' : 'false'}
                  >
                    {refineInFlight && (
                      <>
                        <LoaderCircleIcon aria-hidden className="size-3.5 animate-spin" />
                        <span>Proposing…</span>
                      </>
                    )}
                    <Button
                      variant="ghost"
                      size="xs"
                      data-testid="canvas-show-previous"
                      onClick={() => {
                        const view = activeCanvasView.current;
                        if (view === null) return;
                        const next = !view.state.field(canvasShowPreviousField);
                        view.dispatch({
                          effects: setShowPreviousEffect.of(next),
                          annotations: Transaction.addToHistory.of(false),
                        });
                        setShowPrevious(next);
                      }}
                    >
                      {showPrevious ? 'Show proposed' : 'Show previous'}
                    </Button>
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={refineInFlight}
                      data-testid="canvas-proposal-apply"
                      onClick={() => {
                        const view = activeCanvasView.current;
                        if (view === null) return;
                        acceptSuggestion(view, wholeProposal.id);
                      }}
                    >
                      Apply
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={refineInFlight}
                      data-testid="canvas-proposal-discard"
                      onClick={() => {
                        const view = activeCanvasView.current;
                        if (view === null) return;
                        rejectSuggestion(view, wholeProposal.id);
                        proposalsRef.current.delete(wholeProposal.id);
                        syncSuggestions();
                      }}
                    >
                      Discard
                    </Button>
                  </span>
                )}
              </div>
              <CanvasEditor
                key={scopeKey(scope)}
                initialMarkdown={partMarkdown}
                artifacts={pool}
                moduleId={currentModule.id}
                onChange={setDocText}
                onSuggestionAccepted={(id) => {
                  void handleSuggestionAccepted(id);
                }}
                onSuggestionInvalidated={() => {
                  toastError(
                    'Suggestion discarded — the text was edited inside the proposed range',
                    new Error('a pending proposal was invalidated by an edit inside its range'),
                  );
                  syncSuggestions();
                }}
                onSuggestionsChanged={syncSuggestions}
              />
            </div>
          )}
        </div>
      </div>

      <Dialog
        open={instructionTarget !== null}
        onOpenChange={(open) => {
          if (!open) setInstructionTarget(null);
        }}
      >
        <DialogContent data-testid="canvas-instruction-dialog">
          <DialogHeader>
            <DialogTitle>
              {instructionTarget === 'selection' ? 'Refine selection' : 'Rewrite part'}
            </DialogTitle>
            <DialogDescription>
              {instructionTarget === 'selection'
                ? 'The selected span is replaced exactly — the rest of the part stays untouched until you accept.'
                : 'The whole part is rewritten as a proposal — nothing changes until you apply it.'}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="canvas-instruction">Instruction</Label>
            <Textarea
              id="canvas-instruction"
              placeholder='e.g. "make the villain a child" · "tighten this scene to half the length"'
              value={instruction}
              data-testid="canvas-instruction-input"
              onChange={(event) => {
                setInstruction(event.target.value);
              }}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setInstructionTarget(null);
              }}
            >
              Cancel
            </Button>
            <Button
              data-testid="canvas-instruction-confirm"
              disabled={instruction.trim() === ''}
              onClick={() => {
                const target = instructionTarget;
                const text = instruction.trim();
                setInstructionTarget(null);
                if (target === null) return;
                beginProposal(target, text);
              }}
            >
              Propose
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={switchTarget !== null}
        onOpenChange={(open) => {
          if (!open) setSwitchTarget(null);
        }}
      >
        <AlertDialogContent data-testid="canvas-switch-guard">
          <AlertDialogHeader>
            <AlertDialogTitle>Leave this part?</AlertDialogTitle>
            <AlertDialogDescription>
              Pending proposals and unsaved edits live only on this screen — switching parts
              discards them (the saved module text is unaffected). Session staging dies on reload
              too.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Stay</AlertDialogCancel>
            <AlertDialogAction
              data-testid="canvas-switch-confirm"
              onClick={() => {
                const target = switchTarget;
                setSwitchTarget(null);
                if (target !== null) {
                  navigate(canvasPath(campaignId, moduleId, scopeParam(target)));
                }
              }}
            >
              Discard and switch
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function MissingCanvas({ message, campaignId }: { message: string; campaignId: string }): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-sm text-muted-foreground">{message}</p>
      <Button
        variant="outline"
        size="sm"
        render={<Link to={modulesPath(campaignId)} />}
        nativeButton={false}
      >
        Back to modules
      </Button>
    </div>
  );
}
