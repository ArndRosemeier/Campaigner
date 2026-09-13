import 'fake-indexeddb/auto';

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { createPersona } from '@/db/personaRepo';
import { getRun } from '@/db/runRepo';
import { saveSettings } from '@/db/settingsRepo';
import { db } from '@/db';
import { defaultSettings, type Id, type Persona, type RunStep } from '@/domain';
import { rejectedStepOutput, rejectedStepSentence, rejectionReasons } from '@/llm/rejectionReason';
import { REJECTION_CLAUSES, REJECTION_REASONS } from '@/llm/rejectionReason';
import { runEngine, type StartRunInput } from '@/llm/runEngine';
import { SCHEMA_REPAIR_LEAD_IN } from '@/llm/promptScaffolding';
import { chat } from '@/llm/openrouter';
import { clearDatabase } from '../db/helpers';

/**
 * A rejected step says WHY it was rejected — the class is recorded where the
 * refusal is RAISED, and ONE sentence is composed from it (docs/17 row 152;
 * docs/18 §2.2).
 *
 * THE DEFECT. The engine's auto-autonomy failure sentence claimed *"could not
 * be parsed into the required JSON shape after one automatic retry"* for every
 * rejection class — the prompt-scaffolding echo of row 142 among them, which
 * has nothing to do with JSON. The pins below hold BOTH halves: the sentence
 * each class gets, and the fact that the class reaches the sentence from the
 * SITE that decided it (so neither half can be satisfied by a table nobody
 * fills in).
 *
 * The `invalid-json` sentence is pinned BYTE FOR BYTE to the pre-152 wording
 * (the same literal `tests/llm/runNotCompletedReason.test.ts` uses), because
 * every rejection that was ALREADY truthful had to come out unmoved.
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

const chatMock = vi.mocked(chat);
const { searchRules } = await import('@/search');
vi.mocked(searchRules).mockResolvedValue([]);

/** The tail every rejection sentence ends with, transcribed (the composer's
 * own wording, never imported): a reworded tail reds this file. */
const TAIL =
  '. The run failed without saving partial results — run it again, ' +
  'or use manual/review autonomy to keep the raw reply for editing.';

/**
 * The pre-152 sentence for a JSON rejection — copied from the pin that already
 * existed (`tests/llm/runNotCompletedReason.test.ts`), so "byte-identical" is
 * measured against the OLD literal rather than against this change.
 */
const HISTORIC_JSON_SENTENCE =
  'Step "draft" rejected: the model reply could not be parsed into the required JSON shape ' +
  'after one automatic retry' +
  TAIL;

/** A rejected step exactly as `rejectedStepOutput` writes one. */
function rejectedStep(
  reasons: Parameters<typeof rejectedStepOutput>[2],
  issues: string[] = ['draft.body: expected string, received number'],
  raw = 'the model reply',
): RunStep {
  return {
    index: 1,
    name: 'draft',
    status: 'rejected',
    input: {},
    output: rejectedStepOutput(raw, issues, reasons),
    userEdit: null,
  };
}

describe('one sentence per rejection class (docs/17 row 152)', () => {
  it('invalid-json: the pre-152 sentence, BYTE FOR BYTE', () => {
    // No issues: the historic literal, character for character.
    expect(rejectedStepSentence('draft', rejectedStep(['invalid-json'], []))).toBe(
      HISTORIC_JSON_SENTENCE,
    );
    // With issues: the same sentence plus the engine's long-standing
    // `(issue; issue)` parenthetical.
    expect(rejectedStepSentence('draft', rejectedStep(['invalid-json']))).toBe(
      'Step "draft" rejected: the model reply could not be parsed into the required JSON shape ' +
        'after one automatic retry (draft.body: expected string, received number)' +
        TAIL,
    );
  });

  it('unresolved-source: a monster with no stat source, and it does NOT claim JSON', () => {
    const sentence = rejectedStepSentence('draft', rejectedStep(['unresolved-source'], ['monsters[0] "Ash Cultist": add sourceChunkIndex…']));
    expect(sentence).toBe(
      'Step "draft" rejected: the reply cited monsters with no stat source this run could ' +
        'resolve, after one automatic repair attempt (monsters[0] "Ash Cultist": add sourceChunkIndex…)' +
        TAIL,
    );
    expect(sentence).not.toContain(REJECTION_CLAUSES['invalid-json']);
  });

  it('ability-convention: printed signed abilities, and it does NOT claim JSON', () => {
    const sentence = rejectedStepSentence(
      'statblock',
      rejectedStep(['ability-convention'], ['abilities.dex is "+3"']),
    );
    expect(sentence).toBe(
      'Step "statblock" rejected: the stat block printed signed ability values where the d20 ' +
        'score is required, after one automatic repair attempt (abilities.dex is "+3")' +
        TAIL,
    );
    expect(sentence).not.toContain(REJECTION_CLAUSES['invalid-json']);
  });

  it('brief-contract: the encounter brief broke its own contract, and it does NOT claim JSON', () => {
    const sentence = rejectedStepSentence(
      'brief',
      rejectedStep(['brief-contract'], ['rooms: an encounter is either a single arena…']),
    );
    expect(sentence).toBe(
      "Step \"brief\" rejected: the reply parsed, but it broke the encounter brief's own " +
        'contract (room shape, roster, or level budget) after one automatic repair attempt ' +
        '(rooms: an encounter is either a single arena…)' +
        TAIL,
    );
    expect(sentence).not.toContain(REJECTION_CLAUSES['invalid-json']);
  });

  it('escape-debris: half-formed unicode escapes, and it does NOT claim JSON', () => {
    const sentence = rejectedStepSentence(
      'finalize',
      rejectedStep(['escape-debris'], ['draft.body contains escape debris "?fc"']),
    );
    expect(sentence).toBe(
      'Step "finalize" rejected: the generated text carries half-formed unicode escapes, ' +
        'which is refused at the boundary that would persist it (draft.body contains escape debris "?fc")' +
        TAIL,
    );
    expect(sentence).not.toContain(REJECTION_CLAUSES['invalid-json']);
  });

  it('scaffolding-echo: our own prompt scaffolding echoed back, and it does NOT claim JSON', () => {
    const sentence = rejectedStepSentence(
      'finalize',
      rejectedStep(['scaffolding-echo'], [
        'draft.body contains our own prompt scaffolding the schema-repair lead-in',
      ]),
    );
    expect(sentence).toBe(
      'Step "finalize" rejected: the generated text echoed our own prompt scaffolding back ' +
        'as content, which is refused at the boundary that would persist it (draft.body ' +
        'contains our own prompt scaffolding the schema-repair lead-in)' +
        TAIL,
    );
    // The exact lie of row 145: this refusal used to be reported as JSON.
    expect(sentence).not.toContain(REJECTION_CLAUSES['invalid-json']);
    expect(sentence).not.toContain('JSON');
  });
});

describe('the classes and their sentences come from ONE exhaustive record', () => {
  it('every class has a clause, and no two classes share one', () => {
    expect(Object.keys(REJECTION_CLAUSES).sort()).toEqual([...REJECTION_REASONS].sort());
    const clauses = REJECTION_REASONS.map((reason) => REJECTION_CLAUSES[reason]);
    for (const clause of clauses) expect(clause.trim()).not.toBe('');
    expect(new Set(clauses).size).toBe(clauses.length);
    // The union is non-empty and the JSON class is IN it (the historic one).
    expect(REJECTION_REASONS).toContain('invalid-json');
    expect(REJECTION_REASONS.length).toBeGreaterThan(1);
  });

  it('a step cannot record a class without its own sentence', () => {
    // A class added to the union without a clause is a COMPILE error (the
    // `Record<RejectionReason, string>` above); this pins the RUN-TIME half:
    // a sentence always carries its own class's clause and no other's.
    for (const reason of REJECTION_REASONS) {
      const sentence = rejectedStepSentence('draft', rejectedStep([reason]));
      expect(sentence, reason).toContain(REJECTION_CLAUSES[reason]);
      for (const other of REJECTION_REASONS) {
        if (other === reason) continue;
        expect(sentence.includes(REJECTION_CLAUSES[other]), `${reason} claims ${other}`).toBe(false);
      }
    }
  });

  it('a rejected output cannot be built without a class', () => {
    expect(() => rejectedStepOutput('raw', ['an issue'], [])).toThrow(/must record WHY/);
  });

  it('the reader tolerates a stored value outside the union without inventing one', () => {
    const step = { output: { raw: 'x', issues: ['i'], reasons: ['not-a-class', 'invalid-json', 'invalid-json'] } };
    expect(rejectionReasons(step)).toEqual(['invalid-json']);
    expect(rejectionReasons({ output: { raw: 'x', issues: [] } })).toEqual([]);
    expect(rejectionReasons({ output: null })).toEqual([]);
  });
});

describe('a legacy row (no class recorded) tells the truth', () => {
  const legacy = (issues: string[]): RunStep => ({
    index: 1,
    name: 'draft',
    status: 'rejected',
    input: {},
    output: { raw: 'the model reply', issues },
    userEdit: null,
  });

  it('says it records no class — and NEVER that the reply was unparseable JSON', () => {
    const sentence = rejectedStepSentence('draft', legacy(['draft.body: expected string']));
    expect(sentence).toBe(
      'Step "draft" rejected: this run row records no rejection class (it predates the engine ' +
        'recording them) — the issues it stored are the reason (draft.body: expected string)' +
        TAIL,
    );
    expect(sentence).not.toContain('JSON');
    expect(sentence).not.toContain(REJECTION_CLAUSES['invalid-json']);
  });

  it('says NO issues were stored either when the row carries none', () => {
    const sentence = rejectedStepSentence('draft', legacy([]));
    expect(sentence).toBe(
      'Step "draft" rejected: this run row records no rejection class (it predates the engine ' +
        'recording them) and no issues either' +
        TAIL,
    );
    expect(sentence).not.toContain('JSON');
  });

  it('a row carrying the field with an unknown value is not read as JSON either', () => {
    const sentence = rejectedStepSentence('draft', {
      output: { raw: 'x', issues: ['i'], reasons: ['json-ish'] },
    });
    expect(sentence).not.toContain('JSON');
    expect(sentence).toContain('records no rejection class');
  });
});

describe('SCAN — the class is recorded at the site that refuses (docs/17 row 152)', () => {
  const SEAM = 'llm/runEngine.ts';
  const source = (file: string): string => readFileSync(join(process.cwd(), 'src', file), 'utf8');

  function srcFiles(): string[] {
    const root = join(process.cwd(), 'src');
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (/\.tsx?$/.test(entry.name)) {
          found.push(full.slice(root.length + 1).replace(/\\/g, '/'));
        }
      }
    };
    walk(root);
    return found.sort();
  }

  it('every rejected step in the engine is built by `rejectedStepOutput` — so it carries a class', () => {
    const text = source(SEAM);
    // `outcome.status === 'rejected'` is a PROMISE verdict (parallel.ts), not
    // a step status: counted separately and subtracted, so the two ideas
    // cannot be confused by this scan either.
    const promiseVerdict = "outcome.status === 'rejected'";
    const rejectedStatuses =
      text.split("'rejected',").length - 1 - text.split(promiseVerdict).length + 1;
    const constructions = text.split('rejectedStepOutput(').length - 1;
    // Seven deciding sites at this base (docs/17 row 152 lists them by name);
    // the counts must be EQUAL, so a new site that calls `finishStep` with
    // 'rejected' and a hand-built output reds this pin.
    expect(rejectedStatuses).toBe(7);
    expect(constructions).toBe(rejectedStatuses);
    // And no site may hand-roll the output object beside the constructor.
    expect(text).not.toContain("{ raw, issues }, 'rejected'");
    expect(text).not.toContain("{ raw, issues: sourceIssues }, 'rejected'");
    expect(text).not.toContain("{ raw, issues: abilityIssues }, 'rejected'");
  });

  it('the sentence is composed in exactly ONE place, and the engine composes none of it', () => {
    const holders = srcFiles().filter((file) =>
      source(file).includes('could not be parsed into the required'),
    );
    expect(holders).toEqual(['llm/rejectionReason.ts']);
    // The engine reads the seam instead of writing the sentence itself.
    expect(source(SEAM)).toContain('rejectedStepSentence(name, outcome.step)');
    expect(source(SEAM)).not.toContain('after one automatic retry');
  });

  it('the classes are attached BY NAME where each refusal is decided', () => {
    const text = source(SEAM);
    // Three JSON boundaries (draft, stat block, continuity report), one per
    // class decided by its own detector, and the two whose classes arrive
    // from the mechanism that produced the issues.
    expect(text.split("rejectedStepOutput(raw, issues, ['invalid-json'])").length - 1).toBe(3);
    expect(text.split("rejectedStepOutput(raw, sourceIssues, ['unresolved-source'])").length - 1).toBe(1);
    expect(text.split("rejectedStepOutput(raw, abilityIssues, ['ability-convention'])").length - 1).toBe(1);
    expect(text.split('rejectedStepOutput(raw, evaluated.issues, evaluated.reasons)').length - 1).toBe(1);
    expect(
      text.split('rejectedStepOutput(JSON.stringify(draft), hygiene.issues, hygiene.reasons)').length - 1,
    ).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* The deciding sites, end to end: the engine's own sentence           */
/* ------------------------------------------------------------------ */

const VALID_DRAFT = {
  name: 'Grix',
  summary: 'A goblin alchemist boss.',
  suggestedTags: ['goblin', 'alchemist'],
  body: '# Grix\nShe brews. She throws.',
  appearance: 'Small, soot-stained, goggles.',
  personality: 'Manic, cheerful, volatile.',
  needsStatBlock: true,
};

const VALID_STATBLOCK = {
  system: 'dnd5e',
  level: '3',
  size: 'Small',
  creatureType: 'humanoid (goblinoid)',
  ac: 14,
  acNote: 'leather armor',
  hp: 22,
  hpFormula: '5d6 + 5',
  speed: '30 ft.',
  abilities: { str: 8, dex: 16, con: 13, int: 14, wis: 10, cha: 12 },
  saves: '',
  skills: '',
  senses: '',
  languages: 'Common, Goblin',
  traits: [],
  actions: [],
  reactions: [],
  legendary: [],
  extras: { CR: '1' },
};

async function seedNpc(): Promise<{ campaignId: Id; persona: Persona }> {
  const campaign = await createCampaign({ name: 'Rejection Reason Campaign', system: 'dnd5e' });
  const persona = await createPersona({
    slug: 'npc-rejection-reason-test',
    name: 'NPC Smith',
    description: 'test',
    systemPrompt: 'You are a test persona. Reply with JSON only.',
    producesKind: 'npc',
    builtIn: true,
  });
  return { campaignId: campaign.id, persona };
}

const NPC_INPUT = (campaignId: Id, persona: Persona): StartRunInput => ({
  campaign: {
    id: campaignId,
    name: 'Rejection Reason Campaign',
    system: 'dnd5e',
    description: '',
    coverImageId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  persona,
  autonomy: 'auto',
  brief: 'a goblin alchemist boss for a level 3 party',
  pinnedChunkIds: [],
});

/** The encounter pipeline's own seeding (the Cartographer's harness, trimmed
 * to what the brief boundary needs). */
async function seedEncounter(): Promise<{ campaign: Awaited<ReturnType<typeof createCampaign>>; persona: Persona }> {
  const campaign = await createCampaign({ name: 'Rejection Reason Map', system: 'dnd5e' });
  const cartographer = await createPersona({
    slug: 'encounter-rejection-reason-test',
    name: 'Encounter Cartographer',
    description: '',
    systemPrompt: 'Return encounter JSON.',
    mode: 'encounter',
    producesKind: 'encounter',
    builtIn: true,
  });
  await db.personas.put(cartographer);
  return { campaign, persona: cartographer };
}

const ENCOUNTER_INPUT = (
  campaign: Awaited<ReturnType<typeof createCampaign>>,
  persona: Persona,
): StartRunInput => ({
  campaign,
  persona,
  autonomy: 'auto',
  brief: 'A temple gate encounter',
  pinnedChunkIds: [],
  encounterMapAspect: '4:3',
});

const INLINE_STATBLOCK = {
  system: 'dnd5e',
  level: '1',
  size: 'Medium',
  creatureType: 'humanoid',
  ac: 12,
  acNote: '',
  hp: 7,
  hpFormula: '2d6',
  speed: '30 ft.',
  abilities: { str: 10, dex: 12, con: 10, int: 10, wis: 10, cha: 10 },
  saves: '',
  skills: '',
  senses: '',
  languages: '',
  traits: [],
  actions: [],
  reactions: [],
  legendary: [],
  extras: {},
};

const ENCOUNTER_BRIEF = {
  name: 'Ash Gate Ambush',
  summary: 'Cultists guard a ruined gate.',
  body: '# Ash Gate\nA room-by-room battle.',
  difficulty: 'hard',
  levelHint: '4',
  terrain: 'broken pillars',
  tactics: 'fall back through the gate',
  treasure: 'obsidian key',
  theme: 'ash-choked temple',
  styleNotes: 'inked fantasy map, volcanic stone',
  negative: 'text, labels, tokens',
  monsters: [
    { name: 'Ash Cultist', count: 2, notes: '', treasure: '', statBlock: INLINE_STATBLOCK },
  ],
  rooms: [
    {
      name: 'Entry',
      description: 'Broken doors',
      size: 'medium',
      monsterIndexes: [0],
      adjacentRoomIndexes: [],
      key: 'Cracked doors hang off one hinge.',
      keyTreasure: 'Fallen banner: 15 gp',
    },
  ],
  entryRoomIndex: 0,
};

/** Asserts the sentence the OWNER reads, composed from the class the site
 * recorded, without asking the composer what it should be. */
function expectClassSentence(
  errorMessage: string | undefined,
  stepName: string,
  reason: (typeof REJECTION_REASONS)[number],
): void {
  expect(errorMessage, 'a failed run must carry its sentence').toBeTypeOf('string');
  const sentence = errorMessage ?? '';
  expect(sentence).toContain(`Step "${stepName}" rejected: ${REJECTION_CLAUSES[reason]}`);
  expect(sentence.endsWith(TAIL)).toBe(true);
  for (const other of REJECTION_REASONS) {
    if (other === reason) continue;
    expect(sentence.includes(REJECTION_CLAUSES[other]), `claimed ${other}`).toBe(false);
  }
}

async function failedRun(): Promise<{ errorMessage: string | undefined; step: RunStep | undefined }> {
  const runs = await db.runs.toArray();
  const run = runs.at(-1);
  const steps = run?.steps ?? [];
  const rejected = steps.find((step) => step.status === 'rejected');
  return { errorMessage: run?.errorMessage, step: rejected };
}

beforeEach(async () => {
  await clearDatabase();
  chatMock.mockReset();
  vi.mocked(searchRules).mockResolvedValue([]);
  await saveSettings({ ...defaultSettings(), openRouterApiKey: 'test-key' });
});

afterEach(() => {
  chatMock.mockReset();
  vi.restoreAllMocks();
});

describe('the refusing site records the class the sentence is composed from', () => {
  it('draft → invalid-json: the auto run fails with the PRE-152 sentence, byte for byte', async () => {
    const { campaignId, persona } = await seedNpc();
    chatMock.mockResolvedValue({ text: 'still not json', modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun(NPC_INPUT(campaignId, persona));
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('failed');
    }, { timeout: 20000 });

    const { errorMessage, step } = await failedRun();
    expect(rejectionReasons(step ?? { output: null })).toEqual(['invalid-json']);
    // Not the composer's own answer: the OLD literal is the sentence's PREFIX,
    // with the engine's long-standing issue parenthetical after it.
    expect(errorMessage?.startsWith(HISTORIC_JSON_SENTENCE.replace(TAIL, ''))).toBe(true);
    expect(errorMessage?.endsWith(TAIL)).toBe(true);
    expectClassSentence(errorMessage, 'draft', 'invalid-json');
  }, 20000);

  it('statblock JSON → invalid-json', async () => {
    const { campaignId, persona } = await seedNpc();
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockResolvedValue({ text: 'not a stat block', modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun(NPC_INPUT(campaignId, persona));
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('failed');
    }, { timeout: 20000 });

    const { errorMessage, step } = await failedRun();
    expect(step?.name).toBe('statblock');
    expect(rejectionReasons(step ?? { output: null })).toEqual(['invalid-json']);
    expectClassSentence(errorMessage, 'statblock', 'invalid-json');
  }, 20000);

  it('statblock printed signed abilities → ability-convention', async () => {
    const { campaignId, persona } = await seedNpc();
    const signed = {
      ...VALID_STATBLOCK,
      system: 'pathfinder2e',
      abilities: { ...VALID_STATBLOCK.abilities, dex: '+3' },
    };
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_DRAFT), modelUsed: 'test-model', fallback: null })
      .mockResolvedValue({ text: JSON.stringify(signed), modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun(NPC_INPUT(campaignId, persona));
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('failed');
    }, { timeout: 20000 });

    const { errorMessage, step } = await failedRun();
    expect(step?.name).toBe('statblock');
    expect(rejectionReasons(step ?? { output: null })).toEqual(['ability-convention']);
    expectClassSentence(errorMessage, 'statblock', 'ability-convention');
    // The named issue is still there, under an honest label.
    expect(errorMessage).toContain('abilities.dex is "+3"');
  }, 20000);

  it('escape debris in the finalized draft → escape-debris (this is the row-145 lie)', async () => {
    const { campaignId, persona } = await seedNpc();
    chatMock
      .mockResolvedValueOnce({
        text: JSON.stringify({ ...VALID_DRAFT, body: 'Die Flussm?fcndung glitzert.' }),
        modelUsed: 'test-model',
        fallback: null,
      })
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_STATBLOCK), modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun(NPC_INPUT(campaignId, persona));
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('failed');
    }, { timeout: 20000 });

    const { errorMessage, step } = await failedRun();
    expect(step?.name).toBe('finalize');
    expect(rejectionReasons(step ?? { output: null })).toEqual(['escape-debris']);
    expectClassSentence(errorMessage, 'finalize', 'escape-debris');
    expect(errorMessage).toContain('escape debris');
    expect(errorMessage).not.toContain('JSON');
  }, 20000);

  it('our own prompt scaffolding echoed into the finalized draft → scaffolding-echo', async () => {
    const { campaignId, persona } = await seedNpc();
    chatMock
      .mockResolvedValueOnce({
        text: JSON.stringify({ ...VALID_DRAFT, body: `${SCHEMA_REPAIR_LEAD_IN} the room is dark.` }),
        modelUsed: 'test-model',
        fallback: null,
      })
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_STATBLOCK), modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun(NPC_INPUT(campaignId, persona));
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('failed');
    }, { timeout: 20000 });

    const { errorMessage, step } = await failedRun();
    expect(step?.name).toBe('finalize');
    expect(rejectionReasons(step ?? { output: null })).toEqual(['scaffolding-echo']);
    expectClassSentence(errorMessage, 'finalize', 'scaffolding-echo');
    expect(errorMessage).toContain('prompt scaffolding');
    // THE DEFECT OF ROW 145, pinned as the thing that must never come back.
    expect(errorMessage).not.toContain('could not be parsed into the required JSON shape');
  }, 20000);

  it('encounter draft monster with no stat source → unresolved-source', async () => {
    const { campaign, persona } = await seedEncounter();
    const noSource = {
      ...ENCOUNTER_BRIEF,
      monsters: [{ name: 'Ash Cultist', count: 2, notes: '', treasure: '' }],
    };
    chatMock.mockResolvedValue({ text: JSON.stringify(noSource), modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun(ENCOUNTER_INPUT(campaign, persona));
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('failed');
    }, { timeout: 20000 });

    const { errorMessage, step } = await failedRun();
    expect(step?.name).toBe('brief');
    expect(rejectionReasons(step ?? { output: null })).toEqual(['unresolved-source']);
    expectClassSentence(errorMessage, 'brief', 'unresolved-source');
  }, 20000);

  it('encounter brief that ignores the room-shape contract → brief-contract', async () => {
    const { campaign, persona } = await seedEncounter();
    const twoRooms = {
      ...ENCOUNTER_BRIEF,
      rooms: [
        ENCOUNTER_BRIEF.rooms[0],
        {
          name: 'Sanctum',
          description: '',
          size: 'large',
          monsterIndexes: [0],
          adjacentRoomIndexes: [0],
          key: '',
          keyTreasure: '',
        },
      ],
    };
    chatMock.mockResolvedValue({ text: JSON.stringify(twoRooms), modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun(ENCOUNTER_INPUT(campaign, persona));
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('failed');
    }, { timeout: 20000 });

    const { errorMessage, step } = await failedRun();
    expect(step?.name).toBe('brief');
    expect(rejectionReasons(step ?? { output: null })).toEqual(['brief-contract']);
    expectClassSentence(errorMessage, 'brief', 'brief-contract');
    expect(errorMessage).toContain('rooms: an encounter is either a single arena');
  }, 20000);

  it('the encounter brief that never PARSES is still invalid-json (the split is decided per branch)', async () => {
    const { campaign, persona } = await seedEncounter();
    chatMock.mockResolvedValue({ text: 'not json at all', modelUsed: 'test-model', fallback: null });

    const runId = await runEngine.startRun(ENCOUNTER_INPUT(campaign, persona));
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('failed');
    }, { timeout: 20000 });

    const { errorMessage, step } = await failedRun();
    expect(rejectionReasons(step ?? { output: null })).toEqual(['invalid-json']);
    expectClassSentence(errorMessage, 'brief', 'invalid-json');
  }, 20000);
});
