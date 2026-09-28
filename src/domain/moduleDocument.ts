import { entityKindFor, type EntityKind, type ModuleEntityKind } from '@/domain/module';
import { extractWikiLinks } from '@/lib/wikilinks';

/**
 * THE module document (docs/23-CAMPAIGN-ARC §2–§4, the owner-ratified contract):
 * ONE text per module, read as a list of LEVELS addressed by number.
 *
 * ```
 * <level 0: the premise — everything before the first separator line>
 *
 * =====Level 1=====
 * ## The cursed ship
 * <prose for level 1>
 *
 * =====Level 2=====
 * <prose for level 2>
 * ```
 *
 * THE PREMISE IS LEVEL 0 (owner decision, 2026-09-28). A document is level 0
 * followed by levels 1..N, and level 0 is the one level with NO separator of its
 * own — it is simply everything before `=====Level 1=====`. There is therefore no
 * separate "premise" concept anywhere in this seam: the same level list, the same
 * ranges and the same edit helpers address every section of the document by
 * number, which is exactly why one command family can serve both the premise and
 * the levels and why nothing needs a premise-shaped special case. ZERO
 * SEPARATORS is legal and is simply the "level 0 only" state — the "starts with
 * nothing" document.
 *
 * The format belongs to the APP, exactly as `modulePartsDocument.ts` owns the
 * legacy `==========` parts document. The app WRITES the separators; the model
 * writes prose and is told to preserve the scaffold. So every read here is the
 * paired formatter/parser carve-out of AGENTS rule 5 — a pattern over the app's
 * OWN machine-generated line, kept beside the formatter that writes it and never
 * applied to prose.
 *
 * WHAT IS ENFORCED, LOUDLY AND WITHOUT REPAIR (docs/23 §3). A read either yields
 * the level list or throws `ModuleDocumentError` NAMING THE LINE:
 *  - a separator whose shape is not exactly canonical;
 *  - a NEAR-MISS — a line that looks like a level header but is not canonical.
 *    This is the failure the rule exists for: it must never be silently merged
 *    into the level above, because a silent merge loses a level with no signal;
 *  - a duplicated level number;
 *  - a skipped or out-of-order level number (the separators ascend from 1, one at
 *    a time; level 0 has no separator and cannot be written).
 *
 * THE TOLERANCE IS CLOSED (docs/23 §3): the line's own trailing whitespace and
 * its own `\r`. Nothing else. Case is NOT tolerated (`=====level 3=====`) and
 * neither is indentation (`  =====Level 3=====`), because the app writes the
 * canonical form at column 0 — so anything else is a near-miss and therefore
 * LOUD. The near-miss test is deliberately over-inclusive in one direction
 * only: a separator-shaped line that merely MENTIONS a level is an error, so an
 * unlucky line of prose costs a loud, correctable message, while the opposite
 * mistake would cost a silently lost level.
 *
 * THE LEVEL LIST IS DERIVED, NEVER STORED (docs/23 §4). `moduleLevelList` reads
 * each level's number, its section's text range and the wiki-linked names it
 * mentions (annotated with the kind the module recorded for them), plus
 * `levelMin`/`levelMax`. A stored copy of any of these would be a second truth;
 * the schema cut that deletes the old model stores the ONE text instead.
 *
 * LEVEL-ADDRESSED EDITS (the phase-3 chat commands' requirement, no scope here):
 * the ranges make an edit a splice, not a rewrite — `replaceLevelText` puts new
 * prose in ONE level (level 0 included, which edits the premise) and
 * `appendLevelText` adds to a level's prose or creates the next one (the APP
 * writes the canonical separator and the number). Both take the PARSED document
 * and return the edited text with its own parse, so a batch of edits never
 * re-reads the document to find its levels, and both parse their own RESULT so a
 * bad body is refused loudly rather than landing unreadable text. There is no
 * third document representation: the edit result carries the same
 * `ModuleDocument` a read produces. The command VOCABULARY, its parsing and the
 * chat wiring are phase 3's and are deliberately not here.
 *
 * BUILD STATE, recorded here because an uncalled seam is otherwise a mystery.
 * This module is the phase-1 FORMAT CONTRACT and is complete and pinned on its
 * own; wiring it (replacing `spine.premise` / `spine.partPlan[]` / `parts[]`
 * with the one text under `version(32)`) is the same slice's second half and is
 * blocked — the compile-forced surface is 67 `src/` files (the generation
 * engine, the board, the canvas preview, the PDF planner, export/import, …) plus
 * 147 test files, and `tsconfig.app.json` typechecks `tests/`, so the clean cut
 * cannot land as one writer slice without a half-migrated tree. Nothing here
 * reads or writes storage: it is pure.
 */

/**
 * The separator's two halves — the ONLY place the format's spelling lives, so
 * the formatter below and every message derived from it cannot drift.
 */
const LEVEL_SEPARATOR_PREFIX = '=====Level ';
const LEVEL_SEPARATOR_SUFFIX = '=====';

/** The PREMISE's level number — the one level with no separator of its own. */
export const MODULE_PREMISE_LEVEL = 0;

/** How long a quoted offending line may be before the error message elides it. */
const QUOTED_LINE_CAP = 80;

/**
 * The canonical separator line introducing level `level`: `=====Level N=====`
 * (exactly five `=`, the word `Level`, one space, the number, five `=`).
 *
 * LOUD on a non-separated level (a caller bug must never produce a line the
 * parser would then reject — the formatter and the parser are one contract), and
 * level 0 has no separator: the premise is whatever precedes level 1.
 */
export function moduleLevelSeparator(level: number): string {
  if (!Number.isInteger(level) || level < 1) {
    throw new Error(
      `a level separator names a positive whole level number — got ${String(level)}${
        level === MODULE_PREMISE_LEVEL
          ? ` (level ${MODULE_PREMISE_LEVEL} is the premise and has no separator)`
          : ''
      }`,
    );
  }
  return `${LEVEL_SEPARATOR_PREFIX}${String(level)}${LEVEL_SEPARATOR_SUFFIX}`;
}

/**
 * A malformed module document — the split refuses loudly (AGENTS rule 1). The
 * message NAMES THE LINE (its 1-based number and its quoted text); `name` is
 * stable for callers that branch on the failure class, exactly like
 * `ModulePartsDocumentError` beside it.
 */
export class ModuleDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModuleDocumentError';
  }
}

/**
 * One level of the document. `textFrom`/`textTo` are the level's TEXT range in
 * whole-document coordinates — the separator line and the blank scaffolding
 * around the prose are OUTSIDE the range, in both directions — which is what a
 * level-addressed edit and a block proposal rewrite without re-scanning.
 *
 * Level `MODULE_PREMISE_LEVEL` (0) is the premise: its range starts at offset 0
 * and ends at the last character before the blank scaffolding ahead of level 1.
 */
export interface ModuleDocumentLevel {
  /** Level identity: 0 is the premise, 1..N are the separator sections. */
  number: number;
  /** The section's prose, exactly as written, without the scaffolding blanks. */
  text: string;
  textFrom: number;
  textTo: number;
}

/**
 * A parsed module document: the SOURCE text every range below indexes into, and
 * its levels, level 0 (the premise) FIRST.
 *
 * The source is carried so a level-addressed edit is self-contained: a range
 * without its text cannot be spliced, and making the caller keep the two side by
 * side is how they drift. `replaceLevelText`/`appendLevelText` take THIS parsed
 * value and return the edited text plus its own parse, so a batch of edits never
 * re-reads the document to find its levels again.
 */
export interface ModuleDocument {
  /** The exact text this document was parsed from — the ranges' coordinate space. */
  text: string;
  /**
   * The document's levels in order, level 0 first: `levels[i].number === i`. A
   * document always has at least level 0; a document with no separators has
   * exactly level 0.
   */
  levels: ModuleDocumentLevel[];
}

export interface AssembleModuleDocumentInput {
  /**
   * The document's levels in order, numbered 0..N with no gaps. Level 0 is the
   * premise and writes NO separator; every level from 1 writes its canonical
   * separator line.
   */
  levels: readonly { number: number; text: string }[];
}

/** One line of the document with its whole-document offsets (newline excluded). */
interface DocumentLine {
  content: string;
  start: number;
  end: number;
}

/**
 * Splits `doc` into lines WITH their offsets. The final line after a trailing
 * newline is kept (it is the empty text after it), so a text range can address
 * the document's tail without a special case.
 */
function documentLines(doc: string): DocumentLine[] {
  const lines: DocumentLine[] = [];
  let start = 0;
  for (;;) {
    const newline = doc.indexOf('\n', start);
    const end = newline === -1 ? doc.length : newline;
    lines.push({ content: doc.slice(start, end), start, end });
    if (newline === -1) return lines;
    start = newline + 1;
  }
}

/** `<level>` written as a bare positive integer with NO leading zero. */
function isLevelNumberText(digits: string): boolean {
  if (digits === '') return false;
  if (digits.startsWith('0')) return false;
  for (const char of digits) {
    if (char < '0' || char > '9') return false;
  }
  return true;
}

/**
 * The level number of a CANONICAL separator line, or null when the line is not
 * one. `candidate` must already have had its tolerated trailing whitespace and
 * `\r` removed — the closed tolerance of docs/23 §3, and nothing more.
 */
function canonicalLevelOf(candidate: string): number | null {
  if (candidate.length <= LEVEL_SEPARATOR_PREFIX.length + LEVEL_SEPARATOR_SUFFIX.length) {
    return null;
  }
  if (!candidate.startsWith(LEVEL_SEPARATOR_PREFIX)) return null;
  if (!candidate.endsWith(LEVEL_SEPARATOR_SUFFIX)) return null;
  const digits = candidate.slice(
    LEVEL_SEPARATOR_PREFIX.length,
    candidate.length - LEVEL_SEPARATOR_SUFFIX.length,
  );
  if (!isLevelNumberText(digits)) return null;
  return Number(digits);
}

/**
 * Whether a line LOOKS like a level header without being canonical — the
 * near-miss probe. Deliberately over-inclusive (any `=`-leading line that
 * mentions a level), because a false positive is a loud, correctable message
 * while a false negative is a level silently merged into the one above.
 */
function looksLikeALevelHeader(trimmed: string): boolean {
  return trimmed.startsWith('=') && trimmed.toLowerCase().includes('level');
}

/**
 * The quoted offending line at `from` in `doc` — the ONE line-describer both
 * document formats use for a refusal (the legacy `==========` parts parser
 * imports it too), so a malformed read names its line the same way whoever reads
 * it, and a change to the phrasing cannot drift between the two.
 */
export function describeDocumentLine(doc: string, from: number): string {
  const newline = doc.indexOf('\n', from);
  const line = doc.slice(from, newline === -1 ? doc.length : newline);
  const capped = line.length > QUOTED_LINE_CAP ? `${line.slice(0, QUOTED_LINE_CAP)}…` : line;
  return JSON.stringify(capped);
}

/** `line 7: "…" — …` — every refusal names the line it is about. */
function lineRef(lineIndex: number, doc: string, from: number): string {
  return `line ${lineIndex + 1}: ${describeDocumentLine(doc, from)}`;
}

/** The levels as a readable list, for a refusal that has to say what exists. */
function describeLevelNumbers(levels: readonly ModuleDocumentLevel[]): string {
  if (levels.length === 0) return 'no levels at all';
  return `levels ${levels.map((level) => String(level.number)).join(', ')}`;
}

/**
 * Builds the module document from its levels (PURE — the formatter half of the
 * pair). Level 0 writes NO separator; levels 1..N each write theirs. Refuses a
 * missing level 0 or an out-of-order list loudly rather than sorting it: a
 * caller that hands over levels 0, 2 is a caller bug, and a silent sort would
 * write a document its own parser then reads as a different story (AGENTS
 * rule 1).
 */
export function assembleModuleDocument(input: AssembleModuleDocumentInput): string {
  const first = input.levels[0];
  if (first === undefined) {
    throw new Error(
      `assembleModuleDocument needs at least level ${MODULE_PREMISE_LEVEL} (the premise) — a document is level ${MODULE_PREMISE_LEVEL} followed by its level sections`,
    );
  }
  for (const [index, level] of input.levels.entries()) {
    if (level.number !== index) {
      throw new Error(
        `assembleModuleDocument needs levels numbered 0..n in order — position ${index} carries level ${String(level.number)}; the document format never skips or reorders a level`,
      );
    }
  }
  const pieces: string[] = [];
  for (const level of input.levels) {
    const body = level.text.trimEnd();
    // Level 0 is written BEFORE the first separator, so its text is the head of
    // the document and is only omitted when it is empty and a separator follows.
    if (level.number === MODULE_PREMISE_LEVEL) {
      if (body !== '' || input.levels.length === 1) pieces.push(body);
      continue;
    }
    pieces.push(`${moduleLevelSeparator(level.number)}\n${body}`.trimEnd());
  }
  return pieces.join('\n\n');
}

/**
 * Splits a module document into its levels (PURE — the inverse of
 * `assembleModuleDocument`). Level 0 is the premise: everything before the first
 * separator line, its range excluding the blank scaffolding ahead of level 1.
 * Each level's text range excludes the separator line and the scaffolding in both
 * directions.
 *
 * FAILS LOUDLY with a `ModuleDocumentError` naming the line when the document
 * cannot be read (see the module header for the full list of arms). It NEVER
 * repairs, renumbers or merges.
 */
export function splitModuleDocument(doc: string): ModuleDocument {
  const lines = documentLines(doc);
  const separators: { lineIndex: number; number: number }[] = [];
  for (const [lineIndex, line] of lines.entries()) {
    const withoutCarriageReturn = line.content.endsWith('\r')
      ? line.content.slice(0, -1)
      : line.content;
    // The CLOSED tolerance: the line's own trailing whitespace and its own `\r`.
    const candidate = withoutCarriageReturn.replace(/[ \t]+$/, '');
    const level = canonicalLevelOf(candidate);
    if (level === null) {
      if (looksLikeALevelHeader(withoutCarriageReturn.trim())) {
        throw new ModuleDocumentError(
          `${lineRef(lineIndex, doc, line.start)} looks like a level header but is not the canonical separator — a level section is introduced by a line reading exactly ${moduleLevelSeparator(1)} (five "=", the word "Level", the number, five "="). A near miss is an ERROR here, never a silent merge into the level above`,
        );
      }
      continue;
    }
    const expected = separators.length + 1;
    if (level < expected) {
      const firstUse = separators.find((separator) => separator.number === level);
      throw new ModuleDocumentError(
        `${lineRef(lineIndex, doc, line.start)} — level ${level} is used a second time${
          firstUse === undefined ? '' : ` (first at line ${firstUse.lineIndex + 1})`
        }; a level number appears exactly once`,
      );
    }
    if (level > expected) {
      throw new ModuleDocumentError(
        `${lineRef(lineIndex, doc, line.start)} — level ${level} skips or reorders the level sequence (level ${expected} is missing); the level sections ascend from 1, one at a time`,
      );
    }
    separators.push({ lineIndex, number: level });
  }

  // Level 0: the premise. Everything before the first separator line, with the
  // blank scaffolding ahead of that line left OUT of the range.
  const firstSeparator = separators[0];
  const premiseEnd =
    firstSeparator === undefined
      ? doc.length
      : (lines[firstSeparator.lineIndex]?.start ?? doc.length);
  const premise = doc.slice(0, premiseEnd).trimEnd();
  const levels: ModuleDocumentLevel[] = [
    { number: MODULE_PREMISE_LEVEL, text: premise, textFrom: 0, textTo: premise.length },
  ];

  for (const [index, separator] of separators.entries()) {
    const nextSeparator = separators[index + 1];
    const separatorEnd = lines[separator.lineIndex]?.end ?? doc.length;
    const textStart = Math.min(separatorEnd + 1, doc.length);
    const textEnd =
      nextSeparator === undefined
        ? doc.length
        : (lines[nextSeparator.lineIndex]?.start ?? doc.length);
    const raw = doc.slice(textStart, textEnd);
    const text = raw.trim();
    // An EMPTY level's collapsed range sits at the start of its text area —
    // immediately after its own separator line — so a level-addressed edit lands
    // there as the section's first line and the blank scaffolding around it stays
    // scaffolding. (Trimming the leading whitespace instead would point the range
    // at the NEXT separator line, and a replacement would be spliced onto it with
    // no newline between them — the defect the empty-level pin watches for.)
    const leading = text === '' ? 0 : raw.length - raw.trimStart().length;
    const textFrom = textStart + leading;
    levels.push({ number: separator.number, text, textFrom, textTo: textFrom + text.length });
  }

  return { text: doc, levels };
}

/**
 * The result of ONE level-addressed edit: the whole document text to store, and
 * that SAME text parsed once here — the caller's fresh ranges. A batch of edits
 * therefore walks the levels it just edited without re-reading the document.
 */
export interface ModuleDocumentEdit {
  document: string;
  parsed: ModuleDocument;
}

/** The level `level` of a parsed document, or a LOUD refusal naming what it has. */
function requireLevel(document: ModuleDocument, level: number): ModuleDocumentLevel {
  const found = document.levels.find((entry) => entry.number === level);
  if (found === undefined) {
    throw new ModuleDocumentError(
      `the document carries ${describeLevelNumbers(document.levels)}, so there is no level ${level} to edit — a level-addressed edit names a level the document has (level ${MODULE_PREMISE_LEVEL} is the premise)`,
    );
  }
  return found;
}

/** Parses an edited text so the edit's own result is verified, never assumed. */
function parsedEdit(text: string): ModuleDocumentEdit {
  return { document: text, parsed: splitModuleDocument(text) };
}

/**
 * ONE level's content replaced by `text` (PURE, docs/23 §4): a splice over the
 * range the parse already produced, so nothing is re-scanned, and every byte
 * BEFORE that range — the levels above it, the scaffolding, the premise — is
 * untouched. Level 0 is the premise, so `replaceLevelText(document, 0, text)`
 * replaces the premise through the SAME path as any other level.
 *
 * `text` is stored the way a level body is stored (trimmed; the blank scaffolding
 * around it belongs to the separators), and the scaffolding AFTER it is re-written
 * to the app's own canonical blank line, so a replace cannot leave a separator
 * glued to the prose above it.
 *
 * The RESULT is parsed before it is returned: a body that would break the format
 * (a separator-shaped line the model wrote into the prose) is refused HERE,
 * LOUDLY and by line, rather than landing a document the next read cannot parse.
 * A level the document does not carry is refused rather than created — creating
 * is `appendLevelText`'s job, and silently creating one would hide a caller bug.
 */
export function replaceLevelText(
  document: ModuleDocument,
  level: number,
  text: string,
): ModuleDocumentEdit {
  const target = requireLevel(document, level);
  const body = text.trim();
  const before = document.text.slice(0, target.textFrom);
  const rest = document.text.slice(target.textTo).trim();
  return parsedEdit(rest === '' ? `${before}${body}` : `${before}${body}\n\n${rest}`);
}

/**
 * `text` APPENDED to level `level`'s content (PURE): a paragraph break when the
 * level already has prose, the text alone when it is empty. Level 0 is the
 * premise, so this extends the premise through the SAME path.
 *
 * When the document does not carry `level` yet, the APP writes the next level:
 * the canonical separator with the number comes from `moduleLevelSeparator` and
 * the section is appended after the last one. The next number is `max + 1` over
 * the levels the document HAS — and because level 0 (the premise) always exists,
 * `max` is 0 on a document with no level sections, so the first append creates
 * level 1. Only that NEXT number is accepted: a document with a gap is unreadable
 * by this seam's own parser, so skipping a number is refused loudly instead of
 * writing something the app cannot read back.
 *
 * The document's own bytes are preserved, with the trailing whitespace before
 * the appended section normalized to one blank line; like `replaceLevelText`,
 * the result is parsed before it is returned.
 */
export function appendLevelText(
  document: ModuleDocument,
  level: number,
  text: string,
): ModuleDocumentEdit {
  const added = text.trim();
  const existing = document.levels.find((entry) => entry.number === level);
  if (existing !== undefined) {
    const joined =
      existing.text === '' ? added : added === '' ? existing.text : `${existing.text}\n\n${added}`;
    return replaceLevelText(document, level, joined);
  }
  const last = document.levels[document.levels.length - 1];
  const nextNumber = (last?.number ?? MODULE_PREMISE_LEVEL) + 1;
  if (level !== nextNumber) {
    throw new ModuleDocumentError(
      `the document carries no level ${level}, and ${nextNumber} is the next level it can take — a level is appended one number after the last, because a gap makes the document unreadable`,
    );
  }
  const separator = moduleLevelSeparator(level);
  const section = added === '' ? separator : `${separator}\n${added}`;
  const head = document.text.trimEnd();
  return parsedEdit(head === '' ? section : `${head}\n\n${section}`);
}

/** One wiki-linked name a level mentions, with the kind the module recorded. */
export interface ModuleLevelName {
  /** The name as the document's `[[wiki-link]]` spells it. */
  name: string;
  /** The module's recorded kind for it, or `null` when it recorded none. */
  kind: EntityKind | null;
}

/** One derived level: its identity, its text range and the names it mentions. */
export interface ModuleLevelRecord extends ModuleDocumentLevel {
  names: ModuleLevelName[];
}

/** The DERIVED level list of a module document (docs/23 §4). */
export interface ModuleLevelList {
  /** Level 0 first (the premise), then the level sections in order. */
  levels: ModuleLevelRecord[];
  /**
   * The lowest level number the document carries. It is `0` for EVERY document,
   * because level 0 (the premise) always exists — kept beside `levelMax` because
   * a level RANGE is always read as a pair, and because a document that is level
   * 0 only is exactly the "starts with nothing" state.
   */
  levelMin: number;
  /**
   * The highest level number: the number of the last level SECTION, or `0` when
   * the document has no separators yet (level 0 only).
   */
  levelMax: number;
}

/**
 * Derives the module's level list from its ONE text (docs/23 §4): per level —
 * LEVEL 0 (the premise) INCLUDED — its number, its text range and the
 * wiki-linked names it mentions by kind, plus `levelMin`/`levelMax`. Nothing here
 * is stored; this is the whole reason the level list is not a field, and the
 * generation dialog (phase 4) is its consumer.
 *
 * The names come from the app's ONE wiki-link extractor (`lib/wikilinks`, which
 * already dedupes through the comparable-name form) and the kinds from the
 * module's ONE recorded-kind read (`domain/module.entityKindFor`); a name the
 * module recorded no kind for keeps `kind: null` — it is reported as unnamed
 * rather than dropped or guessed (AGENTS rule 1).
 *
 * Level scope falls straight out of the text: a name wikilinked inside
 * `=====Level 3=====` IS a level-3 mention, so "levels 1–3" is the names of
 * sections 1, 2 and 3 — which excludes level 0 (the premise) by construction,
 * because the range starts at 1.
 */
export function moduleLevelList(
  doc: string,
  entityKinds: readonly ModuleEntityKind[],
): ModuleLevelList {
  const document = splitModuleDocument(doc);
  const levels: ModuleLevelRecord[] = document.levels.map((level) => ({
    ...level,
    names: extractWikiLinks(level.text).map((link) => ({
      name: link.name,
      kind: entityKindFor(entityKinds, link.name) ?? null,
    })),
  }));
  const first = levels[0];
  const last = levels[levels.length - 1];
  return {
    levels,
    levelMin: first?.number ?? MODULE_PREMISE_LEVEL,
    levelMax: last?.number ?? MODULE_PREMISE_LEVEL,
  };
}
