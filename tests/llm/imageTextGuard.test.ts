import 'fake-indexeddb/auto';

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact, listArtifactsByCampaign } from '@/db/artifactRepo';
import { creaturePortraitArt } from '@/db/creatureRepo';
import { createCampaign, getCampaign } from '@/db/campaignRepo';
import { putChunks } from '@/db/chunkRepo';
import { createRulebook } from '@/db/rulebookRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { saveSettings, updateSettings } from '@/db/settingsRepo';
import { getRun } from '@/db/runRepo';
import {
  createPersona,
  defaultSettings,
  newId,
  ruleChunkSchema,
  stampNewEntity,
  statBlockSchema,
  libraryCreatureKey,
} from '@/domain';
import { enqueueCampaignCover, useCoverImageQueue } from '@/features/covers/cover-image-queue';
import { useEntityImageQueue } from '@/features/modules/entity-image-queue';
import { useMobPortraitQueue } from '@/features/campaign/mob-portrait-queue';
import { assembleImagePrompt, buildImagePrompt, IMAGE_TEXT_WHEN_NEEDED_CLAUSE } from '@/llm/imagePromptDraft';
import { encounterRunAdapters, runEngine, type StartRunInput } from '@/llm/runEngine';
import { BATTLEMAP_EMPTY_TERRAIN_CLAUSE, buildLabeledMapPrompt } from '@/llm/visionDungeon';
import { sha256Hex } from '@/lib/hash';
import { useProgressStore } from '@/lib/progress';
import { clearDatabase } from '../db/helpers';
import { answerClassicBattlemapFigureChecks } from '../helpers/battlemapFigureChat';

/**
 * The image text rule is POSITIVE (docs/17 row 319). The shared `Avoid:` list
 * (`IMAGE_TEXT_NEGATIVE` and its mob-portrait alias `MOB_PORTRAIT_TEXT_NEGATIVE`
 * — named here only as history; the constants are DELETED) is gone: the
 * default `negative` is `''`, so the default assembled prompt carries NO
 * `Avoid:` line at all, and ONE positive clause rides the composed prompt of
 * both `buildImagePrompt` branches and both classic-stylize battlemap modes.
 * The vision dungeon path's plaque rule and the classic battlemap's
 * owner-ratified usability hard-bans are CALLER-OWNED rules (declared
 * boundary) and stay untouched.
 *
 * A fail-closed registry keeps every caller known, and a source scan proves
 * the two deleted names never come back into `src/`.
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
vi.mock('@/search', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...(actual as object), searchRules: vi.fn() };
});

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);
const { generateImages } = await import('@/llm/imageGen');
const generateImagesMock = vi.mocked(generateImages);
const { intakeImage } = await import('@/lib/imageIntake');
const intakeImageMock = vi.mocked(intakeImage);
const { searchRules } = await import('@/search');
const searchRulesMock = vi.mocked(searchRules);

function blobOf(text: string): Blob {
  return new Blob([text], { type: 'image/png' });
}

beforeEach(async () => {
  await clearDatabase();
  await seedBuiltInPersonas();
  await updateSettings({ imagesEnabled: true, imageModel: 'test-image-model' });
  chatMock.mockReset();
  // The classic stylize step's figure check (docs/17 row 341) is a chat call
  // on the shared vision contract; answer it unless a test queues its own.
  answerClassicBattlemapFigureChecks(chatMock);
  generateImagesMock.mockReset();
  intakeImageMock.mockReset();
  searchRulesMock.mockReset();
  searchRulesMock.mockResolvedValue([]);
  useCoverImageQueue.getState().reset();
  useEntityImageQueue.getState().reset();
  useMobPortraitQueue.getState().reset();
  useProgressStore.getState().reset();
  generateImagesMock.mockResolvedValue({ images: [blobOf('gen')], costUsd: 0.01, cappedToOne: false, modelUsed: 'test-image-model', fallback: null, filteredCount: 0 });
  intakeImageMock.mockResolvedValue({
    blob: blobOf('intake'),
    mimeType: 'image/webp',
    width: 320,
    height: 240,
  });
  vi.spyOn(encounterRunAdapters, 'renderSchematic').mockReturnValue({ dataUrl: 'data:image/png;base64,schematic', width: 2304, height: 1728 });
  vi.spyOn(encounterRunAdapters, 'generateImages').mockResolvedValue({ images: [new Blob(['one']), new Blob(['two'])], costUsd: 0.02, cappedToOne: false, modelUsed: 'test-image-model', fallback: null, filteredCount: 0 });
  vi.spyOn(encounterRunAdapters, 'normalizeImageAspect').mockImplementation((blob) => Promise.resolve({ blob, width: 1200, height: 900, action: 'none' }));
  vi.spyOn(encounterRunAdapters, 'intakeImage').mockImplementation((blob) => Promise.resolve({ blob, width: 1200, height: 900, mimeType: 'image/webp' }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the text rule is positive (docs/17 row 319)', () => {
  /**
   * PIN 1 (docs/17 row 319) — the owner's own wording rides the COMPOSED
   * prompt of both builder branches, verbatim, and never an `Avoid:` line.
   */
  it('rides the composed prompt in BOTH builder branches, verbatim', () => {
    const grounded = buildImagePrompt(
      { name: 'The Lighthouse', kind: 'location', summary: 'A storm-lashed beacon.', body: 'Black cliffs.', data: {} },
      { systemLabel: 'D&D 5e' },
    );
    expect(grounded.prompt).toContain(IMAGE_TEXT_WHEN_NEEDED_CLAUSE);
    expect(grounded.prompt).toContain('Text is welcome where the subject itself needs it');
    expect(grounded.negative).not.toContain(IMAGE_TEXT_WHEN_NEEDED_CLAUSE);
    const shortcut = buildImagePrompt(
      { name: 'Grix', kind: 'npc', summary: '', body: '', data: { appearance: 'Small, soot-stained, goggles.' } },
      { systemLabel: 'D&D 5e' },
    );
    expect(shortcut.prompt).toContain(IMAGE_TEXT_WHEN_NEEDED_CLAUSE);
    expect(shortcut.prompt).toContain('Text is welcome where the subject itself needs it');
    expect(shortcut.negative).not.toContain(IMAGE_TEXT_WHEN_NEEDED_CLAUSE);
  });

  /**
   * PIN 2 (docs/17 row 319) — the DEFAULT path forbids nothing: the draft's
   * `negative` is `''` and the assembled prompt has NO `Avoid:` line at all.
   * Asserted on the COMPOSED string, not just the field, because an empty
   * field could still be assembled into a bare `Avoid: ` line.
   */
  it('emits NO Avoid line by default in either branch', () => {
    const grounded = buildImagePrompt(
      { name: 'The Lighthouse', kind: 'location', summary: 'A storm-lashed beacon.', body: 'Black cliffs.', data: {} },
      { systemLabel: 'D&D 5e' },
    );
    expect(grounded.negative).toBe('');
    expect(assembleImagePrompt(grounded)).not.toContain('Avoid:');
    const shortcut = buildImagePrompt(
      { name: 'Grix', kind: 'npc', summary: '', body: '', data: { appearance: 'Small, soot-stained, goggles.' } },
      { systemLabel: 'D&D 5e' },
    );
    expect(shortcut.prompt).toBe(`D&D 5e=>Small, soot-stained, goggles.\n${IMAGE_TEXT_WHEN_NEEDED_CLAUSE}`);
    expect(shortcut.negative).toBe('');
    expect(assembleImagePrompt(shortcut)).not.toContain('Avoid:');
  });

  /**
   * PIN 3 (docs/17 row 319) — a request that ASKS for text needs no escape
   * hatch any more: nothing forbids text, so the request and the positive
   * clause share the prompt without contradiction. Both branches are
   * exercised, because the request rides `extraInstruction` on either.
   */
  it('lets a requested treasure map / legend / letter coexist with the positive clause', () => {
    const requests = [
      'Draw this as a treasure map.',
      'A labelled map with a legend down one side.',
      'A confession letter with visible handwriting.',
    ];
    for (const request of requests) {
      for (const data of [{}, { appearance: 'A ragged chart with a torn corner.' }]) {
        const draft = buildImagePrompt(
          { name: 'Ash Gate', kind: 'location', summary: 'A ruined gate.', body: 'Cultists hold it.', data },
          { systemLabel: 'D&D 5e', extraInstruction: request },
        );
        const final = assembleImagePrompt(draft);
        expect(final).toContain(request);
        expect(final).toContain(IMAGE_TEXT_WHEN_NEEDED_CLAUSE);
        // No avoid list exists, so nothing can override the request.
        expect(draft.negative).toBe('');
        expect(final).not.toContain('Avoid:');
      }
    }
  });

  it('keeps an explicit negative as the override (the option stays the seam)', () => {
    const draft = buildImagePrompt(
      { name: 'Bare', kind: 'note', summary: 's', body: '', data: null },
      { systemLabel: 'D&D 5e', negative: 'custom avoid' },
    );
    expect(draft.negative).toBe('custom avoid');
    // The override seam must NOT die with the shared list.
    expect(assembleImagePrompt(draft)).toContain('Avoid: custom avoid');
  });
});

/**
 * ONE classic-stylize capture harness for BOTH mode contracts (docs/11 D17).
 * It runs a full Cartographer classic pipeline (brief → layout → schematic →
 * stylize) to the `pick` pause and returns the prompt the stylize step actually
 * handed `encounterRunAdapters.generateImages`. The only fixture fields the two
 * mode pins vary are the brief's `environment` and its prose, because on a
 * fresh run (no `target` ⇒ no owner `mapMode` override, no persisted
 * `locationKind`) `resolveEncounterMapMode` derives the mode from
 * `environment` alone: `'outdoor'` ⇒ natural, `'dungeon'` (the schema default)
 * ⇒ architectural. Extracted from the original architectural-only capture so
 * the two branches share one setup and cannot drift (AGENTS §Centralization).
 */
async function captureClassicStylizePrompt(brief: {
  environment: 'dungeon' | 'outdoor';
  theme: string;
  terrain: string;
  summary: string;
  styleNotes: string;
}): Promise<string> {
  const campaign = await createCampaign({ name: 'Map Campaign', system: 'dnd5e' });
  const cartographer = createPersona({
    slug: 'encounter-cartographer-guard',
    name: 'Encounter Cartographer',
    description: '',
    systemPrompt: 'Return encounter JSON.',
    mode: 'encounter',
    producesKind: 'encounter',
    builtIn: true,
  });
  const { db } = await import('@/db');
  await db.personas.put(cartographer);
  await saveSettings({ ...defaultSettings(), openRouterApiKey: 'test-key', imagesEnabled: true });
  // The brief carries NO negative (empty string): the stylize step must still
  // guard — only an explicit custom list overrides. (A custom brief negative is
  // pinned by the existing cartographer contract tests.)
  chatMock.mockResolvedValueOnce({
    text: JSON.stringify({
      name: 'Ash Gate Ambush',
      summary: brief.summary,
      body: '# Ash Gate\nA room-by-room battle.',
      difficulty: 'hard',
      levelHint: '', partyLevel: 4,
      terrain: brief.terrain,
      tactics: 'fall back through the gate',
      treasure: 'obsidian key',
      theme: brief.theme,
      styleNotes: brief.styleNotes,
      negative: '',
      environment: brief.environment,
      monsters: [
        {
          name: 'Ash Cultist',
          count: 2,
          notes: '',
          treasure: 'Robes: 2 gp',
          statBlock: {
            system: 'dnd5e', level: '1', size: 'Medium', creatureType: 'humanoid', ac: 12,
            acNote: '', hp: 7, hpFormula: '2d6', speed: '30 ft.',
            abilities: { str: 10, dex: 12, con: 10, int: 10, wis: 10, cha: 10 },
            saves: '', skills: '', senses: '', languages: '', traits: [], actions: [], reactions: [], legendary: [], extras: {},
          },
        },
      ],
      rooms: [
        { name: 'Entry', description: 'Broken doors', size: 'medium', monsterIndexes: [0], adjacentRoomIndexes: [], key: 'Cracked doors hang off one hinge.', keyTreasure: 'Fallen banner: 15 gp' },
      ],
      entryRoomIndex: 0,
    }),
    modelUsed: 'test-model',
    fallback: null,
  });
  const runInput: StartRunInput = {
    campaign,
    persona: cartographer,
    autonomy: 'manual',
    brief: 'A temple gate encounter',
    pinnedChunkIds: [],
    // The create dialog's structured party level (docs/17 row 291).
    encounterPartyLevel: 5,
    encounterMapAspect: '4:3',
  };
  const runId = await runEngine.startRun(runInput);
  await waitFor(
    async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('awaiting_user');
      expect(run?.steps.at(-1)?.name).toBe('brief');
    },
    { timeout: 15000 },
  );
  await runEngine.approve(runId, runInput);
  await waitFor(
    async () => {
      const run = await getRun(runId);
      expect(run?.status).toBe('awaiting_user');
      expect(run?.steps.at(-1)?.name).toBe('pick');
    },
    { timeout: 15000 },
  );
  return vi.mocked(encounterRunAdapters.generateImages).mock.calls[0]?.[0] ?? '';
}

describe('guarded caller families (prompt capture)', () => {
  it('covers carry NO avoid list — they ride the positive clause (docs/17 row 319)', async () => {
    const campaign = await createCampaign({ name: 'Ember', description: 'A city of ash and bells.', system: 'dnd5e' });
    enqueueCampaignCover(campaign.id, 'Ember');
    await waitFor(async () => {
      const updated = await getCampaign(campaign.id);
      expect(updated?.coverImageId).not.toBeNull();
    });
    expect(chatMock).not.toHaveBeenCalled();
    const finalPrompt = generateImagesMock.mock.calls[0]?.[0] ?? '';
    expect(finalPrompt).toContain(IMAGE_TEXT_WHEN_NEEDED_CLAUSE);
    expect(finalPrompt).not.toContain('Avoid:');
  });

  it('entity images carry NO avoid list — they ride the positive clause (docs/17 row 319)', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const moduleId = newId();
    await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Kael', summary: 'Ember’s gate warden.' });
    useEntityImageQueue.getState().enqueue([{ campaignId: campaign.id, moduleId, name: 'Kael' }]);
    await waitFor(async () => {
      const kael = (await listArtifactsByCampaign(campaign.id)).find((a) => a.name === 'Kael');
      expect(kael?.imageIds).toHaveLength(1);
    });
    expect(chatMock).not.toHaveBeenCalled();
    const finalPrompt = generateImagesMock.mock.calls[0]?.[0] ?? '';
    expect(finalPrompt).toContain(IMAGE_TEXT_WHEN_NEEDED_CLAUSE);
    expect(finalPrompt).not.toContain('Avoid:');
  });

  it('mob portraits carry NO avoid list — the deleted alias is not passed any more (docs/17 row 319)', async () => {
    const campaign = await createCampaign({ name: 'Mob portraits', system: 'dnd5e' });
    const text = 'Goblin Boss, humanoid, agile commander. HP 21, AC 17.';
    const book = await createRulebook({ title: 'Bestiary', system: 'dnd5e', filename: 'bestiary.pdf' });
    await putChunks([
      ruleChunkSchema.parse({
        ...stampNewEntity(),
        bookId: book.id,
        pageStart: 12,
        pageEnd: 12,
        chunkType: 'statblock',
        headingPath: ['Goblin Boss'],
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
    const { db } = await import('@/db/db');
    const chunk = await db.chunks.where('bookId').equals(book.id).first();
    if (chunk === undefined) throw new Error('chunk missing');
    // The portrait is keyed by creature IDENTITY (docs/11 D6): no artifact is
    // created for a bestiary creature, and the guard is about the PROMPT.
    const creatureKey = libraryCreatureKey(chunk.id);
    useMobPortraitQueue.getState().enqueue([
      {
        campaignId: campaign.id,
        encounterId: newId(),
        name: 'Goblin Boss',
        creatureKey,
        chunkId: chunk.id,
      },
    ]);
    await waitFor(async () => {
      expect(await creaturePortraitArt(campaign.id, creatureKey)).toBe('cover');
    });
    expect(chatMock).not.toHaveBeenCalled();
    const finalPrompt = generateImagesMock.mock.calls[0]?.[0] ?? '';
    expect(finalPrompt).toContain(IMAGE_TEXT_WHEN_NEEDED_CLAUSE);
    expect(finalPrompt).not.toContain('Avoid:');
  });

  it('classic stylize (architectural) emits NO Avoid line when the brief wrote no negative', async () => {
    const prompt = await captureClassicStylizePrompt({
      environment: 'dungeon',
      theme: 'ash-choked temple',
      terrain: 'broken pillars',
      summary: 'Cultists guard a ruined gate.',
      styleNotes: 'inked fantasy map, volcanic stone',
    });
    // The brief wrote `negative: ''`; there is no shared fallback any more, so
    // the `Avoid:` line is omitted entirely (docs/17 row 319).
    expect(prompt).not.toContain('Avoid:');
    // The owner's positive text rule rides the classic battlemap template too.
    // Its own "no map legend / no text labels" hard-ban is the separate
    // owner-ratified VTT rule (docs/11 D17), asserted as still present so the
    // declared boundary is pinned rather than implied.
    expect(prompt).toContain(IMAGE_TEXT_WHEN_NEEDED_CLAUSE);
    expect(prompt).toContain('no map legend, no scale bar');
    expect(prompt).toContain('no text labels');
    // The POSITIVE emptiness frame (docs/17 row 337) rides BOTH classic modes
    // beside the existing bans: the map is empty terrain and the creatures
    // are tokens added later. A negative alone was never a guarantee.
    expect(prompt).toContain(BATTLEMAP_EMPTY_TERRAIN_CLAUSE);
    // The architectural contract proper: the materials line and the
    // keep-structure clause are what make the layout ground truth.
    expect(prompt).toContain('Environment materials: desaturated stone, wood, dirt.');
    expect(prompt).toContain('Keep walls, openings, the entrance gap and overall structure exactly as in the reference image.');
    expect(prompt).not.toContain('the reference image only marks placement');
  });

  /**
   * docs/17 row 225 — the NATURAL-site arm of the classic-stylize template is
   * DRIVEN, not assumed. Verifying row 224, removing the positive clause from
   * the `natural ? [...]` arm alone (`runEngine.ts` hash
   * `dde93a76a52195e210f8d1b18ac8086fff1759f5`) left every focused
   * guard/draft test GREEN, because the architectural capture above was
   * the only one that reached the template. This pin flips the SAME harness to
   * `environment: 'outdoor'` — the one mode signal a fresh run derives from —
   * and asserts the composed prompt the engine actually hands the image model.
   */
  it('classic stylize (natural site) carries the positive clause and its own prose contract, and never the architectural clauses', async () => {
    const prompt = await captureClassicStylizePrompt({
      environment: 'outdoor',
      theme: 'moonlit pinewood',
      terrain: 'forest clearing',
      summary: 'Bandits ambush the trade road through the pines.',
      styleNotes: 'inked fantasy map, moonlit greens',
    });
    // The owner's positive text rule (docs/17 row 319) rides BOTH battlemap
    // modes, and no `Avoid:` line is emitted at all.
    expect(prompt).toContain(IMAGE_TEXT_WHEN_NEEDED_CLAUSE);
    expect(prompt).not.toContain('Avoid:');
    // The positive emptiness frame (docs/17 row 337) rides the natural mode
    // too — ONE clause, both modes, and the vision builder imports the same
    // constant.
    expect(prompt).toContain(BATTLEMAP_EMPTY_TERRAIN_CLAUSE);
    // The natural contract leads with the encounter's OWN prose …
    expect(prompt).toContain('Theme: moonlit pinewood.');
    expect(prompt).toContain('Site: forest clearing.');
    expect(prompt).toContain('Scene: Bandits ambush the trade road through the pines.');
    // … and explains the reference image as PLACEMENT ONLY: patches where the
    // creatures gather plus the single approach triangle (the natural entrance
    // clause softens to the visible approach path).
    expect(prompt).toContain('the reference image only marks placement');
    expect(prompt).toContain("its soft darker patches show where the encounter's creatures gather");
    expect(prompt).toContain("single neon triangle marks the party's approach");
    expect(prompt).toContain('paint a visible approach path at the marked spot');
    // The architectural branch's clauses are ABSENT — that distinction IS the
    // two-mode contract (docs/11 D17), so a copy-paste of either is a red.
    expect(prompt).not.toContain('Environment materials: desaturated stone, wood, dirt.');
    expect(prompt).not.toContain('Keep walls, openings, the entrance gap and overall structure exactly as in the reference image.');
    expect(prompt).not.toContain('The party enters the map through a single open gap');
    // The usability hard-bans survive BOTH modes (owner decision 2026-09-17,
    // verbatim: "Battlemaps do not need text, so that restriction can stay.").
    expect(prompt).toContain('no map legend');
    expect(prompt).toContain('no text labels');
    expect(prompt).toContain('No white or pale boxes, rectangles, plaques, discs, signposts');
    expect(prompt).toContain('continuous natural terrain with no discrete light-colored sub-rectangles');
  });
});

describe('vision carve-out (binding, caller-owned rule)', () => {
  it('keeps the room plaques while no shared clause reaches the vision path', () => {
    const prompt = buildLabeledMapPrompt(
      [
        { label: 'A', name: 'Entry', description: 'Broken doors', isEntry: true },
        { label: 'B', name: 'Ossuary', description: 'Bone piles' },
      ],
      'ash-choked crypt dungeon',
      'A ↔ B',
    );
    // The tailored, caller-owned rule is present…
    expect(prompt).toContain('plaque');
    expect(prompt).toContain('no written text anywhere except the 2 letter plaques');
    // …and so is the POSITIVE emptiness frame (docs/17 row 337), the SAME
    // constant the classic modes import.
    expect(prompt).toContain(BATTLEMAP_EMPTY_TERRAIN_CLAUSE);
    // …while no shared mechanism is added: no `Avoid:` line, and the owner's
    // positive clause is deliberately absent too — this path's plaque
    // clause is load-bearing for the locate pass (docs/17 rows 224/319).
    expect(prompt).not.toContain('Avoid:');
    expect(prompt).not.toContain(IMAGE_TEXT_WHEN_NEEDED_CLAUSE);
    // The deleted shared list's items cannot leak back in either.
    for (const blanket of ['speech bubbles', 'watermark', 'signature', 'plot summary', 'explanatory text']) {
      expect(prompt, `blanket item leaked into the vision path: ${blanket}`).not.toContain(blanket);
    }
  });
});

describe('image-prompt caller registry (fail-closed)', () => {
  function srcFilesContaining(snippet: string): string[] {
    const root = join(process.cwd(), 'src');
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
        if (readFileSync(full, 'utf8').includes(snippet)) {
          found.push(full.slice(root.length + 1).replace(/\\/g, '/'));
        }
      }
    };
    walk(root);
    return found.sort();
  }

  it('every buildImagePrompt call site is a known guarded caller', () => {
    // Fail-closed: a new image-prompt call site outside this list fails the
    // test. Every caller now rides the contract's positive clause; a caller
    // with a tailored need may still pass its own `negative` (the override
    // seam). Extend this list deliberately when a new producer appears.
    expect(srcFilesContaining('buildImagePrompt(')).toEqual(
      [
        'features/campaign/mob-portrait-cache-queue.ts',
        'features/campaign/mob-portrait-queue.ts',
        'features/covers/cover-image-queue.ts',
        'features/modules/entity-image-queue.ts',
        'llm/imagePromptDraft.ts',
        'llm/runEngine.ts',
      ].sort(),
    );
  });

  it('the deleted shared avoid list cannot come back into src/ (docs/17 row 319)', () => {
    // The constants are DELETED, not merely unwired. A re-introduced name —
    // however it is wired — reds here, so the next reader cannot restore the
    // list in a comment-only or a dead-code spelling without being told.
    expect(srcFilesContaining('IMAGE_TEXT_NEGATIVE')).toEqual([]);
    expect(srcFilesContaining('MOB_PORTRAIT_TEXT_NEGATIVE')).toEqual([]);
    // Non-vacuity: the scanner still sees the LIVE constant at its seam, so a
    // pair of empty results above means ABSENCE, not a broken walk.
    expect(srcFilesContaining('IMAGE_TEXT_WHEN_NEEDED_CLAUSE')).toContain('llm/imagePromptDraft.ts');
  });

  it('every direct image producer is known (no hand-rolled prompt bypasses the guard)', () => {
    // Fail-closed: routing a new prompt around the contract (a generateImages
    // call whose prompt never saw the guard) fails the test. The vision path
    // and the lab bench are the documented carve-out family (their prompts
    // carry the tailored plaque clause, pinned above).
    //
    // The four one-image queues LEFT this list in ledger 126: their
    // `generateImages(finalPrompt, 1, …)` tails are ONE seam now
    // (`llm/oneImage.generateOneImage`, which takes the DRAFT and assembles
    // the contract itself), so the seam is the direct producer those files
    // used to be — and the seam's own source scan pins that they cannot go
    // back to calling the client directly.
    expect(srcFilesContaining('generateImages(')).toEqual(
      [
        'features/lab/labClients.ts',
        'llm/imageGen.ts',
        'llm/oneImage.ts',
        'llm/runEngine.ts',
      ].sort(),
    );
  });

  it('every labeled-map prompt routes through the shared vision builder (the carve-out family)', () => {
    expect(srcFilesContaining('buildLabeledMapPrompt(')).toEqual(
      ['features/lab/experiments/labeledDungeon.ts', 'llm/runEngine.ts', 'llm/visionDungeon.ts'].sort(),
    );
  });
});
