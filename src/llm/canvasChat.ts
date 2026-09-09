import { z } from 'zod';

import type { Id } from '@/domain';
import { getModule } from '@/db/moduleRepo';
import { getSettings } from '@/db/settingsRepo';
import { chat, type ChatMessage } from '@/llm/openrouter';
import { ModuleBusyError } from '@/llm/moduleGen';
import { claimModuleGeneration, releaseModuleGeneration } from '@/llm/canvasBusy';

/**
 * Canvas CHAT contract (08-MODULE-DESIGNER §Module canvas chat): LLM
 * co-authoring of ONE module part through a chat sidebar. The assistant
 * replies with prose plus ZERO OR MORE XML edit commands:
 *
 *   <edit all="false"><search>…current text…</search><replace>…new text…</replace></edit>
 *
 * Design lineage (docs/17 ledger row 50):
 * - AIDER's SEARCH/REPLACE edit format + flexible-match ladder
 *   (aider/coders/editblock_coder.py — perfect match, then leniency;
 *   a failed match is NEVER auto-fuzzed, it FAILS with the closest real
 *   snippet fed back to the model: "Did you mean to match some of these
 *   actual lines?").
 * - OPEN CANVAS (langchain-ai) split: chat steers, the document is the
 *   truth — every request re-grounds on the CURRENT document.
 * - CLINE/ROO `replace_in_file` lessons: strict-only matching turns trivial
 *   whitespace drift into failed diffs and models then fall back to whole-
 *   file rewrites — so the leniency lives IN the matcher ladder, and a
 *   failed diff must never silently degrade into a full rewrite.
 * - XML over JSON for the command shape: prose + nested multi-line bodies
 *   need no escape dance; JSON forces newline/quote escaping exactly where
 *   long prose replacements err. This is the deliberate deviation from
 *   canvasRefine's strict-JSON-schema reply (a prose+XML reply is not a
 *   JSON shape) — owner-directed, recorded in the ledger.
 *
 * Contract rules (binding, AGENTS 1/3):
 * - The reply is parsed by a STRICT extractor (balanced blocks, no
 *   regex-guessing across boundaries) and zod-validated at this boundary —
 *   a malformed, unbalanced or over-cap reply THROWS `CanvasChatParseError`
 *   (the whole reply fails loudly; nothing partial is applied).
 * - The context ALWAYS carries the CURRENT document text — read from the
 *   CM6 doc at send time, never a cached copy — with an explicit note that
 *   it already contains every previously applied edit.
 * - ONE generation per module — the SHARED `canvasBusy` registry (refine +
 *   chat serialize); `ModuleBusyError` is loud, never queued.
 * - Model: the canvas selection (session-only) defaulting to the Settings
 *   `defaultChatModel`; the Settings gates ride the transport (escalation
 *   chain, language directive, reasoning effort) exactly like canvasRefine.
 * - Stop/cancel supported through `signal` (a user abort is not an error).
 */

/** The zod boundary for one edit command. */
export const canvasEditCommandSchema = z.object({
  search: z.string(),
  replace: z.string(),
  all: z.boolean(),
});

export type CanvasEditCommand = z.infer<typeof canvasEditCommandSchema>;

/** Loud cap: more commands than this in one reply fails the whole reply. */
export const MAX_COMMANDS_PER_REPLY = 40;

/** Conversation tail cap: at most this many messages ride one request. */
export const MAX_CONTEXT_MESSAGES = 12;

/** Window (chars) of current-text context around a failure point. */
export const FAILURE_EXCERPT_RADIUS = 300;

/** A malformed, unbalanced or over-cap reply — the whole reply fails. */
export class CanvasChatParseError extends Error {
  /** The offending reply tail (for the error card + report-to-LLM turn). */
  readonly excerpt: string;

  constructor(message: string, excerpt: string) {
    super(message);
    this.name = 'CanvasChatParseError';
    this.excerpt = excerpt;
  }
}

export interface ParsedCanvasChatReply {
  /** Prose between/around the command blocks (may be ''). */
  prose: string;
  commands: CanvasEditCommand[];
}

interface EditTagAttributes {
  all: boolean;
}

// --- strict extractor ---------------------------------------------------------

function isTagBoundaryChar(char: string | undefined): boolean {
  return char === undefined || char === '>' || /\s/.test(char);
}

/**
 * Parses the tag-body attributes of `<edit …>` (the text after the tag
 * name up to and including the closing `>`). Strict: only the known
 * attribute `all="true|false"`; anything else fails.
 */
function parseEditAttributes(body: string): EditTagAttributes {
  const trimmed = body.trim();
  if (trimmed === '') return { all: false };
  let cursor = 0;
  const attrs: EditTagAttributes = { all: false };
  while (cursor < trimmed.length) {
    while (cursor < trimmed.length && /\s/.test(trimmed[cursor] ?? '')) cursor += 1;
    if (cursor >= trimmed.length) break;
    const nameStart = cursor;
    while (cursor < trimmed.length && /[a-zA-Z]/.test(trimmed[cursor] ?? '')) cursor += 1;
    const name = trimmed.slice(nameStart, cursor);
    while (cursor < trimmed.length && /\s/.test(trimmed[cursor] ?? '')) cursor += 1;
    if (trimmed[cursor] !== '=') {
      throw new CanvasChatParseError(`malformed attribute in <edit> tag: "${trimmed.slice(nameStart, cursor + 1)}"`, trimmed);
    }
    cursor += 1;
    while (cursor < trimmed.length && /\s/.test(trimmed[cursor] ?? '')) cursor += 1;
    const quote = trimmed[cursor];
    if (quote !== '"' && quote !== "'") {
      throw new CanvasChatParseError('attribute values must be quoted in <edit> tags', trimmed);
    }
    cursor += 1;
    const valueStart = cursor;
    while (cursor < trimmed.length && trimmed[cursor] !== quote) cursor += 1;
    if (cursor >= trimmed.length) {
      throw new CanvasChatParseError('unterminated attribute value in <edit> tag', trimmed);
    }
    const value = trimmed.slice(valueStart, cursor);
    cursor += 1; // past the closing quote
    if (name === 'all') {
      if (value !== 'true' && value !== 'false') {
        throw new CanvasChatParseError(`all must be "true" or "false", got "${value}"`, trimmed);
      }
      attrs.all = value === 'true';
    } else {
      throw new CanvasChatParseError(`unknown attribute "${name}" in <edit> tag`, trimmed);
    }
  }
  return attrs;
}

/**
 * Scans raw text starting at `start` for `</tag>` and returns
 * `{ content, next }` (next = index after the closing tag). The content is
 * VERBATIM — no entity decoding (the prompt instructs raw bytes; decoding
 * `&amp;` would corrupt search text that legitimately contains it).
 */
function scanUntilClose(text: string, start: number, tag: string): { content: string; next: number } {
  const close = `</${tag}>`;
  const at = text.indexOf(close, start);
  if (at === -1) {
    throw new CanvasChatParseError(`unbalanced <${tag}> block — missing </${tag}>`, text.slice(Math.max(0, start - 120)));
  }
  return { content: text.slice(start, at), next: at + close.length };
}

function expectLiteral(text: string, at: number, literal: string, excerpt: string): void {
  if (!text.startsWith(literal, at)) {
    throw new CanvasChatParseError(`expected <${literal.slice(1, -1)}> inside <edit> block`, excerpt);
  }
}

/**
 * Parses ONE assistant reply into prose + zod-validated commands. Strict
 * (AGENTS 3): a stray closing tag, an unterminated block, a missing
 * `<search>`/`<replace>`, unexpected content inside a block, an unknown
 * attribute, or more than `MAX_COMMANDS_PER_REPLY` commands throws
 * `CanvasChatParseError` — the whole reply is failed, never partially
 * applied.
 */
export function parseCanvasChatReply(raw: string): ParsedCanvasChatReply {
  const commands: CanvasEditCommand[] = [];
  const proseParts: string[] = [];
  let cursor = 0;
  while (cursor < raw.length) {
    const open = raw.indexOf('<edit', cursor);
    if (open === -1) {
      const tail = raw.slice(cursor);
      if (tail.includes('</edit>')) {
        throw new CanvasChatParseError('stray </edit> outside a command block', tail.slice(0, 200));
      }
      proseParts.push(tail);
      break;
    }
    proseParts.push(raw.slice(cursor, open));
    // Word-boundary check: "<edit" must not be the prefix of another tag
    // (e.g. "<editorial") — that is prose, not a command. A self-closing
    // `<edit/>` IS a (malformed) command attempt and fails loud.
    const boundaryChar = raw[open + 5];
    if (boundaryChar === '/' && raw[open + 6] === '>') {
      throw new CanvasChatParseError('<edit> cannot be self-closing — it needs search and replace bodies', raw.slice(open, open + 200));
    }
    if (!isTagBoundaryChar(boundaryChar)) {
      proseParts.push(raw.slice(open, open + 5));
      cursor = open + 5;
      continue;
    }
    // Parse the open tag through its '>'.
    const tagEnd = raw.indexOf('>', open);
    if (tagEnd === -1) {
      throw new CanvasChatParseError('unterminated <edit> tag — no ">" before end of reply', raw.slice(open));
    }
    const selfClosing = raw[tagEnd - 1] === '/';
    if (selfClosing) {
      throw new CanvasChatParseError('<edit> cannot be self-closing — it needs search and replace bodies', raw.slice(open));
    }
    const attrs = parseEditAttributes(raw.slice(open + 5, tagEnd));
    let at = tagEnd + 1;
    const excerpt = raw.slice(open, Math.min(raw.length, open + 400));
    // Optional whitespace, then exactly <search>…</search>.
    while (at < raw.length && /\s/.test(raw[at] ?? '')) at += 1;
    expectLiteral(raw, at, '<search>', excerpt);
    const search = scanUntilClose(raw, at + '<search>'.length, 'search');
    at = search.next;
    while (at < raw.length && /\s/.test(raw[at] ?? '')) at += 1;
    expectLiteral(raw, at, '<replace>', excerpt);
    const replace = scanUntilClose(raw, at + '<replace>'.length, 'replace');
    at = replace.next;
    while (at < raw.length && /\s/.test(raw[at] ?? '')) at += 1;
    if (!raw.startsWith('</edit>', at)) {
      throw new CanvasChatParseError('expected </edit> to close the command block', excerpt);
    }
    cursor = at + '</edit>'.length;
    commands.push(canvasEditCommandSchema.parse({
      search: search.content,
      replace: replace.content,
      all: attrs.all,
    }));
    if (commands.length > MAX_COMMANDS_PER_REPLY) {
      throw new CanvasChatParseError(
        `reply carries more than ${String(MAX_COMMANDS_PER_REPLY)} edit commands — split the work across replies`,
        raw.slice(Math.max(0, raw.length - 200)),
      );
    }
  }
  return {
    prose: proseParts.join('').trim(),
    commands,
  };
}

/**
 * BEST-EFFORT display splitter for STREAMING (never throws, never applies):
 * complete command blocks are hidden from the growing bubble (their outcome
 * cards render after the reply settles); a still-open trailing block shows
 * as nothing but flips `composing`. Display only — the settled reply is
 * always re-parsed strictly.
 */
export function chatProseSoFar(raw: string): { prose: string; composing: boolean } {
  const open = raw.indexOf('<edit');
  if (open === -1) return { prose: raw, composing: false };
  const close = raw.indexOf('</edit>', open);
  if (close === -1) return { prose: raw.slice(0, open).trimEnd(), composing: true };
  // Skip past EVERY complete block (loop on the remainder).
  const rest = chatProseSoFar(raw.slice(close + '</edit>'.length));
  return { prose: `${raw.slice(0, open).trimEnd()}${rest.prose}`.trim(), composing: rest.composing };
}

// --- tolerant match ladder -------------------------------------------------------

export type CanvasEditResolution =
  | {
      status: 'found';
      /** Non-overlapping match ranges in ORIGINAL doc coordinates, left to right. */
      ranges: { from: number; to: number }[];
    }
  | {
      status: 'none';
      /** The closest candidate snippet from the CURRENT doc (may be ''). */
      closest: string;
      /** Its start offset (null when the doc has no comparable text). */
      closestFrom: number | null;
    };

/** Length-preserving per-char lowercase (index-safe folding). */
function foldLower(text: string): string {
  let out = '';
  for (const char of text) {
    const lower = char.toLowerCase();
    out += lower.length === 1 ? lower : char;
  }
  return out;
}

/**
 * Whitespace-collapse projection: every run of whitespace becomes one
 * space. Returns the normalized string plus, per normalized character, the
 * [from, to) span it covers in the ORIGINAL text, so a normalized match
 * maps back onto exact original offsets.
 */
function projectWhitespace(text: string): {
  normalized: string;
  spans: { from: number; to: number }[];
} {
  let normalized = '';
  const spans: { from: number; to: number }[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const char = text[cursor] ?? '';
    if (/\s/.test(char)) {
      let runEnd = cursor;
      while (runEnd < text.length && /\s/.test(text[runEnd] ?? '')) runEnd += 1;
      normalized += ' ';
      spans.push({ from: cursor, to: runEnd });
      cursor = runEnd;
      continue;
    }
    normalized += char;
    spans.push({ from: cursor, to: cursor + 1 });
    cursor += 1;
  }
  return { normalized, spans };
}

/** All non-overlapping occurrences of `needle` in `haystack`, left to right. */
function allOccurrences(haystack: string, needle: string): number[] {
  const at: number[] = [];
  if (needle === '') return at;
  let cursor = 0;
  for (;;) {
    const found = haystack.indexOf(needle, cursor);
    if (found === -1) break;
    at.push(found);
    cursor = found + needle.length;
  }
  return at;
}

/**
 * Character-bigram Dice similarity (0..1) — the pure, dependency-free
 * stand-in for aider's `SequenceMatcher`-based `find_similar_lines`. Only
 * used to POINT at the closest candidate on a zero-match failure (never to
 * auto-apply — that would be aider's dead fuzzy branch).
 */
function bigramSimilarity(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const bigrams = (text: string): Map<string, number> => {
    const counts = new Map<string, number>();
    for (let index = 0; index < text.length - 1; index += 1) {
      const gram = text.slice(index, index + 2);
      counts.set(gram, (counts.get(gram) ?? 0) + 1);
    }
    return counts;
  };
  const left = bigrams(a);
  const right = bigrams(b);
  let overlap = 0;
  for (const [gram, count] of left) {
    overlap += Math.min(count, right.get(gram) ?? 0);
  }
  return (2 * overlap) / (a.length - 1 + b.length - 1);
}

/** Start offset of every line (line 0 starts at 0). */
function lineStarts(doc: string): number[] {
  const starts = [0];
  for (let index = 0; index < doc.length; index += 1) {
    if (doc[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

/** Renders up to `windowLines` doc lines around an offset as the candidate. */
function candidateSnippet(doc: string, from: number, windowLines: number): string {
  if (doc === '') return '';
  const starts = lineStarts(doc);
  let lineIndex = 0;
  for (let index = 0; index < starts.length; index += 1) {
    if ((starts[index] ?? 0) <= from) lineIndex = index;
    else break;
  }
  const startLine = Math.max(0, lineIndex - 1);
  const endLine = Math.min(starts.length - 1, startLine + windowLines - 1);
  const start = starts[startLine] ?? 0;
  const nextLine = starts[endLine + 1];
  const end = nextLine === undefined ? doc.length : Math.max(start, nextLine - 1);
  return doc.slice(start, end);
}

/**
 * The tolerant match ladder (pure; 08 §Module canvas chat): resolve
 * `search` against the CURRENT doc.
 *  1. exact bytes,
 *  2. case-insensitive (index-safe fold),
 *  3. whitespace/collapse-normalized (runs of whitespace ≡ one space).
 * The FIRST level with ≥1 hit wins. NOTE: the canvas editor has no prior
 * fuzzy text matcher to reuse (wiki chips + suggestions are range-based),
 * so this ladder IS the matcher; curly/straight quote folding is
 * deliberately NOT included in v1 (no existing convention to inherit —
 * documented deviation).
 *
 * Multiple matches come back as multiple ranges: the caller applies them
 * ONLY when the command is `all`, otherwise the command fails loudly.
 * Zero matches returns the closest candidate snippet (aider's
 * find_similar_lines reporting role) to guide the retry — never an
 * auto-application.
 */
export function resolveCanvasEdit(doc: string, search: string): CanvasEditResolution {
  if (search === '') {
    return { status: 'none', closest: '', closestFrom: null };
  }
  // 1. Exact.
  let at = allOccurrences(doc, search);
  if (at.length > 0) {
    return {
      status: 'found',
      ranges: at.map((from) => ({ from, to: from + search.length })),
    };
  }
  // 2. Case-insensitive (length-preserving fold keeps offsets aligned).
  const foldedDoc = foldLower(doc);
  at = allOccurrences(foldedDoc, foldLower(search));
  if (at.length > 0) {
    return {
      status: 'found',
      ranges: at.map((from) => ({ from, to: from + search.length })),
    };
  }
  // 3. Whitespace-collapsed (projection maps normalized offsets back).
  const docProjection = projectWhitespace(doc);
  const searchProjection = projectWhitespace(search);
  at = allOccurrences(docProjection.normalized, searchProjection.normalized);
  if (at.length > 0) {
    return {
      status: 'found',
      ranges: at.map((normFrom) => {
        const firstSpan = docProjection.spans[normFrom];
        const lastSpan = docProjection.spans[normFrom + searchProjection.normalized.length - 1];
        return {
          from: firstSpan?.from ?? 0,
          to: lastSpan?.to ?? 0,
        };
      }),
    };
  }
  // Zero matches: locate the closest candidate (whitespace-normalized
  // line-window scan, aider's find_similar_lines role) — reporting only.
  const needle = searchProjection.normalized.trim();
  if (needle === '' || doc === '') {
    return { status: 'none', closest: doc === '' ? '' : candidateSnippet(doc, 0, 3), closestFrom: doc === '' ? null : 0 };
  }
  const starts = lineStarts(doc);
  const lines = doc.split('\n');
  const needleLineCount = Math.max(1, search.split('\n').length);
  let bestRatio = 0;
  let bestOffset: number | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const window = lines.slice(index, index + needleLineCount).join('\n');
    const ratio = bigramSimilarity(projectWhitespace(window).normalized, needle);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      bestOffset = starts[index] ?? null;
    }
  }
  if (bestOffset === null) {
    return { status: 'none', closest: candidateSnippet(doc, 0, 3), closestFrom: 0 };
  }
  return {
    status: 'none',
    closest: candidateSnippet(doc, bestOffset, 3),
    closestFrom: bestOffset,
  };
}

// --- context contract -------------------------------------------------------------

const WIKI_TOKEN_RULES =
  '- Wiki-links are [[Name]] tokens (names, never IDs). Keep every token\'s EXACT canonical spelling when the instruction does not rename the entity; never inflect inside the token — write [[Halmund]]\'s tower, not [[Halmunds]] Haus; write [[Name|display]] when the surface text must differ from the canonical name. The same rules apply in any language.';

/**
 * The fixed system prompt (08 §Module canvas chat): the XML protocol, the
 * doc-is-current contract, replace-all guidance, small-edit preference.
 */
export function canvasChatSystemPrompt(): string {
  return [
    'You are the Canvas chat co-editor for tabletop RPG modules — an expert editor of GM-facing markdown prose.',
    'You edit ONE module part by replying with short conversational prose plus ZERO OR MORE XML edit commands:',
    '<edit all="false"><search>the exact current text</search><replace>the new text</replace></edit>',
    'Command rules:',
    '- "search" must match the CURRENT document (below / in the latest message) EXACTLY, byte for byte, including whitespace, punctuation and line breaks. Copy it verbatim from the document.',
    '- With all="false" (the default) the search must match EXACTLY ONE place; with all="true" every occurrence is replaced (replace-all). Use all="true" whenever repetition is intended (a recurring heading, a name used many times).',
    '- Prefer SMALL, targeted edits over whole-part rewrites: several small commands beat one giant replacement.',
    '- The search text may not be empty and must not contain the literal strings </search> or </edit>.',
    '- Write <search> and <replace> bodies verbatim — no escaping, no markdown code fences around them.',
    'The document you receive is the CURRENT state: it ALREADY CONTAINS every edit applied earlier in this conversation. Never repeat an already-applied edit and never assume the text is still in its older form.',
    WIKI_TOKEN_RULES,
    'Match the language of the document. Prose between commands is shown to the user — keep it brief.',
  ].join('\n');
}

/** The per-turn user content: the CURRENT doc + the instruction. */
export function canvasChatTurnContent(document: string, instruction: string): string {
  return [
    'Module part document — the CURRENT state, including all previously applied edits:',
    '<document>',
    document,
    '</document>',
    '',
    `Instruction: ${instruction}`,
  ].join('\n');
}

/**
 * The failure-report turn (report-to-LLM loop, first-class): the error,
 * the failed command verbatim, and the current text around the failure
 * point. The CURRENT doc rides every request anyway (context contract).
 */
export function composeFailureReport(input: {
  errorText: string;
  command: CanvasEditCommand | null;
  document: string;
  failureFrom: number | null;
}): string {
  const parts: string[] = [
    'Your previous reply could not be applied and the edit was NOT made.',
    `Error: ${input.errorText}`,
  ];
  if (input.command !== null) {
    parts.push(
      'The failed command:',
      `<edit all="${input.command.all ? 'true' : 'false'}"><search>${input.command.search}</search><replace>${input.command.replace}</replace></edit>`,
    );
  }
  if (input.failureFrom !== null && input.document !== '') {
    const from = Math.max(0, input.failureFrom - FAILURE_EXCERPT_RADIUS);
    const to = Math.min(input.document.length, input.failureFrom + FAILURE_EXCERPT_RADIUS);
    parts.push(
      'The current document text around the failure point:',
      '<excerpt>',
      input.document.slice(from, to),
      '</excerpt>',
    );
  }
  parts.push(
    'Re-send the corrected command: copy <search> EXACTLY from the current document (it may differ from what you remember).',
  );
  return parts.join('\n\n');
}

/**
 * Builds the request payload: fixed system prompt + the conversation TAIL
 * (last `MAX_CONTEXT_MESSAGES` messages) + the new turn. History user
 * turns carry their instruction text only — the document block is
 * STRIPPED from older turns (stale snapshots must never ride along; the
 * current doc goes into the final turn only). When the tail was trimmed, a
 * note says so (documented v1 trim policy — a note, not an LLM summary).
 */
export function buildCanvasChatPayload(input: {
  document: string;
  instruction: string;
  history: { role: 'user' | 'assistant'; text: string }[];
}): ChatMessage[] {
  const trimmed = input.history.slice(-MAX_CONTEXT_MESSAGES);
  const omitted = input.history.length - trimmed.length;
  const messages: ChatMessage[] = [{ role: 'system', content: canvasChatSystemPrompt() }];
  if (omitted > 0) {
    messages.push({
      role: 'system',
      content: `[${String(omitted)} earlier message(s) of this conversation were omitted to fit the context — the document below is current.]`,
    });
  }
  for (const entry of trimmed) {
    if (entry.role === 'user') {
      messages.push({
        role: 'user',
        content: entry.text.includes('<document>')
          ? entry.text
          : `[earlier instruction] ${entry.text}`,
      });
    } else {
      messages.push({ role: 'assistant', content: entry.text });
    }
  }
  messages.push({
    role: 'user',
    content: canvasChatTurnContent(input.document, input.instruction),
  });
  return messages;
}

// --- send engine ------------------------------------------------------------------

export interface CanvasChatTurnInput {
  moduleId: Id;
  /** The CURRENT document text, read from the CM6 doc at send time. */
  document: string;
  instruction: string;
  /** Prior conversation (store order, oldest first) — tail-capped here. */
  history: { role: 'user' | 'assistant'; text: string }[];
  /** The canvas model selection; falls back to Settings defaultChatModel. */
  model?: string | undefined;
  signal?: AbortSignal | undefined;
  onDelta?: ((textSoFar: string) => void) | undefined;
}

export interface CanvasChatTurnResult {
  /** The RAW assistant reply (prose + XML blocks), canonical for parsing. */
  raw: string;
  modelUsed: string;
  parse: ParsedCanvasChatReply;
}

/**
 * Sends one chat turn (08 §Module canvas chat). Throws LOUDLY on busy
 * (`ModuleBusyError`, shared registry — chat + refine serialize), a
 * generating module, a vanished module, transport errors, and
 * `CanvasChatParseError` for malformed replies. User aborts throw
 * AbortError (distinguish via `signal.aborted`, 18-ARCHITECTURE).
 */
export async function sendCanvasChatMessage(input: CanvasChatTurnInput): Promise<CanvasChatTurnResult> {
  if (input.signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  const instruction = input.instruction.trim();
  if (instruction === '') {
    throw new Error('canvas chat needs an instruction');
  }
  claimModuleGeneration(input.moduleId);
  try {
    const module = await getModule(input.moduleId);
    if (module === undefined) {
      throw new Error('Module no longer exists');
    }
    if (module.status === 'generating') {
      throw new ModuleBusyError(input.moduleId);
    }
    const settings = await getSettings();
    const messages = buildCanvasChatPayload({
      document: input.document,
      instruction,
      history: input.history,
    });
    const { text: raw, modelUsed } = await chat(messages, {
      model: input.model !== undefined && input.model !== '' ? input.model : settings.defaultChatModel,
      // Same surgical temperature as canvasRefine: prose + targeted edits.
      temperature: 0.4,
      reasoningEffort: settings.defaultReasoningEffort,
      // NO responseFormat: the reply is prose + XML blocks, deliberately
      // not a JSON contract (docs/17 row 50). The strict extractor +
      // zod boundary below are the validation.
      signal: input.signal,
      onToken: (delta) => {
        input.onDelta?.(delta);
      },
    });
    const parse = parseCanvasChatReply(raw);
    return { raw, modelUsed, parse };
  } finally {
    releaseModuleGeneration(input.moduleId);
  }
}
