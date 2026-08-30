import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { createCampaign } from '@/domain';
import {
  createCampaign as addCampaign,
  deleteCampaign,
  getCampaign,
  listCampaigns,
  updateCampaign,
} from '@/db/campaignRepo';
import { db } from '@/db/db';
import { clearDatabase, expectNotFound } from './helpers';

describe('campaignRepo', () => {
  beforeEach(clearDatabase);

  it('creates a campaign with a blank description and stamps identity', async () => {
    const campaign = await addCampaign({ name: 'Emberfall', system: 'dnd5e' });

    expect(campaign.name).toBe('Emberfall');
    expect(campaign.description).toBe('');
    expect(campaign.system).toBe('dnd5e');
    expect(campaign.createdAt).toBeGreaterThan(0);
    expect(campaign.updatedAt).toBe(campaign.createdAt);
    expect(await getCampaign(campaign.id)).toEqual(campaign);
  });

  it('rejects invalid input via the domain factory', () => {
    expect(() => createCampaign({ name: '', system: 'dnd5e' })).toThrow();
  });

  it('updates campaigns and sorts the list by most recent update', async () => {
    const first = await addCampaign({ name: 'First', system: 'cosmere' });
    // Deterministic ordering: updatedAt has millisecond resolution, so the
    // two rows must be created at distinct timestamps.
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = await addCampaign({ name: 'Second', system: 'other' });

    expect((await listCampaigns()).map((c) => c.id)).toEqual([second.id, first.id]);

    await new Promise((resolve) => setTimeout(resolve, 2));
    await updateCampaign(first.id, { name: 'First Updated' });
    expect((await listCampaigns()).map((c) => c.id)).toEqual([first.id, second.id]);

    const updated = await getCampaign(first.id);
    expect(updated?.name).toBe('First Updated');
    expect(updated?.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
  });

  it('throws NotFoundError when updating a missing campaign', async () => {
    await expectNotFound(updateCampaign('missing-id', { name: 'X' }));
  });

  it('rejects schema-invalid patches', async () => {
    const campaign = await addCampaign({ name: 'Valid', system: 'dnd5e' });
    await expect(updateCampaign(campaign.id, { name: '' })).rejects.toThrow();
  });

  it('deletes a campaign and cascades to artifacts, revisions and runs', async () => {
    const { createArtifact } = await import('@/db/artifactRepo');
    const { createRun } = await import('@/db/runRepo');
    const { createPersona } = await import('@/db/personaRepo');

    const campaign = await addCampaign({ name: 'Cascade', system: 'pathfinder2e' });
    const npc = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Goblin' });
    const note = await createArtifact({ campaignId: campaign.id, kind: 'note', name: 'Plot' });
    // A revision beyond the initial one, to prove revisions are cascaded too.
    await import('@/db/artifactRepo').then((repo) =>
      repo.updateArtifact(note.id, { body: 'changed' }),
    );

    const persona = await createPersona({
      slug: 'test-persona',
      name: 'Test Persona',
      description: '',
      systemPrompt: '',
      producesKind: 'note',
      builtIn: false,
    });
    const run = await createRun({
      campaignId: campaign.id,
      personaId: persona.id,
      autonomy: 'manual',
      userBrief: 'test brief',
    });

    await deleteCampaign(campaign.id);

    expect(await getCampaign(campaign.id)).toBeUndefined();
    expect(await db.artifacts.where('campaignId').equals(campaign.id).count()).toBe(0);
    expect(await db.revisions.where('artifactId').anyOf([npc.id, note.id]).count()).toBe(0);
    expect(await db.runs.get(run.id)).toBeUndefined();
  });
});
