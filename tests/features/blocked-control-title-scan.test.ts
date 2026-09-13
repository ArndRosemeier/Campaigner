import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * SCAN — this file is a SOURCE scan, not a behavioural pin (docs/18 §4,
 * ledger 125). It reads `src/**` as TEXT; it renders nothing.
 *
 * The rule it holds: **a control that a `BlockedControl` wraps may not state its
 * REASON in a `title`.** `BlockedControl` is the one device that makes a reason
 * perceivable — the wrapper is the tooltip trigger and the tab stop, and the
 * same sentence rides a visually hidden node the wrapper points at with
 * `aria-describedby` (docs/18 §2.3). A `title` on the natively disabled child
 * beside it is rendered by no browser (the control fires no pointer events, and
 * every shadcn Button adds `disabled:pointer-events-none`) and is reached by no
 * keyboard — so a second copy there is not a fallback. It is a second place for
 * the sentence to DRIFT, and the audit that produced ledger 125 found it doing
 * exactly that at five sites, one of them (entity-panel's classify control)
 * writing one sentence twice 17 lines apart.
 *
 * TWO rules catch the two shapes that defect actually took:
 *
 *  - `shape` — the title expression is a bare identifier, or a nullish-coalesce
 *    (`title={reason ?? 'what the control does'}`). That is the drift-by-
 *    construction shape: which half is visible depends on the control's state,
 *    and the half that is a reason is the invisible one.
 *  - `branch` — the title expression carries a string literal the wrapper's own
 *    `reason` expression also carries. That is the same sentence written twice.
 *
 * HONEST LIMIT, MEASURED (ledger 127 injection I3, kept GREEN on purpose): the
 * `branch` rule compares string LITERALS, so it can only see a sentence that is
 * written inside the wrapper's own `reason={…}` span — or in the `const` that
 * span names outright, which `resolveIdentifier` below follows one level. A
 * reason that reaches the wrapper through a FUNCTION CALL has no literal in the
 * span at all, and a title quoting that sentence verbatim therefore reads as
 * clean. entity-panel's `generate-everything` is exactly that site: its
 * sentences come from `generateAllBlockedReason()`, so only the `shape` rule
 * guards it (which is the shape that control's defect actually took). The
 * blindness is REPORTED here rather than papered over with a scanner that parses
 * ternaries and function bodies.
 *
 * What is NOT a violation, and must not be treated as one: a DESCRIPTION —
 * "what pressing this control does" — gated on the control being able to act
 * (`title={blocked ? undefined : '…'}`). A `title` on a LIVE control is a
 * surface the owner really has; every one of the five wrappers that carries a
 * `title` now keeps its description that way, and each has a behavioural pin
 * asserting both halves (no title while held, the description while live).
 *
 * The scan carries NO allowance. Ledger 125 named exactly two sites it had
 * deliberately left un-folded (both pinned as titles by other files) in a
 * `KNOWN_RESTATED_TITLES` list asserted by EQUALITY so a third offender — or a
 * silent fix of one of the two — could not rot unnoticed. Ledger 127 folded
 * those two and the list went with them: `restatedTitleViolations()` must now be
 * EMPTY. An allowance must not outlive its cause (rows 123/125's own lesson), so
 * the equality was the transition device, never the destination.
 */

const SRC = 'src';

interface BlockedControlSpan {
  file: string;
  testId: string;
  /** The `reason={…}` expression as written, or null when the wrapper has none. */
  reason: string | null;
  /** The child's `title` expression as written, or null when it carries none. */
  title: string | null;
}

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(full)));
    else if (/\.tsx?$/.test(entry.name)) files.push(full);
  }
  return files;
}

/**
 * The expression that starts at `open`: a quoted literal, a `{…}` block (the
 * attribute form) or — for a `const x = <expression>` right-hand side — the
 * statement up to its own `;`.
 */
function expressionAt(source: string, open: number): string {
  if (source[open] === '"' || source[open] === "'" || source[open] === '`') {
    const quote = source[open];
    const end = source.indexOf(quote, open + 1);
    return source.slice(open + 1, end === -1 ? undefined : end);
  }
  const braced = source[open] === '{';
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{' || ch === '(' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ')' || ch === ']') {
      depth -= 1;
      if (braced && depth === 0) return source.slice(open + 1, i);
    } else if (!braced && ch === ';' && depth === 0) return source.slice(open, i);
  }
  return source.slice(braced ? open + 1 : open);
}

/** The attribute's expression (`{…}` or `"…"`), or null when the span omits it. */
function attributeExpression(span: string, attribute: string): string | null {
  const at = span.search(new RegExp(`\\b${attribute}=(?=[{'"])`));
  if (at === -1) return null;
  return expressionAt(span, at + attribute.length + 1);
}

/**
 * The expression as the reader resolves it: a `reason` written as a bare
 * identifier is looked up ONE level, to its `const <name> = …` declaration.
 * MEASURED (ledger 125's injection I3): without this, `reason={classifyReason}`
 * hides the whole sentence from the `branch` rule — the reason's literals are
 * no longer inside the span — so a title that restates it reads as clean. The
 * declaration is the expression the reader actually compares against.
 */
function resolveIdentifier(source: string, expression: string): string {
  const name = expression.trim();
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return expression;
  const declared = new RegExp(`\\bconst\\s+${name}\\s*=`).exec(source);
  if (declared === null) return expression;
  return expressionAt(source, declared.index + declared[0].length);
}

function testIdOf(openTag: string): string {
  const quoted = /\btestId="([^"]+)"/.exec(openTag);
  if (quoted !== null) return quoted[1] ?? '?';
  const computed = /\btestId=\{`([^`]+)`\}/.exec(openTag);
  return computed?.[1] ?? '?';
}

/** Every `BlockedControl` span in `src/`, with the two expressions that matter. */
async function blockedControlSpans(): Promise<BlockedControlSpan[]> {
  const spans: BlockedControlSpan[] = [];
  for (const file of await sourceFiles(SRC)) {
    const source = await readFile(file, 'utf8');
    const blocks = source.matchAll(/<BlockedControl\b[\s\S]*?<\/BlockedControl>/g);
    for (const block of blocks) {
      const span = block[0];
      const reason = attributeExpression(span, 'reason');
      spans.push({
        file,
        testId: testIdOf(span),
        reason: reason === null ? null : resolveIdentifier(source, reason),
        title: attributeExpression(span, 'title'),
      });
    }
  }
  return spans;
}

function stringLiterals(expression: string): string[] {
  return [...expression.matchAll(/'([^'\\]*)'/g)].map((match) => match[1] ?? '');
}

/** The reasons still stated in a `title` beside a `BlockedControl` wrapper. */
async function restatedTitleViolations(): Promise<
  { file: string; testId: string; rule: 'branch' | 'shape' }[]
> {
  const violations: { file: string; testId: string; rule: 'branch' | 'shape' }[] = [];
  for (const span of await blockedControlSpans()) {
    if (span.title === null || span.reason === null) continue;
    const title = span.title.trim();
    const reasonLiterals = new Set(stringLiterals(span.reason));
    if (title.includes('??') || /^[A-Za-z_$][\w$.]*$/.test(title)) {
      violations.push({ file: span.file, testId: span.testId, rule: 'shape' });
      continue;
    }
    if (stringLiterals(title).some((literal) => literal !== '' && reasonLiterals.has(literal))) {
      violations.push({ file: span.file, testId: span.testId, rule: 'branch' });
    }
  }
  return violations.sort((a, b) => a.file.localeCompare(b.file) || a.testId.localeCompare(b.testId));
}

describe('SCAN: a reason is never stated in a title beside its BlockedControl wrapper', () => {
  it('the scanner reaches the surfaces it is about, and exactly five wrappers in src/ carry ANY title', async () => {
    const spans = await blockedControlSpans();
    // Non-vacuity: the scan's own eyesight. Every surface ledger 125 changed is
    // in the population it walked — a regex that stopped matching would
    // otherwise make the rule below pass by finding nothing at all.
    const found = spans.map((span) => span.testId);
    for (const testId of [
      'canvas-save',
      'canvas-fix-problems',
      'canvas-resume-automation',
      'entity-classify-new',
      'batch-${kind}',
      'generate-everything',
    ]) {
      expect(found).toContain(testId);
    }

    // The population of titles inside a wrapper, by EQUALITY: the five gated
    // DESCRIPTIONS — the only thing a `title` may now carry here. A new title in
    // this list, and a title that disappears from it, are both deliberate acts
    // that must update this assertion.
    expect(
      spans
        .filter((span) => span.title !== null)
        .map((span) => span.testId)
        .sort(),
    ).toEqual([
      'canvas-fix-problems',
      'canvas-resume-automation',
      'encounter-repopulate',
      'entity-classify-new',
      'generate-everything',
    ]);
  });

  it('no wrapper states its reason in the child’s title — anywhere in src/, with no allowance left', async () => {
    // EMPTY, not "unchanged": ledger 127 removed the two-entry allowance this
    // used to equal as well as the two sites it named (docs/17 rows 123/125).
    expect(await restatedTitleViolations()).toEqual([]);
  });
});
