import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  AlertCircleIcon,
  BanIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleDotIcon,
  CopyIcon,
  Maximize2Icon,
  MinusIcon,
  PencilIcon,
  PlayIcon,
  RotateCcwIcon,
  SquareArrowOutUpRightIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react';

import { CandidatePreviewDialog } from '@/features/images/candidate-preview-dialog';
import { EncounterLayoutPreview } from '@/features/campaign/components/encounter-layout-preview';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toastError, toastSuccess } from '@/lib/toast';
import { ARTIFACT_KIND_SINGULAR } from '@/domain/artifact';
import { FAILURE_KIND_GUIDANCE, FAILURE_KIND_LABELS } from '@/domain/run';
import { Textarea } from '@/components/ui/textarea';
import { HelpButton } from '@/help/HelpButton';
import { ROUTES, artifactPath } from '@/app/routes';
import { getAnyArtifact, listArtifactsByCampaign, listGlobalArtifacts } from '@/db/artifactRepo';
import { getPersona, listPersonas } from '@/db/personaRepo';
import { listRulebooks } from '@/db/rulebookRepo';
import { deleteRun, getRun, listRunsByCampaign } from '@/db/runRepo';
import { defaultSettings, type ArtifactKind, type Autonomy, type Campaign, type EncounterLayout, type Id, type Persona, type PersonaRun } from '@/domain';
import { GAME_SYSTEM_LABELS } from '@/domain/gameSystem';
import { rejectionIssues, runEngine, type StartRunInput } from '@/llm/runEngine';
import { usePinnedChunksStore } from '@/features/rules/pinStore';
import { useIllustrationRequest } from '@/features/campaign/illustrationRequest';
import { useEncounterGenerationRequest } from '@/features/campaign/encounterGenerationRequest';
import { useContentRefillRequest } from '@/features/campaign/contentRefillRequest';
import { readSettings, updateSettings } from '@/db/settingsRepo';
import { extrasForPersona } from '@/llm/personas/extras';
import type { PostCreateExtra } from '@/domain';
import { useModules } from '@/features/modules/hooks';
import { Checkbox } from '@/components/ui/checkbox';
import { ImageThumb } from '@/features/images/image-thumb';
import { useImageUrl } from '@/features/images/use-image-url';
import { WritersRoom } from '@/features/campaign/components/writers-room';

const AUTONOMY_OPTIONS: { value: Autonomy; label: string }[] = [
  { value: 'manual', label: 'Manual' },
  { value: 'review', label: 'Review' },
  { value: 'auto', label: 'Auto' },
];

/**
 * Canonical smith persona per refillable kind (the STUB_PERSONA_SLUGS
 * convention, 08 §M4-C, extended with the Arc Weaver for plotarcs): the
 * slug match wins over a producesKind scan so a user-created persona with
 * the same kind never outranks the built-in smith.
 */
const REFILL_PERSONA_SLUGS: Readonly<Partial<Record<ArtifactKind, string>>> = {
  npc: 'npc-smith',
  location: 'worldbuilder',
  faction: 'faction-designer',
  note: 'plot-architect',
  plotarc: 'arc-weaver',
};

/** The generate-mode persona that refills artifacts of `kind` (undefined =
 * none exists — the panel leaves the request unclaimed and says nothing). */
function resolveRefillPersona(personas: readonly Persona[], kind: ArtifactKind): Persona | undefined {
  const slug = REFILL_PERSONA_SLUGS[kind];
  if (slug !== undefined) {
    const bySlug = personas.find((persona) => persona.slug === slug && persona.mode === 'generate');
    if (bySlug !== undefined) return bySlug;
  }
  return personas.find((persona) => persona.mode === 'generate' && persona.producesKind === kind);
}

/** The pre-filled brief for a refill request (truthfully worded: an empty
 * artifact is a first generation, not a regeneration). */
function refillBrief(kind: ArtifactKind, regenerate: boolean): string {
  const noun = ARTIFACT_KIND_SINGULAR[kind].toLowerCase();
  return regenerate
    ? `Regenerate the full content of this ${noun} — summary, body and details. Its name, relations and images are preserved.`
    : `Generate the full content of this ${noun}: summary, body and details. Its name, relations and images are preserved.`;
}

/** One "After creation" extra: the offered set derives from the CHOSEN
 * persona (extrasForPersona) — the checkbox writes a remembered preference
 * (Settings.runExtras) except the battlemap offer, which is one-off. */
function ExtraCheckbox({
  label,
  testId,
  checked,
  onChecked,
}: {
  label: string;
  testId: string;
  checked: boolean;
  onChecked: (value: boolean) => void;
}): JSX.Element {
  return (
    <Label className="flex cursor-pointer items-center gap-2 text-sm" data-testid={testId}>
      <Checkbox
        checked={checked}
        onCheckedChange={onChecked}
      />
      {label}
    </Label>
  );
}

const STATUS_LABELS: Record<PersonaRun['status'], string> = {
  running: 'running',
  awaiting_user: 'awaiting you',
  needs_review: 'needs review',
  completed: 'completed',
  cancelled: 'cancelled',
  failed: 'failed',
};

/**
 * The completed-run "Open artifact/encounter" affordance. A plain link is
 * DEAD when the result artifact is already the open page (a targeted in-place
 * run finishes while its artifact is on screen; and re-clicking after one
 * navigation lands on the same URL) — the click then navigates to the path
 * the browser is already showing and nothing visibly happens. In that case
 * the component states the result instead of offering a no-op button.
 */
function CompletedRunArtifactAction({
  campaignId,
  artifactId,
  label,
  noun,
}: {
  campaignId: Id;
  artifactId: Id;
  label: string;
  noun: string;
}): JSX.Element {
  const location = useLocation();
  const target = artifactPath(campaignId, artifactId);
  if (location.pathname === target) {
    return (
      <p
        className="flex items-center gap-1.5 text-xs text-muted-foreground"
        data-testid="run-result-open"
      >
        <CheckIcon aria-hidden className="size-3.5 text-emerald-600" />
        This {noun} is already open in the editor
      </p>
    );
  }
  return (
    <Button render={<Link to={target} />} nativeButton={false}>
      <SquareArrowOutUpRightIcon aria-hidden data-icon="inline-start" />
      {label}
    </Button>
  );
}

/**
 * Right pane (05-UI.md §Workspace): Assistant tab (persona + brief + run
 * view) and Runs tab (history with read-only step log).
 *
 * `initialRunId` deep-links a run (the progress dock's "Open" affordance
 * navigates here with `?run=<id>`): the panel selects that run and focuses
 * the Assistant tab, wherever the run was started from.
 */
export function PersonaPanel({
  campaign,
  hasApiKey,
  initialRunId,
}: {
  campaign: Campaign;
  hasApiKey: boolean;
  initialRunId?: string | null;
}): JSX.Element {
  const personas = useLiveQuery(() => listPersonas(), []);
  const campaignArtifacts = useLiveQuery(() => listArtifactsByCampaign(campaign.id), [campaign.id]);
  const globalArtifacts = useLiveQuery(() => listGlobalArtifacts(), []);
  const targetArtifacts = useMemo(
    () => [...(campaignArtifacts ?? []), ...(globalArtifacts ?? [])],
    [campaignArtifacts, globalArtifacts],
  );
  const [personaId, setPersonaId] = useState<string>('');
  const [autonomy, setAutonomy] = useState<Autonomy>('auto');
  const [brief, setBrief] = useState('');
  const [targetArtifactId, setTargetArtifactId] = useState<string>('');
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [tab, setTab] = useState<string>('assistant');
  // One-off module placement for the created artifact ('' = campaign level);
  // deliberately NOT remembered — a stale remembered module would silently
  // scope new artifacts (ratified owner default 3).
  const [placementModuleId, setPlacementModuleId] = useState<string>('');
  // NOTE: the old one-off "Generate a battlemap" extra is gone — every
  // freshly created encounter gets its battlemap automatically via the
  // unattended map queue (post-run-extras; the module dialog's battlemaps
  // toggle is the module-scoped master switch).

  // Deep link (dock "Open" → workspace `?run=<id>`): focus the run. ActiveRun
  // renders inside the Assistant tab, so the tab follows the selection.
  useEffect(() => {
    if (initialRunId === undefined || initialRunId === null || initialRunId === '') return;
    setTab('assistant');
    setActiveRunId(initialRunId);
  }, [initialRunId]);

  const pinned = usePinnedChunksStore((state) => state.chunks);
  const unpin = usePinnedChunksStore((state) => state.unpin);
  const requestArtifactId = useIllustrationRequest((state) => state.artifactId);
  const requestedAt = useIllustrationRequest((state) => state.requestedAt);
  const clearRequest = useIllustrationRequest((state) => state.clear);
  const encounterRequestId = useEncounterGenerationRequest((state) => state.artifactId);
  const encounterRequestRegenerate = useEncounterGenerationRequest((state) => state.regenerate);
  const encounterRequestVariant = useEncounterGenerationRequest((state) => state.variant);
  const encounterRequestedAt = useEncounterGenerationRequest((state) => state.requestedAt);
  const clearEncounterRequest = useEncounterGenerationRequest((state) => state.clear);
  const settings = useLiveQuery(() => readSettings(), []);

  const selectedPersona = personas?.find((persona) => persona.id === personaId);
  const isReview = selectedPersona?.mode === 'review';
  const isImage = selectedPersona?.mode === 'image';
  const isEncounter = selectedPersona?.mode === 'encounter';
  // A generate persona with an explicit target refills that artifact in
  // place (the artifact-editor's "Generate/Regenerate with AI" hand-off):
  // the run writes into it instead of creating a new one. Encounter-kind
  // personas are excluded — the Encounter Smith's content hand-off has its
  // own targeted branch in start() below (docs/11 semantics, no refill UI).
  const isTargetedRefill =
    selectedPersona?.mode === 'generate' &&
    selectedPersona.producesKind !== 'encounter' &&
    targetArtifactId !== '';
  const needsTarget = isReview || isImage || isTargetedRefill;
  // The creation-dialog controls (module placement + post-create extras)
  // apply to NEW artifacts only: a targeted run fills an existing one and
  // its placement is immutable outside the editor's explicit scope moves.
  const createsArtifact =
    selectedPersona !== undefined && !isReview && !isImage && targetArtifactId === '';
  const kindNoun =
    selectedPersona?.producesKind === undefined
      ? 'artifact'
      : ARTIFACT_KIND_SINGULAR[selectedPersona.producesKind].toLowerCase();
  const offeredExtras = useMemo(
    () => (selectedPersona === undefined ? [] : extrasForPersona(selectedPersona)),
    [selectedPersona],
  );
  const offers = (extra: PostCreateExtra): boolean => offeredExtras.includes(extra);

  // "Illustrate…" from the artifact editor: select the Illustrator persona,
  // target the requesting artifact, and focus the Assistant tab (M3-A).
  useEffect(() => {
    if (requestArtifactId === null) return;
    const illustrator = personas?.find((persona) => persona.slug === 'illustrator');
    if (illustrator === undefined) return; // personas not loaded yet
    setPersonaId(illustrator.id);
    setTargetArtifactId(requestArtifactId);
    setAutonomy('auto');
    setTab('assistant');
    clearRequest();
  }, [requestArtifactId, requestedAt, personas, clearRequest]);

  useEffect(() => {
    if (encounterRequestId === null) return;
    const slug =
      encounterRequestVariant === 'content' ? 'encounter-smith' : 'encounter-cartographer';
    const persona = personas?.find((candidate) => candidate.slug === slug);
    if (persona === undefined) return; // personas not loaded yet
    setPersonaId(persona.id);
    setTargetArtifactId(encounterRequestId);
    // Word the brief truthfully: an encounter without the thing being
    // generated is a first generation, not a regeneration — "regenerate"
    // made it sound like one already existed.
    setBrief(
      encounterRequestVariant === 'content'
        ? encounterRequestRegenerate
          ? 'Regenerate the full content of this encounter — roster with stat sources, terrain, tactics, treasure and prose. Its name, relations and battlemap are preserved.'
          : 'Generate the full content of this encounter: roster with stat sources, terrain, tactics, treasure and prose. Its name, relations and battlemap are preserved.'
        : encounterRequestRegenerate
          ? 'Regenerate this encounter map while preserving its authored roster and prose. Room keys regenerate with the map — edit them again afterwards if needed.'
          : 'Generate a battlemap and room layout for this encounter, with a GM-only key and treasure checklist per room.',
    );
    setAutonomy('auto');
    setTab('assistant');
    clearEncounterRequest();
  }, [encounterRequestId, encounterRequestRegenerate, encounterRequestVariant, encounterRequestedAt, personas, clearEncounterRequest]);

  // "Generate/Regenerate with AI" from the artifact editor (smith kinds):
  // select the kind's smith persona, target the requesting artifact, word
  // the brief truthfully and focus the Assistant tab — the mirror of the
  // encounter hand-off above. The run stays a normal generate run; the
  // target makes finalize write INTO the artifact.
  const refillRequestId = useContentRefillRequest((state) => state.artifactId);
  const refillKind = useContentRefillRequest((state) => state.kind);
  const refillRegenerate = useContentRefillRequest((state) => state.regenerate);
  const refillRequestedAt = useContentRefillRequest((state) => state.requestedAt);
  const clearRefillRequest = useContentRefillRequest((state) => state.clear);
  useEffect(() => {
    if (refillRequestId === null || refillKind === null) return;
    const persona =
      personas === undefined ? undefined : resolveRefillPersona(personas, refillKind);
    if (persona === undefined) return; // personas not loaded yet
    setPersonaId(persona.id);
    setTargetArtifactId(refillRequestId);
    setBrief(refillBrief(refillKind, refillRegenerate));
    setAutonomy('auto');
    setTab('assistant');
    clearRefillRequest();
  }, [refillRequestId, refillKind, refillRegenerate, refillRequestedAt, personas, clearRefillRequest]);

  // Remembered extras defaults (aspect pattern): the dialog pre-ticks from
  // Settings.runExtras and persists toggles.
  const rememberedExtras = settings?.runExtras ?? { image: false, statBlock: false, mobPortraits: false };
  const modules = useModules(campaign.id);

  function tickedExtras(): {
    image: boolean;
    statBlock: boolean;
    mobPortraits: boolean;
  } {
    return {
      image: offers('image') && rememberedExtras.image,
      statBlock: offers('statBlock') && rememberedExtras.statBlock,
      mobPortraits: offers('mobPortraits') && rememberedExtras.mobPortraits,
    };
  }

  async function setRememberedExtra(key: 'image' | 'statBlock' | 'mobPortraits', value: boolean): Promise<void> {
    await updateSettings({
      runExtras: {
        image: key === 'image' ? value : rememberedExtras.image,
        statBlock: key === 'statBlock' ? value : rememberedExtras.statBlock,
        mobPortraits: key === 'mobPortraits' ? value : rememberedExtras.mobPortraits,
      },
    }).catch((error: unknown) => {
      toastError('Could not save the extras default', error);
    });
  }

  async function start(): Promise<void> {
    if (selectedPersona === undefined) return;
    if (selectedPersona.mode === 'encounter') {
      // Regenerate keeps the target encounter's own preset (docs/11 D10): an
      // existing map is never silently re-tiered. A fresh run passes NO
      // preset — Auto — so the brief's resolution chain decides (explicit
      // choice > the encounter's locationKind > the Settings fallback); the
      // Settings select below is that fallback, not a per-run override.
      const targetArtifact = targetArtifacts.find((artifact) => artifact.id === targetArtifactId);
      const targetPreset = targetArtifact?.kind === 'encounter' ? targetArtifact.data.preset : undefined;
      const runId = await runEngine.startRun({
        campaign,
        persona: selectedPersona,
        autonomy,
        brief,
        pinnedChunkIds: pinned.map((chunk) => chunk.id),
        // The schema-defaulted read (F8 cosmetic alignment): the queue paths
        // read the aspect through getSettings()' schema default — this
        // fallback must be the same Settings default, not a hardcoded
        // literal that can drift from domain/settings.
        encounterMapAspect: settings?.encounterMapAspect ?? defaultSettings().encounterMapAspect,
        ...(targetArtifactId !== '' && targetPreset !== undefined
          ? { encounterPreset: targetPreset }
          : {}),
        ...(targetArtifactId === '' ? {} : { targetArtifactId }),
        // Fresh encounter creates carry the dialog's placement + extras;
        // targeted fills get neither (placement is fresh-create only).
        ...(targetArtifactId === '' && placementModuleId !== ''
          ? { placementModuleId }
          : {}),
        ...(targetArtifactId === '' ? { extras: tickedExtras() } : {}),
      });
      setActiveRunId(runId);
      return;
    }
    // Encounter Smith targeted content fill (mode generate, docs/11): the
    // artifact-editor's content hand-off targets an existing encounter and
    // the run writes INTO it — name, links, images and battlemap preserved.
    // start() used to fall through to the fresh-create branch here, DROPPING
    // the target (the run duplicated the artifact instead of refilling it).
    if (selectedPersona.producesKind === 'encounter' && targetArtifactId !== '') {
      const runId = await runEngine.startRun({
        campaign,
        persona: selectedPersona,
        autonomy,
        brief,
        pinnedChunkIds: pinned.map((chunk) => chunk.id),
        targetArtifactId,
      });
      setActiveRunId(runId);
      return;
    }
    if (needsTarget) {
      if (targetArtifactId === '') return;
      const runId = await runEngine.startRun({
        campaign,
        persona: selectedPersona,
        autonomy,
        brief,
        pinnedChunkIds: pinned.map((chunk) => chunk.id),
        targetArtifactId,
      });
      setActiveRunId(runId);
      return;
    }
    const runId = await runEngine.startRun({
      campaign,
      persona: selectedPersona,
      autonomy,
      brief,
      pinnedChunkIds: pinned.map((chunk) => chunk.id),
      ...(placementModuleId !== '' ? { placementModuleId } : {}),
      extras: tickedExtras(),
    });
    setActiveRunId(runId);
  }

  return (
    <div className="flex h-full flex-col" data-testid="persona-panel">
      <Tabs
        value={tab}
        onValueChange={(value) => {
          if (typeof value === 'string') setTab(value);
        }}
        className="flex h-full flex-col gap-0"
      >
        <div className="flex items-center border-b">
          <TabsList className="flex-1 justify-start rounded-none border-b-0">
            <TabsTrigger value="assistant">Assistant</TabsTrigger>
            <TabsTrigger value="room">Writers' room</TabsTrigger>
            <TabsTrigger value="runs">Runs</TabsTrigger>
          </TabsList>
          <div className="pr-1">
            <HelpButton topic="assistant" label="personas & runs" />
          </div>
        </div>

        <TabsContent value="assistant" className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col gap-3 p-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="persona-select">Persona</Label>
              <Select
                value={personaId}
                onValueChange={(value) => {
                  if (value === null) return;
                  setPersonaId(value);
                  if (personas?.find((persona) => persona.id === value)?.mode === 'encounter') {
                    setTargetArtifactId('');
                  }
                }}
                items={Object.fromEntries(
                  (personas ?? []).map((persona) => [persona.id, persona.name]),
                )}
              >
                <SelectTrigger className="w-full" aria-label="Persona">
                  <SelectValue
                    placeholder={personas === undefined ? 'Loading…' : 'Choose a persona'}
                  />
                </SelectTrigger>
                <SelectContent>
                  {(personas ?? []).map((persona) => (
                    <SelectItem key={persona.id} value={persona.id}>
                      {persona.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="autonomy-select">Autonomy</Label>
              <Select
                value={autonomy}
                items={Object.fromEntries(
                  AUTONOMY_OPTIONS.map((option) => [option.value, option.label]),
                )}
                onValueChange={(value) => {
                  if (value !== null) setAutonomy(value);
                }}
              >
                <SelectTrigger className="w-full" aria-label="Autonomy">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AUTONOMY_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {needsTarget && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="target-select">
                  {isImage ? 'Artifact to illustrate' : isTargetedRefill ? 'Artifact to refill' : 'Artifact to check'}
                </Label>
                <Select
                  value={targetArtifactId}
                  items={Object.fromEntries(
                    targetArtifacts.map((artifact) => [
                      artifact.id,
                      artifact.campaignId === null ? `${artifact.name} — Global` : artifact.name,
                    ]),
                  )}
                  onValueChange={(value) => {
                    if (value !== null) setTargetArtifactId(value);
                  }}
                >
                  <SelectTrigger
                    className="w-full"
                    aria-label={isImage ? 'Artifact to illustrate' : isTargetedRefill ? 'Artifact to refill' : 'Artifact to check'}
                  >
                    <SelectValue placeholder="Choose an artifact" />
                  </SelectTrigger>
                  <SelectContent>
                    {targetArtifacts.map((artifact) => (
                      <SelectItem key={artifact.id} value={artifact.id}>
                        {artifact.name}
                        {artifact.campaignId === null ? ' — Global' : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Textarea
                  id="brief"
                  rows={2}
                  placeholder={
                    isImage
                      ? 'Optional image focus, e.g. night scene'
                      : isTargetedRefill
                        ? 'Focus for the refill, e.g. emphasize her role in the finale'
                        : 'Optional focus, e.g. timeline consistency'
                  }
                  value={brief}
                  onChange={(event) => {
                    setBrief(event.target.value);
                  }}
                />
              </div>
            )}

            {isTargetedRefill && (
              <p className="text-xs text-amber-600" data-testid="refill-target-notice">
                Runs against the selected artifact; its name, relations and images are
                preserved, and when it is module-owned the run is grounded in that module
                exactly like automatic module generation. Placement and new-artifact
                options do not apply.
              </p>
            )}

            {!needsTarget && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="brief">Brief</Label>
                <Textarea
                  id="brief"
                  rows={4}
                  placeholder="e.g. a goblin alchemist boss for a level 3 party"
                  value={brief}
                  onChange={(event) => {
                    setBrief(event.target.value);
                  }}
                />
              </div>
            )}

            {createsArtifact && (
              <>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="module-select">Module</Label>
                  <Select
                    value={placementModuleId}
                    onValueChange={(value) => {
                      setPlacementModuleId(value ?? '');
                    }}
                  >
                    <SelectTrigger id="module-select" aria-label="Module" className="w-full">
                      <SelectValue placeholder="Campaign (no module)" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="" data-testid="placement-campaign">
                        Campaign (no module)
                      </SelectItem>
                      {(modules ?? []).map((module) => (
                        <SelectItem key={module.id} value={module.id}>
                          {module.title}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {placementModuleId !== '' && (
                    <p className="text-xs text-muted-foreground" data-testid="placement-note">
                      The created {kindNoun} will live in module{' '}
                      {(modules ?? []).find((module) => module.id === placementModuleId)?.title ??
                        '…'}
                      .
                    </p>
                  )}
                </div>
                {offeredExtras.length > 0 && (
                  <div className="flex flex-col gap-1.5" data-testid="run-extras">
                    <Label>After creation</Label>
                    {offers('image') && (
                      <ExtraCheckbox
                        label="Generate a cover image"
                        testId="extra-image"
                        checked={rememberedExtras.image}
                        onChecked={(value) => {
                          void setRememberedExtra('image', value);
                        }}
                      />
                    )}
                    {offers('statBlock') && (
                      <ExtraCheckbox
                        label="Include a stat block"
                        testId="extra-statblock"
                        checked={rememberedExtras.statBlock}
                        onChecked={(value) => {
                          void setRememberedExtra('statBlock', value);
                        }}
                      />
                    )}
                    {offers('mobPortraits') && (
                      <ExtraCheckbox
                        label="Generate mob portraits"
                        testId="extra-mob-portraits"
                        checked={rememberedExtras.mobPortraits}
                        onChecked={(value) => {
                          void setRememberedExtra('mobPortraits', value);
                        }}
                      />
                    )}
                  </div>
                )}
              </>
            )}

            {isEncounter && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="encounter-aspect">Map aspect</Label>
                <Select
                  value={settings?.encounterMapAspect ?? '4:3'}
                  items={{ '4:3': '4:3', '16:9': '16:9', '1:1': '1:1' }}
                  onValueChange={(value) => {
                    if (value === '4:3' || value === '16:9' || value === '1:1') {
                      void updateSettings({ encounterMapAspect: value }).catch((error: unknown) => {
                        toastError('Could not save map aspect', error);
                      });
                    }
                  }}
                >
                  <SelectTrigger aria-label="Map aspect">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="4:3">4:3</SelectItem>
                    <SelectItem value="16:9">16:9</SelectItem>
                    <SelectItem value="1:1">1:1</SelectItem>
                  </SelectContent>
                </Select>
                <Label htmlFor="encounter-preset">Preset</Label>
                <Select
                  value={settings?.encounterPreset ?? 'auto'}
                  items={{ auto: 'Auto', standard: 'Standard', dungeon: 'Dungeon' }}
                  onValueChange={(value) => {
                    if (value === 'auto' || value === 'standard' || value === 'dungeon') {
                      // Auto (null) is the default: each encounter's own
                      // locationKind decides its grid tier (docs/11 D10
                      // amendment); Standard/Dungeon force the tier.
                      void updateSettings({ encounterPreset: value === 'auto' ? null : value }).catch((error: unknown) => {
                        toastError('Could not save map preset', error);
                      });
                    }
                  }}
                >
                  <SelectTrigger aria-label="Preset">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto</SelectItem>
                    <SelectItem value="standard">Standard</SelectItem>
                    <SelectItem value="dungeon">Dungeon</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Auto: each encounter's own location kind decides — dungeons map on
                  the Dungeon tier (a connected multi-room complex on a finer grid,
                  each cell half the size), everything else on Standard. Standard or
                  Dungeon forces the tier for every map.
                </p>
                {/* fix-02 (decision 6): one lightweight, non-blocking notice
                when this campaign's system has no ready bestiary pack. */}
                <NoPackNotice system={campaign.system} />
                {targetArtifactId !== '' && (
                  <p className="text-xs text-amber-600" data-testid="encounter-regenerate-target">
                    Runs against the selected encounter; name, prose, relations and roster are
                    preserved, layout and map are replaced (keeping its map preset). Placement and
                    new-artifact options do not apply.
                  </p>
                )}
              </div>
            )}

            {pinned.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <Label>Pinned rules ({pinned.length})</Label>
                <div className="flex flex-wrap gap-1.5">
                  {pinned.map((chunk) => (
                    <Badge key={chunk.id} variant="secondary" className="max-w-[16rem]">
                      <span className="truncate">
                        {chunk.headingPath[chunk.headingPath.length - 1] ?? `p. ${chunk.pageStart}`}
                      </span>
                      <button
                        type="button"
                        aria-label={`Unpin ${chunk.headingPath[chunk.headingPath.length - 1] ?? 'chunk'}`}
                        className="ml-1 text-muted-foreground hover:text-foreground"
                        onClick={() => {
                          unpin(chunk.id);
                        }}
                      >
                        ×
                      </button>
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {hasApiKey ? (
              <Button
                disabled={
                  selectedPersona === undefined ||
                  (needsTarget ? targetArtifactId === '' : brief.trim() === '')
                }
                onClick={() => void start()}
                data-testid="start-run"
              >
                <PlayIcon aria-hidden data-icon="inline-start" />
                {isImage ? 'Illustrate' : isEncounter ? 'Generate encounter' : 'Start'}
              </Button>
            ) : (
              <div className="rounded-md border border-dashed p-2 text-center text-xs text-muted-foreground">
                No API key —{' '}
                <Link to={ROUTES.settings} className="underline">
                  add one in Settings
                </Link>{' '}
                to run personas.
              </div>
            )}

            {activeRunId !== null && <ActiveRun runId={activeRunId} campaign={campaign} />}
          </div>
        </TabsContent>

        <TabsContent value="room" className="min-h-0 flex-1 overflow-y-auto">
          <WritersRoom campaign={campaign} />
        </TabsContent>

        <TabsContent value="runs" className="min-h-0 flex-1 overflow-y-auto">
          <RunsList
            campaignId={campaign.id}
            onSelectRun={(runId) => {
              setActiveRunId(runId);
              setTab('assistant');
            }}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * fix-02 (decision 6): the no-pack affordance. When the campaign's system has
 * no ready machine-readable bestiary pack, the encounter run dialog says so
 * once — lightweight, non-blocking (the run itself is never disabled; mobs
 * then come from cited excerpts or inline stat blocks). No notice while the
 * library loads or when a ready pack exists.
 */
function NoPackNotice({ system }: { system: Campaign['system'] }): JSX.Element | null {
  const hasReadyPack = useLiveQuery(async () => {
    const books = await listRulebooks();
    return books.some(
      (book) => book.origin === 'pack' && book.system === system && book.status === 'ready',
    );
  }, [system]);
  if (hasReadyPack !== false) return null;
  return (
    <p className="text-xs text-muted-foreground" data-testid="no-pack-notice">
      No bestiary pack for {GAME_SYSTEM_LABELS[system]} installed — encounter monsters will be
      generated from inline stat blocks.
    </p>
  );
}

function ActiveRun({ runId, campaign }: { runId: string; campaign: Campaign }): JSX.Element {
  const run = useLiveQuery(() => getRun(runId), [runId]);
  const persona = useLiveQuery(
    () => (run === undefined ? undefined : getPersona(run.personaId)),
    [run === undefined ? undefined : run.personaId],
  );
  const target = useLiveQuery(
    () =>
      run?.targetArtifactId === null || run?.targetArtifactId === undefined
        ? undefined
        : getAnyArtifact(run.targetArtifactId),
    [run?.targetArtifactId],
  );
  const [streamed, setStreamed] = useState('');
  const [thinking, setThinking] = useState('');
  const streamRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    setStreamed('');
    setThinking('');
    return runEngine.on((event) => {
      if (event.runId !== runId) return;
      if (event.kind === 'token') {
        setStreamed((previous) => previous + event.delta);
      } else if (event.kind === 'thinking') {
        // Illustration only: the model's raw reasoning deltas while it works,
        // dimmed and cleared with the run. Never part of the run's output.
        setThinking((previous) => (previous + event.delta).slice(-2000));
      } else if (event.kind === 'reset') {
        // Model fallback restarted the stream: drop the failed attempt's
        // partial tokens so the preview never stitches two attempts together.
        setStreamed('');
        setThinking('');
      }
    });
  }, [runId]);

  useEffect(() => {
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight });
  }, [streamed]);

  if (run === undefined) {
    return <p className="text-sm text-muted-foreground">Loading run…</p>;
  }

  const runningIndex = run.steps.findIndex((step) => step.status === 'running');

  return (
    <div className="flex flex-col gap-2 border-t pt-3" data-testid="active-run">
      <div className="flex items-center gap-2 text-xs">
        <Badge
          variant={
            run.status === 'completed'
              ? 'default'
              : run.status === 'failed'
                ? 'destructive'
                : 'outline'
          }
        >
          {STATUS_LABELS[run.status]}
        </Badge>
        {target?.campaignId === null && (
          <Badge variant="outline" data-testid="run-global-badge">
            Library
          </Badge>
        )}
        {run.errorMessage !== '' && <span className="text-destructive">{run.errorMessage}</span>}
      </div>

      <ol className="flex flex-col gap-1">
        {run.steps.map((step, index) => {
          // Persisted escalation notices (fallback model answered, contract
          // repair escalated, candidates capped at one) — visible, never
          // silent (AGENTS rule 1).
          const notice = (step.output as { notice?: unknown } | null | undefined)?.notice;
          const noticeText = typeof notice === 'string' && notice !== '' ? notice : null;
          return (
            <li
              key={step.index}
              className="flex flex-wrap items-center gap-2 text-xs"
              data-testid={`run-step-${step.name}`}
            >
              <StepIcon status={step.status} />
              <span className={step.status === 'running' ? 'font-medium' : ''}>{step.name}</span>
              {step.status === 'rejected' && <Badge variant="destructive">needs review</Badge>}
              {index === runningIndex && (
                <span className="text-muted-foreground">
                  streaming… (reasoning models can think for several minutes before text appears)
                </span>
              )}
              {noticeText !== null && (
                <span
                  className="basis-full text-amber-600 dark:text-amber-400"
                  data-testid={`step-notice-${step.name}`}
                >
                  {noticeText}
                </span>
              )}
            </li>
          );
        })}
      </ol>

      {runningIndex !== -1 && thinking.trim() !== '' && streamed === '' && (
        <div data-testid="thinking-stream">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
            the model is thinking
          </p>
          <pre className="max-h-40 overflow-y-auto rounded-md bg-muted/60 p-2 font-mono text-[11px] italic whitespace-pre-wrap text-muted-foreground/70">
            {thinking}
          </pre>
        </div>
      )}

      {runningIndex !== -1 && streamed !== '' && (
        <pre
          ref={streamRef}
          className="max-h-40 overflow-y-auto rounded-md bg-muted p-2 font-mono text-[11px] whitespace-pre-wrap"
          data-testid="stream"
        >
          {streamed}
        </pre>
      )}

      {run.status === 'failed' ? (
        <FailedRunActions run={run} campaign={campaign} persona={persona} />
      ) : persona?.mode === 'image' ? (
        <ImageRunActions run={run} campaign={campaign} persona={persona} />
      ) : persona?.mode === 'encounter' ? (
        <EncounterRunActions run={run} campaign={campaign} persona={persona} />
      ) : (
        <RunActions run={run} campaign={campaign} />
      )}
    </div>
  );
}

/**
 * Run actions for image personas (07-MILESTONE-3 M3-A): the prompt draft is
 * editable fields (the user edits the prompt instead of rerolling images),
 * and the pick step ALWAYS pauses for the user to choose 0–2 candidates.
 */
function ImageRunActions({
  run,
  campaign,
  persona,
}: {
  run: PersonaRun;
  campaign: Campaign;
  persona: Persona;
}): JSX.Element | null {
  const [selected, setSelected] = useState<Id[]>([]);
  const [previewCandidateId, setPreviewCandidateId] = useState<Id | null>(null);
  const [prompt, setPrompt] = useState('');
  const [negative, setNegative] = useState('');
  const [styleNotes, setStyleNotes] = useState('');

  const paused = run.status === 'awaiting_user';
  const draftStep = run.steps.find((step) => step.name === 'prompt-draft');
  const pickStep = run.steps.find((step) => step.name === 'pick');
  const generating = run.steps.some((step) => step.name === 'generate' && step.status === 'running');

  // Sync the editable prompt fields from the latest draft output (the user's
  // saved edit wins over the raw output, mirroring the engine).
  useEffect(() => {
    if (!paused || draftStep === undefined) return;
    const effective = (draftStep.userEdit ?? draftStep.output) as
      | { parsed?: { prompt?: string; negative?: string; styleNotes?: string } }
      | null;
    setPrompt(effective?.parsed?.prompt ?? '');
    setNegative(effective?.parsed?.negative ?? '');
    setStyleNotes(effective?.parsed?.styleNotes ?? '');
  }, [paused, draftStep]);

  const pickCandidates = ((pickStep?.output as { candidates?: unknown } | null | undefined)?.candidates ?? []) as Id[];
  // The generate step persists a notice when the model caps candidates at 1
  // (imageGen's n-retry) — shown so a single candidate is never a surprise.
  const generateOutput = run.steps.find((step) => step.name === 'generate')?.output as
    | { notice?: unknown }
    | null
    | undefined;
  const capNotice = typeof generateOutput?.notice === 'string' ? generateOutput.notice : null;

  if (run.status === 'completed' && run.resultArtifactId !== null) {
    return (
      <CompletedRunArtifactAction
        campaignId={run.campaignId}
        artifactId={run.resultArtifactId}
        label="Open artifact"
        noun="artifact"
      />
    );
  }

  if (run.status === 'failed' || run.status === 'cancelled') return null;

  const input = {
    campaign,
    persona,
    autonomy: run.autonomy,
    brief: run.userBrief,
    pinnedChunkIds: run.pinnedChunkIds,
  };

  return (
    <div className="flex flex-col gap-2" data-testid="image-run-actions">
      {paused && draftStep?.status === 'done' && (
        <div className="flex flex-col gap-1.5" data-testid="image-prompt-edit">
          <Label htmlFor="image-prompt">Image prompt</Label>
          <Textarea
            id="image-prompt"
            rows={4}
            value={prompt}
            onChange={(event) => {
              setPrompt(event.target.value);
            }}
          />
          <Label htmlFor="image-negative">Avoid</Label>
          <Textarea
            id="image-negative"
            rows={2}
            value={negative}
            onChange={(event) => {
              setNegative(event.target.value);
            }}
          />
          <Label htmlFor="image-style">Style notes</Label>
          <Textarea
            id="image-style"
            rows={2}
            value={styleNotes}
            onChange={(event) => {
              setStyleNotes(event.target.value);
            }}
          />
          <Button
            size="sm"
            disabled={prompt.trim() === ''}
            data-testid="continue-image"
            onClick={() => {
              void runEngine
                .editStep(run.id, draftStep.index, {
                  parsed: { prompt: prompt.trim(), negative, styleNotes },
                }, input)
                .catch((error: unknown) => {
                  toastError('Could not continue', error);
                });
            }}
          >
            <CheckIcon aria-hidden data-icon="inline-start" />
            Generate images
          </Button>
        </div>
      )}

      {generating && (
        // No count claimed: whether the model yields 1 or 2 candidates is
        // only known once the request lands (some models cap n at 1).
        <p className="text-xs text-muted-foreground" data-testid="image-generating">
          Generating candidate images…
        </p>
      )}

      {capNotice !== null && (
        <p className="text-xs text-amber-600 dark:text-amber-400" data-testid="image-cap-notice">
          {capNotice}
        </p>
      )}

      {paused && pickStep?.status === 'done' && (
        <div className="flex flex-col gap-2" data-testid="image-pick">
          <div className="flex items-center justify-between">
            <Label>Candidates — pick up to 2</Label>
            <span className="text-xs text-muted-foreground">Click to select · Double-click or inspect to enlarge</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {pickCandidates.map((candidateId) => {
              const isSelected = selected.includes(candidateId);
              return (
                <div
                  key={candidateId}
                  className={`group/candidate relative rounded-md border p-1 transition-all ${
                    isSelected ? 'border-primary ring-2 ring-primary' : 'border-border hover:border-muted-foreground/50'
                  }`}
                >
                  <button
                    type="button"
                    aria-pressed={isSelected}
                    aria-label={`Candidate ${candidateId}`}
                    className="block cursor-pointer overflow-hidden rounded"
                    onClick={() => {
                      setSelected((previous) =>
                        previous.includes(candidateId)
                          ? previous.filter((id) => id !== candidateId)
                          : previous.length >= 2
                            ? previous
                            : [...previous, candidateId],
                      );
                    }}
                    onDoubleClick={() => {
                      setPreviewCandidateId(candidateId);
                    }}
                  >
                    <ImageThumb imageId={candidateId} alt={`Generated candidate ${candidateId}`} size={144} />
                    {isSelected && (
                      <div className="absolute top-2 left-2 rounded-full bg-primary p-0.5 text-primary-foreground shadow">
                        <CheckIcon className="size-3.5" />
                      </div>
                    )}
                  </button>
                  <Button
                    variant="secondary"
                    size="icon-xs"
                    className="absolute bottom-2 right-2 size-7 rounded-md bg-background/85 shadow backdrop-blur transition-opacity hover:bg-background"
                    aria-label={`Inspect candidate image ${candidateId}`}
                    title="View large image"
                    data-testid={`inspect-candidate-${candidateId}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      setPreviewCandidateId(candidateId);
                    }}
                  >
                    <Maximize2Icon className="size-3.5" aria-hidden />
                  </Button>
                </div>
              );
            })}
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={selected.length === 0}
              data-testid="keep-selected"
              onClick={() => {
                void runEngine.pickImages(run.id, selected).catch((error: unknown) => {
                  toastError('Could not save selection', error);
                });
              }}
            >
              <CheckIcon aria-hidden data-icon="inline-start" />
              Keep {selected.length} selected
            </Button>
            <Button
              variant="outline"
              size="sm"
              data-testid="keep-none"
              onClick={() => {
                void runEngine.pickImages(run.id, []).catch((error: unknown) => {
                  toastError('Could not discard images', error);
                });
              }}
            >
              Keep none
            </Button>
          </div>
          <CandidatePreviewDialog
            candidates={pickCandidates}
            currentId={previewCandidateId}
            onClose={() => { setPreviewCandidateId(null); }}
            isSelected={(id) => selected.includes(id)}
            onSelectCandidate={(id) => {
              setSelected((previous) =>
                previous.includes(id)
                  ? previous.filter((item) => item !== id)
                  : previous.length >= 2
                    ? previous
                    : [...previous, id],
              );
            }}
            title="Generated image candidate"
          />
        </div>
      )}

      <div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void runEngine.cancel(run.id).catch((error: unknown) => {
              toastError('Could not cancel the run', error);
            });
          }}
        >
          <BanIcon aria-hidden data-icon="inline-start" />
          Cancel run
        </Button>
      </div>
    </div>
  );
}

function EncounterRunActions({
  run,
  campaign,
  persona,
}: {
  run: PersonaRun;
  campaign: Campaign;
  persona: Persona;
}): JSX.Element | null {
  const [selected, setSelected] = useState<Id | null>(null);
  const [previewMapId, setPreviewMapId] = useState<Id | null>(null);
  const layoutStep = run.steps.find((step) => step.name === 'layout');
  const layoutValue = layoutStep?.userEdit ?? layoutStep?.output;
  const layout =
    layoutValue !== null && layoutValue !== undefined && typeof layoutValue === 'object'
      ? ((layoutValue as { layout?: EncounterLayout }).layout ?? null)
      : null;
  const pick = run.steps.find((step) => step.name === 'pick');
  const candidates =
    ((pick?.output as { candidates?: Id[] } | null | undefined)?.candidates ?? []);
  const input = {
    campaign,
    persona,
    autonomy: run.autonomy,
    brief: run.userBrief,
    pinnedChunkIds: run.pinnedChunkIds,
    ...(run.targetArtifactId === null ? {} : { targetArtifactId: run.targetArtifactId }),
    ...(run.encounterMapAspect === null ? {} : { encounterMapAspect: run.encounterMapAspect }),
    ...(run.encounterPreset === null ? {} : { encounterPreset: run.encounterPreset }),
    ...(run.placementModuleId === null ? {} : { placementModuleId: run.placementModuleId }),
    ...(run.runExtras === null ? {} : { extras: run.runExtras }),
  };

  if (run.status === 'completed' && run.resultArtifactId !== null) {
    return (
      <CompletedRunArtifactAction
        campaignId={run.campaignId}
        artifactId={run.resultArtifactId}
        label="Open encounter"
        noun="encounter"
      />
    );
  }
  if (run.status === 'failed' || run.status === 'cancelled') return null;

  if (run.status === 'awaiting_user' && pick?.status === 'done') {
    return (
      <div className="flex flex-col gap-2" data-testid="encounter-map-pick">
        <div className="flex items-center justify-between">
          <Label>Battlemap candidates</Label>
          <span className="text-xs text-muted-foreground">Click to select · Double-click or inspect to enlarge</span>
        </div>
        {layout !== null && <EncounterLayoutPreview layout={layout} />}
        <div className="flex flex-wrap gap-2">
          {candidates.map((candidateId) => (
            <div
              key={candidateId}
              className={`group/candidate relative rounded-md border p-1 transition-all ${
                selected === candidateId ? 'border-primary ring-2 ring-primary' : 'border-border hover:border-muted-foreground/50'
              }`}
            >
              <button
                type="button"
                aria-label={`Encounter map candidate ${candidateId}`}
                aria-pressed={selected === candidateId}
                className="block cursor-pointer overflow-hidden rounded"
                onClick={() => {
                  setSelected(candidateId);
                }}
                onDoubleClick={() => {
                  setPreviewMapId(candidateId);
                }}
              >
                {layout === null ? (
                  <ImageThumb imageId={candidateId} alt="Generated battlemap candidate" size={144} />
                ) : (
                  <EncounterMapCandidate imageId={candidateId} layout={layout} />
                )}
              </button>
              <Button
                variant="secondary"
                size="icon-xs"
                className="absolute bottom-2 right-2 size-7 rounded-md bg-background/85 shadow backdrop-blur transition-opacity hover:bg-background"
                aria-label={`Inspect map candidate ${candidateId}`}
                title="View large battlemap"
                data-testid={`inspect-map-candidate-${candidateId}`}
                onClick={(event) => {
                  event.stopPropagation();
                  setPreviewMapId(candidateId);
                }}
              >
                <Maximize2Icon className="size-3.5" aria-hidden />
              </Button>
            </div>
          ))}
        </div>
        <Button
          size="sm"
          disabled={selected === null}
          data-testid="keep-encounter-map"
          onClick={() => {
            if (selected === null) return;
            void runEngine.editStep(run.id, pick.index, { keep: [selected] }, input).catch((error: unknown) => {
              toastError('Could not save the battlemap', error);
            });
          }}
        >
          <CheckIcon aria-hidden data-icon="inline-start" />
          Use selected map
        </Button>
        <Button
          variant="outline"
          size="sm"
          data-testid="regenerate-map-candidates"
          onClick={() => {
            void runEngine.regenerateEncounterCandidates(run.id, input).catch((error: unknown) => {
              toastError('Could not regenerate the map candidates', error);
            });
          }}
        >
          <RotateCcwIcon aria-hidden data-icon="inline-start" />
          Regenerate candidates
        </Button>
        <CandidatePreviewDialog
          candidates={candidates}
          currentId={previewMapId}
          onClose={() => { setPreviewMapId(null); }}
          isSelected={(id) => selected === id}
          onSelectCandidate={(id) => {
            setSelected(id);
          }}
          layout={layout}
          title="Generated battlemap candidate"
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-testid="encounter-run-actions">
      <RunActions run={run} campaign={campaign} />
    </div>
  );
}

function EncounterMapCandidate({
  imageId,
  layout,
}: {
  imageId: Id;
  layout: EncounterLayout;
}): JSX.Element {
  const url = useImageUrl(imageId);
  return (
    <div
      className="relative w-48 overflow-hidden rounded"
      style={{ aspectRatio: `${String(layout.gridW)} / ${String(layout.gridH)}` }}
    >
      {url !== null && <img src={url} alt="Generated battlemap candidate" className="absolute inset-0 size-full object-fill" />}
      <EncounterLayoutPreview layout={layout} overlay />
    </div>
  );
}

function StepIcon({ status }: { status: PersonaRun['steps'][number]['status'] }): JSX.Element {
  if (status === 'done' || status === 'approved') {
    return <CheckIcon aria-hidden className="size-3.5 text-emerald-500" />;
  }
  if (status === 'rejected') {
    return <CircleDotIcon aria-hidden className="size-3.5 text-destructive" />;
  }
  if (status === 'skipped') {
    return <MinusIcon aria-hidden className="size-3.5 text-muted-foreground" />;
  }
  return <CircleDotIcon aria-hidden className="size-3.5 text-muted-foreground" />;
}

function RunActions({
  run,
  campaign,
}: {
  run: PersonaRun;
  campaign: Campaign;
}): JSX.Element | null {
  const personaRow = useLiveQuery(() => getPersona(run.personaId), [run.personaId]);
  const [editMode, setEditMode] = useState(false);
  const [editText, setEditText] = useState('');
  const [retryText, setRetryText] = useState('');

  const paused = run.status === 'awaiting_user' || run.status === 'needs_review';
  const stepIndex = run.steps.findIndex(
    (step) => step.status === 'running' || step.status === 'rejected' || step.status === 'pending',
  );
  const target = stepIndex === -1 ? run.steps.length - 1 : stepIndex;
  const step = run.steps[target];

  const input = useMemo(() => {
    return personaRow === undefined
      ? null
      : {
          campaign,
          persona: personaRow,
          autonomy: run.autonomy,
          brief: run.userBrief,
          pinnedChunkIds: run.pinnedChunkIds,
          ...(run.targetArtifactId === null ? {} : { targetArtifactId: run.targetArtifactId }),
          ...(run.encounterMapAspect === null ? {} : { encounterMapAspect: run.encounterMapAspect }),
    ...(run.encounterPreset === null ? {} : { encounterPreset: run.encounterPreset }),
          ...(run.placementModuleId === null ? {} : { placementModuleId: run.placementModuleId }),
          ...(run.runExtras === null ? {} : { extras: run.runExtras }),
        };
  }, [
    personaRow,
    campaign,
    run.autonomy,
    run.userBrief,
    run.pinnedChunkIds,
    run.targetArtifactId,
    run.encounterMapAspect,
    run.encounterPreset,
    run.placementModuleId,
    run.runExtras,
  ]);

  if (run.status === 'completed' && run.resultArtifactId !== null) {
    return (
      <CompletedRunArtifactAction
        campaignId={run.campaignId}
        artifactId={run.resultArtifactId}
        label="Open artifact"
        noun="artifact"
      />
    );
  }
  if (!paused || input === null || step === undefined) return null;
  // Rejected LLM output has no validated payload and cannot safely advance.
  const canApprove = step.status !== 'rejected';
  const issues = canApprove ? [] : rejectionIssues(step);

  return (
    <div className="flex flex-col gap-2">
      {!canApprove && (
        <div className="flex flex-col gap-1 text-xs text-destructive" data-testid="step-rejection">
          <p>
            The model's reply did not match the required shape, even after one automatic
            correction. Retry (optionally with an extra instruction), or edit the JSON.
          </p>
          {issues.length > 0 && (
            <ul className="list-disc pl-4 font-mono text-[11px]">
              {issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {editMode ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="step-edit">Edited step output (JSON)</Label>
          <Textarea
            id="step-edit"
            rows={6}
            className="font-mono text-xs"
            value={editText}
            onChange={(event) => {
              setEditText(event.target.value);
            }}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => {
                void runEngine
                  .editStep(run.id, target, safeJson(editText), input)
                  .then(() => {
                    setEditMode(false);
                  })
                  .catch((error: unknown) => {
                    toastError('Could not apply the step edit', error);
                  });
              }}
            >
              <CheckIcon aria-hidden data-icon="inline-start" />
              Save & continue
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setEditMode(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {canApprove && (
              <Button
                size="sm"
                onClick={() => {
                  void runEngine.approve(run.id, input).catch((error: unknown) => {
                    toastError('Could not approve the step', error);
                  });
                }}
                data-testid="approve-step"
              >
                <CheckIcon aria-hidden data-icon="inline-start" />
                Approve
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setEditText(JSON.stringify(step.userEdit ?? step.output, null, 2));
                setEditMode(true);
              }}
            >
              <PencilIcon aria-hidden data-icon="inline-start" />
              Edit
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void runEngine.cancel(run.id).catch((error: unknown) => {
                  toastError('Could not cancel the run', error);
                });
              }}
            >
              <BanIcon aria-hidden data-icon="inline-start" />
              Cancel run
            </Button>
          </div>
          {run.status === 'needs_review' && (
            <div className="flex gap-2">
              <Input
                value={retryText}
                placeholder="Optional extra instruction…"
                onChange={(event) => {
                  setRetryText(event.target.value);
                }}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void runEngine.retryStep(run.id, retryText, input).catch((error: unknown) => {
                    toastError('Could not retry the step', error);
                  });
                }}
              >
                <RotateCcwIcon aria-hidden data-icon="inline-start" />
                Retry
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * The step a failed run died on: the first rejected/running step, else the
 * first never-attempted one — the same step `resumeRun` restarts from.
 */
function failedStepName(run: PersonaRun): string | null {
  const active = run.steps.find(
    (step) => step.status === 'rejected' || step.status === 'running',
  );
  if (active !== undefined) return active.name;
  const unattempted = run.steps.find(
    (step) => step.output === null && step.status !== 'skipped',
  );
  return unattempted?.name ?? null;
}

/**
 * The failed-run Details section (docs/05 run views): the classification
 * badge with its one-line guidance, the step the run died on, the started/
 * failed timestamps and the FULL raw errorMessage in a selectable mono block
 * with a Copy affordance. Purely additive context — recovery (Resume) stays
 * in FailedRunActions; this section never replaces the message with the
 * classification, it shows both.
 */
function FailedRunDetails({ run }: { run: PersonaRun }): JSX.Element {
  const kind = run.failureKind ?? 'unknown';
  const [copied, setCopied] = useState(false);
  const [clipboardNote, setClipboardNote] = useState(false);
  const stepName = failedStepName(run);

  async function handleCopy(): Promise<void> {
    try {
      // The DOM lib types `navigator.clipboard` as always present, but at
      // runtime it is missing in insecure contexts and test environments —
      // the widening cast states the truth the type cannot.
      const clipboard = navigator.clipboard as Clipboard | undefined;
      if (clipboard === undefined) throw new Error('Clipboard API is unavailable here');
      await clipboard.writeText(run.errorMessage);
      setCopied(true);
      toastSuccess('Error copied to clipboard');
      setTimeout(() => {
        setCopied(false);
      }, 2000);
    } catch (error) {
      // Loud fallback (AGENTS 2): say the clipboard failed instead of
      // silently doing nothing — the block is select-text, so the raw error
      // can still be copied by hand.
      setClipboardNote(true);
      toastError('Clipboard unavailable — select the error text and copy it manually', error);
    }
  }

  return (
    <div
      className="flex flex-col gap-2 rounded-md border bg-background/60 p-2.5"
      data-testid="failed-run-details"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="destructive" className="text-[10px]" data-testid="failure-kind-badge">
          {FAILURE_KIND_LABELS[kind]}
        </Badge>
        <span className="text-muted-foreground" data-testid="failure-kind-guidance">
          {FAILURE_KIND_GUIDANCE[kind]}
        </span>
      </div>
      {stepName !== null && (
        <p className="text-muted-foreground">
          Failed at step: <span className="font-medium text-foreground">{stepName}</span>
        </p>
      )}
      <p className="text-muted-foreground">
        Started {new Date(run.createdAt).toLocaleString()} · Failed{' '}
        {new Date(run.updatedAt).toLocaleString()}
      </p>
      {run.errorMessage !== '' ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Raw error
            </span>
            <Button
              variant="outline"
              size="xs"
              className="h-6 gap-1 text-[11px]"
              data-testid="copy-error-details"
              onClick={() => {
                void handleCopy();
              }}
            >
              {copied ? (
                <>
                  <CheckIcon className="size-3 text-green-600" aria-hidden />
                  <span>Copied</span>
                </>
              ) : (
                <>
                  <CopyIcon className="size-3" aria-hidden />
                  <span>Copy</span>
                </>
              )}
            </Button>
          </div>
          <pre
            className="max-h-40 select-text overflow-y-auto whitespace-pre-wrap break-words rounded bg-muted/60 p-2 font-mono text-[11px]"
            data-testid="failed-run-raw-error"
          >
            {run.errorMessage}
          </pre>
          {clipboardNote && (
            <p className="text-destructive" role="note" data-testid="clipboard-note">
              Clipboard is unavailable here — select the error text above and copy it manually.
            </p>
          )}
        </div>
      ) : (
        <p className="text-muted-foreground" data-testid="failed-run-no-message">
          No error message was recorded for this run.
        </p>
      )}
    </div>
  );
}

function FailedRunActions({
  run,
  campaign,
  persona,
}: {
  run: PersonaRun;
  campaign: Campaign;
  persona?: Persona | undefined;
}): JSX.Element {
  const [resuming, setResuming] = useState(false);
  const [retryText, setRetryText] = useState('');
  const [showInstruction, setShowInstruction] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  const input: StartRunInput | undefined =
    persona === undefined
      ? undefined
      : {
          campaign,
          persona,
          autonomy: run.autonomy,
          brief: run.userBrief,
          pinnedChunkIds: run.pinnedChunkIds,
          ...(run.targetArtifactId === null ? {} : { targetArtifactId: run.targetArtifactId }),
          ...(run.encounterMapAspect === null ? {} : { encounterMapAspect: run.encounterMapAspect }),
    ...(run.encounterPreset === null ? {} : { encounterPreset: run.encounterPreset }),
          ...(run.placementModuleId === null ? {} : { placementModuleId: run.placementModuleId }),
          ...(run.runExtras === null ? {} : { extras: run.runExtras }),
        };

  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs"
      data-testid="failed-run-actions"
    >
      <div className="flex items-center gap-1.5 font-medium text-destructive">
        <AlertCircleIcon className="size-4 shrink-0" aria-hidden />
        <span>Generation interrupted or encountered an error</span>
      </div>
      <p className="text-muted-foreground">
        Completed steps and drafted content are preserved. You can resume generation from the failed step.
      </p>

      {showInstruction && (
        <Textarea
          placeholder="Optional instruction for the retry…"
          value={retryText}
          onChange={(event) => {
            setRetryText(event.target.value);
          }}
          className="min-h-16 text-xs bg-background"
          data-testid="resume-instruction-input"
        />
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button
          size="sm"
          disabled={resuming}
          data-testid="resume-failed-run"
          onClick={() => {
            setResuming(true);
            void runEngine.resumeRun(run.id, retryText, input).catch((error: unknown) => {
              toastError('Could not resume generation', error);
              setResuming(false);
            });
          }}
        >
          <RotateCcwIcon aria-hidden className="size-3.5" data-icon="inline-start" />
          {resuming ? 'Resuming…' : 'Resume generation'}
        </Button>

        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setShowInstruction((previous) => !previous);
          }}
        >
          {showInstruction ? 'Hide instruction' : 'Resume with instruction…'}
        </Button>

        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            void runEngine.cancel(run.id).catch((error: unknown) => {
              toastError('Could not dismiss run', error);
            });
          }}
        >
          Dismiss
        </Button>

        <Button
          variant="outline"
          size="sm"
          aria-expanded={showDetails}
          data-testid="failed-run-details-toggle"
          onClick={() => {
            setShowDetails((previous) => !previous);
          }}
        >
          {showDetails ? (
            <ChevronDownIcon aria-hidden className="size-3.5" data-icon="inline-start" />
          ) : (
            <ChevronRightIcon aria-hidden className="size-3.5" data-icon="inline-start" />
          )}
          Details
        </Button>
      </div>

      {showDetails && <FailedRunDetails run={run} />}
    </div>
  );
}

function RunsList({
  campaignId,
  onSelectRun,
}: {
  campaignId: string;
  onSelectRun?: (runId: Id) => void;
}): JSX.Element {
  const runs = useLiveQuery(() => listRunsByCampaign(campaignId), [campaignId]);
  const personas = useLiveQuery(() => listPersonas(), []);
  const globalIds = useLiveQuery(
    async () => new Set((await listGlobalArtifacts()).map((artifact) => artifact.id)),
    [],
  );
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const openRun = useLiveQuery(
    () => (openRunId === null ? undefined : getRun(openRunId)),
    [openRunId],
  );
  const [copied, setCopied] = useState(false);

  async function handleDeleteRun(id: string): Promise<void> {
    if (openRunId === id) setOpenRunId(null);
    try {
      await deleteRun(id);
      toastSuccess('Run deleted');
    } catch (error) {
      toastError('Could not delete run', error);
    }
  }

  async function handleResumeRun(id: string): Promise<void> {
    try {
      await runEngine.resumeRun(id);
      onSelectRun?.(id);
    } catch (error) {
      toastError('Could not resume run', error);
    }
  }

  async function handleCopy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toastSuccess('Report copied to clipboard');
      setTimeout(() => {
        setCopied(false);
      }, 2000);
    } catch (error) {
      toastError('Could not copy report to clipboard', error);
    }
  }

  const openPersona = personas?.find((candidate) => candidate.id === openRun?.personaId);
  const reportJson =
    openRun === undefined
      ? ''
      : JSON.stringify(
          {
            id: openRun.id,
            persona: openPersona?.name ?? openRun.personaId,
            status: openRun.status,
            errorMessage: openRun.errorMessage || undefined,
            userBrief: openRun.userBrief,
            updatedAt: openRun.updatedAt,
            steps: openRun.steps,
          },
          null,
          2,
        );

  return (
    <div className="flex flex-col gap-2 p-3" data-testid="runs-list">
      {(runs ?? []).length === 0 && (
        <p className="mt-6 text-center text-sm text-muted-foreground">No runs yet.</p>
      )}
      {(runs ?? []).map((run) => {
        const persona = personas?.find((candidate) => candidate.id === run.personaId);
        const stamp = new Date(run.updatedAt).toLocaleString();
        return (
          <div
            key={run.id}
            className="group/run flex items-start gap-1 rounded-md border p-2 text-xs"
          >
            <button
              type="button"
              className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
              onClick={() => {
                setOpenRunId((previous) => (previous === run.id ? null : run.id));
              }}
            >
              <span className="flex items-center gap-2">
                <span className="font-medium">{persona?.name ?? 'Persona'}</span>
                <Badge variant="outline">{STATUS_LABELS[run.status]}</Badge>
                {run.status === 'failed' && run.failureKind !== null && (
                  <Badge variant="outline" data-testid={`failure-kind-${run.id}`}>
                    {FAILURE_KIND_LABELS[run.failureKind]}
                  </Badge>
                )}
                {run.targetArtifactId !== null && globalIds?.has(run.targetArtifactId) === true && (
                  <Badge variant="outline">Global</Badge>
                )}
              </span>
              <span className="truncate text-muted-foreground">{run.userBrief}</span>
              <span className="text-muted-foreground">{stamp}</span>
            </button>
            {run.status === 'failed' && (
              <>
                <Button
                  variant="outline"
                  size="xs"
                  aria-label={`Resume run ${stamp}`}
                  className="shrink-0 h-6 px-2 text-[11px] gap-1 text-primary hover:text-primary"
                  data-testid={`resume-run-${run.id}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleResumeRun(run.id);
                  }}
                >
                  <RotateCcwIcon className="size-3" aria-hidden />
                  <span>Resume</span>
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  aria-label={`Run details ${stamp}`}
                  className="shrink-0 h-6 px-2 text-[11px] gap-1 text-muted-foreground hover:text-foreground"
                  data-testid={`details-run-${run.id}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    setOpenRunId((previous) => (previous === run.id ? null : run.id));
                  }}
                >
                  <ChevronDownIcon className="size-3" aria-hidden />
                  <span>Details</span>
                </Button>
              </>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Delete run ${stamp}`}
              className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/run:opacity-100 pointer-coarse:opacity-100 hover:text-destructive focus-visible:opacity-100"
              onClick={() => {
                void handleDeleteRun(run.id);
              }}
            >
              <Trash2Icon aria-hidden />
            </Button>
          </div>
        );
      })}
      {openRun !== undefined && (
        <div
          className="flex flex-col gap-2 rounded-md border bg-muted/40 p-3"
          data-testid="open-run-report"
        >
          <div className="flex items-center justify-between gap-2 border-b pb-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-semibold text-xs truncate">
                {openPersona?.name ?? 'Persona'} run
              </span>
              <Badge
                variant={openRun.status === 'failed' ? 'destructive' : 'outline'}
                className="text-[10px]"
              >
                {STATUS_LABELS[openRun.status]}
              </Badge>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {openRun.status === 'failed' && (
                <Button
                  variant="default"
                  size="xs"
                  className="gap-1 h-6 px-2 text-[11px]"
                  data-testid="resume-open-run"
                  onClick={() => {
                    void handleResumeRun(openRun.id);
                  }}
                >
                  <RotateCcwIcon className="size-3" aria-hidden />
                  <span>Resume run</span>
                </Button>
              )}
              <Button
                variant="outline"
                size="xs"
                className="gap-1 h-6 px-2 text-[11px]"
                aria-label="Copy report to clipboard"
                title="Copy report to clipboard"
                onClick={() => {
                  void handleCopy(reportJson);
                }}
              >
                {copied ? (
                  <>
                    <CheckIcon className="size-3 text-green-600" aria-hidden />
                    <span>Copied</span>
                  </>
                ) : (
                  <>
                    <CopyIcon className="size-3" aria-hidden />
                    <span>Copy</span>
                  </>
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Close report"
                title="Close report"
                onClick={() => {
                  setOpenRunId(null);
                }}
              >
                <XIcon className="size-3.5" aria-hidden />
              </Button>
            </div>
          </div>

          {openRun.errorMessage !== '' && (
            <div className="flex flex-col gap-2 rounded border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive">
              <div>
                <span className="font-semibold">Error: </span>
                {openRun.errorMessage}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="xs"
                  className="h-6 gap-1 bg-background text-foreground text-[11px]"
                  data-testid="resume-banner-button"
                  onClick={() => {
                    void handleResumeRun(openRun.id);
                  }}
                >
                  <RotateCcwIcon className="size-3" aria-hidden />
                  Resume from failed step
                </Button>
              </div>
            </div>
          )}

          {openRun.status === 'failed' && <FailedRunDetails run={openRun} />}

          <div className="max-h-[65vh] min-h-[180px] overflow-y-auto overflow-x-auto rounded-md border bg-background p-2.5">
            <pre className="font-mono text-[11px] whitespace-pre-wrap select-text text-foreground">
              {reportJson}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
