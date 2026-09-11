import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CANVAS_CHAT_DETAILS_INSTRUCTION,
  CanvasChatParseError,
  MAX_DETAILS_BLOCK_CHARS,
  MAX_REQUESTS_PER_REPLY,
  REQUESTED_DETAILS_HEADER,
  artifactDetailLines,
  buildCanvasChatDetailsPayload,
  buildCanvasChatPayload,
  canvasChatTurnContent,
  chatProseSoFar,
  parseCanvasChatReply,
  renderArtifactDetails,
  resolveChatDetailsRequests,
  sendCanvasChatMessage,
  type CanvasChatTurnInput,
  type CanvasChatTurnResult,
} from '@/llm/canvasChat';
import {
  assembleModulePartsDocument,
  createModule,
  encounterDataSchema,
  factionDataSchema,
  modulePartSchema,
  moduleSpineSchema,
  npcDataSchema,
  statBlockSchema,
  type Id,
} from '@/domain';
import { createCampaign } from '@/db/campaignRepo';
import { saveModule } from '@/db/moduleRepo';
import { createArtifact, listArtifactsByCampaign } from '@/db/artifactRepo';
import { db } from '@/db/db';
import { clearDatabase } from '../db/helpers';

/**
 * The READ HALF of the canvas chat (docs/17 ledger row 103, owner's words:
 * *"I am considering right now if we should make the details available for
 * the chat (maybe not unconditionally but for the LLM to be able to request).
 * That would also need an ability for the LLM to actually change those
 * details."* — this file pins the READ half only; the write half does not
 * exist yet).
 *
 * What is pinned here:
 *  - the `<request>` command is parsed by the SAME strict extractor with the
 *    same loudness (malformed/over-cap replies fail the WHOLE reply);
 *  - the answers come from STORED rows (a field that exists nowhere in the
 *    module text must ride the second call) resolved through the EXISTING
 *    wiki-link resolver with the module scope;
 *  - exactly ONE further model call per user turn — never a loop;
 *  - unknown/ambiguous/empty/capped requests produce NAMED reasons the model
 *    reads in that next turn;
 *  - a reply with no `<request>` is the plain single-call turn it always was;
 *  - nothing in the path writes anything.
 */

vi.mock('@/llm/openrouter', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  chat: vi.fn(),
}));

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);

const PART_0 = '## The Gate Bargain\n\nThe party bargains with [[Keeper Ilse]] at the gate.';
const PART_1 = 'The docks breathe fog.';
const PART_PLAN = [
  { title: 'The Gate Bargain', levelBand: '1' },
  { title: 'Under the Docks', levelBand: '1' },
];
const PARTS_DOCUMENT = assembleModulePartsDocument({
  partPlan: PART_PLAN,
  parts: [
    { planIndex: 0, markdown: PART_0 },
    { planIndex: 1, markdown: PART_1 },
  ],
}).document;

/** The stored field that exists NOWHERE in the module text — the non-vacuity
 * anchor of every "answers come from the row" pin below. */
const STORED_ONLY_TREASURE = 'a silver locket with an engraved tide-mark';
const STORED_ONLY_ROOM_KEY = 'GM: the altar is a pressure plate; DC 15 to spot.';

function statBlock(overrides: { hp?: number; ac?: number } = {}) {
  return statBlockSchema.parse({
    system: 'dnd5e',
    level: '2',
    size: 'Medium',
    creatureType: 'humanoid (goblinoid)',
    ac: overrides.ac ?? 15,
    hp: overrides.hp ?? 22,
    speed: '30 ft.',
    abilities: { str: 10, dex: 14, con: 12, int: 10, wis: 8, cha: 8 },
    saves: 'Dex +4',
    skills: 'Stealth +6',
    senses: 'darkvision 60 ft.',
    languages: 'Common, Goblin',
    traits: [{ name: 'Nimble Escape', text: 'It disengages as a bonus action.' }],
    actions: [{ name: 'Scimitar', text: 'Melee: +4, 1d6+2 slashing.' }],
  });
}

let world: { campaignId: Id; moduleId: Id; encounterId: Id; npcId: Id } = {
  campaignId: '',
  moduleId: '',
  encounterId: '',
  npcId: '',
};

async function seed(): Promise<void> {
  const campaign = await createCampaign({ name: 'Ember', description: 'The ember war.', system: 'dnd5e' });
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
    spine: moduleSpineSchema.parse({ premise: 'The premise.', themes: [], partPlan: PART_PLAN }),
    parts: [
      modulePartSchema.parse({ planIndex: 0, markdown: PART_0, status: 'ready', errorMessage: '', edited: false }),
      modulePartSchema.parse({ planIndex: 1, markdown: PART_1, status: 'ready', errorMessage: '', edited: false }),
    ],
  });
  const npc = await createArtifact({
    campaignId: campaign.id,
    moduleId: draft.id,
    kind: 'npc',
    name: 'Keeper Ilse',
    aliases: ['the gatekeeper'],
    tags: ['gate'],
    summary: 'The keeper of the drowned gate.',
    body: '# Ilse\nShe keeps the gate and her own counsel.',
    data: npcDataSchema.parse({
      appearance: 'Salt-crusted coat.',
      personality: 'Patient, sardonic.',
      statBlock: statBlock({ hp: 41, ac: 17 }),
    }),
  });
  const encounter = await createArtifact({
    campaignId: campaign.id,
    moduleId: draft.id,
    kind: 'encounter',
    name: 'Salt Gate Ambush',
    tags: ['ambush'],
    summary: 'Four goblins hold the flooded gate.',
    body: 'The gate fight happens at high tide.',
    data: encounterDataSchema.parse({
      difficulty: 'hard',
      levelHint: '3',
      terrain: 'Flooded flagstones, chest-deep at the arch.',
      tactics: 'They fight from the ledges and retreat into the water.',
      treasure: 'The tide-hoard is behind the altar.',
      monsters: [
        {
          name: 'Goblin Warrior',
          count: 4,
          notes: 'Two on each ledge.',
          treasure: STORED_ONLY_TREASURE,
          source: { type: 'inline', statBlock: statBlock() },
        },
      ],
      preset: 'dungeon',
      locationKind: 'dungeon',
      siteShape: 'complex',
      budgetAdvisory: 'Room 2 ships over its challenge band.',
      fillGrade: 70,
      layout: {
        gridW: 20,
        gridH: 16,
        theme: 'flooded gate',
        rooms: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            name: 'The Arch',
            description: 'The gate arch, ankle-deep.',
            rects: [{ x: 1, y: 1, w: 6, h: 6 }],
            mobsRect: { x: 2, y: 2, w: 4, h: 4 },
            monsterIndexes: [0],
            spawn: true,
            key: 'GM: the arch keystone is loose.',
            keyTreasure: 'nothing',
          },
          {
            id: '22222222-2222-4222-8222-222222222222',
            name: 'The Altar Room',
            description: 'The flooded altar.',
            rects: [{ x: 9, y: 1, w: 6, h: 6 }],
            mobsRect: { x: 10, y: 2, w: 4, h: 4 },
            monsterIndexes: [0],
            spawn: false,
            key: STORED_ONLY_ROOM_KEY,
            keyTreasure: 'the tide-hoard',
          },
        ],
        corridors: [{ a: '11111111-1111-4111-8111-111111111111', b: '22222222-2222-4222-8222-222222222222', rects: [{ x: 7, y: 3, w: 2, h: 1 }] }],
        mapPath: 'classic',
        path: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'],
      },
    }),
  });
  world = { campaignId: campaign.id, moduleId: draft.id, encounterId: encounter.id, npcId: npc.id };
}

beforeEach(async () => {
  await clearDatabase();
  vi.clearAllMocks();
  await seed();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function baseInput(overrides: Partial<CanvasChatTurnInput> = {}): CanvasChatTurnInput {
  return {
    moduleId: world.moduleId,
    document: PARTS_DOCUMENT,
    instruction: 'tighten the gate fight',
    history: [],
    turn: new AbortController(),
    ...overrides,
  };
}

/**
 * Narrows a round-trip result to the SERVED arm — a guard, not a cast, so a
 * test that expected an answer fails loudly instead of reading `undefined`.
 */
function servedDetails(result: CanvasChatTurnResult): Extract<NonNullable<CanvasChatTurnResult['details']>, { status: 'ok' }> {
  const details = result.details;
  if (details?.status !== 'ok') throw new Error(`expected a served round trip, got ${JSON.stringify(details)}`);
  return details;
}

/** Narrows a round-trip result to the FAILED arm (the loud follow-up path). */
function failedDetails(result: CanvasChatTurnResult): Extract<NonNullable<CanvasChatTurnResult['details']>, { status: 'failed' }> {
  const details = result.details;
  if (details?.status !== 'failed') throw new Error(`expected a failed round trip, got ${JSON.stringify(details)}`);
  return details;
}

function textOf(message: { content: unknown }): string {
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
}

function payloadTextOf(callIndex: number): string {
  const messages = chatMock.mock.calls[callIndex]?.[0] ?? [];
  return messages.map((message) => textOf(message)).join('\n\n===MESSAGE===\n\n');
}

describe('<request> parsing (the SAME strict extractor)', () => {
  it('parses a request block plus prose, and leaves the edit commands alone', () => {
    const parsed = parseCanvasChatReply(
      [
        'Let me check the encounter rows before editing.',
        '<request><name>Salt Gate Ambush</name></request>',
        'Then I will adjust the roster.',
        '<edit><search>gate</search><replace>arch</replace></edit>',
      ].join('\n'),
    );
    expect(parsed.requests).toEqual([{ name: 'Salt Gate Ambush' }]);
    expect(parsed.commands).toEqual([{ search: 'gate', replace: 'arch', all: false }]);
    expect(parsed.prose).toContain('Let me check the encounter rows');
    expect(parsed.prose).not.toContain('<request>');
  });

  it('finds a request that sits BEFORE an edit (the two tags scan in ONE walk)', () => {
    const parsed = parseCanvasChatReply(
      '<request><name>Keeper Ilse</name></request>\n<edit><search>a</search><replace>b</replace></edit>',
    );
    expect(parsed.requests).toHaveLength(1);
    expect(parsed.commands).toHaveLength(1);
    // The request is NOT swallowed into prose (the pre-extension scanner only
    // knew `<edit` and would have left the whole block in the prose).
    expect(parsed.prose).toBe('');
  });

  it('trims the requested name and accepts several requests in one reply', () => {
    const parsed = parseCanvasChatReply(
      '<request><name>  Keeper Ilse  </name></request><request><name>Salt Gate Ambush</name></request>',
    );
    expect(parsed.requests).toEqual([{ name: 'Keeper Ilse' }, { name: 'Salt Gate Ambush' }]);
  });

  it('fails loud on an attribute, a wrong child, a self-closing tag and an empty name', () => {
    expect(() => parseCanvasChatReply('<request name="Keeper Ilse"></request>')).toThrow(CanvasChatParseError);
    expect(() => parseCanvasChatReply('<request><nama>x</nama></request>')).toThrow(CanvasChatParseError);
    expect(() => parseCanvasChatReply('<request/>')).toThrow(CanvasChatParseError);
    expect(() => parseCanvasChatReply('<request />')).toThrow(CanvasChatParseError);
    expect(() => parseCanvasChatReply('<request><name>x</name>')).toThrow(CanvasChatParseError);
    expect(() => parseCanvasChatReply('<request><name>   </name></request>')).toThrow(CanvasChatParseError);
    expect(() => parseCanvasChatReply('<request><name>a</name><name>b</name></request>')).toThrow(CanvasChatParseError);
  });

  it('fails loud on a stray </request> and on unknown extra content', () => {
    expect(() => parseCanvasChatReply('oops </request> here')).toThrow(CanvasChatParseError);
    expect(() => parseCanvasChatReply('<request>junk<name>a</name></request>')).toThrow(CanvasChatParseError);
  });

  it('fails loud over the per-reply request cap (and the cap is accepted exactly)', () => {
    // The cap is a DOCUMENTED number (docs/08 §Module canvas chat, row 103):
    // asserting it by LITERAL is what keeps this pin non-vacuous — a pin
    // written against the constant alone passes whatever the constant becomes.
    expect(MAX_REQUESTS_PER_REPLY).toBe(5);
    const block = '<request><name>Keeper Ilse</name></request>';
    expect(() => parseCanvasChatReply(block.repeat(6))).toThrow(CanvasChatParseError);
    expect(parseCanvasChatReply(block.repeat(5)).requests).toHaveLength(5);
  });

  it('a tag-name lookalike stays prose (both tags keep their boundary rule)', () => {
    const parsed = parseCanvasChatReply('See <requested-details> and <editorial> for prose only.');
    expect(parsed.requests).toEqual([]);
    expect(parsed.prose).toContain('<requested-details>');
  });

  it('chatProseSoFar hides complete request blocks and reports a forming one', () => {
    expect(chatProseSoFar('Checking.<request><name>Ilse</name></request> Done.')).toEqual({
      prose: 'Checking. Done.',
      composing: false,
    });
    expect(chatProseSoFar('Checking.<request><name>Il')).toEqual({ prose: 'Checking.', composing: true });
    // A raw with NO command block is returned byte-identically (unchanged).
    expect(chatProseSoFar('  just prose  ')).toEqual({ prose: '  just prose  ', composing: false });
  });
});

describe('stored-details rendering (from the ROW, never the text)', () => {
  it('renders every stored field of an encounter, roster stats included', async () => {
    const pool = await listArtifactsByCampaign(world.campaignId);
    const { answers, block } = await resolveChatDetailsRequests({
      requests: [{ name: 'Salt Gate Ambush' }],
      moduleId: world.moduleId,
      pool,
    });
    expect(answers).toHaveLength(1);
    expect(answers[0]?.status).toBe('answered');
    expect(answers[0]?.artifactId).toBe(world.encounterId);
    // Stored-only facts that CANNOT be derived from the module text.
    expect(block).toContain(STORED_ONLY_TREASURE);
    expect(block).toContain(STORED_ONLY_ROOM_KEY);
    expect(block).toContain('Room 2 ships over its challenge band.');
    expect(block).toContain('fill grade: 70%');
    expect(block).toContain('difficulty hard');
    // Rooms, play order, corridors and the roster entry with its inline stats.
    expect(block).toContain('room 1 «The Arch» [spawn room]');
    expect(block).toContain('play order: «The Arch» → «The Altar Room»');
    expect(block).toContain('«The Arch» ↔ «The Altar Room»');
    expect(block).toContain('- #1 Goblin Warrior ×4');
    expect(block).toContain(`    treasure: ${STORED_ONLY_TREASURE}`);
    expect(block).toContain('stats (inline)');
    expect(block).toContain('HP 22');
    // Identity + scope + stored prose.
    expect(block).toContain('### Salt Gate Ambush — Encounter · owned by this module');
    expect(block).toContain('summary: Four goblins hold the flooded gate.');
    expect(block).toContain('prose body (the row\'s stored markdown):');
  });

  it('renders an NPC stat block from the row and names an alias hit', async () => {
    const pool = await listArtifactsByCampaign(world.campaignId);
    const { answers, block } = await resolveChatDetailsRequests({
      requests: [{ name: 'the gatekeeper' }],
      moduleId: world.moduleId,
      pool,
    });
    expect(answers[0]?.status).toBe('answered');
    expect(block).toContain('### Keeper Ilse — NPC · owned by this module');
    expect(block).toContain('requested as: «the gatekeeper»');
    expect(block).toContain('also known as: the gatekeeper');
    expect(block).toContain('HP 41');
    expect(block).toContain('AC 17');
    expect(block).toContain('Nimble Escape');
  });

  it('names an unknown requested name as a NO SUCH ARTIFACT refusal', async () => {
    const pool = await listArtifactsByCampaign(world.campaignId);
    const { answers, block } = await resolveChatDetailsRequests({
      requests: [{ name: 'Halmund the Smith' }],
      moduleId: world.moduleId,
      pool,
    });
    expect(answers[0]?.status).toBe('unresolved');
    expect(answers[0]?.reason).toContain('no artifact in this campaign or the shared library is named «Halmund the Smith»');
    expect(block).toContain('### Request «Halmund the Smith» — NOT SERVED: NO SUCH ARTIFACT');
    expect(block).toContain('the same name resolution the module\'s wiki chips use');
  });

  it('refuses an ambiguous name and lists EXACTLY the resolver\'s candidates (chip parity)', async () => {
    await createArtifact({ campaignId: world.campaignId, moduleId: world.moduleId, kind: 'npc', name: 'Ash Priest' });
    await createArtifact({
      campaignId: world.campaignId,
      moduleId: world.moduleId,
      kind: 'location',
      name: 'Ash Priest',
      aliases: ['the ash chapel'],
    });
    const pool = await listArtifactsByCampaign(world.campaignId);
    const { answers, block } = await resolveChatDetailsRequests({
      requests: [{ name: 'ash priest' }],
      moduleId: world.moduleId,
      pool,
    });
    const { resolveWikiLink } = await import('@/lib/wikilinks');
    const chips = resolveWikiLink('ash priest', pool, { moduleId: world.moduleId });
    expect(chips.status).toBe('ambiguous');
    expect(answers[0]?.status).toBe('ambiguous');
    expect(answers[0]?.candidateIds).toEqual(chips.candidates.map((candidate) => candidate.id));
    expect(block).toContain('### Request «ash priest» — NOT SERVED: AMBIGUOUS NAME');
    expect(block).toContain('2 stored artifacts match «ash priest»');
    expect(block).toContain('«Ash Priest» (NPC, no aliases)');
    expect(block).toContain('«Ash Priest» (Location, aliases: the ash chapel)');
    expect(block).toContain('The app will not guess which row you meant');
  });

  it('refuses a row that stores NOTHING with the bare-stub reason', async () => {
    const stub = await createArtifact({ campaignId: world.campaignId, moduleId: world.moduleId, kind: 'note', name: 'Loose Thread' });
    const pool = await listArtifactsByCampaign(world.campaignId);
    const { answers, block } = await resolveChatDetailsRequests({
      requests: [{ name: 'Loose Thread' }],
      moduleId: world.moduleId,
      pool,
    });
    expect(answers[0]?.status).toBe('no-details');
    expect(answers[0]?.artifactId).toBe(stub.id);
    expect(block).toContain('### Request «Loose Thread» — NOT SERVED: NOTHING STORED ON THE ROW');
    expect(block).toContain('stores no details at all');
    expect(block).toContain('Never invent its content');
  });

  it('answers a note whose stored prose is all it has (a note is not "no details" when it stores text)', async () => {
    await createArtifact({
      campaignId: world.campaignId,
      moduleId: world.moduleId,
      kind: 'note',
      name: 'The Tide Mark',
      body: 'The mark rises one hand each night.',
    });
    const pool = await listArtifactsByCampaign(world.campaignId);
    const { answers, block } = await resolveChatDetailsRequests({
      requests: [{ name: 'The Tide Mark' }],
      moduleId: world.moduleId,
      pool,
    });
    expect(answers[0]?.status).toBe('answered');
    expect(block).toContain('The mark rises one hand each night.');
  });

  it('truncates ONE oversized record with the loud marker (never silently shorter)', async () => {
    // The block cap is documented (docs/08, row 103) — assert the literal, so
    // raising the cap cannot silently retire this pin.
    expect(MAX_DETAILS_BLOCK_CHARS).toBe(12_000);
    await createArtifact({
      campaignId: world.campaignId,
      moduleId: world.moduleId,
      kind: 'note',
      name: 'The Long Ledger',
      body: 'x'.repeat(MAX_DETAILS_BLOCK_CHARS + 5000),
    });
    const pool = await listArtifactsByCampaign(world.campaignId);
    const { answers, block } = await resolveChatDetailsRequests({
      requests: [{ name: 'The Long Ledger' }],
      moduleId: world.moduleId,
      pool,
    });
    expect(answers[0]?.status).toBe('truncated');
    expect(block).toContain('[TRUNCATED — «The Long Ledger» alone exceeds the');
    expect(block).toContain('CUT MID-WAY and the remainder was NOT included');
    expect(block.length).toBeLessThan(MAX_DETAILS_BLOCK_CHARS + 800);
  });

  it('refuses a request that no longer fits the cap, naming it in the block', async () => {
    await createArtifact({
      campaignId: world.campaignId,
      moduleId: world.moduleId,
      kind: 'note',
      name: 'Filler Ledger',
      body: 'y'.repeat(MAX_DETAILS_BLOCK_CHARS - 500),
    });
    const pool = await listArtifactsByCampaign(world.campaignId);
    const { answers, block } = await resolveChatDetailsRequests({
      requests: [{ name: 'Filler Ledger' }, { name: 'Keeper Ilse' }],
      moduleId: world.moduleId,
      pool,
    });
    expect(answers[0]?.status).toBe('answered');
    expect(answers[1]?.status).toBe('over-cap');
    expect(block).toContain('[BLOCK FULL');
    expect(block).toContain('«Keeper Ilse»');
    expect(block).not.toContain('HP 41');
  });

  it('renders EVERY kind without inventing anything (pure renderer)', async () => {
    const extras = { byId: new Map<Id, never>() };
    const artifact = await createArtifact({
      campaignId: world.campaignId,
      moduleId: world.moduleId,
      kind: 'faction',
      name: 'The Salt Guild',
      data: factionDataSchema.parse({
        goals: 'Own the tide gates.',
        methods: 'Debt.',
        resources: 'Three barges.',
        ranks: [{ title: 'Tidewarden', description: 'Keeps the keys.' }],
      }),
    });
    const lines = artifactDetailLines({ artifact, requestedName: 'The Salt Guild', extras });
    expect(lines).toEqual([
      'goals: Own the tide gates.',
      'methods: Debt.',
      'resources: Three barges.',
      'ranks:',
      '  - Tidewarden: Keeps the keys.',
    ]);
  });
});

describe('sendCanvasChatMessage — the request round trip', () => {
  it('a reply with NO request is the plain single-call turn it always was', async () => {
    const raw = 'Tightened.\n<edit><search>fog</search><replace>mist</replace></edit>';
    chatMock.mockResolvedValue({ text: raw, modelUsed: 'served-by', fallback: null });
    const result = await sendCanvasChatMessage(baseInput());
    expect(chatMock).toHaveBeenCalledTimes(1);
    expect(result.details).toBeNull();
    expect(result.raw).toBe(raw);
    expect(result.parse.commands).toHaveLength(1);
    expect(result.modelUsed).toBe('served-by');
    // Byte-identity of the turn content: NO details block, the instruction last.
    const [messages] = chatMock.mock.calls[0] ?? [];
    const last = messages?.[messages.length - 1];
    expect(last?.role).toBe('user');
    expect(payloadTextOf(0)).not.toContain('<requested-details>');
    expect(last?.content).toBe(
      [
        'Module parts document — the CURRENT state, including all previously applied edits:',
        '<document>',
        PARTS_DOCUMENT,
        '</document>',
        '',
        'REFERENCE-ONLY CONTEXT — continuity material. NEVER edit it and never emit edit commands against it; commands apply to the current module\'s parts document above:',
        '<reference-only>',
        'Campaign: Ember — The ember war.',
        '',
        'Game system: D&D 5e',
        '</reference-only>',
        '',
        'Instruction: tighten the gate fight',
      ].join('\n'),
    );
  });

  it('answers a request from the STORED row in exactly ONE further call', async () => {
    chatMock
      .mockResolvedValueOnce({
        text: 'Let me check the encounter first.\n<request><name>Salt Gate Ambush</name></request>',
        modelUsed: 'first-call-model',
        fallback: null,
      })
      .mockResolvedValueOnce({
        text: 'Now the roster edit.\n<edit><search>fog</search><replace>mist</replace></edit>',
        modelUsed: 'second-call-model',
        fallback: null,
      });
    const result = await sendCanvasChatMessage(baseInput());
    expect(chatMock).toHaveBeenCalledTimes(2);
    const details = servedDetails(result);
    expect(details.modelUsed).toBe('second-call-model');
    expect(details.answers[0]?.status).toBe('answered');
    expect(details.parse.commands).toHaveLength(1);
    expect(details.ignoredRequests).toEqual([]);
    // The STORED field the module text never carries rides the second call.
    const second = payloadTextOf(1);
    expect(second).toContain(STORED_ONLY_TREASURE);
    expect(second).toContain(STORED_ONLY_ROOM_KEY);
    expect(second).toContain(REQUESTED_DETAILS_HEADER);
    expect(second).toContain('<requested-details>');
    expect(second).toContain('</requested-details>');
    expect(second).toContain(CANVAS_CHAT_DETAILS_INSTRUCTION);
    // The model sees its OWN request back, and the document rides exactly once.
    const messages = chatMock.mock.calls[1]?.[0] ?? [];
    expect(messages.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(messages[2]?.content).toContain('<request><name>Salt Gate Ambush</name></request>');
    expect(messages.filter((message) => textOf(message).includes(PART_1))).toHaveLength(1);
    // The FIRST call never carried the details (they did not exist yet).
    expect(payloadTextOf(0)).not.toContain(STORED_ONLY_TREASURE);
    expect(payloadTextOf(0)).not.toContain('<requested-details>');
  });

  it('serves a refusal to the model as a NAMED reason in the second call', async () => {
    chatMock
      .mockResolvedValueOnce({ text: '<request><name>Halmund the Smith</name></request>', modelUsed: 'm', fallback: null })
      .mockResolvedValueOnce({ text: 'I could not find that row, so here is prose only.', modelUsed: 'm2', fallback: null });
    const result = await sendCanvasChatMessage(baseInput());
    expect(chatMock).toHaveBeenCalledTimes(2);
    const details = servedDetails(result);
    expect(details.answers[0]?.status).toBe('unresolved');
    const second = payloadTextOf(1);
    expect(second).toContain('NOT SERVED: NO SUCH ARTIFACT');
    expect(second).toContain('no artifact in this campaign or the shared library is named «Halmund the Smith»');
  });

  it('a SECOND request in the follow-up reply is a named no-op — never a third call', async () => {
    chatMock
      .mockResolvedValueOnce({ text: '<request><name>Salt Gate Ambush</name></request>', modelUsed: 'm', fallback: null })
      .mockResolvedValueOnce({
        text: 'I need one more row.\n<request><name>Keeper Ilse</name></request>',
        modelUsed: 'm',
        fallback: null,
      });
    const result = await sendCanvasChatMessage(baseInput());
    expect(chatMock).toHaveBeenCalledTimes(2);
    const details = servedDetails(result);
    expect(details.ignoredRequests).toEqual([{ name: 'Keeper Ilse' }]);
    expect(details.parse.prose).toContain('I need one more row.');
  });

  it('a follow-up whose reply does not parse is LOUD and leaves the first reply intact', async () => {
    chatMock
      .mockResolvedValueOnce({
        text: 'Checking.\n<request><name>Salt Gate Ambush</name></request>',
        modelUsed: 'm',
        fallback: null,
      })
      .mockResolvedValueOnce({ text: 'broken <request><name>x', modelUsed: 'm', fallback: null });
    const result = await sendCanvasChatMessage(baseInput());
    const details = failedDetails(result);
    expect(details.error).toContain('missing </name>');
    expect(details.answers[0]?.status).toBe('answered');
    // The first reply is untouched — the caller still applies its work.
    expect(result.raw).toContain('<request><name>Salt Gate Ambush</name></request>');
  });

  it('a follow-up transport failure is LOUD and leaves the first reply intact', async () => {
    chatMock
      .mockResolvedValueOnce({ text: '<request><name>Salt Gate Ambush</name></request>', modelUsed: 'm', fallback: null })
      .mockRejectedValueOnce(new Error('upstream 503'));
    const result = await sendCanvasChatMessage(baseInput());
    const details = failedDetails(result);
    expect(details.error).toBe('upstream 503');
  });

  it('an over-cap reply fails the WHOLE reply and answers nothing', async () => {
    const block = '<request><name>Keeper Ilse</name></request>';
    chatMock.mockResolvedValue({ text: block.repeat(MAX_REQUESTS_PER_REPLY + 1), modelUsed: 'm', fallback: null });
    await expect(sendCanvasChatMessage(baseInput())).rejects.toThrow(CanvasChatParseError);
    expect(chatMock).toHaveBeenCalledTimes(1);
  });

  it('an abort during the follow-up call propagates (a stop is a stop)', async () => {
    const turn = new AbortController();
    chatMock.mockImplementationOnce(() =>
      Promise.resolve({ text: '<request><name>Salt Gate Ambush</name></request>', modelUsed: 'm', fallback: null }),
    );
    chatMock.mockImplementationOnce(() => {
      turn.abort();
      return Promise.reject(new DOMException('Aborted', 'AbortError'));
    });
    await expect(sendCanvasChatMessage(baseInput({ turn }))).rejects.toThrow(/abort/i);
  });

  it('streams the follow-up reply through its OWN callback', async () => {
    const firstDeltas: string[] = [];
    const followUpDeltas: string[] = [];
    chatMock.mockImplementationOnce((_messages, options) => {
      options.onToken?.('Checking the row');
      return Promise.resolve({ text: '<request><name>Salt Gate Ambush</name></request>', modelUsed: 'm', fallback: null });
    });
    chatMock.mockImplementationOnce((_messages, options) => {
      options.onToken?.('Here is the edit');
      return Promise.resolve({ text: 'Here is the edit', modelUsed: 'm', fallback: null });
    });
    await sendCanvasChatMessage(
      baseInput({
        onDelta: (text) => firstDeltas.push(text),
        onFollowUpDelta: (text) => followUpDeltas.push(text),
      }),
    );
    expect(firstDeltas).toEqual(['Checking the row']);
    expect(followUpDeltas).toEqual(['Here is the edit']);
  });

  it('the round trip WRITES NOTHING (no artifact row, no revision, no module text)', async () => {
    const before = await listArtifactsByCampaign(world.campaignId);
    const revisionsBefore = await db.revisions.count();
    const moduleBefore = await (await import('@/db/moduleRepo')).getModule(world.moduleId);
    chatMock
      .mockResolvedValueOnce({ text: '<request><name>Salt Gate Ambush</name></request>', modelUsed: 'm', fallback: null })
      .mockResolvedValueOnce({ text: 'Noted.', modelUsed: 'm', fallback: null });
    await sendCanvasChatMessage(baseInput());
    const after = await listArtifactsByCampaign(world.campaignId);
    expect(after).toEqual(before);
    expect(await db.revisions.count()).toBe(revisionsBefore);
    const moduleAfter = await (await import('@/db/moduleRepo')).getModule(world.moduleId);
    expect(moduleAfter).toEqual(moduleBefore);
  });
});

describe('the details payload builder (roles + one document)', () => {
  it('inserts the model reply and the app answer, keeping the roles alternating', () => {
    const messages = buildCanvasChatDetailsPayload({
      document: PARTS_DOCUMENT,
      grounding: 'Campaign: Ember',
      instruction: 'tighten it',
      history: [],
      requestedReply: '<request><name>Keeper Ilse</name></request>',
      details: '### Keeper Ilse — NPC · owned by this module\nHP 41',
    });
    expect(messages.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(messages[3]?.content).toContain('HP 41');
    expect(messages[3]?.content).toContain('Instruction: The app answered your <request> blocks');
  });

  it('a request turn stored as two assistant messages gets the app turn between them', () => {
    const messages = buildCanvasChatPayload({
      document: PARTS_DOCUMENT,
      grounding: 'Campaign: Ember',
      instruction: 'next',
      history: [
        { role: 'user', text: 'tighten it' },
        { role: 'assistant', text: '<request><name>Keeper Ilse</name></request>' },
        { role: 'assistant', text: 'Done — the edit landed.' },
      ],
    });
    expect(messages.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'user', 'assistant', 'user']);
    expect(messages[3]?.content).toContain('the app answered the <request> blocks');
    expect(messages[4]?.content).toBe('Done — the edit landed.');
  });

  it('canvasChatTurnContent stays byte-identical without a details block', () => {
    const base = canvasChatTurnContent({ document: 'DOC', grounding: 'GROUND', instruction: 'go' });
    const withUndefined = canvasChatTurnContent({
      document: 'DOC',
      grounding: 'GROUND',
      instruction: 'go',
      details: undefined,
    });
    expect(withUndefined).toBe(base);
    expect(base).toBe(
      [
        'Module parts document — the CURRENT state, including all previously applied edits:',
        '<document>',
        'DOC',
        '</document>',
        '',
        'REFERENCE-ONLY CONTEXT — continuity material. NEVER edit it and never emit edit commands against it; commands apply to the current module\'s parts document above:',
        '<reference-only>',
        'GROUND',
        '</reference-only>',
        '',
        'Instruction: go',
      ].join('\n'),
    );
    expect(base).not.toContain('<requested-details>');
  });

  it('renderArtifactDetails is pure and deterministic', async () => {
    const pool = await listArtifactsByCampaign(world.campaignId);
    const encounter = pool.find((artifact) => artifact.id === world.encounterId);
    if (encounter === undefined) throw new Error('unreachable');
    const extras = { byId: new Map(pool.map((artifact) => [artifact.id, artifact] as const)) };
    const once = renderArtifactDetails({ artifact: encounter, requestedName: 'Salt Gate Ambush', moduleId: world.moduleId, extras });
    const twice = renderArtifactDetails({ artifact: encounter, requestedName: 'Salt Gate Ambush', moduleId: world.moduleId, extras });
    expect(once).toBe(twice);
    expect(once.startsWith('### Salt Gate Ambush — Encounter · owned by this module')).toBe(true);
  });
});
