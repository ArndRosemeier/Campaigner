import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * ONE seam resolves an entity's level, and ONE reader reads a level out of
 * prose (docs/17 rows 206 and 247, AGENTS rule 4).
 *
 * THE FIRST REGRESSION (row 206) was a MISSING COPY, not a wrong one: the
 * artifact editor's "Regenerate with AI" rebuilt `StartRunInput` without
 * `entityLevelHint`, so `runStatblock` silently fell back to a regex over a
 * brief whose only `level N` was the PARTY's.
 *
 * THE SECOND (row 247, the owner's level-5 smith) was the same idea again: a
 * level stated in the module's PREMISE reached nothing, a party-level line
 * biased the model, and the reply's own level was persisted verbatim — with a
 * notice beside it. The cure is still ONE site: `runStatblock` resolves FOUR
 * sources in ONE precedence chain (the user's instruction, the entity record's
 * hint, the module's own stated level, the brief's party-line-free fallback),
 * and the resolved value BINDS the parsed block. `moduleStatedLevel` is ONE
 * derivation (its two consumers — the spine recording the hint and the engine
 * resolving it — are named here), and `firstLevelInText` is the ONE reader of
 * `level N` out of any prose.
 *
 * The pins are SOURCE SCANS because the drift they catch is invisible: a second
 * call site that rebuilds `StartRunInput` reads correctly today and silently
 * loses the level the day a caller is added, and a second `level N` regex
 * anywhere is a second answer to the same question.
 *
 * THE THIRD (row 253) was an ASYMMETRY, not a copy count: the app GENERATES in
 * eleven languages (`llm/language.ts` carries the directive) while the ONE
 * reader asked only for the English word `level`, so a German module's own
 * `Stufe 5` reached NOTHING and the entity fell through to the module's band.
 * The vocabulary now lives in ONE map in the language seam (`LEVEL_WORDS`, one
 * entry per `GENERATION_LANGUAGES` code, machine-enforced complete) and the
 * reader is its ONE caller, so the pre-253 English-only regex is pinned ABSENT
 * rather than renamed: a level word list is a language fact, and a second one
 * is how the reader goes monolingual again (docs/17 row 162 is the same class).
 */

const SRC_DIR = join(process.cwd(), 'src');
const ENGINE = 'src/llm/runEngine.ts';
const ROOM_BUDGET = 'src/llm/roomBudget.ts';
const MODULE_GEN = 'src/llm/moduleGen.ts';
const LANGUAGE = 'src/llm/language.ts';

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full);
  }
  return out.sort();
}

function rel(full: string): string {
  return relative(process.cwd(), full).split(sep).join('/');
}

/** Comments are skipped: the seam's own docstring NAMES the regex it removes. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function scanned(): (readonly [string, string])[] {
  return sourceFiles(SRC_DIR).map(
    (file) => [rel(file), stripComments(readFileSync(file, 'utf8'))] as const,
  );
}

function filesContaining(needle: string): string[] {
  return scanned()
    .filter(([, text]) => text.includes(needle))
    .map(([file]) => file);
}

describe('ONE seam resolves the entity level (docs/17 rows 206/247/253)', () => {
  it('states the precedence chain at exactly one site, and only in the engine', () => {
    const files = sourceFiles(SRC_DIR);
    // Non-vacuity: the walk must see the whole tree, or it proves nothing.
    expect(files.length).toBeGreaterThan(300);
    expect(
      filesContaining('const resolvedLevel = explicitLevel ?? recordedLevel ?? moduleLevel'),
    ).toEqual([ENGINE]);
    // The user's instruction is read at that same site, and the module's own
    // level is consulted there too.
    expect(filesContaining('instructionLevel(statedInstruction)')).toEqual([ENGINE]);
    expect(filesContaining('context.moduleGrounding?.statedLevel')).toEqual([ENGINE]);
  });

  it('reads a level out of prose through ONE reader, fed by ONE language vocabulary', () => {
    // The reader itself…
    expect(filesContaining('export function firstLevelInText')).toEqual([ROOM_BUDGET]);
    // …and the level-WORD vocabulary lives in exactly ONE place (docs/17 row
    // 253): the language seam, beside the directive that makes the app GENERATE
    // in eleven languages. A new language is added to ONE map, not to a regex.
    expect(filesContaining('export const LEVEL_WORDS')).toEqual([LANGUAGE]);
    expect(filesContaining('export function levelWordsPattern')).toEqual([LANGUAGE]);
    // The reader is the ONLY caller of that pattern — a second caller would be
    // a second answer to "what does this text say the level is".
    expect(filesContaining('levelWordsPattern()').sort()).toEqual([ROOM_BUDGET, LANGUAGE].sort());
    // The PRE-253 English-only regex is GONE from `src/`, in BOTH spellings a
    // reader could be re-born as: a regex LITERAL (`/\blevel\s*(\d{1,2})\b/i`)
    // and the escaped SOURCE-string spelling, whose backslashes DOUBLE in the
    // source text (`'\\blevel\\s*(\\d{1,2})\\b'`). Whitespace is stripped
    // from each file first, so a literal wrapped across lines or re-spaced
    // (`` / \blevel \s* ( \d{1,2} ) \b / ``) is caught too. Non-vacuity: the
    // detector must fire on both source spellings, which is why each is
    // asserted against a synthetic text below. NOTE THE SCOPE: like every scan
    // in this file it walks `src/` ONLY, so an injection into the TEST tree is
    // invisible to it by construction — measured the hard way while proving
    // this pin: the first attempt injected in `tests/` and read the green as a
    // dead pin; the real injection went into `src/llm/language.ts` and red.
    const stripWhitespace = (text: string): string => text.replace(/\s+/g, '');
    const englishOnlyNeedle = String.raw`\blevel\s*(\d{1,2})\b`;
    const escapedNeedle = String.raw`\\blevel\\s*(\\d{1,2})\\b`;
    expect(
      stripWhitespace(String.raw`const a = /\blevel\s*(\d{1,2})\b/i;`),
      'the detector fires on a regex LITERAL',
    ).toContain(englishOnlyNeedle);
    expect(
      stripWhitespace(String.raw`const a = '\\blevel\\s*(\\d{1,2})\\b';`),
      'and on the escaped SOURCE-string spelling',
    ).toContain(escapedNeedle);
    const englishOnly = scanned()
      .filter(([, text]) => {
        const code = stripWhitespace(text);
        return code.includes(englishOnlyNeedle) || code.includes(escapedNeedle);
      })
      .map(([file]) => file);
    expect(englishOnly).toEqual([]);
  });

  it('derives the module’s own stated level once, for the spine recording and the engine resolution', () => {
    expect(filesContaining('export function moduleStatedLevel')).toEqual([ROOM_BUDGET]);
    // TWO consumers, both named: the spine records the level onto the entity
    // records it saves, the engine resolves it for a module-created run.
    expect(
      filesContaining('moduleStatedLevel(')
        .filter((file) => file !== ROOM_BUDGET)
        .sort(),
    ).toEqual([MODULE_GEN, ENGINE]);
  });

  it('routes the brief-text fallback through the ONE party-line exclusion, and leaves no raw-brief reader', () => {
    // Defined once, beside `partyLevelLine` whose shape it excludes…
    expect(filesContaining('export function withoutPartyLevelLines')).toEqual([ROOM_BUDGET]);
    // …and consumed only by the stat-block step: the fallback read AND the
    // prompt the step finally sends (docs/17 row 247 removed the party line from
    // BOTH, so what the reader ignores and what the model sees cannot drift).
    const callers = filesContaining('withoutPartyLevelLines(').filter(
      (file) => file !== ROOM_BUDGET,
    );
    expect(callers).toEqual([ENGINE]);
    // The pre-row-206 raw regex over the brief is GONE: a second reader that
    // bypasses the party-line exclusion reds here.
    expect(filesContaining('.exec(input.brief)')).toEqual([]);
  });
});
