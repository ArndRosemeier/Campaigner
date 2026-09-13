import 'fake-indexeddb/auto';

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppRouter } from '@/app/router';
import { canvasPath } from '@/app/routes';
import { createCampaign } from '@/db/campaignRepo';
import { listArtifactsByCampaign, createArtifact } from '@/db/artifactRepo';
import { getModule, saveModule } from '@/db/moduleRepo';
import { listModuleVersions } from '@/db/moduleVersionRepo';
import { saveSettings } from '@/db/settingsRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import {
  createModule,
  defaultSettings,
  modulePartSchema,
  moduleSpineSchema,
  splitPartsDocument,
  type Id,
} from '@/domain';
import { activeCanvasView } from '@/features/modules/canvas/canvasView';
import { useCanvasChatStore } from '@/features/modules/canvas/chatStore';
import { useCanvasLedgerStore } from '@/features/modules/canvas/canvasStore';
import { useCanvasPreviewStore } from '@/features/modules/canvas/previewStore';
import { flushChatPersist } from '@/features/modules/canvas/chatPersist';
import { chainRunner } from '@/llm/chainRunner';
import { useProgressStore } from '@/lib/progress';
import { clearDatabase } from '../db/helpers';
import { expectBlockedReason } from '../helpers/blocked-reason';
import { actDrained, flushAsyncUpdates } from '../helpers/flush';

/**
 * The canvas's two DERIVED controls (docs/05 §Module canvas, docs/08 §M4-B-3):
 * "Fix module problems" (only when the module TEXT has a problem a rewrite can
 * fix) and "Resume automatic module creation" (only when the live state falls
 * short of the RECORDED intent). Both are driven here through the REAL seams —
 * the repair pass, the entity chain, the post-generation sweep, Dexie — with
 * only the model, the background queues and the toasts mocked.
 *
 * The one thing every test in this file circles: visibility is DERIVED, so it
 * follows a hand edit with no stored flag, and each confirmation names exactly
 * what its action will do.
 */

vi.mock('@/lib/toast', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {},
  OpenRouterError: class OpenRouterError extends Error {},
  listModels: vi.fn(),
}));

const { enqueueImageJobs, enqueueEncounterMaps, enqueueMobPortraits } = vi.hoisted(() => ({
  enqueueImageJobs: vi.fn(),
  enqueueEncounterMaps: vi.fn(),
  enqueueMobPortraits: vi.fn(),
}));

vi.mock('@/features/modules/entity-image-queue', () => ({
  useEntityImageQueue: { getState: () => ({ enqueue: enqueueImageJobs }) },
}));

vi.mock('@/features/modules/encounter-map-queue', () => ({
  useEncounterMapQueue: { getState: () => ({ enqueue: enqueueEncounterMaps }) },
}));

vi.mock('@/features/campaign/mob-portrait-queue', () => ({ enqueueMobPortraits }));

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);
const { toastError, toastInfo } = await import('@/lib/toast');
const toastErrorMock = vi.mocked(toastError);
const toastInfoMock = vi.mocked(toastInfo);

interface ChatReply {
  text: string;
  modelUsed: string;
  fallback: null;
}

/** Module prose well above the minimum length, with a findable marker. */
function prose(marker: string, names: string[]): ChatReply {
  return {
    text:
      `${marker}: The tide withdraws and the streets shine wet under a pale sun. `.repeat(4) +
      `Mentioned here: ${names.map((name) => `[[${name}]]`).join(' and ')}.`,
    modelUsed: 'test-model',
    fallback: null,
  };
}

/** The normalization reply recording every listed name as an encounter. */
function encounterReply(...names: string[]): ChatReply {
  return {
    text: JSON.stringify({
      entities: names.map((name) => ({ name, canonical: name, kind: 'encounter' })),
    }),
    modelUsed: 'test-model',
    fallback: null,
  };
}

const npcDraft = {
  name: 'Kael',
  summary: 'The watchful keeper of the tide gate.',
  suggestedTags: ['warden'],
  body: '# Kael\nKael keeps the gate.',
  appearance: 'Weathered leathers.',
  personality: 'Quiet.',
  needsStatBlock: false,
};

const PART_PLAN = [
  { title: 'The Sunken Quarter', levelBand: '1', synopsis: '', levelUpTrigger: '' },
  { title: 'The Drowned Cathedral', levelBand: '2', synopsis: '', levelUpTrigger: '' },
];

let world: { campaignId: Id; moduleId: Id } = { campaignId: '', moduleId: '' };

/**
 * A module whose floor is ENABLED: part 1 names one encounter (the floor is met
 * for band 1), part 2 names nothing (band 2 is short — the rewrite target).
 * `[[Bell Trial]]` is a recorded encounter with an artifact, so its link
 * resolves and it is not a problem in its own right.
 */
async function seedWorld(overrides: Parameters<typeof saveModule>[0] extends never ? never : Record<string, unknown> = {}): Promise<void> {
  const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
  const draft = createModule({
    campaignId: campaign.id,
    title: 'The Drowned Bell',
    concept: 'A harbor bell that rings by itself beneath the water.',
    levelMin: 1,
    levelMax: 2,
    tone: 'eerie',
    sizeDial: 'standard',
  });
  await saveModule({
    ...draft,
    status: 'ready',
    encounterFloorGuardrail: { enabled: true, perLevel: 1 },
    entityNamesNormalized: true,
    entityKinds: [{ name: 'Bell Trial', kind: 'encounter', absorbed: [] }],
    spine: moduleSpineSchema.parse({
      premise: 'The bell rings under the harbor.',
      themes: [],
      partPlan: PART_PLAN,
    }),
    parts: [
      modulePartSchema.parse({
        planIndex: 0,
        markdown: prose('PART-ONE', ['Bell Trial']).text,
        status: 'ready',
        errorMessage: '',
        edited: false,
      }),
      modulePartSchema.parse({
        planIndex: 1,
        markdown: 'PART-TWO: The drowned cathedral waits in the dark, silent and cold. '.repeat(4),
        status: 'ready',
        errorMessage: '',
        edited: false,
      }),
    ],
    ...overrides,
  });
  await createArtifact({
    campaignId: campaign.id,
    kind: 'encounter',
    name: 'Bell Trial',
    summary: '',
    body: '',
    data: {
      difficulty: 'medium',
      levelHint: '1',
      monsters: [],
      terrain: '',
      tactics: '',
      treasure: '',
      mapImageId: null,
      layout: null,
      preset: 'standard',
      locationKind: 'other',
      siteShape: 'single',
      budgetAdvisory: '',
    },
  });
  world = { campaignId: campaign.id, moduleId: draft.id };
}

function renderCanvas(): ReturnType<typeof render> {
  window.history.replaceState(null, '', canvasPath(world.campaignId, world.moduleId));
  return render(<RouterProvider router={createAppRouter()} />);
}

/** The default view (chat + preview, no editor mounted). */
async function mountCanvas(): Promise<void> {
  renderCanvas();
  await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
  await flushAsyncUpdates();
}

/** Mounts with the EDITOR present (the dirty-guard test needs it). */
async function mountCanvasEditor(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  renderCanvas();
  await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
  if (screen.queryByTestId('canvas-chat') === null) {
    await user.click(await screen.findByTestId('canvas-chat-toggle'));
  }
  if (screen.queryByTestId('canvas-preview') !== null) {
    await user.click(screen.getByTestId('canvas-preview-toggle'));
  }
  await screen.findByTestId('canvas-editor');
  await flushAsyncUpdates();
}

beforeEach(async () => {
  await clearDatabase();
  await seedBuiltInPersonas();
  vi.clearAllMocks();
  chatMock.mockReset();
  chainRunner.reset();
  useProgressStore.getState().reset();
  useCanvasLedgerStore.setState({ ownerModuleId: null, byPart: {} });
  useCanvasChatStore.setState({ ownerModuleId: null, byModule: {} });
  useCanvasPreviewStore.setState({ ownerModuleId: null, openByModule: {} });
  await flushChatPersist();
  await saveSettings({ ...defaultSettings(), imagesEnabled: true });
});

describe('"Fix module problems" on the canvas', () => {
  it('is absent while the text has no problem a rewrite can fix', async () => {
    await seedWorld({
      // Both bands met: part 2 gets its own encounter name.
      parts: [
        modulePartSchema.parse({
          planIndex: 0,
          markdown: prose('PART-ONE', ['Bell Trial']).text,
          status: 'ready',
          errorMessage: '',
          edited: false,
        }),
        modulePartSchema.parse({
          planIndex: 1,
          markdown: prose('PART-TWO', ['Flood Trial']).text,
          status: 'ready',
          errorMessage: '',
          edited: false,
        }),
      ],
      entityKinds: [
        { name: 'Bell Trial', kind: 'encounter', absorbed: [] },
        { name: 'Flood Trial', kind: 'encounter', absorbed: [] },
      ],
    });
    await createArtifact({
      campaignId: world.campaignId,
      kind: 'encounter',
      name: 'Flood Trial',
      summary: '',
      body: '',
      data: {
        difficulty: 'medium',
        levelHint: '2',
        monsters: [],
        terrain: '',
        tactics: '',
        treasure: '',
        mapImageId: null,
        layout: null,
        preset: 'standard',
        locationKind: 'other',
        siteShape: 'single',
        budgetAdvisory: '',
      },
    });

    await mountCanvas();

    // Healthy text AND nothing missing: neither control appears (the module
    // records no automation intent, so there is nothing to resume either).
    expect(screen.queryByTestId('canvas-fix-problems')).toBeNull();
    expect(screen.queryByTestId('canvas-resume-automation')).toBeNull();
  }, 30_000);

  it('appears when the text falls short, and its confirmation names the parts it will rewrite', async () => {
    await seedWorld();
    await mountCanvas();

    const button = screen.getByTestId('canvas-fix-problems');
    expect(button).toHaveTextContent('Fix module problems');
    // A LIVE control offers the DESCRIPTION of what pressing it does — a `title`
    // is a surface the owner can reach only while the control can act, so this
    // is where that copy belongs (docs/18 §4, ledger 125). The state that holds
    // the control is stated by the wrapper, and only there.
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute(
      'title',
      'Rewrite the parts whose text falls short of the encounter floor',
    );
    await userEvent.click(button);

    const dialog = await screen.findByTestId('canvas-fix-problems-dialog');
    const items = within(dialog).getAllByTestId('canvas-fix-problem');
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent('Part 2 — The Drowned Cathedral');
    expect(items[0]).toHaveTextContent('the encounter floor needs 1, the text names 0');
    // Nothing entity-side is on this list, and the dialog says what it will not
    // touch rather than hiding it.
    expect(within(dialog).queryByTestId('canvas-fix-problems-reported')).toBeNull();
    expect(within(dialog).getByText(/rewrites the module TEXT only/)).toBeInTheDocument();
  }, 30_000);

  it('rewrites the named part through the repair seam, snapshots first, and the control disappears', async () => {
    await seedWorld();
    chatMock
      .mockResolvedValueOnce(prose('PART-TWO-REPAIRED', ['Flood Trial']))
      .mockResolvedValueOnce(encounterReply('Bell Trial', 'Flood Trial'));
    await mountCanvas();

    await userEvent.click(screen.getByTestId('canvas-fix-problems'));
    await userEvent.click(await screen.findByTestId('canvas-fix-problems-confirm'));
    await flushAsyncUpdates();
    await waitFor(async () => {
      const row = await getModule(world.moduleId);
      expect(row?.parts.find((part) => part.planIndex === 1)?.markdown).toContain(
        'PART-TWO-REPAIRED',
      );
    });

    // The row's own text changed, through the ONE part-text save path.
    const row = await getModule(world.moduleId);
    const repaired = row?.parts.find((part) => part.planIndex === 1);
    expect(repaired?.markdown).toContain('PART-TWO-REPAIRED');
    expect(row?.parts.find((part) => part.planIndex === 0)?.markdown).toContain('PART-ONE');
    // The pre-repair text is a durable version (the undo), and the normalization
    // pass's own snapshot sits beside it.
    const versions = await listModuleVersions(world.moduleId);
    const fixSnapshot = versions.find((version) => version.label.includes('Fix module problems'));
    expect(fixSnapshot).toBeDefined();
    expect(fixSnapshot?.docText).toContain('PART-TWO: The drowned cathedral waits');
    expect(fixSnapshot?.docText).not.toContain('PART-TWO-REPAIRED');
    // …and it is RESTORABLE: it passes the restore door's own gate (the stored
    // document must split against the CURRENT part plan, which is what
    // `restoreDurableVersion` checks before proposing) and its part 2 is the
    // pre-repair text byte-for-byte.
    const plan = (await getModule(world.moduleId))?.spine?.partPlan ?? [];
    const snapshotParts = splitPartsDocument(fixSnapshot?.docText ?? '', plan);
    expect(snapshotParts.find((part) => part.planIndex === 1)?.text).toContain(
      'PART-TWO: The drowned cathedral waits',
    );
    expect(snapshotParts.find((part) => part.planIndex === 1)?.text).not.toContain(
      'PART-TWO-REPAIRED',
    );
    // The canvas re-seeded from the row: the preview shows the repaired text.
    expect(screen.getByTestId('canvas-preview')).toHaveTextContent('PART-TWO-REPAIRED');
    // The floor is met now, so the control is gone without a reload.
    await waitFor(() => {
      expect(screen.queryByTestId('canvas-fix-problems')).toBeNull();
    });
  }, 30_000);

  it('fails loudly and writes nothing when the rewrite cannot be repaired', async () => {
    await seedWorld();
    // A reply that cannot be a part: far too short for the part contract.
    chatMock.mockResolvedValueOnce({ text: 'nope', modelUsed: 'test-model', fallback: null });
    const before = await getModule(world.moduleId);
    await mountCanvas();

    await userEvent.click(screen.getByTestId('canvas-fix-problems'));
    await userEvent.click(await screen.findByTestId('canvas-fix-problems-confirm'));
    await flushAsyncUpdates();
    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalled();
    });

    const after = await getModule(world.moduleId);
    expect(after?.parts.find((part) => part.planIndex === 1)?.markdown).toBe(
      before?.parts.find((part) => part.planIndex === 1)?.markdown,
    );
    // The snapshot precedes the ATTEMPT (the seam cannot know an outcome before
    // calling the model), and it holds the unchanged pre-repair text: restoring
    // it is a no-op. Safety over tidiness — no rewrite may ever run without a
    // prior recorded version.
    const versions = await listModuleVersions(world.moduleId);
    expect(versions.map((version) => version.docText)).toEqual([
      (await import('@/domain')).assembleModulePartsDocument({
        partPlan: PART_PLAN,
        parts: after?.parts ?? [],
      }).document,
    ]);
    expect(toastErrorMock).toHaveBeenCalled();
    // The problem is still there, so the control stays for a retry.
    expect(screen.getByTestId('canvas-fix-problems')).toBeInTheDocument();
  }, 30_000);

  it('is disabled with an honest reason while the editor holds unsaved edits — through the device, never in a title', async () => {
    const user = userEvent.setup();
    await seedWorld();
    await mountCanvasEditor(user);

    act(() => {
      activeCanvasView.current?.dispatch({ changes: { from: 0, insert: 'X' } });
    });
    await flushAsyncUpdates();

    await expectBlockedReason(
      user,
      'canvas-fix-problems',
      'Save or discard your edits first — this action rewrites the module text on disk, not the editor copy.',
    );
    // The reason lives ONLY in the wrapper (docs/18 §4, ledger 125): the `title`
    // used to carry `derivedBlocked ?? <description>`, so the held control stated
    // the same sentence twice and one of the two was a surface no browser renders.
    // The description survives on the ENABLED control (its own pin above) — it is
    // simply never offered on a control that cannot act.
    expect(screen.getByTestId('canvas-fix-problems')).not.toHaveAttribute('title');
  }, 30_000);
});

describe('"Resume automatic module creation" on the canvas', () => {
  /** Intent asks for npc entities + their images; the text names Kael. */
  const INTENT = {
    autoGenerateKinds: ['npc' as const],
    autoImageKinds: ['npc' as const],
    autoGenerateBattlemaps: false,
    autoGenerateMobImages: false,
  };

  async function seedResumable(): Promise<void> {
    await seedWorld();
    const seeded = await getModule(world.moduleId);
    if (seeded === undefined) throw new Error('the seeded module row is missing');
    await saveModule({
      ...seeded,
      autoGenerateKinds: INTENT.autoGenerateKinds,
      autoImageKinds: INTENT.autoImageKinds,
      automationIntent: INTENT,
      entityKinds: [
        { name: 'Bell Trial', kind: 'encounter', absorbed: [] },
        { name: 'Kael', kind: 'npc', absorbed: [] },
      ],
      parts: [
        modulePartSchema.parse({
          planIndex: 0,
          markdown: prose('PART-ONE', ['Bell Trial', 'Kael']).text,
          status: 'ready',
          errorMessage: '',
          edited: false,
        }),
        modulePartSchema.parse({
          planIndex: 1,
          markdown: prose('PART-TWO', ['Kael']).text,
          status: 'ready',
          errorMessage: '',
          edited: false,
        }),
      ],
    });
  }

  it('is absent for a legacy row (nothing was recorded to resume)', async () => {
    await seedWorld();

    await mountCanvas();

    expect(screen.queryByTestId('canvas-resume-automation')).toBeNull();
  }, 30_000);

  it('names what is missing in its confirmation and generates only that', async () => {
    await seedResumable();
    chatMock.mockResolvedValueOnce({
      text: JSON.stringify(npcDraft),
      modelUsed: 'test-model',
      fallback: null,
    });
    await mountCanvas();

    const button = screen.getByTestId('canvas-resume-automation');
    expect(button).toHaveTextContent('Resume automatic module creation');
    await userEvent.click(button);

    const dialog = await screen.findByTestId('canvas-resume-automation-dialog');
    const lines = within(dialog).getAllByTestId('canvas-resume-automation-line');
    // The confirmation lists what is missing RIGHT NOW: the image of an entity
    // that does not exist yet is not a separate promise — it follows from the
    // entity itself being generated (the same sweep queues it).
    expect(lines.map((line) => line.textContent)).toEqual([
      '1 npc named by the text but not generated yet: Kael',
    ]);

    await userEvent.click(within(dialog).getByTestId('canvas-resume-automation-confirm'));
    await waitFor(() => {
      // The image the promised entity needs is queued for exactly that entity.
      expect(enqueueImageJobs).toHaveBeenCalledWith([
        { campaignId: world.campaignId, moduleId: world.moduleId, name: 'Kael' },
      ]);
    });

    const artifacts = await listArtifactsByCampaign(world.campaignId);
    const npcs = artifacts.filter((artifact) => artifact.kind === 'npc');
    expect(npcs.map((artifact) => artifact.name)).toEqual(['Kael']);
    // The entity landed, the image job is QUEUED but not finished (this test
    // never pumps the queue), so the control stays — honestly: the image the
    // owner asked for does not exist yet. Its second line is what is left.
    await waitFor(async () => {
      await userEvent.click(await screen.findByTestId('canvas-resume-automation'));
      const again = await screen.findByTestId('canvas-resume-automation-dialog');
      expect(
        within(again)
          .getAllByTestId('canvas-resume-automation-line')
          .map((line) => line.textContent),
      ).toEqual(['1 npc without an image: Kael']);
    });
  }, 30_000);

  it('turns on after a HAND EDIT with no stored flag on the row', async () => {
    await seedResumable();
    // The owner finishes the work by hand: the npc exists with an image, so
    // nothing is missing and the control is away.
    const kael = await createArtifact({
      campaignId: world.campaignId,
      moduleId: world.moduleId,
      kind: 'npc',
      name: 'Kael',
      summary: '',
      body: '',
      coverImageId: '00000000-0000-4000-8000-00000000d001',
      data: { appearance: '', personality: '', statBlock: null },
    });
    await mountCanvas();
    expect(screen.queryByTestId('canvas-resume-automation')).toBeNull();

    // The owner hand-edits the text and links a name no pass has seen.
    const row = await getModule(world.moduleId);
    if (row === undefined) throw new Error('the module row is missing');
    await saveModule({
      ...row,
      parts: row.parts.map((part) =>
        part.planIndex === 1
          ? { ...part, markdown: `${part.markdown}\n\n[[Mira]] sells the tide charts.` }
          : part,
      ),
    });
    await flushAsyncUpdates();

    const button = await screen.findByTestId('canvas-resume-automation');
    await userEvent.click(button);
    const dialog = await screen.findByTestId('canvas-resume-automation-dialog');
    expect(within(dialog).getByTestId('canvas-resume-automation-list')).toHaveTextContent('Mira');

    // The verdict is nowhere on the row: the state that turned the control on is
    // the text itself.
    const persisted = await getModule(world.moduleId);
    const keys = Object.keys(persisted ?? {});
    expect(keys).not.toContain('deviates');
    expect(keys).not.toContain('hasProblems');
    expect(keys).not.toContain('needsWork');
    expect(keys).not.toContain('automationDeviation');
    expect((await listArtifactsByCampaign(world.campaignId)).find((a) => a.id === kael.id)).toBeDefined();
  }, 30_000);

  it('is a no-op with an honest notice when the confirmation is stale', async () => {
    await seedResumable();
    await mountCanvas();
    await userEvent.click(screen.getByTestId('canvas-resume-automation'));
    const dialog = await screen.findByTestId('canvas-resume-automation-dialog');

    // The work lands by other means while the dialog is open (the owner's other
    // tab, a hand edit, the entity panel). The write lands in the SAME tick as
    // the mounted canvas's live queries, so it runs inside `actDrained`: a bare
    // `await saveModule(...)` hands the loop to `useModule`'s re-emission
    // (dexie-react-hooks → CanvasPage's own setState) and then to the Base UI
    // dialog internals the re-render wakes, all outside act (docs/08-TESTING.md
    // §Console guard). Measured at this site by delaying the cause — an extra
    // bare await right after the write made the un-cured test fail 9/9 with the
    // act warnings (`CanvasPage`, then `AlertDialogRoot`/`DialogPortal`/
    // `DialogBackdrop`/`DialogPopup`), and the drained write absorbs them 9/9.
    // The raw `getModule` read two lines up is NOT a site (250ms of delay there
    // left the test green 4/4): nothing is pending before the write.
    const row = await getModule(world.moduleId);
    if (row === undefined) throw new Error('the module row is missing');
    await actDrained(() =>
      saveModule({
        ...row,
        parts: row.parts.map((part) => ({ ...part, markdown: part.markdown.replaceAll('[[Kael]]', 'the watchman') })),
        entityKinds: [{ name: 'Bell Trial', kind: 'encounter', absorbed: [] }],
      }),
    );
    chatMock.mockClear();

    await userEvent.click(within(dialog).getByTestId('canvas-resume-automation-confirm'));
    await waitFor(() => {
      expect(toastInfoMock).toHaveBeenCalledWith(
        'Nothing is missing any more — the module already has everything creation was asked to automate.',
      );
    });

    expect(chatMock).not.toHaveBeenCalled();
    expect(enqueueImageJobs).not.toHaveBeenCalled();
    expect(enqueueEncounterMaps).not.toHaveBeenCalled();
    expect(enqueueMobPortraits).not.toHaveBeenCalled();
    expect(await listArtifactsByCampaign(world.campaignId)).toHaveLength(1);
  }, 30_000);

  it('states the dirty-editor reason through the device, and offers its description only while LIVE', async () => {
    const user = userEvent.setup();
    await seedResumable();
    await mountCanvasEditor(user);

    // Live: the description of what the action does is on the control — a
    // `title` is a surface only a control that can act ever exposes.
    expect(screen.getByTestId('canvas-resume-automation')).toHaveAttribute(
      'title',
      'Generate only what creation was asked to automate and the module does not have yet',
    );

    // Unsaved editor edits hold it, and the reason is stated by the wrapper —
    // the same expression the `title` used to restate (docs/18 §4, ledger 125).
    act(() => {
      activeCanvasView.current?.dispatch({ changes: { from: 0, insert: 'X' } });
    });
    await flushAsyncUpdates();
    await expectBlockedReason(
      user,
      'canvas-resume-automation',
      'Save or discard your edits first — this action rewrites the module text on disk, not the editor copy.',
    );
    expect(screen.getByTestId('canvas-resume-automation')).not.toHaveAttribute('title');
    await flushAsyncUpdates();
  }, 30_000);
});
