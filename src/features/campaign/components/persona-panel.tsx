import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  BanIcon,
  CheckIcon,
  CircleDotIcon,
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
import { listArtifactsByCampaign } from '@/db/artifactRepo';
import { getPersona, listPersonas } from '@/db/personaRepo';
import { deleteRun, getRun, listRunsByCampaign } from '@/db/runRepo';
import type { Autonomy, Campaign, PersonaRun } from '@/domain';
import { runEngine } from '@/llm/runEngine';
import { usePinnedChunksStore } from '@/features/rules/pinStore';
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
  const [personaId, setPersonaId] = useState<string>('');
  const [autonomy, setAutonomy] = useState<Autonomy>('manual');
  const [brief, setBrief] = useState('');
  const [targetArtifactId, setTargetArtifactId] = useState<string>('');
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const pinned = usePinnedChunksStore((state) => state.chunks);
  const unpin = usePinnedChunksStore((state) => state.unpin);

  const selectedPersona = personas?.find((persona) => persona.id === personaId);
  const isReview = selectedPersona?.mode === 'review';

  async function start(): Promise<void> {
    if (selectedPersona === undefined) return;
    if (selectedPersona.mode === 'review') {
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
      <Tabs defaultValue="assistant" className="flex h-full flex-col gap-0">
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
                  if (value !== null) setPersonaId(value);
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

            {isReview && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="target-select">Artifact to check</Label>
                <Select
                  value={targetArtifactId}
                  items={Object.fromEntries(
                    (campaignArtifacts ?? []).map((artifact) => [artifact.id, artifact.name]),
                  )}
                  onValueChange={(value) => {
                    if (value !== null) setTargetArtifactId(value);
                  }}
                >
                  <SelectTrigger className="w-full" aria-label="Artifact to check">
                    <SelectValue placeholder="Choose an artifact" />
                  </SelectTrigger>
                  <SelectContent>
                    {(campaignArtifacts ?? []).map((artifact) => (
                      <SelectItem key={artifact.id} value={artifact.id}>
                        {artifact.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Textarea
                  id="brief"
                  rows={2}
                  placeholder="Optional focus, e.g. timeline consistency"
                  value={brief}
                  onChange={(event) => {
                    setBrief(event.target.value);
                  }}
                />
              </div>
            )}

            {!isReview && (
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
                  (isReview ? targetArtifactId === '' : brief.trim() === '')
                }
                onClick={() => void start()}
                data-testid="start-run"
              >
                <PlayIcon aria-hidden data-icon="inline-start" />
                Start
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

        <TabsContent value="runs" className="min-h-0 flex-1">
          <RunsList campaignId={campaign.id} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ActiveRun({ runId, campaign }: { runId: string; campaign: Campaign }): JSX.Element {
  const run = useLiveQuery(() => getRun(runId), [runId]);
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

      <RunActions run={run} campaign={campaign} />
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
        };
  }, [personaRow, campaign, run.autonomy, run.userBrief, run.pinnedChunkIds]);

  if (run.status === 'completed' && run.resultArtifactId !== null) {
    return (
      <Button render={<Link to={artifactPath(run.campaignId, run.resultArtifactId)} />}>
        <SquareArrowOutUpRightIcon aria-hidden data-icon="inline-start" />
        Open artifact
      </Button>
    );
  }
  if (!paused || input === null || step === undefined) return null;

  return (
    <div className="flex flex-col gap-2">
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
                    console.error(error);
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
            <Button
              size="sm"
              onClick={() => {
                void runEngine.approve(run.id, input).catch((error: unknown) => {
                  console.error(error);
                });
              }}
              data-testid="approve-step"
            >
              <CheckIcon aria-hidden data-icon="inline-start" />
              Approve
            </Button>
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
            {run.status === 'needs_review' && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setRetryText((previous) => previous);
                }}
              >
                <RotateCcwIcon aria-hidden data-icon="inline-start" />
                Retry…
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void runEngine.cancel(run.id).catch((error: unknown) => {
                  console.error(error);
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
                    console.error(error);
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
              </span>
              <span className="truncate text-muted-foreground">{run.userBrief}</span>
              <span className="text-muted-foreground">{stamp}</span>
            </button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Delete run ${stamp}`}
              className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/run:opacity-100 hover:text-destructive focus-visible:opacity-100"
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
