import { describe, expect, it } from 'vitest';

import { escapeRegExp } from '@/domain/escapeRegExp';

/**
 * ONE regex-literal ESCAPE — the FOLD is proven by a DIFFERENTIAL, not by a
 * promise (docs/17 row 300; AGENTS rule 4 / centralization obligation 2).
 *
 * WHAT THIS FILE IS FOR. The class was spelled at SIX sites
 * (`domain/battle/board`, `llm/language`, `llm/promptScaffolding`,
 * `llm/campaignGrounding`, `llm/roomBudget`, `features/rules/search-browser`)
 * and is now ONE function. The risk of that fold is not a crash: the result of
 * every one of those expressions becomes a `RegExp` SOURCE, so a "cleaner" or
 * "wider" escaping changes WHICH characters a pattern treats literally — and
 * three of the six feed text that is SENT TO THE MODEL (`levelWordsPattern`,
 * the scaffolding markers, `wordBoundaryPattern`), where the prompt bytes are
 * pinned elsewhere. A silent byte change there is the one thing this fold must
 * not do, so the pre-fold expression is kept here as an ORACLE and the two are
 * run over the same inputs.
 *
 * WHY THE ORACLE IS A TEST-LOCAL COPY, which looks like the cross-tree
 * duplication docs/17 row 215 reds. It is the opposite of that defect: row 215
 * forbids a test that asserts against its own copy of PRODUCTION logic (the
 * copy keeps passing while production moves). This oracle is deliberately the
 * RETIRED bytes — the expression the six sites spelled BEFORE the fold — and
 * the assertion is that production EQUALS it. If the seam's escaping ever
 * moves, this file goes RED (that is exactly the injection arm it exists for),
 * so the oracle cannot drift along with the code it guards. It sits far under
 * the tripwire's 75-normalized-character floor, and the reason is written here
 * rather than left for the detector to bless by silence.
 */

/**
 * The PRE-FOLD expression, verbatim from the six sites. Do NOT "fix" this
 * toward the seam: it is the historical bytes, and its value is that it cannot
 * move when the seam does.
 */
const PRE_FOLD_INLINE = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One case per shape the brief names, plus the ones a real campaign produces:
 * every metacharacter, a plain name, the empty string, metacharacters only, an
 * emoji, a NUL, an already-escaped string — and a few the app actually meets
 * (a parenthesised attack, a German name with a `ß`, a path with backslashes).
 */
const CASES: readonly { readonly label: string; readonly input: string }[] = [
  { label: 'a plain name', input: 'Goblin Chief' },
  { label: 'the empty string', input: '' },
  { label: 'EVERY metacharacter at once', input: '.*+?^${}()|[]\\' },
  { label: 'metacharacters ONLY', input: '()[]{}^$.*+?|\\' },
  { label: 'a single metacharacter', input: '.' },
  { label: 'a dot that would otherwise match any character', input: 'A.B' },
  { label: 'a parenthesised attack', input: 'Attack (ranged)' },
  { label: 'a bracketed name', input: 'Wolf [pack]' },
  { label: 'an alternation', input: 'yes|no' },
  { label: 'a quantification run', input: 'a*b+c?d' },
  { label: 'anchors inside the name', input: '^start$end' },
  { label: 'backslashes', input: 'path\\to\\thing' },
  { label: 'an ALREADY-escaped string (escaping is not idempotent — the two copies must still agree)', input: 'a\\.b' },
  { label: 'an emoji', input: 'Ratte 😀' },
  { label: 'a NUL character', input: 'NUL\u0000tail' },
  { label: 'a newline and a tab', input: 'line\nbreak\ttab' },
  { label: 'German prose with a ß', input: 'Die Gilde im Keller (Groß)' },
  { label: 'emoji and NUL together', input: '😀\u0000' },
  { label: 'a long mixed name', input: 'Stufe 5: Goblin*Boss (Elite) [x] {y} ^z$ | \\ end' },
];

/** Every ASCII code point as its own one-character input. */
const ASCII_SINGLE_CHARS = Array.from({ length: 128 }, (_, code) => String.fromCharCode(code));

/** The whole ASCII range as ONE input. */
const ASCII_WHOLE = ASCII_SINGLE_CHARS.join('');

describe('the escape seam is byte-identical to the expression it replaced (docs/17 row 300)', () => {
  it('the differential: the pre-fold expression and the seam agree on every named input', () => {
    for (const { label, input } of CASES) {
      expect(escapeRegExp(input), label).toBe(PRE_FOLD_INLINE(input));
    }
  });

  it('the differential is not vacuous — the expression really escapes, and really changes bytes', () => {
    let changed = 0;
    for (const { input } of CASES) {
      if (PRE_FOLD_INLINE(input) !== input) changed += 1;
    }
    // If the class ever stopped escaping, the arms above would still "agree"
    // while measuring an identity — this is the control against that.
    expect(changed).toBeGreaterThan(10);
    for (const char of '.*+?^${}()|[]\\') {
      expect(PRE_FOLD_INLINE(char), `the oracle escapes ${JSON.stringify(char)}`).not.toBe(char);
      expect(escapeRegExp(char), `the seam escapes ${JSON.stringify(char)}`).not.toBe(char);
    }
  });

  it('the differential holds over the WHOLE ASCII range, per character and as one string', () => {
    for (const char of ASCII_SINGLE_CHARS) {
      expect(escapeRegExp(char), `ASCII ${char.charCodeAt(0)}`).toBe(PRE_FOLD_INLINE(char));
    }
    expect(escapeRegExp(ASCII_WHOLE)).toBe(PRE_FOLD_INLINE(ASCII_WHOLE));
  });

  it('the property the six sites rely on: the escaped literal matches ITSELF, never a metacharacter neighbour', () => {
    for (const { label, input } of CASES) {
      expect(new RegExp(`^${escapeRegExp(input)}$`).test(input), label).toBe(true);
    }
    // The reason the escaping exists: unescaped, `A.B` would also claim `AxB`.
    expect(new RegExp('^A.B$').test('AxB')).toBe(true);
    expect(new RegExp(`^${escapeRegExp('A.B')}$`).test('AxB')).toBe(false);
    expect(new RegExp(`^${escapeRegExp('A.B')}$`).test('A.B')).toBe(true);
  });
});
