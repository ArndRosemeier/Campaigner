import 'fake-indexeddb/auto';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  newId,
  ruleChunkSchema,
  stampNewEntity,
  statBlockSchema,
  type MonsterEntry,
} from '@/domain';
import { putChunks } from '@/db/chunkRepo';
import { createPackBook, finalizePackBook } from '@/db/rulebookRepo';
import { sha256Hex } from '@/lib/hash';
import { MonsterSourceControls } from '@/features/campaign/components/monster-source';
import { clearDatabase } from '../db/helpers';

/**
 * The editor's rulebook-link dialog writes a CITATION (docs/11 §Content
 * identity at citation birth) — and since docs/17 row 155 that citation also
 * names the book the chunk came from, so a strand this dialog creates can tell
 * a GM which pack to install. This is the ONE behavioural pin over that call
 * site: the pick is driven through the real dialog (real search over the real
 * library) and the citation is read off `onChange`.
 */

function statBlock(): unknown {
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

function entry(): MonsterEntry {
  return {
    name: 'Goblin Warrior',
    count: 1,
    notes: '',
    treasure: '',
    // A rulebook citation already in place: that is the row state whose
    // "Change rulebook stat block" affordance opens the search dialog.
    source: { type: 'rulebook', chunkId: newId() },
  };
}

beforeEach(clearDatabase);
afterEach(cleanup);

describe('the rulebook-link dialog stamps the pack of the chunk it cites', () => {
  it('carries the book title through the search hit into the citation it writes', async () => {
    const user = userEvent.setup();
    // A READY book: the dialog's pool is the library's citable books
    // (`readyBookIds`), exactly as in the app.
    const book = await createPackBook({
      title: 'Monster Core',
      system: 'pathfinder2e',
      filename: 'monster-core.zip',
    });
    await finalizePackBook(book.id, {
      sourceId: 'foundry-pf2e',
      license: 'Community Use Policy',
      entriesImported: 1,
      entriesSkipped: 0,
      entriesFailed: 0,
    });
    const text = 'Goblin Warrior\nThis stat block belongs to a goblin.';
    const contentHash = await sha256Hex(text);
    const chunkId = newId();
    await putChunks([
      ruleChunkSchema.parse({
        ...stampNewEntity(),
        id: chunkId,
        bookId: book.id,
        pageStart: 1,
        pageEnd: 1,
        chunkType: 'statblock',
        headingPath: ['Goblin Warrior'],
        text,
        statBlock: statBlock(),
        contentHash,
      }),
    ]);

    const onChange = vi.fn();
    render(
      <MonsterSourceControls
        entry={entry()}
        campaignArtifacts={[]}
        campaignSystem="pathfinder2e"
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Change rulebook stat block' }));
    await user.type(screen.getByPlaceholderText('Search stat blocks…'), 'Goblin');
    await user.click(await screen.findByText('Goblin Warrior', { selector: 'span' }));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalled();
    });
    const picked = onChange.mock.calls[0]?.[0] as MonsterEntry | undefined;
    // The book title is the library's OWN row title: the same identity
    // `creatureOriginLabel` prints for a creature of this book.
    expect(picked?.source).toEqual({
      type: 'rulebook',
      chunkId,
      contentHash,
      creatureName: 'Goblin Warrior',
      bookTitle: 'Monster Core',
    });
  });
});
