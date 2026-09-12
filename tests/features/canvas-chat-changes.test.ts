import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

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
import { createArtifact, getAnyArtifact, listRevisions, restoreRevision } from '@/db/artifactRepo';
import { canvasChatKey, useCanvasChatStore } from '@/features/modules/canvas/chatStore';
import { runSnapshotChatTurn } from '@/features/modules/canvas/snapshotChat';
import { runChatTurn } from '@/features/modules/canvas/chatController';
import { artifactPath } from '@/app/routes';
import { useProgressStore } from '@/lib/progress';
import type { EncounterRegenOptions } from '@/features/campaign/encounterRegen';
import type { EntityBatchResult, RunEntityBatchInput } from '@/features/modules/entity-batch';
import { clearDatabase } from '../db/helpers';

/**
 * The canvas chat's CHANGE half at the CONTROLLER level (docs/17 ledger row
 * 104): a `<change>` block runs the specialist for the resolved row's kind
 * through the ONE `changeArtifact` seam, in BOTH chat flows (editor + preview),
 * and the owner is told what happened — loudly, with the artifact's name and the
 * instruction that asked for it.
 *
 * The specialists are mocked HERE (the assertion target is the wiring, the owner
 * report and the row's RECOVERY facts); the instruction's arrival in a real
 * prompt is pinned where the engine really runs it (`change-artifact-instruction`
 * + `encounterRepopulate`). The mocked specialist writes the row through the SAME
 * `updateArtifact` the engine's finalize uses, so the revision facts measured
 * below are the real ones.
 */

const { repopulateMock, regenerateMock, runEntityBatchMock } = vi.hoisted(() => ({
  repopulateMock: vi.fn<(artifactId: Id, options: EncounterRegenOptions) => Promise<void>>(),
  regenerateMock: vi.fn<(artifactId: Id, options: EncounterRegenOptions) => Promise<void>>(),
  runEntityBatchMock: vi.fn<(input: RunEntityBatchInput) => Promise<EntityBatchResult>>(),
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

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);
const { toastError, toastSuccess } = await import('@/lib/toast');
const toastErrorMock = vi.mocked(toastError);
const toastSuccessMock = vi.mocked(toastSuccess);

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

let world: { campaignId: Id; moduleId: Id; npcId: Id; encounterId: Id } = {
  campaignId: '',
  moduleId: '',
  npcId: '',
  encounterId: '',
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
    summary: 'The keeper of the drowned gate.',
    body: '# Ilse\nShe keeps the gate.',
    data: npcDataSchema.parse({ appearance: 'Salt-crusted coat.', personality: 'Patient.', statBlock: null }),
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
  world = { campaignId: campaign.id, moduleId: draft.id, npcId: npc.id, encounterId: encounter.id };
}

beforeEach(async () => {
  await clearDatabase();
  vi.clearAllMocks();
  useCanvasChatStore.setState({ ownerModuleId: null, byModule: {} });
  useProgressStore.getState().reset();
  repopulateMock.mockReset();
  regenerateMock.mockReset();
  runEntityBatchMock.mockReset();
  repopulateMock.mockResolvedValue(undefined);
  regenerateMock.mockResolvedValue(undefined);
  await seed();
  // The entity lane's default: it succeeds and reports the row it filled.
  runEntityBatchMock.mockResolvedValue(produced('Keeper Ilse', world.npcId));
});

afterEach(() => {
  vi.restoreAllMocks();
});

function messagesFor(key: string) {
  return useCanvasChatStore.getState().module(key).messages;
}

/** What the seam's entity lane returns when it succeeded. `cast: []` — this
 * change ran a persona draft, never the module-side bestiary cast (docs/17 row
 * 107). */
function produced(name: string, artifactId: Id) {
  return { generated: [name], cast: [], produced: [{ name, artifactId }], failed: [] };
}

function changeOf(name: string, instruction: string, operation?: 'repopulate' | 'everything'): string {
  const attribute = operation === undefined ? '' : ` operation="${operation}"`;
  return `<change${attribute}><name>${name}</name><instruction>${instruction}</instruction></change>`;
}

async function revisionCount(artifactId: Id): Promise<number> {
  return (await listRevisions(artifactId)).length;
}

/**
 * A mocked specialist that writes the row the way the engine's finalize does:
 * through `updateArtifact`, which records a NEW revision and leaves the previous
 * one intact. Without that write the revision pins below would be vacuous.
 */
function specialistWrites(artifactId: Id, patch: string) {
  runEntityBatchMock.mockImplementation(async () => {
    const { updateArtifact } = await import('@/db/artifactRepo');
    await updateArtifact(artifactId, { summary: patch });
    return produced('Keeper Ilse', artifactId);
  });
}

describe('the preview flow runs a change through the seam and tells the owner', () => {
  function options(overrides: Partial<Parameters<typeof runSnapshotChatTurn>[0]> = {}) {
    return {
      moduleId: world.moduleId,
      key: canvasChatKey(world.moduleId),
      hasPlannedParts: true,
      doc: PARTS_DOCUMENT,
      modelSelection: null,
      turn: new AbortController(),
      ...overrides,
    };
  }

  it('a change lands as a NEW revision with the PRIOR one intact — and is RESTORABLE', async () => {
    const before = await getAnyArtifact(world.npcId);
    const beforeBytes = JSON.stringify(before);
    const revisionsBefore = await listRevisions(world.npcId);
    expect(revisionsBefore).toHaveLength(1);
    expect(revisionsBefore[0]?.revision).toBe(1);
    // The specialist writes the row exactly the way the engine's finalize does.
    specialistWrites(world.npcId, 'Restocked by the smith after the chat change.');
    chatMock
      .mockResolvedValueOnce({
        text: `I will rewrite her.\n${changeOf('Keeper Ilse', 'make her the smith\'s sister')}`,
        modelUsed: 'first-model',
        fallback: null,
      })
      .mockResolvedValueOnce({ text: 'Done — she is rewritten.', modelUsed: 'second-model', fallback: null });
    const result = await runSnapshotChatTurn(options(), 'make the keeper the smith\'s sister');
    expect(result.docChanged).toBe(false);
    // MEASURED: the change is revision 2 and revision 1 is byte-intact.
    const after = await getAnyArtifact(world.npcId);
    expect(after?.currentRevision).toBe(2);
    expect(after?.summary).toBe('Restocked by the smith after the chat change.');
    const revisionsAfter = await listRevisions(world.npcId);
    expect(revisionsAfter.map((revision) => revision.revision)).toEqual([2, 1]);
    expect(JSON.stringify(revisionsAfter[1]?.snapshot)).toBe(beforeBytes);
    // The owner can SEE it: a loud success notice naming the artifact, what
    // happened and the instruction that asked for it.
    const [copy] = toastSuccessMock.mock.calls[0] ?? [];
    expect(copy).toContain('The chat changed «Keeper Ilse»');
    expect(copy).toContain("make her the smith's sister");
    expect(copy).toContain('redesigned in place');
    expect(toastErrorMock).not.toHaveBeenCalled();
    // The follow-up reply (the model's own account) is its OWN bubble.
    const messages = messagesFor(options().key);
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(messages[2]?.raw).toBe('Done — she is rewritten.');

    // THE RECOVERY SURFACE, measured: the artifact editor's revision restore
    // puts the PREVIOUS bytes back (as a further revision, nothing destroyed).
    await restoreRevision(world.npcId, 1);
    const restored = await getAnyArtifact(world.npcId);
    expect(JSON.stringify({ ...restored, currentRevision: 1, updatedAt: 0 })).toBe(
      JSON.stringify({ ...before, currentRevision: 1, updatedAt: 0 }),
    );
    expect(restored?.summary).toBe('The keeper of the drowned gate.');
  });

  it('reports the change in the progress dock WHILE it runs (honest about time), and clears it after', async () => {
    const seen: { label: string; detail: string; href: string | undefined }[] = [];
    runEntityBatchMock.mockImplementation(() => {
      const job = useProgressStore
        .getState()
        .jobs.find((candidate) => candidate.label === 'Changing «Keeper Ilse»');
      if (job === undefined) throw new Error('the change phase reported no dock job');
      seen.push({ label: job.label, detail: job.detail, href: job.href });
      return Promise.resolve(produced('Keeper Ilse', world.npcId));
    });
    chatMock
      .mockResolvedValueOnce({
        text: changeOf('Keeper Ilse', 'soften her'),
        modelUsed: 'm',
        fallback: null,
      })
      .mockResolvedValueOnce({ text: 'Done.', modelUsed: 'm2', fallback: null });
    await runSnapshotChatTurn(options(), 'soften the keeper');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.detail).toContain('soften her');
    expect(seen[0]?.detail).toContain('an NPC');
    // The dock entry points where the owner can look at the row.
    expect(seen[0]?.href).toBe(artifactPath(world.campaignId, world.npcId));
    // …and nothing outlives the change.
    expect(useProgressStore.getState().jobs).toEqual([]);
  });

  it('an ENCOUNTER change without an operation is refused, named, and the owner is told NOT', async () => {
    chatMock
      .mockResolvedValueOnce({
        text: changeOf('Salt Gate Ambush', 'make it harder'),
        modelUsed: 'm',
        fallback: null,
      })
      .mockResolvedValueOnce({ text: 'Which operation?', modelUsed: 'm2', fallback: null });
    await runSnapshotChatTurn(options(), 'make the gate fight harder');
    expect(repopulateMock).not.toHaveBeenCalled();
    expect(regenerateMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).not.toHaveBeenCalled();
    const [copy] = toastErrorMock.mock.calls[0] ?? [];
    expect(copy).toContain('did NOT change «Salt Gate Ambush»');
    expect(copy).toContain('There is NO default');
    expect(copy).toContain('make it harder');
    // The row is untouched (no revision was added).
    expect(await revisionCount(world.encounterId)).toBe(1);
  });

  it('an operation the model names for an encounter reaches the seam as THAT operation', async () => {
    chatMock
      .mockResolvedValueOnce({
        text: changeOf('Salt Gate Ambush', 'rebuild it entirely', 'everything'),
        modelUsed: 'm',
        fallback: null,
      })
      .mockResolvedValueOnce({ text: 'Rebuilt.', modelUsed: 'm2', fallback: null });
    await runSnapshotChatTurn(options(), 'rebuild the gate fight');
    expect(regenerateMock).toHaveBeenCalledTimes(1);
    expect(repopulateMock).not.toHaveBeenCalled();
    const [artifactId, options_] = regenerateMock.mock.calls[0] ?? [];
    expect(artifactId).toBe(world.encounterId);
    expect(options_).toEqual({ redesignProse: false, instruction: 'rebuild it entirely' });
    const [copy] = toastSuccessMock.mock.calls[0] ?? [];
    expect(copy).toContain('The chat changed «Salt Gate Ambush»');
    expect(copy).toContain('regenerate everything');
  });

  it('an ambiguous name is refused with the resolver candidates, and the owner is told NOT', async () => {
    await createArtifact({ campaignId: world.campaignId, kind: 'note', name: 'Ash Gate', body: 'older' });
    await createArtifact({ campaignId: world.campaignId, kind: 'note', name: 'Ash Gate', body: 'newer' });
    chatMock
      .mockResolvedValueOnce({ text: changeOf('Ash Gate', 'rewrite it'), modelUsed: 'm', fallback: null })
      .mockResolvedValueOnce({ text: 'Which one?', modelUsed: 'm2', fallback: null });
    await runSnapshotChatTurn(options(), 'fix the Ash Gate note');
    expect(runEntityBatchMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).not.toHaveBeenCalled();
    const [copy] = toastErrorMock.mock.calls[0] ?? [];
    expect(copy).toContain('did NOT change «Ash Gate»');
    expect(copy).toContain('2 stored artifacts match «Ash Gate»');
    // Both candidates are named — the app refused to guess which row to rewrite.
    expect((copy ?? '').match(/«Ash Gate» \(Note/g)).toHaveLength(2);
  });

  it('a BUSY module is a loud, named refusal — never a success look', async () => {
    const { ModuleBusyError } = await import('@/llm/moduleGen');
    runEntityBatchMock.mockImplementation(() => {
      throw new ModuleBusyError(world.moduleId);
    });
    chatMock
      .mockResolvedValueOnce({ text: changeOf('Keeper Ilse', 'soften her'), modelUsed: 'm', fallback: null })
      .mockResolvedValueOnce({ text: 'I will wait.', modelUsed: 'm2', fallback: null });
    await runSnapshotChatTurn(options(), 'soften the keeper');
    expect(toastSuccessMock).not.toHaveBeenCalled();
    const [copy] = toastErrorMock.mock.calls[0] ?? [];
    expect(copy).toContain('did NOT change «Keeper Ilse»');
    expect(copy).toContain('was NOT started');
    expect(copy).toContain('single generation slot');
    expect(await revisionCount(world.npcId)).toBe(1);
  });

  it('a change asked for in the FOLLOW-UP is a named no-op the owner hears about (no third call)', async () => {
    chatMock
      .mockResolvedValueOnce({ text: changeOf('Keeper Ilse', 'soften her'), modelUsed: 'm', fallback: null })
      .mockResolvedValueOnce({
        text: `And this one.\n${changeOf('Salt Gate Ambush', 'make it harder', 'repopulate')}`,
        modelUsed: 'm2',
        fallback: null,
      });
    await runSnapshotChatTurn(options(), 'soften the keeper');
    expect(chatMock).toHaveBeenCalledTimes(2);
    expect(repopulateMock).not.toHaveBeenCalled();
    const [copy] = toastErrorMock.mock.calls[0] ?? [];
    expect(copy).toContain('another artifact change in the same turn');
    expect(copy).toContain('«Salt Gate Ambush»');
    expect(copy).toContain('NOTHING was changed for it');
    // The one change that WAS served is reported as a success.
    expect(toastSuccessMock).toHaveBeenCalledTimes(1);
  });
});

describe('the editor flow wires the same change half', () => {
  function editorOptions() {
    const view = new EditorView({ state: EditorState.create({ doc: PARTS_DOCUMENT }) });
    return {
      moduleId: world.moduleId,
      key: canvasChatKey(world.moduleId),
      hasPlannedParts: true,
      view,
      modelSelection: null,
      turn: new AbortController(),
    };
  }

  it('a change runs once, the owner is told, and the follow-up batch still applies to the doc', async () => {
    specialistWrites(world.npcId, 'Rewritten for the chat.');
    chatMock
      .mockResolvedValueOnce({
        text: `${changeOf('Keeper Ilse', 'soften her')}\n<edit><search>fog</search><replace>mist</replace></edit>`,
        modelUsed: 'first-model',
        fallback: null,
      })
      .mockResolvedValueOnce({
        text: 'Also the docks.\n<edit><search>bargains with</search><replace>haggles with</replace></edit>',
        modelUsed: 'second-model',
        fallback: null,
      });
    const options = editorOptions();
    const result = await runChatTurn(options, 'soften the keeper and the docks');
    expect(runEntityBatchMock).toHaveBeenCalledTimes(1);
    const [copy] = toastSuccessMock.mock.calls[0] ?? [];
    expect(copy).toContain('The chat changed «Keeper Ilse»');
    // The reply's own edits apply to the live doc (the change does not touch it).
    expect(result.doc).toContain('mist');
    expect(result.doc).toContain('haggles with');
    const row = await getModule(world.moduleId);
    expect(row?.parts.find((part) => part.planIndex === 1)?.markdown).toContain('mist');
    const messages = messagesFor(options.key);
    expect(messages).toHaveLength(3);
    expect(messages[2]?.status).toBe('ok');
    options.view.destroy();
  });

  it('a chat turn with NO change is the same single-call turn (no dock job, no notice)', async () => {
    chatMock.mockResolvedValue({ text: 'Nothing to change.', modelUsed: 'm', fallback: null });
    const options = editorOptions();
    await runChatTurn(options, 'look at the gate scene');
    expect(chatMock).toHaveBeenCalledTimes(1);
    expect(runEntityBatchMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(useProgressStore.getState().jobs).toEqual([]);
    expect(messagesFor(options.key)).toHaveLength(2);
    options.view.destroy();
  });
});
