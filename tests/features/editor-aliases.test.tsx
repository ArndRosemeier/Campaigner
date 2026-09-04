import 'fake-indexeddb/auto';

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { createArtifact, getArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { ArtifactEditor } from '@/features/campaign/components/artifact-editor';
import { resolveWikiLink } from '@/lib/wikilinks';
import { clearDatabase } from '../db/helpers';
import { flushAsyncUpdates } from '../helpers/flush';

/**
 * Alias chip input in the artifact editor header (08-MODULE-DESIGNER M4-A —
 * "also known as", adjacent to the tags row; docs/05 §Artifact editor).
 * Aliases are the alternate names module wiki-links resolve against:
 * added/removed through the editor like tags, deduped case-insensitively
 * against the artifact's own name and existing aliases, stored verbatim
 * (never lowercased — resolution lowercases on its own), and removal never
 * rewrites module text (08 §M4-A binding rule).
 */

const NPC_DATA = {
  appearance: 'Small, soot-stained.',
  personality: 'Manic, cheerful.',
  statBlock: null,
};

async function seedNpc(): Promise<{ npcId: string; campaignId: string }> {
  const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
  const npc = await createArtifact({
    campaignId: campaign.id,
    kind: 'npc',
    name: 'Grix',
    summary: 'Goblin alchemist boss.',
    tags: ['goblin'],
    aliases: ['The Alchemist'],
    body: 'Meet [[The Alchemist]] at dusk.',
    data: NPC_DATA,
  });
  return { npcId: npc.id, campaignId: campaign.id };
}

/** Re-reads the npc row after the autosave debounce has had its window. */
async function loadNpc(npcId: string) {
  const row = await getArtifact(npcId);
  if (row?.kind !== 'npc') throw new Error('npc missing');
  return row;
}

beforeEach(clearDatabase);

describe('artifact editor alias chips', () => {
  it('adds an alias chip and persists it through autosave', async () => {
    const user = userEvent.setup();
    const { npcId, campaignId } = await seedNpc();
    const npc = await loadNpc(npcId);
    render(<ArtifactEditor artifact={npc} campaignId={campaignId} campaignArtifacts={[npc]} campaignSystem="dnd5e" />);

    const input = screen.getByPlaceholderText('Add alias…');
    await user.type(input, 'Grix the Wily{Enter}');

    expect(screen.getByText('Grix the Wily')).toBeInTheDocument();
    await waitFor(
      async () => {
        expect((await loadNpc(npcId)).aliases).toEqual(['The Alchemist', 'Grix the Wily']);
      },
      { timeout: 4_000 },
    );
    await flushAsyncUpdates();
  });

  it('removes an alias chip and persists the removal without touching body text', async () => {
    const user = userEvent.setup();
    const { npcId, campaignId } = await seedNpc();
    const npc = await loadNpc(npcId);
    render(<ArtifactEditor artifact={npc} campaignId={campaignId} campaignArtifacts={[npc]} campaignSystem="dnd5e" />);

    // Add a second alias, then remove the seeded one.
    await user.type(screen.getByPlaceholderText('Add alias…'), 'Skarn{Enter}');
    await user.click(screen.getByRole('button', { name: 'Remove alias The Alchemist' }));
    expect(screen.queryByText('The Alchemist')).toBeNull();
    expect(screen.getByText('Skarn')).toBeInTheDocument();

    await waitFor(
      async () => {
        expect((await loadNpc(npcId)).aliases).toEqual(['Skarn']);
      },
      { timeout: 4_000 },
    );
    // No cascading rewrite (08 §M4-A): removal only edits the alias list.
    expect((await loadNpc(npcId)).body).toBe(npc.body);
    await flushAsyncUpdates();
  });

  it('rejects a case-insensitive duplicate of an existing alias, keeping the stored spelling', async () => {
    const user = userEvent.setup();
    const { npcId, campaignId } = await seedNpc();
    const npc = await loadNpc(npcId);
    render(<ArtifactEditor artifact={npc} campaignId={campaignId} campaignArtifacts={[npc]} campaignSystem="dnd5e" />);

    await user.type(screen.getByPlaceholderText('Add alias…'), 'the alchemist,'); // comma commits

    // Exactly one chip — the seeded spelling. The lowercase spelling the
    // user typed never appears as a chip (the body textarea is not a chip).
    expect(screen.getAllByLabelText('Remove alias The Alchemist')).toHaveLength(1);
    expect(screen.queryByText('the alchemist')).toBeNull();
    await waitFor(
      async () => {
        // The original spelling is the only one — no lowercase twin stored.
        expect((await loadNpc(npcId)).aliases).toEqual(['The Alchemist']);
      },
      { timeout: 4_000 },
    );
    await flushAsyncUpdates();
  });

  it('rejects an alias equal to the artifact name (case-insensitively)', async () => {
    const user = userEvent.setup();
    const { npcId, campaignId } = await seedNpc();
    const npc = await loadNpc(npcId);
    render(<ArtifactEditor artifact={npc} campaignId={campaignId} campaignArtifacts={[npc]} campaignSystem="dnd5e" />);

    await user.type(screen.getByPlaceholderText('Add alias…'), 'grix{Enter}');

    expect(screen.queryByText('grix')).toBeNull();
    await waitFor(
      async () => {
        expect((await loadNpc(npcId)).aliases).toEqual(['The Alchemist']);
      },
      { timeout: 4_000 },
    );
    await flushAsyncUpdates();
  });

  it('resolves a wiki-link that only matches via a newly added alias', async () => {
    const user = userEvent.setup();
    const { npcId, campaignId } = await seedNpc();
    const npc = await loadNpc(npcId);
    render(<ArtifactEditor artifact={npc} campaignId={campaignId} campaignArtifacts={[npc]} campaignSystem="dnd5e" />);

    await user.type(screen.getByPlaceholderText('Add alias…'), 'Grix the Wily{Enter}');
    await waitFor(
      async () => {
        expect((await loadNpc(npcId)).aliases).toContain('Grix the Wily');
      },
      { timeout: 4_000 },
    );

    // Before the alias existed this name had no owner; now it resolves to
    // the artifact (case-insensitively), name-first matching untouched.
    const stored = await loadNpc(npcId);
    expect(resolveWikiLink('Grix', [stored]).artifact?.id).toBe(npcId); // still the name
    const resolution = resolveWikiLink('grix the wily', [stored]);
    expect(resolution.status).toBe('resolved');
    expect(resolution.artifact?.id).toBe(npcId);
    await flushAsyncUpdates();
  });
});
