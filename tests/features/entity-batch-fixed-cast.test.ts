import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { createModule, type Campaign, type Module, type PersonaRun, type StatBlock } from '@/domain';
import { saveModule } from '@/db/moduleRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { runEntityBatch } from '@/features/modules/entity-batch';
import type * as runEngineModule from '@/llm/runEngine';
import { useProgressStore } from '@/lib/progress';
import { clearDatabase } from '../db/helpers';

/**
 * Fixed-cast glue at the batch seam (docs/11): encounter briefs build after
 * the NPC/monster results land, so the brief pins the drafted scene members
 * as fixed cast; NPC briefs carry the structured level line. The engine is
 * mocked here — the brief STRING is the assertion target (full-run behavior
 * is pinned in tests/llm/fixedCast.test.ts).
 */

const { startRunMock, waitForRunStatusMock } = vi.hoisted(() => ({
  startRunMock: vi.fn(),
  waitForRunStatusMock: vi.fn(),
}));

// The engine is faked (this file pins brief STRINGS), but the withdrawal
// predicate is the REAL one: `runEntityBatch` reads it to tell an owner stop
// from a failure (docs/17 row 117), and a mock that re-implemented that rule
// would judge the fold against a fake. The reason seam is REAL for the same
// reason (docs/18 §2, `runNotCompletedReason`): the per-entity failure pins
// below judge the sentence the site actually emits.
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

const { toastError } = await import('@/lib/toast');
const toastErrorMock = vi.mocked(toastError);

const HALVAR_STATS: StatBlock = {
  system: 'dnd5e',
  level: '6',
  size: 'Large',
  creatureType: 'giant',
  ac: 15,
  acNote: '',
  hp: 45,
  hpFormula: '6d10+12',
  speed: '30 ft.',
  abilities: { str: 18, dex: 10, con: 14, int: 8, wis: 10, cha: 8 },
  saves: '',
  skills: '',
  senses: '',
  languages: 'Giant',
  traits: [],
  actions: [{ name: 'Club', text: 'Melee Weapon Attack: +6 to hit.' }],
  reactions: [],
  legendary: [],
  extras: {},
};

async function seedWorld(): Promise<{ campaign: Campaign; module: Module; halvarId: string }> {
  const campaign = await createCampaign({ name: 'Pit Campaign', system: 'dnd5e' });
  const draft = createModule({
    campaignId: campaign.id,
    title: 'The Pit Module',
    concept: 'concept',
    levelMin: 1,
    levelMax: 1,
    tone: '',
    sizeDial: 'standard',
  });
  const module = await saveModule({
    ...draft,
    spine: {
      premise: 'Pit premise.',
      themes: [],
      writerModel: '',
      origin: null,
      partPlan: [{ title: 'Descent', levelBand: '1', synopsis: '', levelUpTrigger: '' }],
    },
    parts: [
      {
        planIndex: 0,
        markdown:
          'The pit mouth gapes. [[Halvar]] the giant stands beside ' +
          '[[The Howling Pit]], daring the party to enter.',
        status: 'ready',
        errorMessage: '',
        edited: false,
        writerModel: '',
        origin: null,
      },
    ],
  });
  // Halvar is ALREADY drafted (an earlier NPC batch landed him).
  const halvar = await createArtifact({
    campaignId: campaign.id,
    moduleId: module.id,
    kind: 'npc',
    name: 'Halvar',
    summary: 'A giant blocking the pit.',
    body: 'Halvar stands in the way.',
    links: [],
    data: { appearance: 'Huge', personality: 'Gruff', statBlock: HALVAR_STATS },
  });
  await seedBuiltInPersonas();
  return { campaign, module, halvarId: halvar.id };
}

function completedWith(artifactId: string): PersonaRun {
  return { status: 'completed', resultArtifactId: artifactId, errorMessage: '' } as unknown as PersonaRun;
}

/** A run that died on its own, with the sentence the engine composed. */
function failedWith(errorMessage: string): PersonaRun {
  return { status: 'failed', resultArtifactId: null, errorMessage } as unknown as PersonaRun;
}

/** A withdrawn run — the owner's own Stop (docs/17 row 117). */
function cancelled(): PersonaRun {
  return { status: 'cancelled', resultArtifactId: null, errorMessage: '' } as unknown as PersonaRun;
}

function briefs(): string[] {
  return startRunMock.mock.calls.map((call) => {
    const input = call[0] as { brief?: unknown };
    return typeof input.brief === 'string' ? input.brief : '';
  });
}

beforeEach(async () => {
  await clearDatabase();
  useProgressStore.getState().reset();
  startRunMock.mockReset();
  waitForRunStatusMock.mockReset();
  toastErrorMock.mockReset();
});

describe('encounter batch briefs pin the landed fixed cast', () => {
  it('the brief carries the scene NPC summary plus the must-appear instruction', async () => {
    const { campaign, module } = await seedWorld();
    const encounter = await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'encounter',
      name: 'The Howling Pit',
      summary: 'A pit fight.',
      body: 'The pit.',
      links: [],
      data: {
        difficulty: '',
        levelHint: '1',
        monsters: [],
        terrain: '',
        tactics: '',
        treasure: '',
        mapImageId: null,
        preset: 'standard',
        locationKind: 'other',
        siteShape: 'single',
        budgetAdvisory: '',
        layout: null,
      },
    });
    startRunMock.mockResolvedValue('run-1');
    waitForRunStatusMock.mockResolvedValue(completedWith(encounter.id));

    const result = await runEntityBatch({
      module,
      campaign,
      kind: 'encounter',
      targets: [{ name: 'The Howling Pit' }],
    });

    expect(result.failed).toEqual([]);
    expect(result.generated).toEqual(['The Howling Pit']);
    expect(startRunMock).toHaveBeenCalledTimes(1);
    const [brief] = briefs();
    expect(brief).toContain('Party of 4 adventurers at level 1.');
    expect(brief).toContain('Fixed cast');
    expect(brief).toContain('"Halvar"');
    expect(brief).toContain('level 6');
    expect(brief).toContain('MUST appear');
    expect(brief).toContain('as-is');
    expect(brief).toContain('REST of the roster');
  });
});

describe('NPC batch briefs carry the structured level', () => {
  it('the brief carries the part level line and no fixed cast', async () => {
    const { campaign, module, halvarId } = await seedWorld();
    startRunMock.mockResolvedValue('run-1');
    waitForRunStatusMock.mockResolvedValue(completedWith(halvarId));

    const result = await runEntityBatch({
      module,
      campaign,
      kind: 'npc',
      targets: [{ name: 'Halvar' }],
    });

    expect(result.failed).toEqual([]);
    expect(startRunMock).toHaveBeenCalledTimes(1);
    const [brief] = briefs();
    expect(brief).toContain('Party of 4 adventurers at level 1.');
    expect(brief).not.toContain('Fixed cast');
  });
});

/**
 * A batch entity whose run did not complete, and the ONE sentence seam that
 * says why (docs/18 §2, `runNotCompletedReason`; docs/17 row 128). The engine
 * is faked above but the seam is REAL — these pins judge the sentence the SITE
 * emits, so a reworded copy there would have to be re-implemented to survive
 * them.
 */
describe('a batch entity whose run did not complete says WHY through the engine’s one seam', () => {
  it('reports the engine’s own sentence verbatim — never a reworded fragment', async () => {
    const { campaign, module } = await seedWorld();
    const sentence =
      'Step "draft" rejected: the model reply could not be parsed. The run failed without saving partial results — run it again.';
    startRunMock.mockResolvedValue('run-1');
    waitForRunStatusMock.mockResolvedValue(failedWith(sentence));

    const result = await runEntityBatch({
      module,
      campaign,
      kind: 'npc',
      targets: [{ name: 'Kael' }],
    });

    // Byte-identical to what the engine wrote: no status, no label, no
    // wrapper — the message IS the sentence.
    expect(result.failed).toEqual([{ name: 'Kael', message: sentence }]);
    expect(result.generated).toEqual([]);
    // The failure list IS this seam's loud surface (it is what the caller
    // throws at the owner — pinned in `tests/features/change-artifact.test.ts`,
    // "a batch failure is thrown with the specialist reason, never returned as
    // a quiet status"), and exactly one entity is reported: never swallowed,
    // never duplicated.
    expect(result.failed).toHaveLength(1);
  });

  it('falls back to `run ended <status>` when the engine wrote nothing', async () => {
    const { campaign, module } = await seedWorld();
    startRunMock.mockResolvedValue('run-1');
    waitForRunStatusMock.mockResolvedValue(failedWith(''));

    const result = await runEntityBatch({
      module,
      campaign,
      kind: 'npc',
      targets: [{ name: 'Kael' }],
    });

    expect(result.failed).toEqual([{ name: 'Kael', message: 'run ended failed' }]);
  });

  it('a run the OWNER stopped is still WITHDRAWN here: no failure entry and no red toast (row 117’s silence holds)', async () => {
    const { campaign, module } = await seedWorld();
    startRunMock.mockResolvedValue('run-1');
    waitForRunStatusMock.mockResolvedValue(cancelled());

    const result = await runEntityBatch({
      module,
      campaign,
      kind: 'npc',
      targets: [{ name: 'Kael' }],
    });

    // The predicate answers BEFORE the reason seam is ever reached, which is
    // the whole separation the seam documents: a sentence exists for this row
    // (`run ended cancelled`) and the owner still never hears it.
    expect(result.failed).toEqual([]);
    expect(result.generated).toEqual([]);
    expect(toastErrorMock).not.toHaveBeenCalled();
  });
});
