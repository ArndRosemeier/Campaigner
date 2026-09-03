import { describe, expect, it } from 'vitest';

import { moduleSpineSchema } from '@/domain/module';
import { statBlockSchema } from '@/domain/statblock';
import { continuityReportSchema, npcDraftSchema } from '@/llm/schemas';

/**
 * Meaning-preserving schema tolerances (AGENTS rule 3 — validation stays,
 * only formatting variants that carry the same meaning are coerced): quoted
 * numbers, quoted booleans, capitalized enum values, and model-omitted
 * "does not apply" sections. Semantic requirements (identity fields, roster
 * shape, enum values themselves) stay strict.
 */

const STATBLOCK = {
  system: 'dnd5e',
  level: '3',
  size: 'Small',
  creatureType: 'humanoid (goblinoid)',
  speed: '30 ft.',
  saves: '',
  skills: '',
  senses: '',
  languages: 'Common, Goblin',
};

describe('statBlockSchema tolerances', () => {
  it('accepts quoted numeric stats (ac, hp, abilities)', () => {
    const statBlock = statBlockSchema.parse({
      ...STATBLOCK,
      ac: '14',
      hp: '22',
      abilities: { str: '8', dex: '16', con: '13', int: '14', wis: '10', cha: '12' },
    });
    expect(statBlock.ac).toBe(14);
    expect(statBlock.hp).toBe(22);
    expect(statBlock.abilities.str).toBe(8);
  });

  it('still rejects non-numeric stat strings and missing identity fields', () => {
    expect(() =>
      statBlockSchema.parse({ ...STATBLOCK, ac: '14 (plate)', hp: 22, abilities: { str: 8, dex: 16, con: 13, int: 14, wis: 10, cha: 12 } }),
    ).toThrow();
    expect(() =>
      statBlockSchema.parse({
        ...STATBLOCK,
        ac: 14,
        hp: 22,
        abilities: { str: 8, dex: 16, con: 13, int: 14, wis: 10, cha: 12 },
        creatureType: undefined,
      }),
    ).toThrow();
  });

  it('defaults the sections a model may omit when none applies', () => {
    const statBlock = statBlockSchema.parse({
      ...STATBLOCK,
      ac: 14,
      hp: 22,
      abilities: { str: 8, dex: 16, con: 13, int: 14, wis: 10, cha: 12 },
    });
    expect(statBlock.traits).toEqual([]);
    expect(statBlock.actions).toEqual([]);
    expect(statBlock.reactions).toEqual([]);
    expect(statBlock.legendary).toEqual([]);
    expect(statBlock.extras).toEqual({});
    expect(statBlock.acNote).toBe('');
    expect(statBlock.hpFormula).toBe('');
  });
});

describe('draft and report tolerances', () => {
  it('accepts quoted needsStatBlock values', () => {
    const draft = npcDraftSchema.parse({
      name: 'X',
      summary: 'S',
      body: 'B',
      appearance: 'A',
      personality: 'P',
      needsStatBlock: 'false',
    });
    expect(draft.needsStatBlock).toBe(false);
  });

  it('defaults an omitted issue list and artifact relation on a clean verdict', () => {
    const report = continuityReportSchema.parse({
      verdict: 'consistent',
      summary: 'No conflicts found.',
    });
    expect(report.issues).toEqual([]);
  });

  it('accepts capitalized verdict/severity wording', () => {
    const report = continuityReportSchema.parse({
      verdict: 'Issues_Found',
      summary: 'Conflicts.',
      issues: [{ severity: 'Major', message: 'Timeline clash.' }],
    });
    expect(report.verdict).toBe('issues_found');
    expect(report.issues[0]?.severity).toBe('major');
    expect(report.issues[0]?.relatedTo).toBe('');
  });

  it('still rejects verdict values outside the contract', () => {
    expect(() => continuityReportSchema.parse({ verdict: 'maybe', summary: 's' })).toThrow();
  });

  it('defaults an omitted themes list on the module spine (checkpoint-edited)', () => {
    const spine = moduleSpineSchema.parse({
      premise: 'The tide remembers.',
      partPlan: [{ title: 'The Drowned Bell', levelBand: '1–2' }],
    });
    expect(spine.themes).toEqual([]);
    expect(spine.partPlan[0]?.synopsis).toBe('');
    expect(spine.partPlan[0]?.levelUpTrigger).toBe('');
  });
});
