import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { getModule, patchModule, saveModule } from '@/db/moduleRepo';
import { createModule, type Id } from '@/domain';
import { moduleDocumentSections } from '@/domain/moduleDocument';
import {
  CANVAS_LEVEL_EDIT_KINDS,
  CanvasChatParseError,
  MAX_COMMANDS_PER_REPLY,
  canvasChatSystemPrompt,
  canvasEditCommandBlock,
  canvasEditCommandSchema,
  composeFailureReport,
  isLevelEditCommand,
  parseCanvasChatReply,
  type CanvasLevelEditCommand,
} from '@/llm/canvasChat';
import {
  deserializeChatThread,
  serializeChatThread,
} from '@/features/modules/canvas/chatPersist';
import {
  newChatId,
  type CanvasChatMessage,
  type CanvasChatOutcome,
} from '@/features/modules/canvas/chatStore';
import { clearDatabase } from '../db/helpers';

/**
 * THE LEVEL-ADDRESSED CHAT COMMANDS (docs/17 row 381, docs/23 §2.1/§4): the
 * owner's refinement is that the APP writes the canonical separator and the
 * level number, so the model never emits the scaffold — which is what makes a
 * broken format structurally impossible on this path.
 *
 * The commands ride the ONE existing vocabulary: the same strict extractor
 * (`parseCanvasChatReply`), the same zod union (`canvasEditCommandSchema`), the
 * same command array and the ONE applier (`chatApply.applyChatCommands` — its
 * own pins live in `tests/features/canvas-chat-apply-differential.test.tsx`, run
 * over BOTH surfaces). What is pinned HERE is the protocol half and the
 * persistence half:
 *
 * - both commands parse into the ONE command array, in reply order, beside a
 *   search edit; the search half's parsed value is untouched by the union;
 * - level 0 IS the premise and needs no premise-shaped command;
 * - a malformed open tag fails the WHOLE reply loudly (missing/duplicate/
 *   non-canonical `level`, unknown attribute, self-closing, a `<search>` child);
 * - the system prompt documents both commands and their invariant (the number
 *   is the target, the app writes the separator, the premise is level 0);
 * - `composeFailureReport` echoes a level command in ITS OWN spelling, so the
 *   report-to-LLM turn cannot hand the model back a search edit it never sent;
 * - a stored thread carrying a level-addressed outcome ROUND-TRIPS through
 *   `serializeChatThread` → `patchModule` (the module ROW's own schema) →
 *   reload, and the restored card still names the level it touched. That is the
 *   pin that would have caught the schema gap: before
 *   `domain/module.moduleChatCommandSchema` accepted the level shape, the
 *   chat-history write threw and the thread never survived a reload.
 */

const PREMISE = 'The premise of the drowned vault.';
const LEVEL_1 = '## The Gate Bargain\nThe party bargains with [[Keeper Ilse]].';
const LEVEL_2 = 'Rain hammers the stones.';

let world: { campaignId: Id; moduleId: Id } = { campaignId: '', moduleId: '' };

beforeEach(async () => {
  await clearDatabase();
  const campaign = await createCampaign({
    name: 'Ember',
    description: 'The ember war.',
    system: 'dnd5e',
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
  await saveModule({ ...draft, createdAt: 1 });
  world = { campaignId: campaign.id, moduleId: draft.id };
});

describe('the level-addressed commands parse through the ONE vocabulary (docs/17 row 381)', () => {
  it('parses <replace_level> and <append_level> beside a search edit, in reply order', () => {
    const raw = [
      'Rewriting the premise and adding the next level.',
      '<replace_level level="0"><replace>The vault flooded a century ago.</replace></replace_level>',
      '<edit all="false"><search>Rain hammers the stones.</search><replace>Rain drowns the stones.</replace></edit>',
      '<append_level level="3"><replace>## The Long Watch\nNobody sleeps.</replace></append_level>',
    ].join('\n');
    const parsed = parseCanvasChatReply(raw);
    expect(parsed.prose).toBe('Rewriting the premise and adding the next level.');
    // ONE array, reply order, both shapes in it — never a second command list.
    expect(parsed.commands).toEqual([
      { kind: 'replace_level', level: 0, replace: 'The vault flooded a century ago.' },
      { search: 'Rain hammers the stones.', replace: 'Rain drowns the stones.', all: false },
      { kind: 'append_level', level: 3, replace: '## The Long Watch\nNobody sleeps.' },
    ]);
    // The discriminant narrows without adding a field to the search half.
    const first = parsed.commands[0];
    const second = parsed.commands[1];
    expect(first !== undefined && isLevelEditCommand(first)).toBe(true);
    expect(second !== undefined && isLevelEditCommand(second)).toBe(false);
  });

  it('level 0 IS the premise: no premise-shaped command exists, and 0 is accepted', () => {
    const command = canvasEditCommandSchema.parse({
      kind: 'replace_level',
      level: 0,
      replace: 'A new premise.',
    });
    expect(command).toEqual({ kind: 'replace_level', level: 0, replace: 'A new premise.' });
    // Non-vacuity for the premise claim: the vocabulary knows exactly two level
    // kinds and neither is premise-shaped.
    expect([...CANVAS_LEVEL_EDIT_KINDS]).toEqual(['replace_level', 'append_level']);
  });

  it('fails the WHOLE reply loudly on a malformed level command', () => {
    const cases: string[] = [
      // no level at all
      '<replace_level><replace>x</replace></replace_level>',
      // a non-number, a negative, and a non-canonical (leading zero) number
      '<replace_level level="three"><replace>x</replace></replace_level>',
      '<replace_level level="-1"><replace>x</replace></replace_level>',
      '<append_level level="03"><replace>x</replace></append_level>',
      // level twice
      '<append_level level="1" level="2"><replace>x</replace></append_level>',
      // an unknown attribute
      '<replace_level level="1" mode="replace"><replace>x</replace></replace_level>',
      // self-closing
      '<append_level level="1"/>',
      // a <search> child has no place in a level command
      '<replace_level level="1"><search>a</search><replace>x</replace></replace_level>',
      // unterminated
      '<replace_level level="1"><replace>x</replace>',
      // a stray closing tag is never prose
      'oops </replace_level> here',
    ];
    for (const raw of cases) {
      expect(() => parseCanvasChatReply(raw), raw).toThrow(CanvasChatParseError);
    }
  });

  it('counts level commands under the SAME per-reply cap as search edits', () => {
    const block = '<append_level level="1"><replace>x</replace></append_level>';
    expect(parseCanvasChatReply(block).commands).toHaveLength(1);
    expect(() => parseCanvasChatReply(block.repeat(MAX_COMMANDS_PER_REPLY + 1))).toThrow(
      CanvasChatParseError,
    );
    expect(() => parseCanvasChatReply(block.repeat(MAX_COMMANDS_PER_REPLY))).not.toThrow();
  });

  it('echoes a level command in ITS OWN spelling for the report-to-LLM turn', () => {
    const replaceLevel: CanvasLevelEditCommand = {
      kind: 'replace_level',
      level: 0,
      replace: 'A new premise.',
    };
    const appendLevel: CanvasLevelEditCommand = {
      kind: 'append_level',
      level: 4,
      replace: 'More.',
    };
    expect(canvasEditCommandBlock(replaceLevel)).toBe(
      '<replace_level level="0"><replace>A new premise.</replace></replace_level>',
    );
    expect(canvasEditCommandBlock(appendLevel)).toBe(
      '<append_level level="4"><replace>More.</replace></append_level>',
    );
    // The search half is BYTE-IDENTICAL to the literal it replaced.
    expect(canvasEditCommandBlock({ search: 'a', replace: 'b', all: true })).toBe(
      '<edit all="true"><search>a</search><replace>b</replace></edit>',
    );
    const report = composeFailureReport({
      errorText: 'the document carries levels 0, 1, 2, so there is no level 5 to edit',
      command: { kind: 'replace_level', level: 5, replace: 'x' },
      document: '',
      failureFrom: null,
    });
    expect(report).toContain('<replace_level level="5"><replace>x</replace></replace_level>');
  });
});

describe('the system prompt documents both commands (docs/17 row 381)', () => {
  const prompt = canvasChatSystemPrompt();

  it('shows both commands and the level-number invariant', () => {
    expect(prompt).toContain(
      '<replace_level level="3"><replace>the level\'s new text</replace></replace_level>',
    );
    expect(prompt).toContain(
      '<append_level level="4"><replace>text to add at the end of level 4</replace></append_level>',
    );
    // The premise rule and the no-scaffold rule are both stated.
    expect(prompt).toContain('There is deliberately no premise-shaped command');
    expect(prompt).toContain('never write that scaffold yourself');
    // The creation rule, by name: exactly one more than the last level.
    expect(prompt).toContain('exactly ONE MORE than the last level');
    // The refusal rule is stated as visible, never silent.
    expect(prompt).toContain('A refused level command changes NOTHING');
    expect(prompt).toContain('the other commands in the same reply still apply');
    // The new tags join the "never write these literal strings" list.
    expect(prompt).toContain('<replace_level>, <append_level>, </edit>');
  });
});

describe('a stored thread carrying a level command ROUND-TRIPS (docs/17 row 381)', () => {
  function levelOutcome(): CanvasChatOutcome {
    return {
      id: newChatId('outcome'),
      kind: 'applied',
      command: { kind: 'append_level', level: 3, replace: '## The Long Watch' },
      // planIndex is level − 1, so level 3 persists as 2 and the card reads it
      // back as `Level 3`.
      targetParts: [{ planIndex: 2, title: 'Level 3' }],
      occurrences: 1,
      from: 10,
      to: 30,
      before: null,
      reason: null,
      closest: null,
      failureFrom: null,
      reported: false,
    };
  }

  function threadWith(outcome: CanvasChatOutcome): CanvasChatMessage[] {
    return [
      {
        id: newChatId('msg'),
        role: 'user',
        text: 'add the next level',
        raw: null,
        status: 'ok',
        error: null,
        outcomes: [],
        createdAt: 1,
      },
      {
        id: newChatId('msg'),
        role: 'assistant',
        text: 'Adding it.',
        raw: 'Adding it. <append_level level="3"><replace>## The Long Watch</replace></append_level>',
        status: 'ok',
        error: null,
        outcomes: [outcome],
        createdAt: 2,
      },
    ];
  }

  it('survives the row schema and the reload with its level identity intact', async () => {
    const stored = levelOutcome();
    // `patchModule` validates the row with the module schema, so this is the
    // write that used to THROW before the persisted command union existed.
    await patchModule(world.moduleId, { chatThread: serializeChatThread(threadWith(stored)) });
    const reloaded = await getModule(world.moduleId);
    expect(reloaded).toBeDefined();
    const restored = reloaded?.chatThread[1]?.outcomes[0];
    expect(restored?.command).toEqual({
      kind: 'append_level',
      level: 3,
      replace: '## The Long Watch',
    });
    // The card names the level it touched after the round trip.
    expect(restored?.targetParts).toEqual([{ planIndex: 2, title: 'Level 3' }]);
    expect(restored?.before).toBeNull();
    // And the store-facing deserializer keeps the union narrow-able.
    const messages = deserializeChatThread(reloaded?.chatThread ?? []);
    const restoredCommand = messages[1]?.outcomes[0]?.command;
    expect(restoredCommand !== undefined && isLevelEditCommand(restoredCommand)).toBe(true);
  });

  it('an OLD persisted thread (only a search command) still loads byte-unchanged', async () => {
    const old: CanvasChatOutcome = {
      id: newChatId('outcome'),
      kind: 'applied',
      command: { search: 'Rain', replace: 'Mist', all: false },
      targetParts: [{ planIndex: 0, title: 'The Gate Bargain' }],
      occurrences: 1,
      from: 0,
      to: 4,
      before: 'Rain',
      reason: null,
      closest: null,
      failureFrom: null,
      reported: false,
    };
    await patchModule(world.moduleId, { chatThread: serializeChatThread(threadWith(old)) });
    const reloaded = await getModule(world.moduleId);
    const restored = reloaded?.chatThread[1]?.outcomes[0];
    // BYTE-UNCHANGED: the original arm of the union is the same object shape,
    // with no discriminant added, so a row written before row 381 parses as it
    // always did.
    expect(restored?.command).toEqual({ search: 'Rain', replace: 'Mist', all: false });
    const restoredCommand = deserializeChatThread(reloaded?.chatThread ?? [])[1]?.outcomes[0]?.command;
    expect(restoredCommand !== undefined && isLevelEditCommand(restoredCommand)).toBe(false);
  });

  it('names the level a section-addressed title derives, against the plan titles', () => {
    // The applier's target naming rides `moduleDocumentSections`, whose title
    // is the stored plan title or `Level N` — never a reading of the prose.
    const sections = moduleDocumentSections(
      [
        PREMISE,
        '',
        '=====Level 1=====',
        LEVEL_1,
        '',
        '=====Level 2=====',
        LEVEL_2,
      ].join('\n'),
      [{ title: 'The Gate Bargain' }, { title: '' }],
    );
    expect(sections.map((section) => section.number)).toEqual([0, 1, 2]);
    expect(sections[2]?.title).toBe('Level 2');
    expect(sections[2]?.planIndex).toBe(1);
  });
});
