import { z } from 'zod';

import type { Id } from '@/domain';
import { getModule } from '@/db/moduleRepo';
import { getSettings } from '@/db/settingsRepo';
import { chat, type ChatMessage } from '@/llm/openrouter';
import { ModuleBusyError } from '@/llm/moduleGen';
import {
  claimModuleGeneration,
  registerCanvasAbort,
  releaseModuleGeneration,
} from '@/llm/canvasBusy';
import { parseJsonReply } from '@/llm/jsonReply';
import { schemaResponseFormat } from '@/llm/strictSchema';
import { debrisIssuesForFields } from '@/lib/encodingHygiene';

/**
 * Canvas refine contract (08-MODULE-DESIGNER §Module canvas): ONE loud
 * section-rewrite call behind the canvas AI actions — either a SELECTION
 * refine (a replacement for exactly the selected span, grounded with the
 * selection + its enclosing block) or a WHOLE-PART rewrite (the complete
 * replacement for the explicitly picked part).
 *
 * v3 (docs/17 ledger row 53): the editor document is the WHOLE module, and
 * an LLM-triggered action cannot depend on cursor position — the grounding
 * is the EXPLICIT INPUT, never the ambient doc: selection refine grounds on
 * the selected range (plus the block containing its start as context),
 * whole-part rewrite grounds on the picked part's current text. The caller
 * resolves both from the whole-document editor doc; the engine never sees
 * scaffolding or unrelated parts.
 *
 * Contract rules (binding, AGENTS 1/3):
 * - settings model/gates reused — `defaultChatModel` + the default
 *   escalation chain + strict structured outputs + the language directive,
 *   all inside `chat`/`schemaResponseFormat`. No private transport.
 * - the reply is validated by ZOD at this boundary — a validation failure
 *   THROWS, it is never a path to partial application.
 * - the reply runs the encodingHygiene debris scan — a hit rejects LOUDLY
 *   naming the debris (never silent repair, never persistence).
 * - ONE generation per module — a module whose forge is running, or that
 *   already holds a canvas refine OR a canvas chat turn (the SHARED
 *   `canvasBusy` registry — both surfaces serialize), refuses with
 *   `ModuleBusyError`. Surfacing busy is the caller's job (toast); there
 *   is no queue.
 * - stop/cancel supported through `signal` (user aborts are not errors).
 *
 * Streaming: the transport always streams; the reply is a strict JSON
 * object, so raw deltas are not markdown. `ReplacementStreamExtractor`
 * incrementally extracts the `replacement` string value so the SUGGESTION
 * overlay can render content as it arrives — best-effort PREVIEW ONLY (any
 * ambiguity yields nothing); the canonical text is always the settled,
 * validated reply. Overlay updates never touch the document and never enter
 * undo history (see suggestions.ts).
 */

export const canvasRefineReplySchema = z.object({ replacement: z.string() });

export type CanvasRefineScope = 'selection' | 'part';

export interface CanvasRefineInput {
  moduleId: Id;
  scope: CanvasRefineScope;
  /** What to do with the text (non-empty). */
  instruction: string;
  /** scope 'selection': the EXACT selected span (replaced exactly).
   * scope 'part': the picked part's COMPLETE current text (fully
   * rewritten). The grounding is explicit input — never cursor-derived. */
  text: string;
  /** scope 'selection': the block paragraph containing the selection's
   * start (context only — the model must not emit it). */
  enclosingBlock: string;
  /** The caller's per-turn controller. Required: the app-level sweep reaches
   * canvas turns through the `canvasBusy` abort registry, which pairs this
   * controller with the turn's model signal (so a sweep abort also fires the
   * caller's own "the user stopped this" branch). */
  turn?: AbortController | undefined;
  /** Cumulative extracted replacement text so far (overlay streaming). */
  onDelta?: ((textSoFar: string) => void) | undefined;
}

/**
 * The block paragraph containing the selection offsets (pure — the
 * selection triple's middle element): markdown splits on blank lines; the
 * block spanning `from` wins, the last block starting at-or-before `from`
 * is the fallback for boundary selections.
 */
export function enclosingBlockOf(markdown: string, from: number): string {
  let cursor = 0;
  let best: string | null = null;
  for (const block of markdown.split(/\n{2,}/)) {
    const start = cursor;
    cursor += block.length;
    // The separator length between this block and the next is consumed by
    // the next iteration's start; match on the block's own span first.
    if (start <= from && from < cursor) return block;
    if (start <= from) best = block;
  }
  return best ?? '';
}

/**
 * Incremental extractor for the strict `{"replacement": "…"}` reply:
 * `push` consumes raw content deltas and returns the decoded replacement
 * string SO FAR (best-effort preview — ambiguity yields '', never throws).
 */
export class ReplacementStreamExtractor {
  private raw = '';

  push(delta: string): string {
    this.raw += delta;
    return this.textSoFar();
  }

  textSoFar(): string {
    // Reasoning models occasionally emit <think> blocks in the content
    // channel; an unclosed block means nothing answer-shaped has arrived.
    const withoutThink = this.raw
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/<think>[\s\S]*/i, '');
    const open = withoutThink.indexOf('{');
    if (open === -1) return '';
    const keyAt = withoutThink.indexOf('"replacement"', open);
    if (keyAt === -1) return '';
    let cursor = keyAt + '"replacement"'.length;
    while (cursor < withoutThink.length && /\s/.test(withoutThink[cursor] ?? '')) cursor += 1;
    if (withoutThink[cursor] !== ':') return '';
    cursor += 1;
    while (cursor < withoutThink.length && /\s/.test(withoutThink[cursor] ?? '')) cursor += 1;
    if (withoutThink[cursor] !== '"') return '';
    cursor += 1;
    return decodeJsonStringPrefix(withoutThink, cursor);
  }
}

/** Decodes a JSON string body starting at `start` until its closing quote. */
function decodeJsonStringPrefix(text: string, start: number): string {
  let out = '';
  let cursor = start;
  while (cursor < text.length) {
    const char = text[cursor] ?? '';
    if (char === '"') return out;
    if (char === '\\') {
      const escape = text[cursor + 1];
      if (escape === undefined) return out; // wait for more raw
      const simple: Record<string, string> = {
        n: '\n',
        t: '\t',
        r: '\r',
        b: '\b',
        f: '\f',
        '"': '"',
        '\\': '\\',
        '/': '/',
      };
      const mapped = simple[escape];
      if (mapped !== undefined) {
        out += mapped;
        cursor += 2;
        continue;
      }
      if (escape === 'u') {
        const hex = text.slice(cursor + 2, cursor + 6);
        if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) return out; // incomplete
        out += String.fromCharCode(Number.parseInt(hex, 16));
        cursor += 6;
        continue;
      }
      return out; // unknown escape — stop the preview, the settled reply decides
    }
    out += char;
    cursor += 1;
  }
  return out;
}

const WIKI_TOKEN_RULES =
  '- Wiki-links are [[Name]] tokens (names, never IDs). Keep every token\'s EXACT canonical spelling when the instruction does not rename the entity; never inflect inside the token — write [[Halmund]]\'s tower, not [[Halmunds]] Haus; write [[Name|display]] when the surface text must differ from the canonical name; use [[Name|display]] for roles/titles ([[Halmund|the guard Halmund]]). When the instruction renames or introduces entities, update every affected token inside the replacement consistently. The same rules apply in any language.';

/**
 * Runs one canvas refine: returns the validated, debris-scanned replacement
 * AND the model that served the call (`modelUsed`) — the provenance the
 * accepted proposal is persisted with (docs/17 row 93), never a settings
 * lookup, so an escalated turn is attributed to the model that answered.
 * Throws loudly on busy (`ModuleBusyError`), contract failures (JSON/zod),
 * debris, and empty part replacements. User aborts throw `AbortError` —
 * callers distinguish them via `signal.aborted`, not via the error type
 * (18-ARCHITECTURE: the signal is the source of truth).
 */
export async function refineModuleText(
  input: CanvasRefineInput,
): Promise<{ replacement: string; modelUsed: string }> {
  if (input.turn === undefined) {
    // Loud, never a silent un-cancellable turn: the app-level sweep reaches
    // canvas turns through this controller (canvasBusy's abort registry), so a
    // caller that does not pass one would hand the user a generation Stop all
    // cannot stop — the exact bug this seam exists to close.
    throw new Error(
      "canvas refine needs the caller's AbortController (Stop all reaches canvas turns through it)",
    );
  }
  if (input.turn.signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  // ONE generation per module: the SHARED canvas generation registry
  // (canvasBusy — refine + chat serialize on it) is claimed SYNCHRONOUSLY
  // at entry (before any await — two concurrent calls must never both
  // pass the check), and the forge's own row state is the other
  // authority: a module mid-generation refuses too.
  claimModuleGeneration(input.moduleId);
  // The app-level sweep's abort handle (18-ARCHITECTURE §2.3): a refine turn
  // has no run row, so Stop all can only reach it through this registry. The
  // returned signal is composed with the caller's own controller — both ends
  // of a cancel (the user's, the sweep's) land in the SAME place the caller
  // already handles.
  const handle = registerCanvasAbort(input.moduleId, input.turn);
  try {
    const instruction = input.instruction.trim();
    if (instruction === '') {
      throw new Error('canvas refine needs an instruction');
    }
    if (input.scope === 'selection' && input.text === '') {
      throw new Error('canvas selection refine needs a selected span');
    }
    const module = await getModule(input.moduleId);
    if (module === undefined) {
      throw new Error('Module no longer exists');
    }
    if (module.status === 'generating') {
      throw new ModuleBusyError(input.moduleId);
    }
    const settings = await getSettings();
    const messages = canvasRefineMessages(input, instruction);
    const extractor = new ReplacementStreamExtractor();
    const { text: raw, modelUsed } = await chat(messages, {
      model: settings.defaultChatModel,
      // Surgical rewrites: lower than the forge's creative 0.8 so the
      // replacement stays close to the span it replaces.
      temperature: 0.4,
      reasoningEffort: settings.defaultReasoningEffort,
      responseFormat: schemaResponseFormat('canvas-refine', canvasRefineReplySchema),
      signal: handle.signal,
      onToken: (delta) => {
        const soFar = extractor.push(delta);
        if (soFar !== '') input.onDelta?.(soFar);
      },
    });

    // Boundary validation: fail loud, never partial-apply (AGENTS 3).
    const reply = canvasRefineReplySchema.parse(parseJsonReply(raw));
    if (input.scope === 'part' && reply.replacement.trim() === '') {
      throw new Error('the model returned an empty replacement for the whole part');
    }
    const issues = debrisIssuesForFields([{ field: 'replacement', text: reply.replacement }]);
    if (issues.length > 0) {
      throw new Error(`canvas refine rejected its reply — ${issues.join('; ')}`);
    }
    return { replacement: reply.replacement, modelUsed };
  } finally {
    handle.releaseHandle();
    releaseModuleGeneration(input.moduleId);
  }
}

function canvasRefineMessages(input: CanvasRefineInput, instruction: string): ChatMessage[] {
  const system =
    'You are the Canvas co-editor for tabletop RPG modules — an expert rewriter of ' +
    'GM-facing markdown prose. You return ONLY the requested JSON object, never commentary.';
  const rules =
    input.scope === 'selection'
      ? [
          `Rewrite ONLY the selected span of the module's document, following the instruction.`,
          '- "replacement" replaces EXACTLY the selected text — same boundaries, no surrounding words, no added quotes, no explanations.',
          '- Preserve the markdown structure around the selection: never unbalance **emphasis**, lists, headings, tables, or code fences; never start or end the replacement with a newline unless the selection itself did.',
          WIKI_TOKEN_RULES,
          '- Match the language of the surrounding text.',
          'Reply with ONLY a JSON object: { "replacement": string }',
        ]
      : [
          `Rewrite the whole module part below, following the instruction.`,
          '- "replacement" is the COMPLETE new markdown of the part — the same kind of GM-facing document: no commentary, NO H1 (the reader adds the part title), ##/### subheadings allowed, read-aloud text in blockquotes.',
          '- Preserve entity canonical spellings from the original text unless the instruction renames them; keep the prose usable at the table.',
          WIKI_TOKEN_RULES,
          '- Match the generation language of the original text.',
          'Reply with ONLY a JSON object: { "replacement": string }',
        ];
  const context =
    input.scope === 'selection'
      ? [
          `Enclosing block (context only — never part of the replacement):\n${input.enclosingBlock}`,
          `Selected text — the span "replacement" replaces exactly:\n${input.text}`,
        ]
      : [`Full part text to rewrite:\n${input.text}`];
  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: [...rules, ...context, `Instruction: ${instruction}`].join('\n\n'),
    },
  ];
}
