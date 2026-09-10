import { useCallback, useSyncExternalStore } from 'react';

import type { Id } from '@/domain';
import type { ModuleGenEvent } from '@/llm/moduleGen';

/**
 * Module reader stream tails (08-MODULE-DESIGNER M4-B): the in-memory
 * per-part streaming tail, held in an EXTERNAL store instead of page state.
 *
 * ONE way to consume streaming tails: the ONLY subscription to
 * `moduleGenEvents` for reader tails lives here, and the ONLY consumers are
 * the streaming cards (`StreamingTail` in `ModuleReaderPage`), via
 * `useSyncExternalStore`. A token tick therefore re-renders the card that is
 * streaming and NOTHING else — never `ModuleReaderPage`, and never another
 * part's markdown.
 *
 * Why this exists (measured, dev server, Chrome 151, 12 parts × ~4 KB): with
 * the tails in page state, `setTails` re-rendered the page per token, so
 * EVERY delta re-parsed all 12 part bodies plus the premise — 13.6 s of
 * main-thread task time for 200 tokens (one 50–115 ms long task per token),
 * and scrolling DURING generation ran at 51 ms median frames against 16.8 ms
 * while idle. Same shape as `boardStore`'s value-diffed slices: session
 * state that must never re-render the whole document, with a snapshot object
 * replaced only when its VALUE changed (a fresh object per read would
 * re-render every subscriber on every token — the bug, one level down).
 */

/** Tail length cap (chars) — the last `TOKEN_TAIL_CHARS` of each stream. */
export const TOKEN_TAIL_CHARS = 800;

/** One stream's snapshot: content tail plus reasoning tail. */
export interface StreamTail {
  tail: string;
  thinkingTail: string;
}

/** Published before any event arrives — ONE frozen object, so the initial
 * snapshot is reference-stable (`useSyncExternalStore` re-renders forever on
 * a getSnapshot that returns a fresh object each read). */
const EMPTY_TAIL: StreamTail = Object.freeze({ tail: '', thinkingTail: '' });

/** Bounds a tail to the last `TOKEN_TAIL_CHARS` — deltas only ever append. */
function append(current: string, delta: string): string {
  return `${current}${delta}`.slice(-TOKEN_TAIL_CHARS);
}

class StreamTailStore {
  /** Keyed `<moduleId>\u0000<planIndex>`; `null` planIndex = the spine. */
  private readonly tails = new Map<string, StreamTail>();
  private readonly listeners = new Set<() => void>();

  readonly getSnapshot = (moduleId: Id, planIndex: number | null): StreamTail => {
    return this.tails.get(key(moduleId, planIndex)) ?? EMPTY_TAIL;
  };

  readonly subscribe = (
    moduleId: Id,
    planIndex: number | null,
    onStoreChange: () => void,
  ): (() => void) => {
    const entryKey = key(moduleId, planIndex);
    const listener = (): void => {
      if (this.tails.has(entryKey)) onStoreChange();
    };
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * Applies one emitter event: ONE slice is published and only that slice's
   * subscribers wake.
   *
   * `done` is deliberately a NO-OP. The generator emits it in a `finally`
   * AFTER the row writes (`moduleGen.ts` runSpine/runParts), so by then every
   * part is settled: the streaming cards are already unmounted by the row's
   * own status, and a clear here would repaint the streaming card's empty
   * placeholder for one frame on the way out — churn the store exists to
   * remove. The mounted module's tails are dropped by the unmount reset in
   * `ModuleReaderPage`.
   */
  apply(event: ModuleGenEvent): void {
    if (event.kind === 'done') return;
    const planIndex =
      event.kind === 'spine-token' || event.kind === 'spine-thinking' ? null : event.planIndex;
    const entryKey = key(event.moduleId, planIndex);
    const previous = this.tails.get(entryKey) ?? EMPTY_TAIL;
    const isThinking = event.kind === 'spine-thinking' || event.kind === 'part-thinking';
    this.publish(
      entryKey,
      isThinking
        ? { tail: previous.tail, thinkingTail: append(previous.thinkingTail, event.delta) }
        : // A content delta clears the reasoning tail — the model stopped
          // thinking and started writing.
          { tail: append(previous.tail, event.delta), thinkingTail: '' },
    );
  }

  /** Drops every tail of one module (the reader's unmount reset). */
  reset(moduleId: Id): void {
    const prefix = `${moduleId}\u0000`;
    let changed = false;
    for (const entryKey of [...this.tails.keys()]) {
      if (entryKey.startsWith(prefix)) {
        this.tails.delete(entryKey);
        changed = true;
      }
    }
    if (changed) this.notify();
  }

  private publish(entryKey: string, next: StreamTail): void {
    const previous = this.tails.get(entryKey);
    if (previous?.tail === next.tail && previous.thinkingTail === next.thinkingTail) {
      return;
    }
    this.tails.set(entryKey, next);
    this.notify();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

function key(moduleId: Id, planIndex: number | null): string {
  return `${moduleId}\u0000${planIndex === null ? 'spine' : String(planIndex)}`;
}

/** The ONE reader-tail store. */
export const streamTails = new StreamTailStore();

/** Snapshot of one part's stream (`planIndex` null = the spine). */
export function useStreamTail(moduleId: Id, planIndex: number | null): StreamTail {
  // Both functions are identity-stable per (module, part): a fresh closure per
  // render would make `useSyncExternalStore` re-subscribe the store on every
  // token — re-render churn moved one level down instead of removed.
  const subscribe = useCallback(
    (onStoreChange: () => void): (() => void) =>
      streamTails.subscribe(moduleId, planIndex, onStoreChange),
    [moduleId, planIndex],
  );
  const getSnapshot = useCallback(
    (): StreamTail => streamTails.getSnapshot(moduleId, planIndex),
    [moduleId, planIndex],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
