import 'fake-indexeddb/auto';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { putChunks } from '@/db/chunkRepo';
import { createPackBook, finalizePackBook } from '@/db/rulebookRepo';
import {
  ruleChunkSchema,
  spellDataSchema,
  stampNewEntity,
  statBlockSchema,
  type Id,
  type RuleChunk,
  type SpellData,
  type StatBlock,
} from '@/domain';
import { StatBlockCard } from '@/features/campaign/components/stat-block';
import { foundryPf2eRulesAdapter } from '@/ingest/packs/pf2e-rules';
import { clearDatabase } from '../db/helpers';

/**
 * The mob's spells as CHIPS (docs/17 row 184): the ONE `StatBlockCard` every
 * stat-block surface renders gains the section, a name that does not resolve
 * renders the UNRESOLVED state with the name visible, and the chip's detail is
 * `spellAtRank`'s output at the cast rank.
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

let seq = 0;
async function seedSpells(spells: readonly { name: string; data: SpellData }[]): Promise<Id> {
  const book = await createPackBook({
    title: 'PF2e Spells',
    system: 'pathfinder2e',
    filename: 'spells.json',
  });
  const finished = await finalizePackBook(book.id, {
    sourceId: 'test-spells',
    license: 'ORC',
    entriesImported: spells.length,
    entriesSkipped: 0,
    entriesFailed: 0,
  });
  const chunks: RuleChunk[] = spells.map((spell) => {
    seq += 1;
    return ruleChunkSchema.parse({
      ...stampNewEntity(),
      bookId: finished.id,
      pageStart: 1,
      pageEnd: 1,
      chunkType: 'spell',
      headingPath: ['Spells', spell.name],
      text: `${spell.name}\nSource: Pathfinder Player Core (ORC)`,
      statBlock: null,
      contentHash: 'c'.repeat(63) + String(seq % 10),
      spellData: spell.data,
    });
  });
  await putChunks(chunks);
  return finished.id;
}

function block(over: Record<string, unknown> = {}): StatBlock {
  return statBlockSchema.parse({
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
    ...over,
  });
}

beforeEach(async () => {
  await clearDatabase();
  seq = 0;
});
afterEach(cleanup);

describe('a mob stat block renders its spells as chips (docs/17 row 184)', () => {
  it('renders a resolved chip whose detail is the heightened values, and an unresolved chip by name', async () => {
    const fireball = await realSpell('fireball.json', 'spells/spells/rank-3/fireball.json');
    await seedSpells([{ name: 'Fireball', data: fireball }]);

    render(
      <StatBlockCard
        name="Grix"
        statBlock={block({
          spells: [
            { name: 'Fireball', castRank: 5 },
            { name: 'Flameball', castRank: 3 },
          ],
        })}
      />,
    );

    const section = await screen.findByTestId('mob-spells');
    const resolved = await within(section).findByTestId('spell-chip');
    expect(resolved).toHaveTextContent('Fireball');
    // Heightened to the CAST rank through the ONE rule (rank 5 → 10d6).
    expect(resolved.getAttribute('title')).toContain('cast at rank 5: 10d6 fire');
    expect(resolved.getAttribute('title')).toContain('heightening: interval');

    // The invented name is NOT hidden and NOT blank: the unresolved state.
    const unresolved = within(section).getByTestId('spell-chip-unresolved');
    expect(unresolved).toHaveTextContent('Flameball');
    expect(unresolved.getAttribute('data-spell-unresolved')).toBe('Flameball');

    // …and the loud issue names both halves.
    const issues = within(section).getByTestId('mob-spell-issues');
    expect(issues).toHaveTextContent('Flameball');
    expect(issues).toHaveTextContent('Grix');
  });

  it('auto-heightens a cantrip from the mob level, with no rank chosen by the caller', async () => {
    const ignition = await realSpell('ignition.json', 'spells/spells/cantrip/ignition.json');
    await seedSpells([{ name: 'Ignition', data: ignition }]);

    render(<StatBlockCard name="Grix" statBlock={block({ spells: [{ name: 'Ignition' }] })} />);

    const section = await screen.findByTestId('mob-spells');
    const chip = await within(section).findByTestId('spell-chip');
    const title = chip.getAttribute('title') ?? '';
    expect(title).toContain('cast at rank 3');
    expect(title).toContain('cantrip, auto-heightened from the caster');
    expect(title).toContain('4d4 fire');
  });

  it('a LEGACY stat block without the field renders exactly as today — no chip section', async () => {
    await seedSpells([]);
    render(<StatBlockCard name="Grix" statBlock={block()} />);
    expect(await screen.findByText('Level 5')).toBeInTheDocument();
    expect(screen.queryByTestId('mob-spells')).not.toBeInTheDocument();
  });

  it('an authored EMPTY list is the same as no spells — nothing to show, nothing to error', async () => {
    await seedSpells([]);
    render(<StatBlockCard name="Grix" statBlock={block({ spells: [] })} />);
    expect(await screen.findByText('Level 5')).toBeInTheDocument();
    expect(screen.queryByTestId('mob-spells')).not.toBeInTheDocument();
  });

  it('renders a spell whose heightening is prose-only without inventing a number', async () => {
    const prosey = spellDataSchema.parse({
      system: 'pathfinder2e',
      rank: 3,
      cantrip: false,
      traditions: ['arcane'],
      traits: [],
      rarity: 'common',
      cast: { time: '', range: '', target: '', duration: '' },
      damage: { '0': { formula: '1d6', type: 'fire', category: null, materials: [] } },
      heightening: null,
      heighteningEntries: [{ kind: 'fixed', rank: 5, text: 'The damage increases to 3d6.' }],
      heighteningUnparsed: [],
      publication: null,
    });
    await seedSpells([{ name: 'Prosey', data: prosey }]);

    render(
      <StatBlockCard name="Grix" statBlock={block({ spells: [{ name: 'Prosey', castRank: 5 }] })} />,
    );

    const section = await screen.findByTestId('mob-spells');
    const chip = await within(section).findByTestId('spell-chip');
    const title = chip.getAttribute('title') ?? '';
    expect(title).toContain('The damage increases to 3d6.');
    expect(title).toContain('prose-only');
    expect(title).toContain('cast at rank 5: 1d6 fire');
  });
});
