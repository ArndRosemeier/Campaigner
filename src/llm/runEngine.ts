import type {
  AnyArtifact,
  ArtifactData,
  ArtifactKind,
  Autonomy,
  Campaign,
  EncounterLayout,
  EncounterMapAspect,
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
  encounterDataSchema,
  encounterLayoutSchema,
  encounterLocationKindSchema,
  entranceMarkerConfig,
  moduleDocumentText,
  newId,
  packRooms,
  renderSchematic,
  resolveEncounterPreset,
  schematicCellPx,
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
import { getOrCreateMobArtifact } from '@/db/mobArtifacts';
import { createImage, deleteUnreferencedImages, getImage } from '@/db/imageRepo';
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
  checkRoomBudget,
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
import { normalizeImageAspect } from '@/lib/imageAspect';
import { surroundingParagraphs } from '@/lib/wikilinks';

type ContinuityReport = z.infer<typeof continuityReportSchema>;
import { searchRules } from '@/search';
import { debugLog } from '@/lib/debug';
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
};

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
  | EncounterStepName;

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
 * `dropInlineStats` (regenerate mode): the roster is replaced verbatim from
 * the target encounter right after validation, stat sources included, so
 * embedded `statBlock`/`sourceChunkIndex`/`sourceName` fields carry no
 * information and are stripped before the schema runs — the model echoing a
 * stub block there must not fail the map over data the contract discards.
 * Fresh runs keep strict validation: their inline stat blocks become the
 * artifact's source data.
 */
function parseEncounterBrief(
  raw: string,
  opts: { dropInlineStats?: boolean } = {},
): { brief: EncounterGeneratorBrief; issues: [] } | { brief: null; issues: string[] } {
  let json: unknown;
  try {
    json = parseJsonReply(raw);
  } catch (error) {
    return { brief: null, issues: [parseErrorSummary(error)] };
  }
  if (opts.dropInlineStats === true && json !== null && typeof json === 'object' && Array.isArray((json as { monsters?: unknown }).monsters)) {
    const record = json as { monsters: unknown[] };
    // The strip drops only stat-source fields: mob `treasure` is data the
    // contract keeps (the roster contract asks for it verbatim).
    record.monsters = record.monsters.map((monster) =>
      monster !== null && typeof monster === 'object'
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

/** Draft fields are schema-validated strings; coerce defensively. */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
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
      useProgressStore.getState().start(
        encounterProgressId(run.id),
        'Generating encounter map',
        'Drafting the encounter brief…',
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
      if (targetStep.name === 'layout') this.effectiveEncounterLayout(run.steps);
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
      if (targetStep.name === 'layout') this.effectiveEncounterLayout(preview);
    }
    await this.updateStep(runId, stepIndex, { userEdit, status: 'approved' });
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
            ? [...ENCOUNTER_STEP_NAMES]
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
        return input.persona.mode === 'encounter'
          ? this.runEncounterFinalize(runId, stepIndex, steps, input)
          : this.runFinalize(runId, stepIndex, steps, input);
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

  private effectiveEncounterBrief(steps: readonly RunStep[]): {
    parsed: EncounterGeneratorBrief;
    aspect: EncounterMapAspect;
    preset: EncounterPreset;
    statblockChunkIds: Id[];
    rosterChunkByName: Record<string, Id>;
  } {    const step = steps.find((candidate) => candidate.name === 'brief');
    const effective = step?.userEdit ?? step?.output;
    if (effective === null || effective === undefined || typeof effective !== 'object') {
      throw new Error('Encounter run has no approved brief');
    }
    const value = effective as {
      parsed?: unknown;
      aspect?: unknown;
      preset?: unknown;
      statblockChunkIds?: unknown;
      rosterChunkByName?: unknown;
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
      statblockChunkIds: Array.isArray(value.statblockChunkIds)
        ? value.statblockChunkIds.filter((id): id is Id => typeof id === 'string')
        : [],
      rosterChunkByName: sanitizeChunkByName(value.rosterChunkByName),
    };
  }

  private effectiveEncounterLayout(steps: readonly RunStep[]): EncounterLayout {
    const step = steps.find((candidate) => candidate.name === 'layout');
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
    if (targetRoster?.length === 0) {
      throw new Error(
        'This encounter has no monsters yet, so there is no roster to design a map around. ' +
          'Generate its content first (artifact editor → "Generate with AI") or add monsters manually.',
      );
    }
    // Regenerate mode keeps the roster verbatim INCLUDING mob treasure: a
    // map run replaces layout + room keys, never the encounter-scoped
    // treasure authored on the entries (owner-ratified D1 extension).
    const rosterContract = targetRoster !== undefined
      ? `Regeneration target roster — reply with these EXACT entries, same order, same names, counts and treasure (name/count/notes/treasure; emit null for sourceChunkIndex, sourceName and statBlock — the existing encounter's stat sources are preserved automatically): ${JSON.stringify(
          targetRoster.map((monster) => ({
            name: monster.name,
            count: monster.count,
            notes: monster.notes,
            treasure: monster.treasure,
          })),
        )}`
      : 'Design a concrete monster roster appropriate to the requested difficulty.';
    const monsterFieldSpec = targetRoster !== undefined
      ? 'monsters [{name,count,notes,treasure}] (the target roster copied verbatim)'
      : 'monsters [{name,count,notes,treasure,sourceChunkIndex? or sourceName? or statBlock?}]';
    const inlineStatHint = targetRoster === undefined && retrieval.statblockChunkIds.length === 0
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
    const contract = [
      input.brief,
      groundingSection,
      `Campaign: ${input.campaign.name} (${GAME_SYSTEM_LABELS[input.campaign.system]})`,
      `Map aspect: ${aspect}`,
      // Site-shape branch (docs/11 D11): the brief must commit to ONE arena
      // (exactly 1 room, no corridors) or a real dungeon complex (4–10
      // rooms) — 2–3-room briefs are repair-rejected at this boundary. The
      // Dungeon preset clause extends the D10 bias with the per-room
      // challenge contract.
      preset === 'dungeon'
        ? 'Preset: Dungeon — design a connected dungeon complex of 4–10 rooms (never 2–3): distinct chambers joined by corridors, with the entry room as the party\'s way in, and EACH ROOM must alone challenge the party (its own targetLevel).'
        : 'Preset: Standard — design ONE battle arena: exactly one room, no corridors between rooms, with the entry room as the party\'s way in.',
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
    // advisory (no Paizo numbers ship — roomBudget.ts).
    const budgetMode = roomBudgetMode(input.campaign.system);
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
     * level through its citation/inline source; regenerate runs resolve
     * through the TARGET roster's persisted sources (the brief's roster is
     * verbatim-target and carries no sources of its own).
     */
    const budgetVerdicts = async (
      brief: EncounterGeneratorBrief,
    ): Promise<ReturnType<typeof checkRoomBudget>[]> => {
      const freshLevels =
        targetRoster === undefined
          ? resolveBriefMonsterLevels(brief.monsters, {
              chunkById,
              rosterChunkByName: retrieval.rosterChunkByName,
              statblockChunkIds: retrieval.statblockChunkIds,
            })
          : undefined;
      const entryLevels =
        targetRoster === undefined
          ? undefined
          : await resolveEntryLevels(targetRoster, {
              chunkById,
              getArtifactStatBlock: async (artifactId) => {
                const artifact = await getAnyArtifact(artifactId);
                if (artifact?.kind !== 'npc') return null;
                return artifact.data.statBlock;
              },
            });
      const creatures = brief.rooms.map((room) =>
        room.monsterIndexes.map((monsterIndex) => {
          const monster = brief.monsters[monsterIndex];
          return {
            name: monster?.name ?? `roster entry ${String(monsterIndex)}`,
            count: monster?.count ?? 0,
            level: targetRoster === undefined ? freshLevels?.[monsterIndex] : entryLevels?.[monsterIndex],
          };
        }),
      );
      return brief.rooms.map((room, roomIndex) =>
        checkRoomBudget({
          roomIndex,
          roomName: room.name,
          targetLevel: room.targetLevel,
          creatures: creatures[roomIndex] ?? [],
        }),
      );
    };
    /**
     * Shape + budget evaluation. `final` marks the post-repair pass: the
     * bounded retry has been spent, so an over-budget room ships with its
     * target lowered one step (floor 1) and the LOUD advisory instead of
     * re-triggering repair — never a failed run.
     */
    const evaluate = async (
      reply: string,
      final: boolean,
    ): Promise<{
      brief: EncounterGeneratorBrief | null;
      issues: string[];
      advisory: string | null;
    }> => {
      const result = parseEncounterBrief(reply, { dropInlineStats: targetRoster !== undefined });
      if (result.brief === null) return { ...result, advisory: null };
      const brief = result.brief;
      if (targetRoster !== undefined) {
        if (brief.monsters.length !== targetRoster.length) {
          return {
            brief: null,
            advisory: null,
            issues: [
              `monsters: the target roster has exactly ${String(targetRoster.length)} entries — copy it verbatim in the same order (your reply listed ${String(brief.monsters.length)})`,
            ],
          };
        }
        const coverage = encounterCoverageIssues(brief, targetRoster.length);
        if (coverage.length > 0) return { brief: null, issues: coverage, advisory: null };
      } else {
        const sourceIssues = encounterSourceIssues(
          brief.monsters,
          retrieval.statblockChunkIds,
          retrieval.rosterChunkByName,
        );
        if (sourceIssues.length > 0) return { brief: null, issues: sourceIssues, advisory: null };
        const coverage = encounterCoverageIssues(brief, brief.monsters.length);
        if (coverage.length > 0) return { brief: null, issues: coverage, advisory: null };
      }
      // Site-shape dichotomy (docs/11 D11): 1 room (single arena) or 4–10
      // rooms (complex). 2–3 rooms are a repairable issue — the prompt
      // states the exact shape contract.
      if (brief.rooms.length !== 1 && brief.rooms.length < 4) {
        return {
          brief: null,
          advisory: null,
          issues: [
            `rooms: an encounter is either a single arena (exactly 1 room) or a dungeon complex (4–10 rooms) — your reply listed ${String(brief.rooms.length)} rooms`,
          ],
        };
      }
      const stamped = stampTargetLevels(brief);
      if (budgetMode === 'verbatim') {
        // pf2e: no numeric budget ships (Paizo licensing) — the advisory is
        // the deterministic, always-loud replacement.
        return { brief: stamped, issues: [], advisory: PF2E_BUDGET_ADVISORY };
      }
      const verdicts = await budgetVerdicts(stamped);
      const unverified = verdicts.filter((verdict) => verdict.status === 'unverified');
      const over = verdicts.filter((verdict) => verdict.status === 'over');
      if (over.length === 0) {
        const advisories = unverified
          .map((verdict) => verdict.advisory)
          .filter((advisory): advisory is string => advisory !== null);
        return {
          brief: stamped,
          issues: [],
          advisory: advisories.length === 0 ? null : advisories.join(' '),
        };
      }
      if (!final) {
        return {
          brief: null,
          advisory: null,
          issues: over.map((verdict) => verdict.issue ?? '').filter((issue) => issue !== ''),
        };
      }
      // Final pass: lower each over-budget room a step (floor 1) — the
      // documented loop's deterministic tail — and ship the loud advisory.
      const loweredTargets = new Map<number, number>(
        over.flatMap((verdict) =>
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
      const statHintForRepair = targetRoster === undefined && evaluated.issues.some((issue) => issue.includes('statBlock'))
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
    if (targetRoster !== undefined) {
      // Regenerate mode replaces the roster with the target's verbatim
      // entries — mob treasure included (the brief was told to copy it
      // verbatim; the target's own values win over any model drift).
      parsed = {
        ...parsed,
        monsters: targetRoster.map((monster) => ({
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
    return {
      step: this.finishStep(
        steps[stepIndex],
        withNotice(
          {
            parsed,
            aspect,
            preset,
            statblockChunkIds: retrieval.statblockChunkIds,
            rosterChunkByName: retrieval.rosterChunkByName,
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

  private runEncounterSchematic(
    runId: Id,
    stepIndex: number,
    steps: RunStep[],
  ): { step: RunStep } {
    const layout = this.effectiveEncounterLayout(steps);
    const schematic = encounterRunAdapters.renderSchematic(layout, schematicCellPx(layout));
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
    const { parsed } = this.effectiveEncounterBrief(steps);
    const schematic = this.encounterSchematics.get(runId) ?? encounterRunAdapters.renderSchematic(layout, schematicCellPx(layout));
    this.encounterSchematics.set(runId, schematic);

    // Entrance marker (entrance/exit spawn zones, doc 11): the SCHEMATIC
    // paints the wall gap, landing pad and one neon triangle (drawEntrance),
    // and the stylize prompt asks the image model to keep them — decoration
    // only, nothing is ever detected or read back (D7; marker-path deletion
    // record in docs/11). Declared only when the layout carries an entrance
    // AND a free canonical hue exists (rooms consume the palette in order).
    const spawnLayoutRoom = layout.rooms.find((room) => room.spawn);
    const entranceConfig =
      spawnLayoutRoom?.entrance !== undefined
        ? entranceMarkerConfig(layout.rooms.length)
        : null;
    const entranceClause =
      spawnLayoutRoom === undefined || entranceConfig === null
        ? null
        : `Entrance marker: The party enters the map through a single open gap in the entry room's outer wall. On the floor just inside that gap the reference image shows exactly one solid neon ${entranceConfig.colorName} triangle with a thick black outline, pointing into the room — keep it. The entrance triangle never has a disc or a plaque.`;

    const prompt = [
      `Top-down orthographic RPG battlemap, flat vertical overhead view. Theme: ${parsed.theme}.`,
      parsed.styleNotes,
      'Environment materials: desaturated stone, wood, dirt. Water is dark navy, never cyan. Fungus is olive. Metal is bronze or rust, never yellow.',
      entranceClause,
      'Keep walls, openings, the entrance gap and overall structure exactly as in the reference image.',
      'No title banner, no compass rose, no map legend, no scale bar, no grid lines, no text labels, no characters, no monsters, no tokens, no miniatures.',
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

  private async runEncounterFinalize(
    runId: Id,
    stepIndex: number,
    steps: RunStep[],
    input: StartRunInput,
  ): Promise<{ step: RunStep; artifactId: Id }> {
    const { parsed, statblockChunkIds, rosterChunkByName } = this.effectiveEncounterBrief(steps);
    const pick = steps.find((step) => step.name === 'pick');
    const selected = (pick?.userEdit as { keep?: Id[] } | null | undefined)?.keep?.[0];
    if (selected === undefined) throw new Error('Encounter finalize has no selected battlemap');
    const layout = this.effectiveEncounterLayout(steps);
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
      // The re-anchor + content write commit as ONE attach-seam
      // transaction: a crash between the two used to strand a
      // library-scoped unreferenced image while the artifact kept the old
      // map (docs/18 known debt, now closed).
      await attachImagesToArtifact(target.id, {
        appendImageIds: [selected],
        // Only a global target re-anchors its kept image (D2/D9): omitting
        // the key leaves campaign anchors untouched.
        ...(target.campaignId === null ? { anchorImagesTo: null } : {}),
        // Regenerate never touches the cover: keep the existing value, or
        // omit the key when there is none (never an explicit null clear).
        ...(target.coverImageId == null ? {} : { coverImageId: target.coverImageId }),
        data: {
          ...target.data,
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
        },
        meta: { source: 'persona', runId },
      });
      artifactId = target.id;
    } else {
      // Mob artifacts (owner-ratified): a rulebook citation gets ONE
      // image-able npc artifact per campaign per chunkId — roster name +
      // the data.monsterChunkId marker, NO stat duplication (the chunk
      // stays the source of truth). The entry stamps mobArtifactId so
      // seeding pins shared token identity + the portrait path.
      const mobArtifacts = new Map<Id, Id>();
      const monsters: MonsterEntry[] = [];
      for (const monster of parsed.monsters) {
        // M-B (§7) resolution precedence: cited excerpt index → cited
        // roster name → inline stat block → none.
        const chunkId = resolveEncounterMonsterSource(monster, statblockChunkIds, rosterChunkByName);
        if (chunkId === undefined) {
          monsters.push({
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
          source: { type: 'rulebook' as const, chunkId, mobArtifactId },
        });
      }
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
        },
      }, { source: 'persona', runId });
      artifactId = artifact.id;
    }
    await updateRun(runId, { resultArtifactId: artifactId });
    return { step: this.finishStep(steps[stepIndex], { artifactId }), artifactId };
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

  private async runFinalize(
    runId: Id,
    stepIndex: number,
    steps: RunStep[],
    input: StartRunInput,
  ): Promise<{ step: RunStep; artifactId: Id }> {
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
            source: { type: 'rulebook', chunkId, mobArtifactId },
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
      data.monsters = monsters;
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
      const modelAlias = draftName.trim();
      const aliases =
        modelAlias.toLowerCase() === target.name.trim().toLowerCase() ||
        target.aliases.some((alias) => alias.trim().toLowerCase() === modelAlias.toLowerCase())
          ? target.aliases
          : [...target.aliases, modelAlias];
      // In-place fill reconciliation (docs/11 D12): `data.monsters` is the
      // NEW roster while the target's layout stays byte-identical — without
      // re-partitioning, `room.monsterIndexes` dangle/shift/skip against the
      // new roster (loud seed failure or silent wrong-room seeding). The
      // exact rules live in roomBudget.reconcileRoomAssignments: preserve by
      // name-match, append new entries round-robin, drop gone ones.
      const targetLayout = target.data.layout;
      let reconciledLayout = targetLayout;
      let budgetAdvisory = '';
      if (targetLayout !== null) {
        const assignments = reconcileRoomAssignments(
          targetLayout.rooms,
          target.data.monsters,
          data.monsters,
        );
        reconciledLayout = {
          ...targetLayout,
          rooms: targetLayout.rooms.map((room, roomIndex) => ({
            ...room,
            monsterIndexes: assignments[roomIndex]?.monsterIndexes ?? [],
          })),
        };
        // The same asymmetric budget check covers in-place fills. There is
        // no repair turn at finalize (the draft is not re-rolled here), so
        // over-budget rooms get the loop's deterministic tail only: the
        // target lowered a step (floor 1) and the LOUD advisory persisted —
        // never silent, never a failed run.
        const hintLevel = parseRosterTargetLevel(asString(draft.levelHint));
        const stampedRooms = reconciledLayout.rooms.map((room) => ({
          ...room,
          ...(room.targetLevel === undefined && hintLevel !== undefined
            ? { targetLevel: hintLevel }
            : {}),
        }));
        reconciledLayout = { ...reconciledLayout, rooms: stampedRooms };
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
        const verdicts = stampedRooms.map((room, roomIndex) =>
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
      await updateArtifact(
        target.id,
        {
          summary: asString(draft.summary),
          body: asString(draft.body),
          aliases,
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
          }),
        },
        { source: 'persona', runId },
      );
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

    const step = this.finishStep(
      steps[stepIndex],
      withNotice({ artifactId: artifact.id }, null, statblockNotice),
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
