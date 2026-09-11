import { describe, expect, it } from 'vitest';

import type { RuleChunk, Rulebook, StatBlock } from '@/domain';
import { ruleChunkSchema, statBlockSchema, stampNewEntity } from '@/domain';
import { buildBestiaryRows, filterRosterRows } from '@/features/bestiary/roster';
import { parseLevelSort } from '@/llm/encounterRoster';

/**
 * Bestiary roster rows (source-viewers arc): level ordering over the
 * pack-exact + PDF-best-effort level formats, loud per-row data errors for
 * pack-chunk invariant violations (the viewer variant of collectPackRoster's
 * throw), origin labels identical to encounterResolve's rulebook branch,
 * and a filter that never hides data errors.
 */

const PDF_ID = '11111111-1111-4111-8111-111111111111';
const PACK_ID = '22222222-2222-4222-8222-222222222222';

function statBlock(over: Partial<StatBlock> = {}): StatBlock {
  return statBlockSchema.parse({
    system: 'dnd5e',
    level: '3',
    size: 'Large',
    creatureType: 'giant',
    ac: 15,
    acNote: '',
    hp: 84,
    hpFormula: '7d10+21',
    speed: '40 ft.',
    abilities: { str: 18, dex: 10, con: 16, int: 6, wis: 10, cha: 8 },
    saves: '',
    skills: '',
    senses: '',
    languages: '',
    ...over,
  });
}

let seq = 0;
function chunk(over: Partial<RuleChunk> & { bookId: string; headingPath: string[] }): RuleChunk {
  seq += 1;
  const text = over.text ?? `${String(seq)} stat block text`;
  // Schema-valid 64-hex digest stand-in (uniqueness only; no crypto needed).
  const contentHash = 'a'.repeat(63) + String(seq % 10);
  return ruleChunkSchema.parse({
    ...stampNewEntity(),
    pageStart: 10,
    pageEnd: 10,
    chunkType: 'statblock',
    text,
    statBlock: statBlock(),
    contentHash,
    ...over,
  });
}

function pdfBook(): Rulebook {
  return {
    id: PDF_ID,
    createdAt: 1,
    updatedAt: 1,
    title: 'Core Rules',
    system: 'dnd5e',
    status: 'ready',
    origin: 'pdf',
    filename: 'core.pdf',
    pageCount: 100,
    errorMessage: '',
    packMeta: null,
  };
}

function packBook(): Rulebook {
  return {
    id: PACK_ID,
    createdAt: 1,
    updatedAt: 1,
    title: 'SRD Pack',
    system: 'dnd5e',
    status: 'ready',
    origin: 'pack',
    filename: 'pack.json',
    pageCount: 0,
    errorMessage: '',
    packMeta: {
      sourceId: 'foundry-dnd5e-srd',
      license: 'CC-BY-4.0',
      entriesImported: 1,
      entriesSkipped: 0,
      entriesFailed: 0,
    },
  };
}

describe('buildBestiaryRows', () => {
  it('orders entries by level then name, across fraction levels and "—"', () => {
    const rows = buildBestiaryRows([pdfBook()], [
      chunk({ bookId: PDF_ID, headingPath: ['Zeta'], statBlock: statBlock({ level: '10' }) }),
      chunk({ bookId: PDF_ID, headingPath: ['Alpha'], statBlock: statBlock({ level: '1/2' }) }),
      chunk({ bookId: PDF_ID, headingPath: ['Mid'], statBlock: statBlock({ level: '3' }) }),
      chunk({ bookId: PDF_ID, headingPath: ['Nameless Horror'], statBlock: statBlock({ level: '—' }) }),
      chunk({ bookId: PDF_ID, headingPath: ['Beta'], statBlock: statBlock({ level: '1' }) }),
    ]);
    expect(rows.map((row) => (row.kind === 'entry' ? row.name : row.message))).toEqual([
      'Alpha', // 1/2 = 0.5
      'Beta', // 1
      'Mid', // 3
      'Zeta', // 10
      'Nameless Horror', // '—' → last
    ]);
  });

  it('labels origins like encounterResolve: "<book>: <creature>" for packs, "<book> p.N" for PDFs', () => {
    const rows = buildBestiaryRows([pdfBook(), packBook()], [
      chunk({ bookId: PDF_ID, headingPath: ['Troll'] }),
      chunk({ bookId: PACK_ID, headingPath: ['Goblin'], pageStart: 1 }),
    ]);
    const origins = rows.filter((row) => row.kind === 'entry').map((row) => row.origin);
    expect(origins).toContain('Core Rules p.10');
    expect(origins).toContain('SRD Pack: Goblin');
  });

  it('marks a pack chunk with a null stat block as a loud data error; a PDF one is simply not a creature', () => {
    const rows = buildBestiaryRows([pdfBook(), packBook()], [
      chunk({ bookId: PACK_ID, headingPath: ['Broken'], statBlock: null }),
      chunk({ bookId: PDF_ID, headingPath: ['Vague'], statBlock: null }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'data-error',
      message: /has no validated stat block — re-import the pack/,
    });
  });

  it('marks a pack chunk without a creature name and one with an unparseable level as data errors', () => {
    const rows = buildBestiaryRows([packBook()], [
      chunk({ bookId: PACK_ID, headingPath: ['   '] }),
      chunk({ bookId: PACK_ID, headingPath: ['Weird'], statBlock: statBlock({ level: 'legendary' }) }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.kind === 'data-error')).toBe(true);
    const messages = rows.map((row) => (row.kind === 'data-error' ? row.message : ''));
    expect(messages[0]).toMatch(/no creature name in its heading/);
    expect(messages[1]).toMatch(/cannot order creatures by level "legendary"/);
  });

  it('keeps a PDF chunk with an unparseable level as an entry sorted last, not an error', () => {
    const rows = buildBestiaryRows([pdfBook()], [
      chunk({ bookId: PDF_ID, headingPath: ['Odd'], statBlock: statBlock({ level: 'legendary' }) }),
      chunk({ bookId: PDF_ID, headingPath: ['Plain'], statBlock: statBlock({ level: '2' }) }),
    ]);
    expect(rows).toHaveLength(2);
    const names = rows.map((row) => (row.kind === 'entry' ? row.name : 'ERR'));
    expect(names).toEqual(['Plain', 'Odd']); // Odd sorts last (best-effort ∞)
  });

  /**
   * The user-visible damage a PERSISTED junk level does (owner report,
   * docs/17 row 90): a pack chunk is guaranteed an exact printed level, so one
   * that cannot be parsed is a loud data-error row — the creature vanishes from
   * the roster behind an error. That is why the value is refused at the
   * encounter boundary instead of being allowed to become durable.
   *
   * This is the damage pin, not the fix pin: the fix is
   * `statBlockLevelIssues` in the run engine (`tests/llm/encounterRun.test.ts`)
   * plus the materialize guard. Revert-proof here: it fails only if the parser
   * starts accepting these values (which would retire the data-error row the
   * viewer shows).
   */
  it('never lets a junk level slip past the one level parser (the damage a persisted row causes)', () => {
    for (const junk of ['sourceName', '', 'CR 5', 'level 3', '3 (elite)']) {
      expect(() => parseLevelSort(junk)).toThrow();
    }
    // The acceptance set: what the parser DOES accept is what the boundary
    // contract allows — a number, a fraction, "—".
    expect(parseLevelSort('3')).toBe(3);
    expect(parseLevelSort('-1')).toBe(-1);
    expect(parseLevelSort('1/2')).toBe(0.5);
    expect(parseLevelSort('—')).toBe(Number.POSITIVE_INFINITY);

    // A junk level on a PACK chunk surfaces as the loud data error (the
    // creature is not silently mis-ordered).
    const rows = buildBestiaryRows([packBook()], [
      chunk({ bookId: PACK_ID, headingPath: ['Risen Lumberjack'], statBlock: statBlock({ level: 'sourceName' }) }),
    ]);
    expect(rows[0]).toMatchObject({
      kind: 'data-error',
      message: /cannot order creatures by level "sourceName"/,
    });
  });
});

describe('filterRosterRows', () => {
  it('filters entries by name substring but never hides data errors', () => {
    const rows = buildBestiaryRows([pdfBook(), packBook()], [
      chunk({ bookId: PACK_ID, headingPath: ['Broken'], statBlock: null }),
      chunk({ bookId: PDF_ID, headingPath: ['Goblin'] }),
      chunk({ bookId: PDF_ID, headingPath: ['Troll'] }),
    ]);
    const filtered = filterRosterRows(rows, 'gob');
    expect(filtered.filter((row) => row.kind === 'entry').map((row) => row.name)).toEqual(['Goblin']);
    expect(filtered.filter((row) => row.kind === 'data-error')).toHaveLength(1);
    expect(filterRosterRows(rows, '  ')).toHaveLength(3);
  });
});
