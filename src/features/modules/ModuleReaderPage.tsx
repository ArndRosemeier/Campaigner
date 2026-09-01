import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import {
  BanIcon,
  ArrowLeftIcon,
  ListIcon,
  LoaderCircleIcon,
  PencilIcon,
  PlayIcon,
  RotateCcwIcon,
  TriangleAlertIcon,
} from 'lucide-react';

import { modulesPath } from '@/app/routes';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import type { Artifact, Campaign, Id, Module, ModulePart } from '@/domain';
import { MODULE_SIZE_LABELS, entityKindFor, moduleTagFor } from '@/domain';
import { artifactRepo } from '@/db';
import { getCampaign } from '@/db/campaignRepo';
import { patchModule } from '@/db/moduleRepo';
import { useArtifacts, useCampaign } from '@/features/campaign/hooks';
import { WikiMarkdown } from '@/features/campaign/components/wiki-markdown';
import { MarkdownBody } from '@/features/campaign/components/markdown-body';
import { useModule } from '@/features/modules/hooks';
import { EntityPanel } from '@/features/modules/entity-panel';
import { PeekModal } from '@/features/modules/peek-modal';
import { QuickFindDialog } from '@/features/quickfind/quickfind-dialog';
import { SpineCheckpoint } from '@/features/modules/spine-checkpoint';
import { StubPopover, type StubPopoverState } from '@/features/modules/stub-popover';
import { sentenceAround, surroundingParagraphs } from '@/lib/wikilinks';
import {
  cancelModuleGen,
  generateMissingParts,
  moduleGenEvents,
  rewritePart,
} from '@/llm/moduleGen';
import { toastError, toastSuccess } from '@/lib/toast';
import { cn } from '@/lib/utils';

/**
 * Module reader (08-MODULE-DESIGNER M4-A): the module front and center — one
 * scrollable document, prose width (~70ch), large type, parts as chapters
 * (H1 = part title with level-band badge), spine premise as the intro.
 * Sticky mini-ToC on the left, entity panel on the right, per-part ✎ editing
 * (save on blur), wiki-link chips everywhere through the shared WikiMarkdown.
 */

const TOKEN_TAIL_CHARS = 800;

export function ModuleReaderPage(): JSX.Element {
  const { campaignId = '', moduleId = '' } = useParams<{ campaignId: string; moduleId: string }>();
  const campaign = useCampaign(campaignId === '' ? undefined : campaignId);
  const module = useModule(moduleId === '' ? undefined : moduleId);
  const artifacts = useArtifacts(campaignId === '' ? undefined : campaignId);
  const location = useLocation();
  const scrollRef = useRef<HTMLDivElement>(null);

  const [stub, setStub] = useState<StubPopoverState | null>(null);
  const [linkTargetName, setLinkTargetName] = useState<string | null>(null);
  const [peekId, setPeekId] = useState<Id | null>(null);
  const [tocOpen, setTocOpen] = useState(true);
  const [rewriteTarget, setRewriteTarget] = useState<number | null>(null);
  const [rewriteInstruction, setRewriteInstruction] = useState('');
  const [editPartIndex, setEditPartIndex] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [tails, setTails] = useState<{ spine?: string | undefined; parts: Record<number, string> }>({
    parts: {},
  });

  // Streaming tails (in-memory emitter → never persisted).
  useEffect(() => {
    setTails({ parts: {} });
    return moduleGenEvents.on((event) => {
      if (event.moduleId !== moduleId) return;
      if (event.kind === 'spine-token') {
        setTails((previous) => ({
          ...previous,
          spine: `${previous.spine ?? ''}${event.delta}`.slice(-TOKEN_TAIL_CHARS),
        }));
      } else if (event.kind === 'part-token') {
        setTails((previous) => ({
          ...previous,
          parts: {
            ...previous.parts,
            [event.planIndex]: `${previous.parts[event.planIndex] ?? ''}${event.delta}`.slice(
              -TOKEN_TAIL_CHARS,
            ),
          },
        }));
      } else {
        setTails({ parts: {} });
      }
    });
  }, [moduleId]);

  // `#part-<index>` deep links (quick-find "select scrolls the reader").
  useEffect(() => {
    if (module === undefined || module === null) return;
    const match = /^#part-(\d+)$/.exec(location.hash);
    if (match === null) return;
    const element = document.getElementById(`part-${match[1] ?? ''}`);
    element?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [location.hash, module]);

  if (campaign === undefined || module === undefined || artifacts === undefined) {
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

  function scrollToName(name: string): void {
    const container = scrollRef.current;
    if (container === null) return;
    const chip = container.querySelector(`[data-wiki-name="${CSS.escape(name)}"]`);
    chip?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

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

  async function linkExisting(artifact: Artifact): Promise<void> {
    const name = linkTargetName;
    if (name === null) return;
    setLinkTargetName(null);
    try {
      if (!artifact.aliases.some((alias) => alias.toLowerCase() === name.toLowerCase())) {
        await artifactRepo.updateArtifact(artifact.id, { aliases: [...artifact.aliases, name] });
      }
      toastSuccess(`“${name}” now resolves to ${artifact.name}`);
    } catch (error) {
      toastError('Could not link the existing artifact', error);
    }
  }

  return (
    <div className="flex h-full min-h-0" data-testid="module-reader">
      {/* Mini-ToC */}
      {tocOpen ? (
        <nav
          aria-label="Table of contents"
          className="w-56 shrink-0 overflow-y-auto border-r bg-card px-3 py-4 text-sm"
          data-testid="module-toc"
        >
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
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <article className="mx-auto max-w-[70ch] px-6 py-10 text-[15px] leading-relaxed">
          <header className="mb-8 border-b pb-4">
            <ModuleTitleInput module={module} />
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Badge variant="outline">
                Levels {module.levelMin}–{module.levelMax}
              </Badge>
              <Badge variant="outline">{MODULE_SIZE_LABELS[module.sizeDial]}</Badge>
              {module.tone !== '' && <Badge variant="secondary">{module.tone}</Badge>}
              <StatusBadge status={module.status} errorMessage={module.errorMessage} />
              {busy && (
                <Button variant="outline" size="xs" onClick={() => { cancelModuleGen(module.id); }}>
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
              <Button
                variant="ghost"
                size="xs"
                className="ml-auto"
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
              <StreamingCard label="Drafting the spine…" tail={tails.spine ?? ''} />
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
                  artifacts={artifacts}
                  onOpenArtifact={(artifact) => {
                    setPeekId(artifact.id);
                  }}
                  onStub={(name, anchor) => {
                    setStub({ name, ...anchor });
                  }}
                />
              </section>
              <SpineCheckpoint moduleId={module.id} campaign={campaign} spine={module.spine} busy={busy} />
            </>
          ) : (
            <>
              <section id="module-intro" className="mb-10">
                <IntroBlock
                  premise={module.spine.premise}
                  artifacts={artifacts}
                  onOpenArtifact={(artifact) => {
                    setPeekId(artifact.id);
                  }}
                  onStub={(name, anchor) => {
                    setStub({ name, ...anchor });
                  }}
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
                      planTitle={plan.title}
                      artifacts={artifacts}
                      tail={tails.parts[index] ?? ''}
                      editing={editPartIndex === index}
                      editDraft={editDraft}
                      onEditDraftChange={setEditDraft}
                      onEditBlur={() => void savePartEdit()}
                      onOpenArtifact={(artifact) => {
                        setPeekId(artifact.id);
                      }}
                      onStub={(name, anchor) => {
                        setStub({ name, ...anchor });
                      }}
                      onRetry={() => {
                        void rewritePart(moduleId, campaign, index);
                      }}
                      onRewrite={() => {
                        requestRewrite(index);
                      }}
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
        onScrollTo={scrollToName}
      />

      {/* Overlays */}
      {stub !== null && (
        <StubPopover
          state={stub}
          sentence={moduleSentenceFor(stub.name, module)}
          contextParagraphs={moduleContextFor(stub.name, module)}
          premise={module.spine?.premise ?? ''}
          moduleTag={moduleTagFor(module.title)}
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
        <QuickFindDialog
          open
          onOpenChange={(open) => {
            if (!open) setLinkTargetName(null);
          }}
          artifacts={artifacts}
          mode="play"
          onPickArtifact={(artifact) => {
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
                This part was hand-edited after generation — regenerating overwrites your edits.
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

function IntroBlock({
  premise,
  artifacts,
  onOpenArtifact,
  onStub,
}: {
  premise: string;
  artifacts: readonly Artifact[];
  onOpenArtifact: (artifact: Artifact) => void;
  onStub: (name: string, anchor: { x: number; y: number }) => void;
}): JSX.Element {
  return (
    <div className="prose-module">
      <h2 className="mb-3 font-heading text-lg tracking-wide text-muted-foreground uppercase">
        Premise
      </h2>
      <WikiMarkdown value={premise} artifacts={artifacts} onOpenArtifact={onOpenArtifact} onStub={onStub} />
    </div>
  );
}

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

function PartBody({
  part,
  planTitle,
  artifacts,
  tail,
  editing,
  editDraft,
  onEditDraftChange,
  onEditBlur,
  onOpenArtifact,
  onStub,
  onRetry,
  onRewrite,
}: {
  part: ModulePart | undefined;
  planTitle: string;
  artifacts: readonly Artifact[];
  tail: string;
  editing: boolean;
  editDraft: string;
  onEditDraftChange: (value: string) => void;
  onEditBlur: () => void;
  onOpenArtifact: (artifact: Artifact) => void;
  onStub: (name: string, anchor: { x: number; y: number }) => void;
  onRetry: () => void;
  onRewrite: () => void;
}): JSX.Element {
  if (editing) {
    return (
      <MarkdownBody
        value={editDraft}
        onChange={onEditDraftChange}
        onTextareaBlur={onEditBlur}
        hideHeading
        artifacts={artifacts}
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
    return <StreamingCard label={`Writing “${planTitle}”…`} tail={tail} />;
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
          <Button size="sm" variant="outline" onClick={onRetry}>
            <RotateCcwIcon aria-hidden data-icon="inline-start" />
            Retry
          </Button>
          <Button size="sm" variant="ghost" onClick={onRewrite}>
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
        onOpenArtifact={onOpenArtifact}
        onStub={onStub}
      />
    </div>
  );
}

function StreamingCard({ label, tail }: { label: string; tail: string }): JSX.Element {
  return (
    <div className="rounded-lg border bg-muted/30 p-4" data-testid="part-streaming" aria-live="polite">
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircleIcon aria-hidden className="size-4 animate-spin" />
        {label}
      </p>
      <pre className="mt-2 max-h-48 overflow-hidden font-mono text-xs whitespace-pre-wrap text-muted-foreground">
        {tail.trim() === '' ? '…' : tail}
      </pre>
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

function moduleDocumentText(module: Module): string {
  return [
    module.spine?.premise ?? '',
    ...module.parts
      .slice()
      .sort((a, b) => a.planIndex - b.planIndex)
      .map((part) => part.markdown),
  ].join('\n\n');
}

/** Persists one part's hand edit (marks it `edited` for rewrite confirmations). */
async function patchModuleTextPart(module: Module, planIndex: number, markdown: string): Promise<Module> {
  const parts = module.parts.map((part) =>
    part.planIndex === planIndex
      ? { ...part, markdown, status: 'ready' as const, errorMessage: '', edited: true }
      : part,
  );
  return patchModule(module.id, { parts });
}
