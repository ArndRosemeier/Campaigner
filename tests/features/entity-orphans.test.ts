import 'fake-indexeddb/auto';

import { describe, expect, it } from 'vitest';

import {
  createArtifact,
  createModule,
  moduleSchema,
  newId,
  type AnyArtifact,
  type Id,
  type Module,
} from '@/domain';
import { deriveModuleOrphans } from '@/features/modules/entity-orphans';

/**
 * Orphaned-entity derivation (08-MODULE-DESIGNER §M4-C "Orphaned entities",
 * pure units): the module-scope tag — zero RESOLVING wiki-link mentions in
 * THIS module's prose — with the ambiguity-shadow exclusion. Mentions are
 * wiki-link tokens resolved via buildWikiGraph exactly like the reader
 * (exact name then aliases, case-insensitive, module-tier precedence) —
 * never countOccurrences substrings. The campaign-wide gate + structural
 * guards are the SWEEP's recount (tests/db/orphanSweep.test.ts).
 */

function moduleWithProse(campaignId: Id, title: string, premise: string): Module {
  return moduleSchema.parse({
    ...createModule({ campaignId, title, concept: '', levelMin: 1, levelMax: 4, sizeDial: 'standard' }),
    spine: {
      premise,
      themes: [],
      partPlan: [
        {
          title: 'The Seal',
          levelBand: '1–2',
          synopsis: 'Reach the seal.',
          levelUpTrigger: 'The seal breaks.',
        },
      ],
    },
    parts: [],
  });
}

describe('deriveModuleOrphans — the module-scope tag', () => {
  it('counts name, alias and case-insensitive mentions; tags only the unmentioned', () => {
    const campaignId = newModuleCampaign();
    const module = moduleWithProse(
      campaignId,
      'Ember Crypt',
      '[[MIRA]] bows to [[The Whisper]] while [[Bram]] polls the tide.',
    );
    const pool: AnyArtifact[] = [
      // Case-insensitive exact name — mentioned, never tagged.
      createArtifact({ campaignId, moduleId: module.id, kind: 'npc', name: 'Mira' }),
      // Alias-only mention — mentioned, never tagged (14 §2 semantics).
      createArtifact({
        campaignId,
        moduleId: module.id,
        kind: 'npc',
        name: 'Vex',
        aliases: ['The Whisper'],
      }),
      // Untagged prose — the orphan tag.
      createArtifact({ campaignId, moduleId: module.id, kind: 'npc', name: 'Kael' }),
      // Mentioned in prose but CAMPAIGN-owned — not a candidate at all.
      createArtifact({ campaignId, kind: 'npc', name: 'Bram' }),
    ];

    const rows = deriveModuleOrphans(module, pool);

    expect(rows.map((row) => row.artifact.name)).toEqual(['Kael']);
  });

  it('a module-tier same-named row in ANOTHER module does not count as a mention', () => {
    const campaignId = newModuleCampaign();
    const first = moduleWithProse(campaignId, 'Ember Crypt', 'A quiet shore.');
    const second = moduleWithProse(campaignId, 'Tide Gate', '[[Wraith]] hunts the fog.');
    const pool: AnyArtifact[] = [
      // The candidate: module-zero in Ember Crypt.
      createArtifact({ campaignId, moduleId: first.id, kind: 'npc', name: 'Wraith' }),
      // The shadow: Tide Gate's own same-named row wins Tide Gate's prose
      // (module-tier precedence, D8) — it never mentions Ember Crypt's row.
      createArtifact({ campaignId, moduleId: second.id, kind: 'npc', name: 'Wraith' }),
    ];

    const rows = deriveModuleOrphans(first, pool);

    expect(rows.map((row) => row.artifact.id)).toEqual([pool[0]?.id]);
    expect(rows[0]?.ambiguous).toBe(false);
  });

  it("excludes ambiguity-shadowed rows — only the reader's winner gets the node", () => {
    const campaignId = newModuleCampaign();
    const module = moduleWithProse(campaignId, 'Ember Crypt', 'A quiet shore.');
    const pool: AnyArtifact[] = [
      createArtifact({ campaignId, moduleId: module.id, kind: 'npc', name: 'Goblin' }),
      createArtifact({ campaignId, moduleId: module.id, kind: 'npc', name: 'Goblin' }),
    ];

    const rows = deriveModuleOrphans(module, pool);

    // Both rows carry the tag's candidate shape, but both are shadowed:
    // the panel excludes them from deletion (resolve the duplicate first).
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.ambiguous)).toBe(true);
  });

  it('a campaign-level same-named row does not shadow the module-owned row (D8 tiering)', () => {
    const campaignId = newModuleCampaign();
    const module = moduleWithProse(campaignId, 'Ember Crypt', 'A quiet shore.');
    const pool: AnyArtifact[] = [
      createArtifact({ campaignId, moduleId: module.id, kind: 'npc', name: 'Goblin' }),
      createArtifact({ campaignId, kind: 'npc', name: 'Goblin' }),
    ];

    const rows = deriveModuleOrphans(module, pool);

    // The module's own entity wins tier 0 inside its module — no ambiguity.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ambiguous).toBe(false);
    expect(rows[0]?.artifact.moduleId).toBe(module.id);
  });

  it('never candidates pc rows, and includes plotarc (owner-ratified)', () => {
    const campaignId = newModuleCampaign();
    const module = moduleWithProse(campaignId, 'Ember Crypt', 'A quiet shore.');
    const pool: AnyArtifact[] = [
      createArtifact({ campaignId, moduleId: module.id, kind: 'pc', name: 'Serren' }),
      createArtifact({ campaignId, moduleId: module.id, kind: 'plotarc', name: 'The Long Winter' }),
      createArtifact({ campaignId, moduleId: module.id, kind: 'encounter', name: 'Ambush' }),
    ];

    const rows = deriveModuleOrphans(module, pool);

    expect(rows.map((row) => row.artifact.name).sort()).toEqual(['Ambush', 'The Long Winter']);
  });

  it('sorts deterministically by name', () => {
    const campaignId = newModuleCampaign();
    const module = moduleWithProse(campaignId, 'Ember Crypt', 'A quiet shore.');
    const pool: AnyArtifact[] = [
      createArtifact({ campaignId, moduleId: module.id, kind: 'npc', name: 'Zeta' }),
      createArtifact({ campaignId, moduleId: module.id, kind: 'npc', name: 'Alpha' }),
      createArtifact({ campaignId, moduleId: module.id, kind: 'npc', name: 'Mid' }),
    ];

    const rows = deriveModuleOrphans(module, pool);

    expect(rows.map((row) => row.artifact.name)).toEqual(['Alpha', 'Mid', 'Zeta']);
  });
});

function newModuleCampaign(): Id {
  return newId();
}
