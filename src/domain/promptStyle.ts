import { z } from 'zod';

/**
 * Prompt styles (owner-directed, docs/17 row 86): the module-generation prompt
 * is composed from an EDITABLE style layer (voice, shape, craft emphasis) and a
 * READ-ONLY contract layer that no style can drop — see
 * `src/llm/promptStyles.ts` for the contract text and the two built-ins.
 *
 * This module owns the DATA side and nothing else: the style record, the
 * placeholder vocabulary, template parsing/validation, and the pure composer
 * that turns a template + injected values into the exact prompt text. It knows
 * no module, no campaign and no Dexie row, so the whole composition path is
 * testable without a database.
 */

/** The two prompt surfaces a style template carries, in template order. */
export const PROMPT_STYLE_SURFACES = ['spine', 'parts'] as const;

export type PromptSurface = (typeof PROMPT_STYLE_SURFACES)[number];

/**
 * The section marker lines that split one style template into its two prompt
 * surfaces. A template is ONE text (the style record stays a single
 * `templateText`), but the spine prompt and the parts prompt inject different
 * values, so each lives in its own marked section.
 */
export const PROMPT_STYLE_SECTION_MARKERS: Readonly<Record<PromptSurface, string>> = {
  spine: '--- SPINE ---',
  parts: '--- PARTS ---',
};

/** A placeholder token as it appears in a template: `{{name}}`. */
const PLACEHOLDER_SOURCE = String.raw`\{\{\s*([A-Za-z0-9_.]+)\s*\}\}`;

/** A fresh global regex per scan — a shared `g` regex carries `lastIndex`. */
function placeholderPattern(): RegExp {
  return new RegExp(PLACEHOLDER_SOURCE, 'g');
}

/** One occurrence of a placeholder in a template. */
export interface PromptStylePlaceholderUse {
  token: string;
  surface: PromptSurface;
}

/** The placeholder vocabulary: what the composer injects, and when it is empty. */
export interface PromptStylePlaceholder {
  token: string;
  /** 'both' = legal in either section; otherwise only in that section. */
  surface: PromptSurface | 'both';
  /** true = the section may not be saved without it. */
  required: boolean;
  /** 'data' = injected run/campaign/module values; 'contract' = fixed text
   * owned by the app (the layer a style may never weaken). */
  layer: 'data' | 'contract';
  summary: string;
  /** What an empty value does — quoted from the editor's placeholder menu. */
  empty: string;
}

/**
 * The ONE vocabulary. Every placeholder a template may use is listed here, and
 * the editor renders this list as its insert menu (summary + empty behavior), so
 * the documentation a user reads is derived from the same table the validator
 * and the composer enforce.
 *
 * `empty` distinguishes the two documented cases: a value ABSENT in this run
 * (no prior modules, no glossary, a disabled encounter floor) is omitted exactly
 * as the pre-style conditional blocks were, while a fixed contract clause is
 * always present.
 */
export const PROMPT_STYLE_PLACEHOLDERS: readonly PromptStylePlaceholder[] = [
  // --- data: both surfaces -------------------------------------------------
  {
    token: 'campaign',
    surface: 'both',
    required: true,
    layer: 'data',
    summary: 'The campaign line: name, game system, and the campaign description when it has one.',
    empty: 'Never empty.',
  },
  {
    token: 'campaignIndex',
    surface: 'both',
    required: false,
    layer: 'data',
    summary: 'The existing campaign entities (name + kind, capped at 60) the generator may reuse.',
    empty: 'Omitted when the campaign has no reusable entities yet.',
  },
  {
    token: 'priorModules',
    surface: 'both',
    required: false,
    layer: 'data',
    summary:
      'The campaign’s other modules with authored text — premise and parts, oldest first — plus the shared campaign cast.',
    empty: 'Omitted when cross-module continuity is off or no other module carries text.',
  },
  {
    token: 'additionalInstruction',
    surface: 'both',
    required: false,
    layer: 'data',
    summary:
      'A one-off steering instruction for this run (the spine retry, a part retry, a regeneration prompt).',
    empty: 'Omitted on a run that carries no extra instruction.',
  },

  // --- data: spine ---------------------------------------------------------
  {
    token: 'moduleConcept',
    surface: 'spine',
    required: true,
    layer: 'data',
    summary: 'The user’s module concept text.',
    empty: 'Never empty (the concept may itself be blank).',
  },
  {
    token: 'partyLevels',
    surface: 'spine',
    required: true,
    layer: 'data',
    summary: 'The module’s level range, plus its tone when one is set.',
    empty: 'Never empty.',
  },
  {
    token: 'levelMin',
    surface: 'spine',
    required: false,
    layer: 'data',
    summary: 'The module’s lowest party level (a bare number).',
    empty: 'Never empty.',
  },
  {
    token: 'levelMax',
    surface: 'spine',
    required: false,
    layer: 'data',
    summary: 'The module’s highest party level (a bare number).',
    empty: 'Never empty.',
  },
  {
    token: 'levelCount',
    surface: 'spine',
    required: false,
    layer: 'data',
    summary: 'How many levels the module’s range covers (a bare number).',
    empty: 'Never empty.',
  },
  {
    token: 'toneBans',
    surface: 'spine',
    required: false,
    layer: 'data',
    summary:
      'The outcome bans for the module’s tone, as a trailing clause on the sentence it is placed in.',
    empty: 'Renders nothing for a tone with no ban list (a free-text tone).',
  },

  // --- data: parts ---------------------------------------------------------
  {
    token: 'modulePremise',
    surface: 'parts',
    required: true,
    layer: 'data',
    summary: 'The approved spine’s premise, labelled.',
    empty: 'Never empty.',
  },
  {
    token: 'themes',
    surface: 'parts',
    required: false,
    layer: 'data',
    summary: 'The spine’s themes, semicolon-separated.',
    empty: 'Omitted when the spine recorded no themes.',
  },
  {
    token: 'allParts',
    surface: 'parts',
    required: false,
    layer: 'data',
    summary: 'The module’s whole part plan as one line per part (level band, title, synopsis).',
    empty: 'Never empty.',
  },
  {
    token: 'partHeading',
    surface: 'parts',
    required: true,
    layer: 'data',
    summary: 'This part’s number, title and level band.',
    empty: 'Never empty.',
  },
  {
    token: 'partSynopsis',
    surface: 'parts',
    required: true,
    layer: 'data',
    summary: 'This part’s approved synopsis.',
    empty: 'Never empty (a blank synopsis renders as an empty synopsis).',
  },
  {
    token: 'partEndCondition',
    surface: 'parts',
    required: true,
    layer: 'data',
    summary: 'What ends this part / triggers the level-up.',
    empty: 'Never empty.',
  },
  {
    token: 'previousPart',
    surface: 'parts',
    required: false,
    layer: 'data',
    summary: 'The full markdown of the immediately preceding part (hand edits included).',
    empty: 'Omitted for the first part, and when the predecessor failed or is missing.',
  },
  {
    token: 'ruleExcerpts',
    surface: 'parts',
    required: false,
    layer: 'data',
    summary: 'Rulebook excerpts retrieved for this part’s synopsis.',
    empty: 'Omitted when retrieval finds no relevant rules.',
  },
  {
    token: 'glossary',
    surface: 'parts',
    required: false,
    layer: 'data',
    summary: 'The module’s own recorded entity names and kinds — the canonical spellings to link.',
    empty: 'Omitted while the module has no recorded entities.',
  },
  {
    token: 'partEnding',
    surface: 'parts',
    required: false,
    layer: 'data',
    summary:
      'The finale-aware closing demand for this part (satisfaction at full price in the finale, a carried cost otherwise).',
    empty: 'Never empty.',
  },

  // --- contract: spine -----------------------------------------------------
  {
    token: 'contract.replyFormat',
    surface: 'both',
    required: true,
    layer: 'contract',
    summary:
      'The reply format rule for this surface: the JSON contract the spine callback parses in the spine section, and plain markdown / no leading H1 in the parts section.',
    empty: 'Never empty.',
  },
  {
    token: 'contract.floor',
    surface: 'both',
    required: true,
    layer: 'contract',
    summary:
      'The module’s encounter-floor requirement, rendered from its own guardrail. Place it inline: it goes away entirely when the module’s floor is off.',
    empty: 'Renders nothing when the module’s floor is disabled.',
  },
  {
    token: 'contract.entityKinds',
    surface: 'spine',
    required: true,
    layer: 'contract',
    summary: 'The entity-kind vocabulary every declared name must carry.',
    empty: 'Never empty.',
  },
  {
    token: 'contract.sceneKinds',
    surface: 'spine',
    required: true,
    layer: 'contract',
    summary: 'What counts as an encounter and what counts as an event (it decides maps and rosters).',
    empty: 'Never empty.',
  },
  {
    token: 'contract.wikiLinks',
    surface: 'both',
    required: true,
    layer: 'contract',
    summary:
      'The wiki-link rules for this surface: naming and linking the entities the spine introduces, or linking every proper noun by its canonical spelling in a part.',
    empty: 'Never empty.',
  },

  // --- contract: parts -----------------------------------------------------
  {
    token: 'contract.gmAddress',
    surface: 'parts',
    required: true,
    layer: 'contract',
    summary: 'The GM address rule — never author a player character’s actions, words or feelings.',
    empty: 'Never empty.',
  },
  {
    token: 'contract.lengthTarget',
    surface: 'parts',
    required: true,
    layer: 'contract',
    summary: 'This part’s soft word target, from the module’s size dial.',
    empty: 'Never empty.',
  },
  {
    token: 'contract.mechanics',
    surface: 'parts',
    required: true,
    layer: 'contract',
    summary: 'No stat blocks in prose; encounters live in their own artifacts.',
    empty: 'Never empty.',
  },
  {
    token: 'contract.encounterCasting',
    surface: 'parts',
    required: true,
    layer: 'contract',
    summary: 'Name only the fixed participants of a fight — rank-and-file fighters stay anonymous.',
    empty: 'Never empty.',
  },
];

/** One contract clause per surface, in the order the composer documents them. */
export function requiredPlaceholders(surface: PromptSurface): readonly string[] {
  return PROMPT_STYLE_PLACEHOLDERS.filter(
    (entry) =>
      entry.required && (entry.surface === surface || entry.surface === 'both'),
  ).map((entry) => entry.token);
}

/** The vocabulary entry for a token, or undefined when the token is unknown. */
export function promptStylePlaceholder(token: string): PromptStylePlaceholder | undefined {
  return PROMPT_STYLE_PLACEHOLDERS.find((entry) => entry.token === token);
}

/** True when `token` may appear in `surface`'s section. */
function placeholderFits(token: string, surface: PromptSurface): boolean {
  const entry = promptStylePlaceholder(token);
  return entry !== undefined && (entry.surface === surface || entry.surface === 'both');
}

// --- The style record --------------------------------------------------------

export const promptStyleOriginSchema = z.enum(['builtin', 'user']);

/**
 * One module-prompt style. Built-ins ship in code (`src/llm/promptStyles.ts`)
 * and are immutable; user styles live in the settings row and are authored in
 * Settings → Module prompt styles.
 *
 * `version` is the template generation: it is bumped every time the template
 * text is edited, and it is what a module records alongside the text itself, so
 * "this module was written with Story v3" stays readable after the style moves
 * on.
 */
export const promptStyleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  origin: promptStyleOriginSchema,
  /** The style this user style was duplicated or authored from, when known. */
  basedOn: z.string().min(1).optional(),
  version: z.number().int().positive(),
  templateText: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type PromptStyle = z.infer<typeof promptStyleSchema>;

/** A STORED style is always a user style (built-ins never reach the database). */
export const userPromptStyleSchema = promptStyleSchema.extend({
  origin: z.literal('user'),
});

/**
 * What a MODULE records about the style it was generated with: the identity AND
 * the template text, so resume, repair and per-part regeneration keep writing in
 * the voice the module started in even after that style is edited or deleted.
 * The text is the load-bearing field — the id/name/version are provenance for
 * the reader.
 */
export const modulePromptStyleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.number().int().positive(),
  templateText: z.string().min(1),
});

export type ModulePromptStyle = z.infer<typeof modulePromptStyleSchema>;

/** The style id a fresh install (and every module created before styles) uses. */
export const PROMPT_STYLE_CLASSIC_ID = 'classic';

// --- Template parsing and validation ----------------------------------------

/** The lines of one section of a template, marker excluded. */
function sectionLines(templateText: string, surface: PromptSurface): string[] {
  const lines = templateText.replaceAll('\r\n', '\n').split('\n');
  const marker = PROMPT_STYLE_SECTION_MARKERS[surface];
  const start = lines.findIndex((line) => line.trim() === marker);
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const nextMarker = rest.findIndex((line) =>
    Object.values(PROMPT_STYLE_SECTION_MARKERS).some((value) => value === line.trim()),
  );
  return nextMarker < 0 ? rest : rest.slice(0, nextMarker);
}

/** Every placeholder occurrence of a section, in template order. */
function placeholderUses(
  templateText: string,
  surface: PromptSurface,
): PromptStylePlaceholderUse[] {
  const body = sectionLines(templateText, surface).join('\n');
  const uses: PromptStylePlaceholderUse[] = [];
  for (const match of body.matchAll(placeholderPattern())) {
    const token = match[1];
    if (token !== undefined) uses.push({ token, surface });
  }
  return uses;
}

/**
 * Validates a style template, loudly and by name: an unknown placeholder, a
 * placeholder used on the wrong surface, a missing or duplicated section, text
 * outside the sections, a missing REQUIRED clause, or an empty template.
 *
 * Returns one message per problem (empty array = valid). The settings editor
 * refuses to save a template that fails this, and the composer runs the same
 * check before it injects anything, so an invalid template can never reach a
 * model through the back door.
 */
export function validatePromptStyleTemplate(
  templateText: string,
  surfaces: readonly PromptSurface[] = PROMPT_STYLE_SURFACES,
): string[] {
  const issues: string[] = [];
  if (templateText.trim() === '') {
    return ['The template is empty. A style needs both a --- SPINE --- and a --- PARTS --- section.'];
  }
  const lines = templateText.replaceAll('\r\n', '\n').split('\n');
  const markerLine = (line: string): PromptSurface | undefined =>
    PROMPT_STYLE_SURFACES.find((surface) => PROMPT_STYLE_SECTION_MARKERS[surface] === line.trim());

  const seen: Partial<Record<PromptSurface, number>> = {};
  let firstMarkerIndex = -1;
  for (const [index, line] of lines.entries()) {
    const surface = markerLine(line);
    if (surface === undefined) continue;
    if (firstMarkerIndex < 0) firstMarkerIndex = index;
    seen[surface] = (seen[surface] ?? 0) + 1;
  }
  for (const surface of surfaces) {
    const count = seen[surface] ?? 0;
    if (count === 0) {
      issues.push(`The template has no ${PROMPT_STYLE_SECTION_MARKERS[surface]} section.`);
    } else if (count > 1) {
      issues.push(
        `The template has ${PROMPT_STYLE_SECTION_MARKERS[surface]} ${String(count)} times; each section may appear once.`,
      );
    }
  }
  if (firstMarkerIndex > 0) {
    const outside = lines
      .slice(0, firstMarkerIndex)
      .filter((line) => line.trim() !== '')
      .join(' / ');
    if (outside !== '') {
      issues.push(
        `Text sits outside the sections ("${outside}") — every line belongs under ${PROMPT_STYLE_SECTION_MARKERS.spine} or ${PROMPT_STYLE_SECTION_MARKERS.parts}.`,
      );
    }
  }

  for (const surface of surfaces) {
    if ((seen[surface] ?? 0) === 0) continue;
    for (const use of placeholderUses(templateText, surface)) {
      const entry = promptStylePlaceholder(use.token);
      if (entry === undefined) {
        issues.push(`Unknown placeholder {{${use.token}}} in the ${surface} section.`);
      } else if (!placeholderFits(use.token, surface)) {
        issues.push(
          `{{${use.token}}} is a ${entry.surface} placeholder and has no value in the ${surface} section.`,
        );
      }
    }
    const used = new Set(placeholderUses(templateText, surface).map((use) => use.token));
    for (const token of requiredPlaceholders(surface)) {
      if (!used.has(token)) {
        const entry = promptStylePlaceholder(token);
        issues.push(
          `The ${surface} section is missing {{${token}}} (${entry?.summary ?? 'required clause'}).`,
        );
      }
    }
  }
  return issues;
}

// --- Composition -------------------------------------------------------------

/** Which layer produced one stretch of a composed prompt (preview marking only). */
export type ComposedPromptLayer = 'data' | 'contract' | 'style' | 'blank';

/** One stretch of one line — a line can mix a style sentence and a clause. */
export interface ComposedPromptSegment {
  layer: ComposedPromptLayer;
  text: string;
}

/** One composed line, split into the layers that produced it (preview only). */
export interface ComposedPromptLine {
  segments: readonly ComposedPromptSegment[];
}

export interface ComposedPrompt {
  /** The exact text the model receives — the ONLY thing that matters. */
  text: string;
  /** The same text line by line, tagged by layer, for the settings preview. */
  lines: readonly ComposedPromptLine[];
  /** True when at least one line carries a contract clause. */
  hasContract: boolean;
}

/** The value map the composer injects: present-but-empty is '', absent is null. */
export type PromptStyleValues = Readonly<Record<string, string | null>>;

/** A paragraph that is nothing but one placeholder, or undefined. */
function solePlaceholder(text: string): string | undefined {
  const match = new RegExp(`^${PLACEHOLDER_SOURCE}$`).exec(text.trim());
  return match?.[1];
}

/**
 * Composes one surface's prompt from a style template and the values the run
 * provides.
 *
 * Omission semantics (pinned — this is pre-style behavior, not a fallback, and
 * the classic identity test proves all three cases byte for byte):
 *
 * - a placeholder ALONE on its own paragraph disappears when its value is
 *   absent or empty, exactly as a null entry was dropped from the pre-style
 *   message array;
 * - a placeholder alone on a LINE inside a paragraph renders an EMPTY LINE,
 *   exactly as a null entry inside a joined block did (this is what the
 *   pre-style disabled-floor part prompt looks like);
 * - a placeholder inside a sentence is substituted in place, so a clause that
 *   renders empty (a disabled encounter floor in the spine section) leaves the
 *   sentence around it intact.
 *
 * A placeholder with NO value entry at all is a loud error: that is a composer
 * wiring bug, never something to paper over (AGENTS rule 1). An ABSENT value
 * (null) inside a sentence is a loud error too — the author put a
 * run-conditional placeholder where it cannot be omitted.
 */
export function composePromptFromTemplate(args: {
  templateText: string;
  surface: PromptSurface;
  values: PromptStyleValues;
}): ComposedPrompt {
  const issues = validatePromptStyleTemplate(args.templateText);
  if (issues.length > 0) {
    throw new Error(`Prompt style template is invalid: ${issues.join(' ')}`);
  }
  const body = sectionLines(args.templateText, args.surface).join('\n');
  const layers = new Map<string, ComposedPromptLayer>();
  /** Each entry is one OUTPUT line: the injected text never splits a line. */
  const out: ComposedPromptSegment[][] = [];

  /** The value for a token, with the layer it renders as. */
  const valueOf = (token: string): { value: string | null; layer: ComposedPromptLayer } => {
    const value = args.values[token];
    if (value === undefined) {
      throw new Error(
        `The ${args.surface} prompt uses {{${token}}} but the composer injected no value for it`,
      );
    }
    let layer = layers.get(token);
    if (layer === undefined) {
      layer = promptStylePlaceholder(token)?.layer === 'contract' ? 'contract' : 'data';
      layers.set(token, layer);
    }
    return { value, layer };
  };

  /** One segment of one output line, merging with the previous same-layer run. */
  const pushSegment = (
    segments: ComposedPromptSegment[],
    layer: ComposedPromptLayer,
    text: string,
  ): void => {
    if (text === '') return;
    const previous = segments[segments.length - 1];
    if (previous?.layer === layer) previous.text += text;
    else segments.push({ layer, text });
  };

  /** One template line, with its inline tokens substituted in place. */
  const lineSegments = (line: string): ComposedPromptSegment[] => {
    const matches = [...line.matchAll(placeholderPattern())];
    if (matches.length === 0) return [{ layer: 'style', text: line }];
    const segments: ComposedPromptSegment[] = [];
    let cursor = 0;
    for (const match of matches) {
      const at = match.index;
      const token = match[1];
      if (token === undefined) continue;
      pushSegment(segments, 'style', line.slice(cursor, at));
      const { value, layer } = valueOf(token);
      if (value === null) {
        throw new Error(
          `{{${token}}} has no value in this run and sits inside a sentence of the ${args.surface} prompt — put it on its own line so it can be omitted`,
        );
      }
      // A multi-line value keeps its own lines (a data block placed inline).
      const parts = value.split('\n');
      pushSegment(segments, layer, parts[0] ?? '');
      for (const part of parts.slice(1)) {
        out.push(segments.splice(0, segments.length));
        pushSegment(segments, layer, part);
      }
      cursor = at + match[0].length;
    }
    pushSegment(segments, 'style', line.slice(cursor));
    return segments.length === 0 ? [{ layer: 'style', text: '' }] : segments;
  };

  let first = true;
  for (const paragraph of body.split(/\n{2,}/)) {
    const paragraphLines: ComposedPromptSegment[][] = [];
    const sole = solePlaceholder(paragraph);
    if (sole !== undefined) {
      const { value, layer } = valueOf(sole);
      if (value !== null && value !== '') {
        for (const line of value.split('\n')) paragraphLines.push([{ layer, text: line }]);
      }
    } else {
      for (const line of paragraph.split('\n')) {
        const lineSole = solePlaceholder(line);
        if (lineSole === undefined) {
          paragraphLines.push(lineSegments(line));
          continue;
        }
        const { value, layer } = valueOf(lineSole);
        if (value === null || value === '') {
          // A conditional LINE inside a block keeps its place and renders
          // EMPTY — exactly how the pre-style builders rendered one (a null
          // entry inside a joined block is the empty string). A paragraph that
          // is nothing BUT such lines still disappears below.
          paragraphLines.push([{ layer: 'style', text: '' }]);
          continue;
        }
        for (const injected of value.split('\n')) paragraphLines.push([{ layer, text: injected }]);
      }
    }
    // A paragraph whose every line vanished disappears, exactly as a null item
    // used to disappear from the message array.
    if (
      paragraphLines.every((segments) =>
        segments.every((segment) => segment.text.trim() === ''),
      )
    ) {
      continue;
    }
    if (!first) out.push([{ layer: 'blank', text: '' }]);
    first = false;
    out.push(...paragraphLines);
  }

  const lines: ComposedPromptLine[] = out.map((segments) => ({ segments }));
  return {
    text: out.map((segments) => segments.map((segment) => segment.text).join('')).join('\n'),
    lines,
    hasContract: layers.size > 0 && [...layers.values()].includes('contract'),
  };
}
