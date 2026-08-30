import { expect } from 'vitest';

import { isNotFoundError } from '@/lib/errors';
import { db } from '@/db/db';

/** Clears every table so each test starts from an empty DB. */
export async function clearDatabase(): Promise<void> {
  await Promise.all([
    db.campaigns.clear(),
    db.artifacts.clear(),
    db.revisions.clear(),
    db.rulebooks.clear(),
    db.chunks.clear(),
    db.embeddings.clear(),
    db.personas.clear(),
    db.runs.clear(),
    db.settings.clear(),
  ]);
}

/**
 * Asserts that a promise rejects with a NotFoundError — through the
 * Dexie-aware guard, since Dexie wraps errors thrown inside transactions.
 */
export async function expectNotFound(promise: Promise<unknown>): Promise<void> {
  const error: unknown = await promise.then(
    () => null,
    (rejection: unknown) => rejection,
  );
  expect(isNotFoundError(error)).toBe(true);
}
