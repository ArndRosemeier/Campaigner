import 'fake-indexeddb/auto';

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';

import { createAppRouter } from '@/app/router';
import { playPath } from '@/app/routes';
import { createArtifact, getArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { putChunks } from '@/db/chunkRepo';
import { createRulebook, updateRulebook } from '@/db/rulebookRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { ruleChunkSchema, stampNewEntity, type Id } from '@/domain';
import { sha256Hex } from '@/lib/hash';
import { usePinnedChunksStore } from '@/features/rules/pinStore';
import { clearDatabase } from '../db/helpers';

/**
 * Session Mode (07-MILESTONE-3 M3-C): focus + link-hop context grid, secrets
 * as click-to-reveal, scene check-offs, quick log, focus/session restore on
 * reload, and Ctrl+K quick-find (artifact pick + rule preview/pin).
 */

function renderAppAt(path: string): void {
  window.history.replaceState(null, '', path);
  render(<RouterProvider router={createAppRouter()} />);
}

async function statblockChunk(text: string): Promise<Id> {
  const book = await createRulebook({ title: 'Bestiary', system: 'dnd5e', filename: 'bestiary.pdf' });
  await updateRulebook(book.id, { status: 'ready', pageCount: 320 });
  await putChunks([
    ruleChunkSchema.parse({
      ...stampNewEntity(),
      bookId: book.id,
      pageStart: 290,
      pageEnd: 290,
      chunkType: 'statblock',
      headingPath: ['Grapple Rules'],
      text,
      statBlock: null,
      contentHash: await sha256Hex(text),
    }),
  ]);
  const { db } = await import('@/db/db');
  const chunks = await db.chunks.toArray();
  return chunks[0]?.id ?? '';
}

async function seed(): Promise<{ campaignId: Id; encounterId: Id; sessionId: Id; docksId: Id }> {
  await seedBuiltInPersonas();
  const campaign = await createCampaign({ name: 'Play Campaign', system: 'dnd5e' });
  const tower = await createArtifact({
    campaignId: campaign.id,
    kind: 'location',
    name: 'Old Tower',
    summary: 'A crumbling watchtower.',
    body: 'The tower overlooks the ford.',
  });
  const docks = await createArtifact({
    campaignId: campaign.id,
    kind: 'location',
    name: 'The Docks',
    links: [{ targetId: tower.id, relation: 'near' }],
  });
  const npc = await createArtifact({
    campaignId: campaign.id,
    kind: 'npc',
    name: 'Vexra',
    summary: 'A hooded figure.',
    data: {
      role: 'Antagonist',
      appearance: '',
      personality: 'Cold, precise.',
      motivation: 'Finish the ritual.',
      secrets: 'She is the harbourmaster’s sister.',
      voiceNotes: 'Whispers.',
      statBlock: null,
    },
    links: [{ targetId: tower.id, relation: 'located-in' }],
  });
  const encounter = await createArtifact({
    campaignId: campaign.id,
    kind: 'encounter',
    name: 'Pier Ambush',
    data: {
      difficulty: 'deadly',
      levelHint: '5',
      monsters: [
        { name: 'Vexra', count: 1, notes: '', source: { type: 'npc-ref', artifactId: npc.id } },
      ],
      terrain: '',
      tactics: '',
      treasure: '',
      mapImageId: null,
    },
    links: [{ targetId: tower.id, relation: 'at' }],
  });
  const session = await createArtifact({
    campaignId: campaign.id,
    kind: 'session',
    name: 'Session 1',
    data: {
      sessionNumber: '1',
      recap: '',
      prep: [],
      openThreads: [],
      scenes: [
        { title: 'Arrive at the tower', done: false, artifactId: tower.id },
        { title: 'Ambush at the pier', done: false, artifactId: null },
      ],
      log: '',
    },
  });
  return { campaignId: campaign.id, encounterId: encounter.id, sessionId: session.id, docksId: docks.id };
}

describe('play mode', () => {
  beforeEach(clearDatabase);

  it('focuses a location, shows linked NPCs/encounters/neighbors, moves focus, reveals secrets', async () => {
    const user = userEvent.setup();
    const { campaignId } = await seed();
    renderAppAt(playPath(campaignId));

    // Default focus: the first location.
    expect(await screen.findByRole('heading', { name: 'Old Tower' }, { timeout: 5_000 })).toBeInTheDocument();

    // NPCs here: all fields render directly (M4-C — no "More" expander);
    // secrets are plain text — this is a master tool.
    const npcCard = screen.getByTestId('play-npc-card');
    expect(within(npcCard).getByText('Cold, precise.')).toBeInTheDocument();
    expect(within(npcCard).getByText(/harbourmaster/)).toBeInTheDocument();

    // Encounters: resolved stat blocks render directly (NPC link).
    const encounterCard = screen.getByTestId('play-encounter-card');
    await within(encounterCard).findByText('NPC: Vexra');

    // Connected locations: clicking a neighbor moves the focus.
    await user.click(screen.getByTestId(/focus-jump-/));
    expect(await screen.findByRole('heading', { name: 'The Docks' })).toBeInTheDocument();

    // No editing forms anywhere: no textareas in play mode.
    expect(screen.queryByLabelText(/Body/)).not.toBeInTheDocument();
  });

  it('checks off scenes and appends quick-log lines, persisting immediately', async () => {
    const user = userEvent.setup();
    const { campaignId, sessionId } = await seed();
    renderAppAt(playPath(campaignId));

    const rail = await screen.findByTestId('session-rail', {}, { timeout: 5_000 });
    await user.click(await within(rail).findByRole('button', { name: 'Scene: Arrive at the tower' }, { timeout: 5_000 }));

    await waitFor(async () => {
      const session = await getArtifact(sessionId);
      expect(session?.kind === 'session' && session.data.scenes[0]?.done).toBe(true);
    });

    const logInput = await within(rail).findByLabelText('Quick log', {}, { timeout: 5_000 });
    await user.type(logInput, 'The watchman fled.');
    await user.keyboard('{Enter}');

    await waitFor(async () => {
      const session = await getArtifact(sessionId);
      expect(session?.kind === 'session' && session.data.log).toContain('- ');
      expect(session?.kind === 'session' && session.data.log).toContain('The watchman fled.');
    });
    expect(await within(rail).findByText(/The watchman fled/)).toBeInTheDocument();
  });

  it('restores focus and active session after reload', async () => {
    const user = userEvent.setup();
    const { campaignId } = await seed();
    renderAppAt(playPath(campaignId));
    await screen.findByRole('heading', { name: 'Old Tower' }, { timeout: 5_000 });

    // Move focus to the docks, then "reload" by cleaning up and re-rendering.
    await user.click(await screen.findByTestId(/focus-jump-/));
    expect(await screen.findByRole('heading', { name: 'The Docks' })).toBeInTheDocument();
    cleanup();

    renderAppAt(playPath(campaignId));
    expect(
      await screen.findByRole('heading', { name: 'The Docks' }, { timeout: 5_000 }),
    ).toBeInTheDocument();
  });

  it('opens quick-find with Ctrl+K, sets focus from a pick, and pins a rule', { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    const { campaignId } = await seed();
    const chunkId = await statblockChunk('A creature can be grappled by a larger foe.');
    renderAppAt(playPath(campaignId));
    await screen.findByRole('heading', { name: 'Old Tower' }, { timeout: 5_000 });

    await user.keyboard('{Control>}k{/Control}');
    const dialog = await screen.findByTestId('quickfind-dialog');
    await user.type(screen.getByTestId('quickfind-input'), 'Docks');
    await user.click(within(dialog).getByTestId('quickfind-artifact'));
    expect(await screen.findByRole('heading', { name: 'The Docks' })).toBeInTheDocument();

    // Rule search + inline preview + pin. Re-focus the body first: after the
    // dialog closes, focus may sit on a detached node and the hotkey (a
    // window listener) would never fire.
    await waitFor(() => {
      expect(screen.queryByTestId('quickfind-dialog')).not.toBeInTheDocument();
    });
    await user.click(document.body);
    await user.keyboard('{Control>}k{/Control}');
    const dialog2 = await screen.findByTestId('quickfind-dialog', {}, { timeout: 5_000 });
    await user.type(screen.getByTestId('quickfind-input'), 'grappled');
    const chunkItem = await within(dialog2).findByTestId('quickfind-chunk', {}, { timeout: 5_000 });
    await user.click(chunkItem);
    await user.click(within(dialog2).getByRole('button', { name: 'Pin to Assistant' }));
    expect(usePinnedChunksStore.getState().isPinned(chunkId)).toBe(true);
  });
});
