import {
  createPersonaRun as buildRun,
  personaRunSchema,
  type EntityPatch,
  type Id,
  type NewPersonaRun,
  type PersonaRun,
} from '@/domain';
import { db } from '@/db/db';
import { NotFoundError } from '@/lib/errors';

export type RunPatch = EntityPatch<PersonaRun>;

export async function createRun(input: NewPersonaRun): Promise<PersonaRun> {
  const run = buildRun(input);
  await db.runs.put(run);
  return run;
}

export async function getRun(id: Id): Promise<PersonaRun | undefined> {
  return db.runs.get(id);
}

/** Past runs of a campaign, most recent first (Runs tab). */
export async function listRunsByCampaign(campaignId: Id): Promise<PersonaRun[]> {
  const rows = await db.runs.where('campaignId').equals(campaignId).toArray();
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The run engine persists after every state change through this function. */
export async function updateRun(id: Id, patch: RunPatch): Promise<PersonaRun> {
  return db.transaction('rw', db.runs, async () => {
    const current = await db.runs.get(id);
    if (!current) throw new NotFoundError('PersonaRun', id);
    const updated = personaRunSchema.parse({ ...current, ...patch, updatedAt: Date.now() });
    await db.runs.put(updated);
    return updated;
  });
}

export async function deleteRun(id: Id): Promise<void> {
  await db.runs.delete(id);
}

/**
 * Marks runs stuck in 'running' as failed (called on app start: the engine
 * does not survive a reload — 04-LLM-PERSONAS acceptance criteria).
 */
export async function failRunningRuns(errorMessage = 'Interrupted by reload'): Promise<number> {
  const running = await db.runs.where('status').equals('running').toArray();
  if (running.length === 0) return 0;

  const failed = running.map((run) =>
    personaRunSchema.parse({ ...run, status: 'failed', errorMessage, updatedAt: Date.now() }),
  );
  await db.transaction('rw', db.runs, async () => {
    await db.runs.bulkPut(failed);
  });
  return failed.length;
}
