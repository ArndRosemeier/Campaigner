import { describe, expect, it } from 'vitest';

import { parseStatBlock } from '@/ingest/statblock';

const fiveE = [
  'Large giant, neutral',
  'Armor Class 14 (natural armor)',
  'Hit Points 126 (12d10 + 60)',
  'Speed 40 ft.',
  'STR 23 DEX 8 CON 21 INT 5 WIS 9 CHA 6',
  'Saving Throws CON +9, WIS +3',
  'Challenge 7 (2900 XP)',
].join('\n');

/** A block stating every REQUIRED number, and no optional one. */
const COMPLETE_MINIMAL = [
  'Armor Class 15',
  'Hit Points 33',
  'STR 12 DEX 14 CON 10 INT 8 WIS 11 CHA 9',
].join('\n');

describe('parseStatBlock', () => {
  it('parses a 5e-style stat block', () => {
    const block = parseStatBlock(fiveE, 'dnd5e');
    expect(block).not.toBeNull();
    expect(block?.system).toBe('dnd5e');
    expect(block?.ac).toBe(14);
    expect(block?.acNote).toBe('natural armor');
    expect(block?.hp).toBe(126);
    expect(block?.hpFormula).toBe('12d10 + 60');
    expect(block?.speed).toBe('40 ft.');
    expect(block?.abilities).toEqual({ str: 23, dex: 8, con: 21, int: 5, wis: 9, cha: 6 });
    expect(block?.extras.CR).toBe('7');
  });

  it('reads a COMPLETE block into the exact same shape as before (docs/17 row 290)', () => {
    // The refusal must not touch a complete read: every field, byte for byte.
    expect(parseStatBlock(fiveE, 'dnd5e')).toEqual({
      system: 'dnd5e',
      level: '',
      size: '',
      creatureType: '',
      ac: 14,
      acNote: 'natural armor',
      hp: 126,
      hpFormula: '12d10 + 60',
      speed: '40 ft.',
      abilities: { str: 23, dex: 8, con: 21, int: 5, wis: 9, cha: 6 },
      saves: '',
      skills: '',
      senses: '',
      languages: '',
      traits: [],
      actions: [],
      reactions: [],
      legendary: [],
      extras: { CR: '7' },
    });
  });

  it('returns null for prose without stat-block structure', () => {
    expect(
      parseStatBlock(
        'The merchant sells rope, torches and rations at fair prices. He haggles.',
        'dnd5e',
      ),
    ).toBeNull();
  });

  it('REFUSES a block with no ability line instead of filling six 10s (docs/17 row 290)', () => {
    // The defect this pin replaces: `abilities.str ?? 10` (and its five
    // siblings) persisted an entirely invented STR–CHA array on AC+HP+speed
    // alone. A refused span is prose; `null` says so.
    expect(
      parseStatBlock('AC 15\nHP 33\nSpeed 30 ft.\nSome unmatched flavor line.', 'generic-d20'),
    ).toBeNull();
  });

  it('REFUSES a block that states only SOME abilities', () => {
    expect(
      parseStatBlock('AC 15\nHP 33\nSTR 12 DEX 14 CON 10 INT 8 WIS 11', 'generic-d20'),
    ).toBeNull();
  });

  it('REFUSES a block with no AC, and one with no HP (no `?? 10`, no `?? 1`)', () => {
    const abilities = 'STR 12 DEX 14 CON 10 INT 8 WIS 11 CHA 9';
    expect(parseStatBlock(`Hit Points 33\nSpeed 30 ft.\n${abilities}`, 'generic-d20')).toBeNull();
    expect(parseStatBlock(`Armor Class 15\nSpeed 30 ft.\n${abilities}`, 'generic-d20')).toBeNull();
  });

  it('keeps speed, CR and level OPTIONAL — a complete block without them still parses', () => {
    const block = parseStatBlock(COMPLETE_MINIMAL, 'generic-d20');
    expect(block).not.toBeNull();
    expect(block?.ac).toBe(15);
    expect(block?.hp).toBe(33);
    expect(block?.speed).toBe('');
    expect(block?.level).toBe('');
    expect(block?.extras).toEqual({});
    expect(block?.abilities).toEqual({ str: 12, dex: 14, con: 10, int: 8, wis: 11, cha: 9 });
  });
});
