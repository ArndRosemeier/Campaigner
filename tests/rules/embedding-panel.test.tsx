import 'fake-indexeddb/auto';

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { putChunks } from '@/db/chunkRepo';
import { getSettings, updateSettings } from '@/db/settingsRepo';
import { newId, type RuleChunk } from '@/domain';
import { EmbeddingLibraryPanel } from '@/features/rules/embedding-panel';
import { embeddingStats, clearEmbeddings, embedWholeLibrary } from '@/search/embeddings';
import { db } from '@/db/db';
import { clearDatabase } from '../db/helpers';

/**
 * Whole-library embedding management (06-MILESTONES M2): stats, whole-library
 * embed round-trip with a mocked API, clearing, and the panel UI.
 */

const MODEL = 'text-embedding-3-small';

function chunk(text: string): RuleChunk {
  const hash = Array.from(text).reduce((acc, ch) => ((acc * 31 + ch.charCodeAt(0)) % 0xffffffff) >>> 0, 7);
  const suffix = hash.toString(16).padStart(8, '0');
  return {
    id: newId(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    bookId: newId(),
    pageStart: 1,
    pageEnd: 1,
    chunkType: 'section',
    headingPath: ['Chapter 1'],
    text,
    statBlock: null,
    contentHash: `${suffix}${suffix}${suffix}${suffix}${suffix}${suffix}${suffix}${suffix}`.slice(
      0,
      64,
    ),
  };
}

beforeEach(async () => {
  await clearDatabase();
  vi.restoreAllMocks();
});

describe('embedding library helpers', () => {
  it('reports stats and embeds the whole library (mocked API)', async () => {
    await getSettings();
    await updateSettings({
      embeddingModel: MODEL,
      embeddingsEnabled: true,
      openRouterApiKey: 'sk-test',
    });
    const chunks = [chunk('one'), chunk('two'), chunk('three')];
    await putChunks(chunks);

    const fetchMock = vi.fn((_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? '{}') as { input: string[] };
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: body.input.map((input, index) => ({ index, embedding: [input.length, 1, 2] })),
          }),
          { status: 200 },
        ),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    let stats = await embeddingStats();
    expect(stats.totalChunks).toBe(3);
    expect(stats.embeddedChunks).toBe(0);

    const progress: [number, number][] = [];
    await embedWholeLibrary((done, total) => {
      progress.push([done, total]);
    });
    stats = await embeddingStats();
    expect(stats.embeddedChunks).toBe(3);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1]?.[0]).toBe(3);

    // Idempotent: a second pass makes no API calls.
    fetchMock.mockClear();
    await embedWholeLibrary();
    expect(fetchMock).not.toHaveBeenCalled();

    await clearEmbeddings();
    expect((await embeddingStats()).embeddedChunks).toBe(0);
  }, 20000);
});

describe('EmbeddingLibraryPanel', () => {
  it('shows stats, embeds via button, and clears with confirm', async () => {
    const user = userEvent.setup();
    await getSettings();
    await updateSettings({
      embeddingModel: MODEL,
      embeddingsEnabled: true,
      openRouterApiKey: 'sk-test',
    });
    const chunks = [chunk('alpha'), chunk('beta')];
    await putChunks(chunks);

    const fetchMock = vi.fn((_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? '{}') as { input: string[] };
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: body.input.map((_input, index) => ({ index, embedding: [1, 2, 3] })),
          }),
          { status: 200 },
        ),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<EmbeddingLibraryPanel />);

    await waitFor(() => {
      expect(screen.getByText('0 of 2 chunks embedded')).toBeDefined();
    });

    await user.click(screen.getByTestId('embed-library'));
    await waitFor(() => {
      expect(screen.getByText('2 of 2 chunks embedded')).toBeDefined();
    });

    await user.click(screen.getByRole('button', { name: /clear/i }));
    const confirmButton = await screen.findByRole('button', { name: 'Clear' });
    await user.click(confirmButton);
    await waitFor(() => {
      expect(screen.getByText('0 of 2 chunks embedded')).toBeDefined();
    });
    const rows = await db.embeddings.toArray();
    expect(rows).toHaveLength(0);
  }, 20000);
});
