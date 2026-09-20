import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * THE one streaming-zip writer (docs/17 rows 265 and 276; docs/18 §2.1).
 *
 * Both zip producers in the app — the whole-database backup
 * (`lib/backup.buildBackup`) and the campaign export (`lib/exportImport.buildZip`)
 * — build their archive through `lib/zipStream.StreamingZip`, which owns the
 * fflate `Zip`/`ZipDeflate` construction, the 1 MiB push slices and the
 * MACROTASK yield. The defect class this pins is the one BOTH rows exist for:
 * fflate's `zipSync` deflates the whole payload in ONE synchronous call on the
 * main thread, so a large payload never hands the UI a turn and a tablet
 * watchdog can kill the tab.
 *
 * The pin is a SOURCE SCAN because the drift is invisible: a re-introduced
 * `zipSync` call, or a second streaming writer beside the seam, behaves
 * correctly on a small export and only shows up as a blocked tab on a real one.
 * The generic duplicate-body tripwire (`no-duplicate-implementations.test.ts`)
 * sees a COPIED push loop but cannot see a `zipSync` call, which is the shape a
 * future "make the export fast again" change would take.
 *
 * The scan reads the TypeScript AST (comments are trivia, so a docstring that
 * NAMES `zipSync` like this one cannot red it) and deliberately declares no
 * named helper: `tests/**` is itself under the duplicate-body tripwire, so a
 * ninth copy of the shared `sourceFiles`/`stripComments` pair would be a new
 * duplicate blessed by nothing.
 */
const SRC_DIR = join(process.cwd(), 'src');
/** The ONE file allowed to construct a zip stream. */
const SEAM_FILE = 'src/lib/zipStream.ts';
/** fflate's SYNCHRONOUS whole-payload deflate — the anti-pattern, called nowhere. */
const SYNC_ZIP_CALL = 'zipSync';
/** fflate's zip constructors/runners: the seam owns every one of them. */
const ZIP_CONSTRUCTORS: readonly string[] = [
  'Zip',
  'ZipDeflate',
  'AsyncZipDeflate',
  'ZipPassThrough',
];

describe('one streaming zip writer (SOURCE SCAN, docs/17 row 276)', () => {
  it('keeps zip construction in the seam and zipSync out of src/', () => {
    const files = readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.ts') || name.endsWith('.tsx'))
      .sort();
    const syncZipSites: string[] = [];
    const foreignConstructorSites: string[] = [];
    for (const name of files) {
      // `readdirSync` joins with the platform separator; the pins below are
      // spelled with forward slashes.
      const relativeName = name.split(/[\\/]/).join('/');
      const filePath = `src/${relativeName}`;
      const source = ts.createSourceFile(
        relativeName,
        readFileSync(join(SRC_DIR, name), 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      const nodes: ts.Node[] = [source];
      while (nodes.length > 0) {
        const node = nodes.pop();
        if (node === undefined) continue;
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === SYNC_ZIP_CALL
        ) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          syncZipSites.push(`${filePath}:${String(line)}`);
        }
        if (
          ts.isNewExpression(node) &&
          ts.isIdentifier(node.expression) &&
          ZIP_CONSTRUCTORS.includes(node.expression.text) &&
          filePath !== SEAM_FILE
        ) {
          foreignConstructorSites.push(`${filePath} (new ${node.expression.text})`);
        }
        nodes.push(...node.getChildren(source));
      }
    }
    // A site in either list is a SECOND zip builder: AGENTS rule 4 says the fix
    // is to route it through SEAM_FILE, never to keep the copy.
    expect(syncZipSites).toEqual([]);
    expect(foreignConstructorSites).toEqual([]);
  });
});
