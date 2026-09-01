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

  return (
    <div className="flex flex-col gap-3 p-3" data-testid="writers-room">
      <p className="text-xs text-muted-foreground">
        Chain personas into a pipeline — each step sees the artifacts of the steps before it.
      </p>

      {steps.map((step, index) => (
        <div key={index} className="flex flex-col gap-1.5 rounded-md border p-2">
          <div className="flex items-center gap-1.5">
            <Badge variant="outline">{index + 1}</Badge>
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
                className="h-7 flex-1 text-xs"
                aria-label={`Step ${index + 1} persona`}
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
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Move step ${index + 1} up`}
              disabled={busy || index === 0}
              onClick={() => {
                move(index, -1);
              }}
            >
              <ArrowUpIcon aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Move step ${index + 1} down`}
              disabled={busy || index === steps.length - 1}
              onClick={() => {
                move(index, 1);
              }}
            >
              <ArrowDownIcon aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove step ${index + 1}`}
              disabled={busy}
              onClick={() => {
                setSteps((previous) => previous.filter((_, i) => i !== index));
              }}
            >
              <Trash2Icon aria-hidden />
            </Button>
          </div>
          <Input
            value={step.brief}
            placeholder="Brief for this step…"
            className="h-7 text-xs"
            aria-label={`Step ${index + 1} brief`}
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
        </div>
      ))}

      <Button variant="outline" size="sm" className="self-start" disabled={busy} onClick={addStep}>
        <PlusIcon aria-hidden data-icon="inline-start" />
        Add step
      </Button>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="chain-autonomy">Autonomy</Label>
        <Select
          value={autonomy}
          disabled={busy}
          onValueChange={(value) => {
            if (value !== null) setAutonomy(value);
          }}
        >
          <SelectTrigger className="w-full" aria-label="Chain autonomy">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="manual">Manual</SelectItem>
            <SelectItem value="review">Review</SelectItem>
            <SelectItem value="auto">Auto</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex gap-2">
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
      if (event.kind === 'token' && event.runId === runId) {
        setText((previous) => (previous + event.delta).slice(-TOKEN_PREVIEW_CHARS));
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
