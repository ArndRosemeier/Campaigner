import { describe, expect, it } from 'vitest';

import {
  BOARD_PREMISE_NODE_KEY,
  MODULE_PREMISE_LEVEL,
  ModuleDocumentError,
  appendLevelText,
  assembleModuleDocument,
  boardLevelNodeKey,
  levelForStoredCanvasNodeKey,
  levelFromBoardNodeKey,
  moduleLevelList,
  moduleLevelSeparator,
  replaceLevelText,
  splitModuleDocument,
  storedCanvasNodeKeyForLevel,
  type ModuleEntityKind,
} from '@/domain';

/**
 * THE MODULE DOCUMENT FORMAT (docs/23-CAMPAIGN-ARC §2–§4, owner-ratified): level
 * 0 (the premise) followed by `=====Level N=====` sections, with the level list
 * DERIVED from the text and every malformed read refused LOUDLY.
 *
 * This file pins the contract the phase-1 slice is built on, in five parts:
 *
 * 1. the FORMATTER and its inverse round trip, on the level-0-and-sections shape
 *    and on the two degenerate ones (no level sections at all, and an empty
 *    document);
 * 2. every LOUD arm — a near miss, a duplicate, a gap/out-of-order number, and a
 *    number that is not a positive integer — each NAMING THE LINE;
 * 3. THE ARM THAT MATTERS MOST: a near miss is an ERROR and never a silent merge
 *    into the level above. Its non-vacuity arm parses the SAME prose with a
 *    canonical separator and shows it yielding two level sections, so the refusal
 *    is provably the near-miss rule doing the work;
 * 4. the DERIVED level list — number, text range, the wiki-linked names by kind
 *    and `levelMin`/`levelMax` — which is never stored, and which INCLUDES level
 *    0;
 * 5. the LEVEL-ADDRESSED EDITS the phase-3 chat commands ride, level 0 included.
 */

/** A refusal's message, asserting the failure is the typed one. */
function refusalMessage(doc: string): string {
  let caught: unknown;
  try {
    splitModuleDocument(doc);
  } catch (error) {
    caught = error;
  }
  if (!(caught instanceof ModuleDocumentError)) {
    const seen =
      caught instanceof Error ? `a ${caught.name}: ${caught.message}` : `a ${typeof caught} value`;
    throw new Error(
      `expected a ModuleDocumentError, got ${caught === undefined ? 'no error at all' : seen}`,
    );
  }
  return caught.message;
}

/** Assembles [premise, ...level sections] — level 0 is the premise (docs/23 §2). */
function documentOf(premise: string, sections: readonly string[]): string {
  return assembleModuleDocument({
    levels: [
      { number: MODULE_PREMISE_LEVEL, text: premise },
      ...sections.map((text, index) => ({ number: index + 1, text })),
    ],
  });
}

const PREMISE = 'The premise line.';
const LEVEL_ONE = '## The cursed ship\nThe [[Captain Voss]] waits.';
const LEVEL_TWO = 'A [[Drowned Dock]] and [[Captain Voss]].';

const CANONICAL_TWO_LEVELS = [
  PREMISE,
  '',
  '=====Level 1=====',
  '## The cursed ship',
  'The [[Captain Voss]] waits.',
  '',
  '=====Level 2=====',
  'A [[Drowned Dock]] and [[Captain Voss]].',
].join('\n');

describe('the module document formatter (docs/23 §2)', () => {
  it('writes the canonical separator, and refuses level 0 because it has none', () => {
    expect(moduleLevelSeparator(1)).toBe('=====Level 1=====');
    expect(moduleLevelSeparator(12)).toBe('=====Level 12=====');
    expect(() => moduleLevelSeparator(MODULE_PREMISE_LEVEL)).toThrow(/positive whole level number/);
    expect(() => moduleLevelSeparator(MODULE_PREMISE_LEVEL)).toThrow(/is the premise/);
    for (const bad of [-1, 1.5, Number.NaN]) {
      expect(() => moduleLevelSeparator(bad)).toThrow(/positive whole level number/);
    }
  });

  it('assembles level 0 first with NO separator, then one separated section per level', () => {
    expect(documentOf(PREMISE, [LEVEL_ONE, LEVEL_TWO])).toBe(CANONICAL_TWO_LEVELS);
    // Level 0's own number never appears as a separator line.
    expect(CANONICAL_TWO_LEVELS).not.toContain('=====Level 0=====');
  });

  it('refuses an out-of-order or level-0-less list instead of sorting or inventing it', () => {
    expect(() => assembleModuleDocument({ levels: [] })).toThrow(/at least level 0/);
    expect(() => assembleModuleDocument({ levels: [{ number: 1, text: 'A' }] })).toThrow(
      /position 0 carries level 1/,
    );
    expect(() =>
      assembleModuleDocument({
        levels: [
          { number: MODULE_PREMISE_LEVEL, text: 'P' },
          { number: 2, text: 'B' },
        ],
      }),
    ).toThrow(/position 1 carries level 2/);
  });

  it('round trips assemble → split, and split → assemble on a canonical document', () => {
    const parsed = splitModuleDocument(CANONICAL_TWO_LEVELS);
    expect(parsed.levels.map((level) => level.number)).toEqual([0, 1, 2]);
    expect(parsed.levels.map((level) => level.text)).toEqual([PREMISE, LEVEL_ONE, LEVEL_TWO]);
    expect(
      assembleModuleDocument({
        levels: parsed.levels.map((level) => ({ number: level.number, text: level.text })),
      }),
    ).toBe(CANONICAL_TWO_LEVELS);
  });

  it('treats zero separators as LEGAL — the "level 0 only" starts-with-nothing state', () => {
    const premiseOnly = splitModuleDocument('A premise, and no levels yet.');
    expect(premiseOnly.levels.map((level) => level.number)).toEqual([MODULE_PREMISE_LEVEL]);
    expect(premiseOnly.levels[0]?.text).toBe('A premise, and no levels yet.');
    expect(documentOf('A premise, and no levels yet.', [])).toBe('A premise, and no levels yet.');

    const empty = splitModuleDocument('');
    expect(empty.levels.map((level) => level.number)).toEqual([MODULE_PREMISE_LEVEL]);
    expect(empty.levels[0]?.text).toBe('');
    expect(assembleModuleDocument({ levels: [{ number: 0, text: '' }] })).toBe('');
  });

  it('keeps each level text in whole-document coordinates, scaffolding excluded', () => {
    const parsed = splitModuleDocument(CANONICAL_TWO_LEVELS);
    for (const level of parsed.levels) {
      expect(CANONICAL_TWO_LEVELS.slice(level.textFrom, level.textTo)).toBe(level.text);
      expect(level.text.startsWith('\n')).toBe(false);
      expect(level.text.endsWith('\n')).toBe(false);
    }
    expect(parsed.levels[0]?.textFrom).toBe(0);
    expect(parsed.levels[0]?.text).toBe(PREMISE);
    expect(parsed.levels[1]?.text).toBe('## The cursed ship\nThe [[Captain Voss]] waits.');
    expect(parsed.levels[2]?.text).toBe('A [[Drowned Dock]] and [[Captain Voss]].');
  });

  it('reads level identity from the separator NUMBER, never from position', () => {
    const doc = ['=====Level 1=====', 'one', '', '=====Level 2=====', 'two'].join('\n');
    const parsed = splitModuleDocument(doc);
    // Level 0 is the (empty) premise; the sections keep their own numbers.
    expect(parsed.levels.map((level) => level.number)).toEqual([0, 1, 2]);
    expect(parsed.levels[0]?.text).toBe('');
  });

  it('accepts an empty level section', () => {
    const doc = [
      '=====Level 1=====',
      'A',
      '',
      '=====Level 2=====',
      '',
      '=====Level 3=====',
      'C',
    ].join('\n');
    const parsed = splitModuleDocument(doc);
    expect(parsed.levels.map((level) => level.text)).toEqual(['', 'A', '', 'C']);
    expect(
      assembleModuleDocument({
        levels: parsed.levels.map((level) => ({ number: level.number, text: level.text })),
      }),
    ).toBe(doc);
  });
});

describe('the closed tolerance (docs/23 §3)', () => {
  it('tolerates the line’s own trailing whitespace and its own \\r — and nothing else', () => {
    expect(splitModuleDocument('=====Level 1=====   \nA').levels[1]?.text).toBe('A');
    expect(splitModuleDocument('=====Level 1=====\t\nA').levels[1]?.text).toBe('A');
    expect(splitModuleDocument('=====Level 1=====\r\nA').levels[1]?.text).toBe('A');
    expect(splitModuleDocument('=====Level 1===== \r\nA').levels[1]?.text).toBe('A');
  });

  it('does NOT tolerate case, and says so by refusing the line', () => {
    expect(refusalMessage('=====level 1=====\nA')).toMatch(/line 1: "=====level 1====="/);
    expect(refusalMessage('=====LEVEL 1=====\nA')).toMatch(/looks like a level header/);
  });

  it('does NOT tolerate indentation, and says so by refusing the line', () => {
    expect(refusalMessage('  =====Level 1=====\nA')).toContain('line 1: "  =====Level 1====="');
    expect(refusalMessage('\t=====Level 1=====\nA')).toMatch(/looks like a level header/);
  });
});

describe('every malformed document is refused LOUDLY, naming the line (docs/23 §3)', () => {
  it('refuses a NEAR MISS — and never merges it into the level above', () => {
    const nearMisses = [
      '=====Level 3====',
      '===== Level 3 =====',
      '=====LEVEL 3=====',
      '======Level 3======',
      '=====Level 03=====',
      '=====Level 3===== extra',
      '=====Level Three=====',
      '=====Level3=====',
      '=Level 3=',
      '=====Level 1 =====',
      '=====Level 0=====',
    ];
    for (const nearMiss of nearMisses) {
      const doc = ['=====Level 1=====', 'one', '', nearMiss, 'three'].join('\n');
      const message = refusalMessage(doc);
      // NAMES THE LINE: its number and its quoted text.
      expect(message, nearMiss).toContain('line 4:');
      expect(message, nearMiss).toContain(JSON.stringify(nearMiss));
      expect(message, nearMiss).toContain('never a silent merge');
    }
  });

  it('refuses a leading zero — a level section is a positive integer', () => {
    expect(refusalMessage('=====Level 007=====\nA')).toMatch(/looks like a level header/);
  });

  it('the near-miss arm is what decides: the SAME prose parses when the separator IS canonical', () => {
    const nearMissDoc = ['=====Level 1=====', 'one', '', '===== Level 2 =====', 'two'].join('\n');
    const canonicalDoc = ['=====Level 1=====', 'one', '', '=====Level 2=====', 'two'].join('\n');
    expect(refusalMessage(nearMissDoc)).toContain('line 4:');
    const parsed = splitModuleDocument(canonicalDoc);
    expect(parsed.levels.map((level) => level.text)).toEqual(['', 'one', 'two']);
  });

  it('refuses a duplicated level number, naming both lines', () => {
    const doc = ['=====Level 1=====', 'one', '', '=====Level 1=====', 'again'].join('\n');
    const message = refusalMessage(doc);
    expect(message).toContain('line 4:');
    expect(message).toContain('level 1 is used a second time');
    expect(message).toContain('first at line 1');
  });

  it('refuses a gap or an out-of-order number, naming the missing level', () => {
    const gap = ['=====Level 1=====', 'one', '', '=====Level 3=====', 'three'].join('\n');
    expect(refusalMessage(gap)).toContain('level 3 skips or reorders');
    expect(refusalMessage(gap)).toContain('level 2 is missing');

    // A document whose sections do not OPEN at level 1 is the same arm.
    expect(refusalMessage('=====Level 2=====\ntwo')).toMatch(/level 1 is missing/);

    // Levels 1, 2, 4, 3: the level 4 is the offending line, and the level 3 it
    // skipped is named by the message.
    const descending = [
      '=====Level 1=====',
      'a',
      '',
      '=====Level 2=====',
      'b',
      '',
      '=====Level 4=====',
      'd',
      '',
      '=====Level 3=====',
      'c',
    ].join('\n');
    const message = refusalMessage(descending);
    expect(message).toContain('line 7:');
    expect(message).toContain('level 3 is missing');
  });

  it('leaves ordinary prose alone, including a sentence that names a level', () => {
    const doc = ['=====Level 1=====', 'The level 3 boss waits below.', '= not a separator'].join(
      '\n',
    );
    const parsed = splitModuleDocument(doc);
    expect(parsed.levels[1]?.text).toBe('The level 3 boss waits below.\n= not a separator');
  });
});

describe('the DERIVED level list (docs/23 §4) — never stored, level 0 included', () => {
  const ENTITY_KINDS: ModuleEntityKind[] = [
    { name: 'Captain Voss', kind: 'npc', absorbed: [] },
    { name: 'Drowned Dock', kind: 'location', absorbed: [] },
    { name: 'The Fallen City', kind: 'location', absorbed: [] },
  ];

  it('derives each level’s number, text range and wiki-linked names by kind — level 0 too', () => {
    const doc = documentOf(`The [[The Fallen City]] fell. ${PREMISE}`, [LEVEL_ONE, LEVEL_TWO]);
    const list = moduleLevelList(doc, ENTITY_KINDS);
    expect(list.levels.map((level) => level.number)).toEqual([0, 1, 2]);
    for (const level of list.levels) {
      expect(doc.slice(level.textFrom, level.textTo)).toBe(level.text);
    }
    expect(list.levels[0]?.names).toEqual([{ name: 'The Fallen City', kind: 'location' }]);
    expect(list.levels[1]?.names).toEqual([{ name: 'Captain Voss', kind: 'npc' }]);
    expect(list.levels[2]?.names).toEqual([
      { name: 'Drowned Dock', kind: 'location' },
      { name: 'Captain Voss', kind: 'npc' },
    ]);
    // level 0 always exists, so levelMin is 0 for every document; levelMax is the
    // last level SECTION's number.
    expect(list.levelMin).toBe(MODULE_PREMISE_LEVEL);
    expect(list.levelMax).toBe(2);
  });

  it('reports a mentioned name the module recorded no kind for as kind: null', () => {
    const doc = documentOf('A [[Nobody Recorded Me]].', []);
    const list = moduleLevelList(doc, ENTITY_KINDS);
    expect(list.levels[0]?.names).toEqual([{ name: 'Nobody Recorded Me', kind: null }]);
  });

  it('dedupes a name repeated inside one level, and keeps it per level', () => {
    const doc = documentOf('', [
      '[[Captain Voss]] and [[Captain Voss]] again.',
      'Still [[Captain Voss]].',
    ]);
    const list = moduleLevelList(doc, ENTITY_KINDS);
    expect(list.levels[1]?.names).toEqual([{ name: 'Captain Voss', kind: 'npc' }]);
    expect(list.levels[2]?.names).toEqual([{ name: 'Captain Voss', kind: 'npc' }]);
  });

  it('is level 0 only — levelMin and levelMax both 0 — when there are no separators', () => {
    const list = moduleLevelList('Just a premise.', []);
    expect(list.levels.map((level) => level.number)).toEqual([MODULE_PREMISE_LEVEL]);
    expect(list.levelMin).toBe(MODULE_PREMISE_LEVEL);
    expect(list.levelMax).toBe(MODULE_PREMISE_LEVEL);
  });
});

describe('level-addressed edits (the seam the phase-3 chat commands ride)', () => {
  it('replaces ONE level and leaves every other byte of the document alone', () => {
    const parsed = splitModuleDocument(CANONICAL_TWO_LEVELS);
    const edited = replaceLevelText(parsed, 1, '## The frozen ship\nNothing waits.');
    expect(edited.parsed.levels[1]?.text).toBe('## The frozen ship\nNothing waits.');
    // The sibling levels and the premise are byte-identical; only level 1 moved.
    expect(edited.parsed.levels[2]?.text).toBe(parsed.levels[2]?.text);
    expect(edited.parsed.levels[0]?.text).toBe(PREMISE);
    expect(edited.parsed.levels.map((level) => level.number)).toEqual([0, 1, 2]);
    expect(edited.parsed.text).toBe(
      CANONICAL_TWO_LEVELS.replace(LEVEL_ONE, '## The frozen ship\nNothing waits.'),
    );
  });

  it('replaces the PREMISE through the SAME path, because the premise IS level 0', () => {
    const parsed = splitModuleDocument(CANONICAL_TWO_LEVELS);
    const edited = replaceLevelText(parsed, MODULE_PREMISE_LEVEL, 'A brand new premise.');
    expect(edited.document).toBe(CANONICAL_TWO_LEVELS.replace(PREMISE, 'A brand new premise.'));
    expect(edited.parsed.levels[0]?.text).toBe('A brand new premise.');
    expect(edited.parsed.levels[1]?.text).toBe(parsed.levels[1]?.text);
    expect(edited.parsed.levels[2]?.text).toBe(parsed.levels[2]?.text);
  });

  it('extends the premise through the SAME path too', () => {
    const parsed = splitModuleDocument(CANONICAL_TWO_LEVELS);
    const edited = appendLevelText(parsed, MODULE_PREMISE_LEVEL, 'And more premise.');
    expect(edited.parsed.levels[0]?.text).toBe(`${PREMISE}\n\nAnd more premise.`);
    expect(edited.parsed.levels[1]?.text).toBe(LEVEL_ONE);
  });

  it('gives the edit FRESH ranges — a second edit needs no re-read of the document', () => {
    const first = replaceLevelText(
      splitModuleDocument('=====Level 1=====\nA\n\n=====Level 2=====\nB'),
      1,
      'one',
    );
    // No `splitModuleDocument` call between the two edits: the result carries
    // the parse, which is the whole point of the level-addressed shape.
    const second = appendLevelText(first.parsed, 2, 'two');
    expect(second.parsed.levels[1]?.text).toBe('one');
    expect(second.parsed.levels[2]?.text).toBe('B\n\ntwo');
  });

  it('refuses a level the document does not carry instead of inventing it', () => {
    const parsed = splitModuleDocument(CANONICAL_TWO_LEVELS);
    expect(() => replaceLevelText(parsed, 3, 'three')).toThrow(ModuleDocumentError);
    expect(() => replaceLevelText(parsed, 3, 'three')).toThrow(/carries levels 0, 1, 2/);
    const premiseOnly = splitModuleDocument('Just a premise.');
    expect(() => replaceLevelText(premiseOnly, 1, 'x')).toThrow(/carries levels 0/);
  });

  it('appends to an existing level with a paragraph break, and to an empty one bare', () => {
    const parsed = splitModuleDocument(CANONICAL_TWO_LEVELS);
    const grown = appendLevelText(parsed, 2, 'And a third thing.');
    expect(grown.parsed.levels[2]?.text).toBe(`${LEVEL_TWO}\n\nAnd a third thing.`);
    expect(grown.parsed.levels[1]?.text).toBe(parsed.levels[1]?.text);

    const empty = splitModuleDocument(
      ['=====Level 1=====', 'A', '', '=====Level 2=====', '', '=====Level 3=====', 'C'].join('\n'),
    );
    expect(appendLevelText(empty, 2, 'Now it has prose.').parsed.levels[2]?.text).toBe(
      'Now it has prose.',
    );
  });

  it('appends the NEXT level through the app’s own formatter, and parses the result', () => {
    const parsed = splitModuleDocument(CANONICAL_TWO_LEVELS);
    const grown = appendLevelText(parsed, 3, 'A [[New Dock]].');
    expect(grown.document).toBe(`${CANONICAL_TWO_LEVELS}\n\n=====Level 3=====\nA [[New Dock]].`);
    expect(grown.parsed.levels.map((level) => level.number)).toEqual([0, 1, 2, 3]);
    expect(grown.parsed.levels[3]?.text).toBe('A [[New Dock]].');

    // …and the first level SECTION of a document that is level 0 only — `max + 1`
    // is 1 there, because level 0 (the premise) is the only level it has.
    const premiseOnly = splitModuleDocument('A premise.');
    const firstLevel = appendLevelText(premiseOnly, 1, 'The first prose.');
    expect(firstLevel.document).toBe('A premise.\n\n=====Level 1=====\nThe first prose.');
    expect(firstLevel.parsed.levels.map((level) => level.number)).toEqual([0, 1]);
  });

  it('adds an EMPTY next level when the append carries no text', () => {
    const grown = appendLevelText(splitModuleDocument('A premise.'), 1, '');
    expect(grown.document).toBe('A premise.\n\n=====Level 1=====');
    expect(grown.parsed.levels).toHaveLength(2);
    expect(grown.parsed.levels[1]?.text).toBe('');
  });

  it('refuses to skip a level, because the gap would be unreadable', () => {
    const parsed = splitModuleDocument(CANONICAL_TWO_LEVELS);
    expect(() => appendLevelText(parsed, 5, 'five')).toThrow(/next level it can take/);
    expect(() => appendLevelText(parsed, 5, 'five')).toThrow(/3 is the next level/);
  });

  it('refuses a body that would break the format, at the edit, not at the next read', () => {
    const parsed = splitModuleDocument(CANONICAL_TWO_LEVELS);
    expect(() => replaceLevelText(parsed, 1, '=====Level 9=====')).toThrow(ModuleDocumentError);
    expect(() => appendLevelText(parsed, 1, '===== Level 9 =====')).toThrow(
      /looks like a level header/,
    );
    // Level 0 is no exception: the app never writes a separator for the premise.
    expect(() => replaceLevelText(parsed, MODULE_PREMISE_LEVEL, '=====Level 0=====')).toThrow(
      /looks like a level header/,
    );
  });

  it('keeps the document’s own bytes when appending to a premise-only document', () => {
    const parsed = splitModuleDocument('A premise.\n\n');
    // The trailing blank scaffolding is normalized to one blank line; nothing
    // else in the document moves.
    expect(appendLevelText(parsed, 1, 'x').document).toBe('A premise.\n\n=====Level 1=====\nx');
  });

  it('fills an EMPTY level into canonical shape — no glued separator, no stray blank', () => {
    const doc = [
      '=====Level 1=====',
      'A',
      '',
      '=====Level 2=====',
      '',
      '=====Level 3=====',
      'C',
    ].join('\n');
    const edited = replaceLevelText(splitModuleDocument(doc), 2, 'Now it has prose.');
    expect(edited.document).toBe(
      [
        '=====Level 1=====',
        'A',
        '',
        '=====Level 2=====',
        'Now it has prose.',
        '',
        '=====Level 3=====',
        'C',
      ].join('\n'),
    );
    expect(edited.parsed.levels.map((level) => level.text)).toEqual([
      '',
      'A',
      'Now it has prose.',
      'C',
    ]);
  });
});

/**
 * THE CANVAS NODE KEYS (docs/17 row 388): the BOARD addresses a card by its
 * LEVEL, the module ROW keeps the frozen stored spelling, and ONE boundary
 * translates between them through the ONE level↔planIndex conversion above.
 *
 * Three claims, and the third is the reason this slice can land without a
 * `version` bump or a byte of migration:
 *
 * 1. the board's key grammar is `level-<N>` and LEVEL 0 IS THE PREMISE (the one
 *    level with no separator) — `BOARD_PREMISE_NODE_KEY` is `boardLevelNodeKey(0)`,
 *    and every non-level key parses to `null` rather than a wild reading;
 * 2. the row's stored spelling is FROZEN — `'premise'` and `part-<planIndex>` —
 *    and the two spellings are exact INVERSES, so the mapping is applied on read
 *    and write consistently;
 * 3. an EXISTING board's persisted node keys map onto the board's level keys
 *    and write back BYTE-IDENTICALLY, which is what "no shape change" means
 *    here: the row's format is untouched, so no arranged layout is lost and no
 *    `version` bump is owed.
 */
describe('the canvas node keys — the board speaks LEVELS, the row keeps its stored spelling', () => {
  it('spells a board key `level-<N>`, with level 0 (the premise) present and legal', () => {
    expect(boardLevelNodeKey(0)).toBe('level-0');
    expect(boardLevelNodeKey(3)).toBe('level-3');
    expect(BOARD_PREMISE_NODE_KEY).toBe(boardLevelNodeKey(MODULE_PREMISE_LEVEL));
    expect(levelFromBoardNodeKey(BOARD_PREMISE_NODE_KEY)).toBe(MODULE_PREMISE_LEVEL);
    expect(levelFromBoardNodeKey('level-7')).toBe(7);
    // Every key that is not a board level key is NOT a level: the stored
    // spellings, a prior module's group and near misspellings all read null.
    for (const other of ['premise', 'part-0', 'priors-x', 'level-', 'level-1x', 'Level-1']) {
      expect(levelFromBoardNodeKey(other), other).toBeNull();
    }
    // A nonsense level is LOUD, never a garbage key (AGENTS rule 1).
    expect(() => boardLevelNodeKey(-1)).toThrow(/whole level/);
    expect(() => boardLevelNodeKey(1.5)).toThrow(/whole level/);
  });

  it('keeps the row’s stored spelling frozen — and the two spellings are exact inverses', () => {
    expect(storedCanvasNodeKeyForLevel(0)).toBe('premise');
    expect(storedCanvasNodeKeyForLevel(1)).toBe('part-0');
    expect(storedCanvasNodeKeyForLevel(4)).toBe('part-3');
    for (let level = 0; level <= 12; level += 1) {
      expect(levelForStoredCanvasNodeKey(storedCanvasNodeKeyForLevel(level))).toBe(level);
    }
    // A prior module's group key is the same on both sides — not a level — and
    // a stale/garbage key reads null (inert, exactly as before).
    expect(levelForStoredCanvasNodeKey('prior-m-1')).toBeNull();
    expect(levelForStoredCanvasNodeKey('part-x')).toBeNull();
    expect(levelForStoredCanvasNodeKey('level-1')).toBeNull();
    expect(() => storedCanvasNodeKeyForLevel(-1)).toThrow(/whole level/);
  });

  it('maps an EXISTING board’s stored bytes onto the board keys and back, byte-identically', () => {
    // A row exactly as a PRE-388 app wrote it: the premise, two level sections
    // and one prior group.
    const storedKeys = ['premise', 'part-0', 'part-1', 'prior-m-1'];
    // READ (the board's key space): level-<N>, level 0 = the premise.
    const boardKeys = storedKeys.map((key) => {
      const level = levelForStoredCanvasNodeKey(key);
      return level === null ? key : boardLevelNodeKey(level);
    });
    expect(boardKeys).toEqual(['level-0', 'level-1', 'level-2', 'prior-m-1']);
    // WRITE: the board's own keys go back to those SAME bytes.
    expect(
      boardKeys.map((key) => {
        const level = levelFromBoardNodeKey(key);
        return level === null ? key : storedCanvasNodeKeyForLevel(level);
      }),
    ).toEqual(storedKeys);
  });
});
