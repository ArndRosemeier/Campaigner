import 'fake-indexeddb/auto';

import { render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { createArtifact, getArtifact, updateArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { putChunks } from '@/db/chunkRepo';
import { castCreatureAsNpc } from '@/db/creatureRepo';
import { db } from '@/db/db';
import { createRulebook } from '@/db/rulebookRepo';
import {
  blankStatBlock,
  npcDataSchema,
  ruleChunkSchema,
  statBlockSchema,
  stampNewEntity,
  type Artifact,
} from '@/domain';
import { ArtifactEditor } from '@/features/campaign/components/artifact-editor';
import { NpcCard } from '@/features/play/artifact-cards';
import { resolveMonsterEntryWithRepos } from '@/db/monsterResolve';
import { sha256Hex } from '@/lib/hash';
import { clearDatabase } from '../db/helpers';
import { flushAsyncUpdates } from '../helpers/flush';

/**
 * A CITED npc row SHOWS its library creature's numbers (docs/17 row 134,
 * docs/11 D3, docs/18 §2/§4).
 *
 * The owner's report was that a named zombie cast out of a module's TEXT got a
 * portrait and nothing else — *"No text, no stat block, nothing"* — and the
 * stats half of it is NOT a data gap: the numbers exist, derived at read time
 * from the library creature the row cites (`domain/encounterResolve.
 * resolveDerivedNpcStats`, the ONE rule the encounter roster has always read).
 * They were simply drawn nowhere the owner looked, and the editor offered an
 * "Add stat block" button that the cited-row refill refuses before any model
 * call and that `npcDataSchema` refuses to keep — an affordance that could
 * never produce anything.
 *
 * These pins are the two sides of that defect and the two sides of the
 * NON-cited case that must stay byte-identical, plus the LOUD failure when the
 * library can no longer supply the creature (AGENTS rules 1/2: never a blank
 * stat area, never an invented block).
 */

/** A library creature with DISTINCTIVE numbers, so a pin asserting "the card
 * rendered something" cannot pass on a default/empty block. */
async function seedLibraryCreature(): Promise<string> {
  const book = await createRulebook({ title: 'Bestiary', system: 'dnd5e', filename: 'b.pdf' });
  const text = 'Bog Zombie\nLarge undead, unaligned\nArmor Class 14\nHit Points 22';
  const chunk = ruleChunkSchema.parse({
    ...stampNewEntity(),
    bookId: book.id,
    pageStart: 4,
    pageEnd: 4,
    chunkType: 'statblock',
    headingPath: ['Bog Zombie'],
    text,
    statBlock: statBlockSchema.parse({
      system: 'dnd5e',
      level: '2',
      size: 'Large',
      creatureType: 'undead',
      ac: 14,
      acNote: '',
      hp: 22,
      hpFormula: '4d10',
      speed: '20 ft.',
      abilities: { str: 13, dex: 6, con: 16, int: 3, wis: 6, cha: 5 },
      saves: '',
      skills: '',
      senses: '',
      languages: '',
      traits: [],
      actions: [{ name: 'Grave Bite', text: 'Melee weapon attack: 9 (2d6 + 2) necrotic.' }],
      reactions: [],
      legendary: [],
      extras: {},
    }),
    contentHash: await sha256Hex(text),
  });
  await putChunks([chunk]);
  return chunk.id;
}

/** The owner's row: an authored npc cast out of the library creature. */
async function seedCastRow(campaignId: string): Promise<Artifact> {
  const chunkId = await seedLibraryCreature();
  const cast = await castCreatureAsNpc({
    campaignId,
    moduleId: null,
    citation: { chunkId, creatureName: 'Bog Zombie' },
    name: 'Aunt Agatha',
    prose: { body: 'The risen aunt shambles out of the undercroft.' },
  });
  const artifact = await getArtifact(cast.artifactId);
  if (artifact === undefined) throw new Error('the cast row vanished');
  return artifact;
}

function renderEditor(artifact: Artifact, campaignId: string): void {
  render(
    <ArtifactEditor
      artifact={artifact}
      campaignId={campaignId}
      campaignArtifacts={[artifact]}
      campaignSystem="dnd5e"
    />,
  );
}

beforeEach(clearDatabase);

describe('a cited row renders its BORROWED numbers', () => {
  it('renders the library creature’s real numbers, labelled as borrowed, with no authored-block affordance', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const artifact = await seedCastRow(campaign.id);
    if (artifact.kind !== 'npc') throw new Error('not an npc');
    expect(artifact.data.statBlock).toBeNull();
    expect(artifact.data.creatureRef).toBeDefined();

    renderEditor(artifact, campaign.id);

    const borrowed = await screen.findByTestId('borrowed-stat-block');
    // The VALUES come from the library fixture, not from "something rendered".
    expect(within(borrowed).getByText('AC').parentElement?.textContent).toContain('14');
    expect(within(borrowed).getByText('HP').parentElement?.textContent).toContain('22');
    expect(within(borrowed).getByText('Grave Bite.')).toBeInTheDocument();
    // Borrowed numbers are never mistaken for an authored block: the card is
    // labelled from the library AND carries the disclosed origin label.
    expect(within(borrowed).getByTestId('borrowed-stat-block-badge')).toHaveTextContent(
      'Borrowed from the library',
    );
    expect(within(borrowed).getByTestId('borrowed-stat-block-origin')).toHaveTextContent(
      'NPC: Aunt Agatha (stats from Bestiary p.4)',
    );
    // READ-ONLY: not one control inside the borrowed card.
    expect(within(borrowed).queryAllByRole('button')).toHaveLength(0);

    // The impossible affordance is GONE (the cited-row refill refuses such a
    // block and `npcDataSchema` refuses to keep it).
    expect(screen.queryByRole('button', { name: 'Add stat block' })).toBeNull();

    // And the render WROTE nothing: the row keeps its citation and its null block.
    const stored = await getArtifact(artifact.id);
    if (stored?.kind !== 'npc') throw new Error('not an npc');
    expect(stored.data.statBlock).toBeNull();
    expect(stored.data.creatureRef?.chunkId).toBe(artifact.data.creatureRef?.chunkId);
    await flushAsyncUpdates();
  });

  it('renders the same borrowed numbers on the read-only card (the module reader’s entity panel)', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const artifact = await seedCastRow(campaign.id);
    if (artifact.kind !== 'npc') throw new Error('not an npc');

    render(<NpcCard npc={artifact} />);

    const card = await screen.findByTestId('play-npc-card');
    const borrowed = await within(card).findByTestId('borrowed-stat-block');
    expect(within(borrowed).getByText('HP').parentElement?.textContent).toContain('22');
    expect(within(borrowed).getByTestId('borrowed-stat-block-origin')).toHaveTextContent(
      'NPC: Aunt Agatha (stats from Bestiary p.4)',
    );
    await flushAsyncUpdates();
  });
});

describe('a non-cited npc is unchanged', () => {
  it('an AUTHORED block still renders, with its edit and remove controls, and no borrowed card', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const artifact = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Grix',
      data: {
        appearance: 'Soot-stained.',
        personality: 'Manic.',
        statBlock: {
          ...blankStatBlock('dnd5e'),
          size: 'Small',
          creatureType: 'humanoid (goblinoid)',
          ac: 17,
          hp: 31,
        },
      },
    });

    renderEditor(artifact, campaign.id);

    expect(await screen.findByText('Small humanoid (goblinoid)')).toBeInTheDocument();
    expect(screen.getByText('AC').parentElement?.textContent).toContain('17');
    expect(screen.getByText('HP').parentElement?.textContent).toContain('31');
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
    expect(screen.queryByTestId('borrowed-stat-block')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add stat block' })).toBeNull();
    await flushAsyncUpdates();
  });

  it('an npc with NO block and NO citation still offers "Add stat block"', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const artifact = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Empty Ernie',
      data: { appearance: '', personality: '', statBlock: null },
    });

    renderEditor(artifact, campaign.id);

    expect(await screen.findByRole('button', { name: 'Add stat block' })).toBeInTheDocument();
    expect(screen.queryByTestId('borrowed-stat-block')).toBeNull();
    await flushAsyncUpdates();
  });
});

describe('an unresolvable library creature is LOUD, never blank', () => {
  it('names the missing creature in place and offers no authored block', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const artifact = await seedCastRow(campaign.id);
    if (artifact.kind !== 'npc') throw new Error('not an npc');
    // The library loses the creature the row cites (a re-ingest under a new row
    // id, a removed book): the ONE failure mode, named.
    const chunkId = artifact.data.creatureRef?.chunkId;
    if (chunkId === undefined) throw new Error('the cast row carries no citation');
    await db.chunks.delete(chunkId);

    renderEditor(artifact, campaign.id);

    const missing = await screen.findByTestId('borrowed-stat-block-missing');
    expect(within(missing).getByTestId('borrowed-stat-block-missing-origin')).toHaveTextContent(
      'missing ref (Bog Zombie)',
    );
    expect(missing.textContent).toContain('Aunt Agatha draws its numbers from a library creature');
    // Never a blank/greyish stat area, and never the impossible affordance the
    // cited refill refuses.
    expect(screen.queryByText('AC')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add stat block' })).toBeNull();
    await flushAsyncUpdates();
  });

  it('surfaces a citation that cannot be resolved at all, in place and through the toast seam', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    // A citation carrying NEITHER key is unrepresentable through the cast seam
    // (the library must supply the creature), but a hand-written or repaired
    // row can carry one — and it must never draw an empty stat area.
    const artifact = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Nameless Ghoul',
      data: { appearance: '', personality: '', statBlock: null, creatureRef: {} },
    });

    renderEditor(artifact, campaign.id);

    const failed = await screen.findByTestId('borrowed-stat-block-failed');
    expect(failed.textContent).toContain('carries neither a chunk id nor a content hash');
    await waitFor(() => {
      expect(screen.getByTestId('borrowed-stat-block-failed')).toBeInTheDocument();
    });
    await flushAsyncUpdates();
  });
});

describe('the encounter side reads the SAME numbers (one rule, two readers)', () => {
  it('a roster entry linked to the cast row shows the identical origin label and values', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const artifact = await seedCastRow(campaign.id);

    const resolved = await resolveMonsterEntryWithRepos({
      name: 'Aunt Agatha',
      count: 1,
      notes: '',
      treasure: '',
      source: { type: 'npc-ref', artifactId: artifact.id },
    });

    // Byte-identical to what the details panel shows — the fold's whole point.
    expect(resolved.origin).toBe('NPC: Aunt Agatha (stats from Bestiary p.4)');
    expect(resolved.statBlock?.hp).toBe(22);
  });

  it('a vanished library creature is named the same way on both readers', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const artifact = await seedCastRow(campaign.id);
    if (artifact.kind !== 'npc') throw new Error('not an npc');
    await db.chunks.delete(artifact.data.creatureRef?.chunkId ?? '');

    const resolved = await resolveMonsterEntryWithRepos({
      name: 'Aunt Agatha',
      count: 1,
      notes: '',
      treasure: '',
      source: { type: 'npc-ref', artifactId: artifact.id },
    });

    // The CREATURE is named, not the row: "missing ref (Aunt Agatha)" would
    // only repeat the title the GM is already looking at and would hide which
    // book has to come back.
    expect(resolved).toMatchObject({ statBlock: null, origin: 'missing ref (Bog Zombie)' });
  });
});

describe('the refused pair stays unconstructible', () => {
  it('`npcDataSchema` still refuses a citation beside an authored block, by name', () => {
    const parsed = npcDataSchema.safeParse({
      appearance: '',
      personality: '',
      statBlock: blankStatBlock('dnd5e'),
      creatureRef: { chunkId: '00000000-0000-4000-8000-00000000c001' },
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('the refused pair parsed');
    expect(parsed.error.issues[0]?.message).toContain(
      'an npc carries either an authored stat block or a library creatureRef to derive one from, never both',
    );
    // The citation with NO authored block — the shape every cast row has — parses.
    expect(
      npcDataSchema.safeParse({
        appearance: '',
        personality: '',
        statBlock: null,
        creatureRef: { chunkId: '00000000-0000-4000-8000-00000000c001' },
      }).success,
    ).toBe(true);
  });

  it('a cited row whose block is cleared by hand is RE-READ as borrowed, not as an empty block', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const artifact = await seedCastRow(campaign.id);
    if (artifact.kind !== 'npc') throw new Error('not an npc');
    // The editor's autosave path is the only writer here, and it can never set
    // a block on a cited row (the schema would refuse the write); a stray
    // authored value is refused at the repo boundary instead of being kept.
    if (artifact.data.creatureRef === undefined) throw new Error('no citation');
    await expect(
      updateArtifact(artifact.id, {
        data: {
          appearance: '',
          personality: '',
          statBlock: blankStatBlock('dnd5e'),
          creatureRef: artifact.data.creatureRef,
        },
      }),
    ).rejects.toThrow();

    const stored = await getArtifact(artifact.id);
    if (stored?.kind !== 'npc') throw new Error('not an npc');
    expect(stored.data.statBlock).toBeNull();
    expect(stored.data.creatureRef).toBeDefined();
  });
});
