import { describe, expect, it } from 'vitest';

import type { WikiGraphNode } from '@/domain/wikiGraph';
import {
  mentionModuleTitle,
  mentionRoute,
  mentionSummaryText,
  nodeFirstMentionRoute,
  whereLabel,
} from '@/features/campaign/mentionView';

/**
 * The shared display helpers of the wiki-graph consumers
 * (14-BACKLINKS-ORPHANS): the `where` label convention, the reader deep
 * links, and the per-module summary line. Pure — no DB, no router.
 */

const campaignId = 'c-1';
const moduleA = 'm-aaa';
const moduleB = 'm-bbb';
const modules = [
  { id: moduleA, title: 'Ashen Vault' },
  { id: moduleB, title: 'Bell Harbor' },
];

describe('whereLabel', () => {
  it('renders the premise and the reader part numbering (planIndex + 1)', () => {
    expect(whereLabel('premise')).toBe('Premise');
    expect(whereLabel('part-0')).toBe('Part 1');
    expect(whereLabel('part-12')).toBe('Part 13');
  });
});

describe('mentionRoute', () => {
  it('deep-links a part mention to the reader part hash and a premise to the reader', () => {
    expect(mentionRoute(campaignId, { moduleId: moduleA, where: 'part-2', count: 1 })).toBe(
      `/c/${campaignId}/m/${moduleA}#part-2`,
    );
    expect(mentionRoute(campaignId, { moduleId: moduleB, where: 'premise', count: 3 })).toBe(
      `/c/${campaignId}/m/${moduleB}`,
    );
  });
});

describe('nodeFirstMentionRoute', () => {
  it('links to the first mention in document order', () => {
    const node = {
      key: 'name:seggel',
      names: ['Seggel'],
      artifact: undefined,
      status: 'unresolved' as const,
      mentions: 3,
      mentionsByDocument: [
        { moduleId: moduleA, where: 'premise', count: 2 },
        { moduleId: moduleB, where: 'part-1', count: 1 },
      ],
    } satisfies WikiGraphNode;
    expect(nodeFirstMentionRoute(campaignId, node)).toBe(`/c/${campaignId}/m/${moduleA}`);
  });

  it('fails loudly on a mention-less node instead of silently rerouting', () => {
    const node = {
      key: 'name:seggel',
      names: ['Seggel'],
      artifact: undefined,
      status: 'unresolved' as const,
      mentions: 0,
      mentionsByDocument: [],
    } satisfies WikiGraphNode;
    expect(() => nodeFirstMentionRoute(campaignId, node)).toThrow(/no mentions/);
  });
});

describe('mentionModuleTitle', () => {
  it('returns the module title and throws on an unknown module', () => {
    expect(mentionModuleTitle(modules, moduleB)).toBe('Bell Harbor');
    expect(() => mentionModuleTitle(modules, 'm-zzz')).toThrow(/unknown module/);
  });
});

describe('mentionSummaryText', () => {
  it('groups consecutive per-document mentions per module', () => {
    const node = {
      key: 'name:grimm',
      names: ['Grimm'],
      artifact: undefined,
      status: 'unresolved' as const,
      mentions: 5,
      mentionsByDocument: [
        { moduleId: moduleA, where: 'premise', count: 2 },
        { moduleId: moduleA, where: 'part-0', count: 1 },
        { moduleId: moduleB, where: 'part-2', count: 2 },
      ],
    } satisfies WikiGraphNode;
    expect(mentionSummaryText(node, modules)).toBe(
      'Ashen Vault — Premise ×2, Part 1 ×1 · Bell Harbor — Part 3 ×2',
    );
  });
});
