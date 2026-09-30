/**
 * Escape-debris hygiene scanner (detection backstop for the UTF-8 contract
 * in `llm/language.ts`): model-generated non-ASCII intermittently arrives as
 * half-formed unicode escapes (`Flussmündung` → `Flussm?fcndung`). The
 * contract line is prevention; this pure scanner is detection. Valid decoded
 * text must never contain these shapes, so the finalize/part boundaries flag
 * them LOUDLY — never silent repair, never placeholder (AGENTS.md rules 1-2).
 */

/** The two debris shapes this scanner detects in already-decoded text. */
export type EscapeDebrisKind = 'question-hex' | 'unicode-escape';

export interface EscapeDebris {
  kind: EscapeDebrisKind;
  /** The exact offending substring, named verbatim in the loud issue. */
  match: string;
  /** Offset of the match within the scanned text. */
  index: number;
}

/**
 * `?` immediately followed by EXACTLY two lowercase hex chars (a third hex
 * char disqualifies — normal prose like "Huh?face it" must not flag). The
 * pair must form a non-ASCII codepoint tail (first nibble 8–f, i.e. byte ≥
 * 0x80: ü → `?fc`, ä → `?e4`, ö → `?f6`, ß → `?df`); ASCII tails such as
 * `?41` are ordinary prose/questions ("what? 42" never matches anyway — the
 * `?` there is not immediately followed by hex). Uppercase `?FC` is
 * deliberately out of scope: the observed debris is lowercase, and widening
 * the shape would buy false positives in normal prose.
 */
const QUESTION_HEX_PATTERN = /\?([0-9a-f]{2})(?![0-9a-f])/g;

/** A literal `\uXXXX` sequence sitting in ALREADY-DECODED stored text (which
 * must never contain a backslash-u sequence). A doubled backslash is
 * excluded — that is an author discussing escapes, not model debris. */
const UNICODE_ESCAPE_PATTERN = /(?<!\\)\\u[0-9a-fA-F]{4}/g;

function isNonAsciiTail(pair: string): boolean {
  const first = pair.charCodeAt(0);
  // '8'–'9' (0x38–0x39) or 'a'–'f' (0x61–0x66): the byte value is ≥ 0x80.
  return (first >= 0x38 && first <= 0x39) || (first >= 0x61 && first <= 0x66);
}

/**
 * Flags every escape-debris hit in already-decoded text, in text order.
 * Pure: no I/O, no repair — callers decide the loud failure (rejected step,
 * failed part). Clean text (including intact non-ASCII prose) yields [].
 */
export function findEscapeDebris(text: string): EscapeDebris[] {
  const hits: EscapeDebris[] = [];
  QUESTION_HEX_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = QUESTION_HEX_PATTERN.exec(text)) !== null) {
    const pair = match[1] ?? '';
    if (isNonAsciiTail(pair)) {
      hits.push({ kind: 'question-hex', match: match[0], index: match.index });
    }
  }
  UNICODE_ESCAPE_PATTERN.lastIndex = 0;
  while ((match = UNICODE_ESCAPE_PATTERN.exec(text)) !== null) {
    hits.push({ kind: 'unicode-escape', match: match[0], index: match.index });
  }
  hits.sort((a, b) => a.index - b.index);
  return hits;
}

/** One named string leaf for a boundary scan. */
export interface DebrisScanField {
  /** Dotted path naming the source (e.g. `draft.body`, `statBlock.traits[0].text`). */
  field: string;
  text: string;
}

/**
 * Collects every string leaf under `value` (objects and arrays walked;
 * anything else ignored) so a boundary can scan a whole draft/stat block
 * without enumerating its keys. `undefined`/`null` yields [].
 */
export function collectTextLeaves(value: unknown, base: string): DebrisScanField[] {
  const fields: DebrisScanField[] = [];
  const visit = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      fields.push({ field: path, text: node });
      return;
    }
    if (Array.isArray(node)) {
      for (const [index, entry] of node.entries()) visit(entry, `${path}[${String(index)}]`);
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, entry] of Object.entries(node)) visit(entry, `${path}.${key}`);
    }
  };
  if (value !== undefined && value !== null) visit(value, base);
  return fields;
}

/**
 * One LOUD issue per debris hit, naming the field and the exact debris —
 * the shape the rejected-step review card and the failed-part error card
 * render verbatim. No repair, no placeholder.
 */
export function debrisIssuesForFields(fields: readonly DebrisScanField[]): string[] {
  const issues: string[] = [];
  for (const { field, text } of fields) {
    for (const hit of findEscapeDebris(text)) {
      issues.push(
        `${field} contains escape debris "${hit.match}" (half-formed unicode escape in decoded text — refusing to persist; fix the text and retry)`,
      );
    }
  }
  return issues;
}
