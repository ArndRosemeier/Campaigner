import type { Campaign, EntityBestiarySlot, FailureKind, Id, Module, ModuleEntityKind, PersonaRun, Rulebook } from '@/domain';
import { bestiarySlotForEntity, entityIntentFor, entityLevelHintFor, mergeAliasNames, moduleDocumentText, moduleTagFor, sameAliasName, unmatchedEntityLevelHints, aliasCollisionSentence, type AliasCollision } from '@/domain';
import type { CreatureCitation } from '@/domain/encounterResolve';
import type { GameSystem } from '@/domain/gameSystem';
import { citationBookTitle, rulebookDisplayTitle } from '@/domain/encounterResolve';
import { artifactRepo, db } from '@/db';
import { listArtifactsByCampaign, foreignAliasNames } from '@/db/artifactRepo';
import { castCreatureLabel, castCreatureWriteRefusal, isCastCreatureNpc } from '@/domain';
import { castCreatureAsNpc, listLibraryCreatures } from '@/db/creatureRepo';
import { getRulebook } from '@/db/rulebookRepo';
import { libraryCitationForSlot } from '@/domain/libraryCreature';
import { nearestLibraryCreatures } from '@/llm/creatorRoster';
import { listPersonas } from '@/db/personaRepo';
import { getSettings } from '@/db/settingsRepo';
import { isRunWithdrawn, runEngine, runNotCompletedReason, waitForRunStatus, type StartRunInput } from '@/llm/runEngine';
import { errorMessage } from '@/lib/errors';
import {
  buildEntityBrief,
  STUB_PERSONA_SLUGS,
  stubKindCarriesPartyLevel,
  type StubKind,
} from '@/features/modules/persona-request';
import { fixedCastForEncounter, partLevelForMention } from '@/llm/roomBudget';
import { surroundingParagraphs, extractWikiLinks } from '@/lib/wikilinks';
import { mapWithConcurrency } from '@/lib/parallel';
import { recordEntityBatchFailure } from '@/features/modules/entity-batch-report';
import { toastError } from '@/lib/toast';
import { getStopEpoch, stoppedSince } from '@/lib/stopEpoch';
import { useProgressStore } from '@/lib/progress';

/**
 * Headless entity batch (08-MODULE-DESIGNER M4-C): details a list of entity
 * names with one persona in `auto` autonomy — the engine behind the
 * entity panel's "Generate all unresolved of kind…", the module
 * post-generation automation (which runs the same path unattended after the
 * parts land), AND the stub popover's single "Generate" (F7: one live
 * "detail one entity" implementation instead of two — the popover delegates
 * a 1-target batch through `generateSingleEntity`).
 *
 * It is ALSO the engine behind a CHANGE: a target carrying `artifactId` (the
 * change seam, `features/modules/change-artifact`, docs/17 row 101) is filled
 * IN PLACE through the run engine's refill instead of being created, with the
 * same brief builder, the same persona resolution, the same tag/name handling
 * and the same failure reporting — one entity engine, two destinations.
 * `instruction` is the caller's free-text request, appended to every brief in
 * the one `Additional instruction: …` form and absent (byte-identical briefs)
 * when it is empty.
 *
 * Parallelization (optimization feature): entities are independent — each
 * brief is grounded in the module text alone, not in the other entities —
 * so up to `maxParallelRequests` entity runs execute at once. Each entity
 * is still a real PersonaRun visible in the Runs tab; only the incidental
 * "earlier entities as extra retrieval context" coupling of the old
 * sequential chain is dropped.
 *
 * Failure semantics (08 §M4-C / AGENTS rule 2): a failed RUN does not stop
 * the batch — the other runs finish, and every entity without a produced
 * artifact is reported loudly through the ONE reporting seam
 * (`features/modules/entity-batch-report`), which raises the console payload
 * and the toast together. A failure here is a RECORD (`kind` + run id +
 * status + the raw value), never a flattened sentence: the reporting layer
 * needs the whole thing (AGENTS rule 1).
 * Progress rides the shared dock (`module-entities-<moduleId>-<kind>`).
 *
 * A CANCELLED run is not a failure: the engine cancelled it because the user
 * asked for a stop (`runEngine.cancelAllActive`, the dock's Stop all), so its
 * entity is WITHDRAWN — no `failed` entry, no red toast, nothing said about
 * it. The first withdrawn run also ends the pool: a stopped orchestration
 * must not start its next unit, so the remaining targets are never launched
 * (the epoch consulted at the worker entry, `lib/stopEpoch`). Before that,
 * the pool recorded a cancelled run as a per-entity failure, which is how a
 * stop turned into "3 of 5 npcs failed to generate" toasts about nothing.
 */

/** Humanized run-step names for the progress detail line. */
export const RUN_STEP_LABELS: Record<string, string> = {
  retrieve: 'gathering context',
  draft: 'drafting',
  statblock: 'building the statblock',
  finalize: 'writing the artifact',
  gather: 'gathering sources',
  check: 'checking',
};

/**
 * Renames the produced artifact to the EXACT entity name (wiki-links resolve
 * by name/alias), keeping the model's invented name as an alias so nothing
 * authored is lost.
 *
 * A CAST CREATURE NPC is refused LOUDLY instead (`domain/creature`'s
 * `isCastCreatureNpc`): such an NPC is the module's own row for a LIBRARY
 * creature (`db/creatureRepo.castCreatureAsNpc`), and renaming it would sever
 * the citation its stats derive from — every reader of that name would stop
 * finding the creature. The refusal is a throw — never a silent skip — so every
 * caller has to surface the reason (AGENTS rule 2); the batch records it as a
 * per-entity failure with its toast.
 *
 * Returns the model's name REFUSED as another artifact's (docs/17 row 226) —
 * empty on the ordinary path — so the caller can speak it (AGENTS rule 1). The
 * rename itself still lands: refusing the rename would leave the row under a
 * name no wiki-link resolves, which is a worse row than one whose old name no
 * longer answers.
 */
export async function alignEntityName(
  artifactId: Id,
  entityName: string,
): Promise<AliasCollision[]> {
  const artifact = await artifactRepo.getArtifact(artifactId);
  if (artifact === undefined) return [];
  if (isCastCreatureNpc(artifact)) {
    throw new Error(castCreatureWriteRefusal(artifact.name, entityName));
  }
  if (sameAliasName(artifact.name, entityName)) return [];
  const modelName = artifact.name;
  // The "is the old name already an alias?" question is the MERGE's own
  // dedupe (docs/17 row 121): the comparison lives in `domain/artifactAlias`
  // and is never re-stated here — a hand-rolled `alias.trim().toLowerCase()`
  // beside it is exactly how the reader drifted into an untrimmed one. The
  // merge result rides the RENAME patch below (one revision: name + aliases),
  // so this uses the shared RULE rather than `artifactRepo.addArtifactAliases`.
  // Which artifact a name BELONGS to (`libraryCitationForEntity`, the creature
  // lookup above) is a different question and stays out of the seam — but the
  // FOREIGN-name half of it is `artifactRepo.foreignAliasNames` (docs/17 row
  // 226), the SAME guard every alias write applies: the model's name is not
  // attached when another artifact already answers it.
  const refused = await foreignAliasNames(artifactId, [modelName]);
  const aliases = mergeAliasNames(
    artifact.aliases,
    refused.length === 0 ? [modelName] : [],
    entityName,
  );
  await artifactRepo.updateArtifact(artifactId, { name: entityName, aliases });
  return refused;
}


/**
 * The cast an entity's BESTIARY SLOT asked for, resolved against the library
 * (docs/17 row 107, "The Aunt Agatha case").
 *
 * This is a thin LIVE-READ wrapper around THE ONE resolution seam,
 * `domain/libraryCreature.libraryCitationForSlot` (docs/17 row 248's remaining
 * slice): the algorithm — the exact name match, the book disambiguation, the
 * loud refusals, the citation identity — lives there ONCE and is called from
 * here AND from inside the v24 migration's Dexie transaction. The read that
 * cannot live in the transaction is this wrapper's job: `listLibraryCreatures`
 * (the ONE stat-block pool) and the two book-title readers.
 *
 * It is NOT a second creature lookup. It answers "which chunk does this name
 * mean?", and everything after that — the citation's identity, the derived
 * stats, the portrait key — is `castCreatureAsNpc`'s, unchanged. Scoping to the
 * campaign's game system (docs/17 row 207) is passed straight through to the
 * pool read, so a Pathfinder 2e module can never resolve a dnd5e creature's
 * stat block into one of its NPCs.
 *
 * Exported so the resolution rule is pinnable where it lives (docs/18 §2): this
 * is the ONE live caller of the seam, and a second implementation of the name
 * match is the defect the separation makes visible.
 */
export async function libraryCitationForEntity(
  entityName: string,
  slot: EntityBestiarySlot,
  system?: GameSystem,
): Promise<CreatureCitation> {
  const pool = await listLibraryCreatures(system);
  // The books the candidates come from, read ONCE (never one read per
  // candidate — the pool's chunk ids, deduped). Built from the live chunk table
  // and passed to the seam so the disambiguation and the citation stamp read the
  // same rows the pool did.
  const books = new Map<Id, Rulebook>();
  const bookIndexFor = async (chunkId: Id): Promise<Rulebook | undefined> => {
    const chunk = await db.chunks.get(chunkId);
    if (chunk === undefined) return undefined;
    const cached = books.get(chunk.bookId);
    if (cached !== undefined) return cached;
    const book = await getRulebook(chunk.bookId);
    if (book !== undefined) books.set(book.id, book);
    return book;
  };
  return libraryCitationForSlot(entityName, slot, pool, {
    system,
    // The reader-facing title a slot's `book` is matched against — the ONE
    // reading (`domain/encounterResolve.rulebookDisplayTitle`, which
    // `creatureOriginLabel` itself uses), so a slot's book is compared against
    // what the owner can actually read on screen.
    bookTitleOf: async (chunkId) => rulebookDisplayTitle(await bookIndexFor(chunkId)),
    // ...and the title a citation STAMPS (docs/17 row 155): the row's own title,
    // `undefined` when it is gone or blank — the honest "not recorded" rather
    // than the placeholder (AGENTS rule 1).
    stampBookTitleOf: async (chunkId) => citationBookTitle(await bookIndexFor(chunkId)),
    // The nearest names the library holds, over a normalization that forgives
    // case, whitespace, umlauts/diacritics, hyphen-vs-space and a trailing
    // "(…)" qualifier (docs/17 row 114). A query with nothing close yields an
    // empty list, and the seam then says nothing rather than misleading.
    nearest: nearestLibraryCreatures,
  });
}

/**
 * The cast an entity's record ASKED for, or `null` — read from the module row
 * (`domain/module.bestiarySlotForEntity`), so a caller cannot ask for a cast
 * the module never recorded, and the encounter side has nowhere to put one.
 */
function castSlotFor(module: Module, name: string): EntityBestiarySlot | null {
  return bestiarySlotForEntity(module.entityKinds, name);
}

/**
 * The ONE mapping from a settled run that did NOT complete to this batch's
 * per-entity failure record (docs/17 rows 128/131). TWO arms of the batch wait
 * on a run — the entity's own creation run, and the DESCRIPTION run a cast row
 * gets — and both must say the same thing about the same facts: which entity,
 * which run, the run's terminal status, its own `failureKind` and
 * `errorMessage`, and the RAW engine row behind the sentence.
 *
 * The ONE thing the two cannot share is the sentence for the anomaly a
 * COMPLETED run with nothing to show is, because "producing an artifact" and
 * "writing the description of a row that already exists" are different
 * achievements — so the caller hands in its own words (`completedWithout`) and
 * everything else is decided here, once.
 */
function runFailureRecord(
  name: string,
  runId: Id,
  outcome: PersonaRun,
  completedWithout: string,
): EntityBatchFailure {
  return {
    name,
    kind: outcome.failureKind === 'cancelled' ? 'interrupted' : 'run-not-completed',
    message: outcome.status !== 'completed' ? runNotCompletedReason(outcome) : completedWithout,
    runId,
    status: outcome.status,
    ...(outcome.failureKind ? { failureKind: outcome.failureKind } : {}),
    errorMessage: outcome.errorMessage,
    raw: outcome,
  };
}

/** Plural bucket label for the progress bar ("Generating 3 npcs"). */
export const KIND_PLURALS: Record<StubKind, string> = {
  npc: 'npcs',
  location: 'locations',
  event: 'events',
  faction: 'factions',
  note: 'notes',
  encounter: 'encounters',
};

export interface EntityBatchTarget {
  /** The exact wiki-link name the produced artifact must carry. */
  name: string;
  /**
   * CHANGE an artifact that already exists instead of creating one (the change
   * seam, docs/17 row 101): the run fills THIS row in place through the run
   * engine's in-place refill — identity (name, scope, tags, links, images)
   * preserved, the model's invented name kept as an alias, provenance
   * (`writerModel`) recorded on the row exactly as a refill records it. An
   * omit is the creation path, byte-identical to before: the artifact is
   * born MODULE-OWNED via `placementModuleId`.
   *
   * The two are mutually exclusive by contract (the engine refuses a run that
   * carries both), which is why the worker passes exactly one of them.
   */
  artifactId?: Id;
}

export interface RunEntityBatchInput {
  module: Module;
  campaign: Campaign;
  kind: StubKind;
  targets: readonly EntityBatchTarget[];
  /**
   * Free-text change instruction (the change seam): appended to EVERY brief
   * this batch builds, in the one `Additional instruction: …` form
   * (`llm/additionalInstruction`). Empty/omitted = no instruction — the
   * briefs are byte-identical to the ones this batch always sent, which is
   * what every module-generation, panel and automation pin asserts.
   */
  instruction?: string;
}

/**
 * WHICH way an entity ended up without an artifact. The distinction is the
 * owner's own question put into the record ("is my generator broken, or is the
 * system deliberately declining?"), so it is a field rather than something a
 * reader has to parse out of the sentence:
 *
 * - `refused` — a designed stop. The run finished, and the batch refused to
 *   write onto the CAST CREATURE npc the run landed on (`isCastCreatureNpc`,
 *   `domain/creature`'s `castCreatureWriteRefusal`). Nothing is broken.
 * - `interrupted` — the run's own `failureKind` is `'cancelled'` (`docs/05`
 *   renders it "Cancelled or interrupted"): it died with the page
 *   (`db/runRepo.failRunningRuns`, 'Interrupted by reload') or was aborted.
 *   Nothing is broken either — the batch just has to be run again.
 * - `run-not-completed` — the run row exists and the run itself failed.
 * - `setup-error` — the batch never got as far as a finished run: something
 *   threw while setting this entity's run up.
 *
 * DELIBERATELY NOT `cancelled`: a run whose STATUS is `'cancelled'` is the
 * WITHDRAWN case this batch keeps silent (`isRunWithdrawn`, docs/17 row 117),
 * and an interruption is a different fact — status `'failed'`, the run killed
 * under it. Two names for two things, so neither can be read as the other.
 */
export type EntityBatchFailureKind =
  | 'refused'
  | 'interrupted'
  | 'run-not-completed'
  | 'setup-error';

/**
 * One entity whose run produced no artifact, with the reason AND the raw
 * evidence behind it. The reporting layer (`entity-batch-report`) is the only
 * reader: it composes the owner-facing sentence and the console payload from
 * exactly these fields, so nothing is flattened away on the way (AGENTS rule
 * 1) and the two surfaces cannot drift apart (rule 4).
 */
export interface EntityBatchFailure {
  /** The entity (wiki-link target) the failed run belonged to. */
  name: string;
  /** Which path this failure came from. */
  kind: EntityBatchFailureKind;
  /** The run's errorMessage, the thrown setup error's message, or the
   * terminal status when the engine recorded neither. */
  message: string;
  /** The run this failure belongs to. Absent when no run was started (a setup
   * throw before `startRun`) — its presence is what lets the owner find the
   * row in the Runs tab without guessing. */
  runId?: Id;
  /** That run's terminal status, copied rather than re-read: the run row can
   * be gone (or rewritten) by the time anyone reports. */
  status?: PersonaRun['status'];
  /**
   * That run's OWN failure classification (`domain/run`), and its own
   * `errorMessage` verbatim — promoted out of the run row so the reporting
   * layer never has to reach into `raw`. `'cancelled'` is what separates "the
   * page reloaded while this was running" from "the provider or a contract
   * failed"; it is the classification the Runs tab shows beside the run.
   * Absent when the failure did not come from a run.
   */
  failureKind?: FailureKind;
  errorMessage?: string;
  /**
   * The RAW value behind `message`, kept for the console payload (never
   * rendered into a toast):
   *
   * - `refused` → the destination artifact the write was refused for — the
   *   cast creature whose name collides;
   * - `interrupted` / `run-not-completed` → the run ROW (`PersonaRun`), i.e.
   *   the engine's own record of what happened;
   * - `setup-error` → the value that was thrown (a `ZodError` included, so
   *   the issues survive as objects rather than as a JSON wall in a string).
   */
  raw?: unknown;
}

export interface EntityBatchProduced {
  /** The entity (wiki-link target) the run belonged to. */
  name: string;
  /** The produced artifact's id (name-aligned, module-owned + tagged). */
  artifactId: Id;
  /**
   * What the run did to the entity's STAT BLOCK (docs/17 row 247). Read off the
   * engine's OWN step record — `regenerated` when the statblock step completed,
   * `kept` when a REFILL's step was skipped (the row keeps the block it already
   * had), `none` when no block was in play (a create whose draft declined, or a
   * cast entity whose numbers are the library's).
   *
   * WHY IT IS CARRIED rather than left in the run row: the owner's second
   * symptom was a change that reported `changed` while the stat block was
   * untouched, so the CHANGE seam (and the chat reading it) must be able to say
   * which of the two happened instead of implying a full regeneration.
   */
  statBlock: EntityBatchStatBlock;
}

/** See `EntityBatchProduced.statBlock`. */
export type EntityBatchStatBlock = 'regenerated' | 'kept' | 'none';

/**
 * The stat-block outcome of ONE finished run, from the engine's own step record
 * (`statblock`): `done` = a block was authored; `skipped` on a REFILL = the
 * target's existing block survives by design; anything else = no block in play.
 * The engine owns the decision, this only names it — no merge rule is
 * re-implemented here.
 */
function statBlockOutcomeOf(run: PersonaRun, isRefill: boolean): EntityBatchStatBlock {
  const step = run.steps.find((candidate) => candidate.name === 'statblock');
  if (step === undefined) return 'none';
  if (step.status === 'done') return 'regenerated';
  if (step.status === 'skipped') return isRefill ? 'kept' : 'none';
  return 'none';
}

export interface EntityBatchResult {
  /** Names whose chain step completed (artifact produced + aligned). */
  generated: string[];
  /**
   * Names whose entity record carried a BESTIARY SLOT and whose cast landed
   * (docs/17 row 107) — the artifact exists, module-owned, with the library
   * creature's stats behind its `creatureRef`. Kept OUT of `generated` on
   * purpose: `generated` counts artifacts a persona RUN produced, and a cast
   * artifact is the CAST's — its stats are the library's and its identity is
   * the citation, whatever the run below writes into it. Since docs/17 row 133 —
   * and for the ENTITY case the owner-ratified reversal in row 135 — every cast
   * entity is ALSO detailed by her own persona, TARGETING the cast row, with the
   * module's own paragraphs riding the brief as CONTEXT rather than standing in
   * for a description: a real run whose prose lands on a row it did not create,
   * which is why the classification stays `cast` rather than moving to
   * `generated`: the caller-facing fact is that this name was cast from the
   * library, and a caller can tell the two apart without reading statuses.
   */
  cast: string[];
  /** The produced artifacts, name-matched — callers that need the artifact
   * itself (the stub popover returns the artifactId) without re-resolving
   * the wiki link. A cast artifact is in here too: it IS the produced
   * artifact for that entity. */
  produced: EntityBatchProduced[];
  /** Entities that produced no artifact, with the reason and the raw evidence
   * — reported through the ONE seam (`features/modules/entity-batch-report`),
   * loud in the console and in a toast (AGENTS rule 2). A CAST entity whose
   * description run failed is the one case that appears BOTH here and in `cast`
   * (docs/17 row 133): its artifact exists — the cast landed, the citation
   * stands, the portrait is on it — and what did not arrive is the authored
   * prose, which is exactly the failure the owner has to hear about. */
  failed: EntityBatchFailure[];
}

/**
 * The entity boundary's LOUD report for a recorded LEVEL hint whose name the
 * module's own text never mentions (docs/17 row 197, AGENTS rules 1-3): such a
 * hint can never reach a generator, because the mention rule is what makes a
 * name a batch target, and without this report it would be dropped in SILENCE.
 *
 * It never repairs and never invents: no artifact is created for the name, no
 * record is written, and the batch runs on — the hint is an authoring mistake,
 * not corrupt data, so it is NAMED and the work continues. The console line is
 * the pasteable record; the toast is the user-visible surface (AGENTS rule 2 —
 * a console entry alone is forbidden).
 *
 * Exported so the ONE derivation can be pinned directly, and called once, at
 * the batch entry point every entity-generation path shares.
 */
export function reportUnmatchedEntityLevelHints(module: Module): ModuleEntityKind[] {
  const unmatched = unmatchedEntityLevelHints(
    extractWikiLinks(moduleDocumentText(module)).map((link) => link.name),
    module.entityKinds,
  );
  for (const record of unmatched) {
    const message =
      `The module fixes a level for «${record.name}» (level ${String(record.levelHint)}), but its text never ` +
      `mentions that name, so the hint reached no generator. A hint is not an entity — nothing was created for ` +
      `it. Mention the name in the module text, or remove the hint, and generate again.`;
    console.error(
      `[campaigner] entity level hint unmatched ${JSON.stringify({
        moduleId: module.id,
        name: record.name,
        levelHint: record.levelHint,
      })}`,
    );
    toastError('Entity level hint names nothing in the module text', new Error(message));
  }
  return unmatched;
}

/**
 * Runs one batch. Throws only on setup failures (no persona); run failures
 * are collected into `failed` — the CALLER reports them, and both callers
 * report them through the one seam (`features/modules/entity-batch-report`),
 * so the panel's button and the unattended sweep say the same thing.
 */
export async function runEntityBatch(input: RunEntityBatchInput): Promise<EntityBatchResult> {
  const { module, campaign, kind, targets } = input;
  const instruction = input.instruction ?? '';
  // A recorded level hint the text never mentions cannot reach a generator:
  // report it LOUDLY and by name before any work (docs/17 row 197). Never a
  // reason to invent an entity, and never a silent drop.
  reportUnmatchedEntityLevelHints(module);
  // The epoch this batch belongs to: consulted at every worker entry, so a
  // stop withdraws the remaining targets instead of launching them.
  const epoch = getStopEpoch();
  const moduleTag = moduleTagFor(module.title);
  const moduleText = moduleDocumentText(module);
  const jobId = `module-entities-${module.id}-${kind}`;
  const total = targets.length;
  const progressStart = useProgressStore.getState().start;
  const progressUpdate = useProgressStore.getState().update;
  const progressFinish = useProgressStore.getState().finish;
  progressStart(jobId, `Generating ${String(total)} ${KIND_PLURALS[kind]}`);
  const generated: string[] = [];
  const cast: string[] = [];
  const produced: EntityBatchProduced[] = [];
  const failed: EntityBatchFailure[] = [];
  /**
   * THE ONE FUNNEL a failure goes through: it is APPENDED to the batch's list
   * and WRITTEN DOWN through the reporting seam, at the moment it happens —
   * never later, because a batch can die mid-flight (a page reload, the owner's
   * Stop, a throw out of this function) and a failure that is only reported at
   * batch end would leave no evidence at all. Every failure arm below calls
   * this, and a scan pin holds `failed.push` to this one line so a NEW arm
   * cannot append without recording.
   */
  const recordFailure = (failure: EntityBatchFailure): void => {
    failed.push(failure);
    recordEntityBatchFailure({ module, campaign, kind, total }, failure);
  };
  // In-flight entities for the dock detail: name → current run step label.
  const inFlight = new Map<string, string | null>();
  let completed = 0;
  // Set once the first run comes back 'cancelled' (user stop): no further
  // target is launched and the dock says so instead of claiming progress.
  let withdrawn = false;
  const updateDetail = (): void => {
    if (withdrawn) {
      progressUpdate(jobId, { detail: 'Stopped by the user' });
      return;
    }
    const parts = [...inFlight.entries()].slice(0, 3).map(([name, label]) =>
      `"${name}"${label === null ? '' : ` — ${label}`}`,
    );
    progressUpdate(jobId, {
      detail: parts.length === 0 ? 'Wrapping up…' : `Generating ${parts.join(' · ')}`,
      progress: completed / total,
    });
  };
  /**
   * THE ONE WITHDRAWAL (docs/17 row 117): the first run that comes back
   * cancelled IS the owner's Stop — the engine's ONE withdrawal predicate
   * (`isRunWithdrawn`, read by both arms that wait on a run below) — so nothing
   * is reported for it and the pool starts no further unit: a stopped
   * orchestration must not launch the next target. Before this fold the pool
   * recorded a cancelled run as a per-entity failure, which is how a stop
   * turned into "3 of 5 npcs failed to generate" toasts about nothing.
   */
  const withdrawPool = (): void => {
    if (!withdrawn) {
      withdrawn = true;
      updateDetail();
    }
  };
  // Live step labels for the dock detail ("Kael — drafting…"), per run.
  const runNames = new Map<Id, string>();
  const unsubscribeRun = runEngine.on((event) => {
    if (event.kind !== 'step') return;
    const name = runNames.get(event.runId);
    if (name === undefined || !inFlight.has(name)) return;
    inFlight.set(
      name,
      event.stepName === undefined ? null : RUN_STEP_LABELS[event.stepName] ?? event.stepName,
    );
    updateDetail();
  });
  const producedIds: Id[] = [];
  /**
   * The ids this batch must NOT stamp: an in-place change target already
   * exists with its own scope and tag (the seam resolved `module` FROM that
   * row), and `stampModuleOwnership` is a scope writer — a change never
   * re-scopes an artifact (docs/18 §2.1). Creation targets are the only ones
   * the stamp below belongs to.
   */
  const changeTargets = new Set<Id>(
    targets.flatMap((target) => (target.artifactId === undefined ? [] : [target.artifactId])),
  );
  try {
    const personas = await listPersonas();
    const persona =
      personas.find((candidate) => candidate.slug === STUB_PERSONA_SLUGS[kind]) ??
      personas.find((candidate) => candidate.producesKind === kind);
    if (persona === undefined) {
      throw new Error(`No persona available to detail ${kind}s — check Settings → Personas`);
    }
    const settings = await getSettings();
    const limit = Math.max(1, settings.maxParallelRequests);
    // The fixed-cast pool (docs/11): encounter briefs build AFTER the
    // NPC/monster results land — the batch orchestration runs encounters
    // last (post-generation's kind order), and this snapshot re-reads the
    // campaign rows fresh here, so every NPC/monster an earlier batch
    // drafted is visible at brief time. Single-kind panel batches read the
    // same table: already-drafted scene members pin, undrafted names cast
    // as usual.
    const castPool = kind === 'encounter' ? await listArtifactsByCampaign(campaign.id) : [];

    await mapWithConcurrency(targets, limit, async (target) => {
      // Between units: the pool takes the next target only while no stop has
      // landed since this batch started. A stop that arrives while a run is
      // in flight is handled below (the outcome comes back 'cancelled').
      if (stoppedSince(epoch)) return;
      inFlight.set(target.name, null);
      updateDetail();
      // The run this entity starts, when it gets far enough to have one: the
      // catch below reports it too (a wait that throws still leaves a row in
      // the Runs tab, and the owner has to be able to find it).
      let runId: Id | undefined;
      try {
        // The brief stands alone per entity: module text around the wiki-link
        // plus the spine premise — no dependency on sibling entities.
        // Encounter and NPC drafts additionally carry the structured level
        // context (docs/11): the referencing part's exact level at this same
        // mention position; other stub kinds have no level semantics and stay
        // byte-identical. Encounter drafts additionally carry the fixed cast
        // (docs/11): drafted NPCs/monsters sharing this scene's context, with
        // the must-appear instruction — the rest of the roster casts as usual.
        // And encounter drafts present that same scene text as THE SCENE THIS
        // ENCOUNTER MUST STAGE (docs/11 assertion rule, docs/17 row 89): the
        // prose is the truth about this fight, fixed in what it states. Every
        // other stub kind keeps the pre-rule brief bytes.
        //
        // Built for BOTH arms below (docs/17 rows 133/135): EVERY cast entity is
        // detailed by its OWN persona through this same brief, and the module's
        // own paragraphs ride it as CONTEXT — one request to the model for one
        // entity, whichever destination it writes into.
        const contextParagraphs = surroundingParagraphs(moduleText, target.name);
        // The module author's recorded LEVEL for this entity (docs/17 row 197),
        // read through the ONE reader (`entityLevelHintFor`) exactly like the
        // intent note below. READ HERE — by name off `module.entityKinds` — and
        // not carried on `EntityBatchTarget`: the note precedent is decisive, and
        // a target field would have to be attached by all FOUR target-building
        // call sites (the panel, the automation sweep, the stub popover's
        // single-entity delegation and the change/refill lane), which is the
        // "rule enforced at three call sites" AGENTS rule 4 forbids. `null` for
        // every entity without a hint, which leaves the brief AND the run input
        // byte-identical to before this field existed.
        const levelHint = stubKindCarriesPartyLevel(kind)
          ? entityLevelHintFor(module.entityKinds, target.name)
          : null;
        const brief = buildEntityBrief(
          target.name,
          contextParagraphs,
          module.spine?.premise ?? '',
          stubKindCarriesPartyLevel(kind) ? partLevelForMention(module, target.name) : undefined,
          kind === 'encounter'
            ? await fixedCastForEncounter(target.name, contextParagraphs, castPool, module.id)
            : [],
          kind === 'encounter',
          // The batch's kind IS the entity's kind, and it keys the brief's
          // OWNERSHIP BOUNDARY (docs/17 row 140): a location/event/faction
          // detail is told what the encounter owns, so it references the
          // opposition instead of writing tactics and GM handling advice for
          // a fight it does not own. `npc`/`encounter`/`note` render the
          // pre-boundary bytes exactly.
          kind,
          instruction,
          // The module author's recorded intent for this entity (docs/17 row
          // 141), read through the ONE reader (`entityIntentFor`) and rendered
          // as the brief's own paragraph just before the instruction. `null`
          // for every entity without a note — which is every module written
          // before the field — leaving the brief byte-identical. This seam is
          // the batch's, the post-generation automation's, the stub popover's
          // single-entity delegation's AND the change/refill lane's (the change
          // lane re-enters through `runEntityBatch` with the module row), so
          // every detail worker receives the note by construction.
          entityIntentFor(module.entityKinds, target.name),
          // ...and the author's recorded LEVEL (docs/17 row 197), read through
          // the sibling reader and rendered right after the party-level line.
          // `null` renders nothing and leaves the brief byte-identical.
          levelHint,
        );
        // THE CAST PATH (docs/17 row 107, docs/11 §Module-side cast): this
        // entity's RECORD carries a bestiary slot, so its stats are a LIBRARY
        // creature's and it must be born through the ONE cast function — never
        // by running a persona that would author a stat block beside the
        // citation (`npcDataSchema` refuses that pair by name) and never by
        // writing `creatureRef` here. The creature's numbers come from the
        // library, and the row is BORN with the module's own text about the
        // entity — the paragraphs around its wiki-link. `castCreatureAsNpc`
        // reuses an existing cast of the same creature under the same name (so a
        // second run mints no twin) and its prose is never rewritten by a later
        // cast.
        const slot = castSlotFor(module, target.name);
        if (slot !== null && kind === 'npc' && target.artifactId === undefined) {
          const citation = await libraryCitationForEntity(target.name, slot, campaign.system);
          // The prose the cast row is BORN with: the module's own paragraphs
          // about this entity, at the mention site. A batch target is always a
          // wiki-link of the module text (`post-generation.batchTargets`), so
          // the empty case cannot arise from a real target; the name stands in
          // only to keep a hand-supplied target's body NON-EMPTY rather than
          // empty (AGENTS rule 1), and the description run below replaces both
          // anyway. MEASURED, not assumed: this fallback is the one line at this
          // arm no pin reaches (docs/08 §REVERT-PROVEN, injection I6), precisely
          // because no real target can be in that state.
          const context = contextParagraphs.trim();
          const castOutcome = await castCreatureAsNpc({
            campaignId: campaign.id,
            moduleId: module.id,
            citation,
            name: target.name,
            prose: { body: context === '' ? target.name : context },
          });
          producedIds.push(castOutcome.artifactId);
          cast.push(target.name);
          // A cast entity's numbers are the LIBRARY creature's, never authored by
          // a statblock step — `none` says exactly that (docs/17 row 247).
          produced.push({ name: target.name, artifactId: castOutcome.artifactId, statBlock: 'none' });
          // THE DESCRIPTION A TEXT-NAMED ROW MUST HAVE (docs/17 rows 133/135).
          // An NPC is named BECAUSE it is a wiki-link in the module text — that
          // link IS the name (the owner's ruling, verbatim in docs/17 row 135) —
          // so there is no "does the text describe her?" question to ask and no
          // case where the mention stands in for a description: the module's
          // mention is the material the description is written FROM, and it has
          // ALREADY been handed to the model through `brief` above. The entity's
          // own persona therefore runs AGAINST THE ROW it was just cast into —
          // the cited row's existing refill, which is the only sanctioned way to
          // write a cast row's prose: its statblock step is skipped with its
          // reason before the model call (docs/11 §A cited row's REFILL), the
          // citation survives byte-identical, and `statBlock` stays null. The
          // numbers stay the library's; the citation stays the identity; only the
          // prose is authored.
          //
          // Nothing here needs to guard against clobbering: this row was created
          // by the cast immediately above (a name with any authored entity is
          // never a batch target — `post-generation.batchTargets` filters on the
          // panel's own `hasDetailedEntity` verdict, which is exactly what a row
          // carrying a description is), and the reused-row case is unreachable
          // for the same reason. A target carrying `artifactId` (the change
          // seam) never enters this arm at all.
          const castRow = await artifactRepo.getArtifact(castOutcome.artifactId);
          if (castRow === undefined) {
            throw new Error(
              `the cast npc «${target.name}» is gone right after it was cast — there is nothing to write a description into`,
            );
          }
          runId = await runEngine.startRun({
            campaign,
            persona,
            autonomy: 'auto' as const,
            brief,
            pinnedChunkIds: [],
            // The module author's structured level (docs/17 row 197): the
            // stat-block step reads THIS, not a sentence re-parsed out of the
            // brief. Omitted (not null) when there is no hint, so the no-hint
            // run input is byte-identical to before.
            ...(levelHint === null ? {} : { entityLevelHint: levelHint }),
            // A REFILL of the row that exists: no placement — the run fills the
            // cast row in place, exactly like the persona panel's targeted run.
            targetArtifactId: castOutcome.artifactId,
          });
          runNames.set(runId, target.name);
          const outcome = await waitForRunStatus(runId);
          if (isRunWithdrawn(outcome)) {
            // The owner's Stop, not a failure — the ONE withdrawal rule, shared
            // with the creation arm below (`withdrawPool`).
            withdrawPool();
            return;
          }
          if (outcome.status !== 'completed' || outcome.resultArtifactId === null) {
            // LOUD (AGENTS rule 2): the row exists and its citation stands, but
            // the description it was supposed to get did not arrive — reported
            // through the batch's ONE funnel like every other failed run, so the
            // owner hears "this one has no text" instead of finding a bare row
            // later. The row now EXISTS, so this name is a detailed entity and
            // no longer a batch target (`hasDetailedEntity`): a retry means
            // dropping the row and generating the entity again, not re-running
            // this same target.
            recordFailure(
              runFailureRecord(
                target.name,
                runId,
                outcome,
                'the run completed without writing the description',
              ),
            );
          }
          return;
        }
        const runInput: StartRunInput = {
          campaign,
          persona,
          autonomy: 'auto' as const,
          brief,
          pinnedChunkIds: [],
          // The module author's structured level (docs/17 row 197): carried to
          // the run so the stat-block step reads the RECORDED level instead of
          // re-parsing the brief. Omitted when there is no hint, so the no-hint
          // run input stays byte-identical.
          ...(levelHint === null ? {} : { entityLevelHint: levelHint }),
          // Two destinations, exactly one of them per target:
          //
          // - CHANGE (the change seam): the row already exists, so the run
          //   fills it in place (`targetArtifactId`) and must NOT carry a
          //   placement — the engine refuses a run that carries both, and an
          //   existing artifact's scope changes only through explicit scope
          //   moves (docs/18 §2.1), never as a side effect of a change.
          // - CREATE (the panel's batches, the automation, the stub popover):
          //   the artifact is module-owned FROM BIRTH (not stamped after the
          //   run) — the post-run automatic battlemap reads the encounter's
          //   own moduleId to apply the module's master switch, and wiki-links
          //   resolve against the module during the run. The tag stamp below
          //   stays for the module:tag compatibility marker.
          ...(target.artifactId === undefined
            ? { placementModuleId: module.id }
            : { targetArtifactId: target.artifactId }),
        };
        runId = await runEngine.startRun(runInput);
        runNames.set(runId, target.name);
        const outcome = await waitForRunStatus(runId);
        if (isRunWithdrawn(outcome)) {
          // WITHDRAWN, not failed — the ONE withdrawal rule (`withdrawPool`),
          // which stops the pool too: every later target would just start a run
          // that is already doomed.
          withdrawPool();
          return;
        }
        if (outcome.status === 'completed' && outcome.resultArtifactId !== null) {
          // The DESTINATION of this entity is checked before anything is
          // written (the cast guard): a run that landed on a CAST CREATURE npc
          // must not be renamed, re-scoped or tagged. Before this guard the
          // rename/tag below silently took such a row over, which is how an
          // invented NPC's name became the linked creature's — the
          // owner-reported defect this whole arc answers. The refusal is LOUD (a
          // per-entity failure + its toast) and writes nothing.
          const destination = await artifactRepo.getArtifact(outcome.resultArtifactId);
          if (destination !== undefined && isCastCreatureNpc(destination)) {
            const refusal = castCreatureWriteRefusal(destination.name, target.name);
            recordFailure({
              name: target.name,
              kind: 'refused',
              message: refusal,
              runId,
              status: outcome.status,
              // A run row carries a classification or null; a faked engine row
              // may omit it entirely, so the presence test is truthiness.
              ...(outcome.failureKind ? { failureKind: outcome.failureKind } : {}),
              errorMessage: outcome.errorMessage,
              raw: destination,
            });
            toastError(`Refused to write a generated entity onto ${castCreatureLabel(destination.name)}`, new Error(refusal));
          } else {
            producedIds.push(outcome.resultArtifactId);
            generated.push(target.name);
            produced.push({
              name: target.name,
              artifactId: outcome.resultArtifactId,
              statBlock: statBlockOutcomeOf(outcome, target.artifactId !== undefined),
            });
            try {
              // The wiki-link resolves by EXACT name, so an artifact the model
              // named "Kael Ashbound…" would never link back to [[Kael]] —
              // enforce the entity name and keep the model's name as an alias.
              const refusedNames = await alignEntityName(outcome.resultArtifactId, target.name);
              // The model's name was another artifact's (docs/17 row 226): the
              // rename landed, the alias was NOT attached, and that is spoken
              // here — never a silent drop (AGENTS rule 1).
              for (const collision of refusedNames) {
                toastError(
                  'A returned name belongs to another artifact — not attached as an alias',
                  new Error(aliasCollisionSentence(collision)),
                );
              }
            } catch (error) {
              toastError(`Could not align the artifact name for "${target.name}"`, error);
            }
          }
        } else {
          // Loud per-entity reason (AGENTS rule 2): the run's own
          // errorMessage when the engine recorded one, the terminal status
          // otherwise — the engine's ONE sentence seam for why a run did not
          // finish (docs/18 §2, `runNotCompletedReason`). A completed run
          // without an artifact is its own anomaly and says so.
          //
          // AN INTERRUPTION IS ITS OWN CLASS, not a generation failure: a run
          // killed with the page is marked `status: 'failed'` with
          // `failureKind: 'cancelled'` (`db/runRepo.failRunningRuns`), which is
          // deliberately NOT the `status: 'cancelled'` the withdrawal predicate
          // above keeps silent — so without this branch a reload mid-batch
          // would be reported to the owner as "N of M npcs failed to generate".
          recordFailure(
            runFailureRecord(
              target.name,
              runId,
              outcome,
              'the run completed without producing an artifact',
            ),
          );
        }
      } catch (error) {
        // Setup failure for this entity (e.g. key missing): recorded as a
        // failure with its reason — the batch continues with the others. The
        // THROWN VALUE rides along untouched (`raw`): the reporting layer needs
        // the object, not the sentence `errorMessage` makes of it — a
        // ZodError's `message` is the raw issues array (AGENTS rule 1).
        recordFailure({
          name: target.name,
          kind: 'setup-error',
          message: errorMessage(error),
          ...(runId === undefined ? {} : { runId }),
          raw: error,
        });
      } finally {
        inFlight.delete(target.name);
        completed += 1;
        updateDetail();
      }
    });

    // Stamp the compatibility tag (the artifacts are already module-owned
    // from birth via placementModuleId — this is idempotent for both).
    for (const artifactId of producedIds) {
      if (changeTargets.has(artifactId)) continue;
      try {
        const artifact = await artifactRepo.getArtifact(artifactId);
        if (artifact !== undefined && (artifact.moduleId !== module.id || !artifact.tags.includes(moduleTag))) {
          await artifactRepo.stampModuleOwnership(artifactId, module.id, moduleTag);
        }
      } catch (error) {
        toastError('Could not scope a produced artifact', error);
      }
    }
    // Stable order: the input target order, not completion order.
    const failureByName = new Map(failed.map((failure) => [failure.name, failure]));
    const producedByName = new Map(produced.map((entry) => [entry.name, entry]));
    return {
      generated,
      cast,
      produced: targets.flatMap((target) => {
        const entry = producedByName.get(target.name);
        return entry === undefined ? [] : [entry];
      }),
      failed: targets.flatMap((target) => {
        const failure = failureByName.get(target.name);
        return failure === undefined ? [] : [failure];
      }),
    };
  } finally {
    unsubscribeRun();
    progressFinish(jobId);
  }
}


