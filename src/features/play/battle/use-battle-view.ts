import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { Battle, BattleEffect, BattleTokenId, BattleVeil } from '@/domain';
import { resolveBattleView, type BattleView } from '@/domain/battle/view';
import { saveBattleView } from '@/db/battleRepo';
import { registerPageFlush } from '@/lib/pageFlush';
import { toastError } from '@/lib/toast';

/**
 * The battle surface's persisted VIEW state, as one hook (docs/17 row 262b,
 * docs/18 §2.3).
 *
 * THE NO-LEAK PROPERTY is structural, not an effect: `view` is DERIVED from
 * the row (`resolveBattleView(battle.view)`) in the SAME render the row
 * arrives, and the surface renders nothing but its empty state until then — so
 * the first paint of a restored table is already player-safe. There is no
 * "hydrate after mount" step that could commit one frame of GM data, which is
 * exactly the bug class `playerSafe`-as-local-state produced on iOS.
 *
 * A same-mount edit lives in `override` (so a gesture is instant and never
 * waits on IndexedDB); the row is the durable half. Writes ride the EXISTING
 * `saveBattleView` → `patchBattle` path and the page-hide seam is
 * `lib/pageFlush` — a frozen or discarded tab never unmounts, so a zoom still
 * inside the debounce window is landed by the page going away, never by a
 * second listener.
 */

/**
 * How long a gesture-driven view change waits before it is written. The
 * player-safe flag does not wait at all: it is a SAFETY state, so it lands
 * immediately (see `setPlayerSafe`).
 */
export const BATTLE_VIEW_PERSIST_DEBOUNCE_MS = 400;

interface PanOffset {
  x: number;
  y: number;
}
type Updater<T> = T | ((current: T) => T);

export interface BattleViewApi {
  playerSafe: boolean;
  zoom: number;
  pan: PanOffset;
  selectedTokenId: BattleTokenId | null;
  selectedVeilId: BattleVeil['id'] | null;
  selectedEffectId: BattleEffect['id'] | null;
  selectedKeyRoomId: string | null;
  setPlayerSafe: (value: Updater<boolean>) => void;
  setZoom: (value: Updater<number>) => void;
  setPan: (value: PanOffset) => void;
  setSelectedTokenId: (value: BattleTokenId | null) => void;
  setSelectedVeilId: (value: BattleVeil['id'] | null) => void;
  setSelectedEffectId: (value: BattleEffect['id'] | null) => void;
  setSelectedKeyRoomId: (value: string | null) => void;
}

/** Which battle a queued write belongs to, so a view edit never lands on the
 * battle the GM has since navigated to. */
interface PendingViewWrite {
  battleId: string;
  view: BattleView;
}

export function useBattleView(battle: Battle | undefined): BattleViewApi {
  const battleId = battle?.id ?? null;
  const stored = battle?.view;
  const restored = useMemo(() => resolveBattleView(stored), [stored]);

  // A local edit made on THIS mount. Tagged with its battle id so navigating to
  // another encounter (same component instance, different row) cannot carry the
  // previous board's view — including its player-safe flag — across.
  const [override, setOverride] = useState<{ battleId: string; view: BattleView } | null>(null);
  const view = override !== null && override.battleId === battleId ? override.view : restored.view;

  // A stored view that will not validate restores the player-safe fallback AND
  // says so, once per battle row: never the silent reset AGENTS rule 1 forbids.
  // The toast names the STATE rather than rendering the raw parse failure — a
  // Zod error is not a sentence for the owner (lib/toast's humanize-at-the-seam
  // rule); `resolveBattleView` still hands the failure to any caller that wants
  // it, and its own test asserts that reason.
  const corrupt = restored.fallback === 'corrupt';
  const reportedCorruptFor = useRef<string | null>(null);
  useEffect(() => {
    if (!corrupt || battleId === null || reportedCorruptFor.current === battleId) return;
    reportedCorruptFor.current = battleId;
    toastError('The saved battle view could not be read — showing the player-safe view');
  }, [corrupt, battleId]);

  // Mirrors the effective view synchronously so two edits in one tick compose
  // (a pinch's frames, a wheel burst) rather than each reading a stale render.
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  const pendingRef = useRef<PendingViewWrite | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persistPending = useCallback((): void => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending === null) return;
    void saveBattleView(pending.battleId, pending.view).catch((error: unknown) => {
      toastError('Could not save the battle view', error);
    });
  }, []);

  /**
   * Lands a view write still inside the debounce window and does NOTHING
   * otherwise — the pending-gated, idempotent, non-throwing, void-returning
   * contract `lib/pageFlush` requires (docs/17 row 111), with the pending value
   * taken out of the queue BEFORE the write.
   */
  const flushPending = useCallback((): void => {
    if (timerRef.current === null) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
    persistPending();
  }, [persistPending]);

  useEffect(() => {
    const unregister = registerPageFlush(flushPending);
    return () => {
      unregister();
      flushPending();
    };
  }, [flushPending]);

  const apply = useCallback(
    (mutate: (current: BattleView) => BattleView, immediate: boolean): void => {
      if (battleId === null) return;
      const next = mutate(viewRef.current);
      viewRef.current = next;
      setOverride({ battleId, view: next });
      pendingRef.current = { battleId, view: next };
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (immediate) {
        persistPending();
        return;
      }
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        persistPending();
      }, BATTLE_VIEW_PERSIST_DEBOUNCE_MS);
    },
    [battleId, persistPending],
  );

  const setPlayerSafe = useCallback(
    (value: Updater<boolean>): void => {
      apply(
        (current) => ({
          ...current,
          playerSafe: typeof value === 'function' ? value(current.playerSafe) : value,
        }),
        // A SAFETY flag: a reload right after the toggle must not be able to
        // find the old value still sitting in a debounce window.
        true,
      );
    },
    [apply],
  );

  const setZoom = useCallback(
    (value: Updater<number>): void => {
      apply(
        (current) => ({
          ...current,
          zoom: typeof value === 'function' ? value(current.zoom) : value,
        }),
        false,
      );
    },
    [apply],
  );

  const setPan = useCallback(
    (value: PanOffset): void => {
      apply((current) => ({ ...current, pan: value }), false);
    },
    [apply],
  );

  const setSelectedTokenId = useCallback(
    (value: BattleTokenId | null): void => {
      apply((current) => ({ ...current, selectedTokenId: value }), false);
    },
    [apply],
  );

  const setSelectedVeilId = useCallback(
    (value: BattleVeil['id'] | null): void => {
      apply((current) => ({ ...current, selectedVeilId: value }), false);
    },
    [apply],
  );

  const setSelectedEffectId = useCallback(
    (value: BattleEffect['id'] | null): void => {
      apply((current) => ({ ...current, selectedEffectId: value }), false);
    },
    [apply],
  );

  const setSelectedKeyRoomId = useCallback(
    (value: string | null): void => {
      apply((current) => ({ ...current, selectedKeyRoomId: value }), false);
    },
    [apply],
  );

  return {
    playerSafe: view.playerSafe,
    zoom: view.zoom,
    pan: view.pan,
    selectedTokenId: view.selectedTokenId,
    selectedVeilId: view.selectedVeilId,
    selectedEffectId: view.selectedEffectId,
    selectedKeyRoomId: view.selectedKeyRoomId,
    setPlayerSafe,
    setZoom,
    setPan,
    setSelectedTokenId,
    setSelectedVeilId,
    setSelectedEffectId,
    setSelectedKeyRoomId,
  };
}
