import { putChunks } from '@/db/chunkRepo';
import { db } from '@/db/db';
import { ruleChunkSchema, stampNewEntity, statBlockSchema, type Id, type StatBlock } from '@/domain';
import { sha256Hex } from '@/lib/hash';

/**
 * The shared SPAWN PICKER fixtures (docs/17 row 333): the plain dnd5e stat
 * block and the ready-book stat-block chunk that the picker's pins seed their
 * roster, NPCs and core mobs with. The test-tree duplication tripwire
 * (`no-duplicate-implementations`) redded the second spellings the illustrate
 * fill's and the author-and-spawn pins' own files would have been — ONE copy
 * lives here instead. (The module's battle row comes from the EXISTING
 * `tests/helpers/battle-surface-route.currentBattle`; a second reader here was
 * the tripwire's other finding.)
 */

/** A minimal but complete dnd5e block at `level` with `hp` hit points. */
export function spawnPickerStatBlock(level: string, hp: number): StatBlock {
  return statBlockSchema.parse({
    system: 'dnd5e',
    level,
    size: 'Medium',
    creatureType: 'humanoid',
    ac: 12,
    acNote: '',
    hp,
    hpFormula: '',
    speed: '30 ft.',
    abilities: { str: 10, dex: 14, con: 12, int: 10, wis: 10, cha: 10 },
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

/**
 * Persist ONE ready-book `statblock` chunk named `name` and return its id — the
 * core-mob pick's citation read is a chunk lookup, so the fixture is the chunk.
 */
export async function addSpawnPickerChunk(
  bookId: Id,
  name: string,
  level: string,
  hp: number,
): Promise<Id> {
  const text = `${name}, a test creature of level ${level}.`;
  await putChunks([
    ruleChunkSchema.parse({
      ...stampNewEntity(),
      bookId,
      pageStart: 1,
      pageEnd: 1,
      chunkType: 'statblock',
      headingPath: [name],
      text,
      statBlock: spawnPickerStatBlock(level, hp),
      contentHash: await sha256Hex(text),
    }),
  ]);
  const chunk = await db.chunks
    .where('bookId')
    .equals(bookId)
    .and((row) => row.headingPath[0] === name)
    .first();
  if (chunk === undefined) throw new Error(`chunk ${name} missing`);
  return chunk.id;
}
