import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  entityProseLevel,
  firstLevelInText,
  moduleStatedLevel,
  partyLevelLine,
  partLevelForMention,
  withoutPartyLevelLines,
} from '@/llm/roomBudget';
import { readInstructionLevel } from '@/llm/instructionLevel';
import { LEVEL_WORDS, levelWordsPattern } from '@/llm/language';
import { GENERATION_LANGUAGES } from '@/domain/settings';
import type { Module } from '@/domain';

/**
 * The owner's INSTRUCTION is read by the MODEL, never by the pattern this file's
 * other arms pin (docs/17 row 289, AGENTS rule 5): the two are different texts
 * and different questions. `firstLevelInText` reads the app's own MODULE prose;
 * `readInstructionLevel` reads the GM's human free text through ONE structured,
 * zod-validated call. The mock below exists so the pinned arm can exercise that
 * seam without a network.
 */
vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {
    constructor() {
      super('No OpenRouter API key configured');
      this.name = 'MissingApiKeyError';
    }
  },
}));

const chatMock = vi.mocked((await import('@/llm/openrouter')).chat);

afterEach(() => {
  chatMock.mockReset();
});

/**
 * THE LEVEL READER READS THE LANGUAGE THE APP GENERATES IN (docs/17 row 253).
 *
 * The owner's report: a mob whose German module prose says `Stufe 5` keeps
 * coming out of the generator at level 3, because the module is level 3. The
 * defect was an ASYMMETRY, not a bad number: the WRITE side is language-aware
 * (`language.languageDirective` tells the model to write everything in the
 * campaign's chosen language, one of ELEVEN), while the READ side — the ONE
 * free-text level reader, `roomBudget.firstLevelInText` — asked only for the
 * ENGLISH word. `Stufe 5` was therefore invisible to every level source (the
 * user's redo instruction, the module's premise, the legacy brief fallback)
 * and the entity fell through to the module's band.
 *
 * WHAT THIS FILE PINS:
 *
 * 1. every supported language's spelling resolves its own level, INCLUDING
 *    CJK, where there is no space (`レベル5`) and where the English reader's
 *    leading `\b` can never match (JavaScript's `\w` is ASCII-only, so a kana
 *    is a NON-word character and no boundary exists before it);
 * 2. the domain bound and the two-digit form are unchanged (`level 2024` is
 *    not a level, `level 0` is not a level);
 * 3. English still resolves for English text whatever the campaign's setting,
 *    because the vocabulary is a UNION and never a threaded argument;
 * 4. the party-level trap (docs/17 row 206) stays closed: the app's generated
 *    English party line is removed BEFORE the reader sees the brief, so a
 *    German entity level in the same brief still wins;
 * 5. a NAMED entity's level comes from the module in SPECIFICITY ORDER (docs/17
 *    rows 253, 282 and 285): the sentence that NAMES the figure in its own part,
 *    else the sentence that names it in the premise, else the mentioning part's
 *    STRUCTURED band by name, else an EXACT band. The prose rung is ALWAYS
 *    name-scoped, so a premise sentence about a DIFFERENT figure — or about no
 *    figure — still resolves NOTHING (the owner's row-282 ruling stands: a
 *    CAMPAIGN premise is not a module-wide level instruction, and one sentence
 *    about ONE gnome must not become every mob's number);
 * 6. the reader's two MEASURED false positives are closed (docs/17 row 282):
 *    a level word may not reach across a LINE BREAK to a number, and a non-CJK
 *    word may not abut its digits (`Stufe7`) — CJK keeps its no-separator form.
 *
 * SCOPE AFTER docs/17 row 289: this reader now answers ONLY "what level does
 * the app's own MODULE prose state". The owner's INSTRUCTION is HUMAN free text
 * and is read by the MODEL (`llm/instructionLevel.readInstructionLevel`, pinned
 * in `tests/llm/instruction-level.test.ts`); the pre-289
 * `roomBudget.instructionLevel` wrapper is DELETED, so a regex can never again
 * be the authority over his words.
 */

/** The module slice `moduleStatedLevel`/`partLevelForMention` read. */
type LevelModule = Pick<Module, 'spine' | 'parts' | 'levelMin' | 'levelMax'>;

function moduleFixture(options: {
  premise: string;
  parts?: readonly { planIndex: number; markdown: string }[];
  bands?: readonly string[];
  levelMin?: number;
  levelMax?: number;
}): LevelModule {
  const parts = options.parts ?? [];
  const bands = options.bands ?? ['3'];
  return {
    spine: {
      premise: options.premise,
      partPlan: bands.map((levelBand, index) => ({
        title: `Part ${String(index + 1)}`,
        levelBand,
        synopsis: '',
        levelUpTrigger: '',
      })),
    } as Module['spine'],
    parts: parts.map((part) => ({ ...part }) as Module['parts'][number]),
    levelMin: options.levelMin ?? 3,
    levelMax: options.levelMax ?? 3,
  };
}

describe('ONE level reader reads every generated language (docs/17 row 253)', () => {
  it('resolves each supported language’s own level spelling', () => {
    const probes: readonly (readonly [string, string, number])[] = [
      ['en', 'level 5', 5],
      ['de', 'Stufe 5', 5],
      ['fr', 'niveau 5', 5],
      ['es', 'nivel 5', 5],
      ['it', 'livello 5', 5],
      ['pt', 'nível 5', 5],
      ['nl', 'niveau 5', 5],
      ['pl', 'poziom 5', 5],
      ['ru', 'уровень 5', 5],
      ['ja', 'レベル5', 5],
      ['zh', '等级5', 5],
    ];
    for (const [code, text, expected] of probes) {
      expect(LEVEL_WORDS[code as keyof typeof LEVEL_WORDS].length, `${code} has a word`).toBeGreaterThan(0);
      expect(firstLevelInText(text), `${code}: ${text}`).toBe(expected);
    }
  });

  it('resolves CJK with and without a space, and keeps a CJK prefix working', () => {
    // The leading `\b` the English reader used can NEVER match here: measured,
    // `\bレベル` is false against `レベル` because `レ` is not a `\w` character.
    expect(/\b\u30ec/.test('\u30ec')).toBe(false);
    expect(firstLevelInText('レベル5')).toBe(5);
    expect(firstLevelInText('レベル 5')).toBe(5);
    expect(firstLevelInText('等级5')).toBe(5);
    expect(firstLevelInText('级别 7')).toBe(7);
    // A kana/ideograph immediately BEFORE the word must not defeat the reader:
    // a `\p{L}` lookbehind would forbid it, which is why the anchor is ASCII.
    expect(firstLevelInText('高レベル5')).toBe(5);
  });

  it('keeps the level DOMAIN and the standalone-word anchor', () => {
    // The 1..20 domain (ENTITY_LEVEL_HINT_*) survives: a four-digit year is
    // captured as two digits and then rejected by the bound, never read 2024.
    expect(firstLevelInText('level 2024')).toBeUndefined();
    expect(firstLevelInText('Stufe 2024')).toBeUndefined();
    expect(firstLevelInText('レベル2024')).toBeUndefined();
    expect(firstLevelInText('level 0')).toBeUndefined();
    expect(firstLevelInText('level 21')).toBeUndefined();
    expect(firstLevelInText('level 1')).toBe(1);
    expect(firstLevelInText('level 20')).toBe(20);
    // The word must be standalone: the old reader's intent, kept.
    expect(firstLevelInText('counterlevel 5')).toBeUndefined();
    expect(firstLevelInText('levelup 5')).toBeUndefined();
    expect(firstLevelInText('das Niveau der Gruppe')).toBeUndefined();
  });

  it('reads the OWNER’S INSTRUCTION through the MODEL, in any language — the union is the model’s job now (docs/17 row 289)', async () => {
    // THE PRE-289 PIN WAS `instructionLevel('redo completely, this time at level
    // 5')` → 5 through the regex. The SUBJECT is live — an instruction must
    // resolve its level in every language the owner types — but the MECHANISM is
    // now a structured model read, so the pin is CONVERTED, never deleted. What
    // survives unchanged is the property that made the vocabulary a UNION in the
    // first place: the reader has NO language argument, and the owner's words
    // reach the reader verbatim in whichever language he wrote.
    chatMock.mockResolvedValue({
      text: JSON.stringify({ level: 5, quote: 'auf Stufe 5' }),
      modelUsed: 'test-model',
      fallback: null,
    });
    const read = (instruction: string) =>
      readInstructionLevel({
        instruction,
        entityName: 'Marten Graubruch',
        currentLevel: 3,
        model: 'test-model',
        signal: new AbortController().signal,
      });
    expect((await read('redo completely, this time at level 5')).level).toBe(5);
    expect((await read('redo completely, diesmal auf Stufe 5')).level).toBe(5);
    // BOTH sentences arrived at the model VERBATIM — the German one included,
    // which the pre-253 English-only pattern could never have read.
    const contents = chatMock.mock.calls.map((call) => call[0].at(-1)?.content ?? '');
    expect(contents[0]).toContain('redo completely, this time at level 5');
    expect(contents[1]).toContain('redo completely, diesmal auf Stufe 5');
    expect(levelWordsPattern().source).not.toContain('undefined');
  });

  it('does not re-open the party-level trap: the generated English party line is excluded first', () => {
    // The app writes `partyLevelLine` in ENGLISH, never localized. A brief
    // carrying the party at 3 plus a German entity level at 5 resolves 5 once
    // the party line is removed — and the raw text's first hit is the PARTY's,
    // which is exactly why the exclusion is the ONE reader's precondition.
    const brief = [
      partyLevelLine(3),
      '## Marten Graubruch – der Aufseher im Schacht',
      '**Stufe 5 Endgegner für Die Mine (Tiefstollen der Stillen Armee).**',
    ].join('\n\n');
    expect(firstLevelInText(brief)).toBe(3);
    expect(firstLevelInText(withoutPartyLevelLines(brief))).toBe(5);
  });

  it('resolves a NAMED entity’s part level, and NEVER a premise sentence that does not name it (docs/17 rows 282/285)', () => {
    // The owner's exact shape: a part names the entity at 5 — a STRUCTURED,
    // name-scoped statement — while the premise's prose says 3 about the whole
    // campaign. Row 253 made the part outrank the premise; row 282 removed the
    // MODULE-WIDE premise read entirely, because a CAMPAIGN story introduction
    // is not a level instruction ("Its very sloppy to infer all mobs levels from
    // a CAMPAIGN premise … And this was about 1 NPC."). Row 285 keeps that ban
    // and adds back only the sentence that NAMES the figure: this premise names
    // nobody, so it is still not evidence for anyone.
    const module = moduleFixture({
      premise: 'Eine Mine für Stufe 3 Charaktere. Die Stille Armee hat sich eingenistet.',
      bands: ['3', '5'],
      parts: [
        { planIndex: 0, markdown: 'Die Mine ist dunkel und verlassen. Keine Spuren.' },
        {
          planIndex: 1,
          markdown: 'Im Tiefstollen wartet [[Marten Graubruch]] auf die Gruppe.',
        },
      ],
      levelMin: 3,
      levelMax: 3,
    });
    expect(firstLevelInText(module.spine?.premise ?? '')).toBe(3);
    expect(partLevelForMention(module, 'Marten Graubruch')).toBe(5);
    // The premise sentence carries no name, so the name-scoped prose rung is
    // silent and the STRUCTURED part band decides.
    expect(entityProseLevel(module, 'Marten Graubruch')).toBeUndefined();
    // THE MEASURED OUTCOME: the named part states the level — structure, by name.
    expect(moduleStatedLevel(module, 'Marten Graubruch')).toBe(5);
    // An entity NO part names takes the module's own statement, and a premise
    // sentence about nobody is not one: the exact band (3) is, so this is the
    // band and NOT the prose. With a band that states no single level the answer
    // is `undefined` — see the spine-time pin below and the moduleGen pin for the
    // stamping half.
    expect(entityProseLevel(module, 'Unbekannter Namenloser')).toBeUndefined();
    expect(moduleStatedLevel(module, 'Unbekannter Namenloser')).toBe(3);
  });

  it('lets the NAMED figure’s own PART SENTENCE outrank the part’s STRUCTURED band (docs/17 row 285, inversion I1)', () => {
    // THE OWNER'S DEFECT: a level-3 mob whose own paragraph says `level 5`
    // shipped at 3, because `partLevelForMention` reads the part's levelBand and
    // never its sentence — the band outranked the figure's own prose, inverting
    // specificity (entity > part > module). The part NAMES the mob, so its
    // sentence IS evidence about it.
    const module = moduleFixture({
      premise: 'Eine Mine für Stufe 3 Charaktere.',
      bands: ['3'],
      parts: [
        {
          planIndex: 0,
          markdown: 'Im Tiefstollen wartet [[Marten Graubruch]], ein Gegner der Stufe 5.',
        },
      ],
      levelMin: 3,
      levelMax: 3,
    });
    // The band still says 3…
    expect(partLevelForMention(module, 'Marten Graubruch')).toBe(3);
    // …and the figure's own sentence says 5, which now wins.
    expect(entityProseLevel(module, 'Marten Graubruch')).toBe(5);
    expect(moduleStatedLevel(module, 'Marten Graubruch')).toBe(5);
  });

  it('lets a PREMISE sentence that NAMES the figure outrank an EXACT module band (docs/17 row 285, inversion I2)', () => {
    // The honest revival of row 247's premise half, NAME-SCOPED: the sentence
    // says `Stufe 7` about [[Marten Graubruch]] and nobody else, so it is a
    // statement about THAT gnome — exactly the shape the owner's row-282 ruling
    // wanted kept ("this was about 1 NPC"). No part mentions him, so the
    // structured channels fall through to the exact band (4); the named sentence
    // outranks it.
    const module = moduleFixture({
      premise:
        'Der Schmied [[Marten Graubruch]] ist ein Veteran der Stufe 7 und erinnert sich an die Gilde.',
      bands: ['4'],
      parts: [],
      levelMin: 4,
      levelMax: 4,
    });
    expect(partLevelForMention(module, 'Marten Graubruch')).toBeUndefined();
    expect(entityProseLevel(module, 'Marten Graubruch')).toBe(7);
    expect(moduleStatedLevel(module, 'Marten Graubruch')).toBe(7);
  });

  it('reads the PART sentence before the PREMISE sentence when both name the figure (docs/17 row 285)', () => {
    // The order is deterministic: the part (where the stat-block figure is
    // written) first, then the premise. Both name him; the part wins.
    const module = moduleFixture({
      premise: 'Der Schmied [[Marten Graubruch]] ist ein Veteran der Stufe 7.',
      bands: ['3'],
      parts: [
        { planIndex: 0, markdown: 'Im Tiefstollen wartet [[Marten Graubruch]] auf Stufe 5.' },
      ],
      levelMin: 3,
      levelMax: 3,
    });
    expect(entityProseLevel(module, 'Marten Graubruch')).toBe(5);
    expect(moduleStatedLevel(module, 'Marten Graubruch')).toBe(5);
  });

  it('resolves NOTHING for a figure the prose never NAMES — the non-vacuity half (docs/17 rows 282/285)', () => {
    // THE ARM THAT KEEPS ROW 282'S BAN ALIVE. A premise sentence about ANOTHER
    // figure is not evidence about this one, and a premise sentence about NO
    // figure is not evidence about anyone. Both still read as nothing.
    const otherFigure = moduleFixture({
      premise: 'Der Veteran [[Alte Schmiedin]] ist Stufe 9 und schweigt.',
      bands: ['4'],
      parts: [],
      levelMin: 4,
      levelMax: 4,
    });
    expect(firstLevelInText(otherFigure.spine?.premise ?? '')).toBe(9);
    expect(entityProseLevel(otherFigure, 'Marten Graubruch'), 'another figure’s sentence').toBeUndefined();
    // An EXACT band is still structure, so it decides — the row-282 half that survived.
    expect(moduleStatedLevel(otherFigure, 'Marten Graubruch')).toBe(4);
    // A premise about nobody, on a RANGE band: nothing resolves at all, and no
    // level is invented from the range.
    const noFigure = moduleFixture({
      premise: 'Ein Abenteuer für Stufe 5 Gruppen.',
      parts: [],
      levelMin: 1,
      levelMax: 4,
    });
    expect(entityProseLevel(noFigure, 'Marten Graubruch'), 'a sentence about no figure').toBeUndefined();
    expect(moduleStatedLevel(noFigure, 'Marten Graubruch')).toBeUndefined();
    // A PART sentence about a DIFFERENT figure is not evidence either: the part
    // does not mention our name, so it is not even read.
    const partOtherFigure = moduleFixture({
      premise: 'Ein Abenteuer ohne Angabe.',
      bands: ['3'],
      parts: [{ planIndex: 0, markdown: 'Am Tor steht [[Alte Schmiedin]] auf Stufe 9.' }],
      levelMin: 1,
      levelMax: 4,
    });
    expect(entityProseLevel(partOtherFigure, 'Marten Graubruch')).toBeUndefined();
    expect(moduleStatedLevel(partOtherFigure, 'Marten Graubruch')).toBeUndefined();
  });

  it('reads the module’s stated level from STRUCTURE, plus a sentence that NAMES the figure — never a module-wide premise read (docs/17 rows 282/285)', () => {
    // `moduleGen.normalizeAndSave` records the level BEFORE any part exists, and
    // its call passes NO name: the prose rungs genuinely do not exist at spine
    // time, so a premise is still NOT a module-wide level source. That premise
    // read is the defect that stamped one module-wide 7 on every npc of a
    // levels-1–2 module while the Smith minted level-1 blocks.
    const spineTime = moduleFixture({
      premise: 'Ein Abenteuer für Stufe 5 Gruppen.',
      parts: [],
      levelMin: 1,
      levelMax: 4,
    });
    expect(firstLevelInText(spineTime.spine?.premise ?? ''), 'the prose still SAYS 5').toBe(5);
    expect(moduleStatedLevel(spineTime), 'and with NO name it is not a level source').toBeUndefined();
    expect(moduleStatedLevel(spineTime, ''), 'nor for a blank name').toBeUndefined();
    // A premise stating no level and a RANGE band states no level either.
    const rangeless = moduleFixture({
      premise: 'Ein Abenteuer ohne Angabe.',
      parts: [],
      levelMin: 1,
      levelMax: 4,
    });
    expect(moduleStatedLevel(rangeless)).toBeUndefined();
    // An EXACT band is STRUCTURE, and it still resolves — with or without a name.
    const exact = moduleFixture({
      premise: 'Ein Abenteuer ohne Angabe.',
      parts: [],
      levelMin: 4,
      levelMax: 4,
    });
    expect(moduleStatedLevel(exact)).toBe(4);
    expect(moduleStatedLevel(exact, 'Niemand Genannt')).toBe(4);
    // …and an exact band is not overridden by PREMISE prose that names nobody:
    // structure beats a sentence that is about no figure.
    const exactWithLoudProse = moduleFixture({
      premise: 'Ein Abenteuer für Stufe 9 Gruppen.',
      parts: [],
      levelMin: 4,
      levelMax: 4,
    });
    expect(moduleStatedLevel(exactWithLoudProse)).toBe(4);
    // …while the SAME prose, once it NAMES the figure, is a statement about him
    // and outranks the exact band (the row-285 amendment, deliberately).
    const exactWithNamedProse = moduleFixture({
      premise: 'Der Veteran [[Marten Graubruch]] ist Stufe 9.',
      parts: [],
      levelMin: 4,
      levelMax: 4,
    });
    expect(moduleStatedLevel(exactWithNamedProse, 'Marten Graubruch')).toBe(9);
    expect(moduleStatedLevel(exactWithNamedProse, 'Niemand Genannt')).toBe(4);
  });

  it('hardens the two measured reader false positives (docs/17 row 282)', () => {
    // (1) `\\s*` USED TO CROSS A LINE BREAK: a level word at the end of one line
    // and any number starting the next became that prose's level. Horizontal
    // space only now — TAB and Unicode space separators still separate, a LINE
    // BREAK does not.
    expect(firstLevelInText('auf Stufe\n7'), 'a newline is not a separator').toBeUndefined();
    expect(firstLevelInText('Stufe\r\n7')).toBeUndefined();
    expect(firstLevelInText('Stufe\u000b7')).toBeUndefined();
    expect(firstLevelInText('Stufe\t7'), 'a TAB still separates').toBe(7);
    expect(firstLevelInText('Stufe\u00a07'), 'a NBSP still separates').toBe(7);
    // (2) A WORD ABUTTING ITS DIGITS USED TO MATCH: `Stufe7` (no separator)
    // invented a level. A non-CJK word now REQUIRES a separator…
    expect(firstLevelInText('Stufe7')).toBeUndefined();
    expect(firstLevelInText('level5')).toBeUndefined();
    expect(firstLevelInText('уровень7')).toBeUndefined();
    expect(firstLevelInText('Stufe 7'), '…while a real separator still resolves').toBe(7);
    // …but CJK keeps its no-separator form: that script has no word spacing, and
    // the pre-existing pin above (`レベル5`) is the reason `*` survives there.
    expect(firstLevelInText('レベル7')).toBe(7);
    expect(firstLevelInText('等级7')).toBe(7);
    // The level word must still be a standalone token: the negative lookbehind
    // is unchanged, so `Stufe7x` and `counterlevel 5` stay silent.
    expect(firstLevelInText('counterlevel 5')).toBeUndefined();
    expect(firstLevelInText('Stufe7x')).toBeUndefined();
  });

  it('finds a German level the old English-only reader could not see', () => {
    // The regression, stated as a differential against the PRE-FIX spelling:
    // this is the bug in one line.
    const PRE_FIX = /\blevel\s*(\d{1,2})\b/i;
    const german = '**Stufe 5 Endgegner für Die Mine.**';
    expect(PRE_FIX.exec(german)).toBeNull();
    expect(firstLevelInText(german)).toBe(5);
  });

  it('covers every GENERATION_LANGUAGES code, so a new language cannot silently regress', () => {
    // The build-time half (the `Record<GenerationLanguage, …>` type) is
    // enforced by `tsc`; this is the runtime half, so a language added with an
    // empty list is caught too. `tests/architecture/one-level-resolution.test.ts`
    // holds the source-level pin over the map itself.
    for (const { code } of GENERATION_LANGUAGES) {
      const words = LEVEL_WORDS[code];
      expect(words, `${code} has a level vocabulary`).toBeDefined();
      expect(words.length, `${code} lists at least one level word`).toBeGreaterThan(0);
      for (const word of words) expect(word.trim(), `${code} word is not blank`).not.toBe('');
    }
    expect(Object.keys(LEVEL_WORDS).sort()).toEqual(
      GENERATION_LANGUAGES.map(({ code }) => code).sort(),
    );
  });
});

const probe = /\blevel\s*(\d{1,2})\b/i;
void probe;
