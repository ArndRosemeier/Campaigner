import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import 'fake-indexeddb/auto';

import {
  anyArtifactSchema,
  contentCreatureKey,
  createArtifact,
  createModule,
  moduleSchema,
  newId,
  ruleChunkSchema,
  rulebookSchema,
  statBlockSchema,
  type Id,
  type Module,
} from '@/domain';
import { buildWikiGraph } from '@/domain/wikiGraph';
import { analyzeDependencies } from '@/domain/exportDependencies';
import { nearestLibraryCreatures } from '@/llm/creatorRoster';
import { rosterNameIndex, type PackRosterEntry } from '@/llm/encounterRoster';
import { reconcileRoomAssignments, resolveBriefMonsterLevels } from '@/llm/roomBudget';
import { detectCampaignEntities } from '@/llm/campaignGrounding';
import { BUILTIN_PROMPT_STYLES } from '@/llm/promptStyles';
import { missingRefsSummary } from '@/features/campaign/components/missing-refs-summary';
import { createPromptStyle, duplicatePromptStyle } from '@/db/promptStyleRepo';
import { clearDatabase } from '../db/helpers';

/**
 * THE KEY-SPACE ACCOUNTING (docs/17 row 167; the key-index class row 166 named
 * and left to its own slice).
 *
 * WHAT THIS FILE IS. `comparableName` (the comparable form: NFC + trim +
 * case-fold) is ONE primitive serving several DIFFERENT questions. Row 167's
 * brief: the spaces must NOT be merged into one helper — a spelling-variant
 * index and a creature identity are different key spaces — but each space must
 * be DECLARED, named, with its sites and its consumer, so a reader can tell
 * them apart and a new copy cannot be born unnoticed. The declarations live in
 * `domain/artifactAlias`'s header and in one-line comments at the sites; THIS
 * file is the enforcement:
 *
 * 1. per-space accounting — the space's sites still route through the ONE
 *    comparable form, counted (a revert reds);
 * 2. the boundary scan — the hand-rolled `trim().toLowerCase()` KEY spelling
 *    survives ONLY in the declared anti-spaces (a new key-index site is born
 *    red with its path named);
 * 3. one consumer-level behaviour pin per space where a name identity is
 *    involved — composed vs decomposed resolving through the REAL consumer,
 *    never through a re-implementation of the key.
 *
 * WHY SCANS AND NOT ONLY BEHAVIOUR. A key spelled `name.trim().toLowerCase()`
 * and one spelled `comparableName(name)` agree on every ASCII input — the
 * defect only shows for non-ASCII names, which is exactly where rows 162/166's
 * incidents lived. Behaviour pins the composition cases we thought of; the
 * scan declares the population so the ones nobody thought of cannot arrive
 * silently.
 */

/** The per-space accounting: space → file → [needle, exact count]. A COUNT,
 * not `>= 1`: reverting ONE site of several must fail here. The needles are
 * space-SPECIFIC where the file also serves another space; per-file TOTALS
 * that the alias-merge scan already pins (`tests/features/
 * alias-merge-seam.test.ts`, the FOLDED map) are not duplicated here. Counted
 * over CODE, comment lines skipped (row 162's incident: a pin that read
 * comments reds on its own explanation — `domain/creature.ts`'s doc comment
 * NAMES the spelling it holds). */
const SPACES: Record<string, Record<string, readonly [string, number][]>> = {
  // The pack pool's printed name ↔ the model's verbatim `sourceName`, resolved
  // to a chunk id (creature roster AND item pool — one question, two pools).
  PACK_POOL_NAME_KEY: {
    'llm/encounterRoster.ts': [['comparableName(', 3]],
    'llm/encounterItems.ts': [['comparableName(', 3]],
    // The consumers: the model's sourceName must ASK in the index's key space
    // (two bracket lookups in runEngine + the level lookup in roomBudget).
    'llm/runEngine.ts': [['rosterChunkByName[comparableName(', 2]],
    'llm/roomBudget.ts': [['rosterChunkByName[comparableName(', 1]],
  },
  // A name of something the MODULE holds, matched against another such name of
  // the SAME module.
  MODULE_NAME_KEY: {
    'llm/roomBudget.ts': [['comparableName(', 7]], // 6 module sites + 1 pool consumer
    'domain/module.ts': [['comparableName(alias)', 2], ['comparableName(part)', 1]],
    'llm/runEngine.ts': [['comparableName(entry.name)}|', 1]], // the roster digest
  },
  // One WRITTEN `[[name]]` token recognised across a prose set.
  WRITTEN_LINK_NAME_KEY: {
    'domain/wikiGraph.ts': [['comparableName(', 3]],
    'llm/moduleGen.ts': [
      ['names.add(comparableName(link.name))', 1],
      ['names.has(comparableName(rewrite.from))', 1],
    ],
    'features/modules/module-problems.ts': [['comparableName(', 1]],
    'db/artifactAutoPromote.ts': [['comparableName(', 1]],
  },
  // One library creature prints/suggests once.
  LIBRARY_CREATURE_NAME_KEY: {
    'db/creatureCitations.ts': [['comparableName(', 2]],
    'llm/creatorRoster.ts': [['comparableName(', 1]],
  },
  // An export manifest's logical identity against a local snapshot (the L1
  // verdict asks ONE question of both halves: cited book TITLE and cited
  // creature NAME — so one tolerance covers both here, by the consumer).
  IMPORT_IDENTITY_KEY: {
    'domain/exportDependencies.ts': [['comparableName(', 1]],
  },
  // One displayed name, once, in the missing-refs sentence.
  PRINTED_NAME_DEDUPE_KEY: {
    'features/campaign/components/missing-refs-summary.ts': [['comparableName(', 1]],
  },
  // A prompt style's name is unique across the picker (the clash map AND the
  // free-copy-name set — keying one half by `.toLowerCase()` alone misses the
  // other half's entries: the partial-fold trap).
  PROMPT_STYLE_NAME_KEY: {
    'db/promptStyleRepo.ts': [['comparableName(', 6]],
  },
  // The PERSISTED creature identity — FOLDED since docs/17 row 168. This space
  // is the one whose key bytes are an EXISTING identity: a Dexie UNIQUE index
  // (`mobPortraits: 'id, &creatureKey'`), a `creatureImages` composite index,
  // and every battle token's `creatureKey`. The mint folds the name through
  // `comparableName` (the `name.trim().toLowerCase()` of row 167 is gone), and
  // `foldCreatureKey` is the migration/import seam that folds a pre-fold key
  // (the v22 Dexie upgrade and `lib/exportImport` both call it). Both spellings
  // are counted here, so reverting either the mint or the seam reds.
  CREATURE_CONTENT_IDENTITY_KEY: {
    'domain/creature.ts': [
      ['comparableName(name)', 1],
      ['comparableName(storedName)', 1],
    ],
  },
};

/** The ANTI-SPACES: files where `trim().toLowerCase()` is deliberately NOT the
 * comparable form, each for a reason. A file not listed here that carries the
 * shape is a new key-index site born red. (Full rationale for each lives in
 * `domain/artifactAlias`'s header or the row-166/167 docs.)
 *
 * NOT listed, with the reason — these do NOT carry the trimmed KEY shape and so
 * would make the staleness check above lie: `features/modules/entity-batch.ts`
 * (the book-title disambiguator — a BARE `.toLowerCase()` comparison, row 161's
 * rule, declared by row 166) and `features/campaign/components/tag-editor.tsx`
 * (a TAG dedupe spelled `existing.toLowerCase() === tag.toLowerCase()` — a tag
 * is not a name, and its dedupe stays out of every name-key space until an
 * owner says otherwise); and `llm/campaignGrounding.ts`, whose bare
 * `.toLowerCase()` KEY spelling has its own revert pin in the ALIAS_FORM block
 * below. */
const BOUNDARIES: Record<string, string> = {
  'domain/artifactAlias.ts': 'the primitive itself — its definition IS the fold',
  'db/mobPortraitCache.ts': "row 165's survivor — `isCanonicalCitation`, the portrait path another slice owns",
  'domain/module.ts': "sameSlot's BOOK half (a book title is not a name, row 161) + the entity lookups' emptiness probes",
  // `llm/roomBudget.ts` USED to be declared here ("partLevelForMention — an
  // emptiness probe only"): row 285's `firstPartMentioning` refactor replaced
  // that probe's `name.trim().toLowerCase()` with a plain `name.trim() === ''`
  // guard and routed the mention test through the ONE alias-aware pair
  // (`extractWikiLinks` + `sameAliasName`), so the hand-rolled KEY spelling this
  // map licenses no longer exists in the file. THE ENTRY IS DELETED, NOT
  // REWRITTEN: the scan's own doctrine is that a boundary entry which no longer
  // carries the shape "licenses nothing and lies about the tree", and keeping a
  // stale licence alive would be the silent-gain direction this pin forbids.
  'llm/schemas.ts': 'a zod enum case coercion — a VALUE transform, not a key',
  'llm/moduleGen.ts': 'the MODULE_TONE_BANS keyword registry lookup, not a name',
  'features/campaign/components/alias-editor.tsx': 'the FORM — it rejects a keystroke a person just typed (row 121/162)',
  'ingest/packs/dnd5e-foundry.ts': 'an ingest TRAIT literal, not a name identity',
  'features/bestiary/roster.ts': 'a SEARCH NEEDLE — substring contains matching, fuzzy BY CONTRACT, not an identity key',
  'features/campaign/filter.ts': 'a SEARCH NEEDLE — substring contains matching, fuzzy BY CONTRACT, not an identity key',
  'features/play/battle/SpawnPicker.tsx': 'a SEARCH NEEDLE — substring contains matching, fuzzy BY CONTRACT, not an identity key',
  'features/quickfind/moduleHits.ts': 'a SEARCH NEEDLE — substring contains matching, fuzzy BY CONTRACT, not an identity key',
  'help/HelpDialog.tsx': 'a SEARCH NEEDLE — substring contains matching, fuzzy BY CONTRACT, not an identity key',
  'search/search.ts': 'a SEARCH NEEDLE — substring contains matching, fuzzy BY CONTRACT, not an identity key',
};

/** The hand-rolled KEY spelling this file polices: the key-index form of the
 * name-comparison class row 166 folded (its scan was name-anchored on `===`
 * comparisons and deliberately blind to keys — see its own comment). A literal
 * substring needle, not a regex: the shape is exactly this byte sequence, so
 * `includes` is the honest and the simplest matcher. */
const TRIM_CASE_KEY = '.trim().toLowerCase()';

function srcFiles(): string[] {
  const root = join(process.cwd(), 'src');
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
      found.push(full.slice(root.length + 1).replace(/\\/g, '/'));
    }
  };
  walk(root);
  return found.sort();
}

const source = (file: string): string => readFileSync(join(process.cwd(), 'src', file), 'utf8');

/** The file's CODE, comment lines dropped — the declarations NAME the shape
 * they forbid, and a pin that reads comments reds on its own explanation
 * (row 162's real incident). */
const codeLines = (text: string): string =>
  text
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
    })
    .join('\n');

const count = (text: string, needle: string): number => text.split(needle).length - 1;

describe('the name key spaces are declared and held (docs/17 row 167)', () => {
  it('every declared space still routes its sites through the ONE comparable form, counted', () => {
    // Non-vacuity: the primitive the spaces name actually exists, with the
    // composition fold that distinguishes it from a bare case-fold.
    const primitive = source('domain/artifactAlias.ts');
    expect(primitive).toContain('export function comparableName');
    expect(primitive).toContain("name.normalize('NFC').trim().toLowerCase()");

    for (const [space, files] of Object.entries(SPACES)) {
      for (const [file, needles] of Object.entries(files)) {
        const text = codeLines(source(file));
        for (const [needle, expected] of needles) {
          expect(count(text, needle), `${space}: ${file}: ${needle}`).toBe(expected);
        }
      }
    }
  });

  it('the accounting is NON-VACUOUS — it covers eight spaces across the real tree', () => {
    // A needle that matched nothing (a typo, a refactor that renamed the call)
    // would make the accounting vacuously green; the population itself is
    // asserted here.
    const files = new Set(Object.values(SPACES).flatMap((f) => Object.keys(f)));
    expect(Object.keys(SPACES).length).toBe(8);
    expect(files.size).toBeGreaterThanOrEqual(14);
    for (const file of files) {
      expect(srcFiles(), `${file} must exist in src/`).toContain(file);
    }
  });

  it('the hand-rolled KEY spelling survives only in the declared anti-spaces, each with a reason', () => {
    // The shape itself must be live — a regex that matches nothing proves
    // nothing.
    expect('const key = name.trim().toLowerCase();'.includes(TRIM_CASE_KEY)).toBe(true);

    const offenders: string[] = [];
    const boundaryHits = new Set<string>();
    for (const file of srcFiles()) {
      if (!codeLines(source(file)).includes(TRIM_CASE_KEY)) continue;
      if (BOUNDARIES[file] === undefined) {
        offenders.push(file);
        continue;
      }
      boundaryHits.add(file);
    }
    expect(offenders).toEqual([]);

    // Every declared boundary must still CARRY the shape: a stale entry that
    // no longer matches licenses nothing and lies about the tree.
    for (const file of Object.keys(BOUNDARIES)) {
      expect(
        codeLines(source(file)).includes(TRIM_CASE_KEY),
        `${file}: declared boundary no longer carries the shape — update BOUNDARIES`,
      ).toBe(true);
    }
    // Non-vacuity of the population: the scan really walked the tree.
    expect(srcFiles().length).toBeGreaterThan(200);
    expect(boundaryHits.size).toBe(Object.keys(BOUNDARIES).length);
  });
});

// ---------------------------------------------------------------------------
// The consumer-level behaviour pins: composed vs decomposed through the REAL
// consumer. Composition differs only for non-ASCII names; every fixture uses
// one name in NFC (precomposed) and the SAME name in NFD (decomposed) — and
// the fixtures block first proves the two spellings really are different
// strings, so no pin here can pass vacuously.
// ---------------------------------------------------------------------------

const COMPOSED = 'Wächter'; // precomposed ä (U+00E4)
const DECOMPOSED = 'Wa\u0308chter'; // a + combining diaeresis (U+0308)

describe('the fixtures really are two spellings of one name', () => {
  it('composed and decomposed differ as bytes and agree only under the comparable form', () => {
    expect(COMPOSED).not.toBe(DECOMPOSED);
    expect(DECOMPOSED.normalize('NFC')).toBe(COMPOSED);
    expect(COMPOSED.toLowerCase()).not.toBe(DECOMPOSED.toLowerCase());
  });
});

function rosterEntry(name: string, chunkId: Id, bookId: Id): PackRosterEntry {
  return {
    name,
    level: '2',
    traits: '',
    chunkId,
    levelSort: 2,
    bookId,
    bookTitle: 'Monsterkern',
  };
}

function chunk(chunkId: Id, level: string) {
  return ruleChunkSchema.parse({
    id: chunkId,
    bookId: newId(),
    pageStart: 1,
    pageEnd: 1,
    chunkType: 'statblock',
    headingPath: ['Creature'],
    text: '',
    statBlock: statBlockSchema.parse({
      system: 'dnd5e',
      level,
      size: 'Medium',
      creatureType: 'humanoid',
      ac: 12,
      acNote: '',
      hp: 7,
      hpFormula: '',
      speed: '',
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
      saves: '',
      skills: '',
      senses: '',
      languages: '',
      traits: [],
      actions: [],
      reactions: [],
      legendary: [],
      extras: {},
    }),
    contentHash: 'a'.repeat(64),
    createdAt: 1,
    updatedAt: 1,
  });
}

describe('PACK_POOL_NAME_KEY — the pack pool resolves the model’s sourceName', () => {
  it('a DECOMPOSED sourceName resolves a COMPOSED roster entry through the real level lookup', () => {
    const chunkId = newId();
    const index = rosterNameIndex([rosterEntry(COMPOSED, chunkId, newId())]);
    // Non-vacuity: the index really keyed the entry.
    expect([...index.keys()]).toEqual(['wächter']);

    const levels = resolveBriefMonsterLevels([{ sourceName: DECOMPOSED }], {
      chunkById: new Map([[chunkId, chunk(chunkId, '2')]]),
      rosterChunkByName: Object.fromEntries(index),
      statblockChunkIds: [],
    });
    // The consumer answer: the model's decomposed citation reached the same
    // chunk the roster window printed composed — the level comes back instead
    // of the room reading loud-unverified for no reason.
    expect(levels).toEqual(['2']);
  });

  it('two creatures that differ ONLY by diacritic stay TWO pool entries (NFC yes, diacritic folding NO)', () => {
    const schlaeger = newId();
    const schlager = newId();
    const bookId = newId();
    const index = rosterNameIndex([
      rosterEntry('Schläger', schlaeger, bookId),
      rosterEntry('Schlager', schlager, bookId),
    ]);
    // The loose normalizations would fold these into ONE key and silently
    // resolve one creature's citation to the OTHER's stat block — a different
    // creature than the module asked for (row 166's exactness rule, key form).
    expect(index.size).toBe(2);
    expect(index.get('schläger')).toBe(schlaeger);
    expect(index.get('schlager')).toBe(schlager);
  });
});

describe('MODULE_NAME_KEY — the module’s own names reconcile against each other', () => {
  it('a room’s assignment survives a recomposition of the same roster name', () => {
    const result = reconcileRoomAssignments(
      [{ id: 'room-a', monsterIndexes: [0] }],
      [{ name: COMPOSED }],
      [{ name: DECOMPOSED }],
    );
    expect(result).toEqual([{ roomId: 'room-a', monsterIndexes: [0] }]);
  });

  it('a DIFFERENT name never inherits the room (exactness: the remap is identity, not similarity)', () => {
    // 'Schlager' is a different creature from 'Schläger' — it must NOT be
    // matched into Schläger's old room; it lands as a fresh entry via the
    // round-robin fallback (room-a first), leaving room-b unclaimed. A looser
    // key would hand 'Schlager' room-b and strand the layout.
    const result = reconcileRoomAssignments(
      [
        { id: 'room-a', monsterIndexes: [0] },
        { id: 'room-b', monsterIndexes: [1] },
      ],
      [{ name: 'Ogre' }, { name: 'Schläger' }],
      [{ name: 'Schlager' }],
    );
    expect(result).toEqual([
      { roomId: 'room-a', monsterIndexes: [0] },
      { roomId: 'room-b', monsterIndexes: [] },
    ]);
  });
});

describe('WRITTEN_LINK_NAME_KEY — one written token across compositions', () => {
  function moduleWith(markdown: string): Module {
    const draft = createModule({
      campaignId: newId(),
      title: 'A Module',
      concept: '',
      levelMin: 1,
      levelMax: 3,
      sizeDial: 'sketch',
    });
    return moduleSchema.parse({
      ...draft,
      spine: {
        premise: '',
        themes: [],
        partPlan: [{ title: 'Part', levelBand: '1–3', synopsis: '', levelUpTrigger: '' }],
      },
      parts: [
        {
          planIndex: 0,
          markdown,
          status: 'ready' as const,
          errorMessage: '',
          edited: false,
        },
      ],
    });
  }

  it('the composed and the decomposed spelling of one written token are ONE phantom node, counted once per occurrence', () => {
    const graph = buildWikiGraph(
      [moduleWith(`See [[${COMPOSED}]] and then [[${DECOMPOSED}]] again.`)],
      [],
    );
    const phantoms = graph.nodes.filter((node) => node.key.startsWith('name:'));
    // Two written spellings, ONE to-do entry — a second node would read as a
    // second unresolved entity in the reader's problem list.
    expect(phantoms).toHaveLength(1);
    const phantom = phantoms[0];
    if (phantom === undefined) throw new Error('phantom node missing — the pin cannot proceed');
    expect(phantom.key).toBe('name:wächter');
    const mentions = [...phantom.mentionsByDocument.values()];
    expect(mentions.reduce((total, mention) => total + mention.count, 0)).toBe(2);
  });
});

describe('LIBRARY_CREATURE_NAME_KEY — one library creature suggests once', () => {
  it('two rows of the same creature (same composed name) collapse across a DECOMPOSED wanted name', () => {
    const creature = (chunkId: string) => ({
      chunkId,
      name: COMPOSED,
      contentHash: 'h',
      headingPath: [COMPOSED],
      statBlock: null,
      bookId: newId(),
    });
    const suggestions = nearestLibraryCreatures(DECOMPOSED, [creature(newId()), creature(newId())]);
    // Non-vacuity: two candidates went in; the dedupe — not the scoring — is
    // what makes one come out.
    expect(suggestions).toHaveLength(1);
  });
});

describe('IMPORT_IDENTITY_KEY — the L1 verdict matches across compositions', () => {
  it('a manifest title composed against a decomposed local title is still matched, not missing', () => {
    // The manifest cites a creature by a content hash that no longer exists
    // locally (a re-ingest under a new hash): the verdict then depends on
    // matching the BOOK TITLE — here spelled differently ONLY in composition —
    // and the creature name. A hand-rolled title key would answer `missing`
    // and report a dependency the library actually satisfies.
    const local = rulebookSchema.parse({
      id: newId(),
      title: 'Mo\u0308nsterkern', // DECOMPOSED ö
      system: 'pathfinder2e',
      filename: 'monsterkern.zip',
      pageCount: 320,
      status: 'ready',
      errorMessage: '',
      origin: 'pack',
      packMeta: null,
      createdAt: 1,
      updatedAt: 1,
    });
    const reingested = ruleChunkSchema.parse({
      id: newId(),
      bookId: local.id,
      pageStart: 1,
      pageEnd: 1,
      chunkType: 'statblock',
      headingPath: ['Goblin Warrior'],
      text: 'Goblin Warrior, revised',
      statBlock: statBlockSchema.parse({
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
      }),
      contentHash: 'b'.repeat(64),
      createdAt: 1,
      updatedAt: 1,
    });
    const analysis = analyzeDependencies(
      {
        citations: [
          {
            artifactId: newId(),
            artifactName: 'Goblin ambush',
            kind: 'encounter',
            monsterName: 'Goblin Warrior',
            citedChunkId: newId(),
            chunkType: 'statblock',
            status: 'resolved',
            bookTitle: 'Mönsterkern', // COMPOSED ö
            system: 'pathfinder2e',
            creatureName: 'Goblin Warrior',
            contentHash: 'a'.repeat(64),
          },
        ],
        books: [],
        pinnedChunks: [],
        unmetLibraryRefs: [],
      },
      {
        chunksByHash: new Map([['b'.repeat(64), [reingested]]]),
        books: [local],
      },
    );
    expect(analysis.citations[0]?.verdict).toBe('version-drift');
  });
});

describe('PRINTED_NAME_DEDUPE_KEY — one displayed name, once', () => {
  it('the missing-refs sentence prints one creature once across compositions', () => {
    expect(COMPOSED).not.toBe(DECOMPOSED); // non-vacuity
    const sentence = missingRefsSummary([
      { encounter: 'Pier Ambush', creature: COMPOSED },
      { encounter: 'The Drowned Vault', creature: DECOMPOSED },
    ]);
    expect(sentence).toContain('2 encounter entries across 2 encounters');
    expect(sentence).toContain('Missing: Wächter.');
    expect(sentence.indexOf('Wächter')).toBe(sentence.lastIndexOf('Wächter'));
  });
});

describe('ALIAS_FORM_KEY — the anti-space: a spelling pick, not an identity', () => {
  it('keeps its declared spelling: the form key case-folds and does NOT composition-fold', () => {
    // The direct revert pin for the anti-space: this key is `name.toLowerCase()`
    // on a pre-trimmed read, BY DECISION — `comparableName` here would drop a
    // real spelling (the behaviour pin below is what that fold broke).
    expect(source('llm/campaignGrounding.ts')).toContain('const key = name.toLowerCase();');
  });

  it('a COMPOSED prose mention is still detected when the artifact also carries the alias DECOMPOSED', () => {
    // The artifact's name is composed; one of its aliases spells the SAME
    // form DECOMPOSED. The grounding pick must keep BOTH spellings alive (the
    // map's values become detection regexes, and a regex never folds
    // composition). Folding this key onto the comparable form collapsed the
    // two into one entry — and because the decomposed spelling is one code
    // unit LONGER, the alias won the map and the NAME's own spelling was
    // dropped: detection went blind to prose spelled the way the name spells
    // it. This is the pin that was watched RED under that fold (injection c).
    const npc = anyArtifactSchema.parse(
      createArtifact({
        campaignId: newId(),
        kind: 'npc',
        name: COMPOSED,
        aliases: [DECOMPOSED],
        summary: 'waits.',
      }),
    );
    const detected = detectCampaignEntities(`Der ${COMPOSED} steht still im Saal.`, [npc]);
    expect(detected.map((entry) => entry.name)).toEqual([COMPOSED]);
  });

  it('and the decomposed alias spelling detects its own prose too (BOTH spellings alive, not one)', () => {
    const npc = anyArtifactSchema.parse(
      createArtifact({
        campaignId: newId(),
        kind: 'npc',
        name: COMPOSED,
        aliases: [DECOMPOSED],
        summary: 'waits.',
      }),
    );
    const detected = detectCampaignEntities(`Der ${DECOMPOSED} steht still im Saal.`, [npc]);
    expect(detected.map((entry) => entry.name)).toEqual([COMPOSED]);
  });

  it('and the longest spelling still wins its form (the dedupe the key exists for)', () => {
    const npc = anyArtifactSchema.parse(
      createArtifact({
        campaignId: newId(),
        kind: 'npc',
        name: 'The Alchemist',
        aliases: ['The Alchemist '], // same form, trailing space — collapses
        summary: 'brews.',
      }),
    );
    const detected = detectCampaignEntities('The Alchemist brews.', [npc]);
    expect(detected).toHaveLength(1);
  });
});

describe('PROMPT_STYLE_NAME_KEY — the picker’s names are unique in ONE key space', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  it('duplicating a style whose composition differs from an existing copy lands on "(copy 2)", not a clash', async () => {
    // An existing copy spelled COMPOSED; the source spelled DECOMPOSED. The
    // free-copy-name set and its lookups are one key space, so the candidate
    // "Wächter (copy)" is recognised as taken and the copy is named
    // "(copy 2)" — under the partial fold (set keyed comparable, lookups
    // `.toLowerCase()`) the lookup missed and `writeStyles` threw a spurious
    // "already exists" at a legal copy. The template is a builtin's verbatim
    // (a savable template must carry every surface placeholder, so there is
    // no shorter valid one to write by hand).
    const template = BUILTIN_PROMPT_STYLES[0]?.templateText;
    if (template === undefined) throw new Error('no builtin prompt style to copy a template from');
    const existing = await createPromptStyle({
      name: `${COMPOSED} (copy)`,
      templateText: template,
    });
    expect(existing.name).toBe(`${COMPOSED} (copy)`);
    const sourceStyle = await createPromptStyle({
      name: DECOMPOSED,
      templateText: template,
    });
    const copy = await duplicatePromptStyle(sourceStyle);
    expect(copy.name).toBe(`${DECOMPOSED} (copy) 2`);
  });
});

describe('CREATURE_CONTENT_IDENTITY_KEY — the persisted identity is FOLDED', () => {
  it('composition no longer changes the persisted key (docs/17 row 168), while trim and case still fold', () => {
    // THE DECISION THIS PIN HOLDS: composition is folded, so a Mac-authored
    // (decomposed) and a precomposed spelling mint ONE key — one portrait slot,
    // "one creature, one look" (docs/11 D6). The fold's mate is the data
    // migration (`src/db/db.ts` version 22) plus the `foldCreatureKey` seam; the
    // migration's own pins live in `tests/db/creature-key-fold.test.ts`.
    expect(contentCreatureKey(COMPOSED, null)).toBe(contentCreatureKey(DECOMPOSED, null));
    // The parts that were ALWAYS folded stay folded:
    expect(contentCreatureKey(`${COMPOSED} `, null)).toBe(contentCreatureKey(COMPOSED, null));
    expect(contentCreatureKey(COMPOSED.toUpperCase(), null)).toBe(
      contentCreatureKey(COMPOSED, null),
    );
    // undefined and null statBlock collapse (the documented hashing rule):
    expect(contentCreatureKey(COMPOSED, undefined)).toBe(contentCreatureKey(COMPOSED, null));
  });
});
