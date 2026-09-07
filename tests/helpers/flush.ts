import { act } from '@testing-library/react';

/**
 * Drains pending async updates inside act (docs/08-TESTING.md §Console
 * guard): Dexie live queries and Base UI internal state often resolve on
 * fake-indexeddb's timed queue *after* a test's last act-wrapped operation.
 * Without this drain their setState calls fire outside act and the console
 * guard (tests/setup.ts) fails the test with an act() warning.
 *
 * Call at the end of a test whose last steps were raw awaits / fireEvent,
 * before the final assertions that leave updates pending.
 */
export async function flushAsyncUpdates(rounds = 20): Promise<void> {
  await act(async () => {
    for (let round = 0; round < rounds; round += 1) {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }
  });
}

/**
 * Runs a block inside ONE act and drains before exiting (docs/08-TESTING.md
 * §Console guard): a bare `await` of a Dexie read (or any async step) between
 * act-wrapped steps re-opens the act-leak window — during the raw await the
 * event loop turns fake-indexeddb's timed queue, and a liveQuery that
 * (re)subscribed there dispatches its state update outside act (the console
 * guard then fails the test). This is the timing-dependent flake class that
 * hit `battle-surface.test.tsx > selection card`: the tap's bare
 * `await getBattleByModule()` handed the token's image liveQuery — just
 * resubscribed by a late-landing artifacts cascade — that window, and its
 * subscribe-time query emitted outside act.
 *
 * Wrap the raw-await step (and anything else that must not leak); the drain
 * absorbs the pending liveQuery cascade before the act exits. Do NOT wrap
 * paired `fireEvent` pointer sequences in one spanning act: each `fireEvent`
 * flushes its own render, and handlers read state committed by the previous
 * event (e.g. the board's down→up gesture pairing) — a spanning act defers
 * that commit and breaks the pairing.
 */
export async function actDrained<T>(interaction: () => Promise<T>, rounds = 20): Promise<T> {
  let result!: T;
  await act(async () => {
    result = await interaction();
    for (let round = 0; round < rounds; round += 1) {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }
  });
  return result;
}
