import 'fake-indexeddb/auto';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { getModule, saveModule } from '@/db/moduleRepo';
import { listModuleVersions, snapshotModuleVersion } from '@/db/moduleVersionRepo';
import {
  assembleModulePartsDocument,
  createModule,
  modulePartSchema,
  moduleSpineSchema,
  splitPartsDocument,
  type Id,
  type Module,
} from '@/domain';
import { countModuleEncounters, encounterFloorMessage } from '@/llm/moduleGen';
import { saveWholeModuleDocument } from '@/features/modules/canvas/saveDoc';
import { clearDatabase } from '../db/helpers';

/**
 * The scene block is a DOCUMENT-FORMAT change with no schema behind it
 * (08-MODULE-DESIGNER §M4-B-2, docs/18 §2.2, docs/17 row 73): the block lives
 * inside the part's ordinary markdown, so the ONE `assembleModulePartsDocument`
 * / `splitPartsDocument` format, the canvas split-save, the byte-exact durable
 * version snapshots and the encounter floor's `[[encounter]]` counting must all
 * keep working on exactly the same text.
 *
 * This file pins that contract end to end, without the UI:
 * assemble → split → split-save → snapshot → restore-from-snapshot, with a
 * generated-style scene block part AND a legacy prose part in the same
 * document. A legacy part has no scene blocks at all and must keep rendering,
 * counting and saving.
 */

vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

vi.mock('@/db/artifactAutoPromote', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  promoteSecondModuleUses: vi.fn(),
}));

/** A generated-style scene block: every field label, in the declared order. */
const SCENE_BLOCK = `## [[The Bell Beneath the Sluice]] — ENCOUNTER

**Where** — [[Old Tower]].

**First impression** — The sluice gate sweats cold brine, and a bell rope hangs straight down into water that has no current.

**Who is here and what they want right now** — [[Keeper Ilse]] wants the gate left shut until the noon tide; the drowned bell wants a hand on the rope.

**The situation** — The keeper is already losing the argument with the cult's diver below the gate, and in a few minutes the gate opens whether she agrees or not.

**What changed** — The keeper now answers to the diver; reaching her costs the party the only dry route back up.

**If the party acts**
- Cut the bell rope -> the diver surfaces and the fight starts on the walkway.
- Bargain with the keeper -> she names the diver, and the cult learns the party is here.
- Jam the sluice -> the water rises somewhere else, drowning the cache they came for.

**Secrets** — The gate key is a bell clapper, whoever carries it.
A ledger of tolls paid in bodies sits under the third step.

**Leads** — [[The Tide Cult]] — the diver was sent, so someone is waiting. The bell's inscription points at [[The Flooded Nave]].

**Outcome** — Success: the gate holds and the keeper keeps her post. Partial success: the gate holds, and the diver carries word downstream. Failure: the gate opens; the walkway is gone, and whoever is below now knows the party is coming.`;

/** A legacy part: prose written before the block existed, with one encounter. */
const LEGACY_PART = 'The party bargains at the gate with [[Keeper Ilse]].\n\nRain hammers the stones.';

const PART_PLAN = [
  { title: 'The Gate Bargain', levelBand: '1', synopsis: '', levelUpTrigger: '' },
  { title: 'Under the Docks', levelBand: '2', synopsis: '', levelUpTrigger: '' },
];

const ENTITY_KINDS = [
  { name: 'The Bell Beneath the Sluice', kind: 'encounter' as const },
  { name: 'Old Tower', kind: 'location' as const },
  { name: 'Keeper Ilse', kind: 'npc' as const },
  { name: 'The Tide Cult', kind: 'faction' as const },
  { name: 'The Flooded Nave', kind: 'location' as const },
];

const WHOLE_DOC = assembleModulePartsDocument({
  partPlan: PART_PLAN,
  parts: [
    { planIndex: 0, markdown: LEGACY_PART },
    { planIndex: 1, markdown: SCENE_BLOCK },
  ],
}).document;

let world: { campaignId: Id; moduleId: Id } = { campaignId: '', moduleId: '' };

async function seedModule(): Promise<void> {
  const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
  const draft = createModule({
    campaignId: campaign.id,
    title: 'The Drowned Bell',
    concept: 'A harbor bell that rings by itself beneath the water.',
    levelMin: 1,
    levelMax: 2,
    tone: 'eerie',
    sizeDial: 'standard',
  });
  const saved = await saveModule({
    ...draft,
    status: 'ready',
    spine: moduleSpineSchema.parse({
      premise: 'A harbor town raised its bell to warn of the drownings.',
      themes: ['duty'],
      partPlan: PART_PLAN,
    }),
    parts: [
      modulePartSchema.parse({ planIndex: 0, markdown: LEGACY_PART, status: 'ready', errorMessage: '', edited: false }),
      modulePartSchema.parse({ planIndex: 1, markdown: SCENE_BLOCK, status: 'ready', errorMessage: '', edited: false }),
    ],
    entityKinds: ENTITY_KINDS.map((entry) => ({ ...entry, absorbed: [] })),
  });
  world = { campaignId: campaign.id, moduleId: saved.id };
}

async function rowModule(): Promise<Module> {
  const row = await getModule(world.moduleId);
  if (row === undefined) throw new Error('module row missing');
  return row;
}

/** The row's document right now — assembled through the ONE format. */
async function rowDocument(): Promise<string> {
  const row = await rowModule();
  return assembleModulePartsDocument({
    partPlan: row.spine?.partPlan ?? [],
    parts: row.parts,
  }).document;
}

beforeEach(async () => {
  await clearDatabase();
  await seedModule();
});

describe('a scene block is ordinary part markdown (ONE document format)', () => {
  it('survives assemble -> split byte-exactly, field labels and all', () => {
    const sections = splitPartsDocument(WHOLE_DOC, PART_PLAN);

    expect(sections).toHaveLength(2);
    expect(sections[1]?.text).toBe(SCENE_BLOCK);
    // The block's own markdown is intact: heading, every label, the arrow
    // bullets and the blank lines that separate them.
    for (const label of [
      '**Where**',
      '**First impression**',
      '**Who is here and what they want right now**',
      '**The situation**',
      '**What changed**',
      '**If the party acts**',
      '**Secrets**',
      '**Leads**',
      '**Outcome**',
    ]) {
      expect(sections[1]?.text).toContain(label);
    }
    expect(sections[1]?.text).toContain('Cut the bell rope -> the diver surfaces');
    // Re-assembling the split sections reproduces the document byte-exactly.
    expect(
      assembleModulePartsDocument({
        partPlan: PART_PLAN,
        parts: sections.map((section) => ({ planIndex: section.planIndex, markdown: section.text })),
      }).document,
    ).toBe(WHOLE_DOC);
  });

  it('does not trip the fake-header guard — a scene heading is not a part label', () => {
    // The guard refuses content that fakes the scaffolding. A scene block must
    // never look like `[Part n of m — Title]`, and the reader-facing headings
    // it uses instead are ordinary markdown.
    expect(() => splitPartsDocument(WHOLE_DOC, PART_PLAN)).not.toThrow();
    const spoofed = WHOLE_DOC.replace('## [[The Bell Beneath the Sluice]] — ENCOUNTER', '[Part 3 of 3 — Fake]');
    expect(() => splitPartsDocument(spoofed, PART_PLAN)).toThrow(/fakes? the parts-document scaffolding/);
  });

  it('round-trips through the canvas split-save byte-exactly', async () => {
    // A hand edit inside the block: the split-save writes ONLY the changed part.
    const edited = SCENE_BLOCK.replace('**Secrets** — The gate key', '**Secrets** — The gate key is wet.');
    const doc = assembleModulePartsDocument({
      partPlan: PART_PLAN,
      parts: [
        { planIndex: 0, markdown: LEGACY_PART },
        { planIndex: 1, markdown: edited },
      ],
    }).document;

    const result = await saveWholeModuleDocument({
      moduleId: world.moduleId,
      doc,
      module: await rowModule(),
      origin: 'user',
      label: 'Hand edit',
    });

    // Only part 1 changed (the legacy part is untouched → no write).
    expect(result.savedPlanIndexes).toEqual([1]);
    expect(result.failedParts).toEqual([]);
    expect(await rowDocument()).toBe(doc);
    expect((await rowModule()).parts.find((part) => part.planIndex === 0)?.markdown).toBe(LEGACY_PART);
    // The legacy part keeps whatever edit state it had: nothing marked it edited.
    expect((await rowModule()).parts.find((part) => part.planIndex === 0)?.edited).toBe(false);
  });

  it('survives a durable snapshot and a restore from that snapshot byte-exactly', async () => {
    const before = await rowDocument();

    // An AI save snapshots the pre-change document (docs/18 §2.3) and applies it.
    const changed = WHOLE_DOC.replace('the diver carries word downstream', 'the diver carries word upstream');
    expect(changed).not.toBe(WHOLE_DOC);
    await saveWholeModuleDocument({
      moduleId: world.moduleId,
      doc: changed,
      module: await rowModule(),
      origin: 'ai',
      label: 'Rewrite the outcome',
      version: { source: 'generation', label: 'Rewrite the outcome' },
    });
    expect(await rowDocument()).toBe(changed);

    const versions = await listModuleVersions(world.moduleId);
    expect(versions).toHaveLength(1);
    // The snapshot is the WHOLE document, byte-exact, scene blocks included.
    expect(versions[0]?.docText).toBe(before);
    expect(versions[0]?.docText).toContain('## [[The Bell Beneath the Sluice]] — ENCOUNTER');

    // Restore: the snapshot is validated against the CURRENT plan by the same
    // split the canvas restore uses, then lands through the same split-save.
    const snapshot = versions[0]?.docText ?? '';
    const sections = splitPartsDocument(snapshot, PART_PLAN);
    expect(sections[1]?.text).toBe(SCENE_BLOCK);
    await saveWholeModuleDocument({
      moduleId: world.moduleId,
      doc: snapshot,
      module: await rowModule(),
      origin: 'ai',
      label: 'Restore from test',
      version: { source: 'restore', label: 'Restore from test' },
    });
    expect(await rowDocument()).toBe(before);
  });

  it('a legacy prose part still saves, still parses and still counts (no migration)', async () => {
    // Nothing about the legacy part's own text changes: it carries no scene
    // blocks and no label lines, and the document around it still splits.
    const row = await rowModule();
    const legacy = row.parts.find((part) => part.planIndex === 0)?.markdown ?? '';
    expect(legacy).toBe(LEGACY_PART);
    expect(splitPartsDocument(WHOLE_DOC, PART_PLAN)[0]?.text).toBe(LEGACY_PART);

    // A hand edit to the legacy part lands on the row through the SAME path.
    const editedLegacy = `${LEGACY_PART}\n\nThe keeper wants the party gone by dusk.`;
    const doc = assembleModulePartsDocument({
      partPlan: PART_PLAN,
      parts: [
        { planIndex: 0, markdown: editedLegacy },
        { planIndex: 1, markdown: SCENE_BLOCK },
      ],
    }).document;
    const result = await saveWholeModuleDocument({
      moduleId: world.moduleId,
      doc,
      module: await rowModule(),
      origin: 'user',
      label: 'Hand edit',
    });
    expect(result.savedPlanIndexes).toEqual([0]);
    expect((await rowModule()).parts.find((part) => part.planIndex === 0)?.edited).toBe(true);
    expect(await rowDocument()).toBe(doc);
  });

  it('the snapshot of a document that has no scene blocks is unchanged behavior', async () => {
    const doc = assembleModulePartsDocument({
      partPlan: PART_PLAN,
      parts: [
        { planIndex: 0, markdown: LEGACY_PART },
        { planIndex: 1, markdown: LEGACY_PART },
      ],
    }).document;
    await saveWholeModuleDocument({
      moduleId: world.moduleId,
      doc,
      module: await rowModule(),
      origin: 'user',
      label: 'Hand edit',
    });
    const version = await snapshotModuleVersion(world.moduleId, 'generation', 'Legacy capture');
    expect(version?.docText).toBe(doc);
  });
});

describe('the encounter floor is untouched — the block links, nothing else changes', () => {
  it('a scene block names its encounter with an ordinary [[link]], so the counter sees it', () => {
    // The block introduces no new link syntax and no new record: the only thing
    // the floor reads is a canonical `[[encounter]]` link in the part text, and
    // a scene-block heading carries exactly that.
    const section = splitPartsDocument(WHOLE_DOC, PART_PLAN)[1]?.text ?? '';
    expect(section).toContain('[[The Bell Beneath the Sluice]]');
    const row = {
      ...createModule({
        campaignId: '123e4567-e89b-42d3-a456-426614174000',
        title: 'Block',
        concept: 'concept',
        levelMin: 1,
        levelMax: 2,
        sizeDial: 'standard',
      }),
      spine: moduleSpineSchema.parse({ premise: 'p', themes: [], partPlan: PART_PLAN }),
      parts: PART_PLAN.map((_, planIndex) =>
        modulePartSchema.parse({
          planIndex,
          markdown: planIndex === 1 ? SCENE_BLOCK : LEGACY_PART,
          status: 'ready',
          errorMessage: '',
          edited: false,
        }),
      ),
      entityKinds: ENTITY_KINDS.map((entry) => ({ ...entry, absorbed: [] })),
    } satisfies Module;
    const report = countModuleEncounters(row);
    // The encounter named in the block's heading counts for its band; the
    // legacy prose part names none, so its band stays deficient — identical to
    // how the same document counted before the field set existed.
    expect(report.found).toBe(1);
    expect(report.deficient.map((entry) => entry.planIndex)).toEqual([0]);
  });

  it('a legacy document with no scene blocks counts and fails exactly as the golden says', () => {
    // The golden's own shape (the two plan titles it names, levels 1-2, one
    // encounter per level) with no encounter linked anywhere: prose written
    // before this format existed.
    const module = {
      ...createModule({
        campaignId: '123e4567-e89b-42d3-a456-426614174000',
        title: 'Legacy',
        concept: 'concept',
        levelMin: 1,
        levelMax: 2,
        sizeDial: 'standard',
      }),
      spine: moduleSpineSchema.parse({
        premise: 'A quiet premise.',
        themes: [],
        partPlan: [
          { title: 'The Sunken Quarter', levelBand: '1', synopsis: '', levelUpTrigger: '' },
          { title: 'The Drowned Cathedral', levelBand: '2', synopsis: '', levelUpTrigger: '' },
        ],
      }),
      parts: [0, 1].map((planIndex) =>
        modulePartSchema.parse({
          planIndex,
          markdown: 'Prose written before the block existed. No fights named here.',
          status: 'ready',
          errorMessage: '',
          edited: false,
        }),
      ),
      entityKinds: [{ name: 'Ember Trial', kind: 'encounter' as const, absorbed: [] }],
    } satisfies Module;
    const report = countModuleEncounters(module);
    expect(report.required).toBe(2);
    expect(report.found).toBe(0);
    expect(report.deficient.map((entry) => entry.planIndex)).toEqual([0, 1]);
    // The failure copy is the floor's own golden text, byte-identical — the
    // floor-message golden does not change with the scene-block format.
    expect(encounterFloorMessage(report)).toBe(
      readFileSync(
        join(process.cwd(), 'tests', 'fixtures', 'encounterGuardrails', 'floor-message-default.txt'),
        'utf8',
      ),
    );
  });
});
