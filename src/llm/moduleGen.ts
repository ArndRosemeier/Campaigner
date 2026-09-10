import type { AnyArtifact, Campaign, EntityKind, Id, Module, ModuleEntityKind, ModulePart, ModuleSpine, PartPlan } from '@/domain';
import {
  createModule,
  encounterCountWord,
  encounterFloorGuardrailFor,
  encounterFloorPerPart,
  encounterFloorTotal,
  entityKindFor,
  moduleCreationPool,
  moduleDocumentText,
  moduleEntityKindSchema,
  moduleSpineSchema,
  MODULE_SIZE_WORD_TARGETS,
  type EncounterFloorGuardrail,
} from '@/domain';
import { canonicalEntityRecords, mergeEntityRewriteProposals, mergeNewEntityRecords, normalizationReplySchema, unclassifiedEntityNames, validateNormalizationReply, type NormalizationEntry } from '@/domain/entityNormalization';
import { getModule, listModulesByCampaign, patchModule, saveModule } from '@/db/moduleRepo';
import { listArtifactsByCampaign, updateArtifact } from '@/db/artifactRepo';
import { snapshotModuleVersion } from '@/db/moduleVersionRepo';
import { promoteSecondModuleUses } from '@/db/artifactAutoPromote';
import { GAME_SYSTEM_LABELS } from '@/domain/gameSystem';
import { getSettings } from '@/db/settingsRepo';
import { chat, MissingApiKeyError, type ChatMessage, type ChatStreamActivity } from '@/llm/openrouter';
import { parseErrorSummary, parseJsonReply } from '@/llm/jsonReply';
import { repairModel } from '@/llm/modelFallback';
import { schemaResponseFormat } from '@/llm/strictSchema';
import { searchRules } from '@/search';
import { extractWikiLinks, resolveWikiLink, rewriteWikiLinkTargets, surroundingParagraphs, type LinkRewrite } from '@/lib/wikilinks';
import { debrisIssuesForFields } from '@/lib/encodingHygiene';
// The engine triggers the module's own post-generation automation (the
// unattended paths have no UI to do it); the orchestrator never imports this
// module, so the direction stays acyclic.
import { runModulePostGeneration } from '@/features/modules/post-generation';
import { toastError } from '@/lib/toast';
import { errorMessage } from '@/lib/errors';
import { useProgressStore } from '@/lib/progress';
import { getStopEpoch, stoppedSince } from '@/lib/stopEpoch';
import { modulePath } from '@/app/routes';
import { z } from 'zod';

/**
 * Module Designer generator (08-MODULE-DESIGNER M4-B): a two-pass flow —
 * pass 0 drafts the spine (premise + part plan, JSON), pass 1 writes the
 * parts one call per part, sequentially, markdown out. Progress/state lives
 * on the Module row itself (statuses in the domain), observed via
 * `useLiveQuery`; streaming tokens cross to the UI through this in-memory
 * emitter only.
 *
 * Deliberately NOT built on personas/runEngine: different flow, and the prose
 * pass has no JSON contract at all (empty/<100-char output is the failure
 * criterion, retried once). Failures are loud (AGENTS rule 1): a spine
 * failure marks the module `failed` with an `errorMessage`; a part failure
 * marks that part `failed` (visible error card + Retry in its slot) and the
 * chain CONTINUES — part i gets continuity from part i−1 only (no context
 * when the predecessor failed).
 */

export type ModuleGenEvent =
  | { kind: 'spine-token'; moduleId: Id; delta: string }
  /** Reasoning-delta stream (illustration only; never persisted). */
  | { kind: 'spine-thinking'; moduleId: Id; delta: string }
  | { kind: 'part-token'; moduleId: Id; planIndex: number; delta: string }
  | { kind: 'part-thinking'; moduleId: Id; planIndex: number; delta: string }
  | { kind: 'done'; moduleId: Id };

type Listener = (event: ModuleGenEvent) => void;

class ModuleGenEmitter {
  private listeners = new Set<Listener>();

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: ModuleGenEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

/** The generator event bus (mirrors runEngine's in-memory emitter). */
export const moduleGenEvents = new ModuleGenEmitter();

/** In-flight generation per module; a second start on the same row throws. */
const controllers = new Map<Id, AbortController>();

export class ModuleBusyError extends Error {
  constructor(moduleId: Id) {
    super(`Module ${moduleId} is already generating`);
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

// --- Pass 0 — spine ----------------------------------------------------------

export interface SpineRunOptions {
  /** Extra steering instruction from the "Retry spine…" affordance. */
  extraInstruction?: string | undefined;
}

/**
 * Runs pass 0 for a module without a spine: one JSON call. The row moves to
 * `generating` while streaming; on success the spine is stored and the module
 * returns to `draft` — the ALWAYS-on spine approval checkpoint decides when
 * pass 1 starts. On failure the module is `failed` with a loud
 * `errorMessage`.
 */
export async function runSpine(
  moduleId: Id,
  campaign: Campaign,
  options: SpineRunOptions = {},
): Promise<Module> {
  const controller = controllerFor(moduleId);
  // App-wide progress dock (00-OVERVIEW): an outline pass has no measurable
  // sub-steps, so the bar sweeps while the detail line says what is running.
  const progress = useProgressStore.getState();
  const jobId = `module-spine-${moduleId}`;
  progress.start(
    jobId,
    'Designing the module outline',
    // One big planning call — set the "this takes minutes" expectation up
    // front so the quiet stretch before streaming is not read as a hang.
    'Asking for premise, themes and part plan — one large design call; expect several minutes before streaming starts…',
    // The dock label opens the module reader, wherever the user currently is.
    modulePath(campaign.id, moduleId),
  );
  try {
    const module = await getModule(moduleId);
    if (module === undefined) throw new Error('Module to generate no longer exists');
    if (module.parts.length > 0) {
      throw new Error('Refusing to regenerate a spine for a module that already has parts');
    }
    await patchModule(moduleId, { status: 'generating', errorMessage: '' });

    const settings = await getSettings();
    const messages = await spineMessages(module, campaign, options.extraInstruction ?? '');

    // Live dock detail: the spine call can sit minutes on a queued provider or
    // a reasoning model before the first delta — the reporter keeps the dock
    // honest about what is happening (00-OVERVIEW).
    const reporter = streamDetailReporter(
      jobId,
      'Asking for premise, themes and part plan…',
    );
    const streamHandlers = {
      onToken: (delta: string): void => {
        moduleGenEvents.emit({ kind: 'spine-token', moduleId, delta });
        reporter.onToken(delta);
      },
      onReasoning: (delta: string): void => {
        moduleGenEvents.emit({ kind: 'spine-thinking', moduleId, delta });
      },
      onActivity: reporter.onActivity,
    };

    let { text: raw } = await chat(messages, {
      model: settings.defaultChatModel,
      temperature: 0.8,
      reasoningEffort: settings.defaultReasoningEffort,
      responseFormat: schemaResponseFormat('module-spine', spineReplySchema),
      signal: controller.signal,
      ...streamHandlers,
    });

    let spine: ModuleSpine;
    let entityKinds: ModuleEntityKind[];
    try {
      spine = parseSpine(raw);
      entityKinds = parseSpineEntities(raw);
    } catch (error) {
      // One automatic invalid-JSON retry (same policy as persona drafts); a
      // second failure fails the module loudly.
      raw = (
        await chat(
          [
            ...messages,
            {
              role: 'user',
              content: `Your previous reply was invalid JSON for the schema: ${parseErrorSummary(error)}. Reply with corrected JSON only.`,
            },
          ],
          {
            // Contract repair escalates to the fallback model: invalid spine
            // JSON is usually a capability weakness of the first-try model.
            model: repairModel(settings.defaultChatModel, settings),
            temperature: 0.8,
            reasoningEffort: settings.defaultReasoningEffort,
            responseFormat: schemaResponseFormat('module-spine', spineReplySchema),
            signal: controller.signal,
            ...streamHandlers,
          },
        )
      ).text;
      spine = parseSpine(raw);
      entityKinds = parseSpineEntities(raw);
    }

    // Spine-level entities REPLACE the record: this pass invents the world
    // (and only runs while the module has no parts, so nothing is lost).
    // fix-01: the entity list is normalized against the existing campaign
    // artifacts BEFORE storage — the glossary the checkpoint approves is
    // canonical from the start. A normalization failure fails the spine
    // loudly (same policy as the spine reply itself).
    const normalizeAndSave = async (
      nextSpine: ModuleSpine,
      nextKinds: ModuleEntityKind[],
    ): Promise<Module> => {
      // Name normalization is a module-creation pass: its artifact index is
      // the module-creation pool (docs/17 row 69), so a name that happens to
      // match a player character can never be resolved onto the Party — it
      // becomes a NEW module-owned entity instead.
      const artifacts = moduleCreationPool(await listArtifactsByCampaign(campaign.id));
      const artifactNames = artifacts.map((artifact) => artifact.name);
      const spineNames = nextKinds.map((entry) => entry.name);
      let normalizedKinds: ModuleEntityKind[] = [];
      if (spineNames.length > 0) {
        const verdicts = await normalizationCall(
          normalizationMessages(
            spineNames.map((name) => ({
              name,
              context: surroundingParagraphs(nextSpine.premise, name, NORMALIZE_CONTEXT_CAP),
            })),
            artifactNames,
            nextSpine.premise,
          ),
          settings.defaultChatModel,
          spineNames,
          artifactNames,
        );
        // Spine-time verdicts map names only — the records are the canonical
        // form of the planner's own entity list.
        normalizedKinds = canonicalEntityRecords(verdicts);
      }
      const saved = await patchModule(moduleId, {
        spine: nextSpine,
        entityKinds: normalizedKinds,
        status: 'draft',
        errorMessage: '',
      });
      // LINKS hook: the generated premise may reuse another module's entities
      // by exact name — a second-module use promotes them to shared campaign
      // ownership before the checkpoint approves the spine.
      await promoteSecondModuleUses(moduleId, [nextSpine.premise]);
      return saved;
    };
    let saved = await normalizeAndSave(spine, entityKinds);
    // Encounter spine gate (08 §M4-B): zero encounter records gets ONE repair
    // retry on the escalated model; a second encounter-free spine fails the
    // spine loudly (never a silent draft). Floor guarding is read from the
    // MODULE ROW here (its recorded floor, or today's default) — the same
    // numbers that rendered the prompt this reply answered, so the gate can
    // never judge a different rule than the one asked for. With the floor
    // disabled, an encounter-free spine is legitimate.
    const spineFloor = encounterFloorGuardrailFor(saved);
    const spineEncounterDefect = (module: Module): string | null =>
      spineFloor.enabled && !module.entityKinds.some((entry) => entry.kind === 'encounter')
        ? 'declares no encounters'
        : null;
    const spineDefect = spineEncounterDefect(saved);
    if (spineDefect !== null) {
      // The requirement is rendered from the module's own numbers. A defect can
      // only exist while the floor is enabled, so a null requirement here is a
      // loud invariant, never a silently thinner sentence.
      const floorHalf = floorRepairRequirement(spineFloor, saved);
      if (floorHalf === null) {
        throw new Error(
          'The spine encounter gate fired while the module floor is disabled',
        );
      }
      const { text: retryRaw } = await chat(
        [
          ...messages,
          {
            role: 'user',
            content:
              `Your spine ${spineDefect}, ${floorHalf}. ` +
              `Reply with corrected JSON only (same schema): keep the premise, themes and part plan, and declare every planned encounter ` +
              `in entities with kind "encounter", each under a distinctive, stable name.`,
          },
        ],
        {
          // Floor repair escalates to the fallback model: a missing encounter
          // plan is usually a capability weakness of the first-try model.
          model: repairModel(settings.defaultChatModel, settings),
          temperature: 0.8,
          reasoningEffort: settings.defaultReasoningEffort,
          responseFormat: schemaResponseFormat('module-spine', spineReplySchema),
          signal: controller.signal,
          ...streamHandlers,
        },
      );
      const retrySpine = parseSpine(retryRaw);
      const retryKinds = parseSpineEntities(retryRaw);
      saved = await normalizeAndSave(retrySpine, retryKinds);
      const retryDefect = spineEncounterDefect(saved);
      if (retryDefect !== null) {
        throw new Error(
          `The spine still ${retryDefect} after the repair retry — ` +
            'the module needs named encounters (kind "encounter" in entities). Retry the spine draft.',
        );
      }
    }
    return saved;
  } catch (error) {
    await failModule(moduleId, error, controller.signal);
    throw error;
  } finally {
    progress.finish(jobId);
    controllers.delete(moduleId);
    moduleGenEvents.emit({ kind: 'done', moduleId });
  }
}

/** Parses + validates the spine from model output (shared JSON-reply boundary). */
export function parseSpine(raw: string): ModuleSpine {
  return moduleSpineSchema.parse(parseJsonReply(raw));
}

/** The pass-0 entity record schema ({ entities: [{ name, kind }] }). */
const entityKindsReplySchema = z.object({ entities: z.array(moduleEntityKindSchema) });

/**
 * The STRICT structured-output contract for the spine pass: one reply carries
 * the spine AND the entity list (both parse from the same JSON), so the
 * emitted schema is their composition. Runtime parsing keeps the two separate
 * schemas — this is emission-only.
 */
const spineReplySchema = z.object({
  ...moduleSpineSchema.shape,
  entities: z.array(moduleEntityKindSchema),
});

/**
 * Parses the entity list the spine pass records alongside the spine (08
 * §M4-C): the model declares each entity's kind when it invents the name —
 * a missing/incomplete list is a validation error (retry-once, then the
 * spine fails loudly; never a silent default).
 */
export function parseSpineEntities(raw: string): ModuleEntityKind[] {
  return entityKindsReplySchema.parse(parseJsonReply(raw)).entities;
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

/** The tone entry's bans for a free-text module tone (exact match, case-insensitive). */
/**
 * The encounter-floor clause for the spine prompt, or `null` when the module's
 * floor is disabled (then the prompt carries no floor requirement at all).
 *
 * The ONE source of truth for the wording: the numbers the owner set in the New
 * Module dialog flow straight into this sentence, and the gate that judges the
 * reply reads the same numbers (`countModuleEncounters`). At the default
 * (`enabled: true, perLevel: 1`) this renders byte-for-byte the pre-config copy.
 */
function floorClause(floor: EncounterFloorGuardrail, module: Module): string | null {
  if (!floor.enabled) return null;
  const levelCount = module.levelMax - module.levelMin + 1;
  const total = encounterFloorTotal(floor, levelCount);
  return (
    `REQUIREMENT — encounter floor: name at least ${encounterCountWord(floor.perLevel)} distinct ` +
    `encounter${floor.perLevel === 1 ? '' : 's'} per level of this module's range ` +
    `(levels ${String(module.levelMin)}–${String(module.levelMax)} → at least ${String(total)} distinct encounters across the module), ` +
    'with each part naming at least as many encounters as the levels its band covers. An encounter is a fight — a battle map and a monster roster — so a negotiation, hazard, puzzle, investigation or chase is an event instead and does not count.'
  );
}

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

/** The spine repair-retry requirement for a short floor, or `null` when the
 * floor is disabled (a disabled floor is never a spine defect). */
function floorRepairRequirement(floor: EncounterFloorGuardrail, module: Module): string | null {
  if (!floor.enabled) return null;
  const levelCount = module.levelMax - module.levelMin + 1;
  return (
    `but the module requires at least ${encounterCountWord(floor.perLevel)} distinct ` +
    `encounter${floor.perLevel === 1 ? '' : 's'} per level ` +
    `(levels ${String(module.levelMin)}–${String(module.levelMax)} → at least ${String(encounterFloorTotal(floor, levelCount))} encounters)`
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

/** One prior module's block: title, premise, then its written parts in order. */
function priorModuleBlock(module: Module): string {
  const lines: string[] = [];
  lines.push(`## ${module.title} (levels ${String(module.levelMin)}–${String(module.levelMax)})`);
  const premise = module.spine?.premise ?? '';
  if (premise !== '') lines.push(`Premise:\n${truncate(premise, PRIOR_PART_CHAR_CAP)}`);
  const planTitles = module.spine?.partPlan ?? [];
  const blockParts: string[] = [];
  for (const part of [...module.parts].sort((a, b) => a.planIndex - b.planIndex)) {
    if (part.markdown === '') continue;
    const title = planTitles[part.planIndex]?.title ?? `Part ${String(part.planIndex + 1)}`;
    blockParts.push(
      `### Part ${String(part.planIndex + 1)}: ${title}\n${truncate(part.markdown, PRIOR_PART_CHAR_CAP)}`,
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

async function spineMessages(
  module: Module,
  campaign: Campaign,
  extraInstruction: string,
): Promise<ChatMessage[]> {
  // The module-creation pool (08 §M4-B, docs/17 row 69): the Party is
  // invisible to generation — a `pc` row is the players' own character, never
  // campaign setting content to reuse (see `MODULE_CREATION_EXCLUDED_KINDS`).
  const artifacts = moduleCreationPool(await listArtifactsByCampaign(campaign.id));
  const index =
    artifacts.length === 0
      ? null
      : `Existing campaign entities (reuse the ones that fit, by their exact names):\n${artifacts
          .slice(0, 60)
          .map((artifact) => `- ${artifact.name} (${artifact.kind})${artifact.summary === '' ? '' : ` — ${artifact.summary}`}`)
          .join('\n')}`;
  const priorContext = priorModulesContext(await priorModulesOf(module), campaignCastContext(artifacts));

  const levelCount = module.levelMax - module.levelMin + 1;
  // Tone dial teeth (08 §M4-B): the module's tone rules out a few OUTCOMES,
  // never a register or a mood — the prose palette stays fully open. The
  // universal demand (a cost, a loss, or a new problem) is stated positively
  // in the prompt itself, so these are the only hard bans it carries.
  const toneBans = toneBansFor(module.tone) ?? [];
  // The module's OWN floor drives this clause (its recorded value, or today's
  // default) — the same numbers the gate below judges the reply against.
  const spineFloor = encounterFloorGuardrailFor(module);
  const floorRequirement = floorClause(spineFloor, module);
  // With the floor off there is no floor requirement, but the placement /
  // escalation sentences that shared the bullet stay.
  const spineFloorItem =
    '- ' +
    (floorRequirement === null ? '' : `${floorRequirement} `) +
    'Place encounters deliberately in the parts where they make narrative and gameplay sense, and reserve climactic encounters for an earned escalation.';
  const instruction = [
    `Campaign: ${campaign.name} (${GAME_SYSTEM_LABELS[campaign.system]})${campaign.description === '' ? '' : ` — ${campaign.description}`}`,
    `Module concept: ${module.concept}`,
    `Party levels ${module.levelMin}–${module.levelMax}${module.tone === '' ? '' : `; tone: ${module.tone}`}`,
    index,
    priorContext,
    [
      'Design the module spine. Cover the whole level range with parts, in order:',
      `- Default one part per level; you MAY merge adjacent levels into one part when the story is better served (levels ${module.levelMin}–${module.levelMax} → about ${levelCount} parts or fewer).`,
      '- Every level in the range must be covered by exactly one part.',
      '- Each part needs: title, levelBand (e.g. "1" or "2-3"), a one-paragraph synopsis, and levelUpTrigger (what ends this part / triggers the level-up). Write the synopsis as a GM-facing note with scene-level substance: the situation, the actors, the stakes, and at least one concrete scene the part contains.',
      '- Think like an experienced GM: prioritize meaningful choices, varied pacing, clear stakes, and challenges that are exciting without feeling arbitrary. Let the fiction and pacing decide the structure — never a quota.',
      spineFloorItem,
      '- Conflict first: the situation is contested by someone — a faction, an NPC, a predator, a rival party, or the place itself — and who carries that conflict may shift as the module runs. Not every module has an antagonist; every module has a conflict.',
      '- Every situation offers at least two VISIBLE approaches that differ in cost or consequence, so nothing resolves on a single route and no part is a passive wait for the plot. Two rolls toward the same outcome are one approach: the difference must be one the players can see before they commit.',
      '- State in the premise how the situation can resolve, and keep every part equal to what the premise promises — a promised siege arrives, a promised traitor is present and reachable.',
      '- Give each faction an order of battle — wants, needs, preferred tactics, fears, when it flees — and advance its own plan between parts whether or not the party engages it. Every returnable location gets a line of what has changed since.',
      '- If an antagonist exists, the party meets their agents, aftereffects or evidence from the first part — never a villain held back for the finale.',
      '- Every encounter and every location carries one concrete particular that could not be swapped out unchanged (a named river, a debt, a smell, a rule of the place): an opponent the party cannot tell apart from the last one is meaningless combat, and interchangeable scenery is the same failure more slowly.',
      '- Keep the PCs the protagonists: no NPC ally is more intimately bound to the plot than they are, and no NPC solves what the party came to solve.',
      '- Opportunistic threats (a predator, a bandit group, a patrol) belong to the situation: each one advances or reveals a faction’s plan instead of appearing as filler. Exploring is never punished as such — wherever it leads, the interesting thing found there must be worth the risk.',
      '- Structural conflict governs HOW scenes resolve, never what they feel like — no tone, register or subject matter is restricted here. ' +
        'Every conflict ends with someone worse off, a cost paid, or a new problem opened: the losing side is bought, beaten or outmaneuvered, never talked out of its want; a compromise costs a party something it needed; the resolution is built from what the party found and did, never revealed as an unearned third option. Satisfaction is rationed to the finale.' +
        (toneBans.length === 0
          ? ''
          : ` This module’s tone rules out these outcomes, each because it would erase the choice that produced it: ${toneBans.map((ban, index) => `(${String(index + 1)}) ${ban}`).join(' ')}`),
      '- When the party defeats, bypasses or changes something, that change persists and is visible when they return: a beaten antagonist stays beaten unless the fiction earned the return, and no NPC finds, captures or sets back the party by fiat.',
      '- Introduce as many locations, NPCs, factions, notes, events and encounters as the story needs — none of them must be detailed here. Give every scene a distinctive, stable name, declare it with its kind in entities, and wiki-link it in prose ([[Scene Name]]) so it can be resolved into its artifact later.',
      '- An "encounter" is a FIGHT: initiative, a battle map with terrain, and a monster roster with images. Anything that is not a fight — a negotiation, a hazard, a puzzle, an investigation, a ritual, a chase — is an "event" instead: it gets an illustration and no battle map, no monsters, no roster. Never declare a non-combat scene as an encounter, and never hide a fight inside an event. A hazard or a puzzle still carries meaningful risk and player agency — only its artifact differs.',
      '- List every named entity you introduce with its kind: "npc" (a person or creature the party meets), "location" (a place), "event" (a non-combat scene the party plays through; same shape as a location), "faction" (an organization or group), "encounter" (a fight — a battle map and a monster roster), or "note" (anything else — items, rumors, mysteries, plot devices). One entry per named entity, one canonical spelling — a person is listed once, not once per role or title. Reuse existing campaign entities by exact name; never duplicate one to fill the floor.',
      '- Also write a premise (a few paragraphs of markdown — the intro section of the module) and 1-5 themes.',
      '- Before you answer, the three things that do not bend: (1) every situation has at least two visible approaches that differ in cost or consequence — no single-route conclusions; (2) every conflict ends with someone worse off, a cost paid, or a new problem opened; (3) what the party changes stays changed and stays visible when they return.',
      "- The user's premise, tone, level range and size are FIXED INPUT. Do not restate, extend, soften or contradict them. If a structural requirement cannot be met inside the user's premise, change the STRUCTURE (the part plan, which faction carries the conflict, where the conflict starts) — never the premise. If you believe the premise makes a requirement impossible, satisfy the requirement anyway and say what you changed in the structure notes.",
    ].join('\n'),
    extraInstruction === '' ? null : `Additional instruction: ${extraInstruction}`,
    'Reply with ONLY a JSON object: { "premise": string, "themes": string[], "partPlan": [{ "title": string, "levelBand": string, "synopsis": string, "levelUpTrigger": string }], "entities": [{ "name": string, "kind": "npc" | "location" | "event" | "faction" | "note" | "encounter" }] } — partPlan length 1..20, one entity entry per named entity with its kind.',
  ]
    .filter((part) => part !== null)
    .join('\n\n');

  return [
    {
      role: 'system',
      content:
        'You are the Module Architect, an expert adventure designer for tabletop RPGs. ' +
        'You structure adventures as a spine: a premise plus an ordered set of parts covering the party level range. ' +
        'Always answer in the exact JSON format requested. Never include commentary outside the JSON.',
    },
    { role: 'user', content: instruction },
  ];
}

async function failModule(moduleId: Id, error: unknown, signal: AbortSignal): Promise<void> {
  if (isCancel(error, signal)) {
    // Cancellation: rewind a spine-only module so the user can retry cleanly.
    const module = await getModule(moduleId);
    if (module?.status === 'generating' && module.parts.length === 0) {
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
  const names = new Set<string>();
  for (const link of extractWikiLinks(markdown)) {
    if (entityKindFor(entityKinds, link.name) !== 'encounter') continue;
    names.add(link.name.trim().toLowerCase());
  }
  return names;
}

/**
 * Counts the module's encounter floor (pure): the whole-document distinct
 * encounter set against levelCount, allocated per band — each part's
 * markdown must name at least `levelsInLevelBand` encounters. A part with no
 * written row counts 0. sizeDial-independent; the 4× ceiling stays advisory
 * and is never counted here (over-quota never fails). The FLOOR is the
 * module's own recorded guardrail (or today's default when it recorded none).
 */
export function countModuleEncounters(
  module: Module,
  floor: EncounterFloorGuardrail = encounterFloorGuardrailFor(module),
): EncounterFloorReport {
  const required = encounterFloorTotal(floor, module.levelMax - module.levelMin + 1);
  const perPart: PartEncounterCount[] = (module.spine?.partPlan ?? []).map((plan, planIndex) => {
    const part = module.parts.find((entry) => entry.planIndex === planIndex);
    const found = part === undefined ? 0 : encounterNamesIn(part.markdown, module.entityKinds).size;
    return {
      planIndex,
      title: plan.title,
      levelBand: plan.levelBand,
      required: encounterFloorPerPart(floor, levelsInLevelBand(plan.levelBand)),
      found,
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

// --- Pass 1 — parts ----------------------------------------------------------

export interface PartsRunOptions {
  /** Which plan entries to generate; default: all parts, in plan order. */
  planIndexes?: readonly number[] | undefined;
  /** Optional user instruction appended to a single-part rewrite. */
  extraInstruction?: string | undefined;
  /**
   * Per-run override of the module row's `includePriorModules` flag (canvas
   * rewrite dialog). Undefined = read the row (all existing callers —
   * byte-for-byte behavior).
   */
  includePriorModules?: boolean | undefined;
}

/**
 * The honest one-line label for a parts pass (docs/18 §2.3): the Versions menu
 * shows it against the snapshot taken BEFORE the pass, so it names what the
 * pass is about to do — "Generate parts" (full pass), "Generate N missing
 * parts" (hole fill), or "Rewrite part <n> — <title>: <instruction opening>"
 * (single-part rewrite/regenerate, board rewrite). Never a generic "AI change".
 */
function partsRunLabel(module: Module, options: PartsRunOptions): string {
  const indexes = options.planIndexes;
  if (indexes === undefined) return 'Generate parts';
  if (indexes.length !== 1) return `Generate ${String(indexes.length)} missing parts`;
  const planIndex = indexes[0] ?? 0;
  const title = module.spine?.partPlan[planIndex]?.title ?? '';
  const head = title.trim() === '' ? `Rewrite part ${String(planIndex + 1)}` : `Rewrite part ${String(planIndex + 1)} — ${title.trim()}`;
  const instruction = (options.extraInstruction ?? '').trim();
  return instruction === '' ? head : `${head}: ${instruction.slice(0, 60)}`;
}

/**
 * Runs pass 1: one markdown call per plan entry, sequentially. Each finished
 * part lands on the module row immediately (progressive reveal — the reader
 * shows part 1 while part 3 streams). A failed part does NOT stop the chain:
 * it is marked failed (with its error) and generation continues. Continuity
 * for part i comes from the part at planIndex i−1 only — when that
 * predecessor failed, part i is written WITHOUT continuity context.
 *
 * SIMPLE UNDO (docs/18 §2.3): the pass takes ONE durable whole-document
 * snapshot at ENTRY — before the first row write — so every part this pass
 * rewrites (generation, missing-part fill, single-part rewrite/regenerate,
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
  const controller = controllerFor(moduleId);
  // App-wide progress dock (00-OVERVIEW): parts are a known-length list, so
  // the bar fills per part and the detail names the part being written.
  const progress = useProgressStore.getState();
  const jobId = `module-parts-${moduleId}`;
  try {
    const settings = await getSettings();
    const module = await requireModule(moduleId);
    if (module.spine === null) throw new Error('Cannot generate parts without an approved spine');
    // Durable pre-change snapshot (docs/18 §2.3 simple undo): the WHOLE parts
    // document as it stands before this pass writes anything. Loud on failure
    // — an AI pass must not rewrite part text whose pre-state could not be
    // recorded (the throw fails the module through the existing loud path).
    await snapshotModuleVersion(moduleId, 'generation', partsRunLabel(module, options));
    await patchModule(moduleId, { status: 'generating', errorMessage: '' });

    const planIndexes =
      options.planIndexes ?? module.spine.partPlan.map((_, index) => index);
    const total = planIndexes.length;
    progress.start(
      jobId,
      `Writing ${String(total)} module part${total === 1 ? '' : 's'}`,
      'Starting the first part…',
      // The dock label opens the module reader, wherever the user currently is.
      modulePath(campaign.id, moduleId),
    );
    let index = 0;
    for (const planIndex of planIndexes) {
      // A stop that landed between calls throws no error on its own — without
      // this guard the loop would mark the next part 'generating' and fire a
      // doomed chat call before the abort surfaces. Fail fast instead: the
      // outer catch owns the quiet rewind (ready/draft, no toast, no advance).
      if (controller.signal.aborted) {
        throw new DOMException('Module generation was cancelled', 'AbortError');
      }
      const target = await requireModule(moduleId);
      if (target.spine === null) throw new Error('The spine was removed mid-generation');
      const title = target.spine.partPlan[planIndex]?.title ?? `Part ${String(planIndex + 1)}`;
      progress.update(jobId, {
        progress: index / total,
        detail: `Writing part ${String(index + 1)} of ${String(total)}: ${title}`,
      });
      // Live dock detail for the (multi-minute) part call itself: char count
      // while the answer streams, "thinking…" while reasoning deltas arrive.
      const partReporter = streamDetailReporter(
        jobId,
        `Writing part ${String(index + 1)} of ${String(total)}: ${title}`,
      );
      try {
        await generatePart(
          moduleId,
          target,
          planIndex,
          campaign,
          settings.defaultChatModel,
          {
            signal: controller.signal,
            extraInstruction: options.extraInstruction ?? '',
            includePriorModules: options.includePriorModules,
            onToken: (delta) => {
              moduleGenEvents.emit({ kind: 'part-token', moduleId, planIndex, delta });
              partReporter.onToken(delta);
            },
            onReasoning: (delta) => {
              moduleGenEvents.emit({ kind: 'part-thinking', moduleId, planIndex, delta });
            },
            onActivity: partReporter.onActivity,
            // Embedding backfill on the part's retrieval path is reported on
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
      index += 1;
      progress.update(jobId, { progress: index / total });
    }

    // A stop that ended the LAST part leaves no next loop iteration to guard:
    // without this check the pass would fire its post-pass normalization call
    // for a module the user just stopped. Same quiet rewind as the loop
    // guard — the outer catch reads the signal, so it lands as `aborted`.
    throwIfStopped(controller.signal);
    progress.update(jobId, { progress: 1, detail: 'Normalizing entity names…' });
    // Entity name normalization (fix-01): one call after the parts land —
    // canonical names, kinds, link rewrites and aliases. A failure is
    // recorded on the module row (loud, batch gated, Retry in the panel).
    const recordNormalizationFailure = (error: unknown): void => {
      toastError('Entity name normalization failed — retry from the entity panel', error);
    };
    await normalizeModuleEntityNames(moduleId, controller.signal).catch((error: unknown) => {
      if (isCancel(error, controller.signal)) throw error;
      recordNormalizationFailure(error);
    });
    // Encounter-floor gate (08 §M4-B): counted on the NORMALIZED canonicals,
    // before the ready write — a short module is never shipped as ready.
    // Each deficient part in this run's scope gets ONE repair rewrite (the
    // rewritePart engine on the escalated model — see the repairModel
    // rationale on partCall); hand-edited parts are NOT touched (their text
    // changes only on explicit consent — they fail loud instead). Then
    // re-normalize, recount, and fail the module loudly when still short.
    // Good parts are preserved (no rollback — parts are individually
    // regenerable); callers skip the post-generation automation on failure.
    const scope = new Set(planIndexes);
    // The FLOOR this run enforces comes from the module row (its recorded
    // guardrail, or today's default) — the same numbers the spine pass asked
    // for, so a repair and a later retry judge by the module's own rules rather
    // than by whatever the dialog shows today.
    const partsFloor = encounterFloorGuardrailFor(await requireModule(moduleId));
    // A full run owns the whole-module total; a subset run (single-part
    // rewrite/retry) owns only its parts' band shares — it can neither fix
    // nor answer for the rest of the module.
    const isFullRun = (module: Module): boolean =>
      module.spine?.partPlan.every((_, index) => scope.has(index)) ?? false;
    const inScopeTargets = (module: Module): PartEncounterCount[] => {
      const report = countModuleEncounters(module, partsFloor);
      const deficient = report.deficient.filter((entry) => scope.has(entry.planIndex));
      if (deficient.length > 0) return deficient;
      // Full run whose bands are met but whose total repeats across parts:
      // every in-scope part must add DISTINCT encounters.
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
    let gated = await requireModule(moduleId);
    const repairTargets = inScopeTargets(gated).filter((target) => {
      const part = gated.parts.find((entry) => entry.planIndex === target.planIndex);
      return part?.edited !== true;
    });
    if (repairTargets.length > 0) {
      progress.update(jobId, { progress: 1, detail: 'Repairing encounter shortfall…' });
      const floorRepairModel = repairModel(settings.defaultChatModel, settings);
      for (const target of repairTargets) {
        if (controller.signal.aborted) {
          throw new DOMException('Module generation was cancelled', 'AbortError');
        }
        const current = await requireModule(moduleId);
        if (current.spine === null) throw new Error('The spine was removed mid-generation');
        // Satisfaction is rationed to the finale: the repair carries the
        // resolution shape everywhere else, full-price satisfaction on the
        // closing part.
        const repairIsFinale = target.planIndex === current.spine.partPlan.length - 1;
        const floorInstruction = floorRepairInstruction(target);
        // A disabled floor never yields a repair target, so this is a loud
        // invariant rather than a fallback: reaching it would mean a target was
        // computed for a floor that demands nothing.
        if (floorInstruction === null) {
          throw new Error(
            `Encounter floor repair was requested for "${target.title}" while the module's floor is disabled`,
          );
        }
        try {
          await generatePart(moduleId, current, target.planIndex, campaign, floorRepairModel, {
            signal: controller.signal,
            extraInstruction:
              floorInstruction +
              (repairIsFinale
                ? `This is the FINALE: satisfaction is allowed at full price — every want met is paid for visibly.`
                : `End the part with a cost, a revelation, or a new pressure that carries into the next part.`),
            onToken: undefined,
            onReasoning: undefined,
            onActivity: undefined,
            onEmbeddingProgress: undefined,
          });
        } catch (error) {
          if (isCancel(error, controller.signal)) throw error;
          // A failed repair must not destroy the part's pre-repair prose:
          // restore the snapshot when the repair left nothing behind (and no
          // newer hand-edit landed meanwhile). The recount below still fails
          // the module loudly with the part named — the user retries the
          // part itself.
          const snapshot = current.parts.find((entry) => entry.planIndex === target.planIndex);
          const live = (await getModule(moduleId))?.parts.find(
            (entry) => entry.planIndex === target.planIndex,
          );
          if (
            snapshot !== undefined &&
            live?.markdown === '' &&
            !(live.edited && !snapshot.edited)
          ) {
            const restored = (await requireModule(moduleId)).parts.filter(
              (entry) => entry.planIndex !== target.planIndex,
            );
            restored.push(snapshot);
            restored.sort((a, b) => a.planIndex - b.planIndex);
            await patchModule(moduleId, { parts: restored });
          }
        }
      }
      progress.update(jobId, { progress: 1, detail: 'Normalizing entity names…' });
      await normalizeModuleEntityNames(moduleId, controller.signal).catch((error: unknown) => {
        if (isCancel(error, controller.signal)) throw error;
        recordNormalizationFailure(error);
      });
      gated = await requireModule(moduleId);
    }
    const floorReport = countModuleEncounters(gated, partsFloor);
    if (isFloorBlocking(gated)) {
      let floorMessage = encounterFloorMessage(floorReport);
      if (!gated.entityNamesNormalized) {
        floorMessage +=
          ' Entity name normalization did not succeed for the current text, so the count uses the last recorded kinds — retry normalization from the entity panel if this looks wrong.';
      }
      const editedDeficient = floorReport.deficient.filter((entry) =>
        gated.parts.some((part) => part.planIndex === entry.planIndex && part.edited),
      );
      if (editedDeficient.length > 0) {
        floorMessage +=
          ` Hand-edited part(s) ${editedDeficient.map((entry) => `"${entry.title}"`).join(', ')} ` +
          `were left untouched — add the missing [[encounter]] links by hand or rewrite.`;
      }
      toastError('Module generation failed: encounter floor not met', new Error(floorMessage));
      await patchModule(moduleId, { status: 'failed', errorMessage: floorMessage });
      return { module: (await getModule(moduleId)) ?? gated, aborted: false };
    }
    return { module: await patchModule(moduleId, { status: 'ready', errorMessage: '' }), aborted: false };
  } catch (error) {
    if (isCancel(error, controller.signal)) {
      // Parts already written stay; the interrupted part keeps its slot
      // status, and the module returns to `ready` (or `draft` before the
      // first part) so its Retry buttons stay available.
      const module = await getModule(moduleId);
      if (module !== undefined) {
        await patchModule(moduleId, {
          status: module.parts.length > 0 ? 'ready' : 'draft',
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
 * Generates ONE part and writes it to the module row. Writes the
 * `generating` status first (progressive reveal), then the finished markdown
 * — or a `failed` status with the error message, which it rethrows.
 */
export async function generatePart(
  moduleId: Id,
  module: Module,
  planIndex: number,
  campaign: Campaign,
  model: string,
  options: PartCallOptions,
): Promise<string> {
  const spine = module.spine;
  if (spine === null) throw new Error('Cannot generate a part without a spine');
  const plan = spine.partPlan[planIndex];
  if (plan === undefined) throw new Error(`No part plan entry for index ${planIndex}`);

  const setPart = (part: ModulePart): Promise<Module> => {
    const parts = module.parts.filter((entry) => entry.planIndex !== planIndex);
    parts.push(part);
    parts.sort((a, b) => a.planIndex - b.planIndex);
    return patchModule(moduleId, { parts });
  };

  await setPart({ planIndex, markdown: '', status: 'generating', errorMessage: '', edited: false });

  try {
    const markdown = await partCall(module, spine, plan, planIndex, campaign, model, options);
    // Escape-debris hygiene backstop (18-ARCHITECTURE seam): generated part
    // prose is already-decoded stored text — a `?xx` tail or literal
    // `\uXXXX` in it is mangled output, never content. The part fails with
    // the debris named (existing failed semantics: the chain continues, the
    // user retries) — debris is never persisted as a ready part.
    const debrisIssues = debrisIssuesForFields([{ field: `part ${String(planIndex + 1)}`, text: markdown }]);
    if (debrisIssues.length > 0) {
      const debrisMessage =
        `Part text contains escape debris (${debrisIssues.join('; ')}) — ` +
        'half-formed unicode escape in generated prose; refusing to persist. Retry the part.';
      await setPart({ planIndex, markdown: '', status: 'failed', errorMessage: debrisMessage, edited: false });
      throw new Error(debrisMessage);
    }
    await setPart({ planIndex, markdown, status: 'ready', errorMessage: '', edited: false });
    // LINKS hook: generated part prose reuses established names exactly —
    // second-module wikilink uses promote to shared campaign ownership.
    await promoteSecondModuleUses(moduleId, [markdown]);
    return markdown;
  } catch (error) {
    if (isCancel(error, options.signal)) {
      // Cancelled mid-part: leave the slot pending so Retry can pick it up.
      await setPart({
        planIndex,
        markdown: '',
        status: 'pending',
        errorMessage: 'Cancelled',
        edited: false,
      });
      throw error;
    }
    const message = errorMessage(error);
    await setPart({ planIndex, markdown: '', status: 'failed', errorMessage: message, edited: false });
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

/** One part generation recipe: context assembly + call + validation. */
async function partCall(
  module: Module,
  spine: ModuleSpine,
  plan: PartPlan,
  planIndex: number,
  campaign: Campaign,
  model: string,
  options: PartCallOptions,
): Promise<string> {
  const previousPart =
    planIndex === 0
      ? null
      : (module.parts.find((entry) => entry.planIndex === planIndex - 1) ?? null);
  // Continuity = the CURRENT text of part i−1 (hand edits included); a
  // failed/missing predecessor is omitted rather than feeding garbage.
  const continuity =
    previousPart?.status !== 'ready' || previousPart.markdown === ''
      ? null
      : previousPart.markdown;

  const synopses = spine.partPlan
    .map((entry, index) => `${index + 1}. [${entry.levelBand}] ${entry.title} — ${entry.synopsis}`)
    .join('\n');

  const ruleExcerpts = await ruleExcerptSection(plan.synopsis, options.onEmbeddingProgress);

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
  const isFinale = planIndex === spine.partPlan.length - 1;
  const priorContext = priorModulesContext(
    await priorModulesOf(module, options.includePriorModules),
    campaignCastContext(artifacts),
  );

  // This part's floor share, rendered from the MODULE's own guardrail: the
  // number of encounters the part must name, and the instruction asking for
  // them. A disabled floor drops the instruction (and the gate above drops the
  // repair), so the two can never disagree.
  const bandLevels = levelsInLevelBand(plan.levelBand);
  const partFloorRequirement = perPartFloorClause(
    plan.levelBand,
    bandLevels,
    encounterFloorPerPart(encounterFloorGuardrailFor(module), bandLevels),
  );
  // The list item keeps its bullet, and is DROPPED entirely when the floor is
  // off (the guard above then has no repair target either).
  const partFloorItem = partFloorRequirement === null ? null : `- ${partFloorRequirement}`;
  const instruction = [
    `Campaign: ${campaign.name} (${GAME_SYSTEM_LABELS[campaign.system]})${campaign.description === '' ? '' : ` — ${campaign.description}`}`,
    `Module premise:\n${spine.premise}`,
    spine.themes.length > 0 ? `Themes: ${spine.themes.join('; ')}` : null,
    `All parts of this module (one-line synopses, so later parts can foreshadow):\n${synopses}`,
    `Write part ${planIndex + 1}: "${plan.title}" (levels ${plan.levelBand}).`,
    `Part synopsis: ${plan.synopsis}`,
    `Part ends when: ${plan.levelUpTrigger}`,
    continuity === null
      ? null
      : `Full markdown of the previous part (continue seamlessly from it):\n\n${continuity}`,
    ruleExcerpts,
    glossary,
    campaignIndex,
    priorContext,
    [
      'Writing instructions:',
      '- Free-form GM-facing markdown; ## and ### section headings are allowed (the reader adds the H1 part title — do NOT start your reply with an H1).',
      '- Each location opens with one or two sentences of sensory, present-tense description, then a short GM block: who is here, what they want right now, what they do if the party acts, and where the leads point. Read-aloud text stays inside blockquotes and stays that short, so the GM can run the scene without reading a page aloud.',
      '- Every situation in this part offers at least two VISIBLE approaches that differ in cost or consequence — two rolls toward the same outcome are one approach. Nothing resolves on a single route.',
      '- Every conflict ends with someone worse off, a cost paid, or a new problem opened: the losing side is bought, beaten or outmaneuvered, never talked out of its want; a compromise costs a party something it needed; the resolution is built from what the party found and did, never revealed as an unearned third option.',
      '- When the party defeats, bypasses or changes something, write the change into the fiction so it is still visible when they look again — nothing they accomplished is undone off-screen, and nobody locates or captures them by fiat.',
      '- Wiki-link every proper noun as [[Name]]: NPCs, locations, factions, artifacts, monsters — and every scene ([[Encounter Name]] for a fight, [[Event Name]] for anything else). Reuse the exact names of entities from earlier parts and the campaign index, consistently.',
      '- Canonical spellings: link glossary entities only by their listed exact spelling. Never inflect inside the token ([[Halmund]]s Haus, not [[Halmunds]] Haus — English genitive: [[Halmund]]\'s tower) and never bake a role or title into it ([[Halmund|the guard Halmund]], not [[Guard Halmund]]). Use [[Name|display]] when the surface text must differ. Same rules in any language.',
      `- Target length for this part: ${MODULE_SIZE_WORD_TARGETS[module.sizeDial]} (soft target).`,
      partFloorItem,
      isFinale
        ? '- This is the FINALE: satisfaction is allowed here, at full price — every want met must be paid for visibly in loss, consequence, or foregone alternative.'
        : '- End this part with a cost, a revelation, or a new pressure that carries into the next part — never with every side satisfied. Satisfaction is rationed to the finale.',
      '- If an antagonist exists, keep their agents, aftereffects or evidence on the page from here on — never hold the villain back for the finale.',
      '- Show one faction advancing its own plan in this part, whether or not the party engages it; when the party returns to a place they have been, open with what has changed since.',
      '- Every encounter and every location in this part carries one concrete particular that could not be swapped out unchanged: an opponent the party cannot tell apart from the last one is meaningless combat.',
      '- Keep the PCs the protagonists: no NPC ally is more intimately bound to the plot than they are, and no NPC solves what the party came to solve.',
      '- Opportunistic threats (a predator, a patrol, a bandit group) advance or reveal a faction’s plan instead of appearing as filler, and exploring is never punished as such — whatever the party finds must be worth the risk it took.',
      '- No stat blocks in the prose — mechanics belong to linked entities. Reference DCs/checks inline where natural.',
      '- Encounters live in separate encounter artifacts — in the prose, set up the fight and link it as [[Encounter Name]]; do NOT write the encounter itself (no monster roster with counts, no tactics or terrain rules, no battle map or ASCII map — those belong to the linked encounter artifact).',
      '- A scene that is NOT a fight is an event: link it as [[Event Name]] and write the whole scene here — who is present, what they want right now, what they do if the party acts, where the leads point. An event gets an illustration and nothing else: no battle map, no monsters, no roster, because none is generated for it.',
      '- In encounter scenes, name only the fixed participants ([[Halvar]] the boss, the duelist, the negotiator) — rank-and-file fighters stay anonymous and undescribed by name (no names, no counts), so the encounter pipeline casts them.',
      '- Before you answer, the three things that do not bend in this part: (1) at least two visible approaches per situation, differing in cost or consequence, so nothing resolves on a single route; (2) every conflict ends with someone worse off, a cost paid, or a new problem opened; (3) what the party changes stays changed and stays visible.',
    ].join('\n'),
    options.extraInstruction === '' ? null : `Additional instruction from the GM: ${options.extraInstruction}`,
  ]
    .filter((part) => part !== null)
    .join('\n\n');

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'You are the Module Writer, an expert adventure author for tabletop RPGs. ' +
        'You write evocative, immediately usable GM-facing module prose in markdown.',
    },
    { role: 'user', content: instruction },
  ];

  // Output is plain markdown — no JSON, no zod. Empty or <100-char output is
  // a failure (retry once, then the part fails); network errors fail
  // directly.
  const settings = await getSettings();
  const { text: raw } = await chat(messages, {
    model,
    temperature: 0.8,
    reasoningEffort: settings.defaultReasoningEffort,
    signal: options.signal,
    onToken: options.onToken,
    onReasoning: options.onReasoning,
    onActivity: options.onActivity,
  });
  try {
    return normalizePartMarkdown(raw);
  } catch {
    // Contract repair escalates to the fallback model: a too-short reply is
    // usually a capability weakness of the first-try model.
    const { text: retry } = await chat(
      [
        ...messages,
        { role: 'user', content: 'Your previous reply was too short. Write the full part now.' },
      ],
      {
        model: repairModel(model, settings),
        temperature: 0.8,
        reasoningEffort: settings.defaultReasoningEffort,
        signal: options.signal,
        onActivity: options.onActivity,
      },
    );
    return normalizePartMarkdown(retry);
  }
}

// --- Entity name normalization (fix-01) --------------------------------------

const NORMALIZE_CONTEXT_CAP = 400;

/**
 * The module's normalization documents (fix-01): the premise plus every part
 * in plan order — the ONE derivation the full pass and the incremental
 * classification run share, so both classify the same text the entity panel
 * observes (`useModuleEntities` derives its names from exactly these
 * documents).
 */
function moduleNormalizationDocument(module: Module): {
  documents: { where: string; markdown: string }[];
  text: string;
} {
  const documents = [
    { where: 'premise', markdown: module.spine?.premise ?? '' },
    ...module.parts
      .slice()
      .sort((a, b) => a.planIndex - b.planIndex)
      .map((part) => ({ where: `part-${String(part.planIndex)}`, markdown: part.markdown })),
  ];
  return { documents, text: documents.map((document) => document.markdown).join('\n\n') };
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
    `Module premise for context:\n${premise}`,
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
 *   (rendered prose byte-identical) in generated parts — hand-edited parts
 *   and the premise produce stored proposals for the panel's consent review;
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
  const { text } = moduleNormalizationDocument(module);
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
    toastError('Entity name normalization failed — retry from the entity panel', error);
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
 * (generated parts apply immediately; hand-edited parts and the premise become
 * stored proposals for the panel's review — chat-applied text is hand-edited
 * by definition, the one part-text save path stamps `edited: true`). Its input
 * is narrowed to the names that have no record yet and do not resolve, and its
 * record write is APPEND-ONLY (`mergeNewEntityRecords`): names already recorded
 * are untouched, so repeating the run — or chatting again — can neither
 * duplicate a record nor re-key one, and another module's rows are untouched.
 *
 * Failure semantics are the full pass's, deliberately (never swallowed): the
 * error is recorded with `entityNamesNormalized: false` — which CLOSES the
 * batch gate (nothing is batchable-with-a-guess, no name is silently dropped)
 * — plus a toast, and the panel's Retry (the full pass) is the recovery.
 *
 * Refuses to run when the row's names are not normalized: the records may be
 * stale for the whole text, and the full pass owns that state.
 */
export async function classifyNewModuleEntityNames(moduleId: Id): Promise<NewEntityClassification> {
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
  const { text } = moduleNormalizationDocument(module);
  const textNames = extractWikiLinks(text).map((link) => link.name);
  const targets = unclassifiedEntityNames({
    entityKinds: module.entityKinds,
    names: textNames,
    resolvedNames: textNames.filter(
      (name) => resolveWikiLink(name, artifacts, { moduleId: module.id }).artifact !== undefined,
    ),
    proposals: module.entityRewriteProposals,
  });
  // Nothing observed that lacks a record: no call, no write, no toast — the
  // idempotent no-op a repeated click (or a second observation) must be.
  if (targets.length === 0) return { classified: [], failed: false };

  // Durable pre-change snapshot (docs/18 §2.3 simple undo): the verdicts
  // rewrite wiki-link targets inside part text, so this is an AI change to the
  // parts document exactly like every other normalization pass — captured
  // before the first write, loud if it cannot be recorded.
  await snapshotModuleVersion(moduleId, 'normalization', 'Classify new entity names');

  const settings = await getSettings();
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
      { canonicalNames: recordedNames },
    );
  } catch (error) {
    const message = errorMessage(error);
    await patchModule(moduleId, { entityNamesNormalized: false, entityNormalizationError: message });
    toastError('Entity name normalization failed — retry from the entity panel', error);
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
 * Applies a validated verdict mechanically (fix-01): rewrites generated text,
 * holds proposals for hand-edited text and the premise, records aliases, and
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
 *   pending for hand-edited text is preserved rather than replaced
 *   (`mergeEntityRewriteProposals`).
 */
async function applyNormalizationVerdict(
  moduleId: Id,
  module: Module,
  artifacts: Awaited<ReturnType<typeof listArtifactsByCampaign>>,
  verdicts: readonly NormalizationEntry[],
  mode: 'replace' | 'incremental' = 'replace',
): Promise<void> {
  const listedSpelling = new Map<string, string>();
  for (const entry of verdicts) listedSpelling.set(entry.name.trim().toLowerCase(), entry.name.trim());
  const artifactSpelling = new Map<string, string>();
  for (const artifact of artifacts) artifactSpelling.set(artifact.name.trim().toLowerCase(), artifact.name.trim());

  const rewrites: LinkRewrite[] = [];
  const aliasAdditions = new Map<string, string[]>(); // artifactId → variant names
  for (const entry of verdicts) {
    const nameKey = entry.name.trim().toLowerCase();
    const canonicalKey = entry.canonical.trim().toLowerCase();
    if (canonicalKey === nameKey) continue;
    const to = listedSpelling.get(canonicalKey) ?? artifactSpelling.get(canonicalKey) ?? entry.canonical.trim();
    rewrites.push({ from: entry.name.trim(), to });
    const artifact = artifacts.find((candidate) => candidate.name.trim().toLowerCase() === canonicalKey);
    if (artifact !== undefined) {
      aliasAdditions.set(artifact.id, [...(aliasAdditions.get(artifact.id) ?? []), entry.name.trim()]);
    }
  }

  // Aliases make future hand-written variant links resolve on their own
  // (campaign-wide), so no further text rewriting ever happens.
  for (const [artifactId, variants] of aliasAdditions) {
    const artifact = artifacts.find((candidate) => candidate.id === artifactId);
    if (artifact === undefined) continue;
    const additions = variants.filter(
      (variant) => !artifact.aliases.some((alias) => alias.trim().toLowerCase() === variant.toLowerCase()),
    );
    if (additions.length === 0) continue;
    await updateArtifact(artifactId, { aliases: [...artifact.aliases, ...additions] });
  }

  // Generated parts apply immediately; hand-edited parts and the premise are
  // held as proposals (the pass runs headless — consent is the panel's job).
  // The premise ALWAYS takes the proposal path (planIndex −1): it is user-
  // visible everywhere, so its text changes only on explicit consent.
  const sortedParts = [...module.parts].sort((a, b) => a.planIndex - b.planIndex);
  const appliedParts = sortedParts.map((part) => {
    if (part.edited) return part;
    const rewritten = rewriteWikiLinkTargets(part.markdown, rewrites);
    return rewritten === part.markdown ? part : { ...part, markdown: rewritten };
  });
  const premise = module.spine?.premise ?? '';
  // Per-document proposal: only the replacements whose token actually occurs
  // in that document (the stored record stays truthful for the consent UI;
  // applying a replacement whose token is gone is a harmless no-op).
  const rewritesFor = (markdown: string): LinkRewrite[] => {
    const names = new Set(extractWikiLinks(markdown).map((link) => link.name.trim().toLowerCase()));
    return rewrites.filter((rewrite) => names.has(rewrite.from.trim().toLowerCase()));
  };
  const proposals: { planIndex: number; replacements: LinkRewrite[] }[] = [];
  const premiseRewrites = rewritesFor(premise);
  if (premiseRewrites.length > 0) {
    proposals.push({ planIndex: -1, replacements: premiseRewrites });
  }
  for (const part of sortedParts) {
    if (!part.edited) continue;
    const partRewrites = rewritesFor(part.markdown);
    if (partRewrites.length > 0) {
      proposals.push({ planIndex: part.planIndex, replacements: partRewrites });
    }
  }

  const records =
    mode === 'incremental'
      ? mergeNewEntityRecords(module.entityKinds, canonicalEntityRecords(verdicts))
      : canonicalEntityRecords(verdicts);
  const nextProposals =
    mode === 'incremental'
      ? mergeEntityRewriteProposals(module.entityRewriteProposals, proposals)
      : proposals.length > 0
        ? proposals
        : null;
  await patchModule(moduleId, {
    parts: appliedParts,
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
  const parsed = await normalizationCall(
    normalizationMessages([{ name, context }], artifactNames, premise),
    settings.defaultChatModel,
    [name],
    artifactNames,
  );
  const match = parsed.find((entry) => entry.name.trim().toLowerCase() === name.trim().toLowerCase());
  if (match === undefined) {
    throw new Error(`entity normalization did not answer for "${name}"`);
  }
  return { kind: match.kind, canonical: match.canonical };
}

/** Rule excerpts for grounding (empty library → no section, not an error). */
async function ruleExcerptSection(
  query: string,
  onEmbeddingProgress?: (done: number, total: number) => void,
): Promise<string | null> {
  const hits = await searchRules(query, { limit: 4, onEmbeddingProgress });
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

// --- Orchestration wrappers used by the UI -----------------------------------

/**
 * Pass 1 plus the post-generation automation for modules that skipped the
 * spine checkpoint (`autoApproveSpine`) — the unattended tail of the flow.
 */
async function runAutomatedParts(moduleId: Id, campaign: Campaign): Promise<void> {
  // The stop epoch of the pass that ran BEFORE any automation could fire:
  // a stop landing during the pass must not be turned into a fresh sweep by
  // this tail (~1s later, and the pass waited on a long generation itself).
  const epoch = getStopEpoch();
  const finished = await runPartsPass(moduleId, campaign).catch(() => undefined);
  // Automation follows a COMPLETED parts pass: a floor-gated pass is not
  // ready, a CANCELLED pass is `aborted` (its row stays 'ready' with parts
  // present, so the status alone cannot tell the two apart), and a stop that
  // landed mid-pass disqualifies the tail outright.
  if (finished === undefined || finished.aborted || stoppedSince(epoch)) return;
  if (finished.module.status !== 'ready') return;
  // Post-generation automation (opt-in, module row) — fired by the engine
  // because this path has no user interaction to trigger it. The
  // orchestrator is idempotent, loud on its own, and never imports this
  // module (no cycle).
  void runModulePostGeneration(moduleId, campaign);
}

/**
 * "Generate parts" from the spine checkpoint: stores the (user-edited) spine,
 * then runs pass 1. Failures land on the module/parts rows and surface there;
 * the caller navigates to the reader either way.
 */
export async function approveSpineAndRun(
  moduleId: Id,
  campaign: Campaign,
  spine: ModuleSpine,
): Promise<void> {
  await patchModule(moduleId, { spine });
  // LINKS hook: a user-edited spine may link another module's entities.
  await promoteSecondModuleUses(moduleId, [spine.premise]);
  const epoch = getStopEpoch();
  const finished = await runPartsPass(moduleId, campaign).catch(() => undefined);
  // A floor-gated pass is not ready and a CANCELLED one is `aborted` (its
  // row still says 'ready' so Retry stays available) — automation follows a
  // COMPLETED pass, and never follows a stop.
  if (finished === undefined || finished.aborted || stoppedSince(epoch)) return;
  if (finished.module.status !== 'ready') return;
  void runModulePostGeneration(moduleId, campaign);
}

/**
 * Per-part "Rewrite…" (also the failed-part Retry): regenerates just that
 * part with the same context recipe (prior part = its CURRENT text) and an
 * optional user instruction. Overwrites the part's markdown — the reader
 * confirms when the part was hand-edited.
 */
export async function rewritePart(
  moduleId: Id,
  campaign: Campaign,
  planIndex: number,
  extraInstruction = '',
): Promise<void> {
  await runParts(moduleId, campaign, {
    planIndexes: [planIndex],
    extraInstruction,
  }).catch(() => undefined);
}

/**
 * Header action after pass 1 completed with holes: writes every part that is
 * not `ready` yet (pending/failed slots), leaving successful ones untouched.
 */
export async function generateMissingParts(moduleId: Id, campaign: Campaign): Promise<void> {
  const module = await getModule(moduleId);
  if (module === undefined) throw new Error('Module no longer exists');
  if (module.spine === null) throw new Error('Cannot generate parts without an approved spine');
  const indexes = module.spine.partPlan
    .map((_, index) => index)
    .filter((index) => {
      const part = module.parts.find((entry) => entry.planIndex === index);
      return part?.status !== 'ready';
    });
  if (indexes.length === 0) return;
  const epoch = getStopEpoch();
  const finished = await runPartsPass(moduleId, campaign, { planIndexes: indexes }).catch(
    () => undefined,
  );
  // A floor-gated pass is not ready and a CANCELLED one is `aborted` (its
  // row still says 'ready' so Retry stays available) — automation follows a
  // COMPLETED pass, and never follows a stop.
  if (finished === undefined || finished.aborted || stoppedSince(epoch)) return;
  if (finished.module.status !== 'ready') return;
  void runModulePostGeneration(moduleId, campaign);
}

/** Re-runs pass 0 with an optional extra steering instruction. */
export async function retrySpine(
  moduleId: Id,
  campaign: Campaign,
  extraInstruction = '',
): Promise<void> {
  const drafted = await runSpine(moduleId, campaign, { extraInstruction }).catch(
    () => undefined,
  );
  // A failed re-draft is owned by runSpine (failed row + toast).
  if (drafted === undefined) return;
  // Modules that skipped the checkpoint continue unattended after a retry
  // too — the flow never parks on the generated spine.
  if (!drafted.autoApproveSpine) return;
  await runAutomatedParts(moduleId, campaign);
}

/** Checkpoint "Discard": drops the spine, back to a draft module. */
export async function discardSpine(moduleId: Id): Promise<void> {
  const module = await getModule(moduleId);
  if (module === undefined) return;
  await patchModule(moduleId, { spine: null, status: 'draft', errorMessage: '' });
}

/**
 * Creates the module row from the dialog input and STARTS pass 0 without
 * waiting for it: the reader is the spine's live progress surface (streaming
 * card, Stop button), so the dialog navigates immediately instead of blocking
 * for minutes on a slow provider or a thinking model. Spine failures are owned
 * by `runSpine` itself — status `failed` + `errorMessage` on the row and a
 * toast (AGENTS rule 2) — and surface in the reader with a Retry affordance.
 *
 * With `autoApproveSpine` the flow never stops after pass 0: the generated
 * spine is approved as-is and pass 1 (plus any configured post-generation
 * automation) runs unattended.
 */
export async function createModuleAndRun(
  campaign: Campaign,
  input: {
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
  },
): Promise<Id> {
  const created = createModule(input);
  const saved = await saveModule(created);
  void (async () => {
    const drafted = await runSpine(saved.id, campaign).catch(() => undefined);
    // A failed spine is owned by runSpine (failed row + toast) — nothing to
    // continue; the reader offers its Retry, which keeps auto-approving.
    if (drafted === undefined) return;
    if (!drafted.autoApproveSpine) return; // waits at the spine checkpoint
    await runAutomatedParts(saved.id, campaign);
  })();
  return saved.id;
}
