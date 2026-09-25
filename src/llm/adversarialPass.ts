import { z } from 'zod';

import type { Id, ModuleDocumentVersion } from '@/domain';
import { snapshotModuleVersion } from '@/db/moduleVersionRepo';
import { getSettings } from '@/db/settingsRepo';
import { transformModuleText } from '@/llm/canvasRefine';
import { parseJsonReply } from '@/llm/jsonReply';
import { chat, type ChatMessage } from '@/llm/openrouter';
import { recordGlobalChatModelInUse } from '@/llm/recentChatModel';
import { schemaResponseFormat } from '@/llm/strictSchema';

/**
 * The ADVERSARIAL critique-and-edit pass (docs/17 rows 352/353, row 356): ONE
 * callable seam that reviews one piece of module text against EXACTLY the
 * owner's four criteria and, only when the critique found something, hands the
 * findings to the ONE existing text-transform core
 * (`llm/canvasRefine.transformModuleText`) for a rewrite.
 *
 * THE CRITIQUE IS ADVISORY. Findings are an INPUT to the editor, never a
 * verdict: a critique that finds issues does not throw and does not block
 * anything, and an empty `issues` array is a normal, quiet outcome — the pass
 * then returns WITHOUT calling the editor and without writing. The loud
 * failures are the BOUNDARY ones (AGENTS rules 1/3): a critique reply that
 * fails its zod contract, and an editor reply the core rejects. A caller that
 * sees one marks its unit failed and continues (slice 357); the target text is
 * left UNCHANGED on every path — this seam never writes, the WRITE is the
 * caller's business.
 *
 * THE FOUR CRITERIA ARE THE WHOLE ENUM and nothing else: `inconsistency`,
 * `motivation`, `fun`, `originality` — no pacing, no fairness, no separate
 * "is the story conflicted" dimension, no ratios and no cardinality. That is
 * the owner's instruction (docs/17 row 353, verbatim: *"I do not want the
 * criteria you just mentioned, just the ones I posted."*), and the schema below
 * is where it is mechanical: a fifth member, or a schema that would accept an
 * unknown kind, is a defect.
 *
 * THE CALL PATTERN is module generation's own (`moduleGen`'s normalization
 * call): `getSettings().defaultChatModel` + the strict structured-output schema
 * + `defaultReasoningEffort`, through `chat` — NOT a persona, NOT a new persona
 * mode and NOT a run-engine step (module generation is deliberately not built
 * on personas/runEngine, `moduleGen.ts:102`). There is deliberately NO repair
 * turn: a malformed reply is a loud boundary failure, like the editor core's.
 *
 * THE SNAPSHOT is taken FIRST, through the ONE durable snapshot seam
 * (`db/moduleVersionRepo.snapshotModuleVersion`) and before the critique — so
 * whenever the caller persists the returned replacement, the pre-change state
 * is already on the stack (docs/18 §2.3). KNOWN BOUNDARY, named because a
 * future reader will hit it: that seam captures the module's PARTS document and
 * the spine PREMISE is excluded by design (`domain/moduleVersion`), so a
 * premise-target pass records the parts state but not the premise itself.
 *
 * THE GUARD IS NOT HERE. The pass calls the transform CORE, not
 * `refineModuleText`: it runs INSIDE generation (docs/17 row 353), when the
 * canvas surface's busy guard would refuse. Same core, two callers.
 */

/**
 * The owner's four criteria — the COMPLETE list (docs/17 row 353). The order is
 * the order he posted them in, and the tuple is asserted by the pass's pins, so
 * a fifth member cannot be added without a conscious edit.
 */
export const ADVERSARIAL_ISSUE_KINDS = [
  'inconsistency',
  'motivation',
  'fun',
  'originality',
] as const;

export const adversarialIssueKindSchema = z.enum(ADVERSARIAL_ISSUE_KINDS);

export type AdversarialIssueKind = z.infer<typeof adversarialIssueKindSchema>;

/**
 * One finding: what was judged (`kind`), how badly (`severity`), in the
 * critic's OWN words (`message`) and where in the text it applies (`where`).
 * Small and honest — the editor reads `message`/`where`, a human reads them
 * too. The two levels of severity are the continuity report's own convention
 * (`llm/schemas.ts`), not a new vocabulary.
 */
export const adversarialIssueSchema = z.object({
  kind: adversarialIssueKindSchema,
  severity: z.enum(['minor', 'major']),
  message: z.string().min(1),
  where: z.string().min(1),
});

export type AdversarialIssue = z.infer<typeof adversarialIssueSchema>;

/**
 * The critique reply: a list, and nothing else. `issues: []` is the honest
 * "nothing to fault" answer and is the ONLY way the reply carries no findings —
 * the pass reads it as a quiet success, never as a failure.
 */
export const adversarialCritiqueReplySchema = z.object({
  issues: z.array(adversarialIssueSchema),
});

/**
 * What the pass reviews: the module PREMISE (a document in its own right, not a
 * part — `features/modules/module-problems.PREMISE_WHERE`) or one PART by its
 * plan index.
 */
export type AdversarialTarget = { kind: 'premise' } | { kind: 'part'; planIndex: number };

export interface AdversarialPassInput {
  moduleId: Id;
  target: AdversarialTarget;
  /** The CURRENT text of the target — exactly what the critique reads and the
   * editor rewrites. Empty text is a caller bug and fails loudly. */
  text: string;
  /** The owning run's abort controller signal (a stop is not a failure). */
  signal?: AbortSignal | undefined;
}

export interface AdversarialPassReport {
  moduleId: Id;
  target: AdversarialTarget;
  /** The text the pass was given, returned unchanged — the pass never writes. */
  originalText: string;
  /** The durable pre-change snapshot, taken through the ONE snapshot seam
   * BEFORE the critique (and therefore before any caller write). `null` only
   * for a module with no planned parts (the snapshot seam's own contract). */
  snapshot: ModuleDocumentVersion | null;
  critique: {
    issues: AdversarialIssue[];
    /** The model that served the critique, never a settings lookup. */
    modelUsed: string;
  };
  /** The editor's validated replacement, or `null` when the critique found
   * nothing — in which case the editor was NOT called. */
  edit: { replacement: string; modelUsed: string } | null;
}

/** Names the target the way the reader names it ("premise", "part 2"). */
export function adversarialTargetLabel(target: AdversarialTarget): string {
  return target.kind === 'premise' ? 'premise' : `part ${String(target.planIndex + 1)}`;
}

/**
 * Runs the pass for one target: snapshot → critique → (only when the critique
 * found something) editor → report. Nothing is written and nothing is thrown
 * for a FINDING; only a boundary failure throws (see the file header).
 */
export async function runAdversarialPass(
  input: AdversarialPassInput,
): Promise<AdversarialPassReport> {
  const label = adversarialTargetLabel(input.target);
  if (input.text.trim() === '') {
    throw new Error(`the adversarial pass needs the current text of the ${label}`);
  }
  // The durable pre-change snapshot, BEFORE the critique (docs/18 §2.3): the
  // caller that persists the replacement writes over a state that is already
  // recorded. Loud on failure — never a rewrite whose pre-state was not saved.
  const snapshot = await snapshotModuleVersion(
    input.moduleId,
    'generation',
    `Adversarial pass: ${label}`,
  );

  const settings = await getSettings();
  // The pass is one global-model chat call outside the run funnel, so the model
  // in play is recorded here (docs/17 row 198).
  recordGlobalChatModelInUse(settings.defaultChatModel);
  const { text: raw, modelUsed: critiqueModel } = await chat(
    critiqueMessages(input.target, input.text),
    {
      model: settings.defaultChatModel,
      // A critic, not a writer: lower than the forge's creative 0.8 so the
      // findings stay close to what the text actually says.
      temperature: 0.3,
      reasoningEffort: settings.defaultReasoningEffort,
      responseFormat: schemaResponseFormat('adversarial-critique', adversarialCritiqueReplySchema),
      signal: input.signal,
    },
  );
  // Boundary validation: a malformed critique is a loud failure (AGENTS 3),
  // never a silent "no issues found".
  const critique = adversarialCritiqueReplySchema.parse(parseJsonReply(raw));

  if (critique.issues.length === 0) {
    // ADVISORY and quiet: nothing to fault means the editor is never called and
    // the target text is untouched.
    return {
      moduleId: input.moduleId,
      target: input.target,
      originalText: input.text,
      snapshot,
      critique: { issues: [], modelUsed: critiqueModel },
      edit: null,
    };
  }

  // The editor is the EXISTING text-transform core — the same seam the canvas
  // refine rides — never a second editor prompt or reply schema.
  const edit = await transformModuleText({
    target: input.target.kind,
    instruction: editInstruction(input.target, critique.issues),
    text: input.text,
    // The findings carry the context; the whole-document targets take no
    // enclosing block.
    enclosingBlock: '',
    signal: input.signal,
  });

  return {
    moduleId: input.moduleId,
    target: input.target,
    originalText: input.text,
    snapshot,
    critique: { issues: critique.issues, modelUsed: critiqueModel },
    edit,
  };
}

/** The editor's instruction: the findings, as a structured list — never parsed
 * back out of prose (AGENTS rule 5), and never a bare summary that would lose
 * which passage each finding came from. */
function editInstruction(target: AdversarialTarget, issues: readonly AdversarialIssue[]): string {
  const label = adversarialTargetLabel(target);
  const findings = issues.map(
    (issue) =>
      `- [${issue.severity}] ${issue.kind}: ${issue.message} (at: ${issue.where})`,
  );
  return [
    `An adversarial critique reviewed this module ${label} and found these issues:`,
    ...findings,
    `Rewrite the ${label} so every listed issue is resolved. Keep everything the critique did not fault, and keep every [[wiki-link]] token's canonical spelling.`,
  ].join('\n');
}

/** The critic's prompt: the target text, EXACTLY the four criteria, and the
 * one-field-list reply contract. No score, no count, no fifth dimension. */
function critiqueMessages(target: AdversarialTarget, text: string): ChatMessage[] {
  const label = adversarialTargetLabel(target);
  const instruction = [
    `Module ${label} under review:\n${text}`,
    [
      'Judge it ONLY against these four criteria — no other dimension, no score, no count:',
      '- inconsistency: a fact, name, place, relationship or event that contradicts another statement in the reviewed text.',
      '- motivation: a character, faction or event whose reason to act is missing, unclear or not believable.',
      '- fun: a scene, hook, challenge or reward a table would not enjoy playing through.',
      '- originality: a premise, twist or element that is a stock cliché rather than something fresh.',
    ].join('\n'),
    'Report only real problems you can point at in the text. If it is sound against all four criteria, return an empty issues array — never invent a problem to fill the list.',
    'Reply with ONLY a JSON object: { "issues": [{ "kind": "inconsistency" | "motivation" | "fun" | "originality", "severity": "minor" | "major", "message": string, "where": string }] } — "message" states the problem in your own words, "where" names the passage it applies to.',
  ].join('\n\n');
  return [
    {
      role: 'system',
      content:
        'You are a ruthless but fair editor for tabletop RPG modules. You find real ' +
        'problems in GM-facing module text and you never invent one. You answer in the ' +
        'exact JSON format requested and never add commentary outside it.',
    },
    { role: 'user', content: instruction },
  ];
}
