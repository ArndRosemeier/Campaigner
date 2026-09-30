import { ZodError } from 'zod';

import { errorMessage } from '@/lib/errors';

/**
 * Shared boundary between raw LLM replies and JSON.parse + zod (AGENTS rule 3:
 * LLM/JSON output is parsed with zod). One implementation instead of the
 * hand-rolled `raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)` that was
 * duplicated at every call site — that slice silently corrupts or rejects
 * replies it was never meant to see, because real replies are not always a
 * bare object:
 *
 * - reasoning models that inline `<think>…</think>` (with braces) in `content`,
 * - markdown fences, prose wrappers, trailing footnotes containing `}`,
 * - two JSON objects, array roots, trailing commas (a frequent model slip).
 *
 * Every failure here THROWS a descriptive error — never a fallback, never a
 * guessed value (AGENTS rule 1). Repair is limited to meaning-preserving
 * syntax fixes; content is never rewritten.
 */

/** Strips a BOM and `<think>` blocks (closed, or an unclosed prefix) from a reply. */
export function extractJsonText(raw: string): string {
  return raw
    .replace(/^\uFEFF/, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, '');
}

/**
 * Yields every top-level balanced JSON value region (`{…}` or `[…]`) in the
 * text, left to right — string-aware, so braces inside string values are
 * ignored and each candidate is complete (not the first-{-to-last-} slice
 * that grabbed trailing prose). Candidates that fail to parse are skipped so
 * a stray brace pair in surrounding prose cannot shadow the real reply.
 */
function* balancedCandidates(text: string): Generator<string> {
  let index = 0;
  while (index < text.length) {
    const open = text.slice(index).search(/[{[]/);
    if (open === -1) return;
    const start = index + open;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let cursor = start; cursor < text.length; cursor += 1) {
      const char = text[cursor];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{' || char === '[') depth += 1;
      else if (char === '}' || char === ']') {
        depth -= 1;
        if (depth === 0) {
          yield text.slice(start, cursor + 1);
          index = cursor + 1;
          break;
        }
      }
    }
    if (depth !== 0) return; // unbalanced remainder — nothing more to try
  }
}

/** Old fallback slice (first `{` to last `}`) for unbalanced oddities. */
function firstToLastBrace(text: string): string {
  return text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
}

/**
 * Removes trailing commas before `}` / `]` (outside string values) — the one
 * syntactic slip strict JSON.parse rejects that carries no meaning.
 */
function stripTrailingCommas(json: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < json.length; index += 1) {
    const char = json[index] ?? '';
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === ',') {
      let lookahead = index + 1;
      while (lookahead < json.length && /\s/.test(json[lookahead] ?? '')) lookahead += 1;
      if (json[lookahead] === '}' || json[lookahead] === ']') continue;
    }
    out += char;
  }
  return out;
}

function snippet(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '') return '(empty reply)';
  return trimmed.length <= 160 ? trimmed : `${trimmed.slice(0, 160)}…`;
}

/**
 * Extracts and parses the JSON value of a model reply, tolerating wrapper
 * text, `<think>` blocks, and trailing commas. Throws a descriptive error
 * (including a reply snippet) when nothing parseable is found.
 */
export function parseJsonReply(raw: string): unknown {
  const text = extractJsonText(raw);
  let lastError: unknown;
  let tried = 0;
  for (const candidate of balancedCandidates(text)) {
    tried += 1;
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Plain parse failed: the assigned lastError would be dead (the repair
      // either returns or overwrites it) — only the repair failure is kept.
      try {
        return JSON.parse(stripTrailingCommas(candidate)) as unknown;
      } catch (repairError) {
        lastError = repairError;
      }
    }
    if (tried >= 5) break; // bounded: the reply's first few top-level values
  }
  // Unbalanced (e.g. a truncated reply): fall back to the old slice once so a
  // stray leading brace still parses when the tail is intact.
  const fallback = firstToLastBrace(text);
  if (fallback !== '') {
    try {
      return JSON.parse(fallback) as unknown;
    } catch (error) {
      lastError = error;
    }
  }
  if (tried === 0 && fallback === '') {
    throw new Error(
      `the reply contained no JSON object — reply began: ${snippet(text)}`,
    );
  }
  const reason = errorMessage(lastError);
  throw new Error(`invalid JSON in the reply (${reason}) — reply began: ${snippet(text)}`);
}

/** One human-readable line per zod issue (`path: message`), for prompts and review cards. */
export function formatZodIssues(error: ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path
      .map((part) => (typeof part === 'symbol' ? part.toString() : String(part)))
      .join('.');
    return `${path === '' ? 'reply' : path}: ${issue.message}`;
  });
}

/** A compact reason string for any parse/validation error (retry prompts, run rows). */
export function parseErrorSummary(error: unknown): string {
  if (error instanceof ZodError) return formatZodIssues(error).join('; ');
  return errorMessage(error);
}
