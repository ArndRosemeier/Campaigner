import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { createModule, deleteModule, saveModule } from '@/db/moduleRepo';
import {
  clearModuleVersions,
  countModuleVersions,
  listModuleVersions,
  snapshotModuleVersion,
} from '@/db/moduleVersionRepo';
import { db } from '@/db/db';
import {
  assembleModulePartsDocument,
  createModule as createModuleRow,
  MODULE_VERSION_CAP,
  modulePartSchema,
  moduleSpineSchema,
  type Id,
  type Module,
  type ModuleVersionSource,
} from '@/domain';
import { isNotFoundError } from '@/lib/errors';
import { clearDatabase } from './helpers';

/**
 * Durable module document versions (owner-directed simple undo: "Before each
 * AI change, simply save the whole content in a version"; docs/18 §2.3, docs/17
 * ledger row 63): the repo seam — byte-exact whole-document capture, the
 * bounded per-module stack (cap, oldest pruned first), newest-first listing,
 * the one-module Clear-all door, and the module-delete cascade. The AI call
 * sites are pinned in tests/features/canvas-versions.test.tsx (canvas + chat),
 * tests/llm/moduleGen.test.ts (parts pass + normalization) and
 * tests/features/entity-panel.test.tsx (normalization-proposal apply).
 */

const PART_PLAN = [
  { title: 'The Gate Bargain', levelBand: '1', synopsis: '', levelUpTrigger: '' },
  { title: 'Under the Docks', levelBand: '1', synopsis: '', levelUpTrigger: '' },
];

const PART_0_TEXT = 'The party bargains at the gate.';
const PART_1_TEXT = '';

function documentFor(part0: string, part1: string): string {
  return assembleModulePartsDocument({
    partPlan: PART_PLAN,
    parts: [
      { planIndex: 0, markdown: part0 },
      { planIndex: 1, markdown: part1 },
    ],
  }).document;
}

/** One ready module on the shared plan (part 1 written, part 2 still empty). */
async function seedModule(campaignId: Id, title: string, part0: string): Promise<Module> {
  const draft = createModuleRow({
    campaignId,
    title,
    concept: 'concept',
    levelMin: 1,
    levelMax: 2,
    tone: '',
    sizeDial: 'standard',
    includePriorModules: false,
  });
  return createModule({
    ...draft,
    spine: moduleSpineSchema.parse({
      premise: 'A drowned vault premise.',
      themes: [],
      partPlan: PART_PLAN,
    }),
    parts: [
      modulePartSchema.parse({
        planIndex: 0,
        markdown: part0,
        status: 'ready',
        errorMessage: '',
        edited: false,
      }),
    ],
  });
}

let campaignId: Id;
let moduleId: Id;

beforeEach(async () => {
  await clearDatabase();
  const campaign = await createCampaign({ name: 'Ember', description: '', system: 'dnd5e' });
  campaignId = campaign.id;
  const module = await seedModule(campaignId, 'The Drowned Vault', PART_0_TEXT);
  moduleId = module.id;
});

describe('snapshotModuleVersion — byte-exact whole-document capture', () => {
  it('stores the assembled whole document, never a per-part or summary shape', async () => {
    const version = await snapshotModuleVersion(moduleId, 'chat', 'Chat: make the rain heavier');
    expect(version).not.toBeNull();
    expect(version?.moduleId).toBe(moduleId);
    expect(version?.source).toBe('chat');
    expect(version?.label).toBe('Chat: make the rain heavier');
    // Byte-exact: the SAME text the split/save seam reads back, scaffold
    // labels included (a restore re-splits this string — never a second
    // document format).
    expect(version?.docText).toBe(documentFor(PART_0_TEXT, PART_1_TEXT));
    expect(version?.docText).toContain('==========');
    expect(version?.docText).toContain('[Part 1 of 2 — The Gate Bargain]');
    // …and the spine premise is NOT in it (the document's own contract).
    expect(version?.docText).not.toContain('A drowned vault premise.');
  });

  it('parses on read — a row with an impossible source fails loud, never renders blank', async () => {
    const version = await snapshotModuleVersion(moduleId, 'generation', 'Generate parts');
    if (version === null) throw new Error('snapshot missing');
    // Deliberately corrupt the stored row (the parse-on-read boundary).
    await db.moduleVersions.update(version.id, {
      source: 'not-a-source' as ModuleVersionSource,
    });
    await expect(listModuleVersions(moduleId)).rejects.toThrow(/source/);
  });

  it('returns null for a module with no planned parts (no document exists) and throws for a missing module', async () => {
    const planless = await seedModule(campaignId, 'Planless', 'text');
    await saveModule({ ...planless, spine: null });
    expect(
      await snapshotModuleVersion(planless.id, 'normalization', 'Normalize entity names'),
    ).toBeNull();
    expect(await countModuleVersions(planless.id)).toBe(0);

    const error: unknown = await snapshotModuleVersion(
      '00000000-0000-4000-8000-000000000000',
      'chat',
      'Chat: gone',
    ).then(
      () => null,
      (rejection: unknown) => rejection,
    );
    expect(isNotFoundError(error)).toBe(true);
  });
});

describe('the stack is bounded — oldest pruned first, newest kept', () => {
  it(`keeps exactly the most recent ${String(MODULE_VERSION_CAP)} snapshots`, async () => {
    const total = MODULE_VERSION_CAP + 5;
    for (let index = 0; index < total; index += 1) {
      await snapshotModuleVersion(moduleId, 'generation', `Generate parts #${String(index)}`);
    }

    const versions = await listModuleVersions(moduleId);
    expect(versions).toHaveLength(MODULE_VERSION_CAP);
    // The NEWEST survive by content: the newest label is on top, the five
    // oldest are gone (pruning is never a silent unbounded stack).
    expect(versions[0]?.label).toBe(`Generate parts #${String(total - 1)}`);
    expect(versions.map((entry) => entry.label)).not.toContain('Generate parts #0');
    expect(versions.map((entry) => entry.label)).not.toContain(
      `Generate parts #${String(total - MODULE_VERSION_CAP - 1)}`,
    );
    expect(versions.map((entry) => entry.label)).toContain(
      `Generate parts #${String(total - MODULE_VERSION_CAP)}`,
    );
    expect(versions).toHaveLength(new Set(versions.map((entry) => entry.id)).size);
  });

  it('lists newest first (the menu order) even for snapshots taken in the same millisecond', async () => {
    await snapshotModuleVersion(moduleId, 'chat', 'Chat: one');
    await snapshotModuleVersion(moduleId, 'chat', 'Chat: two');
    await snapshotModuleVersion(moduleId, 'chat', 'Chat: three');
    const versions = await listModuleVersions(moduleId);
    expect(versions.map((entry) => entry.label)).toEqual(['Chat: three', 'Chat: two', 'Chat: one']);
    // Strictly increasing timestamps: "newest" is never a coin flip, so the
    // cap can never prune a row younger than one it keeps.
    expect(versions[0]?.createdAt).toBeGreaterThan(versions[1]?.createdAt ?? 0);
    expect(versions[1]?.createdAt).toBeGreaterThan(versions[2]?.createdAt ?? 0);
  });
});

describe("clearModuleVersions — one module's stack, no snapshot of its own", () => {
  it("empties ONE module and leaves a second module's stack untouched", async () => {
    const other = await seedModule(campaignId, 'The Second Vault', 'Other text.');
    await snapshotModuleVersion(moduleId, 'chat', 'Chat: first');
    await snapshotModuleVersion(moduleId, 'chat', 'Chat: second');
    await snapshotModuleVersion(other.id, 'generation', 'Generate parts');

    const removed = await clearModuleVersions(moduleId);
    expect(removed).toBe(2);
    expect(await listModuleVersions(moduleId)).toEqual([]);
    expect(await countModuleVersions(moduleId)).toBe(0);
    // The second module keeps its history — the sweep is module-keyed.
    const survivor = await listModuleVersions(other.id);
    expect(survivor).toHaveLength(1);
    expect(survivor[0]?.label).toBe('Generate parts');
  });

  it('takes no snapshot first (clearing never re-creates what it cleared)', async () => {
    await snapshotModuleVersion(moduleId, 'chat', 'Chat: first');
    expect(await clearModuleVersions(moduleId)).toBe(1);
    expect(await countModuleVersions(moduleId)).toBe(0);
    // A second clear is an honest zero, and a later AI change starts a NEW
    // stack (a clear is not a tombstone that blocks snapshots).
    expect(await clearModuleVersions(moduleId)).toBe(0);
    await snapshotModuleVersion(moduleId, 'chat', 'Chat: after the clear');
    expect((await listModuleVersions(moduleId)).map((entry) => entry.label)).toEqual([
      'Chat: after the clear',
    ]);
  });
});

describe("deleteModule withholds no versions of its own module", () => {
  it("cascades the deleted module's versions and keeps another module's", async () => {
    const other = await seedModule(campaignId, 'The Second Vault', 'Other text.');
    await snapshotModuleVersion(moduleId, 'chat', 'Chat: first');
    await snapshotModuleVersion(other.id, 'chat', 'Chat: other');

    await deleteModule(moduleId, 'keep');

    expect(await countModuleVersions(moduleId)).toBe(0);
    expect(await countModuleVersions(other.id)).toBe(1);
  });
});
