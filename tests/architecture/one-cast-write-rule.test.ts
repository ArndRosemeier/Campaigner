import { describe, expect, it } from 'vitest';

import { CODE, filesWith } from '../helpers/sourceCode';

/**
 * ONE rule decides whether an AI write may AUTHOR numbers onto a cast creature
 * row (docs/17 row 284, AGENTS rule 4 / centralization obligation 2).
 *
 * THE MEASURED DEFECT this pin exists for was an ORDERING bug hiding inside a
 * boundary: `runStatblock` returned the statblock step `skipped` for every cast
 * creature — and that check sat ABOVE the line that read the owner's
 * instruction, so an explicit "make this NPC level 5" was never consulted. The
 * boundary was enforced at four sites in `runEngine` plus the change seam's
 * route, each spelling the same classification; the cure is ONE predicate
 * (`domain/creature.castCreatureWritePermitted`) that every enforcement point
 * asks, and ONE composer of the instruction it is fed
 * (`llm/additionalInstruction.directInstructionFor`).
 *
 * The drift this catches is invisible to behaviour pins: a FIFTH enforcement
 * site that re-reads `isCastCreatureNpc` and refuses on its own reads correctly
 * today, and the ordering regression re-appears silently the day someone moves
 * the instruction read back below the check. The source list comes from Vite's
 * own `import.meta.glob`, through the ONE test-tree helper
 * (`tests/helpers/sourceCode`) — the hand-rolled walker is a BASELINED
 * multi-site population (docs/17 row 212) and a ninth copy of it, or a second
 * copy of the glob normalization, would be the very defect this file exists to
 * pin.
 */

const SEAM = 'src/domain/creature.ts';
const ENGINE = 'src/llm/runEngine.ts';
const INSTRUCTION = 'src/llm/additionalInstruction.ts';

describe('one cast-write rule (SOURCE SCAN, docs/17 row 284)', () => {
  it('is DEFINED once, in the identity/classification seam', () => {
    // Non-vacuity: the glob sees the whole source tree, and the classification
    // the rule is built on is really there.
    expect(Object.keys(CODE).length).toBeGreaterThan(300);
    expect(filesWith('isCastCreatureNpc(').length).toBeGreaterThan(0);
    expect(filesWith('function castCreatureWritePermitted(')).toEqual([SEAM]);
    expect(filesWith('function npcStatsAreAuthored(')).toEqual([SEAM]);
  });

  it('is ASKED from exactly the declared enforcement homes — never re-spelled at a call site', () => {
    // The seam itself (the definition), the statblock step + the refill merge +
    // the encounter mint (all in the engine), the change seam's route, and the
    // entity batch's destination check. A new file here is a new enforcement
    // point that must be declared, and a new site INSIDE an existing file is
    // visible in the file's own use count below.
    expect(filesWith('castCreatureWritePermitted(')).toEqual([
      SEAM,
      'src/features/modules/change-artifact.ts',
      'src/features/modules/entity-batch.ts',
      ENGINE,
    ]);
    // THREE asks in the engine: the statblock step's boundary, the refill
    // merge's permission, and the encounter mint's link-not-write guard.
    expect(CODE[ENGINE]?.match(/castCreatureWritePermitted\(/g)?.length).toBe(3);
  });

  it('reads the instruction through the ONE composer, ABOVE the boundary it can lift', () => {
    // The composer is defined once and read by the engine only.
    expect(filesWith('function directInstructionFor(')).toEqual([INSTRUCTION]);
    expect(filesWith('directInstructionFor(')).toEqual([INSTRUCTION, ENGINE]);
    // ...and the engine no longer re-spells the expression it replaced — the
    // pre-284 shape read `additionalInstructionOf(input.brief)` inline and did so
    // BELOW the cast check.
    expect(CODE[ENGINE]?.includes('additionalInstructionOf(')).toBe(false);
    const readAt = CODE[ENGINE]?.indexOf('const statedInstruction = directInstructionFor(') ?? -1;
    // The statblock step's OWN boundary call — named in full, so this is the
    // ordering inside that step and not an earlier use elsewhere in the file.
    const boundaryAt =
      CODE[ENGINE]?.indexOf('!castCreatureWritePermitted(refillTarget, statedInstruction)') ?? -1;
    expect(readAt).toBeGreaterThan(-1);
    expect(boundaryAt).toBeGreaterThan(-1);
    // THE ORDERING IS THE FIX: the instruction is read BEFORE the boundary that
    // it may lift, so a refusal can never be reached without consulting it.
    expect(readAt).toBeLessThan(boundaryAt);
  });
});
