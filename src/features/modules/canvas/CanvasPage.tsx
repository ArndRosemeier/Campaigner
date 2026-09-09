import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { Link, useBlocker, useLocation, useParams } from 'react-router-dom';
import {
  ArrowLeftIcon,
  BanIcon,
  EyeIcon,
  HistoryIcon,
  LoaderCircleIcon,
  NotebookPenIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PencilIcon,
  SaveIcon,
  WandSparklesIcon,
} from 'lucide-react';

import { modulePath, modulesPath } from '@/app/routes';
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
import {
  assembleModulePartsDocument,
  canvasPartLabel,
  CANVAS_PARTS_DELIMITER,
  ModulePartsDocumentError,
  splitPartsDocument,
  type AnyArtifact,
  type Module,
} from '@/domain';
import { cancelModuleGen, ModuleBusyError } from '@/llm/moduleGen';
import { enclosingBlockOf, refineModuleText } from '@/llm/canvasRefine';
import { useArtifacts, useCampaign, useGlobalArtifacts } from '@/features/campaign/hooks';
import { useModule } from '@/features/modules/hooks';
import { PeekModal } from '@/features/modules/peek-modal';
import { CanvasEditor } from '@/features/modules/canvas/canvasEditor';
import { activeCanvasView, lastCanvasScroll } from '@/features/modules/canvas/canvasView';
import { ChatSidebar } from '@/features/modules/canvas/ChatSidebar';
import { CanvasPreview } from '@/features/modules/canvas/CanvasPreview';
import { useCanvasPreviewStore } from '@/features/modules/canvas/previewStore';
import { canvasChatKey, useCanvasChatStore } from '@/features/modules/canvas/chatStore';
import { flushChatPersist, hydrateChatFromThread } from '@/features/modules/canvas/chatPersist';
import {
  resolveCanvasScrollTarget,
  type PlannedPart,
} from '@/features/modules/canvas/canvasScope';
import { saveWholeModuleDocument } from '@/features/modules/canvas/saveDoc';
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
 * Module canvas (08-MODULE-DESIGNER §Module canvas, canvas v3 — docs/17
 * ledger row 53): ChatGPT-canvas-style co-authoring of the WHOLE module in
 * ONE document — a CodeMirror 6 markdown doc assembled by the shared
 * `assembleModulePartsDocument` (every planned part in plan order, the
 * spine premise EXCLUDED, `==========` separators + `[Part <n> of
 * <total> — <title>]` label lines). There is NO part selector: the editor
 * doc and the chat's context are THE SAME whole-module format, and deep
 * links (`?part=<planIndex|premise>`, the reader's `#part-<n>` hash) are
 * SCROLL targets.
 *
 * The scaffolding lines are ordinary editable text while editing; they are
 * validated only at the boundaries that need the split. Save is ONE action
 * (manual Save, accepted proposals, chat batches): the doc is split by the
 * shared `splitPartsDocument` and ONLY the parts whose text changed land
 * through THE one part-text save path (+ per-part ledger entries) — a doc
 * whose scaffolding no longer parses fails the save loudly with the
 * splitter's reason (editor keeps the text). Leaving with unsaved edits or
 * a pending proposal demands the explicit discard confirm.
 *
 * AI actions (cursor plays no role): selection refine works on an explicit
 * text SELECTION over the whole doc; rewrite part works on an explicitly
 * PICKED part (dialog picker) and proposes a block replace over that
 * part's section range. Proposals render as suggestions (never mutations);
 * acceptance IS persistence (split-save + session version ledger).
 *
 * Preview (header toggle, session-only per module): hides the editor and
 * renders the per-part texts (scaffolding stripped) through the shared
 * `WikiMarkdown` with the reader pool — reader parity by construction. It
 * captures the doc at toggle time; while it is open every writing surface
 * is disabled, so the editor doc is untouched.
 */

const EMPTY_LEDGER: readonly CanvasVersionEntry[] = [];

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

  const plans = useMemo<PlannedPart[]>(() => {
    if (module === null || module === undefined) return [];
    if (module.spine === null) return [];
    return module.spine.partPlan.map((plan, planIndex) => ({
      planIndex,
      title: plan.title,
      levelBand: plan.levelBand,
    }));
  }, [module]);

  // Session version ledger and preview toggle: die on reload by design
  // (Board staging precedent) and reset when the canvas's module changes
  // (their keys embed the module id). The CHAT THREAD persists on the module
  // row (docs/17 row 57): the store still resets per module, then hydrates
  // from the row below — restored entries render as history and never touch
  // the editor.
  useEffect(() => {
    useCanvasLedgerStore.getState().resetFor(moduleId);
    useCanvasChatStore.getState().resetFor(moduleId);
    useCanvasPreviewStore.getState().resetFor(moduleId);
    return () => {
      // A debounced thread write still pending at leave/unmount lands now.
      void flushChatPersist();
    };
  }, [moduleId]);

  // Thread restore: once the module row arrives, hydrate the (just-reset)
  // store from its persisted thread. Idempotent — a non-empty store (the
  // user already chatted this session) always wins over the row.
  useEffect(() => {
    if (module === undefined || module === null) return;
    hydrateChatFromThread(canvasChatKey(moduleId), module.chatThread);
  }, [moduleId, module]);

  // Part text lives in the EDITOR (the doc string is the truth); the page
  // mirrors it only as a render trigger for the Save affordance and the
  // leave-guard. `initialDoc` is captured ONCE per module — the editor doc
  // is never re-assembled from the row mid-session (that would clobber
  // unsaved edits).
  const [initialDoc, setInitialDoc] = useState<string | null>(null);
  const [baselineDoc, setBaselineDoc] = useState<string | null>(null);
  // The doc the editor (re)mounts with: the assembled row doc on first
  // mount, the toggle-time snapshot when returning from the preview (the
  // preview UNMOUNTS the editor, so remounting from the pristine assemble
  // would silently discard unsaved edits — AGENTS 1).
  const [mountDoc, setMountDoc] = useState<string | null>(null);
  const [mountedModuleId, setMountedModuleId] = useState<string | null>(null);
  const [docText, setDocText] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Adjusting state during render (React's derive-state pattern): the whole
  // document is assembled the first time the module row is available, and
  // never again while the same module stays mounted.
  if (
    module !== undefined &&
    module !== null &&
    module.spine !== null &&
    module.spine.partPlan.length > 0 &&
    mountedModuleId !== module.id
  ) {
    const assembled = assembleModulePartsDocument({
      partPlan: module.spine.partPlan,
      parts: module.parts,
    });
    setMountedModuleId(module.id);
    setInitialDoc(assembled.document);
    setBaselineDoc(assembled.document);
    setMountDoc(assembled.document);
  }

  // AI proposal state: the page mirrors the editor's suggestion field for
  // reactive chrome (decision bar, disabled rules) and remembers each
  // proposal's instruction for the ledger label on accept.
  const [suggestions, setSuggestions] = useState<readonly CanvasSuggestion[]>([]);
  const [refineInFlight, setRefineInFlight] = useState(false);
  const [instructionTarget, setInstructionTarget] = useState<'selection' | 'part' | null>(null);
  const [rewritePartIndex, setRewritePartIndex] = useState<number | null>(null);
  const [instruction, setInstruction] = useState('');
  const refineAbortRef = useRef<AbortController | null>(null);
  const proposalsRef = useRef<
    Map<string, { instruction: string; wholePart: boolean; ledgerLabel: string }>
  >(new Map());
  // The Show-previous toggle is PAGE state mirrored into the editor field —
  // reading it from the view during render would use a stale closure (the
  // dispatch never re-renders React by itself).
  const [showPrevious, setShowPrevious] = useState(false);

  // Chat sidebar visibility + preview toggle — session-only, keyed per
  // MODULE (dies on reload).
  const chatKey = canvasChatKey(moduleId);
  const chatOpen = useCanvasChatStore((store) => store.byModule[chatKey]?.open ?? false);
  const previewOpen = useCanvasPreviewStore((store) => store.openByModule[moduleId] ?? false);
  // The preview renders the doc AS OF THE TOGGLE (captured once — the
  // editor is hidden and all writing surfaces disabled while it is open).
  const [previewDoc, setPreviewDoc] = useState<string | null>(null);
  // The peek modal behind the preview's resolved chips (reader affordance).
  const [peekArtifact, setPeekArtifact] = useState<AnyArtifact | null>(null);

  // The leave-guard mirrors (the guard re-checks the live editor view too).
  const dirty = docText !== null && baselineDoc !== null && docText !== baselineDoc;
  const pendingProposalCount = suggestions.length;

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      mountedModuleId !== null &&
      mountedModuleId === moduleId &&
      (dirty || pendingProposalCount > 0) &&
      currentLocation.pathname !== nextLocation.pathname,
  );

  // Deep links are SCROLL targets (no scope, no remount): `?part=` /
  // `#part-<n>` scroll the editor to that part's section, `premise` and the
  // no-target default scroll to the top. Re-applies on location change.
  useEffect(() => {
    if (initialDoc === null || mountedModuleId !== moduleId) return;
    lastCanvasScroll.current = null;
    const target = resolveCanvasScrollTarget(location.search, location.hash, plans);
    if (target === null) return;
    if (target.kind === 'premise') {
      lastCanvasScroll.current = { target: 'top', offset: 0 };
      activeCanvasView.current?.dispatch({
        effects: EditorView.scrollIntoView(0, { y: 'start' }),
      });
      return;
    }
    // The section's label line anchors the scroll (tolerant: a doc whose
    // scaffolding is broken simply doesn't scroll — its brokenness surfaces
    // at save/preview time, not here).
    const plan = plans.find((entry) => entry.planIndex === target.planIndex);
    if (plan === undefined) return;
    let offset: number | null = null;
    if (target.planIndex === 0) {
      offset = 0;
    } else {
      const label = canvasPartLabel(target.planIndex + 1, plans.length, plan.title);
      const at = initialDoc.indexOf(`\n\n${CANVAS_PARTS_DELIMITER}\n\n${label}\n`);
      if (at !== -1) offset = at + `\n\n${CANVAS_PARTS_DELIMITER}\n\n`.length;
    }
    if (offset === null) return;
    lastCanvasScroll.current = { target: 'doc', offset };
    activeCanvasView.current?.dispatch({
      effects: EditorView.scrollIntoView(offset, { y: 'start' }),
    });
  }, [location.search, location.hash, initialDoc, mountedModuleId, moduleId, plans]);

  const ledgerByPart = useCanvasLedgerStore((state) => state.byPart);

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
  if (currentModule.spine === null || currentModule.spine.partPlan.length === 0 || initialDoc === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-muted-foreground">
          This module has no planned parts yet — the canvas edits its parts once the spine exists.
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
  const wholeProposal = suggestions.find((entry) => entry.wholePart);
  const aiBlocked = busy || refineInFlight || wholeProposal !== undefined;
  const viewBusy = busy || refineInFlight || suggestions.length > 0;

  function syncSuggestions(): void {
    const view = activeCanvasView.current;
    setSuggestions(view === null ? [] : pendingSuggestions(view.state));
  }

  /**
   * ONE save action for the whole document (manual Save, accepted
   * proposals, chat batches): split → save ONLY the changed parts through
   * THE one part-text save path (+ per-part ledger entries). A doc whose
   * scaffolding no longer parses fails loud with the splitter's reason —
   * the editor keeps its text so the problem can be fixed. Per-part save
   * failures toast loudly naming the part (saveWholeModuleDocument) while
   * the remaining parts still land.
   */
  async function saveDoc(origin: 'user' | 'ai', label: string, successMessage: string | null): Promise<void> {
    const view = activeCanvasView.current;
    if (view === null || saving) return;
    const doc = view.state.doc.toString();
    setSaving(true);
    try {
      const result = await saveWholeModuleDocument({
        moduleId: currentModule.id,
        doc,
        module: currentModule,
        origin,
        label,
      });
      setBaselineDoc(doc);
      if (successMessage !== null && result.failedParts.length === 0) {
        toastSuccess(successMessage);
      }
    } catch (error) {
      if (error instanceof ModulePartsDocumentError) {
        toastError(
          'Could not save — the parts-document scaffolding no longer parses. Fix the separator / label lines, then Save again.',
          error,
        );
      } else {
        toastError('Could not save the module document', error);
      }
    } finally {
      setSaving(false);
    }
  }

  /**
   * Runs one canvas refine (canvasRefine contract): proposes the suggestion
   * overlay immediately, streams extracted content deltas into it, seals it
   * with the validated reply — or drops it loudly. The grounding is the
   * EXPLICIT input, never the cursor: the selected range for a selection
   * refine, the picked part's current text for a rewrite. User aborts are
   * silent (a stop is not an error); ModuleBusyError surfaces the
   * one-generation-per-module rule; every other failure drops the proposal
   * with a toast.
   */
  function beginProposal(
    target: 'selection' | 'part',
    instructionText: string,
    rewritePlanIndex: number | null,
  ): void {
    const view = activeCanvasView.current;
    if (view === null) return;
    const doc = view.state.doc.toString();
    const selection = view.state.selection.main;
    const isSelection = target === 'selection';
    if (isSelection && selection.from === selection.to) {
      toastInfo('Select the text to refine first, then run Refine selection.');
      return;
    }
    let from = selection.from;
    let to = selection.to;
    let groundingText = doc.slice(selection.from, selection.to);
    if (!isSelection) {
      if (rewritePlanIndex === null) {
        toastInfo('Pick the part to rewrite first.');
        return;
      }
      try {
        const section = splitPartsDocument(doc, currentModule.spine?.partPlan ?? []).find(
          (entry) => entry.planIndex === rewritePlanIndex,
        );
        if (section === undefined) {
          throw new Error(`part ${String(rewritePlanIndex + 1)} is not in the document`);
        }
        from = section.textFrom;
        to = section.textTo;
        groundingText = section.text;
      } catch (error) {
        if (error instanceof ModulePartsDocumentError) {
          toastError(
            'Could not start the rewrite — the parts-document scaffolding no longer parses.',
            error,
          );
        } else {
          toastError('Could not start the rewrite', error);
        }
        return;
      }
    }
    const controller = new AbortController();
    refineAbortRef.current = controller;
    setRefineInFlight(true);
    const id = newSuggestionId();
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
          text: groundingText,
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
   * (ONE undo unit), so the page lands the result through the split-save
   * (only the part(s) the proposal touched hit the row) and appends the
   * session ledger entry per changed part. A failed save toasts loudly and
   * leaves the editor text (Save retries from there).
   */
  async function handleSuggestionAccepted(id: string): Promise<void> {
    const meta = proposalsRef.current.get(id);
    proposalsRef.current.delete(id);
    const view = activeCanvasView.current;
    if (view === null) return;
    await saveDoc('ai', meta?.ledgerLabel ?? 'AI proposal', meta?.wholePart === true ? 'Rewrite applied' : 'Proposal applied');
    syncSuggestions();
  }

  /** Restore proposes an older per-part version through the SAME suggestion
   * machinery — a block replace over THAT part's current section range;
   * accepting it rides undo and the save path like any AI proposal (no
   * side-door write). */
  function restoreVersion(planIndex: number, entry: CanvasVersionEntry): void {
    const view = activeCanvasView.current;
    if (view === null) return;
    if (pendingSuggestions(view.state).length > 0) {
      toastInfo('Discard the pending proposal first.');
      return;
    }
    const doc = view.state.doc.toString();
    let section;
    try {
      section = splitPartsDocument(doc, currentModule.spine?.partPlan ?? []).find(
        (candidate) => candidate.planIndex === planIndex,
      );
    } catch (error) {
      toastError(
        'Could not restore — the parts-document scaffolding no longer parses.',
        error,
      );
      return;
    }
    if (section === undefined) {
      toastError('Could not restore — the part is not in the document', new Error(`part ${String(planIndex + 1)} is not in the document`));
      return;
    }
    const id = newSuggestionId();
    proposalsRef.current.set(id, {
      instruction: `Restore version #${String(entry.seq)}`,
      wholePart: true,
      ledgerLabel: `Restored version #${String(entry.seq)}`,
    });
    proposeSuggestion(view, {
      id,
      from: section.textFrom,
      to: section.textTo,
      originalText: section.text,
      proposedText: entry.markdown,
      instruction: `Restore version #${String(entry.seq)}`,
      streaming: false,
      wholePart: true,
    });
    syncSuggestions();
  }

  function togglePreview(): void {
    const next = !previewOpen;
    if (next) {
      const view = activeCanvasView.current;
      if (view === null) return;
      setPreviewDoc(view.state.doc.toString());
    } else {
      // Return from the preview: the editor remounts — hand it the
      // toggle-time snapshot so unsaved edits survive the round trip.
      setMountDoc(previewDoc ?? mountDoc ?? initialDoc);
      setPreviewDoc(null);
    }
    useCanvasPreviewStore.getState().setOpen(moduleId, next);
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
          <Button
            variant="ghost"
            size="xs"
            aria-pressed={previewOpen}
            disabled={viewBusy}
            data-testid="canvas-preview-toggle"
            onClick={togglePreview}
          >
            {previewOpen ? <PencilIcon aria-hidden data-icon="inline-start" /> : <EyeIcon aria-hidden data-icon="inline-start" />}
            {previewOpen ? 'Edit' : 'Preview'}
          </Button>
          <Button
            variant="outline"
            size="xs"
            disabled={aiBlocked || previewOpen}
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
            disabled={aiBlocked || previewOpen}
            data-testid="canvas-rewrite-part"
            onClick={() => {
              setInstruction('');
              setRewritePartIndex(null);
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
                {plans.every((plan) => (ledgerByPart[canvasLedgerKey(moduleId, plan.planIndex)]?.versions.length ?? 0) === 0) ? (
                  <p className="px-2 py-3 text-sm text-muted-foreground" data-testid="canvas-versions-empty">
                    Nothing accepted yet — accepted proposals and saves land here.
                  </p>
                ) : (
                  plans.map((plan) => {
                    const versions = ledgerByPart[canvasLedgerKey(moduleId, plan.planIndex)]?.versions ?? EMPTY_LEDGER;
                    if (versions.length === 0) return null;
                    return (
                      <DropdownMenuGroup key={String(plan.planIndex)}>
                        <DropdownMenuLabel>
                          {`Part ${String(plan.planIndex + 1)} — ${plan.title}`}
                        </DropdownMenuLabel>
                        {[...versions].reverse().map((entry) => (
                          <DropdownMenuItem
                            key={`${String(plan.planIndex)}-${String(entry.seq)}`}
                            data-testid={`canvas-version-${String(plan.planIndex)}-${String(entry.seq)}`}
                            onClick={() => {
                              restoreVersion(plan.planIndex, entry);
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
                        ))}
                      </DropdownMenuGroup>
                    );
                  })
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
            disabled={!dirty || saving || busy || previewOpen}
            data-testid="canvas-save"
            onClick={() => {
              void saveDoc('user', 'Manual edit', 'Module saved');
            }}
          >
            <SaveIcon aria-hidden data-icon="inline-start" />
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {chatOpen && (
          <ChatSidebar
            moduleId={currentModule.id}
            hasPlannedParts={plans.length > 0}
            pool={pool}
            aiBusy={aiBlocked}
          />
        )}
        <div className="flex min-h-0 flex-1 flex-col">
          {wholeProposal !== undefined && !previewOpen && (
            <div
              className="flex items-center gap-2 border-b px-4 py-1.5 text-sm text-muted-foreground"
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
            </div>
          )}
          {previewOpen && previewDoc !== null ? (
            <CanvasPreview
              doc={previewDoc}
              module={currentModule}
              artifacts={pool}
              moduleId={currentModule.id}
              onOpenArtifact={(artifact) => {
                setPeekArtifact(artifact);
              }}
            />
          ) : (
            <div className="flex min-h-0 flex-1 flex-col p-4">
              <CanvasEditor
                key={currentModule.id}
                initialMarkdown={mountDoc ?? initialDoc}
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

      {peekArtifact !== null && (
        <PeekModal
          artifact={peekArtifact}
          artifacts={pool}
          open
          onOpenChange={(open) => {
            if (!open) setPeekArtifact(null);
          }}
          campaignId={campaignId}
        />
      )}

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
                ? 'The selected span is replaced exactly — the rest of the document stays untouched until you accept.'
                : 'The picked part is rewritten as a proposal — nothing changes until you apply it.'}
            </DialogDescription>
          </DialogHeader>
          {instructionTarget === 'part' && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="canvas-rewrite-part-select">Part to rewrite</Label>
              <Select
                value={rewritePartIndex === null ? '' : String(rewritePartIndex)}
                items={{
                  ...Object.fromEntries(
                    plans.map((plan) => [
                      String(plan.planIndex),
                      `Part ${String(plan.planIndex + 1)}: ${plan.title}`,
                    ]),
                  ),
                }}
                onValueChange={(value) => {
                  setRewritePartIndex(Number(value));
                }}
              >
                <SelectTrigger id="canvas-rewrite-part-select" className="w-full" data-testid="canvas-rewrite-part-select">
                  <SelectValue placeholder="Pick a part…" />
                </SelectTrigger>
                <SelectContent>
                  {plans.map((plan) => (
                    <SelectItem key={String(plan.planIndex)} value={String(plan.planIndex)}>
                      {`Part ${String(plan.planIndex + 1)}: ${plan.title}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
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
              disabled={instruction.trim() === '' || (instructionTarget === 'part' && rewritePartIndex === null)}
              onClick={() => {
                const target = instructionTarget;
                const text = instruction.trim();
                setInstructionTarget(null);
                if (target === null) return;
                beginProposal(target, text, target === 'part' ? rewritePartIndex : null);
              }}
            >
              Propose
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {blocker.state === 'blocked' && (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open) blocker.reset();
          }}
        >
          <AlertDialogContent data-testid="canvas-leave-guard">
            <AlertDialogHeader>
              <AlertDialogTitle>Leave the canvas?</AlertDialogTitle>
              <AlertDialogDescription>
                Pending proposals and unsaved edits live only on this screen — leaving discards
                them (the saved module text is unaffected). Session staging dies on reload too.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Stay</AlertDialogCancel>
              <AlertDialogAction
                data-testid="canvas-leave-confirm"
                onClick={() => {
                  blocker.proceed();
                }}
              >
                Discard and leave
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
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
