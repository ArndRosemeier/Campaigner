import 'fake-indexeddb/auto';

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppRouter } from '@/app/router';
import { deliverablesPath } from '@/app/routes';
import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { listDeliverablesByCampaign } from '@/db/deliverableRepo';
import { createRulebook, updateRulebook } from '@/db/rulebookRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { ruleChunkSchema, stampNewEntity, type Id } from '@/domain';
import { sha256Hex } from '@/lib/hash';
import { clearDatabase } from '../db/helpers';

/**
 * Deliverable builder (07-MILESTONE-3 M3-D): create a deliverable, build an
 * outline with chapters and artifact nodes via the quick-find picker, seed
 * from Module Forge output, and generate the PDF.
 */

function renderAppAt(path: string): void {
  window.history.replaceState(null, '', path);
  render(<RouterProvider router={createAppRouter()} />);
}

async function statblockChunkId(): Promise<Id> {
  const book = await createRulebook({ title: 'Bestiary', system: 'dnd5e', filename: 'bestiary.pdf' });
  await updateRulebook(book.id, { status: 'ready', pageCount: 320 });
  const text = 'The cultist is a humanoid foe.';
  const { putChunks } = await import('@/db/chunkRepo');
  await putChunks([
    ruleChunkSchema.parse({
      ...stampNewEntity(),
      bookId: book.id,
      pageStart: 132,
      pageEnd: 132,
      chunkType: 'statblock',
      headingPath: ['Cultist'],
      text,
      statBlock: null,
      contentHash: await sha256Hex(text),
    }),
  ]);
  const { db } = await import('@/db/db');
  const chunks = await db.chunks.toArray();
  return chunks[0]?.id ?? '';
}

async function seed(): Promise<{ campaignId: Id; sessionId: Id }> {
  await seedBuiltInPersonas();
  const campaign = await createCampaign({ name: 'Module Campaign', system: 'dnd5e' });
  const tower = await createArtifact({
    campaignId: campaign.id,
    kind: 'location',
    name: 'Old Tower',
  });
  const session = await createArtifact({
    campaignId: campaign.id,
    kind: 'session',
    name: 'Session 1',
    data: { sessionNumber: '1', recap: '', prep: [], openThreads: [], scenes: [], log: '' },
  });
  await createArtifact({
    campaignId: campaign.id,
    kind: 'encounter',
    name: 'Pier Ambush',
    links: [{ targetId: session.id, relation: 'in-session' }, { targetId: tower.id, relation: 'at' }],
  });
  void statblockChunkId;
  return { campaignId: campaign.id, sessionId: session.id };
}

describe('deliverables builder', () => {
  beforeEach(clearDatabase);

  it('creates a deliverable, adds a chapter and an artifact node, persists the outline', async () => {
    const user = userEvent.setup();
    const { campaignId } = await seed();
    renderAppAt(deliverablesPath(campaignId));

    await user.click(await screen.findByRole('button', { name: 'New deliverable' }, { timeout: 5_000 }));
    await waitFor(async () => {
      expect(await listDeliverablesByCampaign(campaignId)).toHaveLength(1);
    });

    await user.click(await screen.findByRole('button', { name: '+ Chapter' }, { timeout: 5_000 }));
    // Title input exists for the new chapter (editing per-keystroke is
    // covered by updateDeliverable; no need to fight live-query re-renders).
    await screen.findByLabelText('chapter title', {}, { timeout: 5_000 });

    // Root-level artifact picker (quick-find) → pick Old Tower.
    const artifactButtons = screen.getAllByRole('button', { name: '+ Artifact' });
    const firstArtifactButton = artifactButtons[0];
    if (firstArtifactButton === undefined) throw new Error('no + Artifact button');
    await user.click(firstArtifactButton);
    const dialog = await screen.findByTestId('quickfind-dialog', {}, { timeout: 5_000 });
    await user.type(screen.getByTestId('quickfind-input'), 'Tower');
    await user.click(await within(dialog).findByTestId('quickfind-artifact', {}, { timeout: 5_000 }));

    await waitFor(async () => {
      const stored = await listDeliverablesByCampaign(campaignId);
      expect(stored[0]?.outline.some((node) => node.type === 'chapter')).toBe(true);
    });
    expect(await screen.findByText('Old Tower')).toBeInTheDocument();

    const deliverables = await listDeliverablesByCampaign(campaignId);
    const outline = deliverables[0]?.outline ?? [];
    const chapter = outline.find((node) => node.type === 'chapter');
    expect(chapter?.type === 'chapter' && chapter.title).toBe('New chapter');
    expect(
      chapter?.type === 'chapter' && chapter.children.some((child) => child.type === 'artifact'),
    ).toBe(true);
  });

  it('seeds the outline from Module Forge output (arc/session chapters + galleries)', async () => {
    const user = userEvent.setup();
    const { campaignId } = await seed();
    renderAppAt(deliverablesPath(campaignId));

    await user.click(await screen.findByRole('button', { name: 'New deliverable' }, { timeout: 5_000 }));
    await user.click(await screen.findByRole('button', { name: 'Seed from Module Forge output' }, { timeout: 5_000 }));

    await waitFor(async () => {
      const stored = await listDeliverablesByCampaign(campaignId);
      const outline = stored[0]?.outline ?? [];
      const sessionChapter = outline.find(
        (node) => node.type === 'chapter' && node.title === 'Session 1',
      );
      const seededChildren =
        sessionChapter?.type === 'chapter' ? sessionChapter.children : [];
      expect(seededChildren.length).toBeGreaterThan(0);
      expect(seededChildren.every((child) => child.type === 'artifact')).toBe(true);
      expect(outline.some((node) => node.type === 'gallery')).toBe(true);
    });

  });

  it('generates a PDF download when asked', async () => {
    const user = userEvent.setup();
    const { campaignId } = await seed();
    const downloadSpy = vi.fn();
    const createObjectUrl = vi.fn(() => 'blob:mock-pdf');
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectUrl, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
    HTMLAnchorElement.prototype.click = downloadSpy;

    renderAppAt(deliverablesPath(campaignId));
    await user.click(await screen.findByRole('button', { name: 'New deliverable' }, { timeout: 5_000 }));
    await user.click(await screen.findByRole('button', { name: 'Generate PDF' }, { timeout: 10_000 }));

    await waitFor(
      () => {
        expect(downloadSpy).toHaveBeenCalled();
      },
      { timeout: 20_000 },
    );
    expect(createObjectUrl).toHaveBeenCalled();
  }, 30_000);
});
