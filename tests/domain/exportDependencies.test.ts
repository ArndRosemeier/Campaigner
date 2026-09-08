import { describe, expect, it } from 'vitest';

import {
  analyzeDependencies,
  groupCitationsByArtifact,
  ruleChunkSchema,
  rulebookSchema,
  statBlockSchema,
  stampNewEntity,
  type ExportBookDep,
  type ExportCitation,
  type ExportDependencies,
  type RuleChunk,
  type Rulebook,
  type StatBlock,
} from '@/domain';

/**
 * Dependency analysis matrix (07-MILESTONE-3 M3-E slice B): the pure
 * L0/L1/L2 read of a manifest against a library snapshot — no Dexie, plain
 * maps in, verdicts out.
 */

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function fixtureStatBlock(): StatBlock {
  return statBlockSchema.parse({
    system: 'pathfinder2e',
    level: '1',
    size: 'Small',
    creatureType: 'humanoid',
    ac: 15,
    acNote: '',
    hp: 7,
    hpFormula: '2d6',
    speed: '25 ft.',
    abilities: { str: 10, dex: 12, con: 10, int: 8, wis: 10, cha: 8 },
    saves: '',
    skills: '',
    senses: '',
    languages: '',
    traits: [],
    actions: [],
    reactions: [],
    legendary: [],
    extras: {},
  });
}

function book(over: Partial<Record<string, unknown>> = {}): Rulebook {
  return rulebookSchema.parse({
    ...stampNewEntity(),
    title: 'Monster Core',
    system: 'pathfinder2e',
    filename: 'monster-core.zip',
    pageCount: 320,
    status: 'ready',
    errorMessage: '',
    origin: 'pack',
    packMeta: null,
    ...over,
  });
}

function chunk(bookId: string, over: Partial<Record<string, unknown>> = {}): RuleChunk {
  return ruleChunkSchema.parse({
    ...stampNewEntity(),
    bookId,
    pageStart: 1,
    pageEnd: 1,
    chunkType: 'statblock',
    headingPath: ['Goblin Warrior'],
    text: 'Goblin Warrior stat block',
    statBlock: fixtureStatBlock(),
    contentHash: HASH_A,
    ...over,
  });
}

function citation(over: Partial<Record<string, unknown>> = {}): ExportCitation {
  return {
    artifactId: stampNewEntity().id,
    artifactName: 'Goblin ambush',
    kind: 'encounter',
    monsterName: 'Goblin Warrior',
    citedChunkId: stampNewEntity().id,
    chunkType: 'statblock',
    status: 'resolved',
    bookTitle: 'Monster Core',
    system: 'pathfinder2e',
    creatureName: 'Goblin Warrior',
    contentHash: HASH_A,
    ...over,
  };
}

function manifestBook(over: Partial<Record<string, unknown>> = {}): ExportBookDep {
  return {
    title: 'Monster Core',
    system: 'pathfinder2e',
    origin: 'pack',
    filename: 'monster-core.zip',
    pageCount: 320,
    pack: { sourceId: 'foundry-pf2e', entriesImported: 120 },
    chunkCount: 1,
    citedChunkIds: [stampNewEntity().id],
    ...over,
  };
}

function manifest(over: Partial<ExportDependencies> = {}): ExportDependencies {
  return {
    citations: [citation()],
    books: [manifestBook()],
    pinnedChunks: [],
    unmetLibraryRefs: [],
    ...over,
  };
}

describe('analyzeDependencies', () => {
  it('marks a byte-identical chunk present and the book L0 (clean import)', () => {
    const local = book();
    const localChunk = chunk(local.id);
    const analysis = analyzeDependencies(manifest(), {
      chunksByHash: new Map([[HASH_A, [localChunk]]]),
      books: [local],
    });
    expect(analysis.citations[0]?.verdict).toBe('present');
    expect(analysis.books[0]?.matchLevel).toBe('L0');
    expect(analysis.books[0]?.localTitle).toBe('Monster Core');
    expect(analysis.clean).toBe(true);
    expect(analysis.blockingCitations).toBe(0);
  });

  it('marks the same creature under a new hash version-drift with the book L1', () => {
    const local = book();
    // Re-ingest: new row id, new hash, same creature in the same book.
    const reingested = chunk(local.id, { contentHash: HASH_B, text: 'Goblin Warrior, revised' });
    const analysis = analyzeDependencies(manifest(), {
      chunksByHash: new Map([[HASH_B, [reingested]]]),
      books: [local],
    });
    expect(analysis.citations[0]?.verdict).toBe('version-drift');
    expect(analysis.books[0]?.matchLevel).toBe('L1');
    expect(analysis.books[0]?.hint).toContain('Goblin Warrior');
    expect(analysis.clean).toBe(false);
    expect(analysis.blockingCitations).toBe(1);
  });

  it('marks a citation missing when the book is gone (book-level missing)', () => {
    const analysis = analyzeDependencies(manifest(), { chunksByHash: new Map(), books: [] });
    expect(analysis.citations[0]?.verdict).toBe('missing');
    expect(analysis.citations[0]?.fuzzyHints).toEqual([]);
    expect(analysis.books[0]?.matchLevel).toBe('missing');
    expect(analysis.books[0]?.hint).toContain('Monster Core');
    expect(analysis.clean).toBe(false);
  });

  it('adds the L2 fuzzy advisory when the creature surfaces in another book', () => {
    const other = book({ title: 'Other Bestiary' });
    const pool = chunk(other.id, { contentHash: HASH_B });
    const analysis = analyzeDependencies(manifest(), {
      chunksByHash: new Map([[HASH_B, [pool]]]),
      books: [other],
    });
    expect(analysis.citations[0]?.verdict).toBe('missing');
    expect(analysis.citations[0]?.fuzzyHints).toEqual([
      '‘Goblin Warrior’ in ‘Other Bestiary’ (pathfinder2e)',
    ]);
    // Advisory only: the citation stays missing (still blocking).
    expect(analysis.clean).toBe(false);
    expect(analysis.books[0]?.matchLevel).toBe('L2');
  });

  it('never satisfies L0 from a statless hash hit', () => {
    const local = book();
    const statless = chunk(local.id, { statBlock: null, chunkType: 'section' });
    const analysis = analyzeDependencies(manifest(), {
      chunksByHash: new Map([[HASH_A, [statless]]]),
      books: [local],
    });
    // Same hash but no stats: still missing (the row would show `missing ref`).
    expect(analysis.citations[0]?.verdict).toBe('missing');
    expect(analysis.clean).toBe(false);
  });

  it('blocks on unmet NPC refs even when every citation is present', () => {
    const local = book();
    const localChunk = chunk(local.id);
    const withUnmet = manifest({
      unmetLibraryRefs: [
        {
          artifactId: stampNewEntity().id,
          artifactName: 'Goblin ambush',
          kind: 'encounter',
          monsterName: 'Vexra',
          npcArtifactId: stampNewEntity().id,
          npcName: 'Vexra',
          status: 'global',
        },
      ],
    });
    const analysis = analyzeDependencies(withUnmet, {
      chunksByHash: new Map([[HASH_A, [localChunk]]]),
      books: [local],
    });
    expect(analysis.citations[0]?.verdict).toBe('present');
    expect(analysis.clean).toBe(false);
    expect(analysis.unmetLibraryRefs).toHaveLength(1);
  });

  it('treats missing pins as advisory (never blocking)', () => {
    const local = book();
    const localChunk = chunk(local.id);
    const withPin = manifest({
      pinnedChunks: [{ runId: stampNewEntity().id, chunkId: 'nope', status: 'missing-chunk' }],
    });
    const analysis = analyzeDependencies(withPin, {
      chunksByHash: new Map([[HASH_A, [localChunk]]]),
      books: [local],
    });
    expect(analysis.pinnedMissing).toHaveLength(1);
    expect(analysis.clean).toBe(true);
  });

  it('treats a manifest-less (v1) import as clean', () => {
    expect(analyzeDependencies(undefined, { chunksByHash: new Map(), books: [] }).clean).toBe(
      true,
    );
  });

  it('groups non-present citations by citing artifact for the dialog', () => {
    const local = book();
    const groups = groupCitationsByArtifact(
      analyzeDependencies(
        manifest({ citations: [citation(), citation({ monsterName: 'Goblin Archer' })] }),
        { chunksByHash: new Map(), books: [local] },
      ),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.artifactName).toBe('Goblin ambush');
    expect(groups[0]?.monsters.map((monster) => monster.monsterName).sort()).toEqual([
      'Goblin Archer',
      'Goblin Warrior',
    ]);
  });
});
