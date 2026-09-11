import type { ArtifactKind } from '@/domain';
import { ARTIFACT_KIND_SINGULAR } from '@/domain';
import { artifactPath } from '@/app/routes';
import { changeArtifact } from '@/features/modules/change-artifact';
import type { EncounterChangeOperation } from '@/features/modules/change-artifact';
import { useProgressStore } from '@/lib/progress';
import { toastError, toastSuccess } from '@/lib/toast';
import {
  resolveChatArtifactName,
  type CanvasChatChangeCommand,
  type CanvasChatChangeContext,
  type CanvasChatChangeOperation,
  type CanvasChatChangeOutcome,
  type CanvasChatChangeResult,
} from '@/llm/canvasChat';
import { ModuleBusyError } from '@/llm/moduleGen';

/**
 * The canvas chat's CHANGE half (docs/17 row 104, docs/18 §2.2): what turns a
 * parsed `<change>` block into a real change to a stored artifact.
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
 *   row's own kind to the specialist for that kind; this module never writes a
 *   row, never imports a repo writer, never composes a brief and never starts a
 *   run of its own. All it adds is the CHAT's own policy — which is exactly the
 *   policy the protocol cannot know:
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
 * WHAT IS NOT RECOVERED HERE, and is not invented: a change is a real engine
 * run, so its persistence story is the specialist's. Entity changes land through
 * `runEngine`'s in-place refill (one `updateArtifact` at finalize, with
 * `writerModel` and the `persona` revision source); encounter changes land
 * through the regeneration pipeline. Artifact rows keep revisions, so a change
 * is restorable from the artifact editor's revision history (docs/17 row 104
 * states exactly where, and what that does NOT cover).
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
 */
export async function executeChatChange(
  change: CanvasChatChangeCommand,
  context: CanvasChatChangeContext,
): Promise<CanvasChatChangeResult> {
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
            ? 'the row was redesigned in place by the engine for its kind (identity, links and images kept)'
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

/**
 * The OWNER-facing report of one settled change (AGENTS 2 — a change is never
 * silent and no error ends in a console). Called by the chat turn the moment the
 * change settles, NOT at the end of the turn, so a stop or a later failure
 * cannot swallow what already happened to the owner's data.
 *
 * A refusal, a busy module and a failure all say so in as many words and go
 * through `toastError`: none of them may ever read as success.
 */
export function reportChatChangeOutcome(outcome: CanvasChatChangeOutcome): void {
  const asked = instructionSummary(outcome.change.instruction);
  const label = `«${outcome.change.name}»`;
  const kind = outcome.kind === null ? '' : ` (${kindNoun(outcome.kind)})`;
  if (outcome.status === 'changed') {
    toastSuccess(`The chat changed ${label}${kind} — ${outcome.detail}. Asked: “${asked}”`);
    return;
  }
  if (outcome.status === 'failed') {
    // The specialist threw: it did not report success, and a regeneration
    // RESETS its target before its run, so the row may or may not have moved.
    // Saying "nothing changed" here would be a guess, and a dangerous one.
    toastError(
      `The chat's change to ${label}${kind} FAILED and did not report success: ${outcome.detail} Read the row — and its revision history — before assuming either way. Asked: “${asked}”`,
    );
    return;
  }
  const verb = outcome.status === 'busy' ? 'was NOT started' : 'was REFUSED';
  toastError(
    `The chat did NOT change ${label}${kind} — the change ${verb}: ${outcome.detail} Asked: “${asked}”`,
  );
}
