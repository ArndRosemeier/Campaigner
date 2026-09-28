import { describe, expect, it } from 'vitest';

import {
  assembleModuleDocument,
  legacyViewFromModuleDocument,
  moduleDocumentFromLegacyView,
  moduleRowFromView,
  moduleSchema,
  moduleViewFromRow,
  type Module,
  type ModulePart,
} from '@/domain';
import { newId } from '@/domain/entity';
import { DECLARED_DB_VERSION } from '@/db/cleanCut';

/**
 * THE STORAGE CUT's derivation (docs/23-CAMPAIGN-ARC §4–§5, docs/17 row 382):
 * the module ROW stores ONE document and the legacy `spine`/`parts` shape is
 * DERIVED at read time. These pins are PURE — no database — so they state the
 * mapping itself rather than a repo path.
 *
 * The last pin declares what the mapping CANNOT carry. It is deliberately an
 * assertion of a LOSS: the temporary view must never be mistaken for a faithful
 * model, and the generator's plan/provenance round trip is the measured reason
 * phase 1b cannot land green on its own (see the row-382 report).
 */

function part(planIndex: number, markdown: string): ModulePart {
  return {
    planIndex,
    markdown,
    status: 'ready',
    errorMessage: '',
    edited: true,
    writerModel: '',
    origin: null,
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
      themes: ['greed'],
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
      writerModel: '',
      origin: null,
    },
    parts: [part(0, '## Approach\n\nThe party bargains at the gate.'), part(1, 'Under the docks.')],
    status: 'ready',
    errorMessage: '',
  });
}

describe('the storage cut — the row stores ONE document, the legacy shape is DERIVED', () => {
  it('stores the document and NO spine/parts, and reads the derivation back', () => {
    const view = viewWithPlan();
    const row = moduleRowFromView(view);

    expect('spine' in row).toBe(false);
    expect('parts' in row).toBe(false);
    expect(row.document).toContain('=====Level 1=====');
    expect(row.document).toContain('=====Level 2=====');
    expect(row.document.startsWith('A drowned vault under the harbor.')).toBe(true);

    const back = moduleViewFromRow(row);
    expect(back.spine?.premise).toBe('A drowned vault under the harbor.');
    expect(back.parts.map((entry) => entry.markdown)).toEqual([
      '## Approach\n\nThe party bargains at the gate.',
      'Under the docks.',
    ]);
  });

  it('maps planIndex i to level section i + 1, with levelBand the exact number', () => {
    const back = moduleViewFromRow(moduleRowFromView(viewWithPlan()));
    expect(back.parts.map((entry) => entry.planIndex)).toEqual([0, 1]);
    expect(back.spine?.partPlan.map((entry) => entry.levelBand)).toEqual(['1', '2']);
    // A level RANGE is not derivable — the band is the SECTION's own number.
    expect(back.spine?.partPlan.every((entry) => /^\d+$/.test(entry.levelBand))).toBe(true);
  });

  it('derives the deleted fields as empty (themes, synopsis, levelUpTrigger)', () => {
    const back = moduleViewFromRow(moduleRowFromView(viewWithPlan()));
    expect(back.spine?.themes).toEqual([]);
    expect(back.spine?.partPlan.map((entry) => entry.synopsis)).toEqual(['', '']);
    expect(back.spine?.partPlan.map((entry) => entry.levelUpTrigger)).toEqual(['', '']);
  });

  it('derives the plan TITLE from the section caption (first non-empty line, `#` stripped)', () => {
    const back = moduleViewFromRow(moduleRowFromView(viewWithPlan()));
    expect(back.spine?.partPlan.map((entry) => entry.title)).toEqual(['Approach', 'Under the docks.']);
  });

  it('is null-spine exactly for the empty document — the "starts with nothing" state', () => {
    const empty = moduleSchema.parse({
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
    const row = moduleRowFromView(empty);
    expect(row.document).toBe('');
    expect(moduleViewFromRow(row).spine).toBeNull();

    // A document that is level 0 ONLY (a premise, zero separators) is legal and
    // is NOT the empty state.
    const premiseOnly = moduleRowFromView({
      ...empty,
      spine: { premise: 'Just a premise.', themes: [], partPlan: [], writerModel: '', origin: null },
    });
    expect(moduleViewFromRow(premiseOnly).spine?.premise).toBe('Just a premise.');
  });

  it('round-trips a composed document BYTE-IDENTICALLY (derive ∘ compose is the identity)', () => {
    const document = assembleModuleDocument({
      levels: [
        { number: 0, text: 'The premise.' },
        { number: 1, text: '## One\n\nBody one.' },
        { number: 2, text: 'Body two.' },
      ],
    });
    expect(moduleDocumentFromLegacyView(legacyViewFromModuleDocument(document))).toBe(document);
  });

  it('THE DECLARED LOSS: a plan-authored title/synopsis does NOT survive the round trip', () => {
    // This is the fork the row-382 report puts to the dispatcher, pinned so the
    // temporary view cannot silently pass as faithful. The generator authors
    // `partPlan` BEFORE its parts exist and the document has no slot for the
    // plan's own title/synopsis, so a section whose text does not happen to
    // OPEN with the planned title reads its caption back instead — and a
    // section with NO text yet (the pass-0 state) reads the `Level N` fallback.
    const view = viewWithPlan();
    const back = moduleViewFromRow(moduleRowFromView(view));
    expect(view.spine?.partPlan[1]?.title).toBe('Descent');
    expect(back.spine?.partPlan[1]?.title).toBe('Under the docks.');
    expect(back.spine?.partPlan[1]?.synopsis).toBe('');
    expect(back.spine?.partPlan[1]?.levelUpTrigger).toBe('');

    const emptyPlan = { ...view, parts: [] };
    const emptyBack = moduleViewFromRow(moduleRowFromView(emptyPlan));
    expect(emptyPlan.spine?.partPlan.map((entry) => entry.title)).toEqual(['Approach', 'Descent']);
    expect(emptyBack.spine?.partPlan.map((entry) => entry.title)).toEqual(['Level 1', 'Level 2']);
    expect(emptyBack.spine?.partPlan.map((entry) => entry.synopsis)).toEqual(['', '']);
  });

  it('declares the clean-cut version: 32 (docs/23 §9)', () => {
    expect(DECLARED_DB_VERSION).toBe(32);
  });
});
