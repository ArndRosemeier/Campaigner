import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BanIcon,
  PlayIcon,
  PlusIcon,
  RotateCcwIcon,
  Trash2Icon,
} from 'lucide-react';
import { toastError } from '@/lib/toast';

import { Badge } from '@/components/ui/badge';
import { BlockedControl } from '@/components/blocked-control';
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
import type { Autonomy, Campaign, Id } from '@/domain';
import { chainRunner, type ChainState } from '@/llm/chainRunner';
import { runEngine } from '@/llm/runEngine';
import { listArtifactsByCampaign } from '@/db/artifactRepo';
import { listPersonas } from '@/db/personaRepo';
import { usePinnedChunksStore } from '@/features/rules/pinStore';

const CHAIN_STEP_LABELS: Record<ChainState['steps'][number]['status'], string> = {
  pending: 'pending',
  running: 'running',
  awaiting_user: 'awaiting you',
  needs_review: 'needs review',
  completed: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
};

/**
 * WHY a step-form control cannot act while a chain is in flight (docs/18 §2.3,
 * docs/05 §Why a control cannot act): the `busy` gates below are untouched —
 * these two sentences read the SAME flags that build `busy`, in the same order,
 * so a reason can never disagree with the state it explains. Both name the way
 * out: "Stop chain" renders for exactly that `busy` flag (below), and a paused
 * chain is waiting on a run the user resolves in the Assistant tab — not on a
 * model.
 */
const CHAIN_RUNNING_REASON = 'The chain is running right now — wait for it, or press Stop chain.';
const CHAIN_PAUSED_REASON =
  'The chain is paused on a run that needs you — resolve it in the Assistant tab, or press Stop chain.';

/**
 * The FIRST true condition of `busy` (null = the chain is not holding the
 * form). `chain.status` is the one source: 'running' and 'paused' are the two
 * states `busy` ORs together.
 */
function chainBlockedReason(running: boolean, paused: boolean): string | null {
  if (running) return CHAIN_RUNNING_REASON;
  if (paused) return CHAIN_PAUSED_REASON;
  return null;
}

/**
 * Writers' room (06-MILESTONES M2: persona chaining): an ordered pipeline of
 * personas where every step receives the artifacts of the previous steps as
 * context ("first a location, then the faction that rules it, then the NPC
 * who leads it"). Steps are real runs — they pause for the user exactly like
 * solo runs, and the chain waits.
 */
export function WritersRoom({ campaign }: { campaign: Campaign }): JSX.Element {
  const personas = useLiveQuery(() => listPersonas(), []);
  const pinned = usePinnedChunksStore((state) => state.chunks);
  const [chain, setChain] = useState<ChainState>(chainRunner.getState());
  const [autonomy, setAutonomy] = useState<Autonomy>('auto');
  const [steps, setSteps] = useState<{ personaId: Id; brief: string }[]>([]);

  useEffect(() => chainRunner.on(setChain), []);

  /** Artifact id → name, for naming what each finished step produced. */
  const artifactNames = useLiveQuery(async () => {
    const rows = await listArtifactsByCampaign(campaign.id);
    return new Map(rows.map((row) => [row.id, row.name]));
  }, [campaign.id]);

  function addStep(): void {
    const first = personas?.[0];
    if (first === undefined) return;
    setSteps((previous) => [...previous, { personaId: first.id, brief: '' }]);
  }

  function move(index: number, delta: -1 | 1): void {
    setSteps((previous) => {
      const target = index + delta;
      if (target < 0 || target >= previous.length) return previous;
      const next = [...previous];
      const a = next[index];
      const b = next[target];
      if (a === undefined || b === undefined) return previous;
      next[index] = b;
      next[target] = a;
      return next;
    });
  }

  const busy = chain.status === 'running' || chain.status === 'paused';
  // One computation for every control the `busy` gate holds (docs/18 §2.3): the
  // whole step form goes dead while a chain runs, so each of those controls
  // states this same reason instead of going silently grey.
  const busyReason = chainBlockedReason(chain.status === 'running', chain.status === 'paused');

  return (
    <div className="flex flex-col gap-3 p-3" data-testid="writers-room">
      <p className="text-xs text-muted-foreground">
        Chain personas into a pipeline — each step sees the artifacts of the steps before it.
      </p>

      {steps.map((step, index) => (
        <div key={index} className="flex flex-col gap-1.5 rounded-md border p-2">
          <div className="flex items-center gap-1.5">
            <Badge variant="outline">{index + 1}</Badge>
            {/* The device's `testId` is the wrapper's own hook here: a Base UI
                `Select.Root` renders NO element, so the id cannot live on the
                control itself (the trigger keeps its aria-label). */}
            <BlockedControl
              testId={`writers-room-step-${String(index + 1)}-persona`}
              reason={busyReason}
              className="min-w-0 flex-1"
            >
              <Select
                value={step.personaId}
                items={Object.fromEntries(
                  (personas ?? []).map((persona) => [persona.id, persona.name]),
                )}
                disabled={busy}
                onValueChange={(value) => {
                  if (value === null) return;
                  setSteps((previous) =>
                    previous.map((candidate, i) =>
                      i === index ? { ...candidate, personaId: value } : candidate,
                    ),
                  );
                }}
              >
                <SelectTrigger
                  className="h-7 flex-1 text-xs pointer-coarse:text-base"
                  aria-label={`Step ${index + 1} persona`}
                  data-testid={`writers-room-step-${String(index + 1)}-persona`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(personas ?? []).map((persona) => (
                    <SelectItem key={persona.id} value={persona.id}>
                      {persona.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </BlockedControl>
            {/* `index === 0` is at-an-end and self-evident (pinned in
                tests/features/blocked-reasons-writers-room.test.tsx): the first
                true condition of the gate supplies the reason, so the rung that
                is stated gets it and the rung that is obvious stays bare. */}
            <BlockedControl
              testId={`writers-room-step-${String(index + 1)}-move-up`}
              reason={busyReason}
            >
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Move step ${index + 1} up`}
                data-testid={`writers-room-step-${String(index + 1)}-move-up`}
                disabled={busy || index === 0}
                onClick={() => {
                  move(index, -1);
                }}
              >
                <ArrowUpIcon aria-hidden />
              </Button>
            </BlockedControl>
            <BlockedControl
              testId={`writers-room-step-${String(index + 1)}-move-down`}
              reason={busyReason}
            >
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Move step ${index + 1} down`}
                data-testid={`writers-room-step-${String(index + 1)}-move-down`}
                disabled={busy || index === steps.length - 1}
                onClick={() => {
                  move(index, 1);
                }}
              >
                <ArrowDownIcon aria-hidden />
              </Button>
            </BlockedControl>
            <BlockedControl
              testId={`writers-room-step-${String(index + 1)}-remove`}
              reason={busyReason}
            >
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove step ${index + 1}`}
                data-testid={`writers-room-step-${String(index + 1)}-remove`}
                disabled={busy}
                onClick={() => {
                  setSteps((previous) => previous.filter((_, i) => i !== index));
                }}
              >
                <Trash2Icon aria-hidden />
              </Button>
            </BlockedControl>
          </div>
          <BlockedControl
            testId={`writers-room-step-${String(index + 1)}-brief`}
            reason={busyReason}
          >
            <Input
              value={step.brief}
              placeholder="Brief for this step…"
              className="h-7 text-xs pointer-coarse:text-base"
              aria-label={`Step ${index + 1} brief`}
              data-testid={`writers-room-step-${String(index + 1)}-brief`}
              disabled={busy}
              onChange={(event) => {
                const value = event.target.value;
                setSteps((previous) =>
                  previous.map((candidate, i) =>
                    i === index ? { ...candidate, brief: value } : candidate,
                  ),
                );
              }}
            />
          </BlockedControl>
        </div>
      ))}

      <BlockedControl testId="writers-room-add-step" reason={busyReason} className="self-start">
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          data-testid="writers-room-add-step"
          disabled={busy}
          onClick={addStep}
        >
          <PlusIcon aria-hidden data-icon="inline-start" />
          Add step
        </Button>
      </BlockedControl>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="chain-autonomy">Autonomy</Label>
        <BlockedControl testId="writers-room-autonomy" reason={busyReason}>
          <Select
            value={autonomy}
            disabled={busy}
            onValueChange={(value) => {
              if (value !== null) setAutonomy(value);
            }}
          >
            <SelectTrigger
              className="w-full pointer-coarse:text-base"
              aria-label="Chain autonomy"
              data-testid="writers-room-autonomy"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="manual">Manual</SelectItem>
              <SelectItem value="review">Review</SelectItem>
              <SelectItem value="auto">Auto</SelectItem>
            </SelectContent>
          </Select>
        </BlockedControl>
      </div>

      <div className="flex gap-2">
        {/* The two self-evident halves of this gate (`steps.length === 0`: there
            is nothing to run; `personas === undefined`: the list is still
            loading) get NO wrapper, pinned as such — only the busy rung states
            a reason. */}
        <BlockedControl testId="run-chain" reason={busyReason}>
          <Button
            data-testid="run-chain"
            disabled={busy || steps.length === 0 || personas === undefined}
            onClick={() => {
              const personasById = personas ?? [];
              void chainRunner
                .run(
                  campaign,
                  personasById,
                  steps,
                  autonomy,
                  pinned.map((chunk) => chunk.id),
                )
                .catch((error: unknown) => {
                  toastError('The chain crashed', error);
                });
            }}
          >
            <PlayIcon aria-hidden data-icon="inline-start" />
            Run chain
          </Button>
        </BlockedControl>
        {busy && (
          <Button
            variant="outline"
            onClick={() => {
              chainRunner.cancel();
            }}
          >
            <BanIcon aria-hidden data-icon="inline-start" />
            Stop chain
          </Button>
        )}
      </div>

      {chain.steps.length > 0 && (
        <ol className="flex flex-col gap-1 border-t pt-2" data-testid="chain-progress">
          {chain.steps.map((step, index) => (
            <li key={index} className="flex flex-col gap-0.5 text-xs">
              <div className="flex items-center gap-2">
                <span className="font-medium">{step.title ?? `Step ${index + 1}`}</span>
                <Badge
                  variant={
                    step.status === 'completed'
                      ? 'default'
                      : step.status === 'failed'
                        ? 'destructive'
                        : 'outline'
                  }
                >
                  {CHAIN_STEP_LABELS[step.status]}
                </Badge>
                {step.status === 'completed' && step.artifactId !== null && (
                  <span className="text-muted-foreground" data-testid={`chain-step-artifact-${index + 1}`}>
                    → {artifactNames?.get(step.artifactId) ?? 'artifact'}
                  </span>
                )}
              </div>
              {step.status === 'running' && step.runId !== null && (
                <RunTokenPreview key={step.runId} runId={step.runId} />
              )}
            </li>
          ))}
          {chain.status === 'paused' && (
            <li className="flex items-center gap-2 text-xs text-muted-foreground">
              Chain paused — resolve the current run in the Assistant tab.
              <Button
                variant="outline"
                size="xs"
                data-testid="resume-chain"
                onClick={() => {
                  void chainRunner.resume().catch((error: unknown) => {
                    toastError('Could not resume the chain', error);
                  });
                }}
              >
                <PlayIcon aria-hidden data-icon="inline-start" />
                Resume
              </Button>
            </li>
          )}
          {chain.status === 'failed' && (
            <li className="flex items-center gap-2 text-xs text-muted-foreground">
              Chain failed — completed steps are kept as context.
              <Button
                variant="outline"
                size="xs"
                data-testid="retry-chain"
                onClick={() => {
                  void chainRunner.retry().catch((error: unknown) => {
                    toastError('Could not retry the chain', error);
                  });
                }}
              >
                <RotateCcwIcon aria-hidden data-icon="inline-start" />
                Retry failed step
              </Button>
            </li>
          )}
        </ol>
      )}
    </div>
  );
}

const TOKEN_PREVIEW_CHARS = 400;

/**
 * Live output preview for the currently running chain step: accumulates the
 * streamed tokens of exactly this run (engine events are filtered by runId)
 * and shows the tail while the step is in flight. Never shows stale text
 * from a previous step — the component remounts per runId.
 */
function RunTokenPreview({ runId }: { runId: Id }): JSX.Element {
  const [text, setText] = useState('');

  useEffect(() => {
    setText('');
    return runEngine.on((event) => {
      if (event.runId !== runId) return;
      if (event.kind === 'token') {
        setText((previous) => (previous + event.delta).slice(-TOKEN_PREVIEW_CHARS));
      } else if (event.kind === 'reset') {
        // Model fallback restarted the stream: drop the failed attempt's
        // partial tokens so the preview never stitches two attempts together.
        setText('');
      }
    });
  }, [runId]);

  return (
    <pre
      aria-live="polite"
      data-testid="run-token-preview"
      className="max-h-24 overflow-hidden rounded border bg-muted/40 p-1.5 text-[11px] whitespace-pre-wrap text-muted-foreground"
    >
      {text.trim() === '' ? '…writing' : text}
    </pre>
  );
}
