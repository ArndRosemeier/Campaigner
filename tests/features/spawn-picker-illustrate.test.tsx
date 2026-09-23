import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { createArtifact, listArtifactsByCampaign } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { creaturePortraitArt, setCreatureCover } from '@/db/creatureRepo';
import { createImage } from '@/db/imageRepo';
import { createRulebook, updateRulebook } from '@/db/rulebookRepo';
import { listBattlesByModule } from '@/db/battleRepo';
import { seedBattleFromEncounter } from '@/db/battleSeed';
import {
  createModule,
  libraryCreatureKey,
  monsterEntrySchema,
  type Id,
  type MonsterEntry,
} from '@/domain';
import { createModule as saveModule } from '@/db/moduleRepo';
import { SpawnPicker } from '@/features/play/battle/SpawnPicker';
import { authoredPortraitKey } from '@/features/campaign/mob-portrait-participants';
import { toastError } from '@/lib/toast';
import { actDrained } from '../helpers/flush';
import { addSpawnPickerChunk, spawnPickerStatBlock } from '../helpers/spawn-picker-fixtures';
import { clearDatabase } from '../db/helpers';

/**
 * The spawn picker's "illustrate mobs with no image" checkbox (docs/17 row
 * 333, part 1). The owner's ask, verbatim: *"i would like an image checkbox to
 * illustrate mobs that don't have an image"*.
 *
 * The pins are the three the contract turns on:
 * 1. UNTICKED (the default) enqueues NOTHING — a spawn is byte-for-byte the
 *    spawn it always was;
 * 2. TICKED enqueues EXACTLY the creature the pick created, through the
 *    existing single-mob portrait seam, with the identity and the grounds the
 *    pick group already holds;
 * 3. ALREADY-ILLUSTRATED is NEVER touched — on the campaign's presentation row
 *    AND on an authored npc's own cover (the read the narrower
 *    `creaturePortraitArt` gets wrong, docs/11 D6).
 */

// The portrait seam is observed, never replaced: the real queue is what every
// other test exercises, and this file only counts enqueues and reads the target
// the picker hands it.
vi.mock('@/features/campaign/mob-portrait-queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/campaign/mob-portrait-queue')>();
  return { ...actual, enqueueSingleMobPortrait: vi.fn(actual.enqueueSingleMobPortrait) };
});

vi.mock('@/lib/toast', () => ({
  toastError: vi.fn(),
  toastErrorPersistent: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
}));

const { enqueueSingleMobPortrait } = await import('@/features/campaign/mob-portrait-queue');
const enqueueMock = vi.mocked(enqueueSingleMobPortrait);

let campaignId = '';
let moduleId = '';
let battleId = '';
let trollId = '';
let vexraId = '';
let wispId = '';
let goblinChunkId: Id = '';
let wyrmChunkId: Id = '';
let roster: MonsterEntry[] = [];

async function aPortraitImage(): Promise<Id> {
  const image = await createImage({
    campaignId,
    blob: new Blob(['fake-png-bytes'], { type: 'image/png' }),
    mimeType: 'image/png',
    width: 64,
    height: 64,
    prompt: 'a portrait',
    model: 'test/image-model',
    source: 'generated',
  });
  return image.id;
}

async function addNpc(
  name: string,
  level: string | null,
  hp: number,
  coverImageId?: Id,
): Promise<Id> {
  const npc = await createArtifact({
    campaignId,
    kind: 'npc',
    name,
    ...(coverImageId === undefined ? {} : { coverImageId }),
    data: {
      appearance: '',
      personality: '',
      statBlock: level === null ? null : spawnPickerStatBlock(level, hp),
    },
  });
  return npc.id;
}

beforeEach(async () => {
  await clearDatabase();
  vi.resetAllMocks();
  // jsdom has no layout: virtual-core reads the scroll element's
  // offsetWidth/offsetHeight synchronously (both 0 in jsdom), so the mob
  // window would render empty (the spawn-picker family's own stub).
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 600 });

  campaignId = (await createCampaign({ name: 'Illustrate fill', system: 'dnd5e' })).id;
  const book = await createRulebook({ title: 'Core Bestiary', system: 'dnd5e', filename: 'core.pdf' });
  await updateRulebook(book.id, { status: 'ready', pageCount: 320 });
  goblinChunkId = await addSpawnPickerChunk(book.id, 'Goblin Boss', '1', 21);
  wyrmChunkId = await addSpawnPickerChunk(book.id, 'Ancient Wyrm', '12', 200);

  // Vexra already carries her OWN cover (the authored-lane art).
  vexraId = await addNpc('Vexra', '3', 30, await aPortraitImage());
  trollId = await addNpc('Troll', '2', 84);
  wispId = await addNpc('Wisp', null, 0);

  roster = [
    monsterEntrySchema.parse({
      name: 'Troll',
      count: 1,
      notes: '',
      treasure: '',
      source: { type: 'npc-ref', artifactId: trollId },
    }),
  ];
  const encounter = await createArtifact({
    campaignId,
    kind: 'encounter',
    name: 'Bridge ambush',
    data: {
      difficulty: 'medium',
      levelHint: '',
      partyLevel: 3,
      monsters: roster,
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
    createModule({
      campaignId,
      title: 'Illustrate Module',
      concept: '',
      levelMin: 1,
      levelMax: 5,
      sizeDial: 'sketch',
    }),
  );
  moduleId = module.id;
  await seedBattleFromEncounter(campaignId, moduleId, encounter.id);
  const [battle] = await listBattlesByModule(moduleId);
  if (battle === undefined) throw new Error('battle row missing');
  battleId = battle.id;
});

afterEach(async () => {
  cleanup();
  delete (HTMLElement.prototype as unknown as { offsetWidth?: unknown }).offsetWidth;
  delete (HTMLElement.prototype as unknown as { offsetHeight?: unknown }).offsetHeight;
});

async function currentBattle() {
  return actDrained(async () => {
    const [row] = await listBattlesByModule(moduleId);
    if (row === undefined) throw new Error('battle row missing');
    return row;
  });
}

async function renderPicker(): Promise<void> {
  const artifacts = await listArtifactsByCampaign(campaignId);
  render(
    <SpawnPicker
      open
      onOpenChange={() => undefined}
      battleId={battleId}
      campaignId={campaignId}
      roster={roster}
      encounterName="Bridge ambush"
      artifacts={artifacts}
    />,
  );
  await waitFor(() => {
    expect(screen.getByTestId('spawn-picker-group-roster')).toBeInTheDocument();
  });
  await waitFor(() => {
    expect(screen.getByTestId('spawn-picker-group-mobs')).toHaveTextContent('Goblin Boss');
  });
}

async function tick(): Promise<void> {
  await userEvent.setup().click(screen.getByTestId('spawn-picker-illustrate'));
  expect(screen.getByTestId('spawn-picker-illustrate')).toHaveAttribute('aria-checked', 'true');
}

describe('spawn picker illustrate fill (docs/17 row 333, part 1)', () => {
  it('is OFF by default and enqueues NOTHING while unticked', async () => {
    await renderPicker();
    expect(screen.getByTestId('spawn-picker-illustrate')).toHaveAttribute('aria-checked', 'false');
    await userEvent.setup().click(screen.getByTestId('spawn-pick-roster-0'));
    await waitFor(async () => {
      const battle = await currentBattle();
      expect(battle.board.tokens.some((token) => token.label === 'Troll 2')).toBe(true);
    });
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('ticked enqueues the spawned NPC with its identity and its OWN artifact as the ground', async () => {
    await renderPicker();
    await tick();
    await userEvent.setup().click(screen.getByTestId('spawn-pick-roster-0'));
    await waitFor(() => {
      expect(enqueueMock).toHaveBeenCalledTimes(1);
    });
    expect(enqueueMock).toHaveBeenCalledWith({
      campaignId,
      creatureKey: authoredPortraitKey(trollId),
      name: 'Troll',
      artifactId: trollId,
    });
  });

  it('ticked enqueues a core mob through its CITATION grounds (chunk identity + its own copied block)', async () => {
    await renderPicker();
    await tick();
    await userEvent.setup().click(screen.getByTestId(`spawn-pick-mob-${goblinChunkId}`));
    await waitFor(() => {
      expect(enqueueMock).toHaveBeenCalledTimes(1);
    });
    const target = enqueueMock.mock.calls[0]?.[0];
    expect(target?.creatureKey).toBe(libraryCreatureKey(goblinChunkId));
    expect(target?.name).toBe('Goblin Boss');
    // `buildMobPickEntry` builds a CONVERTED copy: its own block grounds the
    // prompt and no library chunk is read (`rosterParticipantRoute`'s one rule).
    expect(target?.statBlock).toBeDefined();
    expect(target?.chunkId).toBeUndefined();
    expect(target?.artifactId).toBeUndefined();
  });

  it('NEVER touches a creature that already has art — presentation row OR an npc own cover', async () => {
    // (a) the campaign's presentation row for a library creature already exists.
    await setCreatureCover({
      campaignId,
      creatureKey: libraryCreatureKey(wyrmChunkId),
      imageId: await aPortraitImage(),
    });
    await renderPicker();
    await tick();
    await userEvent.setup().click(screen.getByTestId(`spawn-pick-mob-${wyrmChunkId}`));
    await waitFor(async () => {
      const battle = await currentBattle();
      expect(battle.board.tokens.some((token) => token.label === 'Ancient Wyrm 1')).toBe(true);
    });
    expect(enqueueMock).not.toHaveBeenCalled();

    // (b) an authored npc whose portrait is its OWN cover. This is the arm the
    // narrow read gets wrong: `creaturePortraitArt` reads ONLY the presentation
    // row, so it calls this illustrated npc "missing" — the docs/11 D6 defect
    // whose cure is the wider `creatureCoverImageId` read.
    expect(await creaturePortraitArt(campaignId, authoredPortraitKey(vexraId))).toBe('none');
    await userEvent.setup().click(screen.getByTestId(`spawn-pick-npc-${vexraId}`));
    await waitFor(async () => {
      const battle = await currentBattle();
      expect(battle.board.tokens.some((token) => token.label === 'Vexra 1')).toBe(true);
    });
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(vi.mocked(toastError)).not.toHaveBeenCalled();
  });

  it('ticked enqueues a cover-less authored NPC, and a statless one, through the same seam', async () => {
    await renderPicker();
    await tick();
    const user = userEvent.setup();
    await user.click(screen.getByTestId(`spawn-pick-npc-${wispId}`));
    await waitFor(() => {
      expect(enqueueMock).toHaveBeenCalledTimes(1);
    });
    // The statless Wisp still has no art — it is enqueued as an ordinary
    // authored npc (the spawn itself already reported the missing STATS).
    expect(enqueueMock).toHaveBeenCalledWith({
      campaignId,
      creatureKey: authoredPortraitKey(wispId),
      name: 'Wisp',
      artifactId: wispId,
    });
  });
});
