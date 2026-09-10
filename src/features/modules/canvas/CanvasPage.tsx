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
  PlayIcon,
  SaveIcon,
  Trash2Icon,
  WandSparklesIcon,
  WrenchIcon,
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
  DropdownMenuSeparator,
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
  MODULE_VERSION_CAP,
  MODULE_VERSION_SOURCE_LABELS,
  savedVersionsNoun,
  splitPartsDocument,
  type AnyArtifact,
  type Campaign,
  type Module,
  type ModuleDocumentVersion,
  type ModuleVersionSource,
} from '@/domain';
import { cancelModuleGen, ModuleBusyError, repairModuleEncounterFloor } from '@/llm/moduleGen';
import { getModule } from '@/db/moduleRepo';
import {
  deriveAutomationDeviation,
  deviationIsEmpty,
  deviationLines,
} from '@/features/modules/automation-deviation';
import { deriveModuleProblems } from '@/features/modules/module-problems';
import { resumeModuleAutomation } from '@/features/modules/resume-automation';
import { enclosingBlockOf, refineModuleText } from '@/llm/canvasRefine';
import { useArtifacts, useCampaign, useGlobalArtifacts } from '@/features/campaign/hooks';
import { useModule, useModuleVersions } from '@/features/modules/hooks';
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
import {
  reportSnapshotMessage,
  reportSnapshotOutcome,
  runSnapshotChatTurn,
  type SnapshotChatTurnResult,
} from '@/features/modules/canvas/snapshotChat';
import type {
  CanvasChatMessage,
  CanvasChatOutcome,
} from '@/features/modules/canvas/chatStore';
import type { LastReplacement } from '@/features/modules/canvas/lastReplacement';
import { clearModuleVersions } from '@/db/moduleVersionRepo';
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
 * Preview (header toggle, session-only per module, OPEN BY DEFAULT on
 * first open): hides the editor and renders the per-part texts (scaffolding
 * stripped) through the shared `WikiMarkdown` — the reader's exact renderer
 * with the reader pool — filling its pane (no centered narrow measure). The
 * chat sidebar persists beside it and stays FULLY LIVE in preview: sends
 * run against the preview SNAPSHOT STRING (the editor is unmounted — the
 * v3 contract, never remounted hidden) via the shared split + the existing
 * per-part ladder, persist through the existing split-save, and re-render
 * the preview. Preview-applied edits have no CM6 history (the editor is
 * unmounted) — their undo is the durable Versions snapshot taken before the
 * turn, which is why that seam is required for both apply modes. Returning to
 * Edit remounts the editor from the latest snapshot through the existing
 * mountDoc path.
 *
 * Versions (header dropdown) — SIMPLE UNDO, owner-directed (docs/18 §2.3,
 * docs/17 ledger row 63): the top group lists the DURABLE whole-document
 * snapshots taken before every AI change (Dexie `moduleVersions`, newest
 * first, capped at MODULE_VERSION_CAP with the oldest pruned, the retention
 * stated in the menu) and each entry restores through the SAME proposal/save
 * path (validated against the current part plan first — a version saved under
 * a different plan is refused loudly rather than proposed). The bottom group
 * is the SESSION-ONLY per-part ledger, labelled as such: it dies on reload
 * and is never presented as durable history. "Clear all previous versions"
 * empties THIS module's durable stack behind an explicit confirm.
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

  // Front-door entries (docs/17 row 57): a `?chat=open` arrival (the modules
  // list row + the reader header link here) forces the sidebar open even
  // when this session's toggle closed it. Plain canvas arrivals leave the
  // toggle state untouched.
  useEffect(() => {
    if (new URLSearchParams(location.search).get('chat') === 'open') {
      useCanvasChatStore.getState().setOpen(canvasChatKey(moduleId), true);
    }
  }, [location.search, moduleId]);

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
    Map<
      string,
      {
        instruction: string;
        wholePart: boolean;
        ledgerLabel: string;
        /** What kind of AI change accepting this proposal lands (the durable
         * snapshot's source, docs/18 §2.3) — never inferred from the label. */
        versionSource: ModuleVersionSource;
        /** The durable snapshot's honest label (differs from the ledger label
         * for restores: "Restore from <time>" vs "Restored version #N"). */
        versionLabel: string;
        /** Toast shown once the save landed (null = no toast). */
        successMessage: string | null;
      }
    >
  >(new Map());
  // The Show-previous toggle is PAGE state mirrored into the editor field —
  // reading it from the view during render would use a stale closure (the
  // dispatch never re-renders React by itself).
  const [showPrevious, setShowPrevious] = useState(false);

  // Chat sidebar visibility + preview toggle — session-only, keyed per
  // MODULE (both die on reload). The chat sidebar defaults OPEN (front
  // door); the PREVIEW defaults OPEN on first open (`openByModule`
  // undefined ⇒ true) — the canvas lands as chat + rendered preview side
  // by side, and the Edit affordance stays one click away.
  const chatKey = canvasChatKey(moduleId);
  const chatOpen = useCanvasChatStore((store) => store.module(chatKey).open);
  const previewOpen = useCanvasPreviewStore((store) => store.openByModule[moduleId] ?? true);
  // The preview renders the doc AS OF THE TOGGLE (captured once) — or, on
  // first open (no toggle yet), the assembled/mount doc. While the preview
  // is open the chat applies to this SNAPSHOT STRING (the editor is
  // unmounted): every preview turn rewrites it, persists through the
  // split-save, and re-renders from it.
  const [previewDoc, setPreviewDoc] = useState<string | null>(null);
  const previewSource = previewDoc ?? mountDoc ?? initialDoc;
  // Last-replacement highlight (both surfaces): whole-doc offsets plus the
  // post-apply doc string identity — SET ONLY by chat application (the LAST
  // command's FIRST applied range). Renders while the current doc text is
  // byte-identical to the stored string: the editor mark and the preview
  // <mark> both gate on identity, and hand edits clear the page state.
  const [lastReplacement, setLastReplacement] = useState<LastReplacement | null>(null);
  const previewAbortRef = useRef<AbortController | null>(null);
  // The peek modal behind the preview's resolved chips (reader affordance).
  const [peekArtifact, setPeekArtifact] = useState<AnyArtifact | null>(null);
  // "Clear all previous versions" (the Versions menu's destructive door).
  const [versionsClearOpen, setVersionsClearOpen] = useState(false);
  // The TWO derived controls (docs/05 §Module canvas, docs/08 §M4-B-3): each
  // opens a confirmation that names exactly what it will do, and each is
  // USER-INVOKED only — nothing on this page runs them on render, on open or on
  // a timer.
  const [fixOpen, setFixOpen] = useState(false);
  const [fixRunning, setFixRunning] = useState(false);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [resumeRunning, setResumeRunning] = useState(false);
  // Bumped whenever a ROW rewrite has to reach the editor (the repair, the
  // resume's normalization): the editor is keyed by module + epoch, so a row
  // rewrite remounts it from the fresh document instead of leaving a stale doc
  // whose next Save would write the old text back over the repair.
  const [docEpoch, setDocEpoch] = useState(0);
  // The DURABLE version stack (docs/18 §2.3 simple undo): live, so a snapshot
  // taken by any AI path (canvas, chat, generation, normalization) or a clear
  // shows up here without a reload. `undefined` = still loading.
  const durableVersions = useModuleVersions(moduleId);

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
  // `#part-<n>` scroll the editor to that part's section (or the preview
  // article when landing directly in preview — the default view), `premise`
  // and the no-target default scroll to the top. Re-applies on location
  // change.
  // The scroll targets live inside the ready branch (editor / preview) but
  // the module row can arrive BEFORE the campaign/artifacts rows — a first
  // run against the Loading fallback would find nothing and (no dep
  // changing afterwards) silently drop the scroll. `contentReady` re-runs
  // the effect once the content actually commits.
  const contentReady =
    campaign !== undefined &&
    module !== undefined &&
    artifacts !== undefined &&
    globalArtifacts !== undefined;
  useEffect(() => {
    if (!contentReady || initialDoc === null || mountedModuleId !== moduleId) return;
    lastCanvasScroll.current = null;
    const target = resolveCanvasScrollTarget(location.search, location.hash, plans);
    if (target === null) return;
    if (previewOpen) {
      // The editor is unmounted — scroll the preview article (each carries
      // its `part-<n>` anchor id, the reader-hash contract).
      if (target.kind === 'premise') {
        // jsdom has no Element.scrollTo (only scrollIntoView is stubbed in
        // tests/setup.ts) — the optional call keeps this test-safe.
        const scroller = document.querySelector('[data-testid="canvas-preview"]') as unknown as {
          scrollTo?: ((options?: ScrollToOptions) => void) | undefined;
        } | null;
        scroller?.scrollTo?.({ top: 0 });
        return;
      }
      document.getElementById(`part-${String(target.planIndex)}`)?.scrollIntoView({ block: 'start' });
      return;
    }
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
  }, [contentReady, location.search, location.hash, initialDoc, mountedModuleId, moduleId, plans, previewOpen, previewSource]);

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
  // Explicitly narrowed: the handlers below are hoisted function declarations,
  // for which TS's control-flow narrowing of `campaign` does not survive.
  const currentCampaign: Campaign = campaign;
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
  // The two controls' visibility, DERIVED per render on purpose: neither is a
  // stored flag (a flag would go stale on the first hand edit — the exact state
  // the resume exists for), and both answer their question from the row that is
  // live right now. Cheap: a wiki-link scan over the module's text plus a walk
  // of the campaign's artifacts.
  //
  // "Fix module problems" turns on only for a problem a TEXT REWRITE can fix
  // (the encounter floor). The unresolved links it also detects are the READER's
  // "not detailed yet" chips — entity work, which the owner placed outside this
  // action ("This is about the module text, not entities"), so they are reported
  // in the confirmation and never turn this control on.
  const problemSet = deriveModuleProblems(currentModule, pool);
  const fixableProblems = problemSet.repairable;
  // "Resume automatic module creation" turns on when the live state falls short
  // of the RECORDED intent (`automationIntent`) — entities by kind, images,
  // battle maps, mob portraits. Legacy rows recorded no intent and stay inert.
  const deviation = deriveAutomationDeviation(currentModule, artifacts);
  const resumable = !deviationIsEmpty(deviation);
  // Both actions rewrite the module's text/state ON DISK, so they are disabled
  // while the editor holds unsaved edits (an honest reason, shown as the
  // button's title), while a proposal is pending (a remount would drop it) and
  // while the module is generating.
  const derivedBlocked = derivedActionBlockedReason();
  const wholeProposal = suggestions.find((entry) => entry.wholePart);
  const aiBlocked = busy || refineInFlight || wholeProposal !== undefined;
  const viewBusy = busy || refineInFlight || suggestions.length > 0;

  // The preview highlight: the whole-doc replacement mapped onto its
  // part's range (identity-gated — a hand edit, proposal accept or next
  // apply clears/replaces the page state, and a broken scaffolding simply
  // shows no highlight while the preview shows its loud reason).
  let previewHighlight: { planIndex: number; from: number; to: number } | null = null;
  if (
    lastReplacement !== null &&
    previewSource !== null &&
    previewSource === lastReplacement.doc &&
    lastReplacement.to > lastReplacement.from
  ) {
    try {
      const highlightSections = splitPartsDocument(previewSource, currentModule.spine.partPlan);
      const highlightSection = highlightSections.find(
        (section) => lastReplacement.from >= section.textFrom && lastReplacement.to <= section.textTo,
      );
      if (highlightSection !== undefined) {
        previewHighlight = {
          planIndex: highlightSection.planIndex,
          from: lastReplacement.from - highlightSection.textFrom,
          to: lastReplacement.to - highlightSection.textFrom,
        };
      }
    } catch {
      // Broken scaffolding: no highlight — the preview shows the loud reason.
    }
  }

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
   *
   * `ai` saves also take the durable whole-document snapshot BEFORE writing
   * (docs/18 §2.3 simple undo), so the caller passes the AI action it is
   * landing; a missing source throws inside the seam and this catch surfaces
   * it loudly with nothing written.
   */
  async function saveDoc(
    origin: 'user' | 'ai',
    label: string,
    successMessage: string | null,
    version?: { source: ModuleVersionSource; label: string },
  ): Promise<void> {
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
        ...(version === undefined ? {} : { version }),
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
    const proposalLabel = `${isSelection ? 'Refine' : 'Rewrite'}: ${instructionText}`;
    proposalsRef.current.set(id, {
      instruction: instructionText,
      wholePart: !isSelection,
      ledgerLabel: proposalLabel,
      versionSource: isSelection ? 'refine' : 'rewrite',
      versionLabel: proposalLabel,
      successMessage: isSelection ? 'Proposal applied' : 'Rewrite applied',
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
          turn: controller,
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
   * (only the part(s) the proposal touched hit the row), appends the session
   * ledger entry per changed part, and takes the durable pre-change snapshot
   * for the AI source the proposal recorded (docs/18 §2.3). A failed save
   * toasts loudly and leaves the editor text (Save retries from there).
   */
  async function handleSuggestionAccepted(id: string): Promise<void> {
    const meta = proposalsRef.current.get(id);
    proposalsRef.current.delete(id);
    const view = activeCanvasView.current;
    if (view === null) return;
    await saveDoc(
      'ai',
      meta?.ledgerLabel ?? 'AI proposal',
      meta?.successMessage ?? (meta?.wholePart === true ? 'Rewrite applied' : 'Proposal applied'),
      {
        source: meta?.versionSource ?? 'chat',
        label: meta?.versionLabel ?? meta?.ledgerLabel ?? 'AI proposal',
      },
    );
    syncSuggestions();
  }

  /**
   * The restore door for a DURABLE version (docs/18 §2.3): the stored whole
   * document is VALIDATED against the CURRENT part plan first — a version
   * saved under a different plan (a re-drafted spine) would produce a doc
   * whose scaffold labels lie, so it is refused LOUDLY instead of proposed —
   * then it rides the SAME proposal machinery as every other AI change (a
   * block replace over the whole document, NO side-door row write). Accepting
   * it lands through the split-save, and because that save is an AI save it
   * snapshots the pre-restore document first: a wrong restore stays
   * recoverable. Restore needs the mounted editor (the suggestion machinery
   * is CM6 state), so preview mode says so loudly instead of doing nothing.
   */
  function restoreDurableVersion(version: ModuleDocumentVersion): void {
    const view = activeCanvasView.current;
    if (view === null) {
      toastInfo('Switch back to Edit to restore a saved version — the editor is not mounted in preview.');
      return;
    }
    if (pendingSuggestions(view.state).length > 0) {
      toastInfo('Discard the pending proposal first.');
      return;
    }
    try {
      splitPartsDocument(version.docText, currentModule.spine?.partPlan ?? []);
    } catch (error) {
      toastError(
        'Could not restore that version — it was saved for a different part plan, so its part labels no longer match this module.',
        error,
      );
      return;
    }
    const doc = view.state.doc.toString();
    const label = `Restore from ${new Date(version.createdAt).toLocaleString()}`;
    const id = newSuggestionId();
    proposalsRef.current.set(id, {
      instruction: label,
      wholePart: true,
      ledgerLabel: label,
      versionSource: 'restore',
      versionLabel: label,
      successMessage: 'Version restored',
    });
    proposeSuggestion(view, {
      id,
      from: 0,
      to: doc.length,
      originalText: doc,
      proposedText: version.docText,
      instruction: label,
      streaming: false,
      wholePart: true,
    });
    syncSuggestions();
  }

  /** Restore proposes an older per-part version through the SAME suggestion
   * machinery — a block replace over THAT part's current section range;
   * accepting it rides undo and the save path like any AI proposal (no
   * side-door write), and the durable pre-restore snapshot makes the restore
   * itself undoable. */
  function restoreVersion(planIndex: number, entry: CanvasVersionEntry): void {
    const view = activeCanvasView.current;
    if (view === null) {
      toastInfo('Switch back to Edit to restore a version — the editor is not mounted in preview.');
      return;
    }
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
    const sessionRestoreLabel = `Restored version #${String(entry.seq)}`;
    proposalsRef.current.set(id, {
      instruction: sessionRestoreLabel,
      wholePart: true,
      ledgerLabel: sessionRestoreLabel,
      versionSource: 'restore',
      // The durable snapshot describes the change ABOUT to happen, so it is
      // stamped with the time of the version being restored (the session seq
      // means nothing in the durable stack).
      versionLabel: `Restore from ${new Date(entry.createdAt).toLocaleString()}`,
      successMessage: 'Version restored',
    });
    proposeSuggestion(view, {
      id,
      from: section.textFrom,
      to: section.textTo,
      originalText: section.text,
      proposedText: entry.markdown,
      instruction: sessionRestoreLabel,
      streaming: false,
      wholePart: true,
    });
    syncSuggestions();
  }

  /**
   * "Clear all previous versions" (docs/18 §2.3, owner-directed): empties THIS
   * module's durable version stack in one confirmed action. NO snapshot is
   * taken first — that would immediately re-create what was just cleared.
   * Another module's stack is untouched (the sweep is keyed by moduleId), the
   * module's DOCUMENT text is untouched, and the count in the loud success
   * toast is the number of rows that actually went (re-listed inside the
   * repo's transaction, never the count the dialog showed).
   */
  async function confirmClearVersions(): Promise<void> {
    setVersionsClearOpen(false);
    try {
      const removed = await clearModuleVersions(currentModule.id);
      toastSuccess(
        `Cleared ${String(removed)} ${savedVersionsNoun(removed)} for this module — the document text was not changed`,
      );
    } catch (error) {
      toastError('Could not clear the saved versions — nothing was removed', error);
    }
  }

  /**
   * Lands a settled preview chat turn in page state: the snapshot (and the
   * editor mirror + save baseline, so the leave-guard stays honest) advances
   * to the post-turn doc, and the last-replacement highlight is set from the
   * last command's first applied range. A turn that applied nothing leaves
   * the existing highlight alone (identity-gated either way).
   */
  function applyPreviewTurnResult(result: SnapshotChatTurnResult): void {
    if (result.docChanged) {
      setPreviewDoc(result.doc);
      setBaselineDoc(result.doc);
      setDocText(result.doc);
    }
    if (result.lastApplied !== null) {
      setLastReplacement({
        doc: result.doc,
        from: result.lastApplied.from,
        to: result.lastApplied.to,
      });
    }
  }

  function snapshotTurnOptions(): {
    key: string;
    modelSelection: string | null;
    hasPlannedParts: boolean;
  } {
    const key = canvasChatKey(moduleId);
    return {
      key,
      modelSelection: useCanvasChatStore.getState().module(key).modelSelection,
      hasPlannedParts: plans.length > 0,
    };
  }

  /**
   * Preview-mode chat send: the turn runs against the preview SNAPSHOT
   * STRING (no view — the editor is unmounted) through the same protocol +
   * ladder, persists through the existing split-save, and re-renders the
   * preview. A scaffolding-broken snapshot fails the send LOUDLY through
   * the existing `ModulePartsDocumentError` path (failed card). Busy
   * rethrows for the sidebar's toast (canvasRefine surface).
   */
  async function handlePreviewSend(text: string): Promise<void> {
    const source = previewDoc ?? mountDoc ?? initialDoc;
    if (source === null) {
      toastError('The preview is not ready — try again', new Error('canvas preview snapshot missing'));
      return;
    }
    const controller = new AbortController();
    previewAbortRef.current = controller;
    try {
      const options = snapshotTurnOptions();
      const result = await runSnapshotChatTurn(
        {
          moduleId,
          key: options.key,
          hasPlannedParts: options.hasPlannedParts,
          doc: source,
          modelSelection: options.modelSelection,
          turn: controller,
        },
        text,
      );
      applyPreviewTurnResult(result);
    } finally {
      if (previewAbortRef.current === controller) previewAbortRef.current = null;
    }
  }

  /** Preview-mode Report-to-LLM for a failed OUTCOME (excerpt from the CURRENT snapshot). */
  function handlePreviewReportOutcome(messageId: string, outcome: CanvasChatOutcome): void {
    const source = previewDoc ?? mountDoc ?? initialDoc;
    if (source === null) {
      toastError('The preview is not ready — try again', new Error('canvas preview snapshot missing'));
      return;
    }
    const controller = new AbortController();
    previewAbortRef.current = controller;
    const options = snapshotTurnOptions();
    void reportSnapshotOutcome(
      {
        moduleId,
        key: options.key,
        hasPlannedParts: options.hasPlannedParts,
        doc: source,
        modelSelection: options.modelSelection,
        turn: controller,
      },
      messageId,
      outcome,
    )
      .then(applyPreviewTurnResult)
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          // The turn was cancelled — by the user's own stop, or by the
          // app-level Stop all (the canvas abort registry aborts this same
          // controller). A cancel is not an error and needs no surface.
        } else if (error instanceof ModuleBusyError) {
          toastError('A generation is already running for this module — wait for it or stop it first', error);
        } else {
          toastError('Chat failed', error);
        }
      })
      .finally(() => {
        if (previewAbortRef.current === controller) previewAbortRef.current = null;
      });
  }

  /** Preview-mode Report-to-LLM for a failed REPLY (excerpt from the CURRENT snapshot). */
  function handlePreviewReportMessage(message: CanvasChatMessage): void {
    const source = previewDoc ?? mountDoc ?? initialDoc;
    if (source === null) {
      toastError('The preview is not ready — try again', new Error('canvas preview snapshot missing'));
      return;
    }
    const controller = new AbortController();
    previewAbortRef.current = controller;
    const options = snapshotTurnOptions();
    void reportSnapshotMessage(
      {
        moduleId,
        key: options.key,
        hasPlannedParts: options.hasPlannedParts,
        doc: source,
        modelSelection: options.modelSelection,
        turn: controller,
      },
      message,
    )
      .then(applyPreviewTurnResult)
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          // The turn was cancelled — by the user's own stop, or by the
          // app-level Stop all (the canvas abort registry aborts this same
          // controller). A cancel is not an error and needs no surface.
        } else if (error instanceof ModuleBusyError) {
          toastError('A generation is already running for this module — wait for it or stop it first', error);
        } else {
          toastError('Chat failed', error);
        }
      })
      .finally(() => {
        if (previewAbortRef.current === controller) previewAbortRef.current = null;
      });
  }

  /**
   * Editor-mode turn settled: the doc already holds the edits (CM6
   * transactions with normal history — undoable); only the highlight is
   * page state.
   */
  function handleEditorTurnApplied(doc: string, lastApplied: { from: number; to: number } | null): void {
    if (lastApplied !== null) {
      setLastReplacement({ doc, from: lastApplied.from, to: lastApplied.to });
    }
  }

  /**
   * Why the two derived controls are disabled right now (null = they are not).
   * One function, so the button's `title` always tells the owner the honest
   * reason instead of leaving a dead control to be guessed at.
   */
  function derivedActionBlockedReason(): string | null {
    if (busy) return 'The module is generating right now — wait for it (or press Stop).';
    if (refineInFlight) return 'A refine is running.';
    if (suggestions.length > 0) return 'Accept or discard the pending proposal first.';
    if (saving) return 'A save is in flight.';
    if (dirty) {
      return 'Save or discard your edits first — this action rewrites the module text on disk, not the editor copy.';
    }
    return null;
  }

  /**
   * Re-seeds the page's document state from a module row rewritten OUTSIDE the
   * editor ("Fix module problems" rewriting part text, the resume's name
   * normalization). The editor owns the session's document, so without this the
   * canvas would keep a stale doc whose next Save writes the OLD text back over
   * the repair; the doc epoch remounts the editor from the fresh row.
   */
  function reseedFromRow(row: Module): void {
    if (row.spine === null || row.spine.partPlan.length === 0) return;
    const assembled = assembleModulePartsDocument({
      partPlan: row.spine.partPlan,
      parts: row.parts,
    });
    setInitialDoc(assembled.document);
    setBaselineDoc(assembled.document);
    setMountDoc(assembled.document);
    setDocText(assembled.document);
    setPreviewDoc(previewOpen ? assembled.document : null);
    setLastReplacement(null);
    setDocEpoch((epoch) => epoch + 1);
  }

  /**
   * "Fix module problems" — rewrites ONLY the parts the confirmation named, for
   * the check it named, through the EXISTING floor-repair seam (one attempt per
   * part, a durable whole-document snapshot first, `toastError` if a repair
   * still fails). The scope is passed from the confirmation; the seam re-derives
   * it against the live row, so it can only ever rewrite LESS than promised.
   */
  async function handleFixProblems(): Promise<void> {
    if (fixRunning) return;
    setFixOpen(false);
    setFixRunning(true);
    try {
      const outcome = await repairModuleEncounterFloor(
        currentModule.id,
        currentCampaign,
        fixableProblems.map((problem) => problem.planIndex),
      );
      const row = await getModule(currentModule.id);
      if (row !== undefined) reseedFromRow(row);
      // Every other outcome is toasted by the seam itself (which parts it
      // rewrote, which failed, and whether the floor is met). The one silent
      // case is a scope that closed between the confirmation and the run: say so
      // rather than appear to have done nothing.
      if (outcome.attempted.length === 0 && outcome.skipped.length > 0) {
        toastInfo(
          'Nothing to fix any more — those parts already meet the encounter floor (the text changed since the confirmation opened). Nothing was rewritten.',
        );
      }
    } catch (error) {
      toastError('Could not fix the module problems', error);
    } finally {
      setFixRunning(false);
    }
  }

  /**
   * "Resume automatic module creation" — generates ONLY what the confirmation
   * listed as missing, additively, through the existing post-generation sweep.
   * The resume captures the stop epoch at entry, so "Stop all" during it stops
   * it; every refusal reason is toasted by the seam itself.
   */
  async function handleResumeAutomation(): Promise<void> {
    if (resumeRunning) return;
    setResumeOpen(false);
    setResumeRunning(true);
    try {
      const report = await resumeModuleAutomation(currentModule.id, currentCampaign);
      const row = await getModule(currentModule.id);
      if (row !== undefined) reseedFromRow(row);
      if (report.empty && report.refused === null) {
        toastInfo(
          'Nothing is missing any more — the module already has everything creation was asked to automate.',
        );
      }
    } catch (error) {
      toastError('Could not resume automatic module creation', error);
    } finally {
      setResumeRunning(false);
    }
  }

  function togglePreview(): void {
    const next = !previewOpen;
    if (next) {
      const view = activeCanvasView.current;
      if (view !== null) {
        setPreviewDoc(view.state.doc.toString());
      } else if (previewSource !== null) {
        // First open (the preview is the default view — the editor never
        // mounted): render from the assembled/mount doc.
        setPreviewDoc(previewSource);
      } else {
        return;
      }
    } else {
      // Return from the preview: the editor remounts — hand it the LATEST
      // snapshot (preview turns rewrote it) through the existing mountDoc
      // path, so unsaved edits and preview-applied edits survive.
      setMountDoc(previewSource ?? mountDoc ?? initialDoc);
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
          {fixableProblems.length > 0 && (
            <Button
              variant="outline"
              size="xs"
              disabled={derivedBlocked !== null || fixRunning}
              title={derivedBlocked ?? 'Rewrite the parts whose text falls short of the encounter floor'}
              data-testid="canvas-fix-problems"
              onClick={() => {
                setFixOpen(true);
              }}
            >
              <WrenchIcon aria-hidden data-icon="inline-start" />
              {fixRunning ? 'Fixing…' : 'Fix module problems'}
            </Button>
          )}
          {resumable && (
            <Button
              variant="outline"
              size="xs"
              disabled={derivedBlocked !== null || resumeRunning}
              title={derivedBlocked ?? 'Generate only what creation was asked to automate and the module does not have yet'}
              data-testid="canvas-resume-automation"
              onClick={() => {
                setResumeOpen(true);
              }}
            >
              <PlayIcon aria-hidden data-icon="inline-start" />
              {resumeRunning ? 'Resuming…' : 'Resume automatic module creation'}
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="ghost" size="xs" data-testid="canvas-versions">
                  <HistoryIcon aria-hidden data-icon="inline-start" />
                  Versions
                </Button>
              }
            />
            <DropdownMenuContent align="end" className="max-h-96 w-96 overflow-y-auto">
              <DropdownMenuGroup>
                <DropdownMenuLabel data-testid="canvas-saved-versions-label">
                  {`Saved versions — the whole document as it was BEFORE each AI change (keeping the most recent ${String(MODULE_VERSION_CAP)})`}
                </DropdownMenuLabel>
                {durableVersions === undefined ? (
                  <p
                    className="px-2 py-3 text-sm text-muted-foreground"
                    data-testid="canvas-saved-versions-loading"
                  >
                    Loading saved versions…
                  </p>
                ) : durableVersions.length === 0 ? (
                  <p
                    className="px-2 py-3 text-sm text-muted-foreground"
                    data-testid="canvas-saved-versions-empty"
                  >
                    No saved versions yet — one is saved before every AI change, and any of them can be
                    restored from here.
                  </p>
                ) : (
                  durableVersions.map((version) => (
                    <DropdownMenuItem
                      key={version.id}
                      data-testid={`canvas-saved-version-${version.id}`}
                      onClick={() => {
                        restoreDurableVersion(version);
                      }}
                    >
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-sm">{version.label}</span>
                        <span className="text-xs text-muted-foreground">
                          {MODULE_VERSION_SOURCE_LABELS[version.source]} ·{' '}
                          {new Date(version.createdAt).toLocaleString()}
                        </span>
                      </span>
                      <span className="ml-auto pl-2 text-xs text-muted-foreground">Restore</span>
                    </DropdownMenuItem>
                  ))
                )}
                <DropdownMenuItem
                  data-testid="canvas-versions-clear"
                  disabled={durableVersions === undefined || durableVersions.length === 0}
                  onClick={() => {
                    setVersionsClearOpen(true);
                  }}
                >
                  <Trash2Icon aria-hidden data-icon="inline-start" />
                  Clear all previous versions
                </DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel>Session versions — this session only, die on reload</DropdownMenuLabel>
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
                            <span className="ml-auto pl-2 text-xs text-muted-foreground">Restore</span>
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
            previewOpen={previewOpen}
            onPreviewSend={(text) => handlePreviewSend(text)}
            onPreviewReportOutcome={(messageId, outcome) => {
              handlePreviewReportOutcome(messageId, outcome);
            }}
            onPreviewReportMessage={(message) => {
              handlePreviewReportMessage(message);
            }}
            onPreviewStop={() => {
              previewAbortRef.current?.abort();
            }}
            onEditorTurnApplied={(doc, applied) => {
              handleEditorTurnApplied(doc, applied);
            }}
            onChatCleared={() => {
              // Clear chat (ChatSidebar): the thread + this module's session
              // ledger are already pristine — the highlight is PAGE state, so
              // dropping it here is what removes the mark from BOTH surfaces
              // (the editor's CM6 field and the preview wash).
              setLastReplacement(null);
            }}
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
          {previewOpen && previewSource !== null ? (
            <CanvasPreview
              doc={previewSource}
              module={currentModule}
              artifacts={pool}
              moduleId={currentModule.id}
              highlight={previewHighlight}
              onOpenArtifact={(artifact) => {
                setPeekArtifact(artifact);
              }}
            />
          ) : (
            <div className="flex min-h-0 flex-1 flex-col p-4">
              <CanvasEditor
                key={`${currentModule.id}:${String(docEpoch)}`}
                initialMarkdown={mountDoc ?? initialDoc}
                artifacts={pool}
                moduleId={currentModule.id}
                replacement={lastReplacement}
                onChange={(doc) => {
                  setDocText(doc);
                  // The mark renders only on doc identity: any edit that
                  // moves the text away from the stored post-apply string
                  // (hand edit, proposal accept, next apply) clears it.
                  setLastReplacement((previous) =>
                    previous !== null && doc !== previous.doc ? null : previous,
                  );
                }}
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

      {/* "Fix module problems": the confirmation NAMES what it will rewrite —
          which parts, which check, and that the current text is snapshotted
          first — plus the problems it detected and will NOT touch (they are
          entity work, and they never turn this control on). */}
      <AlertDialog open={fixOpen} onOpenChange={setFixOpen}>
        <AlertDialogContent data-testid="canvas-fix-problems-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Fix module problems?</AlertDialogTitle>
            <AlertDialogDescription>
              This rewrites the module TEXT only — no entities, no images. One attempt per part, and
              the text as it is now is saved as a version first, so it can be restored from Versions.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2 text-sm">
            <p className="font-medium">It will rewrite:</p>
            <ul className="list-disc space-y-1 pl-5" data-testid="canvas-fix-problems-list">
              {fixableProblems.map((problem) => (
                <li key={`fix-${String(problem.planIndex)}`} data-testid="canvas-fix-problem">
                  {problem.label}
                </li>
              ))}
            </ul>
            {problemSet.reported.length > 0 && (
              <>
                <p className="font-medium">Also detected, not fixed here (entity work):</p>
                <ul className="list-disc space-y-1 pl-5" data-testid="canvas-fix-problems-reported">
                  {problemSet.reported.map((problem) => (
                    <li key={`reported-${problem.name}`} data-testid="canvas-fix-reported">
                      {problem.label}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="canvas-fix-problems-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="canvas-fix-problems-confirm"
              onClick={() => {
                void handleFixProblems();
              }}
            >
              Fix module problems
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* "Resume automatic module creation": the confirmation names what is
          MISSING (derived from the recorded intent) and states that only that
          is generated. */}
      <AlertDialog open={resumeOpen} onOpenChange={setResumeOpen}>
        <AlertDialogContent data-testid="canvas-resume-automation-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Resume automatic module creation?</AlertDialogTitle>
            <AlertDialogDescription>
              Only what is missing is generated, additively — nothing that already exists is
              re-generated, re-detailed or overwritten. The jobs run in the background and appear in
              the progress dock; Stop all ends them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="list-disc space-y-1 pl-5 text-sm" data-testid="canvas-resume-automation-list">
            {deviationLines(deviation).map((line) => (
              <li key={line} data-testid="canvas-resume-automation-line">
                {line}
              </li>
            ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="canvas-resume-automation-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="canvas-resume-automation-confirm"
              onClick={() => {
                void handleResumeAutomation();
              }}
            >
              Resume automatic module creation
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={versionsClearOpen} onOpenChange={setVersionsClearOpen}>
        <AlertDialogContent data-testid="canvas-versions-clear-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Clear all previous versions for this module?</AlertDialogTitle>
            <AlertDialogDescription data-testid="canvas-versions-clear-description">
              {`Cleared: all ${String(durableVersions?.length ?? 0)} ${savedVersionsNoun(durableVersions?.length ?? 0)} of THIS module — the whole-document snapshots taken before each AI change, in every session, not just this one. Clearing them is permanent: no version is saved first, so this is the one action the undo stack cannot take back.`}
              <br />
              <br />
              {"NOT cleared: the module's DOCUMENT TEXT — the current text stays exactly as it is (this is not an undo, and the text is not touched); the chat thread and this session's Versions list; and every OTHER module's saved versions."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="canvas-versions-clear-cancel">Keep versions</AlertDialogCancel>
            <AlertDialogAction
              data-testid="canvas-versions-clear-confirm"
              onClick={() => {
                void confirmClearVersions();
              }}
            >
              Clear all versions
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
