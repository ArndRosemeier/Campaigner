import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { newId, type PersonaRun } from '@/domain';
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
    // Reload interruptions classify as 'cancelled' (docs/05 run views) —
    // the run died with the page, not because the provider failed.
    expect(reread?.failureKind).toBe('cancelled');
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

  /**
   * Parse-on-read at the Dexie boundary (the ratified `parseBattleRow`
   * template): a run row written before the additive option fields existed
   * materializes the schema defaults on read — resume/retry reconstructs
   * the input exactly instead of seeing `undefined`.
   */
  it('materializes run-option defaults on a legacy row without them', async () => {
    const personaId = await makePersona();
    const campaignId = newId();
    const legacy = {
      id: newId(),
      createdAt: 1,
      updatedAt: 1,
      campaignId,
      personaId,
      autonomy: 'manual',
      status: 'completed',
      userBrief: 'pre-D10 run',
      pinnedChunkIds: [],
      steps: [],
      resultArtifactId: null,
      targetArtifactId: null,
      errorMessage: '',
      // NO encounterMapAspect/encounterPreset/placementModuleId/runExtras.
    };
    await db.runs.put(legacy as unknown as PersonaRun);

    const run = await getRun(legacy.id);
    expect(run?.encounterMapAspect).toBeNull();
    expect(run?.encounterPreset).toBeNull();
    expect(run?.placementModuleId).toBeNull();
    expect(run?.runExtras).toBeNull();
    const listed = await listRunsByCampaign(campaignId);
    expect(listed[0]?.encounterPreset).toBeNull();
    expect(listed[0]?.runExtras).toBeNull();
  });

  /**
   * failureKind rides the same additive-defaults rule: a legacy FAILED row
   * (written before the field existed) parses with failureKind null and its
   * errorMessage untouched — the UI renders null as 'unknown' guidance, no
   * migration (docs/05 run views).
   */
  it('materializes failureKind null on a legacy failed row and keeps the raw message', async () => {
    const personaId = await makePersona();
    const campaignId = newId();
    const legacy = {
      id: newId(),
      createdAt: 1,
      updatedAt: 2,
      campaignId,
      personaId,
      autonomy: 'auto',
      status: 'failed',
      userBrief: 'pre-classification run',
      pinnedChunkIds: [],
      steps: [],
      resultArtifactId: null,
      targetArtifactId: null,
      errorMessage: 'OpenRouter request failed (503): provider overloaded',
      // NO failureKind.
    };
    await db.runs.put(legacy as unknown as PersonaRun);

    const run = await getRun(legacy.id);
    expect(run?.status).toBe('failed');
    expect(run?.failureKind).toBeNull();
    expect(run?.errorMessage).toBe('OpenRouter request failed (503): provider overloaded');
  });

  /**
   * Legacy-run tolerance for the REMOVED encounter `verify` step (docs/11
   * D14): a pre-deletion run row carries a persisted 'verify' step between
   * 'stylize' and 'pick'. The parse boundary drops it and re-indexes the
   * remainder so every consumer — the Runs tab step list (which renders
   * `step.name` generically) and the engine's index-based continuation —
   * sees the current plan's alignment. The verify output had exactly one
   * consumer (the pick UI's drift overlay, removed with the step).
   */
  it('drops legacy verify steps and re-indexes the remainder at the parse boundary', async () => {
    const personaId = await makePersona();
    const campaignId = newId();
    const legacy = {
      id: newId(),
      createdAt: 1,
      updatedAt: 1,
      campaignId,
      personaId,
      autonomy: 'manual',
      status: 'awaiting_user',
      userBrief: 'pre-deletion cartographer run',
      pinnedChunkIds: [],
      // The OLD 7-step encounter plan, pick paused.
      steps: [
        { index: 0, name: 'brief', status: 'done', input: {}, output: { parsed: {} }, userEdit: null },
        { index: 1, name: 'layout', status: 'approved', input: {}, output: { layout: {} }, userEdit: null },
        { index: 2, name: 'schematic', status: 'done', input: {}, output: { width: 1, height: 1 }, userEdit: null },
        { index: 3, name: 'stylize', status: 'done', input: {}, output: { imageIds: ['img-1'] }, userEdit: null },
        { index: 4, name: 'verify', status: 'rejected', input: {}, output: { verifications: [{ needsReview: true, report: 'structure verification: 20 of 94 graded cells mismatched the layout' }] }, userEdit: null },
        { index: 5, name: 'pick', status: 'done', input: {}, output: { candidates: ['img-1'] }, userEdit: null },
        { index: 6, name: 'finalize', status: 'pending', input: {}, output: null, userEdit: null },
      ],
      resultArtifactId: null,
      targetArtifactId: null,
      errorMessage: '',
    };
    await db.runs.put(legacy as unknown as PersonaRun);

    const run = await getRun(legacy.id);
    expect(run?.status).toBe('awaiting_user');
    // The verify step is gone; the remainder is index-coherent.
    expect(run?.steps.map((step) => step.name)).toEqual([
      'brief', 'layout', 'schematic', 'stylize', 'pick', 'finalize',
    ]);
    expect(run?.steps.every((step, index) => step.index === index)).toBe(true);
    const listed = await listRunsByCampaign(campaignId);
    expect(listed[0]?.steps.find((step) => step.name === 'verify')).toBeUndefined();

    // The next engine write heals the STORED row too (the normalizeLegacy
    // precedent): updateRun parses before put.
    await updateRun(legacy.id, { status: 'failed', errorMessage: 'healed' });
    const raw = await db.runs.get(legacy.id);
    expect(raw?.steps.some((step) => step.name === 'verify')).toBe(false);
  });
});
