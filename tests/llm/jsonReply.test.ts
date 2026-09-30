import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  extractJsonText,
  formatZodIssues,
  parseErrorSummary,
  parseJsonReply,
} from '@/llm/jsonReply';

/**
 * The shared LLM-reply boundary must rescue every reply a reasonable model
 * emits (wrapper prose, fences, <think> blocks, trailing commas) while
 * failing LOUDLY with a descriptive error when there is nothing to parse.
 */

describe('extractJsonText', () => {
  it('strips a BOM and closed/unclosed <think> blocks', () => {
    expect(extractJsonText('\uFEFF{"a": 1}')).toBe('{"a": 1}');
    expect(extractJsonText('<think>hmm {a}</think>{"a": 1}')).toBe('{"a": 1}');
    expect(extractJsonText('<think>thinking forever about {"b": 2}')).toBe('');
  });
});

describe('parseJsonReply', () => {
  it('parses clean, fenced and prose-wrapped objects', () => {
    expect(parseJsonReply('{"a": 1}')).toEqual({ a: 1 });
    expect(parseJsonReply('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(parseJsonReply('Here is your JSON:\n{"a": 1}')).toEqual({ a: 1 });
  });

  it('survives reasoning blocks with braces and trailing prose with a closing brace', () => {
    expect(
      parseJsonReply('<think>Let me consider {schema} shapes.</think>\n{"a": 1}'),
    ).toEqual({ a: 1 });
    expect(parseJsonReply('{"a": 1}\n\nNote: markdown tables use | and } characters.')).toEqual({
      a: 1,
    });
  });

  it('takes the first parseable top-level value out of multi-object replies', () => {
    expect(parseJsonReply('{"a": 1}\n{"b": 2}')).toEqual({ a: 1 });
  });

  it('skips a stray brace pair in prose that shadows the real reply', () => {
    expect(parseJsonReply('not {valid json here} — answer: {"a": 1}')).toEqual({ a: 1 });
  });

  it('returns array roots intact instead of slicing into the first element', () => {
    expect(parseJsonReply('Here: [{"a": 1}, {"b": 2}]')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('repairs trailing commas', () => {
    expect(parseJsonReply('{"a": [1, 2,], "b": {"c": 3,},}')).toEqual({ a: [1, 2], b: { c: 3 } });
  });

  it('keeps braces and escapes inside string values intact', () => {
    const reply = '{"text": "curly { } and a quote \\" and a comma , inside"}';
    expect(parseJsonReply(reply)).toEqual({
      text: 'curly { } and a quote " and a comma , inside',
    });
  });

  it('throws a loud descriptive error when the reply has no JSON', () => {
    expect(() => parseJsonReply('this is not json at all')).toThrow(/no JSON object/);
    expect(() => parseJsonReply('this is not json at all')).toThrow(/reply began/);
    expect(() => parseJsonReply('')).toThrow(/no JSON object/);
  });

  it('throws a loud error naming the JSON fault when candidates do not parse', () => {
    expect(() => parseJsonReply('{"a": }')).toThrow(/invalid JSON in the reply/);
  });
});

describe('formatZodIssues / parseErrorSummary', () => {
  const schema = z.object({ name: z.string().min(1), count: z.number() });

  it('formats each issue as `path: message`', () => {
    const result = schema.safeParse({ name: '', count: '4' });
    if (result.success) throw new Error('expected a validation failure');
    expect(formatZodIssues(result.error)).toEqual([
      'name: Too small: expected string to have >=1 characters',
      'count: Invalid input: expected number, received string',
    ]);
  });

  it('summarizes zod errors compactly and passes other errors through', () => {
    const result = schema.safeParse({ count: '4' });
    if (result.success) throw new Error('expected a validation failure');
    expect(parseErrorSummary(result.error)).toContain('name:');
    expect(parseErrorSummary(new Error('boom'))).toBe('boom');
    expect(parseErrorSummary('raw')).toBe('raw');
  });
});
