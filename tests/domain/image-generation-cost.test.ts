import { describe, expect, it } from 'vitest';

import { generationCostOf, imageGenerationCostLabel, imageProvenanceOf } from '@/domain';
import { filesWith } from '../helpers/sourceCode';

/** An image's generation price (docs/17 row 421). */
describe('imageGenerationCostLabel', () => {
  it('prints the price to cents, keeping sub-cent precision', () => {
    expect(imageGenerationCostLabel({ source: 'generated', generationCost: { usd: 0.04, images: 1 } })).toBe('$0.04');
    expect(imageGenerationCostLabel({ source: 'generated', generationCost: { usd: 0.0035, images: 1 } })).toBe('$0.0035');
    expect(imageGenerationCostLabel({ source: 'generated', generationCost: { usd: 1.5, images: 1 } })).toBe('$1.50');
  });

  it('names the candidate count: the price is the call’s, never divided by a guess', () => {
    expect(imageGenerationCostLabel({ source: 'generated', generationCost: { usd: 0.16, images: 4 } })).toBe(
      '$0.16 for the call that made 4 images',
    );
  });

  it('says when no price was recorded, and says nothing for an upload', () => {
    expect(imageGenerationCostLabel({ source: 'generated' })).toBe('price not recorded');
    expect(imageGenerationCostLabel({ source: 'generated', generationCost: null })).toBe('price not recorded');
    expect(imageGenerationCostLabel({ source: 'uploaded' })).toBeNull();
  });
});

describe('the cost is recorded at generation and survives a copy', () => {
  it('generationCostOf takes the call cost and its image count', () => {
    const images = [new Blob(['a']), new Blob(['b'])];
    expect(generationCostOf({ images, costUsd: 0.08 })).toEqual({ usd: 0.08, images: 2 });
    expect(generationCostOf({ images, costUsd: null })).toBeNull();
  });

  it('a copied image keeps its price', () => {
    expect(imageProvenanceOf({ prompt: 'p', model: 'm', generationCost: { usd: 0.04, images: 1 } })).toEqual({
      prompt: 'p',
      model: 'm',
      generationCost: { usd: 0.04, images: 1 },
    });
  });

  it('every image copy goes through imageProvenanceOf (no field-by-field provenance copy)', () => {
    expect(filesWith('imageProvenanceOf(')).toEqual([
      'src/db/libraryAdopt.ts',
      'src/db/mobPortraitCache.ts',
      'src/domain/image.ts',
      'src/features/campaign/mob-portrait-queue.ts',
    ]);
  });
});
