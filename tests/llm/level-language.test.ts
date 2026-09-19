import { describe, expect, it } from 'vitest';

import {
  firstLevelInText,
  instructionLevel,
  moduleStatedLevel,
  partyLevelLine,
  partLevelForMention,
  withoutPartyLevelLines,
} from '@/llm/roomBudget';
import { LEVEL_WORDS, levelWordsPattern } from '@/llm/language';
import { GENERATION_LANGUAGES } from '@/domain/settings';
import type { Module } from '@/domain';

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
 * 5. a NAMED entity's part outranks the module-wide premise (row 253's second
 *    half — the old order let the module's own level 3 shadow the mob's 5).
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

  it('reads English text whatever the campaign’s language is (the union, not a thread)', () => {
    // The reader has no language argument at all — that is the design. An
    // owner typing an English redo instruction about a German module, or an
    // old English premise, resolves without any caller passing a setting.
    expect(instructionLevel('redo completely, this time at level 5')).toBe(5);
    expect(instructionLevel('redo completely, diesmal auf Stufe 5')).toBe(5);
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

  it('lets a NAMED entity’s part outrank the module-wide premise (row 253’s order fix)', () => {
    // The owner's exact shape: the module's band/premise says 3, a part names
    // the entity at 5. The old order returned the premise first, so `name` was
    // nearly dead code and the mob shipped at the module's 3.
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
    // THE MEASURED OUTCOME: the named part wins over the module's own 3.
    expect(moduleStatedLevel(module, 'Marten Graubruch')).toBe(5);
    // An entity NO part names still takes the module-wide statement.
    expect(moduleStatedLevel(module, 'Unbekannter Namenloser')).toBe(3);
  });

  it('keeps the spine-time call (no name, no parts) working on the premise', () => {
    // `moduleGen.normalizeAndSave` records the level BEFORE any part exists.
    const spineTime = moduleFixture({
      premise: 'Ein Abenteuer für Stufe 5 Gruppen.',
      parts: [],
      levelMin: 1,
      levelMax: 4,
    });
    expect(moduleStatedLevel(spineTime)).toBe(5);
    expect(moduleStatedLevel(spineTime, '')).toBe(5);
    // A premise stating no level and a RANGE band states no level either.
    const rangeless = moduleFixture({
      premise: 'Ein Abenteuer ohne Angabe.',
      parts: [],
      levelMin: 1,
      levelMax: 4,
    });
    expect(moduleStatedLevel(rangeless)).toBeUndefined();
    // An EXACT band is a stated level and still resolves.
    const exact = moduleFixture({
      premise: 'Ein Abenteuer ohne Angabe.',
      parts: [],
      levelMin: 4,
      levelMax: 4,
    });
    expect(moduleStatedLevel(exact)).toBe(4);
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
