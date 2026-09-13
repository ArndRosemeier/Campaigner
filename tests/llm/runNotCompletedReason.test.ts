import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createPersonaRun, newId, type PersonaRun } from '@/domain';
import { runNotCompletedReason } from '@/llm/runEngine';

/**
 * "This run did not finish" — the engine's ONE sentence seam (docs/17 row 128,
 * docs/18 §2/§5, docs/08 §The one way to say why a run did not finish).
 *
 * WHAT IT IS. `runNotCompletedReason(run, label?)` answers ONE question: what
 * do we SAY about a run that is not `completed`. The engine's own
 * `errorMessage` is an authored sentence, so it IS the reason — verbatim,
 * never reworded and never demoted to a detail behind somebody else's words.
 * Only when the engine wrote nothing does the caller's own vocabulary name the
 * fact: `<label> ended <status>`, `'run'` when the caller has no label.
 *
 * WHAT IT IS NOT. A verdict. Whether a run's end is reportable at all is still
 * `isRunWithdrawn`'s job, read by whoever holds the row (ledger 117) — the
 * seam must never be widened into the predicate, and the two pins below state
 * that separation rather than leaving it to a doc comment.
 *
 * WHY THERE IS A SOURCE SCAN HERE TOO. A fold is byte-identical BY
 * CONSTRUCTION: reverting a folded call site to the hand-rolled expression it
 * replaced emits the same string, so every behavioural pin stays green. That
 * was measured three times on this repo's sibling folds (77, then 176, then 60
 * behavioural pins stayed green while only a scan reddened — docs/08), so the
 * routing is held by the scan below, labelled as a scan in its own names.
 *
 * THE SCAN IS TEXTUAL, and its limits are stated rather than implied: it sees
 * the formula `… ended ${<something>.status}` and the hand-rolled shapes it
 * replaced, so a copy that computed the sentence through an intermediate
 * variable, or that spelled the fallback as `'run ended ' + run.status`, would
 * be invisible to it. It is also comment-BLIND, which is why every doc comment
 * on this seam names the helper WITHOUT a call parenthesis.
 */

/** A real `PersonaRun` (the domain factory, so the rule table is judged
 * against the shape the callers actually hold — never a cast stub). */
function run(overrides: Partial<PersonaRun>): PersonaRun {
  return {
    ...createPersonaRun({
      campaignId: newId(),
      personaId: newId(),
      autonomy: 'auto',
      userBrief: 'Write the thing',
    }),
    ...overrides,
  };
}

/** A verbatim engine sentence: the shape `runEngine.fail` actually writes. */
const ENGINE_SENTENCE =
  'Step "brief" rejected: the model reply could not be parsed into the required JSON shape ' +
  'after one automatic retry. The run failed without saving partial results — run it again, ' +
  'or use manual/review autonomy to keep the raw reply for editing.';

describe('runNotCompletedReason — the ONE way to say why a run did not finish', () => {
  it("an engine-written message IS the sentence: verbatim, with no label and no status around it", () => {
    const failed = run({ status: 'failed', errorMessage: ENGINE_SENTENCE });

    expect(runNotCompletedReason(failed)).toBe(ENGINE_SENTENCE);
    // The label is the FALLBACK's vocabulary, never a prefix to the engine's
    // own sentence: passing one must not change a word of it.
    expect(runNotCompletedReason(failed, 'Repopulate')).toBe(ENGINE_SENTENCE);
    expect(runNotCompletedReason(failed, 'Repopulate')).not.toContain('Repopulate');
    // The status is a fallback word too — a run that died with a message never
    // reads as "ended <status>".
    expect(runNotCompletedReason(failed)).not.toContain('ended');
  });

  it('an empty errorMessage yields the caller’s own label, `run` when the caller has none', () => {
    const died = run({ status: 'failed', errorMessage: '' });

    expect(runNotCompletedReason(died)).toBe('run ended failed');
    expect(runNotCompletedReason(died, 'Repopulate')).toBe('Repopulate ended failed');
    // The one label default is a real word, never an empty string or
    // `undefined` leaking into the sentence.
    expect(runNotCompletedReason(died)).not.toContain('undefined');
  });

  it('a withdrawn row still HAS a sentence — the seam is not the predicate, and must never be widened into it', () => {
    const stopped = run({ status: 'cancelled', errorMessage: '' });

    // The exact string ledger 117 keeps OUT of the owner's face at the queue:
    // it exists, it is composed here, and only `isRunWithdrawn` decides
    // whether anybody gets to hear it.
    expect(runNotCompletedReason(stopped)).toBe('run ended cancelled');
    expect(runNotCompletedReason(stopped, 'Repopulate')).toBe('Repopulate ended cancelled');
  });
});

describe('the reason is composed in ONE place (SOURCE SCAN)', () => {
  /** The fallback formula: `<label> ended <status>`. */
  const FALLBACK = /ended \$\{[^}]*\.status\}/;
  const SEAM = 'llm/runEngine.ts';

  /**
   * The files allowed to carry the fallback formula, with the reason each one
   * is (docs/18 §2 row + §5 note). `encounterRegen.ts` is the deliberate
   * BOUNDARY: its label names which LEG of a chained operation died, a fact
   * the engine's sentence cannot carry, so its message rides as a
   * colon-suffixed detail instead of as the whole sentence.
   */
  const BOUNDARIES: Record<string, string> = {
    [SEAM]: 'the seam itself — it IS the formula, stated once',
    'features/campaign/encounterRegen.ts':
      'the manual regen chain (docs/18 §5): a leg label plus the engine sentence as a colon-suffixed detail',
  };

  /** Every folded site, with the COUNT of seam calls it must contain (a count,
   * not `>= 1`: reopening ONE copy must be visible). */
  const FOLDED: Record<string, { readonly seams: number }> = {
    'features/modules/encounter-map-queue.ts': { seams: 2 },
    'features/modules/entity-batch.ts': { seams: 1 },
  };

  /** The hand-rolled shapes the fold replaced — none may survive in a folded
   * file. `errorMessage !==` / `errorMessage ||` are the two spellings of the
   * empty check the seam now owns. */
  const BANNED_IN_FOLDED = ['run ended', 'errorMessage !==', 'errorMessage ||'] as const;

  function srcFiles(): string[] {
    const root = join(process.cwd(), 'src');
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
        found.push(full.slice(root.length + 1).replace(/\\/g, '/'));
      }
    };
    walk(root);
    return found.sort();
  }

  const source = (file: string): string => readFileSync(join(process.cwd(), 'src', file), 'utf8');
  const seamCalls = (text: string): number => text.split('runNotCompletedReason(').length - 1;

  it('scan: composes the "… ended <status>" fallback in exactly the seam and its one documented boundary', () => {
    const files = srcFiles();
    // Non-vacuity: the walk must actually see the app, and the needle must
    // actually match the seam, or this pin proves nothing about either.
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain(SEAM);
    expect(FALLBACK.test(source(SEAM)), 'the seam carries the fallback formula').toBe(true);
    expect(source(SEAM)).toContain('`${label} ended ${run.status}`');

    const holders = files.filter((file) => FALLBACK.test(source(file)));
    expect(holders, 'files composing "… ended <status>"').toEqual(Object.keys(BOUNDARIES).sort());

    // The seam's rule, in one line, pinned as a VALUE so a reword has to be a
    // deliberate, test-visible act.
    expect(source(SEAM)).toContain(
      "return run.errorMessage !== '' ? run.errorMessage : `${label} ended ${run.status}`;",
    );
  });

  for (const [file, { seams }] of Object.entries(FOLDED)) {
    it(`scan: routes every "did not finish" reason in ${file} through the seam`, () => {
      const text = source(file);
      expect(seamCalls(text), `${file}: runNotCompletedReason( calls`).toBe(seams);
      // A reverted fold is byte-identical in behaviour — the scan is the pin.
      for (const banned of BANNED_IN_FOLDED) {
        expect(text.includes(banned), `${file}: hand-rolled "${banned}" must be gone`).toBe(false);
      }
    });
  }

  it('scan: the boundary is still the boundary — `awaitCompletedRun` composes its own leg sentence and calls no seam', () => {
    const boundary = 'features/campaign/encounterRegen.ts';
    const text = source(boundary);

    // Both halves of the documented shape: the label prefix, and the message
    // as a colon suffix (never as the whole sentence).
    expect(text).toContain('`${label} ended ${run.status}');
    expect(text).toContain("run.errorMessage === '' ? '' : `: ${run.errorMessage}`");
    // If a later slice folds this site, this pin REDS on purpose: the
    // boundary's licence must not outlive its cause (row 123's lesson) — the
    // docs, this scan and the wording pins move together or not at all.
    expect(seamCalls(text), `${boundary}: must NOT call the seam while it is the boundary`).toBe(0);
  });
});
