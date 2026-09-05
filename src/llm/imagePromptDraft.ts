import { markdownToText } from '@/lib/markdown';
import type { ImagePromptDraft } from '@/llm/schemas';

/**
 * The Illustrator prompt contract — ONE implementation for the three call
 * sites that previously mirrored each other by hand (runEngine's prompt-draft
 * step, the entity image queue, and the mob portrait queue): the appearance
 * shortcut and the body/summary/name grounding.
 *
 * Owner-directed amendment (2026-09-05): the LLM prompt-crafting call (and its
 * one contract-repair retry) is GONE. The image prompt is assembled
 * deterministically from the artifact's own data — no chat call anywhere in
 * the image-prompt path.
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

export interface BuildImagePromptOptions {
  /** Rule-system label ("Pathfinder 2e") — prefixes the appearance shortcut
   * and styles the body/summary grounding. */
  systemLabel: string;
  /** Trailing steering line (the run engine's retry/continue instruction). */
  extraInstruction?: string | undefined;
}

/**
 * Builds the image prompt for one artifact — a pure function, same input →
 * same prompt. When the artifact data carries a non-empty `appearance`, the
 * shortcut prompt `"${systemLabel}=>${appearance}"` is used verbatim (the
 * extra instruction, when set, rides on a second line). Otherwise the prompt
 * grounds on the artifact's own text — name + kind, summary, and the
 * markdown-stripped body — styled with the game system. With nothing to
 * ground on (no appearance, summary, AND body) it throws: a blank image of
 * nothing is a placeholder, never a fallback (AGENTS rule 1).
 */
export function buildImagePrompt(
  target: ImagePromptTarget,
  opts: BuildImagePromptOptions,
): ImagePromptDraft {
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
    return { prompt, negative: '', styleNotes: '' };
  }

  const summary = target.summary.trim();
  // The body is markdown (artifact content): strip the syntax so the image
  // API receives prose, and cap it deterministically (the drafted
  // instruction grounded on ≤800 chars too).
  const description = markdownToText(target.body);
  if (summary === '' && description === '') {
    throw new Error(
      `"${target.name}" has no appearance, summary, or body to ground the image prompt — describe it first`,
    );
  }
  const prompt = [
    `A ${opts.systemLabel} illustration of ${target.name} (${target.kind}).`,
    summary === '' ? null : `Summary: ${summary}`,
    description === '' ? null : `Description: ${description.slice(0, 800)}`,
    opts.extraInstruction === undefined || opts.extraInstruction === ''
      ? null
      : opts.extraInstruction,
  ]
    .filter((part) => part !== null)
    .join('\n');
  return { prompt, negative: '', styleNotes: '' };
}
