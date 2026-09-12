import type { Campaign, EntityBestiarySlot, Id, Module } from '@/domain';
import { bestiarySlotForEntity, moduleDocumentText, moduleTagFor } from '@/domain';
import type { CreatureCitation } from '@/domain/encounterResolve';
import { artifactRepo, db } from '@/db';
import { listArtifactsByCampaign } from '@/db/artifactRepo';
import { castCreatureLabel, castCreatureWriteRefusal, isCastCreatureNpc } from '@/domain';
import { castCreatureAsNpc, listLibraryCreatures } from '@/db/creatureRepo';
import { listPersonas } from '@/db/personaRepo';
import { getSettings } from '@/db/settingsRepo';
import { runEngine, waitForRunStatus, type StartRunInput } from '@/llm/runEngine';
import { errorMessage } from '@/lib/errors';
import {
  buildEntityBrief,
  STUB_PERSONA_SLUGS,
  stubKindCarriesPartyLevel,
  type StubKind,
} from '@/features/modules/persona-request';
import { fixedCastForEncounter, partLevelForMention } from '@/llm/roomBudget';
import { surroundingParagraphs } from '@/lib/wikilinks';
import { mapWithConcurrency } from '@/lib/parallel';
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
 * artifact is reported loudly (toast + the failed runs in the Runs tab).
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
 */
export async function alignEntityName(artifactId: Id, entityName: string): Promise<void> {
  const artifact = await artifactRepo.getArtifact(artifactId);
  if (artifact === undefined) return;
  if (isCastCreatureNpc(artifact)) {
    throw new Error(castCreatureWriteRefusal(artifact.name, entityName));
  }
  if (artifact.name.trim().toLowerCase() === entityName.trim().toLowerCase()) return;
  const modelName = artifact.name;
  const aliases = artifact.aliases.some(
    (alias) => alias.trim().toLowerCase() === modelName.trim().toLowerCase(),
  )
    ? artifact.aliases
    : [...artifact.aliases, modelName];
  await artifactRepo.updateArtifact(artifactId, { name: entityName, aliases });
}

/** The library's OWN disclosure of where one candidate creature comes from:
 * the rulebook's title exactly as an origin label renders it (a pack's title,
 * or the 'Rulebook' placeholder when the row's own title is empty — the same
 * reading `domain/encounterResolve.creatureOriginLabel` performs). ONE reading
 * of "which book is this creature from", and the same one every creature
 * surface shows, so a slot's `book` is matched against what the owner can
 * actually read on screen. */
async function creatureBookTitle(chunkId: Id): Promise<string> {
  const chunk = await db.chunks.get(chunkId);
  if (chunk === undefined) return 'Rulebook';
  const book = await db.rulebooks.get(chunk.bookId);
  const title = book?.title.trim() ?? '';
  return title === '' ? 'Rulebook' : title;
}

/**
 * The cast an entity's BESTIARY SLOT asked for, resolved against the library
 * (docs/17 row 107, "The Aunt Agatha case").
 *
 * This is a NAME lookup over the library pool the rest of the app already reads
 * (`db/creatureRepo.listLibraryCreatures` — the ONE stat-block pool, the same
 * one the wiki-link resolver and the bestiary browser use). It is NOT a second
 * creature lookup: it answers "which chunk does this name mean?", and
 * everything after that — the citation's identity, the derived stats, the
 * portrait key — is `castCreatureAsNpc`'s, unchanged.
 *
 * EVERY failure is LOUD and NAMES both halves (AGENTS rules 1-3), because the
 * alternative is the exact defect this path must not have: a guess, or a silent
 * drop of the prose the model wrote:
 *
 * - no creature of that name in the workspace (a module designed before the
 *   bestiary was imported, a typo, a creature the owner deleted);
 * - the name is ambiguous — two creatures share it, which happens the moment
 *   two books are installed — and the slot named no book, or named a book that
 *   holds no such creature.
 */
async function libraryCitationForEntity(
  entityName: string,
  slot: EntityBestiarySlot,
): Promise<CreatureCitation> {
  const wanted = slot.creature.trim();
  const book = slot.book?.trim() ?? '';
  const named = `the entity «${entityName}» asks to borrow the stats of «${wanted}»`;
  const pool = await listLibraryCreatures();
  const sameName = pool.filter(
    (creature) => creature.name.trim().toLowerCase() === wanted.toLowerCase(),
  );
  // The library's own disclosure of which book each candidate comes from. Read
  // for the candidates ONLY, and only when a book is named or the name turns
  // out to be ambiguous, so the common unambiguous case costs nothing.
  const titleOf = new Map<string, string>();
  const titleFor = async (chunkId: string): Promise<string> => {
    const cached = titleOf.get(chunkId);
    if (cached !== undefined) return cached;
    const title = await creatureBookTitle(chunkId);
    titleOf.set(chunkId, title);
    return title;
  };
  const describe = async (entries: typeof pool): Promise<string> => {
    const lines = await Promise.all(
      entries.map(async (entry) => `${entry.name} (${await titleFor(entry.chunkId)})`),
    );
    return lines.join(', ');
  };
  if (sameName.length === 0) {
    throw new Error(
      `bestiary cast: ${named}, but this workspace's library holds no creature of that name — ` +
        'import the book it comes from, or name a creature the library has (never a guess)',
    );
  }
  let candidates = sameName;
  if (book !== '') {
    candidates = [];
    for (const entry of sameName) {
      if ((await titleFor(entry.chunkId)).toLowerCase() === book.toLowerCase()) {
        candidates.push(entry);
      }
    }
    if (candidates.length === 0) {
      throw new Error(
        `bestiary cast: ${named} from the book «${book}», but that book holds no creature of that ` +
          `name — the library has ${await describe(sameName)}`,
      );
    }
  }
  if (candidates.length > 1) {
    throw new Error(
      `bestiary cast: ${named}, but this workspace's library holds ${String(candidates.length)} creatures ` +
        `of that name (${await describe(candidates)}) — name the book in the entity's bestiary slot ` +
        '("book": the book\'s title) so the cast is unambiguous',
    );
  }
  const resolved = candidates[0];
  if (resolved === undefined) {
    // Unreachable: the empty case threw above and any ambiguity threw just
    // here. Stated rather than asserted so the compiler proves it too.
    throw new Error(`bestiary cast: ${named}, and no library creature answered the name`);
  }
  // Built the way every other citation site builds one: the chunk, its content
  // hash at citation birth, and the library's own spelling of the creature's
  // name — so a cast made here and a cast made from the bestiary browser share
  // ONE identity and therefore one reuse rule (docs/11 D4/D9).
  return {
    chunkId: resolved.chunkId,
    contentHash: resolved.contentHash,
    creatureName: resolved.name,
  };
}

/**
 * The cast an entity's record ASKED for, or `null` — read from the module row
 * (`domain/module.bestiarySlotForEntity`), so a caller cannot ask for a cast
 * the module never recorded, and the encounter side has nowhere to put one.
 */
function castSlotFor(module: Module, name: string): EntityBestiarySlot | null {
  return bestiarySlotForEntity(module.entityKinds, name);
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

/** One entity whose run produced no artifact, with the reason. */
export interface EntityBatchFailure {
  /** The entity (wiki-link target) the failed run belonged to. */
  name: string;
  /** The run's errorMessage, the thrown setup error's message, or the
   * terminal status when the engine recorded neither. */
  message: string;
}

export interface EntityBatchProduced {
  /** The entity (wiki-link target) the run belonged to. */
  name: string;
  /** The produced artifact's id (name-aligned, module-owned + tagged). */
  artifactId: Id;
}

export interface EntityBatchResult {
  /** Names whose chain step completed (artifact produced + aligned). */
  generated: string[];
  /**
   * Names whose entity record carried a BESTIARY SLOT and whose cast landed
   * (docs/17 row 107) — the artifact exists, module-owned, with the library
   * creature's stats behind its `creatureRef`. Kept OUT of `generated` on
   * purpose: `generated` counts artifacts a persona RUN produced, and a cast
   * runs no model call at all (its stats are the library's, its prose is the
   * module's own text about the entity). A caller reporting counts can tell
   * the two apart without reading statuses.
   */
  cast: string[];
  /** The produced artifacts, name-matched — callers that need the artifact
   * itself (the stub popover returns the artifactId) without re-resolving
   * the wiki link. A cast artifact is in here too: it IS the produced
   * artifact for that entity. */
  produced: EntityBatchProduced[];
  /** Entities that produced no artifact, with the reason — loud in the
   * toast and the Runs tab (AGENTS rule 2). */
  failed: EntityBatchFailure[];
}

/**
 * Runs one batch. Throws only on setup failures (no persona); run failures
 * are collected into `failed` — the caller decides how loudly to surface
 * them (the panel toasts per batch; the automation aggregates per module).
 */
export async function runEntityBatch(input: RunEntityBatchInput): Promise<EntityBatchResult> {
  const { module, campaign, kind, targets } = input;
  const instruction = input.instruction ?? '';
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
      try {
        // THE CAST PATH (docs/17 row 107, docs/11 §Module-side cast): this
        // entity's RECORD carries a bestiary slot, so its stats are a LIBRARY
        // creature's and it must be born through the ONE cast function — never
        // by running a persona that would author a stat block beside the
        // citation (`npcDataSchema` refuses that pair by name) and never by
        // writing `creatureRef` here. A persona run is therefore NOT started
        // for this entity at all: the creature's numbers come from the library,
        // and the PROSE is the module's own text about the entity — the
        // paragraphs around its wiki-link, which is what the generator wrote
        // about her. `castCreatureAsNpc` reuses an existing cast of the same
        // creature under the same name (so a second run mints no twin) and its
        // prose is never rewritten by a later cast.
        const slot = castSlotFor(module, target.name);
        if (slot !== null && kind === 'npc' && target.artifactId === undefined) {
          const citation = await libraryCitationForEntity(target.name, slot);
          // The prose the cast row carries: the module's own paragraphs about
          // this entity — what the generator wrote about her, at the mention
          // site. An entity the text never actually mentions (it was declared
          // in the spine's entity list but never written into a scene) still
          // gets a NON-EMPTY body naming her rather than an empty one, which is
          // a state and not a placeholder (AGENTS rule 1).
          const context = surroundingParagraphs(moduleText, target.name).trim();
          const castOutcome = await castCreatureAsNpc({
            campaignId: campaign.id,
            moduleId: module.id,
            citation,
            name: target.name,
            prose: { body: context === '' ? target.name : context },
          });
          producedIds.push(castOutcome.artifactId);
          cast.push(target.name);
          produced.push({ name: target.name, artifactId: castOutcome.artifactId });
          return;
        }
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
        const contextParagraphs = surroundingParagraphs(moduleText, target.name);
        const brief = buildEntityBrief(
          target.name,
          contextParagraphs,
          module.spine?.premise ?? '',
          stubKindCarriesPartyLevel(kind) ? partLevelForMention(module, target.name) : undefined,
          kind === 'encounter'
            ? await fixedCastForEncounter(target.name, contextParagraphs, castPool, module.id)
            : [],
          kind === 'encounter',
          instruction,
        );
        const runInput: StartRunInput = {
          campaign,
          persona,
          autonomy: 'auto' as const,
          brief,
          pinnedChunkIds: [],
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
        const runId = await runEngine.startRun(runInput);
        runNames.set(runId, target.name);
        const outcome = await waitForRunStatus(runId);
        if (outcome.status === 'cancelled') {
          // WITHDRAWN, not failed (mirrors jobQueue's silent 'cancelled'
          // JobOutcome): the user stopped this generation, so there is no
          // failure to report and no artifact to expect. Stop the pool too —
          // every later target would just start a run that is already doomed.
          if (!withdrawn) {
            withdrawn = true;
            updateDetail();
          }
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
            failed.push({ name: target.name, message: refusal });
            toastError(`Refused to write a generated entity onto ${castCreatureLabel(destination.name)}`, new Error(refusal));
          } else {
            producedIds.push(outcome.resultArtifactId);
            generated.push(target.name);
            produced.push({ name: target.name, artifactId: outcome.resultArtifactId });
            try {
              // The wiki-link resolves by EXACT name, so an artifact the model
              // named "Kael Ashbound…" would never link back to [[Kael]] —
              // enforce the entity name and keep the model's name as an alias.
              await alignEntityName(outcome.resultArtifactId, target.name);
            } catch (error) {
              toastError(`Could not align the artifact name for "${target.name}"`, error);
            }
          }
        } else {
          // Loud per-entity reason (AGENTS rule 2): the run's own
          // errorMessage when the engine recorded one, the terminal status
          // otherwise; a completed run without an artifact is its own
          // anomaly and says so.
          failed.push({
            name: target.name,
            message:
              outcome.status !== 'completed'
                ? outcome.errorMessage !== ''
                  ? outcome.errorMessage
                  : `run ended ${outcome.status}`
                : 'the run completed without producing an artifact',
          });
        }
      } catch (error) {
        // Setup failure for this entity (e.g. key missing): recorded as a
        // failure with its reason — the batch continues with the others.
        failed.push({ name: target.name, message: errorMessage(error) });
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


