import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { createArtifact, getArtifact, listArtifactsByCampaign } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { createDeliverable } from '@/db/deliverableRepo';
import { createModule, saveSpine } from '@/db/moduleRepo';
import { sweepOrphanedArtifacts, type OrphanSweepOutcome } from '@/db/orphanSweep';
import { db } from '@/db/db';
import {
  battleSchema,
  createModule as createModuleSchema,
  fullInclude,
  newId,
  stampNewEntity,
  type Battle,
  type BattleBoard,
  type EncounterArtifactData,
  type Id,
  type Module,
  type MonsterEntry,
} from '@/domain';
import { emptyBoard } from '@/domain/battle/board';
import {
  deriveModuleOrphans,
  NO_SWEEP_REFUSALS,
  orphanOfferView,
  type ModuleOrphanRow,
  type OrphanOfferView,
} from '@/features/modules/entity-orphans';
import { clearDatabase } from '../db/helpers';

/**
 * THE OFFER IS TRUTHFUL — the AGREEMENT PIN (08-MODULE-DESIGNER §M4-C
 * "Orphaned entities"; docs/17 row 92).
 *
 * `entity-orphans.ts` and `orphanSweep.ts` decided "deletable" with two
 * separate walks of the same guards before this pin existed, and the claim
 * that tests pinned them to identical decisions was never true: the sweep's
 * guard tests never compared the two surfaces. The owner paid for the
 * divergence — "Delete 2 orphans" offered two creatures a live encounter's
 * roster cites, the sweep refused both, and the offer came back forever.
 *
 * Now ONE function (`evaluateOrphanGuards`) decides, and this file pins the
 * two surfaces per candidate on ONE fixture set covering every guard:
 * (1) campaign-wide mention, (2) ambiguity shadow, (3) battle portrait token,
 * (4) frozen seed fighter, (5) deliverable outline node, (6) encounter roster
 * (both `npc-ref` and rulebook `mobArtifactId`). Guards 3–5 plus the
 * cross-module half of guard 1 need data the panel's props do not carry
 * (docs/18 §4 names the limitation), so the panel's agreement is pinned on
 * its EFFECTIVE OFFER: the read-time derivation composed with the refusals a
 * sweep returned (`orphanOfferView`) — after any sweep the panel offers
 * exactly what the deleter deletes.
 */

/** A module with one premise line (prose is where mentions live). */
async function proseModule(campaignId: Id, title: string, premise: string): Promise<Module> {
  const module = await createModule(
    createModuleSchema({
      campaignId,
      title,
      concept: '',
      levelMin: 1,
      levelMax: 3,
      sizeDial: 'sketch',
    }),
  );
  return saveSpine(module.id, {
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
  });
}

/** A live battle row carrying the given board/seed fighters (write-normalized). */
async function putBattle(
  campaignId: Id,
  moduleId: Id,
  board: Partial<BattleBoard>,
  seedFighters: Battle['seedFighters'] = [],
): Promise<void> {
  await db.battles.put(
    battleSchema.parse({
      ...stampNewEntity(),
      campaignId,
      moduleId,
      encounterArtifactId: null,
      reseed: null,
      board: { ...emptyBoard(), ...board },
      seedFighters,
    }),
  );
}

function tokenFor(artifactId: Id): Battle['board']['tokens'][number] {
  return {
    id: newId(),
    artifactId,
    label: 'Fighter',
    x: 0.5,
    y: 0.5,
    visible: true,
    scale: 1,
    shape: 'portrait',
    color: null,
    currentHp: 10,
    initiativeRoll: null,
    initiativeBonus: 2,
    treasure: '',
    conditions: [],
  };
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

function npcRefEntry(name: string, artifactId: Id): MonsterEntry {
  return { name, count: 1, notes: '', treasure: '', source: { type: 'npc-ref', artifactId } };
}

/** The panel's read-time derivation, over the campaign pool its props carry. */
async function panelRows(module: Module): Promise<ModuleOrphanRow[]> {
  return deriveModuleOrphans(module, await listArtifactsByCampaign(module.campaignId));
}

/** The panel's EFFECTIVE offer: derivation + the refusals a sweep returned. */
function offeredView(
  rows: readonly ModuleOrphanRow[],
  outcome: OrphanSweepOutcome,
): OrphanOfferView {
  return orphanOfferView(rows, new Map(outcome.kept.map((row) => [row.id, row.reason])));
}

/** Names the offer would delete, alphabetical. */
function offeredNames(view: OrphanOfferView): string[] {
  return view.group
    .filter((entry) => entry.inUseReason === null)
    .map((entry) => entry.row.artifact.name)
    .sort();
}

/** The reason the group shows for one row (undefined = the row is not shown). */
function inUseReasonFor(view: OrphanOfferView, name: string): string | null | undefined {
  return view.group.find((entry) => entry.row.artifact.name === name)?.inUseReason;
}

beforeEach(clearDatabase);

describe("the owner's exact shape, end to end", () => {
  it('offers neither lumberjack, and the sweep refuses both with the encounter named', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    // The encounter is staged by the prose ([[Bog Ambush]]), so it survives
    // the sweep and its roster citations keep guarding.
    const module = await proseModule(campaign.id, 'Ember Crypt', 'Fight the [[Bog Ambush]].');
    const risen = await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'npc',
      name: 'Risen Lumberjack',
    });
    const bog = await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'npc',
      name: 'Bog Lumberjack',
    });
    await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'encounter',
      name: 'Bog Ambush',
      data: encounterDataWith([
        npcRefEntry('Risen Lumberjack', risen.id),
        npcRefEntry('Bog Lumberjack', bog.id),
      ]),
    });

    // The panel: two rows, both IN USE, nothing deletable — the destructive
    // control cannot appear, before any sweep has run.
    const rows = await panelRows(module);
    expect(rows.map((row) => row.artifact.name)).toEqual(['Bog Lumberjack', 'Risen Lumberjack']);
    const view = orphanOfferView(rows, NO_SWEEP_REFUSALS);
    expect(offeredNames(view)).toEqual([]);
    expect(inUseReasonFor(view, 'Risen Lumberjack')).toBe(
      'roster entry "Risen Lumberjack" of the encounter "Bog Ambush"',
    );
    expect(inUseReasonFor(view, 'Bog Lumberjack')).toBe(
      'roster entry "Bog Lumberjack" of the encounter "Bog Ambush"',
    );

    // The deleter: exactly the same decision, with the same reason text.
    const outcome = await sweepOrphanedArtifacts(module.id);
    expect(outcome).toEqual({
      deleted: [],
      kept: [
        { id: bog.id, name: 'Bog Lumberjack', reason: inUseReasonFor(view, 'Bog Lumberjack') },
        {
          id: risen.id,
          name: 'Risen Lumberjack',
          reason: inUseReasonFor(view, 'Risen Lumberjack'),
        },
      ],
    });
    expect((await getArtifact(risen.id))?.name).toBe('Risen Lumberjack');
    expect((await getArtifact(bog.id))?.name).toBe('Bog Lumberjack');

    // And the offer after the sweep still deletes nothing (no loop).
    expect(offeredNames(offeredView(rows, outcome))).toEqual([]);
  });
});

describe('the panel derivation and the sweep agree per candidate (all five guards)', () => {
  /**
   * ONE fixture set, every guard: `Echo` is mentioned by ANOTHER module's
   * prose (guard 1), `Doppel` twice (guard 2), `Tokened Wraith` on a battle
   * board (guard 3), `Seeded Wraith` as a frozen seed fighter (guard 4),
   * `Relic Ledger` in a deliverable outline (guard 5), `Gate Guard` and
   * `Goblin` cited by the surviving encounter's roster in both flavors
   * (guard 6) — and `The Long Winter`, which nothing references, deletes.
   */
  async function guardFixture(): Promise<{
    module: Module;
    ids: { first: Id; second: Id; free: Id };
  }> {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = await proseModule(campaign.id, 'Ember Crypt', 'Fight the [[Ambush]].');
    const other = await proseModule(campaign.id, 'Tide Gate', 'The [[Echo]] returns at dusk.');

    // Mentioned only by module B's prose — the panel's props cannot see it.
    await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'npc',
      name: 'Echo',
    });
    const first = await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'npc',
      name: 'Doppel',
    });
    const second = await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'npc',
      name: 'Doppel',
    });
    const tokened = await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'npc',
      name: 'Tokened Wraith',
    });
    const seeded = await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'npc',
      name: 'Seeded Wraith',
    });
    const relic = await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'note',
      name: 'Relic Ledger',
    });
    const guard = await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'npc',
      name: 'Gate Guard',
    });
    const mob = await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'npc',
      name: 'Goblin',
    });
    const free = await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'plotarc',
      name: 'The Long Winter',
    });

    await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'encounter',
      name: 'Ambush',
      data: encounterDataWith([
        npcRefEntry('Gate Guard', guard.id),
        {
          name: 'Goblin',
          count: 2,
          notes: '',
          treasure: '',
          source: { type: 'rulebook', chunkId: newId(), mobArtifactId: mob.id },
        },
      ]),
    });
    // The battle lives in the OTHER module — the guard is campaign-wide.
    await putBattle(campaign.id, other.id, { tokens: [tokenFor(tokened.id)] }, [
      { id: seeded.id, name: 'Seeded Wraith', maxHp: 9, initiativeBonus: 2 },
    ]);
    await createDeliverable({
      campaignId: campaign.id,
      title: 'Ember PDF',
      subtitle: '',
      audience: 'gm',
      coverImageId: null,
      outline: [
        {
          type: 'chapter',
          title: 'Chapter 1',
          children: [{ type: 'artifact', artifactId: relic.id, include: fullInclude() }],
        },
      ],
    });

    return { module, ids: { first: first.id, second: second.id, free: free.id } };
  }

  it('the derivation refuses the two derivable guards, and names what it cannot judge', async () => {
    const { module } = await guardFixture();
    const rows = await panelRows(module);
    const view = orphanOfferView(rows, NO_SWEEP_REFUSALS);

    // Derivable at read time: the encounter roster (both flavors). The
    // ambiguity shadow is hidden entirely (the duplicate must be resolved).
    expect(inUseReasonFor(view, 'Gate Guard')).toBe(
      'roster entry "Gate Guard" of the encounter "Ambush"',
    );
    expect(inUseReasonFor(view, 'Goblin')).toBe(
      'mob artifact for roster entry "Goblin" of the encounter "Ambush"',
    );
    expect(view.hidden.map((row) => row.artifact.name)).toEqual(['Doppel', 'Doppel']);

    // NOT derivable from these props (docs/18 §4): the cross-module mention,
    // the battle carriers and the outline node are still offered until a
    // sweep has spoken — named here so the limitation cannot be forgotten.
    expect(offeredNames(view)).toEqual([
      'Echo',
      'Relic Ledger',
      'Seeded Wraith',
      'The Long Winter',
      'Tokened Wraith',
    ]);
  });

  it('agrees with the sweep per candidate once the sweep has decided', async () => {
    const { module, ids } = await guardFixture();
    const rows = await panelRows(module);
    const outcome = await sweepOrphanedArtifacts(module.id);
    const view = offeredView(rows, outcome);

    // Per candidate: offered ⇔ deleted, and every kept row's reason is the
    // reason the panel renders for it — one predicate, no drift.
    expect(offeredNames(view)).toEqual([...outcome.deleted.map((row) => row.name)].sort());
    expect(offeredNames(view)).toEqual(['The Long Winter']);
    expect(inUseReasonFor(view, 'Echo')).toBe(
      'mentioned in campaign prose — "Tide Gate" premise ×1',
    );
    expect(inUseReasonFor(view, 'Tokened Wraith')).toBe(
      'a portrait token on the battle of "Tide Gate"',
    );
    expect(inUseReasonFor(view, 'Seeded Wraith')).toBe(
      'a frozen seed fighter on the battle of "Tide Gate"',
    );
    expect(inUseReasonFor(view, 'Relic Ledger')).toBe(
      'an outline node of the deliverable "Ember PDF"',
    );
    for (const entry of view.group) {
      if (entry.inUseReason === null) continue;
      const kept = outcome.kept.find((row) => row.id === entry.row.artifact.id);
      expect(kept?.reason).toBe(entry.inUseReason);
    }

    // The shadowed pair is outside the group AND outside the sweep's report
    // (the offered predicate, unchanged) — and untouched on disk.
    expect(view.hidden.map((row) => row.artifact.name)).toEqual(['Doppel', 'Doppel']);
    expect(await getArtifact(ids.first)).toBeDefined();
    expect(await getArtifact(ids.second)).toBeDefined();
    // The genuinely unreferenced orphan was offered AND deleted.
    expect(await getArtifact(ids.free)).toBeUndefined();
  });
});
