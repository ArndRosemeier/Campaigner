import type { JSX } from 'react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  MODULE_DIFFICULTIES,
  MODULE_DIFFICULTY_LABELS,
  type ModuleDifficulty,
} from '@/domain';

/**
 * THE module difficulty control (docs/17 row 190; extracted by row 195):
 * exactly five steps with the middle one normal, labels from the ONE map.
 *
 * It is the ONE place the five steps and their labels are drawn, mounted by
 * BOTH surfaces that choose a difficulty — the New Module dialog's
 * `Advanced — encounter guardrails` disclosure and the artifact editor's
 * encounter section. A second copy of the five steps (or of the labels) is
 * the defect this component exists to prevent, so neither caller maps
 * `MODULE_DIFFICULTIES` itself (AGENTS rule 4; `COPIES: 2→1`).
 *
 * It is deliberately PRESENTATIONAL: it renders the value it is given and
 * reports the pressed step. WHERE the choice is persisted is the caller's
 * question and the two answers genuinely differ — the dialog records it in the
 * New Module draft and stamps it on the module row at creation
 * (`createModuleAndRun`), while the editor writes the owning module row
 * directly through `db/moduleRepo.patchModule`. Both write the SAME
 * `module.difficulty` field through the module repo's own path; the shared
 * thing is the control, not the write.
 *
 * The `value` is always the RESOLVED step (`resolveModuleDifficulty`), so a
 * legacy module with no recorded difficulty renders `Normal` selected — the
 * compatibility reading — instead of a blank or a sixth state.
 */
export function ModuleDifficultyControl({
  value,
  onChange,
  disabled = false,
  testId = 'module-difficulty',
  description,
}: {
  /** The currently effective step (never null — callers resolve it). */
  value: ModuleDifficulty;
  onChange: (difficulty: ModuleDifficulty) => void;
  disabled?: boolean;
  /** The group's DOM id/base for per-step test ids; distinct per surface so
   * two mounts can never answer one query. */
  testId?: string;
  /** Surface-specific help text under the steps. Omitted renders no paragraph. */
  description?: string;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>Module difficulty</Label>
      <div
        className="flex gap-1"
        role="group"
        aria-label="Module difficulty"
        data-testid={testId}
      >
        {MODULE_DIFFICULTIES.map((step) => (
          <Button
            key={step}
            type="button"
            variant={value === step ? 'default' : 'outline'}
            size="sm"
            className="flex-1 px-1 text-xs"
            aria-pressed={value === step}
            disabled={disabled}
            data-testid={`${testId}-${step}`}
            onClick={() => {
              onChange(step);
            }}
          >
            {MODULE_DIFFICULTY_LABELS[step]}
          </Button>
        ))}
      </div>
      {description === undefined ? null : (
        <p className="text-xs text-muted-foreground">{description}</p>
      )}
    </div>
  );
}
