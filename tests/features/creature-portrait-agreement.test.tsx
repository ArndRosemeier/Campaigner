import 'fake-indexeddb/auto';

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { createArtifact, listArtifactsByCampaign } from '@/db/artifactRepo';
import { getBattleByModule } from '@/db/battleRepo';
import { seedBattleFromEncounter } from '@/db/battleSeed';
import { createCampaign } from '@/db/campaignRepo';
import { putChunks } from '@/db/chunkRepo';
import { castCreatureAsNpc, creatureCoverImageId, setCreatureCover } from '@/db/creatureRepo';
import { createImage } from '@/db/imageRepo';
import { createModule as saveModule } from '@/db/moduleRepo';
import { createRulebook } from '@/db/rulebookRepo';
import { db } from '@/db/db';
import {
  createModule,
  libraryCreatureKey,
  ruleChunkSchema,
  statBlockSchema,
  stampNewEntity,
  type MonsterEntry,
} from '@/domain';
import { sha256Hex } from '@/lib/hash';
import { presentationArtOfCampaign } from '@/features/campaign/mob-portrait-participants';
import { deriveAutomationDeviation } from '@/features/modules/automation-deviation';
import { FULL_AUTOMATION_TARGET } from '@/features/modules/post-generation';
import { getModule } from '@/db/moduleRepo';
import { BattleSurface } from '@/features/play/battle/BattleSurface';
import { clearDatabase } from '../db/helpers';
import { flushAsyncUpdates } from '../helpers/flush';

/**
 * THE DIFFERENTIAL THE OWNER'S REPORT NEEDED (docs/17 row 165): the portrait a
 * battle token shows is the portrait the MODULE side resolves for that same
 * creature.
 *
 * The owner reported a mob with no portrait on the battle map although the same
 * mob shows its portrait on the module surface: a module-level creature with
 * core stats and a real library portrait, seeded into an encounter. What this
 * file pins is the AGREEMENT between the two surfaces over the SAME creature —
 * a pin that merely asserted "the token has a portrait" (or "the creature is
 * imaged") could not have caught it, because both statements were separately
 * true: the creature HAD its portrait (the batch said so, and the campaign
 * presentation row held it) while the token rendered INITIALS, because the
 * board read its art off the token's ARTIFACT cover — and the creature tier
 * (docs/17 row 106) leaves a cited creature with no artifact at all.
 *
 * `useImageUrl` is mapped to the identity it is HANDED (`url:<imageId>`), so a
 * token's rendered art is asserted as the IMAGE ID the surface resolved — the
 * fact the defect lived in — rather than through blob plumbing that jsdom
 * cannot produce. The module side's answer is `creatureCoverImageId`, the ONE
 * portrait reading (docs/11 D6) the batch, the module gap detector and the
 * battle card all ask.
 */

vi.mock('@/features/images/use-image-url', () => ({
  useImageUrl: (imageId: string | null | undefined): string | null =>
    imageId === null || imageId === undefined ? null : `url:${imageId}`,
}));

vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {},
  OpenRouterError: class OpenRouterError extends Error {},
  listModels: vi.fn(),
  fetchWithHeadersTimeout: vi.fn(),
}));

const BOARD_W = 800;
const BOARD_H = 600;
const CONTENT_H = 450;
const CONTENT_TOP = 75;

const containerRect = {
  x: 0, y: 0, top: 0, left: 0, bottom: BOARD_H, right: BOARD_W,
  width: BOARD_W, height: BOARD_H, toJSON: () => ({}),
};

class ResizeObserverStub {
  callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe(element: Element): void {
    const rect =
      element.getAttribute('data-board-content') === 'true'
        ? { width: BOARD_W, height: CONTENT_H }
        : { width: BOARD_W, height: BOARD_H };
    queueMicrotask(() => {
      this.callback([{ contentRect: rect } as ResizeObserverEntry], this);
    });
  }
  /* eslint-disable @typescript-eslint/no-empty-function */
  unobserve(): void {}
  disconnect(): void {}
  /* eslint-enable @typescript-eslint/no-empty-function */
}

const ZOMBIE_TEXT = 'Zombie, undead. HP 22, AC 8.';

let campaignId = '';

beforeEach(async () => {
  await clearDatabase();
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return this.getAttribute('data-board-content') === 'true'
      ? {
          x: 0, y: CONTENT_TOP, top: CONTENT_TOP, left: 0,
          bottom: CONTENT_TOP + CONTENT_H, right: BOARD_W,
          width: BOARD_W, height: CONTENT_H, toJSON: () => ({}),
        }
      : { ...containerRect };
  });
  campaignId = (await createCampaign({ name: 'Portrait agreement', system: 'dnd5e' })).id;
});

afterEach(async () => {
  await flushAsyncUpdates(20);
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function statBlock(): ReturnType<typeof statBlockSchema.parse> {
  return statBlockSchema.parse({
    system: 'dnd5e', level: '1', size: 'Medium', creatureType: 'undead',
    ac: 8, acNote: '', hp: 22, hpFormula: '', speed: '20 ft.',
    abilities: { str: 13, dex: 6, con: 16, int: 3, wis: 6, cha: 5 },
    saves: '', skills: '', senses: '', languages: '', cr: '1/4', proficiency: 2,
    traits: [], actions: [], reactions: [], legendary: [], extras: {},
  });
}

async function seedChunk(heading: string, text: string): Promise<string> {
  const book = await createRulebook({ title: 'Monster Core', system: 'dnd5e', filename: 'mc.pdf' });
  await putChunks([
    ruleChunkSchema.parse({
      ...stampNewEntity(), bookId: book.id, pageStart: 1, pageEnd: 1, chunkType: 'statblock',
      headingPath: [heading], text, statBlock: statBlock(),
      contentHash: await sha256Hex(text),
    }),
  ]);
  const chunk = await db.chunks.where('bookId').equals(book.id).first();
  if (chunk === undefined) throw new Error('chunk missing');
  return chunk.id;
}

async function campaignImage(): Promise<string> {
  const image = await createImage({
    campaignId, blob: new Blob(['portrait'], { type: 'image/png' }),
    mimeType: 'image/png', width: 10, height: 10, source: 'uploaded',
  });
  return image.id;
}

interface EncounterFixture {
  moduleId: string;
  encounterId: string;
}

async function seedModule(title: string): Promise<string> {
  const moduleRow = await saveModule(
    createModule({ campaignId, title, concept: '', levelMin: 1, levelMax: 5, sizeDial: 'sketch' }),
  );
  return moduleRow.id;
}

async function seedEncounterWith(moduleId: string, monsters: MonsterEntry[]): Promise<EncounterFixture> {
  const encounter = await createArtifact({
    campaignId, moduleId, kind: 'encounter', name: 'Crypt',
    data: {
      difficulty: 'medium', levelHint: '1', monsters, terrain: '', tactics: '', treasure: '',
      mapImageId: null, layout: null, preset: 'standard', locationKind: 'other',
      siteShape: 'single', budgetAdvisory: '',
    },
  });
  await seedBattleFromEncounter(campaignId, moduleId, encounter.id);
  return { moduleId, encounterId: encounter.id };
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

/** The image id a token actually renders, read off the DOM (through the mapped
 * `useImageUrl`) — or null when it renders its initials. */
function tokenArt(label: string): string | null {
  const token = screen
    .getAllByTestId('battle-token')
    .find((element) => (element.getAttribute('data-token-label') ?? '') === label);
  if (token === undefined) throw new Error(`token “${label}” is not on the board`);
  const img = token.querySelector('img');
  const src = img?.getAttribute('src') ?? null;
  return src === null ? null : src.replace(/^url:/u, '');
}

/** What the MODULE side resolves for the same creature: THE portrait question
 * (docs/11 D6), the reading `features/campaign/mob-portrait-queue` writes
 * through and the module gap detector probes. `npcArtifactId` is the row the
 * roster entry points at, when it points at one — the same input the board
 * hands its own resolution. */
async function moduleSidePortrait(
  creatureKey: string,
  npcArtifactId?: string,
): Promise<string | null> {
  return creatureCoverImageId({
    campaignId,
    creatureKey,
    ...(npcArtifactId === undefined ? {} : { npcArtifactId }),
  });
}

/** The module-level affordance's own answer for this module: the encounters the
 * "Generate everything" control counts (`mobPortraits`), read through the SAME
 * derivation the sidebar uses. */
async function modulePortraitGaps(moduleId: string): Promise<string[]> {
  const moduleRow = await getModule(moduleId);
  if (moduleRow === undefined) throw new Error('module missing');
  const artifacts = await listArtifactsByCampaign(campaignId);
  const presentation = await presentationArtOfCampaign(campaignId);
  const deviation = deriveAutomationDeviation(
    moduleRow,
    artifacts,
    FULL_AUTOMATION_TARGET,
    presentation,
  );
  return deviation.mobPortraits.map((encounter) => encounter.name);
}

describe('the token and the module side resolve ONE portrait', () => {
  it("the owner's case: a module-level creature with core stats and a library portrait", async () => {
    const chunkId = await seedChunk('Zombie', ZOMBIE_TEXT);
    const moduleId = await seedModule('Zombie module');
    // A module-level creature (the cast row the module generator makes) with
    // its portrait: the portrait lands where the creature's IDENTITY says, as
    // a battle token from a rulebook citation of the same creature would find
    // it (a cited creature has no artifact of its own).
    const cast = await castCreatureAsNpc({
      campaignId, moduleId,
      citation: { chunkId, contentHash: await sha256Hex(ZOMBIE_TEXT), creatureName: 'Zombie' },
      name: 'Gustav the Zombie', prose: { body: 'The gardener, risen.' },
    });
    expect(cast.status).toBe('created');
    const portraitId = await campaignImage();
    await setCreatureCover({
      campaignId,
      creatureKey: libraryCreatureKey(chunkId),
      imageId: portraitId,
    });
    const { moduleId: seededModule } = await seedEncounterWith(moduleId, [
      { name: 'Zombie', count: 1, notes: '', treasure: '', source: { type: 'rulebook', chunkId } },
    ]);

    await renderSurface(seededModule);

    // THE DIFFERENTIAL: the same creature, both surfaces, one portrait.
    expect(tokenArt('Zombie')).toBe(portraitId);
    expect(await moduleSidePortrait(libraryCreatureKey(chunkId))).toBe(portraitId);
    // …and with the portrait present there is no portrait work to offer.
    expect(await modulePortraitGaps(seededModule)).toEqual([]);
  });

  it('a cast creature whose portrait is the campaign presentation row renders it too (npc-ref)', async () => {
    const chunkId = await seedChunk('Zombie', ZOMBIE_TEXT);
    const moduleId = await seedModule('Cast module');
    const cast = await castCreatureAsNpc({
      campaignId, moduleId,
      citation: { chunkId, contentHash: await sha256Hex(ZOMBIE_TEXT), creatureName: 'Zombie' },
      name: 'Gustav the Zombie', prose: { body: 'The gardener, risen.' },
    });
    // Its own row carries no art; the creature's portrait is the campaign's.
    const portraitId = await campaignImage();
    await setCreatureCover({ campaignId, creatureKey: libraryCreatureKey(chunkId), imageId: portraitId });
    const { moduleId: seededModule } = await seedEncounterWith(moduleId, [
      { name: 'Gustav the Zombie', count: 1, notes: '', treasure: '', source: { type: 'npc-ref', artifactId: cast.artifactId } },
    ]);

    await renderSurface(seededModule);

    expect(tokenArt('Gustav the Zombie')).toBe(portraitId);
    expect(await moduleSidePortrait(libraryCreatureKey(chunkId), cast.artifactId)).toBe(portraitId);
    expect(await modulePortraitGaps(seededModule)).toEqual([]);
  });

  it('a cast creature whose OWN cover carries the portrait renders that cover (unchanged path)', async () => {
    const chunkId = await seedChunk('Zombie', ZOMBIE_TEXT);
    const moduleId = await seedModule('Own cover module');
    const cast = await castCreatureAsNpc({
      campaignId, moduleId,
      citation: { chunkId, contentHash: await sha256Hex(ZOMBIE_TEXT), creatureName: 'Zombie' },
      name: 'Gustav the Zombie', prose: { body: 'The gardener, risen.' },
    });
    const coverId = await campaignImage();
    await db.artifacts.update(cast.artifactId, { coverImageId: coverId });
    const { moduleId: seededModule } = await seedEncounterWith(moduleId, [
      { name: 'Gustav the Zombie', count: 1, notes: '', treasure: '', source: { type: 'npc-ref', artifactId: cast.artifactId } },
    ]);

    await renderSurface(seededModule);

    expect(tokenArt('Gustav the Zombie')).toBe(coverId);
    expect(await moduleSidePortrait(libraryCreatureKey(chunkId), cast.artifactId)).toBe(coverId);
  });

  it('an invented mob renders the portrait keyed on its own content', async () => {
    const moduleId = await seedModule('Invented module');
    const { moduleId: seededModule } = await seedEncounterWith(moduleId, [
      { name: 'Bog Thing', count: 1, notes: 'Wet and hungry.', treasure: '', source: { type: 'inline', statBlock: statBlock() } },
    ]);
    // The batch's own write for an invented mob: the campaign presentation row
    // under the entry's content identity.
    const battle = await getBattleByModule(seededModule);
    const token = battle?.board.tokens.find((entry) => entry.label === 'Bog Thing');
    if (token?.creatureKey === undefined) throw new Error('invented token has no creature key');
    const portraitId = await campaignImage();
    await setCreatureCover({ campaignId, creatureKey: token.creatureKey, imageId: portraitId });

    await renderSurface(seededModule);

    expect(tokenArt('Bog Thing')).toBe(portraitId);
    expect(await moduleSidePortrait(token.creatureKey)).toBe(portraitId);
    expect(await modulePortraitGaps(seededModule)).toEqual([]);
  });
});

describe('the affordance and the board state the same fact', () => {
  it('a missing portrait is WORK and the board shows initials; the batch then fills both', async () => {
    const chunkId = await seedChunk('Zombie', ZOMBIE_TEXT);
    const moduleId = await seedModule('Gap module');
    await seedEncounterWith(moduleId, [
      { name: 'Zombie', count: 1, notes: '', treasure: '', source: { type: 'rulebook', chunkId } },
    ]);

    await renderSurface(moduleId);

    // Nothing imaged yet: the board shows initials AND the module-side
    // affordance counts the encounter — the loud direction.
    expect(tokenArt('Zombie')).toBeNull();
    expect(await moduleSidePortrait(libraryCreatureKey(chunkId))).toBeNull();
    expect(await modulePortraitGaps(moduleId)).toEqual(['Crypt']);

    // The portrait lands (what the batch's commit seam writes) …
    const portraitId = await campaignImage();
    await setCreatureCover({ campaignId, creatureKey: libraryCreatureKey(chunkId), imageId: portraitId });
    await flushAsyncUpdates(20);

    // … and BOTH sides move together: the token renders it and the gap closes.
    await waitFor(() => {
      expect(tokenArt('Zombie')).toBe(portraitId);
    });
    expect(await modulePortraitGaps(moduleId)).toEqual([]);
  });
});
