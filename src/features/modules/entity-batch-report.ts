import type { Campaign, Module } from '@/domain';
import type { StubKind } from '@/features/modules/persona-request';
import {
  KIND_PLURALS,
  type EntityBatchFailure,
  type EntityBatchFailureKind,
} from '@/features/modules/entity-batch';
import { errorMessage } from '@/lib/errors';
import { toastErrorPersistent, toastInfoPersistent } from '@/lib/toast';
import { zodIssuesOf } from '@/lib/zodErrorSummary';

/**
 * THE reporting seam for a finished entity batch with failures: ONE caller
 * shape, ONE count sentence, ONE console entry (AGENTS rule 4 — the sentence
 * used to be composed character-for-character at TWO call sites,
 * `entity-panel`'s batch button and `post-generation`'s unattended sweep, so
 * the panel and the automation could drift in what they told the owner).
 *
 * WHAT THE OWNER'S PROBLEM WAS, MEASURED. The sentence that used to be raised
 * here went through `toastError`, which passes no `duration` — so sonner's
 * `TOAST_LIFETIME` (4000 ms, `node_modules/sonner/dist/index.mjs:470`, with
 * no `duration` on the app's `<Toaster>` in `app/layout/AppShell.tsx`) applied
 * and the whole report blinked away in four seconds. It was ALSO the only
 * carrier of the payload: nothing reached the console, and the progress dock
 * drops the job on finish (`lib/progress`, no failure field), so a count
 * nobody could read in time was the whole record of the batch.
 *
 * SO THE RECORD IS THIS MODULE'S JOB, and every part of it is raised from HERE
 * so the parts cannot drift:
 *
 * - `recordEntityBatchFailure(context, failure)` is called by the BATCH ITSELF
 *   the moment a failure is recorded (the one funnel in `entity-batch.ts`), NOT
 *   only at batch end — because a batch can die mid-flight (the owner's own
 *   four failures were followed by his Stop; had the page or the batch gone
 *   first, an end-of-batch dump would never have been written and the evidence
 *   would be gone). It emits the failure's own record: a PASTEABLE
 *   single-line JSON string under a stable tag
 *   (`[campaigner] entity-batch failure {…}`) as ONE string argument, plus the
 *   same object live for inspection;
 * - the BATCH-END summary (`reportEntityBatchFailures`) carries a stable,
 *   greppable headline (`[campaigner] npc batch: 4 of 10 failed`), the
 *   structured payload behind it, and the same payload again as a pasteable
 *   `[campaigner] entity-batch summary {…}` line. Every field is there: the
 *   module + campaign context, per entity the name, WHICH path it came down,
 *   its run id and terminal status, the run's own `failureKind` and
 *   `errorMessage`, the engine's sentence and the RAW value (run row / thrown
 *   error / refused destination);
 * - the TOAST is the user-visible surface (AGENTS rule 2 — a console entry
 *   alone is forbidden) and it stays glanceable: the count, and for a batch
 *   containing designed refusals or interrupted runs the breakdown that tells
 *   the owner whether his generator is broken or the system deliberately
 *   declined / the page ate the run. It is raised through
 *   `toastErrorPersistent`, the helper `lib/toast` documents for "a failure
 *   nothing else caught": a refusal's run COMPLETED and a setup throw or an
 *   interruption leaves no usable row behind (an interrupted run IS a failed
 *   row, but the only thing it says is that the page reloaded), so this toast
 *   is the one record they have.
 *
 * WHY A TEXT LINE AND NOT ONLY THE OBJECT (the owner, verbatim: *"when that 4
 * second error message pops up to have something in the console to post back to
 * you"*). A live object is inspectable but cannot be copied faithfully —
 * devtools' "copy object" is a manual step and truncates nested values — so
 * every record also exists as plain text, on ONE line, under a tag that can be
 * grepped. The text line is a SINGLE string argument, deliberately: a console
 * row that also carries an object argument renders a devtools-specific preview
 * into whatever gets copied, and the deliverable here is a line that can be
 * pasted verbatim.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: it never decides what counts as a
 * success or a failure — `runEntityBatch` already did, and this function
 * reports its `failed` array verbatim. A CAST entity (a name the module
 * recorded a bestiary slot for) is a SUCCESS in that array's terms and does not
 * reach this seam while its cast holds; it reaches it in ONE case only (docs/17
 * rows 133/135): the cast landed, the row exists, and the DESCRIPTION run every
 * cast row now gets — the module's own paragraphs are its CONTEXT, never a
 * substitute for a description — did not complete. That is a real failure to
 * hear about (the owner's row would
 * otherwise stay a portrait with no text), and it is the batch that decides it,
 * not this seam. A WITHDRAWN run (the owner's own Stop) is likewise absent from
 * the array.
 */

/** The stable, greppable prefix of every batch-failure console entry. Grep
 * for it in devtools to find every batch that went wrong in one session. */
export const BATCH_FAILURE_CONSOLE_PREFIX = '[campaigner]';

export interface EntityBatchFailureReport {
  /** The module the batch ran for (named in the console entry so the run can
   * be found from the Runs tab without opening every module). */
  module: Module;
  campaign: Campaign;
  kind: StubKind;
  /** How many entities the batch was asked for — the denominator of the count
   * sentence (`failed of total`). */
  total: number;
  /** The batch's own failure list, verbatim and in its own order. */
  failures: readonly EntityBatchFailure[];
}

/** The batch a failure belongs to — everything a per-failure record needs to
 * be self-contained (the same shape the summary reports, without its list). */
export type EntityBatchFailureContext = Omit<EntityBatchFailureReport, 'failures'>;

/** The greppable TAG of a per-failure record — the PASTEABLE line, whose
 * payload is a JSON object immediately after the tag and a space. */
export const BATCH_FAILURE_RECORD_TAG = 'entity-batch failure';

/** The greppable TAG of a record's live-object entry. A DISTINCT tag, not a
 * suffix of the pasteable one: a reader (or a grep) must be able to tell the
 * line to copy from the object to expand without parsing prose — MEASURED, the
 * two entries were indistinguishable while both began with the record tag. */
export const BATCH_FAILURE_DETAIL_TAG = 'entity-batch detail';

/** The greppable TAG of the batch-end summary record. */
export const BATCH_FAILURE_SUMMARY_TAG = 'entity-batch summary';

/**
 * The pasteable half of a record: ONE line of JSON.
 *
 * A value that cannot be serialized (a cycle, a `BigInt`) must not swallow the
 * record, and it must not break the batch either — a reporting failure is not a
 * generation failure — so the line says IN WORDS that it could not be
 * serialized rather than printing nothing (AGENTS rule 1: no silent fallback).
 */
function textLine(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return JSON.stringify({ unserializable: true, reason: errorMessage(error) });
  }
}

/**
 * The batch's identity, as every record carries it — so a pasted line says
 * WHICH module and WHICH batch without a second lookup.
 *
 * `batchKind`, NOT `kind`: a per-failure record already has a `kind`, and it is
 * the FAILURE's class (`refused` / `interrupted` / …). One key with two
 * meanings in one object is exactly the ambiguity this row exists to remove —
 * MEASURED: with both spelled `kind`, the failure's class silently overwrote
 * the batch's kind and the record became unreadable in a way no shape pin could
 * see.
 */
function batchContextOf(context: EntityBatchFailureContext): Record<string, unknown> {
  return {
    campaign: { id: context.campaign.id, name: context.campaign.name },
    module: { id: context.module.id, title: context.module.title },
    batchKind: context.kind,
    total: context.total,
  };
}

/** One failure as the console carries it: `undefined` becomes `null` so the
 * payload is copyable as JSON with every field present. */
function payloadFailure(failure: EntityBatchFailure): Record<string, unknown> {
  return {
    name: failure.name,
    kind: failure.kind,
    message: failure.message,
    runId: failure.runId ?? null,
    status: failure.status ?? null,
    // The run's OWN classification and errorMessage, beside its status: this
    // is the pair that separates "the page reloaded" (`failureKind` is
    // `'cancelled'`, message 'Interrupted by reload') from "the provider or a
    // contract failed" (`'congestion'`, `'bug'`, …).
    failureKind: failure.failureKind ?? null,
    errorMessage: failure.errorMessage ?? null,
    raw: failure.raw ?? null,
    // The readable form of a validation failure: a `ZodError`'s own `message`
    // is the raw issues array, so the issues are carried as objects beside the
    // raw error rather than flattened into the sentence (AGENTS rule 1).
    issues: zodIssuesOf(failure.raw) ?? null,
  };
}

/** How many failures came down each path — the breakdown both surfaces state. */
function classCounts(failures: readonly EntityBatchFailure[]): Record<EntityBatchFailureKind, number> {
  const counts: Record<EntityBatchFailureKind, number> = {
    refused: 0,
    interrupted: 0,
    'run-not-completed': 0,
    'setup-error': 0,
  };
  for (const failure of failures) counts[failure.kind] += 1;
  return counts;
}

/** The structured half of the console entry — one object, one line to read. */
function consolePayload(report: EntityBatchFailureReport): Record<string, unknown> {
  const counts = classCounts(report.failures);
  return {
    ...batchContextOf(report),
    failed: report.failures.length,
    refused: counts.refused,
    // The class the owner cannot get from a count: the run died with the page
    // (or was aborted) rather than because his generator is broken.
    interrupted: counts.interrupted,
    'run-not-completed': counts['run-not-completed'],
    'setup-error': counts['setup-error'],
    failures: report.failures.map(payloadFailure),
  };
}

/** The per-entity half of the sentence: `"Kael" — <the reason>`. */
function summaryOf(failures: readonly EntityBatchFailure[]): string {
  return failures
    .map((failure) => `"${failure.name}" — ${failure.message}`)
    .join('; ');
}

/**
 * The owner-facing sentence.
 *
 * A batch where every failure is a run that simply died keeps the sentence
 * this app has always raised (`"N of M npcs failed to generate — see the Runs
 * tab (…)"`) byte for byte: nothing about a plain generator failure changed,
 * and its runs really are in the Runs tab.
 *
 * Every OTHER batch can no longer say that, because it would be false. A
 * refusal is a designed stop whose run COMPLETED (so the Runs tab holds no
 * failed run for it), and an interruption is a run the page killed — counting
 * either as a generation failure is the conflation docs/17 row 117 rules out,
 * and it is the one thing the owner cannot afford to misread: "is my generator
 * broken?" So the sentence states each class separately, says in words which
 * classes are NOT generator failures, and points at the Runs tab only for the
 * runs that are actually there.
 */
function batchFailureMessage(report: EntityBatchFailureReport): string {
  const plural = KIND_PLURALS[report.kind];
  const total = String(report.total);
  const count = String(report.failures.length);
  const summary = summaryOf(report.failures);
  const counts = classCounts(report.failures);
  if (counts.refused === 0 && counts.interrupted === 0 && counts['setup-error'] === 0) {
    return `${count} of ${total} ${plural} failed to generate — see the Runs tab (${summary})`;
  }
  const clauses: string[] = [];
  if (counts.refused > 0) {
    clauses.push(
      `${String(counts.refused)} refused as cast-creature collisions (a designed stop, not a generator failure)`,
    );
  }
  if (counts.interrupted > 0) {
    clauses.push(
      `${String(counts.interrupted)} cancelled or interrupted while they were running ` +
        '(the app reloaded or the run was stopped — not a generator failure, so run the batch again)',
    );
  }
  if (counts['run-not-completed'] > 0) {
    clauses.push(
      `${String(counts['run-not-completed'])} failed to generate — see the Runs tab`,
    );
  }
  if (counts['setup-error'] > 0) {
    clauses.push(`${String(counts['setup-error'])} could not start — see the console for the reason`);
  }
  return `${count} of ${total} ${plural} did not generate — ${clauses.join(', ')} (${summary})`;
}

/** The greppable headline: the count, plus the classes that are NOT plain
 * generator failures so a console reader sees them without expanding the
 * payload. */
function consoleHeadline(report: EntityBatchFailureReport): string {
  const counts = classCounts(report.failures);
  const notes: string[] = [];
  if (counts.refused > 0) notes.push(`${String(counts.refused)} refused as designed collisions`);
  if (counts.interrupted > 0) notes.push(`${String(counts.interrupted)} cancelled or interrupted`);
  return (
    `${BATCH_FAILURE_CONSOLE_PREFIX} ${report.kind} batch: ` +
    `${String(report.failures.length)} of ${String(report.total)} failed` +
    (notes.length === 0 ? '' : ` (${notes.join(', ')})`)
  );
}

/**
 * Records ONE failure, at the moment the batch recorded it.
 *
 * Called by the batch itself through its single funnel (`entity-batch.ts`'s
 * `recordFailure`), so no failure class can be recorded without being written
 * down — and so the evidence exists even when the batch never reaches its end
 * (a page reload, the owner's Stop, a throw out of the batch). TWO entries, on
 * purpose (see the header): the first is the pasteable single-line JSON, the
 * second the same record as a live object.
 */
export function recordEntityBatchFailure(
  context: EntityBatchFailureContext,
  failure: EntityBatchFailure,
): void {
  const record = { ...batchContextOf(context), ...payloadFailure(failure) };
  console.error(`${BATCH_FAILURE_CONSOLE_PREFIX} ${BATCH_FAILURE_RECORD_TAG} ${textLine(record)}`);
  console.error(
    `${BATCH_FAILURE_CONSOLE_PREFIX} ${BATCH_FAILURE_DETAIL_TAG} ${failure.kind} — "${failure.name}"`,
    record,
  );
}

/**
 * Reports a finished batch's failures: the console headline, the batch's own
 * pasteable summary line AND the user-visible toast, in one call so a caller
 * cannot raise one without the others. A batch with no failures reports nothing
 * at all — no console noise, no toast.
 */
export function reportEntityBatchFailures(report: EntityBatchFailureReport): void {
  if (report.failures.length === 0) return;
  const payload = consolePayload(report);
  console.error(consoleHeadline(report), payload);
  console.error(`${BATCH_FAILURE_CONSOLE_PREFIX} ${BATCH_FAILURE_SUMMARY_TAG} ${textLine(payload)}`);
  toastErrorPersistent(batchFailureMessage(report));
}

/**
 * A DESIGNED DECISION THE BATCH TOOK, WHICH IS NOT A FAILURE (docs/17 row 302).
 *
 * The one kind today is the CAST FALLBACK: the module's entity record asked to
 * borrow a library creature's stats, the entity RECORDED a level, and the
 * library held no creature of that name AT that level — so the entity took the
 * AUTHORED path instead and a stat block was minted at the recorded level. The
 * artifact EXISTS and is a success (`EntityBatchResult.generated`); what this
 * record carries is the thing the owner has to hear, because a cast that became
 * an authored mob is a fact about his module and never a silent substitution
 * (AGENTS rules 1-2).
 *
 * WHY IT IS NOT AN `EntityBatchFailure`. A failure means "no artifact exists",
 * and the batch-end sentence counts those; folding a produced entity into that
 * count would make the sentence lie in exactly the way row 117 spent a slice
 * removing. So a notice rides the SAME seam, the SAME "written down when it
 * happens" discipline and the SAME pasteable-line-plus-object shape, in its own
 * list and under its own tags — never a second reporting mechanism.
 */
export interface EntityBatchNotice {
  /** The entity (wiki-link target) the cast fallback belongs to. */
  name: string;
  /** THE ONE owner-facing sentence (`castFallbackSentence`). */
  message: string;
  /** The creature name the entity's bestiary slot asked to borrow. */
  wanted: string;
  /** The recorded level the cast had to honour, and the level the entity was
   *  authored at instead. */
  level: number;
  /** The resolution seam's own sentence behind the miss: which levels the
   *  library DOES hold for that name, or the nearest creatures it holds — kept
   *  so the record can be diagnosed without re-running the resolution. */
  reason: string;
}

/** The batch-end report for notices: the batch's identity plus its notices. */
export interface EntityBatchNoticeReport extends EntityBatchFailureContext {
  notices: readonly EntityBatchNotice[];
}

/** The greppable TAG of a per-notice record, distinct from every failure tag. */
export const BATCH_NOTICE_RECORD_TAG = 'entity-batch notice';
/** The greppable TAG of a notice's live-object entry — a DISTINCT tag for the
 *  same reason the failure pair uses two (docs/17 row 131): a grep must find
 *  the line to copy without matching the object to expand. */
export const BATCH_NOTICE_DETAIL_TAG = 'entity-batch notice detail';
/** The greppable TAG of the batch-end notice summary. */
export const BATCH_NOTICE_SUMMARY_TAG = 'entity-batch notice summary';

/**
 * THE ONE sentence a cast fallback reports, composed HERE so the batch cannot
 * word it and the report cannot word it differently.
 *
 * It names the RECORDED LEVEL, the creature the slot asked for, and what the
 * app DID instead — authoring at that same level. It is deliberately NOT the
 * failure sentence: nothing failed, and the entity exists.
 */
export function castFallbackSentence(wanted: string, level: number): string {
  return (
    `no library creature at level ${String(level)} matched «${wanted}» — ` +
    `authored at level ${String(level)} instead`
  );
}

/** One notice as the console carries it: every field present, JSON-copyable. */
function payloadNotice(notice: EntityBatchNotice): Record<string, unknown> {
  return {
    name: notice.name,
    wanted: notice.wanted,
    level: notice.level,
    message: notice.message,
    reason: notice.reason,
  };
}

/**
 * Records ONE notice, at the moment the batch took the decision — the same
 * "the evidence exists even if the batch never reaches its end" discipline as
 * `recordEntityBatchFailure`, for the same reason (a page reload, the owner's
 * Stop, a throw out of the batch). TWO entries on purpose: the pasteable
 * single-line JSON under the record tag, and the same object live for
 * inspection, under its own tag.
 */
export function recordEntityBatchNotice(
  context: EntityBatchFailureContext,
  notice: EntityBatchNotice,
): void {
  const record = { ...batchContextOf(context), ...payloadNotice(notice) };
  console.error(`${BATCH_FAILURE_CONSOLE_PREFIX} ${BATCH_NOTICE_RECORD_TAG} ${textLine(record)}`);
  console.error(
    `${BATCH_FAILURE_CONSOLE_PREFIX} ${BATCH_NOTICE_DETAIL_TAG} — "${notice.name}"`,
    record,
  );
}

/** The owner-facing sentence of a batch-end notice report: the count, what the
 *  app did, and each entity's own sentence. */
function batchNoticeMessage(report: EntityBatchNoticeReport): string {
  const plural = KIND_PLURALS[report.kind];
  const summary = report.notices
    .map((notice) => `"${notice.name}" — ${notice.message}`)
    .join('; ');
  return (
    `${String(report.notices.length)} of ${String(report.total)} ${plural} had no library creature at ` +
    `their recorded level — authored at that level instead (${summary})`
  );
}

/**
 * Reports a finished batch's NOTICES: the batch's own pasteable summary line
 * and the user-visible toast, in one call so a caller cannot raise one without
 * the other. A batch with no notices reports nothing at all — no console noise,
 * no toast — which is every batch before row 302 and every batch whose casts
 * resolved.
 *
 * THE TOAST IS PERSISTENT AND INFORMATIONAL (`toastInfoPersistent`): this is the
 * row-280 shape — what the app DID, and it must not be missed — not an error.
 * Raised ONCE per batch rather than once per entity: ten fallbacks must not
 * stack ten notices on the owner's screen.
 */
export function reportEntityBatchNotices(report: EntityBatchNoticeReport): void {
  if (report.notices.length === 0) return;
  const payload = { ...batchContextOf(report), notices: report.notices.map(payloadNotice) };
  console.error(`${BATCH_FAILURE_CONSOLE_PREFIX} ${BATCH_NOTICE_SUMMARY_TAG} ${textLine(payload)}`);
  toastInfoPersistent(batchNoticeMessage(report));
}
