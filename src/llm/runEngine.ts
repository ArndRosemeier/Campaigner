import type {
  ArtifactData,
  ArtifactKind,
  Autonomy,
  Campaign,
  EncounterLayout,
  EncounterMapAspect,
  Id,
  Persona,
  PersonaRun,
  ReasoningEffort,
  RunStep,
  Settings,
  StatBlock,
} from '@/domain';
import {
  CANONICAL_ROOM_MARKERS,
  detectNeonMarkers,
  encounterDataSchema,
  encounterLayoutSchema,
  extractImageData,
  layoutFromStagingMarkers,
  newId,
  packRooms,
  renderSchematic,
  type StagingRoomInput,
} from '@/domain';
import {
  createArtifact,
  getAnyArtifact,
  listArtifactsByCampaign,
  listArtifactsByIds,
  listGlobalArtifacts,
  updateArtifact,
} from '@/db/artifactRepo';
import { getChunksByIds } from '@/db/chunkRepo';
import { createImage, deleteUnreferencedImages, getImage, reanchorImages } from '@/db/imageRepo';
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
import { collectPackRosterWithRetry, formatRosterSection, parseRosterTargetLevel } from '@/llm/encounterRoster';
import { listRulebooks } from '@/db/rulebookRepo';
import { getSettings } from '@/db/settingsRepo';
import { GAME_SYSTEM_LABELS } from '@/domain/gameSystem';
import { statBlockSchema } from '@/domain/statblock';
import { ZodError, z } from 'zod';
import { chat, MissingApiKeyError, OpenRouterError, type ChatFallback, type ChatMessage, type ChatOptions } from '@/llm/openrouter';
import { getCachedModels } from '@/llm/modelCache';
import { generateImages } from '@/llm/imageGen';
import { formatZodIssues, parseErrorSummary, parseJsonReply } from '@/llm/jsonReply';
import { resolveChatModel, repairModel, visionRepairModel } from '@/llm/modelFallback';
import { assembleImagePrompt, draftImagePrompt } from '@/llm/imagePromptDraft';
import { intakeImage } from '@/lib/imageIntake';
import {
  encounterDraftSchema,
  encounterGeneratorBriefSchema,
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
import { verifyEncounterMap } from '@/llm/encounterVision';

type ContinuityReport = z.infer<typeof continuityReportSchema>;
import { searchRules } from '@/search';
import { debugLog } from '@/lib/debug';
import { mapWithConcurrency } from '@/lib/parallel';
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
  verifyEncounterMap,
  blobToDataUrl,
  detectNeonMarkers,
  extractImageData,
  layoutFromStagingMarkers,
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

/** The persisted retrieve-step output the draft/statblock steps re-consume
 * (see contextFromRetrieveStep) — zod-validated when read back. */
const storedRetrieveOutputSchema = z.object({
  chunkIds: z.array(z.string()),
  statblockChunkIds: z.array(z.string()).default([]),
  rosterChunkByName: z.record(z.string(), z.string()).default({}),
  rosterLines: z.array(z.string()).default([]),
  rosterTruncated: z.number().default(0),
  // 15-GRAPH-RETRIEVAL: the derived campaign-grounding blocks, persisted so
  // the draft renders them byte-identically without re-derivation (additive
  // field; older runs read back as []).
  expansionExcerpts: z.array(expansionExcerptSchema).default([]),
});

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
  /** 15-GRAPH-RETRIEVAL: the derived campaign-grounding blocks (already
   * budget-truncated by the derivation). The draft renders them verbatim;
   * the statblock step never does. */
  expansionExcerpts: ExpansionExcerpt[];
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

const ENCOUNTER_STEP_NAMES = [
  'brief',
  'layout',
  'schematic',
  'stylize',
  'verify',
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
 * (AGENTS rule 1).
 */
function escalationNotice(fallback: ChatFallback): string {
  const why = fallback.reason === 'filter' ? 'refused the content' : 'was congested';
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
}

function draftContractFor(kind: ArtifactKind): DraftContract {
  switch (kind) {
    case 'pc':
      return { schema: pcDraftSchema, keys: Object.keys(pcDraftSchema.shape) };
    case 'npc':
      return { schema: npcDraftSchema, keys: Object.keys(npcDraftSchema.shape) };
    case 'location':
      return { schema: locationDraftSchema, keys: Object.keys(locationDraftSchema.shape) };
    case 'faction':
      return { schema: factionDraftSchema, keys: Object.keys(factionDraftSchema.shape) };
    case 'note':
      return { schema: noteDraftSchema, keys: Object.keys(noteDraftSchema.shape) };
    case 'encounter':
      return { schema: encounterDraftSchema, keys: Object.keys(encounterDraftSchema.shape) };
    case 'plotarc':
      return { schema: plotArcDraftSchema, keys: Object.keys(plotArcDraftSchema.shape) };
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
          ? (draft.monsters as { name: string; count: number; notes: string }[]).map((monster) => ({
              ...monster,
              // Finalize replaces these with cited/inline sources (M3-B).
              source: { type: 'none' } as const,
            }))
          : [],
        terrain: asString(draft.terrain),
        tactics: asString(draft.tactics),
        treasure: asString(draft.treasure),
        mapImageId: null,
        layout: null,
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
    record.monsters = record.monsters.map((monster) =>
      monster !== null && typeof monster === 'object'
        ? {
            name: (monster as { name?: unknown }).name,
            count: (monster as { count?: unknown }).count,
            notes: (monster as { notes?: unknown }).notes,
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
    await updateRun(runId, { status: 'running', errorMessage: '' });
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
        // output failed validation (draft, statblock, check, prompt-draft)
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
          await updateRun(runId, { status: 'failed', errorMessage: reason, steps: [...steps] });
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
        return this.runPromptDraft(runId, stepIndex, steps, input, signal, extraInstruction);
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
      case 'verify':
        return this.runEncounterVerify(runId, stepIndex, steps, input, signal);
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
      const expansionExcerpts = await this.campaignGroundingFor(input);
      return {
        chunkIds: merged,
        titles,
        excerpts,
        statblockChunkIds,
        statblockTitles,
        rosterLines,
        rosterTruncated,
        rosterChunkByName,
        expansionExcerpts,
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
   */
  private async campaignGroundingFor(input: StartRunInput): Promise<ExpansionExcerpt[]> {
    const settings = await getSettings();
    if (!settings.wikiGroundingEnabled) return [];
    const [modules, campaignArtifacts, globalArtifacts] = await Promise.all([
      listModulesByCampaign(input.campaign.id),
      listArtifactsByCampaign(input.campaign.id),
      listGlobalArtifacts(),
    ]);
    return computeCampaignGrounding({
      brief: input.brief,
      modules,
      pool: [...campaignArtifacts, ...globalArtifacts],
    });
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
      // 15-GRAPH-RETRIEVAL: the campaign-grounding blocks persist with the
      // selection so the draft renders the stored ones byte-identically —
      // nothing re-derives the graph at draft time.
      expansionExcerpts: context.expansionExcerpts,
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
      expansionExcerpts: output.expansionExcerpts,
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
    const instruction = [
      `Campaign: ${input.campaign.name} (${GAME_SYSTEM_LABELS[input.campaign.system]})${input.campaign.description === '' ? '' : ` — ${input.campaign.description}`}`,
      `Task: ${input.brief}`,
      groundingSection,
      contextSection,
      context.excerpts === ''
        ? 'No rule excerpts available.'
        : `Rule excerpts:\n${context.excerpts}`,
      buildStatblockCitationSection(context.statblockTitles),
      formatRosterSection(context.rosterLines, context.rosterTruncated),
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
        responseFormat: 'json',
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
      withNotice({ parsed }, fallback, contractRepairNotice(firstTryModel, repairTarget)),
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
        responseFormat: 'json',
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
        responseFormat: 'json',
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
   * LLM output; both are `{ parsed: {prompt, negative, styleNotes} }`.
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

  private effectiveEncounterBrief(steps: readonly RunStep[]): {
    parsed: EncounterGeneratorBrief;
    aspect: EncounterMapAspect;
    statblockChunkIds: Id[];
    rosterChunkByName: Record<string, Id>;
  } {
    const step = steps.find((candidate) => candidate.name === 'brief');
    const effective = step?.userEdit ?? step?.output;
    if (effective === null || effective === undefined || typeof effective !== 'object') {
      throw new Error('Encounter run has no approved brief');
    }
    const value = effective as {
      parsed?: unknown;
      aspect?: unknown;
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
    const context = await loadContextArtifacts(input.contextArtifactIds ?? []);
    const retrieval = await this.retrieveContext(runId, input);
    const targetRoster = target?.kind === 'encounter' ? target.data.monsters : undefined;
    if (targetRoster?.length === 0) {
      throw new Error(
        'This encounter has no monsters yet, so there is no roster to design a map around. ' +
          'Generate its content first (artifact editor → "Generate with AI") or add monsters manually.',
      );
    }
    const rosterContract = targetRoster !== undefined
      ? `Regeneration target roster — reply with these EXACT entries, same order, same names and counts (name/count/notes only; never add sourceChunkIndex, sourceName or statBlock, the existing encounter's stat sources are preserved automatically): ${JSON.stringify(
          targetRoster.map((monster) => ({
            name: monster.name,
            count: monster.count,
            notes: monster.notes,
          })),
        )}`
      : 'Design a concrete monster roster appropriate to the requested difficulty.';
    const monsterFieldSpec = targetRoster !== undefined
      ? 'monsters [{name,count,notes}] (the target roster copied verbatim)'
      : 'monsters [{name,count,notes,sourceChunkIndex? or sourceName? or statBlock?}]';
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
      rosterContract,
      context.length === 0 ? null : `Context: ${JSON.stringify(context)}`,
      retrieval.excerpts === '' ? null : `Retrieved rules:\n${retrieval.excerpts}`,
      buildStatblockCitationSection(retrieval.statblockTitles),
      formatRosterSection(retrieval.rosterLines, retrieval.rosterTruncated),
      extraInstruction === '' ? null : `Additional instruction: ${extraInstruction}`,
      inlineStatHint,
      `Reply with JSON only using every field: name, summary, body, difficulty, levelHint, terrain, tactics, treasure, theme, styleNotes, negative, environment ("dungeon" | "outdoor"), ${monsterFieldSpec}, rooms [{name,description,size:"small"|"medium"|"large",monsterIndexes:number[],adjacentRoomIndexes:number[]}] (1–10 rooms), entryRoomIndex. Every monster index belongs to exactly one room. Rooms form one connected graph. Do not emit coordinates.`,
    ].filter((part) => part !== null).join('\n\n');
    const messages: ChatMessage[] = [
      { role: 'system', content: input.persona.systemPrompt },
      { role: 'user', content: contract },
    ];
    const chatOptions = {
      model: resolveChatModel(settings, input.persona.model),
      temperature: input.persona.temperature,
      reasoningEffort: effectiveReasoningEffort(input.persona, settings),
      responseFormat: 'json' as const,
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
    const evaluate = (reply: string): { brief: EncounterGeneratorBrief | null; issues: string[] } => {
      const result = parseEncounterBrief(reply, { dropInlineStats: targetRoster !== undefined });
      if (result.brief === null) return result;
      if (targetRoster !== undefined) {
        if (result.brief.monsters.length !== targetRoster.length) {
          return {
            brief: null,
            issues: [
              `monsters: the target roster has exactly ${String(targetRoster.length)} entries — copy it verbatim in the same order (your reply listed ${String(result.brief.monsters.length)})`,
            ],
          };
        }
        const coverage = encounterCoverageIssues(result.brief, targetRoster.length);
        return coverage.length === 0 ? result : { brief: null, issues: coverage };
      }
      const sourceIssues = encounterSourceIssues(
        result.brief.monsters,
        retrieval.statblockChunkIds,
        retrieval.rosterChunkByName,
      );
      if (sourceIssues.length > 0) return { brief: null, issues: sourceIssues };
      const coverage = encounterCoverageIssues(result.brief, result.brief.monsters.length);
      return coverage.length === 0 ? result : { brief: null, issues: coverage };
    };
    const first = await chat(messages, chatOptions);
    let raw = first.text;
    let fallback = first.fallback;
    // The contract-repair model: the escalation tier when configured (the
    // step notice records the escalation only when it actually differed).
    let briefRepairTarget = chatOptions.model;
    let evaluated = evaluate(raw);
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
      evaluated = evaluate(raw);
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
      parsed = {
        ...parsed,
        monsters: targetRoster.map((monster) => ({
          name: monster.name,
          count: monster.count,
          notes: monster.notes,
        })),
      };
    }
    return {
      step: this.finishStep(
        steps[stepIndex],
        withNotice(
          {
            parsed,
            aspect,
            statblockChunkIds: retrieval.statblockChunkIds,
            rosterChunkByName: retrieval.rosterChunkByName,
          },
          fallback,
          contractRepairNotice(chatOptions.model, briefRepairTarget),
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
    const { parsed, aspect } = this.effectiveEncounterBrief(steps);
    const roomIds = parsed.rooms.map(() => newId());
    const entryRoomId = roomIds[parsed.entryRoomIndex];
    if (entryRoomId === undefined) throw new Error('Encounter brief has no valid entry room');
    const layout = packRooms({
      theme: parsed.theme,
      aspect,
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
    const schematic = encounterRunAdapters.renderSchematic(layout, 96);
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
    const { parsed, aspect } = this.effectiveEncounterBrief(steps);
    const schematic = this.encounterSchematics.get(runId) ?? encounterRunAdapters.renderSchematic(layout, 96);
    this.encounterSchematics.set(runId, schematic);

    const defaultMarker = CANONICAL_ROOM_MARKERS[0] ?? {
      letter: 'A',
      hue: 300,
      colorName: 'magenta',
      label: 'Room A',
    };
    const markerInstructions = parsed.rooms
      .map((room, idx) => {
        const marker = CANONICAL_ROOM_MARKERS[idx] ?? defaultMarker;
        return `Room ${marker.letter} ("${room.name}"): solid neon ${marker.colorName} disc on open floor with small black plaque labeled "${marker.letter}" beside it.`;
      })
      .join(' ');

    const prompt = [
      `Top-down orthographic RPG battlemap, flat vertical overhead view. Theme: ${parsed.theme}.`,
      parsed.styleNotes,
      'Environment materials: desaturated stone, wood, dirt. Water is dark navy, never cyan. Fungus is olive. Metal is bronze or rust, never yellow.',
      'Room staging markers: Each room has exactly one solid circular neon disc on the open floor (approx 1/10th room diameter) with thick black outline, plus a small black plaque with white capital letter immediately to the right.',
      markerInstructions,
      'Keep walls, openings and overall structure aligned with the staging markers.',
      'No title banner, no compass rose, no map legend, no scale bar, no grid lines, no text labels other than the room plaques, no characters, no monsters, no tokens, no miniatures.',
      parsed.negative === '' ? null : `Avoid: ${parsed.negative}`,
    ].filter((part) => part !== null && part !== '').join(' ');
    const generated = await encounterRunAdapters.generateImages(prompt, input.unattended === true ? 1 : 2, {
      model: settings.imageModel,
      signal,
      inputReferences: [{ dataUrl: schematic.dataUrl }],
    });
    const imageIds: Id[] = [];
    const aspectActions: ('none' | 'letterboxed')[] = [];
    const candidateLayouts: Record<Id, EncounterLayout> = {};

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

      // Attempt procedural neon detection from research
      try {
        const imgData = await encounterRunAdapters.extractImageData(normalized.blob);
        if (imgData !== null) {
          const targets = parsed.rooms.map((room, idx) => {
            const marker = CANONICAL_ROOM_MARKERS[idx] ?? defaultMarker;
            return {
              id: layout.rooms[idx]?.id ?? newId(),
              letter: marker.letter,
              hue: marker.hue,
              name: room.name,
            };
          });
          const detection = encounterRunAdapters.detectNeonMarkers(imgData, targets);
          if (detection.detected.length > 0) {
            const stagingRooms: StagingRoomInput[] = parsed.rooms.map((room, idx) => {
              const target = targets[idx] ?? {
                id: layout.rooms[idx]?.id ?? newId(),
                letter: 'A',
                hue: 300,
                name: room.name,
              };
              const found = detection.detected.find((d) => d.id === target.id);
              const fallbackRoom = layout.rooms[idx];
              const fallbackX = fallbackRoom ? (fallbackRoom.mobsRect.x + fallbackRoom.mobsRect.w / 2) / layout.gridW : 0.5;
              const fallbackY = fallbackRoom ? (fallbackRoom.mobsRect.y + fallbackRoom.mobsRect.h / 2) / layout.gridH : 0.5;
              return {
                id: target.id,
                name: room.name,
                description: room.description,
                monsterIndexes: room.monsterIndexes,
                spawn: idx === parsed.entryRoomIndex,
                letter: target.letter,
                markerHue: target.hue,
                markerColorName: CANONICAL_ROOM_MARKERS[idx]?.colorName ?? 'magenta',
                stagingPoint: found ? { x: found.x, y: found.y } : { x: fallbackX, y: fallbackY },
              };
            });
            candidateLayouts[stored.id] = encounterRunAdapters.layoutFromStagingMarkers({
              aspect,
              theme: parsed.theme,
              rooms: stagingRooms,
              rosterCounts: parsed.monsters.map((m) => m.count),
            });
          }
        }
      } catch (err) {
        debugLog('encounter', 'Neon detection candidate processing error', err);
      }
    }
    return {
      step: this.finishStep(steps[stepIndex], {
        imageIds,
        aspectActions,
        candidateLayouts,
        costUsd: generated.costUsd,
        cappedToOne: generated.cappedToOne,
      }),
    };
  }

  private async runEncounterVerify(
    runId: Id,
    stepIndex: number,
    steps: RunStep[],
    input: StartRunInput,
    signal: AbortSignal,
  ): Promise<{ step: RunStep; runStatus?: PersonaRun['status'] }> {
    const settings = await getSettings();
    const layout = this.effectiveEncounterLayout(steps);
    const schematic = this.encounterSchematics.get(runId) ?? encounterRunAdapters.renderSchematic(layout, 96);
    const stylize = steps.find((step) => step.name === 'stylize')?.output as
      | { imageIds?: Id[]; candidateLayouts?: Record<Id, EncounterLayout> }
      | undefined;
    const imageIds = stylize?.imageIds ?? [];
    if (imageIds.length === 0) throw new Error('Encounter stylize step produced no map candidates');
    // Verify sends the stylized map to a *chat* model (vision call) — not the
    // image model. The dedicated setting keeps writing and vision models
    // independent; '' falls back to the default chat model.
    const verifyModel = resolveChatModel(settings, settings.encounterVerifyModel);
    // The grid-repair attempt escalates to the fallback model — but only if
    // the cached /models data knows it accepts image input.
    const verifyRepairModel = visionRepairModel(verifyModel, settings.fallbackChatModel, getCachedModels());
    // Candidates are independent: verify up to maxParallelRequests maps at
    // once. Order is preserved, so verifications[i] still corresponds to
    // imageIds[i] (the review UI maps them positionally). A missing image or
    // an unusable verify model still fails the step loudly — the pool
    // rethrows the first rejection once its in-flight siblings finish.
    const verifications = await mapWithConcurrency(
      imageIds,
      Math.max(1, settings.maxParallelRequests),
      async (imageId) => {
        const image = await getImage(imageId);
        if (image === undefined) throw new Error(`Generated map ${imageId} no longer exists`);
        const candidateLayout = stylize?.candidateLayouts?.[imageId] ?? layout;
        const stylizedDataUrl = await encounterRunAdapters.blobToDataUrl(
          new Blob([image.bytes], { type: image.mimeType }),
        );
        try {
          return await encounterRunAdapters.verifyEncounterMap({
            layout: candidateLayout,
            schematicDataUrl: schematic.dataUrl,
            stylizedDataUrl,
            model: verifyModel,
            repairModel: verifyRepairModel,
            signal,
          });
        } catch (error) {
          if (!(error instanceof OpenRouterError)) throw error;
          // A 400 is the "this model cannot even accept the request" signal —
          // point at the settings. Congestion/timeouts/refusals speak for
          // themselves (their message already says what happened) and now
          // propagate unchanged instead of masquerading as a vision problem.
          if (error.status !== 400) throw error;
          throw new Error(
            `Map verification model "${verifyModel}" cannot process images: ${error.message} ` +
              'Pick a vision-capable chat model in Settings → "Encounter map verify model" ' +
              '(its browse list only offers models that accept image input).',
            { cause: error },
          );
        }
      },
    );
    const needsReview = verifications.some((verification) => verification.needsReview);
    if (needsReview && input.autonomy === 'auto') {
      throw new Error('Generated battlemap failed the structure verification threshold');
    }
    return {
      step: this.finishStep(
        steps[stepIndex],
        { verifications },
        needsReview ? 'rejected' : 'done',
      ),
      ...(needsReview ? { runStatus: 'needs_review' as const } : {}),
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
    const stylize = steps.find((step) => step.name === 'stylize')?.output as {
      candidateLayouts?: Record<Id, EncounterLayout>;
    } | undefined;
    const layout = stylize?.candidateLayouts?.[selected] ?? this.effectiveEncounterLayout(steps);
    const target = input.targetArtifactId === undefined
      ? undefined
      : await getAnyArtifact(input.targetArtifactId);
    if (input.targetArtifactId !== undefined && target === undefined) {
      throw new Error('The encounter to regenerate no longer exists');
    }
    let artifactId: Id;
    if (target !== undefined) {
      if (target.kind !== 'encounter') throw new Error('Encounter regeneration target changed kind');
      if (target.campaignId === null) await reanchorImages([selected], null);
      const imageIds = target.imageIds.includes(selected) ? target.imageIds : [...target.imageIds, selected];
      await updateArtifact(target.id, {
        imageIds,
        data: { ...target.data, layout, mapImageId: selected },
      }, { source: 'persona', runId });
      artifactId = target.id;
    } else {
      const artifact = await createArtifact({
        campaignId: input.campaign.id,
        kind: 'encounter',
        name: parsed.name,
        summary: parsed.summary,
        body: parsed.body,
        imageIds: [selected],
        data: {
          difficulty: parsed.difficulty,
          levelHint: parsed.levelHint,
          monsters: parsed.monsters.map((monster) => {
            // M-B (§7) resolution precedence: cited excerpt index → cited
            // roster name → inline stat block → none.
            const chunkId = resolveEncounterMonsterSource(monster, statblockChunkIds, rosterChunkByName);
            return {
              name: monster.name,
              count: monster.count,
              notes: monster.notes,
              source: chunkId === undefined
                ? monster.statBlock !== undefined
                  ? { type: 'inline' as const, statBlock: monster.statBlock }
                  : { type: 'none' as const }
                : { type: 'rulebook' as const, chunkId },
            };
          }),
          terrain: parsed.terrain,
          tactics: parsed.tactics,
          treasure: parsed.treasure,
          mapImageId: selected,
          layout,
        },
      }, { source: 'persona', runId });
      artifactId = artifact.id;
    }
    await updateRun(runId, { resultArtifactId: artifactId });
    return { step: this.finishStep(steps[stepIndex], { artifactId }), artifactId };
  }

  /** Prompt-draft step (M3-A): drafts an image prompt for the target artifact. */
  private async runPromptDraft(
    runId: Id,
    stepIndex: number,
    steps: RunStep[],
    input: StartRunInput,
    signal: AbortSignal,
    extraInstruction: string,
  ): Promise<{ step: RunStep; runStatus?: PersonaRun['status'] }> {
    const settings = await getSettings();
    const targetId = input.targetArtifactId ?? null;
    const target = targetId === null ? undefined : await getAnyArtifact(targetId);
    if (target === undefined) throw new Error('the artifact to illustrate no longer exists');

    // The prompt contract (appearance shortcut, instruction text, one
    // contract-repair retry on the repair model) is shared with the entity
    // image queue — see draftImagePrompt.
    const result = await draftImagePrompt(
      { name: target.name, kind: target.kind, summary: target.summary, body: target.body, data: target.data },
      {
        model: resolveChatModel(settings, input.persona.model),
        settings,
        systemPrompt: input.persona.systemPrompt,
        systemLabel: GAME_SYSTEM_LABELS[input.campaign.system],
        contextLines: [
          `Campaign tone: ${input.campaign.name}${input.campaign.description === '' ? '' : ` — ${input.campaign.description}`}`,
          input.brief === '' ? null : `Focus: ${input.brief}`,
        ],
        extraInstruction,
        signal,
        chatOptions: (model) =>
          this.chatForStep(runId, stepIndex, {
            model,
            temperature: input.persona.temperature,
            reasoningEffort: effectiveReasoningEffort(input.persona, settings),
            responseFormat: 'json',
            signal,
          }),
      },
    );
    if (!result.ok) {
      debugLog('run', 'prompt-draft parse FAILED after retry', { issue: result.issues.join('; ') });
      const step = this.finishStep(steps[stepIndex], { raw: result.raw, issues: result.issues }, 'rejected');
      if (input.autonomy === 'auto') return { step };
      if (input.autonomy === 'manual') return { step, runStatus: 'awaiting_user' };
      return { step, runStatus: 'needs_review' };
    }

    const step = this.finishStep(
      steps[stepIndex],
      withNotice(
        { parsed: result.draft },
        result.fallback,
        contractRepairNotice(result.firstTryModel, result.repairTarget),
      ),
    );
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
    // The model capping candidates at 1 (e.g. x-ai/grok-imagine-image-2.0)
    // is a degradation the user must see (AGENTS rule 1): persist a notice
    // on the step — the run panel renders it next to the pick UI.
    const notice = generated.cappedToOne
      ? `“${generated.modelUsed}” generates one image per request — this run produced a single candidate.`
      : null;
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
    // images before they are attached to a global target (D2/D9).
    if (target.campaignId === null) await reanchorImages(kept, null);
    await updateArtifact(targetId, {
      imageIds: [...target.imageIds, ...kept],
      coverImageId: target.coverImageId ?? keep[0] ?? null,
    });

    const stepIndex = run.steps.findIndex((step) => step.name === 'pick');
    if (stepIndex !== -1) {
      await this.updateStep(runId, stepIndex, { userEdit: { keep: [...keep] }, status: 'approved' });
      this.emit({ kind: 'step', runId, stepIndex, status: 'approved' });
    }
    // Discarded candidates (from the pick step's candidate list) are pruned.
    const pickStep = run.steps[stepIndex];
    const pickOutput = (pickStep?.output ?? {}) as { candidates?: unknown };
    const candidates = Array.isArray(pickOutput.candidates)
      ? (pickOutput.candidates as Id[])
      : [];
    // Discarded candidates remain campaign-anchored. Pass only discards:
    // kept global images were re-anchored above and campaign reference scans
    // intentionally cannot see them.
    const keepIds = new Set(keep);
    await deleteUnreferencedImages(
      run.campaignId,
      candidates.filter((id) => !keepIds.has(id)),
    );
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
      const monsters: typeof data.monsters = [];
      for (const [index, monster] of data.monsters.entries()) {
        const cited = draftMonsters?.[index];
        const chunkId =
          cited === undefined
            ? undefined
            : resolveEncounterMonsterSource(cited, statblockChunkIds, rosterChunkByName);
        if (chunkId !== undefined) {
          monsters.push({
            name: monster.name,
            count: monster.count,
            notes: monster.notes,
            source: { type: 'rulebook', chunkId },
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
    if (draftName === '') {
      throw new Error(
        `finalize: the ${kind} draft has no name — refusing to create an unnamed artifact`,
      );
    }
    // Generate personas create new artifacts — except an explicitly targeted
    // encounter run (module stubs): the content is written INTO the existing
    // artifact, preserving its identity, links, images and battlemap.
    if (input.targetArtifactId !== undefined) {
      if (kind !== 'encounter') {
        throw new Error(
          `In-place generation targets encounters only — a "${kind}" run cannot fill an existing artifact`,
        );
      }
      const target = await getAnyArtifact(input.targetArtifactId);
      if (target === undefined) throw new Error('The encounter to fill no longer exists');
      if (target.kind !== 'encounter') {
        throw new Error(`"${target.name}" is not an encounter and cannot be filled in place`);
      }
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
          // Boundary re-validation also restores the encounter narrowing that
          // `data` (typed as the ArtifactData union) lost at runtime.
          data: encounterDataSchema.parse({
            ...data,
            // Identity of the artifact wins: an existing battlemap survives a
            // content regeneration untouched.
            mapImageId: target.data.mapImageId,
            layout: target.data.layout,
          }),
        },
        { source: 'persona', runId },
      );
      const step = this.finishStep(steps[stepIndex], { artifactId: target.id });
      await updateRun(runId, { resultArtifactId: target.id });
      return { step, artifactId: target.id };
    }
    const artifact = await createArtifact(
      {
        campaignId: input.campaign.id,
        kind,
        name: draftName,
        tags: Array.isArray(draft.suggestedTags) ? (draft.suggestedTags as string[]) : [],
        summary: asString(draft.summary),
        body: asString(draft.body),
        data,
      },
      { source: 'persona', runId },
    );

    const step = this.finishStep(steps[stepIndex], { artifactId: artifact.id });
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
      await updateRun(runId, { status: 'failed', errorMessage: error.message });
      this.emit({ kind: 'run', runId, status: 'failed' });
      return;
    }
    const message = errorMessage(error);
    toastError(message, error);
    try {
      await updateRun(runId, { status: 'failed', errorMessage: message });
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
    layout: 'Preparing staging layout…',
    schematic: 'Rendering layout reference…',
    stylize: 'Generating candidate battlemaps…',
    verify: 'Detecting room staging markers…',
    pick: 'Waiting for a map selection…',
    finalize: 'Saving the encounter and map…',
  };
  return labels[name] ?? `Running ${name}…`;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reject(reader.error ?? new Error('Could not read generated map'));
    };
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('Generated map did not produce a data URL'));
        return;
      }
      resolve(reader.result);
    };
    reader.readAsDataURL(blob);
  });
}

/** The engine singleton used by the persona panel. */
export const runEngine = new RunEngine();
