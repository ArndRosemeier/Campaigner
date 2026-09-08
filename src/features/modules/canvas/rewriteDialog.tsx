import type { JSX } from 'react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
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
import { Switch } from '@/components/ui/switch';
import type { Module } from '@/domain';

/**
 * Per-part "Rewrite…" dialog on the canvas (08-MODULE-DESIGNER §Module
 * canvas): an optional steering instruction plus the opt-in prior-modules
 * toggle, defaulting to the module row's own `includePriorModules` flag (the
 * flag is overridden FOR THIS RUN only — the row is untouched). The prior-
 * modules context itself is the engine's verbatim `priorModulesContext`
 * (caps 4k/8k/24k are load-bearing, 08 §M4-B).
 */
export function RewritePartDialog({
  module,
  target,
  onConfirm,
  onClose,
}: {
  module: Module;
  /** The part to rewrite: plan index + its stable canvas node key. */
  target: { planIndex: number; nodeKey: string };
  onConfirm: (instruction: string, includePriorModules: boolean) => void;
  onClose: () => void;
}): JSX.Element {
  const [instruction, setInstruction] = useState('');
  const [includePriorModules, setIncludePriorModules] = useState(module.includePriorModules);
  const plan = module.spine?.partPlan[target.planIndex];
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent data-testid="canvas-rewrite-dialog">
        <DialogHeader>
          <DialogTitle>Rewrite part {String(target.planIndex + 1)}</DialogTitle>
          <DialogDescription>
            Regenerating replaces this part's markdown — the new text is staged on the
            card for review before you apply or discard it. Optionally steer the rewrite.
          </DialogDescription>
        </DialogHeader>
        {plan !== undefined && (
          <p className="text-xs text-muted-foreground">
            {plan.title} · Levels {plan.levelBand}
          </p>
        )}
        {module.parts.find((part) => part.planIndex === target.planIndex)?.edited === true && (
          <p
            className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm"
            role="alert"
          >
            This part was hand-edited after generation — the rewrite replaces your edits.
          </p>
        )}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="canvas-rewrite-instruction">Optional instruction</Label>
          <Input
            id="canvas-rewrite-instruction"
            placeholder='e.g. "make the villain a child"'
            value={instruction}
            onChange={(event) => {
              setInstruction(event.target.value);
            }}
          />
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id="canvas-rewrite-prior-modules"
            checked={includePriorModules}
            onCheckedChange={setIncludePriorModules}
            aria-label="Include previous modules in the rewrite context"
            data-testid="canvas-rewrite-prior-modules"
          />
          <Label
            htmlFor="canvas-rewrite-prior-modules"
            className="text-xs text-muted-foreground"
          >
            Continue from previous modules (settled history)
          </Label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            data-testid="canvas-rewrite-confirm"
            onClick={() => {
              onConfirm(instruction.trim(), includePriorModules);
            }}
          >
            Rewrite part
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
