import { saveModule } from '@/db/moduleRepo';
import { createModule, type Id, type Module } from '@/domain';

/**
 * A SAVED module whose document carries `premise` plus ONE level section —
 * the shape the orphan sweep and the orphan-offer agreement pins both seed.
 *
 * ONE seam (AGENTS rule 4, docs/17 row 392). Two byte-identical copies lived in
 * `tests/db/orphanSweep.test.ts` and `tests/features/orphan-offer-agreement.test.ts`
 * and were a DEBT entry in `duplicateImplementationsTestsBaseline.json`; the
 * deletion slice touched both (the whole-spine row write they rode is gone),
 * which changed the shared body and forced the question — so the copies are
 * FOLDED here and the baseline line is DELETED rather than re-blessed.
 *
 * The premise is where the wiki-links live, which is what both sweeps read.
 */
export async function proseModuleFixture(
  campaignId: Id,
  title: string,
  premise: string,
): Promise<Module> {
  const module = createModule({
    campaignId,
    title,
    concept: '',
    levelMin: 1,
    levelMax: 3,
    sizeDial: 'sketch',
  });
  return saveModule({
    ...module,
    spine: {
      premise,
      themes: [],
      writerModel: '',
      origin: null,
      partPlan: [
        {
          title: 'The Seal',
          levelBand: '1–2',
          synopsis: 'Reach the seal.',
          levelUpTrigger: 'The seal breaks.',
        },
      ],
    },
  });
}
