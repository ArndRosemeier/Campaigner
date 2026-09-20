import 'fake-indexeddb/auto';

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { createArtifact, getAnyArtifact, getArtifact } from '@/db/artifactRepo';
import { db } from '@/db/db';
import { seedBattleFromEncounter } from '@/db/battleSeed';
import { createCampaign } from '@/db/campaignRepo';
import { putChunks } from '@/db/chunkRepo';
import { createImage } from '@/db/imageRepo';
import { creatureCoverImageId, setCreatureCover } from '@/db/creatureRepo';
import { retryLibraryAdoptions } from '@/db/libraryAdoptRetry';
import { createModule, globalArtifactSchema, statBlockSchema } from '@/domain';
import { createModule as saveModule } from '@/db/moduleRepo';
import { createRulebook } from '@/db/rulebookRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { updateSettings } from '@/db/settingsRepo';
import { libraryCreatureKey, ruleChunkSchema, stampNewEntity } from '@/domain';
import { sha256Hex } from '@/lib/hash';
import { useMobPortraitQueue } from '@/features/campaign/mob-portrait-queue';
import type * as MobPortraitQueue from '@/features/campaign/mob-portrait-queue';
import { __clearPendingMobPortraitGenerationsForTests } from '@/features/campaign/mob-portrait-cache-queue';
import { useProgressStore } from '@/lib/progress';
import { currentBattle, renderSurface } from '../helpers/battle-surface-route';
import { clearDatabase } from '../db/helpers';
import { flushAsyncUpdates } from '../helpers/flush';

/**
 * Battle-card mob portrait action (docs/11 D5): the selection card gains a
 * GM-only portrait action for rulebook-cited mobs — "Generate portrait" when
 * cover-less, "Regenerate portrait" (editor confirm + canonical-republish
 * semantics) when imaged — through the EXISTING queue entries. Tokens whose
 * mob has no rulebook chunk offer no action; player-safe view never does.
 *
 * The queue module is a pass-through spy (real queue, mocked image backend),
 * so generate/regen assertions prove the wiring end-to-end: the call AND the
 * portrait landing where the board reads it.
 *
 * REWRITTEN (ledger row 106): the token used to name a hidden `npc` artifact
 * that WAS the creature, and the portrait landed on that row's cover. A
 * rulebook token carries `artifactId: null` now (docs/11 D1/D5) and the board
 * resolves its portrait through `creatureCoverImageId` — so the assertions
 * below read the campaign's PRESENTATION row via that same production seam,
 * which is what makes them a statement about the real render path rather than
 * about a test-only lookup.
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

/** The campaign's portrait for a library creature, read through the SAME seam
 * the board uses. */
async function creaturePortrait(chunkId: string): Promise<string | null> {
  return creatureCoverImageId({ campaignId, creatureKey: libraryCreatureKey(chunkId) });
}

/** Seed a portrait for a library creature exactly as a batch would: a
 * campaign-scoped image plus the presentation row that points at it. */
async function seedCreaturePortrait(chunkId: string, text: string): Promise<string> {
  const image = await createImage({
    campaignId,
    blob: blobOf(text),
    mimeType: 'image/png',
    width: 10,
    height: 10,
    source: 'uploaded',
  });
  await setCreatureCover({
    campaignId,
    creatureKey: libraryCreatureKey(chunkId),
    imageId: image.id,
  });
  return image.id;
}

describe('battle-card mob portrait action', () => {
  it('cover-less rulebook mob offers Generate (never Regenerate); clicking enqueues the single job and the cover lands on the token artifact', async () => {
    const { moduleId, chunkId } = await seedRulebookBattle();
    await renderSurface(campaignId, moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    await tapToken('Goblin Boss', moduleId);

    expect(screen.getByTestId('selection-card')).toBeInTheDocument();
    expect(screen.getByTestId('generate-token-portrait')).toHaveTextContent('Generate portrait');
    expect(screen.queryByTestId('regenerate-token-portrait')).toBeNull();

    const user = userEvent.setup();
    await user.click(screen.getByTestId('generate-token-portrait'));
    await waitFor(() => {
      expect(enqueueSingleMock).toHaveBeenCalledTimes(1);
    });
    // NO artifactId: a library creature has no artifact to illustrate, so the
    // target names the identity and the campaign — the token's `artifactId` is
    // null by design and reading it here would be reading a retired field.
    expect(enqueueSingleMock).toHaveBeenCalledWith({
      campaignId,
      creatureKey: libraryCreatureKey(chunkId),
      chunkId,
      name: 'Goblin Boss',
    });
    // The token identifies its creature by `creatureKey`, and its `artifactId`
    // is a SYNTHETIC seed-row id (db/battleSeed) that names no artifact at all —
    // so the old "hang the portrait on the token's artifact" assertion was
    // pinning a row that does not exist.
    const token = (await currentBattle(moduleId)).board.tokens.find(
      (entry) => entry.label === 'Goblin Boss',
    );
    expect(token?.creatureKey).toBe(libraryCreatureKey(chunkId));
    expect(await getAnyArtifact(token?.artifactId ?? '')).toBeUndefined();
    // The same queue the editor batch uses lands the portrait on the campaign's
    // presentation row — the row the board itself resolves through.
    await waitFor(async () => {
      expect(await creaturePortrait(chunkId)).not.toBeNull();
    });
    expect(generateImagesMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).not.toHaveBeenCalled();
    await flushAsyncUpdates();
  });

  it('imaged rulebook mob offers Regenerate (never Generate); Confirm regenerates with the canonical-republish toasts', async () => {
    const { moduleId, chunkId } = await seedRulebookBattle();
    // Seed the portrait through the production seam first, so regen republishes
    // fresh bytes (gen-1 → gen-2).
    const oldCover = await seedCreaturePortrait(chunkId, 'old');
    enqueueSingleMock.mockClear();
    generateImagesMock.mockClear();

    await renderSurface(campaignId, moduleId);
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
    expect(screen.getByTestId('token-portrait-regen-copy').textContent).toMatch(/stays until the new art lands/);

    await user.click(screen.getByTestId('token-portrait-regen-confirm'));
    await waitFor(() => {
      expect(regenerateSingleMock).toHaveBeenCalledTimes(1);
    });
    expect(regenerateSingleMock).toHaveBeenCalledWith({
      campaignId,
      creatureKey: libraryCreatureKey(chunkId),
      chunkId,
      name: 'Goblin Boss',
    });
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
    // Fresh bytes replaced the old portrait on the campaign's presentation row.
    await waitFor(async () => {
      const cover = await creaturePortrait(chunkId);
      expect(cover).not.toBeNull();
      expect(cover).not.toBe(oldCover);
    });
    await flushAsyncUpdates();
  });

  it('regen Cancel regenerates nothing and replays the already-has-portrait toast', async () => {
    const { moduleId, chunkId } = await seedRulebookBattle();
    const uploaded = await seedCreaturePortrait(chunkId, 'old');

    await renderSurface(campaignId, moduleId);
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
    expect(await creaturePortrait(chunkId)).toBe(uploaded);
    await flushAsyncUpdates();
  });

  it('chunk-less tokens (real NPC, PC) offer no portrait action — no dead affordance', async () => {
    const { moduleId } = await seedNpcRefBattle();
    await renderSurface(campaignId, moduleId);
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
    await renderSurface(campaignId, moduleId);
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
    const { moduleId, chunkId } = await seedRulebookBattle();
    await seedCreaturePortrait(chunkId, 'old');

    await renderSurface(campaignId, moduleId);
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

/**
 * THE BATTLE CARD READS THE SEEDED COPY (docs/17 row 255b). The token's
 * `chunk:<id>` key used to make the card re-resolve the library, so a seeded
 * battle lost its AC and attacks the moment the pack was uninstalled. The seed
 * row now freezes the block, and the surface reads THAT — proved here with the
 * chunk DELETED, through the real render path (not a repo call).
 */
describe('battle-card stat block with the library uninstalled', () => {
  it('keeps AC and HP from the frozen seed row after the chunk is deleted', async () => {
    const { moduleId, chunkId } = await seedRulebookBattle();
    // UNINSTALL the pack the mob came from.
    await db.chunks.clear();
    await db.rulebooks.clear();

    await renderSurface(campaignId, moduleId);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    await tapToken('Goblin Boss', moduleId);

    const card = screen.getByTestId('selection-card');
    const statBlock = within(card).getByTestId('selection-card-statblock');
    expect(within(statBlock).getByText('AC').parentElement?.textContent).toContain('11');
    expect(within(statBlock).getByText('HP').parentElement?.textContent).toContain('59');
    // The token still identifies its creature by the frozen identity token —
    // the copy keeps the portrait slot without the library.
    const token = (await currentBattle(moduleId)).board.tokens.find(
      (entry) => entry.label === 'Goblin Boss',
    );
    expect(token?.creatureKey).toBe(libraryCreatureKey(chunkId));
    await flushAsyncUpdates();
  });

  /**
   * docs/17 row 259 — THE OWNER'S SCENARIO, through the real render path. A
   * battle seeded from a LIBRARY npc cites the library row; adoption repoints
   * the token at the campaign's own copy, and the card then renders with the
   * library row DELETED (his "i refetch the monster core, references break"
   * story). Before the repoint the same delete leaves the card with no block at
   * all — the silent degradation this row closes.
   */
  it('renders a token seeded from a LIBRARY npc after adoption, with the library row DELETED', async () => {
    const libraryNpc = globalArtifactSchema.parse({
      ...stampNewEntity(),
      campaignId: null,
      moduleId: null,
      kind: 'npc',
      name: 'Vale Sage',
      tags: [],
      aliases: [],
      summary: '',
      body: '',
      links: [],
      currentRevision: 1,
      imageIds: [],
      coverImageId: null,
      writerModel: '',
      data: { appearance: '', personality: '', statBlock: statBlock({ ac: 16, hp: 84 }) },
    });
    await db.artifacts.put(libraryNpc);
    const encounter = await createArtifact({
      campaignId,
      kind: 'encounter',
      name: 'Ford ambush',
      data: {
        difficulty: 'medium',
        levelHint: '5',
        monsters: [
          {
            name: 'Vale Sage',
            count: 1,
            notes: '',
            treasure: '',
            source: { type: 'npc-ref', artifactId: libraryNpc.id },
          },
        ],
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
      createModule({ campaignId, title: 'Adopt Module', concept: '', levelMin: 1, levelMax: 5, sizeDial: 'sketch' }),
    );
    await seedBattleFromEncounter(campaignId, module.id, encounter.id);

    // BEFORE: the token cites the LIBRARY row.
    const before = await currentBattle(module.id);
    expect(before.board.tokens[0]?.artifactId).toBe(libraryNpc.id);

    // ADOPT through the seam's retry caller (the v27 backfill's own entry),
    // then DELETE the library row.
    await retryLibraryAdoptions();
    const copyId = (await currentBattle(module.id)).board.tokens[0]?.artifactId ?? '';
    expect(copyId).not.toBe(libraryNpc.id);
    expect((await getAnyArtifact(copyId))?.copiedFromArtifactId).toBe(libraryNpc.id);
    await db.artifacts.delete(libraryNpc.id);
    expect(await getAnyArtifact(libraryNpc.id)).toBeUndefined();

    // RENDER: the card reads the campaign's copy.
    await renderSurface(campaignId, module.id);
    await waitFor(() => {
      expect(screen.getAllByTestId('battle-token').length).toBeGreaterThan(0);
    });
    await tapToken('Vale Sage', module.id);
    const card = screen.getByTestId('selection-card');
    const block = within(card).getByTestId('selection-card-statblock');
    expect(within(block).getByText('AC').parentElement?.textContent).toContain('16');
    expect(within(block).getByText('HP').parentElement?.textContent).toContain('84');
    await flushAsyncUpdates();
  });
});

/**
 * docs/17 row 268 — THE OWNER'S ACCEPTANCE THROUGH THE REAL RENDER PATH. A
 * battle seeded from a LIBRARY-scoped encounter is KEYED to the campaign's own
 * adopted copy (never the library row), so deleting the library row leaves the
 * board and its provenance intact — and a route still naming the LIBRARY
 * encounter (a URL typed before the v29 re-key) resolves through that copy
 * rather than rendering the empty state.
 *
 * The owner's correction, verbatim: *"why is there still an identity reference?
 * I do not want any that is stored. I want campaign data completely isolated
 * from libraries, completely, not mostly."*
 */
describe('a battle seeded from a LIBRARY encounter (docs/17 row 268)', () => {
  it('opens with the library row DELETED, from a route that still names the library encounter', async () => {
    const libraryEncounter = globalArtifactSchema.parse({
      ...stampNewEntity(),
      campaignId: null,
      moduleId: null,
      kind: 'encounter',
      name: 'Ford ambush',
      tags: [],
      aliases: [],
      summary: '',
      body: '',
      links: [],
      currentRevision: 1,
      imageIds: [],
      coverImageId: null,
      writerModel: '',
      data: {
        difficulty: 'medium',
        levelHint: '5',
        monsters: [{ name: 'Stamp', count: 1, notes: '', treasure: '', source: { type: 'none' } }],
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
    await db.artifacts.put(libraryEncounter);
    const module = await saveModule(
      createModule({ campaignId, title: 'Library Encounter Module', concept: '', levelMin: 1, levelMax: 5, sizeDial: 'sketch' }),
    );
    const { battle } = await seedBattleFromEncounter(campaignId, module.id, libraryEncounter.id);
    // The KEY is campaign-owned and its stored origin names the library row…
    expect(battle.encounterArtifactId).not.toBe(libraryEncounter.id);
    expect((await getArtifact(battle.encounterArtifactId ?? ''))?.copiedFromArtifactId).toBe(
      libraryEncounter.id,
    );
    // …and the LIBRARY row is DELETED before the table opens.
    await db.artifacts.delete(libraryEncounter.id);
    expect(await getAnyArtifact(libraryEncounter.id)).toBeUndefined();

    // The ROUTE still names the LIBRARY encounter — the stale-URL arm — and the
    // board plus its provenance still render, read through the campaign copy.
    await renderSurface(campaignId, module.id, { encounterId: libraryEncounter.id });
    const provenance = screen.getByTestId('battle-provenance');
    expect(provenance.textContent).toContain('Ford ambush');
    expect(provenance.textContent).not.toContain('no longer exists');
    await flushAsyncUpdates();
  });
});
