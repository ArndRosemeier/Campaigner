import 'fake-indexeddb/auto';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  createModule as buildModule,
  moduleSpineSchema,
  ruleChunkSchema,
  stampNewEntity,
  statBlockSchema,
  type AnyArtifact,
  type SpellData,
} from '@/domain';
import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { putChunks } from '@/db/chunkRepo';
import { saveModule } from '@/db/moduleRepo';
import { createPackBook, finalizePackBook } from '@/db/rulebookRepo';
import { foundryPf2eRulesAdapter } from '@/ingest/packs/pf2e-rules';
import { buildModulePdf, buildModulePdfDocument } from '@/lib/modulePdf';
import { clearDatabase } from '../db/helpers';

/**
 * A mob's spells reach the PRINTED stat box (docs/17 row 184) — the PDF half of
 * the chip surfaces. The bytes are the SAME `mobSpellChipDetail` the in-app chip
 * shows, so the book and the screen cannot disagree about what a spell does at
 * the rank the mob casts it.
 *
 * The definition is CAPTURED (the `generate` seam `buildModulePdf` already
 * takes) and asserted as text: pdfmake has no DOM here, and the document's own
 * JSON is the printable truth.
 */

const SPELL_FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'spells');

async function realSpell(file: string, packRelative: string): Promise<SpellData> {
  const bytes = new TextEncoder().encode(readFileSync(join(SPELL_FIXTURES, file), 'utf8'));
  const parsed = await foundryPf2eRulesAdapter.parseFile(packRelative, bytes);
  expect(parsed.failures).toEqual([]);
  const spell = parsed.sections?.[0]?.spell;
  if (spell === undefined) throw new Error(`fixture ${file} produced no spell payload`);
  return spell;
}

async function seedSpellBook(spell: SpellData): Promise<void> {
  const book = await createPackBook({
    title: 'PF2e Spells',
    system: 'pathfinder2e',
    filename: 'spells.json',
  });
  const finished = await finalizePackBook(book.id, {
    sourceId: 'test-spells',
    license: 'ORC',
    entriesImported: 1,
    entriesSkipped: 0,
    entriesFailed: 0,
  });
  await putChunks([
    ruleChunkSchema.parse({
      ...stampNewEntity(),
      bookId: finished.id,
      pageStart: 1,
      pageEnd: 1,
      chunkType: 'spell',
      headingPath: ['Spells', 'Fireball'],
      text: 'Fireball\nSource: Pathfinder Player Core (ORC)',
      statBlock: null,
      contentHash: 'd'.repeat(64),
      spellData: spell,
    }),
  ]);
}

async function seedModule(): Promise<{ module: Awaited<ReturnType<typeof saveModule>>; artifacts: AnyArtifact[] }> {
  const campaign = await createCampaign({ name: 'Ember', system: 'pathfinder2e' });
  const npc = await createArtifact({
    campaignId: campaign.id,
    kind: 'npc',
    name: 'Grix',
    body: 'She brews.',
    data: {
      appearance: 'Soot-stained',
      personality: 'Manic',
      statBlock: statBlockSchema.parse({
        system: 'pathfinder2e',
        level: '5',
        size: 'Small',
        creatureType: 'goblinoid',
        ac: 20,
        acNote: '',
        hp: 60,
        hpFormula: '',
        speed: '25 feet',
        abilities: { str: 14, dex: 16, con: 14, int: 16, wis: 12, cha: 10 },
        saves: '',
        skills: '',
        senses: '',
        languages: 'Goblin',
        traits: [],
        actions: [],
        reactions: [],
        legendary: [],
        extras: {},
        spells: [{ name: 'Fireball', castRank: 5 }],
      }),
    },
  });
  const module = await saveModule({
    ...buildModule({
      campaignId: campaign.id,
      title: 'Beneath the Docks',
      concept: 'A drowned vault.',
      levelMin: 1,
      levelMax: 5,
      tone: '',
      sizeDial: 'standard',
    }),
    spine: moduleSpineSchema.parse({
      premise: 'The alchemist [[Grix]] waits below.',
      themes: [],
      partPlan: [{ title: 'The Docks', levelBand: '1-5', synopsis: 'Meet the alchemist.', levelUpTrigger: 'None.' }],
    }),
  });
  return { module, artifacts: [npc] };
}

beforeEach(clearDatabase);

describe('a mob spell reaches the printed stat box (docs/17 row 184)', () => {
  it('prints the values at the CAST rank through the shared chip detail', async () => {
    await seedSpellBook(await realSpell('fireball.json', 'spells/spells/rank-3/fireball.json'));
    const { module, artifacts } = await seedModule();

    let captured: unknown = null;
    await buildModulePdf(module, artifacts, (definition) => {
      captured = definition;
      return Promise.resolve(new Blob(['pdf']));
    });

    const text = JSON.stringify(captured);
    expect(text).toContain('cast at rank 5: 10d6 fire');
    expect(text).toContain('heightening: interval');
  });

  it('prints a LOUD line — never a silent drop — when a direct build has no spell index', async () => {
    const { module, artifacts } = await seedModule();

    // `buildModulePdfDocument` is the sync seam a direct caller uses; it is
    // given no corpus, and the block's spell must still be visible in the book.
    const { definition } = buildModulePdfDocument({ module, artifacts });
    const text = JSON.stringify(definition);
    expect(text).toContain('resolved none');
    expect(text).toContain('re-export from the app');
  });
});
