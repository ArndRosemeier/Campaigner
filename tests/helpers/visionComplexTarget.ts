import type { Artifact, Id } from '@/domain';
import { newId } from '@/domain';
import { createArtifact } from '@/db/artifactRepo';

/**
 * ONE complex-encounter fixture for the vision tests (AGENTS §Centralization
 * obligation 4): `encounterVisionMap` and `encounterVisionSteering` carried a
 * byte-identical private copy, which the test-tree duplication tripwire saw as
 * a NEW duplicate. The caller supplies its OWN layout, so each file keeps the
 * fixture that is actually its own.
 */
export async function seedComplexEncounterTarget(
  campaignId: Id,
  layout: unknown,
): Promise<Artifact & { kind: 'encounter' }> {
  const target = await createArtifact({
    campaignId,
    kind: 'encounter',
    name: 'Old Undercroft',
    summary: 'Old summary.',
    body: 'Existing prose.',
    links: [],
    data: {
      difficulty: 'old',
      levelHint: '', partyLevel: 4,
      monsters: [
        {
          name: 'Tomb Ogre',
          count: 4,
          notes: 'keep',
          treasure: 'Ogre pocket: 4 gp',
          source: { type: 'none' as const },
        },
      ],
      terrain: '',
      tactics: '',
      treasure: '',
      mapImageId: newId(),
      preset: 'dungeon',
      locationKind: 'dungeon',
      siteShape: 'complex',
      budgetAdvisory: 'STALE ADVISORY',
      layout: layout as never,
      fillGrade: 100,
    },
  });
  if (target.kind !== 'encounter') throw new Error('encounter target missing');
  return target;
}
