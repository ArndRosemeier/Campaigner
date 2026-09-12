import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { getModule, patchModule, patchModulePartText, saveModule } from '@/db/moduleRepo';
import { updateSettings } from '@/db/settingsRepo';
import {
  createModule,
  modulePartSchema,
  moduleSpineSchema,
  textOriginIsMachineWritten,
  type Campaign,
  type Id,
  type Module,
  type ModulePart,
  type TextOrigin,
} from '@/domain';
import { approveSpineAndRun, normalizeModuleEntityNames, runParts, runSpine } from '@/llm/moduleGen';
import { saveModulePartText } from '@/features/modules/partText';
import type { ChatResult } from '@/llm/openrouter';
import { clearDatabase } from '../db/helpers';

/**
 * AUTHORSHIP vs `edited` (owner report, docs/17 row 113).
 *
 * The owner's bug, verbatim: *"Module creation after creating parts when
 * normalizing now ALWAYS brings up this: 'Normalization wants to update
 * hand-edited text ? review the proposed rewrites.' There is actually nothing
 * hand written."*
 *
 * Two independent causes fed that one banner, and neither was authorship:
 *
 *  1. the premise took the proposal path UNCONDITIONALLY, so a module he never
 *     touched raised the banner whenever its premise named a variant;
 *  2. `edited` was stamped by the one part-text save seam on EVERY write
 *     through it — including model text the canvas auto-accepted — and the
 *     banner read `edited` as "hand-written".
 *
 * This suite pins the fix at every load-bearing line: the origin is recorded
 * at THE ONE save seam (a write that supplies `writerModel` is a MODEL write),
 * the consent rule reads ONE authorship accessor, machine-written text
 * normalizes immediately (the generated premise included), human-authored text
 * still holds, and a row written before the field keeps asking (the
 * conservative default — the origin is NOT recoverable, because a hand edit
 * deliberately carries the previous model id forward).
 *
 * The normalization reply contract is satisfied honestly here: a canonical
 * must be the name itself, ANOTHER LISTED NAME that maps to itself, or an
 * existing artifact (`validateNormalizationReply`) — so the variant and its
 * canonical BOTH appear in the module text, which is exactly how the real
 * prompt gets its vocabulary.
 */

vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {
    constructor() {
      super('No OpenRouter API key configured');
      this.name = 'MissingApiKeyError';
    }
  },
  OpenRouterError: class OpenRouterError extends Error {},
  listModels: vi.fn(),
}));

vi.mock('@/lib/toast', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);

const TEST_MODEL = 'test/fixture-model';

/** Module prose well above the 100-char floor. */
const PROSE =
  'The tide withdraws down the spiral stair and leaves salt on every stone, ' +
  'and the bell above the harbor answers a question nobody asked aloud. ';

/** The variant name and its canonical, both present in the text. */
const VARIANT = 'Guard Halmund';
const CANONICAL = 'Halmund';

/** The one valid verdict for this suite: the variant folds onto the listed
 * canonical, which maps to itself. */
function foldVerdict(): ChatResult {
  return {
    text: JSON.stringify({
      entities: [
        { name: VARIANT, canonical: CANONICAL, kind: 'npc' },
        { name: CANONICAL, canonical: CANONICAL, kind: 'npc' },
      ],
    }),
    modelUsed: TEST_MODEL,
    fallback: null,
  };
}

/** A generator part reply: real prose plus the names the floor/verdicts need. */
function partReply(names: readonly string[]): ChatResult {
  return {
    text:
      `${PROSE}${PROSE}` +
      (names.length === 0
        ? 'Nothing else is named here.'
        : `Named here: ${names.map((name) => `[[${name}]]`).join(' and ')}.`),
    modelUsed: 'staged/part-model',
    fallback: null,
  };
}

async function seedModule(levelMin = 1, levelMax = 1): Promise<{ campaign: Campaign; moduleId: Id }> {
  const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
  const saved = await saveModule(
    createModule({
      campaignId: campaign.id,
      title: 'The Drowned Bell',
      concept: 'A harbor bell that rings by itself beneath the water.',
      levelMin,
      levelMax,
      tone: 'eerie',
      sizeDial: 'standard',
    }),
  );
  await updateSettings({ defaultChatModel: TEST_MODEL });
  return { campaign, moduleId: saved.id };
}

async function seedSpine(moduleId: Id, premise: string, origin: TextOrigin | null): Promise<void> {
  await patchModule(moduleId, {
    spine: moduleSpineSchema.parse({
      premise,
      themes: [],
      partPlan: [
        { title: 'The Sunken Quarter', levelBand: '1', synopsis: '', levelUpTrigger: 'The bell is found.' },
      ],
      origin,
      writerModel: origin === 'model' ? TEST_MODEL : '',
    }),
  });
}

/** Writes ONE part straight onto the row. These tests are about what a WRITE
 * records, so they set the pre-state explicitly rather than going through a
 * seam whose behavior is itself under test. */
async function seedPart(
  moduleId: Id,
  part: {
    planIndex: number;
    markdown: string;
    edited: boolean;
    origin: TextOrigin | null;
    writerModel?: string;
  },
): Promise<void> {
  const current = await getModule(moduleId);
  if (current === undefined) throw new Error('seed module is missing');
  const parts = current.parts.filter((entry) => entry.planIndex !== part.planIndex);
  parts.push(
    modulePartSchema.parse({
      planIndex: part.planIndex,
      markdown: part.markdown,
      status: 'ready',
      errorMessage: '',
      edited: part.edited,
      writerModel: part.writerModel ?? '',
      origin: part.origin,
    }),
  );
  parts.sort((a, b) => a.planIndex - b.planIndex);
  await patchModule(moduleId, { parts });
}

beforeEach(async () => {
  await clearDatabase();
});

afterEach(() => {
  chatMock.mockReset();
  vi.restoreAllMocks();
});

describe('the one part-text save seam records the ORIGIN, not just `edited`', () => {
  it('a write that supplies a writerModel is a MODEL write (edited stays true)', async () => {
    const { moduleId } = await seedModule();

    await patchModulePartText(moduleId, 0, 'Model-written prose.', 'staged/canvas-model');

    const part = (await getModule(moduleId))?.parts[0];
    expect(part?.origin).toBe('model');
    expect(part?.writerModel).toBe('staged/canvas-model');
    // `edited` keeps its old meaning — "written outside the generator" — so no
    // other surface's reading of it changes.
    expect(part?.edited).toBe(true);
    // And the ONE accessor agrees with the record.
    expect(textOriginIsMachineWritten(part?.origin)).toBe(true);
  });

  it('a write that omits it is a HUMAN write, and carries the recorded model id forward', async () => {
    const { moduleId } = await seedModule();
    await patchModulePartText(moduleId, 0, 'Model-written prose.', 'staged/canvas-model');

    // The owner's hand edit through the sanctioned feature seam: no id.
    await saveModulePartText(moduleId, 0, 'The owner rewrote this passage by hand.');

    const part = (await getModule(moduleId))?.parts[0];
    expect(part?.origin).toBe('human');
    // The provenance of the text they edited SURVIVES (docs/17 row 93).
    expect(part?.writerModel).toBe('staged/canvas-model');
    expect(part?.edited).toBe(true);
    expect(textOriginIsMachineWritten(part?.origin)).toBe(false);
  });

  it('a first human write on a part with no recorded id stays empty and reads as human', async () => {
    const { moduleId } = await seedModule();

    await saveModulePartText(moduleId, 0, 'Typed straight into the reader.');

    const part = (await getModule(moduleId))?.parts[0];
    expect(part?.writerModel).toBe('');
    expect(part?.origin).toBe('human');
  });
});

describe('the generated PREMISE normalizes automatically; a hand-edited one holds', () => {
  it('rewrites a machine-written premise in place and keeps its model origin', async () => {
    const { moduleId } = await seedModule();
    await seedSpine(moduleId, `The bell tolls for [[${VARIANT}]] and [[${CANONICAL}]].`, 'model');
    chatMock.mockResolvedValueOnce(foldVerdict());

    await normalizeModuleEntityNames(moduleId);

    const after = await getModule(moduleId);
    // Applied, display text preserved — no proposal, so no banner.
    expect(after?.spine?.premise).toBe(
      `The bell tolls for [[${CANONICAL}|${VARIANT}]] and [[${CANONICAL}]].`,
    );
    expect(after?.spine?.origin).toBe('model');
    expect(after?.entityRewriteProposals).toBeNull();
  });

  it('HOLDS a premise the owner wrote — the consent protection is unchanged', async () => {
    const { moduleId } = await seedModule();
    await seedSpine(moduleId, `The bell tolls for [[${VARIANT}]] and [[${CANONICAL}]].`, 'human');
    chatMock.mockResolvedValueOnce(foldVerdict());

    await normalizeModuleEntityNames(moduleId);

    const after = await getModule(moduleId);
    expect(after?.spine?.premise).toBe(
      `The bell tolls for [[${VARIANT}]] and [[${CANONICAL}]].`,
    );
    expect(after?.spine?.origin).toBe('human');
    expect(after?.entityRewriteProposals).toEqual([
      { planIndex: -1, replacements: [{ from: VARIANT, to: CANONICAL }] },
    ]);
  });
});

describe('the consent rule reads AUTHORSHIP, not `edited`', () => {
  it('applies the rewrite to a canvas-applied MODEL part (which is `edited: true`)', async () => {
    const { moduleId } = await seedModule();
    await seedSpine(moduleId, 'A quiet harbor town.', 'model');
    await seedPart(moduleId, {
      planIndex: 0,
      markdown: `${PROSE}${PROSE}Here lives [[${VARIANT}]] near [[${CANONICAL}]].`,
      edited: true,
      origin: 'model',
      writerModel: 'staged/canvas-model',
    });
    chatMock.mockResolvedValueOnce(foldVerdict());

    await normalizeModuleEntityNames(moduleId);

    const after = await getModule(moduleId);
    expect(after?.parts[0]?.markdown).toContain(`[[${CANONICAL}|${VARIANT}]]`);
    expect(after?.parts[0]?.edited).toBe(true);
    expect(after?.parts[0]?.origin).toBe('model');
    // The whole point of the owner's report: NOTHING is held, so no banner.
    expect(after?.entityRewriteProposals).toBeNull();
  });

  it('HOLDS the rewrite of a part the owner wrote, and rewrites the generated one beside it', async () => {
    const { moduleId } = await seedModule();
    await seedSpine(moduleId, 'A quiet harbor town.', 'model');
    await seedPart(moduleId, {
      planIndex: 0,
      markdown: `${PROSE}${PROSE}The owner typed [[${VARIANT}]] and [[${CANONICAL}]].`,
      edited: true,
      origin: 'human',
      writerModel: 'staged/canvas-model',
    });
    await seedPart(moduleId, {
      planIndex: 1,
      markdown: `${PROSE}${PROSE}The generator wrote [[${VARIANT}]] and [[${CANONICAL}]].`,
      edited: false,
      origin: 'model',
    });
    chatMock.mockResolvedValueOnce(foldVerdict());

    await normalizeModuleEntityNames(moduleId);

    const after = await getModule(moduleId);
    expect(after?.parts.find((part) => part.planIndex === 0)?.markdown).toContain(
      `[[${VARIANT}]]`,
    );
    expect(after?.parts.find((part) => part.planIndex === 1)?.markdown).toContain(
      `[[${CANONICAL}|${VARIANT}]]`,
    );
    expect(after?.entityRewriteProposals).toEqual([
      { planIndex: 0, replacements: [{ from: VARIANT, to: CANONICAL }] },
    ]);
  });

  it('the GENERATOR writes `origin: model` on the spine it generates, so its own premise never asks', async () => {
    const { campaign, moduleId } = await seedModule();
    // The spine pass: the model reply, then the pass's own normalization call.
    chatMock
      .mockResolvedValueOnce({
        text: JSON.stringify({
          premise: `The bell tolls for [[${VARIANT}]] and [[${CANONICAL}]].`,
          themes: ['duty'],
          partPlan: [
            { title: 'The Sunken Quarter', levelBand: '1', synopsis: '', levelUpTrigger: 'The bell is found.' },
          ],
          entities: [
            { name: VARIANT, kind: 'npc' },
            { name: CANONICAL, kind: 'npc' },
            // The pass-0 spine gate reads the DECLARED kinds: one named
            // encounter record keeps it quiet (08 §M4-B).
            { name: 'The Bells Below', kind: 'encounter' },
          ],
        }),
        modelUsed: 'staged/spine-model',
        fallback: null,
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          entities: [
            { name: VARIANT, canonical: VARIANT, kind: 'npc' },
            { name: CANONICAL, canonical: CANONICAL, kind: 'npc' },
            // The pass's own normalizer answers the DECLARED records too.
            { name: 'The Bells Below', canonical: 'The Bells Below', kind: 'encounter' },
          ],
        }),
        modelUsed: TEST_MODEL,
        fallback: null,
      });

    await runSpine(moduleId, campaign);

    const generated = await getModule(moduleId);
    // The generator's own premise is the MODEL's text, recorded as such — not
    // a `null` that would read as the owner's and make the pass ask him about
    // a premise he never saw (the owner's report, exactly).
    expect(generated?.spine?.origin).toBe('model');
    expect(generated?.spine?.writerModel).toBe('staged/spine-model');

    // …and the NEXT normalization pass rewrites that premise in place: no
    // proposal, no banner.
    await patchModule(moduleId, {
      entityKinds: [
        { name: VARIANT, kind: 'npc', absorbed: [] },
        { name: CANONICAL, kind: 'npc', absorbed: [] },
      ],
    });
    chatMock.mockReset();
    chatMock.mockResolvedValueOnce(foldVerdict());

    await normalizeModuleEntityNames(moduleId);

    const after = await getModule(moduleId);
    expect(after?.spine?.premise).toBe(
      `The bell tolls for [[${CANONICAL}|${VARIANT}]] and [[${CANONICAL}]].`,
    );
    expect(after?.entityRewriteProposals).toBeNull();
  }, 20000);

  it('the GENERATOR writes `origin: model` and `edited: false` on a part it generates', async () => {
    const { campaign, moduleId } = await seedModule();
    await seedSpine(moduleId, 'A quiet harbor town.', 'model');
    await patchModule(moduleId, {
      entityKinds: [{ name: CANONICAL, kind: 'npc', absorbed: [] }],
    });
    chatMock
      // The parts pass's own post-pass normalization call…
      .mockResolvedValueOnce({ text: JSON.stringify({ entities: [] }), modelUsed: TEST_MODEL, fallback: null })
      // …then the single part call.
      .mockResolvedValue(partReply([CANONICAL]));

    await runParts(moduleId, campaign);

    const after = await getModule(moduleId);
    expect(after?.parts).toHaveLength(1);
    expect(after?.parts[0]?.edited).toBe(false);
    expect(after?.parts[0]?.origin).toBe('model');
    expect(after?.parts[0]?.writerModel).toBe('staged/part-model');
  });
});

describe('the legacy default: a row with NO origin keeps asking', () => {
  it('holds a rewrite when the origin is not recorded, and the accessor says so', async () => {
    const { moduleId } = await seedModule();
    // A row from before the field: `edited` with `origin: null`. The origin is
    // NOT recoverable — a hand edit carries the previous `writerModel` forward,
    // which is exactly why the recorded id below proves nothing.
    await seedSpine(moduleId, 'A quiet harbor town.', null);
    await seedPart(moduleId, {
      planIndex: 0,
      markdown: `${PROSE}${PROSE}Legacy text names [[${VARIANT}]] and [[${CANONICAL}]].`,
      edited: true,
      origin: null,
      writerModel: 'some/model-from-before',
    });
    chatMock.mockResolvedValueOnce(foldVerdict());

    await normalizeModuleEntityNames(moduleId);

    const after = await getModule(moduleId);
    expect(after?.parts[0]?.markdown).toContain(`[[${VARIANT}]]`);
    expect(after?.entityRewriteProposals).toEqual([
      { planIndex: 0, replacements: [{ from: VARIANT, to: CANONICAL }] },
    ]);
    // The conservative default, pinned: an unrecorded origin is NEVER
    // machine-written, and a recorded model id never makes it so (there is no
    // `writerModel`-shaped input to this function at all).
    expect(textOriginIsMachineWritten(null)).toBe(false);
    expect(textOriginIsMachineWritten(undefined)).toBe(false);
    expect(textOriginIsMachineWritten('human')).toBe(false);
    expect(textOriginIsMachineWritten('model')).toBe(true);
  });

  it('holds a legacy premise too (it is not the generated one)', async () => {
    const { moduleId } = await seedModule();
    await seedSpine(moduleId, `The bell tolls for [[${VARIANT}]] and [[${CANONICAL}]].`, null);
    chatMock.mockResolvedValueOnce(foldVerdict());

    await normalizeModuleEntityNames(moduleId);

    const after = await getModule(moduleId);
    expect(after?.spine?.premise).toBe(
      `The bell tolls for [[${VARIANT}]] and [[${CANONICAL}]].`,
    );
    expect(after?.entityRewriteProposals).toEqual([
      { planIndex: -1, replacements: [{ from: VARIANT, to: CANONICAL }] },
    ]);
  });

  it('an UNCHANGED approved premise keeps the model origin (clicking through the checkpoint claims nothing)', async () => {
    const { campaign, moduleId } = await seedModule();
    await seedSpine(moduleId, 'A quiet harbor town.', 'model');
    const stored = await getModule(moduleId);
    if (stored?.spine === null || stored?.spine === undefined) {
      throw new Error('seed spine missing');
    }
    await patchModule(moduleId, {
      entityKinds: [{ name: CANONICAL, kind: 'npc', absorbed: [] }],
    });
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify({ entities: [] }), modelUsed: TEST_MODEL, fallback: null })
      .mockResolvedValue(partReply([CANONICAL]));

    await approveSpineAndRun(moduleId, campaign, stored.spine);

    const after = await getModule(moduleId);
    expect(after?.spine?.origin).toBe('model');
    expect(after?.spine?.writerModel).toBe(TEST_MODEL);
  });

  it('a premise the owner REWROTE at the checkpoint is stamped human', async () => {
    const { campaign, moduleId } = await seedModule();
    await seedSpine(moduleId, 'A quiet harbor town.', 'model');
    const stored = await getModule(moduleId);
    if (stored?.spine === null || stored?.spine === undefined) {
      throw new Error('seed spine missing');
    }
    await patchModule(moduleId, {
      entityKinds: [{ name: CANONICAL, kind: 'npc', absorbed: [] }],
    });
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify({ entities: [] }), modelUsed: TEST_MODEL, fallback: null })
      .mockResolvedValue(partReply([CANONICAL]));

    await approveSpineAndRun(moduleId, campaign, {
      ...stored.spine,
      premise: 'The owner rewrote the premise himself before generating.',
    });

    const after = await getModule(moduleId);
    expect(after?.spine?.origin).toBe('human');
    // The recorded writing model is untouched: it still answers "which model
    // wrote this", and it does NOT make the text machine-written.
    expect(after?.spine?.writerModel).toBe(TEST_MODEL);
  });
});

describe('the stored-shape contract', () => {
  it('parses a part and a spine written before the field as `origin: null` (no Dexie version)', async () => {
    const { moduleId } = await seedModule();
    const raw = await getModule(moduleId);
    if (raw === undefined) throw new Error('seed module missing');
    // Write the PRE-FIELD shape straight into the row, exactly as a row
    // persisted before this change carries it (no `origin` key at all).
    await saveModule({
      ...raw,
      spine: {
        premise: 'A quiet harbor town.',
        themes: [],
        partPlan: [{ title: 'One', levelBand: '1', synopsis: '', levelUpTrigger: '' }],
        writerModel: 'old/model',
      } as unknown as Module['spine'],
      parts: [
        {
          planIndex: 0,
          markdown: 'Old text.',
          status: 'ready',
          errorMessage: '',
          edited: true,
          writerModel: 'old/model',
        } as unknown as ModulePart,
      ],
    });

    const parsed = await getModule(moduleId);
    expect(parsed?.spine?.origin).toBeNull();
    expect(parsed?.parts[0]?.origin).toBeNull();
    // The conservative default applies to both.
    expect(textOriginIsMachineWritten(parsed?.spine?.origin)).toBe(false);
    expect(textOriginIsMachineWritten(parsed?.parts[0]?.origin)).toBe(false);
  });
});
