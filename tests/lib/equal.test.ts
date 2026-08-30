import { describe, expect, it } from 'vitest';

import { deepEqual, stableStringify } from '@/lib/equal';

describe('stableStringify', () => {
  it('sorts object keys so key order does not matter', () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  it('ignores undefined-valued keys', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
  });

  it('keeps array order significant', () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });

  it('handles nested structures and primitives', () => {
    const a = { tags: ['x', 'y'], data: { nested: { deep: [true, null, 3] } }, s: 'text' };
    const b = { s: 'text', data: { nested: { deep: [true, null, 3] } }, tags: ['x', 'y'] };
    expect(stableStringify(a)).toBe(stableStringify(b));
    expect(stableStringify('text')).toBe('"text"');
    expect(stableStringify(null)).toBe('null');
  });
});

describe('deepEqual', () => {
  it('treats reordered objects as equal', () => {
    expect(deepEqual({ a: [1, { c: 2, b: 3 }] }, { a: [1, { b: 3, c: 2 }] })).toBe(true);
  });

  it('detects value differences', () => {
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(deepEqual('x', 'y')).toBe(false);
  });
});
