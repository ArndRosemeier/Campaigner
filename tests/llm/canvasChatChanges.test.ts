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
import { saveModule } from '@/db/moduleRepo';
import { createArtifact, getAnyArtifact } from '@/db/artifactRepo';
import { db } from '@/db/db';
import { executeChatChange, reportChatChangeOutcome } from '@/features/modules/canvas/chatChanges';
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
      levelHint: '3',
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
function produced(name: string, artifactId: Id) {
  return { generated: [name], cast: [], produced: [{ name, artifactId }], failed: [] };
}

function changeReply(...changes: string[]): string {
  return ['On it.', ...changes].join('\n');
}

function changeOf(name: string, instruction: string, operation?: 'repopulate' | 'everything'): string {
  const attribute = operation === undefined ? '' : ` operation="${operation}"`;
  return `<change${attribute}><name>${name}</name><instruction>${instruction}</instruction></change>`;
}

/** A stub executor that records the ORDER and the CONCURRENCY of the calls. */
function sequencingExecutor(events: string[], behavior?: (change: { name: string }) => void) {
  let inFlight = 0;
  const executor: CanvasChatChangeExecutor = vi.fn(async (change: CanvasChatChangeCommand) => {
    inFlight += 1;
    events.push(`start:${change.name}:${String(inFlight)}`);
    behavior?.(change);
    await new Promise((resolve) => setTimeout(resolve, 5));
    events.push(`end:${change.name}`);
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
    expect(result.changes.outcomes.map((outcome) => outcome.change.name)).toEqual([
      'Keeper Ilse',
      'Halmund the Smith',
    ]);
    // The turn released everything it took.
    expect(isModuleGenerationClaimed(world.moduleId)).toBe(false);
  });

  it('a specialist FAILURE is a named outcome the model reads, and the NEXT change still runs', async () => {
    const executor = vi.fn<CanvasChatChangeExecutor>((change: CanvasChatChangeCommand) => {
      if (change.name === 'Keeper Ilse') throw new Error('the run produced no artifact');
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
      calls.push(change.name);
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
