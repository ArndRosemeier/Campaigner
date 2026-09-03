import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { HistoryIcon, SparklesIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';

import { artifactRepo } from '@/db';
import { AdoptDialog } from '@/features/campaign/components/adopt-dialog';
import { adoptIntoCampaign, moveToModule } from '@/db/artifactRepo';
import { modulePath } from '@/app/routes';
import { getModule } from '@/db/moduleRepo';
import { useEncounterGenerationRequest } from '@/features/campaign/encounterGenerationRequest';
import {
  ARTIFACT_KIND_SINGULAR,
  type AnyArtifact,
  type ArtifactLink,
  type ArtifactRevision,
  type EncounterArtifactData,
  type FactionArtifactData,
  type GameSystem,
  type Id,
  type LocationArtifactData,
  type NpcArtifactData,
  type PcArtifactData,
  type PlotArcArtifactData,
} from '@/domain';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { HelpButton } from '@/help/HelpButton';
import { useModules } from '@/features/modules/hooks';
import { buttonVariants } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  EncounterForm,
  FactionForm,
  LocationForm,
  NpcForm,
  PcForm,
  NoteForm,
  PlotArcForm,
} from '@/features/campaign/components/kind-forms';
import { LinksSection } from '@/features/campaign/components/links-section';
import { ImagesSection } from '@/features/campaign/components/images-section';
import { MarkdownBody } from '@/features/campaign/components/markdown-body';
import { PeekModal } from '@/features/modules/peek-modal';
import { RevisionDialog } from '@/features/campaign/components/revision-dialog';
import { TagEditor } from '@/features/campaign/components/tag-editor';
import { useRevisions } from '@/features/campaign/hooks';
import { deepEqual } from '@/lib/equal';
import { formatDateTime } from '@/lib/format';
import { toastError, toastSuccess } from '@/lib/toast';
import { cn } from '@/lib/utils';

/** Autosave debounce (05-UI §Artifact editor). */
const AUTOSAVE_DELAY_MS = 800;

/**
 * The editable slice of an artifact, correlated with its kind so `data` stays
 * narrowed (no casts anywhere in the editor).
 */
interface CommonDraft {
  name: string;
  tags: string[];
  summary: string;
  body: string;
  links: ArtifactLink[];
}
type PcDraft = CommonDraft & { kind: 'pc'; data: PcArtifactData };
type NpcDraft = CommonDraft & { kind: 'npc'; data: NpcArtifactData };
type LocationDraft = CommonDraft & { kind: 'location'; data: LocationArtifactData };
type FactionDraft = CommonDraft & { kind: 'faction'; data: FactionArtifactData };
type NoteDraft = CommonDraft & { kind: 'note'; data: Record<string, never> };
type EncounterDraft = CommonDraft & { kind: 'encounter'; data: EncounterArtifactData };
type PlotArcDraft = CommonDraft & { kind: 'plotarc'; data: PlotArcArtifactData };
export type ArtifactDraft =
  | PcDraft
  | NpcDraft
  | LocationDraft
  | FactionDraft
  | NoteDraft
  | EncounterDraft
  | PlotArcDraft;

function draftFrom(artifact: AnyArtifact): ArtifactDraft {
  const common: CommonDraft = {
    name: artifact.name,
    tags: [...artifact.tags],
    summary: artifact.summary,
    body: artifact.body,
    links: structuredClone(artifact.links),
  };
  switch (artifact.kind) {
    case 'pc':
      return { ...common, kind: 'pc', data: structuredClone(artifact.data) };
    case 'npc':
      return { ...common, kind: 'npc', data: structuredClone(artifact.data) };
    case 'location':
      return { ...common, kind: 'location', data: structuredClone(artifact.data) };
    case 'faction':
      return { ...common, kind: 'faction', data: structuredClone(artifact.data) };
    case 'note':
      return { ...common, kind: 'note', data: structuredClone(artifact.data) };
    case 'encounter':
      return { ...common, kind: 'encounter', data: structuredClone(artifact.data) };
    case 'plotarc':
      return { ...common, kind: 'plotarc', data: structuredClone(artifact.data) };
  }
}

function draftPatch(draft: ArtifactDraft): {
  name: string;
  tags: string[];
  summary: string;
  body: string;
  links: ArtifactLink[];
  data: ArtifactDraft['data'];
} {
  const { name, tags, summary, body, links, data } = draft;
  return { name, tags, summary, body, links, data };
}

export interface ArtifactEditorProps {
  /** Any scope — library rows open here too (10-MILESTONE-6 C, D7). */
  artifact: AnyArtifact;
  /** The workspace's campaign (peek navigation stays campaign-anchored). */
  campaignId: Id;
  campaignArtifacts: readonly AnyArtifact[];
  campaignSystem: GameSystem;
}

/**
 * Center pane (05-UI §Artifact editor): header with inline name, kind badge,
 * tags, summary and revision dropdown; Markdown body with preview; kind form;
 * links. Autosaves with an 800 ms debounce and only creates a revision when
 * content actually changed (deep-compare against the last saved draft) —
 * keystroke bursts never churn the 50-revision cap.
 *
 * Mounted with `key={artifact.id}` so drafts reset per artifact.
 */
export function ArtifactEditor({
  artifact,
  campaignId,
  campaignArtifacts,
  campaignSystem,
}: ArtifactEditorProps) {
  const [draft, setDraft] = useState<ArtifactDraft>(() => draftFrom(artifact));
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved');
  const [revisionView, setRevisionView] = useState<ArtifactRevision | null>(null);
  const [peekedId, setPeekedId] = useState<Id | null>(null);
  const lastSavedRef = useRef<ArtifactDraft>(draftFrom(artifact));
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  /**
   * Persists the draft if it differs from the last saved state. An empty
   * name (mid-edit) never reaches the DB — the previous name is kept until
   * a valid one is entered, so autosave can't fail on `z.string().min(1)`.
   */
  const saveDraft = useCallback(async (): Promise<boolean> => {
    const current = draftRef.current;
    const effective: ArtifactDraft =
      current.name.trim() === '' ? { ...current, name: lastSavedRef.current.name } : current;
    if (deepEqual(effective, lastSavedRef.current)) return false;
    setSaveState('saving');
    try {
      await artifactRepo.updateArtifact(artifact.id, draftPatch(effective));
      lastSavedRef.current = effective;
      setSaveState('saved');
      return true;
    } catch (error) {
      setSaveState('error');
      toastError('Autosave failed', error);
      return false;
    }
  }, [artifact.id]);

  // Debounced autosave: every draft change restarts the 800 ms timer.
  useEffect(() => {
    if (deepEqual(draft, lastSavedRef.current)) return;
    const timer = window.setTimeout(() => {
      void saveDraft();
    }, AUTOSAVE_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [draft, saveDraft]);

  // Adopt external content changes (e.g. a restored revision) when the local
  // draft has no unsaved edits — otherwise the next autosave would clobber
  // the restore with stale content.
  useEffect(() => {
    const serverDraft = draftFrom(artifact);
    if (deepEqual(serverDraft, lastSavedRef.current)) return;
    if (deepEqual(draftRef.current, lastSavedRef.current)) {
      lastSavedRef.current = serverDraft;
      setDraft(serverDraft);
    }
  }, [artifact]);

  // Flush pending edits when leaving the artifact.
  useEffect(() => {
    return () => {
      void saveDraft();
    };
  }, [saveDraft]);

  async function handleRestore(revision: number): Promise<void> {
    try {
      await artifactRepo.restoreRevision(artifact.id, revision);
      toastSuccess(`Restored revision ${revision}`);
    } catch (error) {
      toastError('Restore failed', error);
    }
  }

  function patchDraft(patch: Partial<CommonDraft>): void {
    setDraft((previous) => ({ ...previous, ...patch }));
  }

  const peekArtifact = campaignArtifacts.find((entry) => entry.id === peekedId);

  return (
    <div className="flex h-full flex-col overflow-hidden" data-testid="artifact-editor">
      <header className="flex flex-col gap-1.5 border-b p-3">
        <div className="flex items-center gap-2">
          <Input
            value={draft.name}
            aria-label="Artifact name"
            data-testid="artifact-name"
            className="h-8 border-none bg-transparent px-1 text-lg font-semibold shadow-none dark:bg-transparent"
            onChange={(event) => {
              patchDraft({ name: event.target.value });
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
            onBlur={() => {
              if (draft.name.trim() === '') patchDraft({ name: lastSavedRef.current.name });
            }}
          />
          <Badge variant="outline">{ARTIFACT_KIND_SINGULAR[artifact.kind]}</Badge>
          <Badge variant="secondary" data-testid="revision-badge">
            rev {artifact.currentRevision}
          </Badge>
          <RevisionDropdown artifactId={artifact.id} onOpen={setRevisionView} />
          {artifact.campaignId === null && (
            <Badge data-testid="global-badge" className="bg-amber-500/15 text-amber-700 dark:text-amber-400">
              Library
            </Badge>
          )}
          {artifact.moduleId !== null && (
            <ModuleOwnerLink campaignId={campaignId} moduleId={artifact.moduleId} />
          )}
          <ScopeAction artifact={artifact} />
          <HelpButton topic="editor" label="artifact editor" className="ml-auto" />
          <span
            data-testid="save-state"
            className={cn(
              'ml-auto text-xs text-muted-foreground',
              saveState === 'error' && 'text-destructive',
            )}
          >
            {saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Save failed' : 'Saved'}
          </span>
        </div>
        <TagEditor
          tags={draft.tags}
          onChange={(tags) => {
            patchDraft({ tags });
          }}
        />
        <Input
          value={draft.summary}
          placeholder="Summary (one line, shown in the tree tooltip)…"
          aria-label="Summary"
          className="h-7 border-none bg-transparent px-1 text-xs shadow-none dark:bg-transparent"
          onChange={(event) => {
            patchDraft({ summary: event.target.value });
          }}
        />
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 p-3">
          <MarkdownBody
            value={draft.body}
            onChange={(body) => {
              patchDraft({ body });
            }}
            artifacts={campaignArtifacts}
            onOpenArtifact={(target) => {
              setPeekedId(target.id);
            }}
          />

          <ImagesSection artifact={artifact} />

          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-medium">{ARTIFACT_KIND_SINGULAR[artifact.kind]} details</h2>            {draft.kind === 'pc' && (
              <PcForm
                data={draft.data}
                campaignSystem={campaignSystem}
                onChange={(data) => {
                  setDraft((previous) => ({ ...previous, kind: 'pc', data }));
                }}
              />
            )}
            {draft.kind === 'npc' && (
              <NpcForm
                artifactName={draft.name}
                data={draft.data}
                onChange={(data) => {
                  setDraft((previous) => ({ ...previous, kind: 'npc', data }));
                }}
                campaignSystem={campaignSystem}
              />
            )}
            {draft.kind === 'location' && (
              <LocationForm
                data={draft.data}
                onChange={(data) => {
                  setDraft((previous) => ({ ...previous, kind: 'location', data }));
                }}
              />
            )}
            {draft.kind === 'faction' && (
              <FactionForm
                data={draft.data}
                onChange={(data) => {
                  setDraft((previous) => ({ ...previous, kind: 'faction', data }));
                }}
              />
            )}
            {draft.kind === 'note' && <NoteForm />}
            {draft.kind === 'encounter' && (
              <EncounterAiSection artifact={artifact} />
            )}
            {draft.kind === 'encounter' && (
              <EncounterForm
                data={draft.data}
                campaignArtifacts={campaignArtifacts}
                onChange={(data) => {
                  setDraft((previous) => ({ ...previous, kind: 'encounter', data }));
                }}
              />
            )}
            {draft.kind === 'plotarc' && (
              <PlotArcForm
                data={draft.data}
                onChange={(data) => {
                  setDraft((previous) => ({ ...previous, kind: 'plotarc', data }));
                }}
              />
            )}
          </section>

          <LinksSection
            links={draft.links}
            onChange={(links) => {
              patchDraft({ links });
            }}
            campaignArtifacts={campaignArtifacts}
            selfId={artifact.id}
          />
        </div>
      </ScrollArea>

      <RevisionDialog
        revision={revisionView}
        onOpenChange={(open) => {
          if (!open) setRevisionView(null);
        }}
        onRestore={(revision) => void handleRestore(revision)}
      />

      {peekArtifact !== undefined && (
        <PeekModal
          artifact={peekArtifact}
          artifacts={campaignArtifacts}
          open
          onOpenChange={(open) => {
            if (!open) setPeekedId(null);
          }}
          campaignId={campaignId}
        />
      )}
    </div>
  );
}

interface RevisionDropdownProps {
  artifactId: Id;
  onOpen: (revision: ArtifactRevision) => void;
}

/**
 * Encounter content hand-off (docs/11 §entry points): a module stub has no
 * roster, so the battlemap section alone cannot help — this hands off to the
 * Encounter Smith, whose targeted run writes content INTO this artifact.
 * Overwriting authored content is a two-step act.
 */
function EncounterAiSection({ artifact }: { artifact: AnyArtifact }): JSX.Element | null {
  const requestEncounter = useEncounterGenerationRequest((state) => state.request);
  const [armed, setArmed] = useState(false);
  const data = artifact.kind === 'encounter' ? artifact.data : null;
  if (data === null) return null;
  const hasContent = data.monsters.length > 0;

  return (
    <div className="flex items-center justify-between gap-3 rounded-md border p-3" data-testid="encounter-ai-section">
      <p className="text-xs text-muted-foreground">
        {hasContent
          ? 'Regenerate roster, terrain, tactics, treasure and prose with the Encounter Smith. Name, links and battlemap are preserved.'
          : 'This encounter has no content yet — generate roster, terrain, tactics, treasure and prose with the Encounter Smith.'}
      </p>
      <Button
        variant={hasContent && !armed ? 'outline' : 'default'}
        size="sm"
        data-testid="generate-encounter-content"
        onClick={() => {
          if (hasContent && !armed) {
            setArmed(true);
            return;
          }
          requestEncounter(artifact.id, hasContent, 'content');
          setArmed(false);
        }}
      >
        <SparklesIcon aria-hidden data-icon="inline-start" />
        {!hasContent ? 'Generate with AI' : armed ? 'Overwrite content — confirm?' : 'Regenerate with AI'}
      </Button>
    </div>
  );
}

function RevisionDropdown({ artifactId, onOpen }: RevisionDropdownProps) {
  const revisions = useRevisions(artifactId);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={buttonVariants({ variant: 'outline', size: 'xs' })}>
        <HistoryIcon aria-hidden data-icon="inline-start" />
        History
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {(revisions ?? []).map((revision) => (
          <DropdownMenuItem
            key={revision.id}
            onClick={() => {
              onOpen(revision);
            }}
          >
            rev {revision.revision} · {formatDateTime(revision.updatedAt)}
          </DropdownMenuItem>
        ))}
        {(revisions ?? []).length === 0 && (
          <DropdownMenuItem disabled>No revisions yet</DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Scope action (10-MILESTONE-6 M6-B): a campaign-owned artifact can move into
 * any module of its own campaign; a module-owned artifact can be adopted back
 * into plain campaign ownership. Both keep id, links, revisions and images —
 * only the ownership fields change — so no confirm dialog is needed; the
 * toast reports where the artifact now lives.
 */
/**
 * Module-owned artifacts edit exactly like campaign artifacts, but their
 * context lives in the module reader — this closes the one-way door that
 * peek-modal "Open in workspace" opened: the editor links back.
 */
function ModuleOwnerLink({ campaignId, moduleId }: { campaignId: Id; moduleId: Id }) {
  const module = useLiveQuery(async () => getModule(moduleId), [moduleId]);
  return (
    <Button
      variant="outline"
      size="sm"
      data-testid="open-in-module"
      render={<Link to={modulePath(campaignId, moduleId)} />}
      nativeButton={false}
      title={module === undefined ? 'Open the owning module' : `Open "${module.title}" in the module reader`}
    >
      Open in module
    </Button>
  );
}

function ScopeAction({ artifact }: { artifact: AnyArtifact }) {  const modules = useModules(artifact.campaignId ?? undefined);
  const ownedModuleId = artifact.moduleId;
  const [adoptOpen, setAdoptOpen] = useState(false);

  if (artifact.campaignId === null) {
    return (
      <>
        <Button
          variant="ghost"
          size="sm"
          data-testid="scope-adopt-global"
          onClick={() => {
            setAdoptOpen(true);
          }}
        >
          Adopt into campaign…
        </Button>
        <AdoptDialog
          artifact={artifact}
          open={adoptOpen}
          onOpenChange={setAdoptOpen}
        />
      </>
    );
  }

  if (ownedModuleId !== null) {
    return (
      <Button
        variant="ghost"
        size="sm"
        data-testid="scope-adopt"
        onClick={() => {
          adoptIntoCampaign(artifact.id)
            .then((moved) => {
              toastSuccess(`"${moved.name}" is owned by the campaign again`);
            })
            .catch((error: unknown) => {
              toastError('Could not adopt the artifact into the campaign', error);
            });
        }}
      >
        Adopt into campaign
      </Button>
    );
  }

  const candidates = modules ?? [];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={buttonVariants({ variant: 'ghost', size: 'sm' })}
        data-testid="scope-move"
        disabled={candidates.length === 0}
      >
        Move to module…
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {candidates.map((module) => (
          <DropdownMenuItem
            key={module.id}
            data-testid={`scope-move-${module.id}`}
            onClick={() => {
              moveToModule(artifact.id, module.id)
                .then((moved) => {
                  toastSuccess(`"${moved.name}" is now owned by "${module.title}"`);
                })
                .catch((error: unknown) => {
                  toastError('Could not move the artifact into the module', error);
                });
            }}
          >
            {module.title}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
