import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { getModule, patchModule, saveModule } from '@/db/moduleRepo';
import {
  createModule,
  deriveLevelProblems,
  entityLevelHintFor,
  levelAskMessage,
  moduleChatMessageSchema,
  withEntityLevelStatement,
  type ModuleEntityKind,
} from '@/domain';
import {
  canvasChatSystemPrompt,
  canvasEditCommandBlock,
  parseCanvasChatReply,
} from '@/llm/canvasChat';
import { applyLevelStatements } from '@/features/modules/canvas/levelStatements';
import { applyChatCommandsToSnapshot } from '@/features/modules/canvas/snapshotChat';
import { deserializeChatThread, serializeChatThread } from '@/features/modules/canvas/chatPersist';
import { newChatId, type CanvasChatMessage } from '@/features/modules/canvas/chatStore';
import { clearDatabase } from '../db/helpers';

/**
 * THE LEVEL STATEMENT (docs/17 row 401): the chat STATES an NPC's / encounter's
 * level through `<state_level>`; it is written to the RECORD's `levelHint`
 * through ONE writer, never parsed from prose, never touches the document.
 */

const rec = (name: string, kind: ModuleEntityKind['kind'], levelHint?: number): ModuleEntityKind => ({
  name,
  kind,
  absorbed: [],
  bestiary: undefined,
  intent: undefined,
  levelHint,
});

beforeEach(async () => {
  await clearDatabase();
});

describe('the <state_level> command parses in the ONE vocabulary', () => {
  it('parses beside the other commands, in reply order, with an optional entity kind', () => {
    const parsed = parseCanvasChatReply(
      'Fine.<state_level level="3" entity="npc"><name>Marten</name></state_level>' +
        '<edit all="false"><search>a</search><replace>b</replace></edit>' +
        '<state_level level="7"><name> Bridge Ambush </name></state_level>',
    );
    expect(parsed.commands).toEqual([
      { kind: 'state_level', name: 'Marten', level: 3, entityKind: 'npc' },
      { search: 'a', replace: 'b', all: false },
      { kind: 'state_level', name: 'Bridge Ambush', level: 7 },
    ]);
    // Echoed in its own spelling by the report-to-LLM formatter.
    expect(canvasEditCommandBlock(parsed.commands[0]!)).toBe(
      '<state_level level="3" entity="npc"><name>Marten</name></state_level>',
    );
  });

  it('refuses malformed statements loudly (whole reply), and prose is never read for a level', () => {
    for (const bad of [
      '<state_level><name>X</name></state_level>',
      '<state_level level="abc"><name>X</name></state_level>',
      '<state_level level="3" level="4"><name>X</name></state_level>',
      '<state_level level="3" bogus="1"><name>X</name></state_level>',
      '<state_level level="3" entity="location"><name>X</name></state_level>',
      '<state_level level="3"><name></name></state_level>',
      '<state_level level="3"/>',
    ]) {
      expect(() => parseCanvasChatReply(bad), bad).toThrow();
    }
    // "Marten is level 9" in prose is prose: no command, no level.
    expect(parseCanvasChatReply('Marten is level 9, a fearsome foe.').commands).toEqual([]);
  });

  it('the prompt tells the chat to state levels and the encounter minimum', () => {
    const prompt = canvasChatSystemPrompt();
    expect(prompt).toContain('STATE THE LEVEL OF EVERY NPC AND EVERY ENCOUNTER YOU WRITE');
    expect(prompt).toContain('<state_level level="3" entity="npc">');
  });
});

describe('ONE writer of the recorded level', () => {
  it('writes levelHint on the named record only; out-of-range / non-integer / unknown / wrong kind are refused per command', () => {
    const records = [rec('Marten', 'npc'), rec('Gate', 'location'), rec('Ambush', 'encounter')];
    const ok = withEntityLevelStatement(records, 'marten', 4);
    expect(ok.ok && ok.records.map((r) => r.levelHint)).toEqual([4, undefined, undefined]);
    for (const level of [0, 21, 2.5, Number.NaN]) {
      expect(withEntityLevelStatement(records, 'Marten', level).ok, String(level)).toBe(false);
    }
    expect(withEntityLevelStatement(records, 'Gate', 3)).toMatchObject({ ok: false });
    expect(withEntityLevelStatement(records, 'Nobody', 3)).toMatchObject({ ok: false });
    // A stated kind creates the record (no second classifier).
    const created = withEntityLevelStatement(records, 'Nobody', 3, 'npc');
    expect(created.ok && created.records.at(-1)).toMatchObject({ name: 'Nobody', kind: 'npc', levelHint: 3 });
    expect(withEntityLevelStatement(records, 'Ambush', 3, 'npc')).toMatchObject({ ok: false });
  });
});

describe('applied through the record seam: persisted, siblings survive, document byte-identical', () => {
  it('applies good statements, fails the bad one loudly, leaves the document alone', async () => {
    const campaign = await createCampaign({ name: 'E', system: 'dnd5e' });
    const draft = createModule({ campaignId: campaign.id, title: 'T', concept: '', levelMin: 1, levelMax: 1, sizeDial: 'sketch' });
    await saveModule({ ...draft, entityKinds: [rec('Marten', 'npc'), rec('Ambush', 'encounter')] });
    const commands = parseCanvasChatReply(
      '<state_level level="3"><name>Marten</name></state_level>' +
        '<state_level level="99"><name>Ambush</name></state_level>' +
        '<state_level level="5" entity="encounter"><name>Ambush</name></state_level>',
    ).commands;
    const outcomes = await applyLevelStatements(draft.id, commands);
    expect(outcomes.map((o) => o.kind)).toEqual(['applied', 'failed', 'applied']);
    expect(outcomes[1]?.reason).toContain('between 1 and 20');
    const row = await getModule(draft.id);
    expect(entityLevelHintFor(row!.entityKinds, 'Marten')).toBe(3);
    expect(entityLevelHintFor(row!.entityKinds, 'Ambush')).toBe(5);

    // The document applier ignores a statement: text is byte-identical.
    const doc = 'Premise.\n\n=====Level 1=====\nText [[Marten]].';
    const snapshot = applyChatCommandsToSnapshot({ commands, partPlan: [{ title: 'One' }], doc });
    expect(snapshot.docChanged).toBe(false);
    expect(snapshot.outcomes).toEqual([]);
  });

  it('round-trips through the persisted thread schema and patchModule; an OLD thread loads unchanged', async () => {
    const campaign = await createCampaign({ name: 'E', system: 'dnd5e' });
    const draft = createModule({ campaignId: campaign.id, title: 'T', concept: '', levelMin: 1, levelMax: 1, sizeDial: 'sketch' });
    await saveModule(draft);
    const command = { kind: 'state_level' as const, name: 'Marten', level: 3, entityKind: 'npc' as const };
    const message: CanvasChatMessage = {
      id: newChatId('m'), role: 'assistant', text: 'ok', raw: null, status: 'ok', error: null, createdAt: 1,
      outcomes: [{
        id: newChatId('o'), kind: 'applied', command, targetParts: [], occurrences: 1, from: null, to: null,
        before: null, reason: null, closest: null, failureFrom: null, reported: false,
      }],
    };
    await patchModule(draft.id, { chatThread: serializeChatThread([message]) });
    const back = deserializeChatThread((await getModule(draft.id))!.chatThread);
    expect(back[0]?.outcomes[0]?.command).toEqual(command);
    // Old search / level-edit commands still parse through the same schema.
    for (const old of [
      { search: 'a', replace: 'b', all: false },
      { kind: 'replace_level', level: 1, replace: 'x' },
    ]) {
      const parsed = moduleChatMessageSchema.parse({
        id: 'x', role: 'assistant', text: '', raw: null, status: 'ok', error: null, createdAt: 1,
        outcomes: [{ id: 'o', kind: 'applied', command: old }],
      });
      expect(parsed.outcomes[0]?.command).toEqual(old);
    }
  });
});

describe('THE problem list: one function over the whole document', () => {
  const doc = [
    'The premise mentions [[Lonely Fight]].',
    '=====Level 1=====',
    'Meet [[Ilse]] and survive [[Bridge Ambush]]. See [[Old Keep]].',
    '=====Level 2=====',
    'Later, [[Marten]] recalls [[Bridge Ambush]].',
    '=====Level 3=====',
    'Nothing here.',
  ].join('\n');
  const kinds = [
    rec('Lonely Fight', 'encounter', 4),
    rec('Ilse', 'npc'),
    rec('Bridge Ambush', 'encounter'),
    rec('Marten', 'npc'),
  ];

  it('lists missing levels, per-level shortfalls, premise-only encounters — in document order, unclassified counted apart', () => {
    const report = deriveLevelProblems({ document: doc, entityKinds: kinds });
    expect(report.problems.map((p) => [p.kind, 'name' in p ? p.name : p.level])).toEqual([
      ['needs-placement', 'Lonely Fight'],
      ['missing-level', 'Ilse'],
      ['missing-level', 'Bridge Ambush'],
      ['missing-level', 'Marten'],
      ['encounter-shortfall', 3],
    ]);
    expect(report.unclassifiedLinks).toEqual(['Old Keep']);
    expect(report.encounterCounts).toEqual([
      { level: 1, found: 1, required: 1 },
      { level: 2, found: 1, required: 1 },
      { level: 3, found: 0, required: 1 },
    ]);
  });

  it('a per-level minimum of 2 changes the shortfalls; a disabled floor has none; a fully specified campaign is EMPTY', () => {
    const two = deriveLevelProblems({ document: doc, entityKinds: kinds, floor: { enabled: true, perLevel: 2 } });
    expect(two.problems.filter((p) => p.kind === 'encounter-shortfall')).toHaveLength(3); // levels 1 and 2 hold ONE each (a recap counts where written), level 3 none
    const off = deriveLevelProblems({ document: doc, entityKinds: kinds, floor: { enabled: false, perLevel: 0 } });
    expect(off.problems.some((p) => p.kind === 'encounter-shortfall')).toBe(false);
    const full = deriveLevelProblems({
      document: '=====Level 1=====\n[[Ilse]] [[Ambush]]',
      entityKinds: [rec('Ilse', 'npc', 2), rec('Ambush', 'encounter', 2)],
    });
    expect(full.problems).toEqual([]);
  });

  it('ONE message carries ALL problems', () => {
    const { problems } = deriveLevelProblems({ document: doc, entityKinds: kinds });
    const message = levelAskMessage(problems);
    expect(message.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(problems.length);
  });
});
