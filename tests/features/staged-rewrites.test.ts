import { beforeEach, describe, expect, it } from 'vitest';

import {
  useStagedRewritesStore,
  stagedRewriteFor,
} from '@/features/modules/board/stagedRewrites';

/**
 * Staged board rewrites — store lifecycle (08-MODULE-DESIGNER §Module
 * board): proposed → (ghost → complete) → applied → dropped, plus the
 * failed-apply revert and the discard drop. The store is strictly
 * session-only: nothing may ever reach localStorage (owner decision — the
 * staging model is "read new as-is, old only until the decision").
 */

function reset(): void {
  useStagedRewritesStore.setState({ byNodeKey: {} });
}

beforeEach(() => {
  reset();
});

describe('staged rewrite lifecycle', () => {
  it('proposes with old text, streams ghost, completes with the new text', () => {
    const store = useStagedRewritesStore.getState();
    store.stageProposal({ nodeKey: 'part-0', planIndex: 0, oldMarkdown: 'OLD TEXT' });

    let entry = stagedRewriteFor(useStagedRewritesStore.getState().byNodeKey, 'part-0');
    expect(entry).toMatchObject({
      nodeKey: 'part-0',
      planIndex: 0,
      oldMarkdown: 'OLD TEXT',
      newMarkdown: '',
      ghost: '',
      status: 'proposed',
    });

    store.appendGhost('part-0', 'NEW ');
    store.appendGhost('part-0', 'TEXT');
    entry = stagedRewriteFor(useStagedRewritesStore.getState().byNodeKey, 'part-0');
    expect(entry?.ghost).toBe('NEW TEXT');
    expect(entry?.status).toBe('proposed');

    store.finishProposal('part-0', 'NEW TEXT COMPLETE');
    entry = stagedRewriteFor(useStagedRewritesStore.getState().byNodeKey, 'part-0');
    expect(entry).toMatchObject({ newMarkdown: 'NEW TEXT COMPLETE', ghost: '', status: 'proposed' });
  });

  it('apply marks applied, then the landing drops the entry; a failed apply reverts', () => {
    const store = useStagedRewritesStore.getState();
    store.stageProposal({ nodeKey: 'part-1', planIndex: 1, oldMarkdown: 'OLD' });
    store.finishProposal('part-1', 'NEW');

    store.markApplied('part-1');
    expect(stagedRewriteFor(useStagedRewritesStore.getState().byNodeKey, 'part-1')?.status).toBe(
      'applied',
    );

    // The save failed: the decision did not land — back to proposed.
    store.revertToProposed('part-1');
    expect(stagedRewriteFor(useStagedRewritesStore.getState().byNodeKey, 'part-1')?.status).toBe(
      'proposed',
    );

    store.markApplied('part-1');
    store.drop('part-1');
    expect(stagedRewriteFor(useStagedRewritesStore.getState().byNodeKey, 'part-1')).toBeUndefined();
  });

  it('discard drops the staging outright', () => {
    const store = useStagedRewritesStore.getState();
    store.stageProposal({ nodeKey: 'part-2', planIndex: 2, oldMarkdown: 'OLD' });
    store.finishProposal('part-2', 'NEW');
    store.drop('part-2');
    expect(useStagedRewritesStore.getState().byNodeKey['part-2']).toBeUndefined();
  });

  it('ignores operations for unknown node keys and re-proposal overwrites', () => {
    const store = useStagedRewritesStore.getState();
    store.appendGhost('missing', 'delta');
    store.finishProposal('missing', 'x');
    store.markApplied('missing');
    store.revertToProposed('missing');
    store.drop('missing');
    expect(useStagedRewritesStore.getState().byNodeKey).toEqual({});

    store.stageProposal({ nodeKey: 'part-0', planIndex: 0, oldMarkdown: 'FIRST' });
    store.stageProposal({ nodeKey: 'part-0', planIndex: 0, oldMarkdown: 'SECOND' });
    expect(stagedRewriteFor(useStagedRewritesStore.getState().byNodeKey, 'part-0')?.oldMarkdown).toBe(
      'SECOND',
    );
  });

  it('is session-only: nothing reaches localStorage', () => {
    const store = useStagedRewritesStore.getState();
    store.stageProposal({ nodeKey: 'part-0', planIndex: 0, oldMarkdown: 'OLD' });
    store.appendGhost('part-0', 'streaming text');
    store.finishProposal('part-0', 'NEW');
    store.markApplied('part-0');
    expect(localStorage.length).toBe(0);
  });
});
