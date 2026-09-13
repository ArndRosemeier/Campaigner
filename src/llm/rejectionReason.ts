import { z } from 'zod';

import type { RunStep } from '@/domain';

/**
 * WHY a run step was refused — the ONE vocabulary, recorded by the site that
 * DECIDED the refusal (docs/17 row 152; docs/18 §2.2).
 *
 * THE DEFECT THIS CLOSES. The engine's user-visible sentence about a rejected
 * step used to say *"the model reply could not be parsed into the required
 * JSON shape after one automatic retry"* for EVERY rejection class that
 * reached the auto-autonomy branch — including refusals that have nothing to
 * do with JSON (the prompt-scaffolding echo of row 142, a monster with no
 * resolvable stat source, printed signed ability scores). The label was wrong
 * for most of them because a rejected step carried only `{ raw, issues }`: no
 * class existed to name.
 *
 * THE SEAM, and what it is NOT. A class is attached where the refusal is
 * RAISED — the branch that produced the issue list, or the detector that
 * produced it (`generatedTextScanForFields` returns the classes beside its
 * issues) — and a class that a deciding site genuinely cannot know is not
 * guessed here. This module therefore never inspects an issue STRING to work
 * out what happened: a second classifier rebuilt from the stored prose would
 * be a second, silent mechanism for one idea (AGENTS rule 4), and it would
 * drift the first time an issue is reworded.
 *
 * THE STORED SHAPE is additive and optional: a rejected step's `output`
 * already carried `{ raw, issues }`, and it may now carry `reasons`. Nothing
 * writes a default onto an old row and no reader invents one — a row written
 * before this seam records NOTHING, and `rejectedStepSentence` then says
 * exactly that instead of claiming JSON. No Dexie version: `personaRunSchema`
 * keeps `steps[].output` as `z.unknown()`, the `runs` table's index signature
 * (`id, campaignId, personaId, status, updatedAt`) does not reach into a
 * step's output, and the repo bumps a version only for an index/schema change
 * (docs/18 §1/§2.1).
 */

/**
 * Every class a run step can be refused for, in ONE array — the union, the
 * zod enum and the runtime membership check all read THIS list, so a class
 * cannot exist in one of the three and not the others.
 */
export const REJECTION_REASONS = [
  /** The reply never became the contract's JSON/schema (draft, stat block,
   * continuity report, encounter brief). */
  'invalid-json',
  /** A cited monster had no stat source this run could resolve. */
  'unresolved-source',
  /** A stat block printed signed ability values where a d20 score is
   * required (docs/17 row 95). */
  'ability-convention',
  /** The reply parsed, but broke the encounter brief's own contract: room
   * shape, roster, coverage or level budget. */
  'brief-contract',
  /** Half-formed unicode escapes in text about to be persisted
   * (`lib/encodingHygiene`). */
  'escape-debris',
  /** OUR OWN prompt scaffolding echoed back as content
   * (`llm/promptScaffolding`, docs/17 row 142). */
  'scaffolding-echo',
] as const;

export type RejectionReason = (typeof REJECTION_REASONS)[number];

export const rejectionReasonSchema = z.enum(REJECTION_REASONS);

const REASON_VALUES: ReadonlySet<string> = new Set<string>(REJECTION_REASONS);

/**
 * The clause each class contributes to the user-visible sentence. An
 * EXHAUSTIVE `Record` over the union: a class added to `REJECTION_REASONS`
 * without a clause here is a COMPILE ERROR, so "a class cannot be added
 * without a sentence" is enforced by the type system rather than by a review.
 *
 * Every clause names what was actually refused. The `invalid-json` clause is
 * the engine's historic wording BYTE FOR BYTE (its sentence is pinned by
 * `tests/llm/runNotCompletedReason.test.ts` and by the auto-run pins), so the
 * truthful cases did not move by one character when the wrong ones were fixed.
 */
export const REJECTION_CLAUSES: Record<RejectionReason, string> = {
  'invalid-json':
    'the model reply could not be parsed into the required JSON shape after one automatic retry',
  'unresolved-source':
    'the reply cited monsters with no stat source this run could resolve, after one automatic repair attempt',
  'ability-convention':
    'the stat block printed signed ability values where the d20 score is required, after one automatic repair attempt',
  'brief-contract':
    "the reply parsed, but it broke the encounter brief's own contract (room shape, roster, or level budget) after one automatic repair attempt",
  'escape-debris':
    'the generated text carries half-formed unicode escapes, which is refused at the boundary that would persist it',
  'scaffolding-echo':
    'the generated text echoed our own prompt scaffolding back as content, which is refused at the boundary that would persist it',
};

/**
 * The refused step's stored output: the reply as the model sent it, the named
 * issues, and the classes the DECIDING site recorded.
 *
 * `reasons` is REQUIRED here — the constructor is the one way to build a
 * rejected output, and a new rejection site that does not know why it refused
 * cannot fill it in. Zero classes is not a state this constructor produces:
 * it is a programming error and throws rather than persisting a step that
 * cannot say what happened (AGENTS rule 1). A row WITHOUT the field is a
 * legacy row, read through `rejectionReasons` below, never through this.
 */
export interface RejectedStepOutput {
  raw: unknown;
  issues: string[];
  reasons: RejectionReason[];
}

export function rejectedStepOutput(
  raw: unknown,
  issues: readonly string[],
  reasons: readonly RejectionReason[],
): RejectedStepOutput {
  if (reasons.length === 0) {
    throw new Error(
      'a rejected step must record WHY it was rejected — pass at least one RejectionReason (docs/17 row 152)',
    );
  }
  return { raw, issues: [...issues], reasons: [...reasons] };
}

/**
 * Named reasons a rejected step recorded alongside its raw reply (`issues`),
 * for the failure message and the review card. Steps that predate the field
 * yield an empty list.
 */
export function rejectionIssues(step: Pick<RunStep, 'output'>): string[] {
  const issues = (step.output as { issues?: unknown } | null | undefined)?.issues;
  return Array.isArray(issues) ? issues.filter((issue): issue is string => typeof issue === 'string') : [];
}

/**
 * The classes a rejected step recorded, deduplicated in the order they were
 * written. An absent field (a legacy row) yields `[]`, which is what the
 * sentence below reports; a value outside `REJECTION_REASONS` is treated the
 * same way as a non-string `issue` is above — the alternative is throwing
 * inside a run view, i.e. a SECOND error on top of the one being reported.
 */
export function rejectionReasons(step: Pick<RunStep, 'output'>): RejectionReason[] {
  const stored = (step.output as { reasons?: unknown } | null | undefined)?.reasons;
  if (!Array.isArray(stored)) return [];
  const known = stored.filter((value): value is RejectionReason => typeof value === 'string' && REASON_VALUES.has(value));
  return [...new Set(known)];
}

/**
 * THE sentence about a refused step (docs/17 row 152; docs/18 §2.2). Composed
 * in ONE place from the recorded class, and read by the ONE caller that has a
 * user to tell: the auto-autonomy branch of `runEngine.executeFrom`, which
 * fails the run with it.
 *
 * Shape: `Step "<name>" rejected: <clause>` + ` (<issues>)` + the tail the
 * engine always wrote. A single `invalid-json` class therefore reproduces the
 * pre-152 sentence BYTE FOR BYTE — the truthful case is the pinned one.
 *
 * A LEGACY ROW (no class recorded) gets its own honest clause: it says the row
 * carries no class and no more, so a row written before this seam can never
 * start claiming its refusal was about JSON.
 */
export function rejectedStepSentence(stepName: string, step: Pick<RunStep, 'output'>): string {
  const reasons = rejectionReasons(step);
  const issues = rejectionIssues(step);
  const clause =
    reasons.length > 0
      ? reasons.map((reason) => REJECTION_CLAUSES[reason]).join(' and ')
      : issues.length > 0
        ? 'this run row records no rejection class (it predates the engine recording them) — the issues it stored are the reason'
        : 'this run row records no rejection class (it predates the engine recording them) and no issues either';
  return (
    `Step "${stepName}" rejected: ${clause}` +
    (issues.length === 0 ? '' : ` (${issues.join('; ')})`) +
    `. The run failed without saving partial results — ` +
    `run it again, or use manual/review autonomy to keep the raw reply for editing.`
  );
}
