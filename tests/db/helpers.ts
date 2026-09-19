import { expect } from 'vitest';

import { isNotFoundError } from '@/lib/errors';
import { db } from '@/db/db';
import { copyCreatureStatsFromDb } from '@/db/libraryCopy';
import { getSettings, updateSettings } from '@/db/settingsRepo';
import { moduleDocumentVersionSchema, stampNewEntity, type Id, type MonsterEntry } from '@/domain';

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
    db.images.clear(),
    db.pdfFiles.clear(),
    db.modules.clear(),
    db.battles.clear(),
    db.moduleVersions.clear(),
    db.settings.clear(),
    db.ideaBoards.clear(),
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

/**
 * The COPY-ON-WRITE shape a generated roster entry must carry (docs/17 row
 * 255a): the library's block, the STAMPED origin line and the opaque
 * `chunk:<id>` token — never a `rulebook` pointer. `entry` is the STORED
 * `MonsterEntry` a write path produced; the expectation comes from the SAME one
 * copy seam the write path calls, so this asserts the write went THROUGH that
 * seam rather than re-deriving a literal in the test (AGENTS §Centralization
 * obligation 2 — a differential, not a paraphrase).
 */
export async function expectCopiedRosterEntry(
  entry: MonsterEntry | undefined,
  chunkId: Id,
  name: string,
): Promise<void> {
  const copy = await copyCreatureStatsFromDb({ chunkId }, name);
  if (copy.status !== 'copied') throw new Error('the fixture chunk must be copyable');
  expect(entry?.source).toEqual({ type: 'inline', statBlock: copy.copy.statBlock });
  expect(entry?.sourceLine).toBe(copy.copy.sourceLine);
  expect(entry?.originToken).toBe(copy.copy.originToken);
}

/**
 * The recents list once every recording write the preceding action started has
 * SETTLED (docs/17 row 203). THE ONE drain for the exclusion pins.
 *
 * The ONE recording seam is FIRE-AND-FORGET by contract (rows 193/198), so a
 * bare read straight after an excluded-tier action does not PROVE no write
 * happened: a wrongly scheduled recorder can still be in flight. `updateSettings`
 * opens an `rw` transaction on the ONE settings row, which Dexie queues behind
 * any pending recorder, so its return is the proof those writes committed.
 * Callers compare the WHOLE list afterwards: "the global id is absent" is the
 * weaker claim the exclusion pins used to make (docs/08-TESTING §row 203).
 */
export async function recentsAfterSettlingWrites(): Promise<string[]> {
  await updateSettings({});
  return (await getSettings()).recentChatModels;
}
