import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * "Does this encounter still need a map?" — ONE rule for the OFFER (docs/17
 * row 129, docs/18 §2.3, docs/08 §The encounter-map offer and the encounter-map
 * work walk ONE rule).
 *
 * WHAT THE OFFER IS. `features/modules/post-generation.encountersNeedingMaps`
 * is the gap list EVERY surface that promises map work reads: the
 * post-generation sweep's battlemap block, the "Resume automatic module
 * creation" deviation, and (since row 129) the entity sidebar's
 * "Generate N encounter maps" button. The queue's own per-artifact guard
 * `features/modules/encounter-map-queue.encounterNeedsMap` is the OTHER half
 * of the same fact and is deliberately narrower — it answers "is THIS one
 * artifact missing a map" for a job that already knows its target, with no
 * kind or ownership test, because the queue's enqueue site decided those.
 *
 * WHY THERE IS A SOURCE SCAN HERE, AND NOT ONLY A COUNT PIN. A fold is
 * byte-identical BY CONSTRUCTION: the panel's reverted filter and the seam
 * select the same artifacts, so the count the button advertises is the same
 * number and no behavioural pin can tell the two apart. That has now been
 * measured five times on this repo's sibling folds (77, 176, 60, 18 and the
 * four image queues' 60 — docs/08), so the ROUTING is held by the scan below,
 * labelled as a scan in its own names, while the count and the enqueue payload
 * are held behaviourally in `tests/features/entity-panel.test.tsx`.
 *
 * THE SCAN IS TEXTUAL, and its limits are MEASURED rather than implied (both
 * injections are recorded in docs/08). (1) The disjunction needle cannot see
 * the same question asked in another SHAPE: a truthiness test
 * (`!a.data.layout || !a.data.mapImageId`) does not match it — but the sibling
 * FIELD needles (`mapImageId`, `data.layout`) do, which is injection I3. (2) A
 * copy that reuses a NAMED predicate instead of restating the fields —
 * `artifacts.filter((a) => a.kind === 'encounter' && a.moduleId === module.id
 * && encounterNeedsMap(a))` — evaded ALL THREE needles and left this file GREEN
 * 2/2 with the count pin green too (injection I4), so a fourth needle banning
 * the queue's guard in the panel was added; re-running I4 REDs it. (3) What is
 * still invisible: a copy arriving through a FUNCTION CALL in another module
 * that itself calls `encounterNeedsMap` (ledger 125/127's lesson one level
 * deeper), and the needle set is comment-BLIND — a comment in the panel naming
 * the guard WITH a call parenthesis would trip the fourth needle, which is why
 * this seam's comments name it without one.
 */

/** The gap predicate, either operand order, with whatever receiver spelling
 * the copy chose (`artifact.data.`, a destructured local, a bare `data.`). */
const GAP_DISJUNCTION =
  /layout === null\s*\|\|\s*[A-Za-z0-9_.]*mapImageId === null|mapImageId === null\s*\|\|\s*[A-Za-z0-9_.]*layout === null/;

/** The two files allowed to compose the disjunction, each for a stated reason. */
const RULE_HOLDERS: Record<string, string> = {
  'features/modules/post-generation.ts':
    'the OFFER seam — `encountersNeedingMaps`: encounter kind + module ownership + the gap',
  'features/modules/encounter-map-queue.ts':
    "the QUEUE's own per-artifact guard — `encounterNeedsMap`: the gap alone, for a job whose target the enqueue site already chose",
};

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
const seamCalls = (text: string): number => text.split('encountersNeedingMaps(').length - 1;

describe('the encounter-map gap is ONE rule (SOURCE SCAN)', () => {
  it('scan: the gap disjunction is composed in exactly the offer seam and the queue’s own guard', () => {
    const files = srcFiles();
    // Non-vacuity: the walk must actually see the app, and the needle must
    // actually match the rule holders, or this pin proves nothing about either.
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain('features/modules/post-generation.ts');
    for (const holder of Object.keys(RULE_HOLDERS)) {
      expect(GAP_DISJUNCTION.test(source(holder)), `${holder} carries the gap rule`).toBe(true);
    }

    // The rule, in one line each, pinned as a VALUE so moving a word of it has
    // to be a deliberate, test-visible act rather than a tidy-up.
    expect(source('features/modules/post-generation.ts')).toContain(
      '(artifact.data.layout === null || artifact.data.mapImageId === null),',
    );
    expect(source('features/modules/encounter-map-queue.ts')).toContain(
      'return artifact.data.layout === null || artifact.data.mapImageId === null;',
    );

    const holders = files.filter((file) => GAP_DISJUNCTION.test(source(file)));
    expect(holders, 'files composing the encounter-map gap disjunction').toEqual(
      Object.keys(RULE_HOLDERS).sort(),
    );
  });

  it('scan: the entity panel ROUTES its map count through the offer seam and composes no filter of its own', () => {
    const panel = 'features/modules/entity-panel.tsx';
    const text = source(panel);

    // Exactly ONE call, so a second, hand-rolled count beside the seam is
    // visible as a number rather than as a subtly different button label.
    expect(seamCalls(text), `${panel}: encountersNeedingMaps( calls`).toBe(1);
    expect(text).toContain('const mapTargets = encountersNeedingMaps(module, artifacts);');

    // The reverted fold is byte-identical in BEHAVIOUR — these needles are what
    // red, and each is named so the next reader knows which one guards what.
    expect(GAP_DISJUNCTION.test(text), `${panel}: must not compose the gap rule`).toBe(false);
    expect(text.includes('mapImageId'), `${panel}: must not read the map field itself`).toBe(false);
    expect(text.includes('data.layout'), `${panel}: must not read the layout field itself`).toBe(
      false,
    );
    // MEASURED (injection I4, docs/08): a copy that re-derives the offer through
    // the ENQUEUE SITE'S OWN per-artifact guard — `artifacts.filter((a) => a.kind
    // === 'encounter' && a.moduleId === module.id && encounterNeedsMap(a))` —
    // carried NONE of the three needles above and left this scan GREEN 2/2
    // while the count pin was green too. The guard answers a different question
    // (is THIS chosen artifact missing a map), so borrowing it to enumerate the
    // offer is a second offer rule in the panel — hence this needle.
    expect(
      text.includes('encounterNeedsMap('),
      `${panel}: must not re-derive the offer through the queue’s per-artifact guard`,
    ).toBe(false);
  });
});
