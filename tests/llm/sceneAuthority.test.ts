import 'fake-indexeddb/auto';

import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { listArtifactsByCampaign } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { createPersona } from '@/db/personaRepo';
import { getRun } from '@/db/runRepo';
import {
  PROMPT_STYLE_PLACEHOLDERS,
  composePromptFromTemplate,
  type Campaign,
  type Persona,
  type PromptStyle,
  type StatBlock,
} from '@/domain';
import { buildEntityBrief } from '@/features/modules/persona-request';
import { BUILTIN_PROMPT_STYLES, partsContractValues } from '@/llm/promptStyles';
import { substitutionAdvisories } from '@/llm/roomBudget';
import { runEngine, type StartRunInput } from '@/llm/runEngine';
import { SCENE_AUTHORITY_SECTION, sceneSubstitutionsOf } from '@/llm/sceneAuthority';
import { encounterDraftSchema, encounterGeneratorBriefSchema, noteDraftSchema } from '@/llm/schemas';
import { GAME_SYSTEM_LABELS } from '@/domain/gameSystem';
import { clearDatabase } from '../db/helpers';

/**
 * THE ASSERTION RULE (docs/11, docs/17 row 89).
 *
 * The owner's report, verbatim: *"The encounter prose generator actually did a
 * good job here, and the mob generator was not too bad either. The problem is
 * the disconnect. The prose actually holds truth, but it might not always be
 * sufficient. If the prose is vague then the mob generator can improvise, if
 * its specific like here, it must follow that lead."*
 *
 * Everything the scene text ASSERTS is binding on the encounter; everything it
 * leaves OPEN is the generator's to invent. This file pins the three halves of
 * that rule where each one lives: the module writer's contract clause (all
 * three styles), the encounter pipelines' prompt section (encounter runs only,
 * every other kind byte-identical), and the loud collision path (a declared
 * substitution renders an advisory, an absent field renders nothing).
 *
 * Every pin below states its own revert-proof in a comment.
 */

vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {},
  OpenRouterError: class OpenRouterError extends Error {},
  listModels: vi.fn(),
}));

vi.mock('@/search', () => ({ searchRules: vi.fn() }));

vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);
const { searchRules } = await import('@/search');
const searchMock = vi.mocked(searchRules);

// --- the contract clause, composed for every style -------------------------

/** The PARTS prompt a style composes with every data slot empty. */
function composedPartsPrompt(style: PromptStyle): string {
  const values: Record<string, string | null> = {};
  for (const entry of PROMPT_STYLE_PLACEHOLDERS) {
    if (entry.surface === 'parts' || entry.surface === 'both') values[entry.token] = null;
  }
  Object.assign(
    values,
    partsContractValues({ lengthTarget: '1200 words', floorClause: 'At least one encounter.' }),
  );
  return composePromptFromTemplate({
    templateText: style.templateText,
    surface: 'parts',
    values,
  }).text;
}

function monsterBlock(level: string): StatBlock {
  return {
    system: 'dnd5e',
    level,
    size: 'Medium',
    creatureType: 'undead',
    ac: 13,
    acNote: '',
    hp: 22,
    hpFormula: '4d8 + 4',
    speed: '30 ft.',
    abilities: { str: 13, dex: 15, con: 12, int: 9, wis: 10, cha: 6 },
    saves: '',
    skills: '',
    senses: 'darkvision 60 ft.',
    languages: 'Common',
    traits: [],
    actions: [],
    reactions: [],
    legendary: [],
    extras: {},
  };
}

describe('the writer’s contract clause states the assertion rule', () => {
  it('renders in all three built-in styles', () => {
    // Revert-proof: restoring the pre-row clause ("no names, no counts") fails
    // this test on both the presence and the absence assertions.
    expect(BUILTIN_PROMPT_STYLES.map((style) => style.id)).toEqual(['classic', 'story', 'freestyle']);
    for (const style of BUILTIN_PROMPT_STYLES) {
      const prompt = composedPartsPrompt(style);
      expect(prompt, style.id).toContain('state what the fight IS and where it happens');
      expect(prompt, style.id).toContain('A count you state is binding on the encounter the app builds from this scene.');
      expect(prompt, style.id).toContain('You assert the FICTION, never the mechanics');
      expect(prompt, style.id).toContain('The pipeline owns the CASTING around your fiction');
      expect(prompt, style.id).toContain(
        'and it must not contradict what you state',
      );
      // No personal names for the rank and file — the one half of the old
      // clause that survives, and it is now about NAMES only.
      expect(prompt, style.id).toContain('A rank-and-file fighter never gets a personal name');
      // The old prohibition is gone, in every style.
      expect(prompt, style.id).not.toContain('no names, no counts');
      expect(prompt, style.id).not.toContain('rank-and-file fighters stay anonymous');
    }
  });

  it('pins the silence-is-free sentence in the contract text of every style', () => {
    // Revert-proof: a rewrite that asks the writer to state MORE, or that reads
    // as "always obey the prose", fails on this sentence disappearing.
    for (const style of BUILTIN_PROMPT_STYLES) {
      const prompt = composedPartsPrompt(style);
      expect(prompt, style.id).toContain('silence is not a constraint');
      expect(prompt, style.id).toContain('the pipeline designs the roster, the map and everything else freely');
    }
  });

  it('leaves the mechanics boundary intact (counts are fiction, the roster is not)', () => {
    // A non-regression guard: the mechanics slot still forbids the roster,
    // tactics rules and the map in prose — the casting clause asks for FICTION.
    const classic = BUILTIN_PROMPT_STYLES.find((style) => style.id === 'classic');
    if (classic === undefined) throw new Error('no classic built-in');
    const prompt = composedPartsPrompt(classic);
    expect(prompt).toContain('no monster roster with counts, no tactics or terrain rules, no battle map');
    expect(prompt).toContain('no stat lines or stat blocks');
  });
});

// --- the encounter-side prompt section ------------------------------------

const NOTE_DRAFT = {
  name: 'The Ember Ledger',
  summary: 'A smugglers’ ledger.',
  suggestedTags: [],
  body: '# The Ember Ledger\nRecovered from the docks.',
};

const SCENE_BRIEF =
  'The fight at [[The Sunken Bridge]]: two risen lumberjacks, axes still in their hands, stand motionless on a narrow boggy footbridge over a knee-deep icy stream.';

const ENCOUNTER_DRAFT = {
  name: 'The Sunken Bridge',
  summary: 'Two drowned men hold a footbridge.',
  suggestedTags: [],
  body: '# The Sunken Bridge\nCold water, cold axes.',
  difficulty: 'hard',
  levelHint: '3',
  monsters: [{ name: 'Ghoul Soldier', count: 2, notes: '', treasure: '', statBlock: monsterBlock('3') }],
  terrain: 'a narrow boggy footbridge over a knee-deep icy stream',
  tactics: 'they hold the span and do not leave it',
  treasure: '',
  locationKind: 'wilderness',
};

const ENCOUNTER_BRIEF_REPLY = {
  name: 'The Sunken Bridge',
  summary: 'Two drowned men hold a footbridge.',
  body: '# The Sunken Bridge\nCold water, cold axes.',
  difficulty: 'hard',
  levelHint: '3',
  terrain: 'a narrow boggy footbridge',
  tactics: 'hold the span',
  treasure: '',
  theme: 'a pine bog at dusk',
  styleNotes: 'inked',
  negative: 'text',
  monsters: [
    { name: 'Ghoul Soldier', count: 2, notes: '', treasure: '', statBlock: monsterBlock('3') },
  ],
  rooms: [
    {
      name: 'The Footbridge',
      description: 'A boggy span over an icy stream',
      size: 'medium',
      monsterIndexes: [0],
      adjacentRoomIndexes: [],
    },
  ],
  entryRoomIndex: 0,
};

function smithPersona(): Promise<Persona> {
  return createPersona({
    slug: 'encounter-smith-assertion',
    name: 'Encounter Smith',
    description: 'test',
    systemPrompt: 'You design encounters.',
    mode: 'generate',
    producesKind: 'encounter',
    builtIn: true,
  });
}

function cartographerPersona(): Promise<Persona> {
  return createPersona({
    slug: 'encounter-cartographer-assertion',
    name: 'Encounter Cartographer',
    description: 'test',
    systemPrompt: 'You design encounters.',
    mode: 'encounter',
    producesKind: 'encounter',
    builtIn: true,
  });
}

function notePersona(): Promise<Persona> {
  return createPersona({
    slug: 'plot-architect-assertion',
    name: 'Plot Architect',
    description: 'test',
    systemPrompt: 'You are a test persona. Reply with JSON only.',
    producesKind: 'note',
    builtIn: true,
  });
}

const INPUT = (campaign: Campaign, persona: Persona, brief: string): StartRunInput => ({
  campaign: {
    id: campaign.id,
    name: campaign.name,
    system: 'dnd5e',
    description: '',
    coverImageId: null,
    createdAt: campaign.createdAt,
    updatedAt: campaign.updatedAt,
  },
  persona,
  autonomy: 'auto' as const,
  brief,
  pinnedChunkIds: [],
});

function userMessage(callIndex: number): string {
  const call = chatMock.mock.calls[callIndex];
  const messages = call?.[0] ?? [];
  return messages
    .filter((message) => message.role === 'user')
    .map((message) => (typeof message.content === 'string' ? message.content : ''))
    .join('\n');
}

beforeEach(async () => {
  await clearDatabase();
  searchMock.mockReset();
  searchMock.mockResolvedValue([]);
  chatMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the encounter pipeline is told the scene is the truth', () => {
  it('renders the scene-authority section right after the Task line of an encounter draft', async () => {
    // Revert-proof: deleting the `kind === 'encounter' ? SCENE_AUTHORITY_SECTION`
    // entry from runDraft fails this test (section absent) and the byte-identity
    // test below (it would still pass there — that is what makes the pair a
    // condition test rather than a presence test).
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const persona = await smithPersona();
    chatMock.mockResolvedValue({ text: JSON.stringify(ENCOUNTER_DRAFT), modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun(INPUT(campaign, persona, SCENE_BRIEF));
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });

    const prompt = userMessage(0);
    expect(prompt).toContain(`Task: ${SCENE_BRIEF}`);
    // The section sits IMMEDIATELY after the Task line — before the rule
    // excerpts, the roster and the reply contract.
    expect(prompt).toContain(`Task: ${SCENE_BRIEF}\n\n${SCENE_AUTHORITY_SECTION}`);
    expect(prompt).toContain('THE SCENE IS THE TRUTH FOR THIS FIGHT');
    expect(prompt).toContain('is FIXED: the roster AND the map must match it');
    expect(prompt).toContain('never silently swapped');
    expect(prompt).toContain('"substitutions"');
    // The silence half, pinned in the prompt too (the owner does not want a
    // timid pipeline): reverting the section's last sentence fails this line.
    expect(prompt).toContain('silence is not a constraint');
    expect(prompt).toContain('you design freely');
  }, 20000);

  it('renders it in the Cartographer brief too (the map half of the rule)', async () => {
    // Revert-proof: dropping the section from the Cartographer's `contract`
    // array fails this test while the Smith test above still passes.
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const persona = await cartographerPersona();
    chatMock.mockResolvedValue({
      text: JSON.stringify(ENCOUNTER_BRIEF_REPLY),
      modelUsed: 'test-model',
      fallback: null,
    });

    const runId = await runEngine.startRun({
      ...INPUT(campaign, persona, SCENE_BRIEF),
      autonomy: 'manual' as const,
    });
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('awaiting_user');
    });

    const prompt = userMessage(0);
    expect(prompt.startsWith(`${SCENE_BRIEF}\n\n${SCENE_AUTHORITY_SECTION}`)).toBe(true);
    expect(prompt).toContain('the roster AND the map must match it');
    await runEngine.cancel(runId);
  }, 20000);

  it('a non-encounter draft prompt is byte-identical without the section', async () => {
    // Revert-proof: rendering the section unconditionally (dropping the
    // `kind === 'encounter'` condition) fails this exact-bytes comparison.
    const campaign = await createCampaign({ name: 'Test Campaign', system: 'dnd5e' });
    const persona = await notePersona();
    const brief = 'a smugglers’ note about the emberwine trade';
    chatMock.mockResolvedValue({ text: JSON.stringify(NOTE_DRAFT), modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun(INPUT(campaign, persona, brief));
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });

    const keys = JSON.stringify(Object.keys(noteDraftSchema.shape));
    expect(userMessage(0)).toBe(
      [
        `Campaign: Test Campaign (${GAME_SYSTEM_LABELS.dnd5e})`,
        `Task: ${brief}`,
        'No rule excerpts available.',
        `Reply with ONLY a JSON object with exactly these fields: ${keys}`,
      ].join('\n\n'),
    );
    expect(userMessage(0)).not.toContain('THE SCENE IS THE TRUTH');
  }, 20000);
});

// --- the brief's own framing ----------------------------------------------

describe('the encounter brief frames its scene text as the scene to stage', () => {
  it('changes the label for encounters and nothing else', () => {
    // Revert-proof: the encounter case fails if the flag is ignored; the
    // byte-identity line below fails if the framing leaks into other kinds
    // (the same assertion `tests/features/persona-request.test.ts` makes).
    const scene = 'Two risen lumberjacks stand on the footbridge.';
    const plain = buildEntityBrief('The Sunken Bridge', scene, 'premise', 3, []);
    const encounter = buildEntityBrief('The Sunken Bridge', scene, 'premise', 3, [], true);
    expect(plain).toContain('Where it is mentioned:');
    expect(encounter).not.toContain('Where it is mentioned:');
    expect(encounter).toBe(
      plain.replace(
        'Where it is mentioned:',
        'The scene this encounter must stage — whatever it states about the opposition and the place is FIXED, and the roster and the map must match it:',
      ),
    );
    expect(buildEntityBrief('The Sunken Bridge', scene, 'premise', 3, [], false)).toBe(plain);
  });
});

// --- the loud collision path ----------------------------------------------

describe('scene-assertion substitutions', () => {
  const baseDraft = { ...ENCOUNTER_DRAFT } as Record<string, unknown>;

  it('absent and null both parse as "none declared" (a brief stored before the field)', () => {
    // Revert-proof: making the field required (dropping the preprocess/default)
    // fails the first parse — that is the pre-row stored shape.
    const absent = encounterDraftSchema.parse(baseDraft);
    expect(absent.substitutions).toEqual([]);
    expect(encounterDraftSchema.parse({ ...baseDraft, substitutions: null }).substitutions).toEqual([]);
  });

  it('parses a declared substitution and keeps its three fields', () => {
    const parsed = encounterDraftSchema.parse({
      ...baseDraft,
      substitutions: [
        { asserted: 'two risen lumberjacks', used: 'ghoul soldiers', reason: 'no stat block' },
      ],
    });
    expect(parsed.substitutions).toEqual([
      { asserted: 'two risen lumberjacks', used: 'ghoul soldiers', reason: 'no stat block' },
    ]);
  });

  it('the Cartographer brief reads the legacy shape the same way', () => {
    const legacy = encounterGeneratorBriefSchema.parse(ENCOUNTER_BRIEF_REPLY);
    expect(legacy.substitutions).toEqual([]);
    const declared = encounterGeneratorBriefSchema.parse({
      ...ENCOUNTER_BRIEF_REPLY,
      substitutions: [{ asserted: 'a boggy footbridge', used: 'an open clearing', reason: 'map fit' }],
    });
    expect(declared.substitutions).toHaveLength(1);
  });

  it('reads a stored draft tolerantly and refuses an unreadable declaration loudly', () => {
    expect(sceneSubstitutionsOf(undefined)).toEqual([]);
    expect(sceneSubstitutionsOf(null)).toEqual([]);
    expect(
      sceneSubstitutionsOf([{ asserted: 'a', used: 'b', reason: 'c' }]),
    ).toEqual([{ asserted: 'a', used: 'b', reason: 'c' }]);
    // AGENTS rule 1: the model's own account of what it could not honour is
    // never silently dropped — a present but unreadable value is loud.
    expect(() => sceneSubstitutionsOf('two risen lumberjacks')).toThrow(/substitutions/);
  });

  it('renders an advisory naming what was asserted, what was used and why', () => {
    // Revert-proof: deleting the advisory rendering fails this test.
    const advisories = substitutionAdvisories('The Sunken Bridge', [
      {
        asserted: 'two risen lumberjacks with axes',
        used: 'two ghoul soldiers',
        reason: 'no lumberjack stat block in this campaign’s books',
      },
    ]);
    expect(advisories).toHaveLength(1);
    expect(advisories[0]).toContain('The Sunken Bridge');
    expect(advisories[0]).toContain('two risen lumberjacks with axes');
    expect(advisories[0]).toContain('two ghoul soldiers');
    expect(advisories[0]).toContain('no lumberjack stat block');
    // An empty declaration says nothing (never an empty advisory line).
    expect(substitutionAdvisories('X', [])).toEqual([]);
    expect(substitutionAdvisories('X', [{ asserted: ' ', used: '', reason: '' }])).toEqual([]);
  });

  it('surfaces a declared substitution on the finalized encounter, and nothing when absent', async () => {
    // The real seam: `data.budgetAdvisory`, the same block the fixed-cast
    // advisories ride. Revert-proof: removing the `substitutionAdvisories` call
    // from runFinalize fails the first assertion while the control run below
    // still passes — the pair is what proves the rendering, not the schema.
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const persona = await smithPersona();
    chatMock.mockResolvedValue({
      text: JSON.stringify({
        ...ENCOUNTER_DRAFT,
        substitutions: [
          {
            asserted: 'two risen lumberjacks with axes',
            used: 'two ghoul soldiers',
            reason: 'no lumberjack stat block in this campaign’s books',
          },
        ],
      }),
      modelUsed: 'test-model',
      fallback: null,
    });

    const runId = await runEngine.startRun(INPUT(campaign, persona, SCENE_BRIEF));
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });

    const artifacts = await listArtifactsByCampaign(campaign.id);
    const encounter = artifacts.find((artifact) => artifact.kind === 'encounter');
    expect(encounter).toBeDefined();
    if (encounter?.kind !== 'encounter') throw new Error('no encounter artifact');
    expect(encounter.data.budgetAdvisory).toContain('two risen lumberjacks with axes');
    expect(encounter.data.budgetAdvisory).toContain('two ghoul soldiers');
    expect(encounter.data.budgetAdvisory).toContain('declared this substitution itself');
    // The roster itself is untouched by the advisory — this is a report.
    expect(encounter.data.monsters.map((monster) => monster.name)).toEqual(['Ghoul Soldier']);
  }, 30000);

  it('a draft that declares nothing rolls up no substitution advisory', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const persona = await smithPersona();
    chatMock.mockResolvedValue({ text: JSON.stringify(ENCOUNTER_DRAFT), modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun(INPUT(campaign, persona, SCENE_BRIEF));
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });

    const artifacts = await listArtifactsByCampaign(campaign.id);
    const encounter = artifacts.find((artifact) => artifact.kind === 'encounter');
    if (encounter?.kind !== 'encounter') throw new Error('no encounter artifact');
    expect(encounter.data.budgetAdvisory).not.toContain('declared this substitution itself');
  }, 30000);
});

// --- a vague scene stays free ---------------------------------------------

describe('a vague scene constrains nothing', () => {
  it('renders no assertion requirement for a scene with no participants and no place', () => {
    // The owner explicitly does not want a timid pipeline. A vague scene adds
    // NO prompt-side constraint of its own: the section is the same text, its
    // freedom half is explicit, and the brief keeps only the label change.
    // Non-regression guard: this asserts nothing new is injected per scene.
    const scene = 'Something waits at the crossing.';
    const brief = buildEntityBrief('The Crossing', scene, 'premise', 2, [], true);
    expect(brief).toContain('The scene this encounter must stage');
    expect(brief).not.toContain('the scene names no participants');
    expect(brief).not.toContain('you must state');
    expect(SCENE_AUTHORITY_SECTION).toContain('A vague scene is never a reason to invent an assertion the text does not make.');
  });

  it('a scene-less encounter brief still composes the same prompt shape', async () => {
    // Non-regression guard over the roster path: with no scene text at all the
    // brief loses only its context block (`contextParagraphs === ''` renders
    // nothing), the encounter prompt keeps the section — and the roster tests
    // that already exist (`tests/llm/encounterRun.test.ts`,
    // `tests/llm/encounterCartographer.test.ts`, `encounterRepopulate`) are the
    // pipeline-side guard that no artificial constraint was added here.
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const persona = await smithPersona();
    chatMock.mockResolvedValue({ text: JSON.stringify(ENCOUNTER_DRAFT), modelUsed: 'test-model', fallback: null });
    const brief = buildEntityBrief('The Sunken Bridge', '', 'premise', 3, [], true);
    expect(brief).not.toContain('Where it is mentioned:');

    const runId = await runEngine.startRun(INPUT(campaign, persona, brief));
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('completed');
    });
    expect(userMessage(0)).toContain(`Task: ${brief}\n\n${SCENE_AUTHORITY_SECTION}`);
  }, 30000);
});
