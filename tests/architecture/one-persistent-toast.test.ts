import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { repoFiles } from '../helpers/sourceCode';

/**
 * THE one persistent-notice mechanism (docs/17 rows 136 and 280, docs/18 §2.3).
 *
 * `lib/toast.ts` owns every toast the app raises. Two of its entry points are
 * PERSISTENT — `toastErrorPersistent` (row 136: a failure nothing else caught
 * must not blink away) and `toastInfoPersistent` (row 280: the clean-cut report
 * must outlive the first-run wizard that opens on the same condition) — and
 * persistence is exactly THREE options working together: `duration: Infinity`,
 * `closeButton: true` (a persistent notice with no reachable closer is a
 * PERMANENT one, the row-136 defect) and, for the info arm, an `onDismiss`
 * acknowledgement hook. They now live in ONE private builder, `persistentNotice`.
 *
 * WHY THIS IS A SOURCE SCAN. The drift is invisible in behaviour and expensive
 * in consequence: the next writer adding a persistent notice copies the nearest
 * options object, and whichever option that copy drops is a SILENT regression in
 * a surface whose entire job is not to be missed — precisely how the row-136
 * defect was born (`duration: Infinity` with no `closeButton`). The generic
 * duplicate-body tripwire cannot see a copied three-key object literal (it is
 * far under the floor), and a behavioural pin can only cover the callers that
 * exist today.
 *
 * WHAT REDS IT, named so a reader knows: a second `duration: Infinity` or
 * `closeButton: true` anywhere under `src/` (a hand-written persistent notice
 * beside the seam), and a third caller of the builder that skips it. The walk
 * reads the TypeScript AST, so a docstring that NAMES the options — including
 * this one and `AppShell`'s — cannot red it.
 *
 * The file list is the ONE tree walk (`repoFiles`, docs/17 row 427).
 */
/** The ONE file allowed to spell a persistent notice's options. */
const TOAST_SEAM = 'src/lib/toast.ts';
/** The ONE builder both persistent entry points ride. */
const BUILDER = 'persistentNotice';

describe('one persistent-notice mechanism (SOURCE SCAN, docs/17 rows 136/280)', () => {
  it('spells the options that MAKE a notice persistent in exactly one place', () => {
    const files = repoFiles('src', ['.ts', '.tsx']);
    const infiniteDurationSites: string[] = [];
    const closeButtonSites: string[] = [];
    let builderCalls = 0;
    for (const filePath of files) {
      const source = ts.createSourceFile(
        filePath.slice('src/'.length),
        readFileSync(filePath, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      const nodes: ts.Node[] = [source];
      while (nodes.length > 0) {
        const node = nodes.pop();
        if (node === undefined) continue;
        if (ts.isPropertyAssignment(node)) {
          const key = node.name.getText(source);
          if (
            key === 'duration' &&
            ts.isIdentifier(node.initializer) &&
            node.initializer.text === 'Infinity'
          ) {
            infiniteDurationSites.push(
              `${filePath}:${String(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1)}`,
            );
          }
          if (key === 'closeButton' && node.initializer.kind === ts.SyntaxKind.TrueKeyword) {
            closeButtonSites.push(
              `${filePath}:${String(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1)}`,
            );
          }
        }
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === BUILDER &&
          filePath === TOAST_SEAM
        ) {
          builderCalls += 1;
        }
        // BLOCK BODY on purpose: `ts.forEachChild` STOPS when the callback
        // returns a truthy value, and `Array.push` returns the new length.
        ts.forEachChild(node, (child) => {
          nodes.push(child);
        });
      }
    }

    // A SECOND site is the copy that drifts; the message names every one.
    expect(infiniteDurationSites.map((site) => site.split(':')[0])).toEqual([TOAST_SEAM]);
    expect(closeButtonSites.map((site) => site.split(':')[0])).toEqual([TOAST_SEAM]);
    // …and both persistent entry points (error + info) really ride the builder,
    // so a third entry point cannot hand-write its own options beside them.
    expect(builderCalls).toBe(2);
    expect(readFileSync(join(process.cwd(), TOAST_SEAM), 'utf8')).toContain(
      'export function toastInfoPersistent',
    );
  });
});
