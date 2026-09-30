import { afterEach, describe, expect, it } from 'vitest';

import {
  APP_BASE_TITLE,
  applyBackgroundTitle,
  backgroundActivityCount,
  backgroundActivityLabel,
  backgroundTitle,
  clearBackgroundActivity,
  clearFinishedBackgroundActivities,
  resetBackgroundTitle,
  setBackgroundActivity,
} from '@/lib/backgroundTitle';

/**
 * The background completion surface (docs/17 row 110, docs/18 §2.2): the ONE
 * thing a backgrounded tab can still say to the owner, and the second half of
 * his report ("generating a module takes a long time, and switching away is
 * normal"): the tab STRIP has to tell him it finished, or failed.
 *
 * Every rule is pinned literally, because a title that lies is worse than a
 * title that says nothing: `✓`/`⚠` come only from a verdict, a user stop
 * reaches no verdict at all (it removes the entry), and while the tab is
 * visible the app's own title is restored — the surface is the strip, never the
 * document the owner is reading.
 */

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
}

afterEach(() => {
  resetBackgroundTitle();
  setHidden(false);
  document.title = APP_BASE_TITLE;
});

describe('the background title', () => {
  it('says what is running, and only writes while the tab is hidden', () => {
    setHidden(true);
    setBackgroundActivity('module-gen-m1', { label: 'The Drowned Vault', state: 'running' });

    expect(document.title).toBe('Working: The Drowned Vault — Campaigner');

    // Back on screen the app's own title is restored: the strip is the surface,
    // not the document being read.
    setHidden(false);
    applyBackgroundTitle();
    expect(document.title).toBe(APP_BASE_TITLE);
    // The state is remembered: hiding again restores the line without a write.
    setHidden(true);
    applyBackgroundTitle();
    expect(document.title).toBe('Working: The Drowned Vault — Campaigner');
  });

  it('turns the same entry into a verdict, and marks a failure harder', () => {
    setHidden(true);
    const id = 'run-r1';
    setBackgroundActivity(id, { label: 'Harbormaster Ilse', state: 'running' });
    expect(document.title).toContain('Working: Harbormaster Ilse');

    setBackgroundActivity(id, { label: 'Harbormaster Ilse', state: 'completed' });
    expect(document.title).toBe('✓ Finished: Harbormaster Ilse — Campaigner');

    setBackgroundActivity(id, { label: 'Harbormaster Ilse', state: 'failed' });
    expect(document.title).toBe('⚠ Failed: Harbormaster Ilse — Campaigner');
    expect(backgroundActivityCount()).toBe(1);
  });

  it('ranks failed over finished over running, and counts the rest instead of dropping them', () => {
    setHidden(true);
    setBackgroundActivity('a', { label: 'The Drowned Vault', state: 'completed' });
    setBackgroundActivity('b', { label: 'The Sunken Quarter', state: 'running' });
    // The owner must act on the failure first; both finished modules are news.
    setBackgroundActivity('c', { label: 'The Bell Tower', state: 'failed' });

    expect(backgroundTitle()).toBe('⚠ Failed: The Bell Tower — Campaigner');

    setBackgroundActivity('d', { label: 'The Salt Marsh', state: 'completed' });
    expect(backgroundTitle()).toBe('⚠ Failed: The Bell Tower — Campaigner');

    clearBackgroundActivity('c');
    // Two finished: the most recent one is named, the other is counted.
    expect(backgroundTitle()).toBe('✓ Finished: The Salt Marsh (+1 more) — Campaigner');
  });

  it('a stop reaches no verdict: the entry is gone and the title is the app title again', () => {
    setHidden(true);
    setBackgroundActivity('module-gen-m1', { label: 'The Drowned Vault', state: 'running' });
    clearBackgroundActivity('module-gen-m1');

    expect(backgroundActivityCount()).toBe(0);
    expect(backgroundTitle()).toBe(APP_BASE_TITLE);
    expect(document.title).toBe(APP_BASE_TITLE);
  });

  it('clears the VERDICTS on the way back in but keeps running work', () => {
    setHidden(true);
    setBackgroundActivity('done', { label: 'Harbormaster Ilse', state: 'completed' });
    setBackgroundActivity('live', { label: 'The Drowned Vault', state: 'running' });

    clearFinishedBackgroundActivities();

    expect(backgroundActivityLabel('done')).toBeUndefined();
    expect(backgroundActivityLabel('live')).toBe('The Drowned Vault');
    expect(backgroundTitle()).toBe('Working: The Drowned Vault — Campaigner');
  });
});
