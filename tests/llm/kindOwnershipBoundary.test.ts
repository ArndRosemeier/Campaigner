import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { saveModule } from '@/db/moduleRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { createModule, type Campaign, type Module, type PersonaRun } from '@/domain';
import { runEntityBatch } from '@/features/modules/entity-batch';
import { buildEntityBrief, type StubKind } from '@/features/modules/persona-request';
import type * as runEngineModule from '@/llm/runEngine';
import { useProgressStore } from '@/lib/progress';
import { clearDatabase } from '../db/helpers';

/**
 * THE KIND OWNERSHIP BOUNDARY (docs/17 row 140).
 *
 * The owner's report, verbatim: *"In my module, a few of the Location Details
 * Detail the Mobs that appear there and even give GM hints on how to handle
 * the Encounter there. Thats not what Location Details are for. We have
 * Encounters for that."*
 *
 * The cause was structural, not model disobedience: `buildEntityBrief` is ONE
 * brief for all six kinds with no location-specific contract, and the module's
 * scene blocks are written from the ENCOUNTER's point of view (`Where`, "If the
 * party acts", `Secrets`, `Outcome` are GM-facing field labels) while the brief
 * hands a location every paragraph that mentions it plus "make this entity
 * serve the module text". The one clause that existed was written for exactly
 * this case (`fe1d365`) but it lived in the persona text — a STORED row seeded
 * once, so no existing install ever received it. The rule therefore moves into
 * CODE, keyed by KIND, at the ONE seam every entity detail passes through.
 *
 * WHAT THESE PINS DO AND DO NOT PROVE. They prove the paragraph is in the bytes
 * of a location/event/faction brief and absent from an npc/encounter/note one,
 * and that the production batch seam actually passes its kind. They CANNOT show
 * that a model obeys the paragraph: that is UNPROVEN and can only be seen by
 * regenerating a location and reading the result (docs/17 row 140 states what
 * to look for).
 */

const { startRunMock, waitForRunStatusMock } = vi.hoisted(() => ({
  startRunMock: vi.fn(),
  waitForRunStatusMock: vi.fn(),
}));

// The engine is faked because the brief STRING is the assertion target; the
// withdrawal predicate is the REAL one (entity-batch reads it to tell an owner
// stop from a failure), exactly as `tests/features/entity-batch-fixed-cast`
// does at this same seam.
vi.mock('@/llm/runEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof runEngineModule>();
  return {
    isRunWithdrawn: actual.isRunWithdrawn,
    runNotCompletedReason: actual.runNotCompletedReason,
    runEngine: { on: () => () => undefined, startRun: startRunMock },
    waitForRunStatus: waitForRunStatusMock,
  };
});

vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

/**
 * The two boundary paragraphs, BY LITERAL — the contract's bytes, not an
 * imported constant, so a reword has to be deliberate on both sides. A revert
 * that drops the paragraph (or keys it wrong) fails every pin below.
 */
const PLACE_BOUNDARY =
  `What this artifact OWNS — one fact, one owner: the module prose draws this line itself ("encounters live in separate encounter artifacts"), so the OPPOSITION belongs to the encounter artifact — its creatures, their counts, its tactics and how the fight is run are that artifact's content, and that is where a GM gets them. If the story needs the opposition, point at where it is fought by the name the module text's own wiki-link uses instead of describing the opposition here, and write no tactics, no encounter-handling advice and no GM guidance on running the fight. "inhabitants" means the people and factions who are here — never monsters. And when the module text you are given is written from the encounter's point of view (fields such as "If the party acts", "Secrets" or "Outcome"), that material belongs to that encounter: do not restate it, do not extend it, and do not turn it into this artifact's own detail.`;

const FACTION_BOUNDARY =
  `What this artifact OWNS — one fact, one owner: the module prose draws this line itself ("encounters live in separate encounter artifacts"), so the OPPOSITION belongs to the encounter artifact — its creatures, their counts, its tactics and how the fight is run are that artifact's content, and that is where a GM gets them. If the story needs the opposition, point at where it is fought by the name the module text's own wiki-link uses instead of describing the opposition here, and write no tactics, no encounter-handling advice and no GM guidance on running the fight. A faction row owns what this faction wants, how it operates, what it controls and how it is ranked — the "order of battle" the module text asks for is the encounter's material, so write no preferred tactics and no encounter-handling advice for it. And when the module text you are given is written from the encounter's point of view (fields such as "If the party acts", "Secrets" or "Outcome"), that material belongs to that encounter: do not restate it, do not extend it, and do not turn it into this artifact's own detail.`;

/** The reported case, as the module text actually writes it: an ENCOUNTER scene
 * block whose fields are GM-facing, mentioning the location in `Where`. */
const ENCOUNTER_SCENE_BLOCK = [
  '### [[The Ash Gate]] — ENCOUNTER',
  '',
  '**Where** — [[The Ash Gate]], the salt-eaten gate below the harbor.',
  '',
  '**First impression** — Water hisses over black stone and the winch chain is gone.',
  '',
  '**If the party acts** — Four risen dockhands seize the winch: two hold the chain, two drag the barge across the gap.',
  '',
  '**Secrets** — The gate warden rigged the winch to drop the chain on a word.',
  '',
  '**Outcome** — Success, the barge crosses. Failure, the chain drops and the fight continues on the mud.',
].join('\n');

const PREMISE = 'A drowned chapel hides a cult.';

/** Every kind, with the paragraph the kind is expected to render (null = none).
 * EXHAUSTIVE over `StubKind` on purpose: a seventh kind must decide. */
const BOUNDARY_BY_KIND: Readonly<Record<StubKind, string | null>> = {
  npc: null,
  encounter: null,
  note: null,
  location: PLACE_BOUNDARY,
  event: PLACE_BOUNDARY,
  faction: FACTION_BOUNDARY,
};

describe('buildEntityBrief: the ownership boundary is keyed by KIND', () => {
  it('a LOCATION brief carries the boundary — and still carries the encounter scene it was handed', () => {
    const brief = buildEntityBrief(
      'The Ash Gate',
      ENCOUNTER_SCENE_BLOCK,
      PREMISE,
      undefined,
      [],
      false,
      'location',
    );
    expect(brief.endsWith(PLACE_BOUNDARY)).toBe(true);
    // The clause that produced the owner's report, named as he named it.
    expect(brief).toContain('the OPPOSITION belongs to the encounter artifact');
    expect(brief).toContain('one fact, one owner');
    expect(brief).toContain('point at where it is fought by the name the module text');
    expect(brief).toContain('no tactics, no encounter-handling advice and no GM guidance on running the fight');
    expect(brief).toContain('"inhabitants" means the people and factions who are here — never monsters');
    // The reported case: the encounter's own field vocabulary, refused by name.
    expect(brief).toContain('"If the party acts", "Secrets" or "Outcome"');
    expect(brief).toContain('do not restate it, do not extend it');
    // The reason is the module's OWN stated principle, cited rather than
    // reinvented (`promptStyles.PARTS_MECHANICS`).
    expect(brief).toContain('encounters live in separate encounter artifacts');
    // NOT a filter: the context paragraphs are the module's ground truth and
    // arrive byte-identical (docs/17 row 140 — the fix is about ownership,
    // never about what the worker may read).
    expect(brief).toContain(ENCOUNTER_SCENE_BLOCK);
    expect(brief).toContain('Where it is mentioned:');
  });

  it('an EVENT brief carries the SAME bytes (its draft contract IS the location’s)', () => {
    const args = ['The Ash Gate', ENCOUNTER_SCENE_BLOCK, PREMISE, undefined] as const;
    const location = buildEntityBrief(...args, [], false, 'location');
    const event = buildEntityBrief(...args, [], false, 'event');
    expect(event).toBe(location);
    expect(event.endsWith(PLACE_BOUNDARY)).toBe(true);
  });

  it('a FACTION brief carries its own boundary: what a faction owns, never how it fights', () => {
    const brief = buildEntityBrief(
      'The Salt League',
      `${ENCOUNTER_SCENE_BLOCK}\n\nThe [[The Salt League]] crew the barge and favour the warden.`,
      PREMISE,
      undefined,
      [],
      false,
      'faction',
    );
    expect(brief.endsWith(FACTION_BOUNDARY)).toBe(true);
    expect(brief).toContain('the OPPOSITION belongs to the encounter artifact');
    expect(brief).toContain('A faction row owns what this faction wants, how it operates, what it controls and how it is ranked');
    expect(brief).toContain('the "order of battle" the module text asks for is the encounter\'s material');
    expect(brief).toContain('write no preferred tactics');
    expect(brief).toContain('"If the party acts", "Secrets" or "Outcome"');
    // The location-only clause stays out of a faction brief (its draft carries
    // no `inhabitants` field).
    expect(brief).not.toContain('"inhabitants" means');
  });

  it('renders the boundary LAST, and the change instruction still rides after it', () => {
    const args = ['The Ash Gate', ENCOUNTER_SCENE_BLOCK, PREMISE, undefined] as const;
    const brief = buildEntityBrief(...args, [], false, 'location', 'Move it upstream.');
    expect(brief).toContain(PLACE_BOUNDARY);
    expect(brief.endsWith('\n\nAdditional instruction: Move it upstream.')).toBe(true);
    // One instruction, one paragraph, and the boundary is not spliced into it.
    expect(brief).toContain(`${PLACE_BOUNDARY}\n\nAdditional instruction: Move it upstream.`);
  });

  it('the OTHER three kinds append exactly their paragraph — the opt-in is per kind, never a blanket', () => {
    const args = ['The Sunken Bridge', ENCOUNTER_SCENE_BLOCK, PREMISE, 3, [], true] as const;
    const withoutKind = buildEntityBrief(...args);
    for (const kind of ['location', 'event', 'faction'] as const) {
      expect(buildEntityBrief(...args, kind)).toBe(`${withoutKind}\n\n${BOUNDARY_BY_KIND[kind] ?? ''}`);
    }
    // location and event share ONE constant (`eventDraftSchema` IS the
    // location's), so a reword cannot drift them apart.
    expect(BOUNDARY_BY_KIND.location).toBe(BOUNDARY_BY_KIND.event);
  });
});

describe('buildEntityBrief: the kinds that own their boundary render the PRE-boundary bytes', () => {
  /**
   * These pins are deliberately PURE (no positive assertion about the opted-in
   * kinds), so the injection proof is readable: disabling the boundary for
   * `location`/`event`/`faction` leaves every pin in this block GREEN — the
   * npc/encounter/note bytes never notice (docs/17 row 140).
   */
  it.each(['npc', 'encounter', 'note'] as const)(
    'a %s brief is BYTE-IDENTICAL with and without its kind',
    (kind) => {
      const args = ['The Sunken Bridge', ENCOUNTER_SCENE_BLOCK, PREMISE, 3, [], true] as const;
      const brief = buildEntityBrief(...args, kind);
      expect(brief).toBe(buildEntityBrief(...args));
      expect(brief).not.toContain('the OPPOSITION belongs to the encounter artifact');
      expect(brief).not.toContain('What this artifact OWNS');
      // Nothing about the rest of the brief moves: the scene framing and the
      // standing instructions are the bytes they always were.
      expect(brief).toContain('The scene this encounter must stage');
      expect(brief.endsWith('make this entity serve the module text.')).toBe(true);
    },
  );

  it('an omitted kind is the same bytes as `npc` for any argument shape', () => {
    const args = ['The Gray Nun', 'context', PREMISE, undefined] as const;
    const withoutKind = buildEntityBrief(...args);
    expect(withoutKind).toBe(buildEntityBrief(...args, [], false, 'npc'));
    expect(withoutKind).not.toContain('What this artifact OWNS');
  });
});

// --- the production seam: the batch must PASS its kind ----------------------

function completedWith(artifactId: string): PersonaRun {
  return { status: 'completed', resultArtifactId: artifactId, errorMessage: '' } as unknown as PersonaRun;
}

function briefs(): string[] {
  return startRunMock.mock.calls.map((call) => {
    const input = call[0] as { brief?: unknown };
    return typeof input.brief === 'string' ? input.brief : '';
  });
}

/**
 * A module written the way the owner's is: a scene block tagged ENCOUNTER that
 * mentions the location and the faction in its GM-facing fields.
 */
async function seedModule(): Promise<{ campaign: Campaign; module: Module }> {
  const campaign = await createCampaign({ name: 'Ash Campaign', system: 'dnd5e' });
  const draft = createModule({
    campaignId: campaign.id,
    title: 'The Salt Gate Module',
    concept: 'A gate the tide owns.',
    levelMin: 1,
    levelMax: 1,
    tone: '',
    sizeDial: 'standard',
  });
  const module = await saveModule({
    ...draft,
    status: 'ready',
    entityNamesNormalized: true,
    entityKinds: [
      { name: 'The Ash Gate', kind: 'location', absorbed: [] },
      { name: 'The Salt League', kind: 'faction', absorbed: [] },
    ],
    spine: {
      premise: PREMISE,
      themes: [],
      writerModel: '',
      origin: null,
      partPlan: [{ title: 'The Gate', levelBand: '1', synopsis: '', levelUpTrigger: '' }],
    },
    parts: [
      {
        planIndex: 0,
        markdown: ENCOUNTER_SCENE_BLOCK,
        status: 'ready',
        errorMessage: '',
        edited: false,
        writerModel: '',
        origin: null,
      },
    ],
  });
  await seedBuiltInPersonas();
  return { campaign, module };
}

/** An artifact for the kind under test, so the faked engine can report it as
 * the run's destination (the batch name-aligns what it is handed). */
async function seedArtifact(
  campaignId: string,
  moduleId: string,
  kind: 'location' | 'event' | 'faction',
  name: string,
): Promise<string> {
  const data =
    kind === 'faction'
      ? { goals: 'Own the gate.', methods: 'Tolls.', resources: 'Barges.', ranks: [] }
      : { locationType: 'Gate', inhabitants: '', pointsOfInterest: [], hooks: [] };
  const row = await createArtifact({
    campaignId,
    moduleId,
    kind,
    name,
    summary: '',
    body: 'The module text.',
    links: [],
    data,
  });
  return row.id;
}

describe('runEntityBatch: the brief the production seam builds carries the boundary', () => {
  beforeEach(async () => {
    await clearDatabase();
    useProgressStore.getState().reset();
    startRunMock.mockReset();
    waitForRunStatusMock.mockReset();
  });

  it.each([
    ['location', 'The Ash Gate'],
    ['event', 'The Ash Gate'],
    ['faction', 'The Salt League'],
  ] as const)('a %s batch passes its kind through to buildEntityBrief', async (kind, name) => {
    const { campaign, module } = await seedModule();
    const artifactId = await seedArtifact(campaign.id, module.id, kind, name);
    startRunMock.mockResolvedValue('run-1');
    waitForRunStatusMock.mockResolvedValue(completedWith(artifactId));

    const result = await runEntityBatch({ module, campaign, kind, targets: [{ name }] });

    expect(result.failed).toEqual([]);
    expect(startRunMock).toHaveBeenCalledTimes(1);
    const brief = briefs()[0] ?? '';
    expect(brief).toContain(BOUNDARY_BY_KIND[kind] ?? '');
    expect(brief.endsWith(BOUNDARY_BY_KIND[kind] ?? '')).toBe(true);
    // The seam still hands the worker the module text it must read.
    expect(brief).toContain('If the party acts');
  });

  it.each([
    ['npc', 'The Ash Gate', 'Where it is mentioned:'],
    ['encounter', 'The Ash Gate', 'The scene this encounter must stage'],
  ] as const)('a %s batch brief stays free of the boundary', async (kind, name, contextLabel) => {
    const { campaign, module } = await seedModule();
    const artifactId = await seedArtifact(
      campaign.id,
      module.id,
      kind === 'encounter' ? 'event' : 'location',
      name,
    );
    startRunMock.mockResolvedValue('run-1');
    waitForRunStatusMock.mockResolvedValue(completedWith(artifactId));

    await runEntityBatch({ module, campaign, kind, targets: [{ name }] });

    const [brief] = briefs();
    expect(brief).not.toContain('the OPPOSITION belongs to the encounter artifact');
    expect(brief).toContain(contextLabel);
  });
});
