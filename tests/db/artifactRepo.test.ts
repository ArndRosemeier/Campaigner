import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { newId, type Artifact } from '@/domain';
import {
  countArtifactsByCampaign,
  createArtifact,
  deleteArtifact,
  getArtifact,
  getRevision,
  listArtifactsByCampaign,
  listRevisions,
  restoreRevision,
  saveArtifact,
  updateArtifact,
} from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { db } from '@/db/db';
import { clearDatabase, expectNotFound } from './helpers';

describe('artifactRepo revisions', () => {
  beforeEach(clearDatabase);

  it('creates revision 1 with a full snapshot on create', async () => {
    const artifact = await createArtifact({
      campaignId: newId(),
      kind: 'npc',
      name: 'Grimm',
      tags: ['goblin'],
    });

    expect(artifact.currentRevision).toBe(1);

    const rows = await db.revisions.where('artifactId').equals(artifact.id).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revision).toBe(1);
    expect(rows[0]?.source).toBe('user');
    expect(rows[0]?.runId).toBeNull();
    expect(rows[0]?.snapshot.name).toBe('Grimm');
    expect(rows[0]?.snapshot.tags).toEqual(['goblin']);
  });

  it('records the persona source and runId when saving for a run', async () => {
    const runId = newId();
    const artifact = await createArtifact(
      { campaignId: newId(), kind: 'npc', name: 'Smithed NPC' },
      { source: 'persona', runId },
    );

    const row = (await listRevisions(artifact.id)).at(0);
    expect(row?.source).toBe('persona');
    expect(row?.runId).toBe(runId);
  });

  it('increments the revision and writes a snapshot per save', async () => {
    const artifact = await createArtifact({
      campaignId: newId(),
      kind: 'location',
      name: 'Ruins',
    });

    const saved = await updateArtifact(artifact.id, { body: 'v2', summary: 'A ruin.' });

    expect(saved.currentRevision).toBe(2);
    expect(saved.body).toBe('v2');

    const row = await getRevision(artifact.id, 2);
    expect(row?.snapshot.body).toBe('v2');
    expect(row?.snapshot.summary).toBe('A ruin.');

    const reread = await getArtifact(artifact.id);
    expect(reread?.currentRevision).toBe(2);
  });

  it('keeps at most 50 revisions per artifact (oldest deleted)', async () => {
    let artifact: Artifact = await createArtifact({
      campaignId: newId(),
      kind: 'note',
      name: 'Journal',
    });

    // 55 saves on top of revision 1 → currentRevision 56, but only 50 rows.
    for (let i = 0; i < 55; i++) {
      artifact = await updateArtifact(artifact.id, { body: `v${i}` });
    }

    expect(artifact.currentRevision).toBe(56);

    const revisions = await listRevisions(artifact.id);
    expect(revisions).toHaveLength(50);
    // Sorted newest first: 56 down to 7.
    expect(revisions[0]?.revision).toBe(56);
    expect(revisions.at(-1)?.revision).toBe(7);
    // Snapshots keep their historical content.
    expect(revisions[0]?.snapshot.body).toBe('v54');
    expect(revisions.at(-1)?.snapshot.body).toBe('v5');
  });

  it('restores an old snapshot as a NEW revision', async () => {
    let artifact: Artifact = await createArtifact({
      campaignId: newId(),
      kind: 'faction',
      name: 'Guild',
    });
    for (let i = 0; i < 55; i++) {
      artifact = await updateArtifact(artifact.id, { body: `v${i}` });
    }

    const restored = await restoreRevision(artifact.id, 7);

    expect(restored.currentRevision).toBe(57);
    expect(restored.body).toBe('v5');

    // The restore itself is a revision; the cap still holds (7 dropped, 57 added).
    const revisions = await listRevisions(artifact.id);
    expect(revisions).toHaveLength(50);
    expect(revisions[0]?.revision).toBe(57);
    expect(revisions[0]?.snapshot.body).toBe('v5');
    expect(revisions.at(-1)?.revision).toBe(8);
  });

  it('rejects saving an artifact whose data does not match its kind', async () => {
    const artifact = await createArtifact({
      campaignId: newId(),
      kind: 'npc',
      name: 'Grimm',
    });

    await expect(
      updateArtifact(artifact.id, {
        data: { goals: '', methods: '', resources: '', ranks: [] },
      }),
    ).rejects.toThrow();
  });

  it('throws NotFoundError for missing artifacts/revisions', async () => {
    // updateArtifact/restoreRevision throw inside transactions, so Dexie
    // wraps the error — match through the guard, not by identity.
    await expectNotFound(updateArtifact('missing', { body: 'x' }));
    await expectNotFound(restoreRevision('missing', 1));
    expect(await getRevision(newId(), 1)).toBeUndefined();
  });

  it('deletes the artifact and its revision history', async () => {
    const artifact = await createArtifact({
      campaignId: newId(),
      kind: 'note',
      name: 'Disposable',
    });
    await updateArtifact(artifact.id, { body: 'v2' });

    await deleteArtifact(artifact.id);

    expect(await db.artifacts.get(artifact.id)).toBeUndefined();
    expect(await db.revisions.where('artifactId').equals(artifact.id).count()).toBe(0);
  });

  it('lists artifacts alphabetically and counts per campaign', async () => {
    const campaignId = newId();
    await createArtifact({ campaignId, kind: 'note', name: 'Beta' });
    await createArtifact({ campaignId, kind: 'npc', name: 'Alpha' });
    await createArtifact({ campaignId, kind: 'faction', name: 'Gamma' });

    const names = (await listArtifactsByCampaign(campaignId)).map((a) => a.name);
    expect(names).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(await countArtifactsByCampaign(campaignId)).toBe(3);
  });

  it('saveArtifact (full-row) also bumps the revision', async () => {
    const artifact = await createArtifact({
      campaignId: newId(),
      kind: 'npc',
      name: 'Original',
    });
    const saved = await saveArtifact({ ...artifact, name: 'Renamed' });

    expect(saved.currentRevision).toBe(2);
    expect((await getRevision(artifact.id, 2))?.snapshot.name).toBe('Renamed');
  });
});

describe('deleteArtifact', () => {
  it('removes the artifact, its revisions, and dangling links in other artifacts', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const npc = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Gorim' });
    const location = await createArtifact({
      campaignId: campaign.id,
      kind: 'location',
      name: 'Forge',
      links: [{ targetId: npc.id, relation: 'workplace-of' }],
      body: 'x'.repeat(50),
    });
    const note = await createArtifact({
      campaignId: campaign.id,
      kind: 'note',
      name: 'Rumors',
      links: [{ targetId: location.id, relation: 'about' }],
      body: 'y'.repeat(50),
    });

    await deleteArtifact(npc.id);

    const afterLocation = await getArtifact(location.id);
    expect(afterLocation?.links).toEqual([]);
    const afterNote = await getArtifact(note.id);
    expect(afterNote?.links).toEqual([{ targetId: location.id, relation: 'about' }]);
    expect(await getArtifact(npc.id)).toBeUndefined();
    expect(await listRevisions(npc.id)).toEqual([]);
  });
});
