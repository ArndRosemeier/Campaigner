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
 * The editor's rulebook-link dialog COPIES the chunk it picks (docs/17 row
 * 255a; the owner's rule is that a core item is only ever copied) — and the
 * copy's stamped origin line names the book the chunk came from, so a mob can
 * still tell a GM where its numbers came from. This is the ONE behavioural pin
 * over that call site: the pick is driven through the real dialog (real search
 * over the real library) and the copy is read off `onChange`.
 *
 * FIXED FORWARD at docs/17 row 255b: the assertion below still expected the
 * retired `rulebook` POINTER, so this file was RED at row 255a's HEAD — the
 * picker had already moved to the copy and this pin had not. The pin's intent
 * (the pick carries the library's own title) is unchanged; only the shape it is
 * carried in moved.
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

describe('the rulebook-link dialog COPIES the chunk it picks and stamps its pack', () => {
  it('carries the library block and the pack title into the copy it writes', async () => {
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
    // NO POINTER: the picked chunk's bytes are copied onto the row.
    expect(picked?.source).toEqual({ type: 'inline', statBlock: statBlock() });
    // The stamped origin line names the LIBRARY's own title (a pack book names
    // the heading): the same identity `creatureOriginLabel` composes.
    expect(picked?.sourceLine).toBe('Monster Core: Goblin Warrior');
    // The opaque token keeps the creature's portrait slot without a live read.
    expect(picked?.originToken).toBe(`chunk:${chunkId}`);
  });
});
