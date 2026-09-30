import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CODE, filesWith } from '../helpers/sourceCode';

/**
 * THE one `spells` ENTRY SHAPE (docs/17 rows 200 and 205, docs/18 §2.2). Row
 * 184 offered a caster the library through a vocabulary header and, in the SAME
 * prompt, handed the model a "COMPLETE schema" line that did not name the
 * `spells` field the header invited — one instruction written in two halves
 * that had drifted. Row 200 made the shape live ONCE; row 205 made it
 * PER-SYSTEM and moved it beside the strict request contract
 * (`llm/statBlockContract.spellEntryShape`), because a shape that is fixed
 * while the contract varies BY SYSTEM is the same drift one layer down (a PF2e
 * prompt whose strict schema demanded the dnd5e keys — the owner's eight loud
 * errors).
 *
 * The pin is a SOURCE SCAN because the drift it catches is invisible: a second
 * hand-written `spells` shape in a prompt string reads identically today and
 * diverges the day the entry shape changes. The needle is the JSON-quoted
 * spelling (`"castRank"`) that only a prompt/contract shape carries.
 */

const SCAFFOLDING = 'src/llm/promptScaffolding.ts';
const COMPOSER = 'src/llm/mobSpellPrompt.ts';
const CONTRACT = 'src/llm/statBlockContract.ts';
const ENGINE = 'src/llm/runEngine.ts';
/** The prompt's JSON spelling of the entry shape — a schema identifier is BARE. */
const SHAPE_NEEDLE = '"castRank"';

function read(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('one spells-shape composer (SOURCE SCAN, docs/17 rows 200/205)', () => {
  it('declares the per-system prompt entry shape in exactly one file', () => {
    // Non-vacuity: the walk must see the whole tree, or it proves nothing.
    expect(Object.keys(CODE).length).toBeGreaterThan(300);
    // Comments are skipped (`CODE`): the seam's own docstring NAMES the shapes it replaces.
    const owners = filesWith(SHAPE_NEEDLE);
    expect(owners).toEqual([CONTRACT]);
  });

  it('builds the vocabulary header AND the contract clause from the ONE shape', () => {
    const composer = read(COMPOSER);
    expect(composer).toMatch(/export function formatMobSpellSection\(/);
    expect(composer).toMatch(/export function formatMobSpellContractClause\(/);
    // Both halves render the builder's own per-system shape — the header
    // between the stable prefix/suffix pair, the clause directly.
    expect(composer.match(/spellEntryShape\(system\)/g) ?? []).toHaveLength(2);
    expect(composer).not.toContain(SHAPE_NEEDLE);
    // The composer declares no shape of its own.
    const scaffolding = CODE[SCAFFOLDING] ?? '';
    expect(scaffolding).not.toContain(SHAPE_NEEDLE);
    expect(scaffolding).toContain('MOB_SPELL_SECTION_PREFIX');
    expect(scaffolding).toContain('MOB_SPELL_SECTION_SUFFIX');
  });

  it('gates every half on the SAME corpus predicate, declared once', () => {
    const composer = read(COMPOSER);
    expect(composer.match(/function mobSpellVocabularyRenders\(/g) ?? []).toHaveLength(1);
    expect(composer).toMatch(/export function mobSpellVocabularyRenders\(/);
    // The section, the contract clause AND (docs/17 row 201) the caster clause
    // each read the one gate, so no half can render where another is withheld.
    expect(
      composer.match(/if \(!mobSpellVocabularyRenders\(vocabulary\)\) return null;/g) ?? [],
    ).toHaveLength(3);
  });

  it('the caster clause is declared once and reaches BOTH NPC steps (docs/17 row 201)', () => {
    const scaffolding = read(SCAFFOLDING);
    expect(scaffolding.match(/export const MOB_SPELL_CASTER_CLAUSE =/g) ?? []).toHaveLength(1);
    // No call site re-spells the clause: the literal the model reads is the
    // composer's own constant, so it cannot drift from the pinned bytes.
    const engine = CODE[ENGINE] ?? '';
    expect(engine).not.toContain('Caster awareness');
    // The NPC DRAFT (identity/prose) and the NPC STAT-BLOCK step (spells/DC)
    // are the ONLY two call sites; the encounter draft and the Cartographer
    // keep their optional invitation and never call it.
    expect(engine.match(/formatMobSpellCasterClause\(/g) ?? []).toHaveLength(2);
  });

  it('never hand-writes the spells clause or shape at a call site', () => {
    const engine = read(ENGINE);
    // The clause composer is imported (the sole surface of that name) and the
    // engine never builds the shape itself.
    expect(engine).toContain('formatMobSpellContractClause');
    expect(engine).not.toContain('"spells": [');
    expect(engine).not.toContain(SHAPE_NEEDLE);
    // The REQUEST schema is built only by the ONE builder (docs/17 row 205).
    expect(engine).not.toMatch(/schemaResponseFormat\(\s*'statblock'/);
    expect(engine).not.toMatch(/z\.object\(\{\s*system:\s*gameSystemSchema/);
  });

  it('the dead 300-line window and its truncation note are GONE (docs/17 row 211)', () => {
    // A dead limit is how the rank-ordered-prefix defect comes back: the
    // vocabulary is now a per-group sample with no cap, so neither the constant
    // nor the note it fed may survive anywhere in `src/` (the behavioural half
    // lives in tests/domain/mobSpells.test.ts).
    const dead = [
      'MOB_SPELL_VOCABULARY_LIMIT',
      'MOB_SPELL_TRUNCATION_PREFIX',
      'MOB_SPELL_TRUNCATION_SUFFIX',
      'the list is TRUNCATED',
    ];
    for (const [file, text] of Object.entries(CODE)) {
      for (const needle of dead) {
        expect(text, `${file} still carries ${needle}`).not.toContain(needle);
      }
    }
  });
});
