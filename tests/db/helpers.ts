import { expect } from 'vitest';

import { isNotFoundError } from '@/lib/errors';
import { db } from '@/db/db';
import { moduleDocumentVersionSchema, stampNewEntity, type Id } from '@/domain';

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
    db.deliverables.clear(),
    db.images.clear(),
    db.pdfFiles.clear(),
    db.modules.clear(),
    db.battles.clear(),
    db.moduleVersions.clear(),
    db.settings.clear(),
  ]);
}

/**
 * One schema-valid durable module-version row, written directly. The delete
 * suites need version stacks on modules their fixtures create WITHOUT a part
 * plan, and the real `snapshotModuleVersion` seam legitimately returns null
 * for those (no planned document exists to capture). Nothing is stubbed: the
 * row goes through the same schema the seam parses on read.
 */
export async function seedModuleVersion(moduleId: Id, label = 'Chat: seeded'): Promise<Id> {
  const row = moduleDocumentVersionSchema.parse({
    ...stampNewEntity(),
    moduleId,
    source: 'chat',
    label,
    docText: 'seeded document',
  });
  await db.moduleVersions.put(row);
  return row.id;
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
