import type { PersonaRun } from '@/domain';
import type { EntityBatchResult } from '@/features/modules/entity-batch';

/**
 * The entity lane's two most-repeated TEST fixtures, folded into ONE seam
 * (docs/17 row 247, AGENTS §Centralization obligation 2). Both were named as
 * fold candidates by the duplication tripwire's own inventory
 * (`tests/architecture/duplicateImplementationsTestsBaseline.json`, the
 * `completedWith` and `produced` entries), and this slice had to touch BOTH
 * copies anyway: the batch now reports what the run did to the entity's STAT
 * BLOCK off the run's own `statblock` step (docs/17 row 247), so a completed
 * run row carries `steps` and a produced entity carries `statBlock`.
 *
 * Folding rather than blessing: the two baselined entries are DELETED with the
 * copies, which is the only direction a baseline edit may take
 * (`docs/17` row 247 and the AGENTS §Workflow field discipline).
 */

/**
 * A COMPLETED run row for the entity lane, as `runEngine.waitForRunStatus`
 * returns it: `steps` is part of every real run row, and an empty list is the
 * honest "this fake's run recorded no step outcomes".
 */
export function completedRunWith(artifactId: string): PersonaRun {
  return {
    status: 'completed',
    resultArtifactId: artifactId,
    errorMessage: '',
    steps: [],
  } as unknown as PersonaRun;
}

/**
 * A successful `runEntityBatch` result for one entity. The entity lane
 * RE-AUTHORS the row's stat block on the change path, and the seam carries that
 * fact to the chat (docs/17 row 247) — `statBlock: 'regenerated'` is what the
 * engine's own `statblock` step reports when it completed.
 */
export function producedEntityResult(name: string, artifactId: string): EntityBatchResult {
  return {
    generated: [name],
    cast: [],
    produced: [{ name, artifactId, statBlock: 'regenerated' }],
    failed: [],
    // No cast fallback happened in this fixture (docs/17 row 302): the entity
    // was produced by a persona run, so the notices list is empty.
    notices: [],
  };
}
