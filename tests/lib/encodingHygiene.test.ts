import { describe, expect, it } from 'vitest';

import {
  collectTextLeaves,
  debrisIssuesForFields,
  findEscapeDebris,
} from '@/lib/encodingHygiene';

/**
 * Escape-debris hygiene scanner (detection backstop for the UTF-8 contract):
 * clean prose passes, every debris shape flags, normal "?" / hex-looking
 * text never flags.
 */

describe('findEscapeDebris', () => {
  it('passes clean German prose with intact umlauts', () => {
    const prose =
      'Die Flussmündung bei Halmund: Äpfel, Öl und süße Grüße vom Hafen — der Wächter trägt eine weiße Mütze. Grüße aus Köln!';
    expect(findEscapeDebris(prose)).toEqual([]);
  });

  it('passes plain ASCII prose', () => {
    expect(findEscapeDebris('The harbor bell rings at midnight. Nothing to see here.')).toEqual([]);
    expect(findEscapeDebris('')).toEqual([]);
  });

  it('flags the observed ?xx debris shape (Flussm?fcndung)', () => {
    const hits = findEscapeDebris('Die Flussm?fcndung bei Halmund');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: 'question-hex', match: '?fc' });
    expect(hits[0]?.index).toBe('Die Flussm'.length);
  });

  it('flags every non-ASCII tail (?e4 ?f6 ?df ?c3 ?80 ?ab)', () => {
    for (const debris of ['?e4', '?f6', '?df', '?c3', '?80', '?ab', '?ff']) {
      const hits = findEscapeDebris(`prefix ${debris} suffix`);
      expect(hits.map((hit) => hit.match)).toEqual([debris]);
      expect(hits[0]?.kind).toBe('question-hex');
    }
  });

  it('flags literal \\uXXXX escapes in already-decoded text', () => {
    const hits = findEscapeDebris('Die Flussm\\u00fcndung bei Halmund');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: 'unicode-escape', match: '\\u00fc' });
  });

  it('flags uppercase-hex \\u escapes too', () => {
    expect(findEscapeDebris('caf\\u00E4 latte').map((hit) => hit.match)).toEqual(['\\u00E4']);
  });

  it('reports multiple hits in text order across both shapes', () => {
    const hits = findEscapeDebris('A?fc B\\u00e4 C?e4');
    expect(hits.map((hit) => hit.match)).toEqual(['?fc', '\\u00e4', '?e4']);
    expect(hits.map((hit) => hit.kind)).toEqual(['question-hex', 'unicode-escape', 'question-hex']);
  });

  it('does not flag "?" followed by non-hex or ASCII tails', () => {
    // "what? 42": the ? is not immediately followed by hex at all.
    expect(findEscapeDebris('what? 42')).toEqual([]);
    expect(findEscapeDebris('Really? No. Who? Why?')).toEqual([]);
    // ASCII tails (?41 = 'A', ?20 = space, ?7f) are ordinary prose, not debris.
    expect(findEscapeDebris('score?41 points')).toEqual([]);
    expect(findEscapeDebris('gap?20 here')).toEqual([]);
    expect(findEscapeDebris('mark?7f end')).toEqual([]);
    // Not hex, or not exactly two chars.
    expect(findEscapeDebris('huh?fg yes')).toEqual([]);
    expect(findEscapeDebris('huh?f yes')).toEqual([]);
  });

  it('requires exactly two hex chars — a third hex char disqualifies', () => {
    // "Huh?face it": ?fa is followed by 'c' (hex), so this is a word, not debris.
    expect(findEscapeDebris('Huh?face it')).toEqual([]);
    expect(findEscapeDebris('plot?fcc arc')).toEqual([]);
    // But ?fc before a non-hex char still flags.
    expect(findEscapeDebris('plot?fcn arc').map((hit) => hit.match)).toEqual(['?fc']);
  });

  it('does not flag a doubled backslash before uXXXX (authored escape discussion)', () => {
    expect(findEscapeDebris('write \\\\u00e4 to escape it')).toEqual([]);
  });

  it('does not flag short \\u sequences or bare backslashes', () => {
    expect(findEscapeDebris('the \\u12 tag')).toEqual([]);
    expect(findEscapeDebris('path \\users\\docs')).toEqual([]);
  });
});

describe('collectTextLeaves', () => {
  it('collects every string leaf with dotted paths', () => {
    const fields = collectTextLeaves(
      {
        name: 'Grix',
        body: 'She brews.',
        count: 3,
        tags: ['goblin', 'alchemist'],
        monsters: [{ name: 'Warg', notes: 'Snarls', treasure: '' }],
        nested: { deep: { text: 'down here' } },
        missing: null,
      },
      'draft',
    );
    expect(fields).toContainEqual({ field: 'draft.name', text: 'Grix' });
    expect(fields).toContainEqual({ field: 'draft.body', text: 'She brews.' });
    expect(fields).toContainEqual({ field: 'draft.tags[0]', text: 'goblin' });
    expect(fields).toContainEqual({ field: 'draft.monsters[0].notes', text: 'Snarls' });
    expect(fields).toContainEqual({ field: 'draft.nested.deep.text', text: 'down here' });
    expect(fields.find((field) => field.field === 'draft.count')).toBeUndefined();
  });

  it('yields [] for nullish input', () => {
    expect(collectTextLeaves(null, 'draft')).toEqual([]);
    expect(collectTextLeaves(undefined, 'draft')).toEqual([]);
  });
});

describe('debrisIssuesForFields', () => {
  it('names the field and the exact debris in each issue', () => {
    const issues = debrisIssuesForFields([
      { field: 'draft.body', text: 'Die Flussm?fcndung' },
      { field: 'draft.summary', text: 'Clean summary.' },
      { field: 'draft.monsters[0].notes', text: 'Snarls \\u00e4tzend' },
    ]);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toContain('draft.body');
    expect(issues[0]).toContain('"?fc"');
    expect(issues[1]).toContain('draft.monsters[0].notes');
    expect(issues[1]).toContain('"\\u00e4"');
  });

  it('returns [] when every field is clean', () => {
    expect(
      debrisIssuesForFields([{ field: 'draft.body', text: 'Die Flussmündung glitzert.' }]),
    ).toEqual([]);
  });
});
