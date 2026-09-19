import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BuildStatusBadge } from '@/app/layout/BuildStatusBadge';
import { buildStatusUrl, readBuildStatus, type BuildStatusRead } from '@/app/layout/build-status';

/**
 * The build-status badge (docs/17 row 250, docs/18 §2): the owner's "WIP, right
 * after the Campaigner Title". These arms pin the THREE honest states and the
 * LOUDNESS contract that makes the badge worth having: a failed fetch, an HTTP
 * error, a malformed payload and an unexpected field all render `cannot-tell` —
 * never `verified`. A badge that silently reads verified when it could not check
 * is the exact failure this slice exists to prevent.
 *
 * The badge is rendered with an INJECTED read (`readStatus`) because a test
 * bundle is not a deploy bundle: `import.meta.env.PROD` is false under vitest,
 * so the default read answers `cannot-tell` with no request at all (pinned as
 * its own arm below). The injected read is the REAL `readBuildStatus` against a
 * mocked global `fetch`, so the whole chain — fetch, HTTP check, zod
 * validation, badge rendering — runs for real.
 */
function stubFetch(response: { ok?: boolean; status?: number; body: unknown }): void {
  vi.stubGlobal('fetch', () =>
    Promise.resolve({
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: () => Promise.resolve(response.body),
    }),
  );
}

/** Render the badge against the real reader with the currently stubbed fetch. */
function renderBadge(read: BuildStatusRead = () => readBuildStatus('/Campaigner/')): void {
  render(<BuildStatusBadge readStatus={read} />);
}

/**
 * Await the badge reaching `state` WITH `titlePart` in its tooltip. The tooltip
 * is asserted too on purpose: it proves the state came from the read rather than
 * from the bundle's synchronous default.
 */
async function waitForBadge(state: string, titlePart: string): Promise<void> {
  await waitFor(() => {
    const badge = screen.getByTestId('build-status-badge');
    expect(badge).toHaveAttribute('data-state', state);
    expect(badge.getAttribute('title')).toContain(titlePart);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BuildStatusBadge (docs/17 row 250)', () => {
  it('renders verified, driven by the fetched payload', async () => {
    stubFetch({ body: { state: 'verified', detail: 'the FULL gate is GREEN at abc1234' } });
    renderBadge();
    await waitForBadge('verified', 'the FULL gate is GREEN at abc1234');
    expect(screen.getByTestId('build-status-badge')).toHaveTextContent('verified');
  });

  it('renders WIP, driven by the fetched payload', async () => {
    stubFetch({ body: { state: 'wip', detail: 'compiles, but the FULL gate has not verified it' } });
    renderBadge();
    await waitForBadge('wip', 'not verified it');
    expect(screen.getByTestId('build-status-badge')).toHaveTextContent('WIP');
  });

  it('renders cannot-tell when the payload says so', async () => {
    stubFetch({ body: { state: 'cannot-tell', detail: 'no GATE GREEN record on the board' } });
    renderBadge();
    await waitForBadge('cannot-tell', 'no GATE GREEN record on the board');
  });

  it('renders cannot-tell when the fetch fails', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
    renderBadge();
    await waitForBadge('cannot-tell', 'offline');
  });

  it('renders cannot-tell when the payload is malformed', async () => {
    stubFetch({ body: { state: 'greenish', detail: 'not a state' } });
    renderBadge();
    await waitForBadge('cannot-tell', 'not a build-status payload');
  });

  it('renders cannot-tell when the payload carries a field the contract does not have', async () => {
    stubFetch({ body: { state: 'verified', detail: 'x', unexpected: true } });
    renderBadge();
    await waitForBadge('cannot-tell', 'not a build-status payload');
  });

  it('renders cannot-tell when the status file answers with an HTTP error', async () => {
    stubFetch({ ok: false, status: 404, body: null });
    renderBadge();
    await waitForBadge('cannot-tell', 'HTTP 404');
  });

  it('answers cannot-tell rather than throwing when the runtime has no fetch at all', async () => {
    vi.stubGlobal('fetch', undefined);
    const status = await readBuildStatus('/Campaigner/', undefined);
    expect(status.state).toBe('cannot-tell');
    expect(status.detail).toContain('no fetch');
  });

  it('reads the status file from the app own base path', () => {
    expect(buildStatusUrl('/Campaigner/')).toBe('/Campaigner/build-status.json');
  });

  it('renders cannot-tell synchronously in a bundle no deploy job produced', () => {
    // No fetch stub on purpose: under vitest `import.meta.env.PROD` is false
    // (this is not a deploy bundle), so the default read must not touch the
    // network — and the badge must say cannot-tell immediately rather than
    // rendering nothing until an update that will never come.
    render(<BuildStatusBadge />);
    const badge = screen.getByTestId('build-status-badge');
    expect(badge).toHaveAttribute('data-state', 'cannot-tell');
    expect(badge.getAttribute('title')).toContain('not produced by the deploy job');
  });
});
