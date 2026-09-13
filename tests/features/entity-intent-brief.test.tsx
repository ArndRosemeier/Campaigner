import 'fake-indexeddb/auto';

import { render, renderHook, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  assembleModulePartsDocument,
  createModule,
  entityIntentFor,
  moduleDocumentText,
  moduleEntityKindSchema,
  newId,
  type Module,
  type ModuleEntityKind,
} from '@/domain';
import { WikiMarkdown } from '@/features/campaign/components/wiki-markdown';
import { buildEntityBrief } from '@/features/modules/persona-request';
import { useModuleEntities } from '@/features/modules/use-module-entities';
import { buildModuleDefinition } from '@/lib/modulePdf';

/**
 * The entity intent PARAGRAPH in the detail brief, and its absence from every
 * surface a reader sees (08-MODULE-DESIGNER §M4-C "Entity intent", docs/17 row
 * 141).
 *
 * Two properties are the whole contract here:
 *
 * 1. A record WITH a note puts ONE paragraph — the spec's own sentence, written
 *    out verbatim below — immediately before the `Additional instruction: …`
 *    paragraph and after the kind's OWNERSHIP boundary, and the REST of the
 *    brief is untouched (removing exactly that paragraph plus one blank line
 *    reproduces the no-intent brief byte for byte).
 * 2. A record with NO note — key absent, `null`, `''`, whitespace — produces the
 *    brief this builder produced before the field existed, BYTE FOR BYTE. The
 *    pre-existing brief pins (`tests/features/persona-request.test.ts`,
 *    `tests/llm/kindOwnershipBoundary.test.ts`) are the other half of that
 *    guarantee and are deliberately UNTOUCHED by this landing.
 */
const NAME = 'The Salt Market';
const CONTEXT = 'The party crosses [[The Salt Market]] at dusk, when the stalls empty.';
const PREMISE = 'A harbor town raised its bell to warn of the drownings.';
const NOTE = 'The market is a front for the smugglers; play the bustle as fear.';
const INSTRUCTION = 'Park her at the docks.';

/**
 * The spec's paragraph, transcribed — NOT imported — so this pin fails if the
 * landing rewrites the hierarchy sentence instead of only adding the note.
 */
const INTENT_PARAGRAPH =
  `The module's author intended: ${NOTE}. ` +
  'This steers EMPHASIS and OWNERSHIP; what the module text states is fixed, ' +
  'and your own charter still governs what this kind may contain.';

/** The record as the spine pass and the normalizer write it — the `null` arm
 * goes through the REAL parse, because that is what a stored row does. */
function record(intent: string | null | undefined): ModuleEntityKind {
  return moduleEntityKindSchema.parse({
    name: NAME,
    kind: 'location',
    absorbed: [],
    ...(intent === undefined ? {} : { intent }),
  });
}

/** The brief built the way BOTH real callers build it: note read off the record. */
function briefFrom(records: readonly ModuleEntityKind[]): string {
  return buildEntityBrief(
    NAME,
    CONTEXT,
    PREMISE,
    2,
    [],
    false,
    'location',
    INSTRUCTION,
    entityIntentFor(records, NAME),
  );
}

afterEach(cleanup);

describe('a record WITH an intent puts the paragraph in the brief, in the specified position', () => {
  it('the brief is the no-intent brief plus ONE paragraph, immediately before the instruction', () => {
    const withIntent = briefFrom([record(NOTE)]);
    const withoutIntent = briefFrom([record(undefined)]);

    // 1. The paragraph is there, verbatim.
    expect(withIntent).toContain(INTENT_PARAGRAPH);
    // 2. Exact composition: deleting exactly that paragraph and the blank line
    //    it brought leaves the no-intent brief character for character — so the
    //    rest of the brief did not move, and nothing else was added.
    expect(withIntent.replace(`${INTENT_PARAGRAPH}\n\n`, '')).toBe(withoutIntent);
  });

  it('it sits AFTER the kind’s ownership boundary and BEFORE the instruction', () => {
    const brief = briefFrom([record(NOTE)]);
    const boundary = brief.indexOf('What this artifact OWNS — one fact, one owner:');
    const intent = brief.indexOf(INTENT_PARAGRAPH);
    const instruction = brief.indexOf(`Additional instruction: ${INSTRUCTION}`);
    expect(boundary).toBeGreaterThan(-1);
    expect(intent).toBeGreaterThan(boundary);
    expect(instruction).toBeGreaterThan(intent);
    expect(brief.endsWith(`Additional instruction: ${INSTRUCTION}`)).toBe(true);
  });

  it('the note is TRIMMED and rendered as ONE paragraph, whatever the record carries', () => {
    expect(briefFrom([record(`  ${NOTE}  `)])).toBe(briefFrom([record(NOTE)]));
  });

  it('a kind that owns its boundary (npc) still gets the paragraph, before the instruction', () => {
    const brief = buildEntityBrief(NAME, CONTEXT, PREMISE, undefined, [], false, 'npc', INSTRUCTION, NOTE);
    const charter = buildEntityBrief(NAME, CONTEXT, PREMISE, undefined, [], false, 'npc');
    expect(brief).toBe(`${charter}\n\n${INTENT_PARAGRAPH}\n\nAdditional instruction: ${INSTRUCTION}`);
  });
});

describe('a record with NO intent is byte-identical to the brief this builder produced before the field', () => {
  it('the key ABSENT, `null` and `\'\'` all produce the same bytes as no note at all', () => {
    const absent = briefFrom([record(undefined)]);
    const nulled = briefFrom([record(null)]);
    const empty = briefFrom([record('')]);
    const blank = briefFrom([record('   ')]);
    const byHand = buildEntityBrief(NAME, CONTEXT, PREMISE, 2, [], false, 'location', INSTRUCTION);

    expect(absent).toBe(byHand);
    expect(nulled).toBe(byHand);
    expect(empty).toBe(byHand);
    expect(blank).toBe(byHand);
  });

  it('the paragraph function never adds an empty paragraph for a missing note', () => {
    for (const value of [undefined, null, '', '   ']) {
      const brief = buildEntityBrief(NAME, CONTEXT, PREMISE, 2, [], false, 'location', '', value);
      expect(brief).not.toContain("The module's author intended:");
      expect(brief).not.toContain('\n\n\n');
    }
  });
});

describe('the intent never reaches a surface a READER sees (it is an authoring note)', () => {
  /** A module whose ONE recorded entity carries the note, mentioned in prose. */
  function moduleWithIntent(): Module {
    const draft = createModule({
      campaignId: newId(),
      title: 'The Drowned Bell',
      concept: 'A harbor bell that rings by itself.',
      levelMin: 1,
      levelMax: 2,
      tone: '',
      sizeDial: 'sketch',
    });
    return {
      ...draft,
      entityKinds: [record(NOTE)],
      spine: {
        premise: `The bell rings over [[${NAME}]].`,
        themes: [],
        partPlan: [{ title: 'One', levelBand: '1', synopsis: '', levelUpTrigger: '' }],
        writerModel: 'test-model',
        origin: 'model',
      },
      parts: [
        {
          planIndex: 0,
          markdown: `Dusk falls on [[${NAME}]], and the stalls empty.`,
          status: 'ready',
          errorMessage: '',
          edited: false,
          writerModel: '',
          origin: null,
        },
      ],
    };
  }

  it('the fixture is NON-VACUOUS: the note really is on the row and really does reach the brief', () => {
    const module = moduleWithIntent();
    expect(entityIntentFor(module.entityKinds, NAME)).toBe(NOTE);
    expect(moduleDocumentText(module)).not.toContain(NOTE);
    // Non-vacuity of the ABSENCE pins below: the same read, given to the brief,
    // does print the note — so the surfaces below are silent because they never
    // read the field, not because the note went missing.
    expect(briefFrom(module.entityKinds)).toContain(NOTE);
  });

  it('the module DOCUMENT (premise + parts, what every export wiki-strips) does not print it', () => {
    const module = moduleWithIntent();
    expect(moduleDocumentText(module)).not.toContain(NOTE);
    const assembled = assembleModulePartsDocument({
      partPlan: module.spine?.partPlan ?? [],
      parts: module.parts,
    });
    expect(assembled.document).not.toContain(NOTE);
  });

  it('the READER render (wiki chips and their tooltips) does not print it', () => {
    const module = moduleWithIntent();
    const { container } = render(
      <WikiMarkdown value={moduleDocumentText(module)} artifacts={[]} moduleId={module.id} />,
    );
    expect(container.innerHTML).not.toContain(NOTE);
    // The chip really rendered (non-vacuous): the name is on the page.
    expect(container.innerHTML).toContain(NAME);
  });

  it('the EXPORT document model (the module PDF is the document) does not print it', () => {
    const module = moduleWithIntent();
    expect(JSON.stringify(buildModuleDefinition({ module, artifacts: [] }))).not.toContain(NOTE);
  });

  it('the entity PANEL’s own rows carry no note field to print', () => {
    const module = moduleWithIntent();
    const { result } = renderHook(() => useModuleEntities(module, []));
    const entries = result.current.entries;
    expect(entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(entries)).not.toContain(NOTE);
    for (const entry of entries) {
      expect(Object.keys(entry)).not.toContain('intent');
    }
  });
});
