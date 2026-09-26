import { describe, expect, it } from 'vitest';

import { CODE, filesWith } from '../helpers/sourceCode';

/**
 * THE one image-row FIELD update (docs/17 row 366, AGENTS rule 4).
 *
 * WHY A SOURCE SCAN: the drift this catches is invisible — a second
 * `db.images.update(id, …)` at a caller compiles, behaves correctly today, and
 * silently becomes a second place where "how an image row is patched" lives.
 * The favourite write therefore does NOT spell its own update: it rides the
 * seam `setImageRole` already used, and this pin reds the moment a third
 * spelling appears. Row CREATION (`db.images.put`) and DELETION are different
 * seams and deliberately not covered here.
 */

const IMAGE_REPO = 'src/db/imageRepo.ts';
const UPDATE_NEEDLE = 'db.images.update(';

describe('ONE image-row field update (docs/17 row 366) — SOURCE SCAN', () => {
  it('patches an image row in exactly one place, and that place is imageRepo', () => {
    expect(filesWith(UPDATE_NEEDLE)).toEqual([IMAGE_REPO]);
    expect((CODE[IMAGE_REPO] ?? '').split(UPDATE_NEEDLE).length - 1).toBe(1);
  });

  it('routes BOTH mutable-field writers through that one seam', () => {
    const repo = CODE[IMAGE_REPO] ?? '';
    // Two CALLS (the role setter and the favourite setter) — the declaration
    // itself is `async function updateImageRow(`, never awaited.
    expect(repo.split('await updateImageRow(').length - 1).toBe(2);
    expect(repo).toContain('export async function setImageRole(');
    expect(repo).toContain('export async function setImageFavourited(');
  });
});
