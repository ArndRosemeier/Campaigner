import type { Settings } from '@/domain';
import { chat, type ChatFallback, type ChatMessage, type ChatOptions } from '@/llm/openrouter';
import { formatZodIssues, parseErrorSummary, parseJsonReply } from '@/llm/jsonReply';
import { repairModel } from '@/llm/modelFallback';
import { imagePromptDraftSchema, type ImagePromptDraft } from '@/llm/schemas';
import { ZodError } from 'zod';

/**
 * The Illustrator prompt contract — ONE implementation for the two call
 * sites that previously mirrored each other by hand (runEngine's prompt-draft
 * step and the entity image queue): the appearance shortcut, the instruction
 * text, the reply contract, and the one contract-repair retry that escalates
 * to the repair model (a violated reply contract is usually a capability
 * weakness of the first-try model).
 */

/** The final image-API prompt: draft prompt + style notes + avoid list. */
export function assembleImagePrompt(draft: ImagePromptDraft): string {
  return [
    draft.prompt,
    draft.styleNotes === '' ? null : `Style: ${draft.styleNotes}`,
    draft.negative === '' ? null : `Avoid: ${draft.negative}`,
  ]
    .filter((part) => part !== null)
    .join('\n');
}

/** The artifact to illustrate (only the fields the prompt contract reads). */
export interface ImagePromptTarget {
  name: string;
  kind: string;
  summary: string;
  body: string;
  /** Kind-specific data — read for the NPC `appearance` shortcut. */
  data: unknown;
}

export interface DraftImagePromptOptions {
  /** The already-resolved first-try model; the repair attempt escalates via
   * `repairModel` (the configured tier, when one is defined). */
  model: string;
  /** Settings for the repair-model resolution. */
  settings: Pick<Settings, 'fallbackChatModel'>;
  /** The Illustrator's system prompt. */
  systemPrompt: string;
  /** Rule-system label prefixing the appearance shortcut ("Pathfinder 2e"). */
  systemLabel: string;
  /** Extra context lines between the description and the reply contract
   * (campaign tone, focus — the run engine passes these, the queue omits
   * them). Null entries are dropped. */
  contextLines?: readonly (string | null)[] | undefined;
  /** Trailing "Additional instruction" line (user steering, repair texts). */
  extraInstruction?: string | undefined;
  signal?: AbortSignal | undefined;
  /**
   * Builds the ChatOptions for one attempt at the given model. Streaming
   * wiring differs per call site (the engine emits run/step token events,
   * the queue streams nowhere), so the caller owns it.
   */
  chatOptions: (model: string) => ChatOptions;
}

export type DraftImagePromptResult =
  | {
      ok: true;
      draft: ImagePromptDraft;
      fallback: ChatFallback | null;
      firstTryModel: string;
      repairTarget: string;
    }
  | {
      ok: false;
      /** The raw reply of the last (failed) attempt. */
      raw: string;
      /** One human-readable line per problem with the last reply. */
      issues: string[];
      fallback: ChatFallback | null;
      firstTryModel: string;
      repairTarget: string;
    };

/**
 * Drafts the image prompt for one artifact. When the artifact data carries a
 * non-empty `appearance`, the deterministic shortcut prompt
 * `"${systemLabel}=>${appearance}"` is returned without any LLM call (the
 * extra instruction, when set, rides on a second line). Otherwise the model
 * drafts the prompt from the artifact fields; a reply that fails the
 * `imagePromptDraftSchema` contract is repaired ONCE on the repair model,
 * naming the concrete zod issues. The second failure is returned as
 * `{ ok: false }` — callers reject loudly (AGENTS rule 1).
 */
export async function draftImagePrompt(
  target: ImagePromptTarget,
  opts: DraftImagePromptOptions,
): Promise<DraftImagePromptResult> {
  const data = target.data as Record<string, unknown> | null | undefined;
  const appearance =
    data !== null && typeof data === 'object' && typeof data.appearance === 'string'
      ? data.appearance.trim()
      : '';
  if (appearance !== '') {
    const prompt =
      opts.extraInstruction === undefined || opts.extraInstruction === ''
        ? `${opts.systemLabel}=>${appearance}`
        : `${opts.systemLabel}=>${appearance}\n${opts.extraInstruction}`;
    return {
      ok: true,
      draft: { prompt, negative: '', styleNotes: '' },
      fallback: null,
      firstTryModel: opts.model,
      repairTarget: opts.model,
    };
  }

  const instruction = [
    `Artifact: ${target.name} (${target.kind})`,
    target.summary === '' ? null : `Summary: ${target.summary}`,
    target.body === '' ? null : `Description (may be truncated):\n${target.body.slice(0, 800)}`,
    ...(opts.contextLines ?? []),
    'Reply with ONLY a JSON object with exactly these fields: ["prompt", "negative", "styleNotes"] — `prompt` describes the image to generate for this artifact, `negative` lists what to avoid, `styleNotes` gives style guidance.',
    opts.extraInstruction === undefined || opts.extraInstruction === ''
      ? null
      : `Additional instruction: ${opts.extraInstruction}`,
  ]
    .filter((part) => part !== null)
    .join('\n\n');

  const messages: ChatMessage[] = [
    { role: 'system', content: opts.systemPrompt },
    { role: 'user', content: instruction },
  ];

  let fallback: ChatFallback | null = null;
  let lastFailure: { raw: string; issues: string[] } | null = null;
  let repairTarget = opts.model;
  let repairMessage = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const attemptModel = attempt === 0 ? opts.model : (repairTarget = repairModel(opts.model, opts.settings));
    const { text: raw, fallback: attemptFallback } = await chat(
      attempt === 0 ? messages : [...messages, { role: 'user' as const, content: repairMessage }],
      opts.chatOptions(attemptModel),
    );
    fallback = attemptFallback ?? fallback;
    try {
      return {
        ok: true,
        draft: imagePromptDraftSchema.parse(parseJsonReply(raw)),
        fallback,
        firstTryModel: opts.model,
        repairTarget: attemptModel,
      };
    } catch (error) {
      const issues = error instanceof ZodError ? formatZodIssues(error) : [parseErrorSummary(error)];
      lastFailure = { raw, issues };
      repairMessage = `Your previous reply was invalid JSON for the schema:\n- ${issues.join('\n- ')}\nReply with corrected JSON only.`;
    }
  }
  const failure = lastFailure ?? { raw: '', issues: ['the prompt draft failed without an error'] };
  return { ok: false, ...failure, fallback, firstTryModel: opts.model, repairTarget };
}
