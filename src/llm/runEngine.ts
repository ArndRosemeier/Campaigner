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
  RunStep,
  StatBlock,
} from '@/domain';
import { encounterLayoutSchema, newId, packRooms, renderSchematic } from '@/domain';
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
import { listRulebooks } from '@/db/rulebookRepo';
import { getSettings } from '@/db/settingsRepo';
import { GAME_SYSTEM_LABELS } from '@/domain/gameSystem';
import { statBlockSchema } from '@/domain/statblock';
import type { z } from 'zod';
import { chat, MissingApiKeyError, type ChatMessage } from '@/llm/openrouter';
import { generateImages } from '@/llm/imageGen';
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
import type { EncounterGeneratorBrief, ImagePromptDraft } from '@/llm/schemas';
import { normalizeImageAspect } from '@/lib/imageAspect';
import { verifyEncounterMap } from '@/llm/encounterVision';

type ContinuityReport = z.infer<typeof continuityReportSchema>;
import { searchRules } from '@/search';
import { debugLog } from '@/lib/debug';
import { toastError } from '@/lib/toast';
import { useProgressStore } from '@/lib/progress';

/** Testable seams for browser/image work in the encounter pipeline. */
export const encounterRunAdapters = {
  renderSchematic,
  generateImages,
  normalizeImageAspect,
  intakeImage,
  verifyEncounterMap,
  blobToDataUrl,
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
  | { kind: 'token'; runId: Id; stepIndex: number; delta: string };

type Listener = (event: EngineEvent) => void;

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
 */
function buildStatblockCitationSection(statblockTitles: readonly string[]): string | null {
  if (statblockTitles.length === 0) return null;
  return [
    'Stat-block excerpts (0-based index before each):',
    ...statblockTitles.map((title, index) => `[${index}] ${title}`),
    'For each monster: if one of these stat blocks matches, add "sourceChunkIndex": <index> to that monster (referring to this numbered list); otherwise leave sourceChunkIndex out and describe the monster in notes.',
  ].join('\n');
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
        role: asString(draft.role),
        appearance: asString(draft.appearance),
        personality: asString(draft.personality),
        motivation: asString(draft.motivation),
        secrets: asString(draft.secrets),
        voiceNotes: asString(draft.voiceNotes),
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

function encounterSourcesValid(
  brief: EncounterGeneratorBrief,
  statblockChunkIds: readonly Id[],
): boolean {
  return brief.monsters.every((monster) =>
    monster.statBlock !== undefined ||
    (monster.sourceChunkIndex !== undefined && statblockChunkIds[monster.sourceChunkIndex] !== undefined),
  );
}

function parseEncounterBrief(raw: string): EncounterGeneratorBrief | null {
  try {
    return encounterGeneratorBriefSchema.parse(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

/** Draft fields are schema-validated strings; coerce defensively. */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export class RunEngine {
  private listeners = new Set<Listener>();
  private controllers = new Map<Id, AbortController>();
  private cancelRequested = new Set<Id>();
  /** JSON-parse retry state per run (one automatic fix retry per LLM step). */
  private draftRetried = new Set<Id>();
  private statblockRetried = new Set<Id>();
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
    this.cancelRequested.delete(run.id);
    if (input.persona.mode === 'encounter') {
      this.encounterLayoutVariants.set(run.id, 0);
    }
    if (input.persona.mode === 'encounter' && input.unattended !== true) {
      useProgressStore.getState().start(
        encounterProgressId(run.id),
        input.targetArtifactId === undefined ? 'Generating encounter map' : 'Regenerating encounter map',
        'Drafting the encounter brief…',
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
    // Approving a pick without a selection means "keep nothing".
    if (run.steps[target]?.name === 'pick') {
      if (input.persona.mode === 'encounter') {
        throw new Error('Select one generated battlemap before continuing');
      }
      await this.pickImages(runId, []);
      return;
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
    if (run.steps[stepIndex]?.name === 'pick') {
      const keep = (userEdit as { keep?: unknown } | null)?.keep;
      const ids = Array.isArray(keep) ? keep.filter((id): id is Id => typeof id === 'string') : [];
      if (input.persona.mode === 'encounter') {
        await this.pickEncounterMap(runId, ids, input);
      } else {
        await this.pickImages(runId, ids);
      }
      return;
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
    void this.executeFrom(runId, stepIndex, input, extraInstruction).catch((error: unknown) => {
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

    try {
      for (let i = startIndex; i < kinds.length; i += 1) {
        const name = kinds[i];
        if (name === undefined) break;
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
          const reason =
            `Step "${name}" rejected: the model reply could not be parsed into the required ` +
            `JSON shape after one automatic retry. The run failed without saving partial results — ` +
            `run it again, or use manual/review autonomy to keep the raw reply for editing.`;
          await updateRun(runId, { status: 'failed', errorMessage: reason, steps: [...steps] });
          this.draftRetried.delete(runId);
          this.statblockRetried.delete(runId);
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

  private async retrieveContext(
    input: StartRunInput,
  ): Promise<{
    chunkIds: Id[];
    titles: string[];
    excerpts: string;
    /** M3-B: statblock-only hits, in citation order (encounter personas). */
    statblockChunkIds: Id[];
    statblockTitles: string[];
  }> {
    const query = `${input.brief} (${GAME_SYSTEM_LABELS[input.campaign.system]})`;
    const hits = await searchRules(query, { limit: 8 });
    const pinned = await getChunksByIds([...input.pinnedChunkIds]);
    const merged: Id[] = [...pinned.map((chunk) => chunk.id)];
    // M3-B: the Encounter Designer gets a second search restricted to
    // statblock chunks so it can cite real bestiary entries.
    const statblockChunkIds: Id[] = [];
    if (input.persona.producesKind === 'encounter') {
      const statHits = await searchRules(query, { limit: 6, chunkTypes: ['statblock'] });
      for (const hit of statHits) {
        if (!merged.includes(hit.chunk.id)) {
          merged.push(hit.chunk.id);
          statblockChunkIds.push(hit.chunk.id);
        }
      }
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
    return { chunkIds: merged, titles, excerpts, statblockChunkIds, statblockTitles };
  }

  private async runRetrieve(
    _runId: Id,
    stepIndex: number,
    steps: RunStep[],
    input: StartRunInput,
  ): Promise<{ step: RunStep }> {
    const context = await this.retrieveContext(input);
    debugLog('run', `retrieve done: ${String(context.chunkIds.length)} chunks selected`);
    const step = this.finishStep(steps[stepIndex], {
      chunkIds: context.chunkIds,
      titles: context.titles,
      statblockChunkIds: context.statblockChunkIds,
    });
    return { step };
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
    const context = await this.retrieveContext(input);
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
    const instruction = [
      `Campaign: ${input.campaign.name} (${GAME_SYSTEM_LABELS[input.campaign.system]})${input.campaign.description === '' ? '' : ` — ${input.campaign.description}`}`,
      `Task: ${input.brief}`,
      contextSection,
      context.excerpts === ''
        ? 'No rule excerpts available.'
        : `Rule excerpts:\n${context.excerpts}`,
      buildStatblockCitationSection(context.statblockTitles),
      // M4-C: secrets and stat blocks are the generator's call, not a
      // requirement — not every character has a secret, and contacts or
      // merchants don't need stats.
      kind === 'npc'
        ? [
            'Field guidance for this NPC:',
            '- "secrets": fill ONLY when this character genuinely has a secret that matters to the story; otherwise use an empty string. Never invent one for its own sake — the GM sees everything anyway.',
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

    const raw = await chat(messages, {
      model: input.persona.model === '' ? settings.defaultChatModel : input.persona.model,
      temperature: input.persona.temperature,
      responseFormat: 'json',
      signal,
      onToken: (delta) => {
        this.emit({ kind: 'token', runId, stepIndex, delta });
      },
    });

    debugLog('run', `draft chat returned ${String(raw.length)} chars`);
    let parsed: unknown = null;
    let parseFailed = false;
    try {
      const jsonText = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
      parsed = contract.schema.parse(JSON.parse(jsonText) as unknown);
    } catch (error) {
      debugLog('run', 'draft parse FAILED — retrying with schema-fix instruction', {
        issue: error instanceof Error ? error.message : String(error),
      });
      parseFailed = true;
      const issues = error instanceof Error ? error.message : String(error);
      if (!this.draftRetried.has(runId)) {
        // One automatic JSON-fix retry (04 spec).
        debugLog('run', 'draft retrying once (automatic JSON fix)');
        this.draftRetried.add(runId);
        return this.runDraft(
          runId,
          stepIndex,
          steps,
          input,
          signal,
          `${extraInstruction === '' ? '' : `${extraInstruction}\n`}Your previous reply was invalid JSON for the schema: ${issues}. Reply with corrected JSON only.`,
        );
      }
    }

    if (parseFailed) {
      // needs_review: raw text stored, run pauses per autonomy.
      const step = this.finishStep(steps[stepIndex], { raw }, 'rejected');
      if (input.autonomy === 'manual') return { step, runStatus: 'awaiting_user' };
      if (input.autonomy === 'auto') return { step };
      return { step, runStatus: 'needs_review' };
    }

    this.draftRetried.delete(runId);
    const step = this.finishStep(steps[stepIndex], { parsed });
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
    const context = await this.retrieveContext(input);
    const instruction = [
      `Fill the StatBlock for "${asString(draft?.name) || 'the NPC'}"${levelHint === '' ? '' : ` at level ${levelHint}`}, grounded in the rule excerpts.`,
      input.brief,
      context.excerpts === ''
        ? 'No rule excerpts available.'
        : `Rule excerpts:\n${context.excerpts}`,
      `Reply with ONLY a JSON object matching this COMPLETE schema: { "system": "${input.campaign.system}", "level": string, "size": string, "creatureType": string, "ac": number, "acNote": string, "hp": number, "hpFormula": string, "speed": string, "abilities": { "str": number, "dex": number, "con": number, "int": number, "wis": number, "cha": number }, "saves": string, "skills": string, "senses": string, "languages": string, "traits": [{ "name": string, "text": string }], "actions": [{ "name": string, "text": string }], "reactions": [{ "name": string, "text": string }], "legendary": [{ "name": string, "text": string }], "extras": Record<string,string> }. Include every field; use empty strings or arrays only when a section truly does not apply.`,
      extraInstruction === '' ? null : `Additional instruction: ${extraInstruction}`,
    ]
      .filter((part) => part !== null)
      .join('\n\n');

    const raw = await chat(
      [
        { role: 'system', content: input.persona.systemPrompt },
        { role: 'user', content: instruction },
      ],
      {
        model: input.persona.model === '' ? settings.defaultChatModel : input.persona.model,
        temperature: input.persona.temperature,
        responseFormat: 'json',
        signal,
        onToken: (delta) => {
          this.emit({ kind: 'token', runId, stepIndex, delta });
        },
      },
    );

    let statBlock: StatBlock | null = null;
    try {
      const jsonText = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
      const parsed = statBlockSchema.parse(JSON.parse(jsonText) as unknown);
      statBlock = parsed;
    } catch (error) {
      const issues = error instanceof Error ? error.message : String(error);
      if (!this.statblockRetried.has(runId)) {
        // 04-LLM-PERSONAS: same one-time schema-repair retry as draft. This
        // was missing, so one malformed stat block discarded a valid NPC.
        debugLog('run', 'statblock parse FAILED — retrying once', { issue: issues });
        this.statblockRetried.add(runId);
        return this.runStatblock(
          runId,
          stepIndex,
          steps,
          input,
          signal,
          `${extraInstruction === '' ? '' : `${extraInstruction}\n`}Your previous statblock reply was invalid JSON for the COMPLETE schema: ${issues}. Reply with corrected JSON only and include every required field.`,
        );
      }
    }

    if (statBlock === null) {
      const step = this.finishStep(steps[stepIndex], { raw }, 'rejected');
      if (input.autonomy === 'auto') return { step };
      if (input.autonomy === 'manual') return { step, runStatus: 'awaiting_user' };
      return { step, runStatus: 'needs_review' };
    }

    this.statblockRetried.delete(runId);
    const step = this.finishStep(steps[stepIndex], { statBlock });
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

    const raw = await chat(
      [
        { role: 'system', content: input.persona.systemPrompt },
        { role: 'user', content: instruction },
      ],
      {
        model: input.persona.model === '' ? settings.defaultChatModel : input.persona.model,
        temperature: input.persona.temperature,
        responseFormat: 'json',
        signal,
        onToken: (delta) => {
          this.emit({ kind: 'token', runId, stepIndex, delta });
        },
      },
    );

    try {
      const jsonText = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
      const report = continuityReportSchema.parse(JSON.parse(jsonText) as unknown);
      const step = this.finishStep(steps[stepIndex], { report });
      if (pauses(input.autonomy, false)) return { step, runStatus: 'awaiting_user' };
      return { step };
    } catch {
      const step = this.finishStep(steps[stepIndex], { raw }, 'rejected');
      if (input.autonomy === 'auto') return { step };
      if (input.autonomy === 'manual') return { step, runStatus: 'awaiting_user' };
      return { step, runStatus: 'needs_review' };
    }
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
  } {
    const step = steps.find((candidate) => candidate.name === 'brief');
    const effective = step?.userEdit ?? step?.output;
    if (effective === null || effective === undefined || typeof effective !== 'object') {
      throw new Error('Encounter run has no approved brief');
    }
    const value = effective as { parsed?: unknown; aspect?: unknown; statblockChunkIds?: unknown };
    return {
      parsed: encounterGeneratorBriefSchema.parse(value.parsed),
      aspect: value.aspect === '16:9' || value.aspect === '1:1' ? value.aspect : '4:3',
      statblockChunkIds: Array.isArray(value.statblockChunkIds)
        ? value.statblockChunkIds.filter((id): id is Id => typeof id === 'string')
        : [],
    };
  }

  private effectiveEncounterLayout(steps: readonly RunStep[]): EncounterLayout {
    const step = steps.find((candidate) => candidate.name === 'layout');
    const effective = step?.userEdit ?? step?.output;
    if (effective === null || effective === undefined || typeof effective !== 'object') {
      throw new Error('Encounter run has no approved layout');
    }
    const value = effective as { layout?: unknown };
    return encounterLayoutSchema.parse(value.layout);
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
    const retrieval = await this.retrieveContext(input);
    const rosterContract = target?.kind === 'encounter'
      ? `Regeneration target roster (preserve this exact order, names and counts): ${JSON.stringify(
          target.data.monsters.map((monster) => ({
            name: monster.name,
            count: monster.count,
            notes: monster.notes,
          })),
        )}`
      : 'Design a concrete monster roster appropriate to the requested difficulty.';
    const contract = [
      input.brief,
      `Campaign: ${input.campaign.name} (${GAME_SYSTEM_LABELS[input.campaign.system]})`,
      `Map aspect: ${aspect}`,
      rosterContract,
      context.length === 0 ? null : `Context: ${JSON.stringify(context)}`,
      retrieval.excerpts === '' ? null : `Retrieved rules:\n${retrieval.excerpts}`,
      buildStatblockCitationSection(retrieval.statblockTitles),
      extraInstruction === '' ? null : `Additional instruction: ${extraInstruction}`,
      'Reply with JSON only using every field: name, summary, body, difficulty, levelHint, terrain, tactics, treasure, theme, styleNotes, negative, monsters [{name,count,notes,sourceChunkIndex? or statBlock?}], rooms [{name,description,size:"small"|"medium"|"large",monsterIndexes:number[],adjacentRoomIndexes:number[]}], entryRoomIndex. Every monster index belongs to exactly one room. Rooms form one connected graph. Do not emit coordinates.',
    ].filter((part) => part !== null).join('\n\n');
    const messages: ChatMessage[] = [
      { role: 'system', content: input.persona.systemPrompt },
      { role: 'user', content: contract },
    ];
    let raw = await chat(messages, {
      model: input.persona.model || settings.defaultChatModel,
      temperature: input.persona.temperature,
      responseFormat: 'json',
      signal,
      onToken: (delta) => {
        this.emit({ kind: 'token', runId, stepIndex, delta });
      },
    });
    let parsed = parseEncounterBrief(raw);
    if (target === undefined && parsed !== null && !encounterSourcesValid(parsed, retrieval.statblockChunkIds)) parsed = null;
    if (parsed === null) {
      raw = await chat(
        [
          ...messages,
          { role: 'assistant', content: raw },
          { role: 'user', content: 'The reply failed the required encounter-brief schema. Return corrected JSON only, with valid room and roster indexes.' },
        ],
        {
          model: input.persona.model || settings.defaultChatModel,
          temperature: input.persona.temperature,
          responseFormat: 'json',
          signal,
          onToken: (delta) => {
        this.emit({ kind: 'token', runId, stepIndex, delta });
      },
        },
      );
      parsed = parseEncounterBrief(raw);
      if (target === undefined && parsed !== null && !encounterSourcesValid(parsed, retrieval.statblockChunkIds)) parsed = null;
    }
    if (parsed === null) {
      return {
        step: this.finishStep(steps[stepIndex], { raw }, 'rejected'),
        ...(input.autonomy === 'auto' ? {} : { runStatus: 'needs_review' as const }),
      };
    }
    if (target?.kind === 'encounter') {
      parsed = {
        ...parsed,
        monsters: target.data.monsters.map((monster) => ({
          name: monster.name,
          count: monster.count,
          notes: monster.notes,
        })),
      };
    }
    return {
      step: this.finishStep(steps[stepIndex], {
        parsed,
        aspect,
        statblockChunkIds: retrieval.statblockChunkIds,
      }),
      ...(input.autonomy === 'auto' ? {} : { runStatus: 'awaiting_user' as const }),
    };
  }

  private runEncounterLayout(
    runId: Id,
    stepIndex: number,
    steps: RunStep[],
    input: StartRunInput,
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
      ...(input.autonomy === 'auto' ? {} : { runStatus: 'awaiting_user' as const }),
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
    const { parsed } = this.effectiveEncounterBrief(steps);
    const schematic = this.encounterSchematics.get(runId) ?? encounterRunAdapters.renderSchematic(layout, 96);
    this.encounterSchematics.set(runId, schematic);
    const prompt = [
      `Top-down tabletop RPG battlemap. Theme: ${parsed.theme}.`,
      parsed.styleNotes,
      'Keep walls, openings and overall structure exactly as in the reference image.',
      'No text, labels, grid lines, numbers, tokens, miniatures or watermark.',
      parsed.negative === '' ? null : `Avoid: ${parsed.negative}`,
    ].filter((part) => part !== null && part !== '').join(' ');
    const generated = await encounterRunAdapters.generateImages(prompt, input.unattended === true ? 1 : 2, {
      model: settings.imageModel,
      signal,
      inputReferences: [{ dataUrl: schematic.dataUrl }],
    });
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
        model: settings.imageModel,
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
    const stylize = steps.find((step) => step.name === 'stylize')?.output as { imageIds?: Id[] } | undefined;
    const imageIds = stylize?.imageIds ?? [];
    if (imageIds.length === 0) throw new Error('Encounter stylize step produced no map candidates');
    const verifications = [];
    for (const imageId of imageIds) {
      const image = await getImage(imageId);
      if (image === undefined) throw new Error(`Generated map ${imageId} no longer exists`);
      const stylizedDataUrl = await encounterRunAdapters.blobToDataUrl(
        new Blob([image.bytes], { type: image.mimeType }),
      );
      verifications.push(
        await encounterRunAdapters.verifyEncounterMap({
          layout,
          schematicDataUrl: schematic.dataUrl,
          stylizedDataUrl,
          model: settings.defaultChatModel,
          signal,
        }),
      );
    }
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
    const { parsed, statblockChunkIds } = this.effectiveEncounterBrief(steps);
    const layout = this.effectiveEncounterLayout(steps);
    const pick = steps.find((step) => step.name === 'pick');
    const selected = (pick?.userEdit as { keep?: Id[] } | null | undefined)?.keep?.[0];
    if (selected === undefined) throw new Error('Encounter finalize has no selected battlemap');
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
            const chunkId = monster.sourceChunkIndex === undefined
              ? undefined
              : statblockChunkIds[monster.sourceChunkIndex];
            return {
              name: monster.name,
              count: monster.count,
              notes: monster.notes,
              source:
                chunkId !== undefined
                  ? { type: 'rulebook' as const, chunkId }
                  : monster.statBlock !== undefined
                    ? { type: 'inline' as const, statBlock: monster.statBlock }
                    : { type: 'none' as const },
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
    const instruction = [
      `Artifact: ${target.name} (${target.kind})`,
      target.summary === '' ? null : `Summary: ${target.summary}`,
      target.body === '' ? null : `Description (may be truncated):\n${target.body.slice(0, 800)}`,
      `Campaign tone: ${input.campaign.name}${input.campaign.description === '' ? '' : ` — ${input.campaign.description}`}`,
      input.brief === '' ? null : `Focus: ${input.brief}`,
      'Reply with ONLY a JSON object with exactly these fields: ["prompt", "negative", "styleNotes"] — `prompt` describes the image to generate for this artifact, `negative` lists what to avoid, `styleNotes` gives style guidance.',
      extraInstruction === '' ? null : `Additional instruction: ${extraInstruction}`,
    ]
      .filter((part) => part !== null)
      .join('\n\n');

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

    const raw = await chat(messages, {
      model: input.persona.model === '' ? settings.defaultChatModel : input.persona.model,
      temperature: input.persona.temperature,
      responseFormat: 'json',
      signal,
      onToken: (delta) => {
        this.emit({ kind: 'token', runId, stepIndex, delta });
      },
    });

    let parsed: unknown;
    try {
      const jsonText = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
      parsed = imagePromptDraftSchema.parse(JSON.parse(jsonText) as unknown);
    } catch (error) {
      const issues = error instanceof Error ? error.message : String(error);
      if (!this.draftRetried.has(runId)) {
        // One automatic JSON-fix retry (same policy as artifact drafts).
        this.draftRetried.add(runId);
        return this.runPromptDraft(
          runId,
          stepIndex,
          steps,
          input,
          signal,
          `${extraInstruction === '' ? '' : `${extraInstruction}\n`}Your previous reply was invalid JSON for the schema: ${issues}. Reply with corrected JSON only.`,
        );
      }
      const step = this.finishStep(steps[stepIndex], { raw }, 'rejected');
      if (input.autonomy === 'auto') return { step };
      if (input.autonomy === 'manual') return { step, runStatus: 'awaiting_user' };
      return { step, runStatus: 'needs_review' };
    }

    const step = this.finishStep(steps[stepIndex], { parsed });
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
    const finalPrompt = [
      draft.prompt,
      draft.styleNotes === '' ? null : `Style: ${draft.styleNotes}`,
      draft.negative === '' ? null : `Avoid: ${draft.negative}`,
    ]
      .filter((part) => part !== null)
      .join('\n');
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
        model: settings.imageModel,
        source: 'generated',
      });
      imageIds.push(stored.id);
    }
    // The model capping candidates at 1 (e.g. x-ai/grok-imagine-image-2.0)
    // is a degradation the user must see (AGENTS rule 1): persist a notice
    // on the step — the run panel renders it next to the pick UI.
    const notice = generated.cappedToOne
      ? `“${settings.imageModel}” generates one image per request — this run produced a single candidate.`
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
    // blocks back into persisted `source` entries.
    if (kind === 'encounter' && 'monsters' in data) {
      const retrieveStep = steps.find((step) => step.name === 'retrieve');
      const retrieveOutput = (retrieveStep?.output ?? {}) as { statblockChunkIds?: unknown };
      const statblockChunkIds = Array.isArray(retrieveOutput.statblockChunkIds)
        ? (retrieveOutput.statblockChunkIds as Id[])
        : [];
      const draftMonsters = (draft as { monsters?: { sourceChunkIndex?: number; statBlock?: StatBlock }[] })
        .monsters;
      data.monsters = data.monsters.map((monster, index) => {
        const cited = draftMonsters?.[index];
        if (cited?.statBlock !== undefined) {
          return { ...monster, source: { type: 'inline', statBlock: cited.statBlock } };
        }
        const chunkId =
          typeof cited?.sourceChunkIndex === 'number'
            ? statblockChunkIds[cited.sourceChunkIndex]
            : undefined;
        return {
          ...monster,
          source:
            chunkId !== undefined
              ? { type: 'rulebook', chunkId }
              : { type: 'none' },
        };
      });
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
    const message = error instanceof Error ? error.message : String(error);
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
    layout: 'Packing rooms and corridors…',
    schematic: 'Rendering the structure reference…',
    stylize: 'Stylizing candidate battlemaps…',
    verify: 'Checking structural alignment…',
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
