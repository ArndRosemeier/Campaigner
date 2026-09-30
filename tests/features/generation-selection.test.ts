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
import { adoptionArenaLayout } from '../helpers/battle-map-fixtures';

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
].map((entry) => ({
  ...entry,
  absorbed: [],
  // STRICT LEVELS (docs/17 row 401): an NPC is generated only with a STATED level.
  ...(entry.kind === 'npc' ? { levelHint: 3 } : {}),
}));

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
      imageKinds: [],
      levelRange: { min: 1, max: 3 },
      encounterExtras: { battlemaps: false, mobPortraits: false },
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
      kinds: ['npc', 'location'],
      imageKinds: ['npc'],
      levelRange: { min: 1, max: 3 },
      encounterExtras: { battlemaps: false, mobPortraits: false },
    });

    expect(selection.detail.map((target) => target.name)).toEqual([
      'Mira',
      'Ash Gate',
      'Old Keep',
      'High Hall',
    ]);
    expect(selection.images.map((target) => target.name)).toEqual(['Kael']);
    // MIGRATED (docs/17 row 406): the plan also counts the image Mira's own
    // detail pass will unlock — 4 details + Kael's image + Mira's pending image.
    // `images` keeps its existing-work meaning; the pending half is its own list.
    expect(selection.pendingImages.map((target) => target.name)).toEqual(['Mira']);
    expect(selection.totalCount).toBe(6);
  });
});

describe('per-kind images (docs/17 row 397)', () => {
  it('returns image targets only for kinds whose toggle is on, and the count follows', () => {
    const module = moduleFixture();
    const artifacts: AnyArtifact[] = ['npc', 'location'].map((kind, index) =>
      createArtifact({
        campaignId: module.campaignId,
        moduleId: module.id,
        kind: kind as 'npc' | 'location',
        name: ['Kael', 'Ash Gate'][index] ?? '',
        summary: '',
        body: '',
      }),
    );
    const pick = (imageKinds: ('npc' | 'location')[]) =>
      selectGenerationTargets({
        module,
        artifacts,
        kinds: ['npc', 'location'],
        imageKinds,
        levelRange: { min: 1, max: 3 },
        encounterExtras: { battlemaps: false, mobPortraits: false },
      });
    expect(pick([]).images).toEqual([]);
    expect(pick(['npc']).images.map((t) => t.name)).toEqual(['Kael']);
    expect(pick(['location']).images.map((t) => t.name)).toEqual(['Ash Gate']);
    // MIGRATED (docs/17 row 406): toggling a kind now also counts the pending
    // image for each entity this run's detail pass creates (npc: Mira;
    // location: Old Keep + High Hall). 5 = 1 existing + 1 pending for npc, 2 + 3
    // for both kinds.
    expect(pick(['npc', 'location']).totalCount - pick([]).totalCount).toBe(5);
  });
});

describe('the pending projection (docs/17 row 406)', () => {
  it('counts an image for each entity the run will create, and stops counting once it exists', () => {
    const module = moduleFixture();
    const plan = selectGenerationTargets({
      module,
      artifacts: [],
      kinds: ['npc', 'location'],
      imageKinds: ['location'],
      levelRange: { min: 1, max: 3 },
      encounterExtras: { battlemaps: false, mobPortraits: false },
    });
    // Nothing exists yet: all 5 names are details, and the 3 locations are the
    // images the detail pass will unlock.
    expect(plan.detail).toHaveLength(5);
    expect(plan.images).toEqual([]);
    expect(plan.pendingImages.map((target) => target.name)).toEqual([
      'Ash Gate',
      'Old Keep',
      'High Hall',
    ]);
    expect(plan.totalCount).toBe(8);

    // The SAME derivation run again after a successful detail pass: the pending
    // half is empty and `images` is exactly the work the run enqueues — the
    // announced count and the actual count are the same number.
    const after = moduleFixture();
    const artifacts: AnyArtifact[] = ['Kael', 'Mira'].map((name) =>
      createArtifact({
        campaignId: after.campaignId,
        moduleId: after.id,
        kind: 'npc',
        name,
        summary: '',
        body: '',
      }),
    );
    artifacts.push(
      ...['Ash Gate', 'Old Keep', 'High Hall'].map((name) =>
        createArtifact({
          campaignId: after.campaignId,
          moduleId: after.id,
          kind: 'location',
          name,
          summary: '',
          body: '',
        }),
      ),
    );
    const actual = selectGenerationTargets({
      module: after,
      artifacts,
      kinds: ['npc', 'location'],
      imageKinds: ['location'],
      levelRange: { min: 1, max: 3 },
      encounterExtras: { battlemaps: false, mobPortraits: false },
    });
    expect(actual.detail).toEqual([]);
    expect(actual.pendingImages).toEqual([]);
    expect(actual.images.map((target) => target.name)).toEqual([
      'Ash Gate',
      'Old Keep',
      'High Hall',
    ]);
    expect(actual.totalCount).toBe(plan.totalCount - 5);
  });

  it('counts a battlemap and a portrait for an encounter the run will create ONLY when ticked', () => {
    const base = moduleFixture();
    const module: Module = {
      ...base,
      entityKinds: [
        ...base.entityKinds,
        { name: 'Ash Fight', kind: 'encounter', absorbed: [], levelHint: 3 },
      ],
      parts: base.parts.map((part, index) =>
        index === 0 ? { ...part, markdown: `${part.markdown} [[Ash Fight]]` } : part,
      ),
    };
    const pick = (battlemaps: boolean, mobPortraits: boolean) =>
      selectGenerationTargets({
        module,
        artifacts: [],
        kinds: ['encounter'],
        imageKinds: [],
        levelRange: { min: 1, max: 3 },
        encounterExtras: { battlemaps, mobPortraits },
      });
    // The encounter does not exist yet: the plan counts it once per ticked extra.
    expect(pick(false, false).totalCount).toBe(1);
    expect(pick(false, false).pendingEncounters.map((target) => target.name)).toEqual(['Ash Fight']);
    expect(pick(true, false).totalCount).toBe(2);
    expect(pick(false, true).totalCount).toBe(2);
    expect(pick(true, true).totalCount).toBe(3);
  });
});

describe('the dialog vocabulary', () => {
  it('has the six entity kinds, in the domain order (images are per kind, row 397)', () => {
    expect(GENERATION_KINDS).toEqual(['npc', 'location', 'event', 'faction', 'note', 'encounter']);
    expect(GENERATION_KINDS.map(generationKindLabel)).toEqual([
      'NPC',
      'Location',
      'Event',
      'Faction',
      'Note',
      'Encounter',
    ]);
  });
});

/**
 * THE OVERWRITE BOX (docs/17 row 422). The owner's words: *"an overwrite
 * checkbox … so that when checked, all selected details that were already there
 * get removed and generated freshly. This is needed for model evaluation."* The
 * seam's half of that: with the box on, the SAME selection also covers what
 * already exists and reports it separately (the dialog names it before anything
 * runs); with it off, nothing changes.
 */
describe('the overwrite box (docs/17 row 422)', () => {
  const COVER = '00000000-0000-4000-8000-00000000c0de';
  const MAP = '00000000-0000-4000-8000-0000000000aa';

  /** The harbor module plus one encounter, and a world where most of it exists. */
  function world(): { module: Module; artifacts: AnyArtifact[] } {
    const base = moduleFixture();
    const module: Module = {
      ...base,
      entityKinds: [
        ...base.entityKinds,
        { name: 'Ash Fight', kind: 'encounter', absorbed: [], levelHint: 3 },
      ],
      parts: base.parts.map((part, index) =>
        index === 0 ? { ...part, markdown: `${part.markdown} [[Ash Fight]]` } : part,
      ),
    };
    const own = (kind: 'npc' | 'location', name: string, coverImageId?: string): AnyArtifact =>
      createArtifact({
        campaignId: module.campaignId,
        moduleId: module.id,
        kind,
        name,
        summary: 'Already written.',
        body: '',
        ...(coverImageId === undefined ? {} : { coverImageId, imageIds: [coverImageId] }),
      });
    const blank = createArtifact({
      campaignId: module.campaignId,
      moduleId: module.id,
      kind: 'encounter',
      name: 'Ash Fight',
      summary: 'Goblins at the gate.',
      body: '',
    });
    if (blank.kind !== 'encounter') throw new Error('fixture: not an encounter');
    // Mapped (layout + map) and rostered: an existing battlemap AND portrait work.
    const encounter: AnyArtifact = {
      ...blank,
      imageIds: [MAP],
      data: {
        ...blank.data,
        layout: adoptionArenaLayout('4:3'),
        mapImageId: MAP,
        monsters: [
          { name: 'Goblin', count: 2, notes: '', treasure: '', source: { type: 'none' } },
        ],
      },
    };
    const artifacts: AnyArtifact[] = [
      own('npc', 'Kael', COVER),
      own('location', 'Ash Gate'),
      // Mira resolves, but to a CAMPAIGN-level row this module does not own.
      createArtifact({
        campaignId: module.campaignId,
        kind: 'npc',
        name: 'Mira',
        summary: 'Already written elsewhere.',
        body: '',
      }),
      encounter,
    ];
    return { module, artifacts };
  }

  /** Ids are minted per call, so every comparison reads ONE world. */
  const fixed = world();
  const pick = (overwrite?: boolean) => {
    const { module, artifacts } = fixed;
    return selectGenerationTargets({
      module,
      artifacts,
      kinds: ['npc', 'location', 'encounter'],
      imageKinds: ['npc', 'location'],
      levelRange: { min: 1, max: 3 },
      encounterExtras: { battlemaps: true, mobPortraits: true },
      ...(overwrite === undefined ? {} : { overwrite }),
    });
  };

  it('OFF (absent or false) leaves the selection exactly as it was and replaces nothing', () => {
    const absent = pick();
    const off = pick(false);
    expect(off).toEqual(absent);
    expect(off.overwrites).toEqual({ details: [], images: [], maps: [], mobPortraits: [], kept: [] });
    // The additive run still sees only the missing work.
    expect(off.detail.map((target) => target.name)).toEqual(['Old Keep', 'High Hall']);
    expect(off.maps).toEqual([]);
    expect(off.mobPortraits.map((target) => target.name)).toEqual(['Ash Fight']);
  });

  it('ON covers every selected name that already exists, reported per kind of work', () => {
    const off = pick(false);
    const on = pick(true);
    const { artifacts } = fixed;
    const idOf = (name: string) => artifacts.find((artifact) => artifact.name === name)?.id;

    // Details: this module's own detailed rows, each with the row it regenerates.
    expect(on.overwrites.details.map((target) => [target.name, target.artifactId])).toEqual([
      ['Kael', idOf('Kael')],
      ['Ash Gate', idOf('Ash Gate')],
      ['Ash Fight', idOf('Ash Fight')],
    ]);
    // A row this module only LINKS to is named, never silently regenerated.
    expect(on.overwrites.kept).toEqual([
      {
        name: 'Mira',
        kind: 'npc',
        reason: 'not this module’s own entity — change it where it lives',
      },
    ]);
    // Images: only rows with a COVER to replace (Ash Gate has none — it stays
    // ordinary additive image work).
    expect(on.overwrites.images.map((target) => target.name)).toEqual(['Kael']);
    expect(on.images.map((target) => target.name)).toEqual(off.images.map((target) => target.name));
    // The mapped encounter is a redraw; its portraits are a replace-all, and it
    // is NOT also counted as a fill (one encounter, one portrait job).
    expect(on.overwrites.maps.map((target) => target.artifactId)).toEqual([idOf('Ash Fight')]);
    expect(on.overwrites.mobPortraits.map((target) => target.artifactId)).toEqual([idOf('Ash Fight')]);
    expect(on.mobPortraits).toEqual([]);
    // The additive work is untouched, and the announced count is TRUE: the old
    // count, minus the fill the replace-all absorbed, plus every overwrite job.
    expect(on.detail).toEqual(off.detail);
    expect(on.totalCount).toBe(off.totalCount - 1 + 3 + 1 + 1 + 1);
  });

  it('an unticked extra replaces nothing of its kind', () => {
    const { module, artifacts } = fixed;
    const on = selectGenerationTargets({
      module,
      artifacts,
      kinds: ['npc', 'location', 'encounter'],
      imageKinds: [],
      levelRange: { min: 1, max: 3 },
      encounterExtras: { battlemaps: false, mobPortraits: false },
      overwrite: true,
    });
    expect(on.overwrites.images).toEqual([]);
    expect(on.overwrites.maps).toEqual([]);
    expect(on.overwrites.mobPortraits).toEqual([]);
    expect(on.overwrites.details).toHaveLength(3);
  });
});
