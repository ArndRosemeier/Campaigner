import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { ArrowDownIcon, ArrowUpIcon, PlayIcon, PlusIcon, RotateCcwIcon, Trash2Icon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { Campaign, Id, ModuleEntityKind, ModuleSpine, PartPlan } from '@/domain';
import { approveSpineAndRun, discardSpine, retrySpine } from '@/llm/moduleGen';
import { toastError, toastSuccess } from '@/lib/toast';

/**
 * Spine approval checkpoint (08-MODULE-DESIGNER M4-B, ALWAYS on): the
 * pass-0 draft (premise + part plan) is fully editable before pass 1 starts.
 * "Generate parts" stores the approved spine and runs pass 1; "Retry spine…"
 * re-runs pass 0 with an optional steering instruction; "Discard" drops the
 * spine back to a draft module. The normalized entity glossary (fix-01) is
 * shown read-only — editing a name there is an ordinary plan edit.
 */

export interface SpineCheckpointProps {
  moduleId: Id;
  campaign: Campaign;
  spine: ModuleSpine;
  busy: boolean;
  /** fix-01: the normalized entity glossary (canonical records). */
  entityKinds: ModuleEntityKind[];
}

export function SpineCheckpoint({
  moduleId,
  campaign,
  spine,
  busy,
  entityKinds,
}: SpineCheckpointProps): JSX.Element {
  const [draft, setDraft] = useState<ModuleSpine>(() => structuredClone(spine));
  const [retryOpen, setRetryOpen] = useState(false);
  const [retryInstruction, setRetryInstruction] = useState('');

  // A spine re-draft ("Retry spine…") replaces the row's spine while this
  // checkpoint stays mounted — resync the editable draft to the new spine.
  useEffect(() => {
    setDraft(structuredClone(spine));
  }, [spine]);

  function patchPlan(index: number, patch: Partial<PartPlan>): void {
    setDraft((previous) => ({
      ...previous,
      partPlan: previous.partPlan.map((plan, i) =>
        i === index ? { ...plan, ...patch } : plan,
      ),
    }));
  }

  function movePlan(index: number, delta: -1 | 1): void {
    setDraft((previous) => {
      const target = index + delta;
      if (target < 0 || target >= previous.partPlan.length) return previous;
      const partPlan = [...previous.partPlan];
      const a = partPlan[index];
      const b = partPlan[target];
      if (a === undefined || b === undefined) return previous;
      partPlan[index] = b;
      partPlan[target] = a;
      return { ...previous, partPlan };
    });
  }

  function removePlan(index: number): void {
    setDraft((previous) => ({
      ...previous,
      partPlan: previous.partPlan.filter((_, i) => i !== index),
    }));
  }

  function addPlan(): void {
    setDraft((previous) => ({
      ...previous,
      partPlan: [
        ...previous.partPlan,
        { title: 'New part', levelBand: '1', synopsis: '', levelUpTrigger: '' },
      ],
    }));
  }

  async function generateParts(): Promise<void> {
    if (draft.partPlan.length === 0) {
      toastError('The part plan is empty — add at least one part');
      return;
    }
    if (draft.partPlan.some((plan) => plan.title.trim() === '')) {
      toastError('Every part needs a title');
      return;
    }
    try {
      await approveSpineAndRun(moduleId, campaign, draft);
      toastSuccess('Parts queued — they appear here as they finish');
    } catch (error) {
      toastError('Could not start part generation', error);
    }
  }

  async function discard(): Promise<void> {
    try {
      await discardSpine(moduleId);
      toastSuccess('Spine discarded — the module is a draft again');
    } catch (error) {
      toastError('Could not discard the spine', error);
    }
  }

  async function retry(): Promise<void> {
    try {
      await retrySpine(moduleId, campaign, retryInstruction.trim());
      setRetryOpen(false);
      setRetryInstruction('');
    } catch (error) {
      toastError('Could not re-run the spine draft', error);
    }
  }

  return (
    <section className="rounded-lg border bg-card p-4" data-testid="spine-checkpoint">
      <h2 className="font-heading text-base font-semibold">Spine — review before writing parts</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Premise and part plan are fully editable. Each part becomes one chapter; parts generate
        sequentially and appear as they finish.
      </p>

      <div className="mt-3 flex flex-col gap-1.5">
        <Label htmlFor="spine-premise">Premise</Label>
        <Textarea
          id="spine-premise"
          rows={6}
          value={draft.premise}
          onChange={(event) => {
            setDraft((previous) => ({ ...previous, premise: event.target.value }));
          }}
        />
        {draft.themes.length > 0 && (
          <p className="text-xs text-muted-foreground">Themes: {draft.themes.join(' · ')}</p>
        )}
        {entityKinds.length > 0 && (
          <p className="text-xs text-muted-foreground" data-testid="spine-entities">
            Entities:{' '}
            {entityKinds
              .map((entity) =>
                entity.absorbed.length > 0
                  ? `${entity.name} (${entity.kind}; also: ${entity.absorbed.join(', ')})`
                  : `${entity.name} (${entity.kind})`,
              )
              .join(' · ')}
          </p>
        )}
      </div>

      <div className="mt-4 flex flex-col gap-2">
        <Label>Part plan</Label>
        {draft.partPlan.map((plan, index) => (
          <div key={index} className="flex flex-col gap-1.5 rounded-md border p-2">
            <div className="flex items-center gap-1.5">
              <Input
                value={plan.title}
                aria-label={`Part ${index + 1} title`}
                className="h-8 flex-1"
                onChange={(event) => {
                  patchPlan(index, { title: event.target.value });
                }}
              />
              <Input
                value={plan.levelBand}
                aria-label={`Part ${index + 1} level band`}
                className="h-8 w-16 text-center"
                onChange={(event) => {
                  patchPlan(index, { levelBand: event.target.value });
                }}
              />
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Move part ${index + 1} up`}
                disabled={index === 0}
                onClick={() => {
                  movePlan(index, -1);
                }}
              >
                <ArrowUpIcon aria-hidden />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Move part ${index + 1} down`}
                disabled={index === draft.partPlan.length - 1}
                onClick={() => {
                  movePlan(index, 1);
                }}
              >
                <ArrowDownIcon aria-hidden />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove part ${index + 1}`}
                className="hover:text-destructive"
                onClick={() => {
                  removePlan(index);
                }}
              >
                <Trash2Icon aria-hidden />
              </Button>
            </div>
            <Textarea
              rows={2}
              placeholder="Synopsis — one paragraph"
              aria-label={`Part ${index + 1} synopsis`}
              value={plan.synopsis}
              onChange={(event) => {
                patchPlan(index, { synopsis: event.target.value });
              }}
            />
            <Input
              placeholder="Level-up trigger — what ends this part"
              aria-label={`Part ${index + 1} level-up trigger`}
              value={plan.levelUpTrigger}
              onChange={(event) => {
                patchPlan(index, { levelUpTrigger: event.target.value });
              }}
            />
          </div>
        ))}
        <Button variant="outline" size="sm" className="self-start" onClick={addPlan}>
          <PlusIcon aria-hidden data-icon="inline-start" />
          Add part
        </Button>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button disabled={busy} onClick={() => void generateParts()} data-testid="generate-parts">
          <PlayIcon aria-hidden data-icon="inline-start" />
          Generate parts
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            setRetryOpen((open) => !open);
          }}
        >
          <RotateCcwIcon aria-hidden data-icon="inline-start" />
          Retry spine…
        </Button>
        <Button variant="ghost" disabled={busy} className="text-destructive" onClick={() => void discard()}>
          Discard
        </Button>
      </div>

      {retryOpen && (
        <div className="mt-3 flex flex-col gap-2 rounded-md border p-2" data-testid="retry-spine">
          <Label htmlFor="retry-instruction">Optional steering instruction</Label>
          <Input
            id="retry-instruction"
            placeholder='e.g. "make the villain a child"'
            value={retryInstruction}
            onChange={(event) => {
              setRetryInstruction(event.target.value);
            }}
          />
          <Button size="sm" className="self-start" disabled={busy} onClick={() => void retry()}>
            Re-run spine draft
          </Button>
        </div>
      )}
    </section>
  );
}
