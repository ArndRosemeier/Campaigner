import type { GeneratedImages } from '@/llm/imageGen';

/**
 * A `generateImages` result that HONORS the requested count — the ONE test
 * fixture for every candidate-count pin (docs/17 row 307, AGENTS rule 4).
 *
 * WHY THE MOCK MUST HONOR `n`. A run's requested candidate count is not
 * observable from the outside; what IS observable is what the run STORED. So
 * the count pins read the run's own candidate list — and a mock that always
 * answered two candidates would keep every one of those pins green even after
 * the request went back to 2, which is exactly the refactor-surviving pin the
 * brief asked for. The fixture therefore builds `n` images, and `n` is the
 * mock's own second argument.
 *
 * The one exception is deliberate and labelled at its call site: a test that
 * needs a MULTI-candidate pick (the prune of a candidate the owner did not
 * keep) passes an `n + 1` count of its own — an API that OVER-delivers what
 * was asked for, which `imageGen.filteredCount` already models as a real
 * possibility.
 */
export function generatedImagesFor(n: number, seedText: string): GeneratedImages {
  return {
    images: Array.from(
      { length: n },
      (_unused, index) => new Blob([`${seedText}-${String(index + 1)}`], { type: 'image/webp' }),
    ),
    costUsd: null,
    cappedToOne: false,
    modelUsed: 'test-image-model',
    fallback: null,
    filteredCount: 0,
  };
}
