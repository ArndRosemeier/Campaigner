import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { creatureRowAiRefusal } from '@/features/campaign/creature-row-guard';
import { changeArtifact } from '@/features/modules/change-artifact';
import {
  claimModuleGeneration,
  isModuleGenerationClaimed,
  releaseModuleGeneration,
} from '@/llm/canvasBusy';
import { ModuleBusyError } from '@/llm/moduleGen';
import { createArtifact, getAnyArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { saveModule } from '@/db/moduleRepo';
import { createModule, newId, type Campaign, type Module } from '@/domain';
import { useProgressStore } from '@/lib/progress';
import { clearDatabase } from '../db/helpers';

/**
 * THE change seam (docs/17 row 101, docs/18 §2): one entry point, routed by the
 * RESOLVED artifact's kind, onto the specialist that already exists.
 *
 * Both specialists are mocked HERE on purpose: the assertion target is the
 * ROUTE (which engine was asked, with what) plus the seam's own decisions
 * (refusals, the busy gate, failure propagation). The instruction's arrival in
 * a real prompt is pinned where the engine really runs it —
 * `tests/features/change-artifact-instruction.test.ts` (the entity brief handed
 * to the run engine) and `tests/llm/encounterRepopulate.test.ts` (the encounter
 * prompt handed to the model), and the no-instruction bytes are pinned by the
 * full-literal brief/contract assertions those files already carried.
 */

const { repopulateMock, regenerateMock, runEntityBatchMock } = vi.hoisted(() => ({
  repopulateMock: vi.fn(),
  regenerateMock: vi.fn(),
  runEntityBatchMock: vi.fn(),
}));

vi.mock('@/features/campaign/encounterRegen', () => ({
  repopulateEncounter: repopulateMock,
  regenerateEncounterEverything: regenerateMock,
}));

vi.mock('@/features/modules/entity-batch', () => ({
  runEntityBatch: runEntityBatchMock,
}));

interface World {
  campaign: Campaign;
  module: Module;
}

async function seedWorld(): Promise<World> {
  const campaign = await createCampaign({ name: 'Change Campaign', system: 'dnd5e' });
  const module = await saveModule({
    ...createModule({
      campaignId: campaign.id,
      title: 'The Drowned Chapter',
      concept: 'a drowned chapter house',
      levelMin: 1,
      levelMax: 3,
      tone: '',
      sizeDial: 'standard',
    }),
    spine: {
      premise: 'The chapter house sank with its chapter inside.',
      themes: [],
      writerModel: '',
      partPlan: [{ title: 'Descent', levelBand: '1', synopsis: '', levelUpTrigger: '' }],
    },
    parts: [
      {
        planIndex: 0,
        markdown: 'The stair sinks toward [[Halvar]] and the [[Sunken Vault]].',
        status: 'ready',
        errorMessage: '',
        edited: false,
        writerModel: '',
      },
    ],
  });
  return { campaign, module };
}

async function seedNpc(world: World, name = 'Halvar'): Promise<string> {
  const npc = await createArtifact({
    campaignId: world.campaign.id,
    moduleId: world.module.id,
    kind: 'npc',
    name,
    summary: 'A giant at the stair.',
    body: 'Halvar blocks the stair.',
    data: { appearance: 'Huge', personality: 'Gruff', statBlock: null },
  });
  return npc.id;
}

async function seedEncounter(world: World): Promise<string> {
  const encounter = await createArtifact({
    campaignId: world.campaign.id,
    moduleId: world.module.id,
    kind: 'encounter',
    name: 'The Sunken Vault',
    summary: 'A vault fight.',
    body: 'The vault.',
    data: {
      difficulty: '',
      levelHint: '1',
      monsters: [],
      terrain: '',
      tactics: '',
      treasure: '',
      mapImageId: null,
      preset: 'standard',
      locationKind: 'other',
      siteShape: 'single',
      budgetAdvisory: '',
      layout: null,
    },
  });
  return encounter.id;
}

function produced(name: string, artifactId: string) {
  return { generated: [name], produced: [{ name, artifactId }], failed: [] };
}

beforeEach(async () => {
  await clearDatabase();
  useProgressStore.getState().reset();
  repopulateMock.mockReset();
  regenerateMock.mockReset();
  runEntityBatchMock.mockReset();
  repopulateMock.mockResolvedValue(undefined);
  regenerateMock.mockResolvedValue(undefined);
});

describe('the route is chosen from the resolved artifact kind', () => {
  it('an encounter change runs the operation the caller named — one specialist, no other', async () => {
    const world = await seedWorld();
    const encounterId = await seedEncounter(world);

    const result = await changeArtifact({
      artifactId: encounterId,
      encounter: { operation: 'repopulate', redesignProse: true },
    });

    expect(result).toEqual({
      status: 'changed',
      artifactId: encounterId,
      kind: 'encounter',
      operation: 'encounter-repopulate',
    });
    expect(repopulateMock).toHaveBeenCalledTimes(1);
    expect(repopulateMock).toHaveBeenCalledWith(encounterId, { redesignProse: true });
    expect(regenerateMock).not.toHaveBeenCalled();
    expect(runEntityBatchMock).not.toHaveBeenCalled();
  });

  it('"everything" reaches the other encounter operation and forwards its per-run option', async () => {
    const world = await seedWorld();
    const encounterId = await seedEncounter(world);

    const result = await changeArtifact({
      artifactId: encounterId,
      encounter: { operation: 'everything', dungeonMapPath: 'vision' },
    });

    expect(result.status).toBe('changed');
    expect(result).toMatchObject({ operation: 'encounter-regenerate-everything' });
    expect(regenerateMock).toHaveBeenCalledWith(encounterId, {
      redesignProse: false,
      dungeonMapPath: 'vision',
    });
    expect(repopulateMock).not.toHaveBeenCalled();
    expect(runEntityBatchMock).not.toHaveBeenCalled();
  });

  it('an entity change reaches the entity engine with the SAME row as its in-place target', async () => {
    const world = await seedWorld();
    const npcId = await seedNpc(world);
    runEntityBatchMock.mockResolvedValue(produced('Halvar', npcId));

    const result = await changeArtifact({
      artifactId: npcId,
      instruction: '  Make her a smuggler captain with a grudge.  ',
    });

    expect(result).toEqual({
      status: 'changed',
      artifactId: npcId,
      kind: 'npc',
      operation: 'entity-redesign',
    });
    expect(runEntityBatchMock).toHaveBeenCalledTimes(1);
    const input = runEntityBatchMock.mock.calls[0]?.[0] as {
      kind: string;
      targets: unknown;
      instruction?: string;
      module: { id: string };
      campaign: { id: string };
    };
    expect(input.kind).toBe('npc');
    // The target is the artifact that EXISTS — never a created second row.
    expect(input.targets).toEqual([{ name: 'Halvar', artifactId: npcId }]);
    // Trimmed ONCE at the boundary: what reaches the prompt is these bytes.
    expect(input.instruction).toBe('Make her a smuggler captain with a grudge.');
    // Context resolved FROM the row, not from the caller.
    expect(input.module.id).toBe(world.module.id);
    expect(input.campaign.id).toBe(world.campaign.id);
    expect(repopulateMock).not.toHaveBeenCalled();
    expect(regenerateMock).not.toHaveBeenCalled();
  });

  it('every entity kind the module lane serves takes the same route', async () => {
    const world = await seedWorld();
    for (const kind of ['npc', 'location', 'event', 'faction', 'note'] as const) {
      runEntityBatchMock.mockReset();
      const row = await createArtifact({
        campaignId: world.campaign.id,
        moduleId: world.module.id,
        kind,
        name: `Row ${kind}`,
        summary: 's',
        body: 'b',
      });
      runEntityBatchMock.mockResolvedValue(produced(row.name, row.id));
      const result = await changeArtifact({ artifactId: row.id });
      expect(result).toMatchObject({ status: 'changed', kind, operation: 'entity-redesign' });
      expect(runEntityBatchMock).toHaveBeenCalledTimes(1);
      expect((runEntityBatchMock.mock.calls[0]?.[0] as { kind: string }).kind).toBe(kind);
    }
  });
});

describe('the instruction is optional and only ever ADDS a paragraph', () => {
  it('a change with no instruction forwards NO instruction field at all', async () => {
    const world = await seedWorld();
    const encounterId = await seedEncounter(world);
    const npcId = await seedNpc(world);
    runEntityBatchMock.mockResolvedValue(produced('Halvar', npcId));

    await changeArtifact({ artifactId: encounterId, encounter: { operation: 'repopulate' } });
    await changeArtifact({ artifactId: npcId });

    const encounterOptions = repopulateMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(encounterOptions).not.toHaveProperty('instruction');
    const entityInput = runEntityBatchMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(entityInput).not.toHaveProperty('instruction');
  });

  it('an empty instruction is the same "none" as an omitted one (no empty paragraph)', async () => {
    const world = await seedWorld();
    const encounterId = await seedEncounter(world);

    await changeArtifact({
      artifactId: encounterId,
      instruction: '   ',
      encounter: { operation: 'repopulate' },
    });

    expect(repopulateMock.mock.calls[0]?.[1]).toEqual({ redesignProse: false });
  });
});

describe('what the seam refuses, it refuses out loud and writes nothing', () => {
  it('a bestiary creature row is REFUSED with the shared reason, and no engine is called', async () => {
    const world = await seedWorld();
    const chunkId = newId();
    const creature = await createArtifact({
      campaignId: world.campaign.id,
      kind: 'npc',
      name: 'Goblin Boss',
      summary: '',
      body: '',
      data: { appearance: '', personality: '', statBlock: null, monsterChunkId: chunkId },
    });
    const before = JSON.stringify(await getAnyArtifact(creature.id));
    const { db } = await import('@/db');
    const runsBefore = await db.runs.count();
    const revisionsBefore = await db.revisions.count();

    const result = await changeArtifact({ artifactId: creature.id, instruction: 'Make it a chief.' });

    expect(result).toEqual({
      status: 'refused',
      artifactId: creature.id,
      kind: 'npc',
      reason: creatureRowAiRefusal('Goblin Boss'),
    });
    // Nothing was called and NOTHING was written (row bytes, runs, revisions).
    expect(runEntityBatchMock).not.toHaveBeenCalled();
    expect(repopulateMock).not.toHaveBeenCalled();
    expect(regenerateMock).not.toHaveBeenCalled();
    expect(JSON.stringify(await getAnyArtifact(creature.id))).toBe(before);
    expect(await db.runs.count()).toBe(runsBefore);
    expect(await db.revisions.count()).toBe(revisionsBefore);
  });

  it('a player character is UNSUPPORTED — the Party is authored, and nothing runs', async () => {
    const world = await seedWorld();
    const pc = await createArtifact({
      campaignId: world.campaign.id,
      kind: 'pc',
      name: 'Bryn',
      summary: 's',
      body: 'b',
    });

    const result = await changeArtifact({ artifactId: pc.id, instruction: 'Make her a paladin.' });

    expect(result.status).toBe('unsupported');
    expect(result).toMatchObject({ kind: 'pc' });
    if (result.status !== 'unsupported') throw new Error('expected an unsupported result');
    expect(result.reason).toContain('authored, not generated');
    expect(runEntityBatchMock).not.toHaveBeenCalled();
    expect(repopulateMock).not.toHaveBeenCalled();
    expect(regenerateMock).not.toHaveBeenCalled();
  });

  it('a plot arc is UNSUPPORTED — the entity lane has no plotarc', async () => {
    const world = await seedWorld();
    const arc = await createArtifact({
      campaignId: world.campaign.id,
      kind: 'plotarc',
      name: 'The Drowned Crown',
      summary: 's',
      body: 'b',
    });

    const result = await changeArtifact({ artifactId: arc.id, instruction: 'Raise the stakes.' });

    expect(result.status).toBe('unsupported');
    expect(result).toMatchObject({ kind: 'plotarc' });
    expect(runEntityBatchMock).not.toHaveBeenCalled();
  });

  it('a module-less entity row is REFUSED — there is no module text to ground in', async () => {
    const world = await seedWorld();
    const campaignLevel = await createArtifact({
      campaignId: world.campaign.id,
      kind: 'location',
      name: 'The Long Road',
      summary: 's',
      body: 'b',
    });

    const result = await changeArtifact({ artifactId: campaignLevel.id });

    expect(result.status).toBe('refused');
    expect(result).toMatchObject({ artifactId: campaignLevel.id, kind: 'location' });
    if (result.status !== 'refused') throw new Error('expected a refusal');
    expect(result.reason).toContain('belongs to no module');
    expect(runEntityBatchMock).not.toHaveBeenCalled();
  });

  it('a refusal never holds the module generation slot', async () => {
    const world = await seedWorld();
    const creature = await createArtifact({
      campaignId: world.campaign.id,
      moduleId: world.module.id,
      kind: 'npc',
      name: 'Goblin Boss',
      summary: '',
      body: '',
      data: { appearance: '', personality: '', statBlock: null, monsterChunkId: newId() },
    });

    await changeArtifact({ artifactId: creature.id, instruction: 'x' });

    expect(isModuleGenerationClaimed(world.module.id)).toBe(false);
  });

  it('a kind-option mismatch is a programming error, not a silent ignore', async () => {
    const world = await seedWorld();
    const npcId = await seedNpc(world);
    const encounterId = await seedEncounter(world);

    await expect(
      changeArtifact({ artifactId: npcId, encounter: { operation: 'repopulate' } }),
    ).rejects.toThrow(/apply to encounters only/);
    await expect(changeArtifact({ artifactId: encounterId })).rejects.toThrow(
      /must name its operation/,
    );
    expect(repopulateMock).not.toHaveBeenCalled();
    expect(regenerateMock).not.toHaveBeenCalled();
    expect(runEntityBatchMock).not.toHaveBeenCalled();
  });

  it('a vanished artifact is a loud throw', async () => {
    await expect(changeArtifact({ artifactId: newId() })).rejects.toThrow(/no longer exists/);
  });
});

describe('uniform semantics: the existing busy gate and loud failures', () => {
  it('the existing one-generation-per-module gate throws its own ModuleBusyError', async () => {
    const world = await seedWorld();
    const npcId = await seedNpc(world);
    claimModuleGeneration(world.module.id);
    try {
      await expect(changeArtifact({ artifactId: npcId, instruction: 'x' })).rejects.toBeInstanceOf(
        ModuleBusyError,
      );
      expect(runEntityBatchMock).not.toHaveBeenCalled();
      // The seam must not release a claim it never took.
      expect(isModuleGenerationClaimed(world.module.id)).toBe(true);
    } finally {
      // release the way the claim owner does
      releaseModuleGeneration(world.module.id);
    }
  });

  it('a successful change releases the slot it took', async () => {
    const world = await seedWorld();
    const npcId = await seedNpc(world);
    runEntityBatchMock.mockResolvedValue(produced('Halvar', npcId));

    await changeArtifact({ artifactId: npcId, instruction: 'x' });

    expect(isModuleGenerationClaimed(world.module.id)).toBe(false);
  });

  it('a specialist that throws propagates — loudly, and the slot is released', async () => {
    const world = await seedWorld();
    const encounterId = await seedEncounter(world);
    repopulateMock.mockRejectedValueOnce(new Error('The Encounter Smith persona is missing'));

    await expect(
      changeArtifact({ artifactId: encounterId, encounter: { operation: 'repopulate' } }),
    ).rejects.toThrow('The Encounter Smith persona is missing');

    expect(isModuleGenerationClaimed(world.module.id)).toBe(false);
  });

  it('a batch failure is thrown with the specialist reason, never returned as a quiet status', async () => {
    const world = await seedWorld();
    const npcId = await seedNpc(world);
    runEntityBatchMock.mockResolvedValue({
      generated: [],
      produced: [],
      failed: [{ name: 'Halvar', message: 'run ended failed: schema rejected the draft' }],
    });

    await expect(changeArtifact({ artifactId: npcId, instruction: 'x' })).rejects.toThrow(
      /Halvar» did not complete: run ended failed: schema rejected the draft/,
    );
    expect(isModuleGenerationClaimed(world.module.id)).toBe(false);
  });
});
