import 'fake-indexeddb/auto';

import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact, getAnyArtifact, listArtifactsByCampaign } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { getRun } from '@/db/runRepo';
import { saveSettings } from '@/db/settingsRepo';
import { useProgressStore } from '@/lib/progress';
import {
  createPersona,
  defaultSettings,
  statBlockSchema,
  type Campaign,
  type Id,
  type Persona,
  type StatBlock,
} from '@/domain';
import { encounterBudgetFor, checkRoomBudget } from '@/llm/roomBudget';
import {
  assertedCastAdvisory,
  assertedCastIssues,
  assertedCastOf,
  assertedCastSectionFor,
  assertedSubstitutionIssues,
  effectiveAssertedCast,
  sameAssertedName,
} from '@/llm/sceneAuthority';
import { encounterDraftSchema } from '@/llm/schemas';
import { rejectionIssues } from '@/llm/rejectionReason';
import { encounterRunAdapters, runEngine, type StartRunInput } from '@/llm/runEngine';
import { chat } from '@/llm/openrouter';
import { clearDatabase } from '../db/helpers';
import { generatedImagesFor } from '../helpers/imageRunFixtures';

/**
 * THE SCENE'S ASSERTED CAST — the owner's row-309 rule, end to end.
 *
 * Owner, verbatim: *"If the whole purpose of the encounter is to defeat the
 * undead king (for example) OF COURSE the generator can not simply exclude
 * this. Not sure about a hard cap, i do not think its good (what if there are 3
 * mobs mentioned in the story that just HAVE to be there). Leave this to the
 * model. An OCCASIONAL overload is not too bad if its not concentrated into one
 * mob. Players can get creative and lure one away, things like that. So, prose
 * assertions are absolute, fill up whats missing is my TLDR."*
 *
 * The five parts of the mechanism, each pinned below:
 *
 * 1. TRANSCRIBE — the step that reads the scene writes `assertedCast` as
 *    structured data (the app never reads prose with a pattern, AGENTS rule 5);
 * 2. SURFACE — the list is stored on the encounter row and named in the
 *    EXISTING advisory block (`data.budgetAdvisory` → the step notice);
 * 3. ENFORCE — an asserted figure missing from the roster is a repair, then a
 *    FAILED RUN. Never a shipped fight with a note;
 * 4. EXEMPT — an asserted figure is excluded from the budget arithmetic; the
 *    band bounds only the FILLER (an occasional overload is accepted);
 * 5. NO SUBSTITUTION for an asserted figure — declared or not, it is refused.
 *
 * Every pin states its own revert-proof.
 */

vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {},
  OpenRouterError: class OpenRouterError extends Error {},
  listModels: vi.fn(),
}));

vi.mock('@/search', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...(actual as object), searchRules: vi.fn() };
});

vi.mock('@/llm/imageGen', () => ({ generateImages: vi.fn() }));
vi.mock('@/lib/imageIntake', () => ({ intakeImage: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

// Fill grade is DRAWN, so the complex stocking expectation must be a fixed
// number for the exemption pin's arithmetic to be readable.
import type * as domainArtifact from '@/domain/artifact';

vi.mock('@/domain/artifact', async (importOriginal) => {
  const actual = await importOriginal<typeof domainArtifact>();
  return { ...actual, drawFillGrade: vi.fn(actual.drawFillGrade) };
});

const chatMock = vi.mocked(chat);
const { searchRules } = await import('@/search');
const searchRulesMock = vi.mocked(searchRules);
const { drawFillGrade } = await import('@/domain/artifact');
const drawFillGradeMock = vi.mocked(drawFillGrade);

/** The scene every Smith pin below reads. */
const SCENE_BRIEF =
  'The fight at [[The Sunken Bridge]]: two risen lumberjacks, axes still in their hands, stand motionless on a narrow boggy footbridge over a knee-deep icy stream.';

function monsterBlock(level: string): StatBlock {
  return statBlockSchema.parse({
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
  });
}

const RISEN = 'Risen Lumberjack';

function smithPersona(): Persona {
  return createPersona({
    slug: 'encounter-smith-asserted',
    name: 'Encounter Smith',
    description: 'test',
    systemPrompt: 'You design encounters.',
    mode: 'generate',
    producesKind: 'encounter',
    builtIn: true,
  });
}

function cartographerPersona(): Persona {
  return createPersona({
    slug: 'encounter-cartographer-asserted',
    name: 'Encounter Cartographer',
    description: 'test',
    systemPrompt: 'You design encounters.',
    mode: 'encounter',
    producesKind: 'encounter',
    builtIn: true,
  });
}

/** The Smith reply: the asserted figure, fielded inline (the library holds no
 *  such creature — that is pin 1's whole point). */
function draftReply(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: 'The Sunken Bridge',
    summary: 'Two drowned men hold a footbridge.',
    suggestedTags: [],
    body: '# The Sunken Bridge\nCold water, cold axes.',
    difficulty: 'hard',
    monsters: [
      {
        name: RISEN,
        count: 2,
        notes: 'axes still in their hands',
        treasure: '',
        statBlock: monsterBlock('2'),
      },
    ],
    terrain: 'a narrow boggy footbridge over a knee-deep icy stream',
    tactics: 'they hold the span and do not leave it',
    treasure: '',
    assertedCast: [{ name: RISEN, count: 2 }],
    substitutions: [],
    locationKind: 'wilderness',
    ...overrides,
  });
}

function smithInput(
  campaign: Campaign,
  autonomy: StartRunInput['autonomy'] = 'auto',
): StartRunInput {
  return {
    campaign,
    persona: smithPersona(),
    autonomy,
    brief: SCENE_BRIEF,
    pinnedChunkIds: [],
    // The create dialog's structured party level (docs/17 row 291).
    encounterPartyLevel: 5,
  };
}

async function smithSetup(): Promise<Campaign> {
  const campaign = await createCampaign({ name: 'Assertions', system: 'dnd5e' });
  await saveSettings({ ...defaultSettings(), openRouterApiKey: 'test-key' });
  return campaign;
}

/** The encounter artifact a completed/failed Smith run produced, if any. */
async function encounterOf(campaign: Campaign) {
  const artifacts = await listArtifactsByCampaign(campaign.id);
  return artifacts.find((artifact) => artifact.kind === 'encounter');
}

async function waitForStatus(runId: Id, status: string): Promise<void> {
  await waitFor(
    async () => {
      expect((await getRun(runId))?.status).toBe(status);
    },
    { timeout: 20000 },
  );
}

/** The USER-role content of one chat call (the prompt the model read). */
function promptText(callIndex: number): string {
  const messages = chatMock.mock.calls[callIndex]?.[0] ?? [];
  return messages
    .filter((message) => message.role === 'user')
    .map((message) => (typeof message.content === 'string' ? message.content : ''))
    .join('\n');
}

/** The LAST message of one chat call (the repair turn's own instruction). */
function repairText(callIndex: number): string {
  const last = (chatMock.mock.calls[callIndex]?.[0] ?? []).at(-1);
  return typeof last?.content === 'string' ? last.content : '';
}

beforeEach(async () => {
  await clearDatabase();
  useProgressStore.getState().reset();
  chatMock.mockReset();
  searchRulesMock.mockReset();
  searchRulesMock.mockResolvedValue([]);
  drawFillGradeMock.mockReset();
  drawFillGradeMock.mockReturnValue(70);
  vi.spyOn(encounterRunAdapters, 'renderSchematic').mockReturnValue({
    dataUrl: 'data:image/png;base64,schematic',
    width: 2304,
    height: 1728,
  });
  vi.spyOn(encounterRunAdapters, 'generateImages').mockImplementation((_prompt, n) =>
    Promise.resolve(generatedImagesFor(n, 'map')),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

// --- 1. TRANSCRIBE: the shape and its tolerant read -------------------------

describe('the transcribed asserted cast (docs/17 row 309)', () => {
  it('reads a stored draft tolerantly, defaults a missing count to 1, and refuses garbage loudly', () => {
    // Revert-proof: dropping the null/absent arm makes a pre-row draft throw;
    // dropping the count preprocess rejects the strict contract's own `null`.
    expect(assertedCastOf(undefined)).toEqual([]);
    expect(assertedCastOf(null)).toEqual([]);
    expect(assertedCastOf([{ name: 'The Undead King', count: null }])).toEqual([
      { name: 'The Undead King', count: 1 },
    ]);
    expect(assertedCastOf([{ name: RISEN, count: 2 }])).toHaveLength(1);
    // AGENTS rule 1: the model's own reading of the scene is never silently
    // dropped — a present but unreadable value is loud.
    expect(() => assertedCastOf('two risen lumberjacks')).toThrow(/assertedCast/);
  });

  it('parses absent and null as "the scene names no figure" on the reply contract', () => {
    const base = JSON.parse(draftReply()) as Record<string, unknown>;
    delete base.assertedCast;
    expect(encounterDraftSchema.parse(base).assertedCast).toEqual([]);
    expect(encounterDraftSchema.parse({ ...base, assertedCast: null }).assertedCast).toEqual([]);
  });

  it('unions the reply\'s reading with the row\'s stored list, deduplicated by the ONE name form', () => {
    // Revert-proof: a lane that dropped the stored list would let the
    // Cartographer's fresh population forget the scene's own cast.
    const stored = [{ name: RISEN, count: 2 }];
    expect(effectiveAssertedCast([{ name: 'risen lumberjack', count: 1 }], stored)).toEqual([
      { name: 'risen lumberjack', count: 1 },
    ]);
    expect(effectiveAssertedCast([], stored)).toEqual(stored);
    expect(sameAssertedName('  Risen Lumberjack  ', RISEN)).toBe(true);
    expect(sameAssertedName('RISEN LUMBERJACK', RISEN)).toBe(true);
    expect(sameAssertedName('Elder Lumberjack', RISEN)).toBe(false);
    expect(sameAssertedName('', '')).toBe(false);
  });

  it('names the missing figure with the count the text stated', () => {
    const issues = assertedCastIssues('The Sunken Bridge', [{ name: RISEN, count: 2 }], [
      { name: 'Ghoul Soldier' },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain(RISEN);
    expect(issues[0]).toContain('×2');
    expect(issues[0]).toContain('The Sunken Bridge');
    expect(assertedCastIssues('X', [{ name: RISEN, count: 1 }], [{ name: 'risen lumberjack' }])).toEqual([]);
  });

  it('REFUSES a substitution that names an asserted figure', () => {
    // Revert-proof: deleting this gate ships the exact silent substitution the
    // assertion rule exists to prevent (docs/11 §The scene is the truth).
    const issues = assertedSubstitutionIssues(
      'The Sunken Bridge',
      [{ name: RISEN, count: 2 }],
      [{ asserted: RISEN, used: 'Ghoul Soldier', reason: 'no stat block' }],
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('may not be substituted');
    // A substitution for something the scene does NOT assert stays legal.
    expect(
      assertedSubstitutionIssues('X', [{ name: RISEN, count: 1 }], [
        { asserted: 'a boggy footbridge', used: 'an open clearing', reason: 'map fit' },
      ]),
    ).toEqual([]);
  });

  it('surfaces the list on the existing advisory seam, and renders nothing when empty', () => {
    const line = assertedCastAdvisory('The Sunken Bridge', [
      { name: RISEN, count: 2 },
      { name: 'The Undead King', count: 1 },
    ]);
    expect(line).toContain('The Sunken Bridge');
    expect(line).toContain(`"${RISEN}" ×2`);
    expect(line).toContain('The Undead King');
    expect(line).toContain('exempt from the challenge budget');
    expect(assertedCastAdvisory('X', [])).toBeNull();
  });

  it('renders a BINDING list for a lane whose own brief carries no scene', () => {
    expect(assertedCastSectionFor([])).toBeNull();
    const section = assertedCastSectionFor([{ name: RISEN, count: 2 }]);
    expect(section).toContain(RISEN);
    expect(section).toContain('×2');
    expect(section).toContain('REQUIRED in your roster');
  });
});

// --- 4. EXEMPT: the budget bounds the filler only ---------------------------

describe('asserted figures are exempt from the budget arithmetic', () => {
  const budget = encounterBudgetFor('system', 'dnd5e', 'normal');

  it('an overweight roster ACCEPTED with the assertion is OVER without it', () => {
    // Revert-proof: dropping `assertedNames` from `checkRoomBudget` fails this
    // pair — the exempt arm then reads 'over' exactly like the control. This is
    // the subtle half: without it the over-budget repair "fixes" the fight by
    // dropping the figure the scene is about.
    const room = {
      roomIndex: 0,
      roomName: 'The Footbridge',
      targetLevel: 1,
      creatures: [
        { name: 'The Undead King', count: 1, level: '12' },
        { name: 'Skeleton', count: 2, level: '1' },
      ],
      complex: false,
      budget,
    };
    const control = checkRoomBudget(room);
    expect(control.status).toBe('over');
    expect(control.sumLevels).toBe(14);
    const exempt = checkRoomBudget({ ...room, assertedNames: ['The Undead King'] });
    expect(exempt.status).toBe('ok');
    // The FILLER's sum is what the band sees: 2 × level 1.
    expect(exempt.sumLevels).toBe(2);
  });

  it('an unreadable asserted level does not make the filler loud-unverified', () => {
    const room = {
      roomIndex: 0,
      roomName: 'Ring',
      targetLevel: 1,
      creatures: [
        { name: 'The Undead King', count: 1, level: undefined },
        { name: 'Skeleton', count: 1, level: '1' },
      ],
      complex: false,
      budget,
    };
    expect(checkRoomBudget(room).status).toBe('unverified');
    expect(checkRoomBudget({ ...room, assertedNames: ['The Undead King'] }).status).toBe('ok');
  });
});

// --- 1 & 3. ENFORCE: presence, repair, then the run fails -------------------

describe('the scene-reading Smith draft transcribes and enforces the cast', () => {
  it('fields a figure the library does NOT hold as an inline creature and completes (pin 1)', async () => {
    // Revert-proof: with the transcription clause and field absent, this run
    // still completes — but the artifact would carry NO asserted cast and no
    // advisory line, and the two failure pins below would have nothing to
    // enforce. This arm is the "author it inline" outcome the rule allows.
    const campaign = await smithSetup();
    chatMock.mockResolvedValue({ text: draftReply(), modelUsed: 'test-model', fallback: null });

    const input = smithInput(campaign);
    const runId = await runEngine.startRun(input);
    await waitForStatus(runId, 'completed');

    const encounter = await encounterOf(campaign);
    if (encounter?.kind !== 'encounter') throw new Error('no encounter artifact');
    // The figure IS the fight, under the name the scene states.
    expect(encounter.data.monsters.map((monster) => monster.name)).toEqual([RISEN]);
    expect(encounter.data.monsters[0]?.count).toBe(2);
    // The library holds no such creature: the numbers are AUTHORED inline by the
    // draft (and materialized onto an NPC row by the established fix-02 path) —
    // never a rulebook citation, because there is no library creature to cite.
    expect(encounter.data.monsters[0]?.source.type).toBe('npc-ref');
    const source = encounter.data.monsters[0]?.source;
    if (source?.type !== 'npc-ref') throw new Error('roster entry is not a materialized npc');
    const materialized = (await listArtifactsByCampaign(campaign.id)).find(
      (artifact) => artifact.id === source.artifactId,
    );
    if (materialized?.kind !== 'npc') throw new Error('materialized npc missing');
    expect(materialized.data.statBlock?.level).toBe('2');
    // STORED on the row (pin 2 of the mechanism) and NAMED on the advisory seam.
    expect(encounter.data.assertedCast).toEqual([{ name: RISEN, count: 2 }]);
    expect(encounter.data.budgetAdvisory).toContain(`"${RISEN}" ×2`);
    expect(encounter.data.budgetAdvisory).toContain('Scene assertions transcribed');
    // The prompt carried the transcription clause, so the contract is stated.
    const prompt = promptText(0);
    expect(prompt).toContain('TRANSCRIBE the cast this scene ASSERTS');
    expect(prompt).toContain('"assertedCast"');
  }, 30000);

  it('repairs once and then FAILS the run when the roster omits an asserted figure (pin 2)', async () => {
    // Revert-proof: deleting the asserted-cast gate makes this run COMPLETE
    // with a rogue roster and no note at all — the silent drop the rule
    // forbids. The pin is the FAILURE, never a warning.
    const campaign = await smithSetup();
    chatMock.mockResolvedValue({
      text: draftReply({
        monsters: [
          { name: 'Ghoul Soldier', count: 2, notes: '', treasure: '', statBlock: monsterBlock('3') },
        ],
      }),
      modelUsed: 'test-model',
      fallback: null,
    });

    const runId = await runEngine.startRun(smithInput(campaign));
    await waitForStatus(runId, 'failed');

    // Exactly one repair turn, and it NAMES the figure and the count.
    expect(chatMock).toHaveBeenCalledTimes(2);
    const repair = repairText(1);
    expect(repair).toContain('left out figures this scene asserts');
    expect(repair).toContain(RISEN);
    const run = await getRun(runId);
    expect(run?.errorMessage).toContain(RISEN);
    expect(run?.errorMessage).toContain('the scene asserts');
    expect(run?.resultArtifactId).toBeNull();
    // Nothing shipped, and the rejection records its own class.
    expect(await encounterOf(campaign)).toBeUndefined();
    const draftStep = run?.steps.find((step) => step.name === 'draft');
    expect(rejectionIssues(draftStep ?? { output: null })[0]).toContain(RISEN);
  }, 30000);

  it('REFUSES a substitution that names an asserted figure — even though the roster honours it (pin 4)', async () => {
    // Revert-proof: dropping `assertedSubstitutionIssues` at the boundary lets
    // this reply through: the fight fields the figure AND declares it swapped,
    // which is a self-contradiction the rule refuses.
    const campaign = await smithSetup();
    chatMock.mockResolvedValue({
      text: draftReply({
        substitutions: [
          { asserted: RISEN, used: 'Ghoul Soldier', reason: 'no stat block in this campaign' },
        ],
      }),
      modelUsed: 'test-model',
      fallback: null,
    });

    const runId = await runEngine.startRun(smithInput(campaign));
    await waitForStatus(runId, 'failed');

    expect(chatMock).toHaveBeenCalledTimes(2);
    const repair = repairText(1);
    expect(repair).toContain('may not be substituted');
    const run = await getRun(runId);
    expect(run?.errorMessage).toContain('may not be substituted');
    expect(await encounterOf(campaign)).toBeUndefined();
  }, 30000);

  it('leaves a vague scene FREE — an empty asserted list constrains nothing (pin 5)', async () => {
    // The anti-invention half (docs/11): a scene that names no figure must not
    // be read as asserting one. Revert-proof: a rule that demanded an assertion
    // would fail this reply, and one that invented one would store a list here.
    const campaign = await smithSetup();
    const vagueBrief = 'Something waits at the crossing.';
    const base = JSON.parse(draftReply()) as Record<string, unknown>;
    delete base.assertedCast;
    chatMock.mockResolvedValue({ text: JSON.stringify(base), modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun({ ...smithInput(campaign), brief: vagueBrief });
    await waitForStatus(runId, 'completed');

    const encounter = await encounterOf(campaign);
    if (encounter?.kind !== 'encounter') throw new Error('no encounter artifact');
    expect(encounter.data.assertedCast ?? []).toEqual([]);
    expect(encounter.data.budgetAdvisory).not.toContain('Scene assertions transcribed');
    // The roster is the model's own design, unconstrained.
    expect(encounter.data.monsters.map((monster) => monster.name)).toEqual([RISEN]);
    // …and the prompt still states the freedom half.
    expect(promptText(0)).toContain('A vague scene is never a reason to invent an assertion');
  }, 30000);

  it('is visible on the row and survives a pause/resume UNCHANGED (pin 6)', async () => {
    // Revert-proof: a resume that re-derived the list (or dropped it) would
    // issue a SECOND draft chat call here — the run pauses at the draft, the
    // stored step output is what finalize reads back, and the artifact must
    // carry the same list the pause recorded.
    const campaign = await smithSetup();
    chatMock.mockResolvedValue({ text: draftReply(), modelUsed: 'test-model', fallback: null });

    const input = smithInput(campaign, 'manual');
    const runId = await runEngine.startRun(input);
    await waitForStatus(runId, 'awaiting_user');

    // The list is at rest in the run row (what a resume reads).
    const paused = await getRun(runId);
    const draftStep = paused?.steps.find((step) => step.name === 'draft');
    const stored = (draftStep?.output as { parsed?: { assertedCast?: unknown } } | undefined)?.parsed
      ?.assertedCast;
    expect(stored).toEqual([{ name: RISEN, count: 2 }]);
    expect(chatMock).toHaveBeenCalledTimes(1);

    await runEngine.approve(runId, input);
    await waitForStatus(runId, 'completed');

    // NO re-derivation: the draft was served exactly once for the whole run.
    expect(chatMock).toHaveBeenCalledTimes(1);
    const encounter = await encounterOf(campaign);
    if (encounter?.kind !== 'encounter') throw new Error('no encounter artifact');
    // The user-visible surface: the same list, stored on the row…
    expect(encounter.data.assertedCast).toEqual([{ name: RISEN, count: 2 }]);
    // …and named in the advisory block the encounter editor renders
    // (`features/campaign/components/kind-forms.tsx`).
    expect(encounter.data.budgetAdvisory).toContain(`"${RISEN}" ×2`);
  }, 30000);
});

// --- 2, 3 & 5 for the STOCKING lane (the Cartographer) ----------------------

/** A printed level for a filler creature. */
function filler(level: string): StatBlock {
  return monsterBlock(level);
}

/**
 * A single-arena reply whose FILLER sits inside the band for target level 4
 * (dnd5e band upper = 6) while a heavy asserted figure shares the room: the
 * colossus (level 12) plus one level-4 filler. Filler-only sum = 4.
 */
function arenaReply(asserted: { name: string; count: number } | null, includeColossus = true): string {
  return JSON.stringify({
    name: 'The Ash Gate',
    summary: 'A colossus holds the ruined gate.',
    body: '# The Ash Gate\nOne arena.',
    difficulty: 'hard',
    terrain: 'broken pillars',
    tactics: 'hold the gate',
    treasure: 'obsidian key',
    theme: 'ash-choked temple',
    styleNotes: 'inked fantasy map',
    negative: 'text, labels, tokens',
    environment: 'dungeon',
    monsters: [
      ...(includeColossus
        ? [{ name: 'Ash Colossus', count: 1, notes: '', treasure: '', statBlock: filler('12') }]
        : []),
      { name: 'Ash Cultist', count: 1, notes: '', treasure: '', statBlock: filler('4') },
    ],
    rooms: [
      {
        name: 'Entry',
        description: '',
        size: 'medium',
        monsterIndexes: includeColossus ? [0, 1] : [0],
        adjacentRoomIndexes: [],
        targetLevel: 4,
      },
    ],
    entryRoomIndex: 0,
    substitutions: [],
    ...(asserted === null ? {} : { assertedCast: [asserted] }),
  });
}

async function cartographerTarget(
  campaign: Campaign,
  asserted: { name: string; count: number }[],
  /** A single arena is classified by its OWN location kind (`building` here):
   *  a `dungeon` classification authorizes the stocking contract, and a
   *  1-room reply on that contract is a repairable shape issue. */
  locationKind: 'building' | 'dungeon' = 'building',
): Promise<Id> {
  const target = await createArtifact({
    campaignId: campaign.id,
    kind: 'encounter',
    name: 'The Ash Gate',
    data: {
      difficulty: '',
      levelHint: '',
      partyLevel: 4,
      monsters: [],
      terrain: '',
      tactics: '',
      treasure: '',
      mapImageId: null,
      layout: null,
      preset: locationKind === 'dungeon' ? 'dungeon' : 'standard',
      locationKind,
      siteShape: 'single',
      budgetAdvisory: '',
      ...(asserted.length === 0 ? {} : { assertedCast: asserted }),
    },
  });
  return target.id;
}

/**
 * A four-room complex whose FILLER sits inside every room's band for target
 * level 4 (band upper 6, one level-4 creature per room) while a heavy asserted
 * figure shares room one — and can be left OUT of the roster, which is the
 * shape pin 2 needs (the Cartographer is allowed to REPLACE the whole roster).
 */
function complexReply(includeColossus: boolean): string {
  return JSON.stringify({
    name: 'Ash Temple Undercroft',
    summary: 'A four-room crypt under the ash temple.',
    body: '# Ash Temple\nFour rooms of cultists.',
    difficulty: 'hard',
    terrain: 'crypt stone',
    tactics: 'hold the lines',
    treasure: 'cult hoard',
    theme: 'ash-choked crypt',
    styleNotes: 'inked fantasy map',
    negative: 'text, labels, tokens',
    environment: 'dungeon',
    monsters: [
      ...(includeColossus
        ? [{ name: 'Ash Colossus', count: 1, notes: '', treasure: '', statBlock: filler('12') }]
        : []),
      { name: 'Ash Cultist', count: 1, notes: '', treasure: '', statBlock: filler('4') },
      { name: 'Crypt Ghoul', count: 1, notes: '', treasure: '', statBlock: filler('4') },
      { name: 'Bone Acolyte', count: 1, notes: '', treasure: '', statBlock: filler('4') },
      { name: 'Ash Priest', count: 1, notes: '', treasure: '', statBlock: filler('4') },
    ],
    rooms: includeColossus
      ? [
          { name: 'Entry', description: '', size: 'medium', monsterIndexes: [0, 1], adjacentRoomIndexes: [1], targetLevel: 4 },
          { name: 'Ossuary', description: '', size: 'medium', monsterIndexes: [2], adjacentRoomIndexes: [0, 2], targetLevel: 4 },
          { name: 'Ritual Chamber', description: '', size: 'large', monsterIndexes: [3], adjacentRoomIndexes: [1, 3], targetLevel: 4 },
          { name: 'Sanctum', description: '', size: 'large', monsterIndexes: [4], adjacentRoomIndexes: [2], targetLevel: 4 },
        ]
      : [
          { name: 'Entry', description: '', size: 'medium', monsterIndexes: [0], adjacentRoomIndexes: [1], targetLevel: 4 },
          { name: 'Ossuary', description: '', size: 'medium', monsterIndexes: [1], adjacentRoomIndexes: [0, 2], targetLevel: 4 },
          { name: 'Ritual Chamber', description: '', size: 'large', monsterIndexes: [2], adjacentRoomIndexes: [1, 3], targetLevel: 4 },
          { name: 'Sanctum', description: '', size: 'large', monsterIndexes: [3], adjacentRoomIndexes: [2], targetLevel: 4 },
        ],
    entryRoomIndex: 0,
    substitutions: [],
  });
}

function cartographerInput(campaign: Campaign, targetArtifactId: Id): StartRunInput {
  return {
    campaign,
    persona: cartographerPersona(),
    autonomy: 'manual',
    brief: 'A temple gate encounter',
    pinnedChunkIds: [],
    targetArtifactId,
    encounterPartyLevel: 4,
    encounterMapAspect: '4:3',
  };
}

async function cartographerSetup(): Promise<Campaign> {
  const campaign = await createCampaign({ name: 'Map Assertions', system: 'dnd5e' });
  await saveSettings({ ...defaultSettings(), openRouterApiKey: 'test-key', imagesEnabled: true });
  drawFillGradeMock.mockReturnValue(70);
  return campaign;
}

describe('the Cartographer is BOUND by the stored asserted cast', () => {
  it('a filler within band plus a heavy asserted cast is ACCEPTED on the first pass (pin 3)', async () => {
    // Revert-proof: drop the exemption and this arm behaves exactly like the
    // control below — a repair turn, a lowered target and a loud over-budget
    // advisory for a fight whose FILLER is comfortably inside the band.
    const campaign = await cartographerSetup();
    const targetId = await cartographerTarget(campaign, [{ name: 'Ash Colossus', count: 1 }]);
    const stored = await getAnyArtifact(targetId);
    if (stored?.kind !== 'encounter') throw new Error('target row missing');
    // The ROW carries the list the scene reader persisted — this is what binds
    // the stocking lane (its own brief states no scene).
    expect(stored.data.assertedCast).toEqual([{ name: 'Ash Colossus', count: 1 }]);
    chatMock.mockResolvedValue({
      text: arenaReply({ name: 'Ash Colossus', count: 1 }),
      modelUsed: 'test-model',
      fallback: null,
    });

    const runId = await runEngine.startRun(cartographerInput(campaign, targetId));
    await waitForStatus(runId, 'awaiting_user');

    // ONE model call: the brief was accepted without a repair turn.
    expect(chatMock).toHaveBeenCalledTimes(1);
    const run = await getRun(runId);
    const briefStep = run?.steps.find((step) => step.name === 'brief');
    expect(briefStep?.status).toBe('done');
    const parsed = (briefStep?.output as { parsed?: { rooms?: { targetLevel?: number }[] } } | undefined)
      ?.parsed;
    // The room's target is UNTOUCHED — nothing lowered it for the colossus.
    expect(parsed?.rooms?.[0]?.targetLevel).toBe(4);
    const advisory = (briefStep?.output as { budgetAdvisory?: unknown } | undefined)?.budgetAdvisory;
    expect(typeof advisory === 'string' ? advisory : '').not.toContain('over its challenge budget');
    // The binding section reached the prompt from the ROW, not from the reply.
    const prompt = promptText(0);
    expect(prompt).toContain('ASSERTED CAST');
    expect(prompt).toContain('Ash Colossus');
    await runEngine.cancel(runId);
  }, 40000);

  it('the SAME reply without the assertion still takes the old over-budget repair (pin 3 control)', async () => {
    // The control arm: the differential's second half. Revert-proof: if the
    // exemption were unconditional this arm would also be accepted on pass one.
    const campaign = await cartographerSetup();
    const targetId = await cartographerTarget(campaign, []);
    chatMock.mockResolvedValue({
      text: arenaReply(null),
      modelUsed: 'test-model',
      fallback: null,
    });

    const runId = await runEngine.startRun(cartographerInput(campaign, targetId));
    await waitForStatus(runId, 'awaiting_user');

    // A repair turn happened (the over-budget room), then the deterministic
    // tail lowered that room's target a step and shipped the loud advisory.
    expect(chatMock).toHaveBeenCalledTimes(2);
    expect(repairText(1)).toContain('over the band');
    const run = await getRun(runId);
    const briefStep = run?.steps.find((step) => step.name === 'brief');
    expect(briefStep?.status).toBe('done');
    const parsed = (briefStep?.output as { parsed?: { rooms?: { targetLevel?: number }[] } } | undefined)
      ?.parsed;
    expect(parsed?.rooms?.[0]?.targetLevel).toBe(3);
    const advisory = (briefStep?.output as { budgetAdvisory?: unknown } | undefined)?.budgetAdvisory;
    expect(typeof advisory === 'string' ? advisory : '').toContain('over its challenge budget');
    // And the binding section is absent — nothing was transcribed for this row.
    expect(promptText(0)).not.toContain('ASSERTED CAST');
    await runEngine.cancel(runId);
  }, 40000);

  it('FAILS the run loudly when the restocked roster drops an asserted figure (pin 2, stocking lane)', async () => {
    // Revert-proof: without the stored-list gate this fresh population ships a
    // roster with no undead king — the hole the persisted list exists to close.
    const campaign = await cartographerSetup();
    const targetId = await cartographerTarget(
      campaign,
      [{ name: 'Ash Colossus', count: 1 }],
      'dungeon',
    );
    chatMock.mockResolvedValue({
      text: complexReply(false),
      modelUsed: 'test-model',
      fallback: null,
    });

    const runId = await runEngine.startRun({
      ...cartographerInput(campaign, targetId),
      autonomy: 'auto',
    });
    await waitForStatus(runId, 'failed');

    expect(chatMock).toHaveBeenCalledTimes(2);
    const repair = repairText(1);
    expect(repair).toContain('Ash Colossus');
    const run = await getRun(runId);
    expect(run?.errorMessage).toContain('Ash Colossus');
    expect(run?.errorMessage).toContain('the scene asserts');
    expect(run?.resultArtifactId).toBeNull();
  }, 40000);
});
