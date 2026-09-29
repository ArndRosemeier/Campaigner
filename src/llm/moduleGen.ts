import type { AnyArtifact, Campaign, EntityKind, Id, Module, ModuleEntityKind, ModulePart, ModuleSpine } from '@/domain';
import {
  aliasCollisionSentence,
  carriedTextOrigin,
  comparableName,
  createModule,
  DEFAULT_MODULE_DIFFICULTY,
  defaultEncounterBudgetPolicy,
  encounterFloorGuardrailFor,
  encounterFloorPerPart,
  encounterFloorTotal,
  entityKindFor,
  levelForPlanIndex,
  moduleCreationPool,
  moduleDocumentText,
  moduleLevelSectionsFromView,
  modulePartsUntouched,
  MODULE_SIZE_WORD_TARGETS,
  partWriterModelFor,
  planIndexForLevel,
  sameAliasName,
  textOriginIsMachineWritten,
  withEntityBestiarySlots,
  type EncounterBudgetPolicy,
  type EncounterFloorGuardrail,
  type ModuleDifficulty,
  type ModuleLevelState,
} from '@/domain';
import { canonicalEntityRecords, mergeEntityRewriteProposals, mergeNewEntityRecords, normalizationReplySchema, unclassifiedEntityNames, validateNormalizationReply, type NormalizationEntry } from '@/domain/entityNormalization';
import {
  composePromptFromTemplate,
  validatePromptStyleTemplate,
  type ModulePromptStyle,
} from '@/domain/promptStyle';
import {
  builtinPromptStyle,
  modulePromptStyleOf,
  PART_ENDING_LINES,
  partsContractValues,
  promptStyleForModule,
} from '@/llm/promptStyles';
import { Emitter } from '@/llm/emitter';
import { createCampaignDocument, getModule, listModulesByCampaign, patchModule, saveModuleLevels } from '@/db/moduleRepo';
import { addArtifactAliases, listArtifactsByCampaign } from '@/db/artifactRepo';
import { snapshotModuleVersion } from '@/db/moduleVersionRepo';
// The LINKS hook (10 D12): every write that puts new prose on the row promotes
// the second-module wikilink uses it carries. ONE import, shared by the
// engine's own level write and the level-text edit path.
import { promoteSecondModuleUses } from '@/db/artifactAutoPromote';
import { GAME_SYSTEM_LABELS, type GameSystem } from '@/domain/gameSystem';
import { getSettings, readPromptStyles } from '@/db/settingsRepo';
import { setBackgroundActivity, clearBackgroundActivity } from '@/lib/backgroundTitle';
import { moduleGenLockName, withGenerationLock } from '@/lib/generationLocks';
import { chat, MissingApiKeyError, type ChatMessage, type ChatStreamActivity } from '@/llm/openrouter';
import { parseErrorSummary, parseJsonReply } from '@/llm/jsonReply';
import { repairModel } from '@/llm/modelFallback';
import { recordGlobalChatModelInUse } from '@/llm/recentChatModel';
import { schemaResponseFormat } from '@/llm/strictSchema';
import { searchRules } from '@/search';
import { extractWikiLinks, resolveWikiLink, rewriteWikiLinkTargets, surroundingParagraphs, type LinkRewrite } from '@/lib/wikilinks';
import { generatedTextScanForFields } from '@/llm/generatedTextHygiene';
import {
  MODULE_PREMISE_LABEL,
  PART_TOO_SHORT_REPAIR_SENTENCE,
} from '@/llm/promptScaffolding';
// The ONE critique-and-edit pass (docs/17 row 356). It returns a REPORT and
// never writes; the trigger below is the caller that persists an edit.
import { runAdversarialPass, type AdversarialPassReport } from '@/llm/adversarialPass';
import { toastError, toastSuccess } from '@/lib/toast';
import { errorMessage } from '@/lib/errors';
import { useProgressStore } from '@/lib/progress';
import { getStopEpoch, stoppedSince } from '@/lib/stopEpoch';
import { modulePath } from '@/app/routes';

/**
 * Module Designer generator (08-MODULE-DESIGNER M4-B): ONE pass — it writes the
 * module document's LEVEL SECTIONS, one call per level, sequentially, markdown
 * out (docs/23 §10 phase 3, docs/17 row 392: the pass-0 spine is DELETED and the
 * CHAT authors the premise and the level list). Progress/state lives on the
 * Module row itself (statuses in the domain), observed via `useLiveQuery`;
 * streaming tokens cross to the UI through this in-memory emitter only.
 *
 * Deliberately NOT built on personas/runEngine: different flow, and the prose
 * pass has no JSON contract at all (empty/<100-char output is the failure
 * criterion, retried once). Failures are loud (AGENTS rule 1): a level failure
 * marks that level `failed` (visible error card + Retry in its slot) and the
 * chain CONTINUES — level N gets continuity from level N−1 only (no context
 * when the predecessor failed).
 */

export type ModuleGenEvent =
  /**
   * A level's streaming text. THE UNIT IS THE LEVEL NUMBER (docs/23 §2.1,
   * docs/17 row 391): a subscriber addresses the level it is watching by its
   * number, exactly as the document does, and never by a `planIndex`.
   */
  | { kind: 'part-token'; moduleId: Id; level: number; delta: string }
  | { kind: 'part-thinking'; moduleId: Id; level: number; delta: string }
  | { kind: 'done'; moduleId: Id };

/** The generator event bus (the ONE emitter primitive, docs/18 §2.2). */
export const moduleGenEvents = new Emitter<ModuleGenEvent>();

/** In-flight generation per module; a second start on the same row throws. */
const controllers = new Map<Id, AbortController>();

/**
 * A SECOND generation was refused because this module's single generation slot
 * is taken (`controllerFor` here, `llm/canvasBusy.claimModuleGeneration`,
 * `llm/canvasRefine`, `llm/canvasChat`, `llm/modulePlan`). Loud and never
 * queued: the caller decides how to say it (`features/modules/module-busy`).
 *
 * The MESSAGE is a sentence for the owner, and it carries NO row id
 * (docs/17 row 123). It used to be ``Module <uuid> is already generating``, and
 * that text reached the owner twice over: as the chat card's `error` line
 * (`canvas/chatController`'s failed-turn write and `canvas/snapshotChat`'s
 * mirror read `error.message` for ANY thrown error, and a busy refusal is one
 * of them) and as a toast's description (`lib/toast.ts` suppressed the
 * description for this class by NAME; it still does, because the title already
 * names the state and both ways out, so a description could only restate it).
 */
export class ModuleBusyError extends Error {
  /**
   * The module whose generation slot refused the call. STRUCTURAL, and the
   * replacement for the id that used to ride in the message: the console/log
   * path prints the error OBJECT (`lib/toast.ts` logs the raw error for a busy
   * refusal), and a caller that needs the row reads this field instead of
   * parsing text. Never render it to the owner.
   */
  readonly moduleId: Id;

  constructor(moduleId: Id) {
    super('This module is already generating — wait for it to finish or stop it first.');
    this.moduleId = moduleId;
    this.name = 'ModuleBusyError';
  }
}

function controllerFor(moduleId: Id): AbortController {
  const existing = controllers.get(moduleId);
  if (existing !== undefined) throw new ModuleBusyError(moduleId);
  const controller = new AbortController();
  controllers.set(moduleId, controller);
  return controller;
}

/** Aborts any in-flight spine/parts work for the module. */
export function cancelModuleGen(moduleId: Id): void {
  controllers.get(moduleId)?.abort();
  controllers.delete(moduleId);
}

/**
 * Is a forge pass (spine, parts, post-generation) live for this module IN THIS
 * PAGE? (docs/17 row 110, docs/18 §2.2.)
 *
 * The row's `status: 'generating'` is a LEASE, not a fact: it says somebody was
 * writing, and the only authority for "somebody" is this registry. The
 * interrupted-generation reconciler (`llm/moduleGenReconcile`) fails such a row
 * ONLY when this answers `false`, so a live pass can never be reconciled out
 * from under itself — the guard is the whole reason that write is safe.
 *
 * Deliberately per-PAGE: a second browser tab's controller is invisible here,
 * which is why the reconciler reads the generation lock (lib/generationLocks)
 * as its second half.
 */
export function hasLiveModuleGen(moduleId: Id): boolean {
  return controllers.has(moduleId);
}

/**
 * One forge pass with its two presentation duties (docs/17 row 110):
 *
 * 1. **A Web Lock for the whole pass** (`lib/generationLocks`, released when
 *    the pass settles, never blocking anything when the API is absent or the
 *    lock is held elsewhere). Chromium's freeze criteria list a held Web Lock
 *    as an opt-out, so this is the cheap half of "let the browser keep giving
 *    the app its resources"; it doubles as the cross-tab lease the reconciler
 *    reads.
 * 2. **The background title** (`lib/backgroundTitle`): while the tab is
 *    elsewhere, the title says what is running and — when it ends — whether it
 *    finished. The VERDICT comes from the ROW, never from the error: a user
 *    stop throws as well, and a stop reaches no verdict, so it clears the
 *    entry instead of reporting a failure that did not happen.
 *
 * The label read happens before the pass body, which starts the controller: the
 * lock is already held by then, and the reconcile write re-checks liveness
 * inside its own transaction (see `features/progress/stop-all-generations` and
 * `llm/moduleGenReconcile`), so the order is safe.
 */
async function withForgePresentation<T>(
  moduleId: Id,
  pass: () => Promise<T>,
  verdictOf: (result: T) => 'completed' | 'failed' | 'aborted',
): Promise<T> {
  const activityId = `module-gen-${moduleId}`;
  const title = (await getModule(moduleId))?.title ?? 'Module generation';
  setBackgroundActivity(activityId, { label: title, state: 'running' });
  try {
    const result = await withGenerationLock(moduleGenLockName(moduleId), pass);
    const verdict = verdictOf(result);
    if (verdict === 'aborted') clearBackgroundActivity(activityId);
    else setBackgroundActivity(activityId, { label: title, state: verdict });
    return result;
  } catch (error) {
    const live = await getModule(moduleId);
    if (live?.status === 'failed') {
      setBackgroundActivity(activityId, { label: title, state: 'failed' });
    } else {
      clearBackgroundActivity(activityId);
    }
    throw error;
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * Cancellation recognition (18-ARCHITECTURE seam): the run controller's
 * `signal.aborted` is the source of truth — NOT the error's type. The
 * streaming pipeline may surface a user stop as a same-realm AbortError, a
 * cross-realm AbortError (`instanceof DOMException` fails across realms —
 * probed with a real abort mid-stream: CTOR DOMException, name AbortError,
 * instanceof false), a wrapped transport error, or no error at all (a stop
 * landing between calls). Every moduleGen catch that decides
 * cancel-vs-failure reads this helper with the run's own signal, so a stop
 * can never be misread as a part failure that lets the chain advance.
 */
/**
 * The loop-boundary stop check ("a stopped orchestration must not start its
 * next unit"). A helper rather than an inline `signal.aborted` test: the
 * control-flow narrowing from the loop guards above would make a later inline
 * test look statically dead, while at RUNTIME the signal is aborted by an
 * external event (the user's Stop all) at any await point.
 */
function throwIfStopped(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Module generation was cancelled', 'AbortError');
  }
}

function isCancel(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return isAbort(error);
}

/**
 * Live dock detail for one streamed LLM call (00-OVERVIEW: multi-minute work
 * must never look like a hang). The spine and part passes feed the stream's
 * `onToken`/`onActivity` events through this reporter; it throttles dock
 * updates to ~3/s (deltas arrive in bursts) and renders either the received
 * char count or what the model is doing right now — reasoning deltas never
 * reach `onToken`, so a thinking model would otherwise look frozen for
 * minutes.
 */
function streamDetailReporter(
  jobId: string,
  baseDetail: string,
): {
  onToken: (delta: string) => void;
  onActivity: (activity: ChatStreamActivity) => void;
} {
  let chars = 0;
  let lastAt = 0;
  const report = (detail: string): void => {
    const now = Date.now();
    if (now - lastAt < 400) return;
    lastAt = now;
    useProgressStore.getState().update(jobId, { detail });
  };
  return {
    onToken: (delta) => {
      chars += delta.length;
      report(`${baseDetail} — ${String(chars)} chars received`);
    },
    onActivity: (activity: ChatStreamActivity) => {
      const seconds = Math.round(activity.elapsedMs / 1000);
      if (activity.phase === 'thinking') {
        // Set the expectation explicitly: reasoning models routinely think
        // for minutes on design-sized prompts — without this users read the
        // quiet dock as a hang and kill the run mid-think.
        report(
          `${baseDetail} — the model is thinking (${String(seconds)}s). ` +
            'Big design asks routinely take several minutes of thinking before the first words arrive — this is normal, not a hang.',
        );
      } else if (activity.phase === 'waiting' && seconds >= 5) {
        report(
          `${baseDetail} — no answer yet (${String(seconds)}s). ` +
            'The request may be queued at the provider; the first bytes can take minutes.',
        );
      }
    },
  };
}



/**
 * Outcome limits per module tone (08 §M4-B tone dial): what a matching tone
 * rules out, never a register or a mood — the prose palette stays fully open
 * (murder clown and grieving revenge both clear every gate). The planner
 * prompt states the universal demand positively (a cost, a loss, or a new
 * problem) and then renders this module tone's 2-3 limits; an unlisted
 * (free-text) tone carries no ban list at all, because the universal demand
 * already names every frictionless resolution these entries used to forbid.
 */
export const MODULE_TONE_BANS: Readonly<Record<string, readonly string[]>> = {
  heroic: [
    'The confrontation is won by a bystander sacrifice the party never chose.',
    'The villain yields the moment the party demonstrates superior resolve.',
  ],
  hopeful: [
    'Every loss is undone before the part ends.',
    'A bleak outcome is reversed by a last-moment turn that costs no one.',
  ],
  whimsical: [
    'The conflict dissolves because it was all a misunderstanding with no remaining consequences.',
    'A trickster rewinds events so the party’s choices leave no trace.',
  ],
  mystery: [
    'The culprit confesses the whole scheme unprompted.',
    'The final clue arrives from nowhere instead of from the investigation.',
  ],
  intrigue: [
    'Every faction honors its bargain with no betrayal priced in.',
    'A divided loyalty is settled by exposition rather than by what is sacrificed.',
  ],
  horror: [
    'The threat is fully explained and dismantled with nothing unknown left standing.',
    'Everyone escapes the scene without loss.',
  ],
  tragedy: [
    'A doomed stand is rescued by an intervention nobody earned.',
    'The price of the outcome lands on someone uninvolved instead of on whoever chose it.',
  ],
};

/** The per-part floor instruction, or `null` when the floor is disabled. */
function perPartFloorClause(levelBand: string, levels: number, required: number): string | null {
  if (required <= 0) return null;
  return (
    `REQUIREMENT — encounter floor for this part (levels ${levelBand}: ${String(levels)} level(s)): ` +
    `name at least ${String(required)} distinct encounter(s) in this part's markdown as [[Encounter Name]] wiki-links, ` +
    `each a fight with real stakes, staged where a battle map and a monster roster make sense. ` +
    `A negotiation, hazard, puzzle, investigation or chase is an event, not an encounter, and cannot cover this floor. ` +
    `Encounters already named in earlier parts do not count toward this part's share; never pad with repetitive or disposable encounters.`
  );
}


/** The floor repair instruction for one short part, or `null` when the floor is
 * disabled (there is nothing to repair). */
function floorRepairInstruction(target: PartEncounterCount): string | null {
  if (target.required <= 0) return null;
  return (
    `Encounter floor repair: this part covers levels ${target.levelBand} ` +
    `(${String(target.required)} level(s)) and must name at least ${String(target.required)} ` +
    `distinct encounter(s) in its markdown as [[Encounter Name]] wiki-links — fights with real stakes, ` +
    `staged where a battle map and a monster roster make sense (a negotiation, hazard, puzzle, investigation ` +
    `or chase is an event and does not count). ` +
    `It currently names ${String(target.found)}. Add the missing encounters; keep the part's story, ` +
    `characters and continuity intact. Encounters already named in other parts do not count toward this part's share. `
  );
}

/**
 * The SCOPED rewrite instruction for one short part — the check's own words plus
 * the closing move every floor repair carries (full-price satisfaction in the
 * finale, a carried cost elsewhere), composed in ONE place so the in-pass repair
 * and the "Fix module problems" entry point can never ask for different things.
 * A disabled floor never yields a repair target, so the `null` branch is a loud
 * invariant rather than a fallback: reaching it would mean a target was computed
 * for a floor that demands nothing.
 */
function floorRepairRewriteInstruction(target: PartEncounterCount, levelCount: number): string {
  const instruction = floorRepairInstruction(target);
  if (instruction === null) {
    throw new Error(
      `Encounter floor repair was requested for "${target.title}" while the module's floor is disabled`,
    );
  }
  return (
    instruction +
    (levelForPlanIndex(target.planIndex) === levelCount
      ? `This is the FINALE: satisfaction is allowed at full price — every want met is paid for visibly.`
      : `End the part with a cost, a revelation, or a new pressure that carries into the next part.`)
  );
}

/** The tone entry's bans for a free-text module tone (exact match, case-insensitive). */
export function toneBansFor(tone: string): readonly string[] | null {
  return MODULE_TONE_BANS[tone.trim().toLowerCase()] ?? null;
}

// --- Prior-module continuity (opt-in) -----------------------------------------

/**
 * Caps for the prior-modules context section (08 §M4-B): one part's markdown,
 * one module's whole block, and the joined section. Bounded context keeps a
 * many-module campaign from ballooning every call.
 */
export const PRIOR_PART_CHAR_CAP = 4000;
export const PRIOR_MODULE_CHAR_CAP = 8000;
export const PRIOR_MODULES_TOTAL_CAP = 24000;
/** Campaign cast block budget inside the prior-modules total (~2.4k chars). */
export const CAMPAIGN_CAST_CHAR_CAP = 2400;
/** Shared-name roster cap — the same 60-name convention as the spine/parts
 * campaign indexes. */
export const CAMPAIGN_CAST_NAME_CAP = 60;

/** True when the module carries any generator-authored text at all. */
function hasPriorText(module: Module): boolean {
  return (module.spine?.premise ?? '') !== '' || module.parts.some((part) => part.markdown !== '');
}

/** Hard-truncates with a visible marker — never a silent cut. */
function truncate(text: string, cap: number): string {
  return text.length <= cap ? text : `${text.slice(0, cap)}…[truncated]`;
}

/** One prior module's block: title, premise, then its written levels in order. */
function priorModuleBlock(module: Module): string {
  const lines: string[] = [];
  lines.push(`## ${module.title} (levels ${String(module.levelMin)}–${String(module.levelMax)})`);
  const premise = module.spine?.premise ?? '';
  if (premise !== '') lines.push(`Premise:\n${truncate(premise, PRIOR_PART_CHAR_CAP)}`);
  const blockParts: string[] = [];
  for (const part of [...module.parts].sort((a, b) => a.planIndex - b.planIndex)) {
    if (part.markdown === '') continue;
    // The heading names the LEVEL, from the derived view's planIndex through the
    // ONE conversion — never the stored plan title (a chat-authored level has
    // none, docs/17 row 390) and never arithmetic of our own.
    const level = levelForPlanIndex(part.planIndex);
    blockParts.push(
      `### Level ${String(level)}\n${truncate(part.markdown, PRIOR_PART_CHAR_CAP)}`,
    );
  }
  if (blockParts.length > 0) lines.push(blockParts.join('\n\n'));
  return truncate(lines.join('\n\n'), PRIOR_MODULE_CHAR_CAP);
}

/**
 * Campaign-level cast list (auto-promote follow-up reuse): the campaign-scoped
 * (`moduleId`-null) rows module creation may see — names + kinds, capped like
 * the campaign indexes — so follow-up generations reuse the shared names
 * exactly instead of inventing duplicates. Returns null when nothing is
 * shared yet.
 *
 * The Party is NOT part of the cast: `pc` rows are excluded through the ONE
 * domain constant (`MODULE_CREATION_EXCLUDED_KINDS`, 08 §M4-B, docs/17 row
 * 69) — the players' characters are authored, not campaign setting content
 * the generator may reuse. Applied here as well as at the load sites, so a
 * caller passing a raw list cannot leak the party back in.
 */
export function campaignCastContext(artifacts: readonly AnyArtifact[]): string | null {
  const shared = moduleCreationPool(artifacts).filter((artifact) => artifact.moduleId === null);
  if (shared.length === 0) return null;
  const lines = shared
    .slice(0, CAMPAIGN_CAST_NAME_CAP)
    .map((artifact) => `- ${artifact.name} (${artifact.kind})`);
  return truncate(
    'Shared campaign cast (used across modules — reuse these exact names, do not duplicate them):\n' +
      lines.join('\n'),
    CAMPAIGN_CAST_CHAR_CAP,
  );
}

/**
 * Builds the prior-modules context section (08 §M4-B opt-in continuity): the
 * campaign's other modules that carry any authored text — premise, part texts,
 * drafts included — in story order (oldest first). When the total cap would
 * overflow, the OLDEST modules are dropped first (recent history matters most
 * for continuity). Returns null when nothing qualifies — the section is then
 * omitted entirely; an empty set is not an error.
 *
 * The shared `cast` block (campaignCastContext) rides the same section so
 * follow-ups reuse promoted names; it is budgeted INSIDE the 24k total.
 */
export function priorModulesContext(
  priors: readonly Module[],
  cast: string | null = null,
): string | null {
  const blocks = [...priors]
    .sort((a, b) => a.createdAt - b.createdAt)
    .filter(hasPriorText)
    .map(priorModuleBlock);
  const kept: string[] = [];
  let total = cast?.length ?? 0;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block === undefined) continue;
    if (total + block.length > PRIOR_MODULES_TOTAL_CAP) continue;
    kept.unshift(block);
    total += block.length;
  }
  if (kept.length === 0 && cast === null) return null;
  return [
    'Previous modules of this campaign, oldest first — settled history. ' +
      'Build on their events and open threads, reuse their established names exactly, and never retcon them:',
    ...(cast === null ? [] : [cast]),
    kept.join('\n\n'),
  ].join('\n\n');
}

/**
 * Loads the campaign's other modules for the opt-in continuity context. The
 * flag off short-circuits to [] (previous behavior, byte-for-byte); a failed
 * read propagates — an opted-in run must not silently generate without the
 * context it promised (AGENTS rule 1). `override` (canvas rewrite dialog)
 * wins over the row flag when set.
 */
async function priorModulesOf(module: Module, override?: boolean): Promise<Module[]> {
  const enabled = override ?? module.includePriorModules;
  if (!enabled) return [];
  const modules = await listModulesByCampaign(module.campaignId);
  return modules.filter((candidate) => candidate.id !== module.id);
}


async function failModule(moduleId: Id, error: unknown, signal: AbortSignal): Promise<void> {
  if (isCancel(error, signal)) {
    // Cancellation: rewind a spine-only module so the user can retry cleanly.
    const module = await getModule(moduleId);
    if (module?.status === 'generating' && modulePartsUntouched(module)) {
      await patchModule(moduleId, { status: 'draft' });
    }
    return;
  }
  if (error instanceof ModuleBusyError) return;
  // Generation failures surface via toast AND on the row (AGENTS rule 2).
  if (error instanceof MissingApiKeyError) {
    toastError('No API key — add one in Settings', error);
  } else {
    toastError('Module generation failed', error);
  }
  const message = errorMessage(error);
  await patchModule(moduleId, { status: 'failed', errorMessage: message });
}

// --- Encounter floor (hard, 08 §M4-B) ------------------------------------------

/**
 * Levels covered by one part's levelBand (`1`, `2-3`, `2–3`, `2 - 3` — hyphen,
 * en/em dash, optional spaces); anything unparseable counts as 1 level, never
 * 0 (an unreadable band must not zero out the part's quota).
 */
export function levelsInLevelBand(levelBand: string): number {
  const match = /^\s*(\d{1,2})\s*(?:[-–—]\s*(\d{1,2}))?\s*$/.exec(levelBand);
  if (match === null) return 1;
  const from = Number(match[1]);
  const to = match[2] === undefined ? from : Number(match[2]);
  if (!Number.isInteger(from) || !Number.isInteger(to)) return 1;
  return Math.max(1, Math.abs(to - from) + 1);
}

/** One part's share of the encounter floor. */
export interface PartEncounterCount {
  planIndex: number;
  title: string;
  levelBand: string;
  /** Levels the band covers = encounters this part's markdown must name. */
  required: number;
  /** Distinct canonical encounters named in this part's markdown. */
  found: number;
}

/** The whole-module encounter floor report (pure — see `countModuleEncounters`). */
export interface EncounterFloorReport {
  /** Distinct canonical encounters named in the whole document text. */
  found: number;
  /** levelMax − levelMin + 1. */
  required: number;
  perPart: PartEncounterCount[];
  /** Parts naming fewer encounters than their band covers. */
  deficient: PartEncounterCount[];
}

/**
 * Distinct canonical encounter names in one markdown text: the set of
 * lowercased `extractWikiLinks` targets whose recorded
 * `entityKindFor(entityKinds, name)` is `'encounter'` (post-normalization
 * canonicals — aliases already rewrote to `[[canonical|display]]`, so
 * variants fold onto the canonical; existing-campaign reuse counts because
 * the record exists either way). Records alone never count: an encounter
 * entity with no `[[link]]` in the text contributes nothing.
 */
function encounterNamesIn(
  markdown: string,
  entityKinds: readonly ModuleEntityKind[],
): Set<string> {
  // KEY SPACE `WRITTEN_LINK_NAME_KEY` (docs/17 row 167): the set counts
  // DISTINCT WRITTEN `[[tokens]]` of encounter-kind entities — the consumer is
  // `.size` (the encounter floor), so two compositions of one written token
  // must count once, and two different tokens must count twice.
  const names = new Set<string>();
  for (const link of extractWikiLinks(markdown)) {
    if (entityKindFor(entityKinds, link.name) !== 'encounter') continue;
    names.add(comparableName(link.name));
  }
  return names;
}

/**
 * Counts the module's encounter floor (pure): the whole-document distinct
 * encounter set against levelCount, allocated per band — each level section's
 * markdown must name at least `levelsInLevelBand` encounters. A level with no
 * written text counts 0. sizeDial-independent; the 4× ceiling stays advisory
 * and is never counted here (over-quota never fails). The FLOOR is the
 * module's own recorded guardrail (or today's default when it recorded none).
 *
 * THE PER-PART FIGURES COME FROM THE DOCUMENT'S LEVEL SECTIONS (docs/23 §4,
 * docs/17 row 391): a level's own section text is what the floor counts, and
 * `section.title` is the ONE display label (the derived `Level N`, or a stored
 * plan title on a legacy row) — never a second reading of the plan record.
 */
export function countModuleEncounters(
  module: Module,
  floor: EncounterFloorGuardrail = encounterFloorGuardrailFor(module),
): EncounterFloorReport {
  const required = encounterFloorTotal(floor, module.levelMax - module.levelMin + 1);
  const perPart: PartEncounterCount[] = moduleLevelSectionsFromView(module).map((section) => {
    const levelBand = String(section.number);
    return {
      planIndex: section.planIndex,
      title: section.title,
      levelBand,
      required: encounterFloorPerPart(floor, levelsInLevelBand(levelBand)),
      found: encounterNamesIn(section.text, module.entityKinds).size,
    };
  });
  const found = encounterNamesIn(moduleDocumentText(module), module.entityKinds).size;
  // A disabled floor has no shortfall: `required` is 0 and no band is deficient,
  // so every gate built on this report passes by construction.
  const deficient = floor.enabled ? perPart.filter((entry) => entry.found < entry.required) : [];
  return { found, required, perPart, deficient };
}

/** Loud failure copy for the floor gate — names every deficient part. */
export function encounterFloorMessage(report: EncounterFloorReport): string {
  const base =
    `Encounter floor not met: the module needs ${String(report.required)} distinct named ` +
    `encounters for its level range but the document names ${String(report.found)}.`;
  if (report.deficient.length > 0) {
    const parts = report.deficient
      .map(
        (entry) =>
          `"${entry.title}" (band ${entry.levelBand}): needs ${String(entry.required)}, names ${String(entry.found)}`,
      )
      .join('; ');
    return `${base} Deficient parts: ${parts}.`;
  }
  return `${base} Every part meets its band quota but names repeat across parts — add distinct encounters.`;
}

/**
 * Throws when the module is short of its encounter floor (total distinct OR
 * any band allocation). The runParts gate catches the report itself for the
 * repair pass; this is the fail-loud verdict shared by the gate and tests.
 */
export function assertEncounterFloor(
  module: Module,
  floor: EncounterFloorGuardrail = encounterFloorGuardrailFor(module),
): void {
  const report = countModuleEncounters(module, floor);
  if (report.found < report.required || report.deficient.length > 0) {
    throw new Error(encounterFloorMessage(report));
  }
}

/**
 * The parts a floor repair must rewrite for the module's CURRENT shortfall: the
 * deficient parts (each short of its own band's share) — or, when every band is
 * met but the whole-module total is short, i.e. the names REPEAT across parts,
 * every planned part, because only DISTINCT encounters can help there. Empty
 * when the floor is met (or disabled).
 *
 * ONE derivation of the repair scope: the parts-pass repair reads it (full runs),
 * the "Fix module problems" problem set lists exactly these parts in its
 * confirmation, and the repair entry point re-derives it before each rewrite — so
 * a button can never promise a different scope than the repair judges by. The
 * floor's own numbers, message and resolver are untouched.
 */
export function floorRepairTargets(
  module: Module,
  floor: EncounterFloorGuardrail = encounterFloorGuardrailFor(module),
): PartEncounterCount[] {
  const report = countModuleEncounters(module, floor);
  if (report.deficient.length > 0) return report.deficient;
  if (report.found >= report.required) return [];
  return report.perPart.filter((entry) => entry.required > 0);
}

/**
 * Puts a part row back exactly as it stood before a rewrite that FAILED or was
 * CANCELLED (`generatePart` clears the slot before its call, so without this the
 * pre-repair prose would be gone — AGENTS rule 1). Restores only when the attempt
 * left the slot EMPTY: text the attempt actually wrote is kept (the user judges
 * it, with the durable pre-change snapshot to undo it), and text already
 * written outside the generator is never clobbered (`live.edited` with
 * nothing of ours to undo — `edited` is exactly "written outside the
 * generator", docs/17 row 113, so this guard deliberately reads that field
 * and NOT `origin`). ONE restore used
 * by the in-pass floor repair and by the "Fix module problems" entry point.
 */
async function restoreLevelAfterFailedRepair(
  moduleId: Id,
  level: number,
  snapshot: ModulePart | undefined,
): Promise<void> {
  if (snapshot === undefined) return;
  const current = await requireModule(moduleId);
  const section = moduleLevelSectionsFromView(current).find((entry) => entry.number === level);
  if (section?.text !== '') return;
  // `edited` is "written outside the generator" (docs/17 row 113): text the
  // attempt did not clear, and text the generator never owned, are both left
  // alone. Read from the derived view's run state through the ONE conversion.
  const liveState = current.parts.find(
    (part) => part.planIndex === planIndexForLevel(level),
  );
  if (liveState?.edited === true && !snapshot.edited) return;
  await saveModuleLevels(moduleId, [
    {
      level,
      text: snapshot.markdown,
      state: {
        status: snapshot.status,
        errorMessage: snapshot.errorMessage,
        edited: snapshot.edited,
        writerModel: snapshot.writerModel,
        origin: snapshot.origin,
      },
    },
  ]);
}

/**
 * The user-visible sentence of a failed normalization pass — ONE wording, so the
 * post-parts normalization, the re-normalization after a floor repair, the
 * incremental classification and the entity panel's own belt all report it
 * identically. Exported because the panel's belt is not a pass failure (it has
 * no module-row write to ride `recordNormalizationFailure` for) yet must not
 * carry a fourth copy of the sentence.
 */
export const NORMALIZATION_FAILURE_MESSAGE =
  'Entity name normalization failed — retry from the entity panel';

/**
 * The user-visible half of a failed normalization pass (the pass records the
 * gate state on the module row itself — `entityNamesNormalized: false` + the
 * error). ONE wording, so a repair run and a parts pass report it identically.
 * Every normalization catch goes through THIS — never `toastError` with the
 * sentence spelled out again (the three sites that did drifted: the
 * classification catch was the one catch of the four with no cancel guard).
 */
function recordNormalizationFailure(error: unknown): void {
  toastError(NORMALIZATION_FAILURE_MESSAGE, error);
}

// --- Pass 1 — levels ---------------------------------------------------------

export interface PartsRunOptions {
  /**
   * Which LEVEL SECTIONS to generate, BY LEVEL NUMBER (docs/23 §2.1, docs/17
   * row 391); default: every level section of the document, in order. Level 0
   * (the premise) is not a level section and is never named here — the chat
   * authors the premise, and the engine writes level sections.
   */
  levels?: readonly number[] | undefined;
  /** Optional user instruction appended to a single-level rewrite. */
  extraInstruction?: string | undefined;
  /**
   * Per-run override of the module row's `includePriorModules` flag (canvas
   * rewrite dialog). Undefined = read the row (all existing callers —
   * byte-for-byte behavior).
   */
  includePriorModules?: boolean | undefined;
}

/**
 * The honest one-line label for a level pass (docs/18 §2.3): the Versions menu
 * shows it against the snapshot taken BEFORE the pass, so it names what the
 * pass is about to do — "Generate levels" (full pass), "Generate N missing
 * levels" (hole fill), or "Rewrite level <n>: <instruction opening>"
 * (single-level rewrite/regenerate, board rewrite). Never a generic "AI
 * change".
 *
 * IT NAMES THE LEVEL BY ITS NUMBER. The stored plan title is NOT read here any
 * more (docs/17 rows 390/391): a chat-authored level has none, and the level's
 * load-bearing identity is its number (docs/23 §2).
 */
function partsRunLabel(options: PartsRunOptions): string {
  const levels = options.levels;
  if (levels === undefined) return 'Generate levels';
  if (levels.length !== 1) return `Generate ${String(levels.length)} missing levels`;
  const level = levels[0];
  if (level === undefined) return 'Generate levels';
  const head = `Rewrite level ${String(level)}`;
  const instruction = (options.extraInstruction ?? '').trim();
  return instruction === '' ? head : `${head}: ${instruction.slice(0, 60)}`;
}

/**
 * The module's level sections, in document order — THE list a full pass
 * iterates and the only place a default scope comes from.
 */
function runLevelSections(module: Module): { number: number; text: string }[] {
  return moduleLevelSectionsFromView(module).map((section) => ({
    number: section.number,
    text: section.text,
  }));
}

/**
 * Runs pass 1: one markdown call per LEVEL SECTION, sequentially. Each finished
 * level lands in the ONE document immediately (progressive reveal — the reader
 * shows level 1 while level 3 streams). A failed level does NOT stop the chain:
 * it is marked failed (with its error) and generation continues. Continuity for
 * level N comes from the level at N−1 only — when that predecessor failed,
 * level N is written WITHOUT continuity context.
 *
 * SIMPLE UNDO (docs/18 §2.3): the pass takes ONE durable whole-document
 * snapshot at ENTRY — before the first row write — so every level this pass
 * rewrites (generation, missing-level fill, single-level rewrite/regenerate,
 * the board's staged rewrite, and the floor-repair rewrites inside the pass)
 * can be undone as a whole. The in-pass `normalizeModuleEntityNames` calls
 * take their OWN snapshot (see that function), because they are separate AI
 * passes over the text.
 */
export async function runParts(
  moduleId: Id,
  campaign: Campaign,
  options: PartsRunOptions = {},
): Promise<Module> {
  return (await runPartsPass(moduleId, campaign, options)).module;
}

/**
 * What a parts pass returned (workflow wrappers only). `aborted` is the
 * distinction the automation tail needs and the persisted row CANNOT carry:
 * a cancelled pass leaves parts in place and the module row at `'ready'` (so
 * the Retry buttons stay available — the cancellation contract), which is
 * byte-identical to a completed pass. Reading that status as "completed"
 * started the post-generation sweep right after a user pressed Stop all
 * (the owner's bug: "it only stops the current type loop").
 */
export interface PartsPassResult {
  module: Module;
  /** True when a cancel ended the pass (parts stay, row stays resumable). */
  aborted: boolean;
}

/** The pass body: see `runParts`, which is the only public entry. */
async function runPartsPass(
  moduleId: Id,
  campaign: Campaign,
  options: PartsRunOptions = {},
): Promise<PartsPassResult> {
  return withForgePresentation(
    moduleId,
    () => runPartsPassUnlocked(moduleId, campaign, options),
    (result) =>
      result.aborted ? 'aborted' : result.module.status === 'failed' ? 'failed' : 'completed',
  );
}

/** The parts-pass body (wrapped by `runPartsPass`; `aborted` is its verdict). */
async function runPartsPassUnlocked(
  moduleId: Id,
  campaign: Campaign,
  options: PartsRunOptions = {},
): Promise<PartsPassResult> {
  const controller = controllerFor(moduleId);
  // App-wide progress dock (00-OVERVIEW): parts are a known-length list, so
  // the bar fills per part and the detail names the part being written.
  const progress = useProgressStore.getState();
  const jobId = `module-parts-${moduleId}`;
  try {
    const settings = await getSettings();
    // The parts pass writes every part on the GLOBAL first-try model (a
    // fallback-model floor repair replaces it per part, and is deliberately NOT
    // recorded — it is the escalation tier; docs/17 row 198).
    recordGlobalChatModelInUse(settings.defaultChatModel);
    const module = await requireModule(moduleId);
    if (module.spine === null) throw new Error('Cannot generate levels without an approved document');
    // Durable pre-change snapshot (docs/18 §2.3 simple undo): the WHOLE module
    // document as it stands before this pass writes anything. Loud on failure
    // — an AI pass must not rewrite level text whose pre-state could not be
    // recorded (the throw fails the module through the existing loud path).
    await snapshotModuleVersion(moduleId, 'generation', partsRunLabel(options));
    await patchModule(moduleId, { status: 'generating', errorMessage: '' });

    const levels = options.levels ?? runLevelSections(module).map((section) => section.number);
    const total = levels.length;
    progress.start(
      jobId,
      `Writing ${String(total)} module level${total === 1 ? '' : 's'}`,
      'Starting the first level…',
      // The dock label opens the module reader, wherever the user currently is.
      modulePath(campaign.id, moduleId),
    );
    let index = 0;
    for (const level of levels) {
      // A stop that landed between calls throws no error on its own — without
      // this guard the loop would mark the next level 'generating' and fire a
      // doomed chat call before the abort surfaces. Fail fast instead: the
      // outer catch owns the quiet rewind (ready/draft, no toast, no advance).
      if (controller.signal.aborted) {
        throw new DOMException('Module generation was cancelled', 'AbortError');
      }
      const target = await requireModule(moduleId);
      if (target.spine === null) throw new Error('The document was removed mid-generation');
      progress.update(jobId, {
        progress: index / total,
        detail: `Writing level ${String(index + 1)} of ${String(total)}: level ${String(level)}`,
      });
      // Live dock detail for the (multi-minute) level call itself: char count
      // while the answer streams, "thinking…" while reasoning deltas arrive.
      const partReporter = streamDetailReporter(
        jobId,
        `Writing level ${String(index + 1)} of ${String(total)}: level ${String(level)}`,
      );
      let written: string | null = null;
      try {
        written = await generatePart(
          moduleId,
          target,
          level,
          campaign,
          settings.defaultChatModel,
          {
            signal: controller.signal,
            extraInstruction: options.extraInstruction ?? '',
            includePriorModules: options.includePriorModules,
            onToken: (delta) => {
              moduleGenEvents.emit({ kind: 'part-token', moduleId, level, delta });
              partReporter.onToken(delta);
            },
            onReasoning: (delta) => {
              moduleGenEvents.emit({ kind: 'part-thinking', moduleId, level, delta });
            },
            onActivity: partReporter.onActivity,
            // Embedding backfill on the level's retrieval path is reported on
            // the same job; the stream reporter overwrites the detail on the
            // first token/activity tick, so no staleness.
            onEmbeddingProgress: (done, total) => {
              progress.update(jobId, {
                detail: `Embedding rulebook excerpts (${String(done)}/${String(total)})…`,
              });
            },
          },
        );
      } catch (error) {
        if (isCancel(error, controller.signal)) throw error;
        // The failed part is persisted with its error by generatePart; the
        // chain continues with the next part (08 §M4-B).
      }
      // ADVERSARIAL LEVEL REVIEW (docs/17 row 358): with the module's flag ON,
      // each level is reviewed as soon as it is written — while its text is
      // fresh, and before the next level reads it as continuity context. The
      // review is contained (a failed critique/editor marks THIS level failed
      // with its text preserved and the chain continues), and it never runs for
      // a level that did not generate text.
      if (written !== null && adversarialReviewEnabled(target)) {
        await reviewLevelInGeneration({
          moduleId,
          level,
          ordinal: index + 1,
          total,
          text: written,
          signal: controller.signal,
          jobId,
        });
      }
      index += 1;
      progress.update(jobId, { progress: index / total });
    }

    // A stop that ended the LAST level leaves no next loop iteration to guard:
    // without this check the pass would fire its post-pass normalization call
    // for a module the user just stopped. Same quiet rewind as the loop
    // guard — the outer catch reads the signal, so it lands as `aborted`.
    throwIfStopped(controller.signal);
    progress.update(jobId, { progress: 1, detail: 'Normalizing entity names…' });
    // Entity name normalization (fix-01): one call after the levels land —
    // canonical names, kinds, link rewrites and aliases. A failure is
    // recorded on the module row (loud, batch gated, Retry in the panel).
    await normalizeModuleEntityNames(moduleId, controller.signal).catch((error: unknown) => {
      if (isCancel(error, controller.signal)) throw error;
      recordNormalizationFailure(error);
    });
    // Encounter-floor gate (08 §M4-B): counted on the NORMALIZED canonicals,
    // before the ready write — a short module is never shipped as ready.
    // Each deficient level in this run's scope gets ONE repair rewrite (the
    // same engine on the escalated model — see the repairModel rationale on
    // levelCall); hand-edited levels are NOT touched (their text changes only
    // on explicit consent — they fail loud instead). Then re-normalize,
    // recount, and fail the module loudly when still short. Good levels are
    // preserved (no rollback — levels are individually regenerable); callers
    // skip the post-generation automation on failure.
    //
    // THE SCOPE IS LEVELS, converted through the ONE pair for the floor
    // report's own planIndex vocabulary (docs/17 row 391) — no arithmetic.
    const scope = new Set(levels.map((level) => planIndexForLevel(level)));
    // The FLOOR this run enforces comes from the module row (its recorded
    // guardrail, or today's default) — the module's own rules rather than
    // whatever the dialog shows today.
    const partsFloor = encounterFloorGuardrailFor(await requireModule(moduleId));
    // A full run owns the whole-module total; a subset run (single-level
    // rewrite/retry) owns only its levels' band shares — it can neither fix
    // nor answer for the rest of the module.
    const isFullRun = (module: Module): boolean =>
      runLevelSections(module).every((section) => scope.has(planIndexForLevel(section.number)));
    const inScopeTargets = (module: Module): PartEncounterCount[] => {
      const report = countModuleEncounters(module, partsFloor);
      const deficient = report.deficient.filter((entry) => scope.has(entry.planIndex));
      if (deficient.length > 0) return deficient;
      // Full run whose bands are met but whose total repeats across levels:
      // every in-scope level must add DISTINCT encounters.
      if (isFullRun(module) && report.found < report.required) {
        return report.perPart.filter((entry) => scope.has(entry.planIndex));
      }
      return [];
    };
    const isFloorBlocking = (module: Module): boolean => {
      const report = countModuleEncounters(module, partsFloor);
      if (isFullRun(module)) return report.found < report.required || report.deficient.length > 0;
      return report.deficient.some((entry) => scope.has(entry.planIndex));
    };
    const gated = await requireModule(moduleId);
    const repairTargets = inScopeTargets(gated).filter((target) => {
      const part = gated.parts.find((entry) => entry.planIndex === target.planIndex);
      return part?.edited !== true;
    });
    let gate = gated;
    if (repairTargets.length > 0) {
      progress.update(jobId, { progress: 1, detail: 'Repairing encounter shortfall…' });
      const floorRepairModel = repairModel(settings.defaultChatModel, settings);
      for (const target of repairTargets) {
        if (controller.signal.aborted) {
          throw new DOMException('Module generation was cancelled', 'AbortError');
        }
        const current = await requireModule(moduleId);
        if (current.spine === null) throw new Error('The document was removed mid-generation');
        // Satisfaction is rationed to the finale: the repair carries the
        // resolution shape everywhere else, full-price satisfaction on the
        // closing level.
        const floorInstruction = floorRepairRewriteInstruction(
          target,
          runLevelSections(current).length,
        );
        const level = levelForPlanIndex(target.planIndex);
        try {
          await generatePart(moduleId, current, level, campaign, floorRepairModel, {
            signal: controller.signal,
            extraInstruction: floorInstruction,
            onToken: undefined,
            onReasoning: undefined,
            onActivity: undefined,
            onEmbeddingProgress: undefined,
          });
        } catch (error) {
          if (isCancel(error, controller.signal)) throw error;
          // A failed repair must not destroy the level's pre-repair prose:
          // restore the snapshot when the repair left nothing behind (and no
          // newer hand-edit landed meanwhile). The recount below still fails
          // the module loudly with the level named — the user retries the
          // level itself.
          await restoreLevelAfterFailedRepair(
            moduleId,
            level,
            current.parts.find((entry) => entry.planIndex === target.planIndex),
          );
        }
      }
      progress.update(jobId, { progress: 1, detail: 'Normalizing entity names…' });
      await normalizeModuleEntityNames(moduleId, controller.signal).catch((error: unknown) => {
        if (isCancel(error, controller.signal)) throw error;
        recordNormalizationFailure(error);
      });
      gate = await requireModule(moduleId);
    }
    const floorReport = countModuleEncounters(gate, partsFloor);
    if (isFloorBlocking(gate)) {
      let floorMessage = encounterFloorMessage(floorReport);
      if (!gate.entityNamesNormalized) {
        floorMessage +=
          ' Entity name normalization did not succeed for the current text, so the count uses the last recorded kinds — retry normalization from the entity panel if this looks wrong.';
      }
      // `edited` is "written outside the generator", NOT an authorship claim
      // (docs/17 row 113) — an accepted AI rewrite is in this list too, so the
      // sentence says what is true of the text (it was not rewritten) instead
      // of asserting the owner typed it.
      const untouchedDeficient = floorReport.deficient.filter((entry) =>
        gate.parts.some((part) => part.planIndex === entry.planIndex && part.edited),
      );
      if (untouchedDeficient.length > 0) {
        floorMessage +=
          ` Part(s) ${untouchedDeficient.map((entry) => `"${entry.title}"`).join(', ')} ` +
          `already written outside the generator were left untouched — add the missing [[encounter]] links by hand or rewrite.`;
      }
      toastError('Module generation failed: encounter floor not met', new Error(floorMessage));
      await patchModule(moduleId, { status: 'failed', errorMessage: floorMessage });
      return { module: (await getModule(moduleId)) ?? gate, aborted: false };
    }
    return { module: await patchModule(moduleId, { status: 'ready', errorMessage: '' }), aborted: false };
  } catch (error) {
    if (isCancel(error, controller.signal)) {
      // Levels already written stay; the interrupted level keeps its slot
      // status, and the module returns to `ready` (or `draft` before the
      // first level) so its Retry buttons stay available.
      const module = await getModule(moduleId);
      if (module !== undefined) {
        await patchModule(moduleId, {
          status: modulePartsUntouched(module) ? 'draft' : 'ready',
        });
      }
      // `aborted` is what tells the automation tail apart from a completed
      // pass — the 'ready' row above is identical in both cases.
      return {
        module: (await getModule(moduleId)) ?? (await requireModule(moduleId)),
        aborted: true,
      };
    }
    await failModule(moduleId, error, controller.signal);
    throw error;
  } finally {
    progress.finish(jobId);
    controllers.delete(moduleId);
    moduleGenEvents.emit({ kind: 'done', moduleId });
  }
}

async function requireModule(moduleId: Id): Promise<Module> {
  const module = await getModule(moduleId);
  if (module === undefined) throw new Error('Module to generate no longer exists');
  return module;
}

/**
 * Generates ONE LEVEL SECTION and writes it into the module DOCUMENT. Writes
 * the `generating` run state first (progressive reveal), then the finished
 * markdown — or a `failed` state with the error message, which it rethrows.
 * Resolves with the markdown (existing contract) after recording the model that
 * served the call on the level's own state (provenance arc, docs/17 row 93).
 *
 * THE UNIT IS THE LEVEL NUMBER (docs/23 §2.1, docs/17 row 391): the write goes
 * through the ONE level-addressed DOCUMENT seam (`db/moduleRepo.saveModuleLevels`
 * → `domain/moduleDocument.moduleRowFromLevelWrites`), so the level's SECTION
 * TEXT is what changes and the `parts` record is the derived view it always was.
 */
export async function generatePart(
  moduleId: Id,
  module: Module,
  level: number,
  campaign: Campaign,
  model: string,
  options: PartCallOptions,
): Promise<string> {
  const spine = module.spine;
  if (spine === null) throw new Error('Cannot generate a level without a document');
  const section = moduleLevelSectionsFromView(module).find((entry) => entry.number === level);
  if (section === undefined) {
    throw new Error(
      `The document carries no level ${String(level)} section to write — the engine writes level sections and never creates them (the chat's append_level does that)`,
    );
  }
  // A level's recorded run state lives at its planIndex slot: the ONE
  // level↔planIndex conversion, here and nowhere else in this seam.
  const planIndex = planIndexForLevel(level);
  // The level's own state write: text plus the run state the engine stamps,
  // through the ONE document seam.
  const writeLevel = (markdown: string, state: ModuleLevelState): Promise<Module> =>
    saveModuleLevels(moduleId, [{ level, text: markdown, state }]);

  // The level being replaced carries its own provenance; a write that cannot
  // observe its serving model must not BLANK an id that was already recorded
  // (`partWriterModelFor`) — the mirror of the hand-edit rule below.
  const previousWriterModel = module.parts.find(
    (entry): boolean => entry.planIndex === planIndex,
  )?.writerModel;
  // PROVENANCE (docs/17 row 93): every write this seam lands carries the model
  // that served the call. The `generating`/`pending`/`failed` slots carry the
  // PREVIOUS id (they hold no new text), the `ready` slot carries the model
  // that actually wrote the markdown — a repair/rewrite escalation to the
  // fallback model is recorded as the fallback, never the configured model.
  const carriedWriterModel = partWriterModelFor('', previousWriterModel);
  // AUTHORSHIP (docs/17 row 113): the same distinction applies to `origin` —
  // the slots that hold NO new text (generating/pending/failed) carry the
  // previous origin, and the `ready` slot is `'model'` by construction: this
  // seam is the generator writing level prose, so it can never be a hand edit.
  const previousOrigin = module.parts.find(
    (entry): boolean => entry.planIndex === planIndex,
  )?.origin;
  const carriedOrigin = carriedTextOrigin(previousOrigin);

  await writeLevel('', {
    status: 'generating',
    errorMessage: '',
    edited: false,
    writerModel: carriedWriterModel,
    origin: carriedOrigin,
  });

  try {
    const called: { markdown: string; modelUsed: string } = await levelCall(
      module,
      level,
      campaign,
      model,
      options,
    );
    const markdown: string = called.markdown;
    // Generated-text hygiene backstop (18-ARCHITECTURE seam): generated level
    // prose is already-decoded stored text — a `?xx` tail or literal
    // `\uXXXX` in it is mangled output, never content, and OUR OWN prompt
    // scaffolding echoed back into the level is the same class of defect
    // (docs/17 row 142). The level fails with the defect named (existing failed
    // semantics: the chain continues, the user retries) — never persisted as a
    // ready level.
    const levelField = { field: `level ${String(level)}`, text: markdown };
    const { issues: hygieneIssues } = generatedTextScanForFields([levelField], [levelField]);
    if (hygieneIssues.length > 0) {
      const hygieneMessage =
        `Level text is not persistable (${hygieneIssues.join('; ')}) — ` +
        'generated prose carrying escape debris or our own prompt scaffolding is a defect, not content; refusing to persist. Retry the level.';
      await writeLevel('', {
        status: 'failed',
        errorMessage: hygieneMessage,
        edited: false,
        writerModel: carriedWriterModel,
        origin: carriedOrigin,
      });
      throw new Error(hygieneMessage);
    }
    await writeLevel(markdown, {
      status: 'ready',
      errorMessage: '',
      edited: false,
      writerModel: partWriterModelFor(called.modelUsed, previousWriterModel),
      origin: 'model',
    });
    // LINKS hook: generated level prose reuses established names exactly —
    // second-module wikilink uses promote to shared campaign ownership.
    await promoteSecondModuleUses(moduleId, [markdown]);
    return markdown;
  } catch (error) {
    if (isCancel(error, options.signal)) {
      // Cancelled mid-level: leave the slot pending so Retry can pick it up.
      await writeLevel('', {
        status: 'pending',
        errorMessage: 'Cancelled',
        edited: false,
        writerModel: carriedWriterModel,
        origin: carriedOrigin,
      });
      throw error;
    }
    const message = errorMessage(error);
    await writeLevel('', {
      status: 'failed',
      errorMessage: message,
      edited: false,
      writerModel: carriedWriterModel,
      origin: carriedOrigin,
    });
    throw error;
  }
}

interface PartCallOptions {
  signal: AbortSignal;
  extraInstruction: string;
  /** Per-run override of the row's includePriorModules flag (undefined = row). */
  includePriorModules?: boolean | undefined;
  onToken: ((delta: string) => void) | undefined;
  /** Liveness probe from the chat stream (see streamDetailReporter). */
  onActivity?: ((activity: ChatStreamActivity) => void) | undefined;
  /**
   * Reasoning-delta stream (illustration only; never part of the part text).
   */
  onReasoning?: ((delta: string) => void) | undefined;
  /**
   * Fires while the part's rule-excerpt search backfills missing embeddings —
   * the first search after enabling embeddings can otherwise sit minutes
   * before the part's chat call starts, with the dock claiming it is writing.
   */
  onEmbeddingProgress?: ((done: number, total: number) => void) | undefined;
}

/**
 * One level's own text as a single prompt line — its first non-empty line,
 * whitespace-collapsed and capped. THE MATERIAL IS THE LEVEL'S OWN PROSE
 * (docs/17 row 391): this is a READING of the section text, never a title
 * extracted from it (docs/23 §2 keeps the line under a separator as prose), and
 * it is only ever shown to the model as context.
 */
function levelExcerpt(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed === '') return '(no text yet)';
  return truncate(collapsed, 160);
}

/** One level generation recipe: context assembly + call + validation. */
async function levelCall(
  module: Module,
  level: number,
  campaign: Campaign,
  model: string,
  options: PartCallOptions,
): Promise<{ markdown: string; modelUsed: string }> {
  const spine = module.spine;
  if (spine === null) throw new Error('Cannot generate a level without a document');
  // THE DOCUMENT'S LEVEL SECTIONS ARE THE MATERIAL (docs/23 §4, docs/17 row
  // 391): the level being written, its predecessor, and the level list the
  // prompt foreshadows with all come from ONE parse of the ONE document. The
  // stored plan records are NOT read: a chat-authored level has no title, no
  // synopsis and no levelUpTrigger (docs/17 row 390), so a prompt built from
  // them would carry empty strings where the level's own prose belongs.
  const sections = moduleLevelSectionsFromView(module);
  // The predecessor by DOCUMENT ORDER — an array step, never the level↔planIndex
  // conversion, which lives only in the ONE pair.
  const at = sections.findIndex((entry) => entry.number === level);
  const section = at === -1 ? undefined : sections[at];
  if (section === undefined) {
    throw new Error(
      `The document carries no level ${String(level)} section to write about`,
    );
  }
  const previous = at > 0 ? sections[at - 1] : undefined;
  // Continuity = the CURRENT text of the previous LEVEL (hand edits included);
  // a failed/empty predecessor is omitted rather than feeding garbage. Its run
  // state comes from the derived view through the ONE conversion.
  const previousState =
    previous === undefined
      ? undefined
      : module.parts.find((part) => part.planIndex === planIndexForLevel(previous.number));
  const continuity =
    previous === undefined || previous.text === '' || previousState?.status !== 'ready'
      ? null
      : previous.text;

  const levelList = sections
    .map((entry) => `Level ${String(entry.number)} — ${levelExcerpt(entry.text)}`)
    .join('\n');

  // The level's OWN TEXT is the retrieval query: an empty level searches on
  // nothing (the excerpt paragraph is dropped), which is honest — there is no
  // material yet.
  const ruleExcerpts = await ruleExcerptSection(
    section.text,
    campaign.system,
    options.onEmbeddingProgress,
  );

  // fix-01: the writer sees the canonical glossary (the normalized spine
  // records) plus the campaign artifact index, so it reuses exact spellings
  // instead of re-deriving names from prose. Cost policy (fix-01): the
  // campaign index is names-only and capped like the spine's (60); the
  // module glossary is uncapped — it is the module's own, small list.
  // The Party is excluded from the campaign index (the module-creation pool,
  // docs/17 row 69): a PC is authored, not a reusable campaign entity.
  const artifacts = moduleCreationPool(await listArtifactsByCampaign(campaign.id));
  const glossary =
    module.entityKinds.length === 0
      ? null
      : `Module entities — wiki-link these ONLY by these exact canonical spellings:\n${module.entityKinds
          .map((entry) => `- ${entry.name} (${entry.kind})`)
          .join('\n')}`;
  const campaignNames = artifacts.slice(0, 60).map((artifact) => `- ${artifact.name} (${artifact.kind})`);
  const campaignIndex =
    campaignNames.length === 0
      ? null
      : `Existing campaign entities (reuse by exact name where they fit):\n${campaignNames.join('\n')}`;
  const isFinale = sections[sections.length - 1]?.number === level;
  const priorContext = priorModulesContext(
    await priorModulesOf(module, options.includePriorModules),
    campaignCastContext(artifacts),
  );

  // This level's floor share, rendered from the MODULE's own guardrail: the
  // number of encounters the level must name, and the instruction asking for
  // them. A disabled floor drops the instruction (and the gate above drops the
  // repair), so the two can never disagree.
  //
  // The BAND IS THE LEVEL'S OWN NUMBER (docs/23 §4): one section per level, so
  // the band is exactly this level and `levelsInLevelBand` is 1 by construction.
  const levelBand = String(level);
  const bandLevels = levelsInLevelBand(levelBand);
  const partFloorRequirement = perPartFloorClause(
    levelBand,
    bandLevels,
    encounterFloorPerPart(encounterFloorGuardrailFor(module), bandLevels),
  );
  // The list item keeps its bullet, and is DROPPED entirely when the floor is
  // off (the guard above then has no repair target either) — inside the style
  // template the floor clause is a slot whose line disappears when it is empty.
  // The two-layer prompt (08 §M4-B-3, docs/17 row 86): the module's OWN style
  // decides the shape of the writing instruction, and the read-only contract
  // layer (reply format, GM address, wiki-link rules, length target, floor,
  // artifact rules) is injected into its required slots. A module reads the
  // style it RECORDED — never today's settings — so a resume, a repair or a
  // per-level regeneration keeps writing in the voice the module started in.
  const style = promptStyleForModule(module);
  const composed = composePromptFromTemplate({
    templateText: style.style.templateText,
    surface: 'parts',
    values: {
      campaign: `Campaign: ${campaign.name} (${GAME_SYSTEM_LABELS[campaign.system]})${campaign.description === '' ? '' : ` — ${campaign.description}`}`,
      modulePremise: `Module premise:\n${spine.premise}`,
      themes: spine.themes.length > 0 ? `Themes: ${spine.themes.join('; ')}` : null,
      // The list item and slot names are the TEMPLATE's (a saved style's
      // placeholders must keep working); their VALUES are the levels' own text.
      allParts: `All levels of this module (each one's own text, so later levels can foreshadow):\n${levelList}`,
      partHeading: `Write level ${String(level)}.`,
      partSynopsis:
        section.text.trim() === ''
          ? null
          : `Level ${String(level)}'s current text (this is the material you are writing):\n${section.text}`,
      // `levelUpTrigger` is DELETED by the arc (docs/23 §1 decision 4, §5):
      // the chat writes an ending in prose, so there is no value to inject and
      // the slot's paragraph disappears.
      partEndCondition: null,
      previousPart:
        continuity === null
          ? null
          : `Full markdown of the previous level (continue seamlessly from it):\n\n${continuity}`,
      ruleExcerpts,
      glossary,
      campaignIndex,
      priorModules: priorContext,
      partEnding: isFinale ? PART_ENDING_LINES.finale : PART_ENDING_LINES.regular,
      additionalInstruction:
        options.extraInstruction === ''
          ? null
          : `Additional instruction from the GM: ${options.extraInstruction}`,
      ...partsContractValues({
        lengthTarget: MODULE_SIZE_WORD_TARGETS[module.sizeDial],
        floorClause: partFloorRequirement,
      }),
    },
  });

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'You are the Module Writer, an expert adventure author for tabletop RPGs. ' +
        'You write evocative, immediately usable GM-facing module prose in markdown.',
    },
    { role: 'user', content: composed.text },
  ];

  // Output is plain markdown — no JSON, no zod. Empty or <100-char output is
  // a failure (retry once, then the level fails); network errors fail
  // directly.
  const settings = await getSettings();
  const first = await chat(messages, {
    model,
    temperature: 0.8,
    reasoningEffort: settings.defaultReasoningEffort,
    signal: options.signal,
    onToken: options.onToken,
    onReasoning: options.onReasoning,
    onActivity: options.onActivity,
  });
  try {
    return { markdown: normalizePartMarkdown(first.text), modelUsed: first.modelUsed };
  } catch {
    // Contract repair escalates to the fallback model: a too-short reply is
    // usually a capability weakness of the first-try model. It WROTE the
    // markdown that lands, so its own `modelUsed` is the level's provenance.
    const retry = await chat(
      [
        ...messages,
        { role: 'user', content: PART_TOO_SHORT_REPAIR_SENTENCE },
      ],
      {
        model: repairModel(model, settings),
        temperature: 0.8,
        reasoningEffort: settings.defaultReasoningEffort,
        signal: options.signal,
        onActivity: options.onActivity,
      },
    );
    return { markdown: normalizePartMarkdown(retry.text), modelUsed: retry.modelUsed };
  }
}

// --- Entity name normalization (fix-01) --------------------------------------

const NORMALIZE_CONTEXT_CAP = 400;

/**
 * The module's normalization TEXT (fix-01): the premise (level 0) plus every
 * LEVEL SECTION's text in document order — the ONE derivation the full pass and
 * the incremental classification run share, so both classify the same text the
 * entity panel observes (`useModuleEntities` derives its names from exactly this
 * text).
 *
 * IT IS THE DOCUMENT's OWN LEVEL LIST (docs/23 §4, docs/17 row 391), read
 * through the ONE accessor: no per-part labels, no `planIndex` — a level is its
 * number.
 */
function moduleNormalizationText(module: Module): string {
  return [
    module.spine?.premise ?? '',
    ...moduleLevelSectionsFromView(module).map((section) => section.text),
  ].join('\n\n');
}

/**
 * The shared normalization prompt (fix-01): the model — which wrote the text
 * — decides per listed name which canonical entity it refers to, and states
 * the canonical entity's kind. One contract for the post-parts pass, the
 * spine's entity list, single hand-typed names, and the incremental run.
 */
function normalizationMessages(
  requests: readonly { name: string; context: string }[],
  artifactNames: readonly string[],
  premise: string,
  options: {
    /**
     * Incremental runs only: the canonical spellings the module already
     * records. A new variant may refer to one of them, so the model must be
     * able to name it (the vocabulary of legal canonicals widens by exactly
     * these recorded names — never by anything the model invents).
     */
    recordedNames?: readonly string[];
  } = {},
): ChatMessage[] {
  const lines = requests.map((request) => {
    const context = request.context.replaceAll('\n', ' ').trim();
    return `- ${request.name}${context === '' ? '' : ` :: ${context}`}`;
  });
  const index =
    artifactNames.length === 0
      ? null
      : `Existing campaign artifacts (a name matching one of these refers to that artifact):\n${artifactNames.join('\n')}`;
  const recorded = options.recordedNames ?? [];
  const recordedIndex =
    recorded.length === 0
      ? null
      : `Entity names already recorded for this module (canonical spellings — a new name that refers to one of these entities maps onto that exact spelling):\n${recorded.join('\n')}`;
  const instruction = [
    `${MODULE_PREMISE_LABEL}\n${premise}`,
    'For each entity name below, decide which canonical entity it refers to.',
    index,
    recordedIndex,
    [
      'Rules:',
      '- One entry per listed name; the "name" field spelled exactly as listed; no extra entries; no invented names.',
      `- "canonical" is the exact spelling of the entity this name refers to: the name itself, another listed name (the canonical form of a variant)${recorded.length === 0 ? '' : ', one of the already-recorded entity names listed above'}, or an existing artifact's exact name. Never a name that appears nowhere in the inputs. Canonical spellings are final — never A → B when B maps elsewhere.`,
      '- Merge only when confident the names refer to the same entity (same person, place, organization, or thing). A role or title attached to the same person ("Guard Halmund" / "Harbormaster Ilse") maps onto the person\'s canonical name; similar names for different beings never merge.',
      '- A name that exactly matches an existing artifact\'s name maps to itself.',
      '- "kind" describes the canonical entity: "npc" = a person or creature the party meets; "location" = a place; "event" = a non-combat scene the party plays through (a negotiation, hazard, puzzle, investigation, ritual, or chase — same shape as a location: an illustration and no battle map, monsters or roster); "faction" = an organization or group; "encounter" = a FIGHT, a scene resolved in initiative with a battle map and a monster roster; "note" = anything else (items, rumors, mysteries, plot devices). Classify a scene by what the party does in it, not by how dangerous it sounds: if no fight happens, it is an event.',
    ].join('\n'),
    'Entities:\n' + lines.join('\n'),
    'Reply with ONLY a JSON object: { "entities": [{ "name": string, "canonical": string, "kind": "npc" | "location" | "event" | "faction" | "note" | "encounter" }] } — one entry per listed entity.',
  ]
    .filter((part) => part !== null)
    .join('\n\n');
  return [
    {
      role: 'system',
      content:
        'You classify tabletop adventure entities precisely. ' +
        'Always answer in the exact JSON format requested. Never include commentary outside the JSON.',
    },
    { role: 'user', content: instruction },
  ];
}

/**
 * Runs one normalization call (fix-01): parses the JSON reply, checks the
 * post-conditions (completeness, no chains, artifact-locked names), and
 * retries ONCE with the violations stated. A second invalid reply throws —
 * the caller records the failure loudly; nothing is ever corrected or
 * substituted here.
 */
async function normalizationCall(
  messages: ChatMessage[],
  model: string,
  names: readonly string[],
  artifactNames: readonly string[],
  options: {
    canonicalNames?: readonly string[];
    /** The pass's abort signal (a parts run's controller). Without it a stop
     * mid-pass left the normalization chat call streaming to completion —
     * the last un-cancellable forge call. */
    signal?: AbortSignal | undefined;
  } = {},
): Promise<NormalizationEntry[]> {
  const settings = await getSettings();
  const base = {
    model,
    temperature: 0.2,
    reasoningEffort: settings.defaultReasoningEffort,
    responseFormat: schemaResponseFormat('entity-normalization', normalizationReplySchema),
    // The normalization call is inside a FORGE pass, so it carries the
    // pass's signal: Stop all aborts it like every other step's call.
    signal: options.signal,
  };
  const run = (raw: string): NormalizationEntry[] => {
    const parsed = normalizationReplySchema.parse(parseJsonReply(raw)).entities;
    const violations = validateNormalizationReply(names, parsed, artifactNames, options);
    if (violations.length > 0) {
      throw new Error(`the normalization reply violated its contract: ${violations.join('; ')}`);
    }
    return parsed;
  };
  const { text: raw } = await chat(messages, base);
  try {
    return run(raw);
  } catch (error) {
    // Contract repair escalates to the fallback model (same rationale as the
    // part prose repair).
    const { text: retry } = await chat(
      [
        ...messages,
        {
          role: 'user',
          content: `Your previous reply was invalid: ${parseErrorSummary(error)}. Reply with corrected JSON only.`,
        },
      ],
      { ...base, model: repairModel(model, settings) },
    );
    return run(retry);
  }
}

/**
 * The name-normalization pass (fix-01), run at the end of EVERY parts run:
 * one model call sees every wiki-link name of the module text plus all
 * existing campaign artifacts and returns, per name, the canonical entity it
 * refers to. The verdict is applied mechanically:
 *
 * - link targets are rewritten to `[[canonical|<original display>]]`
 *   (rendered prose byte-identical) in machine-written documents — generated
 *   parts AND the generated premise (owner decision, docs/17 row 113) —
 *   while text a human authored produces stored proposals for the panel's
 *   consent review;
 * - a canonical that is an existing artifact gains the variant as an alias;
 * - `entityKinds` is REPLACED with one record per canonical entity
 *   (`canonicalEntityRecords` — never merged, or stale variant records
 *   survive).
 *
 * Failure semantics (deliberately tighter than the old classification):
 * an invalid reply after the one retry is RECORDED on the module row
 * (`entityNamesNormalized: false` + the error) and toasted — never swallowed,
 * because a silent failure is a silent path back to duplicate entities. The
 * module stays `status: 'ready'` (the parts are done); batch entity
 * generation stays gated until the panel's Retry succeeds.
 */
export async function normalizeModuleEntityNames(
  moduleId: Id,
  signal?: AbortSignal,
): Promise<void> {
  const module = await requireModule(moduleId);
  // Durable pre-change snapshot (docs/18 §2.3): this pass rewrites wiki-link
  // targets INSIDE generated part text, so it is an AI change to the parts
  // document — whether it runs standalone (the entity panel's Retry) or from
  // inside a parts pass (whose own entry snapshot covers the generated text,
  // not this rewrite). Loud on failure, before any write.
  await snapshotModuleVersion(moduleId, 'normalization', 'Normalize entity names');
  // The candidate set is the module-creation pool (docs/17 row 69): the
  // verdicts may neither resolve a generated name onto a player character nor
  // add an alias to a `pc` row (the same list feeds the alias/rewrite
  // application below).
  const artifacts = moduleCreationPool(await listArtifactsByCampaign(module.campaignId));
  const artifactNames = artifacts.map((artifact) => artifact.name);
  const text = moduleNormalizationText(module);
  const names = extractWikiLinks(text).map((link) => link.name);

  // Pass start: the previous state is invalid for the current text — batch
  // generation gates off until this pass records a success.
  await patchModule(moduleId, {
    entityNamesNormalized: false,
    entityNormalizationError: '',
    entityRewriteProposals: null,
  });
  if (names.length === 0) {
    await patchModule(moduleId, { entityKinds: [], entityNamesNormalized: true });
    return;
  }

  const settings = await getSettings();
  // The full normalization pass is an independent global-model call (the entity
  // panel's Retry and the resume sweep reach it directly), so it records the
  // model it is about to use (docs/17 row 198).
  recordGlobalChatModelInUse(settings.defaultChatModel);
  let verdicts: NormalizationEntry[];
  try {
    verdicts = await normalizationCall(
      normalizationMessages(
        names.map((name) => ({ name, context: surroundingParagraphs(text, name, NORMALIZE_CONTEXT_CAP) })),
        artifactNames,
        module.spine?.premise ?? '',
      ),
      settings.defaultChatModel,
      names,
      artifactNames,
      // The pass's own signal: a stop aborts this call too. The independent
      // entry points (the entity panel's Retry, the creation-time spine pass)
      // pass none — they are user-driven, not a stopped orchestration.
      { signal },
    );
  } catch (error) {
    if (signal?.aborted === true) {
      // A STOP is not a normalization failure: the call was aborted mid-flight
      // by the sweep (or by the pass's own cancel), so recording a failure +
      // toasting would blame the user's stop on the model and paint the
      // panel's failure state over a pass that was simply interrupted. The
      // abort propagates — the caller's cancel path owns the quiet rewind.
      throw error;
    }
    const message = errorMessage(error);
    await patchModule(moduleId, { entityNamesNormalized: false, entityNormalizationError: message });
    recordNormalizationFailure(error);
    return;
  }

  await applyNormalizationVerdict(moduleId, module, artifacts, verdicts);
}

/** What one incremental classification run did (the entity panel's report). */
export interface NewEntityClassification {
  /** The new names this run sent through the pass (empty = nothing to do, or
   * a failure — see `failed`). */
  classified: string[];
  /** True when the pass failed: the failure is RECORDED on the module row
   * (gate closed) and toasted; the panel's Retry owns the recovery. */
  failed: boolean;
}

/**
 * The names the module TEXT carries that still have no record: no
 * `entityKinds` entry, not resolved by the pool, and not already covered by a
 * held consent proposal (`domain/entityNormalization.unclassifiedEntityNames`).
 *
 * PURE observation, ONE derivation for every surface that needs it: the entity
 * panel's bucket observation (`useModuleEntities` + the panel's own read), the
 * incremental classification pass below, and the "Resume automatic module
 * creation" deviation (which has to know whether the text names work no batch
 * can even see yet). `artifacts` must be the MODULE-CREATION pool
 * (`moduleCreationPool`) — the Party is invisible to module creation (docs/17
 * row 69), so a name matching a player character is an unrecorded name here
 * like any other.
 */
export function unclassifiedModuleNames(
  module: Module,
  artifacts: readonly AnyArtifact[],
): string[] {
  const names = extractWikiLinks(moduleDocumentText(module)).map((link) => link.name);
  return unclassifiedEntityNames({
    entityKinds: module.entityKinds,
    names,
    resolvedNames: names.filter(
      (name) => resolveWikiLink(name, artifacts, { moduleId: module.id }).artifact !== undefined,
    ),
    proposals: module.entityRewriteProposals,
  });
}

/**
 * Incremental classification for names the module text picked up AFTER the
 * last pass (08 §M4-C "names the text picks up later", docs/17 row 64).
 *
 * The gap it closes: every batch bucket is built from the kinds the generator
 * RECORDED, and the post-parts pass records the names of the text it saw. A
 * later text change — a chat turn, a hand edit, a board rewrite, a durable
 * version restore — can introduce wiki-link names no pass has seen, so those
 * names have no record and no batch button ("Generate N npcs" disappears for
 * them). The panel observes that state (the same derivation its buckets use)
 * and offers this run.
 *
 * It is the SAME normalization machinery, never a second classifier: the same
 * prompt builder, the same JSON contract + validator + one repair retry, the
 * same mechanical application, and the same consent rule for text rewrites
 * (machine-written documents — generated parts, the generated premise, and
 * text a model wrote through the canvas — apply immediately; text a human
 * authored becomes a stored proposal for the panel's review; the predicate is
 * `textOriginIsMachineWritten`, docs/17 row 113). Its input
 * is narrowed to the names that have no record yet and do not resolve, and its
 * record write is APPEND-ONLY (`mergeNewEntityRecords`): names already recorded
 * are untouched, so repeating the run — or chatting again — can neither
 * duplicate a record nor re-key one, and another module's rows are untouched.
 *
 * Failure semantics are the full pass's, deliberately (never swallowed): the
 * error is recorded with `entityNamesNormalized: false` — which CLOSES the
 * batch gate (nothing is batchable-with-a-guess, no name is silently dropped)
 * — plus a toast, and the panel's Retry (the full pass) is the recovery. A STOP
 * is the exception, as in the full pass: a caller that passes a signal gets its
 * abort propagated instead of a failure recorded against the user's own stop.
 *
 * `signal` is DEFENCE, not a live cure: neither caller passes one today (the
 * panel's button and the resume sweep are user-driven, with no controller of
 * their own), so nothing can abort this pass yet. It exists so that the one
 * cancellation decision stays ONE decision (`isCancel`) the moment a caller
 * does hold a controller, rather than a fourth copy of the wording plus a
 * missing guard.
 *
 * Refuses to run when the row's names are not normalized: the records may be
 * stale for the whole text, and the full pass owns that state.
 */
export async function classifyNewModuleEntityNames(
  moduleId: Id,
  signal?: AbortSignal,
): Promise<NewEntityClassification> {
  const module = await requireModule(moduleId);
  if (!module.entityNamesNormalized) {
    throw new Error(
      'Entity names are not normalized for the current text — run the normalization pass first',
    );
  }
  // The resolution candidate set is the module-creation pool (docs/17 row
  // 69): a name matching a player character does NOT count as resolved, so a
  // generated NPC that happens to share a PC's name is classified like any
  // other new name and becomes a NEW module-owned entity — module creation
  // never quietly binds itself to a party member.
  const artifacts = moduleCreationPool(await listArtifactsByCampaign(module.campaignId));
  const artifactNames = artifacts.map((artifact) => artifact.name);
  const text = moduleNormalizationText(module);
  const targets = unclassifiedModuleNames(module, artifacts);
  // Nothing observed that lacks a record: no call, no write, no toast — the
  // idempotent no-op a repeated click (or a second observation) must be.
  if (targets.length === 0) return { classified: [], failed: false };

  // Durable pre-change snapshot (docs/18 §2.3 simple undo): the verdicts
  // rewrite wiki-link targets inside part text, so this is an AI change to the
  // parts document exactly like every other normalization pass — captured
  // before the first write, loud if it cannot be recorded.
  await snapshotModuleVersion(moduleId, 'normalization', 'Classify new entity names');

  const settings = await getSettings();
  // The incremental classification is its own global-model call (the entity
  // panel's "Classify new names"), so it records the model in use (docs/17 row
  // 198). The no-target early return above never reaches here — no call, no
  // recording.
  recordGlobalChatModelInUse(settings.defaultChatModel);
  // The model may map a new variant onto a canonical the module already
  // records (that name is neither a listed input nor an artifact) — the
  // vocabulary of legal canonicals widens by exactly those recorded names.
  const recordedNames = module.entityKinds.map((entry) => entry.name);
  let verdicts: NormalizationEntry[];
  try {
    verdicts = await normalizationCall(
      normalizationMessages(
        targets.map((name) => ({
          name,
          context: surroundingParagraphs(text, name, NORMALIZE_CONTEXT_CAP),
        })),
        artifactNames,
        module.spine?.premise ?? '',
        { recordedNames },
      ),
      settings.defaultChatModel,
      targets,
      artifactNames,
      // The pass's own signal, exactly like the full pass: a stop must abort
      // this call too — it is the same model call, reached from a second entry
      // point. Undefined for today's callers (see the doc above).
      { canonicalNames: recordedNames, signal },
    );
  } catch (error) {
    // A STOP is not a normalization failure — the sibling guard of the full
    // pass, for the sibling reason: recording a failure + toasting would blame
    // the user's stop on the model and close the batch gate over a pass that
    // was simply interrupted (the abort propagates; the caller's cancel path
    // owns the quiet rewind). Read through `isCancel`, the ONE cancel-vs-
    // failure decision, and only when a signal exists: without one there is no
    // `signal.aborted` source of truth, and the helper's error-type fallback
    // would read a transport `AbortError` as a user stop. With a signal passed
    // this IS the full pass's test (`signal.aborted`), so the two catches can
    // never disagree about one stop.
    if (signal !== undefined && isCancel(error, signal)) throw error;
    const message = errorMessage(error);
    await patchModule(moduleId, { entityNamesNormalized: false, entityNormalizationError: message });
    recordNormalizationFailure(error);
    return { classified: [], failed: true };
  }

  // Applied to the row as it stands NOW: the model call takes seconds and a
  // hand edit can land inside it (a stale parts array must never be written
  // back).
  await applyNormalizationVerdict(
    moduleId,
    await requireModule(moduleId),
    artifacts,
    verdicts,
    'incremental',
  );
  return { classified: targets, failed: false };
}

/**
 * Applies a validated verdict mechanically (fix-01): rewrites machine-written
 * text, holds proposals for text a human authored, records aliases, and
 * writes `entityKinds`. The canonical spelling written into tokens/records is
 * the listed or artifact spelling of the entity the model chose — the verdict
 * itself is never altered.
 *
 * Two record modes, one mechanical application:
 * - `'replace'` (the full pass): `entityKinds` BECOMES the canonical records of
 *   this verdict — the pass saw every name of the text, so a variant-keyed
 *   record from an earlier text must not survive it;
 * - `'incremental'` (names the text picked up later): the verdict covered only
 *   the unrecorded names, so the records of names already on the row are kept
 *   BYTE-IDENTICAL and only genuinely new canonicals are appended
 *   (`mergeNewEntityRecords` — no re-keying, no duplicate, the fix-01
 *   no-duplicate guarantee the batch buckets read), and a review already
 *   pending for human-authored text is preserved rather than replaced
 *   (`mergeEntityRewriteProposals`).
 */
async function applyNormalizationVerdict(
  moduleId: Id,
  module: Module,
  artifacts: Awaited<ReturnType<typeof listArtifactsByCampaign>>,
  verdicts: readonly NormalizationEntry[],
  mode: 'replace' | 'incremental' = 'replace',
): Promise<void> {
  // Every key and comparison in this pass is a NAME, so all of them are the ONE
  // comparable form (docs/17 row 166) — including the two map keys, because an
  // equality moved onto the comparable form while the key it is answered
  // through stays lowercased simply misses the entry and reads as fixed while
  // behaving as before (the same neutralized-half-fold note as
  // `domain/entityNormalization`'s header).
  const listedSpelling = new Map<string, string>();
  for (const entry of verdicts) listedSpelling.set(comparableName(entry.name), entry.name.trim());
  const artifactSpelling = new Map<string, string>();
  for (const artifact of artifacts) artifactSpelling.set(comparableName(artifact.name), artifact.name.trim());

  const rewrites: LinkRewrite[] = [];
  const aliasAdditions = new Map<string, string[]>(); // artifactId → variant names
  for (const entry of verdicts) {
    const nameKey = comparableName(entry.name);
    const canonicalKey = comparableName(entry.canonical);
    if (canonicalKey === nameKey) continue;
    const to = listedSpelling.get(canonicalKey) ?? artifactSpelling.get(canonicalKey) ?? entry.canonical.trim();
    rewrites.push({ from: entry.name.trim(), to });
    const artifact = artifacts.find((candidate) => sameAliasName(candidate.name, entry.canonical));
    if (artifact !== undefined) {
      aliasAdditions.set(artifact.id, [...(aliasAdditions.get(artifact.id) ?? []), entry.name.trim()]);
    }
  }

  // Aliases make future hand-written variant links resolve on their own
  // (campaign-wide), so no further text rewriting ever happens. ONE write per
  // artifact through the alias seam (`artifactRepo.addArtifactAliases` — the ONE
  // merge rule: trimmed, case-insensitive, never a duplicate, never a name equal
  // to the artifact's own name) and ONE write only when something is actually
  // added: the helper returns `null` on a pool that already answered, where the
  // hand-rolled version here wrote a revision that changed nothing.
  for (const [artifactId, variants] of aliasAdditions) {
    // The seam both refuses a variant name another artifact already answers
    // (docs/17 row 226) and hands the refusal back, so it is spoken here — a
    // link that will not resolve on its own is exactly what the owner must
    // hear about rather than discover later (AGENTS rule 1).
    const { refused } = await addArtifactAliases(artifactId, variants);
    for (const collision of refused) {
      toastError(
        'A variant name belongs to another artifact — not attached as an alias',
        new Error(aliasCollisionSentence(collision)),
      );
    }
  }

  // CONSENT (fix-01, re-based on AUTHORSHIP by docs/17 row 113): a rewrite is
  // applied IMMEDIATELY to machine-written text and HELD as a proposal for text
  // a human authored. The predicate is `textOriginIsMachineWritten` — the ONE
  // authorship accessor (domain/provenance) — because `edited` only ever meant
  // "written outside the generator", which is equally true of a canvas-applied
  // model rewrite and of an auto-accepted proposal. Reading `edited` here was
  // the bug the owner hit: a module he never touched raised the consent banner
  // about "hand-edited text" purely because its premise named a variant.
  // `origin: null` (rows written before the field) counts as HUMAN, so such
  // text keeps asking rather than being silently rewritten.
  const sortedParts = [...module.parts].sort((a, b) => a.planIndex - b.planIndex);
  const appliedParts = sortedParts.map((part) => {
    if (!textOriginIsMachineWritten(part.origin)) return part;
    const rewritten = rewriteWikiLinkTargets(part.markdown, rewrites);
    return rewritten === part.markdown ? part : { ...part, markdown: rewritten };
  });
  const storedPremise = module.spine?.premise ?? '';
  // Per-document proposal: only the replacements whose token actually occurs
  // in that document (the stored record stays truthful for the consent UI;
  // applying a replacement whose token is gone is a harmless no-op).
  const rewritesFor = (markdown: string): LinkRewrite[] => {
    // KEY SPACE `WRITTEN_LINK_NAME_KEY` (docs/17 row 167): a rewrite applies
    // when its `from` is the SAME WRITTEN token the document carries — both
    // sides of this comparison are written tokens, so both must ask in the
    // same space or a proposal silently stops matching its own target.
    const names = new Set(extractWikiLinks(markdown).map((link) => comparableName(link.name)));
    return rewrites.filter((rewrite) => names.has(comparableName(rewrite.from)));
  };
  const proposals: { planIndex: number; replacements: LinkRewrite[] }[] = [];
  // THE PREMISE (owner decision, verbatim: "Yes — normalize the generated
  // premise automatically, like a generated part."): this pass used to ALWAYS
  // hold a premise proposal (planIndex −1), which is the other half of the
  // banner the owner hit. The operation only retargets `[[…]]` links and
  // preserves the display text, so a machine-written premise takes it
  // directly; a premise the owner typed is still held, exactly as before.
  let nextSpine: ModuleSpine | null = module.spine;
  const premiseMachineWritten = textOriginIsMachineWritten(module.spine?.origin);
  if (premiseMachineWritten) {
    const rewrittenPremise = rewriteWikiLinkTargets(storedPremise, rewrites);
    if (rewrittenPremise !== storedPremise && module.spine !== null) {
      // The document this pass wrote is no longer the one the model wrote —
      // and NONE of it was typed by the owner, which is the question the
      // consent rule asks, so the origin stays `'model'`.
      nextSpine = { ...module.spine, premise: rewrittenPremise, origin: 'model' };
    }
  } else {
    const premiseRewrites = rewritesFor(storedPremise);
    if (premiseRewrites.length > 0) {
      proposals.push({ planIndex: -1, replacements: premiseRewrites });
    }
  }
  for (const part of sortedParts) {
    if (textOriginIsMachineWritten(part.origin)) continue;
    const partRewrites = rewritesFor(part.markdown);
    if (partRewrites.length > 0) {
      proposals.push({ planIndex: part.planIndex, replacements: partRewrites });
    }
  }

  // The pass's own canonical records, carrying any BESTIARY slot the model
  // asked for (docs/17 row 107) and any entity INTENT note the records hold
  // (docs/17 row 141) onto the canonical name they landed on — the FULL pass
  // answers the records that replaced the planner's list, and on an INCREMENTAL
  // run the module's existing records keep their bytes
  // (`mergeNewEntityRecords`) while the new ones are freshly classified names
  // that carry no slot and no note of their own.
  const canonical = withEntityBestiarySlots(canonicalEntityRecords(verdicts), module.entityKinds);
  const records =
    mode === 'incremental' ? mergeNewEntityRecords(module.entityKinds, canonical) : canonical;
  const nextProposals =
    mode === 'incremental'
      ? mergeEntityRewriteProposals(module.entityRewriteProposals, proposals)
      : proposals.length > 0
        ? proposals
        : null;
  await patchModule(moduleId, {
    parts: appliedParts,
    // The premise, when this pass rewrote it (a machine-written premise); the
    // row's own spine is otherwise written back BYTE-IDENTICAL, so a proposal
    // that was just held can never disturb the text it is about.
    spine: nextSpine,
    entityKinds: records,
    entityNamesNormalized: true,
    entityNormalizationError: '',
    entityRewriteProposals: nextProposals,
  });
}

/**
 * Single-name normalization for hand-typed names (fix-01): the stub popover
 * asks which canonical entity the name refers to (and its kind) before
 * creating anything. Same contract and retry policy as the batched pass.
 *
 * `artifactNames` is the MODULE-CREATION pool's names (`moduleCreationPool`,
 * docs/17 row 69) — never a raw campaign list, or the verdict could resolve a
 * module entity onto a player character.
 */
export async function classifyEntityName(
  name: string,
  context: string,
  premise: string,
  artifactNames: readonly string[],
): Promise<{ kind: NormalizationEntry['kind']; canonical: string }> {
  const settings = await getSettings();
  // The one-name classification is the same global-model call reached from the
  // stub popover, so it records the model in use (docs/17 row 198).
  recordGlobalChatModelInUse(settings.defaultChatModel);
  const parsed = await normalizationCall(
    normalizationMessages([{ name, context }], artifactNames, premise),
    settings.defaultChatModel,
    [name],
    artifactNames,
  );
  const match = parsed.find((entry) => sameAliasName(entry.name, name));
  if (match === undefined) {
    throw new Error(`entity normalization did not answer for "${name}"`);
  }
  return { kind: match.kind, canonical: match.canonical };
}

/** Rule excerpts for grounding (empty library → no section, not an error).
 *
 *  SCOPED to the module's campaign system (docs/17 row 207): `searchRules`
 *  defaults to EVERY ready book when `system` is unset, which grounded a
 *  Pathfinder module's prose in an installed dnd5e pack's rules text. The
 *  system comes from the campaign the module belongs to — the SAME row the
 *  prompt's own `Campaign: … (label)` line is built from — so the excerpt
 *  cannot describe a different game than the one the module is written for. */
async function ruleExcerptSection(
  query: string,
  system: GameSystem,
  onEmbeddingProgress?: (done: number, total: number) => void,
): Promise<string | null> {
  const hits = await searchRules(query, { limit: 4, system, onEmbeddingProgress });
  if (hits.length === 0) return null;
  return `Rule excerpts for grounding:\n${hits
    .map((hit) => `[${hit.chunk.headingPath.join(' > ')}]\n${hit.chunk.text}`)
    .join('\n\n')}`;
}

/** Strips a single leading H1 (the reader adds part titles itself). */
export function normalizePartMarkdown(raw: string): string {
  let text = raw.trim();
  const leadingH1 = /^#\s+[^\n]*\n+/.exec(text);
  if (leadingH1 !== null) text = text.slice(leadingH1[0].length).trim();
  if (text.length < 100) {
    throw new Error(
      `the part output was too short to be module prose (${text.length} characters)`,
    );
  }
  return text;
}

// --- Adversarial generation (docs/17 row 358) --------------------------------

/**
 * Is the automatic adversarial review ON for this module? THE ONE read of the
 * module row's flag (`adversarialGeneration`, docs/17 row 354 — off by
 * default), so the TWO trigger sites (the premise in pass 0, each part in pass
 * 1) cannot drift: the slice's source pin counts this guard's call sites and
 * `runAdversarialPass(` call sites, so a third trigger (or an unguarded one)
 * cannot be born silently.
 *
 * The flag lives on the ROW and nowhere else — never a persona, never a run
 * input and never a setting. Module generation is deliberately not built on
 * personas/runEngine, and the quality choice must survive a resume, a
 * single-part rewrite and a hole fill (all of which ride the same passes).
 */
function adversarialReviewEnabled(module: Module): boolean {
  return module.adversarialGeneration;
}

/**
 * The dock detail for a review that is about to run. It NAMES BOTH SUB-PHASES
 * (docs/17 rows 352/358: the dock's bar advances per part, so a flag-on run
 * must not read as a stall) and it names them TOGETHER on purpose: the pass is
 * ONE seam with two internal model calls and no per-call hook, so a caller
 * cannot observe the critique→editor transition. A line that said only
 * "critique…" would be a lie for as long as the editor runs, and inventing a
 * phase the caller cannot see is worse than naming both.
 */
function adversarialReviewDetail(where: string): string {
  return `Reviewing ${where} — adversarial critique, then an edit if it finds anything…`;
}

/**
 * Marks ONE LEVEL failed after its adversarial review failed, KEEPING its text
 * (docs/17 row 358; the owner's hard constraint: a critique/editor failure must
 * never cost content). The existing failed-level shape is what the level chain
 * already understands — `generatePart`'s failure arm writes `status: 'failed'`
 * + `errorMessage`, the reader shows the failure card with Retry, the chain
 * continues, and `generateMissingParts`/the floor repair can pick the level up.
 * The ONE difference here is that the level's TEXT is NOT cleared: the prose the
 * module writer produced is good, only its review failed, and throwing it away
 * to report a failed critic is exactly the content loss this slice forbids.
 *
 * THAT IS WHY THE WRITE CARRIES NO `text` (docs/17 row 391): a state-only level
 * write leaves the document BYTE-IDENTICAL and stamps the run state at the
 * level's planIndex slot through the ONE conversion.
 *
 * KNOWN CONSEQUENCE, named for the next reader: a failed predecessor feeds no
 * continuity to the next level (`levelCall` reads only a `'ready'` predecessor),
 * which is the same rule a generation failure follows. A review failure on level
 * i therefore costs level i+1 its continuity context until the owner retries
 * level i — the failure card names it, so the state is visible and recoverable.
 *
 * The write re-reads the row inside its transaction, and the pass holds the
 * generation lease, so no competing writer can be overwritten here.
 */
async function failLevelReview(moduleId: Id, level: number, message: string): Promise<void> {
  await saveModuleLevels(moduleId, [
    { level, state: { status: 'failed', errorMessage: message } },
  ]);
}


/**
 * Runs the adversarial pass over ONE just-written LEVEL and applies its edit
 * through THE one level-text write (the SAME document seam the board's Apply
 * rides): one transaction, the whole replacement applied or nothing, the row
 * re-read inside the transaction, and the second-module promote scan after it.
 * The replacement is the COMPLETE new markdown of that LEVEL SECTION, so the
 * module document's scaffolding (`=====Level N=====` separators) is never
 * touched — the section's text is spliced into the ONE document by
 * `domain/moduleDocument`, and there is no second document format to
 * hand-assemble.
 *
 * THE FAILURE CONTAINMENT: a failed critique or a failed editor marks THIS level
 * failed with its text preserved (`failLevelReview`) and returns — the module
 * run CONTINUES. Nothing is thrown but a stop, and no half-applied replacement
 * can exist: `runAdversarialPass` returns a complete validated replacement or
 * throws before any write.
 *
 * The text reviewed is the markdown `generatePart` just wrote, in the same
 * generation lease, so it is the level's current text; the next level's
 * continuity context is read from the document after this write, i.e. the
 * REVIEWED text.
 */
async function reviewLevelInGeneration(input: {
  moduleId: Id;
  level: number;
  ordinal: number;
  total: number;
  text: string;
  signal: AbortSignal;
  jobId: string;
}): Promise<void> {
  const where = `level ${String(input.level)} (${String(input.ordinal)} of ${String(input.total)})`;
  const progress = useProgressStore.getState();
  progress.update(input.jobId, { detail: adversarialReviewDetail(where) });
  // The adversarial pass's own target vocabulary is still part-shaped (the
  // canvas chat's persisted command carries a `planIndex`; docs/17 row 388
  // keeps that keying for its own slice) — so this call converts through the
  // ONE pair, never a mapping of its own.
  const planIndex = planIndexForLevel(input.level);
  let report: AdversarialPassReport;
  try {
    report = await runAdversarialPass({
      moduleId: input.moduleId,
      target: { kind: 'part', planIndex },
      text: input.text,
      signal: input.signal,
    });
  } catch (error) {
    if (isCancel(error, input.signal)) throw error;
    await failLevelReview(
      input.moduleId,
      input.level,
      `The adversarial review failed: ${errorMessage(error)} The generated text was left unchanged — retry the level to review it again.`,
    );
    return;
  }
  if (report.edit === null) {
    progress.update(input.jobId, {
      detail: `Reviewing ${where} — the adversarial critique found nothing to fix.`,
    });
    return;
  }
  progress.update(input.jobId, { detail: `Applying the adversarial edit to ${where}…` });
  try {
    // AUTHORSHIP: `edited: true` + `origin: 'model'` is EXACTLY what this write
    // landed before the engine was re-keyed (it rode `saveModulePartText`, the
    // canvas Apply's own seam) and it is deliberately preserved: the replacement
    // is the EDITOR model's rewrite of the level's text, not the module writer's
    // bytes, and the floor-repair scope reads `edited` to decide what the
    // generator may still rewrite. Changing that reading is its own decision,
    // not a side effect of moving the write onto the document seam.
    await saveModuleLevels(input.moduleId, [
      {
        level: input.level,
        text: report.edit.replacement,
        state: {
          status: 'ready',
          errorMessage: '',
          edited: true,
          writerModel: report.edit.modelUsed,
          origin: 'model',
        },
      },
    ]);
    await promoteSecondModuleUses(input.moduleId, [report.edit.replacement]);
  } catch (error) {
    if (isCancel(error, input.signal)) throw error;
    await failLevelReview(
      input.moduleId,
      input.level,
      `The adversarial edit could not be applied: ${errorMessage(error)} The generated text was left unchanged.`,
    );
  }
}

// --- Orchestration wrappers used by the UI -----------------------------------


/**
 * Per-LEVEL "Rewrite…" (also the failed-level Retry): regenerates just that
 * LEVEL SECTION with the same context recipe (its own current text is the
 * material, the prior level = its CURRENT text) and an optional user
 * instruction. Overwrites the level's section text in the ONE document — the
 * reader confirms when the level was hand-edited.
 */
export async function rewritePart(
  moduleId: Id,
  campaign: Campaign,
  level: number,
  extraInstruction = '',
): Promise<void> {
  await runParts(moduleId, campaign, {
    levels: [level],
    extraInstruction,
  }).catch(() => undefined);
}

/**
 * Header action after pass 1 completed with holes: writes every LEVEL SECTION
 * that is not `ready` yet (pending/failed slots), leaving successful ones
 * untouched.
 *
 * IT NO LONGER STARTS ANYTHING ELSE (docs/23 §8, docs/17 row 394). It used to
 * fire the module's post-generation sweep (`void runModulePostGeneration`) the
 * moment a parts pass completed — the last automatic generation trigger in the
 * app. Detail generation is now the owner's explicit act in the level-scoped
 * generation dialog (`features/modules/generation-dialog`), so this seam writes
 * the missing level TEXT and stops; no entity, image, map or portrait is started
 * by it.
 */
export async function generateMissingParts(moduleId: Id, campaign: Campaign): Promise<void> {
  const module = await getModule(moduleId);
  if (module === undefined) throw new Error('Module no longer exists');
  if (module.spine === null) throw new Error('Cannot generate levels without an approved document');
  const levels = moduleLevelSectionsFromView(module)
    .filter((section) => {
      const part = module.parts.find(
        (entry) => entry.planIndex === planIndexForLevel(section.number),
      );
      return part?.status !== 'ready';
    })
    .map((section) => section.number);
  if (levels.length === 0) return;
  await runPartsPass(moduleId, campaign, { levels }).catch(() => undefined);
}

/**
 * What one "Fix module problems" repair run did (the caller's report).
 *
 * Every field is a fact about the attempt, never a verdict about the module:
 * a repair is ONE attempt per short part, so the caller can say exactly what
 * happened — which parts were rewritten, which attempt failed (and left the
 * text untouched), and what is still short.
 */
export interface FloorRepairOutcome {
  /** Levels the rewrite was attempted for, in the order attempted. */
  attempted: { level: number; title: string }[];
  /** Levels whose text the model rewrote (the durable snapshot precedes them). */
  rewritten: { level: number; title: string }[];
  /** Attempts that threw: the pre-repair text was restored (nothing written). */
  failed: { level: number; title: string; message: string }[];
  /** Requested levels that were no longer short when the repair re-derived the
   * scope (the text changed while the confirmation was open) — never rewritten. */
  skipped: { level: number; title: string }[];
  /** Still short after the attempt (empty = the floor is met). */
  remaining: PartEncounterCount[];
  /** The module's floor is met after this run. */
  met: boolean;
  /** A Stop all / cancel landed before the next level: nothing more started. */
  stopped: boolean;
}

/**
 * "Fix module problems" on the encounter floor — the ONE user-invoked repair of
 * module TEXT, reached from the canvas confirmation (docs/08 §M4-B-3, docs/05
 * §Module canvas). It exists because the owner asked for a button that fixes the
 * text's problems when there are any, and that may rewrite prose as long as a
 * version is saved first ("Allow rewriting with snapshot").
 *
 * It is NOT a second repair path: the rewrite rides the SAME seam the parts
 * pass's floor repair uses — `generatePart` with the check's own instruction
 * (`floorRepairRewriteInstruction`), the escalated `repairModel`, then the
 * existing name-normalization pass so the new encounters get RECORDED kinds (the
 * counter only counts `[[links]]` whose recorded kind is `encounter`, so a
 * rewrite alone would change the prose without moving the number), then a recount
 * of the module's own floor.
 *
 * The boundaries, all binding:
 * - **Snapshot before the write** — `snapshotModuleVersion` (the ONE durable undo
 *   seam) at entry, and a failure to record it throws before anything is written.
 * - **Scoped to this check** — the instruction is the floor repair's; no other
 *   prose is "improved", no entity is created, no image or map is enqueued. The
 *   entity half of a shortfall belongs to the entity workflow and to "Resume
 *   automatic module creation".
 * - **Bounded** — ONE attempt per part per invocation: a failed part is reported,
 *   never retried, and no loop can run away.
 * - **Loud** — a failed part toasts (the text is left as it was), and a still-short
 *   floor toasts with the existing `encounterFloorMessage` verdict and leaves the
 *   module `failed`; a met floor returns it to `ready`.
 * - **Stoppable** — the run registers the module's own controller (so the canvas
 *   Stop and Stop all's module sweep reach it) AND captures the stop epoch at
 *   entry: a stop that lands between parts ends the run without starting the next.
 */
export async function repairModuleEncounterFloor(
  moduleId: Id,
  campaign: Campaign,
  levels: readonly number[],
): Promise<FloorRepairOutcome> {
  const entry = await requireModule(moduleId);
  const floor = encounterFloorGuardrailFor(entry);
  if (!floor.enabled) {
    throw new Error('This module has no enabled encounter floor — there is no floor shortfall to repair');
  }
  const outcome: FloorRepairOutcome = {
    attempted: [],
    rewritten: [],
    failed: [],
    skipped: [],
    remaining: [],
    met: false,
    stopped: false,
  };
  if (levels.length === 0) return outcome;
  // The requested LEVELS are intersected with the scope the LIVE row actually
  // needs BEFORE anything is written: a confirmation opened against text that
  // has since been fixed must produce no snapshot, no status change and no call
  // — the repair can only ever rewrite LESS than it promised.
  //
  // The FLOOR REPORT speaks the derived view's `planIndex` (its `PartEncounterCount`
  // is the shape the canvas's problem list consumes), so this seam converts
  // through the ONE pair and never counts on arithmetic of its own.
  const requested = new Set(levels.map((level) => planIndexForLevel(level)));
  const titles = new Map(
    moduleLevelSectionsFromView(entry).map((section) => [section.number, section.title]),
  );
  const liveTargets = floorRepairTargets(entry, floor)
    .map((target) => target.planIndex)
    .filter((planIndex) => requested.has(planIndex));
  for (const level of levels) {
    if (liveTargets.includes(planIndexForLevel(level))) continue;
    outcome.skipped.push({ level, title: titles.get(level) ?? `Level ${String(level)}` });
  }
  const liveReport = countModuleEncounters(entry, floor);
  outcome.met = liveReport.found >= liveReport.required && liveReport.deficient.length === 0;
  if (liveTargets.length === 0) return outcome;
  const controller = controllerFor(moduleId);
  const epoch = getStopEpoch();
  let statusSet = false;
  /** The loud verdict when the floor is still short after the attempt. */
  let stillShort: string | null = null;
  try {
    const settings = await getSettings();
    const repairModelName = repairModel(settings.defaultChatModel, settings);
    // Durable pre-change snapshot (docs/18 §2.3 simple undo) BEFORE the first
    // write: the whole module document as it stands now, so every level this run
    // rewrites can be undone as one change. Throws loud if it cannot be
    // recorded — no rewrite lands without a restorable pre-state.
    await snapshotModuleVersion(
      moduleId,
      'generation',
      `Fix module problems — encounter floor (${String(levels.length)} level${levels.length === 1 ? '' : 's'})`,
    );
    // The row says 'generating' for the run's duration: that is what the canvas
    // busy badge reads and what Stop all's module sweep keys the abort on.
    await patchModule(moduleId, { status: 'generating' });
    statusSet = true;

    for (const level of levels) {
      // "A stopped orchestration must not start its next unit" (lib/stopEpoch):
      // a stop landing while the previous level was being rewritten ends the run
      // here rather than firing one more doomed call.
      if (stoppedSince(epoch) || controller.signal.aborted) {
        outcome.stopped = true;
        break;
      }
      const current = await requireModule(moduleId);
      if (current.spine === null) throw new Error('The document was removed mid-repair');
      // The scope is re-derived from the LIVE row: a level the owner already
      // fixed (or a document that changed) while the confirmation was open is
      // skipped, so the repair can only ever rewrite LESS than it promised.
      const planIndex = planIndexForLevel(level);
      const target = floorRepairTargets(current, floor).find(
        (entryTarget) => entryTarget.planIndex === planIndex,
      );
      const title = titles.get(level) ?? `Level ${String(level)}`;
      if (target === undefined) {
        outcome.skipped.push({ level, title });
        continue;
      }
      outcome.attempted.push({ level, title: target.title });
      const before = current.parts.find((part) => part.planIndex === planIndex);
      try {
        await generatePart(moduleId, current, level, campaign, repairModelName, {
          signal: controller.signal,
          extraInstruction: floorRepairRewriteInstruction(
            target,
            runLevelSections(current).length,
          ),
          onToken: undefined,
          onReasoning: undefined,
          onActivity: undefined,
          onEmbeddingProgress: undefined,
        });
        outcome.rewritten.push({ level, title: target.title });
      } catch (error) {
        // A cancel is not a failure (the stop's own surface owns it) — but the
        // pre-repair prose still comes back: a stop must never cost text.
        await restoreLevelAfterFailedRepair(moduleId, level, before);
        if (isCancel(error, controller.signal)) {
          outcome.stopped = true;
          break;
        }
        outcome.failed.push({ level, title: target.title, message: errorMessage(error) });
      }
    }

    if (!outcome.stopped && outcome.rewritten.length > 0) {
      // The rewritten levels name NEW encounters, and the floor counter only
      // counts links whose recorded kind is `encounter` — so the pass that
      // records kinds runs here, exactly as the level pass's repair runs it.
      // It is the existing pass (its own snapshot, its consent rule for
      // hand-edited levels), never a second classifier.
      await normalizeModuleEntityNames(moduleId, controller.signal).catch((error: unknown) => {
        if (isCancel(error, controller.signal)) throw error;
        recordNormalizationFailure(error);
      });
    }

    if (!outcome.stopped) {
      const after = await requireModule(moduleId);
      const report = countModuleEncounters(after, floor);
      outcome.remaining = report.deficient;
      outcome.met = report.found >= report.required && report.deficient.length === 0;
      if (outcome.met) {
        await patchModule(moduleId, { status: 'ready', errorMessage: '' });
      } else {
        // Still short: fail LOUDLY, keep what was written (the durable snapshot
        // is the undo), and leave the row `failed` with the floor's own verdict
        // — the wording the generation gate and the runner already use.
        let message = encounterFloorMessage(report);
        if (!after.entityNamesNormalized) {
          message +=
            ' Entity name normalization did not succeed for the current text, so the count uses the last recorded kinds — retry normalization from the entity panel if this looks wrong.';
        }
        await patchModule(moduleId, { status: 'failed', errorMessage: message });
        stillShort =
          `${message} One rewrite attempt per level was made, so nothing more was tried — ` +
          `check the ${String(outcome.remaining.length)} level${outcome.remaining.length === 1 ? '' : 's'} named above, or add the missing [[encounter]] links by hand.`;
      }
    }
  } catch (error) {
    // A cancel anywhere in the run (the in-flight call, the normalization pass)
    // ends it quietly: the stop's own surface reports the stop, and the row's
    // status is restored below.
    if (!isCancel(error, controller.signal)) throw error;
    outcome.stopped = true;
  } finally {
    controllers.delete(moduleId);
    if (statusSet) {
      // A stopped run reaches no verdict: put the row's status back exactly as
      // it was (a stop is not a judgment about the text).
      const live = await getModule(moduleId);
      if (live?.status === 'generating') {
        await patchModule(moduleId, { status: entry.status, errorMessage: entry.errorMessage });
      }
    }
  }

  if (outcome.failed.length > 0) {
    toastError(
      `${String(outcome.failed.length)} of ${String(outcome.attempted.length)} levels could not be rewritten — ` +
        `their text was left as it was (${outcome.failed
          .map((failure) => `"${failure.title}" — ${failure.message}`)
          .join('; ')})`,
    );
  }
  if (outcome.stopped) return outcome;
  if (stillShort !== null) {
    toastError('The module still falls short of its encounter floor', new Error(stillShort));
    return outcome;
  }
  if (outcome.rewritten.length > 0) {
    toastSuccess(
      `Fixed the encounter floor: rewrote ${String(outcome.rewritten.length)} level${outcome.rewritten.length === 1 ? '' : 's'} ` +
        `(${outcome.rewritten.map((entry) => `"${entry.title}"`).join(', ')}) — the pre-repair text is in Versions.`,
    );
  }
  return outcome;
}

/**
 * The style a NEW module is written in (docs/17 row 86): the explicitly chosen
 * id, or the app default from Settings, resolved against the built-ins and the
 * user's styles. Both failure modes are loud and name the offender: an
 * unreadable styles field, an id that resolves to nothing, and a template that
 * fails validation all throw here (nothing is created, nothing is written).
 *
 * This — the CREATION path — is the ONLY place the app default is consulted for
 * a module's style (docs/17 row 88): a module that already EXISTS composes from
 * the style it RECORDED (`promptStyleForModule`), and a module that recorded
 * none keeps resolving to Classic by provenance, so changing the default can
 * never re-voice an existing module on a resume, a repair or a per-part
 * regeneration.
 */
async function resolveCreationPromptStyle(
  requestedId?: string,
): Promise<ModulePromptStyle> {
  const stored = await readPromptStyles();
  if (stored.error !== null) {
    throw new Error(
      `Your saved prompt styles could not be read, so the module was not created: ${stored.error.message}`,
    );
  }
  const id = requestedId ?? (await getSettings()).defaultPromptStyleId;
  const style =
    builtinPromptStyle(id) ?? (stored.styles ?? []).find((entry) => entry.id === id);
  if (style === undefined) {
    throw new Error(`The module prompt style "${id}" does not exist — pick another one in the dialog`);
  }
  const issues = validatePromptStyleTemplate(style.templateText);
  if (issues.length > 0) {
    throw new Error(`The prompt style “${style.name}” cannot be used: ${issues.join(' ')}`);
  }
  return modulePromptStyleOf(style);
}

/**
 * Everything the CREATION dialog hands in, for both creation entries below.
 * `tone` is required here (the dialog always sends one) and the automation
 * fields are recorded on the row — they are the module's generation settings,
 * read by the generator whenever it is started.
 */
export interface NewModuleCreationInput {
  campaignId: Id;
  title: string;
  concept: string;
  levelMin: number;
  levelMax: number;
  tone: string;
  sizeDial: Module['sizeDial'];
  /** Opt-in cross-module continuity (08 §M4-B): prior modules in context. */
  includePriorModules?: boolean;
  /** Post-generation automation (08 §M4-C): artifact kinds to batch-detail
   * after the parts pass, kinds to auto-image, and unattended battlemaps. */
  autoGenerateKinds?: EntityKind[];
  autoImageKinds?: EntityKind[];
  autoGenerateBattlemaps?: boolean;
  /** Opt-in unattended mob portraits for the module's encounters (08). */
  autoGenerateMobImages?: boolean;
  /** Opt-in: skip the spine checkpoint (auto-approve pass 0, run pass 1). */
  autoApproveSpine?: boolean;
  /**
   * Opt-in ADVERSARIAL GENERATION (docs/17 row 354): the critique-and-edit
   * quality pass over the premise and each part. Forwarded verbatim to
   * `createModule` (the spread below), so the created module row records the
   * choice. This slice is the DATA PATH ONLY — nothing in generation reads
   * the flag yet (slices 2–4 add the pass and its triggers).
   */
  adversarialGeneration?: boolean;
  /**
   * The module prompt style to write in (docs/17 row 86): a built-in id or a
   * user style id. Omitted = the app default from Settings. An id that does
   * not resolve, or a style whose template does not validate, throws BEFORE
   * any row is created — the dialog names it and no half-made module is left
   * behind (AGENTS rules 1/3).
   */
  promptStyleId?: string;
  /**
   * The encounter budget policy to record on the new module (docs/17 row
   * 180). Omitted = no explicit choice = the per-system default for the
   * campaign's system (`defaultEncounterBudgetPolicy`), stamped on the row so
   * every later generation of this module reads the same policy.
   */
  encounterBudgetPolicy?: EncounterBudgetPolicy;
  /**
   * The module difficulty to record on the new module (docs/17 row 190), the
   * sibling of the budget policy above. Omitted = no explicit choice = the
   * middle step (`DEFAULT_MODULE_DIFFICULTY`, 'normal'), stamped on the row so
   * every later generation of this module reads the same difficulty.
   */
  difficulty?: ModuleDifficulty;
}

/**
 * The stored defaults of a document created with NO owner-supplied settings
 * (docs/17 row 395): the levels live in the chat, so the declared range is 1–1
 * and tone/concept are empty. `startCampaignDocument` uses this when called
 * without an input — the new-campaign action and the no-document redirect both do.
 */
function emptyDocumentInput(campaign: Campaign): NewModuleCreationInput {
  return {
    campaignId: campaign.id,
    title: campaign.name,
    concept: '',
    levelMin: 1,
    levelMax: 1,
    tone: '',
    sizeDial: 'standard',
  };
}

/**
 * THE APP'S ONE CREATION ENTRY: START THE CAMPAIGN DOCUMENT, and nothing else
 * (docs/23 §10 phase 3, docs/17 row 390).
 *
 * The owner's request — *"One canvas chat that starts with nothing and ends
 * with the campaign premise"* — makes the CHAT the premise's author, so this
 * seam deliberately runs NO pass 0. It resolves the module's writing style,
 * stamps the generation settings the row records (a generation started later
 * reads them), and writes an EMPTY document through THE one campaign-document
 * creation seam (`createCampaignDocument`). An empty document is LEGAL and
 * chattable (level 0 only, zero separators): the canvas chat authors the
 * premise with `replace_level level="0"` and creates each level section with
 * `append_level`, the app writing every separator and level number.
 *
 * The pass-0 spine that used to be this seam's other half is DELETED
 * (docs/17 row 392): the chat is the premise's author, and the level-scoped
 * generation pass is driven from the reader/board/canvas.
 */
export async function startCampaignDocument(
  campaign: Campaign,
  input: NewModuleCreationInput = emptyDocumentInput(campaign),
): Promise<Id> {
  const saved = await createDocumentRow(campaign, input);
  return saved.id;
}

/**
 * THE one module-ROW creation body (AGENTS rule 4): the style resolution, the
 * `createModule` factory call and the write through the refusing
 * `createCampaignDocument` seam. Both creation entries below go through THIS,
 * so a second row-creation path cannot appear beside them.
 */
async function createDocumentRow(
  campaign: Campaign,
  input: NewModuleCreationInput,
): Promise<Module> {
  // Resolved and validated FIRST: a module row that cannot be written in a
  // valid voice must not exist at all.
  const promptStyle = await resolveCreationPromptStyle(input.promptStyleId);
  const created = createModule({
    ...input,
    promptStyle,
    // The sensible default is stamped at creation (docs/17 row 180): a fresh
    // pathfinder2e module records 'pf2e-budget', every other system 'system'.
    // A row written before the field stays null and reads as 'system'.
    encounterBudgetPolicy: input.encounterBudgetPolicy ?? defaultEncounterBudgetPolicy(campaign.system),
    // The middle step is stamped at creation (docs/17 row 190): a fresh module
    // records 'normal', so an owner who never touched the control still gets a
    // row that says so. A row written before the field stays null and also
    // resolves to 'normal' (the legacy reading) — the two are behaviourally
    // identical, and the row keeps the distinction.
    difficulty: input.difficulty ?? DEFAULT_MODULE_DIFFICULTY,
  });
  // THE one campaign-document creation seam (docs/17 row 389): a campaign
  // owns exactly ONE document, so this refuses a second row LOUDLY, naming the
  // document that exists, before anything is written.
  return createCampaignDocument(created);
}

