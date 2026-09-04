/**
 * Bounded parallel execution (parallelization feature): independent
 * generation work (entity batches, queued images, map verifications) runs
 * through one pool so the wall-clock shrinks without stampeding OpenRouter —
 * the "Parallel requests" setting bounds every pool.
 *
 * Failures do NOT cancel siblings: the pool waits for all started workers,
 * then rethrows the first rejection (callers that collect per-item failures
 * catch inside their worker instead).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const effectiveLimit = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: effectiveLimit }, async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await worker(item, index);
    }
  });
  const settled = await Promise.allSettled(runners);
  const firstRejected = settled.find(
    (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
  );
  if (firstRejected !== undefined) throw firstRejected.reason;
  return results;
}
