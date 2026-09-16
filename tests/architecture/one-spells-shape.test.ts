import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * THE one `spells` ENTRY SHAPE (docs/17 row 200, docs/18 §2.4). Row 184 offered
 * a caster the library through a vocabulary header and, in the SAME prompt,
 * handed the model a "COMPLETE schema" line that did not name the `spells`
 * field the header invited — one instruction written in two halves that had
 * drifted. The shape now lives ONCE in `llm/promptScaffolding`
 * (`MOB_SPELL_ENTRY_SHAPE`), the vocabulary header and the reply-contract
 * clause both render it through `llm/mobSpellPrompt`, and both halves read the
 * SAME corpus gate.
 *
 * The pin is a SOURCE SCAN because the drift it catches is invisible: a second
 * hand-written `spells` shape in a prompt string reads identically today and
 * diverges the day the entry shape changes. The needle is the JSON-quoted
 * spelling (`"castRank"`) that only a prompt shape carries.
 */

const SRC_DIR = join(process.cwd(), 'src');
const SCAFFOLDING = 'src/llm/promptScaffolding.ts';
const COMPOSER = 'src/llm/mobSpellPrompt.ts';
const ENGINE = 'src/llm/runEngine.ts';
/** The prompt's JSON spelling of the entry shape — a schema identifier is BARE. */
const SHAPE_NEEDLE = '"castRank"';

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full);
  }
  return out.sort();
}

function rel(full: string): string {
  return relative(process.cwd(), full).split(sep).join('/');
}

function read(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

/** Comments are skipped: the seam's own docstring NAMES the shapes it replaces. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('one spells-shape composer (SOURCE SCAN, docs/17 row 200)', () => {
  it('declares the prompt entry shape in exactly one file', () => {
    const files = sourceFiles(SRC_DIR);
    // Non-vacuity: the walk must see the whole tree, or it proves nothing.
    expect(files.length).toBeGreaterThan(300);
    const owners = files
      .filter((file) => stripComments(readFileSync(file, 'utf8')).includes(SHAPE_NEEDLE))
      .map(rel);
    expect(owners).toEqual([SCAFFOLDING]);
  });

  it('builds the vocabulary header AND the contract clause from the ONE shape', () => {
    const scaffolding = read(SCAFFOLDING);
    expect(scaffolding).toMatch(/export const MOB_SPELL_ENTRY_SHAPE =/);
    expect(scaffolding).toContain('${MOB_SPELL_ENTRY_SHAPE}');

    const composer = read(COMPOSER);
    expect(composer).toMatch(/export function formatMobSpellSection\(/);
    expect(composer).toMatch(/export function formatMobSpellContractClause\(/);
    expect(composer).toContain('MOB_SPELL_ENTRY_SHAPE');
  });

  it('gates both halves on the SAME corpus predicate, declared once', () => {
    const composer = read(COMPOSER);
    expect(composer.match(/function mobSpellVocabularyRenders\(/g) ?? []).toHaveLength(1);
    // The section AND the contract clause each read the one gate.
    expect(
      composer.match(/if \(!mobSpellVocabularyRenders\(vocabulary\)\) return null;/g) ?? [],
    ).toHaveLength(2);
  });

  it('never hand-writes the spells clause or shape at a call site', () => {
    const engine = read(ENGINE);
    expect(engine).toMatch(
      /import \{[^}]*\bformatMobSpellContractClause\b[^}]*\} from '@\/llm\/mobSpellPrompt'/,
    );
    expect(engine).not.toContain('"spells":');
    expect(engine).not.toContain(SHAPE_NEEDLE);
  });
});
