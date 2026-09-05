import { useRef } from 'react';
import type { JSX } from 'react';

import type { AnyArtifact, Id, Module } from '@/domain';
import { useModules } from '@/features/modules/hooks';
import { RunBattleButton } from '@/features/play/run-battle';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export interface ModuleBattlePickerProps {
  /** The workspace campaign — the picker lists its modules (live query). */
  campaignId: Id;
  encounter: AnyArtifact & { kind: 'encounter' };
  /** The editor's artifact pool (campaign + module owned) — row context only. */
  campaignArtifacts: readonly AnyArtifact[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Module picker for encounters without their own module (owner-ratified
 * "own-module anchor + picker fallback"): battles still anchor per module
 * (10-MILESTONE-6 D10), the picker only chooses which. Each row renders the
 * module view's own `RunBattleButton`, so the two-step "Replace running
 * battle?" confirm is the one shared implementation — a picked module with a
 * running board asks before replacing, exactly like the entity panel. Zero
 * modules is a named empty state, never a silent no-op.
 */
export function ModuleBattlePicker({
  campaignId,
  encounter,
  campaignArtifacts,
  open,
  onOpenChange,
}: ModuleBattlePickerProps): JSX.Element {
  const modules = useModules(campaignId);
  const listRef = useRef<HTMLDivElement | null>(null);

  /** Arrow-key navigation across the rows' run buttons. */
  function moveFocus(delta: 1 | -1): void {
    const list = listRef.current;
    if (list === null) return;
    const rows = Array.from(
      list.querySelectorAll<HTMLButtonElement>('button[data-testid="run-battle"]'),
    );
    if (rows.length === 0) return;
    const current = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = current === -1 ? 0 : Math.min(rows.length - 1, Math.max(0, current + delta));
    rows[next]?.focus();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="run-battle-module-picker" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Run battle in which module?</DialogTitle>
          <DialogDescription>
            Battles anchor to a module — the picked module’s battle table is seeded with
            “{encounter.name}”.
          </DialogDescription>
        </DialogHeader>
        {modules === undefined ? (
          <p className="text-sm text-muted-foreground" data-testid="run-battle-picker-loading">
            Loading modules…
          </p>
        ) : modules.length === 0 ? (
          <div
            className="rounded-md border border-dashed p-3 text-sm"
            data-testid="run-battle-picker-empty"
          >
            <p className="font-medium">No modules in this campaign yet.</p>
            <p className="mt-1 text-muted-foreground">
              Battles anchor to modules — every battle table belongs to one module’s reader. Create
              or open a module first (top-bar “New Module” or the Modules tab), then run this
              encounter from here or from the module’s entity panel.
            </p>
          </div>
        ) : (
          <div
            ref={listRef}
            className="flex max-h-64 flex-col gap-1.5 overflow-y-auto"
            data-testid="run-battle-module-list"
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                moveFocus(1);
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                moveFocus(-1);
              }
            }}
          >
            {modules.map((module) => (
              <PickerRow
                key={module.id}
                campaignId={campaignId}
                module={module}
                artifactCount={
                  campaignArtifacts.filter((entry) => entry.moduleId === module.id).length
                }
                encounter={encounter}
                onClose={() => {
                  onOpenChange(false);
                }}
              />
            ))}
          </div>
        )}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PickerRow({
  campaignId,
  module,
  artifactCount,
  encounter,
  onClose,
}: {
  campaignId: Id;
  module: Module;
  artifactCount: number;
  encounter: AnyArtifact & { kind: 'encounter' };
  onClose: () => void;
}): JSX.Element {
  return (
    <div
      className="flex items-center justify-between gap-2 rounded-md border p-2"
      data-testid={`run-battle-module-${module.id}`}
    >
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{module.title}</p>
        <p className="text-xs text-muted-foreground">
          {artifactCount} artifact{artifactCount === 1 ? '' : 's'}
        </p>
      </div>
      <RunBattleButton
        campaignId={campaignId}
        moduleId={module.id}
        encounter={encounter}
        onRun={onClose}
      />
    </div>
  );
}
