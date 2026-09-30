import { beforeEach, describe, expect, it } from 'vitest';

import { useProgressStore } from '@/lib/progress';

/**
 * Shared progress seam (00-OVERVIEW): jobs start/update/finish, progress is
 * clamped 0..1, unknown-length tasks stay indeterminate (progress null), and
 * updates after finish never resurrect a job.
 */

function jobs(): ReturnType<typeof useProgressStore.getState>['jobs'] {
  return useProgressStore.getState().jobs;
}

describe('progress store', () => {
  beforeEach(() => {
    useProgressStore.getState().reset();
  });

  it('starts a job with an indeterminate bar and empty detail', () => {
    useProgressStore.getState().start('job-1', 'Generating 3 npcs');

    expect(jobs()).toEqual([
      { id: 'job-1', label: 'Generating 3 npcs', detail: '', progress: null },
    ]);
  });

  it('updates detail and clamps progress into 0..1', () => {
    useProgressStore.getState().start('job-1', 'Generating 2 npcs');
    useProgressStore.getState().update('job-1', { detail: 'Mira — drafting…', progress: 0.5 });
    expect(jobs()[0]).toMatchObject({ detail: 'Mira — drafting…', progress: 0.5 });

    useProgressStore.getState().update('job-1', { progress: 5 });
    expect(jobs()[0]?.progress).toBe(1);
    useProgressStore.getState().update('job-1', { progress: -2 });
    expect(jobs()[0]?.progress).toBe(0);
  });

  it('finish removes the job and later updates never resurrect it', () => {
    useProgressStore.getState().start('job-1', 'Building PDF');
    useProgressStore.getState().finish('job-1');
    expect(jobs()).toEqual([]);

    useProgressStore.getState().update('job-1', { detail: 'late update', progress: 0.9 });
    expect(jobs()).toEqual([]);
  });

  it('restart replaces an existing job and stacks run concurrently', () => {
    useProgressStore.getState().start('job-1', 'First');
    useProgressStore.getState().update('job-1', { progress: 0.9, detail: 'almost' });
    useProgressStore.getState().start('job-1', 'Second');
    expect(jobs()).toEqual([{ id: 'job-1', label: 'Second', detail: '', progress: null }]);

    useProgressStore.getState().start('job-2', 'Other task');
    expect(jobs().map((job) => job.id)).toEqual(['job-1', 'job-2']);
  });
});
