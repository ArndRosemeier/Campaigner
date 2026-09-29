import { describe, expect, it } from 'vitest';

import { emptyGenerateMaps, malformedVisionPass } from '../helpers/labBenchClients';

import { getLabExperiment } from '@/features/lab/experiments/registry';
import {
  UNLABELED_BENCH_ROOMS,
  UNLABELED_DUNGEON_ROOM_COUNT,
  buildUnlabeledDungeonPrompt,
  buildUnlabeledVisionInstruction,
  parseUnlabeledVisionReply,
  runUnlabeledDungeonExperiment,
  type UnlabeledDungeonClients,
} from '@/features/lab/experiments/unlabeledDungeon';

/**
 * Unlabeled-dungeon bench unit tests (mocked transports — no live LLM
 * calls): the prompt forbids painted marks, the vision contract is chamber
 * centers rather than letter plaques, and a short or long count is a
 * result rather than a repaired coordinate.
 */

describe('buildUnlabeledDungeonPrompt', () => {
  it('names all 15 rooms and forbids painted letters, numbers, and plaques', () => {
    const prompt = buildUnlabeledDungeonPrompt();
    expect(UNLABELED_DUNGEON_ROOM_COUNT).toBe(15);
    expect(UNLABELED_BENCH_ROOMS).toHaveLength(15);
    for (const room of UNLABELED_BENCH_ROOMS) {
      expect(prompt).toContain(room.name);
      expect(prompt).toContain(room.visualHook);
    }
    expect(prompt).toMatch(/unlabeled/i);
    expect(prompt).toMatch(/interconnect/i);
    expect(prompt).toMatch(/no monsters/i);
    expect(prompt).toMatch(/do not draw letters, numbers, plaques/i);
    expect(prompt).not.toMatch(/capital letter plaque/i);
    expect(prompt).not.toMatch(/Room [A-N]:/);
  });
});

describe('buildUnlabeledVisionInstruction', () => {
  it('asks for chamber centers and does not hand the model a letter vocabulary', () => {
    const instruction = buildUnlabeledVisionInstruction();
    expect(instruction).toMatch(/not labeled/i);
    expect(instruction).toMatch(/0–1000/);
    expect(instruction).toContain('"rooms"');
    expect(instruction).toContain('15 rooms');
    expect(instruction).toMatch(/never invent/i);
    expect(instruction).not.toMatch(/plaque letter/i);
    expect(instruction).not.toContain('Sunken Caravel');
  });
});

describe('parseUnlabeledVisionReply', () => {
  it('parses a bare contract reply', () => {
    const parsed = parseUnlabeledVisionReply(
      '{"rooms": [{"index": 1, "x": 123, "y": 456, "note": "flooded wreck"}]}',
    );
    expect(parsed.rooms).toEqual([{ index: 1, x: 123, y: 456, note: 'flooded wreck' }]);
  });

  it('tolerates prose and fence wrappers around the JSON', () => {
    const parsed = parseUnlabeledVisionReply(
      'Rooms I see:\n```json\n{"rooms": [{"index": 2, "x": 10, "y": 20}]}\n```',
    );
    expect(parsed.rooms).toEqual([{ index: 2, x: 10, y: 20, note: undefined }]);
  });

  it('fails loud on malformed JSON and on letter-plaque replies', () => {
    expect(() => parseUnlabeledVisionReply('there is a room in the corner')).toThrow();
    expect(() => parseUnlabeledVisionReply('{"marks": [{"label": "A", "x": 1, "y": 2}]}')).toThrow();
    expect(() => parseUnlabeledVisionReply('{"rooms": [{"index": 0, "x": 1, "y": 2}]}')).toThrow();
    expect(() => parseUnlabeledVisionReply('{"rooms": [{"index": 1, "x": 5000, "y": 2}]}')).toThrow();
  });
});

describe('lab experiment registry', () => {
  it('returns the unlabeled bench with a single 2K image in the cost note', () => {
    const experiment = getLabExperiment('unlabeled-dungeon-rooms');
    expect(experiment?.title).toContain('Unlabeled');
    expect(experiment?.runLabel).toContain('unlabeled-dungeon');
    expect(experiment?.costNote).toContain('1 image');
    expect(experiment?.costNote).toContain('2K');
    expect(experiment?.costNote).toContain('1 vision pass');
    expect(experiment?.Body).toBeDefined();
  });
});

function fakeClients(overrides: Partial<UnlabeledDungeonClients> = {}): UnlabeledDungeonClients {
  return {
    generateMaps: () =>
      Promise.resolve({
        blobs: [new Blob(['map'])],
        cappedToOne: false,
        modelUsed: 'test-image-model',
      }),
    visionPass: () =>
      Promise.resolve({
        text: '{"rooms": [{"index": 2, "x": 80, "y": 90, "note": "mushroom"}, {"index": 2, "x": 1, "y": 1}, {"index": 1, "x": 10, "y": 20}]}',
        modelUsed: 'test-chat-model',
      }),
    blobToDataUrl: () => Promise.resolve('data:image/webp;base64,AAA'),
    ...overrides,
  };
}

describe('runUnlabeledDungeonExperiment', () => {
  it('keeps the first sighting per index, sorts by index, and records the shortfall', async () => {
    const results = await runUnlabeledDungeonExperiment(fakeClients());
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('ok');
    expect(results[0]?.rooms).toEqual([
      { index: 1, x: 10, y: 20, note: undefined },
      { index: 2, x: 80, y: 90, note: 'mushroom' },
    ]);
    expect(results[0]?.droppedDuplicates).toBe(1);
    expect(results[0]?.expectedCount).toBe(15);
    expect(results[0]?.resolution).toBe('2K');
    expect(results[0]?.aspectRatio).toBe('16:9');
    expect(results[0]?.modelUsed).toBe('test-chat-model');
  });

  it('fails one image loud on a malformed reply and draws no rooms', async () => {
    const results = await runUnlabeledDungeonExperiment(
      fakeClients({
        visionPass: malformedVisionPass,
      }),
    );
    expect(results[0]?.status).toBe('failed');
    expect(results[0]?.errorMessage).not.toBe('');
    expect(results[0]?.rooms).toEqual([]);
    expect(results[0]?.expectedCount).toBe(15);
  });

  it('throws loud when generation itself produces nothing', async () => {
    await expect(
      runUnlabeledDungeonExperiment(
        fakeClients({
          generateMaps: emptyGenerateMaps,
        }),
      ),
    ).rejects.toThrow(/no map images/);
  });
});
