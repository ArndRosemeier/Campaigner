import { describe, expect, it } from 'vitest';

import {
  anyArtifactSchema,
  createArtifact,
  createModule,
  moduleSchema,
  newId,
} from '@/domain';
import { seedOutlineFromModule } from '@/features/deliverables/seed-from-module';

/** M6-D: module seeding includes owned entities but never library rows. */
describe('seedOutlineFromModule ownership', () => {
  it('includes module-owned artifacts and leaves globals for explicit adds', () => {
    const campaignId = newId();
    const moduleId = newId();
    const module = moduleSchema.parse({
      ...createModule({
        campaignId,
        title: 'The Vault',
        concept: '',
        levelMin: 1,
        levelMax: 3,
        sizeDial: 'sketch',
      }),
      id: moduleId,
      spine: {
        premise: '',
        themes: [],
        partPlan: [
          {
            title: 'Gate',
            levelBand: '1–3',
            synopsis: '',
            levelUpTrigger: '',
          },
        ],
      },
      parts: [
        {
          planIndex: 0,
          markdown: 'Meet [[Owned Guide]] and [[Library Guide]].',
          status: 'ready',
          errorMessage: '',
          edited: false,
        },
      ],
    });
    const owned = createArtifact({
      campaignId,
      moduleId,
      kind: 'npc',
      name: 'Owned Guide',
    });
    const global = anyArtifactSchema.parse({
      ...createArtifact({ campaignId, kind: 'npc', name: 'Library Guide' }),
      campaignId: null,
      moduleId: null,
    });

    const outline = seedOutlineFromModule(module, [owned, global]);
    const chapter = outline.find((node) => node.type === 'chapter');
    const artifactIds = chapter?.type === 'chapter'
      ? chapter.children.flatMap((node) => (node.type === 'artifact' ? [node.artifactId] : []))
      : [];
    expect(artifactIds).toEqual([owned.id]);
  });
});
