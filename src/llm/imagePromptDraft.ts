import { markdownToText } from '@/lib/markdown';
import type { ImagePromptDraft } from '@/llm/schemas';
import type { NamedText, StatBlock } from '@/domain/statblock';

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
  /** Text folded into the draft's `negative` field (surfaced by
   * `assembleImagePrompt` as `Avoid: …`). Defaults to '' (no avoid list) —
   * only the mob portrait drafts set a text-render guard; every other caller
   * is unaffected. */
  negative?: string | undefined;
}

/**
 * Text-render guard for the mob portrait drafts (docs/11 D5): smart image
 * models otherwise render the grounding prose as captions inside the
 * portrait. Flows into the final prompt as `Avoid: …` via
 * `assembleImagePrompt`.
 */
export const MOB_PORTRAIT_TEXT_NEGATIVE =
  'text, letters, numbers, words, captions, stat block, character sheet, diagram, label';

/**
 * The chunk input the mob portrait grounding reads: raw text plus the
 * parsed stat block (`RuleChunk` satisfies this structurally).
 */
export interface PortraitGroundingChunk {
  text: string;
  statBlock: StatBlock | null;
}

/**
 * Stat-exempt portrait grounding for one creature chunk (docs/11 D5):
 * smart image models RENDER chunk stat text into portraits, so both
 * mob-portrait grounding sites feed this helper's output — never raw
 * `chunk.text` — into the shared Illustrator contract.
 *
 * Stat-exempt rule (identity + prose IN, numbers OUT):
 * - IN: `size` + `creatureType` identity ("Large giant") plus the named-text
 *   prose sections — traits / actions / reactions / legendary — as
 *   `name: text` pairs.
 * - OUT: every stat/number field — `system`, `level` (borderline: a
 *   progression number, deliberately excluded), `ac`, `acNote`, `hp`,
 *   `hpFormula`, `speed`, `abilities`, `saves`, `skills`, `senses`,
 *   `languages`, `extras`. String-typed stat fields (`saves`, `senses`,
 *   `speed` dice like "darkvision 60 ft.") carry digits by nature, so the
 *   rule excludes them by FIELD, not by digit-sniffing the prose.
 *
 * Capped deterministically at 800 chars (the `buildImagePrompt` convention).
 * Pure: same chunk → same grounding.
 *
 * RESIDUAL RENDER RISK (loud, not silent): when `statBlock` is null
 * (unparsed chunks) there is no stat-free material to compose, so this
 * returns `chunk.text` verbatim — exactly today's behavior, stat digits
 * included. Callers and docs name this fallback explicitly; it is never a
 * silent substitution (AGENTS rule 1).
 */
export function portraitGroundingForChunk(chunk: PortraitGroundingChunk): string {
  const statBlock = chunk.statBlock;
  if (statBlock === null) {
    // LOUD FALLBACK: unparsed chunk — no parsed prose exists, so the raw
    // text (stat numbers included) is the only grounding available. This is
    // the residual text-render risk, returned verbatim BY EXPLICIT DESIGN,
    // never as a silent default.
    return chunk.text;
  }
  const parts: string[] = [];
  const identity = `${statBlock.size} ${statBlock.creatureType}`.trim();
  if (identity !== '') parts.push(identity);
  const proseGroups: { label: string; entries: readonly NamedText[] }[] = [
    { label: 'Traits', entries: statBlock.traits },
    { label: 'Actions', entries: statBlock.actions },
    { label: 'Reactions', entries: statBlock.reactions },
    { label: 'Legendary actions', entries: statBlock.legendary },
  ];
  for (const group of proseGroups) {
    if (group.entries.length === 0) continue;
    parts.push(
      `${group.label}: ${group.entries.map((entry) => `${entry.name}: ${entry.text}`).join('; ')}`,
    );
  }
  return parts.join('\n').slice(0, 800);
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
    return { prompt, negative: opts.negative ?? '', styleNotes: '' };
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
  return { prompt, negative: opts.negative ?? '', styleNotes: '' };
}
