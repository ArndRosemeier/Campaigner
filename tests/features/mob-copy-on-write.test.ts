import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { createArtifact } from '@/db/artifactRepo';
import { putChunks } from '@/db/chunkRepo';
import { createRulebook, updateRulebook } from '@/db/rulebookRepo';
import { getSettings } from '@/db/settingsRepo';
import { copyCreatureStatsFromDb } from '@/db/libraryCopy';
import { buildMobPickEntry } from '@/features/play/battle/spawn-picker-logic';
import { rosterMobCopyFor } from '@/llm/runEngine';
import { monsterEntrySchema, newId, ruleChunkSchema, stampNewEntity } from '@/domain';
import { sha256Hex } from '@/lib/hash';
import { clearDatabase } from '../db/helpers';

/**
 * COPY-ON-WRITE AT THE MOMENT A POINTER WOULD BE BORN (docs/17 row 255a).
 *
 * The v24 upgrade is a ONE-SHOT backfill while the app keeps MINTING pointers at
 * live write sites, so a migration-only design cannot satisfy the owner's rule
 * (*"Core items should always ever only be copied"*). This pins the two halves of
 * the answer:
 *
 * 1. EVERY write path copies through the SAME operation — driven here against
 *    ONE library fixture, the pure seam, the encounter generator's roster mint
 *    and the editor/battle pick must produce byte-identical copies (the
 *    differential form of AGENTS §Centralization obligation 2: a second copy
 *    mechanism drifts from the first, and no source scan can see it);
 * 2. the MIGRATION's backfill is that same operation — a legacy `rulebook`
 *    pointer converted by the seam equals what the write path produces today.
 */

const STAT_BLOCK = {
  system: 'dnd5e' as const,
  level: '1',
  size: 'Small',
  creatureType: 'humanoid',
  ac: 15,
  acNote: '',
  hp: 9,
  hpFormula: '2d6+2',
  speed: '30 ft.',
  abilities: { str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8 },
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

describe('copy-on-write: one copy operation, shared by the backfill and every write path', () => {
  beforeEach(clearDatabase);

  async function installLibrary(): Promise<{ campaignId: string; chunkId: string }> {
    const campaign = await createCampaign({ name: 'Copy on write', system: 'dnd5e' });
    const book = await createRulebook({
      title: 'Core Bestiary',
      system: 'dnd5e',
      filename: 'core.pdf',
    });
    await updateRulebook(book.id, { status: 'ready', pageCount: 320 });
    const text = 'Goblin Warrior, a test creature.';
    await putChunks([
      ruleChunkSchema.parse({
        ...stampNewEntity(),
        bookId: book.id,
        pageStart: 12,
        pageEnd: 12,
        chunkType: 'statblock',
        headingPath: ['Goblin Warrior'],
        text,
        statBlock: STAT_BLOCK,
        contentHash: await sha256Hex(text),
      }),
    ]);
    const { db } = await import('@/db/db');
    const [chunk] = await db.chunks.toArray();
    if (chunk === undefined) throw new Error('chunk missing');
    return { campaignId: campaign.id, chunkId: chunk.id };
  }

  it('the pure seam, the encounter generator and the picker produce ONE identical copy', async () => {
    const { chunkId } = await installLibrary();

    const pure = await copyCreatureStatsFromDb({ chunkId }, 'Goblin Warrior');
    if (pure.status !== 'copied') throw new Error('the library fixture must copy');
    const roster = await rosterMobCopyFor(chunkId, 'Goblin Warrior');
    const pick = await buildMobPickEntry(chunkId, 'Goblin Warrior');
    if (pick.source.type !== 'inline') throw new Error('the pick must be a copied block');

    const shape = {
      statBlock: pure.copy.statBlock,
      sourceLine: pure.copy.sourceLine,
      originToken: pure.copy.originToken,
    };
    expect(shape).toEqual({
      statBlock: STAT_BLOCK,
      // The label `creatureOriginLabel` used to compose at READ time, STAMPED.
      sourceLine: 'Core Bestiary p.12',
      // The opaque identity token keeps the creature's portrait slot.
      originToken: `chunk:${chunkId}`,
    });
    expect(roster).toEqual({
      source: { type: 'inline', statBlock: shape.statBlock },
      sourceLine: shape.sourceLine,
      originToken: shape.originToken,
    });
    expect({
      statBlock: pick.source.statBlock,
      sourceLine: pick.sourceLine,
      originToken: pick.originToken,
    }).toEqual(shape);
  });

  it('the MIGRATION backfill is the same operation: a converted pointer equals a fresh copy', async () => {
    const { campaignId, chunkId } = await installLibrary();
    const { db } = await import('@/db/db');
    // The migration persists its report into `settings`; the row is the ONE
    // place an unconverted row can be named to the user.
    await getSettings();
    const legacyEntry = monsterEntrySchema.parse({
      name: 'Goblin Warrior',
      count: 2,
      notes: '',
      treasure: '',
      source: { type: 'rulebook', chunkId, creatureName: 'Goblin Warrior' },
    });
    await createArtifact({
      campaignId,
      kind: 'encounter',
      name: 'Ember Vault',
      data: {
        difficulty: 'medium',
        levelHint: '3',
        monsters: [legacyEntry],
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

    const { repairMobCopies } = await import('@/db/mobCopyRepair');
    const report = await db.transaction(
      'rw',
      [db.artifacts, db.chunks, db.rulebooks, db.settings],
      (tx) => repairMobCopies({ tx, reason: 'upgrade' }),
    );
    expect(report.rosterMobsCopied).toBe(1);
    expect(report.unconverted).toEqual([]);

    const encounter = (await db.artifacts.toArray()).find((row) => row.kind === 'encounter');
    if (encounter?.kind !== 'encounter') throw new Error('encounter missing');
    const converted = encounter.data.monsters[0];
    if (converted === undefined) throw new Error('roster entry missing');
    // NO pointer is left: the row is the live `inline` representation.
    expect(converted.source.type).toBe('inline');

    const fresh = await rosterMobCopyFor(chunkId, 'Goblin Warrior');
    expect(converted.source).toEqual(fresh.source);
    expect(converted.sourceLine).toBe(fresh.sourceLine);
    expect(converted.originToken).toBe(fresh.originToken);
    // The stored row parses as the live model — nothing legacy survives.
    const parsed = monsterEntrySchema.parse(converted);
    expect(parsed.source.type).toBe('inline');
  });

  it('writes NO pointer for a chunk that vanished — it refuses instead', async () => {
    const { campaignId } = await installLibrary();
    expect(campaignId).not.toBe('');
    await expect(rosterMobCopyFor(newId(), 'Ghost')).rejects.toThrow(/not in this workspace/);
    await expect(buildMobPickEntry(newId(), 'Ghost')).rejects.toThrow(/not in this workspace/);
  });
});
