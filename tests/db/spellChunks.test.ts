import 'fake-indexeddb/auto';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { ruleChunkSchema, stampNewEntity, type RuleChunk } from '@/domain';
import { db } from '@/db/db';
import { putChunks } from '@/db/chunkRepo';
import { importPack } from '@/ingest/packImport';
import { FOUNDRY_PF2E_RULES_ADAPTER_ID } from '@/ingest/packs/pf2e-rules';

import { clearDatabase } from './helpers';

/**
 * The spells arc's DATA half end-to-end at the repo boundary (docs/12 §15):
 * a real PF2e rules import persists `chunkType: 'spell'` rows carrying their
 * validated payload, and the indexed `chunkType` list query is how a spell
 * list page will find them. No UI here — the list/filter/chip slice is a
 * separate follow-up.
 */

const FIXTURE_DIR = join(import.meta.dirname, '..', 'fixtures', 'packs', 'pf2e-rules');

function fixtureBytes(name: string): Uint8Array {
  return new TextEncoder().encode(readFileSync(join(FIXTURE_DIR, name), 'utf8'));
}

describe('structured spell chunks persist and are queryable (docs/12 §15)', () => {
  beforeEach(clearDatabase);

  it('imports a real spell document as a `spell` chunk found by the indexed type query', async () => {
    const result = await importPack(
      FOUNDRY_PF2E_RULES_ADAPTER_ID,
      [
        { name: 'spells/spells/cantrip/acid-splash.json', bytes: fixtureBytes('acid-splash.json') },
        { name: 'feats/skill/level-1/cat-fall.json', bytes: fixtureBytes('cat-fall.json') },
      ],
      { title: 'PF2e rules (spell slice)' },
    );
    expect(result.sectionsImported).toBe(2);

    const spells = await db.chunks.where('chunkType').equals('spell').toArray();
    expect(spells).toHaveLength(1);
    const spell = spells[0];
    expect(spell?.headingPath).toEqual(['Spells — Cantrip', 'Acid Splash']);
    expect(spell?.spellData).toMatchObject({
      system: 'pathfinder2e',
      rank: 0,
      cantrip: true,
      traditions: ['arcane', 'primal'],
      rarity: 'common',
    });

    // The feat is still a `section` chunk and the spell query cannot see it.
    const sections = await db.chunks.where('chunkType').equals('section').toArray();
    expect(sections.map((chunk) => chunk.headingPath.at(-1))).toEqual(['Cat Fall']);
  });

  it('keeps a pre-arc row readable and out of the spell list (no migration, no guessing)', async () => {
    // A row written before the arc, exactly as it sits in an existing library.
    const legacy: RuleChunk = ruleChunkSchema.parse({
      ...stampNewEntity(1),
      bookId: crypto.randomUUID(),
      pageStart: 1,
      pageEnd: 1,
      chunkType: 'section',
      headingPath: ['Spells — Cantrip', 'Acid Splash'],
      text: 'Acid Splash\nCantrip 1',
      statBlock: null,
      contentHash: 'a'.repeat(64),
    });
    await putChunks([legacy]);

    const spells = await db.chunks.where('chunkType').equals('spell').toArray();
    expect(spells).toEqual([]);
    // It still parses and reads as the section it always was.
    const [read] = await db.chunks.where('chunkType').equals('section').toArray();
    expect(read?.spellData).toBeUndefined();
  });
});
