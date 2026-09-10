import type { AnyArtifact, Artifact, EntityKind, Id, Module } from '@/domain';
import { moduleCreationPool } from '@/domain';
import { unclassifiedModuleNames } from '@/llm/moduleGen';
import {
  batchTargets,
  encountersNeedingMaps,
  encountersNeedingMobPortraits,
  imageTargets,
  orderedKinds,
} from '@/features/modules/post-generation';

/**
 * "Resume automatic module creation" — the DERIVED deviation between what the
 * owner asked creation to automate and what actually exists (owner intent,
 * verbatim: **"Resume automatic module creation"**, and on the mechanism,
 * verbatim: **"this way this can also be used after edits."**).
 *
 * THE RULE. The TARGET STATE is RECORDED on the module row (`automationIntent`,
 * docs/17 row 71 — what the owner checked at creation, which is unrecoverable
 * from what the engine did). The DEVIATION is DERIVED HERE, at render time, by
 * comparing that intent with the live state. NOTHING about it is stored: a
 * `deviates` / `hasProblems` / `needsWork` flag would go stale the moment the
 * owner edits the text, deletes an artifact or generates an image by hand — and
 * the whole point of the button is that it works AFTER those edits. The schema's
 * own doc comment states the ban; this module is the reason it exists.
 *
 * WHAT IT COMPARES (never a new detector — every target list is the sweep's own):
 * - entities the intent asked for that the text names but no artifact answers
 *   (`batchTargets` — the entity batch's exact target set),
 * - names the text picked up with no recorded type at all, which no batch can
 *   even see until the classification pass runs (`unclassifiedModuleNames`),
 * - the name-normalization gate being closed (`entityNamesNormalized` false),
 *   which silently blocks the entity batches and must therefore be part of what
 *   the resume says it will run,
 * - images the intent asked for on resolved entities that have none
 *   (`imageTargets`),
 * - battle maps the intent asked for on encounters that have none
 *   (`encountersNeedingMaps`), and
 * - mob portraits the intent asked for on encounters whose roster still cites
 *   un-imaged creatures (`encountersNeedingMobPortraits`).
 *
 * THE POOL is the SWEEP's (`moduleCreationPool` over the campaign's artifact
 * list), never the reader's: the confirmation must name exactly the work
 * `runModulePostGeneration` would do — a pool difference (a global row, a party
 * member's name) would otherwise let the button promise work the sweep skips, or
 * hide work it would run.
 *
 * LEGACY ROWS STAY INERT: `automationIntent === null` (every row written before
 * the field) yields an EMPTY deviation, so the control never appears — intent may
 * never be inferred from a legacy row's own automation fields, which describe
 * what the engine did rather than what the owner asked for (docs/17 row 71).
 */

/** One configured kind with the names still missing for it. */
export interface KindDeviation {
  kind: EntityKind;
  /** The text's names that resolve to nothing (the batch's target set). */
  names: string[];
}

export interface AutomationDeviation {
  /** Entities the intent asked for that no artifact answers, per kind. */
  entities: KindDeviation[];
  /**
   * Names the text carries with no recorded type (the incremental
   * classification pass's input) — only meaningful when the intent configures
   * entity generation, because nothing else can consume them.
   */
  unclassified: string[];
  /**
   * `entityNamesNormalized` is false: the entity batches are gated off, so the
   * resume runs the normalization pass first (or says loudly why it cannot).
   */
  normalizationPending: boolean;
  /** Resolved entities of a configured kind with no image yet. */
  images: KindDeviation[];
  /** Module-owned encounters of the intent without a layout + map. */
  battlemaps: { id: Id; name: string }[];
  /**
   * Module-owned encounters of the intent with un-imaged roster mobs — the
   * artifacts themselves, because that is exactly what the portrait batch entry
   * (`enqueueMobPortraits`) takes.
   */
  mobPortraits: (AnyArtifact & { kind: 'encounter' })[];
}

/** The empty deviation (also the legacy/`null`-intent answer). */
export function emptyDeviation(): AutomationDeviation {
  return {
    entities: [],
    unclassified: [],
    normalizationPending: false,
    images: [],
    battlemaps: [],
    mobPortraits: [],
  };
}

/** `true` when nothing the intent asked for is missing (the control is hidden). */
export function deviationIsEmpty(deviation: AutomationDeviation): boolean {
  return (
    deviation.entities.length === 0 &&
    deviation.unclassified.length === 0 &&
    !deviation.normalizationPending &&
    deviation.images.length === 0 &&
    deviation.battlemaps.length === 0 &&
    deviation.mobPortraits.length === 0
  );
}

/** How many individual pieces of work the resume would run. */
export function deviationWorkCount(deviation: AutomationDeviation): number {
  const entityNames = deviation.entities.reduce((sum, entry) => sum + entry.names.length, 0);
  const imageNames = deviation.images.reduce((sum, entry) => sum + entry.names.length, 0);
  return (
    entityNames +
    imageNames +
    deviation.battlemaps.length +
    deviation.mobPortraits.length +
    deviation.unclassified.length +
    (deviation.normalizationPending ? 1 : 0)
  );
}

/** "3 npcs" / "1 npc" (the confirmation's copy). */
function kindCount(kind: EntityKind, count: number): string {
  return `${String(count)} ${kind}${count === 1 ? '' : 's'}`;
}

/**
 * The confirmation's lines: what is missing and what will therefore run. ONE
 * list read by the dialog, so the copy can never drift from the derivation.
 */
export function deviationLines(deviation: AutomationDeviation): string[] {
  const lines: string[] = [];
  if (deviation.normalizationPending) {
    lines.push(
      'Entity names are not normalized for the current text (the pass failed or never ran) — it runs first, before any entity work',
    );
  }
  for (const entry of deviation.entities) {
    lines.push(
      `${kindCount(entry.kind, entry.names.length)} named by the text but not generated yet: ${entry.names.join(', ')}`,
    );
  }
  if (deviation.unclassified.length > 0) {
    lines.push(
      `${String(deviation.unclassified.length)} name${deviation.unclassified.length === 1 ? '' : 's'} the text picked up with no recorded type (classified first): ${deviation.unclassified.join(', ')}`,
    );
  }
  for (const entry of deviation.images) {
    lines.push(
      `${kindCount(entry.kind, entry.names.length)} without an image: ${entry.names.join(', ')}`,
    );
  }
  if (deviation.battlemaps.length > 0) {
    lines.push(
      `${String(deviation.battlemaps.length)} battle map${deviation.battlemaps.length === 1 ? '' : 's'} missing: ${deviation.battlemaps.map((entry) => entry.name).join(', ')}`,
    );
  }
  if (deviation.mobPortraits.length > 0) {
    lines.push(
      `Mob portraits missing for ${String(deviation.mobPortraits.length)} encounter${deviation.mobPortraits.length === 1 ? '' : 's'}: ${deviation.mobPortraits.map((entry) => entry.name).join(', ')}`,
    );
  }
  return lines;
}

/**
 * Derives the deviation. `campaignArtifacts` is the CAMPAIGN's artifact list
 * (the same list `runModulePostGeneration` enumerates) — the module-creation
 * pool is applied here, in the one place, so no caller can hand this a different
 * pool than the sweep reads.
 */
export function deriveAutomationDeviation(
  module: Module,
  campaignArtifacts: readonly Artifact[],
): AutomationDeviation {
  const intent = module.automationIntent;
  // Legacy row: nothing was recorded, so nothing may be inferred (docs/17 row
  // 71) — the deviation is empty and the control stays away.
  if (intent === null) return emptyDeviation();
  const artifacts = moduleCreationPool(campaignArtifacts);

  const entities: KindDeviation[] = orderedKinds(intent.autoGenerateKinds).flatMap((kind) => {
    const names = batchTargets(module, artifacts, kind);
    return names.length === 0 ? [] : [{ kind, names }];
  });
  const images: KindDeviation[] = orderedKinds(intent.autoImageKinds).flatMap((kind) => {
    const names = imageTargets(module, artifacts, kind);
    return names.length === 0 ? [] : [{ kind, names }];
  });

  // The classification pass and the normalization gate only matter when the
  // intent asked for entity generation: those names are exactly what the batch
  // cannot see yet, and the gate is what blocks the batch.
  const entityWorkConfigured = intent.autoGenerateKinds.length > 0;
  const unclassified = entityWorkConfigured ? unclassifiedModuleNames(module, artifacts) : [];

  return {
    entities,
    unclassified,
    normalizationPending: entityWorkConfigured && !module.entityNamesNormalized,
    images,
    battlemaps: intent.autoGenerateBattlemaps ? encountersNeedingMaps(module, artifacts) : [],
    mobPortraits: intent.autoGenerateMobImages
      ? encountersNeedingMobPortraits(module, artifacts)
      : [],
  };
}

/**
 * The invariant between the recorded intent and the row's own automation fields
 * (`autoGenerateKinds` / `autoImageKinds` / `autoGenerateBattlemaps` /
 * `autoGenerateMobImages`), which `createModule` writes with `satisfies` in the
 * same call. The resume READS the intent (that is what the confirmation
 * describes) but the sweep READS the row, so a divergence would mean running —
 * or silently skipping — work the confirmation never described. Nothing in the
 * app writes them apart, so this returns a message only for a row that cannot be
 * trusted, and the resume then refuses LOUDLY instead of guessing which of the
 * two is the owner's wish.
 */
export function automationIntentDrift(module: Module): string | null {
  const intent = module.automationIntent;
  if (intent === null) return null;
  const same = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && a.every((value) => b.includes(value));
  const drift: string[] = [];
  if (!same(intent.autoGenerateKinds, module.autoGenerateKinds)) drift.push('autoGenerateKinds');
  if (!same(intent.autoImageKinds, module.autoImageKinds)) drift.push('autoImageKinds');
  if (intent.autoGenerateBattlemaps !== module.autoGenerateBattlemaps) {
    drift.push('autoGenerateBattlemaps');
  }
  if (intent.autoGenerateMobImages !== module.autoGenerateMobImages) {
    drift.push('autoGenerateMobImages');
  }
  if (drift.length === 0) return null;
  return (
    `This module's automation settings no longer match what creation recorded (${drift.join(', ')}) — ` +
    'nothing was run, because the missing work cannot be derived from a state the owner did not ask for.'
  );
}
