import { describe, expect, it } from 'vitest';

import { filesWith } from '../helpers/sourceCode';

/**
 * ONE DELETE-AFTER-REPLACE ENTRY PER IDEA (docs/17 row 422, AGENTS rule 4).
 *
 * Two ideas were written more than once when the generation dialog's overwrite
 * needed them a third time, and both were folded:
 *
 * 1. THE STALE-JOB UPGRADE — "withdraw every queued or in-flight job holding
 *    this key, then enqueue the replacement" — was hand-spelled in the cover
 *    queue AND the mob-portrait queue (each with its own key formula), and the
 *    entity-image and battlemap queues would have made four. It is now the job
 *    queue factory's `enqueueReplacing`, keyed by the queue's OWN `key`.
 * 2. THE ENCOUNTER REPLACE-ALL — both portrait lanes, cited then invented — was
 *    composed inline by the encounter editor; the overwrite run would have been
 *    a second composition. It is now `regenerateEncounterPortraits`, the regen
 *    twin of `enqueueEncounterPortraitFill`.
 *
 * Source pins, two-sided: each needle is shown to exist where it belongs, so a
 * rename cannot make the scan vacuous.
 */
describe('the stale-job upgrade lives in the job queue factory only', () => {
  it('scans queued + active for a key in exactly one file', () => {
    // The idiom every hand-rolled copy spelled: a filter over the queue's
    // queued-plus-active population.
    expect(filesWith('.active].filter(')).toEqual(['src/lib/jobQueue.ts']);
    expect(filesWith('enqueueReplacing: (jobs) =>')).toEqual(['src/lib/jobQueue.ts']);
  });

  it('every replace path goes through it', () => {
    expect(filesWith('.enqueueReplacing(')).toEqual([
      'src/features/campaign/mob-portrait-queue.ts',
      'src/features/covers/cover-image-queue.ts',
      'src/features/modules/generation-run.ts',
    ]);
  });
});

describe('the encounter portrait replace-all is one seam', () => {
  it('only the queue module composes the cited regen lane', () => {
    expect(filesWith('export async function regenerateEncounterPortraits')).toEqual([
      'src/features/campaign/mob-portrait-queue.ts',
    ]);
    // The cited lane is called by nobody outside its own module: the editor and
    // the overwrite run both go through the combined seam.
    expect(filesWith('regenerateMobPortraits(')).toEqual([
      'src/features/campaign/mob-portrait-queue.ts',
    ]);
    expect(filesWith('regenerateEncounterPortraits(')).toEqual([
      'src/features/campaign/components/mob-portraits-section.tsx',
      'src/features/campaign/mob-portrait-queue.ts',
      'src/features/modules/generation-run.ts',
    ]);
  });
});
