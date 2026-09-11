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
 *
 * Owner-directed amendment (image text-render guard default-on): the
 * `IMAGE_TEXT_NEGATIVE` Avoid list rides EVERY draft unless the caller
 * passes its own `negative` (the explicit-override seam) — covers, entity
 * images, portraits, and the appearance shortcut alike. The vision dungeon
 * path is the one documented carve-out (it needs its room plaques, so it
 * never routes through this contract).
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
   * `assembleImagePrompt` as `Avoid: …`). DEFAULTS to the shared
   * `IMAGE_TEXT_NEGATIVE` guard — every caller is guarded unless it passes
   * its own list. This option is the explicit-override seam: a caller with a
   * tailored need (the vision dungeon path's room plaques) passes its own
   * `negative` instead (an explicit `''` opts out — documented carve-outs
   * only, never by accident). */
  negative?: string | undefined;
}

/**
 * Text-render guard for EVERY image prompt (docs/11 D5, generalized):
 * smart image models otherwise render the grounding prose as captions
 * inside the art (owner report: the model "tends to render lots of text,
 * explaining the whole plot in the image"). Flows into the final prompt as
 * `Avoid: …` via `assembleImagePrompt`. "Use text sparingly" hedges are
 * explicitly NOT the fix — this Avoid list is the proven mechanism.
 */
export const IMAGE_TEXT_NEGATIVE =
  'text, letters, numbers, words, captions, stat block, character sheet, diagram, label, speech bubbles, watermark, signature, plot summary, explanatory text';

/**
 * The mob-portrait name for the shared guard (docs/11 D5): the portrait
 * queues import this symbol, so it stays as an alias — the general list
 * covers the proven portrait list, and the two names denote the same string.
 */
export const MOB_PORTRAIT_TEXT_NEGATIVE = IMAGE_TEXT_NEGATIVE;

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
    return { prompt, negative: opts.negative ?? IMAGE_TEXT_NEGATIVE, styleNotes: '' };
  }

  const summary = target.summary.trim();
  // The body is markdown (artifact content): strip the syntax so the image
  // API receives prose, and cap it deterministically (the drafted
  // instruction grounded on ≤800 chars too).
  //
  // DELIBERATELY `markdownToText`, not `markdownToDisplayText` (docs/17 row
  // 105): this is a MODEL PROMPT, not a rendering — nothing here is read by
  // the owner, and the token is the only place the target's real NAME survives
  // (`[[Encounter:Ash Gate|the gate]]` → the display would drop "Ash Gate"
  // from the grounding). The image text-render guard is the default negative,
  // so the syntax cannot print into the picture either. Pinned as-is by
  // tests/llm/imagePromptDraft.test.ts ("KEEPS a wiki token verbatim").
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
  return { prompt, negative: opts.negative ?? IMAGE_TEXT_NEGATIVE, styleNotes: '' };
}
