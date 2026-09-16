import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * THE one chunk-type read (docs/17 row 182, docs/18 §2.1). Replacing the
 * hand-spelled `db.chunks.where('chunkType')…` at its two former call sites
 * (`db/creatureRepo.listLibraryCreatures`, `app/use-library-creatures`) with
 * `chunkRepo.listChunksByType` is worth nothing if a fourth caller re-spells
 * the query, so this SOURCE SCAN reds on a second one. Caller-side filtering
 * and sorting are fine — a second Dexie QUERY is not.
 *
 * The scan is deliberately textual: the shape it forbids has no behavioural
 * signature (all three spellings were correct), which is exactly why
 * AGENTS' centralization rule asks for a pin rather than discipline.
 */

const SRC_DIR = join(process.cwd(), 'src');
const SEAM = 'src/db/chunkRepo.ts';
const NEEDLE = "where('chunkType')";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full);
  }
  return out.sort();
}

/** Comments are skipped: the scan is about CODE, and this seam's own docstring
 *  names the shape it replaces (`where('chunkType')`) while explaining it. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('one chunk-type read (SOURCE SCAN, docs/17 row 182)', () => {
  it('spells the chunkType query exactly once, inside chunkRepo', () => {
    const files = sourceFiles(SRC_DIR);
    // Non-vacuity: the walk must see the whole tree, or it proves nothing.
    expect(files.length).toBeGreaterThan(300);
    expect(files).toContain(join(SRC_DIR, 'db', 'chunkRepo.ts'));

    const offenders: string[] = [];
    let seamHits = 0;
    for (const file of files) {
      const rel = relative(process.cwd(), file);
      const text = stripComments(readFileSync(file, 'utf8'));
      const hits = text.split(NEEDLE).length - 1;
      if (hits === 0) continue;
      if (rel === SEAM) {
        seamHits += hits;
        continue;
      }
      offenders.push(`${rel} (${String(hits)})`);
    }
    expect(offenders).toEqual([]);
    expect(seamHits).toBe(1);
  });

  it('folds the two former statblock call sites onto the seam', () => {
    const creatureRepo = readFileSync(join(SRC_DIR, 'db', 'creatureRepo.ts'), 'utf8');
    const libraryCreatures = readFileSync(join(SRC_DIR, 'app', 'use-library-creatures.ts'), 'utf8');
    expect(creatureRepo).toContain("listChunksByType('statblock')");
    expect(libraryCreatures).toContain("listChunksByType('statblock')");
  });
});
