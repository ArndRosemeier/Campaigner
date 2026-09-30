import type { Campaign, Id } from '@/domain';
import { getModule } from '@/db/moduleRepo';
import { runEntityBatch } from '@/features/modules/entity-batch';
import type { StubKind } from '@/features/modules/persona-request';

/**
 * Single-entity detail run (08-MODULE-DESIGNER M4-C): the stub popover's
 * "Generate" details ONE entity in place — same machinery as the entity
 * panel's batch and the module post-generation automation, visible on the
 * shared progress bar (00-OVERVIEW §binding progress). The produced artifact
 * is aligned to the exact link name (wiki-links resolve by name/alias) and
 * tagged `module:<title>`, so the chip resolves via the live query without
 * leaving the reader.
 *
 * F7 (convergence): this USED to be a second live implementation — a
 * one-step chainRunner chain beside the batch's direct runEngine path,
 * duplicating persona resolution, name alignment, the ownership stamp and
 * the failure mapping. chainRunner stays for its real consumer (the
 * Writers' Room's multi-persona chains); the single-entity path now
 * delegates a 1-target `runEntityBatch` invocation: same brief grounding
 * (the batch recomputes `surroundingParagraphs(moduleDocumentText(module),
 * name)` + the spine premise, exactly what the reader passed before), same
 * born-owned placement + tag stamp, same auto autonomy.
 */

export interface GenerateSingleEntityInput {
  campaign: Campaign;
  kind: StubKind;
  /** The exact wiki-link name the artifact must carry. */
  name: string;
  /** The owning module — the produced artifact is OWNED by it (M6-B). */
  moduleId: Id;
}

export type GenerateSingleEntityResult =
  | { ok: true; artifactId: Id }
  | { ok: false; error: Error };

/**
 * Details `name` through the entity batch (one target) and returns the
 * produced artifact. Throws only for setup failures (module vanished); a
 * failed RUN is a `{ ok: false }` result — the run row in the Runs tab
 * carries the error.
 */
export async function generateSingleEntity(
  input: GenerateSingleEntityInput,
): Promise<GenerateSingleEntityResult> {
  const { campaign, kind, name, moduleId } = input;
  const module = await getModule(moduleId);
  if (module === undefined) {
    throw new Error('The module that owns this stub no longer exists');
  }
  const result = await runEntityBatch({
    module,
    campaign,
    kind,
    targets: [{ name }],
  });
  const artifactId = result.produced[0]?.artifactId ?? null;
  if (artifactId === null) {
    const reason = result.failed[0]?.message ?? 'the run produced no artifact';
    return {
      ok: false,
      error: new Error(
        `The run for "${name}" did not complete: ${reason} — see the Runs tab in Workspace for details.`,
      ),
    };
  }
  return { ok: true, artifactId };
}
