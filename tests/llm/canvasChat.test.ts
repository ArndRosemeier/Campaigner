import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CanvasChatParseError,
  MAX_COMMANDS_PER_REPLY,
  buildCanvasChatPayload,
  canvasEditCommandSchema,
  chatProseSoFar,
  composeFailureReport,
  parseCanvasChatReply,
  renderChatGrounding,
  resolveCanvasEdit,
  resolveCanvasEditAcrossParts,
  sendCanvasChatMessage,
  type CanvasChatTurnInput,
} from '@/llm/canvasChat';
import {
  CANVAS_PARTS_DELIMITER,
  ModulePartsDocumentError,
  assembleModulePartsDocument,
  canvasPartLabel,
  splitModulePartsDocument,
  splitPartsDocument,
} from '@/domain/modulePartsDocument';
import { ModuleBusyError, PRIOR_MODULES_TOTAL_CAP } from '@/llm/moduleGen';
import type { ChatContentPart } from '@/llm/openrouter';
import { refineModuleText } from '@/llm/canvasRefine';
import { createCampaign } from '@/db/campaignRepo';
import {
  createModule,
  modulePartSchema,
  moduleSpineSchema,
  type Id,
} from '@/domain';
import { saveModule, patchModule } from '@/db/moduleRepo';
import { clearDatabase } from '../db/helpers';

/**
 * Canvas CHAT contract (08-MODULE-DESIGNER §Module canvas chat): the XML
 * command protocol is parsed by a STRICT extractor (malformed/unbalanced/
 * over-cap replies fail loud, never partially), commands are zod-validated,
 * the tolerant match ladder resolves search text per PART (whole-module
 * context: a spanning search cannot match; the empty-part label-anchor
 * fill is the only way into a not-yet-written part), the parts document is
 * assembled from the module row at send time (no premise, `==========`
 * delimiters + `[Part n of total — title]` labels, the OPEN part's live
 * text substituted byte-exactly), and the REFERENCE-ONLY grounding block
 * (campaign premise + system label + ALL preceding modules' FULL text,
 * UNCAPPED — deliberately not moduleGen's capped renderer) rides every
 * request. The transport is mocked — extractor, ladder, assembly,
 * grounding and boundary logic run for real.
 */

vi.mock('@/llm/openrouter', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  chat: vi.fn(),
}));

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);

let world: { campaignId: Id; moduleId: Id } = { campaignId: '', moduleId: '' };

const PART_0 = '## The Gate Bargain\n\nThe party bargains with [[Keeper Ilse]] at the gate.\n\nRain hammers the stones.';
const PART_1 = 'The docks breathe fog. Rain hammers the stones.';
const SPINE_PREMISE = 'The premise that must NOT ride the parts document.';

const PART_PLAN = [
  { title: 'The Gate Bargain', levelBand: '1' },
  { title: 'Under the Docks', levelBand: '1' },
  { title: 'The Long Watch', levelBand: '2' },
];

/** The WHOLE-module parts document the page's editor holds (canvas v3) —
 * exactly what the chat now receives as its live input. */
const PARTS_DOCUMENT = assembleModulePartsDocument({
  partPlan: PART_PLAN,
  parts: [
    { planIndex: 0, markdown: PART_0 },
    { planIndex: 1, markdown: PART_1 },
  ],
}).document;

async function seedModule(): Promise<void> {
  const campaign = await createCampaign({
    name: 'Ember',
    description: 'The ember war.',
    system: 'dnd5e',
  });
  // A PRIOR module with text LONGER than the generation-time total cap —
  // chat grounding is uncapped, so the full text must ride (story order,
  // createdAt ascending).
  const priorDraft = createModule({
    campaignId: campaign.id,
    title: 'The Sunken Chapel',
    concept: 'concept',
    levelMin: 1,
    levelMax: 1,
    tone: '',
    sizeDial: 'standard',
  });
  const longPriorMarkdown = `lighthouse ${'a'.repeat(PRIOR_MODULES_TOTAL_CAP + 2000)}`;
  await saveModule({
    ...priorDraft,
    createdAt: 1,
    spine: moduleSpineSchema.parse({
      premise: 'The chapel premise.',
      themes: [],
      partPlan: [{ title: 'Chapel Bells', levelBand: '1', synopsis: '', levelUpTrigger: '' }],
    }),
    parts: [
      modulePartSchema.parse({
        planIndex: 0,
        markdown: longPriorMarkdown,
        status: 'ready',
        errorMessage: '',
        edited: false,
      }),
    ],
  });
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
    createdAt: 2,
    spine: moduleSpineSchema.parse({
      premise: SPINE_PREMISE,
      themes: [],
      partPlan: PART_PLAN,
    }),
    parts: [
      modulePartSchema.parse({ planIndex: 0, markdown: PART_0, status: 'ready', errorMessage: '', edited: false }),
      modulePartSchema.parse({ planIndex: 1, markdown: PART_1, status: 'ready', errorMessage: '', edited: false }),
    ],
  });
  world = { campaignId: campaign.id, moduleId: draft.id };
}

beforeEach(async () => {
  await clearDatabase();
  vi.clearAllMocks();
  await seedModule();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseCanvasChatReply (strict extractor)', () => {
  it('parses one command plus prose', () => {
    const raw = [
      'Let me make that scene rainier.',
      '<edit all="false"><search>Rain hammers the stones.</search><replace>Rain drowns every word.</replace></edit>',
    ].join('\n');
    const parsed = parseCanvasChatReply(raw);
    expect(parsed.prose).toBe('Let me make that scene rainier.');
    expect(parsed.commands).toEqual([
      { search: 'Rain hammers the stones.', replace: 'Rain drowns every word.', all: false },
    ]);
  });

  it('parses multiple commands and defaults all to false on a bare <edit>', () => {
    const raw = [
      '<edit><search>gate</search><replace>portal</replace></edit>',
      'And the second spot:',
      '<edit all="true"><search>Rain</search><replace>Mist</replace></edit>',
    ].join('\n');
    const parsed = parseCanvasChatReply(raw);
    expect(parsed.commands).toHaveLength(2);
    expect(parsed.commands[0]).toEqual({ search: 'gate', replace: 'portal', all: false });
    expect(parsed.commands[1]).toEqual({ search: 'Rain', replace: 'Mist', all: true });
  });

  it('keeps search/replace bodies verbatim (newlines, pipes, brackets)', () => {
    const raw =
      '<edit><search>line one\nline **two** | [[Gate]]</search><replace>one\n\ntwo</replace></edit>';
    const parsed = parseCanvasChatReply(raw);
    expect(parsed.commands[0]?.search).toBe('line one\nline **two** | [[Gate]]');
    expect(parsed.commands[0]?.replace).toBe('one\n\ntwo');
  });

  it('a reply with zero commands parses to prose only', () => {
    const parsed = parseCanvasChatReply('Just an answer, no edits needed.');
    expect(parsed.prose).toBe('Just an answer, no edits needed.');
    expect(parsed.commands).toEqual([]);
  });

  it('fails loud on a stray closing tag', () => {
    expect(() => parseCanvasChatReply('oops </edit> here')).toThrow(CanvasChatParseError);
  });

  it('fails loud on an unterminated block (missing </edit>)', () => {
    expect(() =>
      parseCanvasChatReply('<edit><search>a</search><replace>b</replace>'),
    ).toThrow(CanvasChatParseError);
    expect(() => parseCanvasChatReply('<edit><search>a')).toThrow(CanvasChatParseError);
  });

  it('fails loud on a missing > in the open tag and on self-closing edits', () => {
    expect(() => parseCanvasChatReply('<edit all="false"><search>a')).toThrow(CanvasChatParseError);
    expect(() => parseCanvasChatReply('<edit/>')).toThrow(CanvasChatParseError);
  });

  it('fails loud on unexpected content between the children', () => {
    expect(() =>
      parseCanvasChatReply('<edit>junk<search>a</search><replace>b</replace></edit>'),
    ).toThrow(CanvasChatParseError);
  });

  it('fails loud on unknown attributes and invalid all values', () => {
    expect(() => parseCanvasChatReply('<edit mode="x"><search>a</search><replace>b</replace></edit>')).toThrow(
      CanvasChatParseError,
    );
    expect(() => parseCanvasChatReply('<edit all="yes"><search>a</search><replace>b</replace></edit>')).toThrow(
      CanvasChatParseError,
    );
  });

  it('fails loud over the per-reply command cap', () => {
    const block = '<edit><search>x</search><replace>y</replace></edit>';
    const raw = block.repeat(MAX_COMMANDS_PER_REPLY + 1);
    expect(() => parseCanvasChatReply(raw)).toThrow(CanvasChatParseError);
    expect(() => parseCanvasChatReply(block.repeat(MAX_COMMANDS_PER_REPLY))).not.toThrow();
  });

  it('every parsed command passes the zod boundary', () => {
    expect(canvasEditCommandSchema.safeParse({ search: 'a', replace: 'b', all: false }).success).toBe(true);
    expect(canvasEditCommandSchema.safeParse({ search: 'a', replace: 42, all: false }).success).toBe(false);
  });
});

describe('chatProseSoFar (streaming display, best effort)', () => {
  it('hides complete blocks and flags a still-open tail', () => {
    expect(chatProseSoFar('Hello.')).toEqual({ prose: 'Hello.', composing: false });
    expect(chatProseSoFar('Hello.<edit><search>a</search><replace>b</replace></edit> bye')).toEqual({
      prose: 'Hello. bye',
      composing: false,
    });
    expect(chatProseSoFar('Working…<edit><search>a')).toEqual({ prose: 'Working…', composing: true });
  });
});

describe('resolveCanvasEdit (tolerant ladder, single doc)', () => {
  it('level 1 — exact match, unique', () => {
    const resolution = resolveCanvasEdit(PART_0, 'Rain hammers the stones.');
    expect(resolution.status).toBe('found');
    if (resolution.status !== 'found') throw new Error('unreachable');
    expect(resolution.ranges).toEqual([
      { from: PART_0.indexOf('Rain'), to: PART_0.indexOf('Rain') + 'Rain hammers the stones.'.length },
    ]);
  });

  it('level 2 — case-insensitive fallback', () => {
    const resolution = resolveCanvasEdit(PART_0, 'rain HAMMERS the stones');
    expect(resolution.status).toBe('found');
    if (resolution.status !== 'found') throw new Error('unreachable');
    expect(PART_0.slice(resolution.ranges[0]?.from ?? 0, resolution.ranges[0]?.to ?? 0)).toBe(
      'Rain hammers the stones',
    );
  });

  it('level 3 — whitespace-collapse fallback (runs of whitespace ≡ one space)', () => {
    const doc = 'The party  enters.\n\nThe   gate opens.';
    const resolution = resolveCanvasEdit(doc, 'The party enters.\n\nThe gate opens.');
    expect(resolution.status).toBe('found');
    if (resolution.status !== 'found') throw new Error('unreachable');
    expect(doc.slice(resolution.ranges[0]?.from ?? 0, resolution.ranges[0]?.to ?? 0)).toBe(
      'The party  enters.\n\nThe   gate opens.',
    );
  });

  it('multiple exact matches come back as multiple ranges (caller decides all)', () => {
    const doc = 'Rain here.\nRain there.\nDone.';
    const resolution = resolveCanvasEdit(doc, 'Rain');
    expect(resolution.status).toBe('found');
    if (resolution.status !== 'found') throw new Error('unreachable');
    expect(resolution.ranges).toHaveLength(2);
    expect(resolution.ranges[0]).toEqual({ from: 0, to: 4 });
  });

  it('zero matches report the closest candidate snippet, never an auto-apply', () => {
    const doc = '## The Gate Bargain\n\nThe party bargains bravely with the keeper.\n\nRain hammers.';
    const resolution = resolveCanvasEdit(doc, 'The party bargains boldy with the keeper.');
    expect(resolution.status).toBe('none');
    if (resolution.status !== 'none') throw new Error('unreachable');
    expect(resolution.closest).toContain('bargains bravely');
    expect(resolution.closestFrom).not.toBeNull();
  });

  it('an empty search never matches', () => {
    expect(resolveCanvasEdit(PART_0, '')).toEqual({ status: 'none', closest: '', closestFrom: null });
  });
});

describe('assembleModulePartsDocument + splitModulePartsDocument (one document, both directions)', () => {
  const base = {
    partPlan: PART_PLAN,
    parts: [
      { planIndex: 0, markdown: PART_0 },
      { planIndex: 1, markdown: PART_1 },
    ],
  };

  it('assembles every planned part in plan order with delimiter + label scaffolding', () => {
    const { document, parts } = assembleModulePartsDocument(base);
    expect(document).toContain(`\n\n${CANVAS_PARTS_DELIMITER}\n\n[Part 2 of 3 — Under the Docks]\n${PART_1}`);
    expect(document).toContain('[Part 1 of 3 — The Gate Bargain]\n');
    expect(document).toContain('[Part 3 of 3 — The Long Watch]\n');
    // The spine premise is EXCLUDED (owner: "without premise").
    expect(document).not.toContain(SPINE_PREMISE);
    expect(parts.map((part) => part.planIndex)).toEqual([0, 1, 2]);
    expect(parts.map((part) => part.title)).toEqual(['The Gate Bargain', 'Under the Docks', 'The Long Watch']);
  });

  it('a missing/empty planned part is an empty section (its label is the only content)', () => {
    const { document, parts } = assembleModulePartsDocument(base);
    expect(parts[2]?.text).toBe('');
    expect(document).toContain(`${CANVAS_PARTS_DELIMITER}\n\n[Part 3 of 3 — The Long Watch]\n`);
  });

  it('the label falls back to [Part n of total] when the plan has no title', () => {
    expect(canvasPartLabel(2, 3, '')).toBe('[Part 2 of 3]');
    expect(canvasPartLabel(1, 2, 'Title')).toBe('[Part 1 of 2 — Title]');
    const { document } = assembleModulePartsDocument({
      partPlan: [{ title: '' }, { title: 'B' }],
      parts: [{ planIndex: 0, markdown: 'x' }],
    });
    expect(document).toContain('[Part 1 of 2]\nx');
  });

  it('throws loud on an empty plan', () => {
    expect(() => assembleModulePartsDocument({ partPlan: [], parts: [] })).toThrow(/planned part/);
  });

  it('split round-trips assemble BYTE-EXACTLY (part texts, titles, ranges)', () => {
    const { document } = assembleModulePartsDocument(base);
    const sections = splitPartsDocument(document, PART_PLAN);
    expect(sections.map((section) => section.planIndex)).toEqual([0, 1, 2]);
    expect(sections.map((section) => section.title)).toEqual([
      'The Gate Bargain',
      'Under the Docks',
      'The Long Watch',
    ]);
    expect(sections.map((section) => section.text)).toEqual([PART_0, PART_1, '']);
    // Ranges slice the exact texts back out of the doc.
    for (const section of sections) {
      expect(document.slice(section.textFrom, section.textTo)).toBe(section.text);
    }
    // And re-assembling the split is the identity.
    expect(
      assembleModulePartsDocument({
        partPlan: PART_PLAN,
        parts: sections.map((section) => ({ planIndex: section.planIndex, markdown: section.text })),
      }).document,
    ).toBe(document);
  });

  it('a bare ========== line INSIDE a part\'s content is harmless (the label line identifies sections)', () => {
    const { document } = assembleModulePartsDocument({
      partPlan: PART_PLAN,
      parts: [
        { planIndex: 0, markdown: `${PART_0}\n\n==========\n\nstill part one` },
        { planIndex: 1, markdown: PART_1 },
      ],
    });
    const sections = splitPartsDocument(document, PART_PLAN);
    expect(sections[0]?.text).toBe(`${PART_0}\n\n==========\n\nstill part one`);
    expect(sections[1]?.text).toBe(PART_1);
  });

  it('fails loud when the separator before a label is missing or malformed', () => {
    const { document } = assembleModulePartsDocument(base);
    const broken = document.replace(`\n\n${CANVAS_PARTS_DELIMITER}\n\n`, '\n\n'); // no delimiter line
    expect(() => splitPartsDocument(broken, PART_PLAN)).toThrow(ModulePartsDocumentError);
    expect(() => splitPartsDocument(broken, PART_PLAN)).toThrow(/separator before the label line of part 2/);
    const nineEquals = document.replace(`\n\n${CANVAS_PARTS_DELIMITER}\n\n`, '\n\n=========\n\n');
    expect(() => splitPartsDocument(nineEquals, PART_PLAN)).toThrow(/separator .* missing or malformed/);
  });

  it('fails loud when the section count does not match the plan (missing label)', () => {
    const { document } = assembleModulePartsDocument(base);
    const truncated = document.slice(0, document.indexOf(`${CANVAS_PARTS_DELIMITER}\n\n[Part 2`));
    expect(() => splitPartsDocument(truncated, PART_PLAN)).toThrow(/label line of part 2 of 3 is missing/);
  });

  it('fails loud when a label\'s title contradicts the plan (lying label)', () => {
    const { document } = assembleModulePartsDocument(base);
    const lying = document.replace('[Part 2 of 3 — Under the Docks]', '[Part 2 of 3 — The Wrong Title]');
    expect(() => splitPartsDocument(lying, PART_PLAN)).toThrow(/contradicts the plan/);
    expect(() => splitPartsDocument(lying, PART_PLAN)).toThrow(/Under the Docks/);
  });

  it('fails loud when content fakes a full section header (the designed guard, never silent re-splitting)', () => {
    const { document } = assembleModulePartsDocument({
      partPlan: PART_PLAN,
      parts: [
        { planIndex: 0, markdown: `${PART_0}\n\n${CANVAS_PARTS_DELIMITER}\n\n[Part 2 of 3 — Under the Docks]\nFaked continuation.` },
        { planIndex: 1, markdown: PART_1 },
      ],
    });
    expect(() => splitPartsDocument(document, PART_PLAN)).toThrow(ModulePartsDocumentError);
    expect(() => splitPartsDocument(document, PART_PLAN)).toThrow(
      /contains a section header line .*Faked|contains a section header line "\[Part 2 of 3/,
    );
  });

  it('fails loud when an extra section rides beyond the plan (count mismatch)', () => {
    const { document } = assembleModulePartsDocument(base);
    const extra = `${document}${CANVAS_PARTS_DELIMITER}\n\n[Part 4 of 3 — Smuggled]\nextra`;
    expect(() => splitPartsDocument(extra, PART_PLAN)).toThrow(/contains a section header line/);
  });

  it('fails loud when the document does not open with part 1\'s label', () => {
    expect(() => splitPartsDocument('just text\n', PART_PLAN)).toThrow(/must open with the label line/);
    expect(() => splitPartsDocument('', PART_PLAN)).toThrow(/must open with the label line/);
  });

  it('fails loud on a module without planned parts', () => {
    expect(() => splitPartsDocument('whatever', [])).toThrow(/no planned parts/);
    expect(() => splitModulePartsDocument('whatever', { spine: null })).toThrow(/no planned parts/);
  });
});

describe('resolveCanvasEditAcrossParts (per-part matching)', () => {
  const snapshots = assembleModulePartsDocument({
    partPlan: PART_PLAN,
    parts: [
      { planIndex: 0, markdown: PART_0 },
      { planIndex: 1, markdown: PART_1 },
    ],
  }).parts;

  it('one textual match across the whole module resolves in its own part', () => {
    const resolution = resolveCanvasEditAcrossParts(
      { search: 'The docks breathe fog.', replace: 'x' },
      snapshots,
    );
    expect(resolution.status).toBe('found');
    if (resolution.status !== 'found') throw new Error('unreachable');
    expect(resolution.totalRanges).toBe(1);
    expect(resolution.matches).toEqual([
      { partIndex: 1, ranges: [{ from: 0, to: 'The docks breathe fog.'.length }] },
    ]);
  });

  it('occurrences sum across parts (the caller enforces all="false" = exactly one)', () => {
    const resolution = resolveCanvasEditAcrossParts({ search: 'Rain', replace: 'Mist' }, snapshots);
    expect(resolution.status).toBe('found');
    if (resolution.status !== 'found') throw new Error('unreachable');
    expect(resolution.totalRanges).toBe(2); // once in part 0, once in part 1
    expect(resolution.matches.map((match) => match.partIndex)).toEqual([0, 1]);
  });

  it('a search SPANNING two parts cannot match (loud zero-match, never across the string)', () => {
    const spanning = `${PART_0}\n\n${CANVAS_PARTS_DELIMITER}\n\n[Part 2 of 3 — Under the Docks]\n${PART_1}`;
    const resolution = resolveCanvasEditAcrossParts({ search: spanning, replace: 'x' }, snapshots);
    expect(resolution.status).toBe('none');
  });

  it('zero matches pick the closest candidate across parts (real neighbor)', () => {
    const parts = assembleModulePartsDocument({
      partPlan: [{ title: 'A' }, { title: 'B' }],
      parts: [
        { planIndex: 0, markdown: 'The ferry crosses at dusk.' },
        { planIndex: 1, markdown: 'The lighthouse keeper lights the lamp at dusk.' },
      ],
    }).parts;
    const resolution = resolveCanvasEditAcrossParts(
      { search: 'The lighthouse keeper lights the lamp at down.', replace: 'x' },
      parts,
    );
    expect(resolution.status).toBe('none');
    if (resolution.status !== 'none') throw new Error('unreachable');
    expect(resolution.closestPartIndex).toBe(1);
    expect(resolution.closest).toContain('lighthouse');
    expect(resolution.closestFrom).not.toBeNull();
  });

  it('the label-anchor fill fills an EMPTY part (replace starts with the same label)', () => {
    const label = canvasPartLabel(3, 3, 'The Long Watch');
    const resolution = resolveCanvasEditAcrossParts(
      { search: label, replace: `${label}\n\nThe watch begins in fog.` },
      snapshots,
    );
    expect(resolution.status).toBe('filled');
    if (resolution.status !== 'filled') throw new Error('unreachable');
    expect(resolution.partIndex).toBe(2);
    expect(resolution.newText).toBe('The watch begins in fog.');
  });

  it('a fill whose replace lacks the label line fails loud', () => {
    const label = canvasPartLabel(3, 3, 'The Long Watch');
    const resolution = resolveCanvasEditAcrossParts(
      { search: label, replace: 'The watch begins in fog.' },
      snapshots,
    );
    expect(resolution.status).toBe('fill-failed');
    if (resolution.status !== 'fill-failed') throw new Error('unreachable');
    expect(resolution.reason).toContain('label line');
  });

  it('a label-only replace (no content after the label) fails loud', () => {
    const label = canvasPartLabel(3, 3, 'The Long Watch');
    const resolution = resolveCanvasEditAcrossParts({ search: label, replace: label }, snapshots);
    expect(resolution.status).toBe('fill-failed');
  });

  it('a search equal to a NON-empty part\'s label never matches (labels are scaffolding)', () => {
    const label = canvasPartLabel(1, 3, 'The Gate Bargain');
    const resolution = resolveCanvasEditAcrossParts({ search: label, replace: 'x' }, snapshots);
    expect(resolution.status).toBe('none');
  });
});

describe('renderChatGrounding (read-only block)', () => {
  it('carries campaign premise + system label + preceding modules in story order, UNCAPPED', () => {
    const longText = 'x'.repeat(PRIOR_MODULES_TOTAL_CAP + 3000);
    const block = renderChatGrounding({
      campaignName: 'Ember',
      campaignDescription: 'The ember war.',
      systemLabel: 'D&D 5e',
      priorModules: [
        { title: 'First Module', premise: 'First premise.', parts: [{ label: '### Part 1: A', markdown: 'short' }] },
        { title: 'Second Module', premise: 'Second premise.', parts: [{ label: '### Part 1: B', markdown: longText }] },
      ],
    });
    expect(block).toContain('Campaign: Ember — The ember war.');
    expect(block).toContain('Game system: D&D 5e');
    expect(block.indexOf('## First Module')).toBeLessThan(block.indexOf('## Second Module'));
    expect(block).toContain('Premise:\nFirst premise.');
    expect(block).toContain('### Part 1: A\nshort');
    // UNCAPPED: the full text rides, no generation-time truncation marker.
    expect(block).toContain(longText);
    expect(block).not.toContain('[truncated]');
  });

  it('omits the previous-modules section when the campaign has none', () => {
    const block = renderChatGrounding({
      campaignName: 'Ember',
      campaignDescription: '',
      systemLabel: 'D&D 5e',
      priorModules: [],
    });
    expect(block).toBe('Campaign: Ember\n\nGame system: D&D 5e');
  });
});

describe('buildCanvasChatPayload (context contract)', () => {
  // Owner-directed (ledger 57): the cap is gone — the entire conversation
  // rides every request. 15 turns (odd count, either role first) exercises
  // "more than the old 12-message tail" without asserting a magic number.
  const history = Array.from({ length: 15 }, (_unused, index) => ({
    role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    text: `turn ${String(index)}`,
  }));

  /** The payload always carries plain strings — narrow the union for asserts. */
  function textOf(message: { content: string | ChatContentPart[] }): string {
    return typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
  }

  it('pins the CURRENT parts doc + the REFERENCE-ONLY grounding into the final user turn', () => {
    const messages = buildCanvasChatPayload({
      document: PART_0,
      grounding: 'Campaign: Ember\nGame system: D&D 5e',
      instruction: 'make it rain',
      history: [],
    });
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toContain('CURRENT state');
    expect(messages[0]?.content).toContain('all="true"');
    const last = messages[messages.length - 1];
    expect(last?.role).toBe('user');
    expect(last?.content).toContain(PART_0);
    expect(last?.content).toContain('<reference-only>');
    expect(last?.content).toContain('Campaign: Ember');
    expect(last?.content).toContain('Instruction: make it rain');
  });

  it('the grounding block rides in the final turn, outside the history', () => {
    const messages = buildCanvasChatPayload({
      document: PART_0,
      grounding: 'Campaign: Ember',
      instruction: 'next',
      history,
    });
    const last = messages[messages.length - 1];
    expect(last?.content).toContain('<reference-only>');
    expect(last?.content).toContain('Campaign: Ember');
  });

  it('the FULL history rides every request — no cap, no omission note', () => {
    const messages = buildCanvasChatPayload({
      document: PART_0,
      grounding: 'Campaign: Ember',
      instruction: 'next',
      history,
    });
    // Every history turn rides in order (15 history + system + final turn).
    expect(messages).toHaveLength(17);
    for (const [index, entry] of history.entries()) {
      const carried = messages[index + 1];
      expect(carried?.role).toBe(entry.role);
      expect(carried?.content).toContain(entry.text);
    }
    expect(messages[messages.length - 1]?.content).toContain('Instruction: next');
    // Nothing is omitted, so no omission note exists anywhere.
    for (const message of messages) {
      expect(textOf(message)).not.toContain('earlier message(s)');
      expect(textOf(message)).not.toContain('were omitted');
    }
  });

  it('stale document snapshots are stripped from older turns; the current doc rides once, in the final turn', () => {
    const stale = 'STALE-DOC-SNAPSHOT-aaa';
    const current = 'CURRENT-DOC-bbb';
    const messages = buildCanvasChatPayload({
      document: current,
      grounding: 'Campaign: Ember',
      instruction: 'next',
      history: [
        { role: 'user', text: `first instruction\n<document>\n${stale}\n</document>` },
        { role: 'assistant', text: 'Done.' },
      ],
    });
    // The older turn keeps its instruction text, never the dead copy.
    expect(messages[1]?.content).toContain('first instruction');
    expect(messages[1]?.content).not.toContain(stale);
    expect(messages[1]?.content).not.toContain('<document>');
    // The current document rides exactly once — in the final turn.
    const carriers = messages.filter((message) => textOf(message).includes(current));
    expect(carriers).toHaveLength(1);
    expect(carriers[0]?.role).toBe('user');
    expect(messages[messages.length - 1]?.content).toContain('Instruction: next');
  });

  it('older user turns are re-rendered instruction-only (stale docs never ride along)', () => {
    const messages = buildCanvasChatPayload({
      document: PART_0,
      grounding: 'Campaign: Ember',
      instruction: 'next',
      history: [{ role: 'user', text: 'make it rain' }, { role: 'assistant', text: 'Done.' }],
    });
    expect(messages[1]?.role).toBe('user');
    expect(messages[1]?.content).toContain('[earlier instruction] make it rain');
    expect(messages[1]?.content).not.toContain('<document>');
    // Assistant replies keep their raw commands (the model sees its own work).
    expect(messages[2]?.content).toBe('Done.');
  });
});

describe('composeFailureReport (report-to-LLM loop)', () => {
  it('carries the error, the verbatim command and the doc excerpt', () => {
    const report = composeFailureReport({
      errorText: 'the search text does not appear in the current document',
      command: { search: 'old text', replace: 'new text', all: false },
      document: `${'x'.repeat(400)}the keeper bargains here${'y'.repeat(400)}`,
      failureFrom: 400,
    });
    expect(report).toContain('could not be applied');
    expect(report).toContain('the search text does not appear');
    expect(report).toContain('<edit all="false"><search>old text</search><replace>new text</replace></edit>');
    expect(report).toContain('the keeper bargains here');
    expect(report).toContain('Re-send the corrected command');
  });

  it('a parse failure (no command, no anchor) still names the error', () => {
    const report = composeFailureReport({
      errorText: 'unbalanced <edit> block',
      command: null,
      document: PART_0,
      failureFrom: null,
    });
    expect(report).toContain('unbalanced <edit> block');
    expect(report).not.toContain('<excerpt>');
  });
});

describe('sendCanvasChatMessage (engine)', () => {
  function baseInput(overrides: Partial<CanvasChatTurnInput> = {}): CanvasChatTurnInput {
    return {
      moduleId: world.moduleId,
      document: PARTS_DOCUMENT,
      instruction: 'make the gate scene rainier',
      history: [],
      ...overrides,
    };
  }

  it('sends the WHOLE module (no premise) + grounding and returns the per-part snapshot', async () => {
    const raw =
      'Done — one edit.\n<edit><search>Rain hammers the stones.</search><replace>Rain drowns every word.</replace></edit>';
    chatMock.mockResolvedValue({ text: raw, modelUsed: 'test-model', fallback: null });
    const result = await sendCanvasChatMessage(baseInput());
    expect(result.parse.prose).toBe('Done — one edit.');
    expect(result.parse.commands).toHaveLength(1);
    expect(result.modelUsed).toBe('test-model');
    // The per-part snapshot matches EXACTLY what the model saw.
    expect(result.parts.map((part) => part.planIndex)).toEqual([0, 1, 2]);
    expect(result.parts[0]?.text).toBe(PART_0);
    expect(result.parts[1]?.text).toBe(PART_1);
    expect(result.parts[2]?.text).toBe('');

    const [messages, opts] = chatMock.mock.calls[0] ?? [];
    expect(messages?.[0]?.role).toBe('system');
    expect(messages?.[0]?.content).toContain('CURRENT state');
    const last = messages?.[messages.length - 1];
    expect(last?.role).toBe('user');
    expect(last?.content).toContain(PART_0);
    expect(last?.content).toContain(PART_1);
    expect(last?.content).toContain(CANVAS_PARTS_DELIMITER);
    expect(last?.content).toContain('[Part 3 of 3 — The Long Watch]');
    // The spine premise NEVER rides the parts document.
    expect(last?.content).not.toContain(SPINE_PREMISE);
    // Read-only grounding: campaign premise + system label + prior module FULL text.
    expect(last?.content).toContain('REFERENCE-ONLY CONTEXT');
    expect(last?.content).toContain('Campaign: Ember — The ember war.');
    expect(last?.content).toContain('Game system: D&D 5e');
    expect(last?.content).toContain('## The Sunken Chapel');
    expect(last?.content).toContain(`lighthouse ${'a'.repeat(PRIOR_MODULES_TOTAL_CAP + 2000)}`);
    expect(last?.content).toContain('Instruction: make the gate scene rainier');
    // No strict JSON response format — the XML protocol is deliberately not
    // a JSON contract (docs/17 row 50).
    expect(opts?.responseFormat).toBeUndefined();
  });

  it('the OPEN part rides from the live editor doc, not the row (unsaved edits apply)', async () => {
    chatMock.mockResolvedValue({ text: 'ok', modelUsed: 'm', fallback: null });
    const live = `${PART_0}\n\nAn unsaved hand edit.`;
    await sendCanvasChatMessage(baseInput({ document: PARTS_DOCUMENT.replace(PART_0, live) }));
    const [messages] = chatMock.mock.calls[0] ?? [];
    const last = messages?.[messages.length - 1];
    expect(last?.content).toContain('An unsaved hand edit.');
  });

  it('uses the Settings defaultChatModel and honors the canvas selection override', async () => {
    chatMock.mockResolvedValue({ text: 'ok', modelUsed: 'm', fallback: null });
    await sendCanvasChatMessage(baseInput());
    const settings = await (await import('@/db/settingsRepo')).getSettings();
    expect(chatMock.mock.calls[0]?.[1]?.model).toBe(settings.defaultChatModel);
    await sendCanvasChatMessage(baseInput({ model: 'custom/canvas-model' }));
    expect(chatMock.mock.calls[1]?.[1]?.model).toBe('custom/canvas-model');
  });

  it('a generating module refuses with ModuleBusyError (chat not called)', async () => {
    await patchModule(world.moduleId, { status: 'generating', errorMessage: '' });
    await expect(sendCanvasChatMessage(baseInput())).rejects.toThrow(ModuleBusyError);
    expect(chatMock).not.toHaveBeenCalled();
  });

  it('a module without planned parts fails the pre-flight loudly', async () => {
    const module = await (await import('@/db/moduleRepo')).getModule(world.moduleId);
    if (module === undefined) throw new Error('seed missing');
    await saveModule({ ...module, spine: null, parts: [] });
    await expect(sendCanvasChatMessage(baseInput())).rejects.toThrow(/no parts to chat about/);
    expect(chatMock).not.toHaveBeenCalled();
  });

  it('a vanished module fails loud', async () => {
    await expect(sendCanvasChatMessage(baseInput({ moduleId: 'nope-nope' }))).rejects.toThrow(
      /no longer exists/i,
    );
  });

  it('chat and refine serialize on the shared registry (ONE generation per module)', async () => {
    let releaseFirst!: () => void;
    chatMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirst = () => {
            resolve({ text: JSON.stringify({ replacement: 'first' }), modelUsed: 'm', fallback: null });
          };
        }),
    );
    chatMock.mockResolvedValue({ text: 'ok', modelUsed: 'm', fallback: null });
    const refine = refineModuleText({
      moduleId: world.moduleId,
      scope: 'part',
      instruction: 'rewrite',
      text: PART_0,
      enclosingBlock: '',
    });
    // Let the refine reach its chat await so the registry is genuinely held.
    for (let round = 0; round < 20 && chatMock.mock.calls.length === 0; round += 1) {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }
    await expect(sendCanvasChatMessage(baseInput())).rejects.toThrow(ModuleBusyError);
    releaseFirst();
    await expect(refine).resolves.toBe('first');
    // After release, a chat turn goes through.
    await expect(sendCanvasChatMessage(baseInput())).resolves.toMatchObject({ modelUsed: 'm' });
  });

  it('a malformed reply throws CanvasChatParseError (loud, whole reply failed)', async () => {
    chatMock.mockResolvedValue({
      text: 'Here you go: <edit><search>abc</search><replace>def',
      modelUsed: 'm',
      fallback: null,
    });
    await expect(sendCanvasChatMessage(baseInput())).rejects.toThrow(CanvasChatParseError);
  });

  it('an empty instruction fails before any model call', async () => {
    await expect(sendCanvasChatMessage(baseInput({ instruction: '   ' }))).rejects.toThrow(/instruction/i);
    expect(chatMock).not.toHaveBeenCalled();
  });

  it('a pre-aborted signal throws AbortError before any model call', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sendCanvasChatMessage(baseInput({ signal: controller.signal }))).rejects.toThrow(/abort/i);
    expect(chatMock).not.toHaveBeenCalled();
  });
});
