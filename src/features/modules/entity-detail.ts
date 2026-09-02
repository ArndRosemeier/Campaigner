import type { Campaign, Id } from '@/domain';
import { artifactRepo } from '@/db';
import { listPersonas } from '@/db/personaRepo';
import { chainRunner } from '@/llm/chainRunner';
import type { ChainStepInput } from '@/llm/chainRunner';
import { runEngine } from '@/llm/runEngine';
import {
  buildEntityBrief,
  STUB_PERSONA_SLUGS,
  type StubKind,
} from '@/features/modules/persona-request';
import { useProgressStore } from '@/lib/progress';

/**
 * Single-entity detail run (08-MODULE-DESIGNER M4-C): the stub popover's
 * "Generate" runs ONE chain step in place — same machinery as the entity
 * panel's batch (chainRunner + runEngine + auto autonomy), visible on the
 * shared progress bar (00-OVERVIEW §binding progress). The produced artifact
 * is aligned to the exact link name (wiki-links resolve by name/alias) and
 * tagged `module:<title>`, so the chip resolves via the live query without
 * leaving the reader.
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

export interface GenerateSingleEntityInput {
  campaign: Campaign;
  kind: StubKind;
  /** The exact wiki-link name the artifact must carry. */
  name: string;
  /** Paragraphs surrounding the name's occurrences in the module text. */
  contextParagraphs: string;
  premise: string;
  /** Tag stamped on the produced artifact, e.g. `module:<title>`. */
  moduleTag: string;
  /** The owning module — the produced artifact is OWNED by it (M6-B). */
  moduleId: Id;
}

export type GenerateSingleEntityResult =
  | { ok: true; artifactId: Id }
  | { ok: false; error: Error };

/**
 * Runs one detail chain for `name` and returns the produced artifact. Throws
 * only for setup failures (no persona, aborted by the user); a failed RUN is
 * a `{ ok: false }` result — the run row in the Runs tab carries the error.
 */
export async function generateSingleEntity(
  input: GenerateSingleEntityInput,
): Promise<GenerateSingleEntityResult> {
  const { campaign, kind, name, contextParagraphs, premise, moduleTag, moduleId } = input;
  const jobId = `module-entity-${campaign.id}-${name}`;
  const progressStart = useProgressStore.getState().start;
  const progressUpdate = useProgressStore.getState().update;
  const progressFinish = useProgressStore.getState().finish;
  progressStart(jobId, `Detailing ${name}`);
  let currentEntry = '';
  let currentRunId: Id | null = null;
  const unsubscribeChain = chainRunner.on((state) => {
    const step = state.steps[state.currentIndex];
    if (state.status === 'running' && step?.status === 'running' && step.runId !== null) {
      currentRunId = step.runId;
      if (step.title !== null) {
        currentEntry = step.title.replace(/^Detail: /u, '');
        progressUpdate(jobId, { detail: `Detailing ${currentEntry}…` });
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
  try {
    const personas = await listPersonas();
    const persona =
      personas.find((candidate) => candidate.slug === STUB_PERSONA_SLUGS[kind]) ??
      personas.find((candidate) => candidate.producesKind === kind);
    if (persona === undefined) {
      throw new Error(`No persona available to detail ${kind}s — check Settings → Personas`);
    }
    const steps: ChainStepInput[] = [
      {
        personaId: persona.id,
        title: `Detail: ${name}`,
        brief: buildEntityBrief(name, contextParagraphs, premise),
        autonomy: 'auto',
      },
    ];
    const result = await chainRunner.run(campaign, personas, steps, 'auto', []);
    const artifactId = result.steps[0]?.artifactId ?? null;
    if (result.status !== 'completed' || artifactId === null) {
      return {
        ok: false,
        error: new Error(
          `The run for "${name}" did not complete — see the Runs tab for the failed run's error.`,
        ),
      };
    }
    await alignEntityName(artifactId, name);
    const artifact = await artifactRepo.getArtifact(artifactId);
    if (artifact !== undefined && (artifact.moduleId !== moduleId || !artifact.tags.includes(moduleTag))) {
      await artifactRepo.updateArtifact(artifactId, {
        moduleId,
        tags: artifact.tags.includes(moduleTag) ? artifact.tags : [...artifact.tags, moduleTag],
      });
    }
    progressUpdate(jobId, { progress: 1 });
    return { ok: true, artifactId };
  } finally {
    unsubscribeChain();
    unsubscribeRun();
    progressFinish(jobId);
  }
}
