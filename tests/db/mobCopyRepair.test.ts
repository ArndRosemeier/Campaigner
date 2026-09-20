import Dexie from 'dexie';
import { describe, expect, it } from 'vitest';

import {
  copiedSpellEntry,
  rosterEntryCreatureIdentity,
  spellDataSchema,
  type MobSpellAssignment,
} from '@/domain';
import { rosterReferenceFor } from '@/domain/encounterResolve';
import { resolveStoredMonsterEntry } from '@/domain/mobCopyLegacy';
import { rosterParticipantRoute } from '@/features/campaign/mob-portrait-participants';

/**
 * v23 → v24 — THE MOB COPY (docs/17 row 248).
 *
 * A mob used to be representable two ways: an authored stat block, or a
 * POINTER into the imported library (an encounter roster entry's `rulebook`
 * source, a cast NPC's `creatureRef`) resolved at read time. The v24 upgrade
 * turns what resolves into an authored COPY, STAMPS the origin line that used
 * to be composed at read time, and keeps the `chunk:` portrait identity as an
 * opaque token. What cannot resolve KEEPS its pointer and is NAMED in the
 * settings report — the owner-decided failure arm, so the startup retry can
 * heal it once the pack is installed.
 *
 * The pins below are the DoD's own: a converted row has NO pointer; the stamped
 * line survives with the library UNREADABLE (so it cannot only be a live chunk
 * read); an unconvertible row keeps its pointer and is named; a second run is
 * all-zero; and a database with no pointers reports zero and writes nothing.
 */

const CAMPAIGN = '00000000-0000-4000-8000-000000000c24';
const MODULE = '00000000-0000-4000-8000-000000000b24';
const BOOK = '00000000-0000-4000-8000-000000000824';
const PACK_BOOK = '00000000-0000-4000-8000-000000000924';
const CHUNK = '00000000-0000-4000-8000-000000000d24';
const PACK_CHUNK = '00000000-0000-4000-8000-000000000e24';
const ENCOUNTER = '00000000-0000-4000-8000-000000000f24';
const NPC = '00000000-0000-4000-8000-000000000a24';

const OWLBEAR = {
  system: 'dnd5e' as const,
  level: '3',
  size: 'Large',
  creatureType: 'monstrosity',
  ac: 13,
  acNote: '',
  hp: 59,
  hpFormula: '7d10+21',
  speed: '40 ft.',
  abilities: { str: 20, dex: 12, con: 17, int: 3, wis: 12, cha: 7 },
  saves: '',
  skills: '',
  senses: '',
  languages: '',
  traits: [],
  actions: [],
  reactions: [],
  legendary: [],
  extras: {},
};

const PACK_ZOMBIE = {
  system: 'dnd5e' as const,
  level: '1',
  size: 'Medium',
  creatureType: 'undead',
  ac: 8,
  acNote: '',
  hp: 22,
  hpFormula: '3d8+9',
  speed: '20 ft.',
  abilities: { str: 13, dex: 6, con: 16, int: 3, wis: 6, cha: 5 },
  saves: '',
  skills: '',
  senses: '',
  languages: '',
  traits: [],
  actions: [],
  reactions: [],
  legendary: [],
  extras: {},
};

/**
 * The library creature's OWN embedded spell assignment (a BARE name, as a
 * creature document carries it) plus the corpus row that name means — the
 * fixture for the migration's spell arm (docs/17 row 255c).
 */
const OWLBEAR_SPELL = 'Fireball';
const FIREBALL = spellDataSchema.parse({
  system: 'dnd5e',
  rank: 3,
  cantrip: false,
  traditions: [],
  school: 'evo',
  filterAxis: 'school',
  traits: [],
  rarity: 'common',
  cast: { time: '1 action', range: '150 feet', target: '', duration: 'instantaneous' },
  damage: { 0: { formula: '8d6', type: 'fire', materials: [] } },
  area: { type: 'sphere', value: 20 },
  heightening: null,
  heighteningEntries: [],
  heighteningUnparsed: [],
  publication: { title: 'D&D SRD 5.2', license: 'CC-BY-4.0' },
});
const OWLBEAR_WITH_SPELLS = {
  ...OWLBEAR,
  spells: [{ name: OWLBEAR_SPELL, castRank: 3 }],
};
const OWLBEAR_COPIED = {
  ...OWLBEAR,
  spells: [{ name: OWLBEAR_SPELL, castRank: 3, spellData: FIREBALL }],
};
const SPELL_CHUNK = '00000000-0000-4000-8000-000000000524';

async function seedLegacyV23(options: {
  resolvedRoster: boolean;
  unresolvedRoster: boolean;
  resolvedNpc: boolean;
  unresolvedNpc: boolean;
  settingsRow: boolean;
}): Promise<void> {
  await Dexie.delete('campaigner');
  const legacy = new Dexie('campaigner');
  legacy.version(23).stores({
    campaigns: 'id, name',
    artifacts: 'id, campaignId, kind, [campaignId+kind], name, updatedAt, moduleId, [moduleId+kind]',
    revisions: 'id, artifactId, [artifactId+revision]',
    images: 'id, campaignId',
    rulebooks: 'id, system, status',
    chunks: 'id, bookId, chunkType, contentHash',
    embeddings: 'contentHash',
    personas: 'id, &slug',
    runs: 'id, campaignId, personaId, status, updatedAt',
    deliverables: null,
    modules: 'id, campaignId, updatedAt',
    battles: 'id, campaignId, &moduleId',
    pdfFiles: 'id, &bookId',
    mobPortraits: 'id, &creatureKey',
    moduleVersions: 'id, moduleId, createdAt',
    creatureImages: 'id, campaignId, [campaignId+creatureKey]',
    ideaBoards: 'id, updatedAt',
    settings: 'id',
  });
  await legacy.open();
  await legacy.table('campaigns').put({
    id: CAMPAIGN,
    name: 'Ember',
    system: 'dnd5e',
    description: '',
    createdAt: 1,
    updatedAt: 1,
  });
  await legacy.table('modules').put({
    id: MODULE,
    campaignId: CAMPAIGN,
    title: 'Ember Crypt',
    concept: 'A vault.',
    levelMin: 1,
    levelMax: 3,
    parts: [],
    createdAt: 1,
    updatedAt: 1,
    autoGenerateMobImages: false,
    autoGenerateBattlemaps: false,
    autoApproveSpine: false,
  });
  // The PDF book, with a page, and a pack book (no page numbers).
  await legacy.table('rulebooks').put({
    id: BOOK,
    system: 'dnd5e',
    status: 'ready',
    title: 'Bestiary',
    createdAt: 1,
    updatedAt: 1,
  });
  await legacy.table('rulebooks').put({
    id: PACK_BOOK,
    system: 'dnd5e',
    status: 'ready',
    title: 'Tome of Beasts',
    origin: 'pack',
    createdAt: 1,
    updatedAt: 1,
  });
  if (options.resolvedRoster) {
    await legacy.table('chunks').put({
      id: CHUNK,
      bookId: BOOK,
      pageStart: 132,
      pageEnd: 133,
      chunkType: 'statblock',
      headingPath: ['Owlbear'],
      text: 'Owlbear. HP 59, AC 13.',
      contentHash: 'hash-owlbear',
      statBlock: OWLBEAR_WITH_SPELLS,
    });
    // The corpus row the creature's bare assignment names (docs/17 row 255c):
    // the migration must copy IT onto the converted roster entry, not just the
    // creature's own block.
    await legacy.table('chunks').put({
      id: SPELL_CHUNK,
      bookId: BOOK,
      pageStart: 200,
      pageEnd: 200,
      chunkType: 'spell',
      headingPath: ['Spells', OWLBEAR_SPELL],
      text: OWLBEAR_SPELL,
      contentHash: 'hash-fireball',
      spellData: FIREBALL,
    });
  }
  if (options.resolvedNpc) {
    await legacy.table('chunks').put({
      id: PACK_CHUNK,
      bookId: PACK_BOOK,
      pageStart: 1,
      pageEnd: 1,
      chunkType: 'statblock',
      headingPath: ['Zombie'],
      text: 'Zombie. HP 22, AC 8.',
      contentHash: 'hash-zombie',
      statBlock: PACK_ZOMBIE,
    });
  }
  const monsters: unknown[] = [];
  if (options.resolvedRoster) {
    monsters.push({
      name: 'Owlbear',
      count: 2,
      notes: '',
      treasure: '',
      source: { type: 'rulebook', chunkId: CHUNK, contentHash: 'hash-owlbear', creatureName: 'Owlbear' },
    });
  }
  if (options.unresolvedRoster) {
    monsters.push({
      name: 'Ghost',
      count: 1,
      notes: '',
      treasure: '',
      source: { type: 'rulebook', chunkId: '00000000-0000-4000-8000-0000000000ff' },
    });
  }
  await legacy.table('artifacts').put({
    id: ENCOUNTER,
    createdAt: 1,
    updatedAt: 1,
    campaignId: CAMPAIGN,
    moduleId: MODULE,
    kind: 'encounter',
    name: 'Ash Gate',
    summary: '',
    body: '',
    aliases: [],
    tags: [],
    links: [],
    imageIds: [],
    coverImageId: null,
    // A real v23 row carries this; the read-path pin parses the row through
    // `anyArtifactSchema`, which requires it.
    currentRevision: 1,
    data: {
      difficulty: 'medium',
      levelHint: '3',
      monsters,
      terrain: '',
      tactics: '',
      treasure: '',
      mapImageId: null,
      layout: null,
      preset: 'standard',
      locationKind: 'other',
      siteShape: 'single',
      budgetAdvisory: '',
    },
  });
  if (options.resolvedNpc || options.unresolvedNpc) {
    await legacy.table('artifacts').put({
      id: NPC,
      createdAt: 1,
      updatedAt: 1,
      campaignId: CAMPAIGN,
      moduleId: MODULE,
      kind: 'npc',
      name: 'Aunt Agatha',
      summary: '',
      body: '',
      aliases: [],
      tags: [],
      links: [],
      imageIds: [],
      coverImageId: null,
      currentRevision: 1,
      data: {
        appearance: '',
        personality: '',
        statBlock: null,
        creatureRef: options.resolvedNpc
          ? { chunkId: PACK_CHUNK, contentHash: 'hash-zombie', creatureName: 'Zombie' }
          : { chunkId: '00000000-0000-4000-8000-0000000000ee' },
      },
    });
  }
  if (options.settingsRow) {
    await legacy.table('settings').put({ id: 'settings', creatureCitationRepair: null });
  }
  legacy.close();
}

/** The lookups a converted mob must NOT need — every one throws. Reading the
 * library to print a copied mob's origin line is the defect this proves gone. */
const LIBRARY_MUST_NOT_BE_READ = {
  getArtifact: (): never => {
    throw new Error('a converted mob must not read a campaign artifact');
  },
  getChunk: (): never => {
    throw new Error('a converted mob must not read the library');
  },
  getChunkByContentHash: (): never => {
    throw new Error('a converted mob must not read the library');
  },
  getRulebook: (): never => {
    throw new Error('a converted mob must not read the library');
  },
};

/** The lookups a stored-pointer read answers against when the library genuinely
 * lacks the row — every table empty, nothing throws. */
const LIBRARY_IS_ABSENT = {
  getArtifact: (): Promise<undefined> => Promise.resolve(undefined),
  getChunk: (): Promise<undefined> => Promise.resolve(undefined),
  getChunkByContentHash: (): Promise<undefined> => Promise.resolve(undefined),
  getRulebook: (): Promise<undefined> => Promise.resolve(undefined),
};

describe('v23 → v24 migration (the mob copy, docs/17 row 248)', () => {
  it('copies a roster mob and a cast NPC, stamps the origin line and keeps the chunk: token', async () => {
    await seedLegacyV23({
      resolvedRoster: true,
      unresolvedRoster: false,
      resolvedNpc: true,
      unresolvedNpc: false,
      settingsRow: true,
    });
    const { db } = await import('@/db/db');
    await db.open();
    expect(db.verno).toBe(29);

    const encounter = await db.artifacts.get(ENCOUNTER);
    if (encounter?.kind !== 'encounter') throw new Error('encounter missing');
    const entry = encounter.data.monsters[0];
    if (entry === undefined) throw new Error('roster entry missing');

    // 1. ONE representation: the pointer is GONE and the numbers are a copy.
    //    The copy carries the library SPELL entry too (docs/17 row 255c), not
    //    the bare name the creature document stated.
    expect(entry.source).toEqual({ type: 'inline', statBlock: OWLBEAR_COPIED });
    if (entry.source.type !== 'inline') throw new Error('the converted entry must be inline');
    const copiedSpells = entry.source.statBlock.spells ?? [];
    expect(copiedSpellEntry(copiedSpells[0] as MobSpellAssignment)).toEqual(FIREBALL);
    expect(entry.sourceLine).toBe('Bestiary p.132');
    expect(entry.originToken).toBe(`chunk:${CHUNK}`);

    // 2. The stamp is the mob's own data: with the library UNREADABLE the
    //    origin still reads. A line composed from a live chunk read fails here.
    const origin = await resolveStoredMonsterEntry(entry, LIBRARY_MUST_NOT_BE_READ);
    expect(origin.origin).toBe('Bestiary p.132');
    expect(origin.statBlock).toEqual(OWLBEAR_COPIED);
    expect(rosterReferenceFor(entry, undefined).text).toBe('Bestiary p.132');

    // 3. The portrait identity is unchanged, so no mobPortraits/creatureImages
    //    row needs remapping and the copy is NOT re-labelled hand-written.
    expect(rosterEntryCreatureIdentity(entry, undefined)?.key).toBe(`chunk:${CHUNK}`);
    expect(rosterParticipantRoute(entry, undefined)).toEqual({
      lane: 'creature',
      creatureKey: `chunk:${CHUNK}`,
      chunkId: CHUNK,
      name: 'Owlbear',
      artifactId: null,
    });

    // 4. The cast NPC: the copied block and its own stamp, no `creatureRef`.
    const npc = await db.artifacts.get(NPC);
    if (npc?.kind !== 'npc') throw new Error('npc missing');
    expect(npc.data.creatureRef).toBeUndefined();
    expect(npc.data.statBlock).toEqual(PACK_ZOMBIE);
    expect(npc.data.sourceLine).toBe('Tome of Beasts: Zombie');
    // The row itself is the ONE thing a converted cast NPC may read; every
    // LIBRARY lookup still throws, so its disclosure cannot be a live read.
    const derived = await resolveStoredMonsterEntry(
      { name: 'Aunt Agatha', count: 1, notes: '', treasure: '', source: { type: 'npc-ref', artifactId: NPC } },
      { ...LIBRARY_MUST_NOT_BE_READ, getArtifact: () => Promise.resolve(npc) },
    );
    expect(derived.origin).toBe('NPC: Aunt Agatha (stats from Tome of Beasts: Zombie)');

    // 5. The report is LOUD and persisted where the shell reads it.
    const settings = await db.settings.get('settings');
    expect(settings?.mobCopyRepair).toEqual({
      rosterMobsCopied: 1,
      npcCreaturesCopied: 1,
      unconverted: [],
      notified: false,
    });
    await db.delete();
  }, 20000);

  it('keeps the pointer and NAMES a mob the library cannot supply', async () => {
    await seedLegacyV23({
      resolvedRoster: false,
      unresolvedRoster: true,
      resolvedNpc: false,
      unresolvedNpc: true,
      settingsRow: true,
    });
    const { db } = await import('@/db/db');
    await db.open();

    const encounter = await db.artifacts.get(ENCOUNTER);
    if (encounter?.kind !== 'encounter') throw new Error('encounter missing');
    const entry = encounter.data.monsters[0];
    // The RETRY HANDLE survives: the pointer is still there, byte for byte.
    expect(entry?.source).toEqual({
      type: 'rulebook',
      chunkId: '00000000-0000-4000-8000-0000000000ff',
    });
    expect(entry?.sourceLine).toBeUndefined();
    expect(entry?.originToken).toBeUndefined();

    const npc = await db.artifacts.get(NPC);
    if (npc?.kind !== 'npc') throw new Error('npc missing');
    expect(npc.data.creatureRef).toEqual({
      chunkId: '00000000-0000-4000-8000-0000000000ee',
    });

    const settings = await db.settings.get('settings');
    expect(settings?.mobCopyRepair).toEqual({
      // NON-VACUITY: nothing was copied, and both rows are named.
      rosterMobsCopied: 0,
      npcCreaturesCopied: 0,
      unconverted: [
        {
          where: 'the encounter “Ash Gate”',
          name: 'Ghost',
          reason: 'the cited stat-block chunk is not in this workspace — install the pack that carries it',
          unexpected: false,
        },
        {
          where: 'an authored NPC',
          name: 'Aunt Agatha',
          reason: 'the cited stat-block chunk is not in this workspace — install the pack that carries it',
          unexpected: false,
        },
      ],
      notified: false,
    });
    await db.delete();
  }, 20000);

  it('is IDEMPOTENT: a second run copies nothing and reports all-zero', async () => {
    await seedLegacyV23({
      resolvedRoster: true,
      unresolvedRoster: false,
      resolvedNpc: true,
      unresolvedNpc: false,
      settingsRow: true,
    });
    const { db } = await import('@/db/db');
    await db.open();
    const { repairMobCopies } = await import('@/db/mobCopyRepair');
    // An ordinary transaction over the same four tables the upgrade body uses:
    // the seam takes the TRANSACTION, so it can be run again.
    const second = await db.transaction(
      'rw',
      [db.artifacts, db.chunks, db.rulebooks, db.settings],
      (tx) => repairMobCopies({ tx, reason: 'upgrade' }),
    );
    expect(second).toEqual({
      rosterMobsCopied: 0,
      npcCreaturesCopied: 0,
      unconverted: [],
      notified: false,
    });
    // And nothing moved: the first report is byte-identical, still un-notified,
    // and the converted row still carries no pointer.
    const settings = await db.settings.get('settings');
    expect(settings?.mobCopyRepair).toEqual({
      rosterMobsCopied: 1,
      npcCreaturesCopied: 1,
      unconverted: [],
      notified: false,
    });
    const encounter = await db.artifacts.get(ENCOUNTER);
    if (encounter?.kind !== 'encounter') throw new Error('encounter missing');
    expect(encounter.data.monsters[0]?.source.type).toBe('inline');
    await db.delete();
  }, 20000);

  it('the start-up retry heals a mob once the missing pack is installed', async () => {
    await seedLegacyV23({
      resolvedRoster: false,
      unresolvedRoster: true,
      resolvedNpc: false,
      unresolvedNpc: false,
      settingsRow: true,
    });
    const { db } = await import('@/db/db');
    await db.open();
    const unresolved = await db.settings.get('settings');
    expect(unresolved?.mobCopyRepair?.unconverted).toHaveLength(1);

    // The pack is installed AFTER the upgrade — the chunk appears.
    await db.chunks.put({
      id: '00000000-0000-4000-8000-0000000000ff',
      bookId: BOOK,
      pageStart: 132,
      pageEnd: 132,
      chunkType: 'statblock',
      headingPath: ['Ghost'],
      text: 'Ghost. HP 45, AC 12.',
      contentHash: 'hash-ghost',
      statBlock: OWLBEAR,
      createdAt: 2,
      updatedAt: 2,
    });
    const { retryMobCopies } = await import('@/db/mobCopyRetry');
    const healed = await retryMobCopies();
    expect(healed.rosterMobsCopied).toBe(1);
    expect(healed.unconverted).toEqual([]);

    const encounter = await db.artifacts.get(ENCOUNTER);
    if (encounter?.kind !== 'encounter') throw new Error('encounter missing');
    const entry = encounter.data.monsters[0];
    expect(entry?.source).toEqual({ type: 'inline', statBlock: OWLBEAR });
    expect(entry?.sourceLine).toBe('Bestiary p.132');

    // The toast is owed for the heal, and the worklist is gone.
    const settings = await db.settings.get('settings');
    expect(settings?.mobCopyRepair).toEqual({
      rosterMobsCopied: 1,
      npcCreaturesCopied: 0,
      unconverted: [],
      notified: false,
    });

    // A retry with nothing left to heal writes NOTHING (no re-report churn).
    if (settings === undefined) throw new Error('settings missing after the retry heal');
    await db.settings.put({ ...settings, mobCopyRepair: { ...healed, notified: true } });
    const again = await retryMobCopies();
    expect(again.rosterMobsCopied).toBe(0);
    const after = await db.settings.get('settings');
    expect(after?.mobCopyRepair?.notified).toBe(true);
    await db.delete();
  }, 20000);

  it('reports ZERO and writes NOTHING for a database that never pointed at a creature', async () => {
    await seedLegacyV23({
      resolvedRoster: false,
      unresolvedRoster: false,
      resolvedNpc: false,
      unresolvedNpc: false,
      settingsRow: true,
    });
    const { db } = await import('@/db/db');
    await db.open();
    // The non-vacuity zero case: the upgrade ran (verno 28) and had nothing to
    // do, so it wrote no report at all — `null` is the shell's "no toast" state.
    expect(db.verno).toBe(29);
    const settings = await db.settings.get('settings');
    expect(settings?.mobCopyRepair).toBeUndefined();
    await db.delete();
  }, 20000);

  it('refuses to migrate a workspace with mobs to copy but no settings row to report in', async () => {
    await seedLegacyV23({
      resolvedRoster: true,
      unresolvedRoster: false,
      resolvedNpc: false,
      unresolvedNpc: false,
      settingsRow: false,
    });
    const { db } = await import('@/db/db');
    await expect(db.open()).rejects.toThrow(/refusing to migrate silently/);
    await Dexie.delete('campaigner');
  }, 20000);

  it('isolates an UNEXPECTED throw to its row: the run COMPLETES and the report names it', async () => {
    // A RESOLVABLE roster mob whose conversion throws where the seam did not
    // predict it — the exact shape that used to abort the whole Dexie upgrade
    // and lock the app shut (docs/18 §5). The throw is injected at the book
    // read inside `creatureOriginLabel`, which is BEHIND every explicit
    // data-condition check, so the row reaches the guard rather than one of the
    // named `continue`s.
    await seedLegacyV23({
      resolvedRoster: true,
      unresolvedRoster: false,
      resolvedNpc: false,
      unresolvedNpc: false,
      settingsRow: true,
    });
    const { db } = await import('@/db/db');
    await db.open();
    const { repairMobCopies } = await import('@/db/mobCopyRepair');
    const { setBookReadFault } = await import('@/db/mobCopyRepair');
    // The fixture's own v24 upgrade already converted this row, so put the
    // POINTER BACK — a row that is resolvable (its chunk is present) but whose
    // conversion is about to throw. Re-converting it is then the only thing the
    // seam has left to do.
    const before = await db.artifacts.get(ENCOUNTER);
    if (before?.kind !== 'encounter') throw new Error('encounter missing');
    await db.artifacts.put({
      ...before,
      data: {
        ...before.data,
        monsters: [
          {
            name: 'Owlbear',
            count: 2,
            notes: '',
            treasure: '',
            source: { type: 'rulebook', chunkId: CHUNK, contentHash: 'hash-owlbear', creatureName: 'Owlbear' },
          },
        ],
      },
    });
    setBookReadFault(() => new Error('the book table exploded'));
    try {
      const report = await db.transaction(
        'rw',
        [db.artifacts, db.chunks, db.rulebooks, db.settings],
        (tx) => repairMobCopies({ tx, reason: 'upgrade' }),
      );
      // NON-VACUITY: the throw is NAMED with its own error text and flagged as
      // the code-defect population rather than the missing-pack one.
      expect(report.unconverted).toHaveLength(1);
      expect(report.unconverted[0]).toMatchObject({
        where: 'the encounter “Ash Gate”',
        name: 'Owlbear',
        unexpected: true,
      });
      expect(report.unconverted[0]?.reason).toContain('the book table exploded');
      // ...and the run COMPLETED: the guard swallowed nothing — the entry names
      // the row — and the rest of the workspace was still processed.
      expect(report.rosterMobsCopied).toBe(0);
      const encounter = await db.artifacts.get(ENCOUNTER);
      if (encounter?.kind !== 'encounter') throw new Error('encounter missing');
      // The row kept its pointer, so the startup retry can still heal it.
      expect(encounter.data.monsters[0]?.source).toEqual({
        type: 'rulebook',
        chunkId: CHUNK,
        contentHash: 'hash-owlbear',
        creatureName: 'Owlbear',
      });
      // ...and the ONE report sentence says so in its own register.
      const { formatMobCopyRepair } = await import('@/domain/mobCopyRepair');
      const sentence = formatMobCopyRepair(report);
      expect(sentence).toContain('unexpected error');
      expect(sentence).toContain('the book table exploded');
    } finally {
      setBookReadFault(null);
      await db.delete();
    }
  }, 20000);

  it('LOADS a stored legacy pointer through the app read path, and the ONE seam resolves it', async () => {
    // The upgrade cannot convert these rows (the pack is absent), so the LEGACY
    // POINTER stays on disk — exactly the shape the failure arm exists to
    // preserve, and exactly what the artifact read path must keep parsing.
    await seedLegacyV23({
      resolvedRoster: false,
      unresolvedRoster: true,
      resolvedNpc: false,
      unresolvedNpc: true,
      settingsRow: true,
    });
    const { db } = await import('@/db/db');
    await db.open();
    const { getArtifact } = await import('@/db/artifactRepo');

    // THE PROPERTY THE ORDER PROTECTS: `getArtifact` parses through
    // `anyArtifactSchema` (`db/artifactRepo.parseArtifactRow`), so a read that
    // no longer accepted the legacy shape would THROW right here — the cure
    // destroying the data the retry needs.
    const encounter = await getArtifact(ENCOUNTER);
    if (encounter?.kind !== 'encounter') throw new Error('encounter missing');
    expect(encounter.data.monsters[0]?.source).toEqual({
      type: 'rulebook',
      chunkId: '00000000-0000-4000-8000-0000000000ff',
    });
    const npc = await getArtifact(NPC);
    if (npc?.kind !== 'npc') throw new Error('npc missing');
    expect(npc.data.creatureRef).toEqual({ chunkId: '00000000-0000-4000-8000-0000000000ee' });

    // ...and the ONE legacy-read seam reads and resolves it: the entry is
    // dispatched to the legacy arm and answers the NAMED missing-ref reason,
    // because the library genuinely lacks the chunk.
    const entry = encounter.data.monsters[0];
    if (entry === undefined) throw new Error('roster entry missing');
    const resolved = await resolveStoredMonsterEntry(entry, LIBRARY_IS_ABSENT);
    expect(resolved.statBlock).toBeNull();
    expect(resolved.origin).toBe('missing ref (Ghost)');
    expect(resolved.missingRef).toEqual({ creature: 'Ghost' });
    await db.delete();
  }, 20000);

  it('still THROWS on a row that is neither the live shape nor a legacy pointer', async () => {
    await seedLegacyV23({
      resolvedRoster: false,
      unresolvedRoster: true,
      resolvedNpc: false,
      unresolvedNpc: false,
      settingsRow: true,
    });
    const { db } = await import('@/db/db');
    await db.open();
    const { anyArtifactSchema } = await import('@/domain');
    const row = await db.artifacts.get(ENCOUNTER);
    if (row?.kind !== 'encounter') throw new Error('encounter missing');
    const entry = row.data.monsters[0];
    if (entry === undefined) throw new Error('roster entry missing');
    // A source the model has never known. The legacy read is NOT a permissive
    // free-for-all parser: the read boundary must fail LOUDLY (AGENTS rule 1)
    // rather than fall through to a name-only row that silently loses the mob.
    expect(() =>
      anyArtifactSchema.parse({
        ...row,
        data: {
          ...row.data,
          monsters: [{ ...entry, source: { type: 'borrowed', chunkId: CHUNK } }],
        },
      }),
    ).toThrow();
    await db.delete();
  }, 20000);
});
