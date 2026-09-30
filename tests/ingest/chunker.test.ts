import { describe, expect, it } from 'vitest';

import { chunkLines } from '@/ingest/chunker';
import { line } from './fixtures';

const body = (...texts: string[]) => texts.flatMap((text) => line(text));

describe('chunkLines', () => {
  it('tracks the heading path stack and flushes sections at headings', () => {
    const chunks = chunkLines([
      ...line('Chapter 9: Combat', { headingLevel: 1, page: 10 }),
      ...line('Combat unfolds in rounds.', { page: 10 }),
      ...line('Each round is six seconds.', { page: 10 }),
      ...line('Grappling', { headingLevel: 2, page: 11 }),
      ...line('A grapple begins with an attack.', { page: 11 }),
      ...line('Escaping uses Athletics checks.', { page: 11 }),
    ]);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.chunkType).toBe('section');
    expect(chunks[0]?.headingPath).toEqual(['Chapter 9: Combat']);
    expect(chunks[0]?.pageStart).toBe(10);
    expect(chunks[0]?.pageEnd).toBe(10);
    expect(chunks[0]?.text).toContain('rounds.');
    expect(chunks[1]?.headingPath).toEqual(['Chapter 9: Combat', 'Grappling']);
    expect(chunks[1]?.pageStart).toBe(11);
    expect(chunks[1]?.pageEnd).toBe(11);
  });

  it('discards section chunks below 40 chars', () => {
    const chunks = chunkLines([...line('Chapter', { headingLevel: 1 }), ...body('Too short.')]);
    expect(chunks).toHaveLength(0);
  });

  it('splits overflowing sections at sentence boundaries with the same path', () => {
    const filler = 'The adventurer paused at the crossroads and weighed every option with care. ';
    const chunks = chunkLines([...line('Travel', { headingLevel: 1 }), ...body(filler.repeat(40))]);

    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((chunk) => {
      expect(chunk.headingPath).toEqual(['Travel']);
      expect(chunk.chunkType).toBe('section');
    });
    expect(chunks.map((chunk) => chunk.text).join(' ')).toContain('crossroads');
  });

  it('keeps lines and text in sync when the sentence boundary falls mid-line (no ±Infinity pages)', () => {
    // The boundary lands inside the second line; the tail after the cut is
    // long enough to become its own chunk. The old mid-line cut desynced
    // section.lines from section.text and produced pageStart/pageEnd of
    // Infinity/-Infinity, which ruleChunkSchema rejects.
    const head = 'Kurzer Einstieg. ';
    const tailSentences =
      'Der Abenteurer wandert weiter durch das Tal und beachtet jede Wegmarkierung. '.repeat(40);
    const chunks = chunkLines([
      ...line('Reisen', { headingLevel: 1 }),
      ...line(head),
      ...line(head + tailSentences),
    ]);

    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((chunk) => {
      expect(Number.isFinite(chunk.pageStart)).toBe(true);
      expect(Number.isFinite(chunk.pageEnd)).toBe(true);
      expect(chunk.pageStart).toBeGreaterThanOrEqual(1);
      expect(chunk.pageEnd).toBeGreaterThanOrEqual(chunk.pageStart);
    });
    expect(chunks.map((chunk) => chunk.text).join(' ')).toContain('Wegmarkierung');
  });

  it('strips lines repeated on most pages (headers/footers)', () => {
    const lines = [1, 2, 3, 4].flatMap((page) => [
      ...line('CHAPTER ONE', { page }),
      ...line('Unique body text for the page '.concat(String(page), ' continues at length here.'), {
        page,
      }),
    ]);
    const chunks = chunkLines(lines);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).not.toContain('CHAPTER ONE');
  });

  it('detects a 5e-style stat block and parses AC/HP/abilities', () => {
    const chunks = chunkLines([
      ...line('Goblin Boss', { headingLevel: 1, page: 3 }),
      ...body('Armor Class 17 (chain shirt)'),
      ...body('Hit Points 66 (12d6 + 22)'),
      ...body('Speed 30 ft.'),
      ...body('STR 14 DEX 14 CON 14 INT 10 WIS 10 CHA 12'),
      ...body('Challenge 2 (450 XP)'),
    ]);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.chunkType).toBe('statblock');
    expect(chunks[0]?.headingPath).toEqual(['Goblin Boss']);
    expect(chunks[0]?.statBlock).not.toBeNull();
    expect(chunks[0]?.statBlock?.ac).toBe(17);
    expect(chunks[0]?.statBlock?.acNote).toBe('chain shirt');
    expect(chunks[0]?.statBlock?.hp).toBe(66);
    expect(chunks[0]?.statBlock?.hpFormula).toBe('12d6 + 22');
    expect(chunks[0]?.statBlock?.speed).toBe('30 ft.');
    expect(chunks[0]?.statBlock?.abilities.str).toBe(14);
    expect(chunks[0]?.statBlock?.abilities.int).toBe(10);
    expect(chunks[0]?.statBlock?.extras.CR).toBe('2');
  });

  it('mints NO statblock chunk for a span the source did not complete (docs/17 row 290)', () => {
    // ≥3 anchors still detect the span, but no ability line is stated, so the
    // old shape persisted six invented 10s. The refusal keeps the text as
    // prose and mints no statblock chunk at all.
    const chunks = chunkLines([
      ...line('Goblin Boss', { headingLevel: 1, page: 3 }),
      ...body('Armor Class 15'),
      ...body('Hit Points 33'),
      ...body('Speed 30 ft.'),
      ...body('This creature states no ability scores at all.'),
    ]);

    expect(chunks.some((chunk) => chunk.chunkType === 'statblock')).toBe(false);
    const prose = chunks.filter((chunk) => chunk.chunkType === 'section');
    const text = prose.map((chunk) => chunk.text).join('\n');
    expect(text).toContain('Armor Class 15');
    expect(text).toContain('This creature states no ability scores at all.');
    prose.forEach((chunk) => {
      expect(chunk.headingPath).toEqual(['Goblin Boss']);
      expect(Number.isFinite(chunk.pageStart)).toBe(true);
    });
  });

  it('keeps a refused span INSIDE the surrounding prose chunk, not in a chunk of its own', () => {
    const chunks = chunkLines([
      ...line('Goblin Camp', { headingLevel: 1, page: 3 }),
      ...body('The camp holds a battered goblin and its pet.'),
      ...body('Armor Class 15'),
      ...body('Hit Points 33'),
      ...body('Speed 30 ft.'),
      ...body('The creature guards the cooking fire.'),
    ]);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.chunkType).toBe('section');
    expect(chunks[0]?.text).toContain('battered goblin');
    expect(chunks[0]?.text).toContain('Armor Class 15');
    expect(chunks[0]?.text).toContain('cooking fire');
  });

  it('walks PAST a refused span and still reads a later complete block', () => {
    const chunks = chunkLines([
      ...line('Bestiary', { headingLevel: 1 }),
      ...body('Armor Class 9'),
      ...body('Hit Points 2'),
      ...body('Speed 10 ft.'),
      ...body('This one states no ability scores at all.'),
      ...line('Second Creature', { headingLevel: 2 }),
      ...body('Armor Class 13'),
      ...body('Hit Points 22'),
      ...body('STR 10 DEX 12 CON 11 INT 9 WIS 10 CHA 8'),
    ]);

    const statblocks = chunks.filter((chunk) => chunk.chunkType === 'statblock');
    expect(statblocks).toHaveLength(1);
    expect(statblocks[0]?.statBlock?.ac).toBe(13);
    expect(statblocks[0]?.headingPath).toEqual(['Bestiary', 'Second Creature']);
    expect(chunks.map((chunk) => chunk.text).join('\n')).toContain(
      'states no ability scores at all',
    );
  });

  it('emits a table chunk when 3+ consecutive lines have 3+ cells each', () => {
    const chunks = chunkLines([
      ...line('Encounter table', { headingLevel: 1 }),
      ...line('d10 | Result | XP', { cells: ['d10', 'Result', 'XP'] }),
      ...line('1 | Bandits | 50', { cells: ['1', 'Bandits', '50'] }),
      ...line('2 | Wolves | 75', { cells: ['2', 'Wolves', '75'] }),
      ...line('Prose resumes here with a single long line to become a section.'),
    ]);

    expect(chunks[0]?.chunkType).toBe('table');
    expect(chunks[0]?.text).toBe('d10 | Result | XP\n1 | Bandits | 50\n2 | Wolves | 75');
  });
});
