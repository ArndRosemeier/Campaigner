import 'fake-indexeddb/auto';

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

import {
  assembleModulePartsDocument,
  createModule,
  modulePartSchema,
  moduleSpineSchema,
  type Id,
} from '@/domain';
import { createCampaign } from '@/db/campaignRepo';
import { getModule, saveModule } from '@/db/moduleRepo';
import { countModuleVersions } from '@/db/moduleVersionRepo';
import { db } from '@/db/db';
import { canvasChatKey, useCanvasChatStore } from '@/features/modules/canvas/chatStore';
import { runSnapshotChatTurn } from '@/features/modules/canvas/snapshotChat';
import { runChatTurn } from '@/features/modules/canvas/chatController';
import { clearDatabase } from '../db/helpers';

/**
 * The ONE turn controller (docs/17 row 150): the editor flow and the preview
 * flow are the same turn over different documents, so the two things a fold
 * like this can silently BREAK are pinned on BOTH callers, not by prose:
 *
 * 1. AUTHORSHIP — supplying `writerModel` is the machine-write signature the
 *    part write reads to stamp `origin: 'model'` (docs/17 row 113). A fold
 *    that drops it on either path stamps model text as the person's, silently
 *    (the reader then asks the owner to consent to the model's own text).
 * 2. VERSIONING — an `origin: 'ai'` save takes the durable pre-change snapshot
 *    FIRST (docs/18 §2.3). A fold that takes it TWICE splits one revision in
 *    two, also silently. The pin asserts the COUNT (not the presence).
 * 3. THE FAILED-TURN RETURN — the two copies disagreed here: the editor
 *    returned the live doc (edits in it), the preview returned the PRE-TURN
 *    doc with `docChanged: false`, contradicting its own refusal ("the edits
 *    are still in the preview, switch to Edit and use Save to retry"). The
 *    truthful reading — the one the user is TOLD — is the return value now, on
 *    both surfaces.
 *
 * WHAT A TEST CANNOT PROVE: that a future author will not re-copy the
 * controller into a third file. The source scan in
 * `canvas-chat-apply-differential.test.ts` is a guard, and it names this file
 * as the one controller.
 */

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

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);

const PART_0 = 'The party bargains at the gate.';
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

/** One reply, ONE command per part — one split-save, two changed parts. */
const TWO_PART_REPLY =
  'Rewriting both.\n<edit><search>The party bargains at the gate.</search><replace>The party bargains at the flooded gate.</replace></edit>\n<edit><search>fog</search><replace>mist</replace></edit>';

const SERVED_MODEL = 'served/chat-model';

let world: { campaignId: Id; moduleId: Id } = { campaignId: '', moduleId: '' };

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
  world = { campaignId: campaign.id, moduleId: draft.id };
}

beforeEach(async () => {
  await clearDatabase();
  vi.clearAllMocks();
  useCanvasChatStore.setState({ ownerModuleId: null, byModule: {} });
  await seed();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function previewOptions(overrides: Partial<Parameters<typeof runSnapshotChatTurn>[0]> = {}) {
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

function editorOptions(
  overrides: Partial<Omit<Parameters<typeof runChatTurn>[0], 'view'>> & { doc?: string } = {},
): Parameters<typeof runChatTurn>[0] & { destroy: () => void } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({ doc: overrides.doc ?? PARTS_DOCUMENT }),
    parent: host,
  });
  return {
    moduleId: world.moduleId,
    key: canvasChatKey(world.moduleId),
    hasPlannedParts: true,
    modelSelection: null,
    turn: new AbortController(),
    ...overrides,
    view,
    destroy: () => {
      view.destroy();
      host.remove();
    },
  };
}

describe('one turn controller — the machine-write signature on BOTH callers', () => {
  it('PREVIEW: the applied parts record the model that served the reply', async () => {
    chatMock.mockResolvedValue({ text: TWO_PART_REPLY, modelUsed: SERVED_MODEL, fallback: null });
    // Non-vacuity: the parts start with NOTHING recorded, so the assertion
    // below proves the turn wrote the signature rather than reading a seed.
    const before = await getModule(world.moduleId);
    expect(before?.parts.map((part) => part.origin)).toEqual([null, null]);
    expect(before?.parts.map((part) => part.writerModel)).toEqual(['', '']);
    const result = await runSnapshotChatTurn(previewOptions(), 'tighten both');
    expect(result.docChanged).toBe(true);
    const row = await getModule(world.moduleId);
    for (const planIndex of [0, 1]) {
      const part = row?.parts.find((candidate) => candidate.planIndex === planIndex);
      expect(part?.origin, `part ${String(planIndex)} origin`).toBe('model');
      expect(part?.writerModel, `part ${String(planIndex)} writerModel`).toBe(SERVED_MODEL);
    }
  });

  it('EDITOR: the same signature, through the live view', async () => {
    chatMock.mockResolvedValue({ text: TWO_PART_REPLY, modelUsed: SERVED_MODEL, fallback: null });
    const options = editorOptions();
    try {
      const result = await runChatTurn(options, 'tighten both');
      expect(result.docChanged).toBe(true);
      const row = await getModule(world.moduleId);
      for (const planIndex of [0, 1]) {
        const part = row?.parts.find((candidate) => candidate.planIndex === planIndex);
        expect(part?.origin, `part ${String(planIndex)} origin`).toBe('model');
        expect(part?.writerModel, `part ${String(planIndex)} writerModel`).toBe(SERVED_MODEL);
      }
    } finally {
      options.destroy();
    }
  });
});

describe('one turn controller — EXACTLY ONE version snapshot per chat turn', () => {
  it('PREVIEW: one batch of two parts takes one snapshot', async () => {
    chatMock.mockResolvedValue({ text: TWO_PART_REPLY, modelUsed: SERVED_MODEL, fallback: null });
    expect(await countModuleVersions(world.moduleId)).toBe(0);
    await runSnapshotChatTurn(previewOptions(), 'tighten both');
    // The COUNT, not the presence: a fold that snapshots per part (or twice
    // around one save) splits one revision in two and would pass a
    // "some snapshot exists" assertion.
    expect(await countModuleVersions(world.moduleId)).toBe(1);
  });

  it('EDITOR: the same single snapshot', async () => {
    chatMock.mockResolvedValue({ text: TWO_PART_REPLY, modelUsed: SERVED_MODEL, fallback: null });
    const options = editorOptions();
    try {
      expect(await countModuleVersions(world.moduleId)).toBe(0);
      await runChatTurn(options, 'tighten both');
      expect(await countModuleVersions(world.moduleId)).toBe(1);
    } finally {
      options.destroy();
    }
  });

  it('takes NO snapshot when nothing applied (a reply with no commands)', async () => {
    chatMock.mockResolvedValue({ text: 'Nothing to change.', modelUsed: SERVED_MODEL, fallback: null });
    await runSnapshotChatTurn(previewOptions(), 'just talk');
    expect(await countModuleVersions(world.moduleId)).toBe(0);
  });
});

describe('the failed-turn return is what the user is TOLD (docs/17 row 150)', () => {
  /**
   * The narrow reachability the divergence lived in: the module row vanishes
   * between the reply and the persist (`getModule` → undefined mid-turn), so
   * the batch IS applied to the document and the refusal says the edits are
   * still there — while nothing was written to the row.
   */
  async function vanishTheRow(): Promise<void> {
    // The module row goes away INSIDE the model call: `sendCanvasChatMessage`'s
    // own pre-flight already read it, the apply step is what finds it gone.
    // (A test-only fixture write — the production seam for this state is a
    // concurrent delete, which the same `getModule` result covers.)
    await db.modules.delete(world.moduleId);
  }

  const ONE_EDIT = '<edit><search>The party bargains at the gate.</search><replace>The party bargains at the flooded gate.</replace></edit>';

  it('PREVIEW: the applied edits stay in the returned doc (they used to be discarded)', async () => {
    chatMock.mockImplementation(async () => {
      await vanishTheRow();
      return { text: `Rewriting.\n${ONE_EDIT}`, modelUsed: SERVED_MODEL, fallback: null };
    });
    const result = await runSnapshotChatTurn(previewOptions(), 'flood the gate');
    // THE RESOLUTION: the refusal below promises the edits are still in the
    // preview, so the returned document CARRIES them — the pre-turn document
    // plus `docChanged: false` was the copy contradicting its own message.
    expect(result.doc).toContain('The party bargains at the flooded gate.');
    expect(result.docChanged).toBe(true);
    expect(result.lastApplied).toBeNull();
    const messages = useCanvasChatStore.getState().module(canvasChatKey(world.moduleId)).messages;
    expect(messages[1]?.status).toBe('failed');
    expect(messages[1]?.error).toContain(
      'Module no longer exists — the edits are still in the preview, switch to Edit and use Save to retry',
    );
  });

  it('EDITOR: the same reading, with the editor’s own sentence', async () => {
    chatMock.mockImplementation(async () => {
      await vanishTheRow();
      return { text: `Rewriting.\n${ONE_EDIT}`, modelUsed: SERVED_MODEL, fallback: null };
    });
    const options = editorOptions();
    try {
      const result = await runChatTurn(options, 'flood the gate');
      expect(result.doc).toContain('The party bargains at the flooded gate.');
      expect(result.docChanged).toBe(true);
      expect(result.lastApplied).toBeNull();
      const messages = useCanvasChatStore.getState().module(canvasChatKey(world.moduleId)).messages;
      expect(messages[1]?.status).toBe('failed');
      expect(messages[1]?.error).toContain(
        'Module no longer exists — the edits are still in the editor, use Save to retry',
      );
    } finally {
      options.destroy();
    }
  });

  it('a transport failure with NOTHING applied returns the untouched document', async () => {
    chatMock.mockRejectedValue(new Error('the transport died'));
    const result = await runSnapshotChatTurn(previewOptions(), 'flood the gate');
    expect(result.doc).toBe(PARTS_DOCUMENT);
    expect(result.docChanged).toBe(false);
    expect(result.lastApplied).toBeNull();
  });
});

// --- the ONE turn controller (SOURCE SCAN) --------------------------------------

/**
 * The behavioural pins above hold the two callers to the same authorship,
 * versioning and failure semantics. This holds the SHAPE: the flow lives in
 * ONE file, and the two surface modules are wrappers. It is a GUARD, not a
 * proof — a third copy written with different words would slip past it — and
 * it is exactly the half that goes red when the deleted copy is re-born.
 */
describe('the chat turn controller is declared EXACTLY once (SOURCE SCAN)', () => {
  const CANVAS_DIR = join(process.cwd(), 'src', 'features', 'modules', 'canvas');
  const CONTROLLER = join(CANVAS_DIR, 'chatTurn.ts');

  function canvasSources(): string[] {
    return readdirSync(CANVAS_DIR)
      .filter((name) => /\.tsx?$/.test(name))
      .map((name) => join(CANVAS_DIR, name));
  }

  function carriers(pattern: RegExp): string[] {
    return canvasSources()
      .filter((file) => pattern.test(readFileSync(file, 'utf8')))
      .map((file) => relative(process.cwd(), file));
  }

  it('declares the turn, its flow helpers and its sentences in ONE file', () => {
    expect(canvasSources().length).toBeGreaterThan(15);
    const controller = relative(process.cwd(), CONTROLLER);
    expect(carriers(/export async function runCanvasChatTurn\(/)).toEqual([controller]);
    expect(carriers(/function historyFor\(/)).toEqual([controller]);
    expect(carriers(/const ensureFollowUpMessage = /)).toEqual([controller]);
    expect(carriers(/followUpRafRef/)).toEqual([controller]);
    expect(carriers(/chat asked for artifact details a second time in one turn/)).toEqual([
      controller,
    ]);
    expect(carriers(/the edits are still in \$\{options\.surface\.unsavedEditsLocation\}/)).toEqual([
      controller,
    ]);
    // The preview copy's OWN failure return (the pre-turn doc) is gone: no
    // surface module returns `options.doc` from a catch any more.
    for (const file of ['chatController.ts', 'snapshotChat.ts']) {
      const text = readFileSync(join(CANVAS_DIR, file), 'utf8');
      expect(text).not.toContain('followUpRafRef');
      expect(text).not.toContain('const applyCommandsFor');
      expect(text).not.toContain('scheduleChatPersist');
      // Both wrapper modules go through the one controller.
      expect(text).toContain('runCanvasChatTurn');
    }
  });

  it('binds the two surfaces with a handle and a surface descriptor, not a second flow', () => {
    const editor = readFileSync(join(CANVAS_DIR, 'chatController.ts'), 'utf8');
    const preview = readFileSync(join(CANVAS_DIR, 'snapshotChat.ts'), 'utf8');
    expect(editor).toContain('editorChatHandle(options.view)');
    expect(editor).toContain('EDITOR_TURN_SURFACE');
    expect(preview).toContain('stringChatHandle(options.doc)');
    expect(preview).toContain('PREVIEW_TURN_SURFACE');
  });
});
