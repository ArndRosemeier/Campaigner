import type {
  AnyArtifact,
  ArtifactData,
  ArtifactKind,
  Autonomy,
  Campaign,
  EncounterLayout,
  EncounterMapAspect,
  EncounterMapMode,
  EncounterPreset,
  Id,
  MonsterEntry,
  Persona,
  PersonaRun,
  ReasoningEffort,
  RunExtras,
  RunStep,
  Settings,
  StatBlock,
} from '@/domain';
import {
  encounterDataIsComplex,
  encounterDataSchema,
  encounterLayoutSchema,
  encounterLocationKindSchema,
  entranceMarkerConfig,
  gridDimensionsFor,
  moduleDocumentText,
  spawnFirstPath,
  drawFillGrade,
  newId,
  packRooms,
  renderSchematic,
  resolveEncounterMapMode,
  resolveEncounterPreset,
  schematicCellPx,
  type DungeonMapPath,
} from '@/domain';
import {
  attachImagesToArtifact,
  createArtifact,
  getArtifact,
  getAnyArtifact,
  listArtifactsByCampaign,
  listArtifactsByIds,
  listGlobalArtifacts,
  updateArtifact,
} from '@/db/artifactRepo';
import { getChunksByIds } from '@/db/chunkRepo';
import { contentIdentityFor } from '@/domain/encounterResolve';
import { carryMobCoversForward, getOrCreateMobArtifact } from '@/db/mobArtifacts';
import { promoteRosterUses } from '@/db/artifactAutoPromote';
import { createImage, deleteUnreferencedImages, getImage } from '@/db/imageRepo';
import { convergeBoardsToRegeneratedMap } from '@/db/battleRepo';
import { createRun, updateRun, getRun } from '@/db/runRepo';
import { getCampaign } from '@/db/campaignRepo';
import { getPersona } from '@/db/personaRepo';
import { listModulesByCampaign, getModule } from '@/db/moduleRepo';
import {
  computeCampaignGrounding,
  expansionExcerptSchema,
  renderCampaignGroundingSection,
  validateExpansionSources,
  type ExpansionExcerpt,
} from '@/llm/campaignGrounding';
import { BUILT_IN_PERSONAS } from '@/llm/personas/builtins';
import { statblockExtraNotice } from '@/llm/personas/extras';
import { collectPackRosterWithRetry, formatRosterSection, parseRosterTargetLevel } from '@/llm/encounterRoster';
import { collectItemPoolWithRetry, formatItemPoolSection } from '@/llm/encounterItems';
import { roomKeyGuidanceFor, treasureGuidanceFor } from '@/llm/treasureGuidance';
import {
  PF2E_BUDGET_ADVISORY,
  ROOM_BUDGET_OVER_MARGIN,
  checkRoomBudget,
  expectedRoomThreat,
  fillGradeStockingFor,
  fixedCastAdvisories,
  fixedCastForEncounter,
  partLevelForMention,
  partyLevelLine,
  reconcileRoomAssignments,
  resolveBriefMonsterLevels,
  resolveEntryLevels,
  roomBudgetGuidanceFor,
  roomBudgetMode,
} from '@/llm/roomBudget';
import { listRulebooks } from '@/db/rulebookRepo';
import { getSettings } from '@/db/settingsRepo';
import { GAME_SYSTEM_LABELS } from '@/domain/gameSystem';
import { statBlockSchema } from '@/domain/statblock';
import { ZodError, z } from 'zod';
import { chat, MissingApiKeyError, type ChatFallback, type ChatMessage, type ChatOptions } from '@/llm/openrouter';
import { generateImages } from '@/llm/imageGen';
import { formatZodIssues, parseErrorSummary, parseJsonReply } from '@/llm/jsonReply';
import { resolveChatModel, repairModel, type ChainFallback } from '@/llm/modelFallback';
import { schemaResponseFormat } from '@/llm/strictSchema';
import { failureKindOf } from '@/llm/failureKind';
import { assembleImagePrompt, buildImagePrompt } from '@/llm/imagePromptDraft';
import { intakeImage } from '@/lib/imageIntake';
import {
  encounterDraftSchema,
  encounterGeneratorBriefSchema,
  eventDraftSchema,
  factionDraftSchema,
  imagePromptDraftSchema,
  locationDraftSchema,
  noteDraftSchema,
  npcDraftSchema,
  pcDraftSchema,
  plotArcDraftSchema,
  continuityReportSchema,
} from '@/llm/schemas';
import type { EncounterDraft, EncounterGeneratorBrief, ImagePromptDraft } from '@/llm/schemas';
import {
  buildLabeledMapPrompt,
  labelsForRoomCount,
  locateDungeonLabels,
  visionLocateReplySchema,
} from '@/llm/visionDungeon';
import { normalizeImageAspect } from '@/lib/imageAspect';
import { surroundingParagraphs } from '@/lib/wikilinks';

type ContinuityReport = z.infer<typeof continuityReportSchema>;
import { searchRules } from '@/search';
import { debugLog } from '@/lib/debug';
import { collectTextLeaves, debrisIssuesForFields } from '@/lib/encodingHygiene';
import { toastError } from '@/lib/toast';
import { errorMessage } from '@/lib/errors';
import { useProgressStore } from '@/lib/progress';
import { workspacePath } from '@/app/routes';

/** Testable seams for browser/image work in the encounter pipeline. */
export const encounterRunAdapters = {
  renderSchematic,
  generateImages,
  normalizeImageAspect,
  intakeImage,
  blobToDataUrl,
};

/** Blob → data URL (FileReader; session-only transport for vision passes). */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reader.abort();
      reject(new Error('could not read a generated map image — the vision-map step failed'));
    };
    reader.onload = () => {
      resolve(typeof reader.result === 'string' ? reader.result : '');
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * Persona run engine (04-LLM-PERSONAS.md §Run pipeline): fixed named steps
 * retrieve → draft → statblock (npc only) → finalize. The run row is
 * persisted after every state change; streaming tokens cross to the UI via an
 * in-memory event emitter only (never persisted per token).
 */

export interface StepDraftOutput {
  parsed: unknown;
  /** Raw model text, stored when JSON parsing failed (needs review). */
  raw?: string;
}

export interface StepRetrieveOutput {
  chunkIds: Id[];
  titles: string[];
}

/** Persistence shape of TargetModuleGrounding (AGENTS rule 3: data at rest
 * is zod-parsed, never cast). */
const storedModuleGroundingSchema = z.object({
  status: z.enum(['ok', 'not-module-owned', 'module-missing']),
  moduleId: z.string().optional(),
  moduleTitle: z.string().optional(),
  contextParagraphs: z.string().optional(),
  premise: z.string().optional(),
});

/** The persisted retrieve-step output the draft/statblock steps re-consume
 * (see contextFromRetrieveStep) — zod-validated when read back. */
const storedRetrieveOutputSchema = z.object({
  chunkIds: z.array(z.string()),
  statblockChunkIds: z.array(z.string()).default([]),
  rosterChunkByName: z.record(z.string(), z.string()).default({}),
  rosterLines: z.array(z.string()).default([]),
  rosterTruncated: z.number().default(0),
  // 12-BESTIARY-PACKS §13: the item pool (the roster's equipment
  // counterpart), persisted so the encounter prompts render it
  // byte-identically without re-collection (additive fields; older runs
  // read back as empty).
  itemChunkByName: z.record(z.string(), z.string()).default({}),
  itemLines: z.array(z.string()).default([]),
  itemTruncated: z.number().default(0),
  // 15-GRAPH-RETRIEVAL: the derived campaign-grounding blocks, persisted so
  // the draft renders them byte-identically without re-derivation (additive
  // field; older runs read back as []).
  expansionExcerpts: z.array(expansionExcerptSchema).default([]),
  // In-place refill parity: what the target artifact's owning module
  // contributes, persisted with the selection so pause/resume renders it
  // byte-identically (additive field; older runs read back as absent).
  moduleGrounding: storedModuleGroundingSchema.optional(),
});

/**
 * In-place refill grounding: what the target artifact's OWNING MODULE
 * contributes to a targeted generate run — the same sources the automatic
 * module generation (`runEntityBatch`) grounds its briefs in (08 §M4-C):
 * the module document text around the artifact's name + the spine premise.
 * Every non-`ok` state is an EXPLICIT degrade (the prompt and run say so —
 * AGENTS rule 1), never a silent drop of the module context.
 */
export interface TargetModuleGrounding {
  /** `ok` — the module row exists; `not-module-owned` — the artifact is
   * campaign/global-scoped; `module-missing` — the artifact claims a module
   * whose row is gone (kept artifact of a deleted module). */
  status: 'ok' | 'not-module-owned' | 'module-missing';
  /** The owning module's id (module-owned targets only). */
  moduleId?: Id | undefined;
  /** The owning module's title (`ok` only). */
  moduleTitle?: string | undefined;
  /** The module document's paragraphs around the artifact's name ('' when
   * the text never mentions it). */
  contextParagraphs?: string | undefined;
  /** The module's spine premise ('' when the module has none). */
  premise?: string | undefined;
}

/** The grounding context one retrieve pass computes (and the retrieve step
 * persists the stable parts of). */
interface RetrieveContext {
  chunkIds: Id[];
  titles: string[];
  excerpts: string;
  /** M3-B: statblock-only hits, in citation order (encounter personas). */
  statblockChunkIds: Id[];
  statblockTitles: string[];
  /** M-B (12-BESTIARY-PACKS §7): pack-roster lines + name→chunkId map. */
  rosterLines: string[];
  rosterTruncated: number;
  rosterChunkByName: Record<string, Id>;
  /** §13 (item-corpus arc): the item pool + name→chunkId map. */
  itemLines: string[];
  itemTruncated: number;
  itemChunkByName: Record<string, Id>;
  /** 15-GRAPH-RETRIEVAL: the derived campaign-grounding blocks (already
   * budget-truncated by the derivation). The draft renders them verbatim;
   * the statblock step never does. */
  expansionExcerpts: ExpansionExcerpt[];
  /** In-place refill parity (undefined when the run is not a targeted
   * generate run). The draft renders the module section from the STORED
   * value — pause/resume cannot drift the prompt. */
  moduleGrounding?: TargetModuleGrounding | undefined;
}

export interface StepStatblockOutput {
  statBlock: StatBlock;
}

const STEP_NAMES = ['retrieve', 'draft', 'statblock', 'finalize'] as const;
export type StepName =
  | (typeof STEP_NAMES)[number]
  | ReviewStepName
  | ImageStepName
  | EncounterStepName
  | EncounterVisionStepName;

const REVIEW_STEP_NAMES = ['gather', 'check', 'finalize'] as const;
export type ReviewStepName = (typeof REVIEW_STEP_NAMES)[number];

/**
 * Image personas (M3-A Illustrator): the prompt draft is the user-editable
 * checkpoint, generate runs the image API, pick ALWAYS pauses (07-MILESTONE-3
 * M3-A) so the user chooses 0–2 candidates on every autonomy level.
 */
const IMAGE_STEP_NAMES = ['prompt-draft', 'generate', 'pick'] as const;
export type ImageStepName = (typeof IMAGE_STEP_NAMES)[number];

/**
 * Encounter Cartographer (docs/11): the pipeline has NO verify step — the
 * human picks the candidate and regenerate is the correction path (D14);
 * pick ALWAYS pauses (manual/review), auto picks candidate one.
 */
const ENCOUNTER_STEP_NAMES = [
  'brief',
  'layout',
  'schematic',
  'stylize',
  'pick',
  'finalize',
] as const;
export type EncounterStepName = (typeof ENCOUNTER_STEP_NAMES)[number];

/**
 * Encounter vision-map pipeline (docs/11 vision path): the dungeon-map
 * path resolved to `'vision'` for a COMPLEX brief — brief (rooms are
 * authored here = the sidecar, BEFORE any image exists) → vision-map
 * (generate the labeled map, locate each plaque with the chat model, verify
 * with a focused re-ask per miss) → finalize (persists the vision layout +
 * map). ONE map candidate by contract — no pick step: locate+verify is the
 * gate and Regenerate everything is the correction path (D14).
 */
const ENCOUNTER_VISION_STEP_NAMES = ['brief', 'vision-map', 'finalize'] as const;
export type EncounterVisionStepName = (typeof ENCOUNTER_VISION_STEP_NAMES)[number];

/**
 * Encounter repopulation (two-button regeneration, docs/11): the roster-only
 * Cartographer pass — brief (with the 'empty' repair loop, which kills
 * pile-ups structurally) then finalize, which persists the roster ONLY.
 * Layout/stylize/pick are skipped, never executed.
 */
const ENCOUNTER_ROSTER_ONLY_STEP_NAMES = ['brief', 'finalize'] as const;

export type EngineEvent =
  | { kind: 'run'; runId: Id; status: PersonaRun['status'] }
  | { kind: 'step'; runId: Id; stepIndex: number; status: RunStep['status']; stepName?: string | undefined }
  | { kind: 'token'; runId: Id; stepIndex: number; delta: string }
  /** Reasoning-delta stream (illustration only; never part of the answer). */
  | { kind: 'thinking'; runId: Id; stepIndex: number; delta: string }
  /**
   * Model fallback restarted this step's stream after a failure: the previous
   * attempt may have streamed partial tokens, so subscribers must clear
   * their buffers before the new attempt's deltas arrive.
   */
  | { kind: 'reset'; runId: Id; stepIndex: number };

type Listener = (event: EngineEvent) => void;

/**
 * The run statuses that end every wait: a run in one of them can make no
 * further progress on its own. Single source of truth for the engine, the
 * chain runner, the entity batch and the encounter-map queue (formerly
 * three private copies plus one inline check).
 */
export const TERMINAL_RUN_STATUSES: readonly PersonaRun['status'][] = ['completed', 'cancelled', 'failed'];

/** True when `status` is terminal (the run can make no further progress). */
export function isTerminalRunStatus(status: PersonaRun['status']): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

export interface WaitForRunOptions {
  /**
   * Also return when the run PAUSES for the user (`awaiting_user` /
   * `needs_review`). Chain steps honor pauses — the user resolves the run
   * through the Assistant tab and the chain resumes it. Unattended callers
   * (entity batch, encounter-map queue) wait for terminal only: an
   * `awaiting_user` run never produces there, so returning early would
   * misreport it as done.
   */
  includePaused?: boolean;
  /**
   * Aborts the WAIT (not the run): the next poll tick throws an AbortError
   * even when the run is still going. Callers that must also stop the
   * underlying run do it themselves — the encounter-map queue's withdrawn
   * jobs call `runEngine.cancel` (the queue cannot leave an unattended run
   * generating a map nobody asked for anymore).
   */
  signal?: AbortSignal;
}

/**
 * THE "wait for a run to reach a status" primitive (one implementation for
 * the formerly duplicated poll loops and the event-subscription variant):
 *
 * Unified contract — resolves with the run row once it reaches a terminal
 * status (plus the pause statuses when `includePaused` is set); throws when
 * the run row disappears mid-wait; polls the row every 250ms, which also
 * covers the already-terminal race (the first read returns immediately).
 * The event emitter stays the liveness surface for UIs; waiting code does
 * not need to subscribe.
 */
export async function waitForRunStatus(runId: Id, opts: WaitForRunOptions = {}): Promise<PersonaRun> {
  for (;;) {
    // An aborted wait wins even over a just-reached terminal status: the
    // caller withdrew the job and must not observe it as done.
    if (opts.signal?.aborted) {
      throw new DOMException('The wait was aborted', 'AbortError');
    }
    const run = await getRun(runId);
    if (run === undefined) {
      throw new Error(`Run ${runId} disappeared while waiting for it to finish`);
    }
    if (isTerminalRunStatus(run.status)) return run;
    if (
      opts.includePaused === true &&
      (run.status === 'awaiting_user' || run.status === 'needs_review')
    ) {
      return run;
    }
    await new Promise((resolve) => {
      window.setTimeout(resolve, 250);
    });
  }
}

/**
 * The persisted escalation note for a step output (the 'notice' convention
 * the persona panel renders): a fallback must be visible, never silent
 * (AGENTS rule 1). Escalation is unconditional (owner: "ANY ERROR, ANY AT
 * ALL should lead to the fallback"), so the reason words the trigger
 * honestly — 'filter' refused, 'congestion' was unavailable, anything else
 * just failed.
 */
function escalationNotice(fallback: ChatFallback): string {
  const why =
    fallback.reason === 'filter'
      ? 'refused the content'
      : fallback.reason === 'congestion'
        ? 'was congested'
        : 'failed';
  return `Primary model “${fallback.from}” ${why} — answered by fallback “${fallback.to}”.`;
}

/** Step output plus the escalation notices (transport fallback inside chat()
 * and/or the contract-repair escalation between calls) when they fired. */
function withNotice<T extends Record<string, unknown>>(
  output: T,
  fallback: ChatFallback | null,
  repairNote: string | null = null,
): T {
  const transport = fallback === null ? null : escalationNotice(fallback);
  const notice = [transport, repairNote]
    .filter((part): part is string => part !== null)
    .join(' ');
  return notice === '' ? output : { ...output, notice };
}

/** The persisted note for a contract-repair attempt that escalated models. */
function contractRepairNotice(firstTryModel: string, repairTarget: string): string | null {
  return repairTarget === firstTryModel
    ? null
    : `The reply contract failed on “${firstTryModel}” — the repair attempt ran on “${repairTarget}”.`;
}

/**
 * The persisted note for an image-step escalation (imageGen's
 * GeneratedImages.fallback): names the failed first-try model and the
 * fallback that actually produced the image. The reason words the trigger
 * honestly (filter refused / congestion / plain failure) — a fallback must
 * be visible, never silent (AGENTS rule 1).
 */
function imageFallbackNotice(fallback: ChainFallback): string {
  switch (fallback.reason) {
    case 'filter':
      return `Content filter on “${fallback.from}” — the fallback model “${fallback.to}” produced this image.`;
    case 'congestion':
      return `Congestion on “${fallback.from}” — the fallback model “${fallback.to}” produced this image.`;
    default:
      return `“${fallback.from}” failed — the fallback model “${fallback.to}” produced this image.`;
  }
}

/**
 * The persisted note for an image step's degradations (escalation fallback,
 * partially filtered candidates, candidate-count cap) — the image-mode twin
 * of withNotice. Null when the step ran clean.
 */
function imageStepNotice(generated: {
  fallback: ChainFallback | null;
  filteredCount: number;
  images: { length: number };
  cappedToOne: boolean;
  modelUsed: string;
}): string | null {
  const parts = [
    generated.fallback === null ? null : imageFallbackNotice(generated.fallback),
    generated.filteredCount > 0
      ? `${generated.filteredCount} of ${generated.images.length + generated.filteredCount} candidates ${
          generated.filteredCount === 1 ? 'was' : 'were'
        } filtered.`
      : null,
    generated.cappedToOne
      ? `“${generated.modelUsed}” generates one image per request — this run produced a single candidate.`
      : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(' ');
}

/**
 * The draft-prompt section that grounds an in-place refill in its owning
 * module (parity with automatic module generation, 08 §M4-C). Pure over the
 * STORED grounding, so pause/resume and the repair turn render it
 * byte-identically. Every degrade names itself in the prompt (AGENTS rule 1)
 * — the section is null only when the run is not a refill at all.
 */
export function moduleGroundingSection(
  grounding: TargetModuleGrounding | undefined,
): string | null {
  if (grounding === undefined) return null;
  switch (grounding.status) {
    case 'not-module-owned':
      return 'In-place regeneration of an existing artifact: it is not owned by a module, so there is no module document to ground it in — regenerate from the brief and the campaign grounding alone.';
    case 'module-missing':
      return `In-place regeneration of an existing artifact: the module that owned it (${grounding.moduleId ?? 'unknown'}) no longer exists, so its document cannot ground this regeneration — say so in the reply when the missing module context matters.`;
    case 'ok': {
      const context = grounding.contextParagraphs ?? '';
      const premise = grounding.premise ?? '';
      const title = grounding.moduleTitle ?? 'the owning module';
      const header = `In-place regeneration of an existing artifact. It is owned by the module "${title}", which grounds it exactly as automatic module generation would.`;
      const mentionNote =
        context === ''
          ? `The module text never mentions this artifact's name — there are no surrounding paragraphs to ground it in.`
          : `Where it is mentioned in the module:\n\n${context}`;
      const premiseNote =
        premise === ''
          ? 'The module carries no spine premise.'
          : `Module premise for context:\n\n${premise}`;
      return [header, mentionNote, premiseNote].join('\n\n');
    }
  }
}

/** The run-level notice for a refill grounding anomaly (the 'notice'
 * convention the persona panel renders): a degrade must be visible, never
 * silent (AGENTS rule 1). */
function moduleGroundingNotice(grounding: TargetModuleGrounding | undefined): string | null {
  if (grounding?.status === 'module-missing') {
    return `The module that owned the refilled artifact (${grounding.moduleId ?? 'unknown'}) no longer exists — the regeneration ran without its module context.`;
  }
  return null;
}

export interface StartRunInput {
  campaign: Campaign;
  persona: Persona;
  autonomy: Autonomy;
  brief: string;
  pinnedChunkIds: readonly Id[];
  /**
   * Artifacts from earlier steps of a writers'-room chain (06-MILESTONES M2:
   * persona chaining) — injected into the draft prompt as context and linked
   * from the produced artifact.
   */
  contextArtifactIds?: readonly Id[];
  /** Review/image target or encounter artifact to regenerate. */
  targetArtifactId?: Id;
  /** Encounter generator aspect; persisted on the run for pauses/retries. */
  encounterMapAspect?: EncounterMapAspect;
  /**
   * Encounter generator preset (docs/11 D10): the Dungeon preset generates
   * the layout on the fixed ×2 grid tier and biases the brief toward a
   * multi-room complex. Persisted on the run for pauses/retries like the
   * aspect.
   */
  encounterPreset?: EncounterPreset;
  /**
   * Dungeon-map production path for ONE run (docs/11 vision path): the D18
   * steering control's per-run choice for Regenerate everything.
   * `'vision'` forces the vision-located pipeline, `'classic'` forces the
   * packed-rooms pipeline, undefined/null = no override (the Settings
   * `dungeonMapPath` default governs). Ignored for singles (one arena needs
   * no registration — always classic) and repopulation (roster-only, never
   * touches the map). Persisted on the run row for pauses/retries like the
   * preset; never persisted as a new settings default.
   */
  dungeonMapPath?: DungeonMapPath | null;
  /**
   * Module placement for the NEWLY created artifact (creation-dialog
   * choice, one-off per run; null/omitted = campaign level). Applied only
   * on fresh creates — an in-place fill with placement set is a loud error
   * (an existing artifact's scope changes only via explicit scope moves).
   */
  placementModuleId?: Id;
  /** Ticked creation-dialog extras; persisted on the run for pause/resume. */
  extras?: RunExtras;
  /** Module post-pass: one candidate, no user checkpoints. */
  unattended?: boolean;
  /**
   * Encounter pipeline scope (two-button regeneration, docs/11): `'full'`
   * runs the whole Cartographer pipeline
   * (brief→layout→schematic→stylize→pick→finalize); `'rosterOnly'` runs the
   * roster-only repopulation pass (brief→finalize — layout/stylize/pick are
   * skipped, the roster is REPLACED with no verbatim pin, and only the
   * roster persists). Defaults to `'full'`. The scope also stamps onto the
   * brief step output (`rosterOnly: true`) so pause/resume continuations —
   * which rebuild this input from the run row — keep the pipeline shape
   * without a Dexie change.
   */
  encounterScope?: 'full' | 'rosterOnly';
  /**
   * Smith encounter in-place fills only: `true` scopes the persist to
   * name/summary/body — a prose-only redesign that must never touch the
   * roster the pipeline just built. A draft that renames, adds or removes a
   * roster entry fails loud and nothing persists (never a partial apply).
   */
  encounterProseOnly?: boolean;
  /**
   * Smith encounter in-place fills only: `true` replaces the target's name
   * with the draft's (the old name becomes an alias) instead of the default
   * name-preserving alias behavior.
   */
  encounterRedesignName?: boolean;
}

/** Fetches context artifacts for the prompt (name + summary + body excerpt). */
async function loadContextArtifacts(
  ids: readonly Id[],
): Promise<{ name: string; summary: string; body: string }[]> {
  if (ids.length === 0) return [];
  const artifacts = await listArtifactsByIds(ids);
  return artifacts.map((artifact) => ({
    name: artifact.name,
    summary: artifact.summary,
    body: artifact.body.length > 800 ? `${artifact.body.slice(0, 800)}…` : artifact.body,
  }));
}

/** Whether a step needs explicit user action before the run continues. */
function pauses(autonomy: Autonomy, stepNeedsReview: boolean): boolean {
  switch (autonomy) {
    case 'manual':
      return true;
    case 'review':
      return stepNeedsReview;
    case 'auto':
      return false;
  }
}

interface DraftContract {
  schema: z.ZodType;
  keys: string[];
  /** OpenRouter strict-schema name (strict structured outputs). */
  name: string;
}

function draftContractFor(kind: ArtifactKind): DraftContract {
  switch (kind) {
    case 'pc':
      return { schema: pcDraftSchema, keys: Object.keys(pcDraftSchema.shape), name: 'pc-draft' };
    case 'npc':
      return { schema: npcDraftSchema, keys: Object.keys(npcDraftSchema.shape), name: 'npc-draft' };
    case 'location':
      return { schema: locationDraftSchema, keys: Object.keys(locationDraftSchema.shape), name: 'location-draft' };
    case 'event':
      return { schema: eventDraftSchema, keys: Object.keys(eventDraftSchema.shape), name: 'event-draft' };
    case 'faction':
      return { schema: factionDraftSchema, keys: Object.keys(factionDraftSchema.shape), name: 'faction-draft' };
    case 'note':
      return { schema: noteDraftSchema, keys: Object.keys(noteDraftSchema.shape), name: 'note-draft' };
    case 'encounter':
      return { schema: encounterDraftSchema, keys: Object.keys(encounterDraftSchema.shape), name: 'encounter-draft' };
    case 'plotarc':
      return { schema: plotArcDraftSchema, keys: Object.keys(plotArcDraftSchema.shape), name: 'plotarc-draft' };
  }
}

/**
 * M3-B: instruction section for encounter personas — a numbered list of
 * stat-block-only excerpts the model may cite via `sourceChunkIndex`.
 * fix-02 (decision 1): a monster with no stat source at all is a rejected
 * draft, so the "otherwise name it" fallback is gone — uncited monsters
 * must pick a roster entry or embed a complete inline block.
 */
function buildStatblockCitationSection(statblockTitles: readonly string[]): string | null {
  if (statblockTitles.length === 0) return null;
  return [
    'Stat-block excerpts (0-based index before each):',
    ...statblockTitles.map((title, index) => `[${index}] ${title}`),
    'For each monster: if one of these stat blocks matches, add "sourceChunkIndex": <index> to that monster (referring to this numbered list); otherwise cite an exact bestiary roster entry via "sourceName" when one matches, or embed a complete inline "statBlock" object. A monster with no stat source is rejected.',
  ].join('\n');
}

/**
 * The exact inline stat-block shape encounter personas must embed when no
 * rulebook excerpt matches. Shared by the statblock step and the Cartographer
 * brief so the contract is spelled out identically in both prompts.
 */
function statBlockSchemaHint(system: string): string {
  return (
    `{ "system": "${system}", "level": string, "size": string, "creatureType": string, "ac": number, ` +
    '"acNote": string, "hp": number, "hpFormula": string, "speed": string, ' +
    '"abilities": { "str": number, "dex": number, "con": number, "int": number, "wis": number, "cha": number }, ' +
    '"saves": string, "skills": string, "senses": string, "languages": string, ' +
    '"traits": [{ "name": string, "text": string }], "actions": [{ "name": string, "text": string }], ' +
    '"reactions": [{ "name": string, "text": string }], "legendary": [{ "name": string, "text": string }], ' +
    '"extras": Record<string,string> }'
  );
}

function dataForDraft(kind: ArtifactKind, draft: Record<string, unknown>): ArtifactData {
  switch (kind) {
    case 'pc':
      // Human-owned fields are never drafted: the player owns name, HP and
      // the initiative override.
      return {
        playerName: '',
        statBlock: null,
        currentHp: 0,
        initiativeOverride: null,
        notes: asString(draft.notes),
      };
    case 'npc':
      return {
        appearance: asString(draft.appearance),
        personality: asString(draft.personality),
        statBlock: null,
      };
    case 'location':
    case 'event':
      return {
        locationType: asString(draft.locationType),
        inhabitants: asString(draft.inhabitants),
        pointsOfInterest: Array.isArray(draft.pointsOfInterest)
          ? (draft.pointsOfInterest as { name: string; description: string }[])
          : [],
        hooks: Array.isArray(draft.hooks) ? (draft.hooks as string[]) : [],
      };
    case 'faction':
      return {
        goals: asString(draft.goals),
        methods: asString(draft.methods),
        resources: asString(draft.resources),
        ranks: Array.isArray(draft.ranks)
          ? (draft.ranks as { title: string; description: string }[])
          : [],
      };
    case 'note':
      return {};
    case 'encounter':
      return {
        difficulty: asString(draft.difficulty),
        levelHint: asString(draft.levelHint),
        monsters: Array.isArray(draft.monsters)
          ? (draft.monsters as { name: string; count: number; notes: string; treasure?: string }[]).map((monster) => ({
              ...monster,
              // Mob treasure rides the entry verbatim ('' when the draft
              // omitted it — optional enrichment, not a failure).
              treasure: monster.treasure ?? '',
              // Finalize replaces these with cited/inline sources (M3-B).
              source: { type: 'none' } as const,
            }))
          : [],
        terrain: asString(draft.terrain),
        tactics: asString(draft.tactics),
        treasure: asString(draft.treasure),
        // D10 amendment: the draft's own location classification (the draft
        // step already validated it against the bounded enum; an omitted
        // field parses to 'other'). Guides the automatic battlemap's preset.
        locationKind: encounterLocationKindSchema.parse(draft.locationKind),
        mapImageId: null,
        layout: null,
        // The content-only Smith run produces no map: always standard (the
        // Cartographer map run owns the preset, docs/11 D10).
        preset: 'standard',
        // A Smith-created encounter has no layout yet: a single site until
        // the Cartographer generates one (docs/11 D11).
        siteShape: 'single',
        budgetAdvisory: '',
      };
    case 'plotarc':
      return {
        arcType: asString(draft.arcType),
        premise: asString(draft.premise),
        stakes: asString(draft.stakes),
        beats: Array.isArray(draft.beats)
          ? (draft.beats as { title: string; description: string }[])
          : [],
        hooks: Array.isArray(draft.hooks) ? (draft.hooks as string[]) : [],
        climax: asString(draft.climax),
      };
  }
}

/**
 * Issues for citations that are PRESENT but unresolvable (12-BESTIARY-PACKS
 * §7): an excerpt index outside the list, or a roster name the roster does
 * not contain. Name-only monsters are flagged one level up by
 * `encounterSourceIssues` (fix-02 decision 1). Used inside the source-issue
 * check shared by the Smith draft validation and the Cartographer brief.
 */
function invalidCitationIssues(
  monsters: readonly {
    name: string;
    sourceChunkIndex?: number | undefined;
    sourceName?: string | undefined;
  }[],
  statblockChunkIds: readonly Id[],
  rosterChunkByName: Readonly<Record<string, Id>>,
): string[] {
  const issues: string[] = [];
  for (const [index, monster] of monsters.entries()) {
    if (monster.sourceChunkIndex !== undefined) {
      if (statblockChunkIds[monster.sourceChunkIndex] === undefined) {
        issues.push(
          `monsters[${String(index)}] "${monster.name}": sourceChunkIndex ${String(monster.sourceChunkIndex)} is not in the excerpt list (0–${String(statblockChunkIds.length - 1)})`,
        );
      }
      continue;
    }
    if (monster.sourceName !== undefined) {
      const key = monster.sourceName.trim().toLowerCase();
      if (rosterChunkByName[key] === undefined) {
        issues.push(
          `monsters[${String(index)}] "${monster.name}": sourceName "${monster.sourceName}" is not in the bestiary roster — cite the exact roster name`,
        );
      }
    }
  }
  return issues;
}

/**
 * Encounter monsters must resolve to a stat block: a cited excerpt index that
 * exists, an exact bestiary roster name (§7), or an inline block — checked in
 * that precedence order. Returns one named issue per offender so the repair
 * prompt and the review UI can say exactly what is missing. Shared by the
 * Smith draft validation and the Cartographer brief (fix-02 decisions 1–2:
 * the Smith no longer accepts name-only monsters — one repair, then loud).
 */
function encounterSourceIssues(
  monsters: readonly {
    name: string;
    sourceChunkIndex?: number | undefined;
    sourceName?: string | undefined;
    statBlock?: StatBlock | undefined;
  }[],
  statblockChunkIds: readonly Id[],
  rosterChunkByName: Readonly<Record<string, Id>>,
): string[] {
  const issues = invalidCitationIssues(monsters, statblockChunkIds, rosterChunkByName);
  for (const [index, monster] of monsters.entries()) {
    if (monster.statBlock !== undefined) continue;
    if (
      monster.sourceChunkIndex !== undefined &&
      statblockChunkIds[monster.sourceChunkIndex] !== undefined
    ) {
      continue;
    }
    const named =
      monster.sourceName !== undefined &&
      rosterChunkByName[monster.sourceName.trim().toLowerCase()] !== undefined;
    if (!named) {
      issues.push(
        `monsters[${String(index)}] "${monster.name}": add sourceChunkIndex citing a listed stat-block excerpt, sourceName citing a bestiary roster entry, or an inline statBlock`,
      );
    }
  }
  return issues;
}

/**
 * Merges a refill draft's data over the target artifact's existing data,
 * preserving what the draft pipeline cannot re-produce: a PC's human-owned
 * fields (playerName/currentHp/initiativeOverride are NEVER drafted —
 * 09-MILESTONE-5 M5-A), a PC's stat block the refill produced none for, an
 * NPC's existing stat block when the refill declined stats (a skipped
 * statblock step must not clobber curated stats), and an NPC's mob-artifact
 * marker. Every other field is the draft's — the refill regenerates the
 * artifact's substance, that is its point.
 */
function mergeRefillData(
  kind: ArtifactKind,
  draftData: ArtifactData,
  target: AnyArtifact,
): ArtifactData {
  if (target.kind !== kind) return draftData;
  if (kind === 'npc' && target.kind === 'npc' && 'appearance' in draftData) {
    const previous = target.data;
    return {
      appearance: draftData.appearance,
      personality: draftData.personality,
      // A refill that skipped its statblock step (needsStatBlock=false) or
      // produced none keeps the target's curated block.
      statBlock: draftData.statBlock ?? previous.statBlock,
      // Mob-artifact marker survives the refill (identity, not content).
      ...(previous.monsterChunkId === undefined ? {} : { monsterChunkId: previous.monsterChunkId }),
    };
  }
  if (kind === 'pc' && target.kind === 'pc' && 'notes' in draftData) {
    const previous = target.data;
    return {
      // Human-owned fields are never drafted — the player owns them.
      playerName: previous.playerName,
      currentHp: previous.currentHp,
      initiativeOverride: previous.initiativeOverride,
      statBlock: draftData.statBlock ?? previous.statBlock,
      notes: draftData.notes,
    };
  }
  return draftData;
}

/**
 * Resolve a monster's rulebook chunk in finalize precedence order (§7):
 * cited excerpt index → cited roster name → undefined (the caller then falls
 * to the inline stat block, or none). Draft validation upstream rejects
 * unresolvable citations, so this only sees valid model output or
 * user-edited drafts; each citation still falls through to the next source.
 */
function resolveEncounterMonsterSource(
  monster: { sourceChunkIndex?: number | undefined; sourceName?: string | undefined },
  statblockChunkIds: readonly Id[],
  rosterChunkByName: Readonly<Record<string, Id>>,
): Id | undefined {
  if (monster.sourceChunkIndex !== undefined) {
    const chunkId = statblockChunkIds[monster.sourceChunkIndex];
    if (chunkId !== undefined) return chunkId;
  }
  if (typeof monster.sourceName === 'string') {
    const chunkId = rosterChunkByName[monster.sourceName.trim().toLowerCase()];
    if (chunkId !== undefined) return chunkId;
  }
  return undefined;
}

/**
 * Stamps a rulebook citation with content identity at birth
 * (chunk-hash-fallback arc — the shared `contentIdentityFor` shape, so all
 * births agree).
 *
 * Loud on a vanished chunk (AGENTS rule 1): validation upstream rejected
 * unresolvable citations, so a chunk that is gone between retrieve and
 * finalize is a real gap — refusing to write a dangling citation instead of
 * saving a row that renders 'missing ref' on arrival.
 */
export async function rulebookSourceFor(
  chunkId: Id,
  entryName: string,
  mobArtifactId: Id,
): Promise<Extract<MonsterEntry['source'], { type: 'rulebook' }>> {
  const chunk = (await getChunksByIds([chunkId]))[0];
  if (chunk === undefined) {
    throw new Error(
      `finalize: cited rulebook chunk ${chunkId} no longer exists — refusing to save a dangling citation`,
    );
  }
  return {
    type: 'rulebook',
    chunkId,
    mobArtifactId,
    ...contentIdentityFor(chunk.contentHash, chunk.headingPath[0], entryName),
  };
}

/**
 * fix-02 (decision 1): materializes a Smith-drafted monster as a REAL NPC
 * artifact. The draft's zod-validated inline stat block becomes a
 * campaign-scoped `npc` artifact (created through the repo's
 * `createArtifact` — full schema parse, fresh `stampNewEntity` identity,
 * revision-1 snapshot, revision meta source 'persona' with the run id) and
 * the encounter entry links it via the existing `{type:'npc-ref'}` route, so
 * the mob resolves with a full block and seeds fighting tokens.
 *
 * Reuse (fix-01's one-entity-per-name rule): an NPC of the exact name
 * (case-insensitive, trimmed) already in the campaign is linked instead of
 * duplicated — a statless twin receives the materialized block as a
 * revisioned persona save; an existing stat block is never overwritten.
 * Duplicate names inside one run collapse onto the first materialized
 * artifact via `cache`.
 */
async function materializeMonsterNpc(
  name: string,
  notes: string,
  statBlock: StatBlock,
  input: StartRunInput,
  runId: Id,
  cache: Map<string, Id>,
): Promise<Id> {
  const trimmedName = name.trim();
  if (trimmedName === '') {
    throw new Error('finalize: a monster to materialize has an empty name');
  }
  const key = trimmedName.toLowerCase();
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const existing = (await listArtifactsByCampaign(input.campaign.id)).find(
    (artifact) => artifact.kind === 'npc' && artifact.name.trim().toLowerCase() === key,
  );
  if (existing !== undefined) {
    if (existing.kind !== 'npc') {
      throw new Error(`"${existing.name}" matched an NPC name lookup but is a ${existing.kind}`);
    }
    if (existing.data.statBlock === null) {
      await updateArtifact(
        existing.id,
        { data: { ...existing.data, statBlock } },
        { source: 'persona', runId },
      );
    }
    cache.set(key, existing.id);
    return existing.id;
  }

  const created = await createArtifact(
    {
      campaignId: input.campaign.id,
      kind: 'npc',
      name: trimmedName,
      summary: notes,
      data: { appearance: '', personality: '', statBlock },
    },
    { source: 'persona', runId },
  );
  cache.set(key, created.id);
  return created.id;
}

/**
 * Every roster entry must be assigned to exactly one room — the same rule
 * `validateEncounterLayout` enforces later. Checking it at the brief boundary
 * turns a downstream run-killing layout error into a repairable issue.
 */
function encounterCoverageIssues(brief: EncounterGeneratorBrief, rosterLength: number): string[] {
  const assignment = new Map<number, number>();
  for (const room of brief.rooms) {
    for (const index of room.monsterIndexes) {
      assignment.set(index, (assignment.get(index) ?? 0) + 1);
    }
  }
  const issues: string[] = [];
  for (let index = 0; index < rosterLength; index += 1) {
    if (assignment.get(index) !== 1) {
      issues.push(`rooms: roster entry ${String(index)} must belong to exactly one room`);
    }
  }
  return issues;
}

/**
 * Parses a Cartographer brief reply. Never swallows the reason: a failed parse
 * returns the schema issues (path + message) so they reach the model's repair
 * turn and the user's review card instead of dying in a bare `null`.
 *
 * `stripStatFieldCount` (regenerate mode): the roster's first N entries are
 * the PINNED prefix copied verbatim from the target encounter right after
 * validation, stat sources included, so embedded
 * `statBlock`/`sourceChunkIndex`/`sourceName` fields on those entries carry
 * no information and are stripped before the schema runs — the model echoing
 * a stub block there must not fail the map over data the contract discards.
 * Entries BEYOND the prefix (a complex's bounded expansion, docs/11 D12
 * amendment) keep their fields: their citations/stat blocks are the real
 * sources finalize will persist. Fresh runs keep strict validation: their
 * inline stat blocks become the artifact's source data.
 */
function parseEncounterBrief(
  raw: string,
  opts: { stripStatFieldCount?: number } = {},
): { brief: EncounterGeneratorBrief; issues: [] } | { brief: null; issues: string[] } {
  let json: unknown;
  try {
    json = parseJsonReply(raw);
  } catch (error) {
    return { brief: null, issues: [parseErrorSummary(error)] };
  }
  const stripCount = opts.stripStatFieldCount;
  if (stripCount !== undefined && stripCount > 0 && json !== null && typeof json === 'object' && Array.isArray((json as { monsters?: unknown }).monsters)) {
    const record = json as { monsters: unknown[] };
    // The strip drops only stat-source fields: mob `treasure` is data the
    // contract keeps (the roster contract asks for it verbatim).
    record.monsters = record.monsters.map((monster, index) =>
      index < stripCount && monster !== null && typeof monster === 'object'
        ? {
            name: (monster as { name?: unknown }).name,
            count: (monster as { count?: unknown }).count,
            notes: (monster as { notes?: unknown }).notes,
            treasure: (monster as { treasure?: unknown }).treasure,
          }
        : monster,
    );
  }
  const result = encounterGeneratorBriefSchema.safeParse(json);
  if (result.success) return { brief: result.data, issues: [] };
  return {
    brief: null,
    issues: result.error.issues.map(
      (issue) => `${issue.path.length === 0 ? 'brief' : issue.path.join('.')}: ${issue.message}`,
    ),
  };
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
 * Reads the roster-only pipeline marker off a run's brief step (two-button
 * regeneration, docs/11): the brief step stamps `rosterOnly: true` when it
 * ran in repopulation scope, so continuations that rebuild `StartRunInput`
 * from the run row (approve/edit/retry/resume — no Dexie field carries the
 * scope) keep the brief→finalize shape. User edits replace the output, so
 * both `userEdit` and `output` are read — the edit path re-stamps it.
 */
function briefRosterOnlyMarker(steps: readonly RunStep[]): boolean {
  const brief = steps.find((candidate) => candidate.name === 'brief');
  const effective = brief?.userEdit ?? brief?.output;
  return (
    effective !== null &&
    typeof effective === 'object' &&
    (effective as { rosterOnly?: unknown }).rosterOnly === true
  );
}

/**
 * Reads the dungeon-map path marker off a run's brief step (docs/11 vision
 * path): the brief stamps `mapPath: 'vision' | 'classic'` when it resolves
 * the path from the brief's room count + the per-run override/Settings
 * default, so continuations that rebuild `StartRunInput` from the run row
 * keep the pipeline shape. User edits replace the output, so both
 * `userEdit` and `output` are read — the edit path re-stamps it (the
 * roster-only precedent above).
 */
function briefVisionMapMarker(steps: readonly RunStep[]): 'vision' | 'classic' | undefined {
  const brief = steps.find((candidate) => candidate.name === 'brief');
  const effective = brief?.userEdit ?? brief?.output;
  if (effective !== null && typeof effective === 'object') {
    const value = (effective as { mapPath?: unknown }).mapPath;
    if (value === 'vision' || value === 'classic') return value;
  }
  return undefined;
}

/**
 * The dungeon-map path resolution (docs/11 vision path): the vision
 * pipeline runs ONLY for multi-room briefs whose resolved path is
 * `'vision'` — the explicit per-run choice (D18 steering) beats the
 * Settings default, and SINGLES always resolve classic (one arena needs no
 * registration — the override is ignored, never an error).
 */
function resolveBriefMapPath(
  roomCount: number,
  override: DungeonMapPath | null | undefined,
  settingsPath: DungeonMapPath,
): 'vision' | 'classic' {
  if (roomCount <= 1) return 'classic';
  return (override ?? settingsPath) === 'vision' ? 'vision' : 'classic';
}

/** Draft fields are schema-validated strings; coerce defensively. */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Reads the vision-map step's selected image (docs/11 vision path): the
 * single generated map, validated as a string id at the boundary. A missing
 * or garbage value fails finalize loud — never a dangling map reference.
 */
function readVisionMapImageId(steps: readonly RunStep[]): Id | undefined {
  const vision = steps.find((candidate) => candidate.name === 'vision-map');
  const effective = vision?.userEdit ?? vision?.output;
  if (effective === null || effective === undefined || typeof effective !== 'object') return undefined;
  const imageId = (effective as { imageId?: unknown }).imageId;
  return typeof imageId === 'string' && imageId !== '' ? imageId : undefined;
}

/**
 * Sanitizes a persisted roster name→chunkId map (12-BESTIARY-PACKS §7) from a
 * retrieve/brief step output — step outputs are plain JSON, so keys/values are
 * re-checked instead of trusted.
 */
function sanitizeChunkByName(value: unknown): Record<string, Id> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, Id> = {};
  for (const [key, chunkId] of Object.entries(value)) {
    if (typeof chunkId === 'string' && key.trim() !== '') result[key] = chunkId;
  }
  return result;
}

function effectiveReasoningEffort(persona: Persona, settings: Settings): ReasoningEffort {
  return persona.reasoningEffort !== 'default'
    ? persona.reasoningEffort
    : settings.defaultReasoningEffort;
}

export class RunEngine {
  private listeners = new Set<Listener>();
  private controllers = new Map<Id, AbortController>();
  private cancelRequested = new Set<Id>();
  /** JSON-parse retry state per run (one automatic fix retry per LLM step). */
  private draftRetried = new Set<Id>();
  private statblockRetried = new Set<Id>();
  /** Monster-citation repair state per run (12-BESTIARY-PACKS §7): one repair
   * attempt for unknown sourceName/out-of-range sourceChunkIndex citations. */
  private sourceRepaired = new Set<Id>();
  private encounterSchematics = new Map<Id, { dataUrl: string; width: number; height: number }>();
  private encounterLayoutVariants = new Map<Id, number>();

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: EngineEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /** Starts a run; resolves with the run id once the row exists. */
  async startRun(input: StartRunInput): Promise<Id> {
    if (input.persona.mode === 'image' && input.targetArtifactId === undefined) {
      throw new Error(`"${input.persona.name}" needs a target artifact to illustrate`);
    }
    const run = await createRun({
      campaignId: input.campaign.id,
      personaId: input.persona.id,
      autonomy: input.autonomy,
      userBrief: input.brief,
      pinnedChunkIds: input.pinnedChunkIds,
      targetArtifactId: input.targetArtifactId ?? null,
      encounterMapAspect:
        input.persona.mode === 'encounter'
          ? (input.encounterMapAspect ?? (await getSettings()).encounterMapAspect)
          : null,
      // D10 amendment: the run row persists the EXPLICIT per-run choice only
      // (null = Auto). The Settings fallback is applied by the brief's
      // resolution chain (resolveEncounterPreset), never coerced here —
      // coercing would outrank the encounter's own locationKind.
      encounterPreset:
        input.persona.mode === 'encounter' ? (input.encounterPreset ?? null) : null,
      // The D18 per-run path choice persists explicit-only (null = no
      // override — the Settings default governs at brief time), exactly
      // like the preset above.
      dungeonMapPath:
        input.persona.mode === 'encounter' ? (input.dungeonMapPath ?? null) : null,
      placementModuleId: input.placementModuleId ?? null,
      runExtras: input.extras ?? null,
      // F8: the run context persists with the row so resumeRun reconstructs
      // the exact mode — an unattended run resumed from the Runs tab stays
      // checkpoint-free, and a chain-step run keeps its grounding.
      unattended: input.unattended ?? null,
      contextArtifactIds:
        input.contextArtifactIds === undefined ? null : [...input.contextArtifactIds],
    });
    this.draftRetried.delete(run.id);
    this.statblockRetried.delete(run.id);
    this.sourceRepaired.delete(run.id);
    this.cancelRequested.delete(run.id);
    if (input.persona.mode === 'encounter') {
      this.encounterLayoutVariants.set(run.id, 0);
    }
    if (input.persona.mode === 'encounter' && input.unattended !== true) {
      const rosterOnlyStart = input.encounterScope === 'rosterOnly';
      useProgressStore.getState().start(
        encounterProgressId(run.id),
        rosterOnlyStart ? 'Repopulating encounter roster' : 'Generating encounter map',
        rosterOnlyStart ? 'Drafting the new roster…' : 'Drafting the encounter brief…',
        // The dock label opens the run in the workspace persona panel
        // (deep-linked via ?run=), wherever the user currently is.
        `${workspacePath(input.campaign.id)}?run=${run.id}`,
      );
    }
    void this.executeFrom(run.id, 0, input).catch((error: unknown) => {
      void this.fail(run.id, error);
    });
    return run.id;
  }

  /** Approves the paused step and continues the pipeline. */
  async approve(runId: Id, input: StartRunInput): Promise<void> {
    const run = await getRun(runId);
    if (run === undefined) return;
    const stepIndex = run.steps.findIndex(
      (step) => step.status === 'running' || step.status === 'pending',
    );
    const target = stepIndex === -1 ? run.steps.length - 1 : stepIndex;
    const targetStep = run.steps[target];
    if (targetStep === undefined) return;
    // Approving a pick without a selection means "keep nothing".
    if (targetStep.name === 'pick') {
      if (input.persona.mode === 'encounter') {
        throw new Error('Select one generated battlemap before continuing');
      }
      await this.pickImages(runId, []);
      return;
    }
    // A rejected encounter brief contains only raw model text. Previously the
    // generic Approve button let it through, so the next step parsed
    // `undefined` and failed with an opaque root-level Zod error. Validate the
    // effective boundary before changing status or starting another step.
    if (input.persona.mode === 'encounter') {
      if (targetStep.name === 'brief') this.effectiveEncounterBrief(run.steps);
      if (targetStep.name === 'layout' || targetStep.name === 'vision-map') {
        this.effectiveEncounterLayout(run.steps);
      }
    }
    await this.updateStep(runId, target, { status: 'approved' });
    this.emit({
      kind: 'step',
      runId,
      stepIndex: target,
      status: 'approved',
      stepName: run.steps[target]?.name,
    });
    void this.executeFrom(runId, target + 1, input).catch((error: unknown) => {
      void this.fail(runId, error);
    });
  }

  /** Replaces the paused step's output with the user's edit and continues. */
  async editStep(
    runId: Id,
    stepIndex: number,
    userEdit: unknown,
    input: StartRunInput,
  ): Promise<void> {
    const run = await getRun(runId);
    if (run === undefined) return;
    const targetStep = run.steps[stepIndex];
    if (targetStep === undefined) return;
    if (targetStep.name === 'pick') {
      const keep = (userEdit as { keep?: unknown } | null)?.keep;
      const ids = Array.isArray(keep) ? keep.filter((id): id is Id => typeof id === 'string') : [];
      if (input.persona.mode === 'encounter') {
        await this.pickEncounterMap(runId, ids, input);
      } else {
        await this.pickImages(runId, ids);
      }
      return;
    }
    // User edits are a boundary too: validate encounter wrappers before they
    // are persisted and before downstream steps can observe them.
    if (input.persona.mode === 'encounter') {
      const preview = [...run.steps];
      preview[stepIndex] = { ...targetStep, userEdit };
      if (targetStep.name === 'brief') this.effectiveEncounterBrief(preview);
      if (targetStep.name === 'layout' || targetStep.name === 'vision-map') {
        this.effectiveEncounterLayout(preview);
      }
    }
    // A manual brief edit replaces the step output wholesale — re-stamp the
    // roster-only marker so the edited run keeps its brief→finalize shape
    // (the marker is pipeline metadata, not brief prose).
    let storedEdit: unknown = userEdit;
    if (
      input.persona.mode === 'encounter' &&
      targetStep.name === 'brief' &&
      briefRosterOnlyMarker(run.steps) &&
      storedEdit !== null &&
      typeof storedEdit === 'object' &&
      !Array.isArray(storedEdit) &&
      (storedEdit as { rosterOnly?: unknown }).rosterOnly !== true
    ) {
      storedEdit = { ...storedEdit, rosterOnly: true };
    }
    // A manual brief edit replaces the step output wholesale — re-stamp the
    // dungeon-map path marker so the edited run keeps its pipeline shape
    // (the marker is pipeline metadata, not brief prose). The edited room
    // count re-resolves against the run's per-run choice + the Settings
    // default exactly like a fresh brief.
    if (
      input.persona.mode === 'encounter' &&
      targetStep.name === 'brief' &&
      !briefRosterOnlyMarker(run.steps) &&
      storedEdit !== null &&
      typeof storedEdit === 'object' &&
      !Array.isArray(storedEdit)
    ) {
      const editedParsed = encounterGeneratorBriefSchema.safeParse(
        (storedEdit as { parsed?: unknown }).parsed,
      );
      if (editedParsed.success) {
        const editedSettings = await getSettings();
        storedEdit = {
          ...storedEdit,
          mapPath: resolveBriefMapPath(
            editedParsed.data.rooms.length,
            run.dungeonMapPath ?? input.dungeonMapPath,
            editedSettings.dungeonMapPath,
          ),
        };
      }
    }
    await this.updateStep(runId, stepIndex, { userEdit: storedEdit, status: 'approved' });
    this.emit({
      kind: 'step',
      runId,
      stepIndex,
      status: 'approved',
      stepName: run.steps[stepIndex]?.name,
    });
    void this.executeFrom(runId, stepIndex + 1, input).catch((error: unknown) => {
      void this.fail(runId, error);
    });
  }

  /** Re-runs the paused step, optionally with an extra instruction. */
  async retryStep(runId: Id, extraInstruction: string, input: StartRunInput): Promise<void> {
    const run = await getRun(runId);
    if (run === undefined) return;
    // Retrying clears the step being retried — capture the roster-only scope
    // BEFORE the reset so a repopulation retry keeps its brief→finalize
    // shape (the rebuilt input carries no scope field).
    if (
      input.persona.mode === 'encounter' &&
      input.encounterScope === undefined &&
      briefRosterOnlyMarker(run.steps)
    ) {
      input.encounterScope = 'rosterOnly';
    }
    const stepIndex = run.steps.findIndex(
      (step) =>
        step.status === 'rejected' || step.status === 'running' || step.status === 'pending',
    );
    if (stepIndex === -1) return;
    await this.resetStep(runId, stepIndex);
    await updateRun(runId, { status: 'running', errorMessage: '', failureKind: null });
    this.emit({ kind: 'run', runId, status: 'running' });
    void this.executeFrom(runId, stepIndex, input, extraInstruction).catch((error: unknown) => {
      void this.fail(runId, error);
    });
  }

  /**
   * Resumes a failed or interrupted run from its first incomplete/failed step.
   * Prior successfully completed steps and their artifacts/briefs/layouts are preserved.
   */
  async resumeRun(
    runId: Id,
    extraInstruction = '',
    explicitInput?: StartRunInput,
  ): Promise<void> {
    const run = await getRun(runId);
    if (run === undefined || run.status === 'completed' || run.status === 'cancelled') return;

    let input = explicitInput;
    if (input === undefined) {
      const campaign = await getCampaign(run.campaignId);
      if (campaign === undefined) throw new Error('Campaign for this run no longer exists');
      const persona =
        (await getPersona(run.personaId)) ??
        BUILT_IN_PERSONAS.find((candidate) => candidate.id === run.personaId);
      if (persona === undefined) throw new Error('Persona for this run no longer exists');
      input = {
        campaign,
        persona,
        autonomy: run.autonomy,
        brief: run.userBrief,
        pinnedChunkIds: run.pinnedChunkIds,
        ...(run.targetArtifactId !== null ? { targetArtifactId: run.targetArtifactId } : {}),
        ...(run.encounterMapAspect !== null ? { encounterMapAspect: run.encounterMapAspect } : {}),
        ...(run.encounterPreset !== null ? { encounterPreset: run.encounterPreset } : {}),
        // The D18 per-run path choice rides the row like the preset — a
        // resumed steered run keeps its forced path, never the new default.
        ...(run.dungeonMapPath !== null ? { dungeonMapPath: run.dungeonMapPath } : {}),
        ...(run.placementModuleId !== null ? { placementModuleId: run.placementModuleId } : {}),
        ...(run.runExtras !== null ? { extras: run.runExtras } : {}),
        // F8: the run's context rides the row — the unattended mode (no user
        // checkpoints on resume) and the chain grounding (the resumed draft
        // prompt keeps its earlier-steps context).
        ...(run.unattended === true ? { unattended: run.unattended } : {}),
        ...(run.contextArtifactIds !== null ? { contextArtifactIds: run.contextArtifactIds } : {}),
      };
    }

    const failedOrPendingIndex = run.steps.findIndex(
      (step) =>
        step.status === 'rejected' ||
        step.status === 'running' ||
        step.status === 'pending' ||
        (step.output === null && step.status !== 'skipped'),
    );
    const resumeIndex = failedOrPendingIndex === -1 ? run.steps.length : failedOrPendingIndex;

    if (resumeIndex < run.steps.length) {
      await this.resetStep(runId, resumeIndex);
    }

    await updateRun(runId, {
      status: 'running',
      errorMessage: '',
      // Restarting also drops the stale classification — a resumed run must
      // not carry the previous attempt's failure kind if it fails again.
      failureKind: null,
    });
    this.emit({ kind: 'run', runId, status: 'running' });

    void this.executeFrom(runId, resumeIndex, input, extraInstruction).catch((error: unknown) => {
      void this.fail(runId, error);
    });
  }

  /** Re-packs an approved encounter brief with the next deterministic variant. */
  async regenerateEncounterLayout(runId: Id, input: StartRunInput): Promise<void> {
    const run = await getRun(runId);
    if (run === undefined || input.persona.mode !== 'encounter') return;
    if (briefRosterOnlyMarker(run.steps)) {
      throw new Error('A roster-only repopulation has no layout to regenerate — its rooms are preserved by design');
    }
    if (briefVisionMapMarker(run.steps) === 'vision') {
      throw new Error('A vision-located map has no packed layout to regenerate — retry the vision-map step for a fresh map');
    }
    const stepIndex = run.steps.findIndex((step) => step.name === 'layout');
    if (stepIndex === -1) throw new Error('Encounter run has no layout step to regenerate');
    this.encounterLayoutVariants.set(runId, (this.encounterLayoutVariants.get(runId) ?? 0) + 1);
    this.encounterSchematics.delete(runId);
    await updateRun(runId, {
      status: 'running',
      steps: run.steps.slice(0, stepIndex),
      errorMessage: '',
      failureKind: null,
    });
    void this.executeFrom(runId, stepIndex, input).catch((error: unknown) => {
      void this.fail(runId, error);
    });
  }

  /**
   * Re-runs the STYLIZE step only (owner ask, docs/11 D14 — "the user is the
   * judge with a regenerate option"): same approved brief and layout — room
   * keys and geometry are untouched, so no key-replacement concern — with a
   * fresh candidate batch, and the run pauses at pick again. The discarded
   * batch's still-unattached candidates are pruned first
   * (deleteUnreferencedImages re-checks the referenced set, so an id that
   * somehow got attached survives). Mirrors regenerateEncounterLayout's
   * truncate-and-execute resume machinery; the schematic is re-rendered
   * deterministically from the same layout when its cache is cold.
   */
  async regenerateEncounterCandidates(runId: Id, input: StartRunInput): Promise<void> {
    const run = await getRun(runId);
    if (run === undefined || input.persona.mode !== 'encounter') return;
    if (briefRosterOnlyMarker(run.steps)) {
      throw new Error('A roster-only repopulation has no map candidates to regenerate — its map is preserved by design');
    }
    if (briefVisionMapMarker(run.steps) === 'vision') {
      throw new Error('A vision-located map has no stylized candidates to regenerate — retry the vision-map step for a fresh map');
    }
    const stepIndex = run.steps.findIndex((step) => step.name === 'stylize');
    if (stepIndex === -1) throw new Error('Encounter run has no stylize step to regenerate');
    const discarded = run.steps
      .filter((step) => step.name === 'stylize' || step.name === 'pick')
      .flatMap((step) => {
        const output = (step.output ?? {}) as { imageIds?: unknown; candidates?: unknown };
        const ids = [
          ...(Array.isArray(output.imageIds) ? (output.imageIds as readonly unknown[]) : []),
          ...(Array.isArray(output.candidates) ? (output.candidates as readonly unknown[]) : []),
        ];
        return ids.filter((id): id is Id => typeof id === 'string');
      });
    if (discarded.length > 0) await deleteUnreferencedImages(run.campaignId, discarded);
    await updateRun(runId, {
      status: 'running',
      steps: run.steps.slice(0, stepIndex),
      errorMessage: '',
      failureKind: null,
    });
    void this.executeFrom(runId, stepIndex, input).catch((error: unknown) => {
      void this.fail(runId, error);
    });
  }

  /** Cancels the run, aborting any in-flight request. */
  async cancel(runId: Id): Promise<void> {
    this.cancelRequested.add(runId);
    this.controllers.get(runId)?.abort();
    await updateRun(runId, { status: 'cancelled' });
    this.emit({ kind: 'run', runId, status: 'cancelled' });
    this.controllers.delete(runId);
    this.cancelRequested.delete(runId);
    this.draftRetried.delete(runId);
    this.statblockRetried.delete(runId);
    this.sourceRepaired.delete(runId);
    this.encounterSchematics.delete(runId);
    this.encounterLayoutVariants.delete(runId);
    useProgressStore.getState().finish(encounterProgressId(runId));
  }

  /**
   * Stop-all seam (features/progress/stop-all-generations): cancels every
   * IN-FLIGHT run — the engine's own controller registry is the in-flight
   * set; a paused run (awaiting_user / needs_review) is NOT generating and
   * is left alone. Cancelled runs keep the existing semantics: resumable,
   * row marked 'cancelled' (never destructive). Returns the cancelled run
   * ids. A run whose row vanished mid-cancel is a loud aggregate failure
   * AFTER the others were still cancelled — a partial stop is never silent.
   */
  async cancelAllActive(): Promise<Id[]> {
    // Snapshot first: cancel() mutates the registry (and new runs may start
    // mid-sweep — they belong to the next stop, not this one).
    const ids = [...this.controllers.keys()];
    const results = await Promise.allSettled(ids.map((id) => this.cancel(id)));
    const failures = results.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    );
    if (failures.length > 0) {
      throw new Error(
        `Could not cancel ${String(failures.length)} of ${String(ids.length)} running generations: ` +
          failures.map((outcome) => errorMessage(outcome.reason)).join('; '),
      );
    }
    return ids;
  }

  private async executeFrom(
    runId: Id,
    startIndex: number,
    input: StartRunInput,
    extraInstruction = '',
  ): Promise<void> {
    const run = await getRun(runId);
    if (run === undefined || run.status === 'cancelled' || run.status === 'failed') return;

    const steps: RunStep[] = [...run.steps];
    const kinds: StepName[] =
      input.persona.mode === 'review'
        ? [...REVIEW_STEP_NAMES]
        : input.persona.mode === 'image'
          ? [...IMAGE_STEP_NAMES]
          : input.persona.mode === 'encounter'
            ? this.encounterPipelineKinds(input, run.steps)
            : input.persona.producesKind === 'npc'
            ? [...STEP_NAMES]
            : STEP_NAMES.filter((name) => name !== 'statblock');

    const controller = new AbortController();
    this.controllers.set(runId, controller);
    let activeStepName: StepName | null = null;

    try {
      for (let i = startIndex; i < kinds.length; i += 1) {
        const name = kinds[i];
        if (name === undefined) break;
        activeStepName = name;
        if (this.cancelRequested.has(runId)) {
          await updateRun(runId, { status: 'cancelled' });
          this.emit({ kind: 'run', runId, status: 'cancelled' });
          return;
        }
        const step: RunStep = {
          index: i,
          name,
          status: 'running',
          input: {},
          output: null,
          userEdit: null,
        };
        steps[i] = step;
        await updateRun(runId, { steps: [...steps] });
        this.emit({ kind: 'step', runId, stepIndex: i, status: 'running', stepName: name });
        if (input.persona.mode === 'encounter') {
          useProgressStore.getState().update(encounterProgressId(runId), {
            detail: encounterStepDetail(name),
            progress: i / kinds.length,
          });
        }

        const outcome = await this.runStep(
          runId,
          i,
          name,
          steps,
          input,
          controller.signal,
          extraInstruction,
        );
        debugLog('run', `step ${name} finished with status ${outcome.step.status}`);
        steps[i] = outcome.step;
        // The encounter pipeline shape re-resolves after the brief (docs/11
        // vision path): only the brief knows the room count, so an auto run
        // whose brief stamped a vision marker continues into vision-map, not
        // layout. Paused runs re-resolve on continuation (executeFrom reads
        // the stamped marker), so this only steers the in-flight loop.
        if (input.persona.mode === 'encounter' && name === 'brief' && outcome.step.status !== 'rejected') {
          const resolved = this.encounterPipelineKinds(input, steps);
          kinds.length = 0;
          kinds.push(...resolved);
        }
        await updateRun(runId, {
          steps: [...steps],
          status: outcome.runStatus ?? 'running',
          resultArtifactId: outcome.artifactId ?? run.resultArtifactId,
        });
        this.emit({
          kind: 'step',
          runId,
          stepIndex: i,
          status: outcome.step.status,
          stepName: name,
        });

        if (outcome.runStatus !== undefined && outcome.runStatus !== 'running') {
          this.emit({ kind: 'run', runId, status: outcome.runStatus });
          if (input.persona.mode === 'encounter') {
            useProgressStore.getState().update(encounterProgressId(runId), {
              detail: outcome.runStatus === 'needs_review' ? 'Map needs review' : 'Waiting for your approval',
              progress: (i + 1) / kinds.length,
            });
          }
          return; // paused (awaiting_user / needs_review)
        }

        // Auto autonomy has no user to rescue a rejected step: any step whose
        // output failed validation (draft, statblock, check)
        // fails the run instead of silently continuing toward placeholder
        // output (e.g. an empty artifact named after the persona — the
        // "Worldbuilder"-class bug).
        if (outcome.step.status === 'rejected' && input.autonomy === 'auto') {
          const issues = rejectionIssues(outcome.step);
          const reason =
            `Step "${name}" rejected: the model reply could not be parsed into the required ` +
            `JSON shape after one automatic retry` +
            (issues.length === 0 ? '' : ` (${issues.join('; ')})`) +
            `. The run failed without saving partial results — ` +
            `run it again, or use manual/review autonomy to keep the raw reply for editing.`;
          await updateRun(runId, {
            status: 'failed',
            errorMessage: reason,
            failureKind: 'invalid-output',
            steps: [...steps],
          });
          this.draftRetried.delete(runId);
          this.statblockRetried.delete(runId);
          this.sourceRepaired.delete(runId);
          if (input.persona.mode === 'encounter') {
            useProgressStore.getState().finish(encounterProgressId(runId));
          }
          this.emit({ kind: 'run', runId, status: 'failed' });
          return;
        }
      }

      await updateRun(runId, { status: 'completed' });
      this.draftRetried.delete(runId);
      this.statblockRetried.delete(runId);
      this.sourceRepaired.delete(runId);
      this.encounterSchematics.delete(runId);
      useProgressStore.getState().finish(encounterProgressId(runId));
      this.emit({ kind: 'run', runId, status: 'completed' });
    } catch (error) {
      if (
        this.cancelRequested.has(runId) ||
        (error instanceof DOMException && error.name === 'AbortError')
      ) {
        await updateRun(runId, { status: 'cancelled' });
        this.emit({ kind: 'run', runId, status: 'cancelled' });
      } else if (input.persona.mode === 'encounter' && activeStepName !== null) {
        const message = errorMessage(error);
        throw new Error(`Encounter step "${activeStepName}" failed: ${message}`, { cause: error });
      } else {
        throw error;
      }
    } finally {
      this.controllers.delete(runId);
    }
  }

  private async runStep(
    runId: Id,
    stepIndex: number,
    name: StepName,
    steps: RunStep[],
    input: StartRunInput,
    signal: AbortSignal,
    extraInstruction: string,
  ): Promise<{ step: RunStep; runStatus?: PersonaRun['status']; artifactId?: Id }> {
    switch (name) {
      case 'retrieve':
        return this.runRetrieve(runId, stepIndex, steps, input);
      case 'draft':
        return this.runDraft(runId, stepIndex, steps, input, signal, extraInstruction);
      case 'statblock':
        return this.runStatblock(runId, stepIndex, steps, input, signal, extraInstruction);
      case 'gather':
        return this.runGather(stepIndex, steps, input);
      case 'check':
        return this.runCheck(runId, stepIndex, steps, input, signal, extraInstruction);
      case 'prompt-draft':
        return this.runPromptDraft(stepIndex, steps, input, extraInstruction);
      case 'generate':
        return this.runGenerate(runId, stepIndex, steps, input, signal);
      case 'brief':
        return this.runEncounterBrief(runId, stepIndex, steps, input, signal, extraInstruction);
      case 'vision-map':
        return this.runVisionDungeonMap(stepIndex, steps, input, signal);
      case 'layout':
        return this.runEncounterLayout(runId, stepIndex, steps, input);
      case 'schematic':
        return this.runEncounterSchematic(runId, stepIndex, steps);
      case 'stylize':
        return this.runEncounterStylize(runId, stepIndex, steps, input, signal);
      case 'pick':
        return input.persona.mode === 'encounter'
          ? this.runEncounterPick(stepIndex, steps, input)
          : this.runPick(stepIndex, steps);
      case 'finalize':
        if (input.persona.mode === 'encounter') {
          return this.encounterIsRosterOnly(input, steps)
            ? this.runEncounterRosterFinalize(runId, stepIndex, steps, input)
            : this.runEncounterFinalize(runId, stepIndex, steps, input);
        }
        return this.runFinalize(runId, stepIndex, steps, input);
    }
  }

  /** The parsed continuity report from the check step (or null). */
  private reportFromCheck(steps: readonly RunStep[]): ContinuityReport | null {
    const checkStep = steps.find((step) => step.name === 'check');
    const effective = checkStep?.userEdit ?? checkStep?.output;
    if (effective === null || effective === undefined || typeof effective !== 'object') return null;
    const report = (effective as { report?: unknown }).report;
    return report !== undefined && report !== null && typeof report === 'object'
      ? (report as ContinuityReport)
      : null;
  }

  private targetName(steps: readonly RunStep[]): string {
    const gatherStep = steps.find((step) => step.name === 'gather');
    const effective = gatherStep?.userEdit ?? gatherStep?.output;
    if (effective === null || effective === undefined || typeof effective !== 'object') {
      throw new Error('finalize: the review run has no gather output to read the target from');
    }
    const target = (effective as { target?: { name?: unknown } | null }).target;
    const name = target?.name;
    if (typeof name !== 'string' || name === '') {
      throw new Error('finalize: the review run has no readable target artifact');
    }
    return name;
  }

  private effectiveDraft(steps: readonly RunStep[]): Record<string, unknown> | null {
    const draftStep = steps.find((step) => step.name === 'draft');
    if (draftStep === undefined) return null;
    const effective = draftStep.userEdit ?? draftStep.output;
    if (effective === null || typeof effective !== 'object') return null;
    const parsed = (effective as { parsed?: unknown }).parsed;
    return parsed !== undefined && parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  }

  /**
   * The roster prompt window's target level (12-BESTIARY-PACKS §7, ratified
   * chain), resolved at the run-engine boundary from what the run carries:
   * (a) the target encounter's free-text `levelHint` ("5", "4–6", "CR 5" —
   * the first digit run wins); (b) else, when the run is module-scoped (the
   * target artifact is owned by a module), that module's
   * `levelMin`/`levelMax` band midpoint; (c) else undefined — the window
   * keeps the level/name-ascending order. The chain is graceful by design:
   * an empty/unparseable levelHint is a legitimate preference state (the
   * hint is a user preference string, not data that failed), so it falls to
   * the next preference. A target artifact claiming module ownership whose
   * module row is gone is corrupt data and fails loudly instead of silently
   * ordering without a target.
   */
  private async rosterTargetLevelFor(input: StartRunInput): Promise<number | undefined> {
    if (input.targetArtifactId === undefined) return undefined;
    const target = await getAnyArtifact(input.targetArtifactId);
    // A vanished target is unreachable in the sanctioned flow (the encounter
    // brief validates it before this runs); without one there is no target
    // preference and the window stays ascending.
    if (target === undefined) return undefined;
    if (target.kind === 'encounter') {
      const fromHint = parseRosterTargetLevel(target.data.levelHint);
      if (fromHint !== undefined) return fromHint;
    }
    if (target.moduleId === null) return undefined;
    const module = await getModule(target.moduleId);
    if (module === undefined) {
      throw new Error(
        `roster target level: "${target.name}" references module ${target.moduleId}, which does not exist`,
      );
    }
    return (module.levelMin + module.levelMax) / 2;
  }

  private async retrieveContext(runId: Id, input: StartRunInput): Promise<RetrieveContext> {
    // First semantic search after enabling embeddings backfills the whole
    // library — minutes of embedding requests before the first LLM call. The
    // dock job appears with the first batch, so a warm cache shows nothing.
    const contextJobId = `run-context-${runId}`;
    const onEmbeddingProgress = (done: number, total: number): void => {
      const store = useProgressStore.getState();
      // start() replaces any job with the same id — idempotent per tick.
      store.start(contextJobId, 'Preparing context', 'embedding rulebook excerpts…');
      store.update(contextJobId, {
        detail: `embedding rulebook excerpts (${String(done)}/${String(total)})`,
        progress: total === 0 ? null : done / total,
      });
    };
    try {
      const query = `${input.brief} (${GAME_SYSTEM_LABELS[input.campaign.system]})`;
      // The run's retrieval is campaign-scoped: grounding excerpts and the
      // citable stat-block pool never cross game systems (pack AND PDF books
      // carry `system`) — a pf2e book is not searchable by a dnd5e run.
      const hits = await searchRules(query, {
        limit: 8,
        system: input.campaign.system,
        onEmbeddingProgress,
      });
      const pinned = await getChunksByIds([...input.pinnedChunkIds]);
      const merged: Id[] = [...pinned.map((chunk) => chunk.id)];
      // M3-B: the Encounter Designer gets a second search restricted to
      // statblock chunks so it can cite real bestiary entries.
      const statblockChunkIds: Id[] = [];
      let rosterLines: string[] = [];
      let rosterTruncated = 0;
      let rosterChunkByName: Record<string, Id> = {};
      let itemLines: string[] = [];
      let itemTruncated = 0;
      let itemChunkByName: Record<string, Id> = {};
      if (input.persona.producesKind === 'encounter') {
        // Pinned-citability: an explicitly pinned chunk is an instruction to
        // use it, so a pinned chunk joins the citation list in PIN ORDER,
        // ahead of the ranked hits (mirroring the excerpt merge's
        // pinned-first convention; the ranked loop below dedupes against
        // `merged`, which already holds every pinned id). The fix-02 pool
        // invariant still binds: only a parsed chunk (statBlock !== null —
        // the same check the hasStatBlock search filter applies) becomes
        // citable; a pinned null-statBlock chunk stays excerpt-context-only.
        for (const chunk of pinned) {
          if (chunk.statBlock !== null && !statblockChunkIds.includes(chunk.id)) {
            statblockChunkIds.push(chunk.id);
          }
        }
        // fix-02 (decision 3): the citable pool excludes unparsed chunks —
        // a 'statblock' chunk whose best-effort parse gave up must never
        // consume a citation slot or be offered to the model.
        const statHits = await searchRules(query, {
          limit: 6,
          chunkTypes: ['statblock'],
          hasStatBlock: true,
          system: input.campaign.system,
          onEmbeddingProgress,
        });
        for (const hit of statHits) {
          if (!merged.includes(hit.chunk.id)) {
            merged.push(hit.chunk.id);
            statblockChunkIds.push(hit.chunk.id);
          }
        }
        // Treasure grounding (owner-ratified room-keys/treasure arc): one
        // bounded third search over rules/table chunks so the budget rules —
        // pf2e's GM Core Treasure chapter VERBATIM (CUP-pinned), or any
        // system's own treasure text — reach the prompt window. Excerpt
        // context only: never a citation, never a stat source.
        const treasureHits = await searchRules('treasure budget by level party wealth hoard coins', {
          limit: 3,
          chunkTypes: ['section', 'table'],
          system: input.campaign.system,
          onEmbeddingProgress,
        });
        for (const hit of treasureHits) {
          if (!merged.includes(hit.chunk.id)) {
            merged.push(hit.chunk.id);
          }
        }
        // M-B (§7): the roster index over every ready pack book grounds WHICH
        // creatures to field. fix-02 (decision 4): one automatic retry for a
        // transient failure, then the named error fails the run loudly — a
        // corrupt pack chunk or dead book never degrades to inline-only.
        // §7 ratified amendment: the 300-line PROMPT WINDOW is ordered by
        // level distance to the run's target level (levelHint → module band
        // midpoint → none), so a huge import surfaces threatening creatures
        // instead of the first 300 low-CR entries. Resolution is unaffected:
        // the name index still covers every entry.
        const rosterTargetLevel = await this.rosterTargetLevelFor(input);
        const roster = await collectPackRosterWithRetry(
          input.campaign.system,
          undefined,
          undefined,
          rosterTargetLevel,
        );
        rosterLines = roster.lines;
        rosterTruncated = roster.truncated;
        rosterChunkByName = Object.fromEntries(roster.chunkByName);
        // §13 (item-corpus arc): the item pool — the roster's equipment
        // counterpart — over every ready pack book that imported items,
        // ordered by the same resolved target level. Retry + loud failure
        // match the roster; a corrupt item chunk never degrades the run.
        const pool = await collectItemPoolWithRetry(
          input.campaign.system,
          undefined,
          undefined,
          {},
          rosterTargetLevel,
        );
        itemLines = pool.lines;
        itemTruncated = pool.truncated;
        itemChunkByName = Object.fromEntries(pool.chunkByName);
      }
      for (const hit of hits) {
        if (merged.length >= 12) break;
        if (!merged.includes(hit.chunk.id)) merged.push(hit.chunk.id);
      }
      const chunks = await getChunksByIds(merged);
      const books = await listRulebooks();
      const titleById = new Map(books.map((book) => [book.id, book.title]));
      const titles = chunks.map(
        (chunk) => `${titleById.get(chunk.bookId) ?? 'Unknown'} p.${chunk.pageStart}`,
      );
      const excerpts = chunks
        .map((chunk, i) => {
          const where = titles[i] ?? '';
          const heading = chunk.headingPath.join(' > ');
          return `[${where}] ${heading}\n${chunk.text}`;
        })
        .join('\n\n');
      const statblockChunks = statblockChunkIds
        .map((id) => chunks.find((chunk) => chunk.id === id))
        .filter((chunk): chunk is (typeof chunks)[number] => chunk !== undefined);
      const statblockTitles = statblockChunks.map(
        (chunk) =>
          `${titleById.get(chunk.bookId) ?? 'Unknown'} p.${chunk.pageStart} — ${chunk.headingPath.join(' > ')}`,
      );
      // 15-GRAPH-RETRIEVAL: graph-aware campaign grounding, computed HERE
      // inside the retrieve step from campaign sources only — zero new
      // searchRules calls, zero query embeddings, zero LLM calls. An OFF
      // toggle, an empty module set or zero detections yield no section.
      // In-place refill parity: the module context is computed FIRST and
      // appended to the detection text, so the grounding detects on the
      // same module prose the automatic generation's brief carries.
      const moduleGrounding = await this.targetModuleGrounding(input);
      const detectionText =
        moduleGrounding?.status === 'ok'
          ? [
              input.brief,
              moduleGrounding.contextParagraphs ?? '',
              moduleGrounding.premise ?? '',
            ]
              .filter((part) => part !== '')
              .join('\n\n')
          : input.brief;
      const expansionExcerpts = await this.campaignGroundingFor(input, detectionText);
      return {
        chunkIds: merged,
        titles,
        excerpts,
        statblockChunkIds,
        statblockTitles,
        rosterLines,
        rosterTruncated,
        rosterChunkByName,
        itemLines,
        itemTruncated,
        itemChunkByName,
        expansionExcerpts,
        moduleGrounding: moduleGrounding ?? undefined,
      };
    } finally {
      useProgressStore.getState().finish(contextJobId);
    }
  }

  /**
   * The derived campaign-grounding blocks (15-GRAPH-RETRIEVAL), gated by the
   * global settings toggle (D4, default ON, mirroring `embeddingsEnabled`).
   * Pure derivation over the campaign's modules and the reader's resolution
   * pool (campaign artifacts + global library, the buildWikiGraph contract);
   * repo failures propagate and fail the run loudly — never a silent empty
   * section.
   *
   * `detectionText` overrides the brief for DETECTION only: an in-place
   * refill appends the target's module context so the grounding sees the
   * same text the automatic module generation would have detected on (the
   * refill's own brief stays untouched on the run row).
   */
  private async campaignGroundingFor(
    input: StartRunInput,
    detectionText?: string,
  ): Promise<ExpansionExcerpt[]> {
    const settings = await getSettings();
    if (!settings.wikiGroundingEnabled) return [];
    const [modules, campaignArtifacts, globalArtifacts] = await Promise.all([
      listModulesByCampaign(input.campaign.id),
      listArtifactsByCampaign(input.campaign.id),
      listGlobalArtifacts(),
    ]);
    return computeCampaignGrounding({
      brief: detectionText ?? input.brief,
      modules,
      pool: [...campaignArtifacts, ...globalArtifacts],
    });
  }

  /**
   * The in-place refill's module grounding (parity with automatic module
   * generation, 08 §M4-C): a targeted GENERATE run grounds its draft in the
   * target artifact's owning module exactly as `runEntityBatch` would —
   * `surroundingParagraphs(moduleDocumentText(module), name)` + the spine
   * premise. Every inapplicable state comes back NAMED (not-module-owned /
   * module-missing) so the prompt degrades explicitly (AGENTS rule 1); a
   * vanished target artifact fails the run loudly. Encounter-mode runs are
   * out of scope: their brief pipeline owns its own context contract
   * (docs/11) and is untouched here.
   */
  private async targetModuleGrounding(input: StartRunInput): Promise<TargetModuleGrounding | null> {
    if (input.targetArtifactId === undefined || input.persona.mode !== 'generate') return null;
    const target = await getAnyArtifact(input.targetArtifactId);
    if (target === undefined) {
      throw new Error(`The artifact to refill (${input.targetArtifactId}) no longer exists`);
    }
    if (target.moduleId === null) {
      return { status: 'not-module-owned' };
    }
    const module = await getModule(target.moduleId);
    if (module === undefined) {
      return { status: 'module-missing', moduleId: target.moduleId };
    }
    return {
      status: 'ok',
      moduleId: module.id,
      moduleTitle: module.title,
      contextParagraphs: surroundingParagraphs(moduleDocumentText(module), target.name),
      premise: module.spine?.premise ?? '',
    };
  }

  private async runRetrieve(
    runId: Id,
    stepIndex: number,
    steps: RunStep[],
    input: StartRunInput,
  ): Promise<{ step: RunStep }> {
    const context = await this.retrieveContext(runId, input);
    debugLog('run', `retrieve done: ${String(context.chunkIds.length)} chunks selected`);
    const step = this.finishStep(steps[stepIndex], {
      chunkIds: context.chunkIds,
      titles: context.titles,
      statblockChunkIds: context.statblockChunkIds,
      rosterChunkByName: context.rosterChunkByName,
      // The draft consumes these verbatim (see contextFromRetrieveStep) —
      // persisting them keeps the roster grounding byte-identical without a
      // second roster collection.
      rosterLines: context.rosterLines,
      rosterTruncated: context.rosterTruncated,
      // §13: the item pool persists with the same contract as the roster.
      itemChunkByName: context.itemChunkByName,
      itemLines: context.itemLines,
      itemTruncated: context.itemTruncated,
      // 15-GRAPH-RETRIEVAL: the campaign-grounding blocks persist with the
      // selection so the draft renders the stored ones byte-identically —
      // nothing re-derives the graph at draft time.
      expansionExcerpts: context.expansionExcerpts,
      // In-place refill parity: the module grounding persists with the
      // selection the same way (absent for runs without a refill target).
      ...(context.moduleGrounding === undefined ? {} : { moduleGrounding: context.moduleGrounding }),
    });
    return { step };
  }

  /**
   * Validates the retrieve step's PERSISTED output (AGENTS rule 3): data at
   * rest is zod-parsed, never cast. Shared by the draft re-grounding and by
   * finalize — the retrieve step always persists a valid output, so garbage
   * here (e.g. a broken hand edit) is an internal invariant violation that
   * must throw loudly, never silently degrade to empty maps.
   */
  private storedRetrieveOutput(steps: readonly RunStep[]): z.infer<typeof storedRetrieveOutputSchema> {
    const parsed = storedRetrieveOutputSchema.safeParse(
      steps.find((step) => step.name === 'retrieve')?.output ?? null,
    );
    if (!parsed.success) {
      throw new Error('the run has no retrieve output to ground from — the retrieve step must run first');
    }
    return parsed.data;
  }

  /**
   * Rebuilds the grounding context from the retrieve step's PERSISTED
   * output. Draft/statblock used to call retrieveContext again — 2 extra
   * searches + 2 extra query embeddings per run — although the retrieve
   * step had already selected the chunks. Rebuilding the excerpts from the
   * stored chunk ids reproduces the retrieve step's grounding exactly (same
   * ids, same order, same rendering — the valid-mobs pack-roster and
   * citation sections included), so the draft and statblock prompts are
   * byte-identical to the re-searched path. Missing retrieve output is a
   * loud error, never a re-search fallback.
   *
   * 15-GRAPH-RETRIEVAL: the stored campaign-grounding blocks are returned
   * verbatim — nothing re-derives the graph here, so pause/resume and
   * mid-run edits cannot drift the prompt. Only their SOURCE REFERENCES
   * are validated on read (impossible-miss rule, §3.7): a stored excerpt
   * whose module/part vanished mid-run fails loudly instead of silently
   * rendering grounding from a source that no longer exists.
   */
  private async contextFromRetrieveStep(
    steps: readonly RunStep[],
    campaignId: Id,
  ): Promise<RetrieveContext> {
    const output = this.storedRetrieveOutput(steps);
    if (output.expansionExcerpts.some((excerpt) => excerpt.moduleId !== undefined)) {
      validateExpansionSources(
        output.expansionExcerpts,
        await listModulesByCampaign(campaignId),
      );
    }
    const chunkIds = output.chunkIds;
    const statblockChunkIds = output.statblockChunkIds;
    const chunks = await getChunksByIds(chunkIds);
    const books = await listRulebooks();
    const titleById = new Map(books.map((book) => [book.id, book.title]));
    const titles = chunks.map(
      (chunk) => `${titleById.get(chunk.bookId) ?? 'Unknown'} p.${chunk.pageStart}`,
    );
    const excerpts = chunks
      .map((chunk, i) => {
        const where = titles[i] ?? '';
        const heading = chunk.headingPath.join(' > ');
        return `[${where}] ${heading}\n${chunk.text}`;
      })
      .join('\n\n');
    const statblockChunks = statblockChunkIds
      .map((id) => chunks.find((chunk) => chunk.id === id))
      .filter((chunk): chunk is (typeof chunks)[number] => chunk !== undefined);
    const statblockTitles = statblockChunks.map(
      (chunk) =>
        `${titleById.get(chunk.bookId) ?? 'Unknown'} p.${chunk.pageStart} — ${chunk.headingPath.join(' > ')}`,
    );
    return {
      chunkIds,
      titles,
      excerpts,
      statblockChunkIds,
      statblockTitles,
      rosterLines: output.rosterLines,
      rosterTruncated: output.rosterTruncated,
      rosterChunkByName: output.rosterChunkByName,
      itemLines: output.itemLines,
      itemTruncated: output.itemTruncated,
      itemChunkByName: output.itemChunkByName,
      expansionExcerpts: output.expansionExcerpts,
      // In-place refill parity: the stored module grounding rides along so
      // the draft renders it byte-identically across pause/resume.
      moduleGrounding: output.moduleGrounding,
    };
  }

  /**
   * The per-step chat options (one builder instead of five inlined copies):
   * every LLM step streams its deltas to the UI through the engine emitter —
   * content tokens, reasoning illustration, and the reset signal a model
   * fallback fires before it restarts the stream.
   */
  private chatForStep(
    runId: Id,
    stepIndex: number,
    base: Pick<ChatOptions, 'model' | 'temperature' | 'reasoningEffort' | 'responseFormat' | 'signal'>,
  ): ChatOptions {
    return {
      ...base,
      onToken: (delta) => {
        this.emit({ kind: 'token', runId, stepIndex, delta });
      },
      onReasoning: (delta) => {
        this.emit({ kind: 'thinking', runId, stepIndex, delta });
      },
      onReset: () => {
        this.emit({ kind: 'reset', runId, stepIndex });
      },
    };
  }

  private async runDraft(
    runId: Id,
    stepIndex: number,
    steps: RunStep[],
    input: StartRunInput,
    signal: AbortSignal,
    extraInstruction: string,
  ): Promise<{ step: RunStep; runStatus?: PersonaRun['status'] }> {
    const settings = await getSettings();
    // Grounding comes from the retrieve step's stored selection — no
    // duplicate search/embedding pass (see contextFromRetrieveStep).
    const context = await this.contextFromRetrieveStep(steps, input.campaign.id);
    const kind = input.persona.producesKind;
    if (kind === undefined) throw new Error('image personas do not draft artifacts');
    const contract = draftContractFor(kind);
    const contextArtifacts = await loadContextArtifacts(input.contextArtifactIds ?? []);
    const contextSection =
      contextArtifacts.length === 0
        ? null
        : `Artifacts created earlier in this pipeline:\n${contextArtifacts
            .map(
              (artifact) =>
                `- ${artifact.name}${artifact.summary === '' ? '' : ` — ${artifact.summary}`}\n${artifact.body}`,
            )
            .join('\n')}`;
    // 15-GRAPH-RETRIEVAL: the campaign-grounding section renders after the
    // Task line, from the retrieve step's STORED blocks (byte-identical
    // across pause/resume; no re-derivation). The toggle is read ONCE, at
    // compute time (campaignGroundingFor) — a mid-run ON→OFF flip cannot
    // un-render persisted blocks: the prompt is a function of the persisted
    // data. Empty blocks render no section at all — never an empty block.
    const groundingSection =
      context.expansionExcerpts.length > 0
        ? renderCampaignGroundingSection(context.expansionExcerpts)
        : null;
    // In-place refill parity: the owning module's document + premise render
    // from the STORED grounding, right after the Task line — the same
    // sources the automatic module generation grounds its briefs in. Every
    // inapplicable state names itself (moduleGroundingSection).
    const moduleSection = moduleGroundingSection(context.moduleGrounding);
    const instruction = [
      `Campaign: ${input.campaign.name} (${GAME_SYSTEM_LABELS[input.campaign.system]})${input.campaign.description === '' ? '' : ` — ${input.campaign.description}`}`,
      `Task: ${input.brief}`,
      moduleSection,
      groundingSection,
      contextSection,
      context.excerpts === ''
        ? 'No rule excerpts available.'
        : `Rule excerpts:\n${context.excerpts}`,
      buildStatblockCitationSection(context.statblockTitles),
      formatRosterSection(context.rosterLines, context.rosterTruncated),
      // §13: the item pool renders after the roster — null (nothing rendered)
      // without item books, so prompts stay byte-identical to the pre-arc shape.
      formatItemPoolSection(context.itemLines, context.itemTruncated),
      // fix-02 (decision 1): with neither excerpts nor a roster there is
      // nothing to cite — the draft must inline a complete block per monster,
      // which finalize then materializes into a real NPC artifact.
      kind === 'encounter' &&
      context.statblockChunkIds.length === 0 &&
      context.rosterLines.length === 0
        ? `No stat-block excerpts and no bestiary roster are available, so every monster needs a complete inline "statBlock" object matching exactly this shape: ${statBlockSchemaHint(input.campaign.system)}. A partial stat block is rejected.`
        : null,
      // The only NPC-specific guidance left: whether stats matter is the
      // draft's call, so non-fightable characters skip the statblock step.
      kind === 'npc'
        ? [
            'Field guidance for this NPC:',
            '- "needsStatBlock": true only when the character is likely to fight or their stats matter at the table (adversaries, rivals, guards, bosses); false for contacts, merchants, innkeepers, informants, quest-givers.',
          ].join('\n')
        : null,
      // Mob treasure (owner-ratified): structure + per-system budget. Renders
      // for encounter drafts only; coheres with the item-pool section above
      // (it adds structure/budget, never re-states the pool instruction).
      kind === 'encounter' ? treasureGuidanceFor(input.campaign.system) : null,
      // D10 amendment: the encounter draft classifies its own location kind
      // (no extra call) — it drives the automatic battlemap's grid tier.
      kind === 'encounter'
        ? [
            'Field guidance for this encounter:',
            '- "locationKind": where the encounter takes place — "dungeon" (underground/ruin complex), "building" (indoor structure), "wilderness" (open terrain), or "other" when nothing fits.',
          ].join('\n')
        : null,
      // Prose-only redesign (two-button regeneration): the roster already on
      // file is final — redesign ONLY name/summary/body prose and copy every
      // roster entry's name and count verbatim. Renaming, adding or removing
      // a monster fails the run (the persist is scoped to name/prose/body).
      kind === 'encounter' && input.encounterProseOnly === true
        ? 'Prose-only redesign: redesign ONLY the name, summary and body prose — copy every roster entry (name and count) verbatim from the existing encounter. Renaming, adding or removing a monster fails the run.'
        : null,
      `Reply with ONLY a JSON object with exactly these fields: ${JSON.stringify(contract.keys)}`,
      extraInstruction === '' ? null : `Additional instruction: ${extraInstruction}`,
    ]
      .filter((part) => part !== null)
      .join('\n\n');
    debugLog(
      'run',
      `draft start: ${input.persona.model === '' ? 'default model' : input.persona.model}, ` +
        `prompt ${String(instruction.length)} chars`,
    );

    const messages: ChatMessage[] = [
      { role: 'system', content: input.persona.systemPrompt },
      { role: 'user', content: instruction },
    ];
    if (this.draftRetried.has(runId)) {
      messages.push({
        role: 'user',
        content:
          'Your previous reply was invalid JSON for the schema. Reply with corrected JSON only.',
      });
    }

    // The one contract-repair attempt escalates to the fallback model: a
    // violated reply contract is usually a capability weakness of the
    // first-try model, so the diagnosed repair goes to the more potent tier.
    const firstTryModel = resolveChatModel(settings, input.persona.model);
    const repairTarget =
      this.draftRetried.has(runId) || this.sourceRepaired.has(runId)
        ? repairModel(firstTryModel, settings)
        : firstTryModel;
    const { text: raw, fallback } = await chat(
      messages,
      this.chatForStep(runId, stepIndex, {
        model: repairTarget,
        temperature: input.persona.temperature,
        reasoningEffort: effectiveReasoningEffort(input.persona, settings),
        // Strict structured outputs (owner decision): every contract step
        // sends its zod schema token-enforced. The Settings strictOutputs
        // toggle downgrades this to json_object ONLY when the user flips it
        // — never automatically.
        responseFormat: schemaResponseFormat(contract.name, contract.schema),
        signal,
      }),
    );

    debugLog('run', `draft chat returned ${String(raw.length)} chars`);
    let parsed: unknown = null;
    let parseFailed = false;
    let issues: string[] = [];
    try {
      parsed = contract.schema.parse(parseJsonReply(raw));
    } catch (error) {
      issues = error instanceof ZodError ? formatZodIssues(error) : [parseErrorSummary(error)];
      debugLog('run', 'draft parse FAILED — retrying with schema-fix instruction', {
        issue: parseErrorSummary(error),
      });
      parseFailed = true;
      if (!this.draftRetried.has(runId)) {
        // One automatic JSON-fix retry (04 spec) that names every problem.
        debugLog('run', 'draft retrying once (automatic JSON fix)');
        this.draftRetried.add(runId);
        return this.runDraft(
          runId,
          stepIndex,
          steps,
          input,
          signal,
          `${extraInstruction === '' ? '' : `${extraInstruction}\n`}Your previous reply was invalid JSON for the schema:\n- ${issues.join('\n- ')}\nReply with corrected JSON only.`,
        );
      }
    }

    if (parseFailed) {
      // needs_review: raw text + the named issues stored, run pauses per autonomy.
      const step = this.finishStep(steps[stepIndex], { raw, issues }, 'rejected');
      if (input.autonomy === 'manual') return { step, runStatus: 'awaiting_user' };
      if (input.autonomy === 'auto') return { step };
      return { step, runStatus: 'needs_review' };
    }

    this.draftRetried.delete(runId);

    // M-B (12-BESTIARY-PACKS §7) + fix-02 (decisions 1–2): a monster
    // citation that resolves to nothing — and a monster with no stat source
    // at all — is a contract violation. One repair attempt naming every
    // offender, then the same loud rejected path as a schema failure. Never
    // a silent fall-through to name-only at finalize.
    if (kind === 'encounter') {
      const draftMonsters = (parsed as { monsters?: EncounterDraft['monsters'] }).monsters ?? [];
      const sourceIssues = encounterSourceIssues(
        draftMonsters,
        context.statblockChunkIds,
        context.rosterChunkByName,
      );
      if (sourceIssues.length > 0) {
        if (!this.sourceRepaired.has(runId)) {
          this.sourceRepaired.add(runId);
          const inlineRequired =
            context.statblockChunkIds.length === 0 && context.rosterLines.length === 0
              ? `\nNo stat-block excerpts and no bestiary roster are available, so every monster needs a complete inline "statBlock" object matching exactly this shape: ${statBlockSchemaHint(input.campaign.system)}. A partial stat block is rejected.`
              : `\nA complete inline "statBlock" object must match exactly this shape: ${statBlockSchemaHint(input.campaign.system)}.`;
          return this.runDraft(
            runId,
            stepIndex,
            steps,
            input,
            signal,
            `${extraInstruction === '' ? '' : `${extraInstruction}\n`}Your previous reply left monsters without a resolvable stat-block source:\n- ${sourceIssues.join('\n- ')}\nFor each offender ${context.rosterLines.length > 0 ? 'cite an exact name from the bestiary roster via "sourceName", ' : ''}a listed stat-block excerpt via "sourceChunkIndex", or provide a complete inline "statBlock".${inlineRequired} Reply with corrected JSON only.`,
          );
        }
        this.sourceRepaired.delete(runId);
        const rejected = this.finishStep(steps[stepIndex], { raw, issues: sourceIssues }, 'rejected');
        if (input.autonomy === 'manual') return { step: rejected, runStatus: 'awaiting_user' };
        if (input.autonomy === 'auto') return { step: rejected };
        return { step: rejected, runStatus: 'needs_review' };
      }
    }
    this.sourceRepaired.delete(runId);

    const step = this.finishStep(
      steps[stepIndex],
      withNotice(
        { parsed },
        fallback,
        [contractRepairNotice(firstTryModel, repairTarget), moduleGroundingNotice(context.moduleGrounding)]
          .filter((note): note is string => note !== null)
          .join(' ') || null,
      ),
    );
    if (pauses(input.autonomy, false)) return { step, runStatus: 'awaiting_user' };
    return { step };
  }

  private async runStatblock(
    runId: Id,
    stepIndex: number,
    steps: RunStep[],
    input: StartRunInput,
    signal: AbortSignal,
    extraInstruction: string,
  ): Promise<{ step: RunStep; runStatus?: PersonaRun['status'] }> {
    debugLog('run', 'statblock start');
    // M4-C: the draft decides whether this character needs stats at all —
    // generating a full stat block for a contact or merchant is wasted
    // effort. The step is marked skipped (visible in the run row).
    const draftDecision = this.effectiveDraft(steps);
    if (draftDecision?.needsStatBlock === false) {
      debugLog('run', 'statblock skipped: draft marked needsStatBlock=false');
      return {
        step: this.finishStep(
          steps[stepIndex],
          { skipped: 'the draft marked this character as not needing a stat block' },
          'skipped',
        ),
      };
    }
    const settings = await getSettings();
    const draft = this.effectiveDraft(steps);
    const levelHint = /level\s*(\d{1,2})/i.exec(input.brief)?.[1] ?? '';
    // Grounding comes from the retrieve step's stored selection — no
    // duplicate search/embedding pass (see contextFromRetrieveStep). The
    // stored campaign-grounding blocks are validated on read but NEVER
    // rendered here: statblock filling grounds in rules, not campaign lore
    // (15-GRAPH-RETRIEVAL §3.3).
    const context = await this.contextFromRetrieveStep(steps, input.campaign.id);
    const instruction = [
      `Fill the StatBlock for "${asString(draft?.name) || 'the NPC'}"${levelHint === '' ? '' : ` at level ${levelHint}`}, grounded in the rule excerpts.`,
      input.brief,
      context.excerpts === ''
        ? 'No rule excerpts available.'
        : `Rule excerpts:\n${context.excerpts}`,
      `Reply with ONLY a JSON object matching this COMPLETE schema: ${statBlockSchemaHint(input.campaign.system)}. Include every field; use empty strings or arrays only when a section truly does not apply.`,
      extraInstruction === '' ? null : `Additional instruction: ${extraInstruction}`,
    ]
      .filter((part) => part !== null)
      .join('\n\n');

    const firstTryModel = resolveChatModel(settings, input.persona.model);
    const repairTarget = this.statblockRetried.has(runId) ? repairModel(firstTryModel, settings) : firstTryModel;
    const { text: raw, fallback } = await chat(
      [
        { role: 'system', content: input.persona.systemPrompt },
        { role: 'user', content: instruction },
      ],
      // Repair escalation: see runDraft — same one-attempt policy.
      this.chatForStep(runId, stepIndex, {
        model: repairTarget,
        temperature: input.persona.temperature,
        reasoningEffort: effectiveReasoningEffort(input.persona, settings),
        responseFormat: schemaResponseFormat('statblock', statBlockSchema),
        signal,
      }),
    );

    let statBlock: StatBlock | null = null;
    let issues: string[] = [];
    try {
      const parsed = statBlockSchema.parse(parseJsonReply(raw));
      statBlock = parsed;
    } catch (error) {
      issues = error instanceof ZodError ? formatZodIssues(error) : [parseErrorSummary(error)];
      if (!this.statblockRetried.has(runId)) {
        // 04-LLM-PERSONAS: same one-time schema-repair retry as draft. This
        // was missing, so one malformed stat block discarded a valid NPC.
        debugLog('run', 'statblock parse FAILED — retrying once', { issue: parseErrorSummary(error) });
        this.statblockRetried.add(runId);
        return this.runStatblock(
          runId,
          stepIndex,
          steps,
          input,
          signal,
          `${extraInstruction === '' ? '' : `${extraInstruction}\n`}Your previous statblock reply was invalid JSON for the COMPLETE schema:\n- ${issues.join('\n- ')}\nReply with corrected JSON only and include every required field.`,
        );
      }
    }

    if (statBlock === null) {
      const step = this.finishStep(steps[stepIndex], { raw, issues }, 'rejected');
      if (input.autonomy === 'auto') return { step };
      if (input.autonomy === 'manual') return { step, runStatus: 'awaiting_user' };
      return { step, runStatus: 'needs_review' };
    }

    this.statblockRetried.delete(runId);
    const step = this.finishStep(
      steps[stepIndex],
      withNotice({ statBlock }, fallback, contractRepairNotice(firstTryModel, repairTarget)),
    );
    if (pauses(input.autonomy, false)) return { step, runStatus: 'awaiting_user' };
    return { step };
  }

  /**
   * Review step 1 (06-MILESTONES M2, Continuity Editor): digest the target
   * artifact and the rest of the campaign for the check step.
   */
  private async runGather(
    stepIndex: number,
    steps: RunStep[],
    input: StartRunInput,
  ): Promise<{ step: RunStep }> {
    const targetId = input.targetArtifactId;
    const [artifacts, settings, target] = await Promise.all([
      listArtifactsByCampaign(input.campaign.id),
      getSettings(),
      targetId === undefined ? undefined : getAnyArtifact(targetId),
    ]);
    const visibleGlobals = settings.artifactScopes.workspace.global
      ? await listGlobalArtifacts()
      : [];
    const others = [...artifacts, ...visibleGlobals]
      .filter((artifact) => artifact.id !== targetId)
      .map((artifact) => ({
        id: artifact.id,
        name: artifact.name,
        kind: artifact.kind,
        summary: artifact.summary,
        body: artifact.body.length > 600 ? `${artifact.body.slice(0, 600)}…` : artifact.body,
      }));
    const step = this.finishStep(steps[stepIndex], {
      target:
        target === undefined
          ? null
          : {
              id: target.id,
              name: target.name,
              kind: target.kind,
              summary: target.summary,
              body: target.body,
            },
      others,
    });
    return { step };
  }

  /**
   * Review step 2: the continuity check itself — compare the target against
   * the campaign digest, JSON report, same JSON-retry policy as draft.
   */
  private async runCheck(
    runId: Id,
    stepIndex: number,
    steps: RunStep[],
    input: StartRunInput,
    signal: AbortSignal,
    extraInstruction: string,
  ): Promise<{ step: RunStep; runStatus?: PersonaRun['status'] }> {
    const settings = await getSettings();
    const gatherStep = steps.find((step) => step.name === 'gather');
    const gather = (gatherStep?.userEdit ?? gatherStep?.output) as
      | {
          target?: { name?: string } | null;
          others?: { name?: string; kind?: string; summary?: string; body?: string }[];
        }
      | null
      | undefined;
    const target = gather?.target;
    const others = gather?.others ?? [];

    const instruction = [
      `Artifact under review: ${target?.name ?? 'unknown'}\n${JSON.stringify(target)}`,
      `Existing artifacts of the campaign:\n${others
        .map(
          (other) =>
            `- ${other.name ?? ''} (${other.kind ?? ''})${other.summary === undefined || other.summary === '' ? '' : ` — ${other.summary}`}\n${other.body ?? ''}`,
        )
        .join('\n')}`,
      input.brief === '' ? null : `Focus: ${input.brief}`,
      'Reply with ONLY a JSON object: { "verdict": "consistent" | "issues_found", "summary": string, "issues": [{ "severity": "minor" | "major", "message": string, "relatedTo": string }] } — "relatedTo" is the name of the conflicting artifact or "".',
      extraInstruction === '' ? null : `Additional instruction: ${extraInstruction}`,
    ]
      .filter((part) => part !== null)
      .join('\n\n');

    const { text: raw, fallback } = await chat(
      [
        { role: 'system', content: input.persona.systemPrompt },
        { role: 'user', content: instruction },
      ],
      this.chatForStep(runId, stepIndex, {
        model: resolveChatModel(settings, input.persona.model),
        temperature: input.persona.temperature,
        reasoningEffort: effectiveReasoningEffort(input.persona, settings),
        responseFormat: schemaResponseFormat('continuity-report', continuityReportSchema),
        signal,
      }),
    );

    let report: ContinuityReport | null = null;
    let issues: string[] = [];
    try {
      report = continuityReportSchema.parse(parseJsonReply(raw));
    } catch (error) {
      // The rejection reason reaches the review card — a bare "rejected"
      // left the user guessing what shape the model actually returned.
      issues = error instanceof ZodError ? formatZodIssues(error) : [parseErrorSummary(error)];
      debugLog('run', 'continuity report parse FAILED', { issue: parseErrorSummary(error) });
    }

    if (report === null) {
      const step = this.finishStep(steps[stepIndex], { raw, issues }, 'rejected');
      if (input.autonomy === 'auto') return { step };
      if (input.autonomy === 'manual') return { step, runStatus: 'awaiting_user' };
      return { step, runStatus: 'needs_review' };
    }
    const step = this.finishStep(steps[stepIndex], withNotice({ report }, fallback));
    if (pauses(input.autonomy, false)) return { step, runStatus: 'awaiting_user' };
    return { step };
  }

  /**
   * The effective prompt draft of an image run: the user's edit wins over the
   * deterministic draft; both are `{ parsed: {prompt, negative, styleNotes} }`.
   */
  private effectivePromptDraft(steps: readonly RunStep[]): ImagePromptDraft | null {
    const step = steps.find((candidate) => candidate.name === 'prompt-draft');
    if (step === undefined) return null;
    const effective = step.userEdit ?? step.output;
    if (effective === null || typeof effective !== 'object') return null;
    const parsed = (effective as { parsed?: unknown }).parsed;
    const result = imagePromptDraftSchema.safeParse(parsed);
    return result.success ? result.data : null;
  }

  /**
   * The budget loop's loud advisory from the brief step output (docs/11
   * D12) — '' when the brief shipped clean. Step outputs are plain JSON, so
   * the field is re-checked instead of trusted.
   */
  private encounterBudgetAdvisory(steps: readonly RunStep[]): string {
    const brief = steps.find((candidate) => candidate.name === 'brief')?.output as
      | { budgetAdvisory?: unknown }
      | undefined;
    const value = brief?.budgetAdvisory;
    return typeof value === 'string' ? value : '';
  }

  /**
   * The encounter pipeline shape (two-button regeneration, docs/11): the
   * explicit input flag wins; otherwise the brief step's stamped marker
   * decides (pause/resume continuations rebuild the input from the run row,
   * which carries no scope field). Anything else is the full pipeline.
   */
  private encounterIsRosterOnly(input: StartRunInput, steps: readonly RunStep[]): boolean {
    if (input.encounterScope === 'rosterOnly') return true;
    if (input.encounterScope === 'full') return false;
    return briefRosterOnlyMarker(steps);
  }

  /**
   * Whether this run maps the vision-located pipeline (docs/11 vision
   * path): the stamped brief marker wins once the brief ran (it reflects
   * the ACTUAL room count — a vision override on a single room still maps
   * classic); before the brief runs, an explicit vision override selects
   * the vision list optimistically (brief is step 0 in every list, and the
   * list re-resolves after the brief stamps its marker).
   */
  private encounterIsVisionMap(input: StartRunInput, steps: readonly RunStep[]): boolean {
    if (this.encounterIsRosterOnly(input, steps)) return false;
    const marker = briefVisionMapMarker(steps);
    if (marker !== undefined) return marker === 'vision';
    return input.dungeonMapPath === 'vision';
  }

  /**
   * The encounter pipeline shape: roster-only repopulation (brief→finalize)
   * beats vision mapping (brief→vision-map→finalize) beats the full
   * classic pipeline. The shape re-resolves after the brief step (see
   * executeFrom) because only the brief knows the room count.
   */
  private encounterPipelineKinds(input: StartRunInput, steps: readonly RunStep[]): StepName[] {
    if (this.encounterIsRosterOnly(input, steps)) return [...ENCOUNTER_ROSTER_ONLY_STEP_NAMES];
    if (this.encounterIsVisionMap(input, steps)) return [...ENCOUNTER_VISION_STEP_NAMES];
    return [...ENCOUNTER_STEP_NAMES];
  }

  private effectiveEncounterBrief(steps: readonly RunStep[]): {
    parsed: EncounterGeneratorBrief;
    aspect: EncounterMapAspect;
    preset: EncounterPreset;
    mapMode: EncounterMapMode;
    statblockChunkIds: Id[];
    rosterChunkByName: Record<string, Id>;
    /** The run's fill grade (docs/11 D12 amendment) — the value the brief
     * step drew or read off the target. Undefined on pre-arc runs; finalize
     * draws a fallback for a complex that materializes without one. */
    fillGrade: number | undefined;
  } {    const step = steps.find((candidate) => candidate.name === 'brief');
    const effective = step?.userEdit ?? step?.output;
    if (effective === null || effective === undefined || typeof effective !== 'object') {
      throw new Error('Encounter run has no approved brief');
    }
    const value = effective as {
      parsed?: unknown;
      aspect?: unknown;
      preset?: unknown;
      mapModeOverride?: unknown;
      mapLocationKind?: unknown;
      statblockChunkIds?: unknown;
      rosterChunkByName?: unknown;
      fillGrade?: unknown;
    };
    const parsed = encounterGeneratorBriefSchema.safeParse(value.parsed);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.length === 0 ? 'brief' : issue.path.join('.')}: ${issue.message}`)
        .join('; ');
      throw new Error(
        `Encounter brief step has no valid approved output (${issues}). Retry the brief, or edit it to valid JSON before continuing.`,
      );
    }
    return {
      parsed: parsed.data,
      aspect: value.aspect === '16:9' || value.aspect === '1:1' ? value.aspect : '4:3',
      // Runs from before the preset existed read back as 'standard' — the
      // exact geometry they generated (docs/11 D10 default).
      preset: value.preset === 'dungeon' ? 'dungeon' : 'standard',
      // Natural-site mode (docs/11): derived from the EFFECTIVE brief prose
      // (an owner-edited environment re-classifies the map) over the run
      // facts stamped at brief time (the target's owner override + persisted
      // locationKind). Pre-mode runs carry neither fact → the architectural
      // default, byte-identical to the pre-mode behavior.
      mapMode: resolveEncounterMapMode({
        override: value.mapModeOverride === 'architectural' || value.mapModeOverride === 'natural'
          ? value.mapModeOverride
          : undefined,
        briefEnvironment: parsed.data.environment,
        locationKind: value.mapLocationKind === 'dungeon' ||
            value.mapLocationKind === 'building' ||
            value.mapLocationKind === 'wilderness' ||
            value.mapLocationKind === 'other'
          ? value.mapLocationKind
          : undefined,
      }),
      statblockChunkIds: Array.isArray(value.statblockChunkIds)
        ? value.statblockChunkIds.filter((id): id is Id => typeof id === 'string')
        : [],
      rosterChunkByName: sanitizeChunkByName(value.rosterChunkByName),
      // Step outputs are plain JSON: the fill grade is re-checked instead of
      // trusted (an out-of-range/garbage value reads as absent, and finalize
      // draws a fallback — never a silent wrong number).
      fillGrade: typeof value.fillGrade === 'number' &&
          Number.isInteger(value.fillGrade) &&
          value.fillGrade >= 0 &&
          value.fillGrade <= 100
        ? value.fillGrade
        : undefined,
    };
  }

  private effectiveEncounterLayout(steps: readonly RunStep[]): EncounterLayout {
    // Vision runs store their layout on the vision-map step (docs/11 vision
    // path) — classic runs on the layout step. The zod boundary below
    // validates the vision branch (letters + observed points, no geometry)
    // exactly like the packed branch.
    const step = steps.find((candidate) => candidate.name === 'layout') ??
      steps.find((candidate) => candidate.name === 'vision-map');
    const effective = step?.userEdit ?? step?.output;
    if (effective === null || effective === undefined || typeof effective !== 'object') {
      throw new Error('Encounter run has no approved layout');
    }
    const value = effective as { layout?: unknown };
    const parsed = encounterLayoutSchema.safeParse(value.layout);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.length === 0 ? 'layout' : issue.path.join('.')}: ${issue.message}`)
        .join('; ');
      throw new Error(
        `Encounter layout step has no valid approved output (${issues}). Regenerate the layout, or edit it to valid JSON before continuing.`,
      );
    }
    return parsed.data;
  }

  private async runEncounterBrief(
    runId: Id,
    stepIndex: number,
    steps: RunStep[],
    input: StartRunInput,
    signal: AbortSignal,
    extraInstruction: string,
  ): Promise<{ step: RunStep; runStatus?: PersonaRun['status'] }> {
    const settings = await getSettings();
    const run = await getRun(runId);
    const aspect = run?.encounterMapAspect ?? input.encounterMapAspect ?? settings.encounterMapAspect;
    const target = input.targetArtifactId === undefined
      ? undefined
      : await getAnyArtifact(input.targetArtifactId);
    if (input.targetArtifactId !== undefined && target === undefined) {
      throw new Error('The encounter to regenerate no longer exists');
    }
    if (target !== undefined && target.kind !== 'encounter') {
      throw new Error(`"${target.name}" is not an encounter and cannot be regenerated`);
    }
    // D10 amendment — the preset resolution order: an explicit per-run
    // choice (the persisted run row; the panel's Auto writes null) beats the
    // regeneration target's own locationKind, which beats the Settings
    // fallback for unclassified encounters.
    const preset = resolveEncounterPreset(
      run?.encounterPreset ?? input.encounterPreset,
      target?.kind === 'encounter' ? target.data.locationKind : undefined,
      settings.encounterPreset,
    );
    const context = await loadContextArtifacts(input.contextArtifactIds ?? []);
    const retrieval = await this.retrieveContext(runId, input);
    const targetRoster = target?.kind === 'encounter' ? target.data.monsters : undefined;
    // Two-button regeneration (docs/11): the roster-only repopulation pass
    // REPLACES the roster — the old spawn was wrong, that is the point — so
    // it never pins the target's entries. An empty target roster (a fresh
    // Regenerate-everything reset, or a stub that never had content) is a
    // fresh population, not an error: appending to nothing means designing
    // the whole population. The pin exists only for legacy verbatim map
    // regenerations with a roster on file.
    const rosterOnly = this.encounterIsRosterOnly(input, steps);
    const rosterPin =
      rosterOnly || targetRoster === undefined || targetRoster.length === 0 ? undefined : targetRoster;
    const existingRooms =
      target?.kind === 'encounter' && target.data.layout !== null ? target.data.layout.rooms : undefined;
    // Roster sources are only checked for fresh encounters: a regenerate run
    // replaces the roster with the target's verbatim entries below.
    // Asymmetric per-room budget loop (docs/11 D12): the lookups the level
    // resolution needs — every chunk the brief could cite (stat-block pool +
    // roster name index) plus, for regenerate runs, the target's own roster
    // sources. pf2e runs replace the numeric check with the loud verbatim
    // advisory (no Paizo numbers ship — roomBudget.ts).
    const budgetMode = roomBudgetMode(input.campaign.system);
    // Shape-gated restock (docs/11 D12 amendment, owner-directed): the
    // stocking/expansion contract keys on the TARGET'S ACTUAL SHAPE —
    // `encounterDataIsComplex`, the parse-normalized D11 derivation — not on
    // the remembered preset. The battlemap "Regenerate" action passes the
    // artifact's OWN persisted `data.preset` as the explicit per-run choice
    // (persona-panel), so a legacy complex row whose remembered preset is
    // 'standard' used to brief a one-arena map with NO stocking clauses at
    // all; the shape now carries the contract. A genuine single arena on a
    // dungeon preset keeps today's prompt byte-identical (the preset's D10
    // bias still applies — the clause gate below is an OR, never a switch).
    // pf2e has no cap to bound an append (Paizo numbers never ship), so the
    // machinery stays band-only and the verbatim pin holds. ONE flag drives
    // BOTH the prompt clauses and the evaluate gate — they cannot drift
    // apart again.
    const targetIsComplex = target?.kind === 'encounter' && encounterDataIsComplex(target.data);
    // The stocking contract authorizes whenever the shape calls for a complex
    // (dungeon preset OR a complex-shaped target) on a band system — the pin
    // decides only HOW it binds: a pinned roster expands (verbatim prefix →
    // source-cited appends → cap), an unpinned one is designed whole under
    // the same numbers and cap.
    const stockingAuthorized =
      (preset === 'dungeon' || targetIsComplex) && budgetMode === 'band';
    const expansionAuthorized = rosterPin !== undefined && stockingAuthorized;
    // The directive tier: a complex-shaped target is TOLD to append (the
    // permissive 'may' let an under-appending model ship the old roster plus
    // a loud advisory — a stocking contract, not a permission).
    const directiveAppend = expansionAuthorized && targetIsComplex;
    // Fill grade (docs/11 D12 amendment, draw-once): a value on the target
    // row (owner-set or a previous draw) ALWAYS wins; a fresh run or a
    // legacy target without one draws a candidate here so the brief prompt
    // can carry concrete per-room numbers and the complex expansion cap.
    // The draw PERSISTS only when a complex layout materializes with the
    // field absent (finalize); a single-arena outcome discards it.
    const targetFillGrade = target?.kind === 'encounter' ? target.data.fillGrade : undefined;
    const fillGrade = targetFillGrade ?? drawFillGrade();
    // Structured level context (docs/11): the party level is the
    // referencing part's EXACT level — the first part whose markdown carries
    // the target's [[Name]] mention supplies its levelBand (ONE shared pure
    // helper, `partLevelForMention` — no second implementation). No mention
    // in the module text (or no owning module) keeps today's behavior
    // byte-identical: the structured line stays absent and the free-text
    // chain below drives.
    const partLevel = await (async (): Promise<number | undefined> => {
      if (target?.kind !== 'encounter' || target.moduleId === null) return undefined;
      const owner = await getModule(target.moduleId);
      if (owner === undefined) return undefined;
      return partLevelForMention(owner, target.name);
    })();
    // The level the rooms' targetLevels will default to (stampTargetLevels):
    // the structured part level first, then the target's own hint on a
    // regenerate, the run brief's text for a fresh encounter. Without a
    // digit there is no honest number to render.
    const promptLevel = partLevel
      ?? (target?.kind === 'encounter'
        ? parseRosterTargetLevel(target.data.levelHint)
        : parseRosterTargetLevel(input.brief));
    // Per-room stocking numbers (docs/11 D12 amendment): the fill-grade
    // share as concrete creature-levels at the level the rooms default to.
    // Null for pf2e (no Paizo numbers) or a digit-free level — the
    // qualitative clause still applies, never an invented number. Rendered
    // ABOVE the roster contract, which the append clauses cite.
    const stockingNumbers = fillGradeStockingFor(fillGrade, promptLevel, input.campaign.system);
    // Regenerate mode keeps the roster verbatim INCLUDING mob treasure: a
    // map run replaces layout + room keys, never the encounter-scoped
    // treasure authored on the entries (owner-ratified D1 extension).
    // AMENDED (docs/11 D12, fill-grade arc): a multi-room COMPLEX may
    // EXPAND the pinned roster — the target's entries stay the first N
    // (verbatim, sources preserved) and appended entries stock the rooms
    // the pin would have left empty; bounded by the rooms' expected shares
    // (budget-checked in evaluate). A single arena keeps the exact pin.
    // AMENDED AGAIN (shape-gated restock): the append clause renders when
    // the stocking contract is authorized at all (dungeon preset OR a
    // complex-shaped target, band systems) and is a DIRECTIVE for a
    // complex-shaped target — same three-part structure (verbatim prefix →
    // source-cited appends → cap), but the model must reach one fight per
    // room, not merely may.
    const appendClauseMay =
      'If you design a multi-room complex, you MAY append more entries after those to stock the complex — every room needs a real fight, so size the roster for one fight per room. Every appended entry must cite a source (sourceChunkIndex, sourceName or a complete inline statBlock). The whole complex must total at most (number of rooms × the per-room expected creature-levels above) + ' +
      `${String(ROOM_BUDGET_OVER_MARGIN)} creature-levels.`;
    const appendClauseDirective =
      'This encounter is an existing multi-room complex — you MUST append more entries after those to stock it: every room needs a real fight, so the roster must reach one fight per room' +
      (stockingNumbers === null ? '' : ' (reach the per-room stocking numbers above)') +
      '. Every appended entry must cite a source (sourceChunkIndex, sourceName or a complete inline statBlock). The whole complex must total at most (number of rooms × the per-room expected creature-levels above) + ' +
      `${String(ROOM_BUDGET_OVER_MARGIN)} creature-levels.`;
    // Fresh-population instruction (two-button regeneration, docs/11): no pin
    // exists — an empty roster after a Regenerate-everything reset, or a
    // roster-only repopulation whose old spawn was wrong — so the reply
    // designs the WHOLE population under the same numbers and cap. A
    // repopulation mirrors the dungeon's existing rooms (named below, in
    // order, with their targetLevels) instead of inventing new ones.
    const existingRoomList =
      existingRooms === undefined || existingRooms.length === 0
        ? null
        : existingRooms
            .map((room, index) => {
              const level = room.targetLevel === undefined ? '' : ` (targetLevel ${String(room.targetLevel)})`;
              return `${String(index + 1)}. ${room.name}${level}`;
            })
            .join('; ');
    const freshComplexClause =
      rosterOnly && existingRoomList !== null
        ? `This dungeon keeps its ${String(existingRooms?.length ?? 0)} rooms — design a NEW roster stocking every one of them: one fight per room (${existingRoomList}); reply rooms must mirror these rooms in order (same names, same targetLevels). Every entry must cite a source (sourceChunkIndex, sourceName or a complete inline statBlock). The whole complex must total at most (number of rooms × the per-room expected creature-levels above) + ${String(ROOM_BUDGET_OVER_MARGIN)} creature-levels.`
        : 'Design a complete new roster for the whole encounter — a complex needs one fight per room (reach the per-room stocking numbers above). Every entry must cite a source (sourceChunkIndex, sourceName or a complete inline statBlock). The whole complex must total at most (number of rooms × the per-room expected creature-levels above) + ' +
          `${String(ROOM_BUDGET_OVER_MARGIN)} creature-levels.`;
    const rosterContract = rosterPin !== undefined
      ? [
          `Regeneration target roster — keep these EXACT entries as the first ${String(rosterPin.length)} entries of your reply, same order, same names, counts and treasure (name/count/notes/treasure; emit null for sourceChunkIndex, sourceName and statBlock — the existing encounter's stat sources are preserved automatically): ${JSON.stringify(
            rosterPin.map((monster) => ({
              name: monster.name,
              count: monster.count,
              notes: monster.notes,
              treasure: monster.treasure,
            })),
          )}`,
          ...(expansionAuthorized ? [directiveAppend ? appendClauseDirective : appendClauseMay] : []),
        ].join('\n')
      : stockingAuthorized
        ? freshComplexClause
        : 'Design a concrete monster roster appropriate to the requested difficulty.';
    const monsterFieldSpec = rosterPin === undefined
      ? stockingAuthorized
        ? 'monsters [{name,count,notes,treasure,sourceChunkIndex? or sourceName? or statBlock?}] (a new roster stocking the whole complex — one fight per room)'
        : 'monsters [{name,count,notes,treasure,sourceChunkIndex? or sourceName? or statBlock?}]'
      : directiveAppend
        ? 'monsters [{name,count,notes,treasure,sourceChunkIndex? or sourceName? or statBlock?}] (the target roster first, verbatim; appended entries stock the complex — the roster must grow to one fight per room)'
        : expansionAuthorized
          ? 'monsters [{name,count,notes,treasure,sourceChunkIndex? or sourceName? or statBlock?}] (the target roster first, verbatim; optional appended entries stock a complex)'
          : 'monsters [{name,count,notes,treasure}] (the target roster copied verbatim)';
    const inlineStatHint = rosterPin === undefined && retrieval.statblockChunkIds.length === 0
      ? `No stat-block excerpts are available, so every monster needs a complete inline "statBlock" object matching exactly this shape: ${statBlockSchemaHint(input.campaign.system)}. A partial stat block is rejected.`
      : null;
    // 15-GRAPH-RETRIEVAL (D2 = general grounding only): the encounter brief
    // renders the derived campaign-grounding section after the brief line;
    // the citable stat-block search and the pack roster above stay
    // byte-identical (the frozen fix-02 contract). The toggle is read ONCE,
    // at compute time (campaignGroundingFor) — persisted blocks render even
    // if flipped OFF mid-run. Empty blocks render no section at all.
    const groundingSection =
      retrieval.expansionExcerpts.length > 0
        ? renderCampaignGroundingSection(retrieval.expansionExcerpts)
        : null;
    // Site-shape branch (docs/11 D11): the brief must commit to ONE arena
    // (exactly 1 room, no corridors) or a real dungeon complex (4–10
    // rooms) — 2–3-room briefs are repair-rejected at this boundary. The
    // Dungeon preset clause extends the D10 bias with the per-room
    // challenge contract, and the roster sizing seam (fill-grade arc):
    // a complex of N rooms needs roughly one fight per room. AMENDED
    // (shape-gated restock): the complex shape contract also renders for a
    // COMPLEX-SHAPED target on the standard preset (the remembered preset
    // keeps naming the tier — the shape names the rooms), while a genuine
    // single arena on the dungeon preset keeps the shipped bytes exactly.
    const complexShapeProse =
      'design a connected dungeon complex of 4–10 rooms (never 2–3): distinct chambers joined by corridors, with the entry room as the party\'s way in, and EACH ROOM must alone challenge the party (its own targetLevel). A complex of N rooms needs roughly one fight per room — size the roster for N fights, and every room stocks a real fight (a complex room with no creatures is a repairable defect).';
    const presetShapeClause = preset === 'dungeon'
      ? `Preset: Dungeon — ${complexShapeProse}`
      : targetIsComplex
        ? `Preset: Standard — this encounter is an existing multi-room complex, so ${complexShapeProse}`
        : 'Preset: Standard — design ONE battle arena: exactly one room, no corridors between rooms, with the entry room as the party\'s way in.';
    const contract = [
      input.brief,
      groundingSection,
      `Campaign: ${input.campaign.name} (${GAME_SYSTEM_LABELS[input.campaign.system]})`,
      partLevel === undefined ? null : partyLevelLine(partLevel),
      `Map aspect: ${aspect}`,
      presetShapeClause,
      stockingNumbers,
      // Natural-site mode (docs/11): the brief's `environment` classifies the
      // map contract — one honest line (the field was listed but never
      // explained); when it says outdoor, the map is prose-led natural-site.
      'Environment: set "environment" honestly from the site\'s own nature — "outdoor" when the encounter plays in the open (forest, swamp, coast, road, cavern mouth), "dungeon" only when it plays inside an enclosed built complex of halls and corridors.',
      rosterContract,
      context.length === 0 ? null : `Context: ${JSON.stringify(context)}`,
      retrieval.excerpts === '' ? null : `Retrieved rules:\n${retrieval.excerpts}`,
      buildStatblockCitationSection(retrieval.statblockTitles),
      formatRosterSection(retrieval.rosterLines, retrieval.rosterTruncated),
      // §13: the item pool grounds the treasure field here too.
      formatItemPoolSection(retrieval.itemLines, retrieval.itemTruncated),
      extraInstruction === '' ? null : `Additional instruction: ${extraInstruction}`,
      inlineStatHint,
      // Owner-ratified room keys + mob treasure: structure + per-system
      // budget (treasureGuidanceFor coheres with the item-pool section above)
      // and the room-key field contract (Cartographer only — the brief owns
      // the rooms).
      roomKeyGuidanceFor(),
      treasureGuidanceFor(input.campaign.system),
      // Asymmetric per-room budget loop (docs/11 D12): the targetLevel
      // contract + the documented per-system band.
      roomBudgetGuidanceFor(input.campaign.system),
      `Reply with JSON only using every field: name, summary, body, difficulty, levelHint, terrain, tactics, treasure, theme, styleNotes, negative, environment ("dungeon" | "outdoor"), ${monsterFieldSpec}, rooms [{name,description,size:"small"|"medium"|"large",monsterIndexes:number[],adjacentRoomIndexes:number[],key:string,keyTreasure:string,targetLevel?:number}] (a single arena = exactly 1 room; a dungeon complex = 4–10 rooms), entryRoomIndex. Every monster index belongs to exactly one room. Rooms form one connected graph. Do not emit coordinates.`,
    ].filter((part) => part !== null).join('\n\n');
    const messages: ChatMessage[] = [
      { role: 'system', content: input.persona.systemPrompt },
      { role: 'user', content: contract },
    ];
    const chatOptions = {
      model: resolveChatModel(settings, input.persona.model),
      temperature: input.persona.temperature,
      reasoningEffort: effectiveReasoningEffort(input.persona, settings),
      responseFormat: schemaResponseFormat('encounter-brief', encounterGeneratorBriefSchema),
      signal,
      onToken: (delta: string) => {
        this.emit({ kind: 'token', runId, stepIndex, delta });
      },
      onReasoning: (delta: string) => {
        this.emit({ kind: 'thinking', runId, stepIndex, delta });
      },
      onReset: () => {
        this.emit({ kind: 'reset', runId, stepIndex });
      },
    };
    // Roster sources are only checked for fresh encounters: a regenerate run
    // replaces the roster with the target's verbatim entries below.
    // Asymmetric per-room budget loop (docs/11 D12): the lookups the level
    // resolution needs — every chunk the brief could cite (stat-block pool +
    // roster name index) plus, for regenerate runs, the target's own roster
    // sources. pf2e runs replace the numeric check with the loud verbatim
    // advisory (no Paizo numbers ship — roomBudget.ts). The budget mode is
    // resolved above (the roster contract and stocking numbers branch on it).
    const budgetChunkIds = [
      ...new Set([...retrieval.statblockChunkIds, ...Object.values(retrieval.rosterChunkByName)]),
    ];
    const budgetChunks = budgetChunkIds.length === 0 ? [] : await getChunksByIds(budgetChunkIds);
    const chunkById = new Map(budgetChunks.map((chunk) => [chunk.id, chunk]));
    /** Stamps the encounter's parsed levelHint onto rooms with no target. */
    const stampTargetLevels = (brief: EncounterGeneratorBrief): EncounterGeneratorBrief => {
      const hintLevel = parseRosterTargetLevel(brief.levelHint);
      return {
        ...brief,
        rooms: brief.rooms.map((room) => ({
          ...room,
          ...(room.targetLevel === undefined && hintLevel !== undefined
            ? { targetLevel: hintLevel }
            : {}),
        })),
      };
    };
    /**
     * Budget verdicts for a stamped brief. Fresh runs resolve each monster's
     * level through its citation/inline source; regenerate runs resolve the
     * PINNED prefix through the TARGET roster's persisted sources (the
     * prefix carries no sources of its own — they are stripped) and any
     * EXPANDED entry through its own citation/inline source. The rooms are
     * judged as a complex whenever the brief carries more than one: the
     * fill-grade lower verdicts ('empty'/'under') apply to complex rooms
     * only (docs/11 D12 amendment).
     */
    const budgetVerdicts = async (
      brief: EncounterGeneratorBrief,
    ): Promise<ReturnType<typeof checkRoomBudget>[]> => {
      const briefLevels = resolveBriefMonsterLevels(brief.monsters, {
        chunkById,
        rosterChunkByName: retrieval.rosterChunkByName,
        statblockChunkIds: retrieval.statblockChunkIds,
      });
      const entryLevels =
        rosterPin === undefined
          ? undefined
          : await resolveEntryLevels(rosterPin, {
              chunkById,
              getArtifactStatBlock: async (artifactId) => {
                const artifact = await getAnyArtifact(artifactId);
                if (artifact?.kind !== 'npc') return null;
                return artifact.data.statBlock;
              },
            });
      const levelFor = (monsterIndex: number): string | undefined => {
        if (rosterPin !== undefined && monsterIndex < rosterPin.length) {
          return entryLevels?.[monsterIndex];
        }
        return briefLevels[monsterIndex];
      };
      const isComplex = brief.rooms.length > 1;
      const creatures = brief.rooms.map((room) =>
        room.monsterIndexes.map((monsterIndex) => {
          const monster = brief.monsters[monsterIndex];
          return {
            name: monster?.name ?? `roster entry ${String(monsterIndex)}`,
            count: monster?.count ?? 0,
            level: levelFor(monsterIndex),
          };
        }),
      );
      return brief.rooms.map((room, roomIndex) =>
        checkRoomBudget({
          roomIndex,
          roomName: room.name,
          targetLevel: room.targetLevel,
          creatures: creatures[roomIndex] ?? [],
          fillGrade,
          complex: isComplex,
          system: input.campaign.system,
        }),
      );
    };
    /** Creature-level label matching the budget loop's advisory style. */
    const formatLevels = (sum: number): string =>
      Number.isInteger(sum) ? String(sum) : sum.toFixed(1);
    /**
     * Shape + budget evaluation. `final` marks the post-repair pass: the
     * bounded retry has been spent, so an over-budget room ships with its
     * target lowered one step (floor 1) and the LOUD advisory instead of
     * re-triggering repair — never a failed run. `expansionActive` marks a
     * regenerate reply that kept the pinned prefix AND appended entries (a
     * complex's bounded expansion) — its merged roster is what finalize
     * persists.
     */
    const evaluate = async (
      reply: string,
      final: boolean,
    ): Promise<{
      brief: EncounterGeneratorBrief | null;
      issues: string[];
      advisory: string | null;
      expansionActive: boolean;
    }> => {
      const result = parseEncounterBrief(
        reply,
        rosterPin === undefined ? {} : { stripStatFieldCount: rosterPin.length },
      );
      if (result.brief === null) return { ...result, advisory: null, expansionActive: false };
      const brief = result.brief;
      const isComplex = brief.rooms.length > 1;
      // Bounded roster expansion (docs/11 D12 amendment, shape-gated): the
      // gate reads the SAME authorization the prompt rendered — a COMPLEX
      // brief (this reply's shape) on a numeric-band system, when the
      // stocking contract was authorized at all (dungeon preset or a
      // complex-shaped target). A reply that grows rooms on an unauthorized
      // run keeps the exact verbatim pin (the repair below says so) — never
      // a source contract the prompt never stated. pf2e (no numbers → no
      // cap to compute) and single arenas keep the exact verbatim pin.
      // AMENDED (two-button regeneration): an UNPINNED complex reply on a
      // stocked target (a fresh Regenerate-everything population or a
      // roster-only repopulation) is capped the same way — the cap binds the
      // shape, not the pin.
      const expansion = expansionAuthorized && isComplex;
      const freshCapped = rosterPin === undefined && target !== undefined && isComplex && stockingAuthorized;
      // Site-shape dichotomy (docs/11 D11): 1 room (single arena) or 4–10
      // rooms (complex). 2–3 rooms are a repairable issue — the prompt
      // states the exact shape contract. AMENDED (two-button regeneration):
      // a repopulation mirrors the dungeon's EXISTING rooms instead, so a
      // grandfathered 2–3-room complex repopulates in place — the count must
      // match the rooms on file exactly.
      const mirrorCount = rosterOnly ? existingRooms?.length : undefined;
      if (mirrorCount !== undefined && mirrorCount > 0) {
        if (brief.rooms.length !== mirrorCount) {
          return {
            brief: null,
            advisory: null,
            expansionActive: false,
            issues: [
              `rooms: this repopulation keeps the dungeon's ${String(mirrorCount)} rooms — mirror them in order with the same names (your reply listed ${String(brief.rooms.length)} rooms)`,
            ],
          };
        }
      } else if (brief.rooms.length !== 1 && brief.rooms.length < 4) {
        return {
          brief: null,
          advisory: null,
          expansionActive: false,
          issues: [
            `rooms: an encounter is either a single arena (exactly 1 room) or a dungeon complex (4–10 rooms) — your reply listed ${String(brief.rooms.length)} rooms`,
          ],
        };
      }
      const pinLength = rosterPin?.length ?? 0;
      if (rosterPin !== undefined) {
        if (expansion) {
          if (brief.monsters.length < pinLength) {
            return {
              brief: null,
              advisory: null,
              expansionActive: false,
              issues: [
                `monsters: keep the target roster's ${String(pinLength)} entries as the FIRST entries of your reply, same order (your reply listed ${String(brief.monsters.length)})`,
              ],
            };
          }
        } else if (brief.monsters.length !== pinLength) {
          return {
            brief: null,
            advisory: null,
            expansionActive: false,
            issues: [
              `monsters: the target roster has exactly ${String(pinLength)} entries — copy it verbatim in the same order (your reply listed ${String(brief.monsters.length)})`,
            ],
          };
        }
      } else {
        const sourceIssues = encounterSourceIssues(
          brief.monsters,
          retrieval.statblockChunkIds,
          retrieval.rosterChunkByName,
        );
        if (sourceIssues.length > 0) {
          return { brief: null, issues: sourceIssues, advisory: null, expansionActive: false };
        }
      }
      // The target's own values win over any model drift on the pinned
      // prefix (as before); an expanded entry keeps the model's values — its
      // citations are what finalize resolves and persists.
      const corrected: EncounterGeneratorBrief = expansion
          ? {
              ...brief,
              monsters: brief.monsters.map((monster, index) => {
                const pinned = index < pinLength ? rosterPin[index] : undefined;
                return pinned === undefined
                  ? monster
                  : {
                      name: pinned.name,
                      count: pinned.count,
                      notes: pinned.notes,
                      treasure: pinned.treasure,
                    };
              }),
            }
          : brief;
      if (expansion) {
        const expandedEntries = corrected.monsters.slice(pinLength);
        const sourceIssues = encounterSourceIssues(
          expandedEntries,
          retrieval.statblockChunkIds,
          retrieval.rosterChunkByName,
        );
        if (sourceIssues.length > 0) {
          return { brief: null, issues: sourceIssues, advisory: null, expansionActive: false };
        }
      }
      const coverage = encounterCoverageIssues(corrected, corrected.monsters.length);
      if (coverage.length > 0) {
        return { brief: null, issues: coverage, advisory: null, expansionActive: false };
      }
      const stamped = stampTargetLevels(corrected);
      if (budgetMode === 'verbatim') {
        // pf2e: no numeric budget ships (Paizo licensing) — the advisory is
        // the deterministic, always-loud replacement.
        return { brief: stamped, issues: [], advisory: PF2E_BUDGET_ADVISORY, expansionActive: false };
      }
      const verdicts = await budgetVerdicts(stamped);
      if (expansion || freshCapped) {
        // The stocking cap (docs/11 D12 amendment): the whole complex may
        // carry at most the SUM of its rooms' expected shares plus the
        // band's documented headroom — an oversized roster is a repairable
        // issue, never a silent accept. Binds pinned expansions and unpinned
        // fresh populations alike.
        const expectedTotal = stamped.rooms.reduce((total, room) => {
          if (room.targetLevel === undefined) return total;
          const expectation = expectedRoomThreat(fillGrade, room.targetLevel, input.campaign.system);
          return total + (expectation?.expectedLevels ?? 0);
        }, 0);
        const cap = expectedTotal + ROOM_BUDGET_OVER_MARGIN;
        const shipped = verdicts.reduce((total, verdict) => total + verdict.sumLevels, 0);
        if (shipped > cap) {
          return {
            brief: null,
            advisory: null,
            expansionActive: false,
            issues: [
              `monsters: the ${expansion ? 'expanded ' : ''}roster sums to ${formatLevels(shipped)} creature-levels — over the complex's stocking cap of ${formatLevels(cap)} (the rooms' expected shares + ${String(ROOM_BUDGET_OVER_MARGIN)}). Trim the roster so every room fits its band.`,
            ],
          };
        }
      }
      // The lower verdicts (fill-grade arc): 'empty' is repairable on fresh
      // complex briefs (the inverted asymmetry — complexes must stock every
      // room), 'under' is advisory-only; single arenas keep the original
      // asymmetric call (no lower verdicts exist for them).
      const unverified = verdicts.filter((verdict) => verdict.status === 'unverified');
      const under = verdicts.filter((verdict) => verdict.status === 'under');
      const repairable = verdicts.filter(
        (verdict) => verdict.status === 'over' || verdict.status === 'empty',
      );
      if (repairable.length === 0) {
        const advisories = [...unverified, ...under]
          .map((verdict) => verdict.advisory)
          .filter((advisory): advisory is string => advisory !== null);
        return {
          brief: stamped,
          issues: [],
          advisory: advisories.length === 0 ? null : advisories.join(' '),
          expansionActive: expansion,
        };
      }
      if (!final) {
        return {
          brief: null,
          advisory: null,
          expansionActive: false,
          issues: repairable.map((verdict) => verdict.issue ?? '').filter((issue) => issue !== ''),
        };
      }
      // Final pass: lower each over-budget room a step (floor 1) — the
      // documented loop's deterministic tail — and ship the loud advisory
      // (over, empty and under rooms alike).
      const loweredTargets = new Map<number, number>(
        repairable.flatMap((verdict) =>
          verdict.loweredTargetLevel === null
            ? []
            : [[verdict.roomIndex, verdict.loweredTargetLevel]],
        ),
      );
      const finalBrief: EncounterGeneratorBrief = {
        ...stamped,
        rooms: stamped.rooms.map((room, roomIndex) => {
          const lowered = loweredTargets.get(roomIndex);
          return lowered === undefined ? room : { ...room, targetLevel: lowered };
        }),
      };
      const loweredVerdicts = await budgetVerdicts(finalBrief);
      const advisories = loweredVerdicts
        .filter((verdict) => verdict.status !== 'ok')
        .map((verdict) => verdict.advisory ?? '')
        .filter((advisory) => advisory !== '');
      return {
        brief: finalBrief,
        issues: [],
        advisory: advisories.length === 0 ? null : advisories.join(' '),
        expansionActive: expansion,
      };
    };
    const first = await chat(messages, chatOptions);
    let raw = first.text;
    let fallback = first.fallback;
    // The contract-repair model: the escalation tier when configured (the
    // step notice records the escalation only when it actually differed).
    let briefRepairTarget = chatOptions.model;
    let evaluated = await evaluate(raw, false);
    if (evaluated.brief === null) {
      // One repair turn that names every problem — a bare "the schema failed"
      // made the model repeat the same mistake three runs in a row.
      const statHintForRepair = rosterPin === undefined && evaluated.issues.some((issue) => issue.includes('statBlock'))
        ? `\nA complete inline "statBlock" object must match exactly this shape: ${statBlockSchemaHint(input.campaign.system)}.`
        : '';
      // Contract repair escalates to the fallback model (see runDraft).
      briefRepairTarget = repairModel(chatOptions.model, settings);
      const retry = await chat(
        [
          ...messages,
          { role: 'assistant', content: raw },
          {
            role: 'user',
            content: `Your reply failed the encounter-brief contract:\n- ${evaluated.issues.join('\n- ')}\nReturn the corrected JSON object only, with every field present and valid room/roster indexes.${statHintForRepair}`,
          },
        ],
        { ...chatOptions, model: briefRepairTarget },
      );
      raw = retry.text;
      fallback = retry.fallback ?? fallback;
      evaluated = await evaluate(raw, true);
    }
    if (evaluated.brief === null) {
      const step = this.finishStep(steps[stepIndex], { raw, issues: evaluated.issues }, 'rejected');
      // Same rejection mapping as every other step: manual waits for the
      // user (awaiting_user), review parks the run for triage, auto lets
      // executeFrom fail the run.
      if (input.autonomy === 'manual') return { step, runStatus: 'awaiting_user' };
      if (input.autonomy === 'auto') return { step };
      return { step, runStatus: 'needs_review' };
    }
    let parsed: EncounterGeneratorBrief = evaluated.brief;
    if (rosterPin !== undefined && !evaluated.expansionActive) {
      // Regenerate mode (verbatim pin) replaces the roster with the target's
      // verbatim entries — mob treasure included (the brief was told to copy
      // it verbatim; the target's own values win over any model drift). An
      // EXPANDED complex roster keeps the merged entries: the corrected
      // prefix already carries the target's verbatim values (evaluate), and
      // the appended entries are what finalize resolves and persists.
      // Unpinned replies (fresh creates, fresh re-populations, roster-only
      // repopulations) keep the model's roster as evaluated.
      parsed = {
        ...parsed,
        monsters: rosterPin.map((monster) => ({
          name: monster.name,
          count: monster.count,
          notes: monster.notes,
          treasure: monster.treasure,
        })),
      };
    }
    // The budget loop's advisory (docs/11 D12): persisted on the step output
    // (finalize copies it onto the artifact) and surfaced on the notice.
    const budgetAdvisory = evaluated.advisory;
    // Natural-site mode (docs/11): the target's map facts stamp with the
    // brief — the OWNER override and the persisted locationKind are
    // run-row facts, while the mode itself re-derives at every consumption
    // from the EFFECTIVE brief prose (`effectiveEncounterBrief`), so an
    // owner-edited brief re-classifies the map with it. Null = fresh run
    // (derive from the brief's `environment` alone).
    const mapModeOverride = target?.kind === 'encounter' ? (target.data.mapMode ?? null) : null;
    const mapLocationKind = target?.kind === 'encounter' ? target.data.locationKind : null;
    // The dungeon-map path marker (docs/11 vision path): stamped from the
    // brief's ACTUAL room count + the per-run choice/Settings default, so
    // the pipeline shape (and every continuation) follows the rooms on
    // file — singles always stamp classic, repopulation never reads it.
    const mapPath = rosterOnly
      ? ('classic' as const)
      : resolveBriefMapPath(
        parsed.rooms.length,
        run?.dungeonMapPath ?? input.dungeonMapPath,
        settings.dungeonMapPath,
      );
    return {
      step: this.finishStep(
        steps[stepIndex],
        withNotice(
          {
            parsed,
            aspect,
            preset,
            mapModeOverride,
            mapLocationKind,
            mapPath,
            statblockChunkIds: retrieval.statblockChunkIds,
            rosterChunkByName: retrieval.rosterChunkByName,
            // The run's fill grade (docs/11 D12 amendment): the value the
            // brief was written against — finalize stamps it when a complex
            // materializes with the field absent (draw-once).
            fillGrade,
            // The pipeline shape (two-button regeneration): continuations
            // that rebuild the input from the run row read this back —
            // without it a repopulation would resume as a full map run.
            ...(rosterOnly ? { rosterOnly: true as const } : {}),
            ...(budgetAdvisory === null ? {} : { budgetAdvisory }),
          },
          fallback,
          [
            contractRepairNotice(chatOptions.model, briefRepairTarget),
            budgetAdvisory,
          ].filter((part): part is string => part !== null).join(' ') || null,
        ),
      ),
      ...(input.autonomy === 'auto' ? {} : { runStatus: 'awaiting_user' as const }),
    };
  }

  private runEncounterLayout(
    runId: Id,
    stepIndex: number,
    steps: RunStep[],
    _input: StartRunInput,
  ): { step: RunStep; runStatus?: PersonaRun['status'] } {
    const { parsed, aspect, preset } = this.effectiveEncounterBrief(steps);
    const roomIds = parsed.rooms.map(() => newId());
    const entryRoomId = roomIds[parsed.entryRoomIndex];
    if (entryRoomId === undefined) throw new Error('Encounter brief has no valid entry room');
    const layout = packRooms({
      theme: parsed.theme,
      aspect,
      // The preset chooses the grid tier (dungeon = the fixed ×2 tier,
      // docs/11 D10) — geometry itself stays deterministic packer output.
      preset,
      entryRoomId,
      rosterCounts: parsed.monsters.map((monster) => monster.count),
      rooms: parsed.rooms.map((room, index) => {
        const id = roomIds[index];
        if (id === undefined) throw new Error(`Encounter room ${String(index)} has no id`);
        return {
          id,
          name: room.name,
          description: room.description,
          size: room.size,
          monsterIndexes: room.monsterIndexes,
          adjacentRoomIds: room.adjacentRoomIndexes.map((adjacent) => {
            const adjacentId = roomIds[adjacent];
            if (adjacentId === undefined) throw new Error(`Room ${room.name} has invalid adjacency`);
            return adjacentId;
          }),
          // The GM room key travels with the room through packing (packRooms
          // may rotate the room order — a parallel list would desync).
          key: room.key,
          keyTreasure: room.keyTreasure,
          // The room's own challenge target travels with it for the same
          // reason (the budget loop may have stamped/lowered it).
          ...(room.targetLevel === undefined ? {} : { targetLevel: room.targetLevel }),
        };
      }),
    }, this.encounterLayoutVariants.get(runId) ?? 0);
    return {
      step: this.finishStep(steps[stepIndex], { layout }),
    };
  }

  /**
   * The vision-map step (docs/11 vision path): SIDECAR FIRST — rooms (id,
   * name, description, encounter assignment, marker letter A..N in plan
   * order) are authored from the brief BEFORE any image exists — then the
   * labeled map is generated through the existing image pipeline + storage
   * (same `mapImageId` home), then ONE structured vision pass with the
   * configured chat model locates each plaque (0–1000 grid, zod boundary),
   * with a focused re-ask per miss. A still-missing plaque fails the MAP
   * STEP LOUD (the run fails / pauses per the pipeline's existing failure
   * handling) after pruning the unattached candidate — NEVER an
   * invented/defaulted coordinate (AGENTS rule 1). A vision-incapable
   * configured chat model fails here loudly too — a valid result, never a
   * silent skip.
   *
   * Single candidate by contract: no pick step follows (locate+verify is
   * the gate; Regenerate everything is the correction path, D14). No
   * aspect normalization: the image IS the map, and cropping could cut
   * plaques — the board letterboxes instead.
   */
  private async runVisionDungeonMap(
    stepIndex: number,
    steps: RunStep[],
    input: StartRunInput,
    signal: AbortSignal,
  ): Promise<{ step: RunStep }> {
    const settings = await getSettings();
    if (!settings.imagesEnabled) throw new Error('Image generation is disabled — enable it in Settings');
    const { parsed, aspect, preset } = this.effectiveEncounterBrief(steps);
    if (parsed.rooms.length <= 1) {
      throw new Error('Vision-located mapping needs a multi-room brief — single arenas map classic');
    }
    const labels = labelsForRoomCount(parsed.rooms.length);
    const entryRoomIndex = parsed.entryRoomIndex;
    if (entryRoomIndex < 0 || entryRoomIndex >= parsed.rooms.length) {
      throw new Error('Encounter brief has no valid entry room');
    }
    // The sidecar (docs/11 vision path): authored from the brief's existing
    // room input — name + description render as "Room A: name — description",
    // connectivity from the brief's room graph, diegetic letter plaques
    // engraved/carved per room, no monsters. The entry designation rides the
    // SAME rule as classic's entryRoomId (`roomIds[entryRoomIndex]`, in the
    // layout step) translated to letter space — `labels[entryRoomIndex]` —
    // never a second rule: the entry room keeps its letter, flagged `isEntry`
    // so the prompt draws it as the visual ingress.
    const entryLabel = labels[entryRoomIndex];
    if (entryLabel === undefined) throw new Error('Encounter brief has no valid entry room');
    const sidecarRooms = parsed.rooms.map((room, index) => {
      const label = labels[index];
      if (label === undefined) throw new Error(`Encounter room ${String(index)} has no marker letter`);
      return {
        label,
        name: room.name,
        description: room.description,
        isEntry: index === entryRoomIndex,
      };
    });
    const seenPairs = new Set<string>();
    const links: string[] = [];
    for (const [index, room] of parsed.rooms.entries()) {
      for (const adjacent of room.adjacentRoomIndexes) {
        if (adjacent === index) continue;
        const pair = [Math.min(index, adjacent), Math.max(index, adjacent)].join('<>');
        if (seenPairs.has(pair)) continue;
        seenPairs.add(pair);
        const left = labels[Math.min(index, adjacent)];
        const right = labels[Math.max(index, adjacent)];
        if (left !== undefined && right !== undefined) links.push(`${left} ↔ ${right}`);
      }
    }
    const concept = parsed.terrain === ''
      ? `${parsed.theme} dungeon`
      : `${parsed.theme} dungeon — ${parsed.terrain}`;
    const prompt = buildLabeledMapPrompt(
      sidecarRooms,
      concept,
      links.length === 0 ? undefined : links.join(', '),
    );
    const generated = await encounterRunAdapters.generateImages(prompt, 1, {
      model: settings.imageModel,
      signal,
    });
    const blob = generated.images[0];
    if (blob === undefined) {
      throw new Error('The image model returned no map images — the vision-map step failed without saving partial results');
    }
    const intake = await encounterRunAdapters.intakeImage(blob, { role: 'map' });
    const stored = await createImage({
      campaignId: input.campaign.id,
      blob: intake.blob,
      mimeType: intake.mimeType,
      width: intake.width,
      height: intake.height,
      prompt,
      model: generated.modelUsed,
      source: 'generated',
      role: 'map',
    });
    // LOCATE + VERIFY (docs/11 vision path): the observed point per letter.
    // Any failure prunes the unattached candidate first — the failed step
    // persists NOTHING and invents NOTHING.
    let marks;
    try {
      const imageDataUrl = await encounterRunAdapters.blobToDataUrl(intake.blob);
      const chatModel = resolveChatModel(settings);
      marks = await locateDungeonLabels(
        {
          visionPass: (imageDataUrlForPass, instruction) =>
            this.visionLocatePass(imageDataUrlForPass, instruction, chatModel),
        },
        { imageDataUrl, labels },
      );
    } catch (error) {
      await deleteUnreferencedImages(input.campaign.id, [stored.id]);
      throw error;
    }
    // STORE (docs/11 vision path): observed x_norm/y_norm as ADDITIVE room
    // fields (no Dexie version). Room ids are assigned here and persisted on
    // the step output, so pause/resume never re-mints them.
    const roomIds = parsed.rooms.map(() => newId());
    const entryRoomId = roomIds[entryRoomIndex];
    if (entryRoomId === undefined) throw new Error('Encounter brief has no valid entry room');
    const corridorPairs = new Set<string>();
    for (const [index, room] of parsed.rooms.entries()) {
      for (const adjacent of room.adjacentRoomIndexes) {
        if (adjacent === index) continue;
        corridorPairs.add([Math.min(index, adjacent), Math.max(index, adjacent)].join('<>'));
      }
    }
    const { gridW, gridH } = gridDimensionsFor(preset, aspect);
    const layout = encounterLayoutSchema.parse({
      gridW,
      gridH,
      theme: parsed.theme,
      rooms: parsed.rooms.map((room, index) => {
        const id = roomIds[index];
        const mark = marks[index];
        if (id === undefined || mark === undefined) {
          throw new Error(`Encounter room ${String(index)} has no located plaque`);
        }
        return {
          id,
          name: room.name,
          description: room.description,
          monsterIndexes: room.monsterIndexes,
          spawn: index === entryRoomIndex,
          letter: labels[index],
          observedX: mark.x / 1000,
          observedY: mark.y / 1000,
          key: room.key,
          keyTreasure: room.keyTreasure,
          ...(room.targetLevel === undefined ? {} : { targetLevel: room.targetLevel }),
        };
      }),
      corridors: [...corridorPairs].flatMap((pair) => {
        const [leftText, rightText] = pair.split('<>');
        const left = roomIds[Number(leftText)];
        const right = roomIds[Number(rightText)];
        return left === undefined || right === undefined ? [] : [{ a: left, b: right }];
      }),
      mapPath: 'vision',
      path: parsed.rooms.length > 1 ? spawnFirstPath(roomIds, entryRoomId) : undefined,
    });
    return {
      step: this.finishStep(steps[stepIndex], {
        imageId: stored.id,
        layout,
        costUsd: generated.costUsd,
        cappedToOne: generated.cappedToOne,
        notice: imageStepNotice(generated),
      }),
    };
  }

  /**
   * One structured vision pass for the vision-map step: the configured chat
   * model reads the labeled map back (0–1000 grid, strict JSON boundary).
   * A vision-incapable model fails LOUD here — the map step owns the error,
   * never a silent skip.
   */
  private async visionLocatePass(
    imageDataUrl: string,
    instruction: string,
    model: string,
  ): Promise<{ text: string }> {
    const reply = await chat(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: instruction },
            { type: 'image_url', image_url: { url: imageDataUrl } },
          ],
        },
      ],
      {
        model,
        temperature: 0,
        responseFormat: schemaResponseFormat('vision-dungeon-locate', visionLocateReplySchema),
      },
    );
    return { text: reply.text };
  }

  private runEncounterSchematic(
    runId: Id,
    stepIndex: number,
    steps: RunStep[],
  ): { step: RunStep } {
    const layout = this.effectiveEncounterLayout(steps);
    // Natural-site mode (docs/11): 'natural' renders the placement-only
    // overlay; 'architectural' keeps the room/wall schematic byte-identical.
    const { mapMode } = this.effectiveEncounterBrief(steps);
    const schematic = encounterRunAdapters.renderSchematic(layout, schematicCellPx(layout), undefined, mapMode);
    this.encounterSchematics.set(runId, schematic);
    return {
      step: this.finishStep(steps[stepIndex], {
        width: schematic.width,
        height: schematic.height,
      }),
    };
  }

  private async runEncounterStylize(
    runId: Id,
    stepIndex: number,
    steps: RunStep[],
    input: StartRunInput,
    signal: AbortSignal,
  ): Promise<{ step: RunStep }> {
    const settings = await getSettings();
    if (!settings.imagesEnabled) throw new Error('Image generation is disabled — enable it in Settings');
    const layout = this.effectiveEncounterLayout(steps);
    const { parsed, mapMode } = this.effectiveEncounterBrief(steps);
    const natural = mapMode === 'natural';
    const schematic =
      this.encounterSchematics.get(runId) ??
      encounterRunAdapters.renderSchematic(layout, schematicCellPx(layout), undefined, mapMode);
    this.encounterSchematics.set(runId, schematic);

    // Entrance marker (entrance/exit spawn zones, doc 11): the SCHEMATIC
    // paints the wall gap, landing pad and one neon triangle (drawEntrance),
    // and the stylize prompt asks the image model to keep them — decoration
    // only, nothing is ever detected or read back (D7; marker-path deletion
    // record in docs/11). Declared only when the layout carries an entrance
    // AND a free canonical hue exists (rooms consume the palette in order).
    // Natural-site mode softens ONLY the clause wording (the overlay paints
    // no wall gap — the marker is a spot on open ground); the marker
    // mechanics (one triangle, canonical hue, keep it) are unchanged.
    const spawnLayoutRoom = layout.rooms.find((room) => room.spawn);
    const entranceConfig =
      spawnLayoutRoom?.entrance !== undefined
        ? entranceMarkerConfig(layout.rooms.length)
        : null;
    const entranceClause =
      spawnLayoutRoom === undefined || entranceConfig === null
        ? null
        : natural
          ? `Entrance marker: the reference image shows exactly one solid neon ${entranceConfig.colorName} triangle with a thick black outline at the party's approach — keep it, and paint a visible approach path at the marked spot (the way the party walks in). The entrance triangle never has a disc or a plaque.`
          : `Entrance marker: The party enters the map through a single open gap in the entry room's outer wall. On the floor just inside that gap the reference image shows exactly one solid neon ${entranceConfig.colorName} triangle with a thick black outline, pointing into the room — keep it. The entrance triangle never has a disc or a plaque.`;

    // The usability hard-bans are the shared contract tail (docs/11): they
    // pin byte-identical in BOTH modes — the anti-hallucination negatives
    // (owner-observed white-rectangle failure) never soften.
    const usabilityBans =
      'No title banner, no compass rose, no map legend, no scale bar, no grid lines, no text labels, no characters, no monsters, no tokens, no miniatures. No white or pale boxes, rectangles, plaques, discs, signposts, or other markers or label-like geometry apart from the entrance triangle: paint every room floor as continuous natural terrain with no discrete light-colored sub-rectangles.';
    const prompt = natural
      ? [
          // Natural-site contract (docs/11): the encounter's own prose is the
          // truth — theme + terrain + summary lead, the reference image only
          // marks placement, and there is NO materials line and NO
          // keep-walls/structure clause (no terrain bans either: an island
          // in a lava lake or a murder-clown tent stays paintable).
          `Top-down orthographic RPG battlemap, flat vertical overhead view. Theme: ${parsed.theme}.`,
          parsed.terrain === '' ? null : `Site: ${parsed.terrain}.`,
          `Scene: ${parsed.summary}`,
          parsed.styleNotes,
          'This site is open natural terrain: the reference image only marks placement — its soft darker patches show where the encounter\'s creatures gather and its single neon triangle marks the party\'s approach — so shape the ground itself from the scene description above.',
          entranceClause,
          usabilityBans,
          parsed.negative === '' ? null : `Avoid: ${parsed.negative}`,
        ].filter((part) => part !== null && part !== '').join(' ')
      : [
          `Top-down orthographic RPG battlemap, flat vertical overhead view. Theme: ${parsed.theme}.`,
          parsed.styleNotes,
          'Environment materials: desaturated stone, wood, dirt. Water is dark navy, never cyan. Fungus is olive. Metal is bronze or rust, never yellow.',
          entranceClause,
          'Keep walls, openings, the entrance gap and overall structure exactly as in the reference image.',
          usabilityBans,
          parsed.negative === '' ? null : `Avoid: ${parsed.negative}`,
        ].filter((part) => part !== null && part !== '').join(' ');
    const generated = await encounterRunAdapters.generateImages(prompt, input.unattended === true ? 1 : 2, {
      model: settings.imageModel,
      signal,
      inputReferences: [{ dataUrl: schematic.dataUrl }],
    });
    // Marker-path deletion (docs/11): the candidates ARE the packed
    // geometry — no room-disc detection, no staging rebuild, no pixel
    // read-back (the two AGENTS-rule-1 violations — the silent packed-center
    // fallback and the swallowed detection errors — die with their host).
    // Every candidate verifies and finalizes against the same layout.
    const imageIds: Id[] = [];
    const aspectActions: ('none' | 'letterboxed')[] = [];
    for (const blob of generated.images) {
      const normalized = await encounterRunAdapters.normalizeImageAspect(blob, layout.gridW, layout.gridH);
      const intake = await encounterRunAdapters.intakeImage(normalized.blob, { role: 'map' });
      const stored = await createImage({
        campaignId: input.campaign.id,
        blob: intake.blob,
        mimeType: intake.mimeType,
        width: intake.width,
        height: intake.height,
        prompt,
        model: generated.modelUsed,
        source: 'generated',
        role: 'map',
      });
      imageIds.push(stored.id);
      aspectActions.push(normalized.action);
    }
    return {
      step: this.finishStep(steps[stepIndex], {
        imageIds,
        aspectActions,
        costUsd: generated.costUsd,
        cappedToOne: generated.cappedToOne,
        // Degradations must be visible here too (AGENTS rule 1): escalation
        // fallback and partial filtering name themselves on the step.
        notice: imageStepNotice(generated),
      }),
    };
  }

  private async runEncounterPick(
    stepIndex: number,
    steps: RunStep[],
    input: StartRunInput,
  ): Promise<{ step: RunStep; runStatus?: PersonaRun['status'] }> {
    const stylize = steps.find((step) => step.name === 'stylize')?.output as { imageIds?: Id[] } | undefined;
    const candidates = stylize?.imageIds ?? [];
    if (candidates.length === 0) throw new Error('Encounter run has no map candidates to pick');
    if (input.autonomy === 'auto') {
      const selected = candidates[0];
      if (selected === undefined) throw new Error('Encounter auto run has no first map candidate');
      await deleteUnreferencedImages(
        input.campaign.id,
        candidates.filter((id) => id !== selected),
      );
      return {
        step: {
          ...this.finishStep(steps[stepIndex], { candidates }, 'approved'),
          userEdit: { keep: [selected] },
        },
      };
    }
    return {
      step: this.finishStep(steps[stepIndex], { candidates }),
      runStatus: 'awaiting_user',
    };
  }

  async pickEncounterMap(runId: Id, keep: readonly Id[], input: StartRunInput): Promise<void> {
    if (keep.length !== 1) throw new Error('Select exactly one generated battlemap');
    const run = await getRun(runId);
    if (run?.status !== 'awaiting_user' && run?.status !== 'needs_review') return;
    if (briefRosterOnlyMarker(run.steps)) {
      throw new Error('A roster-only repopulation has no battlemap to pick — its map is preserved by design');
    }
    if (briefVisionMapMarker(run.steps) === 'vision') {
      throw new Error('A vision-located map has no candidates to pick — its single map is selected by contract');
    }
    const stepIndex = run.steps.findIndex((step) => step.name === 'pick');
    const pick = run.steps[stepIndex];
    const candidates = (pick?.output as { candidates?: Id[] } | undefined)?.candidates ?? [];
    const selected = keep[0];
    if (selected === undefined || !candidates.includes(selected)) {
      throw new Error('Selected battlemap is not a candidate from this run');
    }
    // Map approval is the last human boundary before finalize. Validate every
    // prerequisite here so a corrupt/rejected earlier step stays reviewable
    // instead of failing asynchronously after the user clicks Use map.
    this.effectiveEncounterBrief(run.steps);
    this.effectiveEncounterLayout(run.steps);
    if ((await getImage(selected)) === undefined) {
      throw new Error('The selected battlemap image no longer exists; regenerate the map candidates');
    }
    await this.updateStep(runId, stepIndex, {
      userEdit: { keep: [selected] },
      status: 'approved',
    });
    await deleteUnreferencedImages(
      run.campaignId,
      candidates.filter((id) => id !== selected),
    );
    void this.executeFrom(runId, stepIndex + 1, input).catch((error: unknown) => {
      void this.fail(runId, error);
    });
  }

  /**
   * Roster-only repopulation finalize (two-button regeneration, docs/11):
   * the `rosterOnly` Cartographer variant — brief → evaluate (with the
   * 'empty' repair loop: this is what kills pile-ups structurally) → SKIP
   * layout/stylize/pick → finalize persists the roster ONLY. Rooms, room
   * geometry/keys, layout corridors/path and the battlemap (`mapImageId`)
   * are PRESERVED — only each room's `monsterIndexes` is re-partitioned
   * onto the new roster. The roster is REPLACED (no verbatim pin — the old
   * spawn was wrong), room-tagged per the brief's stocking contract from the
   * row's fill grade, bounded by the existing cap, source-citing per the
   * existing monsters-field rules. Shape-gating (`encounterDataIsComplex`)
   * and the directive-append machinery are reused, not re-derived. The
   * advisory block is recomputed. Downstream effects (statblocks, portraits,
   * entity records) follow the first-materialization path — reuse, never
   * reinvent. The Smith keeps its one-fight charter for singles: this pass
   * is the Cartographer's, not a Smith extension.
   */
  private async runEncounterRosterFinalize(
    runId: Id,
    stepIndex: number,
    steps: RunStep[],
    input: StartRunInput,
  ): Promise<{ step: RunStep; artifactId: Id }> {
    const { parsed, statblockChunkIds, rosterChunkByName, fillGrade: briefFillGrade } =
      this.effectiveEncounterBrief(steps);
    const target = input.targetArtifactId === undefined
      ? undefined
      : await getAnyArtifact(input.targetArtifactId);
    if (input.targetArtifactId !== undefined && target === undefined) {
      throw new Error('The encounter to repopulate no longer exists');
    }
    if (target === undefined) {
      throw new Error('A roster-only repopulation needs an existing encounter to restock');
    }
    if (target.kind !== 'encounter') throw new Error('Encounter repopulation target changed kind');
    if (input.placementModuleId !== undefined) {
      throw new Error(
        'Module placement applies only to a newly created artifact — clear the module choice or drop the target',
      );
    }
    const targetLayout = target.data.layout;
    if (targetLayout === null) {
      throw new Error(
        `"${target.name}" has no room layout to restock — use Regenerate everything to build rooms and a map first`,
      );
    }
    const isComplex = targetLayout.rooms.length > 1;
    // Fill grade (docs/11 D12 amendment, draw-once): the row's value always
    // wins; then the brief's stamped value (the draw the prompt was written
    // against — the same precedence the full finalize uses); a legacy
    // complex with neither draws NOW (the same backfill the Smith fill
    // performs) so the budget check runs against a real expectation. One
    // draw per run at most — never redrawn, never ignored.
    const fillGrade = isComplex
      ? (target.data.fillGrade ?? briefFillGrade ?? drawFillGrade())
      : undefined;
    const fillGradeToPersist: number | undefined = isComplex
      ? (target.data.fillGrade ?? fillGrade)
      : target.data.fillGrade;
    // The fresh roster materializes through the first-materialization path
    // (rulebook citations → shared mob artifacts, inline blocks stay inline)
    // — every entry, since no verbatim pin exists.
    const monsters = await this.materializeBriefRoster(
      parsed.monsters,
      input.campaign.id,
      runId,
      statblockChunkIds,
      rosterChunkByName,
      new Map<Id, Id>(),
    );
    await promoteRosterUses(target.moduleId ?? null, monsters);
    // Room-tagging comes straight from the brief's stocking contract: the
    // evaluate gate forced the reply's rooms to mirror the dungeon's
    // existing rooms (same count, same order), with every roster entry in
    // exactly one room — so the partition maps by index onto the PRESERVED
    // rooms. Geometry, keys, corridors and path ride along untouched — only
    // `monsterIndexes` (and lowered `targetLevel`s below) change. A
    // count/index drift here is a loud invariant failure, never a silent
    // re-partition: the gate already approved this assignment.
    if (parsed.rooms.length !== targetLayout.rooms.length) {
      throw new Error(
        `repopulate: the approved brief stocks ${String(parsed.rooms.length)} rooms but "${target.name}" has ${String(targetLayout.rooms.length)} — refusing to re-partition a mismatched roster`,
      );
    }
    for (const [roomIndex, briefRoom] of parsed.rooms.entries()) {
      for (const monsterIndex of briefRoom.monsterIndexes) {
        if (monsterIndex < 0 || monsterIndex >= monsters.length) {
          throw new Error(
            `repopulate: the approved brief assigns roster entry ${String(monsterIndex)} to room ${String(roomIndex)} but the roster has ${String(monsters.length)} entries — refusing a dangling assignment`,
          );
        }
      }
    }
    const hintLevel = parseRosterTargetLevel(parsed.levelHint);
    const stampedRooms = targetLayout.rooms.map((room) => ({
      ...room,
      ...(room.targetLevel === undefined && hintLevel !== undefined
        ? { targetLevel: hintLevel }
        : {}),
    }));
    let reconciledLayout = {
      ...targetLayout,
      rooms: stampedRooms.map((room, roomIndex) => ({
        ...room,
        monsterIndexes: [...(parsed.rooms[roomIndex]?.monsterIndexes ?? [])],
      })),
    };
    const chunkIds = [
      ...new Set(
        monsters.flatMap((monster) =>
          monster.source.type === 'rulebook' ? [monster.source.chunkId] : [],
        ),
      ),
    ];
    const chunks = chunkIds.length === 0 ? [] : await getChunksByIds(chunkIds);
    const chunkById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
    const levels = await resolveEntryLevels(monsters, {
      chunkById,
      getArtifactStatBlock: async (artifactId) => {
        const artifact = await getArtifact(artifactId);
        if (artifact?.kind !== 'npc') return null;
        return artifact.data.statBlock;
      },
    });
    // The budget loop's deterministic tail (no repair turn at finalize):
    // over rooms step their target down (floor 1); 'empty'/'under' rooms
    // ship with the LOUD advisory persisted — never silent, never a failed
    // run. The repopulation brief's repair loop already forced every room
    // covered, so an 'empty' verdict here is loud by construction.
    const verdicts = reconciledLayout.rooms.map((room, roomIndex) =>
      checkRoomBudget({
        roomIndex,
        roomName: room.name,
        targetLevel: room.targetLevel,
        creatures: room.monsterIndexes.map((monsterIndex) => {
          const monster = monsters[monsterIndex];
          return {
            name: monster?.name ?? `roster entry ${String(monsterIndex)}`,
            count: monster?.count ?? 0,
            level: levels[monsterIndex],
          };
        }),
        ...(fillGrade === undefined ? {} : { fillGrade }),
        complex: isComplex,
        system: input.campaign.system,
      }),
    );
    const lowered = new Map<number, number>(
      verdicts.flatMap((verdict) =>
        verdict.loweredTargetLevel === null
          ? []
          : [[verdict.roomIndex, verdict.loweredTargetLevel]],
      ),
    );
    if (lowered.size > 0) {
      reconciledLayout = {
        ...reconciledLayout,
        rooms: reconciledLayout.rooms.map((room, roomIndex) => {
          const next = lowered.get(roomIndex);
          return next === undefined ? room : { ...room, targetLevel: next };
        }),
      };
    }
    const advisories = verdicts
      .map((verdict) => (verdict.status === 'ok' ? '' : verdict.advisory ?? ''))
      .filter((advisory) => advisory !== '');
    if (roomBudgetMode(input.campaign.system) === 'verbatim') {
      advisories.push(PF2E_BUDGET_ADVISORY);
    }
    const budgetAdvisory = advisories.join(' ');
    await updateArtifact(
      target.id,
      {
        // Roster ONLY: name, prose, links, tags, images, preset, siteShape,
        // locationKind, layout geometry and mapImageId all ride the spread
        // untouched. Only the roster, its room partition, the recomputed
        // advisory and the (draw-once) fill grade land.
        data: encounterDataSchema.parse({
          ...target.data,
          monsters,
          layout: reconciledLayout,
          budgetAdvisory,
          ...(fillGradeToPersist === undefined ? {} : { fillGrade: fillGradeToPersist }),
        }),
      },
      { source: 'persona', runId },
    );
    // Portrait preservation (docs/11 D5): same-named re-cited entries carry
    // covers forward. Best-effort: never fails the finalize.
    await carryMobCoversForward({
      campaignId: input.campaign.id,
      oldMonsters: target.data.monsters,
      newMonsters: monsters,
    });
    const step = this.finishStep(
      steps[stepIndex],
      withNotice(
        { artifactId: target.id },
        null,
        budgetAdvisory === '' ? null : budgetAdvisory,
      ),
    );
    await updateRun(runId, { resultArtifactId: target.id });
    return { step, artifactId: target.id };
  }

  private async runEncounterFinalize(
    runId: Id,
    stepIndex: number,
    steps: RunStep[],
    input: StartRunInput,
  ): Promise<{ step: RunStep; artifactId: Id }> {
    const { parsed, statblockChunkIds, rosterChunkByName, fillGrade: briefFillGrade } =
      this.effectiveEncounterBrief(steps);
    const layout = this.effectiveEncounterLayout(steps);
    // Vision runs (docs/11 vision path) select their single map by contract
    // — no pick step ran, locate+verify was the gate. Classic runs read the
    // human's pick.
    const selected = layout.mapPath === 'vision'
      ? readVisionMapImageId(steps)
      : (steps.find((step) => step.name === 'pick')?.userEdit as { keep?: Id[] } | null | undefined)?.keep?.[0];
    if (selected === undefined) throw new Error('Encounter finalize has no selected battlemap');
    const target = input.targetArtifactId === undefined
      ? undefined
      : await getAnyArtifact(input.targetArtifactId);
    if (input.targetArtifactId !== undefined && target === undefined) {
      throw new Error('The encounter to regenerate no longer exists');
    }
    if (target !== undefined && input.placementModuleId !== undefined) {
      throw new Error(
        'Module placement applies only to a newly created artifact — clear the module choice or drop the target',
      );
    }
    // Loud existence check (AGENTS rule 1): a module deleted while the run
    // was in flight FAILS the run here — never a dangling artifact whose
    // moduleId points at a removed row.
    if (target === undefined && input.placementModuleId !== undefined) {
      const placedModule = await getModule(input.placementModuleId);
      if (placedModule === undefined) {
        throw new Error(
          `finalize: the module placed for this encounter (${input.placementModuleId}) was deleted ` +
            'while the run was running — refusing to create an artifact owned by a module that no longer exists',
        );
      }
    }
    let artifactId: Id;
    if (target !== undefined) {
      if (target.kind !== 'encounter') throw new Error('Encounter regeneration target changed kind');
      // Single-map-slot replace (owner decision, docs/11): the gallery holds
      // EXACTLY one map per encounter. The previous battlemap leaves
      // `imageIds` in the SAME attach-seam transaction that lands the fresh
      // one (true replace, not accumulate), and rides `pruneCandidates` so
      // its blob is refchecked and freed when nothing still pins it (live
      // boards and history pin via the imageRepo refcount). Unpicked
      // candidates were already pruned at pick — only the previous map goes
      // here. History keeps the old id via revision snapshots (writeRevision
      // clones the whole row, `data.mapImageId` included).
      const previousMapImageId = target.data.mapImageId;
      // Complex expansion (docs/11 D12 amendment): a brief that kept the
      // pinned prefix and appended entries persists the MERGED roster — the
      // target's own entries stay byte-identical (identity, mob artifact,
      // treasure survive) and the appended entries materialize their fresh
      // sources exactly like the fresh-encounter birth path below.
      const expandedMonsters =
        parsed.monsters.length > target.data.monsters.length
          ? [
              ...target.data.monsters,
              ...await this.materializeBriefRoster(
                parsed.monsters.slice(target.data.monsters.length),
                input.campaign.id,
                runId,
                statblockChunkIds,
                rosterChunkByName,
                new Map<Id, Id>(),
              ),
            ]
          : target.data.monsters;
      // The re-anchor + content write commit as ONE attach-seam
      // transaction: a crash between the two used to strand a
      // library-scoped unreferenced image while the artifact kept the old
      // map (docs/18 known debt, now closed).
      await attachImagesToArtifact(target.id, {
        appendImageIds: [selected],
        // The slot swap: the old map id leaves the gallery with the new one.
        ...(previousMapImageId !== null && previousMapImageId !== selected
          ? { removeImageIds: [previousMapImageId] }
          : {}),
        // Only a global target re-anchors its kept image (D2/D9): omitting
        // the key leaves campaign anchors untouched.
        ...(target.campaignId === null ? { anchorImagesTo: null } : {}),
        // Regenerate never touches the cover: keep the existing value, or
        // omit the key when there is none (never an explicit null clear).
        ...(target.coverImageId == null ? {} : { coverImageId: target.coverImageId }),
        data: {
          ...target.data,
          // Complex expansion: the appended entries join the persisted
          // roster; the pinned prefix is untouched (equal length keeps the
          // target's own array byte-identical).
          monsters: expandedMonsters,
          layout,
          mapImageId: selected,
          // The run's preset is authoritative for the map it just produced
          // (regenerate keeps the target's preset via the run input; an
          // explicit change re-tiers the map — docs/11 D10).
          preset: this.effectiveEncounterBrief(steps).preset,
          // So is the shape it just produced (docs/11 D11): the target's old
          // shape may not match the fresh layout's room count.
          siteShape: layout.rooms.length === 1 ? 'single' : 'complex',
          // And the run's own budget verdict (docs/11 D12) replaces the
          // target's stale advisory — the fresh layout was just checked.
          budgetAdvisory: this.encounterBudgetAdvisory(steps),
          // Fill grade (docs/11 D12 amendment): the row's value always wins
          // (never redrawn — owner precedence). Absent + a complex layout
          // stamps the run's drawn value — the legacy row's draw-on-first-
          // regen; a single-arena result never carries one.
          ...(target.data.fillGrade !== undefined
            ? { fillGrade: target.data.fillGrade }
            : layout.rooms.length > 1
              ? { fillGrade: briefFillGrade ?? drawFillGrade() }
              : {}),
        },
        meta: { source: 'persona', runId },
        // Refchecked prune of the replaced map (no-op while a live board or
        // history still pins it — the refcount decides, never the caller).
        ...(previousMapImageId !== null && previousMapImageId !== selected
          ? {
              pruneCandidates: {
                campaignId: input.campaign.id,
                candidateIds: [previousMapImageId],
              },
            }
          : {}),
      });
      artifactId = target.id;
      // Board convergence (owner decision, docs/11): never-opened battles
      // seeded from this encounter move onto the fresh map+layout; live
      // battles stay frozen (Open battle never reseeds — docs/18 gotcha).
      const { liveSkipped } = await convergeBoardsToRegeneratedMap(target.id, {
        mapImageId: selected,
        mapLayout: { cols: layout.gridW, rows: layout.gridH },
      });
      if (liveSkipped > 0) {
        // Loud (AGENTS rule 2): the new map is saved, but the live table
        // still plays the old board — the GM must act to pick it up.
        toastError(
          `The battlemap was replaced, but ${liveSkipped === 1 ? 'a live battle is' : `${String(liveSkipped)} live battles are`} still frozen on the old board — re-run battle to pick up the new map.`,
        );
      }
    } else {
      // Mob artifacts (owner-ratified): a rulebook citation gets ONE
      // image-able npc artifact per campaign per chunkId — roster name +
      // the data.monsterChunkId marker, NO stat duplication (the chunk
      // stays the source of truth). The entry stamps mobArtifactId so
      // seeding pins shared token identity + the portrait path.
      const mobArtifacts = new Map<Id, Id>();
      const monsters = await this.materializeBriefRoster(
        parsed.monsters,
        input.campaign.id,
        runId,
        statblockChunkIds,
        rosterChunkByName,
        mobArtifacts,
      );
      // Auto-promote on second-module use (ROSTER hook): a freshly drafted
      // encounter placed in a module shares any other-module roster
      // artifacts campaign-wide before the encounter row is created.
      await promoteRosterUses(input.placementModuleId ?? null, monsters);
      const artifact = await createArtifact({
        campaignId: input.campaign.id,
        // Creation-dialog placement (one-off), same as generate finalize.
        ...(input.placementModuleId === undefined ? {} : { moduleId: input.placementModuleId }),
        kind: 'encounter',
        name: parsed.name,
        summary: parsed.summary,
        body: parsed.body,
        imageIds: [selected],
        data: {
          difficulty: parsed.difficulty,
          levelHint: parsed.levelHint,
          monsters,
          terrain: parsed.terrain,
          tactics: parsed.tactics,
          treasure: parsed.treasure,
          mapImageId: selected,
          layout,
          // The run's preset (brief step, resolved from run input/settings)
          // is authoritative for the map it just produced — both branches.
          preset: this.effectiveEncounterBrief(steps).preset,
          // The Cartographer's brief already stages the encounter (dungeon |
          // outdoor) — carry it as the artifact's location kind so
          // Cartographer-created encounters classify themselves too (D10
          // amendment; the Smith draft classifies via its own field).
          locationKind: parsed.environment === 'dungeon' ? 'dungeon' : 'wilderness',
          // The shape the run just produced (docs/11 D11): one arena room =
          // single, anything multi-room = complex. The brief boundary
          // enforces 1-or-4–10; the persisted field records the outcome.
          siteShape: layout.rooms.length === 1 ? 'single' : 'complex',
          budgetAdvisory: this.encounterBudgetAdvisory(steps),
          // Fill grade (docs/11 D12 amendment): a complex layout
          // materializing for the FIRST time stamps the value the brief was
          // written against (drawn at the brief step; a pre-arc resumed run
          // without one draws here). A single-arena outcome discards the
          // draw — the field is a dungeon-stocking share.
          ...(layout.rooms.length > 1
            ? { fillGrade: briefFillGrade ?? drawFillGrade() }
            : {}),
        },
      }, { source: 'persona', runId });
      artifactId = artifact.id;
    }
    await updateRun(runId, { resultArtifactId: artifactId });
    return { step: this.finishStep(steps[stepIndex], { artifactId }), artifactId };
  }

  /**
   * Materializes a brief's roster entries into persisted `MonsterEntry`
   * sources — the M-B §7 precedence: cited excerpt index → cited roster
   * name → inline stat block → none; a rulebook citation gets the ONE
   * campaign mob artifact per chunk and full content identity. Shared by
   * the fresh-encounter finalize and the complex expansion tail of a
   * regenerate finalize (docs/11 D12 amendment) so both birth paths stamp
   * sources identically.
   */
  private async materializeBriefRoster(
    monsters: readonly {
      name: string;
      count: number;
      notes: string;
      treasure: string;
      sourceChunkIndex?: number | undefined;
      sourceName?: string | undefined;
      statBlock?: StatBlock | undefined;
    }[],
    campaignId: Id,
    runId: Id,
    statblockChunkIds: readonly Id[],
    rosterChunkByName: Readonly<Record<string, Id>>,
    mobArtifacts: Map<Id, Id>,
  ): Promise<MonsterEntry[]> {
    const entries: MonsterEntry[] = [];
    for (const monster of monsters) {
      const chunkId = resolveEncounterMonsterSource(monster, statblockChunkIds, rosterChunkByName);
      if (chunkId === undefined) {
        entries.push({
          name: monster.name,
          count: monster.count,
          notes: monster.notes,
          treasure: monster.treasure,
          source: monster.statBlock !== undefined
            ? { type: 'inline' as const, statBlock: monster.statBlock }
            : { type: 'none' as const },
        });
        continue;
      }
      const mobArtifactId = await getOrCreateMobArtifact(
        campaignId,
        chunkId,
        monster.name,
        { source: 'persona', runId },
        mobArtifacts,
      );
      entries.push({
        name: monster.name,
        count: monster.count,
        notes: monster.notes,
        treasure: monster.treasure,
        source: await rulebookSourceFor(chunkId, monster.name, mobArtifactId),
      });
    }
    return entries;
  }

  /**
   * Prompt-draft step (M3-A): assembles the image prompt for the target
   * artifact deterministically from its own data (owner-directed: the LLM
   * prompt-crafting call is gone — buildImagePrompt). The step stays in the
   * pipeline so run history keeps its shape and manual/review autonomy can
   * still edit the draft before generate.
   */
  private async runPromptDraft(
    stepIndex: number,
    steps: RunStep[],
    input: StartRunInput,
    extraInstruction: string,
  ): Promise<{ step: RunStep; runStatus?: PersonaRun['status'] }> {
    const targetId = input.targetArtifactId ?? null;
    const target = targetId === null ? undefined : await getAnyArtifact(targetId);
    if (target === undefined) throw new Error('the artifact to illustrate no longer exists');

    // The prompt contract (appearance shortcut, body/summary/name grounding)
    // is shared with the entity image and mob portrait queues — see
    // buildImagePrompt. Deterministic: no chat call, no repair retry.
    const draft = buildImagePrompt(
      { name: target.name, kind: target.kind, summary: target.summary, body: target.body, data: target.data },
      { systemLabel: GAME_SYSTEM_LABELS[input.campaign.system], extraInstruction },
    );
    const step = this.finishStep(steps[stepIndex], { parsed: draft });
    const pausesHere = pauses(input.autonomy, true);
    return pausesHere ? { step, runStatus: 'awaiting_user' } : { step };
  }

  /** Generate step (M3-A): calls the image API and stores the candidates. */
  private async runGenerate(
    _runId: Id,
    stepIndex: number,
    steps: RunStep[],
    input: StartRunInput,
    signal: AbortSignal,
  ): Promise<{ step: RunStep }> {
    const settings = await getSettings();
    if (!settings.imagesEnabled) {
      throw new Error('Image generation is disabled — enable it in Settings');
    }
    const draft = this.effectivePromptDraft(steps);
    if (draft === null) throw new Error('no prompt draft available to generate from');
    const finalPrompt = assembleImagePrompt(draft);
    const generated = await generateImages(finalPrompt, 2, {
      model: settings.imageModel,
      signal,
    });

    // Store each candidate through the same intake pipeline as uploads
    // (EXIF-safe decode, ≤1600px, WebP re-encode with format detection).
    const imageIds: Id[] = [];
    for (const blob of generated.images) {
      const intake = await intakeImage(blob);
      const stored = await createImage({
        campaignId: input.campaign.id,
        blob: intake.blob,
        mimeType: intake.mimeType,
        width: intake.width,
        height: intake.height,
        prompt: finalPrompt,
        model: generated.modelUsed,
        source: 'generated',
      });
      imageIds.push(stored.id);
    }
    // Degradations the user must see (AGENTS rule 1): an escalation fallback
    // that produced the image, partially filtered candidates, and the model
    // capping candidates at 1 (e.g. x-ai/grok-imagine-image-2.0) — persist a
    // notice on the step; the run panel renders it next to the pick UI.
    const notice = imageStepNotice(generated);
    const step = this.finishStep(steps[stepIndex], { imageIds, costUsd: generated.costUsd, notice });
    return { step };
  }

  /**
   * Pick step (M3-A): ALWAYS pauses (07-MILESTONE-3 M3-A) — on every autonomy
   * level the user chooses 0–2 candidates.
   */
  private runPick(stepIndex: number, steps: RunStep[]): { step: RunStep; runStatus: PersonaRun['status'] } {
    const generateStep = steps.find((step) => step.name === 'generate');
    const output = (generateStep?.output ?? {}) as { imageIds?: unknown };
    const candidates = Array.isArray(output.imageIds) ? (output.imageIds as Id[]) : [];
    const step = this.finishStep(steps[stepIndex], { candidates });
    return { step, runStatus: 'awaiting_user' };
  }

  /**
   * Applies the user's pick for an image run (M3-A): appends kept ids to the
   * target artifact (the first keep becomes the cover if none exists), prunes
   * discarded candidates, and completes the run with the target as result.
   * The attach (re-anchor → artifact update → prune) is ONE repo
   * transaction — attachImagesToArtifact; the step write and run completion
   * stay with the engine (runs table).
   */
  async pickImages(runId: Id, keep: readonly Id[]): Promise<void> {
    const run = await getRun(runId);
    if (run?.status !== 'awaiting_user') return;
    const targetId = run.targetArtifactId;
    if (targetId === null) throw new Error('image run has no target artifact');
    const target = await getAnyArtifact(targetId);
    if (target === undefined) throw new Error('the artifact to illustrate no longer exists');

    const existing = new Set(target.imageIds);
    const kept = keep.filter((id) => !existing.has(id));
    // A run stays anchored to its campaign, but kept images become library
    // images before they are attached to a global target (D2/D9) — re-anchored
    // inside the attach transaction. The prune runs in the SAME transaction,
    // after the artifact update, so kept images are already referenced when
    // the candidate scan runs; pass only discards — kept global images were
    // re-anchored above and campaign reference scans intentionally cannot
    // see them.
    const pickStep = run.steps.find((step) => step.name === 'pick');
    const pickOutput = (pickStep?.output ?? {}) as { candidates?: unknown };
    const candidates = Array.isArray(pickOutput.candidates)
      ? (pickOutput.candidates as Id[])
      : [];
    const keepIds = new Set(keep);
    await attachImagesToArtifact(targetId, {
      appendImageIds: kept,
      // Only a global target re-anchors its kept images (D2/D9): omitting the
      // key leaves the campaign anchors untouched.
      ...(target.campaignId === null ? { anchorImagesTo: null } : {}),
      coverImageId: target.coverImageId ?? keep[0] ?? null,
      pruneCandidates: {
        campaignId: run.campaignId,
        candidateIds: candidates.filter((id) => !keepIds.has(id)),
      },
    });

    const stepIndex = run.steps.findIndex((step) => step.name === 'pick');
    if (stepIndex !== -1) {
      await this.updateStep(runId, stepIndex, { userEdit: { keep: [...keep] }, status: 'approved' });
      this.emit({ kind: 'step', runId, stepIndex, status: 'approved' });
    }
    await updateRun(runId, { status: 'completed', resultArtifactId: targetId });
    this.emit({ kind: 'run', runId, status: 'completed' });
  }

  /**
   * Fixed-cast finalize advisories (docs/11): after the roster finalizes,
   * the encounter's scene members must have landed — a missing name
   * (cast-coverage) or a wildly-off fielded level (level-mismatch) rides the
   * existing advisory block (`data.budgetAdvisory` + the step notice, the
   * 'under' precedent). Loud, never blocking: unjudgeable states (no owning
   * module, module gone mid-flight, no scene mention, empty cast, no party
   * level) yield no advisory, never a failure. Genuine IO errors propagate
   * like every other finalize read (AGENTS rule 1 — no catch-and-continue).
   */
  private async fixedCastAdvisoriesFor(args: {
    campaignId: Id;
    moduleId: Id | null | undefined;
    encounterName: string;
    monsters: readonly { name: string }[];
    levelHint: string;
  }): Promise<string[]> {
    const { campaignId, moduleId, encounterName, monsters, levelHint } = args;
    if (moduleId === null || moduleId === undefined) return [];
    const owner = await getModule(moduleId);
    if (owner === undefined) return [];
    const sceneContext = surroundingParagraphs(moduleDocumentText(owner), encounterName);
    if (sceneContext === '') return [];
    const pool = await listArtifactsByCampaign(campaignId);
    const cast = fixedCastForEncounter(encounterName, sceneContext, pool, owner.id);
    if (cast.length === 0) return [];
    const partyLevel =
      partLevelForMention(owner, encounterName) ?? parseRosterTargetLevel(levelHint);
    return fixedCastAdvisories(encounterName, cast, monsters, partyLevel);
  }

  private async runFinalize(
    runId: Id,
    stepIndex: number,
    steps: RunStep[],
    input: StartRunInput,
  ): Promise<{ step: RunStep; runStatus?: PersonaRun['status']; artifactId?: Id }> {
    const draft = this.effectiveDraft(steps) ?? {};
    const kind = input.persona.producesKind;
    if (kind === undefined) throw new Error('image personas do not produce artifacts');
    // Loud existence check (AGENTS rule 1), BEFORE any finalize work: a
    // module deleted while the run was in flight FAILS the run — never a
    // dangling artifact whose moduleId points at a removed row. Review
    // personas finalize campaign-level continuity notes and never honor
    // placement, so they are out of scope here.
    if (
      input.targetArtifactId === undefined &&
      input.placementModuleId !== undefined &&
      input.persona.mode !== 'review'
    ) {
      const placedModule = await getModule(input.placementModuleId);
      if (placedModule === undefined) {
        throw new Error(
          `finalize: the module placed for this artifact (${input.placementModuleId}) was deleted ` +
            'while the run was running — refusing to create an artifact owned by a module that no longer exists',
        );
      }
    }
    const data = dataForDraft(kind, draft);
    // Attach the parsed stat block for NPC artifacts before creating (the
    // finalize revision is the baseline snapshot).
    const statblockStep = steps.find((step) => step.name === 'statblock');
    const statblockOutput = (statblockStep?.userEdit ?? statblockStep?.output) as
      { statBlock?: StatBlock } | null | undefined;
    // Escape-debris hygiene backstop (18-ARCHITECTURE seam): the UTF-8
    // contract in `llm/language.ts` is prevention, this is detection. The
    // effective draft (body/summary/name, encounter monster notes/treasure)
    // plus the statblock strings are scanned BEFORE any create/updateArtifact
    // below — a hit rejects the step LOUDLY with the debris named in the
    // issues, and nothing persists. Never repair-and-continue (AGENTS 1-2).
    const debrisIssues = debrisIssuesForFields([
      ...collectTextLeaves(draft, 'draft'),
      ...collectTextLeaves(statblockOutput?.statBlock, 'statBlock'),
    ]);
    if (debrisIssues.length > 0) {
      const step = this.finishStep(steps[stepIndex], { raw: JSON.stringify(draft), issues: debrisIssues }, 'rejected');
      if (input.autonomy === 'manual') return { step, runStatus: 'awaiting_user' };
      if (input.autonomy === 'auto') return { step };
      return { step, runStatus: 'needs_review' };
    }
    if ((kind === 'npc' || kind === 'pc') && 'statBlock' in data) {
      const statBlock = statblockOutput?.statBlock;
      if (statBlock !== undefined) data.statBlock = statBlock;
    }
    // M3-B: map encounter monsters' cited rulebook chunks / inline stat
    // blocks back into persisted `source` entries. M-B (§7) adds roster-name
    // citations and the precedence: excerpt index → roster name → inline.
    // fix-02 (decisions 1–2): the Smith materializes instead of going quiet —
    // an uncited monster's validated inline block becomes a real NPC artifact
    // linked via {type:'npc-ref'}, and a source-less monster refuses to
    // finalize. Serves BOTH Smith paths: fresh-draft creation and the
    // in-place content run (both write `data.monsters` below).
    if (kind === 'encounter' && 'monsters' in data) {
      // The retrieve output is data at rest — validate it at the boundary
      // exactly like the draft path (storedRetrieveOutput). Garbage must
      // fail the run loudly, never silently become empty citation maps.
      const retrieveOutput = this.storedRetrieveOutput(steps);
      const statblockChunkIds = retrieveOutput.statblockChunkIds;
      const rosterChunkByName = retrieveOutput.rosterChunkByName;
      const draftMonsters = (
        draft as {
          monsters?: {
            sourceChunkIndex?: number;
            sourceName?: string;
            statBlock?: StatBlock;
          }[];
        }
      ).monsters;
      const materializedNpcs = new Map<string, Id>();
      // Mob artifacts share the materialize cache pattern, keyed by chunkId
      // (owner-ratified: one artifact per creature kind per campaign).
      const mobArtifacts = new Map<Id, Id>();
      const monsters: typeof data.monsters = [];
      for (const [index, monster] of data.monsters.entries()) {
        const cited = draftMonsters?.[index];
        const chunkId =
          cited === undefined
            ? undefined
            : resolveEncounterMonsterSource(cited, statblockChunkIds, rosterChunkByName);
        if (chunkId !== undefined) {
          const mobArtifactId = await getOrCreateMobArtifact(
            input.campaign.id,
            chunkId,
            monster.name,
            { source: 'persona', runId },
            mobArtifacts,
          );
          monsters.push({
            name: monster.name,
            count: monster.count,
            notes: monster.notes,
            treasure: monster.treasure,
            source: await rulebookSourceFor(chunkId, monster.name, mobArtifactId),
          });
          continue;
        }
        const statBlock = cited?.statBlock;
        if (statBlock !== undefined) {
          const artifactId = await materializeMonsterNpc(
            monster.name,
            monster.notes,
            statBlockSchema.parse(statBlock),
            input,
            runId,
            materializedNpcs,
          );
          monsters.push({
            name: monster.name,
            count: monster.count,
            notes: monster.notes,
            treasure: monster.treasure,
            source: { type: 'npc-ref', artifactId },
          });
          continue;
        }
        throw new Error(
          `finalize: monster "${monster.name}" has no stat-block source — no valid citation and no inline stat block. ` +
            'Refusing to save an encounter with stat-less mobs; re-run the draft or edit it to add a source.',
        );
      }
      // Auto-promote on second-module use (ROSTER hook): roster npc-ref /
      // mob artifacts owned by another module promote to campaign level
      // before the encounter persists — covers BOTH the mob get-or-create
      // above and materializeMonsterNpc reuse below in one scan. A
      // campaign-level encounter (no target, no placement) promotes any
      // module owner; the promotion notice is loud, failures are loud.
      const encounterOwner =
        input.targetArtifactId === undefined
          ? undefined
          : await getAnyArtifact(input.targetArtifactId);
      if (encounterOwner === undefined && input.targetArtifactId !== undefined) {
        throw new Error('finalize: the encounter to fill no longer exists');
      }
      await promoteRosterUses(
        encounterOwner?.moduleId ?? input.placementModuleId ?? null,
        monsters,
      );
      data.monsters = monsters;
    }

    // Fixed-cast advisories (docs/11): the scene members the brief pinned
    // (or the prose named, for runs outside the batch) must have landed in
    // the finalized roster — coverage + level mismatches ride the advisory
    // block, loud, never blocking. Fresh creations only here; the in-place
    // fill below computes the same checks on its own path.
    let fixedCastNotice: string | null = null;
    if (kind === 'encounter' && 'monsters' in data && input.targetArtifactId === undefined) {
      const castAdvisories = await this.fixedCastAdvisoriesFor({
        campaignId: input.campaign.id,
        moduleId: input.placementModuleId ?? null,
        encounterName: asString(draft.name).trim(),
        monsters: data.monsters,
        levelHint: data.levelHint,
      });
      if (castAdvisories.length > 0) {
        data.budgetAdvisory = [data.budgetAdvisory, ...castAdvisories]
          .filter((part) => part !== '')
          .join(' ');
        fixedCastNotice = castAdvisories.join(' ');
      }
    }

    // Review personas finalize as a continuity report note linked to the
    // target artifact (06-MILESTONES M2: Continuity Editor).
    if (input.persona.mode === 'review') {
      const report = this.reportFromCheck(steps);
      // No structured report here means the check step lied about being
      // done — refusing to write a "no structured report" placeholder note.
      if (report === null) {
        throw new Error('finalize: the check step produced no continuity report');
      }
      const targetId = input.targetArtifactId ?? null;
      const targetName = this.targetName(steps);
      const reportBody = [
        `# Continuity report — ${targetName}`,
        [
          `**Verdict:** ${report.verdict === 'consistent' ? 'consistent' : 'issues found'}`,
          report.issues
            .map(
              (issue) =>
                `- **[${issue.severity}]** ${issue.message}${issue.relatedTo === '' ? '' : ` (relates to: ${issue.relatedTo})`}`,
            )
            .join('\n'),
        ]
          .filter((part) => part !== '')
          .join('\n\n'),
      ].join('\n');
      const artifact = await createArtifact(
        {
          campaignId: input.campaign.id,
          kind: 'note',
          name: `Continuity report — ${targetName}`,
          tags: ['continuity'],
          summary: report.summary,
          body: reportBody,
          links: targetId === null ? [] : [{ targetId, relation: 'continuity-check-of' }],
          data: {},
        },
        { source: 'persona', runId },
      );
      const step = this.finishStep(steps[stepIndex], { artifactId: artifact.id });
      await updateRun(runId, { resultArtifactId: artifact.id });
      return { step, artifactId: artifact.id };
    }

    // A generate persona reaching finalize without a draft name means the
    // pipeline skipped validation — refuse instead of naming the artifact
    // after the persona (the "Worldbuilder"-class bug).
    const draftName = asString(draft.name);
    if (draftName.trim() === '') {
      throw new Error(
        `finalize: the ${kind} draft has no name — refusing to create an unnamed artifact`,
      );
    }
    // Minimum content at the finalize boundary (AGENTS 1): a completed draft
    // with an empty body never materializes — neither as a new artifact nor
    // as a refill overwrite. The schema already rejects empty bodies, so
    // this guards the holes it cannot see (user-edited drafts, older runs
    // resumed after the contract tightened). Loud run failure; an in-place
    // refill leaves the existing content untouched.
    if (asString(draft.body).trim() === '') {
      throw new Error(
        `finalize: the ${kind} draft has an empty body — refusing to create or overwrite an artifact with empty content`,
      );
    }
    // Generate personas create new artifacts — except an explicitly targeted
    // run (module stubs): the content is written INTO the existing artifact,
    // preserving its identity, links, images and (encounters) battlemap.
    if (input.targetArtifactId !== undefined) {
      if (input.placementModuleId !== undefined) {
        throw new Error(
          'Module placement applies only to a newly created artifact — clear the module choice or drop the target',
        );
      }
      const target = await getAnyArtifact(input.targetArtifactId);
      if (target === undefined) throw new Error('The artifact to fill no longer exists');
      if (kind === 'encounter' && target.kind === 'encounter') {
      if (!('monsters' in data)) {
        throw new Error('In-place generation produced no monster roster to fill the encounter with');
      }
      // Prose-only redesign (two-button regeneration, docs/11): name and
      // prose are redesigned; the roster the pipeline just built is NEVER
      // touched. A draft that renames, adds or removes a roster entry fails
      // LOUD here — before any write — so a prose reply can never
      // partial-apply a roster rewrite. `data` (including layout, map,
      // advisories and fill grade) persists byte-identically.
      if (input.encounterProseOnly === true) {
        const rosterKey = (entries: readonly { name: string; count: number }[]): string =>
          JSON.stringify(
            entries
              .map((entry) => `${entry.name.trim().toLowerCase()}|${String(entry.count)}`)
              .sort(),
          );
        if (rosterKey(data.monsters) !== rosterKey(target.data.monsters)) {
          throw new Error(
            'prose-only redesign: the draft rewrote the monster roster (names or counts differ) — ' +
              'a prose redesign must copy the roster verbatim. Nothing was changed; re-run the prose pass.',
          );
        }
        const nextName = draftName.trim();
        const nextAliases =
          nextName.toLowerCase() === target.name.trim().toLowerCase() ||
          target.aliases.some((alias) => alias.trim().toLowerCase() === nextName.toLowerCase())
            ? target.aliases
            : [...target.aliases, target.name];
        await updateArtifact(
          target.id,
          {
            name: nextName,
            summary: asString(draft.summary),
            body: asString(draft.body),
            aliases: nextAliases,
          },
          { source: 'persona', runId },
        );
        const step = this.finishStep(steps[stepIndex], withNotice({ artifactId: target.id }, null));
        await updateRun(runId, { resultArtifactId: target.id });
        return { step, artifactId: target.id };
      }
      const modelAlias = draftName.trim();
      // The prose checkbox (two-button regeneration): ticked, the draft's
      // name REPLACES the target's (the old name becomes an alias, so links
      // keep resolving); unticked, the default name-preserving alias
      // behavior holds — the Smith charter for singles is unchanged.
      const renamed = input.encounterRedesignName === true &&
        modelAlias.toLowerCase() !== target.name.trim().toLowerCase();
      const aliases = renamed
        ? [
          ...target.aliases.filter(
            (alias) => alias.trim().toLowerCase() !== modelAlias.toLowerCase(),
          ),
          ...(target.aliases.some(
            (alias) => alias.trim().toLowerCase() === target.name.trim().toLowerCase(),
          )
            ? []
            : [target.name]),
        ]
        : modelAlias.toLowerCase() === target.name.trim().toLowerCase() ||
            target.aliases.some((alias) => alias.trim().toLowerCase() === modelAlias.toLowerCase())
          ? target.aliases
          : [...target.aliases, modelAlias];
      // In-place fill reconciliation (docs/11 D12; packing amended by the
      // fill-grade arc): `data.monsters` is the NEW roster while the
      // target's layout stays byte-identical — without re-partitioning,
      // `room.monsterIndexes` dangle/shift/skip against the new roster
      // (loud seed failure or silent wrong-room seeding). The exact rules
      // live in roomBudget.reconcileRoomAssignments: preserve by name-match,
      // then pack the unclaimed by nearest-band fit when per-room
      // expectations exist (round-robin fallback without them), drop gone
      // ones. A room left empty by packing is a legit loud 'empty' verdict.
      const targetLayout = target.data.layout;
      let reconciledLayout = targetLayout;
      let budgetAdvisory = '';
      let fillGradeToPersist: number | undefined = target.data.fillGrade;
      if (targetLayout !== null) {
        const isComplex = targetLayout.rooms.length > 1;
        // Fill grade (docs/11 D12 amendment): the row's value always wins;
        // a legacy complex without one draws NOW (draw-once at the refill —
        // the second ratified draw site) so the packing and the budget
        // check run against a real expectation.
        const fillGrade = isComplex ? (target.data.fillGrade ?? drawFillGrade()) : undefined;
        if (isComplex && fillGrade !== undefined) fillGradeToPersist = fillGrade;
        const hintLevel = parseRosterTargetLevel(asString(draft.levelHint));
        const stampedRooms = targetLayout.rooms.map((room) => ({
          ...room,
          ...(room.targetLevel === undefined && hintLevel !== undefined
            ? { targetLevel: hintLevel }
            : {}),
        }));
        const chunkIds = [
          ...new Set(
            data.monsters.flatMap((monster) =>
              monster.source.type === 'rulebook' ? [monster.source.chunkId] : [],
            ),
          ),
        ];
        const chunks = chunkIds.length === 0 ? [] : await getChunksByIds(chunkIds);
        const chunkById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
        const levels = await resolveEntryLevels(data.monsters, {
          chunkById,
          getArtifactStatBlock: async (artifactId) => {
            const artifact = await getArtifact(artifactId);
            if (artifact?.kind !== 'npc') return null;
            return artifact.data.statBlock;
          },
        });
        const assignments = reconcileRoomAssignments(
          stampedRooms,
          target.data.monsters,
          data.monsters,
          {
            levels,
            ...(fillGrade === undefined
              ? {}
              : {
                  expectedLevels: stampedRooms.map(
                    (room) =>
                      room.targetLevel === undefined
                        ? undefined
                        : expectedRoomThreat(fillGrade, room.targetLevel, input.campaign.system)
                          ?.expectedLevels,
                  ),
                }),
          },
        );
        reconciledLayout = {
          ...targetLayout,
          rooms: stampedRooms.map((room, roomIndex) => ({
            ...room,
            monsterIndexes: assignments[roomIndex]?.monsterIndexes ?? [],
          })),
        };
        // The same budget loop covers in-place fills. There is no repair
        // turn at finalize (the draft is not re-rolled here), so every
        // non-ok verdict gets the loop's deterministic tail only: over rooms
        // step their target down (floor 1), and 'empty'/'under' rooms ship
        // with the LOUD advisory persisted — never silent, never a failed
        // run.
        const verdicts = reconciledLayout.rooms.map((room, roomIndex) =>
          checkRoomBudget({
            roomIndex,
            roomName: room.name,
            targetLevel: room.targetLevel,
            creatures: room.monsterIndexes.map((monsterIndex) => {
              const monster = data.monsters[monsterIndex];
              return {
                name: monster?.name ?? `roster entry ${String(monsterIndex)}`,
                count: monster?.count ?? 0,
                level: levels[monsterIndex],
              };
            }),
            ...(fillGrade === undefined ? {} : { fillGrade }),
            complex: isComplex,
            system: input.campaign.system,
          }),
        );
        const lowered = new Map<number, number>(
          verdicts.flatMap((verdict) =>
            verdict.loweredTargetLevel === null
              ? []
              : [[verdict.roomIndex, verdict.loweredTargetLevel]],
          ),
        );
        if (lowered.size > 0) {
          reconciledLayout = {
            ...reconciledLayout,
            rooms: reconciledLayout.rooms.map((room, roomIndex) => {
              const next = lowered.get(roomIndex);
              return next === undefined ? room : { ...room, targetLevel: next };
            }),
          };
        }
        const advisories = verdicts
          .map((verdict) => (verdict.status === 'ok' ? '' : verdict.advisory ?? ''))
          .filter((advisory) => advisory !== '');
        if (roomBudgetMode(input.campaign.system) === 'verbatim') {
          advisories.push(PF2E_BUDGET_ADVISORY);
        }
        budgetAdvisory = advisories.join(' ');
      }
      // Fixed-cast advisories (docs/11): the same checks as fresh creations,
      // riding the same advisory block + notice (which the update below
      // persists). The prose-only path above returns earlier and persists
      // the roster byte-identically — untouched.
      const castAdvisories = await this.fixedCastAdvisoriesFor({
        campaignId: input.campaign.id,
        moduleId: target.moduleId,
        encounterName: target.name,
        monsters: data.monsters,
        levelHint: asString(draft.levelHint),
      });
      if (castAdvisories.length > 0) {
        budgetAdvisory = [budgetAdvisory, ...castAdvisories]
          .filter((part) => part !== '')
          .join(' ');
      }
      await updateArtifact(
        target.id,
        {
          summary: asString(draft.summary),
          body: asString(draft.body),
          aliases,
          // The prose checkbox (two-button regeneration): a ticked redesign
          // replaces the name; otherwise the target keeps its authored name.
          ...(renamed ? { name: modelAlias } : {}),
          // Boundary re-validation also restores the encounter narrowing that
          // `data` (typed as the ArtifactData union) lost at runtime.
          data: encounterDataSchema.parse({
            ...data,
            // Identity of the artifact wins: an existing battlemap survives a
            // content regeneration untouched — including its persisted preset
            // (D10: the label describes the layout on file; only an explicit
            // Cartographer run re-tiers the map). The draft's locationKind
            // DOES re-classify: the fresh content describes the encounter.
            mapImageId: target.data.mapImageId,
            layout: reconciledLayout,
            preset: target.data.preset,
            // The layout's structure is untouched, so the target's shape
            // still holds (docs/11 D11).
            siteShape: target.data.siteShape,
            budgetAdvisory,
            // The fill grade persists: the row's own value (owner-set or an
            // earlier draw) or the one just drawn for a legacy complex.
            ...(fillGradeToPersist === undefined ? {} : { fillGrade: fillGradeToPersist }),
          }),
        },
        { source: 'persona', runId },
      );
      // Portrait preservation (docs/11 D5): re-cited roster entries converge
      // on NEW cover-less mob-artifact rows when the chunk changed
      // (re-chunked/re-imported bestiary) — the old row's cover would strand
      // as an orphan while tokens render initials. Carry covers forward
      // (same-named old row → new row, cloned bytes, old row untouched).
      // Best-effort: never fails the finalize (the helper never throws for
      // missing rows).
      await carryMobCoversForward({
        campaignId: input.campaign.id,
        oldMonsters: target.data.monsters,
        newMonsters: data.monsters,
      });
      const step = this.finishStep(
        steps[stepIndex],
        withNotice(
          { artifactId: target.id },
          null,
          budgetAdvisory === '' ? null : budgetAdvisory,
        ),
      );
      await updateRun(runId, { resultArtifactId: target.id });
      return { step, artifactId: target.id };
      }
      // In-place refill of an existing artifact by a generate persona (the
      // "use the NPC smith to correct this" flow): summary, body and the
      // draft's data are written INTO the artifact, preserving its identity —
      // name, scope, tags, links, images. The model's invented name becomes
      // an alias (nothing authored is lost), exactly like the encounter fill
      // above. The module grounding that levels this with automatic module
      // generation rides the retrieve step (targetModuleGrounding).
      if (input.persona.mode === 'generate' && target.kind === kind) {
        const modelAlias = draftName.trim();
        const aliases =
          modelAlias.toLowerCase() === target.name.trim().toLowerCase() ||
          target.aliases.some((alias) => alias.trim().toLowerCase() === modelAlias.toLowerCase())
            ? target.aliases
            : [...target.aliases, modelAlias];
        await updateArtifact(
          target.id,
          {
            summary: asString(draft.summary),
            body: asString(draft.body),
            aliases,
            // Fields the draft pipeline cannot re-produce survive the refill
            // (mergeRefillData): a player's human-owned PC fields, and an
            // existing stat block the refill declined to regenerate.
            data: mergeRefillData(kind, data, target),
          },
          { source: 'persona', runId },
        );
        const step = this.finishStep(steps[stepIndex], { artifactId: target.id });
        await updateRun(runId, { resultArtifactId: target.id });
        return { step, artifactId: target.id };
      }
      throw new Error(
        `In-place generation cannot fill "${target.name}" (${target.kind}) from a "${kind}" run`,
      );
    }
    const artifact = await createArtifact(
      {
        campaignId: input.campaign.id,
        // Creation-dialog placement (one-off): module-owned when chosen,
        // campaign level otherwise. The module tag that the stub path stamps
        // via stampModuleOwnership is deliberately not applied here — wiki
        // links resolve by moduleId, not by tag (owner-ratified risk note).
        ...(input.placementModuleId === undefined ? {} : { moduleId: input.placementModuleId }),
        kind,
        name: draftName,
        tags: Array.isArray(draft.suggestedTags) ? (draft.suggestedTags as string[]) : [],
        summary: asString(draft.summary),
        body: asString(draft.body),
        data,
      },
      { source: 'persona', runId },
    );

    // Stat-block extra is VERIFICATION-ONLY (ratified): the statblock step
    // already ran for npc personas; a null statBlock here means the draft
    // declined or the step produced nothing — the notice says so visibly,
    // never fabricating a placeholder stat block (AGENTS rule 1).
    const statblockNotice = statblockExtraNotice(kind, input.extras, data);
    // Fixed-cast advisories ride the step notice alongside the statblock
    // note (the artifact row carries them on `data.budgetAdvisory` above).
    const notice =
      [statblockNotice, fixedCastNotice].filter((part) => part !== null && part !== '').join(' ') ||
      null;

    const step = this.finishStep(
      steps[stepIndex],
      withNotice({ artifactId: artifact.id }, null, notice),
    );
    await updateRun(runId, { resultArtifactId: artifact.id });
    return { step, artifactId: artifact.id };
  }

  private finishStep(
    step: RunStep | undefined,
    output: unknown,
    status: RunStep['status'] = 'done',
  ): RunStep {
    return {
      index: step?.index ?? 0,
      name: step?.name ?? 'retrieve',
      status,
      input: step?.input ?? {},
      output,
      userEdit: step?.userEdit ?? null,
    };
  }

  private async resetStep(runId: Id, stepIndex: number): Promise<void> {
    await this.updateStep(runId, stepIndex, { status: 'pending', output: null, userEdit: null });
  }

  private async updateStep(runId: Id, stepIndex: number, patch: Partial<RunStep>): Promise<void> {
    const run = await getRun(runId);
    if (run === undefined) return;
    const steps = [...run.steps];
    const step = steps[stepIndex];
    if (step === undefined) return;
    steps[stepIndex] = { ...step, ...patch };
    await updateRun(runId, { steps });
  }

  private async fail(runId: Id, error: unknown): Promise<void> {
    this.draftRetried.delete(runId);
    this.sourceRepaired.delete(runId);
    this.encounterSchematics.delete(runId);
    this.encounterLayoutVariants.delete(runId);
    useProgressStore.getState().finish(encounterProgressId(runId));
    this.statblockRetried.delete(runId);
    if (error instanceof MissingApiKeyError) {
      toastError('No API key — add one in Settings', error);
      await updateRun(runId, {
        status: 'failed',
        errorMessage: error.message,
        failureKind: failureKindOf(error),
      });
      this.emit({ kind: 'run', runId, status: 'failed' });
      return;
    }
    const message = errorMessage(error);
    toastError(message, error);
    try {
      // The kind annotates the message (docs/05 run views) — the raw text
      // above stays verbatim and is what the user sees first.
      await updateRun(runId, {
        status: 'failed',
        errorMessage: message,
        failureKind: failureKindOf(error),
      });
    } finally {
      this.emit({ kind: 'run', runId, status: 'failed' });
    }
  }
}

function encounterProgressId(runId: Id): string {
  return `encounter-map-${runId}`;
}

function encounterStepDetail(name: StepName): string {
  const labels: Partial<Record<StepName, string>> = {
    brief: 'Drafting the encounter brief…',
    'vision-map': 'Painting the labeled map and locating rooms…',
    layout: 'Packing rooms into the map grid…',
    schematic: 'Rendering layout reference…',
    stylize: 'Generating candidate battlemaps…',
    pick: 'Waiting for a map selection…',
    finalize: 'Saving the encounter and map…',
  };
  return labels[name] ?? `Running ${name}…`;
}

/** The engine singleton used by the persona panel. */
export const runEngine = new RunEngine();
