import type {
  AnyArtifact,
  Artifact,
  Campaign,
  EntityKind,
  Id,
  Module,
  ModuleAutomationIntent,
} from '@/domain';
import { ENTITY_KINDS, entityKindFor, moduleCreationPool, moduleDocumentText } from '@/domain';
import { listArtifactsByCampaign } from '@/db/artifactRepo';
import { getModule } from '@/db/moduleRepo';
import { getSettings } from '@/db/settingsRepo';
import {
  enqueueInventedCreaturePortraits,
  enqueueMobPortraits,
} from '@/features/campaign/mob-portrait-queue';
import {
  encounterNeedsMobPortraitWork,
  presentationArtOfCampaign,
} from '@/features/campaign/mob-portrait-participants';
import { hasDetailedEntity } from '@/features/modules/detailed-entity';
import { useEncounterMapQueue } from '@/features/modules/encounter-map-queue';
import { runEntityBatch } from '@/features/modules/entity-batch';
import { reportEntityBatchFailures } from '@/features/modules/entity-batch-report';
import { useEntityImageQueue } from '@/features/modules/entity-image-queue';
import { extractWikiLinks, resolveWikiLink } from '@/lib/wikilinks';
import { errorMessage } from '@/lib/errors';
import { moduleGenLockName, withGenerationLock } from '@/lib/generationLocks';
import { getStopEpoch, stoppedSince } from '@/lib/stopEpoch';
import { toastError, toastSuccess } from '@/lib/toast';

/**
 * Post-generation automation (module row: `autoGenerateKinds`,
 * `autoImageKinds`, `autoGenerateBattlemaps`, `autoGenerateMobImages`): after
 * a FULL parts pass has landed (spine approval or "generate missing parts" —
 * never a single-part rewrite), the module can finish its own entity workflow
 * unattended:
 *
 * 1. **Auto-generate artifacts** — for every configured kind, the unresolved
 *    wiki-link entities of that kind are batch-detailed through the same
 *    headless chain as the entity panel's batch (08 §M4-C; gated on the
 *    name-normalization pass, the fix-01 guarantee against duplicates).
 *    "Unresolved" is the panel's own verdict (`batchTargets`): a name with no
 *    authored entity of its own — including one that only resolves to a shared
 *    bestiary creature row.
 * 2. **Auto-generate images** — every resolved entity of a configured kind
 *    without an image is enqueued in the background image queue (one cover
 *    per entity). Runs AFTER the batches so newly generated artifacts are
 *    covered too.
 * 3. **Auto-generate battlemaps** — module-owned encounters without a
 *    layout/map are enqueued in the unattended encounter-map queue (docs/11
 *    §Module generation integration; auto autonomy, no pick pause).
 * 4. **Auto-generate mob portraits** — every module-owned encounter with
 *    un-imaged roster creatures is enqueued on the mob-portrait queue through
 *    the encounter editor's own batch entries, BOTH lanes (`enqueueMobPortraits`
 *    for the chunk-backed kinds, `enqueueInventedCreaturePortraits` for the
 *    participants whose creature is not chunk-backed — docs/17 row 96): one
 *    cover portrait per creature kind, canonically cached for citations.
 *    Enqueue is the contract — the queue carries the progress dock and the
 *    loud per-mob failures; this sweep never awaits portrait completion.
 *
 * Everything is idempotent: batches target only UNRESOLVED entities, the
 * image queue skips artifacts that already have an image, the map queue
 * skips encounters that already carry a map, and the portrait batch
 * enumerates away already-imaged mobs — re-running a full pass can never
 * double-generate. Failures are loud per job (toasts + the Runs tab) and
 * never stop the remaining automation.
 *
 * A STOP does (owner report: "Stop all should stop all generations, but it
 * only stops the current type loop"). This sweep is the longest-lived
 * orchestration in the app — several kinds, each a full batch, then three
 * enqueue blocks — and a cancelled unit inside it looks like a finished one
 * (the kind loop's batch returns normally, and a cancelled parts pass leaves
 * the module `'ready'`, which is exactly the status the automation gates
 * read). So the sweep captures the app-level stop epoch at entry
 * (`lib/stopEpoch`) and consults it between units: before every kind, and
 * before every enqueue block. Nothing it was about to start can outlive the
 * user's stop.
 */

/** Configured kinds in the domain's stable order (encounters last).
 *
 * The order is the fixed-cast pin (docs/11): NPCs/monsters detail BEFORE
 * encounters, so an encounter batch's brief-time snapshot already holds the
 * scene members its brief must pin as fixed cast. */
export function orderedKinds(configured: readonly EntityKind[]): EntityKind[] {
  return ENTITY_KINDS.filter((kind) => configured.includes(kind));
}

/**
 * The FULL automation target — every entity kind for details AND for images,
 * battle maps on, mob portraits on (docs/17 row 80). The entity sidebar's
 * "Generate everything" control passes this to the sweep and derives its
 * confirmation against it, so the sidebar describes exactly the work the sweep
 * would run. Both lists are the `ENTITY_KINDS` enum itself, so a kind added to
 * the domain is covered here without touching this file.
 *
 * It is NOT a recorded intent: `automationIntent` records what the owner
 * checked at creation (docs/17 row 71) and stays byte-identical — this constant
 * is a caller-supplied TARGET, never written to the module row.
 */
export const FULL_AUTOMATION_TARGET: ModuleAutomationIntent = {
  autoGenerateKinds: [...ENTITY_KINDS],
  autoImageKinds: [...ENTITY_KINDS],
  autoGenerateBattlemaps: true,
  autoGenerateMobImages: true,
};

/** Wiki-link names of the module whose recorded kind is `kind`, deduped. */
function namesOfKind(module: Module, kind: EntityKind): string[] {
  const text = moduleDocumentText(module);
  return extractWikiLinks(text)
    .map((link) => link.name)
    .filter((name) => entityKindFor(module.entityKinds, name) === kind);
}

/**
 * Batch targets: wiki-link names of the module whose recorded kind is `kind`
 * and that have NO authored, detailed entity of their own — the exact set the
 * entity batch is given. "No entity of its own" is `hasDetailedEntity` (the
 * panel's own verdict, `features/modules/detailed-entity`), so the two surfaces
 * can never disagree:
 *
 * - docs/17 row 69: a name matching a player character does NOT count as
 *   detailed, so it becomes the module's own entity instead of silently binding
 *   the module to the Party;
 * - a name whose only resolution is a LIBRARY CREATURE (docs/11 D10) does NOT
 *   count either — the creature is a read-only bestiary row with no authored
 *   detail, so the module gets ITS entity of that name (and the module tier
 *   then prefers it).
 *
 * Exported so the "Resume automatic module creation" deviation can list the
 * SAME work the sweep would do.
 */
export function batchTargets(
  module: Module,
  artifacts: readonly AnyArtifact[],
  kind: EntityKind,
): string[] {
  return namesOfKind(module, kind).filter(
    (name) => !hasDetailedEntity(resolveWikiLink(name, artifacts, { moduleId: module.id })),
  );
}

/** Image targets: resolved entities of a configured kind without an image.
 * Deliberately the RESOLUTION, not the detailed verdict above: an image job
 * attaches to whatever row the name resolves to, and the panel's images mode
 * already refuses a not-detailed row ("Detail this entity first"). Reading the
 * detailed verdict here would silently stop illustrating a name the module
 * legitimately resolves (docs/18 §4). */
export function imageTargets(module: Module, artifacts: readonly AnyArtifact[], kind: EntityKind): string[] {
  return namesOfKind(module, kind).filter((name) => {
    const artifact = resolveWikiLink(name, artifacts, { moduleId: module.id }).artifact;
    if (artifact === undefined) return false;
    return artifact.coverImageId === null && artifact.imageIds.length === 0;
  });
}

/** Map targets: module-owned encounters without a generated layout + map. */
export function encountersNeedingMaps(
  module: Module,
  artifacts: readonly AnyArtifact[],
): { id: Id; name: string }[] {
  return artifacts
    .filter(
      (artifact) =>
        artifact.kind === 'encounter' &&
        artifact.moduleId === module.id &&
        (artifact.data.layout === null || artifact.data.mapImageId === null),
    )
    .map((artifact) => ({ id: artifact.id, name: artifact.name }));
}

/**
 * Portrait targets: module-owned encounters whose roster still holds portrait
 * work — an encounter the portrait batch would enqueue for.
 *
 * THE predicate is the queue's own (`encounterNeedsMobPortraitWork`,
 * features/campaign/mob-portrait-participants): the SAME routing (by what an
 * entry's creature IS — a `rulebook` citation of a LIBRARY creature shares the
 * one bestiary portrait, and an invented `inline`/`none` entry gets its own
 * local one keyed by its content; an `npc-ref` keeps its portrait on the
 * artifact it points at), the SAME art reading and the SAME per-kind identity
 * the two enqueue lanes use. It is computed over the artifact snapshot the
 * other steps already hold: no DB read, no write, no art mutation — and, for a
 * caller with no campaign image rows to hand, the creature lanes answer
 * conservatively (work), which the skip-if-imaged queue then costs nothing.
 *
 * Why it is shared rather than re-derived (owner report, docs/17 row 96): this
 * detector used to answer with its OWN rule — roster rows whose
 * `source.type === 'rulebook'` — so every `npc-ref` row and every uncited entry
 * was invisible to the module path, and the sweep behind it enqueued the
 * rulebook lane alone. Both halves are the same defect rows 90/92 fixed for
 * the encounter editor: an offer and the work it names must read ONE rule.
 *
 * The one honest residue, and it is deliberately the loud direction: a roster
 * row pointing OUTSIDE the snapshot (a dangling `npc-ref`, a link to a row this
 * campaign does not own) counts as work. The enqueue resolves those from the DB — it enqueues the portrait it
 * finds, and THROWS with the citing name when the row is gone (the sweep
 * aggregates that into one loud per-encounter toast). Reporting them as
 * "nothing to do" would be the silent miss this seam exists to remove, and the
 * queue's own per-kind dedupe + skip-if-imaged make a re-run of an already
 * imaged kind a no-op.
 */
export function encountersNeedingMobPortraits(
  module: Module,
  artifacts: readonly AnyArtifact[],
  /** The campaign's presentation snapshot, when the caller has it (docs/11
   * D6): a caller that passes it gets an answer that AGREES with the batch; a
   * caller without it gets the conservative over-offer the predicate documents
   * (harmless — the batch is skip-if-imaged — but it can promise work the batch
   * then declines, so a surface that names specific work should pass it). */
  presentationByKey?: ReadonlyMap<string, Id>,
): (AnyArtifact & { kind: 'encounter' })[] {
  return artifacts.filter(
    // listArtifactsByCampaign yields OWNED rows only (never global), so the
    // owned encounter variant is what the predicate narrows to; it feeds the
    // batch entry's `AnyArtifact & { kind: 'encounter' }` parameter as-is.
    (artifact): artifact is Artifact & { kind: 'encounter' } => {
      if (artifact.kind !== 'encounter' || artifact.moduleId !== module.id) return false;
      return encounterNeedsMobPortraitWork(artifact, artifacts, presentationByKey);
    },
  );
}

/**
 * Runs the configured automation for one module. Fire-and-forget safe: an
 * unexpected throw is toasted, never left as an unhandled rejection. A
 * no-op when there is nothing configured (or the module was deleted mid-run).
 *
 * `target` is the OPTIONAL explicit automation target (docs/17 row 80). When
 * it is omitted the sweep reads the module ROW's own automation fields
 * (`autoGenerateKinds` / `autoImageKinds` / `autoGenerateBattlemaps` /
 * `autoGenerateMobImages`) exactly as it always did — the creation-time call
 * site and "Resume automatic module creation" are byte-identical. When it is
 * given, the sweep runs THAT target and never touches the row's fields: they
 * remain the persisted record of what the owner asked creation to automate
 * (docs/17 row 71), and a temporary write would corrupt that meaning. The
 * entity sidebar's "Generate everything" control passes
 * `FULL_AUTOMATION_TARGET`.
 */
export async function runModulePostGeneration(
  moduleId: Id,
  campaign: Campaign,
  target?: ModuleAutomationIntent,
): Promise<void> {
  // The sweep holds the module's Web Lock for its whole duration (docs/17 row
  // 110, lib/generationLocks): it is the app's longest-lived orchestration —
  // several entity batches, then three enqueue blocks — and a held Web Lock is
  // one of Chromium's documented freeze opt-outs. `withGenerationLock` NEVER
  // blocks: without the API, or with the lock already held by another tab, the
  // sweep runs exactly as before.
  return withGenerationLock(moduleGenLockName(moduleId), () =>
    runModulePostGenerationUnlocked(moduleId, campaign, target),
  );
}

/** The sweep body (see `runModulePostGeneration` for the public contract). */
async function runModulePostGenerationUnlocked(
  moduleId: Id,
  campaign: Campaign,
  target?: ModuleAutomationIntent,
): Promise<void> {
  try {
    const module = await getModule(moduleId);
    if (module === undefined) return;
    // Automation follows a completed parts pass. This check is NOT the
    // completed-vs-cancelled test: a cancelled pass keeps 'ready' with parts
    // present (Retry must stay available), so a cancel is rejected by the
    // stop-epoch guard below and by the caller's `aborted` flag.
    if (module.status !== 'ready') return;
    // The epoch this pass belongs to (see the doc comment): captured ONCE,
    // here — the moment the automation actually starts doing work, after the
    // no-op gates — so every guard below answers "did a Stop all land while
    // this automation was running?" and keeps answering yes for the rest of
    // it.
    const epoch = getStopEpoch();
    const { autoGenerateKinds, autoImageKinds, autoGenerateBattlemaps, autoGenerateMobImages } =
      target ?? module;
    if (
      autoGenerateKinds.length === 0 &&
      autoImageKinds.length === 0 &&
      !autoGenerateBattlemaps &&
      !autoGenerateMobImages
    ) {
      return;
    }

    // 1) Entity batches — gated on the name-normalization pass (fix-01):
    // a failed pass already toasted and shows its Retry in the entity
    // panel; batching on top of it could create duplicate entities.
    let generatedCount = 0;
    if (autoGenerateKinds.length > 0 && module.entityNamesNormalized) {
      for (const kind of orderedKinds(autoGenerateKinds)) {
        // Between units: a stop during the previous kind ends the sweep —
        // the cancelled batch returned normally (its per-entity outcome is
        // WITHDRAWN, not a failure), so without this guard the loop would
        // cheerfully start the next kind's batch.
        if (stoppedSince(epoch)) return;
        // The batch target set is the module-creation pool (docs/17 row 69):
        // a recorded name that happens to match a player character does NOT
        // count as detailed, so it is generated as a NEW module-owned entity
        // instead of silently binding the module to the Party — and neither
        // does one that only resolves to a shared bestiary creature row
        // (batchTargets, features/modules/detailed-entity).
        const artifacts = moduleCreationPool(await listArtifactsByCampaign(module.campaignId));
        const names = batchTargets(module, artifacts, kind);
        if (names.length === 0) continue;
        const result = await runEntityBatch({
          module,
          campaign,
          kind,
          targets: names.map((name) => ({ name })),
        });
        generatedCount += result.generated.length;
        // ONE reporting seam for both surfaces (docs/18 §2.3,
        // `entity-batch-report`): the console payload and the toast are raised
        // together, from the same count sentence the entity panel's batch
        // button uses, so the automation and that button cannot drift.
        reportEntityBatchFailures({
          module,
          campaign,
          kind,
          total: names.length,
          failures: result.failed,
        });
      }
    }

    // Current artifacts for the queue targets — the batches above may have
    // produced some. The module-creation pool (docs/17 row 69): image targets
    // are module entities, never the Party.
    const artifacts = moduleCreationPool(await listArtifactsByCampaign(module.campaignId));
    const settings = await getSettings();

    // The enqueue half of the sweep is one unit too: a stop is not a reason
    // to hand the queues fresh work (they would start a fresh pump for it —
    // the pump exits on cancelAll, but any later enqueue starts a new one).
    // Checked ONCE, before the whole enqueue half: the batches above are the
    // long part, and the three blocks below are a single stretch of
    // enqueueing.
    if (stoppedSince(epoch)) return;

    // 2) Images — one loud skip when the image API is off (never a silent
    // drop of the configured automation, never a wall of per-entity errors).
    const imageJobs = orderedKinds(autoImageKinds).flatMap((kind) =>
      imageTargets(module, artifacts, kind).map((name) => ({
        campaignId: module.campaignId,
        moduleId: module.id,
        name,
      })),
    );
    if (imageJobs.length > 0 && !settings.imagesEnabled) {
      toastError(
        'Auto image generation skipped — image generation is disabled in Settings',
      );
    } else if (imageJobs.length > 0) {
      useEntityImageQueue.getState().enqueue(imageJobs);
    }

    // 3) Battlemaps — the stylize step needs the image API too.
    const mapJobs = autoGenerateBattlemaps
      ? encountersNeedingMaps(module, artifacts).map((encounter) => ({
          campaignId: module.campaignId,
          moduleId: module.id,
          artifactId: encounter.id,
          name: encounter.name,
        }))
      : [];
    if (mapJobs.length > 0 && !settings.imagesEnabled) {
      toastError(
        'Auto battlemap generation skipped — image generation is disabled in Settings',
      );
    } else if (mapJobs.length > 0) {
      useEncounterMapQueue.getState().enqueue(mapJobs);
    }

    // 4) Mob portraits — the encounter editor's "Generate mob portraits"
    // batch entry per module-owned encounter, BOTH lanes (docs/17 row 96):
    // the rulebook lane for every chunk-backed creature kind, then the
    // invented lane for the participants whose creature is not chunk-backed
    // (an uncited entry's on-demand creature; an `npc-ref` monster or named
    // NPC that already has its own artifact). That is exactly the two calls
    // the editor's additive fill makes, over exactly the encounters
    // `encountersNeedingMobPortraits` counted — one rule, no lane gate on the
    // roster's shape (a roster of nothing but materialized monsters has no
    // rulebook-citation entry and must still be illustrated). Additive in
    // both lanes: the enumeration resolves what exists and skips every kind
    // that already carries art, so a re-run replaces nothing.
    //
    // Enqueued-but-async is the contract: the portrait queue owns progress
    // (dock) and the loud per-mob failure path; the sweep NEVER awaits
    // portrait completion.
    //
    // The switch is the run's OWN (`target ?? module`, destructured above, like
    // `autoGenerateBattlemaps` and the two kind lists): reading the module ROW
    // here made an explicit target's promise false — the entity sidebar's
    // "Generate everything" (FULL_AUTOMATION_TARGET, `autoGenerateMobImages:
    // true`) offered mob portraits in its confirmation and then never enqueued
    // them for a module whose row had the toggle off, which is the default
    // (owner report, docs/17 row 96, second symptom).
    // The presentation snapshot is read HERE, for the same reason it is read
    // for the confirmation: the sweep's target list and the batch's own plan
    // must answer the same question, or the run enqueues work it cannot do (a
    // creature the campaign already shows a portrait for).
    const portraitTargets = autoGenerateMobImages
      ? encountersNeedingMobPortraits(
          module,
          artifacts,
          await presentationArtOfCampaign(campaign.id),
        )
      : [];
    let portraitJobs = 0;
    if (portraitTargets.length > 0 && !settings.imagesEnabled) {
      // One loud skip for the configured automation (never a silent drop,
      // never a wall of per-encounter errors) — same pattern as images
      // and battlemaps above.
      toastError(
        'Auto mob portrait generation skipped — image generation is disabled in Settings',
      );
    } else {
      // One encounter's failure never kills the sweep: the rest still
      // enqueue, and the failures aggregate into ONE loud toast. ONE try per
      // encounter (both lanes inside it), so the aggregation counts
      // encounters and never lanes; a failure in the first lane therefore
      // ends that encounter's portrait work with its own loud reason, and a
      // dangling `npc-ref` is exactly such a failure (`enumerateBatchKinds`
      // throws with the citing name — never a silent skip).
      const failedPortraits: string[] = [];
      for (const encounter of portraitTargets) {
        // The portrait batch awaits per encounter (it reads the roster), so a
        // stop landing mid-loop must end it here, not after the last one.
        if (stoppedSince(epoch)) break;
        try {
          portraitJobs += (await enqueueMobPortraits(encounter, module.campaignId)).enqueued;
          // The invented lane always follows: every encounter in
          // `portraitTargets` has a non-empty roster by construction (the
          // predicate walks roster rows), which IS the editor's
          // `hasParticipants` gate — stated here instead of as an unreachable
          // branch. It enumerates nothing when every participant is
          // chunk-backed, and creates/enqueues nothing that exists.
          portraitJobs += (
            await enqueueInventedCreaturePortraits(encounter, module.campaignId)
          ).enqueued;
        } catch (error) {
          failedPortraits.push(`"${encounter.name}" — ${errorMessage(error)}`);
        }
      }
      if (failedPortraits.length > 0) {
        toastError(
          `${String(failedPortraits.length)} of ${String(portraitTargets.length)} encounters ` +
            `failed to enqueue mob portraits (${failedPortraits.join('; ')})`,
        );
      }
    }

    // One honest completion signal for work that lands minutes after the
    // parts finished (the docks carry the live progress of each queue).
    const parts = [
      generatedCount > 0 ? `${String(generatedCount)} artifact${generatedCount === 1 ? '' : 's'} generated` : null,
      imageJobs.length > 0 && settings.imagesEnabled
        ? `${String(imageJobs.length)} image${imageJobs.length === 1 ? '' : 's'} queued`
        : null,
      mapJobs.length > 0 && settings.imagesEnabled
        ? `${String(mapJobs.length)} battlemap${mapJobs.length === 1 ? '' : 's'} queued`
        : null,
      portraitJobs > 0
        ? `${String(portraitJobs)} mob portrait${portraitJobs === 1 ? '' : 's'} queued`
        : null,
    ].filter((part) => part !== null);
    if (parts.length > 0) {
      toastSuccess(`Module automation: ${parts.join(', ')}`);
    }
  } catch (error) {
    toastError('Module post-generation automation failed', error);
  }
}
