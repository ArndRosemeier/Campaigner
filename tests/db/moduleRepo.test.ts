import 'fake-indexeddb/auto';

import { ZodError } from 'zod';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  createModule as buildModule,
  newId,
  type ModuleSpine,
  type PartPlan,
} from '@/domain';
import {
  createModule,
  deleteModule,
  getModule,
  listModulesByCampaign,
  patchModule,
  patchModuleSpine,
  saveModule,
  savePartPlan,
  saveSpine,
} from '@/db/moduleRepo';
import { createArtifact, getArtifact, listRevisions, updateArtifact } from '@/db/artifactRepo';
import { db } from '@/db/db';
import { ensureBattleForEncounter, listBattlesByModule } from '@/db/battleRepo';
import { clearDatabase, expectNotFound } from './helpers';

/**
 * Module repo (08-MODULE-DESIGNER M4-A): CRUD over the `modules` table where
 * every write is a full-row `moduleSchema.parse` — an invalid row can never
 * persist.
 */

describe('moduleRepo', () => {
  beforeEach(clearDatabase);

  it('round-trips a module built by the domain factory', async () => {
    const campaignId = newId();
    const built = buildModule({
      campaignId,
      title: 'The Sunken Vault',
      concept: 'A drowned dungeon that floods at high tide.',
      levelMin: 1,
      levelMax: 3,
      tone: 'eerie',
      sizeDial: 'standard',
    });

    const created = await createModule(built);

    expect(created.id).toBe(built.id);
    expect(created.status).toBe('draft');
    expect(created.spine).toBeNull();
    expect(created.parts).toEqual([]);

    const row = await getModule(created.id);
    expect(row?.campaignId).toBe(campaignId);
    expect(row?.title).toBe('The Sunken Vault');
    expect(row?.levelMin).toBe(1);
    expect(row?.levelMax).toBe(3);
    expect(row?.sizeDial).toBe('standard');
  });

  it('lists a campaign’s modules newest-first and excludes other campaigns', async () => {
    const campaignId = newId();
    const older = await createModule(
      buildModule({ campaignId, title: 'Older', concept: '', levelMin: 1, levelMax: 3, sizeDial: 'sketch' }),
    );
    const newer = await createModule(
      buildModule({ campaignId, title: 'Newer', concept: '', levelMin: 1, levelMax: 3, sizeDial: 'sketch' }),
    );
    await createModule(
      buildModule({
        campaignId: newId(),
        title: 'Elsewhere',
        concept: '',
        levelMin: 1,
        levelMax: 3,
        sizeDial: 'sketch',
      }),
    );

    // Bump the older row so the updatedAt sort has a deterministic flip.
    await db.modules.update(older.id, { updatedAt: newer.updatedAt + 1000 });

    const titles = (await listModulesByCampaign(campaignId)).map((row) => row.title);
    expect(titles).toEqual(['Older', 'Newer']);
  });

  it('keeps newest-first even where it CONTRADICTS the display arc order (docs/17 row 297)', async () => {
    // The arm above is not discriminating against a level sort: both of its
    // modules share a level band, so `createdAt` ASC happens to agree with the
    // bumped recency order. THIS fixture makes the two orders disagree on
    // purpose — the level-5 module is the most recently touched, so the
    // display's arc order is (Low, High) and the repo's contract is the
    // REVERSE. A future "unification" of the two orders reds here.
    const campaignId = newId();
    const low = await createModule(
      buildModule({ campaignId, title: 'Low', concept: '', levelMin: 1, levelMax: 2, sizeDial: 'sketch' }),
    );
    const high = await createModule(
      buildModule({ campaignId, title: 'High', concept: '', levelMin: 5, levelMax: 6, sizeDial: 'sketch' }),
    );
    await db.modules.update(high.id, { updatedAt: low.updatedAt + 1000 });

    const titles = (await listModulesByCampaign(campaignId)).map((row) => row.title);
    expect(titles).toEqual(['High', 'Low']);
  });

  it('patchModule merges a partial and persists it', async () => {
    const created = await createModule(
      buildModule({
        campaignId: newId(),
        title: 'Working title',
        concept: 'Concept',
        levelMin: 1,
        levelMax: 5,
        tone: 'grim',
        sizeDial: 'detailed',
      }),
    );

    const patched = await patchModule(created.id, { title: 'Final title', tone: 'hopeful' });

    expect(patched.title).toBe('Final title');
    expect(patched.tone).toBe('hopeful');
    expect(patched.concept).toBe('Concept');
    expect(patched.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);

    const row = await getModule(created.id);
    expect(row?.title).toBe('Final title');
    expect(row?.tone).toBe('hopeful');

    await expectNotFound(patchModule(newId(), { title: 'Ghost' }));
  });

  it('saveSpine replaces the spine and savePartPlan replaces only the plan', async () => {
    const created = await createModule(
      buildModule({ campaignId: newId(), title: 'Spined', concept: '', levelMin: 1, levelMax: 4, sizeDial: 'standard' }),
    );

    const spine: ModuleSpine = {
      premise: 'A vault that floods at high tide.',
      themes: ['drowning', 'greed'],
      writerModel: '',
      origin: null,
      partPlan: [
        { title: 'Approach', levelBand: '1', synopsis: 'Reach the sea gate.', levelUpTrigger: 'The tide turns.' },
        { title: 'Descent', levelBand: '2–4', synopsis: 'Dive the flooded stair.', levelUpTrigger: 'The vault seals.' },
      ],
    };
    const spined = await saveSpine(created.id, spine);
    // The stored spine carries the provenance field too (docs/17 row 93): a
    // spine handed in without an id reads back with the additive default `''`
    // = NOT RECORDED (which displays as nothing), never an invented model.
    expect(spined.spine).toEqual({ ...spine, writerModel: '' });
    expect((await getModule(created.id))?.spine).toEqual({ ...spine, writerModel: '' });

    const nextPlan: PartPlan[] = [
      { title: 'One long act', levelBand: '1–4', synopsis: 'Everything in a single part.', levelUpTrigger: 'Escape at dawn.' },
    ];
    const replanned = await savePartPlan(created.id, nextPlan);
    expect(replanned.spine?.partPlan).toEqual(nextPlan);
    expect(replanned.spine?.premise).toBe(spine.premise);
    expect(replanned.spine?.themes).toEqual(spine.themes);

    const row = await getModule(created.id);
    expect(row?.spine?.partPlan).toEqual(nextPlan);
  });

  it('patchModuleSpine merges ONE spine subfield and leaves the rest byte-identical', async () => {
    const created = await createModule(
      buildModule({ campaignId: newId(), title: 'Subfield', concept: '', levelMin: 1, levelMax: 4, sizeDial: 'standard' }),
    );
    const spine: ModuleSpine = {
      premise: 'A vault that floods at high tide.',
      themes: ['drowning', 'greed'],
      writerModel: '',
      origin: 'model',
      partPlan: [
        { title: 'Approach', levelBand: '1', synopsis: 'Reach the sea gate.', levelUpTrigger: 'The tide turns.' },
        { title: 'Descent', levelBand: '2–4', synopsis: 'Dive the flooded stair.', levelUpTrigger: 'The vault seals.' },
      ],
    };
    await saveSpine(created.id, spine);
    const before = await getModule(created.id);

    // The version restore's premise write rides this seam (docs/17 row 357):
    // ONE subfield changes, every other byte of the spine stays.
    const patched = await patchModuleSpine(created.id, { premise: 'An OLDER premise, restored.' });
    expect(patched.spine).toEqual({ ...spine, premise: 'An OLDER premise, restored.' });
    expect(patched.spine?.themes).toEqual(spine.themes);
    expect(patched.spine?.partPlan).toEqual(spine.partPlan);
    expect(patched.spine?.writerModel).toBe(spine.writerModel);
    expect(patched.spine?.origin).toBe(spine.origin);
    expect(patched.parts).toEqual(before?.parts);
  });

  it('patchModuleSpine refuses a module that has no spine (loud, never a silent no-op)', async () => {
    const created = await createModule(
      buildModule({ campaignId: newId(), title: 'Spineless', concept: '', levelMin: 1, levelMax: 3, sizeDial: 'sketch' }),
    );

    await expect(patchModuleSpine(created.id, { premise: 'nowhere to land' })).rejects.toThrow(
      /without a spine/,
    );
    expect((await getModule(created.id))?.spine).toBeNull();
  });

  it('refuses a part plan on a module that has no spine', async () => {
    const created = await createModule(
      buildModule({ campaignId: newId(), title: 'Spineless', concept: '', levelMin: 1, levelMax: 3, sizeDial: 'sketch' }),
    );

    const plan: PartPlan[] = [{ title: 'Solo', levelBand: '1–3', synopsis: '', levelUpTrigger: '' }];
    await expect(savePartPlan(created.id, plan)).rejects.toThrow();

    expect((await getModule(created.id))?.spine).toBeNull();
  });

  it('saveModule rejects an invalid row with a ZodError and writes nothing', async () => {
    const built = buildModule({
      campaignId: newId(),
      title: 'Broken',
      concept: '',
      levelMin: 3,
      levelMax: 5,
      sizeDial: 'standard',
    });

    await expect(saveModule({ ...built, levelMax: 2 })).rejects.toThrow(ZodError);
    expect(await getModule(built.id)).toBeUndefined();
  });

  it('saveSpine rejects a part plan above the 20-entry cap', async () => {
    const created = await createModule(
      buildModule({ campaignId: newId(), title: 'Capped', concept: '', levelMin: 1, levelMax: 3, sizeDial: 'sketch' }),
    );

    const tooBig: ModuleSpine = {
      premise: 'p',
      themes: [],
      writerModel: '',
      origin: null,
      partPlan: Array.from({ length: 21 }, (_, index) => ({
        title: `Part ${index + 1}`,
        levelBand: '1',
        synopsis: '',
        levelUpTrigger: '',
      })),
    };
    await expect(saveSpine(created.id, tooBig)).rejects.toThrow();
  });

  it('deleteModule removes the row and is idempotent', async () => {
    const created = await createModule(
      buildModule({ campaignId: newId(), title: 'Doomed', concept: '', levelMin: 1, levelMax: 3, sizeDial: 'sketch' }),
    );

    await ensureBattleForEncounter(created.campaignId, created.id, newId());
    expect(await listBattlesByModule(created.id)).toHaveLength(1);
    await deleteModule(created.id, 'keep');
    expect(await getModule(created.id)).toBeUndefined();
    expect(await listBattlesByModule(created.id)).toEqual([]);

    await deleteModule(created.id, 'keep');
    expect(await listModulesByCampaign(created.campaignId)).toEqual([]);
  });

  describe('owned-artifacts disposal (10-MILESTONE-6 D5)', () => {
    beforeEach(clearDatabase);

    it("'keep' releases the module's artifacts into campaign ownership", async () => {
      const campaignId = newId();
      const created = await createModule(
        buildModule({ campaignId, title: 'Ember Crypt', concept: '', levelMin: 1, levelMax: 3, sizeDial: 'sketch' }),
      );
      const owned = await createArtifact({
        campaignId,
        moduleId: created.id,
        kind: 'npc',
        name: 'Kael',
      });
      await createArtifact({ campaignId, kind: 'note', name: 'Free note' });

      const before = await getArtifact(owned.id);
      const beforeRevisions = (await listRevisions(owned.id)).length;

      await deleteModule(created.id, 'keep');

      expect(await getModule(created.id)).toBeUndefined();
      const released = await getArtifact(owned.id);
      expect(released?.moduleId).toBeNull();
      // The campaign anchor survives the release.
      expect(released?.campaignId).toBe(campaignId);
      // The release rides the SANCTIONED scope seam (docs/18 §2.1), so it is
      // a revisioned scope change like any single move — not a raw
      // `modify({moduleId: null})` that no history records.
      expect(released?.currentRevision).toBe((before?.currentRevision ?? 0) + 1);
      const revisions = await listRevisions(owned.id);
      expect(revisions.length).toBe(beforeRevisions + 1);
      expect(revisions[0]?.snapshot.moduleId).toBeNull();
      // A scope change is a real save: the row's `updatedAt` moves with it.
      expect(released?.updatedAt).toBeGreaterThanOrEqual(before?.updatedAt ?? 0);
      expect((await listArtifactsByCampaignRows(campaignId)).map((row) => row.name).sort()).toEqual([
        'Free note',
        'Kael',
      ]);
    });

    it("'cascade' deletes the module's artifacts with their revisions", async () => {
      const campaignId = newId();
      const created = await createModule(
        buildModule({ campaignId, title: 'Ember Crypt', concept: '', levelMin: 1, levelMax: 3, sizeDial: 'sketch' }),
      );
      const owned = await createArtifact({
        campaignId,
        moduleId: created.id,
        kind: 'npc',
        name: 'Kael',
      });
      await updateArtifact(owned.id, { body: 'v2' });
      const free = await createArtifact({ campaignId, kind: 'note', name: 'Free note' });

      await deleteModule(created.id, 'cascade');

      expect(await getModule(created.id)).toBeUndefined();
      expect(await getArtifact(owned.id)).toBeUndefined();
      expect(await listRevisions(owned.id)).toEqual([]);
      // Other campaign artifacts are untouched.
      expect((await getArtifact(free.id))?.name).toBe('Free note');
    });
  });
});

/** Module rows + owned rows of a campaign, like the module reader would see
 * them (listArtifactsByCampaign includes module-owned rows). */
async function listArtifactsByCampaignRows(campaignId: string) {
  const { listArtifactsByCampaign } = await import('@/db/artifactRepo');
  return listArtifactsByCampaign(campaignId);
}
