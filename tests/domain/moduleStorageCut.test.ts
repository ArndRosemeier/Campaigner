import { describe, expect, it } from 'vitest';

import {
  appendLevelText,
  assembleModuleDocument,
  ModuleDocumentError,
  moduleRowFromView,
  moduleSchema,
  moduleViewFromRow,
  replaceLevelText,
  splitModuleDocument,
  type Module,
  type ModulePart,
} from '@/domain';
import { newId } from '@/domain/entity';
import { DECLARED_DB_VERSION } from '@/db/cleanCut';

/**
 * THE STORAGE CUT (docs/23-CAMPAIGN-ARC §4–§5, docs/17 row 382, owner decision
 * = option A): the module ROW stores ONE document as the TEXT truth, plus the
 * GENERATOR'S working state the text cannot carry (plan / run state /
 * provenance / themes). `spine` and `parts` are DERIVED at read time. These pins
 * are PURE — no database — so they state the mapping itself.
 *
 * Two properties are load-bearing here and each has its own arms below:
 *  (1) the CAPTION LINE UNDER A SEPARATOR IS PROSE AND IS NEVER READ — a plan
 *      title is only ever the stored one, and an unplanned section gets a
 *      LABEL, never a value read out of prose (docs/23 §2, AGENTS rule 5);
 *  (2) composing must never turn prose into STRUCTURE — a body line that reads
 *      as a level header is refused LOUDLY, including the case that would
 *      otherwise parse VALIDLY and silently capture a level, because escaping
 *      it would change the text the owner wrote.
 */

function part(
  planIndex: number,
  markdown: string,
  overrides: Partial<ModulePart> = {},
): ModulePart {
  return {
    planIndex,
    markdown,
    status: 'ready',
    errorMessage: '',
    edited: true,
    writerModel: '',
    origin: null,
    ...overrides,
  };
}

function viewWithPlan(): Module {
  return moduleSchema.parse({
    id: newId(),
    createdAt: 1,
    updatedAt: 1,
    campaignId: newId(),
    title: 'The Gate Bargain',
    concept: '',
    levelMin: 1,
    levelMax: 2,
    tone: '',
    sizeDial: 'standard',
    spine: {
      premise: 'A drowned vault under the harbor.',
      themes: ['greed', 'tides'],
      partPlan: [
        {
          title: 'Approach',
          levelBand: '1',
          synopsis: 'Reach the sea gate.',
          levelUpTrigger: 'The tide turns.',
        },
        {
          title: 'Descent',
          levelBand: '2',
          synopsis: 'Dive the flooded stair.',
          levelUpTrigger: 'The vault seals.',
        },
      ],
      writerModel: 'writer/premise-model',
      origin: 'model',
    },
    parts: [
      part(0, '## The party bargains at the gate.', {
        writerModel: 'writer/part-a',
        origin: 'model',
      }),
      part(1, 'Under the docks.', { status: 'failed', errorMessage: 'loud failure' }),
    ],
    status: 'ready',
    errorMessage: '',
  });
}

/** A minimal premise-only module — the "starts with nothing" state. */
function emptyModule(): Module {
  return moduleSchema.parse({
    id: newId(),
    createdAt: 1,
    updatedAt: 1,
    campaignId: newId(),
    title: 'Nothing yet',
    concept: '',
    levelMin: 1,
    levelMax: 1,
    tone: '',
    sizeDial: 'sketch',
    spine: null,
    parts: [],
    status: 'draft',
    errorMessage: '',
  });
}

describe('the storage cut — the row stores the TEXT plus the generator state, and derives the legacy shape', () => {
  it('stores the document and NO spine/parts, and reads the view back', () => {
    const row = moduleRowFromView(viewWithPlan());

    expect('spine' in row).toBe(false);
    expect('parts' in row).toBe(false);
    expect(row.document).toContain('=====Level 1=====');
    expect(row.document).toContain('=====Level 2=====');
    expect(row.document.startsWith('A drowned vault under the harbor.')).toBe(true);
    // No character of the TEXT is stored twice: the parts' markdown lives only
    // in the document, and the stored plan/state carry none of it.
    expect(JSON.stringify(row.levelPlans)).not.toContain('The party bargains');
    expect(JSON.stringify(row.levelStates)).not.toContain('The party bargains');

    const back = moduleViewFromRow(row);
    expect(back.spine?.premise).toBe('A drowned vault under the harbor.');
    expect(back.parts.map((entry) => entry.markdown)).toEqual([
      '## The party bargains at the gate.',
      'Under the docks.',
    ]);
  });

  it('maps planIndex i to level section i + 1, with levelBand the exact number (never stored)', () => {
    const row = moduleRowFromView(viewWithPlan());
    expect(JSON.stringify(row.levelPlans)).not.toContain('levelBand');
    const back = moduleViewFromRow(row);
    expect(back.parts.map((entry) => entry.planIndex)).toEqual([0, 1]);
    expect(back.spine?.partPlan.map((entry) => entry.levelBand)).toEqual(['1', '2']);
  });

  it('round-trips the plan, themes, per-level run state and provenance (the STORED metadata)', () => {
    const back = moduleViewFromRow(moduleRowFromView(viewWithPlan()));
    expect(back.spine?.partPlan.map((entry) => entry.title)).toEqual(['Approach', 'Descent']);
    expect(back.spine?.partPlan.map((entry) => entry.synopsis)).toEqual([
      'Reach the sea gate.',
      'Dive the flooded stair.',
    ]);
    expect(back.spine?.partPlan.map((entry) => entry.levelUpTrigger)).toEqual([
      'The tide turns.',
      'The vault seals.',
    ]);
    expect(back.spine?.themes).toEqual(['greed', 'tides']);
    expect(back.spine?.writerModel).toBe('writer/premise-model');
    expect(back.spine?.origin).toBe('model');
    expect(back.parts[0]?.writerModel).toBe('writer/part-a');
    expect(back.parts[0]?.origin).toBe('model');
    expect(back.parts[0]?.edited).toBe(true);
    expect(back.parts[1]?.status).toBe('failed');
    expect(back.parts[1]?.errorMessage).toBe('loud failure');
  });

  it('NEVER reads the caption line under a separator into the plan title', () => {
    // The section's first line says one thing; the stored plan says another. The
    // plan wins, and nothing about the prose is read (docs/23 §2).
    const back = moduleViewFromRow(moduleRowFromView(viewWithPlan()));
    expect(back.parts[0]?.markdown.startsWith('## The party bargains')).toBe(true);
    expect(back.spine?.partPlan[0]?.title).toBe('Approach');

    // An UNPLANNED section (a part written before any plan) gets a LABEL.
    const planless = { ...viewWithPlan(), spine: null };
    const backPlanless = moduleViewFromRow(moduleRowFromView(planless));
    expect(backPlanless.spine?.partPlan[0]?.title).toBe('Level 1');
    expect(backPlanless.spine?.partPlan[0]?.synopsis).toBe('');
  });

  it('is null-spine exactly for the empty document — the "starts with nothing" state', () => {
    const row = moduleRowFromView(emptyModule());
    expect(row.document).toBe('');
    expect(row.levelPlans).toEqual([]);
    expect(moduleViewFromRow(row).spine).toBeNull();

    // A level-0-only document (a premise, zero separators) is legal and is NOT
    // the empty state.
    const premiseOnly = moduleViewFromRow(
      moduleRowFromView({
        ...emptyModule(),
        spine: {
          premise: 'Just a premise.',
          themes: [],
          partPlan: [],
          writerModel: '',
          origin: null,
        },
      }),
    );
    expect(premiseOnly.spine?.premise).toBe('Just a premise.');
  });

  it('round-trips a composed document BYTE-IDENTICALLY (derive ∘ compose is the identity)', () => {
    const withParts = moduleSchema.parse({
      ...emptyModule(),
      spine: {
        premise: 'The premise.',
        themes: [],
        partPlan: [
          { title: 'One', levelBand: '1', synopsis: '', levelUpTrigger: '' },
          { title: 'Two', levelBand: '2', synopsis: '', levelUpTrigger: '' },
        ],
        writerModel: '',
        origin: null,
      },
      parts: [part(0, '## One\n\nBody one.'), part(1, 'Body two.')],
    });
    const document = assembleModuleDocument({
      levels: [
        { number: 0, text: 'The premise.' },
        { number: 1, text: '## One\n\nBody one.' },
        { number: 2, text: 'Body two.' },
      ],
    });
    expect(moduleRowFromView(withParts).document).toBe(document);
    expect(moduleRowFromView(moduleViewFromRow(moduleRowFromView(withParts))).document).toBe(
      document,
    );
  });

  it('READS a document with more level sections than the plan-era cap of 20', () => {
    const levels: { number: number; text: string }[] = [{ number: 0, text: 'Premise.' }];
    for (let n = 1; n <= 25; n += 1) levels.push({ number: n, text: `Section ${String(n)}.` });
    const document = assembleModuleDocument({ levels });
    const row = moduleRowFromView(
      moduleSchema.parse({
        ...emptyModule(),
        spine: {
          premise: 'Premise.',
          themes: [],
          partPlan: [],
          writerModel: '',
          origin: null,
        },
      }),
    );
    const back = moduleViewFromRow({ ...row, document });
    expect(back.spine?.partPlan).toHaveLength(25);
    expect(back.spine?.partPlan[24]?.levelBand).toBe('25');
    expect(splitModuleDocument(document).levels).toHaveLength(26);
  });

  it('declares the clean-cut version: 32 (docs/23 §9)', () => {
    expect(DECLARED_DB_VERSION).toBe(32);
  });
});

describe('composing must never turn prose into STRUCTURE (docs/23 §3, row 382)', () => {
  const LOOKALIKE_BODY = 'The vault breathes.\n=====Level 2=====\nAnd again.';

  it('refuses a body whose separator-shaped line would PARSE VALIDLY as a new level', () => {
    // The dangerous direction: the composed document would read fine and the
    // prose line would silently BECOME level 2.
    const compose = (): string =>
      assembleModuleDocument({
        levels: [
          { number: 0, text: 'Premise.' },
          { number: 1, text: LOOKALIKE_BODY },
        ],
      });
    expect(compose).toThrow(ModuleDocumentError);
    let message = '';
    try {
      compose();
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toContain('=====Level 2=====');
    expect(message).toContain('level 1');
  });

  it('refuses every near-miss spelling too (case, spacing, indentation)', () => {
    for (const line of ['===== Level 2 =====', '====level 2====', '=====Level 02=====']) {
      expect(() =>
        assembleModuleDocument({
          levels: [
            { number: 0, text: 'Premise.' },
            { number: 1, text: `prose\n${line}` },
          ],
        }),
      ).toThrow(ModuleDocumentError);
    }
  });

  it('COMPOSES the same prose without the lookalike — the other direction', () => {
    const document = assembleModuleDocument({
      levels: [
        { number: 0, text: 'Premise.' },
        { number: 1, text: 'The vault breathes.\nAnd again.' },
      ],
    });
    expect(splitModuleDocument(document).levels).toHaveLength(2);
    expect(splitModuleDocument(document).levels[1]?.text).toBe('The vault breathes.\nAnd again.');
  });

  it('refuses the SAME body through the level-addressed edits (replace and append)', () => {
    const parsed = splitModuleDocument(
      assembleModuleDocument({
        levels: [
          { number: 0, text: 'Premise.' },
          { number: 1, text: 'Body.' },
        ],
      }),
    );
    expect(() => replaceLevelText(parsed, 1, LOOKALIKE_BODY)).toThrow(ModuleDocumentError);
    expect(() => appendLevelText(parsed, 1, LOOKALIKE_BODY)).toThrow(ModuleDocumentError);
    // The edits still do their normal work.
    expect(replaceLevelText(parsed, 1, 'A clean body.').parsed.levels[1]?.text).toBe('A clean body.');
  });
});
