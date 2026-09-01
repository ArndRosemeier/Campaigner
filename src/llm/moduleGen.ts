import type { Campaign, Id, Module, ModulePart, ModuleSpine, PartPlan } from '@/domain';
import { createModule, moduleSpineSchema, MODULE_SIZE_WORD_TARGETS } from '@/domain';
import { getModule, patchModule, saveModule } from '@/db/moduleRepo';
import { listArtifactsByCampaign } from '@/db/artifactRepo';
import { GAME_SYSTEM_LABELS } from '@/domain/gameSystem';
import { getSettings } from '@/db/settingsRepo';
import { chat, MissingApiKeyError, type ChatMessage } from '@/llm/openrouter';
import { searchRules } from '@/search';
import { toastError } from '@/lib/toast';

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
  | { kind: 'part-token'; moduleId: Id; planIndex: number; delta: string }
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
  try {
    const module = await getModule(moduleId);
    if (module === undefined) throw new Error('Module to generate no longer exists');
    if (module.parts.length > 0) {
      throw new Error('Refusing to regenerate a spine for a module that already has parts');
    }
    await patchModule(moduleId, { status: 'generating', errorMessage: '' });

    const settings = await getSettings();
    const messages = await spineMessages(module, campaign, options.extraInstruction ?? '');

    let raw = await chat(messages, {
      model: settings.defaultChatModel,
      temperature: 0.8,
      responseFormat: 'json',
      signal: controller.signal,
      onToken: (delta) => {
        moduleGenEvents.emit({ kind: 'spine-token', moduleId, delta });
      },
    });

    let spine: ModuleSpine;
    try {
      spine = parseSpine(raw);
    } catch (error) {
      // One automatic invalid-JSON retry (same policy as persona drafts); a
      // second failure fails the module loudly.
      raw = await chat(
        [
          ...messages,
          {
            role: 'user',
            content: `Your previous reply was invalid JSON: ${error instanceof Error ? error.message : String(error)}. Reply with corrected JSON only.`,
          },
        ],
        {
          model: settings.defaultChatModel,
          temperature: 0.8,
          responseFormat: 'json',
          signal: controller.signal,
        },
      );
      spine = parseSpine(raw);
    }

    return await patchModule(moduleId, { spine, status: 'draft', errorMessage: '' });
  } catch (error) {
    await failModule(moduleId, error);
    throw error;
  } finally {
    controllers.delete(moduleId);
    moduleGenEvents.emit({ kind: 'done', moduleId });
  }
}

/** Parses + validates the spine from model output (sliced to the JSON body). */
export function parseSpine(raw: string): ModuleSpine {
  const jsonText = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  if (jsonText === '') throw new Error('the reply contained no JSON object');
  return moduleSpineSchema.parse(JSON.parse(jsonText) as unknown);
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

  const levelCount = module.levelMax - module.levelMin + 1;
  const instruction = [
    `Campaign: ${campaign.name} (${GAME_SYSTEM_LABELS[campaign.system]})${campaign.description === '' ? '' : ` — ${campaign.description}`}`,
    `Module concept: ${module.concept}`,
    `Party levels ${module.levelMin}–${module.levelMax}${module.tone === '' ? '' : `; tone: ${module.tone}`}`,
    index,
    [
      'Design the module spine. Cover the whole level range with parts, in order:',
      `- Default one part per level; you MAY merge adjacent levels into one part when the story is better served (levels ${module.levelMin}–${module.levelMax} → about ${levelCount} parts or fewer).`,
      '- Every level in the range must be covered by exactly one part.',
      '- Each part needs: title, levelBand (e.g. "1" or "2-3"), a one-paragraph synopsis, and levelUpTrigger (what ends this part / triggers the level-up).',
      '- Introduce as many locations, NPCs and factions as the story needs — you are not required to detail any of them.',
      '- Also write a premise (a few paragraphs of markdown — the intro section of the module) and 1-5 themes.',
    ].join('\n'),
    extraInstruction === '' ? null : `Additional instruction: ${extraInstruction}`,
    'Reply with ONLY a JSON object: { "premise": string, "themes": string[], "partPlan": [{ "title": string, "levelBand": string, "synopsis": string, "levelUpTrigger": string }] } — partPlan length 1..20.',
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
  try {
    const settings = await getSettings();
    const module = await requireModule(moduleId);
    if (module.spine === null) throw new Error('Cannot generate parts without an approved spine');

    const planIndexes =
      options.planIndexes ?? module.spine.partPlan.map((_, index) => index);
    for (const planIndex of planIndexes) {
      const target = await requireModule(moduleId);
      if (target.spine === null) throw new Error('The spine was removed mid-generation');
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
            },
          },
        );
      } catch (error) {
        if (isAbort(error)) throw error;
        // The failed part is persisted with its error by generatePart; the
        // chain continues with the next part (08 §M4-B).
      }
    }

    return await patchModule(moduleId, { status: 'ready', errorMessage: '' });
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

  const ruleExcerpts = await ruleExcerptSection(plan.synopsis);

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
    [
      'Writing instructions:',
      '- Free-form GM-facing markdown; ## and ### section headings are allowed (the reader adds the H1 part title — do NOT start your reply with an H1).',
      '- Read-aloud text goes in blockquotes.',
      '- Wiki-link every proper noun as [[Name]]: NPCs, locations, factions, artifacts, monsters. Reuse the exact names of entities from earlier parts and the campaign index, consistently.',
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
  const raw = await chat(messages, {
    model,
    temperature: 0.8,
    signal: options.signal,
    onToken: options.onToken,
  });
  try {
    return normalizePartMarkdown(raw);
  } catch {
    const retry = await chat(
      [
        ...messages,
        { role: 'user', content: 'Your previous reply was too short. Write the full part now.' },
      ],
      {
        model,
        temperature: 0.8,
        signal: options.signal,
      },
    );
    return normalizePartMarkdown(retry);
  }
}

/** Rule excerpts for grounding (empty library → no section, not an error). */
async function ruleExcerptSection(query: string): Promise<string | null> {
  const hits = await searchRules(query, { limit: 4 });
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
}

/** Re-runs pass 0 with an optional extra steering instruction. */
export async function retrySpine(
  moduleId: Id,
  campaign: Campaign,
  extraInstruction = '',
): Promise<void> {
  await runSpine(moduleId, campaign, { extraInstruction }).catch(() => undefined);
}

/** Checkpoint "Discard": drops the spine, back to a draft module. */
export async function discardSpine(moduleId: Id): Promise<void> {
  const module = await getModule(moduleId);
  if (module === undefined) return;
  await patchModule(moduleId, { spine: null, status: 'draft', errorMessage: '' });
}

/** Creates the module row from the dialog input and immediately runs pass 0. */
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
  },
): Promise<Id> {
  const created = createModule(input);
  const saved = await saveModule(created);
  await runSpine(saved.id, campaign).catch(() => undefined);
  return saved.id;
}
