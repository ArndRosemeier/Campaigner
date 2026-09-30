/**
 * Shared fake transports for the lab dungeon benches (labeled and unlabeled).
 * Both benches share the same client contract shape, so the two failure fakes
 * both test files use live here once (docs/17 row 409, rule 4).
 */

/** A generation that produced no images at all: the bench must throw loud. */
export function emptyGenerateMaps(): Promise<{ blobs: Blob[]; cappedToOne: boolean; modelUsed: string }> {
  return Promise.resolve({ blobs: [], cappedToOne: false, modelUsed: 'm' });
}

/** A vision reply that is not JSON: the image must fail loud. */
export function malformedVisionPass(): Promise<{ text: string; modelUsed: string }> {
  return Promise.resolve({ text: 'not json at all', modelUsed: 'test-chat-model' });
}
