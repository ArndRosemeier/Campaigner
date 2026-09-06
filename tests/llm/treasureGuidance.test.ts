import { describe, expect, it } from 'vitest';

import { roomKeyGuidanceFor, treasureGuidanceFor } from '@/llm/treasureGuidance';

/**
 * The per-system treasure-budget guidance (owner-ratified room-keys/treasure
 * arc). Licensing shape is binding: dnd5e carries Campaigner's OWN documented
 * approximation (the DMG is not licensable — no DMG text may be quoted or
 * restated); pf2e grounds amounts in the VERBATIM GM Core excerpts the
 * retrieve step surfaced (Paizo CUP, personal use) and forbids inventing
 * amounts without them.
 */
describe('treasureGuidanceFor', () => {
  it('teaches the shared treasure structure for every system', () => {
    const clause = treasureGuidanceFor('dnd5e');
    expect(clause).toContain('Treasure structure (owner-ratified)');
    expect(clause).toContain('"treasure" string: what ONE instance of that creature carries');
    expect(clause).toContain('Encounter-scoped');
    expect(clause).toContain('permanent/magic items come ONLY from the item pool');
  });

  it('dnd5e: ships the documented approximation and names the licensing constraint', () => {
    const clause = treasureGuidanceFor('dnd5e');
    expect(clause).toContain('Campaigner\'s own documented approximation');
    expect(clause).toContain('the DMG is not licensable');
    expect(clause).toContain('50 gp × the average encounter level');
  });

  it('pf2e: grounds budgets in verbatim GM Core excerpts and forbids invented numbers', () => {
    const clause = treasureGuidanceFor('pathfinder2e');
    expect(clause).toContain('GM Core treasure rules are the law');
    expect(clause).toContain('VERBATIM');
    expect(clause).toContain('do not invent amounts');
    // The dnd5e approximation must never leak into a pf2e prompt.
    expect(clause).not.toContain('documented approximation');
  });

  it('generic-d20 falls back to the documented dnd5e-style approximation', () => {
    const clause = treasureGuidanceFor('generic-d20');
    expect(clause).toContain('documented approximation');
  });
});

describe('roomKeyGuidanceFor', () => {
  it('teaches the per-room key contract, outdoor staging areas and the regeneration consequence', () => {
    const clause = roomKeyGuidanceFor();
    expect(clause).toContain('every room carries a "key"');
    expect(clause).toContain('"keyTreasure"');
    expect(clause).toContain('Outdoor encounters get room keys too');
    expect(clause).toContain('regenerate together with the map');
  });
});
