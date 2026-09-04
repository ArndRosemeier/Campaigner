import type { Campaign, EntityKind, Id, Module, ModuleEntityKind, ModulePart, ModuleSpine, PartPlan } from '@/domain';
import { createModule, moduleEntityKindSchema, moduleSpineSchema, MODULE_SIZE_WORD_TARGETS } from '@/domain';
import { canonicalEntityRecords, normalizationReplySchema, validateNormalizationReply, type NormalizationEntry } from '@/domain/entityNormalization';
import { getModule, listModulesByCampaign, patchModule, saveModule } from '@/db/moduleRepo';
import { listArtifactsByCampaign, updateArtifact } from '@/db/artifactRepo';
import { GAME_SYSTEM_LABELS } from '@/domain/gameSystem';
import { getSettings } from '@/db/settingsRepo';
import { chat, MissingApiKeyError, type ChatMessage, type ChatStreamActivity } from '@/llm/openrouter';
import { parseErrorSummary, parseJsonReply } from '@/llm/jsonReply';
import { repairModel } from '@/llm/modelFallback';
import { searchRules } from '@/search';
import { extractWikiLinks, rewriteWikiLinkTargets, surroundingParagraphs, type LinkRewrite } from '@/lib/wikilinks';
// The engine triggers the module's own post-generation automation (the
// unattended paths have no UI to do it); the orchestrator never imports this
// module, so the direction stays acyclic.
import { runModulePostGeneration } from '@/features/modules/post-generation';
import { toastError } from '@/lib/toast';
import { useProgressStore } from '@/lib/progress';
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
      responseFormat: 'json',
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
            responseFormat: 'json',
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
    const artifacts = await listArtifactsByCampaign(campaign.id);
    const artifactNames = artifacts.map((artifact) => artifact.name);
    const spineNames = entityKinds.map((entry) => entry.name);
    let normalizedKinds: ModuleEntityKind[] = [];
    if (spineNames.length > 0) {
      const verdicts = await normalizationCall(
        normalizationMessages(
          spineNames.map((name) => ({
            name,
            context: surroundingParagraphs(spine.premise, name, NORMALIZE_CONTEXT_CAP),
          })),
          artifactNames,
          spine.premise,
        ),
        settings.defaultChatModel,
        spineNames,
        artifactNames,
      );
      normalizedKinds = canonicalEntityRecords(verdicts);
    }
    return await patchModule(moduleId, { spine, entityKinds: normalizedKinds, status: 'draft', errorMessage: '' });
  } catch (error) {
    await failModule(moduleId, error);
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
 * Parses the entity list the spine pass records alongside the spine (08
 * §M4-C): the model declares each entity's kind when it invents the name —
 * a missing/incomplete list is a validation error (retry-once, then the
 * spine fails loudly; never a silent default).
 */
export function parseSpineEntities(raw: string): ModuleEntityKind[] {
  return entityKindsReplySchema.parse(parseJsonReply(raw)).entities;
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
 * Builds the prior-modules context section (08 §M4-B opt-in continuity): the
 * campaign's other modules that carry any authored text — premise, part texts,
 * drafts included — in story order (oldest first). When the total cap would
 * overflow, the OLDEST modules are dropped first (recent history matters most
 * for continuity). Returns null when nothing qualifies — the section is then
 * omitted entirely; an empty set is not an error.
 */
export function priorModulesContext(priors: readonly Module[]): string | null {
  const blocks = [...priors]
    .sort((a, b) => a.createdAt - b.createdAt)
    .filter(hasPriorText)
    .map(priorModuleBlock);
  const kept: string[] = [];
  let total = 0;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block === undefined) continue;
    if (total + block.length > PRIOR_MODULES_TOTAL_CAP) continue;
    kept.unshift(block);
    total += block.length;
  }
  if (kept.length === 0) return null;
  return [
    'Previous modules of this campaign, oldest first — settled history. ' +
      'Build on their events and open threads, reuse their established names exactly, and never retcon them:',
    kept.join('\n\n'),
  ].join('\n\n');
}

/**
 * Loads the campaign's other modules for the opt-in continuity context. The
 * flag off short-circuits to [] (previous behavior, byte-for-byte); a failed
 * read propagates — an opted-in run must not silently generate without the
 * context it promised (AGENTS rule 1).
 */
async function priorModulesOf(module: Module): Promise<Module[]> {
  if (!module.includePriorModules) return [];
  const modules = await listModulesByCampaign(module.campaignId);
  return modules.filter((candidate) => candidate.id !== module.id);
}

async function spineMessages(
  module: Module,
  campaign: Campaign,
  extraInstruction: string,
): Promise<ChatMessage[]> {
  const artifacts = await listArtifactsByCampaign(campaign.id);
  const index =
    artifacts.length === 0
      ? null
      : `Existing campaign entities (reuse the ones that fit, by their exact names):\n${artifacts
          .slice(0, 60)
          .map((artifact) => `- ${artifact.name} (${artifact.kind})${artifact.summary === '' ? '' : ` — ${artifact.summary}`}`)
          .join('\n')}`;
  const priorContext = priorModulesContext(await priorModulesOf(module));

  const levelCount = module.levelMax - module.levelMin + 1;
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
      '- Each part needs: title, levelBand (e.g. "1" or "2-3"), a one-paragraph synopsis, and levelUpTrigger (what ends this part / triggers the level-up).',
      '- Think like an experienced GM designing for real players: prioritize fun, meaningful choices, varied pacing, memorable moments, clear stakes, and challenges that are exciting without feeling arbitrary or hopeless. Balance combat, social, exploration, discovery, and recovery according to the story and the group’s enjoyment. Let the fiction and pacing decide the exact structure rather than filling a quota mechanically.',
      '- As a soft planning guideline, aim for roughly 1–4 encounters per level across the module. This is advice, not a requirement: create fewer when tension, travel, investigation, or character moments need room; create more only when the adventure supports that pace. An encounter may be combat, social conflict, exploration, hazard, negotiation, chase, puzzle, or another scene with meaningful risk and player agency. Place encounters deliberately in the parts where they make narrative and gameplay sense, vary their type and intensity, and reserve climactic encounters for an earned escalation. Never pad the module with repetitive or disposable encounters.',
      '- Introduce as many locations, NPCs, factions, notes, and encounters as the story needs — you are not required to detail any of them in the spine. Give every planned encounter a distinctive, stable name and declare it with kind "encounter" in entities when introduced. When the module references an encounter in prose, use a wiki-link ([[Encounter Name]]) so it can be resolved into an encounter artifact later.',
      '- List every named entity you introduce with its kind: "npc" (a person or creature the party meets), "location" (a place), "faction" (an organization or group), "encounter" (a named combat, challenge, or tactical set piece), or "note" (anything else — items, rumors, mysteries, plot devices). One entity entry per named entity, under one canonical spelling — list a person once, not once per role or title. Reuse existing campaign entities by their exact names when they fit; do not invent duplicates to satisfy the soft encounter guideline.',
      '- Also write a premise (a few paragraphs of markdown — the intro section of the module) and 1-5 themes.',
    ].join('\n'),
    extraInstruction === '' ? null : `Additional instruction: ${extraInstruction}`,
    'Reply with ONLY a JSON object: { "premise": string, "themes": string[], "partPlan": [{ "title": string, "levelBand": string, "synopsis": string, "levelUpTrigger": string }], "entities": [{ "name": string, "kind": "npc" | "location" | "faction" | "note" | "encounter" }] } — partPlan length 1..20, one entity entry per named entity.',
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

async function failModule(moduleId: Id, error: unknown): Promise<void> {
  if (isAbort(error)) {
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
  const message = error instanceof Error ? error.message : String(error);
  await patchModule(moduleId, { status: 'failed', errorMessage: message });
}

// --- Pass 1 — parts ----------------------------------------------------------

export interface PartsRunOptions {
  /** Which plan entries to generate; default: all parts, in plan order. */
  planIndexes?: readonly number[] | undefined;
  /** Optional user instruction appended to a single-part rewrite. */
  extraInstruction?: string | undefined;
}

/**
 * Runs pass 1: one markdown call per plan entry, sequentially. Each finished
 * part lands on the module row immediately (progressive reveal — the reader
 * shows part 1 while part 3 streams). A failed part does NOT stop the chain:
 * it is marked failed (with its error) and generation continues. Continuity
 * for part i comes from the part at planIndex i−1 only — when that
 * predecessor failed, part i is written WITHOUT continuity context.
 */
export async function runParts(
  moduleId: Id,
  campaign: Campaign,
  options: PartsRunOptions = {},
): Promise<Module> {
  const controller = controllerFor(moduleId);
  // App-wide progress dock (00-OVERVIEW): parts are a known-length list, so
  // the bar fills per part and the detail names the part being written.
  const progress = useProgressStore.getState();
  const jobId = `module-parts-${moduleId}`;
  try {
    const settings = await getSettings();
    const module = await requireModule(moduleId);
    if (module.spine === null) throw new Error('Cannot generate parts without an approved spine');
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
        if (isAbort(error)) throw error;
        // The failed part is persisted with its error by generatePart; the
        // chain continues with the next part (08 §M4-B).
      }
      index += 1;
      progress.update(jobId, { progress: index / total });
    }

    const result = await patchModule(moduleId, { status: 'ready', errorMessage: '' });
    progress.update(jobId, { progress: 1, detail: 'Normalizing entity names…' });
    // Entity name normalization (fix-01): one call after the parts land —
    // canonical names, kinds, link rewrites and aliases. A failure is
    // recorded on the module row (loud, batch gated, Retry in the panel) but
    // must NOT fail the completed run — there is nothing safe to fall back to.
    await normalizeModuleEntityNames(moduleId).catch((error: unknown) => {
      toastError('Entity name normalization failed — retry from the entity panel', error);
    });
    return result;
  } catch (error) {
    if (isAbort(error)) {
      // Parts already written stay; the interrupted part keeps its slot
      // status, and the module returns to `ready` (or `draft` before the
      // first part) so its Retry buttons stay available.
      const module = await getModule(moduleId);
      if (module !== undefined) {
        await patchModule(moduleId, {
          status: module.parts.length > 0 ? 'ready' : 'draft',
        });
      }
      return (await getModule(moduleId)) ?? (await requireModule(moduleId));
    }
    await failModule(moduleId, error);
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
    await setPart({ planIndex, markdown, status: 'ready', errorMessage: '', edited: false });
    return markdown;
  } catch (error) {
    if (isAbort(error)) {
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
    const message = error instanceof Error ? error.message : String(error);
    await setPart({ planIndex, markdown: '', status: 'failed', errorMessage: message, edited: false });
    throw error;
  }
}

interface PartCallOptions {
  signal: AbortSignal;
  extraInstruction: string;
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
  const artifacts = await listArtifactsByCampaign(campaign.id);
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
  const priorContext = priorModulesContext(await priorModulesOf(module));

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
      '- Read-aloud text goes in blockquotes.',
      '- Wiki-link every proper noun as [[Name]]: NPCs, locations, factions, artifacts, monsters. Reuse the exact names of entities from earlier parts and the campaign index, consistently.',
      '- Canonical spellings: link glossary entities only by their listed exact spelling. Never inflect inside the token — write [[Halmund]]s Haus, not [[Halmunds]] Haus (English genitive: [[Halmund]]\'s tower). Never bake roles or titles into the token — write [[Halmund|the guard Halmund]], not [[Guard Halmund]]. Use [[Name|display]] whenever the surface text must differ from the canonical name. The same rules apply in any language.',
      `- Target length for this part: ${MODULE_SIZE_WORD_TARGETS[module.sizeDial]} (soft target).`,
      '- No stat blocks in the prose — mechanics belong to linked entities. Reference DCs/checks inline where natural.',
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
 * The shared normalization prompt (fix-01): the model — which wrote the text
 * — decides per listed name which canonical entity it refers to, and states
 * the canonical entity's kind. One contract for the post-parts pass, the
 * spine's entity list, and single hand-typed names.
 */
function normalizationMessages(
  requests: readonly { name: string; context: string }[],
  artifactNames: readonly string[],
  premise: string,
): ChatMessage[] {
  const lines = requests.map((request) => {
    const context = request.context.replaceAll('\n', ' ').trim();
    return `- ${request.name}${context === '' ? '' : ` :: ${context}`}`;
  });
  const index =
    artifactNames.length === 0
      ? null
      : `Existing campaign artifacts (a name matching one of these refers to that artifact):\n${artifactNames.join('\n')}`;
  const instruction = [
    `Module premise for context:\n${premise}`,
    'For each entity name below, decide which canonical entity it refers to.',
    index,
    [
      'Rules:',
      '- One entry per listed name; the "name" field spelled exactly as listed; no extra entries; no invented names.',
      '- "canonical" is the exact spelling of the entity this name refers to: the name itself, another listed name (the canonical form of a variant), or an existing artifact\'s exact name. Never a name that appears nowhere in the inputs. Canonical spellings are final — never A → B when B maps elsewhere.',
      '- Merge only when confident the names refer to the same entity (same person, place, organization, or thing). A role or title attached to the same person ("Guard Halmund" / "Harbormaster Ilse") maps onto the person\'s canonical name; similar names for different beings never merge.',
      '- A name that exactly matches an existing artifact\'s name maps to itself.',
      '- "kind" describes the canonical entity: "npc" = a person or creature the party meets; "location" = a place; "faction" = an organization or group; "encounter" = a named combat or tactical set piece; "note" = anything else (items, rumors, mysteries, plot devices).',
    ].join('\n'),
    'Entities:\n' + lines.join('\n'),
    'Reply with ONLY a JSON object: { "entities": [{ "name": string, "canonical": string, "kind": "npc" | "location" | "faction" | "note" | "encounter" }] } — one entry per listed entity.',
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
): Promise<NormalizationEntry[]> {
  const settings = await getSettings();
  const base = {
    model,
    temperature: 0.2,
    reasoningEffort: settings.defaultReasoningEffort,
    responseFormat: 'json' as const,
  };
  const run = (raw: string): NormalizationEntry[] => {
    const parsed = normalizationReplySchema.parse(parseJsonReply(raw)).entities;
    const violations = validateNormalizationReply(names, parsed, artifactNames);
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
export async function normalizeModuleEntityNames(moduleId: Id): Promise<void> {
  const module = await requireModule(moduleId);
  const artifacts = await listArtifactsByCampaign(module.campaignId);
  const artifactNames = artifacts.map((artifact) => artifact.name);
  const documents = [
    { where: 'premise', markdown: module.spine?.premise ?? '' },
    ...module.parts
      .slice()
      .sort((a, b) => a.planIndex - b.planIndex)
      .map((part) => ({ where: `part-${String(part.planIndex)}`, markdown: part.markdown })),
  ];
  const text = documents.map((document) => document.markdown).join('\n\n');
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
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await patchModule(moduleId, { entityNamesNormalized: false, entityNormalizationError: message });
    toastError('Entity name normalization failed — retry from the entity panel', error);
    return;
  }

  await applyNormalizationVerdict(moduleId, module, artifacts, verdicts);
}

/**
 * Applies a validated verdict mechanically (fix-01): rewrites generated text,
 * holds proposals for hand-edited text and the premise, records aliases,
 * replaces `entityKinds`. The canonical spelling written into tokens/records
 * is the listed or artifact spelling of the entity the model chose — the
 * verdict itself is never altered.
 */
async function applyNormalizationVerdict(
  moduleId: Id,
  module: Module,
  artifacts: Awaited<ReturnType<typeof listArtifactsByCampaign>>,
  verdicts: readonly NormalizationEntry[],
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

  await patchModule(moduleId, {
    parts: appliedParts,
    entityKinds: canonicalEntityRecords(verdicts),
    entityNamesNormalized: true,
    entityNormalizationError: '',
    entityRewriteProposals: proposals.length > 0 ? proposals : null,
  });
}

/**
 * Single-name normalization for hand-typed names (fix-01): the stub popover
 * asks which canonical entity the name refers to (and its kind) before
 * creating anything. Same contract and retry policy as the batched pass.
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
  await runParts(moduleId, campaign).catch(() => undefined);
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
  await runParts(moduleId, campaign).catch(() => undefined);
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
  await runParts(moduleId, campaign, { planIndexes: indexes }).catch(() => undefined);
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
