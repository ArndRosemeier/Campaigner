import { z } from 'zod';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { RuleChunk } from '@/domain';
import { ruleChunkSchema } from '@/domain/rulebook';
import { zodPersistStorage } from '@/lib/persisted';

/**
 * Global "pinned rules" list (05-UI.md): chunks pinned from the Rules
 * browser, consumed by the persona panel (T7) as retrieval context.
 * Full RuleChunk objects are persisted so the engine can use them directly.
 */

const PINNED_STORAGE_KEY = 'campaigner.pinned-chunks';

const persistedSchema = z.object({ chunks: z.array(ruleChunkSchema) });

type PinnedPersisted = z.infer<typeof persistedSchema>;

interface PinnedStore extends PinnedPersisted {
  pin: (chunk: RuleChunk) => void;
  unpin: (chunkId: string) => void;
  clear: () => void;
  isPinned: (chunkId: string) => boolean;
}

export const usePinnedChunksStore = create<PinnedStore>()(
  persist(
    (set, get) => ({
      chunks: [],
      pin: (chunk) => {
        if (get().chunks.some((existing) => existing.id === chunk.id)) return;
        set((state) => ({ chunks: [...state.chunks, chunk] }));
      },
      unpin: (chunkId) => {
        set((state) => ({ chunks: state.chunks.filter((chunk) => chunk.id !== chunkId) }));
      },
      clear: () => set({ chunks: [] }),
      isPinned: (chunkId) => get().chunks.some((chunk) => chunk.id === chunkId),
    }),
    {
      name: PINNED_STORAGE_KEY,
      storage: zodPersistStorage(persistedSchema),
      partialize: (state): PinnedPersisted => ({ chunks: state.chunks }),
    },
  ),
);
