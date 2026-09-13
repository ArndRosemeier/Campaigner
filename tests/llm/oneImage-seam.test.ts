import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { GeneratedImages } from '@/llm/imageGen';
import type { ImagePromptDraft } from '@/llm/schemas';

/**
 * The "generate ONE image and prepare it for storage" seam (docs/17 row 126,
 * docs/18 §2.2/§4, docs/08 §The one way to generate ONE image).
 *
 * WHAT IT PINS, in three parts:
 * 1. the seam's HAPPY PATH — the prompt contract is assembled from the DRAFT
 *    (not taken pre-assembled), the API is asked for exactly ONE image, the
 *    intake runs on the returned blob, and the RESULT is the six-field shape
 *    every storage writer consumes;
 * 2. the seam's EMPTY-RESULT REFUSAL, with its message NAMED. This is the pin
 *    the audit found missing: the sentence was a literal at four call sites and
 *    grepping `tests/` found no pin on it anywhere, so a silently-blank cover
 *    or portrait was one deleted line away from passing every gate;
 * 3. a SOURCE SCAN, labelled as a scan in both halves' names, because a fold is
 *    byte-identical BY CONSTRUCTION and behaviour can never see a half-done or
 *    later-reverted fold (measured on the sibling folds: reverting folded sites
 *    left 77 and then 176 behavioural pins green, with only a scan red).
 */
vi.mock('@/llm/imageGen', () => ({ generateImages: vi.fn() }));
vi.mock('@/lib/imageIntake', () => ({ intakeImage: vi.fn() }));

const { generateImages } = await import('@/llm/imageGen');
const generateImagesMock = vi.mocked(generateImages);
const { intakeImage } = await import('@/lib/imageIntake');
const intakeImageMock = vi.mocked(intakeImage);
const { generateOneImage, NO_IMAGE_FROM_API_MESSAGE } = await import('@/llm/oneImage');

/** A full `GeneratedImages` result — the seam consumes only `images[0]` and
 * `modelUsed`, but the mock must satisfy the whole declared shape. */
function apiResult(images: Blob[], modelUsed = 'requested-model'): GeneratedImages {
  return { images, costUsd: null, cappedToOne: false, modelUsed, fallback: null, filteredCount: 0 };
}

const DRAFT: ImagePromptDraft = {
  prompt: 'A dwarf smith at an anvil',
  styleNotes: 'oil painting',
  negative: 'text, letters, numbers',
};
const ASSEMBLED = 'A dwarf smith at an anvil\nStyle: oil painting\nAvoid: text, letters, numbers';

describe('generateOneImage — the ONE way to generate and prepare ONE image', () => {
  beforeEach(() => {
    generateImagesMock.mockReset();
    intakeImageMock.mockReset();
  });

  it('assembles the prompt contract, asks for exactly ONE image and intakes the returned blob', async () => {
    const raw = new Blob(['raw-bytes'], { type: 'image/png' });
    const stored = new Blob(['stored-bytes'], { type: 'image/webp' });
    generateImagesMock.mockResolvedValue(apiResult([raw], 'escalated-model'));
    intakeImageMock.mockResolvedValue({
      blob: stored,
      mimeType: 'image/webp',
      width: 640,
      height: 480,
    });
    const signal = new AbortController().signal;

    const result = await generateOneImage(DRAFT, { model: 'settings-model', signal });

    // The prompt contract is assembled HERE from the draft, and the API is
    // asked for ONE candidate with the caller's model and signal.
    expect(generateImagesMock).toHaveBeenCalledTimes(1);
    expect(generateImagesMock).toHaveBeenCalledWith(ASSEMBLED, 1, {
      model: 'settings-model',
      signal,
    });
    // The EXIF-safe intake runs on the API's blob, and only on it. The
    // REFERENCE assertion is the load-bearing half: `toHaveBeenCalledWith`
    // compares Blobs by deep equality, and two Blobs of different bytes are
    // deeply equal (no own enumerable properties) — MEASURED by injection,
    // which is how this line got its identity check.
    expect(intakeImageMock).toHaveBeenCalledTimes(1);
    expect(intakeImageMock.mock.calls[0]?.[0]).toBe(raw);
    expect(intakeImageMock).toHaveBeenCalledWith(raw);
    // The result is the shape every caller spreads into its storage writer:
    // the intake's blob/mime/size plus the ASSEMBLED prompt and the model that
    // ACTUALLY answered (never the requested one).
    expect(result).toEqual({
      blob: stored,
      mimeType: 'image/webp',
      width: 640,
      height: 480,
      prompt: ASSEMBLED,
      model: 'escalated-model',
    });
    expect(Object.keys(result).sort()).toEqual([
      'blob',
      'height',
      'mimeType',
      'model',
      'prompt',
      'width',
    ]);
    // The result carries the INTAKE's blob object itself (not the API's, and
    // not a copy) — identity, for the same Blob-equality reason as above.
    expect(result.blob).toBe(stored);
  });

  it('refuses an empty result LOUDLY, naming the message the four hand-rolled copies each carried', async () => {
    generateImagesMock.mockResolvedValue(apiResult([]));

    const error: unknown = await generateOneImage(DRAFT, { model: 'm' }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('the image API returned no image');
    expect((error as Error).message).toBe(NO_IMAGE_FROM_API_MESSAGE);
    // The refusal is the seam's own export: a caller (or a doc) quotes it
    // instead of restating the literal, and the VALUE is pinned so a reword
    // has to be a deliberate, test-visible act.
    expect(NO_IMAGE_FROM_API_MESSAGE).toBe('the image API returned no image');
    // Nothing was intaken: a refused generation never prepares (or stores) an
    // image that does not exist.
    expect(intakeImageMock).not.toHaveBeenCalled();
  });

  it('propagates the API failure unchanged — the seam adds no error handling of its own', async () => {
    const failure = new Error('image API: 402 payment required');
    generateImagesMock.mockRejectedValue(failure);

    await expect(generateOneImage(DRAFT, { model: 'm' })).rejects.toBe(failure);
    expect(intakeImageMock).not.toHaveBeenCalled();
  });
});

describe('the ONE-image tail is ONE seam (SOURCE SCAN)', () => {
  /**
   * The hand-rolled SHAPE, stated as the two halves that make a copy a copy:
   * a file that calls `generateImages(` AND `intakeImage(` is generating one
   * or more images and preparing them for storage by hand. Literal substring
   * tests on purpose (not a line-shaped regex) — the four copies this slice
   * folded were formatted across lines and one of them spread its signal
   * conditionally.
   */
  const CALLS_API = 'generateImages(';
  const CALLS_INTAKE = 'intakeImage(';

  /**
   * The ONLY files allowed to carry both halves, each for a reason stated in
   * `llm/oneImage.ts`'s header or docs/18 §2.2/§4 (path → why):
   */
  const BOUNDARIES: Record<string, string> = {
    'llm/runEngine.ts':
      'the run engine\u2019s map paths — they answer a different question (how many candidates, and which one does the owner pick?) and ride the `encounterRunAdapters` indirection the run tests stub; the map intake is `{ role: \'map\' }` with the vision-map carve-out prompt, never the shared draft contract',
    'llm/oneImage.ts':
      'the seam itself — it IS the shape, stated once, and this pin exists so it stays stated once',
  };

  /** Every folded site, with how many seam calls it must contain. A COUNT, not
   * `>= 1`: reopening ONE of the four tails must be visible. */
  const FOLDED: Record<string, { readonly seams: number }> = {
    'features/covers/cover-image-queue.ts': { seams: 1 },
    'features/modules/entity-image-queue.ts': { seams: 1 },
    'features/campaign/mob-portrait-queue.ts': { seams: 1 },
    'features/campaign/mob-portrait-cache-queue.ts': { seams: 1 },
  };

  /** The sentences and helpers the four copies carried — none of them may
   * survive in a folded file. */
  const BANNED_IN_FOLDED = ['generateImages(', 'intakeImage(', 'assembleImagePrompt('] as const;

  const EMPTY_RESULT_SENTENCE = 'the image API returned no image';

  function srcFiles(): string[] {
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
        found.push(full.slice(root.length + 1).replace(/\\/g, '/'));
      }
    };
    walk(root);
    return found.sort();
  }

  const source = (file: string): string => readFileSync(join(process.cwd(), 'src', file), 'utf8');

  it('scan: leaves the hand-rolled generate-plus-intake shape in exactly the documented boundaries (and nowhere else)', () => {
    const files = srcFiles();
    // Non-vacuity: the walk must actually see the app, or this pin proves
    // nothing about it.
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain('llm/oneImage.ts');

    const offenders: string[] = [];
    const seenBoundaries = new Set<string>();
    for (const file of files) {
      const text = source(file);
      if (!(text.includes(CALLS_API) && text.includes(CALLS_INTAKE))) continue;
      if (file in BOUNDARIES) {
        seenBoundaries.add(file);
        continue;
      }
      offenders.push(file);
    }
    expect(offenders, 'hand-rolled "generate one image + intake" outside the seam').toEqual([]);
    // …and each boundary still exists as a copy, so this allowlist cannot rot
    // into a list of files that no longer need it.
    expect([...seenBoundaries].sort()).toEqual(Object.keys(BOUNDARIES).sort());
  });

  for (const [file, { seams }] of Object.entries(FOLDED)) {
    it(`scan: routes the one-image tail in ${file} through the seam`, () => {
      const text = source(file);
      const calls = text.split('generateOneImage(').length - 1;
      expect(calls, `${file}: generateOneImage( call sites`).toBe(seams);
      // A reverted fold is byte-identical in behaviour — the scan is the pin.
      for (const banned of BANNED_IN_FOLDED) {
        expect(text.includes(banned), `${file}: ${banned} must be gone`).toBe(false);
      }
      // The empty-result sentence must not be restated beside the seam.
      expect(text.includes(EMPTY_RESULT_SENTENCE), `${file}: restated refusal`).toBe(false);
      expect(text.includes('NO_IMAGE_FROM_API_MESSAGE'), `${file}: local message override`).toBe(
        false,
      );
    });
  }

  it('scan: states the empty-result sentence in exactly ONE source file, and the seam reads it from there', () => {
    const holders = srcFiles().filter((file) => source(file).includes(EMPTY_RESULT_SENTENCE));
    expect(holders).toEqual(['llm/oneImage.ts']);
    expect(source('llm/oneImage.ts')).toContain(
      `export const NO_IMAGE_FROM_API_MESSAGE = '${EMPTY_RESULT_SENTENCE}';`,
    );
  });
});
