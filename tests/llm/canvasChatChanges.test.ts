import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CANVAS_CHAT_CHANGES_INSTRUCTION,
  CANVAS_CHAT_DETAILS_INSTRUCTION,
  CHANGE_RESULTS_HEADER,
  MAX_CHANGES_PER_REPLY,
  CanvasChatParseError,
  canvasChatFollowUpTurnContent,
  canvasChatSystemPrompt,
  isArtifactChange,
  parseCanvasChatReply,
  renderChangeResults,
  sendCanvasChatMessage,
  type CanvasChatChangeCommand,
  type CanvasChatChangeExecutor,
  type CanvasChatChangeOutcome,
  type CanvasChatTurnInput,
  type CanvasChatTurnResult,
} from '@/llm/canvasChat';
import {
  assembleModulePartsDocument,
  createModule,
  encounterDataSchema,
  modulePartSchema,
  moduleSpineSchema,
  npcDataSchema,
  type Id,
} from '@/domain';
import { createCampaign } from '@/db/campaignRepo';
import { getModule, saveModule } from '@/db/moduleRepo';
import { listModuleVersions } from '@/db/moduleVersionRepo';
import { createArtifact, getAnyArtifact } from '@/db/artifactRepo';
import { db } from '@/db/db';
import { executeChatChange, reportChatChangeOutcome } from '@/features/modules/canvas/chatChanges';
import { stringChatHandle } from '@/features/modules/canvas/chatApply';
import {
  PREVIEW_TURN_SURFACE,
  runCanvasChatTurn,
} from '@/features/modules/canvas/chatTurn';
import {
  canvasChatKey,
  useCanvasChatStore,
} from '@/features/modules/canvas/chatStore';
import { saveWholeModuleDocument } from '@/features/modules/canvas/saveDoc';
import { flushChatPersist } from '@/features/modules/canvas/chatPersist';
import { splitPartsDocument } from '@/domain/modulePartsDocument';
import { schemaNameOf } from '../helpers/chatSchemaName';
import { CODE, filesWith } from '../helpers/sourceCode';
import type {
  ChangeArtifactRequest,
  ChangeArtifactResult,
} from '@/features/modules/change-artifact';
import type { EncounterRegenOptions } from '@/features/campaign/encounterRegen';
import type { EntityBatchResult, RunEntityBatchInput } from '@/features/modules/entity-batch';
import {
  claimModuleGeneration,
  isModuleGenerationClaimed,
  releaseModuleGeneration,
} from '@/llm/canvasBusy';
import { useProgressStore } from '@/lib/progress';
import { clearDatabase } from '../db/helpers';
import { producedEntityResult as produced } from '../helpers/entityRunFixtures';

/**
 * The WRITE HALF of the canvas chat (docs/17 ledger row 104, docs/18 §2.2). The
 * owner's words, verbatim: *"That would also need an ability for the LLM to
 * actually change those details."*
 *
 * What is pinned here:
 *  - `<change>` is parsed by the SAME strict extractor with the same loudness
 *    (malformed / unknown-attributed / over-cap fails the WHOLE reply, and
 *    nothing is executed);
 *  - a change runs through the ONE `changeArtifact` seam with the resolved row's
 *    id, the instruction and (for an encounter) the operation the model named —
 *    and the chat path writes NO row of its own;
 *  - an encounter change with no operation is refused BY NAME (never defaulted),
 *    an ambiguous name is refused with the resolver's own candidates (never
 *    guessed), and a held module slot is a NAMED busy outcome;
 *  - changes run SEQUENTIALLY with the module slot handed to the specialist, one
 *    at a time, bounded by the cap;
 *  - an abort stops the phase at a change boundary and the pending change never
 *    touches its row (MEASURED: revision counts);
 *  - every outcome reaches the model in the SAME one follow-up call the read
 *    half established, and a change asked for in THAT reply is a named no-op;
 *  - a reply with no `<change>` is the byte-identical single-call turn.
 */

const { repopulateMock, regenerateMock, runEntityBatchMock, changeArtifactMock } = vi.hoisted(() => ({
  repopulateMock: vi.fn<(artifactId: Id, options: EncounterRegenOptions) => Promise<void>>(),
  regenerateMock: vi.fn<(artifactId: Id, options: EncounterRegenOptions) => Promise<void>>(),
  runEntityBatchMock: vi.fn<(input: RunEntityBatchInput) => Promise<EntityBatchResult>>(),
  changeArtifactMock: vi.fn<ChangeArtifactFn>(),
}));

vi.mock('@/llm/openrouter', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  chat: vi.fn(),
}));

vi.mock('@/lib/toast', () => ({
  toastError: vi.fn(),
  toastErrorPersistent: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
  toastAction: vi.fn(),
}));

vi.mock('@/features/campaign/encounterRegen', () => ({
  repopulateEncounter: repopulateMock,
  regenerateEncounterEverything: regenerateMock,
}));

vi.mock('@/features/modules/entity-batch', () => ({
  runEntityBatch: runEntityBatchMock,
}));

/**
 * The seam is SPY-wrapped, not replaced: the real routing runs (so the route is
 * the resolved row's own kind), while the call itself is observable. That is the
 * pin that "the chat changes an artifact THROUGH the seam" — a chat that wrote a
 * row itself would leave this spy uncalled.
 */
/** The seam's callable type, so the spy's calls are TYPED (no `any`). */
type ChangeArtifactFn = (request: ChangeArtifactRequest) => Promise<ChangeArtifactResult>;

vi.mock('@/features/modules/change-artifact', async (importOriginal) => ({
  ...(await importOriginal<{ changeArtifact: ChangeArtifactFn }>()),
  changeArtifact: changeArtifactMock,
}));

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);
const { toastError, toastSuccess } = await import('@/lib/toast');
const toastErrorMock = vi.mocked(toastError);
const toastSuccessMock = vi.mocked(toastSuccess);

const PART_0 = '## The Gate Bargain\n\nThe party bargains with [[Keeper Ilse]] at the [[Salt Gate Ambush]].';
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

let world: { campaignId: Id; moduleId: Id; encounterId: Id; npcId: Id; secondNpcId: Id } = {
  campaignId: '',
  moduleId: '',
  encounterId: '',
  npcId: '',
  secondNpcId: '',
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
    summary: 'The keeper of the drowned gate.',
    body: '# Ilse\nShe keeps the gate.',
    data: npcDataSchema.parse({ appearance: 'Salt-crusted coat.', personality: 'Patient.', statBlock: null }),
  });
  const secondNpc = await createArtifact({
    campaignId: campaign.id,
    moduleId: draft.id,
    kind: 'npc',
    name: 'Halmund the Smith',
    summary: 'The smith.',
    body: 'He works the forge.',
    data: npcDataSchema.parse({ appearance: 'Soot.', personality: 'Blunt.', statBlock: null }),
  });
  const encounter = await createArtifact({
    campaignId: campaign.id,
    moduleId: draft.id,
    kind: 'encounter',
    name: 'Salt Gate Ambush',
    summary: 'Four goblins hold the flooded gate.',
    body: 'The gate fight happens at high tide.',
    data: encounterDataSchema.parse({
      difficulty: 'hard',
      levelHint: '', partyLevel: 3,
      terrain: 'Flooded flagstones.',
      tactics: 'They fight from the ledges.',
      treasure: 'The tide-hoard.',
      monsters: [],
      preset: 'standard',
      locationKind: 'other',
      siteShape: 'single',
      budgetAdvisory: '',
      layout: null,
    }),
  });
  world = {
    campaignId: campaign.id,
    moduleId: draft.id,
    encounterId: encounter.id,
    npcId: npc.id,
    secondNpcId: secondNpc.id,
  };
}

beforeEach(async () => {
  await clearDatabase();
  vi.clearAllMocks();
  useProgressStore.getState().reset();
  // Plain `vi.fn()` mocks keep their implementation across tests (clearAllMocks
  // clears CALLS only), so the specialists are reset explicitly.
  repopulateMock.mockReset();
  regenerateMock.mockReset();
  runEntityBatchMock.mockReset();
  repopulateMock.mockResolvedValue(undefined);
  regenerateMock.mockResolvedValue(undefined);
  // The SEAM SPY runs the REAL seam (see the factory above): the real routing,
  // the real refusals, the real busy gate.
  const actual = await vi.importActual<{ changeArtifact: ChangeArtifactFn }>(
    '@/features/modules/change-artifact',
  );
  changeArtifactMock.mockReset();
  changeArtifactMock.mockImplementation(actual.changeArtifact);
  await seed();
  // The entity lane's default: it succeeds and reports the row it filled.
  runEntityBatchMock.mockResolvedValue(produced('Keeper Ilse', world.npcId));
});

afterEach(() => {
  releaseModuleGeneration(world.moduleId);
  vi.restoreAllMocks();
});

function baseInput(overrides: Partial<CanvasChatTurnInput> = {}): CanvasChatTurnInput {
  return {
    moduleId: world.moduleId,
    document: PARTS_DOCUMENT,
    instruction: 'tighten the gate fight',
    history: [],
    turn: new AbortController(),
    executeChange: executeChatChange,
    reportChange: reportChatChangeOutcome,
    ...overrides,
  };
}

function textOf(message: { content: unknown }): string {
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
}

function payloadTextOf(callIndex: number): string {
  const messages = chatMock.mock.calls[callIndex]?.[0] ?? [];
  return messages.map((message) => textOf(message)).join('\n\n===MESSAGE===\n\n');
}

function rolesOf(callIndex: number): (string | undefined)[] {
  return (chatMock.mock.calls[callIndex]?.[0] ?? []).map((message) => message.role);
}

function changeBlockOf(result: CanvasChatTurnResult): string {
  if (result.changes === null) throw new Error('expected a change round trip');
  return result.changes.block;
}

async function revisionCount(artifactId: Id): Promise<number> {
  return db.revisions.where('artifactId').equals(artifactId).count();
}

async function rowBytes(artifactId: Id): Promise<string> {
  return JSON.stringify(await getAnyArtifact(artifactId));
}

/** What the seam's entity lane returns when it succeeded. `cast: []` — this
 * change ran a persona draft, never the module-side bestiary cast (docs/17 row
 * 107). */
function changeReply(...changes: string[]): string {
  return ['On it.', ...changes].join('\n');
}

function changeOf(name: string, instruction: string, operation?: 'repopulate' | 'everything'): string {
  const attribute = operation === undefined ? '' : ` operation="${operation}"`;
  return `<change${attribute}><name>${name}</name><instruction>${instruction}</instruction></change>`;
}


/** The name of an artifact change (these tests drive the artifact half only). */
function nameOf(change: CanvasChatChangeCommand): string {
  return isArtifactChange(change) ? change.name : 'adversarial';
}

/** A stub executor that records the ORDER and the CONCURRENCY of the calls. */
function sequencingExecutor(events: string[], behavior?: (change: CanvasChatChangeCommand) => void) {
  let inFlight = 0;
  const executor: CanvasChatChangeExecutor = vi.fn(async (change: CanvasChatChangeCommand) => {
    inFlight += 1;
    events.push(`start:${nameOf(change)}:${String(inFlight)}`);
    behavior?.(change);
    await new Promise((resolve) => setTimeout(resolve, 5));
    events.push(`end:${nameOf(change)}`);
    inFlight -= 1;
    return { status: 'changed' as const, artifactId: world.npcId, kind: 'npc' as const, detail: 'done' };
  });
  return executor;
}

describe('<change> parsing (the SAME strict extractor)', () => {
  it('parses a change block with its operation, and leaves edits and requests alone', () => {
    const parsed = parseCanvasChatReply(
      [
        'I will restock the vault.',
        '<change operation="repopulate"><name>Salt Gate Ambush</name><instruction>fewer goblins, deeper water</instruction></change>',
        '<request><name>Keeper Ilse</name></request>',
        '<edit><search>fog</search><replace>mist</replace></edit>',
      ].join('\n'),
    );
    expect(parsed.changes).toEqual([
      { name: 'Salt Gate Ambush', instruction: 'fewer goblins, deeper water', operation: 'repopulate' },
    ]);
    expect(parsed.requests).toEqual([{ name: 'Keeper Ilse' }]);
    expect(parsed.commands).toEqual([{ search: 'fog', replace: 'mist', all: false }]);
    expect(parsed.prose).toContain('I will restock the vault');
    expect(parsed.prose).not.toContain('<change');
  });

  it('parses a change with NO operation — whether it is REQUIRED depends on the resolved row, not the syntax', () => {
    const parsed = parseCanvasChatReply(changeOf('Keeper Ilse', 'make her the smith\'s sister'));
    expect(parsed.changes).toEqual([{ name: 'Keeper Ilse', instruction: "make her the smith's sister" }]);
  });

  it('finds a change that sits BEFORE an edit (all three tags scan in ONE walk)', () => {
    const parsed = parseCanvasChatReply(
      `${changeOf('Keeper Ilse', 'age her twenty years')}\n<edit><search>a</search><replace>b</replace></edit>`,
    );
    expect(parsed.changes).toHaveLength(1);
    expect(parsed.commands).toHaveLength(1);
    // The block is NOT swallowed into prose (a scanner that only knew the
    // earlier tags would have left the whole block there).
    expect(parsed.prose).toBe('');
  });

  it('trims the name and the instruction, and accepts several changes in one reply', () => {
    const parsed = parseCanvasChatReply(
      `<change operation="everything"><name>  Salt Gate Ambush  </name><instruction>\n rebuild it \n</instruction></change>${changeOf('Keeper Ilse', '  soften her  ')}`,
    );
    expect(parsed.changes).toEqual([
      { name: 'Salt Gate Ambush', instruction: 'rebuild it', operation: 'everything' },
      { name: 'Keeper Ilse', instruction: 'soften her' },
    ]);
  });

  it('fails the WHOLE reply on anything malformed', () => {
    const cases: [string, string][] = [
      ['an unknown attribute', '<change when="now"><name>x</name><instruction>y</instruction></change>'],
      ['a missing operation value', '<change operation><name>x</name><instruction>y</instruction></change>'],
      ['an unquoted operation value', '<change operation=repopulate><name>x</name><instruction>y</instruction></change>'],
      ['an invented operation', '<change operation="refresh"><name>x</name><instruction>y</instruction></change>'],
      ['a duplicated operation', '<change operation="repopulate" operation="everything"><name>x</name><instruction>y</instruction></change>'],
      ['a self-closing tag', '<change/>'],
      ['a spaced self-closing tag', '<change />'],
      ['a name first, instruction second, then a THIRD child', '<change><name>x</name><instruction>y</instruction><operation>z</operation></change>'],
      ['the instruction BEFORE the name', '<change><instruction>y</instruction><name>x</name></change>'],
      ['a missing instruction', '<change><name>x</name></change>'],
      ['an EMPTY instruction', '<change><name>x</name><instruction>   </instruction></change>'],
      ['an empty name', '<change><name></name><instruction>y</instruction></change>'],
      ['an unterminated block', '<change><name>x</name><instruction>y</instruction>'],
      ['a stray closing tag', 'prose </change> more prose'],
    ];
    for (const [what, raw] of cases) {
      expect(() => parseCanvasChatReply(raw), what).toThrow(CanvasChatParseError);
    }
  });

  it('the cap fails the reply BEFORE anything runs (no partial execution)', async () => {
    const raw = changeReply(
      changeOf('Keeper Ilse', 'a'),
      changeOf('Halmund the Smith', 'b'),
      changeOf('Salt Gate Ambush', 'c', 'repopulate'),
      changeOf('Keeper Ilse', 'd'),
    );
    expect(() => parseCanvasChatReply(raw)).toThrow(/more than 3 change requests/);
    chatMock.mockResolvedValue({ text: raw, modelUsed: 'm', fallback: null });
    await expect(sendCanvasChatMessage(baseInput())).rejects.toThrow(CanvasChatParseError);
    expect(chatMock).toHaveBeenCalledTimes(1);
    expect(changeArtifactMock).not.toHaveBeenCalled();
    expect(repopulateMock).not.toHaveBeenCalled();
    expect(runEntityBatchMock).not.toHaveBeenCalled();
    expect(MAX_CHANGES_PER_REPLY).toBe(3);
  });
});

describe('a change goes THROUGH the seam (never a row write of its own)', () => {
  it('an encounter change reaches changeArtifact with the resolved id, the instruction and the operation', async () => {
    const before = await rowBytes(world.encounterId);
    const revisionsBefore = await revisionCount(world.encounterId);
    chatMock
      .mockResolvedValueOnce({
        text: changeReply(
          changeOf('Salt Gate Ambush', 'fewer goblins, deeper water', 'repopulate'),
        ),
        modelUsed: 'first',
        fallback: null,
      })
      .mockResolvedValueOnce({ text: 'Restocked.', modelUsed: 'second', fallback: null });
    const result = await sendCanvasChatMessage(baseInput());
    expect(changeArtifactMock).toHaveBeenCalledTimes(1);
    const [request] = changeArtifactMock.mock.calls[0] ?? [];
    expect(request).toMatchObject({
      artifactId: world.encounterId,
      instruction: 'fewer goblins, deeper water',
      encounter: { operation: 'repopulate' },
    });
    // The specialist is reached (the mock) — and the call the seam made is the
    // REPOPULATE one, not the destructive default.
    expect(repopulateMock).toHaveBeenCalledTimes(1);
    expect(regenerateMock).not.toHaveBeenCalled();
    expect(changeBlockOf(result)).toContain('### Change «Salt Gate Ambush» — APPLIED');
    // Nothing on the CHAT path wrote the row: the mocked specialist writes
    // nothing, so the row and its revisions are byte-identical.
    expect(await rowBytes(world.encounterId)).toBe(before);
    expect(await revisionCount(world.encounterId)).toBe(revisionsBefore);
  });

  it('an entity change passes NO encounter options (the seam would refuse a mismatch)', async () => {
    chatMock
      .mockResolvedValueOnce({
        text: changeReply(changeOf('Keeper Ilse', 'make her the smith\'s sister')),
        modelUsed: 'first',
        fallback: null,
      })
      .mockResolvedValueOnce({ text: 'Done.', modelUsed: 'second', fallback: null });
    runEntityBatchMock.mockResolvedValue(produced('Keeper Ilse', world.npcId));
    await sendCanvasChatMessage(baseInput());
    const [request] = changeArtifactMock.mock.calls[0] ?? [];
    expect(request?.artifactId).toBe(world.npcId);
    expect(request?.instruction).toBe("make her the smith's sister");
    expect(request).not.toHaveProperty('encounter');
    expect(runEntityBatchMock).toHaveBeenCalledTimes(1);
    expect(repopulateMock).not.toHaveBeenCalled();
  });

  it('an ENCOUNTER change with no operation is refused BY NAME — never defaulted', async () => {
    const before = await rowBytes(world.encounterId);
    const revisionsBefore = await revisionCount(world.encounterId);
    chatMock
      .mockResolvedValueOnce({
        text: changeReply(changeOf('Salt Gate Ambush', 'make it harder')),
        modelUsed: 'first',
        fallback: null,
      })
      .mockResolvedValueOnce({ text: 'Understood.', modelUsed: 'second', fallback: null });
    const result = await sendCanvasChatMessage(baseInput());
    // The seam was never called: no operation, no change, no guess.
    expect(changeArtifactMock).not.toHaveBeenCalled();
    expect(repopulateMock).not.toHaveBeenCalled();
    expect(regenerateMock).not.toHaveBeenCalled();
    const block = changeBlockOf(result);
    expect(block).toContain('### Change «Salt Gate Ambush» — NOT APPLIED: REFUSED');
    expect(block).toContain('"repopulate"');
    expect(block).toContain('"everything"');
    expect(block).toContain('There is NO default');
    // Nothing moved.
    expect(await rowBytes(world.encounterId)).toBe(before);
    expect(await revisionCount(world.encounterId)).toBe(revisionsBefore);
    // The owner was told it did NOT happen (never a success notice).
    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(toastErrorMock.mock.calls[0]?.[0]).toContain('did NOT change');
  });

  it('an operation on a NON-encounter is refused by name (the seam would call it a programming error)', async () => {
    chatMock
      .mockResolvedValueOnce({
        text: changeReply(changeOf('Keeper Ilse', 'rebuild everything', 'everything')),
        modelUsed: 'first',
        fallback: null,
      })
      .mockResolvedValueOnce({ text: 'Understood.', modelUsed: 'second', fallback: null });
    const result = await sendCanvasChatMessage(baseInput());
    expect(changeArtifactMock).not.toHaveBeenCalled();
    const block = changeBlockOf(result);
    expect(block).toContain('### Change «Keeper Ilse» — NOT APPLIED: REFUSED');
    expect(block).toContain('apply to encounters only');
  });

  it('an ambiguous name is refused with the RESOLVER\'S OWN candidates, and nothing is called', async () => {
    // Two rows in the SAME scope tier (both campaign-level), so the resolver
    // cannot pick one: the app must never guess which row to REWRITE.
    await createArtifact({
      campaignId: world.campaignId,
      kind: 'note',
      name: 'Ash Gate',
      summary: 'The older note.',
      body: 'older',
    });
    await createArtifact({
      campaignId: world.campaignId,
      kind: 'note',
      name: 'Ash Gate',
      summary: 'The newer note.',
      body: 'newer',
    });
    const revisionsBefore = await db.revisions.count();
    chatMock
      .mockResolvedValueOnce({
        text: changeReply(changeOf('Ash Gate', 'rewrite the sign')),
        modelUsed: 'first',
        fallback: null,
      })
      .mockResolvedValueOnce({ text: 'Which one?', modelUsed: 'second', fallback: null });
    const result = await sendCanvasChatMessage(baseInput());
    expect(changeArtifactMock).not.toHaveBeenCalled();
    const block = changeBlockOf(result);
    expect(block).toContain('### Change «Ash Gate» — NOT APPLIED: AMBIGUOUS NAME');
    expect(block).toContain('2 stored artifacts match «Ash Gate»');
    expect(block).toContain('newest first');
    // Both candidates are named, with their kinds — the chips' own list.
    expect(block.match(/«Ash Gate» \(Note/g)).toHaveLength(2);
    expect(await db.revisions.count()).toBe(revisionsBefore);
  });

  it('a name that resolves to nothing is refused by name, and nothing is called', async () => {
    chatMock
      .mockResolvedValueOnce({
        text: changeReply(changeOf('Nobody At All', 'change it')),
        modelUsed: 'first',
        fallback: null,
      })
      .mockResolvedValueOnce({ text: 'No such row.', modelUsed: 'second', fallback: null });
    const result = await sendCanvasChatMessage(baseInput());
    expect(changeArtifactMock).not.toHaveBeenCalled();
    const block = changeBlockOf(result);
    expect(block).toContain('### Change «Nobody At All» — NOT APPLIED: NO SUCH ARTIFACT');
    expect(block).toContain('no artifact in this campaign or the shared library is named «Nobody At All»');
  });

  it('the seam\'s own arms ride through unchanged (unsupported kinds never read as success)', async () => {
    const pc = await createArtifact({
      campaignId: world.campaignId,
      moduleId: world.moduleId,
      kind: 'pc',
      name: 'Bryn',
      summary: 's',
      body: 'b',
    });
    chatMock
      .mockResolvedValueOnce({
        text: changeReply(changeOf('Bryn', 'make her a paladin')),
        modelUsed: 'first',
        fallback: null,
      })
      .mockResolvedValueOnce({ text: 'That one is authored.', modelUsed: 'second', fallback: null });
    const result = await sendCanvasChatMessage(baseInput());
    expect(changeArtifactMock).toHaveBeenCalledTimes(1);
    const block = changeBlockOf(result);
    expect(block).toContain('### Change «Bryn» — NOT APPLIED: NO ENGINE FOR THIS KIND');
    expect(block).toContain('authored, not generated');
    expect(repopulateMock).not.toHaveBeenCalled();
    expect(runEntityBatchMock).not.toHaveBeenCalled();
    expect(await revisionCount(pc.id)).toBe(1);
  });
});

describe('sequential, capped, abortable — and honest about the module slot', () => {
  it('runs the changes ONE AT A TIME, in reply order, with the slot handed over', async () => {
    const events: string[] = [];
    const slots: boolean[] = [];
    const executor = sequencingExecutor(events, () => {
      // The specialist must find the module's generation slot FREE: the chat
      // turn handed it over (a nested claim would be an immediate
      // ModuleBusyError and no change would ever run).
      slots.push(isModuleGenerationClaimed(world.moduleId));
    });
    chatMock
      .mockResolvedValueOnce({
        text: changeReply(
          changeOf('Keeper Ilse', 'a'),
          changeOf('Halmund the Smith', 'b'),
        ),
        modelUsed: 'first',
        fallback: null,
      })
      .mockResolvedValueOnce({ text: 'Both done.', modelUsed: 'second', fallback: null });
    const result = await sendCanvasChatMessage(baseInput({ executeChange: executor }));
    expect(events).toEqual([
      'start:Keeper Ilse:1',
      'end:Keeper Ilse',
      'start:Halmund the Smith:1',
      'end:Halmund the Smith',
    ]);
    expect(slots).toEqual([false, false]);
    expect(result.changes?.status).toBe('ok');
    if (result.changes?.status !== 'ok') throw new Error('expected served changes');
    expect(result.changes.outcomes.map((outcome) => nameOf(outcome.change))).toEqual([
      'Keeper Ilse',
      'Halmund the Smith',
    ]);
    // The turn released everything it took.
    expect(isModuleGenerationClaimed(world.moduleId)).toBe(false);
  });

  it('a specialist FAILURE is a named outcome the model reads, and the NEXT change still runs', async () => {
    const executor = vi.fn<CanvasChatChangeExecutor>((change: CanvasChatChangeCommand) => {
      if (nameOf(change) === 'Keeper Ilse') throw new Error('the run produced no artifact');
      return Promise.resolve({
        status: 'changed',
        artifactId: world.secondNpcId,
        kind: 'npc',
        detail: 'done',
      });
    });
    chatMock
      .mockResolvedValueOnce({
        text: changeReply(changeOf('Keeper Ilse', 'a'), changeOf('Halmund the Smith', 'b')),
        modelUsed: 'first',
        fallback: null,
      })
      .mockResolvedValueOnce({ text: 'One of them failed.', modelUsed: 'second', fallback: null });
    const result = await sendCanvasChatMessage(baseInput({ executeChange: executor }));
    if (result.changes?.status !== 'ok') throw new Error('expected served changes');
    expect(result.changes.outcomes.map((outcome) => outcome.status)).toEqual(['failed', 'changed']);
    expect(executor).toHaveBeenCalledTimes(2);
    const block = result.changes.block;
    expect(block).toContain('### Change «Keeper Ilse» — NOT APPLIED: FAILED');
    expect(block).toContain('the run produced no artifact');
    expect(block).toContain('### Change «Halmund the Smith» — APPLIED');
    // A failure is LOUD to the owner, never a success notice.
    expect(toastSuccessMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock.mock.calls[0]?.[0]).toContain('FAILED');
  });

  it('a module slot held by ANOTHER generation is a NAMED busy outcome (and the real seam says busy too)', async () => {
    // (a) The feature executor's own path: a foreign claim on the module makes
    // the seam throw its ModuleBusyError — which becomes a named outcome.
    claimModuleGeneration(world.moduleId);
    const busy = await executeChatChange(
      { name: 'Keeper Ilse', instruction: 'x' },
      {
        moduleId: world.moduleId,
        campaignId: world.campaignId,
        pool: await poolOf(),
        signal: new AbortController().signal,
        parts: [],
      },
    );
    expect(busy.status).toBe('busy');
    expect(busy.detail).toContain('single generation slot');
    expect(repopulateMock).not.toHaveBeenCalled();
    expect(runEntityBatchMock).not.toHaveBeenCalled();
    releaseModuleGeneration(world.moduleId);

    // (b) …and it is relayed to the model in the follow-up block.
    const executor = vi.fn<CanvasChatChangeExecutor>(() =>
      Promise.resolve({
        status: 'busy' as const,
        artifactId: world.npcId,
        kind: 'npc' as const,
        detail: 'the module is already generating',
      }),
    );
    chatMock
      .mockResolvedValueOnce({ text: changeReply(changeOf('Keeper Ilse', 'x')), modelUsed: 'first', fallback: null })
      .mockResolvedValueOnce({ text: 'I will wait.', modelUsed: 'second', fallback: null });
    const result = await sendCanvasChatMessage(baseInput({ executeChange: executor }));
    expect(changeBlockOf(result)).toContain('### Change «Keeper Ilse» — NOT APPLIED: MODULE BUSY');
    expect(payloadTextOf(1)).toContain('the module is already generating');
  });

  it('an abort at a change BOUNDARY starts nothing further and leaves the pending row untouched (MEASURED)', async () => {
    const turn = new AbortController();
    const npcBefore = await rowBytes(world.npcId);
    const secondBefore = await rowBytes(world.secondNpcId);
    const npcRevisions = await revisionCount(world.npcId);
    const secondRevisions = await revisionCount(world.secondNpcId);
    // The FIRST change really lands (the mocked specialist writes a revision
    // exactly the way the engine's finalize does) and then the user stops.
    runEntityBatchMock.mockImplementation(async (input: RunEntityBatchInput) => {
      const artifactId = input.targets[0]?.artifactId;
      if (artifactId === undefined) throw new Error('expected an in-place target');
      const row = await getAnyArtifact(artifactId);
      if (row === undefined) throw new Error('missing row');
      const { updateArtifact } = await import('@/db/artifactRepo');
      await updateArtifact(artifactId, { summary: 'restocked by the specialist' });
      turn.abort();
      return produced('Keeper Ilse', artifactId);
    });
    chatMock.mockResolvedValueOnce({
      text: changeReply(changeOf('Keeper Ilse', 'a'), changeOf('Halmund the Smith', 'b')),
      modelUsed: 'first',
      fallback: null,
    });
    await expect(sendCanvasChatMessage(baseInput({ turn }))).rejects.toThrow(/Aborted/);
    // The first change ran and is measured as a real write…
    expect(runEntityBatchMock).toHaveBeenCalledTimes(1);
    // …the seam was ENTERED exactly once — the stop is checked BEFORE the next
    // change starts, so a stopped turn does not even open the second door.
    expect(changeArtifactMock).toHaveBeenCalledTimes(1);
    expect(await revisionCount(world.npcId)).toBe(npcRevisions + 1);
    expect(await rowBytes(world.npcId)).not.toBe(npcBefore);
    // …and the SECOND one never started: its row and revisions are untouched,
    // and no model call was made about it either (the turn stopped).
    expect(await rowBytes(world.secondNpcId)).toBe(secondBefore);
    expect(await revisionCount(world.secondNpcId)).toBe(secondRevisions);
    expect(chatMock).toHaveBeenCalledTimes(1);
    expect(isModuleGenerationClaimed(world.moduleId)).toBe(false);
  });

  it('a stub executor is never called a second time once the turn is stopped (the boundary is CHECKED)', async () => {
    const turn = new AbortController();
    const calls: string[] = [];
    const executor = vi.fn<CanvasChatChangeExecutor>((change: CanvasChatChangeCommand) => {
      calls.push(nameOf(change));
      turn.abort();
      return Promise.resolve({
        status: 'changed',
        artifactId: world.npcId,
        kind: 'npc',
        detail: 'done',
      });
    });
    chatMock.mockResolvedValueOnce({
      text: changeReply(changeOf('Keeper Ilse', 'a'), changeOf('Halmund the Smith', 'b')),
      modelUsed: 'first',
      fallback: null,
    });
    await expect(sendCanvasChatMessage(baseInput({ turn, executeChange: executor }))).rejects.toThrow(/Aborted/);
    expect(calls).toEqual(['Keeper Ilse']);
  });

  it('an abort that lands DURING a change (Stop all) stops the turn and writes nothing', async () => {
    const turn = new AbortController();
    const before = await rowBytes(world.npcId);
    const revisionsBefore = await revisionCount(world.npcId);
    // A run cancelled by Stop all: the specialist's own await reports the
    // cancelled run (a stop is not an error, and the caller decides from
    // `signal.aborted` — the existing convention). The turn must let the abort
    // through, never relay it as a named change and never keep going.
    runEntityBatchMock.mockImplementation(() => {
      turn.abort();
      throw new Error('the run ended cancelled');
    });
    chatMock.mockResolvedValueOnce({
      text: changeReply(changeOf('Keeper Ilse', 'a'), changeOf('Halmund the Smith', 'b')),
      modelUsed: 'first',
      fallback: null,
    });
    await expect(sendCanvasChatMessage(baseInput({ turn }))).rejects.toThrow(/ended cancelled/);
    expect(turn.signal.aborted).toBe(true);
    expect(runEntityBatchMock).toHaveBeenCalledTimes(1);
    expect(await rowBytes(world.npcId)).toBe(before);
    expect(await revisionCount(world.npcId)).toBe(revisionsBefore);
    expect(await revisionCount(world.secondNpcId)).toBe(1);
    expect(chatMock).toHaveBeenCalledTimes(1);
    // Nothing was claimed and left behind.
    expect(isModuleGenerationClaimed(world.moduleId)).toBe(false);
  });

  it('a generation that takes the slot DURING the change phase skips the follow-up LOUDLY (outcomes stand)', async () => {
    const events: string[] = [];
    const executor = sequencingExecutor(events, () => {
      // Simulate a generation that starts while the specialist holds the slot
      // and is still running when the phase ends.
      claimModuleGeneration(world.moduleId);
    });
    chatMock.mockResolvedValueOnce({
      text: changeReply(changeOf('Keeper Ilse', 'a')),
      modelUsed: 'first',
      fallback: null,
    });
    const result = await sendCanvasChatMessage(baseInput({ executeChange: executor }));
    expect(chatMock).toHaveBeenCalledTimes(1);
    expect(result.details).toBeNull();
    if (result.changes?.status !== 'failed') throw new Error('expected a failed relay');
    expect(result.changes.outcomes).toHaveLength(1);
    expect(result.changes.error).toContain('follow-up turn could not be sent');
    expect(result.changes.error).toContain('already generating');
    // The change's own notice still reached the owner (reported as it settled).
    expect(toastSuccessMock).toHaveBeenCalledTimes(1);
  });

  it('a <change> without the executor is a LOUD throw, never a silent no-op', async () => {
    chatMock.mockResolvedValueOnce({
      text: changeReply(changeOf('Keeper Ilse', 'a')),
      modelUsed: 'first',
      fallback: null,
    });
    await expect(
      sendCanvasChatMessage(baseInput({ executeChange: undefined, reportChange: undefined })),
    ).rejects.toThrow(/without the change executor/);
    expect(changeArtifactMock).not.toHaveBeenCalled();
  });
});

describe('the outcome rides the SAME one follow-up call (never a loop)', () => {
  it('relays every outcome to the model, with the document riding exactly once', async () => {
    chatMock
      .mockResolvedValueOnce({
        text: changeReply(changeOf('Salt Gate Ambush', 'deeper water', 'repopulate')),
        modelUsed: 'first-model',
        fallback: null,
      })
      .mockResolvedValueOnce({ text: 'Roster restocked.', modelUsed: 'second-model', fallback: null });
    const result = await sendCanvasChatMessage(baseInput());
    expect(chatMock).toHaveBeenCalledTimes(2);
    expect(rolesOf(1)).toEqual(['system', 'user', 'assistant', 'user']);
    const second = payloadTextOf(1);
    expect(second).toContain(CHANGE_RESULTS_HEADER);
    expect(second).toContain('<change-results>');
    expect(second).toContain('</change-results>');
    expect(second).toContain('### Change «Salt Gate Ambush» — APPLIED');
    expect(second).toContain('asked: deeper water');
    expect(second).toContain(CANVAS_CHAT_CHANGES_INSTRUCTION);
    // The model sees its OWN change request back, and the model call the reply
    // was served by is the one recorded (provenance per call).
    const messages = chatMock.mock.calls[1]?.[0] ?? [];
    expect(messages[2]?.content).toContain('<change operation="repopulate">');
    expect(messages.filter((message) => textOf(message).includes(PART_1))).toHaveLength(1);
    if (result.details?.status !== 'ok') throw new Error('expected a served follow-up');
    expect(result.details.modelUsed).toBe('second-model');
    // A changes-only turn answered no requests, and says so.
    expect(result.details.answers).toEqual([]);
    expect(result.details.block).toBe('');
  });

  it('requests AND changes in one reply ride ONE follow-up carrying both blocks', async () => {
    chatMock
      .mockResolvedValueOnce({
        text: `Let me check.\n<request><name>Keeper Ilse</name></request>\n${changeOf('Keeper Ilse', 'soften her')}`,
        modelUsed: 'first',
        fallback: null,
      })
      .mockResolvedValueOnce({ text: 'Both handled.', modelUsed: 'second', fallback: null });
    const result = await sendCanvasChatMessage(baseInput());
    expect(chatMock).toHaveBeenCalledTimes(2);
    const second = payloadTextOf(1);
    expect(second).toContain('<requested-details>');
    expect(second).toContain('<change-results>');
    expect(second).toContain(CANVAS_CHAT_DETAILS_INSTRUCTION);
    expect(second).toContain(CANVAS_CHAT_CHANGES_INSTRUCTION);
    // The details were read BEFORE the change ran (its header says it is a
    // snapshot the rows may move under) and both answers are in the result.
    if (result.details?.status !== 'ok') throw new Error('expected a served follow-up');
    expect(result.details.answers[0]?.status).toBe('answered');
    expect(result.changes?.outcomes).toHaveLength(1);
  });

  it('a change asked for in the FOLLOW-UP reply is a named no-op (no third call, nothing executed)', async () => {
    chatMock
      .mockResolvedValueOnce({
        text: changeReply(changeOf('Keeper Ilse', 'soften her')),
        modelUsed: 'first',
        fallback: null,
      })
      .mockResolvedValueOnce({
        text: `Now this one too.\n${changeOf('Halmund the Smith', 'make him older')}`,
        modelUsed: 'second',
        fallback: null,
      });
    const result = await sendCanvasChatMessage(baseInput());
    expect(chatMock).toHaveBeenCalledTimes(2);
    expect(changeArtifactMock).toHaveBeenCalledTimes(1);
    if (result.changes?.status !== 'ok') throw new Error('expected served changes');
    expect(result.changes.ignoredChanges).toEqual([
      { name: 'Halmund the Smith', instruction: 'make him older' },
    ]);
    expect(changeArtifactMock.mock.calls[0]?.[0]?.artifactId).toBe(world.npcId);
  });

  it('a failed follow-up call keeps the outcomes and says the results did not reach the model', async () => {
    chatMock
      .mockResolvedValueOnce({ text: changeReply(changeOf('Keeper Ilse', 'a')), modelUsed: 'first', fallback: null })
      .mockRejectedValueOnce(new Error('upstream 503'));
    const result = await sendCanvasChatMessage(baseInput());
    expect(result.details?.status).toBe('failed');
    if (result.changes?.status !== 'failed') throw new Error('expected a failed change report');
    expect(result.changes.outcomes).toHaveLength(1);
    expect(result.changes.error).toBe('upstream 503');
    expect(result.changes.block).toContain('### Change «Keeper Ilse» — APPLIED');
  });

  it('the change-results block names a NOT APPLIED verdict for every non-changing status', () => {
    const outcomes: CanvasChatChangeOutcome[] = [
      { change: { name: 'A', instruction: 'i' }, status: 'refused', artifactId: null, kind: null, detail: 'd1' },
      { change: { name: 'B', instruction: 'i' }, status: 'unsupported', artifactId: null, kind: null, detail: 'd2' },
      { change: { name: 'C', instruction: 'i' }, status: 'unresolved', artifactId: null, kind: null, detail: 'd3' },
      { change: { name: 'D', instruction: 'i' }, status: 'ambiguous', artifactId: null, kind: null, detail: 'd4' },
      { change: { name: 'E', instruction: 'i' }, status: 'busy', artifactId: null, kind: null, detail: 'd5' },
      { change: { name: 'F', instruction: 'i' }, status: 'failed', artifactId: null, kind: null, detail: 'd6' },
    ];
    const block = renderChangeResults(outcomes);
    for (const line of block.split('\n')) {
      if (!line.startsWith('### ')) continue;
      const isApplied = line.endsWith('— APPLIED');
      expect(isApplied).toBe(false);
      expect(line).toContain('NOT APPLIED');
    }
    expect(block).toContain('NOT APPLIED: NO ENGINE FOR THIS KIND');
    expect(block).toContain('NOT APPLIED: MODULE BUSY');
  });
});

describe('unused replies are UNCHANGED (byte-for-byte)', () => {
  it('a reply with no change is the plain single-call turn it always was', async () => {
    const raw = 'Tightened.\n<edit><search>fog</search><replace>mist</replace></edit>';
    chatMock.mockResolvedValue({ text: raw, modelUsed: 'served-by', fallback: null });
    const result = await sendCanvasChatMessage(baseInput());
    expect(chatMock).toHaveBeenCalledTimes(1);
    expect(result.details).toBeNull();
    expect(result.changes).toBeNull();
    expect(result.raw).toBe(raw);
    expect(result.parse.changes).toEqual([]);
    const [messages] = chatMock.mock.calls[0] ?? [];
    const last = messages?.[messages.length - 1];
    expect(last?.role).toBe('user');
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

  it('the follow-up turn content is byte-identical to the details-only form when no change block rides', () => {
    const detailsOnly = canvasChatFollowUpTurnContent({ details: 'ROW' });
    expect(detailsOnly).toContain('<requested-details>');
    expect(detailsOnly).not.toContain('<change-results>');
    expect(detailsOnly.endsWith(`Instruction: ${CANVAS_CHAT_DETAILS_INSTRUCTION}`)).toBe(true);
  });

  it('the system prompt states the change capability (a capability the model was never told about is not one)', () => {
    const prompt = canvasChatSystemPrompt();
    expect(prompt).toContain('<change operation="repopulate|everything">');
    expect(prompt).toContain('operation is REQUIRED for an encounter');
    expect(prompt).toContain('At most 3 change blocks per reply');
    expect(prompt).toContain('do not send another <change>');
  });
});

describe('the owner is told what happened (AGENTS 2)', () => {
  it('a changed outcome is a SUCCESS notice naming the artifact, the operation and the instruction', () => {
    reportChatChangeOutcome({
      change: { name: 'Salt Gate Ambush', instruction: 'deeper water', operation: 'repopulate' },
      status: 'changed',
      artifactId: world.encounterId,
      kind: 'encounter',
      detail: 'repopulate — a new roster was generated for every room',
    });
    expect(toastErrorMock).not.toHaveBeenCalled();
    const [copy] = toastSuccessMock.mock.calls[0] ?? [];
    expect(copy).toContain('«Salt Gate Ambush»');
    expect(copy).toContain('an encounter');
    expect(copy).toContain('a new roster was generated for every room');
    expect(copy).toContain('deeper water');
  });

  it('every non-changing status is a LOUD error (never a success look)', () => {
    const statuses = ['refused', 'unsupported', 'unresolved', 'ambiguous', 'busy', 'failed'] as const;
    for (const status of statuses) {
      toastErrorMock.mockClear();
      toastSuccessMock.mockClear();
      reportChatChangeOutcome({
        change: { name: 'Keeper Ilse', instruction: 'soften her' },
        status,
        artifactId: world.npcId,
        kind: 'npc',
        detail: `reason for ${status}`,
      });
      expect(toastSuccessMock, status).not.toHaveBeenCalled();
      const [copy] = toastErrorMock.mock.calls[0] ?? [];
      expect(copy, status).toContain('«Keeper Ilse»');
      expect(copy, status).toContain(`reason for ${status}`);
      expect(copy, status).toContain('soften her');
      if (status === 'failed') {
        expect(copy).toContain('FAILED');
        expect(copy).toContain('before assuming either way');
      } else {
        expect(copy).toContain('did NOT change');
      }
    }
  });
});

/** The chips' pool, read the way the turn reads it. */
async function poolOf() {
  const { loadChatDetailsPool } = await import('@/llm/canvasChat');
  return loadChatDetailsPool(world.campaignId);
}

// --- the adversarial review from the chat (docs/17 row 360) ---------------------
//
// The owner's requirement, verbatim: *"This step can be automated to run once,
// but it should also be triggerable in the module chat."* What is pinned: the
// command parses (and a malformed one is refused LOUDLY), the executor calls the
// ONE pass with the RIGHT target, the CRITIQUE FINDINGS render with the edit, an
// empty critique writes nothing and says so, an accepted edit lands through the
// existing seams and is undoable from the version stack (premise included), and
// a failed pass surfaces loudly without touching the module.

const ADVERSARIAL_ISSUE = {
  kind: 'inconsistency',
  severity: 'major',
  message: 'The vault is north of the gate here and south of it later.',
  where: 'second paragraph',
};

/** The transport the PASS uses: a critique reply, then an editor reply. */
function mockPass(issues: unknown, replacement = 'The reviewed text, rewritten.'): void {
  chatMock.mockReset();
  chatMock.mockImplementation((_messages, opts) => {
    if (schemaNameOf(opts) === 'adversarial-critique') {
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

function adversarialChangeOf(target: 'premise' | number): CanvasChatChangeCommand {
  return target === 'premise'
    ? { adversarial: { kind: 'premise' } }
    : { adversarial: { kind: 'part', planIndex: target } };
}

/** The context the TURN hands the executor — including the live per-part
 * snapshot (the SAME split the engine makes of the editor doc). */
function adversarialContext() {
  return {
    moduleId: world.moduleId,
    campaignId: world.campaignId,
    pool: [] as const,
    signal: new AbortController().signal,
    parts: splitPartsDocument(PARTS_DOCUMENT, PART_PLAN),
  };
}

describe('the adversarial <change> is parsed by the SAME strict extractor (docs/17 row 360)', () => {
  it('parses the premise form and the numbered-part form', () => {
    const parsed = parseCanvasChatReply(
      ['Sure.', '<change adversarial="premise"></change>', '<change adversarial="part" part="2"></change>'].join(
        '\n',
      ),
    );
    expect(parsed.changes).toEqual([
      { adversarial: { kind: 'premise' } },
      { adversarial: { kind: 'part', planIndex: 1 } },
    ]);
    expect(parsed.prose).toBe('Sure.');
  });

  it('refuses every malformed adversarial form LOUDLY, and nothing is executed', () => {
    const malformed = [
      // part= is required with adversarial="part"
      '<change adversarial="part"></change>',
      // the premise is not a part
      '<change adversarial="premise" part="2"></change>',
      // a value outside the two the app defines
      '<change adversarial="everything"></change>',
      // the two shapes are different requests
      '<change adversarial="premise" operation="repopulate"></change>',
      // free text where a number belongs
      '<change adversarial="part" part="two"></change>',
      '<change adversarial="part" part="0"></change>',
      // "part" without the shape that owns it
      '<change part="2"><name>x</name><instruction>y</instruction></change>',
      // a body on a shape that has none
      '<change adversarial="premise"><name>x</name></change>',
      // an unknown attribute
      '<change adversarial="premise" scope="all"></change>',
    ];
    for (const raw of malformed) {
      expect(() => parseCanvasChatReply(raw), raw).toThrow(CanvasChatParseError);
    }
  });
});

describe('the executor calls the ONE pass with the RIGHT target (docs/17 row 360)', () => {
  it('a part review critiques THAT part\'s live text, and names it in the instruction', async () => {
    mockPass([ADVERSARIAL_ISSUE]);
    const handle = stringChatHandle(PARTS_DOCUMENT);
    const outcome = await executeChatChange(
      adversarialChangeOf(1),
      adversarialContext(),
      handle,
    );
    const critiqueUser = textOf(
      (chatMock.mock.calls.find(([, opts]) => schemaNameOf(opts) === 'adversarial-critique')?.[0] ??
        [])[1] ?? { content: '' },
    );
    // The reviewed text is PART 1's text, never PART 0's.
    expect(critiqueUser).toContain(PART_1);
    expect(critiqueUser).not.toContain(PART_0);
    const editorUser = textOf(
      (chatMock.mock.calls.find(([, opts]) => schemaNameOf(opts) === 'canvas-refine')?.[0] ?? [])[1] ??
        { content: '' },
    );
    expect(editorUser).toContain('part 2');
    expect(editorUser).toContain(ADVERSARIAL_ISSUE.message);
    expect(outcome.status).toBe('changed');
    expect(handle.read()).toContain('The reviewed text, rewritten.');
    expect(handle.read()).not.toContain(PART_1);
  });

  it('a premise review critiques the premise and writes it through the spine seam', async () => {
    mockPass([ADVERSARIAL_ISSUE], 'A rewritten premise.');
    const outcome = await executeChatChange(adversarialChangeOf('premise'), adversarialContext());
    expect(outcome.status).toBe('changed');
    const row = await getModule(world.moduleId);
    expect(row?.spine?.premise).toBe('A rewritten premise.');
    // The parts are untouched: a premise review writes the spine alone.
    expect(row?.parts.map((part) => part.markdown)).toEqual([PART_0, PART_1]);
  });

  it('an empty critique is the QUIET clean outcome: NOTHING is written and it says so', async () => {
    mockPass([]);
    const handle = stringChatHandle(PARTS_DOCUMENT);
    const outcome = await executeChatChange(
      adversarialChangeOf(0),
      adversarialContext(),
      handle,
    );
    expect(outcome.status).toBe('clean');
    expect(outcome.edit).toBeUndefined();
    expect(outcome.detail).toContain('found nothing to fix');
    // Nothing moved: neither the document nor the module row.
    expect(handle.read()).toBe(PARTS_DOCUMENT);
    const row = await getModule(world.moduleId);
    expect(row?.parts.map((part) => part.markdown)).toEqual([PART_0, PART_1]);
    // The editor was never called.
    expect(chatMock.mock.calls.some(([, opts]) => schemaNameOf(opts) === 'canvas-refine')).toBe(
      false,
    );
  });

  it('a target with no text is a NAMED refusal, never a pass run', async () => {
    mockPass([ADVERSARIAL_ISSUE]);
    const outcome = await executeChatChange(adversarialChangeOf(7), adversarialContext());
    expect(outcome.status).toBe('refused');
    expect(outcome.detail).toContain('no part 8');
    expect(chatMock).not.toHaveBeenCalled();
  });

  it('the findings are rendered on the outcome AND in the change-results block', async () => {
    mockPass([ADVERSARIAL_ISSUE]);
    const handle = stringChatHandle(PARTS_DOCUMENT);
    const result = await executeChatChange(adversarialChangeOf(0), adversarialContext(), handle);
    expect(result.findings).toEqual([
      `[major] inconsistency: ${ADVERSARIAL_ISSUE.message} (at: ${ADVERSARIAL_ISSUE.where})`,
    ]);
    const block = renderChangeResults([
      { ...result, change: adversarialChangeOf(0) },
    ]);
    expect(block).toContain('### Change part 1 — APPLIED');
    expect(block).toContain('inconsistency');
    expect(block).toContain(ADVERSARIAL_ISSUE.message);
    expect(block).toContain('findings:');
  });

  it('accepting a PART edit is UNDOABLE: the pre-change document is on the version stack (premise included)', async () => {
    mockPass([ADVERSARIAL_ISSUE]);
    const handle = stringChatHandle(PARTS_DOCUMENT);
    const outcome = await executeChatChange(adversarialChangeOf(1), adversarialContext(), handle);
    expect(outcome.appliedToDocument).not.toBeNull();
    // The turn persists through the EXISTING split-save, exactly as it does for
    // an <edit> batch — no new write seam.
    const row = await getModule(world.moduleId);
    if (row === undefined) throw new Error('module row missing');
    await saveWholeModuleDocument({
      moduleId: world.moduleId,
      doc: handle.read(),
      module: row,
      origin: 'ai',
      label: 'Chat: review',
      version: { source: 'chat', label: 'Chat: review' },
      writerModel: outcome.edit?.modelUsed ?? '',
    });
    const versions = await listModuleVersions(world.moduleId);
    // The PASS's own snapshot is the first row (it runs BEFORE the critique) and
    // it carries the pre-change parts document AND the premise (row 357).
    expect(versions.some((version) => version.docText === PARTS_DOCUMENT)).toBe(true);
    expect(versions.some((version) => version.premise === 'The premise.')).toBe(true);
    // And the row really moved.
    const after = await getModule(world.moduleId);
    expect(after?.parts[1]?.markdown).toContain('The reviewed text, rewritten.');
  });

  it('accepting a PREMISE edit is UNDOABLE through the pass\'s own snapshot', async () => {
    mockPass([ADVERSARIAL_ISSUE], 'A rewritten premise.');
    await executeChatChange(adversarialChangeOf('premise'), adversarialContext());
    const versions = await listModuleVersions(world.moduleId);
    expect(versions[0]?.premise).toBe('The premise.');
    expect(versions[0]?.docText).toBe(PARTS_DOCUMENT);
  });
});

describe('the chat turn renders the critique and persists the edit (docs/17 row 360)', () => {
  function adversarialTurnChat(reply: string): void {
    chatMock.mockReset();
    let replySent = false;
    chatMock.mockImplementation((_messages, opts) => {
      const schema = schemaNameOf(opts);
      if (schema === 'adversarial-critique') {
        return Promise.resolve({
          text: JSON.stringify({ issues: [ADVERSARIAL_ISSUE] }),
          modelUsed: 'critic-model',
          fallback: null,
        });
      }
      if (schema === 'canvas-refine') {
        return Promise.resolve({
          text: JSON.stringify({ replacement: 'The reviewed text, rewritten.' }),
          modelUsed: 'editor-model',
          fallback: null,
        });
      }
      if (!replySent) {
        replySent = true;
        return Promise.resolve({ text: reply, modelUsed: 'chat-model', fallback: null });
      }
      return Promise.resolve({ text: 'Reviewed.', modelUsed: 'chat-model', fallback: null });
    });
  }

  it('THE FINDINGS ARE VISIBLE: the card carries each finding WITH the edit', async () => {
    adversarialTurnChat('Reviewing part 1.\n<change adversarial="part" part="1"></change>');
    const key = canvasChatKey(world.moduleId);
    useCanvasChatStore.getState().resetFor(world.moduleId);
    const handle = stringChatHandle(PARTS_DOCUMENT);
    await runCanvasChatTurn(
      {
        moduleId: world.moduleId,
        key,
        hasPlannedParts: true,
        handle,
        surface: PREVIEW_TURN_SURFACE,
        modelSelection: null,
        turn: new AbortController(),
      },
      'review part 1',
    );
    await flushChatPersist(key);
    const assistant = useCanvasChatStore
      .getState()
      .module(key)
      .messages.find((message) => message.role === 'assistant');
    const card = assistant?.outcomes.find((outcome) => (outcome.findings ?? []).length > 0);
    expect(card?.kind).toBe('applied');
    expect(card?.findings?.[0]).toContain('inconsistency');
    expect(card?.findings?.[0]).toContain(ADVERSARIAL_ISSUE.message);
    // The edit rides the SAME card: before is what the critic read, after the
    // replacement.
    // part="1" is the FIRST part (1-based, as the plan labels it).
    expect(card?.before).toBe(PART_0);
    expect(card?.command.replace).toBe('The reviewed text, rewritten.');
  });

  it('THE ACCEPTED EDIT IS UNDOABLE: it persists through the EXISTING split-save, and the pre-change document is on the version stack', async () => {
    adversarialTurnChat('Reviewing part 1.\n<change adversarial="part" part="1"></change>');
    const key = canvasChatKey(world.moduleId);
    useCanvasChatStore.getState().resetFor(world.moduleId);
    await runCanvasChatTurn(
      {
        moduleId: world.moduleId,
        key,
        hasPlannedParts: true,
        handle: stringChatHandle(PARTS_DOCUMENT),
        surface: PREVIEW_TURN_SURFACE,
        modelSelection: null,
        turn: new AbortController(),
      },
      'review part 1',
    );
    await flushChatPersist(key);
    // The row moved — through the turn's ONE split-save, not a side-door write.
    const row = await getModule(world.moduleId);
    expect(row?.parts[0]?.markdown).toContain('The reviewed text, rewritten.');
    // Undoable: the pass's own snapshot (taken BEFORE the critique) carries the
    // pre-change parts document AND the premise (docs/17 row 357).
    const versions = await listModuleVersions(world.moduleId);
    expect(versions.some((version) => version.docText === PARTS_DOCUMENT)).toBe(true);
    expect(versions.some((version) => version.premise === 'The premise.')).toBe(true);
  });

  it('THE FINDINGS ARE VISIBLE: an EMPTY critique renders a quiet clean card and applies nothing', async () => {
    chatMock.mockReset();
    let replySent = false;
    chatMock.mockImplementation((_messages, opts) => {
      if (schemaNameOf(opts) === 'adversarial-critique') {
        return Promise.resolve({ text: JSON.stringify({ issues: [] }), modelUsed: 'critic', fallback: null });
      }
      if (!replySent) {
        replySent = true;
        return Promise.resolve({
          text: 'Reviewing the premise.\n<change adversarial="premise"></change>',
          modelUsed: 'chat-model',
          fallback: null,
        });
      }
      return Promise.resolve({ text: 'Nothing to fix.', modelUsed: 'chat-model', fallback: null });
    });
    const key = canvasChatKey(world.moduleId);
    useCanvasChatStore.getState().resetFor(world.moduleId);
    await runCanvasChatTurn(
      {
        moduleId: world.moduleId,
        key,
        hasPlannedParts: true,
        handle: stringChatHandle(PARTS_DOCUMENT),
        surface: PREVIEW_TURN_SURFACE,
        modelSelection: null,
        turn: new AbortController(),
      },
      'review the premise',
    );
    await flushChatPersist(key);
    const assistant = useCanvasChatStore
      .getState()
      .module(key)
      .messages.find((message) => message.role === 'assistant');
    const clean = assistant?.outcomes.find((outcome) => outcome.kind === 'clean');
    expect(clean).toBeDefined();
    expect(clean?.reason).toContain('found nothing to fix');
    expect(clean?.findings ?? []).toEqual([]);
    const row = await getModule(world.moduleId);
    expect(row?.spine?.premise).toBe('The premise.');
    expect(row?.parts.map((part) => part.markdown)).toEqual([PART_0, PART_1]);
    // The editor was never called for an empty critique.
    expect(chatMock.mock.calls.some(([, opts]) => schemaNameOf(opts) === 'canvas-refine')).toBe(false);
  });

  it('a FAILED pass surfaces loudly through the turn and writes NOTHING', async () => {
    chatMock.mockReset();
    let replySent = false;
    chatMock.mockImplementation((_messages, opts) => {
      if (schemaNameOf(opts) === 'adversarial-critique') {
        // A malformed critique reply is a BOUNDARY failure (AGENTS 3).
        return Promise.resolve({ text: 'I think it is fine, actually.', modelUsed: 'critic', fallback: null });
      }
      if (!replySent) {
        replySent = true;
        return Promise.resolve({
          text: 'Reviewing the premise.\n<change adversarial="premise"></change>',
          modelUsed: 'chat-model',
          fallback: null,
        });
      }
      return Promise.resolve({ text: 'Ok.', modelUsed: 'chat-model', fallback: null });
    });
    const key = canvasChatKey(world.moduleId);
    useCanvasChatStore.getState().resetFor(world.moduleId);
    const result = await runCanvasChatTurn(
      {
        moduleId: world.moduleId,
        key,
        hasPlannedParts: true,
        handle: stringChatHandle(PARTS_DOCUMENT),
        surface: PREVIEW_TURN_SURFACE,
        modelSelection: null,
        turn: new AbortController(),
      },
      'review the premise',
    );
    void result;
    await flushChatPersist(key);
    const row = await getModule(world.moduleId);
    expect(row?.spine?.premise).toBe('The premise.');
    expect(row?.parts.map((part) => part.markdown)).toEqual([PART_0, PART_1]);
    expect(toastErrorMock).toHaveBeenCalled();
    const copy = toastErrorMock.mock.calls[0]?.[0] ?? '';
    expect(copy).toContain('FAILED');
  });

  it('the canvas guard still refuses while the module is generating', async () => {
    const row = await getModule(world.moduleId);
    if (row === undefined) throw new Error('module row missing');
    await saveModule({ ...row, status: 'generating' });
    chatMock.mockReset();
    await expect(
      sendCanvasChatMessage(
        baseInput({
          instruction: 'review the premise',
          executeChange: (change, context) => executeChatChange(change, context),
        }),
      ),
    ).rejects.toThrow(/already generating/i);
  });
});

describe('the adversarial trigger adds NO second mechanism (docs/17 row 360)', () => {
  it('one executor file: one pass call, one applier, one spine write, no side-door row write, no second busy registry', () => {
    const chatChanges = CODE['src/features/modules/canvas/chatChanges.ts'] ?? '';
    expect(chatChanges).not.toBe('');
    // The ONE pass, called once.
    expect(chatChanges.match(/runAdversarialPass\(/g)).toHaveLength(1);
    // A part edit rides the chat's ONE applier…
    expect(chatChanges.match(/applyChatCommands\(/g)).toHaveLength(1);
    // …a premise edit rides the ONE spine-subfield seam…
    expect(chatChanges.match(/patchModuleSpine\(/g)).toHaveLength(1);
    // …and the executor writes NO row of its own.
    expect(chatChanges).not.toContain('saveModulePartText(');
    expect(chatChanges).not.toContain('patchModule(');
    // NO second busy mechanism (the turn owns the module slot handover) and NO
    // surface guard: the pass reaches the shared transform CORE, not
    // `refineModuleText` (whose canvas guard would refuse inside its own turn).
    expect(chatChanges).not.toContain('claimModuleGeneration(');
    expect(chatChanges).not.toContain('registerCanvasAbort(');
    expect(chatChanges).not.toContain('refineModuleText(');
  });

  it('the chat has exactly ONE outcome-card renderer, and it renders the findings', () => {
    expect(filesWith('data-testid="canvas-chat-outcome"')).toEqual([
      'src/features/modules/canvas/ChatSidebar.tsx',
    ]);
    const sidebar = CODE['src/features/modules/canvas/ChatSidebar.tsx'] ?? '';
    // ONE findings block, rendered by the ONE card component.
    expect(sidebar.match(/canvas-chat-outcome-findings/g)).toHaveLength(1);
    expect(sidebar).toContain('data-kind="clean"');
  });

  it('the findings survive the chat thread round trip (a restored card shows what the critic found)', async () => {
    const { serializeChatThread, deserializeChatThread } = await import(
      '@/features/modules/canvas/chatPersist'
    );
    const [serialized] = serializeChatThread([
      {
        id: 'msg-1',
        role: 'assistant',
        text: 'Reviewed.',
        raw: null,
        status: 'ok',
        error: null,
        createdAt: 1,
        outcomes: [
          {
            id: 'outcome-1',
            kind: 'applied',
            command: { search: 'old', replace: 'new', all: false },
            targetParts: [{ planIndex: 0, title: 'The Gate Bargain' }],
            occurrences: 1,
            from: 1,
            to: 2,
            before: 'old',
            reason: null,
            closest: null,
            failureFrom: null,
            reported: false,
            findings: ['[major] inconsistency: it drifts (at: paragraph 2)'],
          },
        ],
      },
    ]);
    expect(serialized?.outcomes[0]?.findings).toEqual([
      '[major] inconsistency: it drifts (at: paragraph 2)',
    ]);
    expect(deserializeChatThread(serialized === undefined ? [] : [serialized])[0]?.outcomes[0]?.findings).toEqual([
      '[major] inconsistency: it drifts (at: paragraph 2)',
    ]);
  });
});
