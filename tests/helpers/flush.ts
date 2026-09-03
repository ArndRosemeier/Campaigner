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
