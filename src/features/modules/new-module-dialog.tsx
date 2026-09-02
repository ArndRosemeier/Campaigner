import { useState } from 'react';
import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { MinusIcon, PlusIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { Textarea } from '@/components/ui/textarea';
import type { Campaign, ModuleSizeDial } from '@/domain';
import { MODULE_SIZE_LABELS } from '@/domain';
import { modulePath } from '@/app/routes';
import { listModulesByCampaign } from '@/db/moduleRepo';
import { createModuleAndRun } from '@/llm/moduleGen';
import { toastError } from '@/lib/toast';

/**
 * "New Module" creation dialog (08-MODULE-DESIGNER M4-B): concept, level
 * range (two steppers, max ≥ min), tone, size dial — plus the opt-in
 * cross-module continuity checkbox. Creates the Module row and immediately
 * runs pass 0; the reader then shows the spine-approval checkpoint.
 */

const SIZES: readonly ModuleSizeDial[] = ['sketch', 'standard', 'detailed'];

export interface NewModuleDialogProps {
  campaign: Campaign;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function NewModuleDialog({
  campaign,
  open,
  onOpenChange,
}: NewModuleDialogProps): JSX.Element {
  const navigate = useNavigate();
  const [concept, setConcept] = useState('');
  const [levelMin, setLevelMin] = useState(1);
  const [levelMax, setLevelMax] = useState(3);
  const [tone, setTone] = useState('');
  const [sizeDial, setSizeDial] = useState<ModuleSizeDial>('standard');
  const [includePriorModules, setIncludePriorModules] = useState(false);
  const [starting, setStarting] = useState(false);

  // The opt-in continuity checkbox is only meaningful when some other module
  // of this campaign actually carries authored text (premise or parts).
  const priorModules = useLiveQuery(
    () => listModulesByCampaign(campaign.id),
    [campaign.id],
  );
  const hasPriorText = (priorModules ?? []).some(
    (module) =>
      (module.spine?.premise ?? '') !== '' || module.parts.some((part) => part.markdown !== ''),
  );

  const canStart = concept.trim() !== '' && !starting;

  async function start(): Promise<void> {
    setStarting(true);
    try {
      const moduleId = await createModuleAndRun(campaign, {
        campaignId: campaign.id,
        title: 'New Module',
        concept: concept.trim(),
        levelMin,
        levelMax: Math.max(levelMax, levelMin),
        tone: tone.trim(),
        sizeDial,
        includePriorModules,
      });
      onOpenChange(false);
      navigate(modulePath(campaign.id, moduleId));
    } catch (error) {
      // The module row carries the failure (status failed + errorMessage);
      // still navigate so the user sees it in the reader.
      toastError('The spine draft failed — check the module reader', error);
      onOpenChange(false);
    } finally {
      setStarting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="new-module-dialog">
        <DialogHeader>
          <DialogTitle>New Module</DialogTitle>
          <DialogDescription>
            The spine (premise + part plan) is drafted first and shown for your approval; parts
            are written afterwards, one per level band.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="module-concept">Concept</Label>
            <Textarea
              id="module-concept"
              rows={3}
              placeholder="e.g. 'smugglers' cove gone eldritch — the party raids a smuggling den that has dug into something older.'"
              value={concept}
              onChange={(event) => {
                setConcept(event.target.value);
              }}
            />
          </div>

          <div className="flex items-end gap-3">
            <LevelStepper
              id="module-level-min"
              label="Level from"
              value={levelMin}
              onChange={setLevelMin}
            />
            <LevelStepper
              id="module-level-max"
              label="Level to"
              value={Math.max(levelMax, levelMin)}
              min={levelMin}
              onChange={setLevelMax}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="module-tone">Tone (optional)</Label>
            <Input
              id="module-tone"
              placeholder="e.g. grim, folk-horror, swashbuckling…"
              value={tone}
              onChange={(event) => {
                setTone(event.target.value);
              }}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Size</Label>
            <div className="flex gap-1" role="group" aria-label="Module size">
              {SIZES.map((size) => (
                <Button
                  key={size}
                  type="button"
                  variant={sizeDial === size ? 'default' : 'outline'}
                  size="sm"
                  className="flex-1"
                  aria-pressed={sizeDial === size}
                  onClick={() => {
                    setSizeDial(size);
                  }}
                >
                  {MODULE_SIZE_LABELS[size]}
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Target part length: sketch ≈ 400–700 words, standard ≈ 800–1500, detailed ≈
              1500–2500.
            </p>
          </div>

          <div className="flex items-start gap-2">
            <Checkbox
              id="module-include-prior"
              checked={includePriorModules}
              disabled={!hasPriorText}
              onCheckedChange={(checked) => {
                setIncludePriorModules(checked);
              }}
            />
            <div className="flex flex-col gap-0.5">
              <Label
                htmlFor="module-include-prior"
                className={hasPriorText ? '' : 'text-muted-foreground'}
              >
                Continue from previous modules
              </Label>
              <p className="text-xs text-muted-foreground">
                {hasPriorText
                  ? 'Give the generator the other modules of this campaign — premises and part texts, drafts included — as settled history to continue.'
                  : 'No previous modules with text in this campaign yet.'}
              </p>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => { onOpenChange(false); }}>
            Cancel
          </Button>
          <Button disabled={!canStart} onClick={() => void start()} data-testid="start-module">
            {starting ? 'Drafting spine…' : 'Draft spine'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LevelStepper({
  id,
  label,
  value,
  min = 1,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min?: number;
  onChange: (value: number) => void;
}): JSX.Element {
  function clamp(next: number): number {
    return Math.min(20, Math.max(min, next));
  }
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label={`Decrease ${label}`}
          disabled={value <= min}
          onClick={() => {
            onChange(clamp(value - 1));
          }}
        >
          <MinusIcon aria-hidden />
        </Button>
        <Input
          id={id}
          type="number"
          min={min}
          max={20}
          value={value}
          aria-label={label}
          className="w-16 text-center"
          onChange={(event) => {
            const parsed = Number.parseInt(event.target.value, 10);
            if (!Number.isNaN(parsed)) onChange(clamp(parsed));
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label={`Increase ${label}`}
          disabled={value >= 20}
          onClick={() => {
            onChange(clamp(value + 1));
          }}
        >
          <PlusIcon aria-hidden />
        </Button>
      </div>
    </div>
  );
}
