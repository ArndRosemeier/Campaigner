import { describe, expect, it } from 'vitest';

import { CODE, filesWith, rawSourceText } from '../helpers/sourceCode';

/**
 * ONE SELECTION SEAM, AND NO AUTOMATISM (docs/23 §7/§8, docs/17 row 394).
 *
 * The owner's request has two halves: *"a detail generation dialog with
 * checkboxes and level ranges"* and *"No automatism … I do not need the old
 * generation mechanism anymore"*. Behaviour tests can prove the dialog's scope
 * (docs/08, `tests/features/generation-{selection,dialog}`); they CANNOT prove
 * that a pass the app used to start by itself is gone, because a revived
 * automatic call compiles and only fires on a path a unit test does not take.
 * This is therefore a SOURCE pin, and it is deliberately two-sided: every
 * `not.toContain` sits beside a `toContain` proving the needle is greppable, so
 * a rename cannot make the scan vacuous.
 *
 * WHAT IT IS NOT: not a duplication detector (the tripwire owns that) and not a
 * proof that the removed passes cannot come back through a different call — it
 * pins the vocabulary the removal was made of.
 */

const SWEEP = 'src/features/modules/post-generation.ts';
const MODULE_GEN = 'src/llm/moduleGen.ts';
const POST_RUN = 'src/features/campaign/post-run-extras.ts';
const NEW_MODULE = 'src/features/modules/new-module-dialog.tsx';
const DIALOG = 'src/features/modules/generation-dialog.tsx';
const SEAM = 'src/features/modules/generation-selection.ts';
const RUN = 'src/features/modules/generation-run.ts';

function code(path: string): string {
  const text = CODE[path];
  if (text === undefined) throw new Error(`${path} is not in the src/ tree scan`);
  return text;
}

describe('the automatic generation triggers are gone', () => {
  it('the engine no longer fires the post-generation sweep when a parts pass lands', () => {
    // The sweep itself STAYS (the engine is what the dialog drives) …
    expect(code(SWEEP)).toContain('export async function runModulePostGeneration');
    expect(code(SWEEP)).toContain('export function batchTargets');
    // … and NOTHING in the generator starts it any more.
    expect(code(MODULE_GEN)).not.toContain('runModulePostGeneration');
    expect(code(MODULE_GEN)).toContain('export async function generateMissingParts');
  });

  it('a completed run no longer auto-enqueues battlemaps or roster portraits', () => {
    // The explicit extras the owner ticked for a run still run …
    expect(code(POST_RUN)).toContain('run.runExtras');
    expect(code(POST_RUN)).toContain('enqueueEncounterPortraitFill');
    // … but the two AUTOMATIC paths (a fresh encounter's map, a landed roster's
    // portraits) and their switches are deleted.
    expect(code(POST_RUN)).not.toContain('encounterNeedsMap');
    expect(code(POST_RUN)).not.toContain('isEncounterMapPending');
    expect(code(POST_RUN)).not.toContain('useEncounterMapQueue');
    expect(code(POST_RUN)).not.toContain('autoGenerateBattlemaps');
    expect(code(POST_RUN)).not.toContain('autoGenerateMobImages');
  });

  it('creation records no automation intent, so no later surface can start work by itself', () => {
    const source = code(NEW_MODULE);
    // The CONTROLS are gone (their test ids appear nowhere) …
    for (const needle of [
      'module-automation-grid',
      'auto-spine',
      'auto-battlemaps',
      'auto-mob-images',
      'auto-generate-',
      'auto-image-',
    ]) {
      expect(source).not.toContain(needle);
    }
    // … and the creation PAYLOAD no longer carries the flags either, so a
    // module created from now on records an EMPTY automation intent whatever the
    // stored draft happens to hold. (The draft's own fields survive as the
    // stored-format compatibility record; that is the named remainder, docs/18
    // §5, and it is why this pin scopes to the payload rather than the file.)
    const start = source.slice(source.indexOf('const input: NewModule'));
    const payload = start.slice(0, start.indexOf('};'));
    for (const needle of [
      'autoGenerateKinds',
      'autoImageKinds',
      'autoGenerateBattlemaps',
      'autoGenerateMobImages',
      'autoApproveSpine',
    ]) {
      expect(payload).not.toContain(needle);
    }
    // The dialog still creates (the control inventory is the claim, not an
    // empty file).
    expect(source).toContain('startCampaignDocument');
  });
});

describe('ONE selection seam on the DERIVED level list', () => {
  it('is defined exactly once, and it is the seam the dialog and the run read', () => {
    expect(filesWith('export function selectLevelNames')).toEqual([SEAM]);
    expect(filesWith('export function selectGenerationTargets')).toEqual([SEAM]);
    expect(code(DIALOG)).toContain('selectGenerationTargets');
    expect(code(RUN)).toContain('selectGenerationTargets');
  });

  it('derives the levels through the ONE level list, never a second parse', () => {
    // The level list has ONE definition, in the domain …
    expect(filesWith('export function moduleLevelList')).toEqual([
      'src/domain/moduleDocument.ts',
    ]);
    // … the seam reads it, and the dialog reads it for the picker's bounds —
    // the SAME derivation, never the parser.
    expect(code(SEAM)).toContain('moduleLevelList');
    expect(code(DIALOG)).toContain('moduleLevelList');
    for (const path of [SEAM, DIALOG, RUN]) {
      expect(code(path)).not.toContain('splitModuleDocument');
    }
  });

  it('reuses the existing verdict and detector seams instead of re-deciding what is missing', () => {
    for (const needle of [
      'batchTargets',
      'imageTargets',
      'encountersNeedingMaps',
      'encountersNeedingMobPortraits',
    ]) {
      expect(code(SEAM)).toContain(needle);
    }
    // The dispatcher drives the EXISTING engine units, in the domain's kind
    // order (encounters last — the fixed-cast pin).
    expect(code(RUN)).toContain('runEntityBatch');
    expect(code(RUN)).toContain('useEntityImageQueue');
    expect(code(RUN)).toContain('useEncounterMapQueue');
    expect(code(RUN)).toContain('enqueueEncounterPortraitFill');
  });
});

describe('the dialog is the only thing that states a scope', () => {
  it('renders the count from the seam it dispatches, in ONE place', async () => {
    const raw = await rawSourceText();
    const dialog = raw[DIALOG];
    expect(dialog).toBeDefined();
    expect(dialog).toContain('generation-scope-count');
    expect(dialog).toContain('selection.totalCount');
    expect(dialog).toContain('WIDE_SELECTION_JOBS');
  });
});
