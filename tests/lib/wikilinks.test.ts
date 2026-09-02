import { describe, expect, it } from 'vitest';

import { anyArtifactSchema, type AnyArtifact, type Artifact } from '@/domain';
import {
  countOccurrences,
  extractWikiLinks,
  resolveWikiLink,
  rewriteWikiLinkTargets,
  sentenceAround,
  stripWikiLinks,
  surroundingParagraphs,
  wikiLinkNames,
} from '@/lib/wikilinks';

/**
 * Pure wiki-link syntax & resolution (08-MODULE-DESIGNER M4-A). Fixtures are
 * minimal `note` artifacts — the only kind whose `data` payload is empty —
 * so resolution tests need no kind-specific structured data. `Id` is a UUID
 * string and timestamps are plain epoch-millisecond numbers (entity.ts).
 */

let fixtureSeq = 0;

/** Builds a valid `note` artifact; unique ids keep ambiguity tests honest. */
function makeNote(fields: {
  name: string;
  updatedAt: number;
  aliases?: string[];
  moduleId?: string | null;
}): Artifact {
  fixtureSeq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(fixtureSeq).padStart(12, '0')}`,
    createdAt: 1000,
    updatedAt: fields.updatedAt,
    campaignId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    moduleId: fields.moduleId ?? null,
    kind: 'note',
    name: fields.name,
    tags: [],
    aliases: fields.aliases ?? [],
    summary: `Summary of ${fields.name}.`,
    body: '',
    links: [],
    currentRevision: 1,
    imageIds: [],
    coverImageId: null,
    data: {},
  };
}

/** Builds a global library row (globals are never `note` kind). */
function makeGlobal(fields: {
  name: string;
  updatedAt: number;
  kind: 'npc' | 'location' | 'faction';
}): AnyArtifact {
  fixtureSeq += 1;
  const data = {
    npc: {
      role: '',
      appearance: '',
      personality: '',
      motivation: '',
      secrets: '',
      voiceNotes: '',
      statBlock: null,
    },
    location: { locationType: '', inhabitants: '', pointsOfInterest: [], hooks: [] },
    faction: { goals: '', methods: '', resources: '', ranks: [] },
  }[fields.kind];
  return anyArtifactSchema.parse({
    id: `00000000-0000-4000-8000-${String(fixtureSeq).padStart(12, '0')}`,
    createdAt: 1000,
    updatedAt: fields.updatedAt,
    campaignId: null,
    moduleId: null,
    kind: fields.kind,
    name: fields.name,
    tags: [],
    aliases: [],
    summary: `Summary of ${fields.name}.`,
    body: '',
    links: [],
    currentRevision: 1,
    imageIds: [],
    coverImageId: null,
    data,
  });
}

describe('extractWikiLinks', () => {
  it('extracts name and display in order of occurrence', () => {
    expect(extractWikiLinks('[[Alice]] met [[Bob|Bobby]] at [[The Rusty Tankard]].')).toEqual([
      { name: 'Alice', display: 'Alice' },
      { name: 'Bob', display: 'Bobby' },
      { name: 'The Rusty Tankard', display: 'The Rusty Tankard' },
    ]);
  });

  it('dedupes case-insensitively, keeping the first casing', () => {
    expect(extractWikiLinks('[[Alice]] and [[ALICE]] and [[alice]] again')).toEqual([
      { name: 'Alice', display: 'Alice' },
    ]);
  });

  it('trims name and display, defaulting blank display to the name', () => {
    expect(extractWikiLinks('[[  Alice  |  the Guest  ]]')).toEqual([
      { name: 'Alice', display: 'the Guest' },
    ]);
    expect(extractWikiLinks('[[A|   ]]')).toEqual([{ name: 'A', display: 'A' }]);
  });

  it('skips empty names and unterminated tokens', () => {
    expect(extractWikiLinks('[[ ]] and [[|x]] and [[Ghost')).toEqual([]);
    expect(extractWikiLinks('plain text only')).toEqual([]);
  });

  it('treats a second pipe as part of the display text', () => {
    expect(extractWikiLinks('[[A|B|C]]')).toEqual([{ name: 'A', display: 'B|C' }]);
  });
});

describe('stripWikiLinks', () => {
  it('replaces tokens with display text, falling back to the name', () => {
    expect(stripWikiLinks('See [[Alice]] and [[Bob|  Bobby  ]] now.')).toBe(
      'See Alice and Bobby now.',
    );
    expect(stripWikiLinks('[[A|   ]] was here.')).toBe('A was here.');
  });

  it('leaves text without tokens untouched', () => {
    expect(stripWikiLinks('No tokens, [[ not even this one')).toBe('No tokens, [[ not even this one');
  });
});

describe('resolveWikiLink', () => {
  it('is unresolved for an empty pool, no match, or a blank name', () => {
    const alice = makeNote({ name: 'Alice', updatedAt: 100 });
    expect(resolveWikiLink('Alice', [])).toEqual({
      status: 'unresolved',
      artifact: undefined,
      candidates: [],
    });
    expect(resolveWikiLink('Ghost', [alice])).toEqual({
      status: 'unresolved',
      artifact: undefined,
      candidates: [],
    });
    expect(resolveWikiLink('   ', [alice])).toEqual({
      status: 'unresolved',
      artifact: undefined,
      candidates: [],
    });
  });

  it('resolves by artifact name, case-insensitively with trimmed query', () => {
    const alice = makeNote({ name: 'Alice', updatedAt: 100 });
    expect(resolveWikiLink('  aLiCe ', [alice])).toEqual({
      status: 'resolved',
      artifact: alice,
      candidates: [alice],
    });
  });

  it('resolves by alias, case-insensitively with trimmed aliases', () => {
    const bob = makeNote({ name: 'Bob', updatedAt: 10, aliases: ['Bobby', ' Robert '] });
    expect(resolveWikiLink('  bobby ', [bob]).status).toBe('resolved');
    expect(resolveWikiLink('robert', [bob])).toEqual({
      status: 'resolved',
      artifact: bob,
      candidates: [bob],
    });
  });

  it('is ambiguous for same-name artifacts, newest updatedAt first', () => {
    const older = makeNote({ name: 'ALICE', updatedAt: 50 });
    const newer = makeNote({ name: 'Alice', updatedAt: 100 });
    const result = resolveWikiLink('alice', [older, newer]);
    expect(result.status).toBe('ambiguous');
    expect(result.candidates).toEqual([newer, older]);
    expect(result.artifact).toBe(newer);
  });

  it('breaks updatedAt ties by keeping list order', () => {
    const first = makeNote({ name: 'Twins', updatedAt: 100 });
    const second = makeNote({ name: 'Twins', updatedAt: 100 });
    const result = resolveWikiLink('twins', [second, first]);
    expect(result.candidates).toEqual([second, first]);
    expect(result.artifact).toBe(second);
  });

  it('merges the name and alias pools, so a newer alias match wins', () => {
    const olderNameMatch = makeNote({ name: 'Ember', updatedAt: 10 });
    const newerAliasMatch = makeNote({ name: 'Cinder', updatedAt: 20, aliases: ['Ember'] });
    const result = resolveWikiLink('ember', [olderNameMatch, newerAliasMatch]);
    expect(result.status).toBe('ambiguous');
    expect(result.candidates).toEqual([newerAliasMatch, olderNameMatch]);
    expect(result.artifact).toBe(newerAliasMatch);
  });

  it('counts one artifact matching both its name and its own alias as ONE candidate', () => {
    // An alias equal to the artifact's own name (e.g. a rename that kept the
    // old name as an alias) must not create a duplicate candidate.
    const ash = makeNote({ name: 'Ash', updatedAt: 10, aliases: ['Ash'] });
    const result = resolveWikiLink('ash', [ash]);
    expect(result.status).toBe('resolved');
    expect(result.candidates).toEqual([ash]);
    expect(result.artifact).toBe(ash);
  });

  it('does not mutate the input artifact list', () => {
    const older = makeNote({ name: 'ALICE', updatedAt: 50 });
    const newer = makeNote({ name: 'Alice', updatedAt: 100 });
    const pool = [older, newer];
    resolveWikiLink('alice', pool);
    expect(pool).toEqual([older, newer]);
  });
});

describe('scope precedence (10-MILESTONE-6 D8)', () => {
  const MODULE = '00000000-0000-4000-8000-0000000000b1';

  it('module context: the own-module entity wins over a campaign-owned namesake', () => {
    const own = makeNote({ name: 'Seggel', updatedAt: 100, moduleId: MODULE });
    const campaignRow = makeNote({ name: 'Seggel', updatedAt: 999 });
    const result = resolveWikiLink('Seggel', [campaignRow, own], { moduleId: MODULE });
    expect(result.status).toBe('resolved');
    expect(result.artifact?.id).toBe(own.id);
    expect(result.candidates).toHaveLength(1);
  });

  it('module context: a campaign-owned entity beats a global library namesake', () => {
    const campaignRow = makeNote({ name: 'The Rusty Tankard', updatedAt: 100 });
    const globalRow = makeGlobal({ name: 'The Rusty Tankard', updatedAt: 999, kind: 'faction' });
    const result = resolveWikiLink('The Rusty Tankard', [globalRow, campaignRow], {
      moduleId: MODULE,
    });
    expect(result.status).toBe('resolved');
    expect(result.artifact?.id).toBe(campaignRow.id);
  });

  it('without a module context, owned rows beat the global library', () => {
    const campaignRow = makeNote({ name: 'Old Mine', updatedAt: 100 });
    const globalRow = makeGlobal({ name: 'Old Mine', updatedAt: 999, kind: 'location' });
    const result = resolveWikiLink('Old Mine', [globalRow, campaignRow]);
    expect(result.status).toBe('resolved');
    expect(result.artifact?.id).toBe(campaignRow.id);
  });

  it('ambiguity stays a within-tier property (fix-01 behavior)', () => {
    const newer = makeNote({ name: 'Twins', updatedAt: 200 });
    const older = makeNote({ name: 'Twins', updatedAt: 100 });
    const result = resolveWikiLink('Twins', [older, newer], { moduleId: MODULE });
    expect(result.status).toBe('ambiguous');
    expect(result.candidates.map((candidate) => candidate.id)).toEqual([newer.id, older.id]);
  });

  it('a lower tier never silences a higher-tier ambiguity', () => {
    const first = makeNote({ name: 'Goblin', updatedAt: 200 });
    const second = makeNote({ name: 'Goblin', updatedAt: 100 });
    const globalRow = makeGlobal({ name: 'Goblin', updatedAt: 999, kind: 'npc' });
    const result = resolveWikiLink('Goblin', [globalRow, second, first], { moduleId: MODULE });
    expect(result.status).toBe('ambiguous');
    expect(result.candidates.every((candidate) => candidate.campaignId !== null)).toBe(true);
  });
});

describe('wikiLinkNames', () => {
  it('lists unique names in order of first occurrence', () => {
    expect(wikiLinkNames('[[Alice]] met [[Bob|Bobby]]. Later [[alice]] and [[Bob]] again.')).toEqual(
      ['Alice', 'Bob'],
    );
    expect(wikiLinkNames('')).toEqual([]);
  });
});

describe('countOccurrences', () => {
  it('counts case-insensitively per document, omitting zero-count documents', () => {
    const documents = [
      { where: 'premise', markdown: 'Alice met alice. ALICE left.' },
      { where: 'part-0', markdown: 'Nobody relevant here.' },
      { where: 'part-1', markdown: 'alice dreams; alice wakes.' },
    ];
    expect(countOccurrences('  ALICE ', documents)).toEqual([
      { where: 'premise', count: 3 },
      { where: 'part-1', count: 2 },
    ]);
    expect(countOccurrences('alice', [])).toEqual([]);
  });

  it('counts non-overlapping matches', () => {
    expect(countOccurrences('aa', [{ where: 'd', markdown: 'aaaa' }])).toEqual([
      { where: 'd', count: 2 },
    ]);
  });

  it('is plain substring matching, not token-aware', () => {
    expect(countOccurrences('Alice', [{ where: 'd', markdown: 'Malice toward none.' }])).toEqual([
      { where: 'd', count: 1 },
    ]);
  });

  it('returns no occurrences for a blank name instead of looping forever', () => {
    expect(countOccurrences('   ', [{ where: 'd', markdown: 'anything at all' }])).toEqual([]);
    expect(countOccurrences('', [{ where: 'd', markdown: 'anything at all' }])).toEqual([]);
  });
});

describe('sentenceAround', () => {
  const markdown = '[[Alice|Alice Liddell]] smiled. Bob frowned. Where did Alice go?';

  it('returns the first sentence containing the name, tokens stripped to display', () => {
    expect(sentenceAround(markdown, 'alice')).toBe('Alice Liddell smiled.');
    expect(sentenceAround(markdown, 'frowned')).toBe('Bob frowned.');
    expect(sentenceAround('He saw [[Bob|Bobby]] fall.', 'bob')).toBe('He saw Bobby fall.');
  });

  it('returns an empty string when the name is absent or blank', () => {
    expect(sentenceAround(markdown, 'ghost')).toBe('');
    expect(sentenceAround('No links at all.', '   ')).toBe('');
  });
});

describe('surroundingParagraphs', () => {
  const markdown = [
    'Intro paragraph without tokens.',
    '[[Alice]] rules the vale.',
    'Unrelated chatter.',
    'The vale of [[Alice|the Vale Queen]] is cold.',
  ].join('\n\n');

  it('keeps matching paragraphs with tokens intact, joined by blank lines', () => {
    expect(surroundingParagraphs(markdown, 'alice')).toBe(
      '[[Alice]] rules the vale.\n\nThe vale of [[Alice|the Vale Queen]] is cold.',
    );
  });

  it('matches on token names only, never on display text', () => {
    expect(surroundingParagraphs(markdown, 'the Vale Queen')).toBe('');
    expect(surroundingParagraphs('Alice appears without any token.\n\nNothing about her.', 'alice')).toBe(
      'Alice appears without any token.',
    );
  });

  it('returns an empty string for a blank name', () => {
    expect(surroundingParagraphs(markdown, '   ')).toBe('');
  });

  it('caps the join at 1200 chars by default, with an ellipsis only when truncating', () => {
    const long = 'x'.repeat(600) + ' [[Alice]] ' + 'y'.repeat(700);
    const capped = surroundingParagraphs(long, 'alice');
    expect(capped.length).toBe(1201);
    expect(capped.endsWith('…')).toBe(true);

    const exact = 'a'.repeat(1194) + 'Alice' + 'b';
    const uncapped = surroundingParagraphs(exact, 'alice');
    expect(uncapped).toBe(exact);
    expect(uncapped.endsWith('…')).toBe(false);
  });

  it('honours a custom cap', () => {
    expect(surroundingParagraphs('[[Alice]] was here and the tale goes far beyond.', 'alice', 10)).toBe(
      '[[Alice]] …',
    );
  });
});

describe('rewriteWikiLinkTargets', () => {
  it('rewrites bare tokens to [[canonical|original name]], preserving rendered prose', () => {
    expect(rewriteWikiLinkTargets('[[Guard Halmund]] guards.', [{ from: 'Guard Halmund', to: 'Halmund' }])).toBe(
      '[[Halmund|Guard Halmund]] guards.',
    );
    // The display text the reader and PDF render is unchanged.
    expect(stripWikiLinks('[[Halmund|Guard Halmund]] guards.')).toBe('Guard Halmund guards.');
  });

  it('keeps an existing display text exactly as written', () => {
    expect(
      rewriteWikiLinkTargets('[[Guard Halmund|the guard]] waits.', [{ from: 'Guard Halmund', to: 'Halmund' }]),
    ).toBe('[[Halmund|the guard]] waits.');
  });

  it('rewrites every occurrence and leaves unrelated tokens alone', () => {
    const out = rewriteWikiLinkTargets(
      '[[Halmunds]] Haus neben [[Seggel]] und [[Halmunds]] Kegel — plus [[Seggel]] again.',
      [
        { from: 'Halmunds', to: 'Halmund' },
        { from: 'Seggel', to: 'Seggel' },
      ],
    );
    expect(out).toBe(
      '[[Halmund|Halmunds]] Haus neben [[Seggel]] und [[Halmund|Halmunds]] Kegel — plus [[Seggel]] again.',
    );
  });

  it('skips tokens inside fenced code blocks and inline code spans', () => {
    const markdown = [
      'Before [[Guard Halmund]].',
      '',
      '```markdown',
      'Example: [[Guard Halmund]] stays',
      '```',
      '',
      'Inline `[[Guard Halmund]]` stays too. After [[Guard Halmund|late]].',
    ].join('\n');
    const out = rewriteWikiLinkTargets(markdown, [{ from: 'Guard Halmund', to: 'Halmund' }]);
    expect(out).toContain('Example: [[Guard Halmund]] stays');
    expect(out).toContain('Inline `[[Guard Halmund]]` stays too.');
    expect(out).toContain('Before [[Halmund|Guard Halmund]].');
    expect(out).toContain('After [[Halmund|late]].');
  });

  it('rewrites in one pass so results are never re-matched', () => {
    // "Halmunds" → "Halmund" produces [[Halmund|Halmunds]]; a naive second
    // pass could re-match the inserted target — it must not.
    const out = rewriteWikiLinkTargets('[[Halmunds]]', [
      { from: 'Halmunds', to: 'Halmund' },
      { from: 'Halmund', to: 'Other' },
    ]);
    expect(out).toBe('[[Halmund|Halmunds]]');
  });

  it('is a no-op without rewrites', () => {
    expect(rewriteWikiLinkTargets('[[Alice]]', [])).toBe('[[Alice]]');
  });
});
