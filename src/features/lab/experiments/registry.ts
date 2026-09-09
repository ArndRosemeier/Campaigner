import type { ComponentType } from 'react';

import { LabeledDungeonView } from '@/features/lab/LabeledDungeonView';

/**
 * The experiment-lab registry (the reusable part of the lab): one entry per
 * bench — id, title, description, run config, results renderer. The NEXT
 * experiment plugs in here (entry + Body component) without touching the lab
 * shell (`LabPage`), which only ever reads this registry.
 *
 * Lab code imports FROM app seams (image/text generation, settings, toast) —
 * never the reverse: nothing in the creation path may import or depend on
 * lab code.
 */

/** Props the lab shell passes to every experiment body (its run config). */
export interface LabExperimentBodyProps {
  /** Run-button label (the cost note renders alongside it, never hidden). */
  runLabel: string;
  /** Plain cost note rendered on the run button itself. */
  costNote: string;
}
/** One reusable experiment plugged into the lab shell. */
export interface LabExperiment {
  /** Stable id (also the registry key). */
  readonly id: string;
  /** Display title. */
  readonly title: string;
  /** One-paragraph description of what the bench tests. */
  readonly description: string;
  /** Run-button label (the cost note renders alongside it, never hidden). */
  readonly runLabel: string;
  /** Plain cost note rendered on the run button itself. */
  readonly costNote: string;
  /** The experiment body: run control + results renderer. Owns session-only state. */
  readonly Body: ComponentType<LabExperimentBodyProps>;
}

/** The single shipped bench. The next experiment appends one entry here. */
export const LAB_EXPERIMENTS: readonly LabExperiment[] = [
  {
    id: 'labeled-dungeon-maps',
    title: 'Labeled-dungeon vision test',
    description:
      'Generates battlemaps of one interconnected irregular dungeon whose rooms carry letter plaques A–H, then asks the configured chat model to locate each letter. The human eye is the detector: compare the original against the annotated overlay to see how good the vision is.',
    runLabel: 'Run labeled-dungeon bench',
    costNote: 'generates 4 images + 4 vision passes with your configured models',
    Body: LabeledDungeonView,
  },
];

/** Looks up one experiment by id — undefined for unknown ids (loud at the call site). */
export function getLabExperiment(id: string): LabExperiment | undefined {
  return LAB_EXPERIMENTS.find((experiment) => experiment.id === id);
}
