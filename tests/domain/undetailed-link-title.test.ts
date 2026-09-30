import { describe, expect, it } from 'vitest';

import { entityRecordFor, undetailedLinkTitle, type ModuleEntityKind } from '@/domain';
import { CODE, filesWith } from '../helpers/sourceCode';

/**
 * The hover of a link with no artifact yet states what the module ALREADY
 * records for the name (docs/17 row 417, owner: "I would also like to see the
 * link type and any other info that is ALREADY available for this link").
 */

const KAEL: ModuleEntityKind = {
  name: 'Kael',
  kind: 'npc',
  absorbed: ['Kael the Grey'],
  levelHint: 3,
  intent: 'the gatekeeper who betrays the party',
  bestiary: { creature: 'Bandit Captain', book: 'Monster Core' },
};

describe('undetailedLinkTitle', () => {
  it('names every recorded fact: kind, level, intent, cast creature, variants', () => {
    expect(undetailedLinkTitle('Kael', [KAEL])).toBe(
      [
        'Kael — not detailed yet',
        'Kind: NPC',
        'Level: 3',
        'Intent: the gatekeeper who betrays the party',
        'Stats from: Bandit Captain (Monster Core)',
        'Also written as: Kael the Grey',
      ].join('\n'),
    );
  });

  it('matches through the one alias comparison (case and spacing do not matter)', () => {
    expect(undetailedLinkTitle('  kael ', [KAEL])).toContain('Kind: NPC');
  });

  it('states only what is recorded: a bare record gives the kind alone', () => {
    const keep: ModuleEntityKind = { name: 'Old Keep', kind: 'location', absorbed: [] };
    expect(undetailedLinkTitle('Old Keep', [keep])).toBe('Old Keep — not detailed yet\nKind: Location');
  });

  it('says honestly that no kind is recorded yet when the module has no record', () => {
    expect(undetailedLinkTitle('Nobody', [KAEL])).toBe(
      'Nobody — not detailed yet\nKind: not recorded yet — Generate details classifies it',
    );
  });

  it('claims nothing about kinds on a surface that does not know the records', () => {
    expect(undetailedLinkTitle('Kael', undefined)).toBe('Kael — not detailed yet');
  });
});

describe('one record lookup, one hover text (AGENTS rule 4)', () => {
  it('entityRecordFor finds the record the per-field reads use', () => {
    expect(entityRecordFor([KAEL], 'KAEL')).toBe(KAEL);
    expect(entityRecordFor([KAEL], '   ')).toBeUndefined();
  });

  it('the name→record search is written once in src/', () => {
    const searches = filesWith('entityKinds.find((entry) => sameAliasName(entry.name, name))');
    expect(searches).toEqual(['src/domain/module.ts']);
    expect(CODE['src/domain/module.ts']?.split('entityKinds.find((entry) => sameAliasName(entry.name, name))').length).toBe(2);
  });

  it('the "not detailed yet" hover is composed only by undetailedLinkTitle', () => {
    expect(filesWith('— not detailed yet`')).toEqual(['src/domain/undetailedLinkTitle.ts']);
  });
});
