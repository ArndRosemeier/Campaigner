import { getAnyArtifact, updateArtifact } from '@/db/artifactRepo';
import { getCampaign } from '@/db/campaignRepo';
import { listPersonas } from '@/db/personaRepo';
import { getSettings } from '@/db/settingsRepo';
import { encounterDataIsComplex, type Campaign, type DungeonMapPath, type Id, type Persona } from '@/domain';
import { withAdditionalInstruction } from '@/llm/additionalInstruction';
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
  /**
   * The D18 per-run dungeon-map path for Regenerate everything (docs/11
   * vision path): `'vision'`/`'classic'` force the path for a COMPLEX
   * regen; undefined/null = no override (the Settings `dungeonMapPath`
   * default governs). Ignored for singles (one arena needs no registration
   * — always classic) and repopulation (roster-only, path-independent).
   * Never persisted as a new Settings default.
   */
  dungeonMapPath?: DungeonMapPath | null;
  /**
   * Free-text change instruction (the change seam, docs/17 row 101). It is
   * appended to EVERY brief this operation sends — the content leg, the map
   * leg and the prose leg — in the one `Additional instruction: …` form
   * (`llm/additionalInstruction`), and empty/omitted leaves every brief
   * BYTE-IDENTICAL to the one this operation has always sent (the pins in
   * `tests/llm/encounterRepopulate.test.ts`).
   *
   * It only ever ADDS a paragraph: each leg's own contract still governs
   * (the prose leg still demands the roster verbatim and fails loud on a
   * reply that rewrites it — never a partial apply), and the operation stays
   * the chained, stop-at-first-failure sequence it was.
   */
  instruction?: string;
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

/**
 * The manual regen's own "this leg did not finish" sentence, and the ONE
 * caller that does not adopt `runNotCompletedReason` (docs/18 §2/§5, docs/17
 * row 128) — deliberately, twice over:
 *
 * 1. The LABEL is a fact the engine cannot carry. Every one of these callers
 *    names a LEG of a chained operation ("Regenerate everything (content)"
 *    vs "(battlemap)"), and the engine's own sentence names a STEP inside one
 *    leg — both legs brief under the same step name — so adopting the seam
 *    would delete the only place the owner can read WHICH leg died after one
 *    click on "Regenerate everything". Losing information is not a wording
 *    change.
 * 2. The engine already surfaces its own sentence on this path (the run's
 *    failure toasts it, `runEngine.fail`), so the message here rides as a
 *    colon-suffixed DETAIL behind the leg, exactly as the other three sites
 *    ride it AS the sentence. Two sentences for one fact, one per reader: the
 *    run's own row says why the run died, this says which leg of the
 *    operation the owner asked for died (the ledger-120 shape).
 *
 * The fallback branch is byte-identical to the seam's own fallback under this
 * label — same formula, same label — so the seam still owns what "ended
 * <status>" MEANS; only the composition with a non-empty message differs,
 * and the scan pin in `tests/llm/runNotCompletedReason.test.ts` records this
 * file as the one boundary that composes it. Do NOT "fix"
 * this by adopting the seam without an owner decision, and do NOT fold the
 * withdrawal predicate under it either: reporting a cancelled run as a
 * failure is this path's own contract (a caller is waiting for an answer),
 * while a queue job's withdrawal is moot work (docs/17 row 117).
 */
async function awaitCompletedRun(runId: Id, label: string): Promise<void> {
  const run = await waitForRunStatus(runId);
  if (run.status !== 'completed') {
    throw new Error(
      `${label} ended ${run.status}${run.errorMessage === '' ? '' : `: ${run.errorMessage}`}`,
    );
  }
}

/**
 * One leg's brief, with the caller's change instruction appended (the change
 * seam, docs/17 row 101). With no instruction the bytes are exactly the
 * literal's — `withAdditionalInstruction` returns the text unchanged — so the
 * two buttons the artifact editor has always had keep sending the prompts
 * they always sent.
 */
function legBrief(brief: string, options: EncounterRegenOptions): string {
  return withAdditionalInstruction(brief, options.instruction ?? '');
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
      brief: legBrief(
        'Regenerate the full content of this encounter — roster with stat sources, terrain, tactics, treasure and prose. Its name, relations and battlemap are preserved.',
        options,
      ),
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
    brief: legBrief(
      `Repopulate the roster of "${artifact.name}" — a NEW roster stocking every room. Rooms, layout and battlemap are preserved.`,
      options,
    ),
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
    await runProseRedesign(campaign, smith, artifactId, options);
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
      brief: legBrief(
        'Regenerate the full content of this encounter — roster with stat sources, terrain, tactics, treasure and prose. Its name and relations are preserved; a fresh battlemap follows.',
        options,
      ),
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
      brief: legBrief(
        `Generate a room layout and battlemap for "${refilled.name}" using its existing roster and prose.`,
        options,
      ),
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
    brief: legBrief(
      `Regenerate everything for "${reread.name}" — a whole new population, room layout and battlemap. Name and prose are preserved.`,
      options,
    ),
    pinnedChunkIds: [],
    targetArtifactId: artifactId,
    encounterPreset: reread.data.preset,
    encounterMapAspect: settings.encounterMapAspect,
    // The D18 per-run path choice (explicit beats the Settings default;
    // omitted/null = no override). Singles never reach this leg.
    ...(options.dungeonMapPath === undefined || options.dungeonMapPath === null
      ? {}
      : { dungeonMapPath: options.dungeonMapPath }),
  });
  await awaitCompletedRun(runId, 'Regenerate everything');
  if (options.redesignProse) {
    await runProseRedesign(campaign, smith, artifactId, options);
  }
}

/**
 * The prose checkbox's second leg (two-button regeneration, docs/11):
 * prose-ONLY by contract — the Smith draft's persist is scoped to
 * name/summary/body, and a reply that tries to rewrite monsters fails loud,
 * never partial-applies.
 */
async function runProseRedesign(
  campaign: Campaign,
  smith: Persona,
  artifactId: Id,
  options: EncounterRegenOptions,
): Promise<void> {
  const artifact = await getAnyArtifact(artifactId);
  if (artifact?.kind !== 'encounter') throw new Error('The encounter to redesign no longer exists');
  const roster = artifact.data.monsters
    .map((monster) => `${monster.name} ×${String(monster.count)}`)
    .join(', ');
  const runId = await runEngine.startRun({
    campaign,
    persona: smith,
    autonomy: 'auto',
    brief: legBrief(
      `Redesign the name and prose of "${artifact.name}" — prose ONLY. ` +
        `Copy the roster verbatim (names and counts: ${roster === '' ? 'no monsters' : roster}); ` +
        'renaming, adding or removing a monster fails the run. Layout, battlemap, treasure and all other data are preserved.',
      options,
    ),
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
