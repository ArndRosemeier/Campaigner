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
 * Owner-directed amendment (docs/17 row 319): the text rule is POSITIVE. The
 * shared text `Avoid:` list is DELETED — both exported names are gone from
 * `src/`, and docs/17 row 319 records the exact string that was dropped — the
 * default `negative` is `''` so a default draft carries NO `Avoid:` line at
 * all, and ONE positive clause — `IMAGE_TEXT_WHEN_NEEDED_CLAUSE`, the owner's
 * own wording — rides the composed prompt of both branches instead: text the
 * subject itself needs is welcome and nothing is forbidden. The vision dungeon
 * path keeps its own plaque clause (documented carve-out, on the constant
 * below).
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
   * `assembleImagePrompt` as `Avoid: …`). There is NO shared avoid list: the
   * default is `''`, so a caller that supplies nothing emits no `Avoid:` line
   * at all. This option is the explicit-override seam — a caller with a
   * tailored need (the battlemap brief's own negative) passes its own list,
   * and an explicit `''` opts out. */
  negative?: string | undefined;
}

/**
 * The positive text rule (docs/17 row 319) — the OWNER's intent, verbatim:
 * *"I do not want a text avoid list. I do not want anything that the model
 * needs to strictly avoid. I want the model to be told to only use text where
 * it is needed and then it is ok. Any avoid list will capture things that will
 * be important at some time, i just realized that."*
 *
 * WHY THERE IS NO AVOID LIST. The original incident stands — a smart image
 * model "tends to render lots of text, explaining the whole plot in the
 * image" — but every attempt to name what to forbid captured something a
 * future request needed (docs/17 rows 62, 224, 319). The owner's decision is
 * therefore that NOTHING is forbidden: this ONE clause states where text
 * BELONGS and asks for it to be short, correctly spelled and readable. It
 * rides the COMPOSED PROMPT of both `buildImagePrompt` branches (BEFORE any
 * `extraInstruction`, so a request that asks for text follows this
 * permission) and of both classic-stylize battlemap modes (`runEngine`) —
 * never an `Avoid:` line, which is now only what an EXPLICIT caller
 * `negative` supplies.
 *
 * NOT wired into the vision dungeon path:
 * `visionDungeon.buildLabeledMapPrompt`'s "no written text anywhere except the
 * N letter plaques" clause is a CALLER-OWNED rule, LOAD-BEARING for its
 * locate pass (the vision camera reads exactly those plaques), so the owner's
 * "map with a legend" need is served by the generic illustration paths
 * instead — docs/17 rows 224/319.
 */
export const IMAGE_TEXT_WHEN_NEEDED_CLAUSE =
  "Text is welcome where the subject itself needs it — writing on a letter, a sign, a book or a map's own labels — and wherever the request asks for it; use it only where it is needed, and keep it short, correctly spelled and clearly readable.";

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
 * same prompt. Both branches carry the owner's `IMAGE_TEXT_WHEN_NEEDED_CLAUSE`
 * (docs/17 row 319) between the grounding and any `extraInstruction`, so a
 * request that asks for text follows the permission that precedes it.
 * When the artifact data carries a non-empty `appearance`, the
 * shortcut prompt `"${systemLabel}=>${appearance}"` is used verbatim (the
 * clause and the extra instruction, when set, ride on following lines).
 * Otherwise the prompt
 * grounds on the artifact's own text — name + kind, summary, and the
 * markdown-stripped body — styled with the game system. With nothing to
 * ground on (no appearance, summary, AND body) it throws: a blank image of
 * nothing is a placeholder, never a fallback (AGENTS rule 1). The default
 * `negative` is `''` — no shared avoid list exists, so the default prompt
 * carries no `Avoid:` line.
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
      // The owner's positive text rule rides BEFORE any trailing instruction,
      // so a request that asks for text ("…a map with a legend") follows the
      // permission it is an instance of.
      IMAGE_TEXT_WHEN_NEEDED_CLAUSE,
      opts.extraInstruction === undefined || opts.extraInstruction === ''
        ? null
        : opts.extraInstruction,
    ]
      .filter((part) => part !== null)
      .join('\n');
    return { prompt, negative: opts.negative ?? '', styleNotes: '' };
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
  // from the grounding). Nothing here is an `Avoid:` line any more (docs/17
  // row 319 deleted the shared list), so the syntax is pinned as prompt TEXT,
  // not as a rendering. Pinned as-is by
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
    // The owner's positive text rule rides BEFORE any trailing instruction,
    // so a request that asks for text ("…a map with a legend") follows the
    // permission it is an instance of.
    IMAGE_TEXT_WHEN_NEEDED_CLAUSE,
    opts.extraInstruction === undefined || opts.extraInstruction === ''
      ? null
      : opts.extraInstruction,
  ]
    .filter((part) => part !== null)
    .join('\n');
  return { prompt, negative: opts.negative ?? '', styleNotes: '' };
}
