import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { markdownToDisplayText, markdownToText } from '@/lib/markdown';
import {
  countOccurrences,
  extractWikiLinks,
  resolveWikiLink,
  sentenceAround,
  stripWikiLinks,
  surroundingParagraphs,
} from '@/lib/wikilinks';
import { comparableName, mergeAliasNames, sameAliasName } from '@/domain/artifactAlias';
import { normalizeCreatureName, sameCreatureName } from '@/domain/creatureName';
import type { AnyArtifact } from '@/domain';

/**
 * THE CLASS THIS FILE PINS: **a rule that only holds in English is not a
 * rule** (docs/17 row 162; the owner's mandate, verbatim: *"Honestly i think
 * its good that i do german modules, otherwise some bugs would just not be
 * found. This should really work in any language."*).
 *
 * The owner authors modules in German on purpose and calls it free fuzzing. A
 * defect he hit this week was exactly this class (the bestiary cast refused
 * «Plague Zombie» from the book «Monsterkern» although the library holds that
 * creature, because a MODEL-AUTHORED, TRANSLATABLE DISPLAY STRING was used as a
 * RESOLUTION KEY — docs/17 row 161). This file holds the two halves of the
 * fix that make the shape impossible to repeat:
 *
 * 1. the ONE ASCII-only regex over user text (below), and
 * 2. the SOURCE SCAN that goes red when a new one appears (further down).
 *
 * The German round-trip through the real seams (markdown strip → wiki-token
 * parse → comparable-form match, NFC vs NFD) lives in the same file, because it
 * is the same claim stated end to end.
 */

/**
 * The emphasis rule as it stood BEFORE this slice, verbatim from
 * `src/lib/markdown.ts:18`. `\w` is ASCII-only in JavaScript (`[A-Za-z0-9_]`,
 * whatever the flags), so `(?<!\w)` asks "is the character before this `*` a
 * LATIN-ASCII letter" while the author of the text meant "is it a LETTER".
 *
 * It is kept here as the ORACLE of the "the fix cannot change English
 * behaviour" claim: a differential over a bounded-exhaustive ASCII corpus, not
 * a promise. A test file is outside the source scan's walk (`src/` only), which
 * is one of the limits that scan states about itself.
 */
const PRE_FIX_EMPHASIS = /(?<!\w)\*([^*\n]+)\*(?!\w)/g;

/** The whole pre-fix stripper, so the ASCII differential runs at the level of
 *  the FUNCTION a caller uses rather than of one line of it. */
function preFixMarkdownToText(markdown: string): string {
  return markdown
    .replaceAll(/```[\s\S]*?```/g, (block) => block.replaceAll(/^```[a-z]*\n?|```$/gm, ''))
    .replaceAll(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replaceAll(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replaceAll(/^#{1,6}\s+/gm, '')
    .replaceAll(/\*\*([^*]+)\*\*/g, '$1')
    .replaceAll(PRE_FIX_EMPHASIS, '$1')
    .replaceAll(/(?<!_)_([^_\n]+)_(?!_)/g, '$1')
    .replaceAll(/`([^`]+)`/g, '$1')
    .trim();
}

describe('emphasis over text that is not Latin-ASCII (docs/17 row 162)', () => {
  /**
   * THE PIN THAT WAS WATCHED FAILING BEFORE THE FIX. A word-final `ß` or a
   * word-final accented letter (`Gruß*`, `Spaß*`, `René*`) is NOT a `\w`
   * character, so `(?<!\w)` was satisfied and the literal asterisk right after
   * it was read as an emphasis DELIMITER — the pair of footnote markers was
   * eaten out of the rendered text. The English line of the same shape keeps
   * both markers, which is what makes this a rule that only holds in English.
   */
  it('keeps a literal * after a word-final ß instead of reading it as an emphasis delimiter', () => {
    // The `*` must follow a word that ENDS in the non-ASCII letter: `Siegel*`
    // would pass on the pre-slice code too (the `l` before it is a `\w`
    // character), which is exactly the kind of non-discriminating pin this
    // sentence was written to avoid — measured, not assumed.
    expect(markdownToText('Ein Gruß* aus Wien, und ein Spaß* für alle.')).toBe(
      'Ein Gruß* aus Wien, und ein Spaß* für alle.',
    );
    // The SAME SHAPE in English, which never lost its markers: the differential
    // that shows the old rule was an English-only rule rather than a rule.
    expect(markdownToText('A greeting* from Vienna, and a joke* for everyone.')).toBe(
      'A greeting* from Vienna, and a joke* for everyone.',
    );
  });

  it('keeps a literal * after a word-final accented letter too', () => {
    expect(markdownToText('René* und André* sind da.')).toBe('René* und André* sind da.');
  });

  it('still strips a real emphasis pair written in German', () => {
    expect(markdownToText('*Grüße* aus Wien')).toBe('Grüße aus Wien');
    expect(markdownToText('Die «Straße» ist *wirklich* schön.')).toBe(
      'Die «Straße» ist wirklich schön.',
    );
    expect(markdownToText('Er sagte: *Hör auf!*')).toBe('Er sagte: Hör auf!');
  });

  /**
   * THE "CANNOT CHANGE ENGLISH BEHAVIOUR" CLAIM, MEASURED. The Unicode class
   * `[\p{L}\p{N}_]` and `\w` pick out EXACTLY the same characters in ASCII, so
   * the two implementations must agree on every ASCII input. This is a
   * bounded-exhaustive differential over the alphabet `['a', ' ', '*', '1',
   * '_']` (3 906 strings up to length 5 — every arrangement of the emphasis
   * grammar at that width), not a sample, plus the ordinary English documents
   * below.
   *
   * Deliberately NOT covered: a code fence carrying an INFO STRING (```` ```JS ````).
   * That is the one other place this slice touches the same function, it is a
   * deliberate behaviour change, and it has its own pin below rather than being
   * smuggled into an equivalence claim it would falsify.
   */
  it('is byte-identical to its pre-slice self on ASCII input', () => {
    const alphabet = ['a', ' ', '*', '1', '_'];
    let checked = 0;
    const build = (prefix: string, depth: number): void => {
      if (prefix !== '') {
        checked += 1;
        expect(markdownToText(prefix), JSON.stringify(prefix)).toBe(preFixMarkdownToText(prefix));
      }
      if (depth === 0) return;
      for (const char of alphabet) build(`${prefix}${char}`, depth - 1);
    };
    build('', 5);
    // Non-vacuity: the walk really enumerated the corpus.
    expect(checked).toBe(3905);

    const english = [
      '# Title\n\n**bold** and _em_ and [link](https://x.y)',
      'plain *soft* emphasis in an English sentence',
      'a * b * c',
      '5*3 and 2*4',
      '`code *stars* here`',
      '```\nfenced code\n```',
      'Not a link: [[ not even this one',
      'snake_case_name and _underscored_ word',
    ];
    for (const source of english) {
      expect(markdownToText(source), source).toBe(preFixMarkdownToText(source));
    }
  });

  /**
   * The ONE deliberate English-behaviour change of this slice, named rather
   * than hidden: `^```[a-z]*` left the info string of a fence written in any
   * other spelling in the stripped text (a `\`\`\`JS` fence printed `JS` as
   * prose to a reader). An info string is machine metadata, never prose, so it
   * is now stripped whatever it says. BEFORE: `markdownToText('```JS\nx\n```')
   * === 'JS\nx'`; AFTER: `'x'`.
   */
  it('strips a code fence info string however it is spelled', () => {
    expect(markdownToText('```JS\nx\n```')).toBe('x');
    expect(markdownToText('```de\nx\n```')).toBe('x');
    expect(markdownToText('```c++\nx\n```')).toBe('x');
    expect(markdownToText('```js\nx\n```')).toBe('x');
    expect(markdownToText('```\nx\n```')).toBe('x');
  });
});

/**
 * A GERMAN SENTENCE THROUGH THE REAL SEAMS, end to end: umlauts, `ß` and `« »`
 * survive (a) the markdown→plain-text stripper, (b) the wiki-token parse and
 * (c) the comparable-form match — and the SAME name in composed (NFC) and
 * decomposed (NFD) Unicode form matches, which is what a Mac-authored string
 * looks like (docs/17 row 162).
 *
 * NFD is built with `String.normalize('NFD')` rather than written as escapes:
 * a literal combining diaeresis in this file is invisible in a diff, and a pin
 * nobody can READ is a pin nobody will maintain.
 */
describe('German text through the seams (docs/17 row 162)', () => {
  const SIGIL = 'Siegel der Müller';
  const sigilNfc = SIGIL.normalize('NFC');
  const sigilNfd = SIGIL.normalize('NFD');
  /** `[[Name|display]]` written with a DECOMPOSED name and a German display. */
  const germanProse = `Der Wächter grüßt die «Straße» hinab. Er trägt das [[${sigilNfd}|Siegel]].`;

  it('(a) survives the markdown→plain-text stripper byte for byte', () => {
    // No markdown syntax here at all: the stripper must be the identity, which
    // is the claim a German sentence with umlauts, ß and guillemets needs.
    const plain = 'Der Wächter grüßt die «Straße» hinab. Er trägt das Siegel.';
    expect(markdownToText(plain)).toBe(plain);
    expect(markdownToText('Der Wächter grüßt.')).toBe('Der Wächter grüßt.');
    // …and the token form renders the DISPLAY, with the German text intact.
    expect(markdownToDisplayText(germanProse)).toBe(
      'Der Wächter grüßt die «Straße» hinab. Er trägt das Siegel.',
    );
  });

  it('(b) survives the wiki-token parse, non-ASCII name and display alike', () => {
    const links = extractWikiLinks(`[[Müller|der Müller]] und [[Straße]] und [[${sigilNfd}]]`);
    expect(links.map((link) => link.name)).toEqual(['Müller', 'Straße', sigilNfd]);
    expect(links.map((link) => link.display)).toEqual(['der Müller', 'Straße', sigilNfd]);
    expect(stripWikiLinks(germanProse)).toBe(
      'Der Wächter grüßt die «Straße» hinab. Er trägt das Siegel.',
    );
  });

  it('(c) resolves a DECOMPOSED token against a COMPOSED artifact, and the reverse', () => {
    const composed = artifact({ name: sigilNfc });
    const decomposed = artifact({ name: sigilNfd });
    // The pair that a Mac-authored string meets every day: NFD vs NFC.
    expect(sigilNfd).not.toBe(sigilNfc);
    expect(sameAliasName(sigilNfd, sigilNfc)).toBe(true);
    expect(comparableName(sigilNfd)).toBe(comparableName(sigilNfc));
    expect(resolveWikiLink(sigilNfd, [composed]).status).toBe('resolved');
    expect(resolveWikiLink(sigilNfd, [composed]).artifact?.id).toBe(composed.id);
    expect(resolveWikiLink(sigilNfc, [decomposed]).artifact?.id).toBe(decomposed.id);
    // The creature tier applies the same comparable form.
    expect(sameCreatureName(sigilNfd, sigilNfc)).toBe(true);
    expect(normalizeCreatureName(sigilNfd)).toBe(normalizeCreatureName(sigilNfc));
    // …and canonical equivalence is NOT diacritic folding: the strict tier
    // still tells «Müller» from «Muller», and the loose creature form still
    // folds them (the two-sided vocabulary of docs/17 row 114 is untouched).
    expect(sameAliasName('Müller', 'Muller')).toBe(false);
    expect(normalizeCreatureName('Müller')).toBe(normalizeCreatureName('Muller'));
  });

  it('(d) treats the two compositions as ONE name wherever a name is a key', () => {
    // The alias POOL: an NFD spelling of the artifact's own NFC name is not an
    // alias, and a merge that adds nothing returns the caller's list unchanged.
    const existing: string[] = [];
    expect(mergeAliasNames(existing, [sigilNfd], sigilNfc)).toBe(existing);
    // The COUNTING and CONTEXT readers must agree with resolution — they feed
    // the entity briefs and the mention panel, and an empty answer there is a
    // SILENT one (the model is handed no context and nothing says so).
    const documents = [{ where: 'part-1', markdown: `Er trägt das ${sigilNfc}.` }];
    expect(countOccurrences(sigilNfd, documents)).toEqual([{ where: 'part-1', count: 1 }]);
    expect(sentenceAround(documents[0]?.markdown ?? '', sigilNfd)).toBe(
      `Er trägt das ${sigilNfc}.`,
    );
    expect(surroundingParagraphs(documents[0]?.markdown ?? '', sigilNfd)).toBe(
      `Er trägt das ${sigilNfc}.`,
    );
    // The other direction too, so the pin cannot be satisfied by normalizing
    // one side only.
    expect(sentenceAround(`Er trägt das ${sigilNfd}.`, sigilNfc)).toBe(
      `Er trägt das ${sigilNfd}.`,
    );
  });
});

/** A minimal artifact row — only the fields the resolver reads. */
function artifact(fields: { name: string }): AnyArtifact {
  return {
    id: 'a4a4a4a4-0000-4000-8000-000000000001',
    kind: 'npc',
    name: fields.name,
    aliases: [],
    campaignId: null,
    moduleId: null,
    body: '',
    data: {},
    createdAt: 0,
    updatedAt: 0,
  } as unknown as AnyArtifact;
}

/**
 * THE "EXACTLY ONE" PIN FOR THE CLASS (AGENTS §Centralization 2): a SOURCE SCAN
 * over `src/` that goes red when an ASCII-only text regex is born outside the
 * declared sites, in the shape of the markdown-pipe-grammar scan
 * (`tests/lib/mdToPdfmake.test.ts`, docs/17 row 157).
 *
 * WHY A SCAN AND NOT ONLY BEHAVIOUR. `\w`, `\b` and `[a-z]` are ASCII-only in
 * JavaScript, and the difference is INVISIBLE on English input — that is the
 * whole reason this class survives review: a copy is born correct where it is
 * written, and only a German (or Japanese, or Arabic) sentence ever shows it.
 * Measured on the pre-slice tree: `Der Wächter trägt ein Siegel* und der Wirt
 * einen Gruß*.` lost its two footnote markers while the English line of the
 * same shape kept both. Behaviour can therefore only pin the sites somebody
 * thought of; the scan is what catches the site nobody has written yet.
 *
 * WHAT IT CANNOT SEE, stated here rather than discovered later:
 * - it walks `src/` only, so a TEST may hold a copy of an ASCII pattern — and
 *   one deliberately does: `PRE_FIX_EMPHASIS` above is the pre-slice rule kept
 *   as the oracle of the English-equivalence differential;
 * - it is TEXTUAL: a pattern assembled at runtime (`new RegExp(name)`) is
 *   invisible, and so is an ASCII assumption spelled without one of these
 *   idioms (`codePointAt`, `charAt` + a manual range test, a `String.raw`
 *   template is seen only because the shape is written down in it);
 * - it finds a SITE, never a JUDGEMENT: whether a declared site is applied to
 *   user/model text is the reason recorded beside it, and the reason is what a
 *   reader must re-check when the site changes;
 * - `\d` over non-ASCII DIGITS is not detected by the idioms below, because in
 *   those sites `[0-9]` is the deliberate spelling of a hex/digit grammar (see
 *   the declared reasons). An Arabic-Indic digit in a stat block would MISS the
 *   detector, not corrupt it.
 */
describe('every ASCII-only text regex lives in a declared site (SOURCE SCAN, docs/17 row 162)', () => {
  /** `\w`/`\b`/`[a-z]`/`[A-Z]`/`[0-9]`, char-code arithmetic, and the
   *  locale-aware case fold — the idioms that encode "text is ASCII". */
  const ASCII_TEXT_SHAPE =
    /\\[wWbB]|\[a-z|\[A-Z|\[0-9|charCodeAt|fromCharCode|toLocaleLowerCase/;

  /**
   * Every file allowed to carry the shape, with its LINE COUNT and the reason.
   * Each entry is a judgement a reviewer can disagree with, which is the point:
   * deleting one because a site "looks fine" is how the ninth copy gets born.
   */
  const DECLARED_SITES: Readonly<Record<string, number>> = {
    'src/domain/exportDependencies.ts': 2,
    'src/domain/persona.ts': 1,
    'src/domain/promptStyle.ts': 1,
    'src/domain/rulebook.ts': 1,
    // `src/features/modules/persona-request.ts` USED to be declared here (2):
    // `guessKindFromSentence`'s English keyword regexes over a typed sentence.
    // Row 293 DELETED that guesser — the entity kind now comes from the module's
    // recorded kind or the ONE structured classification call — so the file no
    // longer holds an ASCII-only text regex and its declaration is DELETED, not
    // rewritten (a declared site that no longer exists lies about the tree, and
    // its REASONS entry below goes with it).
    'src/ingest/packs/dnd5e-foundry.ts': 2,
    'src/ingest/packs/pf2e-journal.ts': 2,
    'src/ingest/packs/text.ts': 2,
    'src/ingest/statblock.ts': 11,
    'src/lib/backup.ts': 1,
    'src/lib/base64.ts': 1,
    'src/lib/encodingHygiene.ts': 3,
    'src/lib/exportImport.ts': 1,
    'src/llm/canvasChat.ts': 1,
    'src/llm/canvasRefine.ts': 3,
    'src/llm/imageGen.ts': 1,
    // docs/17 rows 247 and 253: the ONE level reader (in `roomBudget.ts`) is
    // fed by the ONE level-WORD vocabulary (in `language.ts`), and the ASCII
    // shape moved with the regex when the reader became language-aware.
    'src/llm/language.ts': 1,
    'src/llm/strictSchema.ts': 1,
    'src/llm/visionDungeon.ts': 1,
  };

  /** Why each site is safe. A declared site without a reason, or a reason for a
   *  site that is no longer declared, fails (the reasons cannot rot in place). */
  const REASONS: Readonly<Record<string, string>> = {
    'src/domain/exportDependencies.ts':
      'a contentHash: a SHA-256 HEX DIGEST, not text — a non-ASCII character can never be part of one',
    'src/domain/persona.ts':
      'a persona SLUG identifier (kebab-case), our own vocabulary rather than prose',
    'src/domain/promptStyle.ts':
      'the {{placeholder}} grammar of a style: placeholder names are our own ASCII tokens (premise, partText, …), never user prose',
    'src/domain/rulebook.ts': 'a SHA-256 hex digest, same as exportDependencies',
    'src/ingest/packs/dnd5e-foundry.ts':
      'TWO machine-format patterns, neither of them prose: the `@abilities.str.mod` FORMULA grammar of the Foundry pack format, and the higher-levels SECTION PROBE row 294 added (`/(?:^|</p>|<br…)\\s*(?:<[^<>]+>\\s*)*(?:at\\s+)?higher\\s+levels?\\b/i`), which matches the pack\u2019s own `<strong>At Higher Levels</strong>` markup to tell a MISS from an absence — the English words are the PUBLISHER\u2019s heading, not user text',
    'src/ingest/packs/pf2e-journal.ts':
      'the `<em>… pg. …</em>` page-reference markup: the English `pg.` abbreviation is printed by the pack\u2019s own publisher',
    'src/ingest/packs/text.ts':
      'the `@Type[…]{…}` inline-notation grammar of the Foundry pack format: machine syntax',
    'src/ingest/statblock.ts':
      'the d20 STAT BLOCK vocabulary (Armor Class, Hit Points, Speed, STR/DEX/CON, Challenge, Level) and its numbers — English format keywords by the systems\u2019 own spec. A stat block written with non-ASCII digits MISSES detection (the chunk is simply not classified), it is never corrupted, and a citation that then finds no chunk fails loudly (docs/17 row 155)',
    'src/llm/language.ts':
      'the level-READER pattern (`levelWordsPattern`, docs/17 rows 247 and 253) over the module\u2019s own premise / part prose and over a user\u2019s change instruction: the ASCII digits plus the leading `[A-Za-z0-9_]` lookbehind are the RAW MATERIAL of a level rather than prose to classify. The language assumption this scan hunts is NOT here — the alternation is the UNION of all eleven `GENERATION_LANGUAGES` level words (`LEVEL_WORDS`, machine-enforced complete), CJK included — which is exactly why this file is an ASCII SHAPE and not a bug. Its failure mode is a MISSING level, never corrupted text \u2014 with no exact statement the module\u2019s band BOUNDS the block, and a module-owned run with no band refuses loudly (docs/17 row 247). Residual and accepted: an ASCII-letter lookbehind also declines a kanji immediately prefixing the CJK word (\u201e\u9ad8\u30ec\u30d9\u30eb5\u201c), because the alternative \u2014 a `\\p{L}` lookbehind \u2014 would decline the ordinary CJK spelling `\u30ec\u30d9\u30eb5` itself',
          'src/lib/backup.ts':
        'the camelCase SPLITTER for an internal Dexie TABLE NAME (a store name is our own ASCII vocabulary), used to render a display label — never user prose, and nothing is matched or stored from it',
      'src/lib/base64.ts': 'charCodeAt over a BINARY string (base64 bytes), not over text',
    'src/lib/encodingHygiene.ts':
      'the DEBRIS DETECTOR itself: `?` + two lowercase hex, and the literal `\\uXXXX` escape. ASCII is the POINT — the defect it finds IS a mangled non-ASCII character (docs/18 §2, row 177)',
    'src/lib/exportImport.ts': 'String.fromCharCode byte→binary, the sibling of base64',
    'src/llm/canvasChat.ts':
      'the attribute-NAME scanner of a model-authored `<edit …>` tag: our own ASCII attribute vocabulary, and an unknown name does not mis-parse — the next check throws `malformed attribute in <edit> tag` LOUD',
    'src/llm/canvasRefine.ts':
      '`b: \'\\b\'` is the JSON BACKSPACE escape in a string literal, not a word boundary (a detector false positive, declared rather than special-cased); the other two read a `\\uXXXX` escape, where hex is ASCII by definition',
    'src/llm/imageGen.ts':
      'matches the PROVIDER\u2019s own English error sentence (`parameter(s): n`), not user text',
    'src/llm/strictSchema.ts':
      'an OpenAI-style schema NAME: `[A-Za-z0-9_-]{1,64}` is the provider\u2019s documented grammar',
    'src/llm/visionDungeon.ts':
      'String.fromCharCode builds the A–N PLAQUE LABELS of the vision contract: ASCII by design',
  };

  function srcFiles(dir = 'src'): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(join(process.cwd(), dir)).sort()) {
      const path = `${dir}/${entry}`;
      if (statSync(join(process.cwd(), path)).isDirectory()) out.push(...srcFiles(path));
      else if (/\.tsx?$/.test(entry)) out.push(path);
    }
    return out;
  }

  /** The matching lines of one file — comment lines skipped, because a doc
   *  comment NAMING `\w` is prose about the rule, not a rule. */
  function asciiShapeLines(text: string): string[] {
    return text.split('\n').filter((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) {
        return false;
      }
      return ASCII_TEXT_SHAPE.test(line);
    });
  }

  it('declares exactly the ASCII-only text regexes that exist, and no more', () => {
    const files = srcFiles().filter((file) => /\.tsx?$/.test(file));
    // Non-vacuity 1: the walk must see the whole app.
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain('src/lib/markdown.ts');

    // Non-vacuity 2: the detector must really fire on the shape it hunts, and
    // the file this slice fixed must really carry the Unicode spelling now —
    // asserted over its CODE lines, because the seam's own doc comment NAMES
    // the ASCII rule it replaced (measured the hard way: the first version of
    // this assertion read the raw text and went red on that explanation).
    const seam = readFileSync(join(process.cwd(), 'src/lib/markdown.ts'), 'utf8');
    expect(seam).toContain('const EMPHASIS_PATTERN = /(?<![\\p{L}\\p{N}_])\\*([^*\\n]+)\\*(?![\\p{L}\\p{N}_])/gu;');
    expect(asciiShapeLines(seam), 'src/lib/markdown.ts holds no ASCII-only text regex').toEqual([]);
    expect(asciiShapeLines('const a = /\\bfoo\\b/g;')).toHaveLength(1);
    expect(asciiShapeLines('// a comment naming \\bfoo\\b')).toHaveLength(0);

    const found: Record<string, number> = {};
    for (const file of files) {
      const lines = asciiShapeLines(readFileSync(join(process.cwd(), file), 'utf8'));
      if (lines.length > 0) found[file] = lines.length;
    }
    // Non-vacuity 3: the scan is not vacuous — it finds a real population.
    const total = Object.values(found).reduce((sum, count) => sum + count, 0);
    expect(total).toBeGreaterThan(30);
    expect(Object.keys(found).length).toBeGreaterThan(10);

    expect(found).toEqual(DECLARED_SITES);
    // Rot check: every declared site still exists (an equality above already
    // proves it, and this names the offender when it stops being true)…
    for (const site of Object.keys(DECLARED_SITES)) {
      expect(found[site], `${site} no longer holds an ASCII-only text regex`).toBeDefined();
    }
    // …and every declared site, and no other, carries a reason.
    expect(Object.keys(REASONS).sort()).toEqual(Object.keys(DECLARED_SITES).sort());
  });

  it('never folds case with the locale, which is the matching hazard rather than a fix', () => {
    const offenders: string[] = [];
    for (const file of srcFiles()) {
      // Same comment rule as the shape scan: a doc comment NAMING
      // `toLocaleLowerCase` is prose about the hazard, not the hazard. Found
      // the hard way — this check's first version read the raw file text and
      // went red on the seam's own explanation of why it is forbidden.
      for (const line of readFileSync(join(process.cwd(), file), 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) {
          continue;
        }
        if (line.includes('toLocaleLowerCase')) offenders.push(`${file}: ${trimmed}`);
      }
    }
    // Zero, deliberately (docs/17 row 162): in a Turkish locale `I` folds to
    // `ı`, so a locale-aware fold makes a name resolve on one machine and not
    // on another. `toLowerCase` is the correct comparison fold everywhere.
    expect(offenders).toEqual([]);
  });
});
