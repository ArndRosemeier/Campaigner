import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { createModule, type Campaign, type Module, type PersonaRun, type StatBlock } from '@/domain';
import { saveModule } from '@/db/moduleRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { runEntityBatch } from '@/features/modules/entity-batch';
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

vi.mock('@/llm/runEngine', () => ({
  runEngine: { on: () => () => undefined, startRun: startRunMock },
  waitForRunStatus: waitForRunStatusMock,
}));

vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

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
