import type { Campaign, Id, Module } from '@/domain';
import { moduleDocumentText, moduleTagFor } from '@/domain';
import { artifactRepo } from '@/db';
import { listPersonas } from '@/db/personaRepo';
import { getSettings } from '@/db/settingsRepo';
import { runEngine, waitForRunStatus, type StartRunInput } from '@/llm/runEngine';
import { errorMessage } from '@/lib/errors';
import {
  buildEntityBrief,
  STUB_PERSONA_SLUGS,
  type StubKind,
} from '@/features/modules/persona-request';
import { surroundingParagraphs } from '@/lib/wikilinks';
import { mapWithConcurrency } from '@/lib/parallel';
import { toastError } from '@/lib/toast';
import { useProgressStore } from '@/lib/progress';

/**
 * Headless entity batch (08-MODULE-DESIGNER M4-C): details a list of entity
 * names with one persona in `auto` autonomy — the engine behind the
 * entity panel's "Generate all unresolved of kind…", the module
 * post-generation automation (which runs the same path unattended after the
 * parts land), AND the stub popover's single "Generate" (F7: one live
 * "detail one entity" implementation instead of two — the popover delegates
 * a 1-target batch through `generateSingleEntity`).
 *
 * Parallelization (optimization feature): entities are independent — each
 * brief is grounded in the module text alone, not in the other entities —
 * so up to `maxParallelRequests` entity runs execute at once. Each entity
 * is still a real PersonaRun visible in the Runs tab; only the incidental
 * "earlier entities as extra retrieval context" coupling of the old
 * sequential chain is dropped.
 *
 * Failure semantics (08 §M4-C / AGENTS rule 2): a failed RUN does not stop
 * the batch — the other runs finish, and every entity without a produced
 * artifact is reported loudly (toast + the failed runs in the Runs tab).
 * Progress rides the shared dock (`module-entities-<moduleId>-<kind>`).
 */

/** Humanized run-step names for the progress detail line. */
export const RUN_STEP_LABELS: Record<string, string> = {
  retrieve: 'gathering context',
  draft: 'drafting',
  statblock: 'building the statblock',
  finalize: 'writing the artifact',
  gather: 'gathering sources',
  check: 'checking',
};

/**
 * Renames the produced artifact to the EXACT entity name (wiki-links resolve
 * by name/alias), keeping the model's invented name as an alias so nothing
 * authored is lost.
 */
export async function alignEntityName(artifactId: Id, entityName: string): Promise<void> {
  const artifact = await artifactRepo.getArtifact(artifactId);
  if (artifact === undefined) return;
  if (artifact.name.trim().toLowerCase() === entityName.trim().toLowerCase()) return;
  const modelName = artifact.name;
  const aliases = artifact.aliases.some(
    (alias) => alias.trim().toLowerCase() === modelName.trim().toLowerCase(),
  )
    ? artifact.aliases
    : [...artifact.aliases, modelName];
  await artifactRepo.updateArtifact(artifactId, { name: entityName, aliases });
}

/** Plural bucket label for the progress bar ("Generating 3 npcs"). */
export const KIND_PLURALS: Record<StubKind, string> = {
  npc: 'npcs',
  location: 'locations',
  event: 'events',
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

/** One entity whose run produced no artifact, with the reason. */
export interface EntityBatchFailure {
  /** The entity (wiki-link target) the failed run belonged to. */
  name: string;
  /** The run's errorMessage, the thrown setup error's message, or the
   * terminal status when the engine recorded neither. */
  message: string;
}

export interface EntityBatchProduced {
  /** The entity (wiki-link target) the run belonged to. */
  name: string;
  /** The produced artifact's id (name-aligned, module-owned + tagged). */
  artifactId: Id;
}

export interface EntityBatchResult {
  /** Names whose chain step completed (artifact produced + aligned). */
  generated: string[];
  /** The produced artifacts, name-matched — callers that need the artifact
   * itself (the stub popover returns the artifactId) without re-resolving
   * the wiki link. */
  produced: EntityBatchProduced[];
  /** Entities that produced no artifact, with the reason — loud in the
   * toast and the Runs tab (AGENTS rule 2). */
  failed: EntityBatchFailure[];
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
  const generated: string[] = [];
  const produced: EntityBatchProduced[] = [];
  const failed: EntityBatchFailure[] = [];
  // In-flight entities for the dock detail: name → current run step label.
  const inFlight = new Map<string, string | null>();
  let completed = 0;
  const updateDetail = (): void => {
    const parts = [...inFlight.entries()].slice(0, 3).map(([name, label]) =>
      `"${name}"${label === null ? '' : ` — ${label}`}`,
    );
    progressUpdate(jobId, {
      detail: parts.length === 0 ? 'Wrapping up…' : `Generating ${parts.join(' · ')}`,
      progress: completed / total,
    });
  };
  // Live step labels for the dock detail ("Kael — drafting…"), per run.
  const runNames = new Map<Id, string>();
  const unsubscribeRun = runEngine.on((event) => {
    if (event.kind !== 'step') return;
    const name = runNames.get(event.runId);
    if (name === undefined || !inFlight.has(name)) return;
    inFlight.set(
      name,
      event.stepName === undefined ? null : RUN_STEP_LABELS[event.stepName] ?? event.stepName,
    );
    updateDetail();
  });
  const producedIds: Id[] = [];
  try {
    const personas = await listPersonas();
    const persona =
      personas.find((candidate) => candidate.slug === STUB_PERSONA_SLUGS[kind]) ??
      personas.find((candidate) => candidate.producesKind === kind);
    if (persona === undefined) {
      throw new Error(`No persona available to detail ${kind}s — check Settings → Personas`);
    }
    const settings = await getSettings();
    const limit = Math.max(1, settings.maxParallelRequests);

    await mapWithConcurrency(targets, limit, async (target) => {
      inFlight.set(target.name, null);
      updateDetail();
      try {
        // The brief stands alone per entity: module text around the wiki-link
        // plus the spine premise — no dependency on sibling entities.
        const brief = buildEntityBrief(
          target.name,
          surroundingParagraphs(moduleText, target.name),
          module.spine?.premise ?? '',
        );
        const runInput: StartRunInput = {
          campaign,
          persona,
          autonomy: 'auto' as const,
          brief,
          pinnedChunkIds: [],
          // The batch's artifacts are module-owned FROM BIRTH (not stamped
          // after the run): the post-run automatic battlemap reads the
          // encounter's own moduleId to apply the module's master switch,
          // and wiki-links resolve against the module during the run. The
          // tag stamp below stays for the module:tag compatibility marker.
          placementModuleId: module.id,
        };
        const runId = await runEngine.startRun(runInput);
        runNames.set(runId, target.name);
        const outcome = await waitForRunStatus(runId);
        if (outcome.status === 'completed' && outcome.resultArtifactId !== null) {
          producedIds.push(outcome.resultArtifactId);
          generated.push(target.name);
          produced.push({ name: target.name, artifactId: outcome.resultArtifactId });
          try {
            // The wiki-link resolves by EXACT name, so an artifact the model
            // named "Kael Ashbound…" would never link back to [[Kael]] —
            // enforce the entity name and keep the model's name as an alias.
            await alignEntityName(outcome.resultArtifactId, target.name);
          } catch (error) {
            toastError(`Could not align the artifact name for "${target.name}"`, error);
          }
        } else {
          // Loud per-entity reason (AGENTS rule 2): the run's own
          // errorMessage when the engine recorded one, the terminal status
          // otherwise; a completed run without an artifact is its own
          // anomaly and says so.
          failed.push({
            name: target.name,
            message:
              outcome.status !== 'completed'
                ? outcome.errorMessage !== ''
                  ? outcome.errorMessage
                  : `run ended ${outcome.status}`
                : 'the run completed without producing an artifact',
          });
        }
      } catch (error) {
        // Setup failure for this entity (e.g. key missing): recorded as a
        // failure with its reason — the batch continues with the others.
        failed.push({ name: target.name, message: errorMessage(error) });
      } finally {
        inFlight.delete(target.name);
        completed += 1;
        updateDetail();
      }
    });

    // Stamp the compatibility tag (the artifacts are already module-owned
    // from birth via placementModuleId — this is idempotent for both).
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
    // Stable order: the input target order, not completion order.
    const failureByName = new Map(failed.map((failure) => [failure.name, failure]));
    const producedByName = new Map(produced.map((entry) => [entry.name, entry]));
    return {
      generated,
      produced: targets.flatMap((target) => {
        const entry = producedByName.get(target.name);
        return entry === undefined ? [] : [entry];
      }),
      failed: targets.flatMap((target) => {
        const failure = failureByName.get(target.name);
        return failure === undefined ? [] : [failure];
      }),
    };
  } finally {
    unsubscribeRun();
    progressFinish(jobId);
  }
}


