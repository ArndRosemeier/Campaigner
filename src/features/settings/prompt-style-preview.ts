import {
  composePromptFromTemplate,
  PROMPT_STYLE_PLACEHOLDERS,
  validatePromptStyleTemplate,
  type ComposedPrompt,
  type PromptStyle,
  type PromptSurface,
} from '@/domain';
import { partsContractValues, spineContractValues } from '@/llm/promptStyles';

/**
 * Preview + validation for the settings authoring editor (docs/17 row 86).
 *
 * Two jobs, both of them about the author seeing what they are making:
 *
 * 1. VALIDATION runs the SAME `validatePromptStyleTemplate` the save path and
 *    the composer run, so the editor can never show "no problems" for a
 *    template the composer will refuse. The problems are listed, not softened.
 * 2. PREVIEW composes the style against SAMPLE values and tags each line with
 *    the layer it came from, so the author can see which text is theirs and
 *    which lines are the contract that will ride along with it no matter what
 *    they write. The contract values come from the REAL builders (the same ones
 *    the generation path injects) — a preview that invented its own contract
 *    text would be a lie about what the model receives.
 *
 * The sample values are labelled: every non-contract placeholder renders
 * `‹…›`, so nothing in the preview reads as a claim about a real module.
 */

const SAMPLE_FLOOR_CLAUSE =
  'REQUIREMENT — encounter floor: name at least one distinct encounter per level of this module’s range.';

/** Sample data values, one per non-contract placeholder, all visibly fake. */
function sampleDataValues(): Record<string, string> {
  const values: Record<string, string> = {};
  for (const entry of PROMPT_STYLE_PLACEHOLDERS) {
    if (entry.layer === 'contract') continue;
    values[entry.token] = `‹${entry.summary.replace(/\.$/, '')}›`;
  }
  return values;
}

/** One composed surface plus its problems (a failing template yields problems, not a crash). */
export interface PromptStylePreview {
  surface: PromptSurface;
  composed: ComposedPrompt | null;
  /** Problems the composer/save path would raise, verbatim. */
  problems: readonly string[];
}

export interface PromptStylePreviewSet {
  spine: PromptStylePreview;
  parts: PromptStylePreview;
  /**
   * Every problem, each one ONCE: a template with no sections at all raises the
   * same complaint on both surfaces, and a list that repeats itself reads as two
   * separate faults (and, as a React list, needs distinct keys).
   */
  problems: readonly string[];
  /** True when BOTH surfaces compose — the only state in which a save can stick. */
  savable: boolean;
}

function previewSurface(
  templateText: string,
  surface: PromptSurface,
  values: Record<string, string>,
): PromptStylePreview {
  const problems = validatePromptStyleTemplate(templateText, [surface]);
  if (problems.length > 0) return { surface, composed: null, problems };
  try {
    return { surface, composed: composePromptFromTemplate({ templateText, surface, values }), problems: [] };
  } catch (error) {
    // A template that validated but cannot compose is a LOUD problem, never an
    // empty preview (AGENTS 1/2).
    return {
      surface,
      composed: null,
      problems: [error instanceof Error ? error.message : String(error)],
    };
  }
}

/** Validates and previews one style for the editor.
 *
 * The conditional clauses a run may not carry are rendered as PRESENT here,
 * because this surface documents what a style's placeholders hold when they
 * hold anything: the sample encounter floor, and the bestiary slot
 * (`bestiaryAvailable: true`) — a workspace WITH a bestiary is the case a style
 * author needs to see, and the template itself is the same either way. */
export function previewPromptStyle(style: Pick<PromptStyle, 'templateText'>): PromptStylePreviewSet {
  const shared = sampleDataValues();
  const spine = previewSurface(style.templateText, 'spine', {
    ...shared,
    ...spineContractValues({ floorClause: SAMPLE_FLOOR_CLAUSE, bestiaryAvailable: true }),
  });
  const parts = previewSurface(style.templateText, 'parts', {
    ...shared,
    ...partsContractValues({ lengthTarget: '800–1500', floorClause: SAMPLE_FLOOR_CLAUSE }),
  });
  return {
    spine,
    parts,
    problems: [...new Set([...spine.problems, ...parts.problems])],
    savable: spine.composed !== null && parts.composed !== null,
  };
}
