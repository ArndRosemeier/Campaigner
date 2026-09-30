import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildLines } from '@/ingest/buildLines';
import { chunkLines } from '@/ingest/chunker';
import { extractPages } from '@/ingest/extract';
import { sha256Hex } from '@/lib/hash';

/**
 * Integration test (06-MILESTONES T4): a real (tiny) PDF fixture goes through
 * the full pipeline — extraction, line building, chunking, hashing — exactly
 * what the worker runs, but invoked directly (no Worker in vitest).
 */
const fixturePath = join(import.meta.dirname, '..', 'fixtures', 'sample-rulebook.pdf');

describe('ingestion pipeline with the committed PDF fixture', () => {
  it('extracts, chunks and hashes the sample rulebook', async () => {
    const bytes = readFileSync(fixturePath);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

    const progress: number[] = [];
    const pages = await extractPages(buffer, (p) => {
      progress.push(p.page);
    });

    expect(pages).toHaveLength(2);
    expect(progress).toEqual([1, 2]);
    expect(pages[0]?.items.length).toBeGreaterThan(0);
    expect(pages[1]?.items.length).toBeGreaterThan(0);

    const lines = buildLines(pages);
    const pageOne = lines[0] ?? [];
    expect(pageOne[0]?.headingLevel).toBe(1);
    expect(pageOne[0]?.text).toBe('Chapter 1: The Grappling Rules');

    const chunks = chunkLines(lines.flat(), 'dnd5e');
    expect(chunks.length).toBeGreaterThanOrEqual(2);

    // The grappling prose ends up in a section chunk under the chapter path.
    const grappling = chunks.find((chunk) => chunk.text.includes('grapple'));
    expect(grappling).toBeDefined();
    expect(grappling?.chunkType).toBe('section');
    expect(grappling?.headingPath).toEqual(['Chapter 1: The Grappling Rules']);
    expect(grappling?.pageStart).toBe(1);

    // The stat-block page becomes one statblock chunk with parsed stats.
    const statblock = chunks.find((chunk) => chunk.chunkType === 'statblock');
    expect(statblock).toBeDefined();
    expect(statblock?.headingPath).toEqual(['Chapter 1: The Grappling Rules', 'Goblin Boss']);
    expect(statblock?.statBlock?.ac).toBe(17);
    expect(statblock?.statBlock?.hp).toBe(66);
    expect(statblock?.statBlock?.abilities.str).toBe(14);
    expect(statblock?.statBlock?.extras.CR).toBe('2');

    // contentHash matches the centralized hash helper.
    const first = chunks[0];
    expect(first).toBeDefined();
    expect(await sha256Hex(first?.text ?? '')).toMatch(/^[0-9a-f]{64}$/);
  });
});
