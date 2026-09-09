import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact, listArtifactsByCampaign } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { createModule, moduleDocumentText, type Campaign, type Id, type StatBlock } from '@/domain';
import { listModulesByCampaign, saveModule } from '@/db/moduleRepo';
import { buildEntityBrief, stubKindCarriesPartyLevel } from '@/features/modules/persona-request';
import {
  fixedCastForEncounter,
  fixedCastSectionFor,
  partLevelForMention,
} from '@/llm/roomBudget';
import { extractWikiLinks, surroundingParagraphs } from '@/lib/wikilinks';
import { clearDatabase } from '../db/helpers';

/**
 * Fixed-cast glue, part 1 (docs/11): NPC drafts carry the structured level,
 * and encounter drafts pin already-drafted scene members as fixed cast.
 * (Part 2 — the finalize advisories and the prose rule — extends this file.)
 */

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
      partPlan: [{ title: 'Descent', levelBand: '1', synopsis: '', levelUpTrigger: '' }],
    },
    parts: [
      {
        planIndex: 0,
        markdown: SCENE_MARKDOWN,
        status: 'ready',
        errorMessage: '',
        edited: false,
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
      partPlan: [{ title: 'Descent', levelBand: '1', synopsis: '', levelUpTrigger: '' }],
    },
    parts: [
      {
        planIndex: 0,
        markdown: '[[Halvar]] scowls at the gate.',
        status: 'ready' as const,
        errorMessage: '',
        edited: false,
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
    const cast = fixedCastForEncounter('The Howling Pit', SCENE_MARKDOWN, artifacts, moduleId);
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
    const cast = fixedCastForEncounter('The Howling Pit', scene, artifacts, moduleId);
    expect(cast.map((member) => member.name)).toEqual(['Halvar', 'Mira']);
  });

  it('returns empty for an empty scene', async () => {
    const { campaign, moduleId } = await seedWorld();
    const artifacts = await listArtifactsByCampaign(campaign.id);
    expect(fixedCastForEncounter('The Howling Pit', '', artifacts, moduleId)).toEqual([]);
  });
});

describe('buildEntityBrief fixed cast', () => {
  it('renders the summary plus the must-appear, as-is instruction', async () => {
    const { campaign, moduleId } = await seedWorld();
    const artifacts = await listArtifactsByCampaign(campaign.id);
    const cast = fixedCastForEncounter('The Howling Pit', SCENE_MARKDOWN, artifacts, moduleId);
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
