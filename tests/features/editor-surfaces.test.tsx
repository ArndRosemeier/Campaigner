import 'fake-indexeddb/auto';

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { createArtifact, getArtifact, listRevisions, updateArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { blankStatBlock, type Artifact, type ArtifactLink, type StatBlock } from '@/domain';
import { ArtifactEditor } from '@/features/campaign/components/artifact-editor';
import { clearDatabase } from '../db/helpers';
import { flushAsyncUpdates } from '../helpers/flush';

/**
 * Editor sub-surfaces that no dedicated test interacted with (08-TESTING
 * matrix): markdown preview toggle, tag editor, links section, stat block
 * card/form toggle, and the revision dropdown → snapshot → restore flow.
 */

const NPC_DATA = {
  role: 'Boss',
  appearance: 'Small, soot-stained.',
  personality: 'Manic, cheerful.',
  motivation: 'Prove her elixirs work.',
  secrets: 'Out of good reagents.',
  voiceNotes: 'Fast, cackling.',
  statBlock: null,
};

function testStatBlock(): StatBlock {
  return {
    ...blankStatBlock('dnd5e'),
    level: '3',
    size: 'Small',
    creatureType: 'humanoid (goblinoid)',
    ac: 14,
    acNote: 'leather armor',
    hp: 22,
    hpFormula: '5d6 + 5',
    speed: '30 ft.',
    abilities: { str: 8, dex: 16, con: 13, int: 14, wis: 10, cha: 12 },
    languages: 'Common, Goblin',
    traits: [{ name: 'Nimble Escape', text: 'Disengage or hide as a bonus action.' }],
    extras: { CR: '1' },
  };
}

async function seedNpc(extra?: {
  statBlock?: StatBlock | null;
  links?: ArtifactLink[];
}): Promise<{ npc: Artifact; forge: Artifact }> {
  const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
  const forge = await createArtifact({
    campaignId: campaign.id,
    kind: 'location',
    name: 'Forge',
  });
  const npc = await createArtifact({
    campaignId: campaign.id,
    kind: 'npc',
    name: 'Grix',
    summary: 'Goblin alchemist boss.',
    body: '# Grix\nShe brews.',
    tags: ['goblin'],
    links: extra?.links ?? [],
    data: { ...NPC_DATA, statBlock: extra?.statBlock ?? null },
  });
  return { npc, forge };
}

beforeEach(clearDatabase);

describe('editor surfaces', () => {
  it('markdown body toggles between editing and rendered preview', async () => {
    const user = userEvent.setup();
    const { npc, forge } = await seedNpc();
    render(<ArtifactEditor artifact={npc} campaignId={npc.campaignId} campaignArtifacts={[npc, forge]} campaignSystem="dnd5e" />);

    const body = screen.getByPlaceholderText('Free-text content, written in Markdown…');
    await user.clear(body);
    await user.type(body, '## Brew{Enter}Brews deeply.');
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    // Toggling swaps a textarea for a tall div → the ScrollArea resizes and
    // Base UI schedules an update; drain it inside act.
    await flushAsyncUpdates();

    // The textarea is replaced by rendered markdown.
    expect(screen.queryByPlaceholderText('Free-text content, written in Markdown…')).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'Brew' })).toBeInTheDocument();
    expect(screen.getByText('Brews deeply.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await flushAsyncUpdates();
    expect(screen.getByPlaceholderText('Free-text content, written in Markdown…')).toHaveValue(
      '## Brew\nBrews deeply.',
    );
    await flushAsyncUpdates();
  }, 20000);

  it('tag editor adds, deduplicates case-insensitively, and removes tags', async () => {
    const user = userEvent.setup();
    const { npc, forge } = await seedNpc();
    render(<ArtifactEditor artifact={npc} campaignId={npc.campaignId} campaignArtifacts={[npc, forge]} campaignSystem="dnd5e" />);

    const input = screen.getByPlaceholderText('Add tag…');
    await user.type(input, 'alchemist{Enter}');
    await user.type(input, 'Alchemist,'); // duplicate, different case → ignored
    await user.type(input, 'boss{Enter}');

    expect(screen.getByText('boss')).toBeInTheDocument();
    expect(screen.getAllByText(/alchemist/i)).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Remove tag alchemist' }));
    expect(screen.queryByText('alchemist')).toBeNull();

    // Persisted through autosave.
    await waitFor(
      async () => {
        const stored = await getArtifact(npc.id);
        expect(stored?.tags).toEqual(['goblin', 'boss']);
      },
      { timeout: 4_000 },
    );
    await flushAsyncUpdates();
  });

  it('links section adds, renames, and removes links', async () => {
    const user = userEvent.setup();
    const { npc, forge } = await seedNpc();
    render(<ArtifactEditor artifact={npc} campaignId={npc.campaignId} campaignArtifacts={[npc, forge]} campaignSystem="dnd5e" />);

    // The target select is a Base UI combobox: open, pick 'Forge'.
    await user.click(screen.getByRole('combobox', { name: 'New link target' }));
    await user.click(await screen.findByRole('option', { name: 'Forge' }));

    const add = screen.getByRole('button', { name: 'Add link' });
    expect(add).toBeEnabled();
    await user.click(add);

    // Default relation applied; the row names the target artifact.
    const relation = screen.getByLabelText('Relation of link 1');
    expect(relation).toHaveValue('related-to');
    expect(relation.closest('div')?.textContent).toContain('Forge');

    // Editing the relation updates the row.
    await user.type(relation, ' inside');
    expect(screen.getByLabelText('Relation of link 1')).toHaveValue('related-to inside');

    // Removing clears the row.
    await user.click(screen.getByRole('button', { name: 'Remove link 1' }));
    expect(screen.queryByLabelText('Relation of link 1')).toBeNull();

    await flushAsyncUpdates();
  });

  it('links referencing a deleted artifact render as dangling, not broken', async () => {
    const { npc, forge } = await seedNpc({
      links: [{ targetId: '00000000-0000-4000-8000-000000000000', relation: 'enemy-of' }],
    });
    render(<ArtifactEditor artifact={npc} campaignId={npc.campaignId} campaignArtifacts={[npc, forge]} campaignSystem="dnd5e" />);

    expect(await screen.findByText('(deleted artifact)')).toBeInTheDocument();
    await flushAsyncUpdates();
  });

  it('stat block card renders, the edit form changes values, and it can be removed', async () => {
    const user = userEvent.setup();
    const { npc, forge } = await seedNpc({ statBlock: testStatBlock() });
    render(<ArtifactEditor artifact={npc} campaignId={npc.campaignId} campaignArtifacts={[npc, forge]} campaignSystem="dnd5e" />);

    // Card view: headline, defenses with note, ability modifiers, traits, extras.
    expect(screen.getByRole('heading', { name: 'Grix' })).toBeInTheDocument();
    expect(screen.getByText('Small humanoid (goblinoid)')).toBeInTheDocument();
    expect(screen.getByText('AC').parentElement?.textContent).toContain('14 (leather armor)');
    expect(screen.getByText('DEX').parentElement?.textContent).toContain('16 (+3)');
    expect(screen.getByText('Nimble Escape.')).toBeInTheDocument();

    // Card → form → change HP → back to card.
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const hp = screen.getByRole('spinbutton', { name: 'HP' });
    await user.clear(hp);
    await user.type(hp, '30');
    await user.click(screen.getByRole('button', { name: 'Done editing' }));
    expect(screen.getByText('HP').parentElement?.textContent).toContain('30 (5d6 + 5)');

    // Remove brings back the empty state (persisted via autosave).
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByRole('button', { name: 'Add stat block' })).toBeInTheDocument();
    await waitFor(
      async () => {
        const stored = await getArtifact(npc.id);
        if (stored?.kind !== 'npc') throw new Error('not an npc');
        expect(stored.data.statBlock).toBeNull();
      },
      { timeout: 4_000 },
    );
    await flushAsyncUpdates();
  });

  it('revision dropdown opens the snapshot dialog and restore writes a new revision', async () => {
    const user = userEvent.setup();
    const { npc, forge } = await seedNpc();
    // Revision 2: change the body (listRevisions is newest-first).
    await act(async () => {
      const stored = await getArtifact(npc.id);
      if (stored === undefined) throw new Error('npc vanished');
      await updateArtifact(stored.id, { body: '# Grix, rewritten' });
    });
    const current = await getArtifact(npc.id);
    if (current === undefined) throw new Error('npc vanished');
    render(
      <ArtifactEditor
        artifact={current}
        campaignId={current.campaignId}
        campaignArtifacts={[current, forge]}
        campaignSystem="dnd5e"
      />,
    );
    expect(screen.getByTestId('revision-badge')).toHaveTextContent('rev 2');

    await user.click(screen.getByRole('button', { name: 'History' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: /rev 2 · / })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /rev 1 · / })).toBeInTheDocument();

    await user.click(within(menu).getByRole('menuitem', { name: /rev 1 · / }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Revision 1')).toBeInTheDocument();
    expect(within(dialog).getByText(/manual save/)).toBeInTheDocument();
    // The snapshot shows revision 1's body ('# Grix' renders as a heading),
    // not the current revision's body.
    expect(within(dialog).getByRole('heading', { level: 1, name: 'Grix' })).toBeInTheDocument();
    expect(within(dialog).getByText('She brews.')).toBeInTheDocument();
    expect(within(dialog).queryByText(/rewritten/)).toBeNull();

    await user.click(within(dialog).getByRole('button', { name: 'Restore this revision' }));
    // The restore transaction re-fires the revisions live query; drain it
    // inside act before plain DB reads.
    await flushAsyncUpdates();
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    // Restore = save snapshot as a new revision (05-UI §Revisions).
    const restored = await getArtifact(npc.id);
    expect(restored?.body).toBe('# Grix\nShe brews.');
    expect(restored?.currentRevision).toBe(3);
    const revisions = await listRevisions(npc.id);
    expect(revisions).toHaveLength(3);
    expect(revisions[0]?.revision).toBe(3);
    expect(revisions[0]?.source).toBe('user');
    await flushAsyncUpdates();
  }, 20000);
});
