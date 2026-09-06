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

  it('round-trips a description edit and bumps updatedAt', async () => {
    const campaign = await addCampaign({
      name: 'Emberfall',
      description: 'A sunless sea.',
      system: 'dnd5e',
    });
    expect(campaign.description).toBe('A sunless sea.');

    await new Promise((resolve) => setTimeout(resolve, 2));
    const updated = await updateCampaign(campaign.id, { description: 'A drowned city.' });
    expect(updated.description).toBe('A drowned city.');
    expect(updated.name).toBe('Emberfall'); // untouched fields survive the patch
    expect(updated.updatedAt).toBeGreaterThan(campaign.updatedAt);
    expect((await getCampaign(campaign.id))?.description).toBe('A drowned city.');

    // Clearing the description is a valid edit.
    await updateCampaign(campaign.id, { description: '' });
    expect((await getCampaign(campaign.id))?.description).toBe('');
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

/**
 * Cascade completeness pin (F2): modules, live battles and deliverable
 * outlines all carry the campaign's id but had no delete path — deleting a
 * campaign stranded them as permanent orphans that every backup re-exports.
 * The TopBar's last-module shortcut is cleared when it pointed into the
 * deleted campaign (a stale shortcut navigates to a dead reader route).
 */
describe('deleteCampaign cascade completeness', () => {
  beforeEach(clearDatabase);

  it('deletes the campaign\'s modules, battles and deliverables in the same transaction', async () => {
    const { createModule } = await import('@/db/moduleRepo');
    const { createModule: buildModule } = await import('@/domain');
    const { ensureBattle } = await import('@/db/battleRepo');
    const { createDeliverable } = await import('@/db/deliverableRepo');

    const campaign = await addCampaign({ name: 'Doomed', system: 'dnd5e' });
    const other = await addCampaign({ name: 'Survivor', system: 'dnd5e' });
    const doomedModule = await createModule(
      buildModule({ campaignId: campaign.id, title: 'Doomed Vault', concept: '', levelMin: 1, levelMax: 3, sizeDial: 'sketch' }),
    );
    const keptModule = await createModule(
      buildModule({ campaignId: other.id, title: 'Kept Vault', concept: '', levelMin: 1, levelMax: 3, sizeDial: 'sketch' }),
    );
    const battle = await ensureBattle(campaign.id, doomedModule.id);
    await createDeliverable({
      campaignId: campaign.id,
      title: 'Vault outline',
      subtitle: '',
      audience: 'gm',
      coverImageId: null,
      outline: [],
    });

    await deleteCampaign(campaign.id);

    expect(await db.modules.get(doomedModule.id)).toBeUndefined();
    expect(await db.battles.get(battle.id)).toBeUndefined();
    expect(await db.deliverables.where('campaignId').equals(campaign.id).count()).toBe(0);
    // Neighbouring campaign keeps its rows.
    expect(await db.modules.get(keptModule.id)).toBeDefined();
    expect(await db.battles.where('campaignId').equals(other.id).count()).toBe(0);
  });

  it('clears settings.lastModule only when it pointed into the deleted campaign', async () => {
    const { createModule } = await import('@/db/moduleRepo');
    const { createModule: buildModule } = await import('@/domain');
    const { updateSettings } = await import('@/db/settingsRepo');

    const campaign = await addCampaign({ name: 'Shortlived', system: 'dnd5e' });
    const doomedModule = await createModule(
      buildModule({ campaignId: campaign.id, title: 'Shortlived Vault', concept: '', levelMin: 1, levelMax: 3, sizeDial: 'sketch' }),
    );
    await updateSettings({
      lastModule: { campaignId: campaign.id, moduleId: doomedModule.id, name: doomedModule.title },
    });

    await deleteCampaign(campaign.id);
    expect((await db.settings.get('settings'))?.lastModule).toBeNull();

    // A shortcut into a surviving campaign is untouched by another delete.
    const survivor = await addCampaign({ name: 'Elsewhere', system: 'dnd5e' });
    const keptModule = await createModule(
      buildModule({ campaignId: survivor.id, title: 'Kept Vault', concept: '', levelMin: 1, levelMax: 3, sizeDial: 'sketch' }),
    );
    await updateSettings({
      lastModule: { campaignId: survivor.id, moduleId: keptModule.id, name: keptModule.title },
    });
    const unrelated = await addCampaign({ name: 'Unrelated', system: 'dnd5e' });
    await deleteCampaign(unrelated.id);
    expect((await db.settings.get('settings'))?.lastModule?.moduleId).toBe(keptModule.id);
  });
});
