import { z } from 'zod';

import {
  DOCUMENT_PLAN_ROLES,
  documentPlanIssues,
  moduleDocumentPlanReplySchema,
  type AnyArtifact,
  type Battle,
  type DocumentPlanContext,
  type Id,
  type Module,
  type ModuleDocumentPlan,
} from '@/domain';
import { getModule } from '@/db/moduleRepo';
import { getSettings } from '@/db/settingsRepo';
import { chat, type ChatMessage } from '@/llm/openrouter';
import { ModuleBusyError } from '@/llm/moduleGen';
import {
  claimModuleGeneration,
  registerCanvasAbort,
  releaseModuleGeneration,
} from '@/llm/canvasBusy';
import { parseJsonReply, parseErrorSummary } from '@/llm/jsonReply';
import { schemaResponseFormat } from '@/llm/strictSchema';
import { debrisIssuesForFields } from '@/lib/encodingHygiene';
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
 * - the plan never reaches the row from here: the caller persists the returned
 *   plan (`patchModule`), so a failed call writes nothing at all.
 * - ONE generation per module: the shared `canvasBusy` registry is claimed
 *   synchronously at entry (`ModuleBusyError` when another canvas generation
 *   holds the module) and the turn is registered for "Stop all" through the
 *   same abort registry every other canvas turn uses.
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

/** The number of parts/artifacts one prompt lists before it says how many it cut. */
const INVENTORY_CAP = 120;

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
    const messages = modulePlanMessages({ module, scopedArtifacts: scoped, images });
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
    const issues = debrisIssuesForFields(
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
 * ONE prompt builder: the strict contract's rules, the role vocabulary and the
 * inventory of what actually exists. Exported so a test can read exactly what
 * the model is allowed to decide instead of trusting a comment.
 */
export function modulePlanMessages(input: {
  module: Module;
  scopedArtifacts: readonly AnyArtifact[];
  images: readonly { id: Id; where: string }[];
}): ChatMessage[] {
  const { module, scopedArtifacts, images } = input;
  const partPlan = module.spine?.partPlan ?? [];
  const rules = [
    'You are the layout planner for a tabletop RPG module PDF. You return ONLY the requested JSON object.',
    'The plan decides STRUCTURE and nothing else: which sections the document has, in which order, what each section is called, what each section is about, and which of the module’s existing images prints in which section.',
    ...MODULE_PLAN_PROHIBITIONS.map((rule) => `- ${rule}`),
    '',
    'Every section has a "source" naming ONE thing that already exists, by the ids in the inventory below:',
    '- {"type":"part","planIndex":N} — a part of the module’s own part plan (planIndex -1 is the premise).',
    '- {"type":"artifact","artifactId":"…"} — a row listed under ARTIFACTS.',
    '- {"type":"encounter","artifactId":"…"} — a row listed under ENCOUNTERS.',
    'An id or index that is not in the inventory fails the WHOLE plan — the app never guesses what you meant.',
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

  // The premise rides the prompt at a larger cap than a summary: it is the
  // module's own statement of what the document is about, and a plan is
  // decided from it.
  const premise = oneLine((module.spine?.premise ?? '').trim(), 600);
  const parts: string[] = [
    `Premise (planIndex -1): ${premise === '' ? '(none — the spine pass has not run)' : premise}`,
  ];
  for (const [index, part] of partPlan.entries()) {
    const synopsis = part.synopsis.trim() === '' ? '' : ` · ${oneLine(part.synopsis)}`;
    parts.push(
      `- planIndex ${String(index)}: “${part.title}” · levels ${part.levelBand}${synopsis}`,
    );
  }

  const artifactLines = scopedArtifacts
    .filter((artifact) => artifact.kind !== 'encounter')
    .slice(0, INVENTORY_CAP)
    .map((artifact) => `- ${artifact.id} · ${artifact.kind} · “${artifact.name}”${summaryTail(artifact)}`);
  const encounterLines = scopedArtifacts
    .filter((artifact) => artifact.kind === 'encounter')
    .slice(0, INVENTORY_CAP)
    .map((artifact) => {
      const difficulty = [artifact.data.difficulty, artifact.data.levelHint]
        .filter((part) => part !== '')
        .join(' · ');
      return `- ${artifact.id} · “${artifact.name}”${difficulty === '' ? '' : ` · ${difficulty}`}`;
    });

  const user = [
    'THE MODULE',
    `Title: ${module.title}`,
    `Concept: ${module.concept.trim() === '' ? '(none)' : oneLine(module.concept)}`,
    `Levels ${String(module.levelMin)}–${String(module.levelMax)}${module.tone.trim() === '' ? '' : ` · ${module.tone}`}`,
    '',
    'ITS PARTS',
    ...parts,
    '',
    `ARTIFACTS (${String(artifactLines.length)} of ${String(scopedArtifacts.filter((a) => a.kind !== 'encounter').length)})`,
    ...(artifactLines.length === 0 ? ['(none)'] : artifactLines),
    '',
    `ENCOUNTERS (${String(encounterLines.length)})`,
    ...(encounterLines.length === 0 ? ['(none)'] : encounterLines),
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

/** A one-line excerpt for the prompt: never a wall of prose, never silent. */
function oneLine(text: string, cap = 160): string {
  const flat = text.replaceAll(/\s+/g, ' ').trim();
  return flat.length <= cap ? flat : `${flat.slice(0, cap)}…`;
}

/** The artifact's summary as a prompt tail ('' when it has none). */
function summaryTail(artifact: AnyArtifact): string {
  const summary = artifact.summary.trim();
  return summary === '' ? '' : ` · ${oneLine(summary)}`;
}
