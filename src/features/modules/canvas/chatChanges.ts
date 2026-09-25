import type { ArtifactKind, Module } from '@/domain';
import { ARTIFACT_KIND_SINGULAR } from '@/domain';
import { artifactPath } from '@/app/routes';
import { getModule, patchModuleSpine } from '@/db/moduleRepo';
import { promoteSecondModuleUses } from '@/db/artifactAutoPromote';
import { changeArtifact } from '@/features/modules/change-artifact';
import type { EncounterChangeOperation } from '@/features/modules/change-artifact';
import type { EntityBatchStatBlock } from '@/features/modules/entity-batch';
import { applyChatCommands, type ChatDocumentHandle } from '@/features/modules/canvas/chatApply';
import { useProgressStore } from '@/lib/progress';
import { toastError, toastSuccess } from '@/lib/toast';
import {
  adversarialFindingLines,
  canvasChatChangeInstruction,
  canvasChatChangeLabel,
  isArtifactChange,
  resolveChatArtifactName,
  type CanvasChatAdversarialTarget,
  type CanvasChatChangeCommand,
  type CanvasChatChangeContext,
  type CanvasChatChangeOperation,
  type CanvasChatChangeOutcome,
  type CanvasChatChangeResult,
} from '@/llm/canvasChat';
import {
  runAdversarialPass,
  type AdversarialPassReport,
  type AdversarialTarget,
} from '@/llm/adversarialPass';
import { ModuleBusyError } from '@/llm/moduleGen';

/**
 * The canvas chat's CHANGE half (docs/17 row 104, docs/18 §2.2): what turns a
 * parsed `<change>` block into a real change to a stored artifact — or, since
 * docs/17 row 360, into an ADVERSARIAL review of the module's premise or one of
 * its parts.
 *
 * The owner's words, verbatim: *"That would also need an ability for the LLM to
 * actually change those details."* This module is the ONE place that ability is
 * wired, and it is deliberately thin, because every decision it could make for
 * itself is a decision that already has an owner:
 *
 * - **The name is resolved by the resolver, once.** `resolveChatArtifactName`
 *   is the SAME `resolveWikiLink(name, pool, { moduleId })` the reader's wiki
 *   chips and the read half (`<request>`) use, so the chat cannot edit a
 *   different row than it read. An ambiguous name is a NAMED refusal carrying
 *   the resolver's own candidate list — the app never guesses which row to
 *   REWRITE (a wrong guess is a wrong row rewritten, not just a wrong row
 *   displayed).
 * - **The change itself goes through the SEAM, and only through it.**
 *   `features/modules/change-artifact.changeArtifact` routes by the resolved
 *   row's own kind to the specialist for that kind; this module never composes
 *   a brief and never starts a run of its own. All it adds is the CHAT's own
 *   policy — which is exactly the policy the protocol cannot know:
 *   1. an encounter change must NAME its operation (the two are materially
 *      different: `repopulate` keeps the rooms, layout and map, `everything`
 *      replaces them) — a missing one is refused BY NAME, never defaulted;
 *   2. an operation on a non-encounter is refused by name (the seam treats that
 *      mismatch as a programming error, because for a caller like the artifact
 *      editor it IS one — a model can make the mistake, so the model gets a
 *      sentence it can act on);
 *   3. a busy module is a NAMED outcome (`ModuleBusyError` from the seam's own
 *      one-generation-per-module gate), so the model is told the change did not
 *      happen and can ask again.
 * - **The owner hears about it as it settles.** `reportChatChangeOutcome` is
 *   called by the turn the moment each change settles (AGENTS 2) and names the
 *   artifact, what happened and the instruction that asked for it. A change
 *   that FAILED or was refused NEVER reads as success: refusals and failures go
 *   through `toastError`, and the words "did not" are in the sentence.
 *
 * THE ADVERSARIAL HALF (docs/17 row 360). The owner's requirement, verbatim:
 * *"This step can be automated to run once, but it should also be triggerable in
 * the module chat."* An adversarial `<change>` names a TARGET (the premise, or a
 * part by its 1-based number) and this module calls the ONE EXISTING pass
 * (`runAdversarialPass`) with the target's CURRENT text — the live per-part
 * snapshot the model was shown for a part, the row's own premise for the
 * premise. There is no second critique, no second editor and no second
 * snapshot: the pass takes the durable pre-change snapshot FIRST (row 356) and
 * row 357 made that snapshot carry the premise, so an accepted edit is undoable
 * through the EXISTING version stack.
 *
 * WHERE THE EDIT LANDS, and why the two targets differ:
 *
 * - a PART is INSIDE the canvas document, so its edit is applied to the LIVE
 *   document through the chat's OWN applier (`applyChatCommands` — the same
 *   `resolveCanvasEditAcrossParts` ladder, the same hygiene scan, the same
 *   before→after outcome the `<edit>` commands ride). The turn then persists it
 *   through the EXISTING split-save (`saveWholeModuleDocument`), so the doc and
 *   the row cannot drift and the editor's undo history holds the change;
 * - the PREMISE is NOT in the document, so its edit goes through the ONE
 *   spine-subfield seam (`db/moduleRepo.patchModuleSpine`) with the editor's own
 *   provenance — the path the in-generation trigger (row 358) already rides.
 *
 * A finding is ADVISORY and the pass is loud only at its boundaries, so: a
 * critique that found NOTHING is the quiet `clean` outcome and NOTHING is
 * written; a pass failure is rethrown and becomes the engine's named `failed`
 * outcome (loud toast + card) with nothing written.
 */

/**
 * The chat's operation vocabulary IS the seam's — tied at compile time, so a
 * third operation (or a renamed one) cannot appear on one side only.
 */
const ENCOUNTER_OPERATION: Readonly<Record<CanvasChatChangeOperation, EncounterChangeOperation>> = {
  repopulate: 'repopulate',
  everything: 'everything',
} satisfies Record<CanvasChatChangeOperation, EncounterChangeOperation>;

/** What each encounter operation does, said EXACTLY (the model reads this back
 * and the owner sees it): the difference between them is the whole reason the
 * operation is required. */
const ENCOUNTER_OPERATION_SCOPE: Readonly<Record<CanvasChatChangeOperation, string>> = {
  repopulate:
    'a new roster was generated for every room; the rooms, layout and battlemap are kept, and this operation does NOT rename the encounter or rewrite its prose',
  everything:
    'the encounter was regenerated top to bottom — a new roster, a new room layout and a new battlemap; the name and prose are kept',
};

/** The seam's operation, named the way the OWNER knows it (the editor buttons'
 * own words: "Repopulate" / "Regenerate everything"). */
const ENCOUNTER_OPERATION_LABEL: Readonly<Record<CanvasChatChangeOperation, string>> = {
  repopulate: 'repopulate',
  everything: 'regenerate everything',
};

/** The one line a change's failure/dock entry carries from the instruction. */
function instructionSummary(instruction: string): string {
  const collapsed = instruction.replace(/\s+/g, ' ').trim();
  return collapsed.length <= 160 ? collapsed : `${collapsed.slice(0, 157)}…`;
}

/** The named refusal for an encounter change that did not state its operation. */
function missingOperationReason(name: string): string {
  return `«${name}» is an encounter, and an encounter has exactly TWO change operations that do materially different things: "repopulate" (a new roster for every room; rooms, layout and battlemap kept) and "everything" (a new roster, a new layout AND a new battlemap). There is NO default, so nothing was changed: send the change again with operation="repopulate" or operation="everything".`;
}

/** The named refusal for an operation on a row that is not an encounter. */
function operationKindReason(name: string, kind: ArtifactKind): string {
  return `«${name}» is ${kindNoun(kind)}, and the two encounter operations (repopulate / everything) apply to encounters only. Nothing was changed: send the change again WITHOUT the operation attribute.`;
}

/** The named outcome for a change the module's generation slot refused. */
function busyReason(): string {
  return `another generation holds this module's single generation slot right now, so the change was NOT started and nothing was changed. Ask again once that generation finishes — a change is never queued behind it.`;
}

/**
 * The STAT-BLOCK half of a changed entity's report (docs/17 row 247), from the
 * run engine's own step record through the change seam. The owner's report was
 * a change that recreated everything BUT the stat block while the outcome said
 * only "changed" — so which of the two happened is stated in as many words.
 *
 * `undefined` (the encounter route) contributes NOTHING: the encounter lane's
 * regeneration semantics are its own, and this clause must never claim a stat
 * block was regenerated when the operation never touched one.
 */
function statBlockClause(statBlock: EntityBatchStatBlock | undefined): string {
  switch (statBlock) {
    case 'regenerated':
      return '; its stat block was REGENERATED at the level this run resolved for the entity';
    case 'kept':
      return '; its existing stat block was KEPT — it was NOT regenerated';
    case 'none':
      return '; no stat block was authored for it (the entity needs none, or its numbers come from a cited library creature)';
    default:
      return '';
  }
}

/** The owner-facing noun for a kind, derived from the ONE kind vocabulary
 * (`ARTIFACT_KIND_SINGULAR`) so a rename cannot drift the copy. 'PC' and 'NPC'
 * are initialisms, so their article follows their SOUND ("an NPC"). */
function kindNoun(kind: ArtifactKind): string {
  const label = ARTIFACT_KIND_SINGULAR[kind];
  const article = label === 'NPC' || /^[AEIOU]/.test(label) ? 'an' : 'a';
  const noun = label === 'PC' || label === 'NPC' ? label : label.toLowerCase();
  return `${article} ${noun}`;
}

/**
 * Runs ONE parsed change, through the seam, and returns its named outcome. The
 * caller (the chat turn) runs these SEQUENTIALLY, one at a time, and reports
 * each outcome to the owner as it settles.
 *
 * Thrown failures are the caller's to relay (`failed`, in the specialist's own
 * words); the ONLY error swallowed here is the busy gate, which becomes a named
 * outcome because "the module is generating — ask again" is information the
 * model can act on, not a failure of the change itself.
 *
 * `handle` is the turn's LIVE document handle. It is REQUIRED for an adversarial
 * PART review — the edit must land in the document the owner is looking at, and
 * the applier that owns the matching ladder needs that document — and untouched
 * by every other change (an artifact change writes a stored row; a premise
 * review writes the spine).
 */
export async function executeChatChange(
  change: CanvasChatChangeCommand,
  context: CanvasChatChangeContext,
  handle?: ChatDocumentHandle,
): Promise<CanvasChatChangeResult> {
  if (!isArtifactChange(change)) {
    return executeAdversarialChange(change.adversarial, context, handle);
  }
  const progress = useProgressStore.getState();
  const progressId = `chat-change:${context.moduleId}:${change.name}`;
  progress.start(progressId, `Changing «${change.name}»`, instructionSummary(change.instruction));
  try {
    const resolution = resolveChatArtifactName({
      name: change.name,
      moduleId: context.moduleId,
      pool: context.pool,
    });
    if (resolution.status !== 'resolved') {
      // The resolver's own candidate list rides the reason, newest first —
      // the same candidates the wiki chips show, and no guess at all.
      return { status: resolution.status, artifactId: null, kind: null, detail: resolution.reason };
    }
    const artifact = resolution.artifact;
    progress.update(progressId, {
      detail: `${instructionSummary(change.instruction)} — ${kindNoun(artifact.kind)}`,
      href: artifactPath(context.campaignId, artifact.id),
    });
    if (artifact.kind === 'encounter' && change.operation === undefined) {
      // NEVER defaulted, NEVER guessed: the two operations differ materially and
      // the destructive one is never what a model gets by forgetting to choose.
      return {
        status: 'refused',
        artifactId: artifact.id,
        kind: artifact.kind,
        detail: missingOperationReason(artifact.name),
      };
    }
    if (artifact.kind !== 'encounter' && change.operation !== undefined) {
      return {
        status: 'refused',
        artifactId: artifact.id,
        kind: artifact.kind,
        detail: operationKindReason(artifact.name, artifact.kind),
      };
    }
    const operation = change.operation;
    let result: Awaited<ReturnType<typeof changeArtifact>>;
    try {
      result = await changeArtifact({
        artifactId: artifact.id,
        instruction: change.instruction,
        signal: context.signal,
        // The chat never ticks the encounter editor's "also redesign name and
        // prose" box: that is a bigger change than the operation the model
        // asked for, and the outcome says so (see ENCOUNTER_OPERATION_SCOPE).
        ...(operation === undefined
          ? {}
          : { encounter: { operation: ENCOUNTER_OPERATION[operation] } }),
      });
    } catch (error) {
      if (error instanceof ModuleBusyError) {
        return {
          status: 'busy',
          artifactId: artifact.id,
          kind: artifact.kind,
          detail: busyReason(),
        };
      }
      throw error;
    }
    if (result.status === 'changed') {
      return {
        status: 'changed',
        artifactId: result.artifactId,
        kind: result.kind,
        detail:
          operation === undefined
            ? `the row was redesigned in place by the engine for its kind (identity, links and images kept)${statBlockClause(result.statBlock)}`
            : `${ENCOUNTER_OPERATION_LABEL[operation]} — ${ENCOUNTER_OPERATION_SCOPE[operation]}`,
      };
    }
    // `refused` / `unsupported`: the seam's own words, never paraphrased.
    return {
      status: result.status,
      artifactId: result.artifactId,
      kind: result.kind,
      detail: result.reason,
    };
  } finally {
    progress.finish(progressId);
  }
}

// --- the adversarial half (docs/17 row 360) ------------------------------------

/** The named refusal for a target the module has no text to review for. */
function missingTargetReason(target: CanvasChatAdversarialTarget, module: Module): string {
  if (target.kind === 'premise') {
    return module.spine === null
      ? 'this module has no premise yet (its spine was never drafted), so there is nothing for the adversarial review to read. Generate the module first.'
      : 'this module\'s premise is empty, so there is nothing for the adversarial review to read. Generate or write the premise first.';
  }
  return `this module has no part ${String(target.planIndex + 1)} in its plan, so there is nothing for the adversarial review to read — parts are numbered from 1, as the module plan shows them.`;
}

/** The named refusal for a part that exists but stores no text. */
function emptyTargetReason(label: string): string {
  return `${label} is empty, so there is nothing for the adversarial review to read — the pass never invents text to critique.`;
}

/** What the owner reads for a review that found nothing (the quiet success). */
function cleanDetail(label: string, modelUsed: string): string {
  return `the adversarial critique of ${label} found nothing to fix against the owner's four criteria (inconsistency, motivation, fun, originality), so the editor was NOT called and nothing was written. Critic model: ${modelUsed}.`;
}

/** What the admin reads for a review whose edit landed. */
function appliedDetail(label: string, report: AdversarialPassReport): string {
  const count = report.critique.issues.length;
  const noun = count === 1 ? 'finding' : 'findings';
  return `the adversarial critique of ${label} found ${String(count)} ${noun} and the editor rewrote it — the replacement is on the module now (undo it from the Versions menu; the pass snapshotted the module first). Critic model: ${report.critique.modelUsed}; editor model: ${report.edit?.modelUsed ?? ''}.`;
}

/**
 * Resolves an adversarial target's CURRENT text: the LIVE part the model was
 * shown for a part (never a re-read of the row, so what the critic judges is
 * what the owner sees), or the module row's own premise. Returns the named
 * refusal when there is nothing to read — the pass throws on empty text BY
 * DESIGN, and a target with no text is a refusal, not a failure.
 */
interface ResolvedTarget {
  target: AdversarialTarget;
  label: string;
  text: string;
}

async function resolveAdversarialTarget(
  target: CanvasChatAdversarialTarget,
  context: CanvasChatChangeContext,
): Promise<ResolvedTarget | { reason: string }> {
  const label = target.kind === 'premise' ? 'the premise' : `part ${String(target.planIndex + 1)}`;
  if (target.kind === 'part') {
    const section = context.parts.find((part) => part.planIndex === target.planIndex);
    if (section === undefined) {
      const module = await getModule(context.moduleId);
      if (module === undefined) throw new Error('Module no longer exists');
      return { reason: missingTargetReason(target, module) };
    }
    if (section.text.trim() === '') return { reason: emptyTargetReason(label) };
    return { target, label, text: section.text };
  }
  const module = await getModule(context.moduleId);
  if (module === undefined) throw new Error('Module no longer exists');
  const premise = module.spine?.premise ?? '';
  if (premise.trim() === '') return { reason: missingTargetReason(target, module) };
  return { target, label, text: premise };
}

/**
 * Runs the ONE pass for one adversarial request and applies its edit through the
 * target's EXISTING write path (see the file header). NOTHING is written when
 * the critique found nothing; a boundary failure propagates to the engine's
 * named `failed` outcome.
 */
async function executeAdversarialChange(
  target: CanvasChatAdversarialTarget,
  context: CanvasChatChangeContext,
  handle: ChatDocumentHandle | undefined,
): Promise<CanvasChatChangeResult> {
  const progress = useProgressStore.getState();
  const progressId = `chat-adversarial:${context.moduleId}:${target.kind === 'premise' ? 'premise' : String(target.planIndex)}`;
  const resolved = await resolveAdversarialTarget(target, context);
  if ('reason' in resolved) {
    return { status: 'refused', artifactId: null, kind: null, detail: resolved.reason };
  }
  progress.start(
    progressId,
    `Reviewing ${resolved.label}`,
    'adversarial critique, then an edit if it finds anything…',
  );
  try {
    const report = await runAdversarialPass({
      moduleId: context.moduleId,
      target: resolved.target,
      text: resolved.text,
      signal: context.signal,
    });
    const findings = adversarialFindingLines(report.critique.issues);
    if (report.edit === null) {
      // ADVISORY and quiet: nothing to fault means nothing is written, and this
      // outcome says exactly that rather than claiming a change.
      progress.update(progressId, {
        detail: `Reviewing ${resolved.label} — the critique found nothing to fix.`,
      });
      return {
        status: 'clean',
        artifactId: null,
        kind: null,
        detail: cleanDetail(resolved.label, report.critique.modelUsed),
        findings,
      };
    }
    if (resolved.target.kind === 'premise') {
      await patchModuleSpine(context.moduleId, {
        premise: report.edit.replacement,
        // PROVENANCE (docs/17 row 93): the model that WROTE the text now on the
        // row is the editor, never a settings lookup — and the authorship is the
        // model's, so the normalization pass may rewrite its link targets.
        writerModel: report.edit.modelUsed,
        origin: 'model',
      });
      await promoteSecondModuleUses(context.moduleId, [report.edit.replacement]);
      progress.update(progressId, { detail: `Applied the adversarial edit to ${resolved.label}.` });
      return {
        status: 'changed',
        artifactId: null,
        kind: null,
        detail: appliedDetail(resolved.label, report),
        findings,
        edit: {
        originalText: report.originalText,
        replacement: report.edit.replacement,
        modelUsed: report.edit.modelUsed,
      },
      };
    }
    // A PART lives INSIDE the canvas document: the edit goes through the chat's
    // OWN applier (the same ladder + hygiene scan the <edit> commands ride), so
    // the doc cannot drift from the reviewed text, and the TURN persists it
    // through the existing split-save.
    if (handle === undefined) {
      throw new Error(
        'the chat cannot apply an adversarial part edit without the live document handle — the caller wires it to features/modules/canvas/chatTurn',
      );
    }
    const applied = applyChatCommands({
      commands: [{ search: report.originalText, replace: report.edit.replacement, all: false }],
      partPlan: context.parts.map((part) => ({ title: part.title })),
      handle,
    });
    const failure = applied.outcomes.find((outcome) => outcome.kind === 'failed');
    if (!applied.docChanged || failure !== undefined) {
      // The replacement did not land: NOTHING was written to the row either
      // (the turn persists only what the document carries), so this is a loud
      // refusal with the applier's own reason.
      return {
        status: 'refused',
        artifactId: null,
        kind: null,
        detail: `${resolved.label} could not be replaced with the edit the adversarial pass produced: ${failure?.reason ?? 'the replacement matched nothing in the current document'}. Nothing was changed.`,
        findings,
      };
    }
    progress.update(progressId, { detail: `Applied the adversarial edit to ${resolved.label}.` });
    return {
      status: 'changed',
      artifactId: null,
      kind: null,
      detail: appliedDetail(resolved.label, report),
      findings,
      edit: {
          originalText: report.originalText,
          replacement: report.edit.replacement,
          modelUsed: report.edit.modelUsed,
        },
      ...(applied.lastApplied === null ? {} : { appliedToDocument: applied.lastApplied }),
    };
  } finally {
    progress.finish(progressId);
  }
}

/**
 * The OWNER-facing report of one settled change (AGENTS 2 — a change is never
 * silent and no error ends in a console). Called by the chat turn the moment the
 * change settles, NOT at the end of the turn, so a stop or a later failure
 * cannot swallow what already happened to the owner's data.
 *
 * A refusal, a busy module and a failure all say so in as many words and go
 * through `toastError`: none of them may ever read as success. An adversarial
 * review reports its FINDINGS here as well as on its outcome card (docs/17 row
 * 360) — the critique is the point of the feature, so it is never reduced to
 * "reviewed".
 */
export function reportChatChangeOutcome(outcome: CanvasChatChangeOutcome): void {
  const label = canvasChatChangeLabel(outcome.change);
  const instruction = canvasChatChangeInstruction(outcome.change);
  const asked = instruction === null ? null : instructionSummary(instruction);
  const kind = outcome.kind === null ? '' : ` (${kindNoun(outcome.kind)})`;
  const findings = outcome.findings ?? [];
  const findingClause =
    findings.length === 0
      ? ''
      : ` The critic found: ${findings.map((line) => `\n• ${line}`).join('')}`;
  if (outcome.status === 'changed') {
    toastSuccess(
      `The chat changed ${label}${kind} — ${outcome.detail}${findingClause}${asked === null ? '' : ` Asked: “${asked}”`}`,
    );
    return;
  }
  if (outcome.status === 'clean') {
    // A quiet success, NOT an error: the critique found nothing and nothing was
    // applied — the honest outcome the owner asked for.
    toastSuccess(`Nothing to fix in ${label} — ${outcome.detail}`);
    return;
  }
  if (outcome.status === 'failed') {
    // The specialist threw: it did not report success, and a regeneration
    // RESETS its target before its run, so the row may or may not have moved.
    // Saying "nothing changed" here would be a guess, and a dangerous one.
    toastError(
      `The chat's change to ${label}${kind} FAILED and did not report success: ${outcome.detail}${findingClause} Read the row — and its revision history — before assuming either way.${asked === null ? '' : ` Asked: “${asked}”`}`,
    );
    return;
  }
  const verb = outcome.status === 'busy' ? 'was NOT started' : 'was REFUSED';
  toastError(
    `The chat did NOT change ${label}${kind} — the change ${verb}: ${outcome.detail}${findingClause}${asked === null ? '' : ` Asked: “${asked}”`}`,
  );
}
