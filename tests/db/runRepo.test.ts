import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { newId } from '@/domain';
import { createPersona } from '@/db/personaRepo';
import {
  createRun,
  deleteRun,
  getRun,
  listRunsByCampaign,
  updateRun,
  failRunningRuns,
} from '@/db/runRepo';
import { db } from '@/db/db';
import { clearDatabase, expectNotFound } from './helpers';

async function makePersona(): Promise<string> {
  const persona = await createPersona({
    slug: `persona-${newId()}`,
    name: 'Test Persona',
    description: '',
    systemPrompt: '',
    producesKind: 'note',
    builtIn: false,
  });
  return persona.id;
}

describe('runRepo', () => {
  beforeEach(clearDatabase);

  it('creates a run in the running state with no steps', async () => {
    const personaId = await makePersona();
    const run = await createRun({
      campaignId: newId(),
      personaId,
      autonomy: 'manual',
      userBrief: 'a goblin alchemist boss for level 3 party',
      pinnedChunkIds: ['chunk-1'],
    });

    expect(run.status).toBe('running');
    expect(run.steps).toEqual([]);
    expect(run.resultArtifactId).toBeNull();
    expect(run.errorMessage).toBe('');
    expect(run.pinnedChunkIds).toEqual(['chunk-1']);
  });

  it('persists step progress through updateRun', async () => {
    const personaId = await makePersona();
    const run = await createRun({
      campaignId: newId(),
      personaId,
      autonomy: 'review',
      userBrief: 'brief',
    });

    const updated = await updateRun(run.id, {
      status: 'awaiting_user',
      steps: [
        { index: 0, name: 'retrieve', status: 'done', input: 'q', output: ['c1'], userEdit: null },
        { index: 1, name: 'draft', status: 'running', input: null, output: null, userEdit: null },
      ],
    });

    expect(updated.status).toBe('awaiting_user');
    expect(updated.steps).toHaveLength(2);
    expect(updated.steps[0]?.output).toEqual(['c1']);

    const reread = await getRun(run.id);
    expect(reread?.status).toBe('awaiting_user');
  });

  it('lists runs of a campaign, most recent first', async () => {
    const campaignId = newId();
    const personaId = await makePersona();
    const first = await createRun({
      campaignId,
      personaId,
      autonomy: 'auto',
      userBrief: 'first',
    });
    await createRun({ campaignId, personaId, autonomy: 'auto', userBrief: 'second' });

    // Deterministic ordering: updatedAt has millisecond resolution.
    await new Promise((resolve) => setTimeout(resolve, 2));
    await updateRun(first.id, { status: 'completed' });

    const briefs = (await listRunsByCampaign(campaignId)).map((run) => run.userBrief);
    expect(briefs).toEqual(['first', 'second']);
  });

  it('marks running runs as failed (interrupted by reload)', async () => {
    const campaignId = newId();
    const personaId = await makePersona();
    const running = await createRun({
      campaignId,
      personaId,
      autonomy: 'manual',
      userBrief: 'running',
    });
    const done = await createRun({
      campaignId,
      personaId,
      autonomy: 'auto',
      userBrief: 'done',
    });
    await updateRun(done.id, { status: 'completed' });

    const count = await failRunningRuns();

    expect(count).toBe(1);
    const reread = await getRun(running.id);
    expect(reread?.status).toBe('failed');
    expect(reread?.errorMessage).toBe('Interrupted by reload');
    expect((await getRun(done.id))?.status).toBe('completed');

    // Idempotent: nothing left running.
    expect(await failRunningRuns()).toBe(0);
  });

  it('throws NotFoundError when updating a missing run', async () => {
    await expectNotFound(updateRun('missing', { status: 'cancelled' }));
  });

  it('deletes runs', async () => {
    const personaId = await makePersona();
    const run = await createRun({
      campaignId: newId(),
      personaId,
      autonomy: 'manual',
      userBrief: 'x',
    });
    await deleteRun(run.id);
    expect(await db.runs.get(run.id)).toBeUndefined();
  });
});
