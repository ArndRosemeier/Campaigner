import type { AnyArtifact, Artifact, Campaign, EntityKind, Id, Module } from '@/domain';
import { ENTITY_KINDS, entityKindFor, moduleDocumentText } from '@/domain';
import { listArtifactsByCampaign } from '@/db/artifactRepo';
import { getModule } from '@/db/moduleRepo';
import { getSettings } from '@/db/settingsRepo';
import { enqueueMobPortraits } from '@/features/campaign/mob-portrait-queue';
import { useEncounterMapQueue } from '@/features/modules/encounter-map-queue';
import { runEntityBatch } from '@/features/modules/entity-batch';
import { useEntityImageQueue } from '@/features/modules/entity-image-queue';
import { extractWikiLinks, resolveWikiLink } from '@/lib/wikilinks';
import { errorMessage } from '@/lib/errors';
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
 * 2. **Auto-generate images** — every resolved entity of a configured kind
 *    without an image is enqueued in the background image queue (one cover
 *    per entity). Runs AFTER the batches so newly generated artifacts are
 *    covered too.
 * 3. **Auto-generate battlemaps** — module-owned encounters without a
 *    layout/map are enqueued in the unattended encounter-map queue (docs/11
 *    §Module generation integration; auto autonomy, no pick pause).
 * 4. **Auto-generate mob portraits** — every module-owned encounter's
 *    rulebook-cited roster mobs are enqueued on the mob-portrait queue
 *    through the encounter editor's batch entry (`enqueueMobPortraits`):
 *    one cover portrait per creature kind, canonically cached. Enqueue is
 *    the contract — the queue carries the progress dock and the loud
 *    per-mob failures; this sweep never awaits portrait completion.
 *
 * Everything is idempotent: batches target only UNRESOLVED entities, the
 * image queue skips artifacts that already have an image, the map queue
 * skips encounters that already carry a map, and the portrait batch
 * enumerates away already-imaged mobs — re-running a full pass can never
 * double-generate. Failures are loud per job (toasts + the Runs tab) and
 * never stop the remaining automation.
 */

/** Configured kinds in the domain's stable order (encounters last).
 *
 * The order is the fixed-cast pin (docs/11): NPCs/monsters detail BEFORE
 * encounters, so an encounter batch's brief-time snapshot already holds the
 * scene members its brief must pin as fixed cast. */
export function orderedKinds(configured: readonly EntityKind[]): EntityKind[] {
  return ENTITY_KINDS.filter((kind) => configured.includes(kind));
}

/** Wiki-link names of the module whose recorded kind is `kind`, deduped. */
function namesOfKind(module: Module, kind: EntityKind): string[] {
  const text = moduleDocumentText(module);
  return extractWikiLinks(text)
    .map((link) => link.name)
    .filter((name) => entityKindFor(module.entityKinds, name) === kind);
}

/** Image targets: resolved entities of a configured kind without an image. */
function imageTargets(module: Module, artifacts: Awaited<ReturnType<typeof listArtifactsByCampaign>>, kind: EntityKind): string[] {
  return namesOfKind(module, kind).filter((name) => {
    const artifact = resolveWikiLink(name, artifacts, { moduleId: module.id }).artifact;
    if (artifact === undefined) return false;
    return artifact.coverImageId === null && artifact.imageIds.length === 0;
  });
}

/** Map targets: module-owned encounters without a generated layout + map. */
function encountersNeedingMaps(
  module: Module,
  artifacts: Awaited<ReturnType<typeof listArtifactsByCampaign>>,
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
 * Portrait targets: module-owned encounters whose roster still carries
 * rulebook-cited creature work — an entry with no stamped `mobArtifactId`
 * (the batch resolves or creates it) or one whose mob artifact is still
 * cover-less. Cheap over the same artifact snapshot the other steps use;
 * an unstamped entry whose campaign-wide mob artifact already exists imaged
 * may over-notify the disabled skip below (errs loud, never silent). The
 * queue's own one-per-creature-kind dedupe + skip-if-imaged make an enqueue
 * re-run a no-op.
 */
function encountersNeedingMobPortraits(
  module: Module,
  artifacts: Awaited<ReturnType<typeof listArtifactsByCampaign>>,
): (AnyArtifact & { kind: 'encounter' })[] {
  return artifacts.filter(
    // listArtifactsByCampaign yields OWNED rows only (never global), so the
    // owned encounter variant is what the predicate narrows to; it feeds the
    // batch entry's `AnyArtifact & { kind: 'encounter' }` parameter as-is.
    (artifact): artifact is Artifact & { kind: 'encounter' } => {
      if (artifact.kind !== 'encounter' || artifact.moduleId !== module.id) return false;
      return artifact.data.monsters.some((entry) => {
        if (entry.source.type !== 'rulebook') return false;
        const stamped = entry.source.mobArtifactId;
        if (stamped === undefined) return true;
        const mob = artifacts.find((candidate) => candidate.id === stamped);
        return mob === undefined || (mob.coverImageId === null && mob.imageIds.length === 0);
      });
    },
  );
}

/**
 * Runs the configured automation for one module. Fire-and-forget safe: an
 * unexpected throw is toasted, never left as an unhandled rejection. A
 * no-op when the module has nothing configured (or was deleted mid-run).
 */
export async function runModulePostGeneration(moduleId: Id, campaign: Campaign): Promise<void> {
  try {
    const module = await getModule(moduleId);
    if (module === undefined) return;
    if (module.status !== 'ready') return; // automation follows a COMPLETED parts pass
    const { autoGenerateKinds, autoImageKinds, autoGenerateBattlemaps, autoGenerateMobImages } =
      module;
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
        const artifacts = await listArtifactsByCampaign(module.campaignId);
        const names = namesOfKind(module, kind).filter(
          (name) => resolveWikiLink(name, artifacts, { moduleId: module.id }).artifact === undefined,
        );
        if (names.length === 0) continue;
        const result = await runEntityBatch({
          module,
          campaign,
          kind,
          targets: names.map((name) => ({ name })),
        });
        generatedCount += result.generated.length;
        if (result.failed.length > 0) {
          const summary = result.failed
            .map((failure) => `"${failure.name}" — ${failure.message}`)
            .join('; ');
          toastError(
            `${String(result.failed.length)} of ${String(names.length)} ${kind}s failed to generate — ` +
              `see the Runs tab (${summary})`,
          );
        }
      }
    }

    // Current artifacts for the queue targets — the batches above may have
    // produced some.
    const artifacts = await listArtifactsByCampaign(module.campaignId);
    const settings = await getSettings();

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
    // batch entry per module-owned encounter. Enqueued-but-async is the
    // contract: the portrait queue owns progress (dock) and the loud
    // per-mob failure path; the sweep NEVER awaits portrait completion.
    const portraitTargets = module.autoGenerateMobImages
      ? encountersNeedingMobPortraits(module, artifacts)
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
      // enqueue, and the failures aggregate into ONE loud toast.
      const failedPortraits: string[] = [];
      for (const encounter of portraitTargets) {
        try {
          portraitJobs += (await enqueueMobPortraits(encounter, module.campaignId)).enqueued;
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
