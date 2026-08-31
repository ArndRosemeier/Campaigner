import 'fake-indexeddb/auto';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact, getArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { defaultArtifactName } from '@/domain/create';
import { ArtifactEditor } from '@/features/campaign/components/artifact-editor';
import { db } from '@/db/db';
import { clearDatabase } from '../db/helpers';

// The revision dropdown's live query is irrelevant here; the DB state is
// what we assert on. (Also avoids Dexie live-query reactivity in jsdom.)
vi.mock('@/features/campaign/hooks', () => ({ useRevisions: () => undefined }));

/**
 * Real timers (Dexie schedules work with them); autosave debounces 800 ms.
 * Wrapped in act so component updates driven by Base UI internals (scroll
 * area resize observation) during the wait do not fire outside act.
 */
async function sleep(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  });
}

beforeEach(clearDatabase);
afterEach(cleanup);

async function seedNpc(): Promise<string> {
  const campaign = await createCampaign({ name: 'Test', description: '', system: 'dnd5e' });
  const artifact = await createArtifact({
    campaignId: campaign.id,
    kind: 'npc',
    name: defaultArtifactName('npc'),
  });
  return artifact.id;
}

async function loadArtifact(id: string) {
  const row = await getArtifact(id);
  if (row === undefined) throw new Error('artifact missing');
  return row;
}

describe('ArtifactEditor autosave', () => {
  it('does not create a revision when nothing changed', async () => {
    const id = await seedNpc();
    const row = await loadArtifact(id);

    render(<ArtifactEditor artifact={row} campaignArtifacts={[]} campaignSystem="dnd5e" />);
    await sleep(1100);

    const after = await loadArtifact(id);
    expect(after.currentRevision).toBe(1);
    expect(await db.revisions.where('artifactId').equals(id).count()).toBe(1);
  });

  it('creates exactly one revision per changed autosave window', async () => {
    const id = await seedNpc();
    const row = await loadArtifact(id);

    render(<ArtifactEditor artifact={row} campaignArtifacts={[]} campaignSystem="dnd5e" />);

    const body = screen.getByPlaceholderText('Free-text content, written in Markdown…');
    fireEvent.change(body, { target: { value: 'Hello world' } });
    // More edits inside the same 800 ms window collapse into one save.
    await sleep(300);
    fireEvent.change(body, { target: { value: 'Hello world, part two' } });

    await waitFor(
      async () => {
        expect((await loadArtifact(id)).currentRevision).toBe(2);
      },
      { timeout: 3000 },
    );
    expect((await loadArtifact(id)).body).toBe('Hello world, part two');
    expect(await db.revisions.where('artifactId').equals(id).count()).toBe(2);

    // Letting more time elapse with no further changes stays at rev 2.
    await sleep(1100);
    expect((await loadArtifact(id)).currentRevision).toBe(2);
  }, 10000);

  it('never persists an empty name (mid-edit state)', async () => {
    const id = await seedNpc();
    const row = await loadArtifact(id);

    render(<ArtifactEditor artifact={row} campaignArtifacts={[]} campaignSystem="dnd5e" />);

    const nameInput = screen.getByLabelText('Artifact name');
    fireEvent.change(nameInput, { target: { value: '' } });
    await sleep(1100);
    expect((await loadArtifact(id)).name).toBe('New NPC');

    fireEvent.change(nameInput, { target: { value: 'Gorim' } });
    await waitFor(
      async () => {
        expect((await loadArtifact(id)).name).toBe('Gorim');
      },
      { timeout: 3000 },
    );
  }, 10000);
});
