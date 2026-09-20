import type { ChatMessage } from '@/llm/openrouter';
import { GENERATION_LANGUAGES, generationLanguageLabel } from '@/domain/settings';
import type { GenerationLanguage } from '@/domain/settings';

/**
 * Generation-language enforcement: every LLM prompt sent through the
 * OpenRouter client carries a system-level directive requiring all generated
 * content in the language chosen in settings (default English). Injected at
 * the single `chat()` choke point so run engine, module generator, image
 * prompt drafting, and rule Q&A are all covered. The directive also carries
 * the UTF-8 contract (non-ASCII characters written directly, never
 * \u-escaped), since model prose inside JSON strings otherwise arrives with
 * mangled umlauts.
 */

/** The message shape the directive is applied to — the real chat message. */
export type DirectiveMessage = ChatMessage;

/** The system-level instruction enforcing the generation language. */
export function languageDirective(language: string): string {
  const label = generationLanguageLabel(language);
  return [
    'Language requirement: Write ALL generated content (prose, descriptions,',
    `names, notes, and every free-text field) in ${label}. This overrides any`,
    'conflicting language hints elsewhere in this conversation.',
    'Write all non-ASCII characters directly as UTF-8; never use \\u escapes',
    'in prose or any free-text field.',
  ].join(' ');
}

/**
 * Returns the messages with the language directive attached: appended to the
 * LAST existing system message when one is present (keeping the persona's
 * system prompt first-class), otherwise as a leading system message.
 */
export function applyLanguageDirective<M extends DirectiveMessage>(
  messages: readonly M[],
  language: string,
): M[] {
  const directive = languageDirective(language);
  let lastSystemIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'system') {
      lastSystemIndex = i;
      break;
    }
  }
  if (lastSystemIndex === -1) {
    return [{ role: 'system', content: directive } as M, ...messages];
  }
  return messages.map((message, i) => {
    if (i !== lastSystemIndex) return message;
    const content =
      typeof message.content === 'string'
        ? `${message.content}\n\n${directive}`
        : [...message.content, { type: 'text' as const, text: directive }];
    return { ...message, content };
  });
}

/**
 * How each generation language SPELLS "level" in generated prose — the ONE
 * place a language's level wording lives (docs/17 row 253).
 *
 * WHY THIS EXISTS. The WRITE side has been language-aware since
 * `languageDirective` above (a German campaign's prose, premises and module
 * text all come back in German), while the READ side asked for the English
 * word: the app's ONE free-text level reader was `/\blevel\s*(\d{1,2})\b/i`,
 * so a German campaign's own `Stufe 5` was invisible to EVERY level source —
 * the user's redo instruction, the module's premise, the legacy brief
 * fallback — and the entity fell through to the module's band. That asymmetry
 * was the whole defect (docs/17 row 253, the owner's level-5 mob in a level-3
 * module).
 *
 * A UNION, NOT A THREADED ARGUMENT — deliberately. The reader is asked about
 * text whose language is NOT the setting: an owner types an English redo
 * instruction about a German module, and a module written in one language can
 * carry a premise in another. Reading every language's word means no caller
 * has to know or pass the active language, so a caller that forgets the
 * argument cannot regress it — which is exactly the bug class that produced
 * docs/17 row 206 (a caller-rebuilt input that lost a field). The generated
 * party-level line (`roomBudget.partyLevelLine`) is always ENGLISH, never
 * localized, so the union does not re-open the party-level trap either.
 *
 * EVERY code in `GENERATION_LANGUAGES` must appear here:
 * `tests/architecture/one-level-resolution.test.ts` fails when one is missing,
 * so adding a language cannot silently reintroduce this defect.
 *
 * Ordering within a list matters for overlapping spellings (the pattern tries
 * them in declared order); keep the more specific word first.
 */
export const LEVEL_WORDS: Readonly<Record<GenerationLanguage, readonly string[]>> = {
  en: ['level'],
  de: ['Stufe'],
  fr: ['niveau'],
  es: ['nivel'],
  it: ['livello'],
  pt: ['nível'],
  nl: ['niveau'],
  pl: ['poziom'],
  ru: ['уровень'],
  ja: ['レベル'],
  // Both spellings a model actually reaches for: 等级 is the dictionary term,
  // 级别 the common TTRPG one (verified against generated German/Chinese usage
  // rather than trusted from the brief alone — docs/17 row 253).
  zh: ['等级', '级别'],
};

/**
 * A word whose LAST character is CJK — the only words that may abut their
 * digits (docs/17 row 282). CJK is written without word spaces, so `レベル5` is
 * ordinary orthography; every other script separates the word from the number.
 */
const CJK_TAIL = /[\u3005-\u3007\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/**
 * The ONE regex source that finds a level word in ANY supported language,
 * anchored so a level word is a standalone token in BOTH scripts
 * (docs/17 row 253, hardened by docs/17 row 282).
 *
 * THE BOUNDARY IS THE WHOLE PROBLEM FOR CJK. A leading `\b` (the English
 * reader's anchor) can NEVER match before a kana/ideograph: JavaScript's `\w`
 * is ASCII-only, so `レ` is a NON-word character, no boundary exists between
 * it and the start of the string, and `\bレベル` therefore matches nothing —
 * measured, not reasoned. The trailing `\b` stays (ASCII digits ARE `\w`, so a
 * boundary after them always exists), and it is what keeps the app's level
 * domain honest: `level 2024` captures `20`, which the 1..20 bound then
 * rejects, so a four-digit year is never read as a level.
 *
 * The leading anchor is therefore a negative lookbehind over `[A-Za-z0-9_]` —
 * NOT over `\p{L}`: a Unicode property escape would also forbid the kana
 * immediately before the CJK word (`高レベル5` would stop resolving), trading
 * a false positive for a false negative in the very script this exists for.
 * The ASCII class reproduces the OLD reader's standalone-word intent exactly
 * (`counterlevel 5` / `levelup 5` still resolve nothing) while allowing a CJK
 * prefix. `i` case-folds the Latin words; `u` lets non-ASCII sources compile.
 * The caller applies the level DOMAIN (1..20) — this pattern only finds the
 * number.
 *
 * TWO MEASURED FALSE POSITIVES ARE NOW CLOSED (docs/17 row 282), which is why
 * the separator is per word rather than one `\s*` for the whole union:
 *
 * - **`\s*` CROSSED A LINE BREAK.** The old pattern matched `"auf Stufe\n7"`,
 *   so a level word at the end of one line and ANY number starting the next
 *   (a stat, a page, a year) became that prose's level. The separator is now a
 *   HORIZONTAL space only — `[\\p{Zs}\\t]` (Unicode space separators plus TAB),
 *   which deliberately EXCLUDES `\n`, `\r`, `\v` and `\f`.
 * - **A WORD ABUTTING ITS DIGITS MATCHED ANYWHERE.** `"Stufe7"` (no separator)
 *   resolved 7, so a malformed or merely concatenated token invented a level.
 *   A non-CJK word now REQUIRES at least one separator; a CJK word keeps
 *   `*` because its script has no word spacing (`レベル5` must still resolve).
 */
export function levelWordsPattern(): RegExp {
  const alternatives = GENERATION_LANGUAGES.flatMap(({ code }) =>
    LEVEL_WORDS[code].map((word) => {
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const separator = CJK_TAIL.test(word.slice(-1)) ? '[\\p{Zs}\\t]*' : '[\\p{Zs}\\t]+';
      return `(?:${escaped})${separator}`;
    }),
  );
  return new RegExp(`(?<![A-Za-z0-9_])((?:${alternatives.join('|')}))(\\d{1,2})\\b`, 'iu');
}
