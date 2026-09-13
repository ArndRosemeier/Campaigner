import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * "A batch finished with failures, and here is what happened" — ONE seam
 * (docs/17 row 131, docs/18 §2.3, docs/08 §A batch failure is reported through
 * ONE seam).
 *
 * WHY A SOURCE SCAN IS HERE AND NOT ONLY BEHAVIOUR. The fold is byte-identical
 * BY CONSTRUCTION: the panel's sentence and the automation's sentence were the
 * same characters before the fold and are the same characters after it, so
 * reverting the fold leaves every behavioural pin green — measured five times
 * on this repo's sibling folds (77, 176, 60, 18, 60 — docs/08), and measured
 * again here in THIS slice's injections (the whole fold reverted: the seam test
 * and the panel pins stayed GREEN; only this file reddened). So the ROUTING and
 * the fact that the sentence is composed in exactly ONE file are held here,
 * labelled as scans in their own names, while the payload, the copy and the
 * toast's duration are held behaviourally in
 * `tests/features/entity-batch-failure-report.test.ts`.
 *
 * THE SCAN IS TEXTUAL, and its limits are MEASURED rather than implied (the
 * injections are recorded in docs/08 and docs/18 §4). It cannot see:
 *
 * - a copy that arrives through a FUNCTION CALL in another module which itself
 *   composes the sentence (the ledger 125/127/129 lesson one level deeper);
 * - an EQUIVALENT SPELLING that avoids the needles — measured: a re-inlined
 *   sentence built as `['failed','to','generate'].join(' ')` and joined with
 *   `String.fromCharCode(59)` left this file GREEN 3/3 (injection I6);
 * - a needle inside a comment: the needles are comment-BLIND, which is why
 *   `entity-batch.ts`'s historical quote of the old toast is a KNOWN file below
 *   rather than a surprise red.
 */

/** Every `src/**` file, with its text — the population every pin below is
 * asserted against, so a scanner that silently stops finding files fails the
 * non-vacuity check instead of passing empty. */
function srcFiles(): { path: string; text: string }[] {
  const root = join(process.cwd(), 'src');
  const found: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
      found.push({
        path: full.slice(root.length + 1),
        text: readFileSync(full, 'utf8'),
      });
    }
  };
  walk(root);
  return found;
}

const SRC = srcFiles();

/** The files allowed to reference the reporting seam, each for a stated
 * reason. Asserted by EQUALITY: a THIRD caller reds this pin (a new batch
 * surface must report through the seam deliberately, not by accident). */
const SEAM_USERS: Record<string, string> = {
  'features/modules/entity-batch-report.ts': 'the seam itself — it composes the count sentence, the console payload and the toast',
  'features/modules/entity-panel.tsx': "the entity panel's per-kind batch button",
  'features/modules/post-generation.ts': "the unattended module-generation sweep's entity batches",
};

/** The files that may contain the count sentence at all. The seam COMPOSES it;
 * the other two only ever QUOTE it — `entity-batch.ts` in a doc comment
 * recording the row-117 incident, ModuleReaderPage about a single failed
 * module PART (a different sentence that happens to share three words). */
const SENTENCE_HOLDERS: Record<string, string> = {
  'features/modules/entity-batch-report.ts': 'the composer — the ONE place the count sentence is written',
  'features/modules/entity-batch.ts':
    'a DOC COMMENT quoting the historical toast from the row-117 incident ("3 of 5 npcs failed to generate"); no code here composes it',
  'features/modules/ModuleReaderPage.tsx':
    'an unrelated per-PART sentence ("This part failed to generate.") about a module part, not about a batch of entities',
};

/** Needles that mean "the sentence is being composed HERE again". Each is
 * banned from both call sites, and each was verified present in the
 * pre-change copies (see this slice's injections).
 *
 * A needle is chosen to be DEFECT-SHAPED, which is a measured constraint and
 * not a taste: a `.join('; ')` needle was tried first and REDdened on healthy
 * code in both files (`entity-panel.tsx:678` joins unrelated list items, and
 * the sweep builds a "failed to enqueue mob portraits (…)" sentence the same
 * way). A needle that fires on correct code teaches the next reader to delete
 * it, so the shape it was meant to catch is caught by the two needles that
 * read the FAILURE RECORD instead. */
const COMPOSITION_NEEDLES: readonly { name: string; pattern: RegExp }[] = [
  { name: 'the count phrase itself', pattern: /failed to generate/ },
  { name: 'the plural table the sentence needs', pattern: /\bKIND_PLURALS\b/ },
  { name: "a read of the batch's failure list to build a sentence", pattern: /\.failed\s*\.map\(/ },
  { name: "the failure record's human sentence read at a call site", pattern: /\bfailure\.message\b/ },
  { name: 'the sentence’s own tail (`see the Runs tab`)', pattern: /see the Runs tab/ },
];

describe('the batch-failure report goes through ONE seam (source scans)', () => {
  it('the scanner reads the whole source tree (non-vacuity)', () => {
    expect(SRC.length).toBeGreaterThan(200);
    expect(SRC.map((file) => file.path)).toContain('features/modules/entity-batch-report.ts');
  });

  it('exactly the two call sites route through the seam, by EQUALITY', () => {
    const users = SRC.filter((file) => file.text.includes('reportEntityBatchFailures(')).map(
      (file) => file.path,
    );
    expect([...users].sort()).toEqual(Object.keys(SEAM_USERS).sort());
    // …and the known list is not a rubber stamp: each entry still names a
    // REASON, so removing a caller has to be a deliberate edit here too.
    for (const reason of Object.values(SEAM_USERS)) {
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  it('the count sentence is composed in exactly ONE file', () => {
    const holders = SRC.filter((file) => file.text.includes('failed to generate')).map(
      (file) => file.path,
    );
    expect([...holders].sort()).toEqual(Object.keys(SENTENCE_HOLDERS).sort());
  });

  it('the per-failure record is written from ONE funnel, and the batch cannot append around it', () => {
    const batch = SRC.find((file) => file.path === 'features/modules/entity-batch.ts');
    if (batch === undefined) throw new Error('scanner lost the batch');
    // THE structural guarantee behind "the root problem is simply not recorded"
    // (owner, verbatim): a failure is appended to the batch's list in EXACTLY
    // one line — inside `recordFailure`, which also writes it down through the
    // seam. A new failure arm that pushes directly makes this 2 and reds.
    const pushes = batch.text.match(/failed\.push\(/g) ?? [];
    expect(pushes).toHaveLength(1);
    // …and the seam's per-failure entry point is called from exactly that
    // funnel: the definition site plus one caller in the batch, nowhere else.
    const writers = SRC.filter((file) => file.text.includes('recordEntityBatchFailure(')).map(
      (file) => file.path,
    );
    expect([...writers].sort()).toEqual([
      'features/modules/entity-batch-report.ts',
      'features/modules/entity-batch.ts',
    ]);
    const inBatch = batch.text.match(/recordEntityBatchFailure\(/g) ?? [];
    expect(inBatch).toHaveLength(1);
  });

  it('a record exists as PASTEABLE text under its own tag, and the object entry cannot be mistaken for it', () => {
    const seam = SRC.find((file) => file.path === 'features/modules/entity-batch-report.ts');
    if (seam === undefined) throw new Error('scanner lost the seam');
    // The three tags are DISTINCT: a reader grepping for the line to copy must
    // not also match the live-object entry (MEASURED — while both began with
    // the record tag, a parser could not tell them apart).
    expect(seam.text).toContain("BATCH_FAILURE_RECORD_TAG = 'entity-batch failure'");
    expect(seam.text).toContain("BATCH_FAILURE_SUMMARY_TAG = 'entity-batch summary'");
    expect(seam.text).toContain("BATCH_FAILURE_DETAIL_TAG = 'entity-batch detail'");
    // The pasteable form is JSON, built in the seam and only there.
    expect(seam.text).toContain('JSON.stringify(');
    const stringifiers = SRC.filter((file) => file.text.includes('JSON.stringify(')).map(
      (file) => file.path,
    );
    expect(stringifiers).toContain('features/modules/entity-batch-report.ts');
  });

  it('neither call site re-states the sentence: every composition needle is absent', () => {
    for (const path of ['features/modules/entity-panel.tsx', 'features/modules/post-generation.ts']) {
      const file = SRC.find((candidate) => candidate.path === path);
      if (file === undefined) throw new Error(`scanner lost ${path}`);
      for (const needle of COMPOSITION_NEEDLES) {
        expect(
          needle.pattern.test(file.text),
          `${path} carries ${needle.name} — the count sentence belongs to features/modules/entity-batch-report.ts`,
        ).toBe(false);
      }
    }
  });

  it('the seam raises BOTH the console entry and the toast (AGENTS rule 2: never console-only)', () => {
    const seam = SRC.find((file) => file.path === 'features/modules/entity-batch-report.ts');
    if (seam === undefined) throw new Error('scanner lost the seam');
    expect(seam.text).toContain('console.error(');
    expect(seam.text).toContain('toastErrorPersistent(');
    // The TRANSIENT helper is what made the owner's report blink away; the
    // seam must not reach for it.
    expect(seam.text).not.toContain('toastError(');
  });
});
