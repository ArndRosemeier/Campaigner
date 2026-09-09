import { getAnyArtifact, updateArtifact } from '@/db/artifactRepo';
import { getCampaign } from '@/db/campaignRepo';
import { listPersonas } from '@/db/personaRepo';
import { getSettings } from '@/db/settingsRepo';
import { encounterDataIsComplex, type Campaign, type Id, type Persona } from '@/domain';
import { runEngine, waitForRunStatus } from '@/llm/runEngine';

/**
 * The two-button encounter regeneration surface (docs/11): EXACTLY two
 * automatic actions for both shapes, plus the prose checkbox. This module is
 * the one orchestration seam — the editor buttons call these functions and
 * nothing else starts encounter regeneration runs automatically.
 *
 * - `repopulateEncounter` — "Repopulate": a NEW roster for ALL rooms (single:
 *   today's Smith one-fight fill, map preserved; complex: a roster-only
 *   Cartographer pass reusing the stocking machinery — rooms, layout and map
 *   preserved byte-identically). Honors the row's fill grade (draw-once).
 * - `regenerateEncounterEverything` — "Regenerate everything": a new dungeon
 *   top to bottom, same as if freshly module-generated (complex: reset
 *   roster + layout + map while KEEPING fillGrade, siteShape, locationKind,
 *   name and prose, then the FULL pipeline with the row's CURRENT preset
 *   resolution; single: a fresh one-fight Smith draft plus a fresh map, one
 *   action chaining the existing pieces).
 * - `redesignProse` (the checkbox, default OFF): name/prose are redesigned
 *   too, via a prose-ONLY Smith pass that must never touch the roster the
 *   pipeline just built (a reply that tries fails loud, never
 *   partial-applies). For singles the Smith leg always refreshes prose per
 *   its charter — the checkbox additionally replaces the name there.
 *
 * Every awaited run uses autonomy `'auto'` (fully automatic, no checkpoints)
 * and is verified terminal-`completed` — any other terminal status throws
 * loudly with the run's error (which also sits on the failed run row).
 * Chained legs stop at the first failure: a failed Smith leg never triggers
 * its map run, and a failed roster pass never triggers its prose pass.
 */

export interface EncounterRegenOptions {
  /** The "Also redesign name and prose" checkbox (default OFF). */
  redesignProse: boolean;
}

interface RegenContext {
  campaign: Campaign;
  cartographer: Persona;
  smith: Persona;
}

async function loadRegenContext(artifactId: Id): Promise<RegenContext & { complex: boolean }> {
  const artifact = await getAnyArtifact(artifactId);
  if (artifact === undefined) throw new Error('The encounter to regenerate no longer exists');
  if (artifact.kind !== 'encounter') {
    throw new Error(`"${artifact.name}" is not an encounter and cannot be regenerated`);
  }
  if (artifact.campaignId === null) {
    throw new Error(`"${artifact.name}" is library-scoped and cannot be regenerated here`);
  }
  const campaign = await getCampaign(artifact.campaignId);
  if (campaign === undefined) throw new Error('The campaign for this encounter no longer exists');
  const personas = await listPersonas();
  const cartographer = personas.find((persona) => persona.slug === 'encounter-cartographer');
  if (cartographer === undefined) throw new Error('The Encounter Cartographer persona is missing');
  const smith = personas.find((persona) => persona.slug === 'encounter-smith');
  if (smith === undefined) throw new Error('The Encounter Smith persona is missing');
  return { campaign, cartographer, smith, complex: encounterDataIsComplex(artifact.data) };
}

async function awaitCompletedRun(runId: Id, label: string): Promise<void> {
  const run = await waitForRunStatus(runId);
  if (run.status !== 'completed') {
    throw new Error(
      `${label} ended ${run.status}${run.errorMessage === '' ? '' : `: ${run.errorMessage}`}`,
    );
  }
}

/**
 * "Repopulate": the dungeon looks fine, the spawn looks wrong — a NEW
 * roster for ALL rooms. Single: today's Smith content regen unchanged (new
 * one-fight roster, map preserved). Complex: the roster-only Cartographer
 * pass (brief → evaluate with the 'empty' repair loop → finalize persists
 * the roster ONLY). Both honor the fill grade.
 */
export async function repopulateEncounter(
  artifactId: Id,
  options: EncounterRegenOptions,
): Promise<void> {
  const { campaign, cartographer, smith, complex } = await loadRegenContext(artifactId);
  const settings = await getSettings();
  if (!complex) {
    const runId = await runEngine.startRun({
      campaign,
      persona: smith,
      autonomy: 'auto',
      brief:
        'Regenerate the full content of this encounter — roster with stat sources, terrain, tactics, treasure and prose. Its name, relations and battlemap are preserved.',
      pinnedChunkIds: [],
      targetArtifactId: artifactId,
      ...(options.redesignProse ? { encounterRedesignName: true as const } : {}),
    });
    await awaitCompletedRun(runId, 'Repopulate');
    return;
  }
  const artifact = await getAnyArtifact(artifactId);
  if (artifact?.kind !== 'encounter') throw new Error('The encounter to repopulate no longer exists');
  const runId = await runEngine.startRun({
    campaign,
    persona: cartographer,
    autonomy: 'auto',
    brief: `Repopulate the roster of "${artifact.name}" — a NEW roster stocking every room. Rooms, layout and battlemap are preserved.`,
    pinnedChunkIds: [],
    targetArtifactId: artifactId,
    encounterScope: 'rosterOnly',
    // The row's own preset is the explicit per-run choice (D10 untouched —
    // never silently re-tiered).
    encounterPreset: artifact.data.preset,
    encounterMapAspect: settings.encounterMapAspect,
  });
  await awaitCompletedRun(runId, 'Repopulate');
  if (options.redesignProse) {
    await runProseRedesign(campaign, smith, artifactId);
  }
}

/**
 * "Regenerate everything": a new dungeon top to bottom, same as if freshly
 * module-generated — new roster + new layout + new map. Complex: reset
 * roster + layout + map (monsters [], layout null, map cleared) while
 * KEEPING fillGrade, siteShape, locationKind, name and prose; then the FULL
 * pipeline with the CURRENT preset resolution. Single: a fresh one-fight
 * draft plus a fresh map in ONE action (the existing Smith + Cartographer
 * pieces, chained). Both honor the fill grade.
 */
export async function regenerateEncounterEverything(
  artifactId: Id,
  options: EncounterRegenOptions,
): Promise<void> {
  const { campaign, cartographer, smith, complex } = await loadRegenContext(artifactId);
  const settings = await getSettings();
  if (!complex) {
    const smithRunId = await runEngine.startRun({
      campaign,
      persona: smith,
      autonomy: 'auto',
      brief:
        'Regenerate the full content of this encounter — roster with stat sources, terrain, tactics, treasure and prose. Its name and relations are preserved; a fresh battlemap follows.',
      pinnedChunkIds: [],
      targetArtifactId: artifactId,
      ...(options.redesignProse ? { encounterRedesignName: true as const } : {}),
    });
    await awaitCompletedRun(smithRunId, 'Regenerate everything (content)');
    const refilled = await getAnyArtifact(artifactId);
    if (refilled?.kind !== 'encounter') {
      throw new Error('The encounter to regenerate no longer exists');
    }
    const mapRunId = await runEngine.startRun({
      campaign,
      persona: cartographer,
      autonomy: 'auto',
      brief: `Generate a room layout and battlemap for "${refilled.name}" using its existing roster and prose.`,
      pinnedChunkIds: [],
      targetArtifactId: artifactId,
      encounterPreset: refilled.data.preset,
      encounterMapAspect: settings.encounterMapAspect,
    });
    await awaitCompletedRun(mapRunId, 'Regenerate everything (battlemap)');
    return;
  }
  const artifact = await getAnyArtifact(artifactId);
  if (artifact?.kind !== 'encounter') throw new Error('The encounter to regenerate no longer exists');
  // The reset: roster + layout + map go, everything the contract keeps stays
  // (fillGrade, siteShape, locationKind, name, prose, links, tags, images —
  // the old map file stays in the gallery as a plain image; the finalize
  // lands the fresh one). A revision snapshots the pre-reset row, so a
  // failed run is restorable, never silent data loss.
  await resetComplexForRegeneration(artifactId);
  const reread = await getAnyArtifact(artifactId);
  if (reread?.kind !== 'encounter') throw new Error('The encounter to regenerate no longer exists');
  const runId = await runEngine.startRun({
    campaign,
    persona: cartographer,
    autonomy: 'auto',
    brief: `Regenerate everything for "${reread.name}" — a whole new population, room layout and battlemap. Name and prose are preserved.`,
    pinnedChunkIds: [],
    targetArtifactId: artifactId,
    encounterPreset: reread.data.preset,
    encounterMapAspect: settings.encounterMapAspect,
  });
  await awaitCompletedRun(runId, 'Regenerate everything');
  if (options.redesignProse) {
    await runProseRedesign(campaign, smith, artifactId);
  }
}

/**
 * The prose checkbox's second leg (two-button regeneration, docs/11):
 * prose-ONLY by contract — the Smith draft's persist is scoped to
 * name/summary/body, and a reply that tries to rewrite monsters fails loud,
 * never partial-applies.
 */
async function runProseRedesign(campaign: Campaign, smith: Persona, artifactId: Id): Promise<void> {
  const artifact = await getAnyArtifact(artifactId);
  if (artifact?.kind !== 'encounter') throw new Error('The encounter to redesign no longer exists');
  const roster = artifact.data.monsters
    .map((monster) => `${monster.name} ×${String(monster.count)}`)
    .join(', ');
  const runId = await runEngine.startRun({
    campaign,
    persona: smith,
    autonomy: 'auto',
    brief:
      `Redesign the name and prose of "${artifact.name}" — prose ONLY. ` +
      `Copy the roster verbatim (names and counts: ${roster === '' ? 'no monsters' : roster}); ` +
      'renaming, adding or removing a monster fails the run. Layout, battlemap, treasure and all other data are preserved.',
    pinnedChunkIds: [],
    targetArtifactId: artifactId,
    encounterProseOnly: true,
  });
  await awaitCompletedRun(runId, 'Prose redesign');
}

/**
 * The Regenerate-everything reset for complexes: roster + layout + map go
 * (monsters [], layout null, map cleared) while fillGrade, siteShape,
 * locationKind, name and prose are KEPT. With the roster empty, the
 * shape-gated directive renders as a fresh-population instruction on the
 * full pipeline that follows.
 */
async function resetComplexForRegeneration(artifactId: Id): Promise<void> {
  const artifact = await getAnyArtifact(artifactId);
  if (artifact?.kind !== 'encounter') throw new Error('The encounter to regenerate no longer exists');
  await updateArtifact(artifact.id, {
    data: {
      ...artifact.data,
      monsters: [],
      layout: null,
      mapImageId: null,
    },
  });
}
