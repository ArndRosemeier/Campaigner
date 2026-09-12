import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact, listArtifactsByCampaign } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import {
  createModule,
  createPersona,
  defaultSettings,
  moduleDocumentText,
  type Campaign,
  type Id,
  type StatBlock,
} from '@/domain';
import { listModulesByCampaign, saveModule } from '@/db/moduleRepo';
import { saveSettings } from '@/db/settingsRepo';
import { buildEntityBrief, stubKindCarriesPartyLevel } from '@/features/modules/persona-request';
import {
  fixedCastAdvisories,
  fixedCastForEncounter,
  fixedCastSectionFor,
  partLevelForMention,
} from '@/llm/roomBudget';
import { runEngine, waitForRunStatus, type StartRunInput } from '@/llm/runEngine';
import { runParts } from '@/llm/moduleGen';
import { chat } from '@/llm/openrouter';
import type { ChatResult } from '@/llm/openrouter';
import { extractWikiLinks, surroundingParagraphs } from '@/lib/wikilinks';
import { clearDatabase } from '../db/helpers';

/**
 * Fixed-cast glue (docs/11): NPC drafts carry the structured level, encounter
 * drafts pin already-drafted scene members as fixed cast, finalize checks
 * the cast landed (coverage + level-mismatch advisories, loud never
 * blocking), and the prose writer names only constants in encounter scenes.
 */

vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {},
  OpenRouterError: class OpenRouterError extends Error {},
}));

vi.mock('@/search', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...(actual as object), searchRules: vi.fn() };
});

vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

const chatMock = vi.mocked(chat);
const { searchRules } = await import('@/search');
const searchRulesMock = vi.mocked(searchRules);

const TEST_MODEL = 'test/fixture-model';

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

const SCENE_MARKDOWN =
  'The pit mouth gapes. [[Halvar]] the giant and [[Mira]] stand beside ' +
  '[[The Howling Pit]], daring the party to enter. [[Pit Goblin]]s swarm. ' +
  'Far off lies [[Ember Chapel]].';

async function seedWorld(): Promise<{ campaign: Campaign; moduleId: Id }> {
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
        markdown: SCENE_MARKDOWN,
        status: 'ready',
        errorMessage: '',
        edited: false,
        writerModel: '',
        origin: null,
      },
    ],
  });
  // Halvar: drafted NPC bruiser, level 6 in a level-1 part (the owner case).
  await createArtifact({
    campaignId: campaign.id,
    moduleId: module.id,
    kind: 'npc',
    name: 'Halvar',
    summary: 'A giant blocking the pit.',
    body: 'Halvar stands in the way.',
    links: [],
    data: { appearance: 'Huge', personality: 'Gruff', statBlock: HALVAR_STATS },
  });
  // Mira: drafted but statless (a contact caught in the scene).
  await createArtifact({
    campaignId: campaign.id,
    moduleId: module.id,
    kind: 'npc',
    name: 'Mira',
    summary: 'A guide.',
    body: 'Mira knows the way down.',
    links: [],
    data: { appearance: '', personality: '', statBlock: null },
  });
  // A location sharing the scene: never cast.
  await createArtifact({
    campaignId: campaign.id,
    moduleId: module.id,
    kind: 'location',
    name: 'Ember Chapel',
    summary: 'A chapel.',
    body: 'Far off.',
    links: [],
    data: { locationType: '', inhabitants: '', pointsOfInterest: [], hooks: [] },
  });
  // The encounter itself, drafted: its own name must never join its cast.
  await createArtifact({
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
  return { campaign, moduleId: module.id };
}

beforeEach(async () => {
  await clearDatabase();
  chatMock.mockReset();
  searchRulesMock.mockReset();
  searchRulesMock.mockResolvedValue([]);
});

describe('stubKindCarriesPartyLevel', () => {
  it('pins encounters and npcs (monsters are npc rows), nothing else', () => {
    expect(stubKindCarriesPartyLevel('encounter')).toBe(true);
    expect(stubKindCarriesPartyLevel('npc')).toBe(true);
    expect(stubKindCarriesPartyLevel('location')).toBe(false);
    expect(stubKindCarriesPartyLevel('event')).toBe(false);
    expect(stubKindCarriesPartyLevel('faction')).toBe(false);
    expect(stubKindCarriesPartyLevel('note')).toBe(false);
  });
});

describe('NPC draft structured level', () => {
  const levelOneModule = {
    spine: {
      premise: 'premise',
      themes: [],
      writerModel: '',
      origin: null,
      partPlan: [{ title: 'Descent', levelBand: '1', synopsis: '', levelUpTrigger: '' }],
    },
    parts: [
      {
        planIndex: 0,
        markdown: '[[Halvar]] scowls at the gate.',
        status: 'ready' as const,
        errorMessage: '',
        edited: false,
        writerModel: '',
        origin: null,
      },
    ],
  };

  it('an NPC draft brief carries the part level line', () => {
    const level = partLevelForMention(levelOneModule, 'Halvar');
    expect(level).toBe(1);
    const brief = buildEntityBrief('Halvar', '[[Halvar]] scowls at the gate.', 'premise', level);
    expect(brief).toContain('Party of 4 adventurers at level 1.');
  });

  it('an unmentioned NPC brief stays level-free', () => {
    expect(partLevelForMention(levelOneModule, 'Nobody')).toBeUndefined();
    const brief = buildEntityBrief('Nobody', '', 'premise', undefined);
    expect(brief).not.toContain('Party of');
  });
});

describe('fixedCastForEncounter', () => {
  it('collects drafted scene NPCs in mention order with name, level and stats', async () => {
    const { campaign, moduleId } = await seedWorld();
    const artifacts = await listArtifactsByCampaign(campaign.id);
    const cast = await fixedCastForEncounter(
      'The Howling Pit',
      SCENE_MARKDOWN,
      artifacts,
      moduleId,
    );
    expect(cast.map((member) => member.name)).toEqual(['Halvar', 'Mira']);
    const halvar = cast[0];
    expect(halvar?.level).toBe('6');
    expect(halvar?.summary).toContain('Halvar');
    expect(halvar?.summary).toContain('level 6');
    expect(halvar?.summary).toContain('AC 15');
    expect(halvar?.summary).toContain('HP 45');
    expect(halvar?.statBlock?.level).toBe('6');
    // Statless Mira still pins (coverage applies); her level is unknown.
    expect(cast[1]?.level).toBeUndefined();
    expect(cast[1]?.summary).toContain('no stat block on file');
    expect(cast[1]?.statBlock).toBeNull();
  });

  it('derives from the real scene-excerpt seam (module text position)', async () => {
    const { campaign, moduleId } = await seedWorld();
    const modules = await listModulesByCampaign(campaign.id);
    const module = modules.find((row) => row.id === moduleId);
    if (module === undefined) throw new Error('module missing');
    const scene = surroundingParagraphs(moduleDocumentText(module), 'The Howling Pit');
    expect(extractWikiLinks(scene).map((link) => link.name)).toContain('Halvar');
    const artifacts = await listArtifactsByCampaign(campaign.id);
    const cast = await fixedCastForEncounter('The Howling Pit', scene, artifacts, moduleId);
    expect(cast.map((member) => member.name)).toEqual(['Halvar', 'Mira']);
  });

  it('returns empty for an empty scene', async () => {
    const { campaign, moduleId } = await seedWorld();
    const artifacts = await listArtifactsByCampaign(campaign.id);
    expect(await fixedCastForEncounter('The Howling Pit', '', artifacts, moduleId)).toEqual([]);
  });
});

describe('buildEntityBrief fixed cast', () => {
  it('renders the summary plus the must-appear, as-is instruction', async () => {
    const { campaign, moduleId } = await seedWorld();
    const artifacts = await listArtifactsByCampaign(campaign.id);
    const cast = await fixedCastForEncounter(
      'The Howling Pit',
      SCENE_MARKDOWN,
      artifacts,
      moduleId,
    );
    const brief = buildEntityBrief(
      'The Howling Pit',
      SCENE_MARKDOWN,
      'premise',
      1,
      cast,
    );
    expect(brief).toContain('Party of 4 adventurers at level 1.');
    expect(brief).toContain('Fixed cast');
    expect(brief).toContain('"Halvar"');
    expect(brief).toContain('MUST appear');
    expect(brief).toContain('as-is');
    expect(brief).toContain('inline "statBlock"');
    expect(brief).toContain('never substitute a generic equivalent');
    expect(brief).toContain('REST of the roster');
  });

  it('stays byte-identical without a cast', () => {
    expect(fixedCastSectionFor([])).toBeNull();
    expect(buildEntityBrief('X', 'c', 'p', undefined, [])).toBe(
      buildEntityBrief('X', 'c', 'p', undefined),
    );
  });
});

describe('fixedCastAdvisories', () => {
  const cast = [
    { name: 'Halvar', level: '6', summary: 'Halvar — level 6, AC 15, HP 45', statBlock: null },
    { name: 'Mira', level: undefined, summary: 'Mira (no stat block on file)', statBlock: null },
  ];

  it('flags a missing cast name, never a mismatch for the absent', () => {
    const advisories = fixedCastAdvisories('The Howling Pit', cast, [{ name: 'Pit Goblin' }], 1);
    expect(advisories).toHaveLength(2);
    expect(advisories[0]).toContain('Fixed cast member "Halvar"');
    expect(advisories[0]).toContain('missing from the roster');
    expect(advisories[1]).toContain('Fixed cast member "Mira"');
    expect(advisories.join(' ')).not.toContain('far from the party level');
  });

  it('flags a fielded cast member wildly off the party level', () => {
    const advisories = fixedCastAdvisories(
      'The Howling Pit',
      cast,
      [{ name: 'Halvar' }, { name: 'Mira' }],
      1,
    );
    expect(advisories).toHaveLength(1);
    expect(advisories[0]).toContain('Fixed cast member "Halvar"');
    expect(advisories[0]).toContain('(level 6)');
    expect(advisories[0]).toContain('party level (1)');
    expect(advisories[0]).toContain('deliberate mismatches are legal');
  });

  it('stays quiet within one band step and without a party level', () => {
    expect(
      fixedCastAdvisories('The Howling Pit', cast, [{ name: 'Halvar' }, { name: 'Mira' }], 5),
    ).toEqual([]);
    // The boundary: two off is one band step (quiet), three off is wild.
    expect(
      fixedCastAdvisories('The Howling Pit', cast, [{ name: 'Halvar' }, { name: 'Mira' }], 4),
    ).toEqual([]);
    expect(
      fixedCastAdvisories('The Howling Pit', cast, [{ name: 'Halvar' }, { name: 'Mira' }], 3),
    ).toHaveLength(1);
    expect(
      fixedCastAdvisories('The Howling Pit', cast, [{ name: 'Halvar' }, { name: 'Mira' }], undefined),
    ).toEqual([]);
    expect(fixedCastAdvisories('The Howling Pit', [], [{ name: 'Halvar' }], 1)).toEqual([]);
  });

  it('matches roster names case-insensitively, ignoring blanks', () => {
    expect(
      fixedCastAdvisories('The Howling Pit', cast, [{ name: '  HALVAR ' }, { name: '' }, { name: 'mira' }], 1),
    ).toHaveLength(1);
  });
});

describe('Smith finalize fixed-cast advisories (full runs)', () => {
  const GOBLIN_STATS: StatBlock = {
    system: 'dnd5e',
    level: '1',
    size: 'Small',
    creatureType: 'humanoid',
    ac: 13,
    acNote: '',
    hp: 7,
    hpFormula: '2d6',
    speed: '30 ft.',
    abilities: { str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8 },
    saves: '',
    skills: '',
    senses: '',
    languages: '',
    traits: [],
    actions: [{ name: 'Scimitar', text: 'Melee Weapon Attack: +4 to hit.' }],
    reactions: [],
    legendary: [],
    extras: {},
  };

  function smithPersona() {
    return createPersona({
      slug: 'encounter-smith-test',
      name: 'Encounter Smith',
      description: '',
      systemPrompt: 'Design one encounter per request.',
      producesKind: 'encounter',
      builtIn: true,
    });
  }

  function smithDraft(monsters: unknown) {
    return {
      text: JSON.stringify({
        name: 'The Howling Pit',
        summary: 'A pit fight.',
        body: '# The Howling Pit\nThe pit gapes below.',
        suggestedTags: [],
        difficulty: 'medium',
        levelHint: '1',
        monsters,
        terrain: 'A reeking pit.',
        tactics: 'Swarm the rim.',
        treasure: '',
        locationKind: 'other',
      }),
      modelUsed: 'test-model',
      fallback: null,
    };
  }

  async function runSmith(monsters: unknown) {
    const { campaign, moduleId } = await seedWorld();
    await saveSettings({ ...defaultSettings(), openRouterApiKey: 'test-key' });
    const persona = smithPersona();
    const { db } = await import('@/db');
    await db.personas.put(persona);
    chatMock.mockResolvedValueOnce(smithDraft(monsters));
    const runInput: StartRunInput = {
      campaign,
      persona,
      autonomy: 'auto',
      brief: 'A pit fight at level 1.',
      pinnedChunkIds: [],
      placementModuleId: moduleId,
    };
    const runId = await runEngine.startRun(runInput);
    const run = await waitForRunStatus(runId);
    return { campaign, run };
  }

  it('a roster missing the cast completes with the coverage advisory', async () => {
    const { campaign, run } = await runSmith([
      { name: 'Pit Goblin', count: 3, notes: 'Swarming', treasure: '', statBlock: GOBLIN_STATS },
    ]);
    expect(run.status).toBe('completed');
    const artifacts = await listArtifactsByCampaign(campaign.id);
    // seedWorld drafts a bare 'The Howling Pit' row (the self-exclusion
    // belt); the run under test is the one carrying a roster.
    const encounter = artifacts.find(
      (artifact) =>
        artifact.kind === 'encounter' &&
        artifact.name === 'The Howling Pit' &&
        artifact.data.monsters.length > 0,
    );
    if (encounter?.kind !== 'encounter') throw new Error('encounter missing');
    expect(encounter.data.budgetAdvisory).toContain('Fixed cast member "Halvar"');
    expect(encounter.data.budgetAdvisory).toContain('missing from the roster');
    expect(encounter.data.budgetAdvisory).not.toContain('far from the party level');
    // The non-cast roster still materializes through the inline path as today.
    expect(encounter.data.monsters.map((monster) => monster.name)).toEqual(['Pit Goblin']);
    expect(encounter.data.monsters[0]?.source.type).toBe('npc-ref');
  }, 30_000);

  it('a wildly-off fielded cast member completes with the mismatch advisory', async () => {
    const { campaign, run } = await runSmith([
      { name: 'Halvar', count: 1, notes: 'Boss', treasure: '', statBlock: HALVAR_STATS },
    ]);
    expect(run.status).toBe('completed');
    const artifacts = await listArtifactsByCampaign(campaign.id);
    const encounter = artifacts.find(
      (artifact) =>
        artifact.kind === 'encounter' &&
        artifact.name === 'The Howling Pit' &&
        artifact.data.monsters.length > 0,
    );
    if (encounter?.kind !== 'encounter') throw new Error('encounter missing');
    expect(encounter.data.budgetAdvisory).toContain('Fixed cast member "Halvar"');
    expect(encounter.data.budgetAdvisory).toContain('(level 6)');
    expect(encounter.data.budgetAdvisory).toContain('party level (1)');
    expect(encounter.data.budgetAdvisory).toContain('deliberate mismatches are legal');
    // Halvar himself is fielded (no coverage advisory for him); Mira — the
    // other scene member, absent from this roster — keeps hers.
    expect(encounter.data.budgetAdvisory).not.toContain('"Halvar" is missing');
    expect(encounter.data.budgetAdvisory).toContain('Fixed cast member "Mira" is missing');
    // Finalize links the EXISTING Halvar row (one-entity-per-name reuse) —
    // the as-is stats never duplicate or overwrite the landed NPC.
    const halvars = artifacts.filter(
      (artifact) => artifact.kind === 'npc' && artifact.name === 'Halvar',
    );
    expect(halvars).toHaveLength(1);
    expect(encounter.data.monsters[0]?.source).toEqual({
      type: 'npc-ref',
      artifactId: halvars[0]?.id,
    });
  }, 30_000);
});

describe('partCall constants-only sentence', () => {
  function partReply(): ChatResult {
    return {
      text:
        'The ambush springs at the ford. The party fights through. '.repeat(6) +
        ' Trials faced: [[Ember Ambush]].',
      modelUsed: 'test-model',
      fallback: null,
    };
  }

  function normReply(): ChatResult {
    return {
      text: JSON.stringify({
        entities: [
          {
            name: 'Ember Ambush',
            canonical: 'Ember Ambush',
            kind: 'encounter',
          },
        ],
      }),
      modelUsed: 'test-model',
      fallback: null,
    };
  }

  function partCallText(): string {
    const call = chatMock.mock.calls.find((messages) =>
      messages[0].some(
        (message) =>
          message.role === 'user' &&
          typeof message.content === 'string' &&
          message.content.includes('Write part'),
      ),
    );
    if (call === undefined) throw new Error('no part call made');
    const user = call[0].find((message) => message.role === 'user');
    return typeof user?.content === 'string' ? user.content : '';
  }

  it('the part prompt carries the assertion rule for encounter scenes', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const targetDraft = createModule({
      campaignId: campaign.id,
      title: 'The Target',
      concept: 'target',
      levelMin: 1,
      levelMax: 2,
      sizeDial: 'standard',
      includePriorModules: false,
    });
    const target = await saveModule({
      ...targetDraft,
      spine: {
        premise: 'The target premise.',
        themes: [],
        writerModel: '',
        origin: null,
        partPlan: [
          { title: 'First', levelBand: '1', synopsis: '', levelUpTrigger: '' },
          { title: 'Second', levelBand: '2', synopsis: '', levelUpTrigger: '' },
        ],
      },
      parts: [],
    });
    const { updateSettings } = await import('@/db/settingsRepo');
    await updateSettings({ defaultChatModel: TEST_MODEL });
    chatMock.mockResolvedValueOnce(partReply()).mockResolvedValueOnce(normReply());

    await runParts(target.id, campaign, { planIndexes: [0] });

    // The rewritten casting clause (docs/17 row 89): the writer asserts the
    // fiction — a stated count is binding — and keeps personal names off the
    // rank and file. This test used to pin the OLD clause ("name only the
    // fixed participants" / "rank-and-file"); it is the one existing pin on
    // that contract text outside the byte-identity fixtures.
    expect(partCallText()).toContain('state what the fight IS and where it happens');
    expect(partCallText()).toContain('A count you state is binding');
    expect(partCallText()).toContain('A rank-and-file fighter never gets a personal name');
  }, 30_000);
});
