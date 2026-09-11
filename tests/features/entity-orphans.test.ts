import 'fake-indexeddb/auto';

import { describe, expect, it } from 'vitest';

import {
  createArtifact,
  createModule,
  moduleSchema,
  newId,
  type AnyArtifact,
  type EncounterArtifactData,
  type Id,
  type Module,
  type MonsterEntry,
} from '@/domain';
import {
  deriveModuleOrphans,
  NO_SWEEP_REFUSALS,
  orphanOfferView,
} from '@/features/modules/entity-orphans';

/**
 * Orphaned-entity derivation (08-MODULE-DESIGNER §M4-C "Orphaned entities",
 * pure units): the module-scope tag — zero RESOLVING wiki-link mentions in
 * THIS module's prose — carrying every guard verdict the panel's props can
 * derive (the encounter roster, the ambiguity shadow). Mentions are wiki-link
 * tokens resolved via buildWikiGraph exactly like the reader (exact name then
 * aliases, case-insensitive, module-tier precedence) — never countOccurrences
 * substrings. The campaign-wide gate + the structural guards (battle
 * tokens/seeds, outline nodes) are the SWEEP's recount — the two surfaces run
 * ONE predicate and are pinned per candidate in
 * tests/features/orphan-offer-agreement.test.ts.
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

/** Encounter data with the given roster (the full schema shape, typed). */
function encounterDataWith(monsters: MonsterEntry[]): EncounterArtifactData {
  return {
    difficulty: '',
    levelHint: '',
    monsters,
    terrain: '',
    tactics: '',
    treasure: '',
    mapImageId: null,
    layout: null,
    preset: 'standard',
    locationKind: 'other',
    siteShape: 'single',
    budgetAdvisory: '',
  };
}

/** A roster entry citing a module-owned npc artifact (guard 6's carrier). */
function npcRefEntry(name: string, artifactId: Id): MonsterEntry {
  return { name, count: 1, notes: '', treasure: '', source: { type: 'npc-ref', artifactId } };
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
    expect(rows[0]?.refusal).toBeNull();
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
    expect(rows.map((row) => row.refusal?.guard)).toEqual(['ambiguity', 'ambiguity']);
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
    expect(rows[0]?.refusal).toBeNull();
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

/**
 * The owner's report (docs/17 row 92): the panel offered two creatures for
 * deletion, the sweep refused both because a LIVE ENCOUNTER's roster cites
 * them, and the offer came straight back. The roster guard is derivable from
 * the panel's own props, so the derivation refuses them BEFORE any sweep.
 */
describe('deriveModuleOrphans — the roster guard (never offered)', () => {
  it("keeps both of the owner's lumberjacks with the encounter's own reason, unswept", () => {
    const campaignId = newModuleCampaign();
    // The encounter IS mentioned (the module's prose stages the fight), so it
    // survives a sweep and its citations keep guarding.
    const module = moduleWithProse(campaignId, 'Ember Crypt', 'Fight the [[Bog Ambush]].');
    const risen = createArtifact({
      campaignId,
      moduleId: module.id,
      kind: 'npc',
      name: 'Risen Lumberjack',
    });
    const bog = createArtifact({
      campaignId,
      moduleId: module.id,
      kind: 'npc',
      name: 'Bog Lumberjack',
    });
    const encounter = createArtifact({
      campaignId,
      moduleId: module.id,
      kind: 'encounter',
      name: 'Bog Ambush',
      data: encounterDataWith([
        npcRefEntry('Risen Lumberjack', risen.id),
        npcRefEntry('Bog Lumberjack', bog.id),
      ]),
    });

    const rows = deriveModuleOrphans(module, [risen, bog, encounter]);

    // Both rows are tagged orphans and both are in use — the panel never
    // offers them, and the reason text is the sweep's own.
    expect(rows.map((row) => row.artifact.name)).toEqual(['Bog Lumberjack', 'Risen Lumberjack']);
    expect(rows.map((row) => row.refusal?.guard)).toEqual([
      'encounter-roster',
      'encounter-roster',
    ]);
    expect(rows.map((row) => row.refusal?.reason)).toEqual([
      'roster entry "Bog Lumberjack" of the encounter "Bog Ambush"',
      'roster entry "Risen Lumberjack" of the encounter "Bog Ambush"',
    ]);

    const view = orphanOfferView(rows, NO_SWEEP_REFUSALS);
    expect(view.group.map((entry) => entry.inUseReason)).toEqual([
      'roster entry "Bog Lumberjack" of the encounter "Bog Ambush"',
      'roster entry "Risen Lumberjack" of the encounter "Bog Ambush"',
    ]);
    // Nothing deletable: there is no offer to make, before any sweep has run.
    expect(view.group.filter((entry) => entry.inUseReason === null)).toEqual([]);
  });

  it('a roster citation by an encounter that is itself deletable does NOT keep the row', () => {
    const campaignId = newModuleCampaign();
    // A quiet module: nothing is mentioned, so the encounter is an orphan too
    // and a sweep deletes it — its citations go with it (survivor semantics,
    // the sweep's own rule; the derivation must agree).
    const module = moduleWithProse(campaignId, 'Ember Crypt', 'A quiet shore.');
    const guard = createArtifact({
      campaignId,
      moduleId: module.id,
      kind: 'npc',
      name: 'Gate Guard',
    });
    const encounter = createArtifact({
      campaignId,
      moduleId: module.id,
      kind: 'encounter',
      name: 'Doomed Fight',
      data: encounterDataWith([npcRefEntry('Gate Guard', guard.id)]),
    });

    const rows = deriveModuleOrphans(module, [guard, encounter]);

    expect(rows.map((row) => row.artifact.name)).toEqual(['Doomed Fight', 'Gate Guard']);
    expect(rows.map((row) => row.refusal)).toEqual([null, null]);
    expect(
      orphanOfferView(rows, NO_SWEEP_REFUSALS).group.filter(
        (entry) => entry.inUseReason === null,
      ),
    ).toHaveLength(2);
  });
});

/**
 * The panel's offer: the derivation plus the refusals a sweep returned. The
 * guards the props cannot judge (cross-module mentions, battle tokens/seeds,
 * outline nodes) land here, so a refusal never leaves the same rows offered.
 */
describe('orphanOfferView — the offer after a sweep', () => {
  it('a recorded sweep refusal moves the row out of the offer, with the sweep reason', () => {
    const campaignId = newModuleCampaign();
    const module = moduleWithProse(campaignId, 'Ember Crypt', 'A quiet shore.');
    const wraith = createArtifact({
      campaignId,
      moduleId: module.id,
      kind: 'npc',
      name: 'Lonely Wraith',
    });
    const free = createArtifact({ campaignId, moduleId: module.id, kind: 'plotarc', name: 'Free' });

    const rows = deriveModuleOrphans(module, [wraith, free]);
    expect(rows.map((row) => row.refusal)).toEqual([null, null]);

    const view = orphanOfferView(
      rows,
      new Map([[wraith.id, 'a portrait token on the battle of "Tide Gate"']]),
    );

    expect(view.group.map((entry) => [entry.row.artifact.name, entry.inUseReason])).toEqual([
      ['Free', null],
      ['Lonely Wraith', 'a portrait token on the battle of "Tide Gate"'],
    ]);
    // The offer is the deletable row alone.
    expect(view.group.filter((entry) => entry.inUseReason === null).map((e) => e.row.artifact.name))
      .toEqual(['Free']);
  });

  it('ambiguity-shadowed rows stay outside the group AND outside the offer', () => {
    const campaignId = newModuleCampaign();
    const module = moduleWithProse(campaignId, 'Ember Crypt', 'A quiet shore.');
    const pool: AnyArtifact[] = [
      createArtifact({ campaignId, moduleId: module.id, kind: 'npc', name: 'Goblin' }),
      createArtifact({ campaignId, moduleId: module.id, kind: 'npc', name: 'Goblin' }),
    ];

    const rows = deriveModuleOrphans(module, pool);
    const view = orphanOfferView(rows, NO_SWEEP_REFUSALS);

    expect(view.group).toEqual([]);
    expect(view.hidden.map((row) => row.refusal?.guard)).toEqual(['ambiguity', 'ambiguity']);
  });
});

function newModuleCampaign(): Id {
  return newId();
}
