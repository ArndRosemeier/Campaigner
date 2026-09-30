import {
  createModule,
  modulePartSchema,
  moduleSpineSchema,
  type Id,
  type Module,
} from '@/domain';

/**
 * A module whose DOCUMENT carries `premise` plus ONE level section per entry of
 * `sections` — the shape both generation-dialog pins read (the Generate dialog
 * and its Change sibling, docs/17 row 431).
 *
 * ONE seam (AGENTS rule 4). The two dialog pins composed this body twice, which
 * the duplication tripwire caught by name
 * (`tests/architecture/no-duplicate-implementations.test.ts`); the copies are
 * FOLDED here rather than blessed with a baseline entry. The callers differ only
 * in their own options, so each keeps its own options constant.
 */
export function moduleDocumentFixture(options: {
  campaignId: Id;
  entityKinds: Module['entityKinds'];
  premise: string;
  sections: readonly string[];
}): Module {
  const base = createModule({
    campaignId: options.campaignId,
    title: 'The Harbor',
    concept: '',
    levelMin: 1,
    levelMax: 3,
    sizeDial: 'sketch',
  });
  return {
    ...base,
    entityKinds: options.entityKinds,
    spine: moduleSpineSchema.parse({
      premise: options.premise,
      themes: [],
      partPlan: options.sections.map((_, index) => ({
        title: `Level ${String(index + 1)}`,
        levelBand: String(index + 1),
        synopsis: '',
        levelUpTrigger: '',
      })),
    }),
    parts: options.sections.map((markdown, planIndex) =>
      modulePartSchema.parse({
        planIndex,
        markdown,
        status: 'ready',
        errorMessage: '',
        edited: false,
      }),
    ),
  };
}
