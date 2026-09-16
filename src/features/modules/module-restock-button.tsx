import { useState } from 'react';
import type { JSX } from 'react';
import { RefreshCwIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { MODULE_DIFFICULTY_LABELS, resolveModuleDifficulty, type Module } from '@/domain';
import { ModuleBusyError } from '@/llm/moduleGen';
import { restockModuleEncounters } from '@/features/modules/module-restock';
import { toastModuleBusy } from '@/features/modules/module-busy';
import { toastError } from '@/lib/toast';

/**
 * "Restock encounters" — the module-level action (docs/17 row 195), mounted
 * with the module's other actions on BOTH module surfaces (the canvas header
 * and the campaign tree's module group), the ONE-component-several-surfaces
 * precedent `ModulePdfButton`/`ModulePlanButton` set.
 *
 * It DISPLAYS the module's current difficulty read-only BESIDE the button, from
 * the ONE resolver. That is deliberate: this press restocks every encounter AT
 * THAT VALUE, so a button whose behaviour depends on a hidden setting would be
 * a small lie. The value shown is the module row's — the artifact editor's
 * difficulty control (the SAME `ModuleDifficultyControl` the New Module dialog
 * mounts) is the one place it is edited, and a live module query there means
 * this badge follows an edit without a reload.
 *
 * The work itself is `restockModuleEncounters`: sequential, one run at a time,
 * through the existing repopulate seam; it holds the module's generation slot,
 * reports through the progress dock, respects the app's Stop all, and raises
 * the loud named end-of-sweep summary. This component owns only its own
 * `running` state and the two REFUSAL toasts that never reach a run (a vanished
 * module, the module-busy slot).
 */
export function ModuleRestockButton({
  module,
  size = 'xs',
  variant = 'outline',
}: {
  module: Module;
  size?: 'xs' | 'sm';
  variant?: 'outline' | 'ghost';
}): JSX.Element {
  const [running, setRunning] = useState(false);
  const difficulty = resolveModuleDifficulty(module);
  const label = MODULE_DIFFICULTY_LABELS[difficulty];

  async function run(): Promise<void> {
    if (running) return;
    setRunning(true);
    try {
      // The sweep raises its own end-of-sweep summary (success, stop or the
      // loud named failures), so nothing is toasted here on a completed sweep.
      await restockModuleEncounters(module.id);
    } catch (error) {
      if (error instanceof ModuleBusyError) {
        toastModuleBusy(error);
      } else {
        toastError('Could not restock the module — no encounter was restocked', error);
      }
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="flex items-center gap-1.5">
      <Badge
        variant="secondary"
        data-testid="module-restock-difficulty"
        aria-label={`Module difficulty: ${label}`}
      >
        {label}
      </Badge>
      <Button
        variant={variant}
        size={size}
        disabled={running}
        title="Repopulate every encounter in this module at the module's current difficulty — rooms, layout and maps are kept"
        data-testid="module-restock"
        onClick={() => {
          void run();
        }}
      >
        <RefreshCwIcon aria-hidden data-icon="inline-start" />
        {running ? 'Restocking…' : 'Restock encounters'}
      </Button>
    </div>
  );
}
