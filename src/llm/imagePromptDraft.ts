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
 *
 * Owner-directed amendment (docs/17 row 224, the text-budget REVERSAL): the
 * guard above stopped forbidding text WHOLESALE. The bare text terms are
 * gone, and a POSITIVE clause — `IMAGE_TEXT_SPARING_CLAUSE`, the owner's own
 * wording — rides the composed prompt of both branches instead, so a request
 * for a treasure map, a confession letter or a map with a legend is never
 * overridden by the Avoid list. See the constants below for the incident,
 * the reversal and why the vision path keeps its own clause.
 */

/**
 * How much GROUNDING TEXT one image prompt may carry (docs/17 row 223).
 *
 * OWNER DECISION, verbatim (2026-09-17): *"I never authorized a cap and i
 * would have vehemently opposed such a low one. So thats why some details get
 * ignored. Please raise the cap to 10k. Most image models can do much more
 * than that."* The 800-character value this replaces was never an owner
 * decision — it was written into the composer and into two pins as a
 * convention — and it silently dropped the tail of every long body, which is
 * why details went missing from module covers (whose grounding is the whole
 * document text) and from long-bodied entities with no `appearance`.
 *
 * ONE constant, used by BOTH capped sites below (`buildImagePrompt`'s
 * `Description:` line and `portraitGroundingForChunk`), so the two can never
 * drift apart again. The cut is still silent when it bites — a 10k grounding
 * is far beyond any image model's useful attention, so it should not bite in
 * practice; if it ever does, surfacing the truncation is its own slice, not a
 * reason to trim here.
 */
export const IMAGE_PROMPT_GROUNDING_MAX_CHARS = 10_000;

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
 * inside the art (OWNER INCIDENT: the model "tends to render lots of text,
 * explaining the whole plot in the image"). Flows into the final prompt as
 * `Avoid: …` via `assembleImagePrompt`.
 *
 * REVERSAL — the incident stands; the first cure was TOO BROAD (docs/17 row
 * 224). Owner report, verbatim: *"Apparently that now led to a negative
 * prompt so that models don't produce ANY text at all anymore. That was not
 * my goal. I instructed a model to make a legend and it did not do it. I
 * would like to discourage the model to use too much text but not forbid it
 * to do any. Something like 'Unless requested otherwise, use text
 * sparingly'. It should still be able to draw a treasure map or a confession
 * letter or a map with a legend."* The reading this comment used to carry —
 * *"'Use text sparingly' hedges are explicitly NOT the fix — this Avoid list
 * is the proven mechanism."* — was WRONG and is REVERSED: the hedge IS the
 * fix (`IMAGE_TEXT_SPARING_CLAUSE`), and the list's BARE text terms were the
 * defect, because an image model reads `Avoid: text, letters, numbers,
 * words` as "render no text at all" — which is exactly what stopped the
 * legend. Those five bare terms are DROPPED; what remains is only the proven
 * failure modes. The clause is the request-coexistence mechanism: it sets
 * the default budget, and "unless requested otherwise" keeps a treasure map,
 * a confession letter or a map with a legend drawable.
 */
export const IMAGE_TEXT_NEGATIVE =
  'long paragraphs of text, captions, explanatory text, plot summary, stat block, character sheet, diagram, speech bubbles, watermark, signature, illegible or garbled or misspelled lettering';

/**
 * The positive text-budget clause (docs/17 row 224) — the OWNER's wording,
 * verbatim: *"Something like 'Unless requested otherwise, use text
 * sparingly'."* It rides the COMPOSED PROMPT, never the Avoid list, because
 * the two are read differently: the list names failure modes, while this
 * clause sets the DEFAULT budget and leaves "unless requested otherwise" as
 * the escape hatch for text the request actually asks for.
 *
 * Wired into both `buildImagePrompt` branches (the `appearance` shortcut and
 * the name/summary/description grounding) and into the classic-stylize
 * battlemap prompt (`runEngine`). NOT wired into the vision dungeon path:
 * `buildLabeledMapPrompt`'s "no written text anywhere except the N letter
 * plaques" clause is LOAD-BEARING for its locate pass (the vision camera
 * reads exactly those plaques), so the owner's "map with a legend" need is
 * served by the generic illustration paths instead — docs/17 row 224.
 */
export const IMAGE_TEXT_SPARING_CLAUSE = 'Unless requested otherwise, use text sparingly.';

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
 * Capped deterministically at `IMAGE_PROMPT_GROUNDING_MAX_CHARS` (the ONE
 * constant this file exports, docs/17 row 223 — the owner raised it from 800
 * to 10,000 on 2026-09-17 because the old value silently dropped the tail of
 * long groundings). Pure: same chunk → same grounding.
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
  // The PARSED arm lives below, shared with a mob COPY's own block — one body,
  // two entry points (the unparsed fallback stays on THIS entry: a copy has no
  // unparsed text to fall back to).
  return portraitGroundingForStatBlock(statBlock);
}

/**
 * The stat-exempt portrait grounding of a creature whose OWN stat block is the
 * source — the arm a CONVERTED mob copy grounds through (docs/17 row 269): a
 * copy carries the library's bytes on its own row, so its portrait never reads
 * the pack, and `rosterParticipantRoute` hands this block to the job.
 *
 * WHY IT IS NOT A SECOND RULE. It is `portraitGroundingForChunk`'s parsed arm,
 * moved here so both entries call ONE body (the sizes/types/prose IN, every
 * numeric field OUT and the 10,000-char cap are stated once, on the chunk
 * entry above). A copy's block is parsed by construction — `domain/libraryCopy`
 * refuses a chunk with no stat block — which is exactly why this entry needs no
 * `text` fallback and why no caller may fabricate one.
 */
export function portraitGroundingForStatBlock(statBlock: StatBlock): string {
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
  return parts.join('\n').slice(0, IMAGE_PROMPT_GROUNDING_MAX_CHARS);
}

/**
 * Builds the image prompt for one artifact — a pure function, same input →
 * same prompt. Both branches carry the owner's `IMAGE_TEXT_SPARING_CLAUSE`
 * (docs/17 row 224) between the grounding and any `extraInstruction`, so a
 * request that asks for text is the "unless requested otherwise" exception.
 * When the artifact data carries a non-empty `appearance`, the
 * shortcut prompt `"${systemLabel}=>${appearance}"` is used verbatim (the
 * clause and the extra instruction, when set, ride on following lines).
 * Otherwise the prompt
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
    const prompt = [
      `${opts.systemLabel}=>${appearance}`,
      // The owner's text budget rides BEFORE any trailing instruction, so a
      // request that asks for text ("…a map with a legend") follows the
      // "unless requested otherwise" it is the exception to.
      IMAGE_TEXT_SPARING_CLAUSE,
      opts.extraInstruction === undefined || opts.extraInstruction === ''
        ? null
        : opts.extraInstruction,
    ]
      .filter((part) => part !== null)
      .join('\n');
    return { prompt, negative: opts.negative ?? IMAGE_TEXT_NEGATIVE, styleNotes: '' };
  }

  const summary = target.summary.trim();
  // The body is markdown (artifact content): strip the syntax so the image
  // API receives prose, and cap it deterministically (the drafted
  // instruction grounded on the SAME cap too).
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
    description === '' ? null : `Description: ${description.slice(0, IMAGE_PROMPT_GROUNDING_MAX_CHARS)}`,
    // The owner's text budget rides BEFORE any trailing instruction, so a
    // request that asks for text ("…a map with a legend") follows the
    // "unless requested otherwise" it is the exception to.
    IMAGE_TEXT_SPARING_CLAUSE,
    opts.extraInstruction === undefined || opts.extraInstruction === ''
      ? null
      : opts.extraInstruction,
  ]
    .filter((part) => part !== null)
    .join('\n');
  return { prompt, negative: opts.negative ?? IMAGE_TEXT_NEGATIVE, styleNotes: '' };
}
