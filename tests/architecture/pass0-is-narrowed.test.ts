import { describe, expect, it } from 'vitest';

import { CODE, filesWith } from '../helpers/sourceCode';

/**
 * PASS 0 IS NARROWED, NOT DELETED — and this is the pin that says so out loud
 * (docs/23 §10 phase 3, docs/17 rows 390/391).
 *
 * The engine's unit became the LEVEL at row 391: its prompts read the level's
 * OWN TEXT out of the document, so the plan record (`levelPlans` — the title /
 * synopsis / `levelUpTrigger`) is VESTIGIAL for generation. What survives is the
 * pass-0 PLAN AUTHORING itself (`runSpine` and the checkpoint that approves it),
 * and this file records the exact shape of the decision rather than leaving it
 * to prose:
 *
 *   - `runSpine` has exactly ONE STARTER, `createModuleAndRun`, which lives in
 *     `llm/moduleGen.ts` and is called from NO app surface (the app's creation
 *     door is `startCampaignDocument`, pinned in
 *     `tests/architecture/one-document-per-campaign.test.ts`). So no app entry
 *     STARTS a plan any more;
 *   - what IS still reachable is RECOVERY for a row that already carries a
 *     pass-0 plan: the reader's Retry (`retrySpine`) and the spine checkpoint
 *     (`approveSpineAndRun` / `discardSpine` / `retrySpine`), whose mount is
 *     narrowed to `spine.partPlan.length > 0` (docs/17 row 390 — a
 *     chat-authored premise-only document must never land on it, because its
 *     "Discard" would delete the premise the chat just wrote).
 *
 * WHY NARROW RATHER THAN DELETE, stated so a successor can overturn it: the
 * starter is a real caller, the checkpoint and the retry are real recovery for a
 * legacy/imported row with a plan, and deleting the machinery would delete the
 * plan-authoring capability phase 4's generation dialog was declared to need
 * (docs/17 row 390, named as the remainder there). A slice that deletes it must
 * delete THIS file with it and name every pin that dies; a slice that adds a
 * second starter reds here.
 */
describe('pass 0 is NARROWED with its one starter named (SOURCE SCAN, docs/17 row 391)', () => {
  it('the plan-authoring starter is `createModuleAndRun`, and no app surface calls it', () => {
    // A CALL, not the name: the dialog and the difficulty control name
    // `createModuleAndRun` in PROSE (their doc comments), which is not a door.
    expect(filesWith('createModuleAndRun(')).toEqual(['src/llm/moduleGen.ts']);
    expect(filesWith('runSpine(')).toEqual(['src/llm/moduleGen.ts']);
    // The app's create dialog walks through the chat-first entry instead.
    const dialog = CODE['src/features/modules/new-module-dialog.tsx'] ?? '';
    expect(dialog.includes('startCampaignDocument(')).toBe(true);
    expect(dialog.includes('createModuleAndRun(')).toBe(false);
  });

  it('the pass-0 RECOVERY surfaces are the reader retry and the spine checkpoint', () => {
    expect(filesWith('retrySpine(')).toEqual([
      'src/features/modules/ModuleReaderPage.tsx',
      'src/features/modules/spine-checkpoint.tsx',
      'src/llm/moduleGen.ts',
    ]);
    expect(filesWith('approveSpineAndRun(')).toEqual([
      'src/features/modules/spine-checkpoint.tsx',
      'src/llm/moduleGen.ts',
    ]);
    expect(filesWith('discardSpine(')).toEqual([
      'src/features/modules/spine-checkpoint.tsx',
      'src/llm/moduleGen.ts',
    ]);
    // …and the checkpoint is gated on a PASS-0 PLAN, so a chat-authored document
    // can never reach it (docs/17 row 390).
    const reader = CODE['src/features/modules/ModuleReaderPage.tsx'] ?? '';
    expect(reader.includes('spine.partPlan.length > 0')).toBe(true);
  });
});
