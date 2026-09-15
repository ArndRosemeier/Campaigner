import { z } from 'zod';

import {
  DOCUMENT_PLAN_ROLES,
  documentPlanIssues,
  moduleDocumentPlanReplySchema,
  moduleDocumentText,
  type AnyArtifact,
  type Battle,
  type DocumentPlanContext,
  type Id,
  type Module,
  type ModuleDocumentPlan,
} from '@/domain';
import { WIKI_GRAPH_NODE_CAP, buildWikiGraph, wikiGraphNodeLabel } from '@/domain/wikiGraph';
import { getModule, patchModule } from '@/db/moduleRepo';
import { getSettings } from '@/db/settingsRepo';
import { chat, type ChatMessage } from '@/llm/openrouter';
import { ModuleBusyError } from '@/llm/moduleGen';
import { renderStoredArtifactSection } from '@/llm/canvasChat';
import {
  claimModuleGeneration,
  registerCanvasAbort,
  releaseModuleGeneration,
} from '@/llm/canvasBusy';
import { parseJsonReply, parseErrorSummary } from '@/llm/jsonReply';
import { schemaResponseFormat } from '@/llm/strictSchema';
import { generatedTextScanForFields } from '@/llm/generatedTextHygiene';
import { modulePdfArtifacts, modulePdfImageRequests } from '@/lib/modulePdf';

/**
 * The DOCUMENT PLANNER (docs/17 row 109, docs/07 §M3-D): the ONE writer of a
 * module's document plan, and the only place in the app that asks a model to
 * decide a DOCUMENT'S STRUCTURE.
 *
 * The owner's ratified boundary lives here: the model decides what the plan
 * says and NOTHING about how it prints. It is told, in the prompt below, what
 * it may decide (the sections, their order, their titles, their roles, their
 * audience, which existing image prints where) and what it may not (it does
 * not write content, it does not edit the module, it does not invent a
 * section that references nothing). Everything it decides is then visible in
 * the module's "Document plan" surface and re-renderable byte-for-byte — the
 * reason a plan is DATA rather than model-authored rendering.
 *
 * Contract rules (binding, AGENTS 1/3):
 * - the settings model + the default escalation chain + strict structured
 *   outputs, all inside `chat`/`schemaResponseFormat`. No private transport.
 * - the reply is parsed with zod AT THIS BOUNDARY: an invalid JSON reply, a
 *   shape failure, or a plan naming something that is not there THROWS. There
 *   is no coercion, no repair, no partial plan and no defaulted section.
 * - the plan never reaches the row from `planModuleDocument`: it returns the
 *   validated plan, so a failed call writes nothing at all.
 *   `planAndStoreModuleDocument` is the ONE seam that persists it
 *   (`patchModule`), and BOTH callers — the export's automatic planning step
 *   and the "Document plan" surface's Regenerate — go through it, so the app
 *   has ONE plan write (docs/17 row 139).
 * - ONE generation per module: the shared `canvasBusy` registry is claimed
 *   synchronously at entry (`ModuleBusyError` when another canvas generation
 *   holds the module) and the turn is registered for "Stop all" through the
 *   same abort registry every other canvas turn uses.
 *
 * THE PLANNER'S TOOLKIT (docs/17 row 169, docs/19 §6): the ONE call now carries
 * real CONTENT, not one-line excerpts — the module's own text through the
 * shared reader (`moduleDocumentText`), the part↔entity structure through the
 * ONE graph derivation (`domain/wikiGraph.buildWikiGraph`) and each scoped
 * row's real stored fields through the CANVAS CHAT's own renderer
 * (`renderStoredArtifactSection` — the same one its `<request>` answer uses),
 * so no second retrieval mechanism exists (AGENTS rule 4). The plan contract,
 * its validation, its one write and its renderer are untouched: the content
 * changes what the model can JUDGE, never what it may decide.
 */

/** The strict structured-output contract name for the planner. */
export const MODULE_PLAN_CONTRACT_NAME = 'module-document-plan';

/**
 * The reply the model must return: the plan's sections, without the app's own
 * provenance fields (see `moduleDocumentPlanReplySchema`).
 */
export const modulePlannerReplySchema = moduleDocumentPlanReplySchema;

export type ModulePlannerReply = z.infer<typeof modulePlannerReplySchema>;

export interface ModulePlanInput {
  moduleId: Id;
  /**
   * The rows the document may draw from (the campaign's artifacts plus the
   * shared library). The planner scopes them ITSELF through the renderer's own
   * rule (`modulePdfArtifacts`), so the inventory it offers can never name a
   * row the document could not print.
   */
  artifacts: readonly AnyArtifact[];
  /** The module's live battle, when one exists (a board map is an image). */
  battles?: readonly Battle[];
  /**
   * The caller's per-turn controller. REQUIRED, exactly as `canvasRefine`
   * requires it: the app-level sweep reaches canvas turns through the
   * `canvasBusy` abort registry, so a call without one would hand the owner a
   * generation "Stop all" cannot stop.
   */
  turn: AbortController;
}

/**
 * The hard cap (characters) on the CONTENT the planner's ONE call may carry:
 * the module's own text, the wiki-graph link map and each row's real stored
 * fields, assembled in that priority order. It is LOUD (AGENTS rule 1): a
 * section that alone exceeds the cap is included CUT, and every section that
 * no longer fits is NAMED in a marker — never a silent trim. The shape is the
 * canvas chat's own `MAX_DETAILS_BLOCK_CHARS` markers (`[TRUNCATED — …]` /
 * `[BLOCK FULL — …]`), not a second convention.
 */
export const MODULE_PLAN_CONTENT_BUDGET_CHARS = 48000;

/** Room reserved for the loud marker when a single section exceeds the cap. */
const MODULE_PLAN_CONTENT_MARKER_ROOM = 400;

/** The separator between content sections. */
const MODULE_PLAN_CONTENT_SEPARATOR = '\n\n';

/** How many dropped names the `[BLOCK FULL]` marker spells out before counting. */
const MODULE_PLAN_DROPPED_NAMES_IN_MARKER = 20;

/** One labeled block of the planner's injected content. */
export interface ModulePlanContentSection {
  /** The `=== … ===` heading; also the name the marker uses when it is cut. */
  label: string;
  /** The section body (verbatim stored content). */
  text: string;
}

/** What the assembler decided about one section. */
export interface ModulePlanContentSectionStatus {
  label: string;
  status: 'included' | 'dropped' | 'truncated';
}

export interface ModulePlanContentBlock {
  /** The assembled content, markers included. */
  text: string;
  /** Per-section outcome, in input order. */
  sections: ModulePlanContentSectionStatus[];
}

/** The rendered form of one content section (the ONE spelling). */
function renderedContentSection(section: ModulePlanContentSection): string {
  return `=== ${section.label} ===\n${section.text}`;
}

/**
 * Assembles the injected content under the hard cap, mirroring the chat's
 * `assembleRequestedDetailsBlock` exactly: sections render in priority order;
 * the first one that does not fit ends the block and every later section is
 * NAMED in the `[BLOCK FULL — …]` marker; a FIRST section that alone exceeds
 * the cap is included CUT (room for the marker is reserved, so the marker is
 * never the thing that gets cut) under the `[TRUNCATED — …]` marker; everything
 * fits ⇒ no marker at all.
 */
export function assembleModulePlanContent(
  sections: readonly ModulePlanContentSection[],
): ModulePlanContentBlock {
  const rendered: string[] = [];
  const statuses: ModulePlanContentSectionStatus[] = [];
  const dropped: string[] = [];
  let used = 0;
  let stopped = false;
  let truncated: string | null = null;
  for (const section of sections) {
    if (stopped) {
      statuses.push({ label: section.label, status: 'dropped' });
      dropped.push(section.label);
      continue;
    }
    const text = renderedContentSection(section);
    const cost =
      rendered.length === 0 ? text.length : text.length + MODULE_PLAN_CONTENT_SEPARATOR.length;
    if (used + cost <= MODULE_PLAN_CONTENT_BUDGET_CHARS) {
      rendered.push(text);
      used += cost;
      statuses.push({ label: section.label, status: 'included' });
      continue;
    }
    stopped = true;
    if (rendered.length === 0) {
      rendered.push(
        text.slice(
          0,
          Math.max(0, MODULE_PLAN_CONTENT_BUDGET_CHARS - MODULE_PLAN_CONTENT_MARKER_ROOM),
        ),
      );
      truncated = section.label;
      statuses.push({ label: section.label, status: 'truncated' });
      continue;
    }
    statuses.push({ label: section.label, status: 'dropped' });
    dropped.push(section.label);
  }
  const markers: string[] = [];
  if (truncated !== null) {
    markers.push(
      `[TRUNCATED — «${truncated}» alone exceeds the planner's ${String(MODULE_PLAN_CONTENT_BUDGET_CHARS)}-character content cap, so that block above is CUT MID-WAY and the remainder was NOT sent. Never treat the cut block as complete and never invent its missing content.]`,
    );
  }
  if (dropped.length > 0) {
    const named = dropped.slice(0, MODULE_PLAN_DROPPED_NAMES_IN_MARKER);
    const rest = dropped.length - named.length;
    markers.push(
      `[BLOCK FULL — the planner's content reached its ${String(MODULE_PLAN_CONTENT_BUDGET_CHARS)}-character cap, so these blocks were NOT sent: ${named.map((label) => `«${label}»`).join(', ')}${rest === 0 ? '' : `, and ${String(rest)} more`}. Name only a row you were shown, and never invent a row you did not receive.]`,
    );
  }
  return { text: [...rendered, ...markers].join(MODULE_PLAN_CONTENT_SEPARATOR), sections: statuses };
}

/** The `=== … ===` heading of one row: the id the plan's `source` must use. */
function artifactContentLabel(artifact: AnyArtifact): string {
  return `${artifact.kind === 'encounter' ? 'ENCOUNTER' : 'ARTIFACT'} ${artifact.id} — «${artifact.name}» (${artifact.kind})`;
}

/** The named line for a row whose every stored field is empty (never dropped). */
function emptyArtifactLine(artifact: AnyArtifact): string {
  return `- ${artifact.id} · «${artifact.name}» (${artifact.kind}) — NOT RENDERED: the row stores no details at all (every stored field is empty; it is a bare stub). Never invent its content.`;
}

/**
 * The module's links, per document, from the ONE graph derivation
 * (`domain/wikiGraph.buildWikiGraph`) — never a second resolver. A name that
 * resolves names its kind and id; a library creature is named as one; an
 * unresolved link is named as having no row (the campaign's to-do list).
 */
function moduleLinkLines(input: { module: Module; pool: readonly AnyArtifact[] }): string[] {
  const graph = buildWikiGraph([input.module], input.pool, { moduleId: input.module.id });
  const titles = new Map<number, string>();
  for (const [index, part] of (input.module.spine?.partPlan ?? []).entries()) {
    titles.set(index, part.title);
  }
  const parts = input.module.parts.slice().sort((a, b) => a.planIndex - b.planIndex);
  const places = [
    { where: 'premise', label: 'premise' },
    ...parts.map((part) => ({
      where: `part-${String(part.planIndex)}`,
      label: `part ${String(part.planIndex)} “${titles.get(part.planIndex) ?? '(untitled)'}”`,
    })),
  ];
  const lines = places.map((place) => {
    const named = graph.nodes
      .filter((node) => node.mentionsByDocument.some((mention) => mention.where === place.where))
      .map((node) => {
        const label = wikiGraphNodeLabel(node);
        if (node.artifact !== undefined) {
          return `«${label}» (${node.artifact.kind} ${node.artifact.id})`;
        }
        if (node.creature !== undefined) {
          return `«${label}» (the library creature «${node.creature.name}», not a stored row)`;
        }
        return `«${label}» (no row — an unresolved wiki-link)`;
      });
    return `${place.label}: ${named.length === 0 ? '(nothing linked)' : named.join('; ')}`;
  });
  if (graph.truncated > 0) {
    lines.push(
      `(${String(graph.truncated)} further linked entities are beyond the graph's own ${String(WIKI_GRAPH_NODE_CAP)}-node cap and are not listed here.)`,
    );
  }
  return lines;
}

/**
 * The planner's injected content, in priority order: the module's OWN text
 * through the shared reader (`moduleDocumentText` — premise + every part), the
 * wiki-graph link map, then every scoped row's real stored fields through the
 * chat's own renderer. Rows past the cap are named, never dropped quietly; a
 * row that stores nothing is named as such. Expensive per-row resolution (an
 * encounter's roster stats, a cited creature's stat block) stops as soon as the
 * running cost passes the cap, so the reads a dropped row would need are never
 * spent.
 */
export async function modulePlanContentSections(input: {
  module: Module;
  scopedArtifacts: readonly AnyArtifact[];
  pool: readonly AnyArtifact[];
}): Promise<ModulePlanContentSection[]> {
  const byId = new Map(input.pool.map((candidate) => [candidate.id, candidate] as const));
  const sections: ModulePlanContentSection[] = [
    {
      label: 'THE MODULE’S OWN TEXT (premise + every part, verbatim, in planIndex order)',
      text: moduleDocumentText(input.module),
    },
    {
      label: 'WHAT THE MODULE LINKS TO (from the reader’s own wiki graph)',
      text: moduleLinkLines({ module: input.module, pool: input.pool }).join('\n'),
    },
  ];
  let used = sections.reduce(
    (sum, section) =>
      sum + renderedContentSection(section).length + MODULE_PLAN_CONTENT_SEPARATOR.length,
    0,
  );
  let stopped = used > MODULE_PLAN_CONTENT_BUDGET_CHARS;
  for (const artifact of input.scopedArtifacts) {
    const label = artifactContentLabel(artifact);
    if (stopped) {
      // Already over the cap: carry the LABEL so the marker names the row,
      // without spending the DB reads its block would need.
      sections.push({ label, text: '' });
      continue;
    }
    const { section, lines } = await renderStoredArtifactSection({
      artifact,
      requestedName: artifact.name,
      moduleId: input.module.id,
      byId,
    });
    const entry: ModulePlanContentSection = {
      label,
      text: lines.length === 0 ? emptyArtifactLine(artifact) : section,
    };
    used += renderedContentSection(entry).length + MODULE_PLAN_CONTENT_SEPARATOR.length;
    if (used > MODULE_PLAN_CONTENT_BUDGET_CHARS) stopped = true;
    sections.push(entry);
  }
  return sections;
}

/**
 * Runs the planner: returns the VALIDATED plan, with provenance stamped on it
 * (`plannedByModel` = the model that actually served the call, `plannedAt`),
 * and the model id. Throws loudly on busy, on a transport failure, on an
 * unparseable reply, on a shape failure, and on a plan that names a part,
 * artifact, encounter or image the module does not have.
 */
export async function planModuleDocument(
  input: ModulePlanInput,
): Promise<{ plan: ModuleDocumentPlan; modelUsed: string }> {
  if (input.turn.signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  // ONE generation per module, claimed SYNCHRONOUSLY before any await (two
  // concurrent planners must never both pass the check).
  claimModuleGeneration(input.moduleId);
  const handle = registerCanvasAbort(input.moduleId, input.turn);
  try {
    const module = await getModule(input.moduleId);
    if (module === undefined) {
      throw new Error('Module no longer exists');
    }
    if (module.status === 'generating') {
      throw new ModuleBusyError(input.moduleId);
    }
    if (module.spine === null) {
      // Nothing to structure: a module with no part plan has no premise and no
      // parts, so every plan it could produce would name something absent.
      throw new Error(
        'this module has no part plan yet (the spine pass has not run), so there is nothing to plan',
      );
    }
    const scoped = modulePdfArtifacts(module, input.artifacts);
    const images = modulePdfImageRequests({
      module,
      artifacts: input.artifacts,
      ...(input.battles === undefined ? {} : { battles: input.battles }),
    });
    const settings = await getSettings();
    const messages = await modulePlanMessages({
      module,
      scopedArtifacts: scoped,
      pool: input.artifacts,
      images,
    });
    const { text: raw, modelUsed } = await chat(messages, {
      model: settings.defaultChatModel,
      // Structural work, not prose: a low temperature keeps a re-plan close to
      // the document the module actually has.
      temperature: 0.2,
      reasoningEffort: settings.defaultReasoningEffort,
      responseFormat: schemaResponseFormat(MODULE_PLAN_CONTRACT_NAME, modulePlannerReplySchema),
      signal: handle.signal,
    });

    // Boundary validation (AGENTS 3): fail loud, never a coerced default.
    const reply = modulePlannerReplySchema.parse(parseJsonReply(raw));
    const { issues } = generatedTextScanForFields(
      reply.sections.map((section, index) => ({
        field: `sections.${String(index)}.title`,
        text: section.title,
      })),
    );
    if (issues.length > 0) {
      throw new Error(`the planner's reply was rejected — ${issues.join('; ')}`);
    }
    // Hard rule: a plan may only NAME things that exist (docs/17 row 109). A
    // plan naming a missing part, artifact, encounter or image is refused
    // WHOLE — the caller writes nothing and the owner is told by name.
    const context: DocumentPlanContext = {
      partPlan: module.spine.partPlan,
      hasPremise: module.spine.premise.trim() !== '',
      artifacts: scoped,
      imageIds: images.map((request) => request.id),
    };
    const referenceIssues = documentPlanIssues(reply.sections, context);
    if (referenceIssues.length > 0) {
      throw new Error(
        `the plan names something that does not exist — ${referenceIssues
          .slice(0, 3)
          .map((issue) => `${issue.where}: ${issue.reason}`)
          .join('; ')}`,
      );
    }
    return {
      plan: {
        sections: reply.sections,
        plannedByModel: modelUsed,
        plannedAt: Date.now(),
      },
      modelUsed,
    };
  } catch (error) {
    // A zod failure carries the issue list as raw JSON in `.message`; the
    // human-readable form is the seam's job (AGENTS: humanize at the seam).
    throw error instanceof z.ZodError
      ? new Error(`the planner's reply did not match the document plan: ${parseErrorSummary(error)}`)
      : error;
  } finally {
    handle.releaseHandle();
    releaseModuleGeneration(input.moduleId);
  }
}

/**
 * THE planning step: plan this module's document and STORE the result on the
 * row, returning the module row as it now stands. It exists because the export
 * no longer has a plan STEP (docs/17 row 139): `ModulePdfButton` calls this
 * before rendering and the "Document plan" surface's Regenerate calls it for
 * the same reason, so the plan+persist pair is spelled ONCE (AGENTS rule 4)
 * instead of at each surface.
 *
 * It is NOT a cache and must never be read as one (owner decision, docs/17 row
 * 139: *"I dont think we need a cache. Chances to do 2 reports on the same
 * module thats unchanged are VERY slim."*). **Every export plans, always** —
 * this seam takes no "is the stored plan still good?" decision, and a caller
 * may not add one: the stored plan is (a) the record of what the LAST export
 * decided, which is the only evidence when a book comes out badly, and (b) the
 * escape hatch that lets the app print the last book again without spending a
 * call, because the renderer applies whatever plan the row holds. A fresh call
 * therefore REPLACES the stored plan, which is the property row 139 records as
 * knowingly traded away: the same module exported twice yields two different
 * books.
 *
 * Failure is loud and writes nothing (AGENTS rules 1–3): this throws whatever
 * `planModuleDocument` throws — busy module, refused reply, a plan naming
 * something that does not exist — and the PREVIOUS plan stays exactly as it was
 * on the row, which is what makes the caller's fallback honest rather than a
 * cleared field.
 */
export async function planAndStoreModuleDocument(input: ModulePlanInput): Promise<Module> {
  const { plan } = await planModuleDocument(input);
  return patchModule(input.moduleId, { documentPlan: plan });
}

/**
 * What the model is told it may NOT do — kept in ONE constant so the prompt,
 * the surface's copy and a test read the same sentences.
 */
export const MODULE_PLAN_PROHIBITIONS: readonly string[] = [
  'You do not write, rewrite, summarise or translate any content — the app prints the module’s own text and the named row’s own text, verbatim.',
  'You do not change the module, its parts, its artifacts or its images; you choose only how the document is laid out.',
  'You do not invent a section that references nothing, and you never invent a part index, an artifact id or an image id.',
  'You do not choose typefaces, sizes, colours or margins — the renderer owns every typographic decision.',
];

/**
 * ONE prompt builder: the strict contract's rules, the role vocabulary, the
 * part index and the real CONTENT the model judges from — the module's own
 * text, the wiki-graph link map and every scoped row's stored fields (through
 * the chat's own renderer), under the loud content cap. Exported so a test can
 * read exactly what the model is allowed to decide instead of trusting a
 * comment.
 */
export async function modulePlanMessages(input: {
  module: Module;
  scopedArtifacts: readonly AnyArtifact[];
  /**
   * The reader's resolution pool (campaign artifacts + the shared library) —
   * what the wiki graph and the row renderer resolve against, exactly as the
   * chat's `<request>` answer does.
   */
  pool: readonly AnyArtifact[];
  images: readonly { id: Id; where: string }[];
}): Promise<ChatMessage[]> {
  const { module, scopedArtifacts, images } = input;
  const partPlan = module.spine?.partPlan ?? [];
  const rules = [
    'You are the layout planner for a tabletop RPG module PDF. You return ONLY the requested JSON object.',
    'The plan decides STRUCTURE and nothing else: which sections the document has, in which order, what each section is called, what each section is about, and which of the module’s existing images prints in which section.',
    ...MODULE_PLAN_PROHIBITIONS.map((rule) => `- ${rule}`),
    '',
    'Every section has a "source" naming ONE thing that already exists, by the ids in THE CONTENT below:',
    '- {"type":"part","planIndex":N} — a part of the module’s own part plan (planIndex -1 is the premise).',
    '- {"type":"artifact","artifactId":"…"} — the id on an `ARTIFACT …` content heading (any row whose kind is not "encounter").',
    '- {"type":"encounter","artifactId":"…"} — the id on an `ENCOUNTER …` content heading.',
    'An id or index that is not in the inventory fails the WHOLE plan — the app never guesses what you meant.',
    '',
    'THE CONTENT carries the module’s own text and each row’s real stored fields — read it before deciding what belongs together. The content has a hard character cap: a `[TRUNCATED …]` or `[BLOCK FULL …]` marker at its end names exactly what was left out. Name only a row whose block you were shown; never invent a row that was not sent.',
    '',
    'Every section has a "role", one of exactly these four (there are no others):',
    ...Object.entries({
      explanation: 'the body: explanatory prose about what the section names',
      'read-aloud': 'the module’s own narration, printed in the read-aloud box for the table',
      'gm-note': 'mechanical or GM-facing content, printed as a boxed GM note',
      aside: 'a short parenthetical insert, printed small and indented',
    }).map(([role, meaning]) => `- "${role}" — ${meaning}`),
    'A role changes how its section PRINTS, never what it contains: the same text is the same text under every role.',
    '',
    'Every section has an "audience": "all" (both the GM and the player document), "gm", or "player".',
    'Default: GM-only material — a row tagged gm-only, a note, a plot arc, an encounter’s tactics and treasure, a faction’s methods — is "gm"; everything else is "all".',
    'State the audience for every section: an audience you did not state is an audience nobody can review.',
    '',
    'Section "images" lists image ids from the IMAGE INVENTORY, in print order. An empty list prints no image.',
    '',
    'The order of the "sections" array IS the order of the document. Typical documents run 6–20 sections; a section is a place a reader turns to, not a paragraph.',
    `Reply with ONLY a JSON object: { "sections": [ { "title": string, "role": ${DOCUMENT_PLAN_ROLES.map(
      (role) => `"${role}"`,
    ).join(' | ')}, "audience": "all" | "gm" | "player", "source": { … }, "images": [ string ] } ] }`,
  ];

  // The part index: the planIndex a "part" source must name. The TITLES are the
  // index; the content itself rides THE CONTENT below (the module's own text).
  const parts: string[] = ['- planIndex -1: the premise'];
  for (const [index, part] of partPlan.entries()) {
    const synopsis = part.synopsis.trim() === '' ? '' : ` · ${oneLine(part.synopsis)}`;
    parts.push(
      `- planIndex ${String(index)}: “${part.title}” · levels ${part.levelBand}${synopsis}`,
    );
  }

  const contentSections = await modulePlanContentSections({
    module,
    scopedArtifacts,
    pool: input.pool,
  });
  const block = assembleModulePlanContent(contentSections);
  const statusByLabel = new Map(block.sections.map((entry) => [entry.label, entry.status] as const));
  const isSent = (artifact: AnyArtifact): boolean => {
    const status = statusByLabel.get(artifactContentLabel(artifact));
    return status === 'included' || status === 'truncated';
  };
  const artifactRows = scopedArtifacts.filter((artifact) => artifact.kind !== 'encounter');
  const encounterRows = scopedArtifacts.filter((artifact) => artifact.kind === 'encounter');

  const user = [
    'THE MODULE',
    `Title: ${module.title}`,
    `Concept: ${module.concept.trim() === '' ? '(none)' : oneLine(module.concept)}`,
    `Levels ${String(module.levelMin)}–${String(module.levelMax)}${module.tone.trim() === '' ? '' : ` · ${module.tone}`}`,
    '',
    'ITS PART PLAN (the planIndex values a "part" source may name)',
    ...parts,
    '',
    `ARTIFACTS (${String(artifactRows.filter(isSent).length)} of ${String(artifactRows.length)})`,
    ...(artifactRows.length === 0 ? ['(none)'] : []),
    `ENCOUNTERS (${String(encounterRows.filter(isSent).length)} of ${String(encounterRows.length)})`,
    ...(encounterRows.length === 0 ? ['(none)'] : []),
    '',
    'THE CONTENT — the module’s own text and each row’s real stored fields, verbatim. Each `=== … ===` heading names the id a "source" must use; the app prints exactly the text below it.',
    block.text,
    '',
    'IMAGE INVENTORY (ids the document can print)',
    ...(images.length === 0 ? ['(none)'] : images.map((image) => `- ${image.id} — ${image.where}`)),
    '',
    'Plan this module’s PDF.',
  ].join('\n');

  return [
    { role: 'system', content: rules.join('\n') },
    { role: 'user', content: user },
  ];
}

/** A one-line excerpt for an INDEX (a title or synopsis), never the content. */
function oneLine(text: string, cap = 160): string {
  const flat = text.replaceAll(/\s+/g, ' ').trim();
  return flat.length <= cap ? flat : `${flat.slice(0, cap)}…`;
}
