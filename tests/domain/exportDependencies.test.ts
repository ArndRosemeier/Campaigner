import { describe, expect, it } from 'vitest';

import {
  analyzeDependencies,
  artifactSchema,
  citedChunkIdsFor,
  collectDependencies,
  groupCitationsByArtifact,
  personaRunSchema,
  ruleChunkSchema,
  rulebookSchema,
  statBlockSchema,
  stampNewEntity,
  type Artifact,
  type DependencyLibrary,
  type ExportBookDep,
  type ExportCitation,
  type ExportDependencies,
  type PersonaRun,
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

/** No library at all — every chunk, book and artifact lookup misses. */
function emptyLibrary(): DependencyLibrary {
  return {
    chunksById: new Map(),
    booksById: new Map(),
    artifactsById: new Map(),
    chunkCountsByBookId: new Map(),
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
    expect(analysis.driftedCitations).toBe(0);
  });

  it('marks the same creature under a new hash version-drift with the book L1 — no longer blocking, still counted', () => {
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
    // docs/17 row 261: a drift is the same creature under another version of
    // the same book — the import proceeds (clean), and the drift is COUNTED
    // rather than either blocking or disappearing.
    expect(analysis.clean).toBe(true);
    expect(analysis.blockingCitations).toBe(0);
    expect(analysis.driftedCitations).toBe(1);
  });

  it('a missing citation beside a drift still blocks, and only the missing one is counted', () => {
    const local = book();
    // Citation 1 ("Goblin Warrior") drifts; citation 2 cites a creature the
    // book does not hold at all → genuinely missing.
    const reingested = chunk(local.id, { contentHash: HASH_B, text: 'Goblin Warrior, revised' });
    const analysis = analyzeDependencies(
      manifest({
        citations: [citation(), citation({ creatureName: 'Ancient Red Dragon' })],
      }),
      { chunksByHash: new Map([[HASH_B, [reingested]]]), books: [local] },
    );
    expect(analysis.citations.map((entry) => entry.verdict)).toEqual(['version-drift', 'missing']);
    expect(analysis.clean).toBe(false);
    expect(analysis.blockingCitations).toBe(1);
    expect(analysis.driftedCitations).toBe(1);
  });

  it('marks a citation missing when the book is gone (book-level missing)', () => {
    const analysis = analyzeDependencies(manifest(), { chunksByHash: new Map(), books: [] });
    expect(analysis.citations[0]?.verdict).toBe('missing');
    expect(analysis.citations[0]?.fuzzyHints).toEqual([]);
    expect(analysis.books[0]?.matchLevel).toBe('missing');
    expect(analysis.books[0]?.hint).toContain('Monster Core');
    // The abort arm: a genuinely absent book blocks (docs/17 row 261 keeps it).
    expect(analysis.clean).toBe(false);
    expect(analysis.blockingCitations).toBe(1);
    expect(analysis.driftedCitations).toBe(0);
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
    expect(analysis.blockingCitations).toBe(1);
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
    // The unmet-ref arm blocks on its OWN (docs/17 row 261 leaves it as the
    // always-blocking half): zero blocking/drifted citations, still not clean.
    expect(analysis.blockingCitations).toBe(0);
    expect(analysis.driftedCitations).toBe(0);
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

/**
 * Manifest-stamp carry (chunk-hash-fallback follow-up): `collectDependencies`
 * stamps a dangling entry's own content identity onto its `missing-chunk`
 * citation, so re-exporting a healed-but-dangling campaign writes a manifest
 * a second-generation import clears at L0 instead of aborting on.
 */
describe('collectDependencies missing-chunk stamp carry', () => {
  function rulebookEntry(chunkId: string, stamp: Record<string, unknown> = {}): unknown {
    void chunkId;
    void stamp;
    return {
      name: 'Goblin Warrior',
      count: 1,
      notes: '',
      source: { type: 'none' as const },
    };
  }

  function encounterWith(monsters: unknown[]): Artifact {
    return artifactSchema.parse({
      ...stampNewEntity(),
      campaignId: stampNewEntity().id,
      kind: 'encounter',
      name: 'Goblin ambush',
      tags: [],
      summary: '',
      body: '',
      links: [],
      currentRevision: 1,
      data: {
        difficulty: 'medium',
        levelHint: '1',
        monsters,
        terrain: '',
        tactics: '',
        treasure: '',
      },
    });
  }

  it('re-export after heal: a stamped dangling entry exports its hash and analyzes L0-present (no abort)', () => {
    const danglingId = stampNewEntity().id;
    const healed = encounterWith([
      rulebookEntry(danglingId, { contentHash: HASH_A, creatureName: 'Goblin Warrior' }),
    ]);
    const exported = collectDependencies([healed], [], emptyLibrary());
    expect(exported.citations).toHaveLength(1);
    // Honest status (the chunk WAS missing here) WITH the entry's stamp.
    expect(exported.citations[0]).toMatchObject({
      citedChunkId: danglingId,
      status: 'missing-chunk',
      contentHash: HASH_A,
      creatureName: 'Goblin Warrior',
    });
    // Second-generation import: a byte-identical install clears L0.
    const local = book();
    const localChunk = chunk(local.id);
    const analysis = analyzeDependencies(exported, {
      chunksByHash: new Map([[HASH_A, [localChunk]]]),
      books: [local],
    });
    expect(analysis.citations[0]?.verdict).toBe('present');
    expect(analysis.clean).toBe(true);
    expect(analysis.blockingCitations).toBe(0);
    expect(analysis.driftedCitations).toBe(0);
  });

  it('chunk data wins over a stale entry stamp (no silent override)', () => {
    const local = book();
    const localChunk = chunk(local.id, { contentHash: HASH_A });
    const staleStamp = encounterWith([
      rulebookEntry(localChunk.id, { contentHash: HASH_B, creatureName: 'Stale Name' }),
    ]);
    const exported = collectDependencies(
      [staleStamp],
      [],
      {
        ...emptyLibrary(),
        chunksById: new Map([[localChunk.id, localChunk]]),
        booksById: new Map([[local.id, local]]),
        chunkCountsByBookId: new Map([[local.id, 1]]),
      },
    );
    expect(exported.citations[0]).toMatchObject({
      status: 'resolved',
      contentHash: HASH_A,
      creatureName: 'Goblin Warrior',
    });
  });

  it('a stamp-less dangling entry stays a plain missing citation (no behavior change)', () => {
    const danglingId = stampNewEntity().id;
    const unstamped = encounterWith([rulebookEntry(danglingId)]);
    const exported = collectDependencies([unstamped], [], emptyLibrary());
    expect(exported.citations).toHaveLength(1);
    expect(exported.citations[0]?.status).toBe('missing-chunk');
    expect(exported.citations[0]?.contentHash).toBeUndefined();
    expect(exported.citations[0]?.creatureName).toBeUndefined();
    const analysis = analyzeDependencies(exported, { chunksByHash: new Map(), books: [] });
    expect(analysis.citations[0]?.verdict).toBe('missing');
    expect(analysis.clean).toBe(false);
    expect(analysis.blockingCitations).toBe(1);
    expect(analysis.driftedCitations).toBe(0);
  });
});

/**
 * THE NPC CREATURE-CITATION ARM (docs/17 row 271, item A3). A cast NPC that
 * still carries the legacy `creatureRef` pointer cites a library creature
 * exactly as a roster `rulebook` entry does — the two are the same four-field
 * citation (`domain/creature.creatureRefForRulebookSource`) — but
 * `collectDependencies` used to skip every non-encounter row, so an unmet one
 * traveled with NO warning at all and only rendered `missing ref` after the
 * import. It now takes the SAME writer and the SAME policy as the roster arm.
 */
describe('collectDependencies NPC creatureRef arm', () => {
  function npcWith(creatureRef: Record<string, unknown>): Artifact {
    return artifactSchema.parse({
      ...stampNewEntity(),
      campaignId: stampNewEntity().id,
      kind: 'npc',
      name: 'Aunt Agatha',
      tags: [],
      summary: '',
      body: '',
      links: [],
      currentRevision: 1,
      data: { appearance: '', personality: '', statBlock: null, creatureRef },
    });
  }

  it('NAMES an unmet NPC citation and blocks it, exactly as the roster arm does', () => {
    const npc = npcWith({
      chunkId: stampNewEntity().id,
      creatureName: 'Ghoul',
      bookTitle: 'Monster Core',
    });
    const exported = collectDependencies([npc], [], emptyLibrary());
    expect(exported.citations).toHaveLength(1);
    expect(exported.citations[0]).toMatchObject({
      artifactId: npc.id,
      artifactName: 'Aunt Agatha',
      kind: 'npc',
      monsterName: 'Aunt Agatha',
      status: 'missing-chunk',
      creatureName: 'Ghoul',
    });
    const analysis = analyzeDependencies(exported, { chunksByHash: new Map(), books: [] });
    expect(analysis.clean).toBe(false);
    expect(analysis.blockingCitations).toBe(1);
    expect(analysis.driftedCitations).toBe(0);
    expect(analysis.citations[0]?.citation.kind).toBe('npc');
  });

  it('resolves an NPC citation through the SAME chunk→book join, and rolls the book up', () => {
    const local = book();
    const localChunk = chunk(local.id);
    const npc = npcWith({ chunkId: localChunk.id });
    const exported = collectDependencies([npc], [], {
      ...emptyLibrary(),
      chunksById: new Map([[localChunk.id, localChunk]]),
      booksById: new Map([[local.id, local]]),
      chunkCountsByBookId: new Map([[local.id, 1]]),
    });
    expect(exported.citations[0]).toMatchObject({
      citedChunkId: localChunk.id,
      status: 'resolved',
      bookTitle: 'Monster Core',
      system: 'pathfinder2e',
      creatureName: 'Goblin Warrior',
      contentHash: HASH_A,
    });
    expect(exported.books[0]?.citedChunkIds).toEqual([localChunk.id]);
    expect(
      analyzeDependencies(exported, {
        chunksByHash: new Map([[HASH_A, [localChunk]]]),
        books: [local],
      }).clean,
    ).toBe(true);
  });

  it('NAMES an id-less creatureRef too, carrying the hash it has (never silent)', () => {
    const npc = npcWith({ contentHash: HASH_A, creatureName: 'Ghoul' });
    const exported = collectDependencies([npc], [], emptyLibrary());
    expect(exported.citations).toHaveLength(1);
    expect(exported.citations[0]?.citedChunkId).toBeUndefined();
    expect(exported.citations[0]).toMatchObject({ status: 'missing-chunk', contentHash: HASH_A });
    // The verdict reads the hash, so a byte-identical install still clears it.
    const local = book();
    const localChunk = chunk(local.id);
    expect(
      analyzeDependencies(exported, {
        chunksByHash: new Map([[HASH_A, [localChunk]]]),
        books: [local],
      }).citations[0]?.verdict,
    ).toBe('present');
  });

  it('a COPIED npc (no creatureRef) contributes no citation at all', () => {
    const copied = artifactSchema.parse({
      ...stampNewEntity(),
      campaignId: stampNewEntity().id,
      kind: 'npc',
      name: 'Aunt Agatha',
      tags: [],
      summary: '',
      body: '',
      links: [],
      currentRevision: 1,
      data: {
        appearance: '',
        personality: '',
        statBlock: fixtureStatBlock(),
        sourceLine: 'Bestiary p.132',
        originToken: 'chunk:00000000-0000-4000-8000-0000000000ff',
      },
    });
    expect(collectDependencies([copied], [], emptyLibrary()).citations).toHaveLength(0);
  });
});

/**
 * THE ONE ENUMERATION (docs/17 row 271). The bulk read that fills
 * `chunksById` asks `citedChunkIdsFor`; the builder reads the citations off the
 * rows. This is the differential pin between them: if a citation arm exists that
 * the helper does not enumerate, the builder resolves it against an empty map
 * and the manifest calls a present chunk missing.
 */
describe('citedChunkIdsFor covers every citation arm collectDependencies reads', () => {
  function runWithPins(id: string, pinnedChunkIds: string[]): PersonaRun {
    return personaRunSchema.parse({
      ...stampNewEntity(),
      id,
      campaignId: stampNewEntity().id,
      personaId: stampNewEntity().id,
      autonomy: 'manual',
      status: 'completed',
      userBrief: 'draft goblins',
      errorMessage: '',
      pinnedChunkIds,
      steps: [],
      resultArtifactId: null,
      targetArtifactId: null,
    });
  }

  it('names exactly the roster, NPC and run-pin chunks, and the manifest resolves them', () => {
    const local = book();
    const rosterChunk = chunk(local.id, { headingPath: ['Goblin Warrior'] });
    const npcChunk = chunk(local.id, { headingPath: ['Ghoul'] });
    const pinnedChunk = chunk(local.id, { headingPath: ['Wraith'] });
    const encounter = artifactSchema.parse({
      ...stampNewEntity(),
      campaignId: stampNewEntity().id,
      kind: 'encounter',
      name: 'Goblin ambush',
      tags: [],
      summary: '',
      body: '',
      links: [],
      currentRevision: 1,
      data: {
        difficulty: 'medium',
        levelHint: '1',
        monsters: [
          {
            name: 'Goblin Warrior',
            count: 1,
            notes: '',
            treasure: '',
            source: { type: 'none' as const },
          },
        ],
        terrain: '',
        tactics: '',
        treasure: '',
      },
    });
    const npc = artifactSchema.parse({
      ...stampNewEntity(),
      campaignId: stampNewEntity().id,
      kind: 'npc',
      name: 'Aunt Agatha',
      tags: [],
      summary: '',
      body: '',
      links: [],
      currentRevision: 1,
      data: {
        appearance: '',
        personality: '',
        statBlock: null,
        originToken: `chunk:${npcChunk.id}`,
      },
    });
    const run = runWithPins(stampNewEntity().id, [pinnedChunk.id]);
    const artifacts = [encounter, npc];

    expect(new Set(citedChunkIdsFor(artifacts, [run]))).toEqual(
      new Set([rosterChunk.id, npcChunk.id, pinnedChunk.id]),
    );

    // Every enumerated chunk is in the library: NOTHING may be missing-chunk.
    const chunksById = new Map(
      [rosterChunk, npcChunk, pinnedChunk].map((entry) => [entry.id, entry] as const),
    );
    const exported = collectDependencies(artifacts, [run], {
      ...emptyLibrary(),
      chunksById,
      booksById: new Map([[local.id, local]]),
      chunkCountsByBookId: new Map([[local.id, 3]]),
    });
    expect(exported.citations).toHaveLength(2);
    expect(exported.citations.filter((entry) => entry.status === 'missing-chunk')).toEqual([]);
    expect(exported.pinnedChunks.filter((pin) => pin.status !== 'resolved')).toEqual([]);
  });
});
