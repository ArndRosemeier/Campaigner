import { describe, expect, it } from 'vitest';

import {
  DUNGEON_BENCH_LABELS,
  DUNGEON_BENCH_ROOMS,
  buildLabeledDungeonPrompt,
  normToPercent,
  parseDungeonVisionReply,
  runLabeledDungeonExperiment,
  type LabeledDungeonClients,
} from '@/features/lab/experiments/labeledDungeon';
import { getLabExperiment } from '@/features/lab/experiments/registry';

/**
 * Labeled-dungeon bench unit tests (mocked transports — no live LLM calls):
 * the norm→percent mapping, the vision boundary, the registry seam, and the
 * generation prompt contents.
 */

describe('normToPercent', () => {
  it('maps corners and center exactly', () => {
    expect(normToPercent(0)).toBe(0);
    expect(normToPercent(500)).toBe(50);
    expect(normToPercent(1000)).toBe(100);
  });

  it('clamps out-of-range input instead of leaking it into the overlay', () => {
    expect(normToPercent(-5)).toBe(0);
    expect(normToPercent(1200)).toBe(100);
  });

  it('maps non-finite input to the origin instead of NaN', () => {
    expect(normToPercent(Number.NaN)).toBe(0);
    expect(normToPercent(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('parseDungeonVisionReply', () => {
  it('parses a bare contract reply', () => {
    const parsed = parseDungeonVisionReply(
      '{"marks": [{"label": "A", "x": 123, "y": 456, "note": "on the floor"}]}',
    );
    expect(parsed.marks).toEqual([{ label: 'A', x: 123, y: 456, note: 'on the floor' }]);
  });

  it('tolerates prose and fence wrappers around the JSON', () => {
    const parsed = parseDungeonVisionReply(
      'Here are the plaques I see:\n```json\n{"marks": [{"label": "B", "x": 10, "y": 20}]}\n```\nThat is all.',
    );
    expect(parsed.marks).toEqual([{ label: 'B', x: 10, y: 20, note: undefined }]);
  });

  it('fails loud on malformed JSON (no partial disks from unparsed text)', () => {
    expect(() => parseDungeonVisionReply('A is at the top left, roughly')).toThrow();
  });

  it('fails loud on contract violations (bad label, out-of-range point)', () => {
    expect(() => parseDungeonVisionReply('{"marks": [{"label": "Z", "x": 1, "y": 2}]}')).toThrow();
    expect(() => parseDungeonVisionReply('{"marks": [{"label": "A", "x": 5000, "y": 2}]}')).toThrow();
    expect(() => parseDungeonVisionReply('{"marks": "A"}')).toThrow();
  });
});

describe('lab experiment registry', () => {
  it('returns the labeled-dungeon bench with its run config', () => {
    const experiment = getLabExperiment('labeled-dungeon-maps');
    expect(experiment?.title).toContain('vision');
    expect(experiment?.runLabel).not.toBe('');
    expect(experiment?.costNote).toContain('4 images');
    expect(experiment?.costNote).toContain('4 vision passes');
    expect(experiment?.Body).toBeDefined();
  });

  it('returns undefined for unknown ids', () => {
    expect(getLabExperiment('no-such-bench')).toBeUndefined();
  });
});

describe('buildLabeledDungeonPrompt', () => {
  it('contains all 8 letters, rooms, and the irregular/interconnected instruction', () => {
    const prompt = buildLabeledDungeonPrompt();
    for (const room of DUNGEON_BENCH_ROOMS) {
      expect(prompt).toContain(room.label);
      expect(prompt).toContain(room.name);
    }
    expect(DUNGEON_BENCH_LABELS).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
    expect(prompt).toMatch(/irregular/i);
    expect(prompt).toMatch(/interconnect/i);
    expect(prompt).toMatch(/no monsters/i);
  });
});

function fakeClients(overrides: Partial<LabeledDungeonClients> = {}): LabeledDungeonClients {
  return {
    generateMaps: () =>
      Promise.resolve({
        blobs: [new Blob(['map-a']), new Blob(['map-b'])],
        cappedToOne: false,
        modelUsed: 'test-image-model',
      }),
    visionPass: () =>
      Promise.resolve({
        text: '{"marks": [{"label": "A", "x": 100, "y": 200}]}',
        modelUsed: 'test-chat-model',
      }),
    blobToDataUrl: () => Promise.resolve('data:image/webp;base64,AAA'),
    ...overrides,
  };
}

describe('runLabeledDungeonExperiment', () => {
  it('marks found letters and reports the rest missing', async () => {
    const results = await runLabeledDungeonExperiment(fakeClients());
    expect(results).toHaveLength(2);
    expect(results[0]?.status).toBe('ok');
    expect(results[0]?.marks).toEqual([{ label: 'A', x: 100, y: 200, note: undefined }]);
    expect(results[0]?.missing).toEqual(['B', 'C', 'D', 'E', 'F', 'G', 'H']);
    expect(results[0]?.modelUsed).toBe('test-chat-model');
  });

  it('fails one image loud on a malformed reply — no disks, all letters missing', async () => {
    const results = await runLabeledDungeonExperiment(
      fakeClients({
        visionPass: () => Promise.resolve({ text: 'not json at all', modelUsed: 'test-chat-model' }),
      }),
    );
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.status).toBe('failed');
      expect(result.errorMessage).not.toBe('');
      expect(result.marks).toEqual([]);
      expect(result.missing).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
    }
  });

  it('keeps one bad pass from taking down the other maps', async () => {
    let calls = 0;
    const results = await runLabeledDungeonExperiment(
      fakeClients({
        visionPass: () => {
          calls += 1;
          if (calls === 1) return Promise.reject(new Error('the model has no vision input'));
          return Promise.resolve({ text: '{"marks": []}', modelUsed: 'test-chat-model' });
        },
      }),
    );
    expect(results[0]?.status).toBe('failed');
    expect(results[0]?.errorMessage).toContain('no vision input');
    expect(results[1]?.status).toBe('ok');
    expect(results[1]?.missing).toHaveLength(8);
  });

  it('throws loud when generation itself produces nothing', async () => {
    await expect(
      runLabeledDungeonExperiment(
        fakeClients({
          generateMaps: () => Promise.resolve({ blobs: [], cappedToOne: false, modelUsed: 'm' }),
        }),
      ),
    ).rejects.toThrow(/no map images/);
  });
});
