import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect } from 'vitest';

import { putChunks } from '@/db/chunkRepo';
import { createPackBook, finalizePackBook } from '@/db/rulebookRepo';
import {
  ruleChunkSchema,
  stampNewEntity,
  type GameSystem,
  type SpellData,
} from '@/domain';
import { foundryPf2eRulesAdapter } from '@/ingest/packs/pf2e-rules';

/**
 * THE shared spell-corpus harness (docs/17 row 373).
 *
 * WHY IT EXISTS: six test files each carried their own `realSpell`, and the
 * duplicate tripwire (`tests/architecture/no-duplicate-implementations.test.ts`)
 * had blessed that population in its baseline; the player-character pins needed
 * the same read and a `seedCorpus`/`lastPrompt` pair, and a seventh private copy
 * would have been a new blessing of the very duplication AGENTS rule 4 forbids.
 * The copies are therefore FOLDED here and the baseline entry is deleted — ONE
 * fixture reader, ONE corpus seeder, ONE prompt reader, so a test harness cannot
 * drift from the others. The fixtures under `tests/fixtures/**` are the captured
 * upstream corpus and are read through the REAL adapter, never hand-built.
 */
export const SPELL_FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'spells');

export async function realSpell(file: string, packRelative: string): Promise<SpellData> {
  const bytes = new TextEncoder().encode(readFileSync(join(SPELL_FIXTURES, file), 'utf8'));
  const parsed = await foundryPf2eRulesAdapter.parseFile(packRelative, bytes);
  expect(parsed.failures).toEqual([]);
  const spell = parsed.sections?.[0]?.spell;
  if (spell === undefined) throw new Error(`fixture ${file} produced no spell payload`);
  return spell;
}

/** The user turn of one chat call — the prompt the model actually received. */
export function userPromptOf(
  call: readonly { role: string; content: unknown }[] | undefined,
): string {
  const content = call?.at(-1)?.content;
  return typeof content === 'string' ? content : '';
}

/**
 * Seeds the campaign's OWN system with the REAL Fireball + Ignition payloads
 * (the two spells every spell-bearing lane's corpus pins use). The chunk hashes
 * are position-derived: the corpus is seeded into a cleared database, so two
 * distinct digits are unique within it and no cross-call state is needed.
 */
export async function seedSpellCorpus(system: GameSystem): Promise<void> {
  const spells: readonly (readonly [string, SpellData])[] = [
    ['Fireball', await realSpell('fireball.json', 'spells/spells/rank-3/fireball.json')],
    ['Ignition', await realSpell('ignition.json', 'spells/spells/cantrip/ignition.json')],
  ];
  const book = await createPackBook({ title: 'Spells', system, filename: 'spells.json' });
  const finished = await finalizePackBook(book.id, {
    sourceId: 'test-spells',
    license: 'ORC',
    entriesImported: spells.length,
    entriesSkipped: 0,
    entriesFailed: 0,
  });
  await putChunks(
    spells.map(([name, spellData], index) =>
      ruleChunkSchema.parse({
        ...stampNewEntity(),
        bookId: finished.id,
        pageStart: 1,
        pageEnd: 1,
        chunkType: 'spell',
        headingPath: ['Spells', name],
        text: `${name}\nSource: Pathfinder Player Core (ORC)`,
        statBlock: null,
        spellData,
        contentHash: 'b'.repeat(63) + String(index),
      }),
    ),
  );
}
