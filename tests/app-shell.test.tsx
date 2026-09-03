import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { z } from 'zod';
import { beforeEach, describe, expect, it } from 'vitest';

import { createAppRouter } from '@/app/router';
import {
  ROUTES,
  deliverablesPath,
  graphPath,
  modulesPath,
  workspacePath,
} from '@/app/routes';
import { DEFAULT_THEME, THEME_STORAGE_KEY, useThemeStore } from '@/app/theme/theme';
import { createCampaign } from '@/db/campaignRepo';
import { createModule as saveModule } from '@/db/moduleRepo';
import { createModule } from '@/domain';
import { clearDatabase } from './db/helpers';

/**
 * App shell behavior (T1): shell + theme toggle on every route, the campaign
 * bar (campaign tabs + breadcrumb) and the routed pages as they become real.
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
    expect(screen.getByRole('link', { name: 'Rules' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Switch to light theme' })).toBeInTheDocument();
  });

  it('renders the campaign tabs disabled while no campaign is open', () => {
    renderAppAt(ROUTES.campaignPicker);

    // The app map stays visible on every route; without a campaign the
    // campaign-level tabs are disabled instead of hidden.
    expect(screen.getByTestId('campaign-bar')).toBeInTheDocument();
    for (const label of ['Workspace', 'Modules', 'Deliverables', 'Graph']) {
      expect(screen.getByRole('button', { name: label })).toBeDisabled();
    }
  });

  it('renders the campaign picker on /', () => {
    renderAppAt(ROUTES.campaignPicker);

    expect(screen.getByRole('heading', { name: 'Campaigns' })).toBeInTheDocument();
    expect(screen.getByTestId('new-campaign')).toBeInTheDocument();
  });

  it('renders the workspace for /c/:campaignId (missing-campaign pane when empty)', async () => {
    renderAppAt('/c/campaign-1');

    expect(await screen.findByText(/does not exist/, {}, { timeout: 10000 })).toBeInTheDocument();
  });

  it('renders the workspace for /c/:campaignId/a/:artifactId', async () => {
    renderAppAt('/c/campaign-1/a/artifact-9');

    expect(await screen.findByText(/does not exist/, {}, { timeout: 10000 })).toBeInTheDocument();
  });

  it('navigates to the Rules screen from the top bar', async () => {
    const user = userEvent.setup();
    renderAppAt(ROUTES.campaignPicker);

    await user.click(screen.getByRole('link', { name: 'Rules' }));

    expect(screen.getByRole('heading', { name: 'Rulebooks' })).toBeInTheDocument();
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

describe('campaign switcher', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  it('lists created campaigns, navigates on selection and shows the current one', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'The Sunless Sea', system: 'generic-d20' });
    renderAppAt(ROUTES.campaignPicker);

    // On the picker route no campaign is open yet.
    expect(screen.getByTestId('current-campaign')).toHaveTextContent('No campaign');

    await user.click(screen.getByRole('button', { name: 'Switch campaign' }));
    expect(
      await screen.findByRole('menuitem', { name: 'The Sunless Sea' }),
    ).toBeInTheDocument();

    // Selecting a campaign opens its workspace and updates the trigger.
    await user.click(screen.getByRole('menuitem', { name: 'The Sunless Sea' }));
    expect(await screen.findByTestId('current-campaign')).toHaveTextContent('The Sunless Sea');
    expect(window.location.pathname).toBe(workspacePath(campaign.id));
  });

  it('shows the empty state before any campaign exists', async () => {
    const user = userEvent.setup();
    renderAppAt(ROUTES.campaignPicker);

    await user.click(screen.getByRole('button', { name: 'Switch campaign' }));

    expect(
      await screen.findByRole('menuitem', { name: 'No campaigns yet' }),
    ).toHaveAttribute('aria-disabled', 'true');
  });

  it('tracks the campaign in the switcher on every campaign route', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });

    renderAppAt(graphPath(campaign.id));
    // The trigger renders synchronously with 'No campaign'; the live query
    // resolves a tick later.
    await waitFor(() => {
      expect(screen.getByTestId('current-campaign')).toHaveTextContent('Ember');
    });
  });

  it('points the campaign tabs at the open campaign', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });

    renderAppAt(workspacePath(campaign.id));
    await waitFor(() => {
      expect(screen.getByTestId('current-campaign')).toHaveTextContent('Ember');
    });
    expect(screen.getByRole('link', { name: 'Workspace' })).toHaveAttribute(
      'href',
      workspacePath(campaign.id),
    );
    expect(screen.getByRole('link', { name: 'Modules' })).toHaveAttribute(
      'href',
      modulesPath(campaign.id),
    );
    expect(screen.getByRole('link', { name: 'Deliverables' })).toHaveAttribute(
      'href',
      deliverablesPath(campaign.id),
    );
    expect(screen.getByRole('link', { name: 'Graph' })).toHaveAttribute(
      'href',
      graphPath(campaign.id),
    );
  });
});

describe('campaign bar breadcrumb', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  it('shows Campaigns / Modules / title on the module reader route', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = await saveModule(
      createModule({
        campaignId: campaign.id,
        title: 'The Drowned Vault',
        concept: 'A flooded vault beneath a watchtower.',
        levelMin: 1,
        levelMax: 3,
        sizeDial: 'standard',
      }),
    );

    renderAppAt(`/c/${campaign.id}/m/${module.id}`);

    const crumb = await screen.findByTestId('campaign-crumb', {}, { timeout: 10_000 });
    expect(crumb).toHaveTextContent('Campaigns');
    expect(within(crumb).getByRole('link', { name: 'Modules' })).toHaveAttribute(
      'href',
      modulesPath(campaign.id),
    );
    expect(screen.getByTestId('crumb-module')).toHaveTextContent('The Drowned Vault');
    expect(within(crumb).queryByText('Battle table')).not.toBeInTheDocument();
  });

  it('appends the Battle table step on the battle route', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = await saveModule(
      createModule({
        campaignId: campaign.id,
        title: 'The Drowned Vault',
        concept: 'A flooded vault beneath a watchtower.',
        levelMin: 1,
        levelMax: 3,
        sizeDial: 'standard',
      }),
    );

    renderAppAt(`/c/${campaign.id}/m/${module.id}/battle`);

    const crumb = await screen.findByTestId('campaign-crumb', {}, { timeout: 10_000 });
    expect(crumb).toHaveTextContent('Battle table');
    expect(screen.getByTestId('crumb-module')).toHaveTextContent('The Drowned Vault');
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

describe('generation language select', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  it('is choosable on the main page and persists the choice in settings', async () => {
    const user = userEvent.setup();
    renderAppAt(ROUTES.campaignPicker);

    await user.click(
      await screen.findByLabelText('Generation language', {}, { timeout: 5_000 }),
    );
    await user.click(
      await screen.findByRole('option', { name: 'Deutsch (German)' }, { timeout: 5_000 }),
    );

    await waitFor(async () => {
      const { readSettings } = await import('@/db/settingsRepo');
      expect((await readSettings()).language).toBe('de');
    });

    // The choice survives a re-render (value read back from settings).
    await waitFor(() => {
      expect(screen.getByLabelText('Generation language')).toHaveTextContent('Deutsch');
    });
  });
});
