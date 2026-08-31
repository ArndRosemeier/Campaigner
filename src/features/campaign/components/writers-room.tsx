import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowDownIcon, ArrowUpIcon, BanIcon, PlayIcon, PlusIcon, Trash2Icon } from 'lucide-react';

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
                console.error(error);
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
            <li key={index} className="flex items-center gap-2 text-xs">
              <span className="font-medium">Step {index + 1}</span>
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
                    console.error(error);
                  });
                }}
              >
                <PlayIcon aria-hidden data-icon="inline-start" />
                Resume
              </Button>
            </li>
          )}
        </ol>
      )}
    </div>
  );
}
