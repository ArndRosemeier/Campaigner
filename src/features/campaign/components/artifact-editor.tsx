import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { HistoryIcon, SparklesIcon, SwordsIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';

import { artifactRepo } from '@/db';
import { AdoptDialog } from '@/features/campaign/components/adopt-dialog';
import { AliasEditor } from '@/features/campaign/components/alias-editor';
import { adoptIntoCampaign, moveToModule } from '@/db/artifactRepo';
import { promoteRosterUses } from '@/db/artifactAutoPromote';
import { modulePath } from '@/app/routes';
import { getModule } from '@/db/moduleRepo';
import { useContentRefillRequest } from '@/features/campaign/contentRefillRequest';
import { changeArtifact } from '@/features/modules/change-artifact';
import {
  ARTIFACT_KIND_SINGULAR,
  DUNGEON_MAP_PATH_LABELS,
  encounterDataIsComplex,
  type AnyArtifact,
  type ArtifactLink,
  type ArtifactRevision,
  type DungeonMapPath,
  type EncounterArtifactData,
  type EventArtifactData,
  type FactionArtifactData,
  type GameSystem,
  type Id,
  type LocationArtifactData,
  type NpcArtifactData,
  type PcArtifactData,
  type PlotArcArtifactData,
} from '@/domain';
import { BlockedControl } from '@/components/blocked-control';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
import { MentionsPanel } from '@/features/campaign/components/mentions-panel';
import { ImagesSection } from '@/features/campaign/components/images-section';
import { MarkdownBody } from '@/features/campaign/components/markdown-body';
import { PeekModal } from '@/features/modules/peek-modal';
import { MobPortraitsSection } from '@/features/campaign/components/mob-portraits-section';
import { RunBattleButton } from '@/features/play/run-battle';
import { ModuleBattlePicker } from '@/features/campaign/components/run-battle-picker';
import { RevisionDialog } from '@/features/campaign/components/revision-dialog';
import { TagEditor } from '@/features/campaign/components/tag-editor';
import { useRevisions } from '@/features/campaign/hooks';
import { deepEqual } from '@/lib/equal';
import { formatDateTime } from '@/lib/format';
import { toastError, toastSuccess } from '@/lib/toast';
import { registerPageFlush } from '@/lib/pageFlush';
import { cn } from '@/lib/utils';

/** Autosave debounce (05-UI §Artifact editor). */
const AUTOSAVE_DELAY_MS = 800;

/**
 * The autosave debounce, exported because the tests that pin the page-hide
 * flush cap their waits against it: a wait longer than the window would pass
 * on the timer alone and stop proving that a flush landed the write.
 */
export { AUTOSAVE_DELAY_MS };

/**
 * The editable slice of an artifact, correlated with its kind so `data` stays
 * narrowed (no casts anywhere in the editor).
 */
interface CommonDraft {
  name: string;
  tags: string[];
  aliases: string[];
  summary: string;
  body: string;
  links: ArtifactLink[];
}
type PcDraft = CommonDraft & { kind: 'pc'; data: PcArtifactData };
type NpcDraft = CommonDraft & { kind: 'npc'; data: NpcArtifactData };
type LocationDraft = CommonDraft & { kind: 'location'; data: LocationArtifactData };
/** Event drafts share the location shape exactly (EventArtifactData is the location alias). */
type EventDraft = CommonDraft & { kind: 'event'; data: EventArtifactData };
type FactionDraft = CommonDraft & { kind: 'faction'; data: FactionArtifactData };
type NoteDraft = CommonDraft & { kind: 'note'; data: Record<string, never> };
type EncounterDraft = CommonDraft & { kind: 'encounter'; data: EncounterArtifactData };
type PlotArcDraft = CommonDraft & { kind: 'plotarc'; data: PlotArcArtifactData };
export type ArtifactDraft =
  | PcDraft
  | NpcDraft
  | LocationDraft
  | EventDraft
  | FactionDraft
  | NoteDraft
  | EncounterDraft
  | PlotArcDraft;

function draftFrom(artifact: AnyArtifact): ArtifactDraft {
  const common: CommonDraft = {
    name: artifact.name,
    tags: [...artifact.tags],
    aliases: [...artifact.aliases],
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
    case 'event':
      return { ...common, kind: 'event', data: structuredClone(artifact.data) };
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
  aliases: string[];
  summary: string;
  body: string;
  links: ArtifactLink[];
  data: ArtifactDraft['data'];
} {
  const { name, tags, aliases, summary, body, links, data } = draft;
  return { name, tags, aliases, summary, body, links, data };
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
 * tags, aliases, summary and revision dropdown; Markdown body with preview;
 * kind form; links. Autosaves with an 800 ms debounce and only creates a
 * revision when content actually changed (deep-compare against the last
 * saved draft) — keystroke bursts never churn the 50-revision cap.
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
   * Adopts a row whose stored state moved underneath the draft (a revision
   * restore, or a write the editor itself made): the draft AND the last-saved
   * snapshot move to the fresh row in one step, so the pending-autosave effect
   * sees no difference and can never write the stale text back. The artifact
   * prop arriving from the parent's live query would do the same only while the
   * draft has no unsaved edits — this closes the window where a half-typed edit
   * coexists with a change the editor did not originate.
   *
   * The creature-row repair and the refused creature-row authored write this
   * comment used to name are GONE with the mob artifact (docs/17 row 106): a
   * row that cites a library creature is an ordinary authored npc, and the one
   * write still refused for it (`changeArtifact`, which could rename it and
   * thus let the generator cast a second row) refuses BEFORE any write, so
   * there is no rejected text to adopt.
   */
  const adoptExternalRow = useCallback((next: AnyArtifact): void => {
    const serverDraft = draftFrom(next);
    lastSavedRef.current = serverDraft;
    setDraft(serverDraft);
  }, []);

  /**
   * Persists the draft if it differs from the last saved state. An empty
   * name (mid-edit) never reaches the DB — the previous name is kept until
   * a valid one is entered, so autosave can't fail on `z.string().min(1)`.
   *
   * THE WRITE BOUNDARY. Everything that persists from this file funnels into
   * this one function, so no per-input check has to be remembered.
   *
   * There is no creature-row refusal here any more (docs/11 D8): a bestiary
   * creature is a LIBRARY row, which this editor can neither open nor write, so
   * the guard that used to protect a hidden creature artifact has nothing left
   * to protect. The rule is now structural rather than enforced — the tier has
   * no writer.
   */
  const saveDraft = useCallback(async (): Promise<boolean> => {
    const current = draftRef.current;
    const effective: ArtifactDraft =
      current.name.trim() === '' ? { ...current, name: lastSavedRef.current.name } : current;
    if (deepEqual(effective, lastSavedRef.current)) return false;
    setSaveState('saving');
    try {
      await artifactRepo.updateArtifact(artifact.id, draftPatch(effective));
      // ROSTER hook (monster-source picker commit path): the saved roster
      // may now cite another module's npc/mob artifact — a second-module use
      // promotes it to shared campaign ownership. Idempotent: already-shared
      // rows are a silent no-op, so autosave bursts never re-toast.
      if (effective.kind === 'encounter') {
        await promoteRosterUses(artifact.moduleId, effective.data.monsters);
      }
      lastSavedRef.current = effective;
      setSaveState('saved');
      return true;
    } catch (error) {
      setSaveState('error');
      toastError('Autosave failed', error);
      return false;
    }
  }, [artifact.id, artifact.moduleId, adoptExternalRow]);

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

  /**
   * THE page-hide flush (docs/17 row 111, `lib/pageFlush`). The unmount flush
   * below covers a route change and nothing else: closing, discarding or
   * freezing a tab never unmounts React, so an edit sitting inside the 800 ms
   * autosave window was lost with the tab and — this file's own contract —
   * with no revision to restore it from.
   */
  const flushPendingEdits = useCallback((): void => {
    void saveDraft();
  }, [saveDraft]);

  /**
   * The SAME flush on the two triggers that need it, in one effect because
   * they are the same work and the same lifetime:
   *
   * 1. `registerPageFlush` — the page going away. `saveDraft` IS the flush: it
   *    is already PENDING-GATED (it returns early unless the draft differs from
   *    `lastSavedRef`) and idempotent for the same reason (a successful write
   *    moves `lastSavedRef` onto what it wrote), so a tab switch writes nothing
   *    and fires no revision, while a failed write still reaches the owner
   *    ('Autosave failed').
   * 2. The cleanup — leaving the artifact (a route change), which already
   *    worked and must keep working. It runs on re-registration too, on the
   *    closure being replaced, so a new `saveDraft` identity never drops the
   *    edits the old one captured.
   */
  useEffect(() => {
    const unregister = registerPageFlush(flushPendingEdits);
    return () => {
      unregister();
      flushPendingEdits();
    };
  }, [flushPendingEdits]);

  async function handleRestore(revision: number): Promise<void> {
    try {
      await artifactRepo.restoreRevision(artifact.id, revision);
      toastSuccess(`Restored revision ${revision}`);
    } catch (error) {
      toastError('Restore failed', error);
    }
  }

  /**
   * The one draft mutator every authored input writes through — the header
   * fields, the AliasEditor, `MarkdownBody` and the kind forms all land here,
   * and every change is persisted only by `saveDraft`'s guarded write above.
   */
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
          {artifact.kind === 'encounter' && (
            <EncounterRunAction
              artifact={artifact}
              campaignId={campaignId}
              campaignArtifacts={campaignArtifacts}
            />
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
        <AliasEditor
          name={draft.name}
          aliases={draft.aliases}
          onChange={(aliases) => {
            patchDraft({ aliases });
          }}
        />
        <Input
          value={draft.summary}
          placeholder="Summary (one line, shown in the tree tooltip)…"
          aria-label="Summary"
          data-testid="artifact-summary"
          className="h-7 border-none bg-transparent px-1 text-xs shadow-none pointer-coarse:text-base dark:bg-transparent"
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
            textareaTestId="artifact-body"
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
            {draft.kind === 'event' && (
              <LocationForm
                data={draft.data}
                onChange={(data) => {
                  setDraft((previous) => ({ ...previous, kind: 'event', data }));
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
            {draft.kind !== 'encounter' && (
              <ContentAiSection artifact={artifact} />
            )}
            {draft.kind === 'encounter' && (
              <EncounterAiSection artifact={artifact} />
            )}
            {draft.kind === 'encounter' && (
              <EncounterForm
                data={draft.data}
                campaignArtifacts={campaignArtifacts}
                campaignSystem={campaignSystem}
                onChange={(data) => {
                  setDraft((previous) => ({ ...previous, kind: 'encounter', data }));
                }}
              />
            )}
            {artifact.kind === 'encounter' && (
              <MobPortraitsSection artifact={artifact} campaignId={campaignId} />
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

          {/* Mentions panel (14-BACKLINKS-ORPHANS): the derived wiki-link
              mentions, read-only and deliberately below the editable
              Relations section — the two graphs stay separate lists. It
              reuses the editor's pool (campaign + globals). */}
          <MentionsPanel
            artifact={artifact}
            campaignId={campaignId}
            campaignArtifacts={campaignArtifacts}
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
 * In-place refill hand-off for the smith kinds (npc/location/faction/note/
 * plotarc/pc — encounters have their own roster-aware section below): a
 * targeted generate run writes summary, body and details INTO this artifact,
 * preserving its name, relations, tags and images (docs/08 §M4-C). The run is
 * grounded in the owning module exactly like automatic module generation
 * (runEngine's targetModuleGrounding). Overwriting authored content is a
 * two-step act, mirroring the encounter section.
 *
 * A bestiary creature is not a row this panel can reach at all any more
 * (docs/11 D1/D8): it is a read-only LIBRARY entry, so there is no "creature
 * row" case here to guard. A CAST CREATURE npc (docs/11 D4) IS reachable and IS
 * fillable — its prose is exactly what a smith should write — and the refill
 * preserves its `creatureRef` through the write (`llm/runEngine.mergeRefillData`),
 * so filling it in cannot sever the citation that gives it the creature's
 * numbers.
 */
function ContentAiSection({ artifact }: { artifact: AnyArtifact }): JSX.Element {
  const requestRefill = useContentRefillRequest((state) => state.request);
  const [armed, setArmed] = useState(false);
  const hasContent = artifact.body.trim() !== '';

  return (
    <div className="flex items-center justify-between gap-3 rounded-md border p-3" data-testid="content-ai-section">
      <p className="text-xs text-muted-foreground">
        {hasContent
          ? 'Regenerate summary, body and details with a smith persona. Name, relations and images are preserved; when the artifact is module-owned, the run is grounded in its module like automatic generation.'
          : 'This artifact has no content yet — generate summary, body and details with a smith persona, grounded in its owning module when it has one.'}
      </p>
      <Button
        variant={hasContent && !armed ? 'outline' : 'default'}
        size="sm"
        data-testid="generate-artifact-content"
        onClick={() => {
          if (hasContent && !armed) {
            setArmed(true);
            return;
          }
          requestRefill(artifact.id, artifact.kind, hasContent);
          setArmed(false);
        }}
      >
        <SparklesIcon aria-hidden data-icon="inline-start" />
        {!hasContent ? 'Generate with AI' : armed ? 'Overwrite content — confirm?' : 'Regenerate with AI'}
      </Button>
    </div>
  );
}

/**
 * Encounter generation surface (docs/11, two-button regeneration): EXACTLY
 * two automatic actions for both shapes, plus the prose checkbox — nothing
 * else generates encounter content on its own.
 *
 * - Regenerate everything: a new dungeon top to bottom (complex: new roster
 *   + new layout + new map, same as if freshly module-generated; single: a
 *   fresh one-fight draft plus a fresh map, one action).
 * - Repopulate: the dungeon looks fine, the spawn looks wrong — a NEW roster
 *   for ALL rooms (complex: rooms, layout and map kept; single: today's
 *   Smith one-fight fill, map preserved).
 * - The checkbox ("Also redesign name and prose", default OFF): name/prose
 *   are redesigned too, prose-ONLY — it never touches the roster the run
 *   just built. Unticked, a dungeon's name and prose stay exactly as
 *   authored (singles always get fresh Smith prose per the Smith charter;
 *   ticking additionally replaces the name there).
 *
 * Both actions honor the fill grade (drawn once at the first materialization,
 * never redrawn, never ignored). Manual Clear (map deletion) and the
 * invisible unattended map queue are not generation buttons and stay as-is.
 */
function EncounterAiSection({ artifact }: { artifact: AnyArtifact }): JSX.Element | null {
  const data = artifact.kind === 'encounter' ? artifact.data : null;
  if (data === null) return null;
  return <EncounterRegenControls artifactId={artifact.id} data={data} />;
}

function EncounterRegenControls({
  artifactId,
  data,
}: {
  artifactId: Id;
  data: EncounterArtifactData;
}): JSX.Element {
  const [redesignProse, setRedesignProse] = useState(false);
  const [running, setRunning] = useState<'repopulate' | 'everything' | null>(null);
  // The per-run dungeon-map path for THIS Regenerate everything only
  // (docs/11 vision path): never persisted, never a new Settings default —
  // the next run starts back at 'default' (the control resets with the
  // section's state per mount).
  const [mapPathChoice, setMapPathChoice] = useState<'default' | DungeonMapPath>('default');
  const complex = encounterDataIsComplex(data);
  // Repopulating a roomless complex has nothing to stock — Regenerate
  // everything builds rooms and a map first.
  const repopulateBlocked = complex && data.layout === null;
  /**
   * The ONE gate expression behind Repopulate (AGENTS rule 4): the same boolean
   * drives the child's `disabled` and the DESCRIPTION it offers, so "held" and
   * "has a description" cannot disagree (docs/18 §4, ledger 125 — the shape the
   * classification control and CanvasPage's gates took).
   */
  const repopulateHeld = running !== null || repopulateBlocked;

  async function run(action: 'repopulate' | 'everything'): Promise<void> {
    if (running !== null) return;
    setRunning(action);
    try {
      // The ENGINE call goes through THE change seam (docs/17 row 101,
      // docs/18 §2): the seam resolves the row and picks the route, while this
      // surface keeps only its own state (the `running` flag) and its copy. No
      // instruction is passed — these two buttons ask for the operation
      // itself, so every brief the engine sends stays byte-identical.
      const result = await changeArtifact({
        artifactId,
        encounter: {
          operation: action,
          redesignProse,
          // Singles ignore the choice (the control is complex-only, so the
          // state is always 'default' there — and the engine stamps single
          // briefs classic regardless).
          ...(mapPathChoice === 'default' ? {} : { dungeonMapPath: mapPathChoice }),
        },
      });
      if (result.status !== 'changed') {
        // A refusal is never silent — the seam's own reason is what the owner
        // reads (never a generic line).
        toastError(result.reason);
        return;
      }
      toastSuccess(
        action === 'repopulate'
          ? 'Encounter repopulated — a new roster stocks every room, map kept'
          : 'Encounter regenerated — new roster, new layout, new map',
      );
    } catch (error) {
      toastError(
        action === 'repopulate' ? 'Could not repopulate the encounter' : 'Could not regenerate the encounter',
        error,
      );
    } finally {
      setRunning(null);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border p-3" data-testid="encounter-ai-section">
      <p className="text-xs text-muted-foreground">
        Two automatic actions exist — nothing else generates encounter content on its own.
        {complex
          ? ' Regenerate everything builds a new roster, a new layout and a new map. Repopulate writes a new roster for all rooms and keeps rooms, layout and map.'
          : ' Regenerate everything writes a fresh roster and prose, then a fresh map. Repopulate rewrites the roster as one fight and keeps the map.'}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <BlockedControl
          testId="encounter-regenerate-everything"
          // Sibling of Repopulate below (a site the reason sweep named): while
          // the OTHER action runs this label stays "Regenerate everything", so
          // nothing on the control says why it is dead.
          reason={
            running === 'repopulate'
              ? 'Repopulate is running right now — wait for it.'
              : null
          }
        >
          <Button
            variant="default"
            size="sm"
            data-testid="encounter-regenerate-everything"
            disabled={running !== null}
            onClick={() => {
              void run('everything');
            }}
          >
            <SparklesIcon aria-hidden data-icon="inline-start" />
            {running === 'everything' ? 'Regenerating…' : 'Regenerate everything'}
          </Button>
        </BlockedControl>
        <BlockedControl
          testId="encounter-repopulate"
          // Reasons in the order they hold the control: the roomless complex,
          // then the OTHER action's run — the one blocked state whose label says
          // nothing (this action's own run renders "Repopulating…"). Each
          // sentence is written ONCE, here (docs/18 §2.3/§4, ledger 125): the
          // roomless one used to be repeated verbatim in the child's `title`,
          // where no browser renders it and no key reaches it.
          reason={
            repopulateBlocked
              ? 'This dungeon has no rooms yet — Regenerate everything builds rooms and a map first'
              : running === 'everything'
                ? 'Regenerate everything is running right now — wait for it.'
                : null
          }
        >
          <Button
            variant="outline"
            size="sm"
            data-testid="encounter-repopulate"
            disabled={repopulateHeld}
            // The DESCRIPTION, not a reason (docs/18 §4, ledger 125): what
            // pressing the control does, offered only while it can act. `held`
            // here is the SAME expression as `disabled` above, so a held control
            // never carries a description, and the roomless complex states its
            // case in the wrapper's reason and nowhere else.
            title={
              repopulateHeld
                ? undefined
                : complex
                  ? 'New roster for all rooms — rooms, layout and map kept'
                  : 'New one-fight roster — map kept'
            }
            onClick={() => {
              void run('repopulate');
            }}
          >
            <SwordsIcon aria-hidden data-icon="inline-start" />
            {running === 'repopulate' ? 'Repopulating…' : 'Repopulate'}
          </Button>
        </BlockedControl>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
          <Checkbox
            checked={redesignProse}
            data-testid="encounter-redesign-prose"
            aria-label="Also redesign name and prose"
            onCheckedChange={(checked) => {
              setRedesignProse(checked);
            }}
          />
          Also redesign name and prose
        </label>
        {complex && (
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
            Map path
            <Select
              value={mapPathChoice}
              items={{
                default: 'Use default',
                classic: DUNGEON_MAP_PATH_LABELS.classic,
                vision: DUNGEON_MAP_PATH_LABELS.vision,
              }}
              onValueChange={(value) => {
                if (value === 'default' || value === 'classic' || value === 'vision') {
                  setMapPathChoice(value);
                }
              }}
            >
              <SelectTrigger aria-label="Regenerate map path" data-testid="encounter-regen-map-path">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">Use default</SelectItem>
                <SelectItem value="classic">{DUNGEON_MAP_PATH_LABELS.classic}</SelectItem>
                <SelectItem value="vision">{DUNGEON_MAP_PATH_LABELS.vision}</SelectItem>
              </SelectContent>
            </Select>
          </label>
        )}
      </div>
      {complex && (
        <p className="text-[11px] text-muted-foreground" data-testid="encounter-regen-map-path-hint">
          {mapPathChoice === 'vision'
            ? 'Vision: one painted map, room plaques located by sight.'
            : mapPathChoice === 'classic'
              ? 'Classic: packed vector rooms on the grid.'
              : 'Use default: follows the dungeon map path setting.'}
        </p>
      )}
      <p className="text-[11px] text-muted-foreground">
        {complex
          ? 'Unticked, name and prose stay exactly as authored. Manual Clear (map deletion) and the budget advisory below are untouched by either button.'
          : 'The Smith always refreshes prose on singles — ticking the box additionally replaces the name. Manual Clear (map deletion) and the budget advisory below are untouched by either button.'}
      </p>
      {running !== null && (
        <p className="text-xs text-muted-foreground" data-testid="encounter-regen-status" role="status">
          {running === 'repopulate' ? 'Repopulating the roster…' : 'Regenerating everything…'} The run
          rows stay visible under Runs.
        </p>
      )}
    </div>
  );
}

/**
 * Run-battle affordance for the editor header (owner-ratified: own-module
 * anchor + picker fallback). Battles still anchor per module (10-MILESTONE-6
 * D10): a module-owned encounter runs through the module view's own
 * `RunBattleButton`, anchored to its own module; a campaign- or
 * library-scoped encounter opens a module picker whose rows render the same
 * button — one two-step replace confirm, never a fork.
 */
function EncounterRunAction({
  artifact,
  campaignId,
  campaignArtifacts,
}: {
  artifact: AnyArtifact & { kind: 'encounter' };
  campaignId: Id;
  campaignArtifacts: readonly AnyArtifact[];
}): JSX.Element {
  const [pickerOpen, setPickerOpen] = useState(false);
  const moduleId = artifact.moduleId;
  if (moduleId !== null) {
    return <RunBattleButton campaignId={campaignId} moduleId={moduleId} encounter={artifact} />;
  }
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        data-testid="run-battle-picker"
        onClick={() => {
          setPickerOpen(true);
        }}
      >
        <SwordsIcon aria-hidden data-icon="inline-start" />
        Run battle…
      </Button>
      <ModuleBattlePicker
        campaignId={campaignId}
        encounter={artifact}
        campaignArtifacts={campaignArtifacts}
        open={pickerOpen}
        onOpenChange={setPickerOpen}
      />
    </>
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
