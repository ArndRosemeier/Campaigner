import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact, getAnyArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { createModule, getModule, saveModule } from '@/db/moduleRepo';
import {
  createModule as createModuleSchema,
  modulePartSchema,
  moduleSpineSchema,
  type Id,
  type Module,
} from '@/domain';
import {
  moduleDocumentFromView,
  replaceLevelText,
  splitModuleDocument,
} from '@/domain/moduleDocument';
import { saveWholeModuleDocument } from '@/features/modules/canvas/saveDoc';
import { clearDatabase } from '../db/helpers';

/**
 * THE DOCUMENT SAVE'S LINKS HOOK, PINNED THROUGH THE REAL SEAM (docs/17 row
 * 387).
 *
 * Row 385 restored `saveWholeModuleDocument`'s lost promotion hook —
 * `promoteSecondModuleUses(input.moduleId, changed.map(level => level.text))`,
 * run AFTER the document write. Nothing asserted it: the canvas suites MOCK
 * `promoteSecondModuleUses`, and a mock nobody asserts is not a pin, so the
 * dispatcher deleted the call and 35 canvas tests stayed green.
 *
 * This file is the pin that was missing. It never mocks
 * `db/artifactAutoPromote` (only `lib/toast`, whose toasts are the promotion's
 * own loud surface): it drives THE save seam the canvas drives
 * (`features/modules/canvas/saveDoc.saveWholeModuleDocument`) and reads the
 * PROMOTION'S OBSERVABLE EFFECT off the artifact rows — a second module's
 * wikilink moves the artifact to campaign level (`moduleId: null`). Deleting
 * the call reds the first arm; promoting every level instead of the CHANGED
 * ones reds the second; calling it unconditionally reds the third.
 */

vi.mock('@/lib/toast', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
}));

interface Seeded {
  campaignId: Id;
  ownerModuleId: Id;
  writerModuleId: Id;
  changedShrineId: Id;
  unchangedShrineId: Id;
}

let campaignId: Id = '';
let ownerModuleId: Id = '';
let writerModuleId: Id = '';
let changedShrineId: Id = '';
let unchangedShrineId: Id = '';

/**
 * A campaign with TWO modules (the owner and the writer) and two artifacts
 * OWNED by the owner module. The writer's document has two level sections; the
 * CALLER decides what each links, so a test can change exactly one of them.
 */
async function seed(options: {
  /** The first level section's text, as stored. */
  levelOne: string;
  /** The second level section's text, as stored. */
  levelTwo: string;
}): Promise<Seeded> {
  campaignId = (await createCampaign({ name: 'Ember', system: 'dnd5e' })).id;
  const owner = await createModule(
    createModuleSchema({
      campaignId,
      title: 'The Owner',
      concept: '',
      levelMin: 1,
      levelMax: 1,
      sizeDial: 'sketch',
    }),
  );
  ownerModuleId = owner.id;
  const draft = createModuleSchema({
    campaignId,
    title: 'The Writer',
    concept: '',
    levelMin: 1,
    levelMax: 2,
    sizeDial: 'sketch',
  });
  const saved = await saveModule({
    ...draft,
    status: 'ready',
    spine: moduleSpineSchema.parse({
      premise: 'A premise that links nothing.',
      themes: [],
      partPlan: [
        { title: 'Level one', levelBand: '1', synopsis: '', levelUpTrigger: '' },
        { title: 'Level two', levelBand: '2', synopsis: '', levelUpTrigger: '' },
      ],
    }),
    parts: [
      modulePartSchema.parse({
        planIndex: 0,
        markdown: options.levelOne,
        status: 'ready',
        errorMessage: '',
        edited: false,
      }),
      modulePartSchema.parse({
        planIndex: 1,
        markdown: options.levelTwo,
        status: 'ready',
        errorMessage: '',
        edited: false,
      }),
    ],
  });
  writerModuleId = saved.id;
  changedShrineId = (
    await createArtifact({
      campaignId,
      moduleId: ownerModuleId,
      kind: 'location',
      name: 'Changed Shrine',
    })
  ).id;
  unchangedShrineId = (
    await createArtifact({
      campaignId,
      moduleId: ownerModuleId,
      kind: 'location',
      name: 'Unchanged Shrine',
    })
  ).id;
  return { campaignId, ownerModuleId, writerModuleId, changedShrineId, unchangedShrineId };
}

/** The writer's document AS STORED — the save's own diff baseline. */
async function writerDocument(): Promise<string> {
  const module = await getModule(writerModuleId);
  if (module === undefined) throw new Error('the writer module vanished');
  return moduleDocumentFromView(module);
}

async function writerModule(): Promise<Module> {
  const module = await getModule(writerModuleId);
  if (module === undefined) throw new Error('the writer module vanished');
  return module;
}

/** The artifact's owner after the save (`null` = promoted to campaign level). */
async function ownerOf(artifactId: Id): Promise<Id | null> {
  const artifact = await getAnyArtifact(artifactId);
  if (artifact === undefined) throw new Error(`artifact ${artifactId} vanished`);
  return artifact.moduleId;
}

beforeEach(async () => {
  await clearDatabase();
  vi.clearAllMocks();
});

describe('the document save promotes the CHANGED levels\u2019 links (docs/17 row 387)', () => {
  it('promotes an artifact a changed level now links, through the REAL save seam', async () => {
    await seed({
      levelOne: 'Nothing is linked here yet.',
      levelTwo: 'The road passes [[Unchanged Shrine]].',
    });
    const before = await writerDocument();
    // THE CHANGE: level 1's text links another module's artifact. Level 2 is
    // left byte-identical by splicing through the document's own parse.
    const edited = replaceLevelText(
      splitModuleDocument(before),
      1,
      'The party reaches [[Changed Shrine]].',
    ).document;

    const result = await saveWholeModuleDocument({
      moduleId: writerModuleId,
      doc: edited,
      module: await writerModule(),
      origin: 'user',
      label: 'Edited level 1',
    });

    expect(result.savedPlanIndexes).toEqual([0]);
    // The changed level's link promoted the artifact to CAMPAIGN level.
    expect(await ownerOf(changedShrineId)).toBeNull();
    // …and the UNCHANGED level's link did NOT (the changed levels' texts only).
    expect(await ownerOf(unchangedShrineId)).toBe(ownerModuleId);
  });

  it('is not invoked at all when NO level changed', async () => {
    await seed({
      levelOne: 'The party reaches [[Changed Shrine]].',
      levelTwo: 'The road passes [[Unchanged Shrine]].',
    });
    // The document as stored is saved back UNCHANGED: an unconditional promote
    // (or one handed every level's text) would promote here; the hook is
    // driven by the changed levels, so nothing moves.
    const document = await writerDocument();
    const result = await saveWholeModuleDocument({
      moduleId: writerModuleId,
      doc: document,
      module: await writerModule(),
      origin: 'user',
      label: 'No-op save',
    });

    expect(result.savedPlanIndexes).toEqual([]);
    expect(await ownerOf(changedShrineId)).toBe(ownerModuleId);
    expect(await ownerOf(unchangedShrineId)).toBe(ownerModuleId);
  });

  it('promotes ONLY the changed level when two levels carry links', async () => {
    await seed({
      levelOne: 'Nothing is linked here yet.',
      levelTwo: 'The road passes [[Unchanged Shrine]].',
    });
    const before = await writerDocument();
    const edited = replaceLevelText(
      splitModuleDocument(before),
      1,
      'The party reaches [[Changed Shrine]].',
    ).document;

    await saveWholeModuleDocument({
      moduleId: writerModuleId,
      doc: edited,
      module: await writerModule(),
      origin: 'user',
      label: 'Edited level 1',
    });
    // A THIRD save that changes level 2 promotes level 2's link; the level 1
    // link is already campaign-level, so nothing double-promotes and the count
    // is exactly the changed level's.
    const second = await saveWholeModuleDocument({
      moduleId: writerModuleId,
      doc: replaceLevelText(
        splitModuleDocument(edited),
        2,
        'The road passes [[Unchanged Shrine]] and the gate.',
      ).document,
      module: await writerModule(),
      origin: 'user',
      label: 'Edited level 2',
    });
    expect(second.savedPlanIndexes).toEqual([1]);
    expect(await ownerOf(changedShrineId)).toBeNull();
    expect(await ownerOf(unchangedShrineId)).toBeNull();
  });
});
