import { describe, expect, it } from 'vitest';

import {
  createArtifact,
  createModule,
  MODULE_PREMISE_LEVEL,
  moduleLevelList,
  modulePartSchema,
  moduleSpineSchema,
  type AnyArtifact,
  type Module,
} from '@/domain';
import {
  GENERATION_KINDS,
  generationKindLabel,
  selectGenerationTargets,
  selectLevelNames,
} from '@/features/modules/generation-selection';

/**
 * THE LEVEL-SCOPED GENERATION SELECTION (docs/23 §7, docs/17 row 394).
 *
 * The owner's request — *"a detail generation dialog with checkboxes and level
 * ranges (for example: generate everything but encounters and images for levels
 * 1-3, although 6 levels are already defined)"* — is ONE question, and these
 * pins answer it in both directions: which names a (kinds, levelRange) selection
 * covers, WHICH level each one is attributed to, and what happens to a name
 * several levels mention or to one that only the premise mentions.
 *
 * `selectLevelNames` takes the DERIVED LEVEL LIST (docs/23 §4) directly, so the
 * core pins are pure: no DB, no module row, one document string.
 */

/** The document every pin below reads — the premise plus three level sections. */
const DOC = [
  'The harbor town of [[Ash Gate]] hides the [[Drowned Gate]].',
  '=====Level 1=====',
  '[[Kael]] meets [[Mira]] at the [[Ash Gate]].',
  '=====Level 2=====',
  '[[Kael]] travels to [[Old Keep]] and hears about [[Mira]].',
  '=====Level 3=====',
  'Nothing new here but [[High Hall]].',
].join('\n\n');

/** The module's recorded kinds — ONE record per linked name. */
const ENTITY_KINDS = [
  { name: 'Ash Gate', kind: 'location' as const },
  { name: 'Drowned Gate', kind: 'location' as const },
  { name: 'Kael', kind: 'npc' as const },
  { name: 'Mira', kind: 'npc' as const },
  { name: 'Old Keep', kind: 'location' as const },
  { name: 'High Hall', kind: 'location' as const },
].map((entry) => ({ ...entry, absorbed: [] }));

function list() {
  return moduleLevelList(DOC, ENTITY_KINDS);
}

const ALL_KINDS = ['npc', 'location'] as const;

describe('selectLevelNames — the level range', () => {
  it('picks the names of the sections in the range, each from ITS OWN section', () => {
    const selection = selectLevelNames(list(), ALL_KINDS, { min: 1, max: 3 });

    expect(selection.targets.map((target) => [target.name, target.level])).toEqual([
      ['Kael', 1],
      ['Mira', 1],
      ['Ash Gate', 1],
      ['Old Keep', 2],
      ['High Hall', 3],
    ]);
    // Level 3 mentions nothing from level 1 or 2: the attribution is the
    // section's own text, never a name carried forward.
    expect(selection.levels).toEqual([
      { number: 1, count: 3 },
      { number: 2, count: 1 },
      { number: 3, count: 1 },
    ]);
  });

  it('excludes the premise by construction when the range starts at 1', () => {
    const selection = selectLevelNames(list(), ALL_KINDS, { min: 1, max: 3 });

    expect(selection.targets.some((target) => target.name === 'Drowned Gate')).toBe(false);
    expect(selection.premiseOnly).toEqual([
      { name: 'Drowned Gate', kind: 'location', level: null },
    ]);
  });

  it('narrows to a sub-range and drops a name whose FIRST mention is outside it', () => {
    const selection = selectLevelNames(list(), ALL_KINDS, { min: 2, max: 3 });

    // Kael and Mira are level-1 entities (their first mention), so levels 2–3 do
    // not pull them in even though level 2 mentions them again — the owner's
    // dedupe rule taken literally: the entity IS a level-1 entity.
    expect(selection.targets.map((target) => target.name)).toEqual(['Old Keep', 'High Hall']);
  });

  it('filters by kind', () => {
    const selection = selectLevelNames(list(), ['npc'], { min: 1, max: 3 });

    expect(selection.targets.map((target) => target.name)).toEqual(['Kael', 'Mira']);
  });
});

describe('selectLevelNames — the premise bucket (no level yet)', () => {
  it('selects a premise-only entity ONLY when the low bound is the premise', () => {
    const off = selectLevelNames(list(), ALL_KINDS, { min: 1, max: 3 });
    const on = selectLevelNames(list(), ALL_KINDS, {
      min: MODULE_PREMISE_LEVEL,
      max: 3,
    });

    expect(off.targets.some((target) => target.level === null)).toBe(false);
    expect(on.targets[0]).toEqual({ name: 'Drowned Gate', kind: 'location', level: null });
    // The bucket is NAMED either way, so the dialog can say what it left out.
    expect(on.premiseOnly).toEqual(off.premiseOnly);
    expect(on.levels[0]).toEqual({ number: MODULE_PREMISE_LEVEL, count: 1 });
  });

  it('a name the premise AND a section mention is that section entity, not a bucket entry', () => {
    const selection = selectLevelNames(list(), ALL_KINDS, {
      min: MODULE_PREMISE_LEVEL,
      max: 3,
    });

    const ashGate = selection.targets.find((target) => target.name === 'Ash Gate');
    expect(ashGate?.level).toBe(1);
    expect(selection.premiseOnly.map((target) => target.name)).toEqual(['Drowned Gate']);
  });
});

describe('selectLevelNames — the dedupe rule (owner-ratified, docs/23 §6)', () => {
  it('generates a twice-mentioned entity ONCE, at its FIRST level, and says so', () => {
    const selection = selectLevelNames(list(), ALL_KINDS, { min: 1, max: 3 });

    expect(selection.targets.filter((target) => target.name === 'Kael')).toHaveLength(1);
    expect(selection.duplicates).toEqual([
      { name: 'Kael', kind: 'npc', level: 1, laterLevels: [2] },
      { name: 'Mira', kind: 'npc', level: 1, laterLevels: [2] },
    ]);
  });

  it('reports no duplicate for a name only one level mentions', () => {
    const selection = selectLevelNames(list(), ALL_KINDS, { min: 2, max: 3 });

    expect(selection.duplicates).toEqual([]);
  });
});

/** A module whose document is `DOC`, built purely (no DB). */
function moduleFixture(): Module {
  const base = createModule({
    campaignId: '00000000-0000-4000-8000-000000000001',
    title: 'The Harbor',
    concept: '',
    levelMin: 1,
    levelMax: 3,
    sizeDial: 'sketch',
  });
  const sections = [
    '[[Kael]] meets [[Mira]] at the [[Ash Gate]].',
    '[[Kael]] travels to [[Old Keep]] and hears about [[Mira]].',
    'Nothing new here but [[High Hall]].',
  ];
  return {
    ...base,
    entityKinds: ENTITY_KINDS,
    spine: moduleSpineSchema.parse({
      premise: 'The harbor town of [[Ash Gate]] hides the [[Drowned Gate]].',
      themes: [],
      partPlan: sections.map((_, index) => ({
        title: `Level ${String(index + 1)}`,
        levelBand: String(index + 1),
        synopsis: '',
        levelUpTrigger: '',
      })),
    }),
    parts: sections.map((markdown, planIndex) =>
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

describe('selectGenerationTargets — the work sets and the announced count', () => {
  it('with no entities authored yet, every selected name needs a detail and the count is TRUE', () => {
    const module = moduleFixture();
    const selection = selectGenerationTargets({
      module,
      artifacts: [],
      kinds: ['npc', 'location'],
      levelRange: { min: 1, max: 3 },
    });

    // Ordered by level, then the domain's kind order (npc before location),
    // then name.
    expect(selection.detail.map((target) => target.name)).toEqual([
      'Kael',
      'Mira',
      'Ash Gate',
      'Old Keep',
      'High Hall',
    ]);
    expect(selection.images).toEqual([]);
    expect(selection.maps).toEqual([]);
    expect(selection.mobPortraits).toEqual([]);
    // THE SCOPE STATEMENT IS TRUE: the number the dialog prints is the sum of
    // the work it will start.
    expect(selection.totalCount).toBe(
      selection.detail.length +
        selection.images.length +
        selection.maps.length +
        selection.mobPortraits.length,
    );
    expect(selection.totalCount).toBe(5);
  });

  it('a detailed entity leaves the detail set and a cover-less one enters the image set', () => {
    const module = moduleFixture();
    const artifacts: AnyArtifact[] = [
      createArtifact({
        campaignId: module.campaignId,
        moduleId: module.id,
        kind: 'npc',
        name: 'Kael',
        summary: '',
        body: '',
      }),
    ];
    const selection = selectGenerationTargets({
      module,
      artifacts,
      kinds: ['npc', 'location', 'image'],
      levelRange: { min: 1, max: 3 },
    });

    expect(selection.detail.map((target) => target.name)).toEqual([
      'Mira',
      'Ash Gate',
      'Old Keep',
      'High Hall',
    ]);
    expect(selection.images.map((target) => target.name)).toEqual(['Kael']);
    expect(selection.totalCount).toBe(5);
  });
});

describe('the dialog vocabulary', () => {
  it('has the owner’s seven kinds, in the domain order, images last', () => {
    expect(GENERATION_KINDS).toEqual([
      'npc',
      'location',
      'event',
      'faction',
      'note',
      'encounter',
      'image',
    ]);
    expect(GENERATION_KINDS.map(generationKindLabel)).toEqual([
      'NPC',
      'Location',
      'Event',
      'Faction',
      'Note',
      'Encounter',
      'Images',
    ]);
  });
});
