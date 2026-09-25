import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ADVERSARIAL_ISSUE_KINDS,
  adversarialCritiqueReplySchema,
  adversarialIssueKindSchema,
  runAdversarialPass,
  type AdversarialIssue,
} from '@/llm/adversarialPass';
import {
  refineModuleText,
  transformModuleText,
  type CanvasRefineInput,
} from '@/llm/canvasRefine';
import { isModuleGenerationClaimed } from '@/llm/canvasBusy';
import { ModuleBusyError } from '@/llm/moduleGen';
import { createCampaign } from '@/db/campaignRepo';
import {
  assembleModulePartsDocument,
  createModule,
  modulePartSchema,
  moduleSpineSchema,
  type Id,
} from '@/domain';
import { getModule, patchModule, saveModule } from '@/db/moduleRepo';
import { listModuleVersions } from '@/db/moduleVersionRepo';
import { clearDatabase } from '../db/helpers';
import { CODE, filesWith } from '../helpers/sourceCode';

/**
 * The ADVERSARIAL critique-and-edit pass (docs/17 rows 352/353/356): EXACTLY
 * the owner's four issue kinds, an ADVISORY critique (findings never throw and
 * never block; an empty critique is quiet; only a malformed reply fails loudly),
 * the editor REUSING the ONE validated text-transform core for BOTH a premise
 * and a part target, a durable snapshot BEFORE the critique (and so before any
 * caller write), and the GUARD SPLIT — the canvas caller still refuses a
 * generating module while the shared core does not.
 *
 * The transport is mocked at the protocol boundary; the schema, the pass and
 * the core run for real.
 */

vi.mock('@/llm/openrouter', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  chat: vi.fn(),
}));

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);

const CRITIQUE_SCHEMA = 'adversarial-critique';
const EDIT_SCHEMA = 'canvas-refine';

const PREMISE = 'The party must recover the Drowned Vault before the tide returns.';
const DOC = '## The Gate Bargain\n\nThe party bargains with [[Keeper Ilse]] at the gate.';

let world: { campaignId: Id; moduleId: Id } = { campaignId: '', moduleId: '' };

async function seedModule(): Promise<void> {
  const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
  const draft = createModule({
    campaignId: campaign.id,
    title: 'The Drowned Vault',
    concept: 'concept',
    levelMin: 1,
    levelMax: 2,
    tone: '',
    sizeDial: 'standard',
  });
  await saveModule({
    ...draft,
    spine: moduleSpineSchema.parse({
      premise: PREMISE,
      themes: [],
      partPlan: [
        { title: 'The Gate Bargain', levelBand: '1', synopsis: '', levelUpTrigger: '' },
        { title: 'Under the Docks', levelBand: '2', synopsis: '', levelUpTrigger: '' },
      ],
    }),
    parts: [
      modulePartSchema.parse({
        planIndex: 0,
        markdown: DOC,
        status: 'ready',
        errorMessage: '',
        edited: false,
      }),
    ],
  });
  world = { campaignId: campaign.id, moduleId: draft.id };
}

function issue(overrides: Partial<AdversarialIssue> = {}): AdversarialIssue {
  return {
    kind: 'inconsistency',
    severity: 'major',
    message: 'The vault is north of the gate here and south of it later.',
    where: 'second paragraph',
    ...overrides,
  };
}

/** The schema NAME of the call in flight — the pass's two calls differ by it. */
function schemaNameOf(opts: unknown): string {
  const format = (opts as { responseFormat?: { name?: string } } | undefined)?.responseFormat;
  return format?.name ?? '';
}

/** A critique reply, then an editor reply (the pass's real order). */
function mockCritiqueThenEdit(issues: unknown, replacement = 'The rewritten premise.'): void {
  chatMock.mockImplementation((_messages, opts) => {
    if (schemaNameOf(opts) === CRITIQUE_SCHEMA) {
      return Promise.resolve({
        text: JSON.stringify({ issues }),
        modelUsed: 'critic-model',
        fallback: null,
      });
    }
    return Promise.resolve({
      text: JSON.stringify({ replacement }),
      modelUsed: 'editor-model',
      fallback: null,
    });
  });
}

function canvasInput(overrides: Partial<CanvasRefineInput> = {}): CanvasRefineInput {
  return {
    moduleId: world.moduleId,
    scope: 'part',
    instruction: 'tighten the scene',
    text: DOC,
    enclosingBlock: '',
    turn: new AbortController(),
    ...overrides,
  };
}

/** `opts` of the Nth chat call, by schema name. */
function callOptions(name: string): { messages: unknown } | undefined {
  const call = chatMock.mock.calls.find(([, opts]) => schemaNameOf(opts) === name);
  if (call === undefined) return undefined;
  return { messages: call[0] };
}

function userTextOf(messages: unknown): string {
  const list = messages as { role: string; content: unknown }[] | undefined;
  const user = list?.[1]?.content;
  if (typeof user !== 'string') throw new Error('expected string user content');
  return user;
}

beforeEach(async () => {
  await clearDatabase();
  vi.clearAllMocks();
  await seedModule();
});

describe('the critique contract — EXACTLY the owner\'s four kinds (docs/17 rows 353/356)', () => {
  it('declares the four kinds and rejects a fifth', () => {
    expect(ADVERSARIAL_ISSUE_KINDS).toEqual([
      'inconsistency',
      'motivation',
      'fun',
      'originality',
    ]);
    expect(adversarialIssueKindSchema.options).toEqual([...ADVERSARIAL_ISSUE_KINDS]);
    for (const kind of ADVERSARIAL_ISSUE_KINDS) {
      const parsed = adversarialCritiqueReplySchema.parse({
        issues: [{ kind, severity: 'minor', message: 'm', where: 'w' }],
      });
      expect(parsed.issues[0]?.kind).toBe(kind);
    }
    // The REJECTION is asserted, not just the acceptance: a schema that took an
    // unknown kind would accept a criterion the owner did not post.
    expect(() =>
      adversarialCritiqueReplySchema.parse({
        issues: [{ kind: 'pacing', severity: 'minor', message: 'm', where: 'w' }],
      }),
    ).toThrow();
    expect(() =>
      adversarialCritiqueReplySchema.parse({
        issues: [{ kind: 'fairness', severity: 'minor', message: 'm', where: 'w' }],
      }),
    ).toThrow();
  });

  it('an empty issues list is a valid critique, and a finding needs its words', () => {
    expect(adversarialCritiqueReplySchema.parse({ issues: [] }).issues).toEqual([]);
    expect(() =>
      adversarialCritiqueReplySchema.parse({
        issues: [{ kind: 'fun', severity: 'minor', message: '', where: 'w' }],
      }),
    ).toThrow();
  });

  it('a finding is ADVISORY: the pass resolves and returns the edit', async () => {
    mockCritiqueThenEdit([issue(), issue({ kind: 'fun', severity: 'minor', where: 'the ending' })]);
    const report = await runAdversarialPass({
      moduleId: world.moduleId,
      target: { kind: 'premise' },
      text: PREMISE,
    });
    expect(report.critique.issues.map((entry) => entry.kind)).toEqual(['inconsistency', 'fun']);
    expect(report.critique.modelUsed).toBe('critic-model');
    expect(report.edit).toMatchObject({
      replacement: 'The rewritten premise.',
      modelUsed: 'editor-model',
    });
    expect(report.originalText).toBe(PREMISE);
  });

  it('an empty critique is a normal, QUIET outcome — the editor is never called', async () => {
    chatMock.mockResolvedValue({
      text: JSON.stringify({ issues: [] }),
      modelUsed: 'critic-model',
      fallback: null,
    });
    const report = await runAdversarialPass({
      moduleId: world.moduleId,
      target: { kind: 'premise' },
      text: PREMISE,
    });
    expect(report.critique.issues).toEqual([]);
    expect(report.edit).toBeNull();
    expect(chatMock).toHaveBeenCalledTimes(1);
    expect(schemaNameOf(chatMock.mock.calls[0]?.[1])).toBe(CRITIQUE_SCHEMA);
  });

  it('a malformed critique reply fails LOUDLY (zod at the boundary)', async () => {
    chatMock.mockResolvedValue({ text: 'no json at all', modelUsed: 'm', fallback: null });
    await expect(
      runAdversarialPass({ moduleId: world.moduleId, target: { kind: 'premise' }, text: PREMISE }),
    ).rejects.toThrow(/no JSON object/i);

    chatMock.mockResolvedValue({
      text: JSON.stringify({ issues: [{ kind: 'pacing', severity: 'minor', message: 'm', where: 'w' }] }),
      modelUsed: 'm',
      fallback: null,
    });
    await expect(
      runAdversarialPass({ moduleId: world.moduleId, target: { kind: 'premise' }, text: PREMISE }),
    ).rejects.toThrow();
    // A malformed reply is never read as "nothing found".
    expect(chatMock).toHaveBeenCalledTimes(2);
  });

  it('empty target text fails loudly before any call', async () => {
    await expect(
      runAdversarialPass({ moduleId: world.moduleId, target: { kind: 'premise' }, text: '   ' }),
    ).rejects.toThrow(/current text/i);
    expect(chatMock).not.toHaveBeenCalled();
  });
});

describe('the editor — the ONE text-transform core, for a PREMISE and for a PART', () => {
  it('rewrites the PREMISE through the core, with the findings as the instruction', async () => {
    mockCritiqueThenEdit([issue()], 'The rewritten premise.');
    const report = await runAdversarialPass({
      moduleId: world.moduleId,
      target: { kind: 'premise' },
      text: PREMISE,
    });
    expect(report.edit?.replacement).toBe('The rewritten premise.');
    const user = userTextOf(callOptions(EDIT_SCHEMA)?.messages);
    expect(user).toContain('COMPLETE new markdown of the premise');
    expect(user).toContain('NO H1');
    expect(user).toContain(`Full premise text to rewrite:\n${PREMISE}`);
    // The findings ride the instruction as a structured list — kind, severity,
    // words and locator all reach the editor.
    expect(user).toContain('[major] inconsistency: The vault is north of the gate here');
    expect(user).toContain('(at: second paragraph)');
    expect(user).toContain('Rewrite the premise');
  });

  it('rewrites a PART through the SAME core, naming the part', async () => {
    mockCritiqueThenEdit([issue({ kind: 'originality' })], '## Under the Docks\n\nRewritten.');
    const report = await runAdversarialPass({
      moduleId: world.moduleId,
      target: { kind: 'part', planIndex: 1 },
      text: DOC,
    });
    expect(report.edit?.replacement).toBe('## Under the Docks\n\nRewritten.');
    const user = userTextOf(callOptions(EDIT_SCHEMA)?.messages);
    expect(user).toContain('COMPLETE new markdown of the part');
    expect(user).toContain(`Full part text to rewrite:\n${DOC}`);
    expect(user).toContain('Rewrite the part 2');
  });

  it('a FAILED editor fails loudly and leaves the target text unchanged', async () => {
    const before = await getModule(world.moduleId);
    chatMock.mockImplementation((_messages, opts) =>
      Promise.resolve(
        schemaNameOf(opts) === CRITIQUE_SCHEMA
          ? { text: JSON.stringify({ issues: [issue()] }), modelUsed: 'c', fallback: null }
          : { text: JSON.stringify({ replacement: 42 }), modelUsed: 'e', fallback: null },
      ),
    );
    await expect(
      runAdversarialPass({ moduleId: world.moduleId, target: { kind: 'premise' }, text: PREMISE }),
    ).rejects.toThrow(/replacement/i);
    const after = await getModule(world.moduleId);
    expect(after?.spine?.premise).toBe(before?.spine?.premise);
    expect(after?.parts[0]?.markdown).toBe(before?.parts[0]?.markdown);
    expect(after?.parts[0]?.status).toBe(before?.parts[0]?.status);
  });

  it('an empty whole-document replacement fails loudly (never a half-edit)', async () => {
    mockCritiqueThenEdit([issue()], '   ');
    await expect(
      runAdversarialPass({ moduleId: world.moduleId, target: { kind: 'part', planIndex: 0 }, text: DOC }),
    ).rejects.toThrow(/empty replacement/i);
  });

  it('a replacement carrying our own escape debris is refused by the EXISTING scan', async () => {
    mockCritiqueThenEdit([issue()], 'Der Flussm?fcndung steigt.');
    await expect(
      runAdversarialPass({ moduleId: world.moduleId, target: { kind: 'premise' }, text: PREMISE }),
    ).rejects.toThrow(/\?fc/);
  });
});

describe('the durable snapshot is taken BEFORE the critique and the editor', () => {
  it('records the pre-change parts document through the ONE snapshot seam, first', async () => {
    const before = await getModule(world.moduleId);
    if (before === undefined) throw new Error('seeded module missing');
    const { document } = assembleModulePartsDocument({
      partPlan: before.spine?.partPlan ?? [],
      parts: before.parts,
    });

    const versionsSeenAtEachCall: number[] = [];
    const docSeenAtEachCall: string[] = [];
    chatMock.mockImplementation(async (_messages, opts) => {
      const versions = await listModuleVersions(world.moduleId);
      versionsSeenAtEachCall.push(versions.length);
      docSeenAtEachCall.push(versions[0]?.docText ?? '');
      return schemaNameOf(opts) === CRITIQUE_SCHEMA
        ? { text: JSON.stringify({ issues: [issue()] }), modelUsed: 'c', fallback: null }
        : { text: JSON.stringify({ replacement: 'Rewritten.' }), modelUsed: 'e', fallback: null };
    });

    const report = await runAdversarialPass({
      moduleId: world.moduleId,
      target: { kind: 'premise' },
      text: PREMISE,
    });

    // A snapshot existed before the FIRST model call (the critique) — and the
    // document it holds is the PRE-change one, still the same at the editor.
    expect(versionsSeenAtEachCall).toEqual([1, 1]);
    expect(docSeenAtEachCall).toEqual([document, document]);
    expect(report.snapshot?.docText).toBe(document);
    expect(report.snapshot?.source).toBe('generation');
  });
});

describe('the GUARD SPLIT — the canvas caller refuses a generating module, the core does not', () => {
  it('refineModuleText still throws ModuleBusyError while the shared core resolves', async () => {
    await patchModule(world.moduleId, { status: 'generating', errorMessage: '' });
    chatMock.mockResolvedValue({
      text: JSON.stringify({ replacement: 'x' }),
      modelUsed: 'm',
      fallback: null,
    });
    await expect(refineModuleText(canvasInput())).rejects.toThrow(ModuleBusyError);
    expect(chatMock).not.toHaveBeenCalled();
    // The pass's own core (the second caller) must NOT grow the surface rule
    // back: an in-generation review IS the generation (docs/17 row 353).
    await expect(
      transformModuleText({
        target: 'part',
        instruction: 'tighten the scene',
        text: DOC,
        enclosingBlock: '',
      }),
    ).resolves.toMatchObject({ replacement: 'x' });
    expect(chatMock).toHaveBeenCalledTimes(1);
  });

  it('the core does not claim the canvas registry; the canvas caller does', async () => {
    const claimedDuringCall: boolean[] = [];
    chatMock.mockImplementation(() => {
      claimedDuringCall.push(isModuleGenerationClaimed(world.moduleId));
      return Promise.resolve({
        text: JSON.stringify({ replacement: 'x' }),
        modelUsed: 'm',
        fallback: null,
      });
    });
    await transformModuleText({
      target: 'premise',
      instruction: 'tighten it',
      text: PREMISE,
      enclosingBlock: '',
    });
    expect(claimedDuringCall).toEqual([false]);
    await refineModuleText(canvasInput());
    expect(claimedDuringCall).toEqual([false, true]);
    // ...and the canvas claim is released again by its own finally.
    expect(isModuleGenerationClaimed(world.moduleId)).toBe(false);
  });

  it('the whole-document core targets the PREMISE, which the canvas scope union does not name', async () => {
    chatMock.mockResolvedValue({
      text: JSON.stringify({ replacement: 'New premise.' }),
      modelUsed: 'm',
      fallback: null,
    });
    await expect(
      transformModuleText({
        target: 'premise',
        instruction: 'sharpen it',
        text: PREMISE,
        enclosingBlock: '',
      }),
    ).resolves.toMatchObject({ replacement: 'New premise.' });
    const user = userTextOf(chatMock.mock.calls[0]?.[0]);
    expect(user).toContain('Rewrite the whole module PREMISE below');
  });
});

describe('the pass has exactly ONE importer and TWO guarded trigger sites (docs/17 row 358)', () => {
  it('moduleGen imports it, calls it twice behind the row flag, and no one else calls it', () => {
    // The comment-stripped, whitespace-collapsed `src/` tree from the ONE
    // source-scan helper (docs/17 rows 212/284): a docstring is allowed to NAME
    // the pass, and only CODE is counted.
    expect(Object.keys(CODE).length).toBeGreaterThan(300);
    // The DEFINITION lives in exactly one file (the module that owns it).
    expect(filesWith('export async function runAdversarialPass(')).toEqual([
      'src/llm/adversarialPass.ts',
    ]);
    // The IMPORT is a single edge: module generation wires the pass in.
    expect(filesWith('@/llm/adversarialPass')).toEqual(['src/llm/moduleGen.ts']);
    // The TRIGGERS are exactly two — the premise in pass 0 and each part in
    // pass 1 — and the flag guard that gates them is read three times in the
    // file (its own definition plus the two trigger sites). A third trigger, or
    // one that skipped the guard, moves a count and reds here.
    const moduleGen = CODE['src/llm/moduleGen.ts'] ?? '';
    expect(moduleGen.match(/runAdversarialPass\(/g)).toHaveLength(2);
    expect(moduleGen.match(/adversarialReviewEnabled\(/g)).toHaveLength(3);
  });
});
