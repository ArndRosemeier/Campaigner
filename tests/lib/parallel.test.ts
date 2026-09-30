import { describe, expect, it } from 'vitest';

import { mapWithConcurrency } from '@/lib/parallel';

/**
 * Bounded parallel execution: order-preserving results, a hard concurrency
 * ceiling, and no sibling cancellation on failure (the pool waits for all
 * started workers before rethrowing).
 */

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('mapWithConcurrency', () => {
  it('preserves result order regardless of completion order', async () => {
    // Later items resolve first; results must still come back in input order.
    const result = await mapWithConcurrency([30, 10, 20], 3, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return ms * 2;
    });
    expect(result).toEqual([60, 20, 40]);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 3, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return n;
    });
    expect(peak).toBe(3);
  });

  it('clamps the limit to at least one and at most the item count', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2, 3], 99, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight -= 1;
      return n;
    });
    expect(peak).toBe(3); // 99 clamps to items.length

    let serialInFlight = 0;
    let serialPeak = 0;
    await mapWithConcurrency([1, 2, 3], 0, async (n) => {
      serialInFlight += 1;
      serialPeak = Math.max(serialPeak, serialInFlight);
      await new Promise((resolve) => setTimeout(resolve, 0));
      serialInFlight -= 1;
      return n;
    });
    expect(serialPeak).toBe(1); // 0 clamps to 1 — never zero parallelism
  });

  it('runs items one at a time with limit 1 and still completes every item', async () => {
    const processed: number[] = [];
    const result = await mapWithConcurrency([1, 2, 3], 1, async (n) => {
      await Promise.resolve();
      processed.push(n);
      return n * 10;
    });
    expect(processed).toEqual([1, 2, 3]);
    expect(result).toEqual([10, 20, 30]);
  });

  it('waits for started siblings before rethrowing the first failure', async () => {
    const first = deferred();
    const third = deferred();
    let thirdFinished = false;
    const pending = mapWithConcurrency([1, 2, 3], 3, async (n) => {
      if (n === 1) {
        first.resolve();
        throw new Error('worker one failed');
      }
      if (n === 3) {
        await third.promise;
        thirdFinished = true;
      }
      return n;
    });
    await first.promise; // worker one is about to fail
    third.resolve(); // let the sibling finish
    await expect(pending).rejects.toThrow('worker one failed');
    expect(thirdFinished).toBe(true); // the pool did not abandon it mid-flight
  });

  it('survives workers that record failures internally and never throw', async () => {
    const result = await mapWithConcurrency([1, 2, 3], 2, async (n) => {
      await Promise.resolve();
      if (n === 2) return 'failed:two' as unknown as number;
      return n;
    });
    expect(result).toEqual([1, 'failed:two', 3]);
  });
});
