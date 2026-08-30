import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { z } from 'zod';
import { beforeEach, describe, expect, it } from 'vitest';

import { createAppRouter } from '@/app/router';
import { ROUTES } from '@/app/routes';
import { DEFAULT_THEME, THEME_STORAGE_KEY, useThemeStore } from '@/app/theme/theme';

/**
 * T1 acceptance: the app shell renders on every route with placeholder pages
 * and a working theme toggle (docs/06-MILESTONES.md).
 */

function renderAppAt(path: string): void {
  window.history.replaceState(null, '', path);
  render(<RouterProvider router={createAppRouter()} />);
}

/** Reads the persisted theme from the zustand persist envelope in localStorage. */
function persistedTheme(): string | undefined {
  const raw = localStorage.getItem(THEME_STORAGE_KEY);
  if (!raw) return undefined;
  const envelope = z
    .object({ state: z.object({ theme: z.string() }), version: z.number() })
    .parse(JSON.parse(raw) as unknown);
  return envelope.state.theme;
}

beforeEach(() => {
  useThemeStore.setState({ theme: DEFAULT_THEME });
});

describe('app shell', () => {
  it('renders the top bar with app name and nav links', () => {
    renderAppAt(ROUTES.campaignPicker);

    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Campaigner' })).toHaveAttribute(
      'href',
      ROUTES.campaignPicker,
    );
    expect(screen.getByRole('link', { name: 'Workspace' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Rules' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Switch to light theme' })).toBeInTheDocument();
  });

  it('renders the campaign picker placeholder on /', () => {
    renderAppAt(ROUTES.campaignPicker);

    expect(screen.getByRole('heading', { name: 'Campaign picker' })).toBeInTheDocument();
  });

  it('renders the workspace placeholder for /c/:campaignId', () => {
    renderAppAt('/c/campaign-1');

    expect(screen.getByRole('heading', { name: 'Campaign workspace' })).toBeInTheDocument();
    expect(screen.getByText(/campaign “campaign-1”/)).toBeInTheDocument();
  });

  it('renders the workspace placeholder for /c/:campaignId/a/:artifactId', () => {
    renderAppAt('/c/campaign-1/a/artifact-9');

    expect(screen.getByText(/campaign “campaign-1”, artifact “artifact-9”/)).toBeInTheDocument();
  });

  it('navigates to the Rules placeholder from the top bar', async () => {
    const user = userEvent.setup();
    renderAppAt(ROUTES.campaignPicker);

    await user.click(screen.getByRole('link', { name: 'Rules' }));

    expect(screen.getByRole('heading', { name: 'Rules library' })).toBeInTheDocument();
  });

  it('navigates to the Settings placeholder from the top bar', async () => {
    const user = userEvent.setup();
    renderAppAt(ROUTES.campaignPicker);

    await user.click(screen.getByRole('link', { name: 'Settings' }));

    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
  });

  it('renders the not-found page for unknown routes', () => {
    renderAppAt('/definitely-not-a-route');

    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });
});

describe('theme toggle', () => {
  it('defaults to the dark theme and persists it', () => {
    renderAppAt(ROUTES.campaignPicker);

    expect(useThemeStore.getState().theme).toBe('dark');
    expect(document.documentElement).toHaveClass('dark');
    expect(persistedTheme()).toBe('dark');
  });

  it('toggles dark → light → dark and applies it to the document', async () => {
    const user = userEvent.setup();
    renderAppAt(ROUTES.campaignPicker);

    await user.click(screen.getByRole('button', { name: 'Switch to light theme' }));

    expect(useThemeStore.getState().theme).toBe('light');
    expect(document.documentElement).not.toHaveClass('dark');
    expect(document.documentElement.style.colorScheme).toBe('light');
    expect(persistedTheme()).toBe('light');

    await user.click(screen.getByRole('button', { name: 'Switch to dark theme' }));

    expect(useThemeStore.getState().theme).toBe('dark');
    expect(document.documentElement).toHaveClass('dark');
  });
});
