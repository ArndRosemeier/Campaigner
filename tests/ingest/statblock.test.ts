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

  it('returns null for prose without stat-block structure', () => {
    expect(
      parseStatBlock(
        'The merchant sells rope, torches and rations at fair prices. He haggles.',
        'dnd5e',
      ),
    ).toBeNull();
  });

  it('treats unmatched content as blanks and keeps the text in the chunk', () => {
    const block = parseStatBlock(
      'AC 15\nHP 33\nSpeed 30 ft.\nSome unmatched flavor line.',
      'generic-d20',
    );
    expect(block).not.toBeNull();
    expect(block?.abilities.str).toBe(10);
    expect(block?.traits).toEqual([]);
  });
});
