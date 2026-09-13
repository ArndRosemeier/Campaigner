import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { addArtifactAliases, createArtifact, getAnyArtifact, listRevisions } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { newId } from '@/domain';
import { clearDatabase, expectNotFound } from './helpers';

/**
 * The ONE alias WRITE path (docs/17 row 121, docs/18 §2.1): the merged pool is
 * persisted by `artifactRepo.addArtifactAliases`, which owns the read-merge-write
 * as one revisioned save. The RULE it applies is pinned in
 * `tests/domain/artifactAlias.test.ts`; this file pins the row contract the
 * callers depend on — one revision per real addition, and NOTHING AT ALL when
 * the pool already answers (no revision, no `updatedAt` move), which is what
 * lets a surface ask twice and write once.
 */
async function seedNpc(aliases: string[] = []) {
  const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
  const npc = await createArtifact({
    campaignId: campaign.id,
    kind: 'npc',
    name: 'Warden Bellamy',
    aliases,
  });
  return npc;
}

describe('artifactRepo.addArtifactAliases', () => {
  beforeEach(clearDatabase);

  it('adds the name and writes exactly ONE revision', async () => {
    const npc = await seedNpc(['Missing Person ']);
    const before = await listRevisions(npc.id);

    const updated = await addArtifactAliases(npc.id, ['Sentry']);

    expect(updated?.aliases).toEqual(['Missing Person ', 'Sentry']);
    expect(updated?.currentRevision).toBe(npc.currentRevision + 1);
    expect((await listRevisions(npc.id)).length).toBe(before.length + 1);
  });

  it('names the LAST writer of the row (the revision meta the callers pass)', async () => {
    const npc = await seedNpc();
    const updated = await addArtifactAliases(npc.id, ['Sentry'], { source: 'persona', runId: null });
    const revisions = await listRevisions(npc.id);
    const latest = revisions.find((row) => row.revision === updated?.currentRevision);
    expect(latest?.source).toBe('persona');
  });

  it('writes NOTHING when the pool already answers — even across whitespace or case', async () => {
    const npc = await seedNpc(['Missing Person ']);
    const revisionsBefore = (await listRevisions(npc.id)).length;
    const updatedAtBefore = npc.updatedAt;

    // The `"Kael "` divergence, at the write path: `Missing Person` is already
    // answered by the stored `"Missing Person "`.
    expect(await addArtifactAliases(npc.id, ['missing person'])).toBeNull();
    expect(await addArtifactAliases(npc.id, ['  Missing Person  '])).toBeNull();
    // …and the artifact's own name is not an alias either.
    expect(await addArtifactAliases(npc.id, ['Warden Bellamy'])).toBeNull();

    const after = await getAnyArtifact(npc.id);
    expect(after?.aliases).toEqual(['Missing Person ']);
    expect(after?.currentRevision).toBe(npc.currentRevision);
    expect(after?.updatedAt).toBe(updatedAtBefore);
    expect((await listRevisions(npc.id)).length).toBe(revisionsBefore);
  });

  it('is idempotent across two calls (the second is the no-op)', async () => {
    const npc = await seedNpc();
    const first = await addArtifactAliases(npc.id, ['Kael']);
    expect(first?.aliases).toEqual(['Kael']);
    expect(await addArtifactAliases(npc.id, ['KAEL'])).toBeNull();
    expect((await getAnyArtifact(npc.id))?.currentRevision).toBe(first?.currentRevision);
  });

  it('merges inside its own transaction, so one call cannot clobber another', async () => {
    const npc = await seedNpc();
    const [left, right] = await Promise.all([
      addArtifactAliases(npc.id, ['Kael']),
      addArtifactAliases(npc.id, ['Bram']),
    ]);
    // Both writes landed: each call reads the row INSIDE its own transaction,
    // so neither caller's snapshot is written back over the other's name.
    expect(left).not.toBeNull();
    expect(right).not.toBeNull();
    const after = await getAnyArtifact(npc.id);
    expect(after?.aliases).toHaveLength(2);
    expect(new Set(after?.aliases ?? [])).toEqual(new Set(['Kael', 'Bram']));
  });

  it('is LOUD about a missing row rather than a silent skip (AGENTS 1)', async () => {
    // A row that is not there is an error, never a `null` (which means "nothing
    // to write"): the callers treat `null` as success.
    await expectNotFound(addArtifactAliases(newId(), ['Ghost']));
  });
});
