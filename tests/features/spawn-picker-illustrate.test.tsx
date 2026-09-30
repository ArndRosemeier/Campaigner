import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

    // The dialog is a flex column with a DEFINITE height (not only a cap), and
    // NOT itself a scroller — so a short iPad viewport cannot push the header off
    // screen (the height's units are pinned separately, docs/17 rows 340 and 343).
    expect(dialog.className).toContain('h-[85vh]');
    expect(dialog.className).toContain('supports-[height:100svh]:h-[min(85svh,85dvh)]');
    expect(dialog.className).toContain('flex-col');
    expect(dialog.className).toContain('overflow-hidden');

    // THE BODY IS THE ONLY SCROLLER inside the dialog — including any
    // `overflow-auto`/`overflow-scroll` box, which is how the Core-mobs list
    // used to scroll INSIDE the body (docs/17 row 340).
    const scrollers = [...dialog.querySelectorAll('*')].filter((element) =>
      /(^|\s)overflow(-[xy])?-(auto|scroll)(\s|$)/.test(element.className),
    );
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

/**
 * THE VIRTUALIZED CORE-MOBS ROWS (docs/17 row 339). Owner, verbatim: *"Core
 * mobs also have overlapping spawn buttons."*
 *
 * WHY THE VERTICAL DEFECT IS THIS GROUP'S ALONE. The two in-flow groups lay
 * their rows out in a `space-y-1` list: a row that grows pushes the next one
 * down. The Core-mobs list is VIRTUALIZED — its rows are absolutely positioned at
 * `translateY(item.start)` and, until this row, forced to `height: item.size`,
 * where `item.size` was the 44px ESTIMATE. The row's content is REM-based (the
 * `sm` action button carries `pointer-coarse:min-h-11` = 2.75rem, and
 * `app/theme/uiScale` multiplies the root font-size by `--ui-scale`, 0.9–2), so
 * it is 44px tall only at scale 1 on a fine pointer. On the owner's iPad the
 * pointer is COARSE — at scale 1 the button alone exactly eats the row's 4px
 * vertical padding, so adjacent buttons touch, and at scale > 1 a 48.4–88px
 * button overflows the 44px box and overlaps the neighbouring rows. The estimate
 * is now the row's FLOOR and the virtualizer MEASURES, so `item.start` is a real
 * height.
 *
 * HOW A TEST WITH NO LAYOUT SEES IT. jsdom computes no boxes, but the
 * VIRTUALIZER reads the row's own rect — so these pins stub the mob rows' rect at
 * 60px and require the row PITCH and the track height to follow the MEASUREMENT,
 * never the estimate, plus the inline-style shape that keeps the measurement from
 * being self-fulfilling. What no pin here can see is the real overlap or the
 * pixels of a 768x1024 iPad: those owe a real-device check (docs/08
 * §Battle-surface test families, docs/17 row 339).
 */
describe('spawn picker Core-mobs rows are MEASURED, not sized by the estimate (docs/17 row 339)', () => {
  /**
   * The mob rows answer `height`; every other element keeps jsdom's zero box, so
   * nothing outside the list learns a fiction.
   */
  function stubMobRowRect(height: number): void {
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      writable: true,
      value(this: HTMLElement) {
        return new DOMRect(0, 0, 0, this.dataset.testid === 'spawn-picker-mob-row' ? height : 0);
      },
    });
  }

  afterEach(() => {
    delete (HTMLElement.prototype as unknown as { getBoundingClientRect?: unknown })
      .getBoundingClientRect;
  });

  it('spaces the rows by the MEASURED height, never by the 44px estimate', async () => {
    stubMobRowRect(60);
    await renderPicker();
    const rows = screen.getAllByTestId('spawn-picker-mob-row');
    // The fixture's two core mobs must both be mounted, or the pitch pin below
    // would be vacuous.
    expect(rows.length).toBeGreaterThanOrEqual(2);
    // A 44px pitch IS the defect's shape, so wait for the MEASURED one.
    await waitFor(() => {
      expect(rows[1]?.style.transform).toBe('translateY(60px)');
    });
    for (const [index, row] of rows.entries()) {
      expect(row.style.transform, `row ${String(index)}`).toBe(
        `translateY(${String(index * 60)}px)`,
      );
    }
    // The scroll track is the summed measured height, not count × 44.
    expect(rows[0]?.parentElement?.style.height).toBe(`${String(rows.length * 60)}px`);
  });

  it('gives each row a FLOOR, never a fixed height, so the measurement cannot be self-fulfilling', async () => {
    await renderPicker();
    const [row] = screen.getAllByTestId('spawn-picker-mob-row');
    // `height: item.size` made the row 44px by DECREE: the element could then
    // never report the 48.4–88px its own action button needs at --ui-scale > 1,
    // so the measurement would confirm the estimate forever.
    expect(row?.style.height).toBe('');
    expect(row?.style.minHeight).toBe('44px');
  });

  it('keeps every Core-mobs label on ONE truncating line beside a shrink-0 action', async () => {
    await renderPicker();
    const rows = screen.getAllByTestId('spawn-picker-mob-row');
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) {
      const label = row.querySelector('span');
      expect(label?.className).toContain('whitespace-nowrap');
      expect(label?.className).toContain('truncate');
      expect(label?.className).toContain('min-w-0');
      expect(row.querySelector('button')?.className).toContain('shrink-0');
    }
  });

  it('gives the dialog a DEFINITE height whose PLAIN fallback is the CONSERVATIVE value, refined by `svh` behind @supports (docs/17 row 343)', async () => {
    await renderPicker();
    const dialog = screen.getByTestId('spawn-picker');
    // A DEFINITE height, not only a `max-h` cap: `flex-1 min-h-0` on the body
    // needs a definite parent height to resolve against, and a container bounded
    // only by `max-height` can leave the body at its content height where
    // `overflow-hidden` clips the excess — no scrollbar and no scroll, which
    // matches the owner's *"Still can't scroll an I also see no scroll bar"*.
    // That is the WORKING DIAGNOSIS (docs/17 row 343): its evidence is the in-repo
    // CONTROL `HelpDialog`, which ships this same body under a definite `h-[80vh]`,
    // and the device check that would confirm or falsify it is OWED. A
    // `fit-content` height is NOT a substitute: it is an intrinsic, indefinite
    // size, so it does not bound the flex child either — the value has to be a
    // LENGTH, and it lives in `DIALOG_VIEWPORT_BOX`.
    expect(dialog.className).toContain('h-[85vh]');
    // The row-340 shape must not come back: a `max-h` VIEWPORT CAP is not a
    // definite height, and under the working diagnosis above that is the shape
    // WebKit clips (the `DIALOG_VIEWPORT_BOX` doc carries the diagnosis, the
    // `HelpDialog` control and the owed tablet check). The plain `85vh` survives
    // an old iPad that drops `@supports` because it leaves 15% of the large
    // viewport as headroom against Safari's ~9% of bars.
    expect(dialog.className).not.toContain('max-h-[85vh]');
    // The shared base's BELT stays and must be the CONSERVATIVE one: a browser
    // that drops `@supports` gets it too, and `calc(100vh-2rem)` (row 340's plain
    // value) is the LARGE viewport again.
    expect(dialog.className).toContain('max-h-[calc(85vh-2rem)]');
    expect(dialog.className).not.toContain('max-h-[calc(100vh-2rem)]');
    // The REFINEMENT is the better value where the units are known: `svh` is the
    // viewport with the bars SHOWING, so it cannot exceed what he can see, and
    // `min(svh, dvh)` still follows a dynamic shrink (the keyboard).
    expect(dialog.className).toContain('supports-[height:100svh]:h-[min(85svh,85dvh)]');
    expect(dialog.className).toContain('flex-col');
    expect(dialog.className).toContain('overflow-hidden');
  });
});

/**
 * ONE SCROLL CONTAINER IN THE SPAWN DIALOG — the BODY — and a DEFINITE height
 * whose PLAIN fallback is the safe value (docs/17 rows 340 and 343).
 * Owner, verbatim: *"Spawn dialog now does not scroll anymore on my ipad"* — the
 * regression he hit right after rows 336 and 339 reshaped this dialog — and then,
 * after row 340, *"Still can't scroll an I also see no scroll bar"*.
 *
 * THREE CANDIDATE MECHANISMS, and the fix has to be right for ALL of them because
 * jsdom can settle NONE. Two are ruled out by the evidence and one is the WORKING
 * DIAGNOSIS, whose evidence is an IN-REPO CONTROL and whose device check is OWED:
 * (1) `85vh` as the large viewport cannot explain it (`85vh` fits an iPad in both
 * orientations: Safari's bars are ~90px and 15% of 1024 is ~150px); (2) the dialog
 * body scrolled AND the Core-mobs list scrolled inside it, while the row
 * measurement changed the inner content size mid-drag, a classic way for touch
 * momentum to be swallowed; (3) a `flex-1 min-h-0` child inside an ancestor whose
 * height is `auto` plus a `max-height` does not reliably get a bounded height on
 * WebKit, so it grows to its content height and the ancestor's `overflow-hidden`
 * clips it — no scrollbar AND no scroll, the two symptoms together, with many
 * screens of content. THE CONTROL is `HelpDialog`, which ships this same body
 * under a DEFINITE `h-[80vh]`: the height TYPE is the only difference from the
 * failing picker, which is the strongest evidence the repo can offer by itself,
 * and it is still an inference rather than a measurement on the device. So there
 * is ONE scroller (the body), the Core-mobs list no longer scrolls, the
 * virtualizer's scroll element is the body (windowed in the body's CONTENT
 * coordinates: the track's own offset is the `scrollMargin`, because the roster
 * and NPC groups sit above it), and the dialog carries the shared DEFINITE height
 * `DIALOG_VIEWPORT_BOX` (`85vh`, with the `svh`-bounded `min(85svh,85dvh)` as the
 * `@supports` REFINEMENT) with the shared `DIALOG_SCROLL_BODY` as its body. The
 * plain value must fit with the bars showing, because an iOS that does not know
 * `svh`/`dvh` keeps ONLY the plain one and `vh` there is the large viewport.
 *
 * WHAT NO PIN HERE CAN PROVE, STATED RATHER THAN IMPLIED: jsdom computes no
 * layout and cannot scroll by touch or momentum, so NOTHING in this file — or
 * anywhere in this suite — can establish that the dialog scrolls on the owner's
 * iPad, and NOTHING here measures the inferred mechanism above. These pins assert
 * the STRUCTURE the fix turns on (which element is the scroller, which element the
 * virtualizer observes, the coordinate space its window is computed in, and the
 * height's units); the REAL-DEVICE CHECK IS OWED and is the only thing that can
 * confirm the diagnosis (docs/08 §Battle-surface test families, docs/11 §Spawn
 * picker, docs/17 rows 340 and 343).
 */
describe('spawn picker scrolls through ONE container, the dialog body (docs/17 row 340)', () => {
  afterEach(() => {
    delete (HTMLElement.prototype as unknown as { getBoundingClientRect?: unknown })
      .getBoundingClientRect;
  });

  /**
   * The row-339 `renderPicker` waits for BOTH fixture mobs to render, which a
   * real `scrollMargin` correctly prevents while the list is still below the
   * fold — so this pin waits for the TRACK and drives the scroll itself.
   */
  async function renderToTrack(): Promise<void> {
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
      expect(screen.getByTestId('spawn-picker-mob-track')).toBeInTheDocument();
    });
  }

  it('observes the BODY for scroll, and leaves the Core-mobs list without a scroller of its own', async () => {
    const addSpy = vi.spyOn(HTMLElement.prototype, 'addEventListener');
    try {
      await renderPicker();
      const body = screen.getByTestId('spawn-picker-body');
      const list = screen.getByTestId('spawn-picker-mob-list');
      // The virtualizer attaches its scroll listener to `getScrollElement()` —
      // so the element that RECEIVES the observation IS the scroll element.
      const scrollTargets = addSpy.mock.calls
        .map((call, index) => ({ type: call[0], self: addSpy.mock.instances[index] }))
        .filter((entry) => entry.type === 'scroll')
        .map((entry) => entry.self);
      expect(scrollTargets).toContain(body);
      expect(scrollTargets).not.toContain(list);
      // The body is the ONE scroller; the list carries no scroll box and no
      // height cap of its own (the `max-h-56 overflow-auto` of rows 336/339).
      expect(body.className).toContain('overflow-y-auto');
      expect(list.className).not.toMatch(/overflow|max-h-/);
    } finally {
      addSpy.mockRestore();
    }
  });

  it('windows the list in the BODY’s coordinates — the track’s own offset is the scrollMargin', async () => {
    const TRACK_TOP = 1000;
    const ROW_HEIGHT = 60;
    // The track sits BELOW the roster and NPC groups and jsdom lays out none of
    // that, so the offset is stubbed here; the row rects answer 60px (the row-339
    // measurement arm) and every other element keeps jsdom's zero box.
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      writable: true,
      value(this: HTMLElement) {
        const testId = this.dataset.testid;
        const top = testId === 'spawn-picker-mob-track' ? TRACK_TOP : 0;
        const height = testId === 'spawn-picker-mob-row' ? ROW_HEIGHT : 0;
        return new DOMRect(0, top, 0, height);
      },
    });
    await renderToTrack();
    const body = screen.getByTestId('spawn-picker-body');
    // The finger drags the Core-mobs list up to the top of the body.
    body.scrollTop = TRACK_TOP;
    fireEvent.scroll(body);
    await waitFor(() => {
      const rows = screen.getAllByTestId('spawn-picker-mob-row');
      // The FIRST row is the first VISIBLE row, sitting at the TRACK's own
      // origin. Without the `scrollMargin` the window is shifted down by the
      // groups above the track and this index is far higher; without the
      // subtraction in the transform the row would sit `TRACK_TOP` px down.
      expect(rows[0]?.dataset.index).toBe('0');
      expect(rows[0]?.style.transform).toBe('translateY(0px)');
      expect(rows[1]?.style.transform).toBe(`translateY(${String(ROW_HEIGHT)}px)`);
    });
  });
});
