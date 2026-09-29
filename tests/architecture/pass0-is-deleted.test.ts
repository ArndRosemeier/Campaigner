import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { countsIn, rawSourceText } from '../helpers/sourceCode';

/**
 * PASS 0 IS DELETED — the temporary compatibility layer the storage cut built
 * in phase 1b is gone, and this scan is the proof (docs/23 §10 phase 3,
 * docs/17 rows 390/391/392).
 *
 * Pass 0 drafted the plan (a premise plus a part plan, one JSON call) and the
 * checkpoint approved it before pass 1 ran. Row 390 moved the app's premise
 * authoring to the CHAT and narrowed pass 0 to a legacy row; row 391 made the
 * generation engine's unit the LEVEL and named the deletion's full pin list;
 * row 392 DELETED the machinery: the pass entry points, the spine prompt
 * builder and its JSON reply boundary, the whole-spine and plan-only row
 * writes, the checkpoint component, the reader's spine tail/Retry card and the
 * per-level stream store's `null` (spine) key.
 *
 * THIS IS A SOURCE SCAN BECAUSE the deletion's failure mode is INVISIBLE to
 * behaviour tests: a revived helper compiles, and a stale COMMENT naming the
 * deleted seam is the drift that actually happened at row 386. It reads RAW
 * text (the ONE `tests/helpers/sourceCode.rawSourceText` view) over BOTH trees
 * and sees comments.
 *
 * THE PIN NAMES ITSELF AS THE ONE CARRIER, exactly as the row-386 format scan
 * does: every needle is written literally below, so THIS file legitimately
 * contains it, and each arm requires the carrier list to be exactly `[this
 * file]`. That keeps the detector non-vacuous (the needle is proven greppable
 * in this very tree) and reds the moment a second carrier appears — a revived
 * function, a re-export, or one comment that writes the name again.
 */

const ROOT = process.cwd();
const SRC_DIR = join(ROOT, 'src');
/** This file, as the scan reports paths. */
const SELF = 'tests/architecture/pass0-is-deleted.test.ts';

/** The DELETED pass-0 machinery's whole vocabulary. */
const DELETED_IDENTIFIERS = [
  // The pass entry points and its shared chat plumbing (public exports).
  'runSpine',
  'SpineRunOptions',
  'retrySpine',
  'approveSpineAndRun',
  'discardSpine',
  'createModuleAndRun',
  'runAutomatedParts',
  // The spine prompt builder and its entity/intent/level-hint clauses.
  'spineMessages',
  'spineEntityLevelHint',
  'SPINE_ENTITY_INTENT',
  // The spine JSON reply boundary (the emitted contract and its two parsers).
  'spineReplySchema',
  'parseSpine',
  'parseSpineEntities',
  'entityKindsReplySchema',
  'modelEntityKindSchema',
  // The pass-0-only adversarial premise review.
  'reviewPremiseInGeneration',
  // The checkpoint UI, its component and its mounting path.
  'SpineCheckpoint',
  'spine-checkpoint',
  // The pass-0 row writes (the checkpoint's own seams).
  'saveSpine',
  'savePartPlan',
  // The pass-0 stream events (the reader's spine tail).
  'spine-token',
  'spine-thinking',
];

describe('pass 0 is DELETED (SOURCE SCAN, docs/17 row 392)', () => {
  it('sees a real tree, and the deleted checkpoint file is GONE', async () => {
    const raw = await rawSourceText();
    // Non-vacuity: a walk that saw nothing would make every count below
    // meaningless. Both trees are in the map.
    expect(Object.keys(raw).length).toBeGreaterThan(400);
    expect(Object.keys(raw).some((path) => path.startsWith('src/'))).toBe(true);
    expect(Object.keys(raw).some((path) => path.startsWith('tests/'))).toBe(true);
    // The component really was deleted, not emptied.
    expect(existsSync(join(SRC_DIR, 'features', 'modules', 'spine-checkpoint.tsx'))).toBe(false);
    // …and the ONE level-addressed engine seam survives where it should.
    expect(existsSync(join(SRC_DIR, 'llm', 'moduleGen.ts'))).toBe(true);
    expect(existsSync(join(SRC_DIR, 'db', 'moduleRepo.ts'))).toBe(true);
  });

  it('carries no deleted pass-0 identifier outside this pin', async () => {
    const raw = await rawSourceText();
    for (const needle of DELETED_IDENTIFIERS) {
      // The pin is the ONLY carrier: it proves the needle is greppable in this
      // tree (non-vacuity), and any second carrier — a revived entry point, a
      // re-export, a comment that reintroduces the name — reds by file.
      expect(countsIn(raw, '', needle).map(([path]) => path), needle).toEqual([SELF]);
    }
  });
});
