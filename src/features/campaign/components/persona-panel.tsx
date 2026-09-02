import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  BanIcon,
  CheckIcon,
  CircleDotIcon,
  MinusIcon,
  PencilIcon,
  PlayIcon,
  RotateCcwIcon,
  SquareArrowOutUpRightIcon,
  Trash2Icon,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toastError, toastSuccess } from '@/lib/toast';
import { Textarea } from '@/components/ui/textarea';
import { HelpButton } from '@/help/HelpButton';
import { ROUTES, artifactPath } from '@/app/routes';
import { getAnyArtifact, listArtifactsByCampaign, listGlobalArtifacts } from '@/db/artifactRepo';
import { getPersona, listPersonas } from '@/db/personaRepo';
import { deleteRun, getRun, listRunsByCampaign } from '@/db/runRepo';
import type { Autonomy, Campaign, EncounterLayout, Id, Persona, PersonaRun } from '@/domain';
import { runEngine } from '@/llm/runEngine';
import { usePinnedChunksStore } from '@/features/rules/pinStore';
import { useIllustrationRequest } from '@/features/campaign/illustrationRequest';
import { useEncounterGenerationRequest } from '@/features/campaign/encounterGenerationRequest';
import { readSettings, updateSettings } from '@/db/settingsRepo';
import { ImageThumb } from '@/features/images/image-thumb';
import { useImageUrl } from '@/features/images/use-image-url';
import { WritersRoom } from '@/features/campaign/components/writers-room';

const AUTONOMY_OPTIONS: { value: Autonomy; label: string }[] = [
  { value: 'manual', label: 'Manual' },
  { value: 'review', label: 'Review' },
  { value: 'auto', label: 'Auto' },
];

const STATUS_LABELS: Record<PersonaRun['status'], string> = {
  running: 'running',
  awaiting_user: 'awaiting you',
  needs_review: 'needs review',
  completed: 'completed',
  cancelled: 'cancelled',
  failed: 'failed',
};

/**
 * Right pane (05-UI.md §Workspace): Assistant tab (persona + brief + run
 * view) and Runs tab (history with read-only step log).
 */
export function PersonaPanel({
  campaign,
  hasApiKey,
}: {
  campaign: Campaign;
  hasApiKey: boolean;
}): JSX.Element {
  const personas = useLiveQuery(() => listPersonas(), []);
  const campaignArtifacts = useLiveQuery(() => listArtifactsByCampaign(campaign.id), [campaign.id]);
  const globalArtifacts = useLiveQuery(() => listGlobalArtifacts(), []);
  const targetArtifacts = useMemo(
    () => [...(campaignArtifacts ?? []), ...(globalArtifacts ?? [])],
    [campaignArtifacts, globalArtifacts],
  );
  const [personaId, setPersonaId] = useState<string>('');
  const [autonomy, setAutonomy] = useState<Autonomy>('manual');
  const [brief, setBrief] = useState('');
  const [targetArtifactId, setTargetArtifactId] = useState<string>('');
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [tab, setTab] = useState<string>('assistant');
  const pinned = usePinnedChunksStore((state) => state.chunks);
  const unpin = usePinnedChunksStore((state) => state.unpin);
  const requestArtifactId = useIllustrationRequest((state) => state.artifactId);
  const requestedAt = useIllustrationRequest((state) => state.requestedAt);
  const clearRequest = useIllustrationRequest((state) => state.clear);
  const encounterRequestId = useEncounterGenerationRequest((state) => state.artifactId);
  const encounterRequestRegenerate = useEncounterGenerationRequest((state) => state.regenerate);
  const encounterRequestedAt = useEncounterGenerationRequest((state) => state.requestedAt);
  const clearEncounterRequest = useEncounterGenerationRequest((state) => state.clear);
  const settings = useLiveQuery(() => readSettings(), []);

  const selectedPersona = personas?.find((persona) => persona.id === personaId);
  const isReview = selectedPersona?.mode === 'review';
  const isImage = selectedPersona?.mode === 'image';
  const isEncounter = selectedPersona?.mode === 'encounter';
  const needsTarget = isReview || isImage;

  // "Illustrate…" from the artifact editor: select the Illustrator persona,
  // target the requesting artifact, and focus the Assistant tab (M3-A).
  useEffect(() => {
    if (requestArtifactId === null) return;
    const illustrator = personas?.find((persona) => persona.slug === 'illustrator');
    if (illustrator === undefined) return; // personas not loaded yet
    setPersonaId(illustrator.id);
    setTargetArtifactId(requestArtifactId);
    setTab('assistant');
    clearRequest();
  }, [requestArtifactId, requestedAt, personas, clearRequest]);

  useEffect(() => {
    if (encounterRequestId === null) return;
    const cartographer = personas?.find((persona) => persona.slug === 'encounter-cartographer');
    if (cartographer === undefined) return;
    setPersonaId(cartographer.id);
    setTargetArtifactId(encounterRequestId);
    // Word the brief truthfully: an encounter without a battlemap is a first
    // generation, not a regeneration — "regenerate" made it sound like a map
    // already existed.
    setBrief(
      encounterRequestRegenerate
        ? 'Regenerate this encounter map while preserving its authored roster and prose.'
        : 'Generate a battlemap and room layout for this encounter.',
    );
    setTab('assistant');
    clearEncounterRequest();
  }, [encounterRequestId, encounterRequestRegenerate, encounterRequestedAt, personas, clearEncounterRequest]);

  async function start(): Promise<void> {
    if (selectedPersona === undefined) return;
    if (selectedPersona.mode === 'encounter') {
      const runId = await runEngine.startRun({
        campaign,
        persona: selectedPersona,
        autonomy,
        brief,
        pinnedChunkIds: pinned.map((chunk) => chunk.id),
        encounterMapAspect: settings?.encounterMapAspect ?? '4:3',
        ...(targetArtifactId === '' ? {} : { targetArtifactId }),
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
                  {isImage ? 'Artifact to illustrate' : 'Artifact to check'}
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
                    aria-label={isImage ? 'Artifact to illustrate' : 'Artifact to check'}
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
                    isImage ? 'Optional image focus, e.g. night scene' : 'Optional focus, e.g. timeline consistency'
                  }
                  value={brief}
                  onChange={(event) => {
                    setBrief(event.target.value);
                  }}
                />
              </div>
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
                {targetArtifactId !== '' && (
                  <p className="text-xs text-amber-600" data-testid="encounter-regenerate-target">
                    Runs against the selected encounter; name, prose, links and roster are
                    preserved, layout and map are replaced.
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
          <RunsList campaignId={campaign.id} />
        </TabsContent>
      </Tabs>
    </div>
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
  const streamRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    setStreamed('');
    return runEngine.on((event) => {
      if (event.runId !== runId || event.kind !== 'token') return;
      setStreamed((previous) => previous + event.delta);
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
            Global
          </Badge>
        )}
        {run.errorMessage !== '' && <span className="text-destructive">{run.errorMessage}</span>}
      </div>

      <ol className="flex flex-col gap-1">
        {run.steps.map((step, index) => (
          <li key={step.index} className="flex items-center gap-2 text-xs">
            <StepIcon status={step.status} />
            <span className={step.status === 'running' ? 'font-medium' : ''}>{step.name}</span>
            {step.status === 'rejected' && <Badge variant="destructive">needs review</Badge>}
            {index === runningIndex && <span className="text-muted-foreground">streaming…</span>}
          </li>
        ))}
      </ol>

      {runningIndex !== -1 && streamed !== '' && (
        <pre
          ref={streamRef}
          className="max-h-40 overflow-y-auto rounded-md bg-muted p-2 font-mono text-[11px] whitespace-pre-wrap"
          data-testid="stream"
        >
          {streamed}
        </pre>
      )}

      {persona?.mode === 'image' ? (
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
      <Button
        render={<Link to={artifactPath(run.campaignId, run.resultArtifactId)} />}
        nativeButton={false}
      >
        <SquareArrowOutUpRightIcon aria-hidden data-icon="inline-start" />
        Open artifact
      </Button>
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
          <Label>Candidates — pick up to 2</Label>
          <div className="flex flex-wrap gap-2">
            {pickCandidates.map((candidateId) => {
              const isSelected = selected.includes(candidateId);
              return (
                <button
                  key={candidateId}
                  type="button"
                  aria-pressed={isSelected}
                  aria-label={`Candidate ${candidateId}`}
                  className={`rounded-md border p-0.5 ${isSelected ? 'border-primary ring-2 ring-primary' : ''}`}
                  onClick={() => {
                    setSelected((previous) =>
                      previous.includes(candidateId)
                        ? previous.filter((id) => id !== candidateId)
                        : previous.length >= 2
                          ? previous
                          : [...previous, candidateId],
                    );
                  }}
                >
                  <ImageThumb imageId={candidateId} alt={`Generated candidate ${candidateId}`} size={72} />
                </button>
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
  const layoutStep = run.steps.find((step) => step.name === 'layout');
  const layoutValue = layoutStep?.userEdit ?? layoutStep?.output;
  const layout =
    layoutValue !== null && layoutValue !== undefined && typeof layoutValue === 'object'
      ? ((layoutValue as { layout?: EncounterLayout }).layout ?? null)
      : null;
  const pick = run.steps.find((step) => step.name === 'pick');
  const candidates =
    ((pick?.output as { candidates?: Id[] } | null | undefined)?.candidates ?? []);
  const verification = run.steps.find((step) => step.name === 'verify')?.output as
    | {
        verifications?: {
          mismatchRatio: number;
          needsReview: boolean;
          mismatchedIndexes: number[];
          expected: { cols: number; rows: number };
        }[];
      }
    | undefined;
  const input = {
    campaign,
    persona,
    autonomy: run.autonomy,
    brief: run.userBrief,
    pinnedChunkIds: run.pinnedChunkIds,
    ...(run.targetArtifactId === null ? {} : { targetArtifactId: run.targetArtifactId }),
    ...(run.encounterMapAspect === null ? {} : { encounterMapAspect: run.encounterMapAspect }),
  };

  if (run.status === 'completed' && run.resultArtifactId !== null) {
    return (
      <Button render={<Link to={artifactPath(run.campaignId, run.resultArtifactId)} />} nativeButton={false}>
        <SquareArrowOutUpRightIcon aria-hidden data-icon="inline-start" />
        Open encounter
      </Button>
    );
  }
  if (run.status === 'failed' || run.status === 'cancelled') return null;

  if (run.status === 'awaiting_user' && pick?.status === 'done') {
    return (
      <div className="flex flex-col gap-2" data-testid="encounter-map-pick">
        {layout !== null && <EncounterLayoutPreview layout={layout} />}
        {verification?.verifications?.map((result, index) => (
          <p key={String(index)} className={result.needsReview ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
            Candidate {String(index + 1)} structure mismatch: {Math.round(result.mismatchRatio * 100)}%
          </p>
        ))}
        <div className="flex flex-wrap gap-2">
          {candidates.map((candidateId, candidateIndex) => (
            <button
              key={candidateId}
              type="button"
              aria-label={`Encounter map candidate ${candidateId}`}
              aria-pressed={selected === candidateId}
              className={`rounded-md border p-1 ${selected === candidateId ? 'border-primary ring-2 ring-primary' : ''}`}
              onClick={() => {
                setSelected(candidateId);
              }}
            >
              {layout === null ? (
                <ImageThumb imageId={candidateId} alt="Generated battlemap candidate" size={120} />
              ) : (
                <EncounterMapCandidate
                  imageId={candidateId}
                  layout={layout}
                  {...(verification?.verifications?.[candidateIndex] === undefined
                    ? {}
                    : { verification: verification.verifications[candidateIndex] })}
                />
              )}
            </button>
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
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-testid="encounter-run-actions">
      {layout !== null && <EncounterLayoutPreview layout={layout} />}
      {run.status === 'awaiting_user' && layoutStep?.status === 'done' && (
        <Button
          variant="outline"
          size="sm"
          data-testid="regenerate-layout"
          onClick={() => {
            void runEngine.regenerateEncounterLayout(run.id, input).catch((error: unknown) => {
              toastError('Could not regenerate the layout', error);
            });
          }}
        >
          <RotateCcwIcon aria-hidden data-icon="inline-start" />
          Regenerate layout
        </Button>
      )}
      <RunActions run={run} campaign={campaign} />
    </div>
  );
}

function EncounterMapCandidate({
  imageId,
  layout,
  verification,
}: {
  imageId: Id;
  layout: EncounterLayout;
  verification?: {
    mismatchedIndexes: number[];
    expected: { cols: number; rows: number };
  };
}): JSX.Element {
  const url = useImageUrl(imageId);
  return (
    <div
      className="relative w-48 overflow-hidden rounded"
      style={{ aspectRatio: `${String(layout.gridW)} / ${String(layout.gridH)}` }}
    >
      {url !== null && <img src={url} alt="Generated battlemap candidate" className="absolute inset-0 size-full object-fill" />}
      <EncounterLayoutPreview layout={layout} overlay />
      {verification?.mismatchedIndexes.map((index) => {
        const column = index % verification.expected.cols;
        const row = Math.floor(index / verification.expected.cols);
        return (
          <span
            key={String(index)}
            className="pointer-events-none absolute bg-destructive/45"
            style={{
              left: `${String((column / verification.expected.cols) * 100)}%`,
              top: `${String((row / verification.expected.rows) * 100)}%`,
              width: `${String(100 / verification.expected.cols)}%`,
              height: `${String(100 / verification.expected.rows)}%`,
            }}
            data-testid="vision-diff-cell"
          />
        );
      })}
    </div>
  );
}

function EncounterLayoutPreview({
  layout,
  overlay = false,
}: {
  layout: EncounterLayout;
  overlay?: boolean;
}): JSX.Element {
  return (
    <div
      className={
        overlay
          ? 'pointer-events-none absolute inset-0 overflow-hidden'
          : 'relative w-full overflow-hidden rounded-md border bg-muted'
      }
      style={{ aspectRatio: `${String(layout.gridW)} / ${String(layout.gridH)}` }}
      data-testid="encounter-layout-preview"
    >
      {layout.rooms.flatMap((room) =>
        room.rects.map((rect, index) => (
          <div
            key={`${room.id}-${String(index)}`}
            className="absolute border border-primary/70 bg-primary/10"
            style={{
              left: `${String((rect.x / layout.gridW) * 100)}%`,
              top: `${String((rect.y / layout.gridH) * 100)}%`,
              width: `${String((rect.w / layout.gridW) * 100)}%`,
              height: `${String((rect.h / layout.gridH) * 100)}%`,
            }}
            title={room.name}
          >
            {index === 0 && (
              <span className="block truncate bg-background/70 px-0.5 text-[9px]">{room.name}</span>
            )}
          </div>
        )),
      )}
      {layout.rooms.map((room) => (
        <div
          key={`${room.id}-mobs`}
          className="pointer-events-none absolute border border-dashed border-destructive/80 bg-destructive/10"
          style={{
            left: `${String((room.mobsRect.x / layout.gridW) * 100)}%`,
            top: `${String((room.mobsRect.y / layout.gridH) * 100)}%`,
            width: `${String((room.mobsRect.w / layout.gridW) * 100)}%`,
            height: `${String((room.mobsRect.h / layout.gridH) * 100)}%`,
          }}
          title={`${room.name} mob area`}
        />
      ))}
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
        };
  }, [
    personaRow,
    campaign,
    run.autonomy,
    run.userBrief,
    run.pinnedChunkIds,
    run.targetArtifactId,
    run.encounterMapAspect,
  ]);

  if (run.status === 'completed' && run.resultArtifactId !== null) {
    return (
      <Button
        render={<Link to={artifactPath(run.campaignId, run.resultArtifactId)} />}
        nativeButton={false}
      >
        <SquareArrowOutUpRightIcon aria-hidden data-icon="inline-start" />
        Open artifact
      </Button>
    );
  }
  if (!paused || input === null || step === undefined) return null;
  // Rejected LLM output has no validated payload and cannot safely advance.
  // Encounter verify is the exception: rejection there means a valid map
  // exceeded the drift threshold and the user may deliberately continue.
  const canApprove =
    step.status !== 'rejected' || (personaRow?.mode === 'encounter' && step.name === 'verify');

  return (
    <div className="flex flex-col gap-2">
      {!canApprove && (
        <p className="text-xs text-destructive">
          This step did not produce valid data. Retry it, or edit the JSON before continuing.
        </p>
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

function RunsList({ campaignId }: { campaignId: string }): JSX.Element {
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

  async function handleDeleteRun(id: string): Promise<void> {
    if (openRunId === id) setOpenRunId(null);
    try {
      await deleteRun(id);
      toastSuccess('Run deleted');
    } catch (error) {
      toastError('Could not delete run', error);
    }
  }

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
                {run.targetArtifactId !== null && globalIds?.has(run.targetArtifactId) === true && (
                  <Badge variant="outline">Global</Badge>
                )}
              </span>
              <span className="truncate text-muted-foreground">{run.userBrief}</span>
              <span className="text-muted-foreground">{stamp}</span>
            </button>
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
        <ScrollArea className="max-h-64">
          <pre className="rounded-md bg-muted p-2 font-mono text-[11px] whitespace-pre-wrap">
            {JSON.stringify(openRun.steps, null, 2)}
          </pre>
        </ScrollArea>
      )}
    </div>
  );
}
