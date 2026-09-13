import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  BanIcon,
  ArrowLeftIcon,
  ListIcon,
  LoaderCircleIcon,
  MessageSquareTextIcon,
  NetworkIcon,
  PencilIcon,
  PlayIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SquarePenIcon,
  SwordsIcon,
  TriangleAlertIcon,
} from 'lucide-react';

import { artifactPath, battlePath, boardPath, canvasChatPath, canvasPath, modulesPath } from '@/app/routes';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { WriterModelId } from '@/components/writer-model-id';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { AnyArtifact, Campaign, Id, Module, ModulePart } from '@/domain';
import { MODULE_SIZE_LABELS, entityKindFor, moduleDocumentText, moduleTagFor } from '@/domain';
import { artifactRepo } from '@/db';
import { getCampaign } from '@/db/campaignRepo';
import { patchModule } from '@/db/moduleRepo';
import { readSettings, updateSettings } from '@/db/settingsRepo';
import { saveModulePartText } from '@/features/modules/partText';
import { useArtifacts, useCampaign, useGlobalArtifacts, useScopedArtifacts } from '@/features/campaign/hooks';
import { WikiMarkdown } from '@/features/campaign/components/wiki-markdown';
import { useModule } from '@/features/modules/hooks';
import { GenerateModuleCoverButton, ModuleCoverHero } from '@/features/covers/cover-art';
import { EntityPanel } from '@/features/modules/entity-panel';
import { useCreaturePresentation } from '@/app/use-creature-presentation';
import { PartTextEditor } from '@/features/modules/part-text-editor';
import { modulePartWriterLabel } from '@/features/modules/module-problems';
import { PeekModal } from '@/features/modules/peek-modal';
import { QuickFindDialog } from '@/features/quickfind/quickfind-dialog';
import { ReaderSearch } from '@/features/modules/reader-search';
import { SpineCheckpoint } from '@/features/modules/spine-checkpoint';
import { StubPopover, type StubPopoverState } from '@/features/modules/stub-popover';
import { streamTails, useStreamTail } from '@/features/modules/streamTails';
import { sentenceAround, surroundingParagraphs } from '@/lib/wikilinks';
import {
  generateMissingParts,
  moduleGenEvents,
  rewritePart,
  retrySpine,
} from '@/llm/moduleGen';
import { stopModuleGeneration } from '@/llm/moduleGenReconcile';
import { toastError, toastSuccess } from '@/lib/toast';
import { cn } from '@/lib/utils';

/**
 * Module reader (08-MODULE-DESIGNER M4-A): the module front and center — one
 * full-width scrollable document, large type, parts as chapters
 * (H1 = part title with level-band badge), spine premise as the intro.
 * Sticky mini-ToC on the left, entity panel on the right, per-part ✎ editing
 * (save on blur), wiki-link chips everywhere through the shared WikiMarkdown.
 */

export function ModuleReaderPage(): JSX.Element {
  const { campaignId = '', moduleId = '' } = useParams<{ campaignId: string; moduleId: string }>();
  const campaign = useCampaign(campaignId === '' ? undefined : campaignId);
  const module = useModule(moduleId === '' ? undefined : moduleId);
  const artifacts = useArtifacts(campaignId === '' ? undefined : campaignId);
  // The creature PRESENTATION snapshot the entity panel is handed (docs/11 D6):
  // the page owns data reads, the panel stays a pure function of its props.
  const creaturePresentation = useCreaturePresentation(campaignId);
  // Module text resolves against the campaign pool PLUS the shared library —
  // a module quoting a global entity ("[[Goblin Warrior]]") must render a
  // resolved chip, not a stub. The combined pool feeds ONLY the reader's
  // IntroBlock/PartBody markdown; the entity panel, peek modal and the
  // link-existing picker keep the campaign-only pool (10-MILESTONE-6 D).
  const globalArtifacts = useGlobalArtifacts();
  const location = useLocation();
  const navigate = useNavigate();

  const [stub, setStub] = useState<StubPopoverState | null>(null);
  const [linkTargetName, setLinkTargetName] = useState<string | null>(null);
  const [peekId, setPeekId] = useState<Id | null>(null);
  const [tocOpen, setTocOpen] = useState(true);
  /** The scrollable document — ReaderSearch walks its rendered text. */
  const documentRef = useRef<HTMLDivElement>(null);
  const [rewriteTarget, setRewriteTarget] = useState<number | null>(null);
  const [rewriteInstruction, setRewriteInstruction] = useState('');
  const [editPartIndex, setEditPartIndex] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState('');

  // Streaming tails (in-memory emitter → never persisted) live in an EXTERNAL
  // store, not page state: a token tick must re-render ONLY the card that is
  // streaming (features/modules/streamTails + `StreamingTail`). As page state
  // it re-rendered this whole page per delta, re-parsing every part's
  // markdown — the measured cause of the slow, jumpy scroll during
  // generation. This effect owns the store's lifetime for the mounted module:
  // it is emptied on unmount (a later mount must never show the previous
  // visit's tails).
  useEffect(() => {
    streamTails.reset(moduleId);
    return () => {
      streamTails.reset(moduleId);
    };
  }, [moduleId]);

  // Every hook runs before the loading/missing guards below (Rules of Hooks:
  // a hook can never sit behind an early return).
  //
  // ONE array per artifact arrival: a fresh concat every render is a fresh
  // prop identity for every memoized body in the document, which would
  // re-parse all of them for a page state change that has nothing to do with
  // them.
  const readerArtifacts: readonly AnyArtifact[] = useMemo(
    () => [...(artifacts ?? []), ...(globalArtifacts ?? [])],
    [artifacts, globalArtifacts],
  );
  // Stable identities for the props of the memoized bodies: any state change
  // in this page (a stub click, an edit-draft keystroke, a streaming tick)
  // must not hand a part body a fresh prop and re-parse its markdown.
  // `saveEditPart` calls the CURRENT save closure through a ref, so its
  // identity is stable while its behavior is always that of this render.
  const openArtifact = useCallback((artifact: AnyArtifact) => {
    setPeekId(artifact.id);
  }, []);
  const openStub = useCallback((name: string, anchor: { x: number; y: number }) => {
    setStub({ name, ...anchor });
  }, []);
  const cancelEditPart = useCallback(() => {
    setEditPartIndex(null);
  }, []);
  const changeEditDraft = useCallback((value: string) => {
    setEditDraft(value);
  }, []);
  const saveEditRef = useRef<() => void>(() => undefined);
  const saveEditPart = useCallback(() => {
    saveEditRef.current();
  }, []);
  const retryPart = useCallback(
    (planIndex: number) => {
      void (async () => {
        try {
          const camp = await getCampaign(campaignId);
          if (camp === undefined) throw new Error('Campaign no longer exists');
          await rewritePart(moduleId, camp, planIndex);
        } catch (error) {
          toastError('Could not retry the part', error);
        }
      })();
    },
    [campaignId, moduleId],
  );

  // `#part-<index>` deep links (quick-find "select scrolls the reader").
  useEffect(() => {
    if (module === undefined || module === null) return;
    const match = /^#part-(\d+)$/.exec(location.hash);
    if (match === null) return;
    const element = document.getElementById(`part-${match[1] ?? ''}`);
    element?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [location.hash, module]);

  // Last-used module shortcut (settings.lastModule): opening a reader is the
  // "most recent module" event, so the mount persists it for the TopBar
  // entry. Written whole (updateSettings merges one level deep) and only
  // when it differs — re-mounting the same module must not churn the row.
  useEffect(() => {
    if (module === undefined || module === null) return;
    const next = {
      campaignId,
      moduleId,
      name: module.title,
    };
    void readSettings()
      .then(async (current) => {
        const last = current.lastModule;
        if (
          last !== null &&
          last.campaignId === next.campaignId &&
          last.moduleId === next.moduleId &&
          last.name === next.name
        ) {
          return;
        }
        await updateSettings({ lastModule: next });
      })
      .catch((error: unknown) => {
        // The shortcut is an enrichment, not a reader requirement — but a
        // failure is never silent (AGENTS rule 2).
        toastError('Could not save the last-used module', error);
      });
  }, [campaignId, moduleId, module]);

  if (
    campaign === undefined ||
    module === undefined ||
    artifacts === undefined ||
    globalArtifacts === undefined
  ) {
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;
  }
  if (campaign === null) {
    return (
      <MissingModule
        message="This campaign does not exist (it may have been deleted)."
        campaignId={campaignId}
      />
    );
  }
  if (module === null) {
    return (
      <MissingModule message="This module does not exist (it may have been deleted)." campaignId={campaignId} />
    );
  }

  // Narrowed locals: closures below (function declarations) can't rely on the
  // guards above for narrowing.
  const currentModule: Module = module;
  const currentCampaign: Campaign = campaign;

  const busy = module.status === 'generating';
  const parts = module.parts.slice().sort((a, b) => a.planIndex - b.planIndex);
  const plans =
    module.spine !== null
      ? module.spine.partPlan.map((plan, index) => ({ plan, index }))
      : [];
  const hasMissingParts = plans.some(({ index }) => {
    const part = module.parts.find((entry) => entry.planIndex === index);
    return part?.status !== 'ready';
  });

  const peekArtifact =
    peekId !== null ? artifacts.find((artifact) => artifact.id === peekId) : undefined;

  function startEditPart(part: ModulePart): void {
    setEditPartIndex(part.planIndex);
    setEditDraft(part.markdown);
  }

  async function savePartEdit(): Promise<void> {
    const index = editPartIndex;
    if (index === null) return;
    setEditPartIndex(null);
    try {
      await patchModuleTextPart(currentModule, index, editDraft);
      toastSuccess('Part saved');
    } catch (error) {
      toastError('Could not save the part', error);
    }
  }
  saveEditRef.current = () => {
    void savePartEdit();
  };

  function requestRewrite(planIndex: number): void {
    setRewriteInstruction('');
    setRewriteTarget(planIndex);
  }

  async function confirmRewrite(): Promise<void> {
    const index = rewriteTarget;
    if (index === null) return;
    setRewriteTarget(null);
    await rewritePart(moduleId, currentCampaign, index, rewriteInstruction.trim());
  }

  async function linkExisting(artifact: AnyArtifact): Promise<void> {
    const name = linkTargetName;
    if (name === null) return;
    setLinkTargetName(null);
    try {
      // The ONE alias write path (`artifactRepo.addArtifactAliases`): the merge
      // rule lives in `domain/artifactAlias` and compares TRIMMED, so an
      // existing alias spelled `"Kael "` no longer gets a duplicate `"Kael"`
      // appended here while `entity-batch.alignEntityName` skipped it — the two
      // surfaces now agree, and a pool that already answers writes nothing.
      await artifactRepo.addArtifactAliases(artifact.id, [name]);
      toastSuccess(`“${name}” now resolves to ${artifact.name}`);
    } catch (error) {
      toastError('Could not use the existing entity', error);
    }
  }

  return (
    <div className="flex h-full min-h-0" data-testid="module-reader">
      {/* The ONE reader subscription to the generator's token emitter: it
          publishes each delta into `streamTails` and renders nothing, so a
          token tick re-renders a streaming card and never this page. */}
      <ModuleGenTailsBridge moduleId={moduleId} />
      {/* Mini-ToC */}
      {tocOpen ? (
        <nav
          aria-label="Table of contents"
          className="w-56 shrink-0 overflow-y-auto overscroll-contain border-r bg-card px-3 py-4 text-sm"
          data-testid="module-toc"
        >
          <ReaderSearch containerRef={documentRef} />
          <Button
            variant="ghost"
            size="xs"
            className="mb-2"
            render={<Link to={modulesPath(campaignId)} />}
            nativeButton={false}
          >
            <ArrowLeftIcon aria-hidden data-icon="inline-start" />
            All modules
          </Button>
          <Button
            variant="outline"
            size="xs"
            className="mb-3 w-full"
            render={<Link to={battlePath(campaignId, moduleId)} />}
            nativeButton={false}
          >
            <SwordsIcon aria-hidden data-icon="inline-start" />
            Battle table
          </Button>
          <p className="mb-1 px-1 text-xs tracking-wide text-muted-foreground uppercase">
            Contents
          </p>
          <button
            type="button"
            className="block w-full truncate rounded px-2 py-1 text-left hover:bg-accent"
            onClick={() => {
              document.getElementById('module-intro')?.scrollIntoView({ behavior: 'smooth' });
            }}
          >
            Intro
          </button>
          {plans.map(({ plan, index }) => {
            const part = module.parts.find((entry) => entry.planIndex === index);
            return (
              <button
                key={index}
                type="button"
                className="flex w-full items-center gap-1.5 truncate rounded px-2 py-1 text-left hover:bg-accent"
                onClick={() => {
                  document.getElementById(`part-${String(index)}`)?.scrollIntoView({ behavior: 'smooth' });
                }}
              >
                <span
                  aria-hidden
                  className={cn(
                    'size-1.5 shrink-0 rounded-full',
                    part === undefined || part.status === 'pending'
                      ? 'bg-muted-foreground/40'
                      : part.status === 'ready'
                        ? 'bg-emerald-500'
                        : part.status === 'generating'
                          ? 'animate-pulse bg-sky-500'
                          : 'bg-destructive',
                  )}
                />
                <span className="truncate">
                  {plan.levelBand} · {plan.title}
                </span>
              </button>
            );
          })}
        </nav>
      ) : (
        <Button
          variant="ghost"
          size="icon-sm"
          className="m-2 self-start"
          aria-label="Show table of contents"
          onClick={() => {
            setTocOpen(true);
          }}
        >
          <ListIcon aria-hidden />
        </Button>
      )}

      {/* Document */}
      <div ref={documentRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <article className="px-8 py-10 text-[0.9375rem] leading-relaxed">
          <header className="mb-8 border-b pb-4">
            {/* Cover hero (cover-generation arc): the banner renders only
                when the module has cover art — the header shape never shifts
                for cover-less modules. */}
            <ModuleCoverHero module={module} />
            <ModuleTitleInput module={module} />
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Badge variant="outline">
                Levels {module.levelMin}–{module.levelMax}
              </Badge>
              <Badge variant="outline">{MODULE_SIZE_LABELS[module.sizeDial]}</Badge>
              {module.tone !== '' && <Badge variant="secondary">{module.tone}</Badge>}
              <StatusBadge status={module.status} errorMessage={module.errorMessage} />
              {/* Cover generation lives with the header's other module
                  actions (a GM control like every reader control here —
                  player-safe battle view never mounts this surface). */}
              <GenerateModuleCoverButton module={module} />
              {busy && (
                <Button
                  variant="outline"
                  size="xs"
                  data-testid="module-stop"
                  onClick={() => {
                    // The Stop control must never be a silent no-op (docs/17 row
                    // 110): with a live pass behind the row it cancels it, as it
                    // always did; with NO live pass — the state left by a
                    // reloaded/discarded tab, where `busy` is a lease nobody
                    // holds — it performs the RECONCILIATION instead: the row
                    // lands failed with a named reason, its unfinished part slots
                    // rewind, and the reader's own recovery controls appear.
                    void stopModuleGeneration(module.id).catch((error: unknown) => {
                      toastError('Could not stop or reconcile that generation', error);
                    });
                  }}
                >
                  <BanIcon aria-hidden data-icon="inline-start" />
                  Stop
                </Button>
              )}
              {!busy &&
                module.spine !== null &&
                hasMissingParts &&
                module.parts.length > 0 && (
                  <MissingPartsButton
                    moduleId={module.id}
                    campaignId={campaignId}
                  />
                )}
              {/* Play is a mode change, not a scroll target: the battle
                  entry stays in the header so collapsing the contents
                  sidebar never hides it. */}
              <Button
                variant="outline"
                size="xs"
                className="ml-auto"
                data-testid="battle-table-header-link"
                render={<Link to={battlePath(campaignId, moduleId)} />}
                nativeButton={false}
              >
                <SwordsIcon aria-hidden data-icon="inline-start" />
                Battle table
              </Button>
              {/* Whole-module board (08 §Module board) — the module's
                  spatial overview: the second module child surface, beside
                  the battle table entry. */}
              <Button
                variant="outline"
                size="xs"
                data-testid="board-header-link"
                render={<Link to={boardPath(campaignId, moduleId)} />}
                nativeButton={false}
              >
                <NetworkIcon aria-hidden data-icon="inline-start" />
                Board
              </Button>
              {/* Per-part document canvas (08 §Module canvas) — the module
                  child surface for co-authoring ONE part beside the board. */}
              <Button
                variant="outline"
                size="xs"
                data-testid="canvas-header-link"
                render={<Link to={canvasPath(campaignId, moduleId)} />}
                nativeButton={false}
              >
                <SquarePenIcon aria-hidden data-icon="inline-start" />
                Canvas
              </Button>
              {/* Chat front door (08 §Module canvas chat, ledger 57) — one
                  click from the reader to talking to the module: the canvas
                  with the chat sidebar forced open. */}
              <Button
                variant="outline"
                size="xs"
                data-testid="chat-header-link"
                render={<Link to={canvasChatPath(campaignId, moduleId)} />}
                nativeButton={false}
              >
                <MessageSquareTextIcon aria-hidden data-icon="inline-start" />
                Chat
              </Button>
              <Button
                variant="ghost"
                size="xs"
                aria-label={tocOpen ? 'Hide table of contents' : 'Show table of contents'}
                onClick={() => {
                  setTocOpen((open) => !open);
                }}
              >
                <ListIcon aria-hidden data-icon="inline-start" />
                {tocOpen ? 'Hide contents' : 'Contents'}
              </Button>
            </div>
          </header>

          {module.spine === null ? (
            busy ? (
              <StreamingTail label="Drafting the spine…" moduleId={module.id} planIndex={null} />
            ) : module.status === 'failed' ? (
              // A failed first spine is actionable, not a dead end: the
              // generator recorded the error on the row (AGENTS rule 2) and
              // Retry re-runs pass 0 in place.
              <section
                className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm"
                data-testid="spine-failed"
              >
                <p className="font-medium">The spine draft failed.</p>
                {module.errorMessage !== '' && (
                  <p className="mt-1 text-muted-foreground" data-testid="spine-failed-error">
                    {module.errorMessage}
                  </p>
                )}
                <Button
                  variant="outline"
                  size="xs"
                  className="mt-3"
                  data-testid="retry-spine"
                  onClick={() => {
                    void retrySpine(currentModule.id, currentCampaign).catch((error: unknown) => {
                      toastError('Could not retry the spine draft', error);
                    });
                  }}
                >
                  <RefreshCwIcon aria-hidden data-icon="inline-start" />
                  Retry spine draft
                </Button>
              </section>
            ) : (
              <section className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                This module has no spine yet — open the{' '}
                <Link className="underline" to={modulesPath(campaignId)}>
                  module list
                </Link>{' '}
                and re-run the spine draft, or delete and recreate the module.
              </section>
            )
          ) : parts.length === 0 && !busy ? (
            <>
              <section id="module-intro" className="mb-8">
                <IntroBlock
                  premise={module.spine.premise}
                  // PROVENANCE (docs/17 row 93): the spine-checkpoint branch
                  // shows the SAME premise card as the generated reader, so it
                  // carries the same id. This call site omitted the prop when
                  // the field landed (the card silently had no caption here
                  // and `tsc -b` caught it, not the test suite).
                  writerModel={module.spine.writerModel}
                  artifacts={readerArtifacts}
                  moduleId={module.id}
                  onOpenArtifact={openArtifact}
                  onStub={openStub}
                />
              </section>
              <SpineCheckpoint
                moduleId={module.id}
                campaign={campaign}
                spine={module.spine}
                busy={busy}
                entityKinds={module.entityKinds}
              />
            </>
          ) : (
            <>
              {module.status === 'failed' && (
                <section
                  className="mb-8 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm"
                  data-testid="module-failed-banner"
                  role="alert"
                >
                  <div className="flex items-center gap-2 font-medium text-destructive">
                    <TriangleAlertIcon className="size-4 shrink-0" aria-hidden />
                    <span>Module generation encountered an error.</span>
                  </div>
                  {module.errorMessage !== '' && (
                    <p className="mt-1 text-xs text-muted-foreground">{module.errorMessage}</p>
                  )}
                  <p className="mt-2 text-xs text-muted-foreground">
                    Completed parts are preserved. You can resume generation to write any missing or failed parts.
                  </p>
                  <div className="mt-3 flex gap-2">
                    <Button
                      variant="default"
                      size="xs"
                      data-testid="resume-module-generation"
                      onClick={() => {
                        void (async () => {
                          try {
                            const camp = await getCampaign(campaignId);
                            if (camp === undefined) throw new Error('Campaign no longer exists');
                            await generateMissingParts(module.id, camp);
                          } catch (error) {
                            toastError('Could not resume module generation', error);
                          }
                        })();
                      }}
                    >
                      <RotateCcwIcon className="size-3.5" aria-hidden data-icon="inline-start" />
                      Resume module generation
                    </Button>
                  </div>
                </section>
              )}
              <section id="module-intro" className="mb-10">
                <IntroBlock
                  premise={module.spine.premise}
                  writerModel={module.spine.writerModel}
                  artifacts={readerArtifacts}
                  moduleId={module.id}
                  onOpenArtifact={openArtifact}
                  onStub={openStub}
                />
              </section>

              {plans.map(({ plan, index }) => {
                const part = module.parts.find((entry) => entry.planIndex === index);
                return (
                  <section key={index} id={`part-${String(index)}`} className="mb-12 scroll-mt-4">
                    <div className="mb-3 flex items-baseline gap-3">
                      <h1 className="font-heading text-2xl font-bold tracking-tight">{plan.title}</h1>
                      <Badge variant="outline">Levels {plan.levelBand}</Badge>
                      <PartActions
                        part={part}
                        editing={editPartIndex === index}
                        onEdit={() => {
                          if (part !== undefined) startEditPart(part);
                        }}
                        onRewrite={() => {
                          requestRewrite(index);
                        }}
                      />
                    </div>
                    <PartBody
                      part={part}
                      planIndex={index}
                      planTitle={plan.title}
                      artifacts={readerArtifacts}
                      moduleId={module.id}
                      editing={editPartIndex === index}
                      editDraft={editDraft}
                      onEditDraftChange={changeEditDraft}
                      onEditSave={saveEditPart}
                      onEditCancel={cancelEditPart}
                      onOpenArtifact={openArtifact}
                      onStub={openStub}
                      onRetry={retryPart}
                      onRewrite={requestRewrite}
                    />
                  </section>
                );
              })}
            </>
          )}
        </article>
      </div>

      {/* Entity panel */}
      <EntityPanel
        module={module}
        artifacts={artifacts}
        campaign={campaign}
        onStub={(name, anchor) => {
          setStub({ name, ...anchor });
        }}
        {...(creaturePresentation === undefined ? {} : { creaturePresentation })}
        onOpenCard={(artifact) => {
          // Encounters skip the peek modal: the owner always wants the
          // encounter directly in the workspace (same target as the peek
          // modal's "Open in workspace" button). Every other kind peeks.
          if (artifact.kind === 'encounter') {
            navigate(artifactPath(campaignId, artifact.id));
            return;
          }
          setPeekId(artifact.id);
        }}
      />

      {/* Overlays */}
      {stub !== null && (
        <StubPopover
          state={stub}
          sentence={moduleSentenceFor(stub.name, module)}
          contextParagraphs={moduleContextFor(stub.name, module)}
          premise={module.spine?.premise ?? ''}
          moduleTag={moduleTagFor(module.title)}
          moduleId={currentModule.id}
          campaign={campaign}
          recordedKind={entityKindFor(currentModule.entityKinds, stub.name)}
          onClose={() => {
            setStub(null);
          }}
          onLinkExisting={(name) => {
            setLinkTargetName(name);
            setStub(null);
          }}
        />
      )}

      {linkTargetName !== null && (
        <LinkExistingPicker
          campaignId={campaignId}
          onClose={() => {
            setLinkTargetName(null);
          }}
          onPick={(artifact) => {
            void linkExisting(artifact);
          }}
        />
      )}

      {peekArtifact !== undefined && (
        <PeekModal
          artifact={peekArtifact}
          artifacts={artifacts}
          open
          onOpenChange={(open) => {
            if (!open) setPeekId(null);
          }}
          campaignId={campaignId}
        />
      )}

      <Dialog
        open={rewriteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRewriteTarget(null);
        }}
      >
        <DialogContent data-testid="rewrite-dialog">
          <DialogHeader>
            <DialogTitle>Rewrite part {rewriteTarget !== null ? rewriteTarget + 1 : ''}</DialogTitle>
            <DialogDescription>
              Regenerating replaces this part's markdown. Optionally steer the rewrite.
            </DialogDescription>
          </DialogHeader>
          {rewriteTarget !== null &&
            module.parts.find((entry) => entry.planIndex === rewriteTarget)?.edited === true && (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm" role="alert">
                {modulePartWriterLabel(
                  module.parts.find((entry) => entry.planIndex === rewriteTarget),
                )}{' '}
                Regenerating overwrites it.
              </p>
            )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rewrite-instruction">Optional instruction</Label>
            <Input
              id="rewrite-instruction"
              placeholder='e.g. "make the villain a child"'
              value={rewriteInstruction}
              onChange={(event) => {
                setRewriteInstruction(event.target.value);
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setRewriteTarget(null); }}>
              Cancel
            </Button>
            <Button onClick={() => void confirmRewrite()}>Rewrite part</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// --- Pieces ------------------------------------------------------------------

/**
 * The ONE subscription that moves generator deltas into the tail store. It
 * renders NOTHING (null) and never subscribes to the store itself: this
 * component must not re-render per token, or the isolation it exists for is
 * lost one level up. Other modules' events are ignored — a reader mounts one
 * module.
 */
function ModuleGenTailsBridge({ moduleId }: { moduleId: Id }): null {
  useEffect(
    () =>
      moduleGenEvents.on((event) => {
        if (event.moduleId !== moduleId) return;
        streamTails.apply(event);
      }),
    [moduleId],
  );
  return null;
}

function MissingModule({ message, campaignId }: { message: string; campaignId: string }): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-sm text-muted-foreground">{message}</p>
      <Button variant="outline" size="sm" render={<Link to={modulesPath(campaignId)} />} nativeButton={false}>
        Back to modules
      </Button>
    </div>
  );
}

function StatusBadge({ status, errorMessage }: { status: Module['status']; errorMessage: string }): JSX.Element {
  if (status === 'failed') {
    return (
      <Badge variant="destructive" title={errorMessage}>
        <TriangleAlertIcon aria-hidden className="size-3" />
        failed
      </Badge>
    );
  }
  if (status === 'generating') {
    return (
      <Badge variant="secondary" data-testid="module-status">
        <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />
        generating
      </Badge>
    );
  }
  return <Badge variant="secondary">{status}</Badge>;
}

function ModuleTitleInput({ module }: { module: Module }): JSX.Element {
  const [title, setTitle] = useState(module.title);
  useEffect(() => {
    setTitle(module.title);
  }, [module.title]);

  async function commit(): Promise<void> {
    const next = title.trim();
    if (next === '' || next === module.title) {
      setTitle(module.title);
      return;
    }
    try {
      await patchModule(module.id, { title: next });
    } catch (error) {
      toastError('Could not rename the module', error);
      setTitle(module.title);
    }
  }

  return (
    <Input
      value={title}
      aria-label="Module title"
      data-testid="module-title"
      className="h-10 border-none bg-transparent px-0 font-heading text-3xl font-bold tracking-tight shadow-none dark:bg-transparent"
      onChange={(event) => {
        setTitle(event.target.value);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
      onBlur={() => {
        void commit();
      }}
    />
  );
}

/** The premise's markdown tree — memoized on its real inputs (`premise`,
 * `artifacts`, `moduleId` and the two stable callbacks), so a page state
 * change does not re-parse the intro either.
 *
 * PROVENANCE (docs/17 row 93): the PREMISE's writing model renders under it,
 * small and muted — the module half of the owner's request. `''` (a module
 * written before the field, or a hand-written premise) renders nothing. */
const IntroBlock = memo(function IntroBlock({
  premise,
  writerModel,
  artifacts,
  moduleId,
  onOpenArtifact,
  onStub,
}: {
  premise: string;
  writerModel: string;
  artifacts: readonly AnyArtifact[];
  moduleId: Id;
  onOpenArtifact: (artifact: AnyArtifact) => void;
  onStub: (name: string, anchor: { x: number; y: number }) => void;
}): JSX.Element {
  return (
    <div className="prose-module">
      <h2 className="mb-3 font-heading text-lg tracking-wide text-muted-foreground uppercase">
        Premise
      </h2>
      <WikiMarkdown
        value={premise}
        artifacts={artifacts}
        moduleId={moduleId}
        onOpenArtifact={onOpenArtifact}
        onStub={onStub}
      />
      <WriterModelId model={writerModel} testId="premise-writer-model" />
    </div>
  );
});

function PartActions({
  part,
  editing,
  onEdit,
  onRewrite,
}: {
  part: ModulePart | undefined;
  editing: boolean;
  onEdit: () => void;
  onRewrite: () => void;
}): JSX.Element | null {
  if (editing || part?.status !== 'ready') return null;
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1">
      <Button variant="ghost" size="icon-sm" aria-label="Edit part" onClick={onEdit} data-testid="part-edit">
        <PencilIcon aria-hidden className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Rewrite part"
        onClick={onRewrite}
        data-testid="part-rewrite"
      >
        <RotateCcwIcon aria-hidden className="size-3.5" />
      </Button>
    </span>
  );
}

/**
 * The streaming stream itself, in its OWN component: this is the only reader
 * subscriber to `moduleGenEvents` (through `streamTails`), so a token tick
 * re-renders this card and nothing else. `planIndex` is null for the spine.
 * Every prop is stable for the life of the stream, so a tick that belongs to
 * another part never touches this card.
 */
const StreamingTail = memo(function StreamingTail({
  label,
  moduleId,
  planIndex,
}: {
  label: string;
  moduleId: Id;
  planIndex: number | null;
}): JSX.Element {
  const { tail, thinkingTail } = useStreamTail(moduleId, planIndex);
  return <StreamingCard label={label} tail={tail} thinkingTail={thinkingTail} />;
});

/**
 * ONE part's body, memoized on its real inputs. `part`, `artifacts` and every
 * callback are stable across a page re-render, so a body re-renders only when
 * its own data changed — never because a sibling streamed a token or the page
 * re-rendered for an unrelated state change. The streaming tail is
 * deliberately NOT a prop: it comes from the store inside `StreamingTail`, so
 * a token is outside this component's inputs entirely.
 */
const PartBody = memo(function PartBody({
  part,
  planIndex,
  planTitle,
  artifacts,
  moduleId,
  editing,
  editDraft,
  onEditDraftChange,
  onEditSave,
  onEditCancel,
  onOpenArtifact,
  onStub,
  onRetry,
  onRewrite,
}: {
  part: ModulePart | undefined;
  planIndex: number;
  planTitle: string;
  artifacts: readonly AnyArtifact[];
  moduleId: Id;
  editing: boolean;
  editDraft: string;
  onEditDraftChange: (value: string) => void;
  onEditSave: () => void;
  onEditCancel: () => void;
  onOpenArtifact: (artifact: AnyArtifact) => void;
  onStub: (name: string, anchor: { x: number; y: number }) => void;
  onRetry: (planIndex: number) => void;
  onRewrite: (planIndex: number) => void;
}): JSX.Element {
  if (editing) {
    return (
      <PartTextEditor
        value={editDraft}
        onChange={onEditDraftChange}
        onSave={onEditSave}
        onCancel={onEditCancel}
        artifacts={artifacts}
        moduleId={moduleId}
        onOpenArtifact={onOpenArtifact}
        onStub={onStub}
      />
    );
  }
  if (part === undefined || part.status === 'pending') {
    return (
      <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground" data-testid="part-pending">
        Not written yet — it generates after the previous parts.
      </div>
    );
  }
  if (part.status === 'generating') {
    return <StreamingTail label={`Writing “${planTitle}”…`} moduleId={moduleId} planIndex={planIndex} />;
  }
  if (part.status === 'failed') {
    return (
      <div
        className="flex flex-col gap-2 rounded-lg border border-destructive/50 bg-destructive/5 p-4"
        data-testid="part-failed"
        role="alert"
      >
        <p className="flex items-center gap-2 text-sm font-medium text-destructive">
          <TriangleAlertIcon aria-hidden className="size-4" />
          This part failed to generate.
        </p>
        <p className="text-sm text-muted-foreground">{part.errorMessage}</p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => { onRetry(planIndex); }}>
            <RotateCcwIcon aria-hidden data-icon="inline-start" />
            Retry
          </Button>
          <Button variant="ghost" size="sm" onClick={() => { onRewrite(planIndex); }}>
            Retry with instruction…
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="prose-module" data-testid="part-body">
      <WikiMarkdown
        value={part.markdown}
        artifacts={artifacts}
        moduleId={moduleId}
        onOpenArtifact={onOpenArtifact}
        onStub={onStub}
      />
      {/* PROVENANCE (docs/17 row 93): the part's writing model, under the
          passage it wrote — a chat-applied rewrite records the chat model (the
          last writer); a hand edit KEEPS the id. Nothing recorded → nothing. */}
      <WriterModelId model={part.writerModel} testId="part-writer-model" />
    </div>
  );
});

function StreamingCard({
  label,
  tail,
  thinkingTail = '',
}: {
  label: string;
  tail: string;
  thinkingTail?: string;
}): JSX.Element {
  return (
    <div className="rounded-lg border bg-muted/30 p-4" data-testid="part-streaming" aria-live="polite">
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircleIcon aria-hidden className="size-4 animate-spin" />
        {label}
      </p>
      {/* Reasoning deltas, streamed dimmed for illustration only — the model's
          raw thoughts, never part of the module text. Present only while the
          model is thinking; the first content delta clears it. */}
      {thinkingTail.trim() !== '' && (
        <div
          className="mt-2 flex max-h-24 flex-col justify-end overflow-hidden font-mono text-[11px] italic text-muted-foreground/60"
          data-testid="thinking-tail"
        >
          <p className="shrink-0 text-[10px] font-medium uppercase tracking-wide not-italic">
            thinking
          </p>
          <pre className="shrink-0 whitespace-pre-wrap">{thinkingTail}</pre>
        </div>
      )}
      {/* Fixed height + bottom-anchored: the box occupies its final size from
          the first token, so streaming never reflows the surrounding document
          (a growing box made the whole module jitter), and clipping at the
          TOP keeps the newest text visible like a terminal tail. */}
      <div className="mt-2 flex h-48 flex-col justify-end overflow-hidden font-mono text-xs text-muted-foreground">
        <pre className="shrink-0 whitespace-pre-wrap">{tail.trim() === '' ? '…' : tail}</pre>
      </div>
    </div>
  );
}

function MissingPartsButton({ moduleId, campaignId }: { moduleId: Id; campaignId: string }): JSX.Element {
  const [running, setRunning] = useState(false);
  return (
    <Button
      variant="outline"
      size="xs"
      disabled={running}
      data-testid="generate-missing"
      onClick={() => {
        setRunning(true);
        void (async () => {
          try {
            const campaign = await getCampaign(campaignId);
            if (campaign === undefined) throw new Error('Campaign no longer exists');
            await generateMissingParts(moduleId, campaign);
          } catch (error) {
            toastError('Could not generate the missing parts', error);
          } finally {
            setRunning(false);
          }
        })();
      }}
    >
      <PlayIcon aria-hidden data-icon="inline-start" />
      {running ? 'Generating…' : 'Generate missing parts'}
    </Button>
  );
}

/** The first-occurrence sentence for stub summaries (premise + parts). */
function moduleSentenceFor(name: string, module: Module): string {
  return sentenceAround(moduleDocumentText(module), name);
}

/** Surrounding paragraphs for persona briefs (premise + parts). */
function moduleContextFor(name: string, module: Module): string {
  return surroundingParagraphs(moduleDocumentText(module), name);
}

/**
 * Link-existing picker (10-MILESTONE-6 C): lists artifacts according to the
 * module view's persisted scope control. Keeping these live queries inside
 * the conditionally mounted picker avoids unrelated reader rerenders while
 * a wiki-link chip is being clicked.
 */
function LinkExistingPicker(props: {
  campaignId: Id;
  onClose: () => void;
  onPick: (artifact: AnyArtifact) => void;
}): JSX.Element | null {
  const scoped = useScopedArtifacts('moduleView', props.campaignId);
  if (scoped === undefined) return null;
  return (
    <QuickFindDialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      artifacts={scoped}
      mode="picker"
      onPickArtifact={props.onPick}
    />
  );
}

/** Persists one part's hand edit through the ONE part-text save path
 * (features/modules/partText → patchModulePartText inside a re-read tx,
 * `edited: true`, post-save auto-promote scan — LINKS hook). */
async function patchModuleTextPart(module: Module, planIndex: number, markdown: string): Promise<Module> {
  return saveModulePartText(module.id, planIndex, markdown);
}
