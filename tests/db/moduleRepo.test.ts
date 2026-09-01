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
  saveModule,
  savePartPlan,
  saveSpine,
} from '@/db/moduleRepo';
import { db } from '@/db/db';
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
      partPlan: [
        { title: 'Approach', levelBand: '1', synopsis: 'Reach the sea gate.', levelUpTrigger: 'The tide turns.' },
        { title: 'Descent', levelBand: '2–4', synopsis: 'Dive the flooded stair.', levelUpTrigger: 'The vault seals.' },
      ],
    };
    const spined = await saveSpine(created.id, spine);
    expect(spined.spine).toEqual(spine);
    expect((await getModule(created.id))?.spine).toEqual(spine);

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

    await deleteModule(created.id);
    expect(await getModule(created.id)).toBeUndefined();

    await deleteModule(created.id);
    expect(await listModulesByCampaign(created.campaignId)).toEqual([]);
  });
});
