import type { Campaign, Id, Module } from '@/domain';
import { moduleTagFor } from '@/domain';
import { artifactRepo } from '@/db';
import { listPersonas } from '@/db/personaRepo';
import { chainRunner } from '@/llm/chainRunner';
import type { ChainStepInput } from '@/llm/chainRunner';
import { runEngine } from '@/llm/runEngine';
import { alignEntityName, RUN_STEP_LABELS } from '@/features/modules/entity-detail';
import {
  buildEntityBrief,
  STUB_PERSONA_SLUGS,
  type StubKind,
} from '@/features/modules/persona-request';
import { surroundingParagraphs } from '@/lib/wikilinks';
import { toastError } from '@/lib/toast';
import { useProgressStore } from '@/lib/progress';

/**
 * Headless entity batch (08-MODULE-DESIGNER M4-C): details a list of entity
 * names with one persona chain in `auto` autonomy — the engine behind the
 * entity panel's "Generate all unresolved of kind…" AND the module
 * post-generation automation (which runs the same path unattended after the
 * parts land).
 *
 * Failure semantics (08 §M4-C / AGENTS rule 2): a failed RUN does not stop
 * the batch — the chain skips past it and the remaining names are retried in
 * a fresh chain; every entity without a produced artifact is reported loudly
 * (toast + the failed runs in the Runs tab). Progress rides the shared dock
 * (`module-entities-<moduleId>-<kind>`).
 */

/** Plural bucket label for the progress bar ("Generating 3 npcs"). */
export const KIND_PLURALS: Record<StubKind, string> = {
  npc: 'npcs',
  location: 'locations',
  faction: 'factions',
  note: 'notes',
  encounter: 'encounters',
};

export interface EntityBatchTarget {
  /** The exact wiki-link name the produced artifact must carry. */
  name: string;
}

export interface RunEntityBatchInput {
  module: Module;
  campaign: Campaign;
  kind: StubKind;
  targets: readonly EntityBatchTarget[];
}

export interface EntityBatchResult {
  /** Names whose chain step completed (artifact produced + aligned). */
  generated: string[];
  /** Names that produced no artifact — loud in the toast and Runs tab. */
  failed: string[];
}

/** The full module text (premise + parts, plan order) for brief context. */
export function moduleDocumentText(module: Module): string {
  return [
    module.spine?.premise ?? '',
    ...module.parts
      .slice()
      .sort((a, b) => a.planIndex - b.planIndex)
      .map((part) => part.markdown),
  ].join('\n\n');
}

/**
 * Runs one batch. Throws only on setup failures (no persona); run failures
 * are collected into `failed` — the caller decides how loudly to surface
 * them (the panel toasts per batch; the automation aggregates per module).
 */
export async function runEntityBatch(input: RunEntityBatchInput): Promise<EntityBatchResult> {
  const { module, campaign, kind, targets } = input;
  const moduleTag = moduleTagFor(module.title);
  const moduleText = moduleDocumentText(module);
  const jobId = `module-entities-${module.id}-${kind}`;
  const total = targets.length;
  const progressStart = useProgressStore.getState().start;
  const progressUpdate = useProgressStore.getState().update;
  const progressFinish = useProgressStore.getState().finish;
  progressStart(jobId, `Generating ${String(total)} ${KIND_PLURALS[kind]}`);
  // Live detail for the dock: the chain runner names the entity currently
  // being detailed, the run engine names the step inside it ("drafting") —
  // multi-minute work must never look like a hang (00-OVERVIEW).
  let currentEntry = '';
  let currentRunId: Id | null = null;
  // Targets finished across chain invocations (the loop re-chains past
  // failed steps) — keeps the bar monotonic.
  let completed = 0;
  const unsubscribeChain = chainRunner.on((state) => {
    const step = state.steps[state.currentIndex];
    if (state.status === 'running' && step?.status === 'running' && step.runId !== null) {
      currentRunId = step.runId;
      if (step.title !== null) {
        currentEntry = step.title.replace(/^Detail: /u, '');
        progressUpdate(jobId, {
          detail: `Generating ${currentEntry}…`,
          progress: (completed + state.currentIndex) / total,
        });
      }
    }
  });
  const unsubscribeRun = runEngine.on((event) => {
    if (event.kind !== 'step' || event.runId !== currentRunId) return;
    if (event.status === 'running' && event.stepName !== undefined) {
      const label = RUN_STEP_LABELS[event.stepName] ?? event.stepName;
      progressUpdate(jobId, { detail: `${currentEntry} — ${label}…` });
    }
  });
  const generated: string[] = [];
  try {
    const personas = await listPersonas();
    const persona =
      personas.find((candidate) => candidate.slug === STUB_PERSONA_SLUGS[kind]) ??
      personas.find((candidate) => candidate.producesKind === kind);
    if (persona === undefined) {
      throw new Error(`No persona available to detail ${kind}s — check Settings → Personas`);
    }
    let remaining: EntityBatchTarget[] = [...targets];
    const producedIds: Id[] = [];
    // One chain over all targets; chain semantics keep completed steps and
    // show failed runs in the Runs tab. On a failed step the batch
    // CONTINUES with the remaining names (fresh chain).
    while (remaining.length > 0) {
      const steps: ChainStepInput[] = remaining.map((entry) => ({
        personaId: persona.id,
        title: `Detail: ${entry.name}`,
        brief: buildEntityBrief(
          entry.name,
          surroundingParagraphs(moduleText, entry.name),
          module.spine?.premise ?? '',
        ),
        autonomy: 'auto' as const,
      }));
      const result = await chainRunner.run(campaign, personas, steps, 'auto', []);
      // Align produced artifacts with their entity (index-parallel): the
      // wiki-link resolves by EXACT name, so an artifact the model named
      // "Kael Ashbound…" would never link back to [[Kael]] — enforce the
      // entity name and keep the model's name as an alias.
      for (const [index, step] of result.steps.entries()) {
        const entry = remaining[index];
        if (entry === undefined) continue;
        if (step.status === 'completed' && step.artifactId !== null) {
          producedIds.push(step.artifactId);
          generated.push(entry.name);
          try {
            await alignEntityName(step.artifactId, entry.name);
          } catch (error) {
            toastError(`Could not align the artifact name for "${entry.name}"`, error);
          }
        }
        // Non-completed steps are NOT counted as failures here: the chain
        // stops at the first failure and reports the not-yet-run steps as
        // 'pending' — counting them double-counted every retry round ("12
        // of 9 failed"). Real failures are computed after the loop.
      }
      completed += result.steps.filter((step) => step.status === 'completed').length;
      progressUpdate(jobId, { progress: completed / total });
      const failedIndex = result.steps.findIndex((step) => step.status === 'failed');
      if (result.status === 'completed') break;
      if (result.status === 'cancelled') break;
      if (failedIndex === -1) break;
      // Skip everything up to and including the failed step, keep going.
      remaining = remaining.slice(failedIndex + 1);
    }
    // Stamp the produced artifacts with their owning module (M6-B) and
    // the compatibility tag.
    for (const artifactId of producedIds) {
      try {
        const artifact = await artifactRepo.getArtifact(artifactId);
        if (artifact !== undefined && (artifact.moduleId !== module.id || !artifact.tags.includes(moduleTag))) {
          await artifactRepo.stampModuleOwnership(artifactId, module.id, moduleTag);
        }
      } catch (error) {
        toastError('Could not scope a produced artifact', error);
      }
    }
    return {
      generated,
      failed: targets.filter((target) => !generated.includes(target.name)).map((target) => target.name),
    };
  } finally {
    unsubscribeChain();
    unsubscribeRun();
    progressFinish(jobId);
  }
}
