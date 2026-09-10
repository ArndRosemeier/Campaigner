import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { createArtifact, listArtifactsByCampaign, updateArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { getModule, saveModule } from '@/db/moduleRepo';
import { createModule, modulePartSchema, moduleSpineSchema, type Module } from '@/domain';
import {
  automationIntentDrift,
  deriveAutomationDeviation,
  deviationIsEmpty,
  deviationLines,
  deviationWorkCount,
} from '@/features/modules/automation-deviation';
import {
  deriveModuleProblems,
  hasRewritableProblems,
  moduleHasProblems,
} from '@/features/modules/module-problems';
import { clearDatabase } from '../db/helpers';

/**
 * "Resume automatic module creation" visibility (docs/08 §M4-B-3, docs/05
 * §Module canvas): the recorded INTENT (`automationIntent`, docs/17 row 71)
 * against the live state, DERIVED at render time. Nothing is stored — pinning
 * that is the point of this file: a hand edit or a hand-deleted artifact must
 * move the button with no flag written on the row (a flag would go stale the
 * moment the owner touches anything, which is exactly why resume is derived).
 */

const npcData = { appearance: '', personality: '', statBlock: null };

async function seedModule(overrides: Partial<Module> = {}): Promise<Module> {
  const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
  const intent = {
    autoGenerateKinds: ['npc' as const],
    autoImageKinds: ['npc' as const],
    autoGenerateBattlemaps: false,
    autoGenerateMobImages: false,
  };
  const base = createModule({
    campaignId: campaign.id,
    title: 'Ember Crypt',
    concept: 'A drowned crypt beneath the harbor.',
    levelMin: 1,
    levelMax: 1,
    sizeDial: 'sketch',
    autoGenerateKinds: intent.autoGenerateKinds,
    autoImageKinds: intent.autoImageKinds,
  });
  return saveModule({
    ...base,
    status: 'ready',
    entityNamesNormalized: true,
    entityKinds: [
      { name: 'Kael', kind: 'npc', absorbed: [] },
      { name: 'Nera', kind: 'npc', absorbed: [] },
      { name: 'Ember Crypt', kind: 'location', absorbed: [] },
    ],
    spine: moduleSpineSchema.parse({
      premise: 'The gate of [[Ember Crypt]] opens at dusk.',
      themes: [],
      partPlan: [{ title: 'The Tide Gate', levelBand: '1', synopsis: '', levelUpTrigger: '' }],
    }),
    parts: [
      modulePartSchema.parse({
        planIndex: 0,
        status: 'ready',
        markdown: '## The Tide Gate\n\n[[Kael]] watches the gate. [[Nera]] counts the boats.',
        edited: false,
        errorMessage: '',
      }),
    ],
    ...overrides,
  });
}

/** The campaign's artifact list, exactly as the sweep enumerates it. */
async function campaignArtifacts(module: Module) {
  return listArtifactsByCampaign(module.campaignId);
}

beforeEach(clearDatabase);

describe('deriveAutomationDeviation', () => {
  it('is empty (button hidden) when everything the intent asked for exists', async () => {
    const module = await seedModule();
    await createArtifact({
      campaignId: module.campaignId,
      moduleId: module.id,
      kind: 'npc',
      name: 'Kael',
      summary: '',
      body: '',
      coverImageId: '00000000-0000-4000-8000-00000000a001',
      data: npcData,
    });
    await createArtifact({
      campaignId: module.campaignId,
      moduleId: module.id,
      kind: 'npc',
      name: 'Nera',
      summary: '',
      body: '',
      coverImageId: '00000000-0000-4000-8000-00000000a002',
      data: npcData,
    });

    const deviation = deriveAutomationDeviation(module, await campaignArtifacts(module));

    expect(deviation).toEqual({
      entities: [],
      unclassified: [],
      normalizationPending: false,
      images: [],
      battlemaps: [],
      mobPortraits: [],
    });
    expect(deviationIsEmpty(deviation)).toBe(true);
  }, 30_000);

  it('names the entities the text carries with no artifact, per kind', async () => {
    const module = await seedModule();

    const deviation = deriveAutomationDeviation(module, []);

    expect(deviation.entities).toEqual([{ kind: 'npc', names: ['Kael', 'Nera'] }]);
    expect(deviationIsEmpty(deviation)).toBe(false);
    expect(deviationLines(deviation)).toContain(
      '2 npcs named by the text but not generated yet: Kael, Nera',
    );
  }, 30_000);

  it('reports an image the intent asked for when the entity has none, and never when nothing is configured', async () => {
    const module = await seedModule();
    await createArtifact({
      campaignId: module.campaignId,
      moduleId: module.id,
      kind: 'npc',
      name: 'Kael',
      summary: '',
      body: '',
      data: npcData,
    });
    await createArtifact({
      campaignId: module.campaignId,
      moduleId: module.id,
      kind: 'npc',
      name: 'Nera',
      summary: '',
      body: '',
      data: npcData,
    });

    const deviation = deriveAutomationDeviation(module, await campaignArtifacts(module));
    expect(deviation.images).toEqual([{ kind: 'npc', names: ['Kael', 'Nera'] }]);
    expect(deviation.entities).toEqual([]);
    expect(deviationLines(deviation)).toContain('2 npcs without an image: Kael, Nera');

    // The intent chose no images: the missing images are not a deviation — the
    // owner never asked for them, and this control only resumes what was asked.
    const noImages = await saveModule({ ...module, automationIntent: null, autoImageKinds: [] });
    expect(
      deriveAutomationDeviation(noImages, await campaignArtifacts(noImages)).images,
    ).toEqual([]);
  }, 30_000);

  it('stays inert for a legacy row (no recorded intent) however much is missing', async () => {
    const module = await seedModule();
    const legacy = await saveModule({ ...module, automationIntent: null });

    const deviation = deriveAutomationDeviation(legacy, []);

    expect(deviationIsEmpty(deviation)).toBe(true);
    expect(deviationWorkCount(deviation)).toBe(0);
    expect(deviationLines(deviation)).toEqual([]);
  }, 30_000);

  it('reports the closed normalization gate and the names no batch can see yet', async () => {
    const module = await seedModule({
      // The owner hand-edited the text: a new name with no record.
      entityKinds: [
        { name: 'Kael', kind: 'npc', absorbed: [] },
        { name: 'Ember Crypt', kind: 'location', absorbed: [] },
      ],
      parts: [
        modulePartSchema.parse({
          planIndex: 0,
          status: 'ready',
          markdown: '## The Tide Gate\n\n[[Kael]] watches the gate. [[Mira]] waits.',
          edited: true,
          errorMessage: '',
        }),
      ],
    });

    const withGate = await saveModule({ ...module, entityNamesNormalized: false });
    const deviation = deriveAutomationDeviation(withGate, []);

    expect(deviation.normalizationPending).toBe(true);
    expect(deviation.unclassified).toEqual(['Mira']);
    expect(deviation.entities).toEqual([{ kind: 'npc', names: ['Kael'] }]);
    expect(deviationLines(deviation)[0]).toContain('not normalized for the current text');
    // The batch gate only matters when entity generation was asked for.
    const noEntityWork = await saveModule({
      ...withGate,
      automationIntent: {
        autoGenerateKinds: [],
        autoImageKinds: [],
        autoGenerateBattlemaps: false,
        autoGenerateMobImages: false,
      },
    });
    const quiet = deriveAutomationDeviation(noEntityWork, []);
    expect(quiet.normalizationPending).toBe(false);
    expect(quiet.unclassified).toEqual([]);
  }, 30_000);

  it('reports battle maps and mob portraits only for the kinds the intent asked for', async () => {
    const module = await seedModule({
      autoGenerateKinds: [],
      autoImageKinds: [],
      autoGenerateBattlemaps: true,
      autoGenerateMobImages: true,
      automationIntent: {
        autoGenerateKinds: [],
        autoImageKinds: [],
        autoGenerateBattlemaps: true,
        autoGenerateMobImages: true,
      },
      entityKinds: [{ name: 'Ash Gate', kind: 'encounter', absorbed: [] }],
      parts: [
        modulePartSchema.parse({
          planIndex: 0,
          status: 'ready',
          markdown: '## The Tide Gate\n\nThe party forces [[Ash Gate]].',
          edited: false,
          errorMessage: '',
        }),
      ],
    });
    const encounter = await createArtifact({
      campaignId: module.campaignId,
      moduleId: module.id,
      kind: 'encounter',
      name: 'Ash Gate',
      summary: '',
      body: '',
      data: {
        difficulty: 'medium',
        levelHint: '1',
        monsters: [
          {
            name: 'Goblin',
            count: 2,
            notes: '',
            treasure: '',
            source: { type: 'rulebook', chunkId: '00000000-0000-4000-8000-00000000c001' },
          },
        ],
        terrain: '',
        tactics: '',
        treasure: '',
        mapImageId: null,
        layout: null,
        preset: 'standard',
        locationKind: 'other',
        siteShape: 'single',
        budgetAdvisory: '',
      },
    });

    const deviation = deriveAutomationDeviation(module, await campaignArtifacts(module));

    expect(deviation.battlemaps).toEqual([{ id: encounter.id, name: 'Ash Gate' }]);
    // The portrait bucket carries the artifacts themselves, because that is
    // what the portrait batch entry takes.
    expect(deviation.mobPortraits.map((entry) => entry.id)).toEqual([encounter.id]);
    expect(deviation.mobPortraits.map((entry) => entry.name)).toEqual(['Ash Gate']);
    const lines = deviationLines(deviation);
    expect(lines).toContain('1 battle map missing: Ash Gate');
    expect(lines).toContain('Mob portraits missing for 1 encounter: Ash Gate');
  }, 30_000);

  it('moves with a hand-deleted artifact and stores no verdict on the row', async () => {
    const module = await seedModule();
    const kael = await createArtifact({
      campaignId: module.campaignId,
      moduleId: module.id,
      kind: 'npc',
      name: 'Kael',
      summary: '',
      body: '',
      coverImageId: '00000000-0000-4000-8000-00000000a001',
      data: npcData,
    });
    await createArtifact({
      campaignId: module.campaignId,
      moduleId: module.id,
      kind: 'npc',
      name: 'Nera',
      summary: '',
      body: '',
      coverImageId: '00000000-0000-4000-8000-00000000a002',
      data: npcData,
    });
    expect(
      deviationIsEmpty(deriveAutomationDeviation(module, await campaignArtifacts(module))),
    ).toBe(true);

    // The owner deletes Kael's cover by hand (the artifact row loses its image
    // AND the module text keeps naming it — the entity itself is still there).
    await updateArtifact(kael.id, { coverImageId: null });

    const afterDelete = deriveAutomationDeviation(module, await campaignArtifacts(module));
    expect(afterDelete.images).toEqual([{ kind: 'npc', names: ['Kael'] }]);
    expect(deviationIsEmpty(afterDelete)).toBe(false);

    // The derivation lives on the row's TEXT and INTENT only: nothing wrote a
    // verdict field to persist, so the state cannot go stale.
    const persisted = await getModule(module.id);
    expect(persisted).toBeDefined();
    const keys = Object.keys(persisted ?? {});
    expect(keys).not.toContain('deviates');
    expect(keys).not.toContain('hasProblems');
    expect(keys).not.toContain('needsWork');
    expect(keys).not.toContain('automationDeviation');
    // …and the row itself is untouched by the derivation (same object values).
    expect(persisted?.updatedAt).toBe(module.updatedAt);
  }, 30_000);

  it('turns a hand edit into missing work the resume can act on', async () => {
    const module = await seedModule();
    await createArtifact({
      campaignId: module.campaignId,
      moduleId: module.id,
      kind: 'npc',
      name: 'Kael',
      summary: '',
      body: '',
      coverImageId: '00000000-0000-4000-8000-00000000a001',
      data: npcData,
    });
    await createArtifact({
      campaignId: module.campaignId,
      moduleId: module.id,
      kind: 'npc',
      name: 'Nera',
      summary: '',
      body: '',
      coverImageId: '00000000-0000-4000-8000-00000000a002',
      data: npcData,
    });

    // The owner edits the prose by hand and links a name that has no entity.
    const edited = await saveModule({
      ...module,
      entityNamesNormalized: false,
      parts: [
        modulePartSchema.parse({
          planIndex: 0,
          status: 'ready',
          markdown:
            '## The Tide Gate\n\n[[Kael]] watches the gate. [[Nera]] counts. [[Hallow]] waits.',
          edited: true,
          errorMessage: '',
        }),
      ],
    });

    const deviation = deriveAutomationDeviation(edited, await campaignArtifacts(edited));
    expect(deviation.unclassified).toEqual(['Hallow']);
    expect(deviation.normalizationPending).toBe(true);
    expect(deviationIsEmpty(deviation)).toBe(false);
  }, 30_000);

  it('refuses to guess when the row diverges from the recorded intent', async () => {
    const module = await seedModule();

    expect(automationIntentDrift(module)).toBeNull();

    const drifted = await saveModule({ ...module, autoGenerateKinds: [] });
    expect(automationIntentDrift(drifted)).toContain('autoGenerateKinds');
  }, 30_000);
});

describe('the two actions answer different questions', () => {
  it('a healthy text with missing entity work turns on ONLY the resume control', async () => {
    // "Fix module problems" is about the PROSE: a module whose text is fine
    // (every name resolves, the floor is met) has no problem for it, while the
    // missing images the owner asked for are the resume action's business.
    const module = await saveModule(
      await seedModule({
        encounterFloorGuardrail: { enabled: true, perLevel: 1 },
        autoGenerateKinds: [],
        autoImageKinds: ['npc'],
        automationIntent: {
          autoGenerateKinds: [],
          autoImageKinds: ['npc'],
          autoGenerateBattlemaps: false,
          autoGenerateMobImages: false,
        },
        entityKinds: [
          { name: 'Kael', kind: 'npc', absorbed: [] },
          { name: 'Nera', kind: 'encounter', absorbed: [] },
          { name: 'Ember Crypt', kind: 'location', absorbed: [] },
        ],
      }),
    );
    const artifacts = [
      await createArtifact({
        campaignId: module.campaignId,
        moduleId: module.id,
        kind: 'npc',
        name: 'Kael',
        summary: '',
        body: '',
        data: npcData,
      }),
      await createArtifact({
        campaignId: module.campaignId,
        moduleId: module.id,
        kind: 'encounter',
        name: 'Nera',
        summary: '',
        body: '',
        data: {
          difficulty: 'medium',
          levelHint: '1',
          monsters: [],
          terrain: '',
          tactics: '',
          treasure: '',
          mapImageId: null,
          layout: null,
          preset: 'standard',
          locationKind: 'other',
          siteShape: 'single',
          budgetAdvisory: '',
        },
      }),
      await createArtifact({
        campaignId: module.campaignId,
        moduleId: module.id,
        kind: 'location',
        name: 'Ember Crypt',
        summary: '',
        body: '',
        data: { locationType: 'other', inhabitants: '', pointsOfInterest: [], hooks: [] },
      }),
    ];

    const problems = deriveModuleProblems(module, artifacts);
    const deviation = deriveAutomationDeviation(module, artifacts);

    // The text is healthy: no floor shortfall, every name resolves.
    expect(problems.problems).toEqual([]);
    expect(hasRewritableProblems(problems)).toBe(false);
    // Kael exists but has no image: the work the owner asked for and did not
    // get is the resume action's business.
    expect(deviation.images).toEqual([{ kind: 'npc', names: ['Kael'] }]);
    expect(deviationIsEmpty(deviation)).toBe(false);
  }, 30_000);

  it('an unresolved name is DETECTED and reported, and never drives the Fix control', async () => {
    // The reader's dashed chip ("not detailed yet") is entity work: the owner
    // placed entities outside "Fix module problems", so the detected problem is
    // reported in the confirmation but does not turn that control on.
    const module = await saveModule(
      await seedModule({
        encounterFloorGuardrail: { enabled: true, perLevel: 1 },
        // The floor is MET — [[Ash Gate]] is a recorded encounter the prose
        // names — so the only detected problems are the unresolved names.
        entityKinds: [
          { name: 'Kael', kind: 'npc', absorbed: [] },
          { name: 'Nera', kind: 'npc', absorbed: [] },
          { name: 'Ash Gate', kind: 'encounter', absorbed: [] },
          { name: 'Ember Crypt', kind: 'location', absorbed: [] },
        ],
        parts: [
          modulePartSchema.parse({
            planIndex: 0,
            status: 'ready',
            markdown:
              '## The Tide Gate\n\n[[Kael]] watches the gate and [[Nera]] counts the boats. Then [[Ash Gate]] breaks.',
            edited: false,
            errorMessage: '',
          }),
        ],
        automationIntent: {
          autoGenerateKinds: ['npc'],
          autoImageKinds: [],
          autoGenerateBattlemaps: false,
          autoGenerateMobImages: false,
        },
      }),
    );

    const problems = deriveModuleProblems(module, []);

    expect(problems.reported.map((problem) => problem.name).sort()).toEqual([
      'Ash Gate',
      'Ember Crypt',
      'Kael',
      'Nera',
    ]);
    expect(problems.repairable).toEqual([]);
    expect(moduleHasProblems(problems)).toBe(true);
    expect(hasRewritableProblems(problems)).toBe(false);
  }, 30_000);
});
