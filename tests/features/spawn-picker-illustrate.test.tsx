import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
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
import type * as mobPortraitQueueModule from '@/features/campaign/mob-portrait-queue';
import { SpawnPicker } from '@/features/play/battle/SpawnPicker';
import { authoredPortraitKey } from '@/features/campaign/mob-portrait-participants';
import { toastError } from '@/lib/toast';
import { addSpawnPickerChunk, spawnPickerStatBlock } from '../helpers/spawn-picker-fixtures';
import { currentBattle } from '../helpers/battle-surface-route';
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
  const actual = await importOriginal<typeof mobPortraitQueueModule>();
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

afterEach(() => {
  cleanup();
  delete (HTMLElement.prototype as unknown as { offsetWidth?: unknown }).offsetWidth;
  delete (HTMLElement.prototype as unknown as { offsetHeight?: unknown }).offsetHeight;
});

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
      const battle = await currentBattle(moduleId);
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
      const battle = await currentBattle(moduleId);
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
      const battle = await currentBattle(moduleId);
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

/**
 * DEFECT B and DEFECT C of docs/17 row 336.
 *
 * B: the owner authored a mob and reported *"Also, I do not see a checkbox to
 * illustrate it."* — the ONE illustrate control lived in the dialog HEADER
 * only. It is now offered in the AUTHOR section too, as the SAME control bound
 * to the SAME `illustrateMissing` flag and the same illustrate path.
 *
 * C: *"the spawn buttons for non authored mobs are overlapping on my ipad"*.
 * The dialog now fits a short viewport with the BODY as the only scroller (the
 * header and both ticks stay outside it), and every pick row is built so the
 * label truncates in its own track and the action never shrinks.
 *
 * WHAT THESE PINS CANNOT PROVE, STATED RATHER THAN IMPLIED: jsdom computes no
 * layout, so no pin here — or anywhere in this suite — can observe the owner's
 * actual overlap or the pixels of a dialog on a 768×1024 iPad. These pins
 * assert the STRUCTURE the fix turned on (which element scrolls, which classes
 * carry the truncation/shrink contract); the visual result owes a real-device
 * check, recorded in docs/08 §Battle-surface test families and in docs/17 row
 * 336.
 */
describe('spawn picker layout + the illustrate control in the author section (docs/17 row 336, defects B and C)', () => {
  it('offers the SAME illustrate choice in the author section, bound to the ONE flag (defect B)', async () => {
    await renderPicker();
    const authorSection = screen.getByTestId('spawn-picker-author');
    const authorTick = within(authorSection).getByTestId('spawn-picker-author-illustrate');
    const headerTick = screen.getByTestId('spawn-picker-illustrate');
    expect(authorTick).toHaveAttribute('aria-checked', 'false');
    expect(headerTick).toHaveAttribute('aria-checked', 'false');

    // One state: ticking EITHER placement shows on BOTH.
    const user = userEvent.setup();
    await user.click(authorTick);
    expect(authorTick).toHaveAttribute('aria-checked', 'true');
    expect(headerTick).toHaveAttribute('aria-checked', 'true');
    await user.click(headerTick);
    expect(headerTick).toHaveAttribute('aria-checked', 'false');
    expect(authorTick).toHaveAttribute('aria-checked', 'false');
  });

  it('illustrates through the ONE path when the AUTHOR tick is the one used (defect B)', async () => {
    await renderPicker();
    await userEvent.setup().click(screen.getByTestId('spawn-picker-author-illustrate'));
    await userEvent.setup().click(screen.getByTestId('spawn-pick-roster-0'));
    await waitFor(() => {
      expect(enqueueMock).toHaveBeenCalledTimes(1);
    });
    // The same target the header tick produces: one flag, one path.
    expect(enqueueMock).toHaveBeenCalledWith({
      campaignId,
      creatureKey: authoredPortraitKey(trollId),
      name: 'Troll',
      artifactId: trollId,
    });
  });

  it('keeps the header and both illustrate ticks OUTSIDE the only scroller, in a viewport-bounded dialog (defect C)', async () => {
    await renderPicker();
    const dialog = screen.getByTestId('spawn-picker');
    const body = screen.getByTestId('spawn-picker-body');

    // The dialog is a flex column bounded by the viewport and NOT itself a
    // scroller — so a short iPad viewport cannot push the header off screen.
    expect(dialog.className).toContain('max-h-[85dvh]');
    expect(dialog.className).toContain('flex-col');
    expect(dialog.className).toContain('overflow-hidden');

    // THE BODY IS THE ONLY SCROLLER inside the dialog.
    const scrollers = [...dialog.querySelectorAll('.overflow-y-auto')];
    expect(scrollers).toEqual([body]);
    expect(body.className).toContain('min-h-0');
    expect(body.className).toContain('flex-1');

    // The header's controls stay reachable: neither the search field nor the
    // header's illustrate tick is inside the scrolling body.
    expect(within(body).queryByTestId('spawn-picker-illustrate')).toBeNull();
    expect(within(body).queryByTestId('spawn-picker-search')).toBeNull();
    expect(within(body).queryByTestId('spawn-picker-sort')).toBeNull();
  });

  it('makes every pick row collision-proof — label truncates, action never shrinks (defect C)', async () => {
    await renderPicker();
    const body = screen.getByTestId('spawn-picker-body');
    const actions = [
      screen.getByTestId('spawn-pick-roster-0'),
      ...[...body.querySelectorAll('[data-testid^="spawn-pick-npc-"]')],
      ...[...body.querySelectorAll('[data-testid^="spawn-pick-mob-"]')],
    ];
    // Every group is represented, or this pin would be vacuous.
    expect(actions.length).toBeGreaterThanOrEqual(4);
    for (const action of actions) {
      expect(action.className).toContain('shrink-0');
    }
    // Every row pairs its action with a label that truncates inside the row.
    const rows = [
      ...body.querySelectorAll('li'),
      ...body.querySelectorAll('[data-testid="spawn-picker-mob-row"]'),
    ];
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const row of rows) {
      const label = row.querySelector('span');
      expect(label?.className).toContain('min-w-0');
      expect(label?.className).toContain('truncate');
      expect(row.querySelector('button')).not.toBeNull();
    }
    // IN-FLOW rows may wrap the action onto its own line; the VIRTUALIZED mob
    // rows must not (their height is the virtualizer's, so wrapping would
    // overlap the next row — the very defect being fixed).
    for (const row of body.querySelectorAll('li')) {
      expect(row.className).toContain('flex-wrap');
    }
    for (const row of body.querySelectorAll('[data-testid="spawn-picker-mob-row"]')) {
      expect(row.className).not.toContain('flex-wrap');
    }
  });
});
