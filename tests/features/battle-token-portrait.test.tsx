import 'fake-indexeddb/auto';

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { createArtifact, getAnyArtifact, updateArtifact } from '@/db/artifactRepo';
import { db } from '@/db/db';
import { getBattleByModule } from '@/db/battleRepo';
import { seedBattleFromEncounter } from '@/db/battleSeed';
import { createCampaign } from '@/db/campaignRepo';
import { putChunks } from '@/db/chunkRepo';
import { createImage } from '@/db/imageRepo';
import { createModule, statBlockSchema } from '@/domain';
import { createModule as saveModule } from '@/db/moduleRepo';
import { createRulebook } from '@/db/rulebookRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { updateSettings } from '@/db/settingsRepo';
import { ruleChunkSchema, stampNewEntity } from '@/domain';
import { sha256Hex } from '@/lib/hash';
import { useMobPortraitQueue } from '@/features/campaign/mob-portrait-queue';
import type * as MobPortraitQueue from '@/features/campaign/mob-portrait-queue';
import { __clearPendingMobPortraitGenerationsForTests } from '@/features/campaign/mob-portrait-cache-queue';
import { useProgressStore } from '@/lib/progress';
import { BattleSurface } from '@/features/play/battle/BattleSurface';
import { clearDatabase } from '../db/helpers';
import { actDrained, flushAsyncUpdates } from '../helpers/flush';

/**
 * Battle-card mob portrait action (docs/11 D5): the selection card gains a
 * GM-only portrait action for rulebook-cited mobs — "Generate portrait" when
 * cover-less, "Regenerate portrait" (editor confirm + canonical-republish
 * semantics) when imaged — through the EXISTING queue entries. Tokens whose
 * mob has no rulebook chunk offer no action; player-safe view never does.
 *
 * The queue module is a pass-through spy (real queue, mocked image backend),
 * so generate/regen assertions prove the wiring end-to-end: the call AND the
 * cover landing on the token's artifact.
 */

vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {},
  OpenRouterError: class OpenRouterError extends Error {},
  listModels: vi.fn(),
  fetchWithHeadersTimeout: vi.fn(),
}));
vi.mock('@/llm/imageGen', () => ({ generateImages: vi.fn() }));
vi.mock('@/lib/imageIntake', () => ({ intakeImage: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn(), toastInfo: vi.fn() }));
vi.mock('@/features/campaign/mob-portrait-queue', async (importOriginal) => {
  const actual = await importOriginal<typeof MobPortraitQueue>();
  return {
    ...actual,
    enqueueSingleMobPortrait: vi.fn(actual.enqueueSingleMobPortrait),
    regenerateSingleMobPortrait: vi.fn(actual.regenerateSingleMobPortrait),
  };
});

const { generateImages } = await import('@/llm/imageGen');
const generateImagesMock = vi.mocked(generateImages);
const { intakeImage } = await import('@/lib/imageIntake');
const intakeImageMock = vi.mocked(intakeImage);
const { toastSuccess, toastInfo, toastError } = await import('@/lib/toast');
const toastSuccessMock = vi.mocked(toastSuccess);
const toastInfoMock = vi.mocked(toastInfo);
const toastErrorMock = vi.mocked(toastError);
const { enqueueSingleMobPortrait, regenerateSingleMobPortrait } = await import(
  '@/features/campaign/mob-portrait-queue'
);
const enqueueSingleMock = vi.mocked(enqueueSingleMobPortrait);
const regenerateSingleMock = vi.mocked(regenerateSingleMobPortrait);

const BOARD_W = 800;
const BOARD_H = 600;
const CONTENT_H = 450;
const CONTENT_TOP = 75;

const containerRect = {
  x: 0, y: 0, top: 0, left: 0, bottom: BOARD_H, right: BOARD_W,
  width: BOARD_W, height: BOARD_H, toJSON: () => ({}),
};
let contentRect = {
  x: 0, y: CONTENT_TOP, top: CONTENT_TOP, left: 0,
  bottom: CONTENT_TOP + CONTENT_H, right: BOARD_W,
  width: BOARD_W, height: CONTENT_H, toJSON: () => ({}),
};

const GOBLIN_TEXT = 'Goblin Boss, humanoid, agile commander. HP 21, AC 17.';

function blobOf(text: string): Blob {
  return new Blob([text], { type: 'image/png' });
}

function statBlock(over: Record<string, unknown> = {}) {
  return statBlockSchema.parse({
    system: 'dnd5e',
    level: '1',
    size: 'Medium',
    creatureType: 'humanoid',
    ac: 12,
    acNote: '',
    hp: 10,
    hpFormula: '',
    speed: '30 ft.',
    abilities: { str: 10, dex: 14, con: 12, int: 10, wis: 10, cha: 10 },
    saves: '',
    skills: '',
    senses: '',
    languages: '',
    cr: '1/2',
    proficiency: 2,
    traits: [],
    actions: [],
    reactions: [],
    legendary: [],
    extras: {},
    ...over,
  });
}

let campaignId = '';
let generationCount = 0;

class ResizeObserverStub {
  callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe(element: Element): void {
    const rect =
      element.getAttribute('data-board-content') === 'true'
        ? { width: contentRect.width, height: contentRect.height }
        : { width: BOARD_W, height: BOARD_H };
    queueMicrotask(() => {
      act(() => {
        this.callback([{ contentRect: rect } as ResizeObserverEntry], this);
      });
    });
  }
  /* eslint-disable @typescript-eslint/no-empty-function */
  unobserve(): void {}
  disconnect(): void {}
  /* eslint-enable @typescript-eslint/no-empty-function */
}

beforeEach(async () => {
  await clearDatabase();
  contentRect = {
    x: 0, y: CONTENT_TOP, top: CONTENT_TOP, left: 0,
    bottom: CONTENT_TOP + CONTENT_H, right: BOARD_W,
    width: BOARD_W, height: CONTENT_H, toJSON: () => ({}),
  };
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element,
  ) {
    return this.getAttribute('data-board-content') === 'true'
      ? { ...contentRect }
      : { ...containerRect };
  });
  campaignId = (await createCampaign({ name: 'Token portrait', system: 'dnd5e' })).id;
  await seedBuiltInPersonas();
  await updateSettings({ imagesEnabled: true, imageModel: 'test-image-model' });
  // Pass-through spies keep their real implementations — clear calls only.
  enqueueSingleMock.mockClear();
  regenerateSingleMock.mockClear();
  toastSuccessMock.mockClear();
  toastInfoMock.mockClear();
  toastErrorMock.mockClear();
  generateImagesMock.mockReset();
  intakeImageMock.mockReset();
  __clearPendingMobPortraitGenerationsForTests();
  useMobPortraitQueue.getState().reset();
  useProgressStore.getState().reset();
  generationCount = 0;
  generateImagesMock.mockImplementation(() => {
    generationCount += 1;
    return Promise.resolve({
      images: [blobOf(`gen-${String(generationCount)}`)],
      costUsd: 0.01,
      cappedToOne: false,
      modelUsed: 'test-image-model',
      fallback: null,
      filteredCount: 0,
    });
  });
  intakeImageMock.mockImplementation((blob: Blob) =>
    Promise.resolve({ blob, mimeType: 'image/webp', width: 320, height: 240 }),
  );
});

afterEach(async () => {
  await flushAsyncUpdates(20);
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function seedCreatureChunk(creatureName: string, text: string): Promise<string> {
  const book = await createRulebook({ title: 'Bestiary', system: 'dnd5e', filename: 'bestiary.pdf' });
  await putChunks([
    ruleChunkSchema.parse({
      ...stampNewEntity(),
      bookId: book.id,
      pageStart: 12,
      pageEnd: 12,
      chunkType: 'statblock',
      headingPath: [creatureName],
      text,
      statBlock: statBlockSchema.parse({
        system: 'dnd5e',
        level: '2',
        size: 'Large',
        creatureType: 'giant',
        ac: 11,
        acNote: '',
        hp: 59,
        hpFormula: '7d10 + 21',
        speed: '40 ft.',
        abilities: { str: 20, dex: 8, con: 16, int: 5, wis: 7, cha: 7 },
        saves: '',
        skills: '',
        senses: 'darkvision 60 ft.',
        languages: 'Common, Giant',
        traits: [],
        actions: [],
        reactions: [],
        legendary: [],
        extras: {},
      }),
      contentHash: await sha256Hex(text),
    }),
  ]);
  const chunk = await db.chunks.where('bookId').equals(book.id).first();
  if (chunk === undefined) throw new Error('chunk missing');
  return chunk.id;
}

async function seedRulebookBattle(): Promise<{ moduleId: string; chunkId: string }> {
  const chunkId = await seedCreatureChunk('Goblin Boss', GOBLIN_TEXT);
  const encounter = await createArtifact({
    campaignId,
    kind: 'encounter',
    name: 'Goblin warren',
    data: {
      difficulty: 'medium',
      levelHint: '1',
      monsters: [{ name: 'Goblin Boss', count: 1, notes: '', treasure: '', source: { type: 'rulebook', chunkId } }],
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
  const module = await saveModule(
    createModule({ campaignId, title: 'Portrait Module', concept: '', levelMin: 1, levelMax: 5, sizeDial: 'sketch' }),
  );
  await seedBattleFromEncounter(campaignId, module.id, encounter.id);
  return { moduleId: module.id, chunkId };
}

async function seedNpcRefBattle(): Promise<{ moduleId: string; npcId: string; pcId: string }> {
  const pc = await createArtifact({
    campaignId,
    kind: 'pc',
    name: 'Serren',
    data: { playerName: '', statBlock: statBlock({ hp: 20 }), currentHp: 20, initiativeOverride: null, notes: '' },
  });
  const npc = await createArtifact({
    campaignId,
    kind: 'npc',
    name: 'Troll',
    data: { appearance: '', personality: '', statBlock: statBlock({ hp: 84 }) },
  });
  const encounter = await createArtifact({
    campaignId,
    kind: 'encounter',
    name: 'Bridge ambush',
    data: {
      difficulty: 'deadly',
      levelHint: '5',
      monsters: [{ name: 'Troll', count: 1, notes: '', treasure: '', source: { type: 'npc-ref', artifactId: npc.id } }],
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
  const module = await saveModule(
    createModule({ campaignId, title: 'Portrait Module', concept: '', levelMin: 1, levelMax: 5, sizeDial: 'sketch' }),
  );
  await seedBattleFromEncounter(campaignId, module.id, encounter.id);
  return { moduleId: module.id, npcId: npc.id, pcId: pc.id };
}

async function renderSurface(moduleId: string): Promise<void> {
  render(
    <MemoryRouter initialEntries={[`/c/${campaignId}/m/${moduleId}/battle`]}>
      <Routes>
        <Route path="/c/:campaignId/m/:moduleId/battle" element={<BattleSurface />} />
      </Routes>
    </MemoryRouter>,
  );
  await waitFor(() => {
    expect(screen.getByTestId('battle-board')).toBeInTheDocument();
  });
  await flushAsyncUpdates(20);
}

async function currentBattle(moduleId: string) {
  const battle = await actDrained(async () => {
    const row = await getBattleByModule(moduleId);
    if (row === undefined) throw new Error('battle row missing');
    return row;
  });
  return battle;
}

async function tapToken(label: string, moduleId: string): Promise<void> {
  const battle = await currentBattle(moduleId);
  const token = battle.board.tokens.find((entry) => entry.label === label);
  if (token === undefined) throw new Error(`${label} missing`);
  const el = screen
    .getAllByTestId('battle-token')
    .find((element) => element.getAttribute('data-token-label') === label);
  if (el === undefined) throw new Error(`${label} element missing`);
  fireEvent.pointerDown(el, { pointerId: 2, clientX: token.x * BOARD_W, clientY: CONTENT_TOP + token.y * CONTENT_H });
  fireEvent.pointerUp(el, { pointerId: 2 });
  await flushAsyncUpdates();
}

async function tokenArtifactId(moduleId: string, label: string): Promise<string> {
  const battle = await currentBattle(moduleId);
  const token = battle.board.tokens.find((entry) => entry.label === label);
  if (token?.artifactId === null || token?.artifactId === undefined) throw new Error(`${label} has no artifact`);
  return token.artifactId;
}

describe('battle-card mob portrait action', () => {
  it('cover-less rulebook mob offers Generate (never Regenerate); clicking enqueues the single job and the cover lands on the token artifact', async () => {
    const { moduleId, chunkId } = await seedRulebookBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    await tapToken('Goblin Boss', moduleId);

    expect(screen.getByTestId('selection-card')).toBeInTheDocument();
    expect(screen.getByTestId('generate-token-portrait')).toHaveTextContent('Generate portrait');
    expect(screen.queryByTestId('regenerate-token-portrait')).toBeNull();

    const user = userEvent.setup();
    await user.click(screen.getByTestId('generate-token-portrait'));
    const artifactId = await tokenArtifactId(moduleId, 'Goblin Boss');
    await waitFor(() => {
      expect(enqueueSingleMock).toHaveBeenCalledTimes(1);
    });
    expect(enqueueSingleMock).toHaveBeenCalledWith({ campaignId, artifactId, chunkId, name: 'Goblin Boss' });
    // The same queue the editor batch uses lands the cover on the token's
    // mob artifact (tokens render it via the existing coverImageId path).
    await waitFor(async () => {
      expect((await getAnyArtifact(artifactId))?.coverImageId).not.toBeNull();
    });
    expect(generateImagesMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).not.toHaveBeenCalled();
    await flushAsyncUpdates();
  });

  it('imaged rulebook mob offers Regenerate (never Generate); Confirm regenerates with the canonical-republish toasts', async () => {
    const { moduleId, chunkId } = await seedRulebookBattle();
    // Populate the canonical slot + cover through the normal flow first, so
    // regen republishes fresh bytes (gen-1 → gen-2).
    const artifactId = await tokenArtifactId(moduleId, 'Goblin Boss');
    enqueueSingleMock.getMockImplementation()?.({ campaignId, artifactId, chunkId, name: 'Goblin Boss' });
    await waitFor(async () => {
      expect((await getAnyArtifact(artifactId))?.coverImageId).not.toBeNull();
    });
    const oldCover = (await getAnyArtifact(artifactId))?.coverImageId ?? '';
    enqueueSingleMock.mockClear();
    generateImagesMock.mockClear();

    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    await tapToken('Goblin Boss', moduleId);

    expect(screen.queryByTestId('generate-token-portrait')).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('regenerate-token-portrait'));
    const dialog = await screen.findByTestId('token-portrait-regen-dialog');
    expect(dialog.textContent).toMatch(/Regenerate portrait\?/);
    expect(screen.getByTestId('token-portrait-regen-copy').textContent).toMatch(/"Goblin Boss"/);
    expect(screen.getByTestId('token-portrait-regen-copy').textContent).toMatch(/Existing cover is replaced/);
    expect(screen.getByTestId('token-portrait-regen-copy').textContent).toMatch(/shows initials/);

    await user.click(screen.getByTestId('token-portrait-regen-confirm'));
    await waitFor(() => {
      expect(regenerateSingleMock).toHaveBeenCalledTimes(1);
    });
    expect(regenerateSingleMock).toHaveBeenCalledWith({ campaignId, artifactId, chunkId, name: 'Goblin Boss' });
    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalledWith(
        'Regenerating portrait for "Goblin Boss" — the existing cover is replaced',
      );
    });
    // Canonical citation → the loud shared-consequence toast, SAME copy as
    // the editor section.
    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalledWith(
        'Shared portrait republished for "Goblin Boss" — future portraits in every campaign use the new art; existing covers elsewhere keep theirs',
      );
    });
    // Fresh bytes replaced the old cover on the token's artifact.
    await waitFor(async () => {
      const cover = (await getAnyArtifact(artifactId))?.coverImageId;
      expect(cover).not.toBeNull();
      expect(cover).not.toBe(oldCover);
    });
    await flushAsyncUpdates();
  });

  it('regen Cancel regenerates nothing and replays the already-has-portrait toast', async () => {
    const { moduleId } = await seedRulebookBattle();
    const artifactId = await tokenArtifactId(moduleId, 'Goblin Boss');
    const uploaded = await createImage({
      campaignId,
      blob: blobOf('old'),
      mimeType: 'image/png',
      width: 10,
      height: 10,
      source: 'uploaded',
    });
    await updateArtifact(artifactId, { imageIds: [uploaded.id], coverImageId: uploaded.id });

    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    await tapToken('Goblin Boss', moduleId);

    const user = userEvent.setup();
    await user.click(screen.getByTestId('regenerate-token-portrait'));
    await screen.findByTestId('token-portrait-regen-dialog');
    await user.click(screen.getByTestId('token-portrait-regen-cancel'));

    await waitFor(() => {
      expect(toastInfoMock).toHaveBeenCalledWith('"Goblin Boss" already has a portrait');
    });
    expect(regenerateSingleMock).not.toHaveBeenCalled();
    expect(generateImagesMock).not.toHaveBeenCalled();
    expect((await getAnyArtifact(artifactId))?.coverImageId).toBe(uploaded.id);
    await flushAsyncUpdates();
  });

  it('chunk-less tokens (real NPC, PC) offer no portrait action — no dead affordance', async () => {
    const { moduleId } = await seedNpcRefBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });

    await tapToken('Troll', moduleId);
    expect(screen.getByTestId('selection-card')).toBeInTheDocument();
    expect(screen.queryByTestId('generate-token-portrait')).toBeNull();
    expect(screen.queryByTestId('regenerate-token-portrait')).toBeNull();
    expect(screen.queryByTestId('token-portrait-regen-dialog')).toBeNull();

    await tapToken('Serren', moduleId);
    const card = screen.getByTestId('selection-card');
    expect(within(card).getByTestId('selection-card-name')).toHaveTextContent('Serren');
    expect(screen.queryByTestId('generate-token-portrait')).toBeNull();
    expect(screen.queryByTestId('regenerate-token-portrait')).toBeNull();
    expect(enqueueSingleMock).not.toHaveBeenCalled();
    await flushAsyncUpdates();
  });

  it('player-safe view hides the portrait action for a cover-less rulebook mob', async () => {
    const { moduleId } = await seedRulebookBattle();
    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId('player-safe-toggle'));
    await tapToken('Goblin Boss', moduleId);

    // The card still shows (name + image + HP only) but the GM-only action
    // never mounts — and the portrait button stays a pure lightbox opener.
    expect(screen.getByTestId('selection-card')).toBeInTheDocument();
    expect(screen.queryByTestId('token-controls')).toBeNull();
    expect(screen.queryByTestId('generate-token-portrait')).toBeNull();
    expect(screen.queryByTestId('regenerate-token-portrait')).toBeNull();
    expect(enqueueSingleMock).not.toHaveBeenCalled();
    await flushAsyncUpdates();
  });

  it('player-safe view hides the portrait action for an imaged rulebook mob', async () => {
    const { moduleId } = await seedRulebookBattle();
    const artifactId = await tokenArtifactId(moduleId, 'Goblin Boss');
    const uploaded = await createImage({
      campaignId,
      blob: blobOf('old'),
      mimeType: 'image/png',
      width: 10,
      height: 10,
      source: 'uploaded',
    });
    await updateArtifact(artifactId, { imageIds: [uploaded.id], coverImageId: uploaded.id });

    await renderSurface(moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId('player-safe-toggle'));
    await tapToken('Goblin Boss', moduleId);

    expect(screen.getByTestId('selection-card')).toBeInTheDocument();
    expect(screen.queryByTestId('generate-token-portrait')).toBeNull();
    expect(screen.queryByTestId('regenerate-token-portrait')).toBeNull();
    await flushAsyncUpdates();
  });
});
