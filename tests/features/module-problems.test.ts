import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { createArtifact, listGlobalArtifacts, publishToLibrary } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { saveModule } from '@/db/moduleRepo';
import {
  createModule,
  encounterFloorGuardrailSchema,
  modulePartSchema,
  moduleSpineSchema,
  type AnyArtifact,
  type Module,
} from '@/domain';
import {
  deriveModuleProblems,
  moduleHasProblems,
  PREMISE_WHERE,
} from '@/features/modules/module-problems';
import { clearDatabase } from '../db/helpers';

/**
 * "Fix module problems" visibility (docs/08 §M4-B-3, docs/05 §Module canvas):
 * the button exists exactly when the DERIVED problem set of the module TEXT is
 * non-empty — no stored flag, and the two detectors are the repo's own (the
 * encounter floor per level band, and the reader's unresolved wiki-links).
 * The text-vs-entity boundary is pinned here too: an unresolved name is
 * DETECTED and reported, never turned into an entity job by this action.
 */

/** A module row with a two-part plan and caller-supplied part texts. */
async function seedModule(overrides: Partial<Module> = {}): Promise<Module> {
  const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
  const base = createModule({
    campaignId: campaign.id,
    title: 'Ember Crypt',
    concept: 'A drowned crypt beneath the harbor.',
    levelMin: 1,
    levelMax: 2,
    sizeDial: 'sketch',
  });
  return saveModule({
    ...base,
    status: 'ready',
    entityNamesNormalized: true,
    spine: moduleSpineSchema.parse({
      premise: 'The gate of [[Ember Crypt]] opens at dusk.',
      themes: [],
      partPlan: [
        { title: 'The Tide Gate', levelBand: '1', synopsis: '', levelUpTrigger: '' },
        { title: 'Under the Docks', levelBand: '2', synopsis: '', levelUpTrigger: '' },
      ],
    }),
    parts: [
      modulePartSchema.parse({
        planIndex: 0,
        status: 'ready',
        markdown: '## The Tide Gate\n\nThe party forces [[Ash Gate]] at dusk.',
        edited: false,
        errorMessage: '',
      }),
      modulePartSchema.parse({
        planIndex: 1,
        status: 'ready',
        markdown: '## Under the Docks\n\nThe drowned stair goes down.',
        edited: false,
        errorMessage: '',
      }),
    ],
    ...overrides,
  });
}

/** The floor the owner recorded (1 encounter per level; the default). */
const ONE_PER_LEVEL = encounterFloorGuardrailSchema.parse({ enabled: true, perLevel: 1 });

beforeEach(clearDatabase);

describe('deriveModuleProblems — the encounter floor detector', () => {
  it('is empty (button hidden) for a module whose text meets its floor', async () => {
    const module = await seedModule({
      encounterFloorGuardrail: ONE_PER_LEVEL,
      entityKinds: [
        { name: 'Ash Gate', kind: 'encounter', absorbed: [] },
        { name: 'Drowned Stair', kind: 'encounter', absorbed: [] },
        { name: 'Ember Crypt', kind: 'location', absorbed: [] },
      ],
      parts: [
        modulePartSchema.parse({
          planIndex: 0,
          status: 'ready',
          markdown: '## The Tide Gate\n\nThe party forces [[Ash Gate]].',
          edited: false,
          errorMessage: '',
        }),
        modulePartSchema.parse({
          planIndex: 1,
          status: 'ready',
          markdown: '## Under the Docks\n\nThey break [[Drowned Stair]].',
          edited: false,
          errorMessage: '',
        }),
      ],
    });
    const artifacts = [
      await createArtifact({ campaignId: module.campaignId, kind: 'encounter', name: 'Ash Gate' }),
      await createArtifact({ campaignId: module.campaignId, kind: 'encounter', name: 'Drowned Stair' }),
      await createArtifact({ campaignId: module.campaignId, kind: 'location', name: 'Ember Crypt' }),
    ];

    const problems = deriveModuleProblems(module, artifacts);

    expect(problems.problems).toEqual([]);
    expect(moduleHasProblems(problems)).toBe(false);
  }, 30_000);

  it('reports the deficient part with its band numbers (button visible)', async () => {
    const module = await seedModule({
      encounterFloorGuardrail: ONE_PER_LEVEL,
      entityKinds: [{ name: 'Ash Gate', kind: 'encounter', absorbed: [] }],
    });

    const problems = deriveModuleProblems(module, []);

    expect(moduleHasProblems(problems)).toBe(true);
    // Part 2 (band 2, one level) is short; part 1 meets its band.
    expect(problems.repairable).toHaveLength(1);
    const problem = problems.repairable[0];
    expect(problem?.planIndex).toBe(1);
    expect(problem?.check).toBe('encounter-floor');
    expect(problem?.levelBand).toBe('2');
    expect(problem?.required).toBe(1);
    expect(problem?.found).toBe(0);
    expect(problem?.moduleTotal).toBe(false);
    expect(problem?.handEdited).toBe(false);
    // The confirmation line names the part, the band and both numbers.
    expect(problem?.label).toContain('Part 2 — Under the Docks');
    expect(problem?.label).toContain('band 2');
    expect(problem?.label).toContain('needs 1');
    expect(problem?.label).toContain('names 0');
  }, 30_000);

  it('flags a hand-edited deficient part as such in the confirmation line', async () => {
    const module = await seedModule({
      encounterFloorGuardrail: ONE_PER_LEVEL,
      parts: [
        modulePartSchema.parse({
          planIndex: 0,
          status: 'ready',
          markdown: '## The Tide Gate\n\nNothing happens here.',
          edited: true,
          errorMessage: '',
        }),
        modulePartSchema.parse({
          planIndex: 1,
          status: 'ready',
          markdown: '## Under the Docks\n\nThey break [[Drowned Stair]].',
          edited: false,
          errorMessage: '',
        }),
      ],
      entityKinds: [{ name: 'Drowned Stair', kind: 'encounter', absorbed: [] }],
    });

    const problems = deriveModuleProblems(module, []);

    const problem = problems.repairable.find((entry) => entry.planIndex === 0);
    expect(problem?.handEdited).toBe(true);
    expect(problem?.label).toContain('Hand-edited');
  }, 30_000);

  it('targets both parts when both bands are short', async () => {
    const module = await seedModule({
      encounterFloorGuardrail: encounterFloorGuardrailSchema.parse({
        enabled: true,
        perLevel: 2,
      }),
      entityKinds: [{ name: 'Ash Gate', kind: 'encounter', absorbed: [] }],
      parts: [
        modulePartSchema.parse({
          planIndex: 0,
          status: 'ready',
          markdown: '## The Tide Gate\n\nThe party forces [[Ash Gate]].',
          edited: false,
          errorMessage: '',
        }),
        modulePartSchema.parse({
          planIndex: 1,
          status: 'ready',
          markdown: '## Under the Docks\n\nThey force [[Ash Gate]] again.',
          edited: false,
          errorMessage: '',
        }),
      ],
    });

    const problems = deriveModuleProblems(module, []);

    // Floor: 2 per level × 2 levels = 4 distinct; the text names 1, and no
    // band is deficient (each part's own share is 2 → both ARE deficient).
    // The repeats branch is the one with every band met: pinned in the next
    // case; here both parts are short of their own share.
    expect(problems.repairable.map((entry) => entry.planIndex)).toEqual([0, 1]);
    expect(problems.repairable.every((entry) => !entry.moduleTotal)).toBe(true);
  }, 30_000);

  it('targets every part when each band is met but the module total is short', async () => {
    const module = await seedModule({
      encounterFloorGuardrail: encounterFloorGuardrailSchema.parse({
        enabled: true,
        perLevel: 2,
      }),
      // Both parts name 2 encounters each (bands met: 2 levels → 2 each), but
      // the SAME two names: the module total (4) is short.
      entityKinds: [
        { name: 'Ash Gate', kind: 'encounter', absorbed: [] },
        { name: 'Drowned Stair', kind: 'encounter', absorbed: [] },
      ],
      parts: [
        modulePartSchema.parse({
          planIndex: 0,
          status: 'ready',
          markdown: '## The Tide Gate\n\n[[Ash Gate]] and [[Drowned Stair]].',
          edited: false,
          errorMessage: '',
        }),
        modulePartSchema.parse({
          planIndex: 1,
          status: 'ready',
          markdown: '## Under the Docks\n\n[[Ash Gate]] and [[Drowned Stair]] again.',
          edited: false,
          errorMessage: '',
        }),
      ],
    });

    const problems = deriveModuleProblems(module, []);

    expect(problems.repairable.map((entry) => entry.planIndex)).toEqual([0, 1]);
    expect(problems.repairable.every((entry) => entry.moduleTotal)).toBe(true);
    expect(problems.repairable[0]?.label).toContain('names repeat across parts');
  }, 30_000);

  it('reports nothing for the floor when the module disabled it', async () => {
    const module = await seedModule({
      encounterFloorGuardrail: encounterFloorGuardrailSchema.parse({
        enabled: false,
        perLevel: 1,
      }),
    });

    expect(deriveModuleProblems(module, []).repairable).toEqual([]);
  }, 30_000);
});

describe('deriveModuleProblems — the reader’s unresolved-link detector', () => {
  it('reports a link with no entity, and never as rewritable', async () => {
    const module = await seedModule({
      encounterFloorGuardrail: encounterFloorGuardrailSchema.parse({ enabled: false, perLevel: 1 }),
      entityKinds: [{ name: 'Ash Gate', kind: 'encounter', absorbed: [] }],
    });
    const resolved = await createArtifact({
      campaignId: module.campaignId,
      kind: 'encounter',
      name: 'Ash Gate',
    });

    const problems = deriveModuleProblems(module, [resolved]);

    // [[Ember Crypt]] (premise) resolves to nothing: the reader shows it as a
    // dashed chip — a TEXT problem, reported and NOT rewritten here.
    expect(problems.reported).toHaveLength(1);
    const reported = problems.reported[0];
    expect(reported?.name).toBe('Ember Crypt');
    expect(reported?.where).toEqual([PREMISE_WHERE]);
    expect(reported?.repairable).toBe(false);
    expect(reported?.label).toContain('resolves to nothing');
    expect(reported?.label).toContain('Resume automatic module creation');
    expect(problems.repairable).toEqual([]);
  }, 30_000);

  it('lists every module-text document a phantom name appears in, once', async () => {
    const module = await seedModule({
      encounterFloorGuardrail: encounterFloorGuardrailSchema.parse({ enabled: false, perLevel: 1 }),
      entityKinds: [{ name: 'Ash Gate', kind: 'encounter', absorbed: [] }],
      parts: [
        modulePartSchema.parse({
          planIndex: 0,
          status: 'ready',
          markdown: '## The Tide Gate\n\n[[Galt]] waits by [[Ash Gate]].',
          edited: false,
          errorMessage: '',
        }),
        modulePartSchema.parse({
          planIndex: 1,
          status: 'ready',
          markdown: '## Under the Docks\n\n[[Galt]] is still waiting.',
          edited: false,
          errorMessage: '',
        }),
      ],
    });

    const problems = deriveModuleProblems(module, []);

    // [[Galt]] appears in both parts and is ONE problem naming both places;
    // the premise's [[Ember Crypt]] and part 1's [[Ash Gate]] are the other two
    // phantom names.
    expect(problems.reported.map((entry) => entry.name).sort()).toEqual([
      'Ash Gate',
      'Ember Crypt',
      'Galt',
    ]);
    const galt = problems.reported.find((entry) => entry.name === 'Galt');
    expect(galt?.where).toEqual(['part 1', 'part 2']);
    expect(galt?.label).toContain('part 1, part 2');
  }, 30_000);

  it('does not report a name a campaign or shared-library entity resolves', async () => {
    const module = await seedModule({
      encounterFloorGuardrail: encounterFloorGuardrailSchema.parse({ enabled: false, perLevel: 1 }),
      entityKinds: [{ name: 'Ash Gate', kind: 'encounter', absorbed: [] }],
      spine: moduleSpineSchema.parse({
        premise: 'The gate of [[Ember Crypt]] opens at dusk.',
        themes: [],
        partPlan: [
          { title: 'The Tide Gate', levelBand: '1', synopsis: '', levelUpTrigger: '' },
          { title: 'Under the Docks', levelBand: '2', synopsis: '', levelUpTrigger: '' },
        ],
      }),
    });
    const globalCrypt = await createArtifact({
      campaignId: module.campaignId,
      kind: 'location',
      name: 'Ember Crypt',
    });
    // The reader's pool is campaign artifacts PLUS the shared library: a
    // published row resolves its chip and therefore is not a problem.
    await publishToLibrary(globalCrypt.id);
    const artifacts: readonly AnyArtifact[] = [
      await createArtifact({ campaignId: module.campaignId, kind: 'encounter', name: 'Ash Gate' }),
      ...(await listGlobalArtifacts()),
    ];

    expect(deriveModuleProblems(module, artifacts).reported).toEqual([]);
  }, 30_000);
});

describe('deriveModuleProblems — derived, never stored', () => {
  it('flips with a hand edit and writes no field on the row', async () => {
    const module = await seedModule({
      encounterFloorGuardrail: encounterFloorGuardrailSchema.parse({ enabled: false, perLevel: 1 }),
      entityKinds: [
        { name: 'Ash Gate', kind: 'encounter', absorbed: [] },
        { name: 'Drowned Stair', kind: 'encounter', absorbed: [] },
      ],
      spine: moduleSpineSchema.parse({
        premise: 'The gate of [[Ember Crypt]] opens at dusk.',
        themes: [],
        partPlan: [
          { title: 'The Tide Gate', levelBand: '1', synopsis: '', levelUpTrigger: '' },
          { title: 'Under the Docks', levelBand: '2', synopsis: '', levelUpTrigger: '' },
        ],
      }),
      parts: [
        modulePartSchema.parse({
          planIndex: 0,
          status: 'ready',
          markdown: '## The Tide Gate\n\n[[Ash Gate]] holds.',
          edited: false,
          errorMessage: '',
        }),
        modulePartSchema.parse({
          planIndex: 1,
          status: 'ready',
          markdown: '## Under the Docks\n\n[[Drowned Stair]] waits.',
          edited: false,
          errorMessage: '',
        }),
      ],
    });
    const artifacts = [
      await createArtifact({ campaignId: module.campaignId, kind: 'encounter', name: 'Ash Gate' }),
      await createArtifact({
        campaignId: module.campaignId,
        kind: 'encounter',
        name: 'Drowned Stair',
      }),
      await createArtifact({ campaignId: module.campaignId, kind: 'location', name: 'Ember Crypt' }),
    ];

    expect(moduleHasProblems(deriveModuleProblems(module, artifacts))).toBe(false);

    // The owner edits part 2 by hand and introduces a name with no entity.
    const edited = await saveModule({
      ...module,
      parts: module.parts.map((part) =>
        part.planIndex === 1 ? { ...part, markdown: '## Under the Docks\n\n[[Nera]] waits.' } : part,
      ),
    });

    expect(moduleHasProblems(deriveModuleProblems(edited, artifacts))).toBe(true);
    // Nothing about the problem set is persisted: the row gained no verdict
    // field, and the same derivation answers from the text alone.
    expect(Object.keys(edited)).not.toContain('hasProblems');
    expect(Object.keys(edited)).not.toContain('deviates');
    expect(Object.keys(edited)).not.toContain('problems');
  }, 30_000);
});
