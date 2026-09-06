import 'fake-indexeddb/auto';

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RouterProvider } from 'react-router-dom';

import { createAppRouter } from '@/app/router';
import { ROUTES, guidePath, modulesPath } from '@/app/routes';
import { GUIDE_CHAPTERS } from '@/features/guide/guideContent';
import { useOnboardingStore } from '@/features/onboarding/onboardingStore';
import { defaultSettings } from '@/domain';
import { createCampaign } from '@/db/campaignRepo';
import { saveSettings } from '@/db/settingsRepo';
import { clearDatabase } from '../db/helpers';
import { flushAsyncUpdates } from '../helpers/flush';

/**
 * First-module guide (05-UI.md §Guide): content completeness (helpContent
 * pattern), route-table validity of every chapter's app link, the page's
 * chapter navigation, campaign-scoped CTA resolution and the entry points
 * (wizard step 6, modules empty state).
 */

function renderAppAt(path: string): void {
  window.history.replaceState(null, '', path);
  render(<RouterProvider router={createAppRouter()} />);
}

beforeEach(async () => {
  await clearDatabase();
  useOnboardingStore.setState({ open: false, focusStep: null });
  // The guide is not the wizard's owner — keep the auto-open quiet here.
  await saveSettings({
    ...defaultSettings(),
    onboarding: { status: 'complete' as const, stepState: [] },
  });
});
afterEach(() => {
  cleanup();
});

describe('guide content registry', () => {
  it('is complete: nine chapters, unique ids, populated sections and checkpoints', () => {
    expect(GUIDE_CHAPTERS).toHaveLength(9);
    const seen = new Set<string>();
    for (const chapter of GUIDE_CHAPTERS) {
      expect(seen.has(chapter.id)).toBe(false);
      seen.add(chapter.id);
      expect(chapter.title.length).toBeGreaterThan(3);
      expect(chapter.intro.length).toBeGreaterThan(20);
      expect(chapter.minutes).toBeGreaterThan(0);
      expect(chapter.checkpoint.length).toBeGreaterThan(10);
      expect(chapter.sections.length).toBeGreaterThanOrEqual(1);
      for (const section of chapter.sections) {
        expect(section.heading.length).toBeGreaterThan(3);
        expect(section.markdown.length).toBeGreaterThan(20);
      }
    }
  });

  it('covers the authored path in order', () => {
    expect(GUIDE_CHAPTERS.map((chapter) => chapter.id)).toEqual([
      'start-here',
      'campaign',
      'rules',
      'create-module',
      'spine',
      'parts',
      'cast',
      'battlemaps',
      'table',
    ]);
  });

  it('every app link points at a real route', () => {
    const staticPaths: ReadonlySet<string> = new Set<string>(Object.values(ROUTES));
    for (const chapter of GUIDE_CHAPTERS) {
      const link = chapter.appLink;
      if (link === undefined) continue;
      if (link.route.kind === 'static') {
        expect(staticPaths.has(link.route.path)).toBe(true);
      } else {
        expect(['workspace', 'modules', 'deliverables']).toContain(link.route.section);
      }
    }
  });
});

describe('GuidePage', () => {
  it('renders the first chapter with chapter navigation', async () => {
    renderAppAt(guidePath());
    expect(await screen.findByTestId('guide-chapter')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Start here' })).toBeInTheDocument();
    for (const chapter of GUIDE_CHAPTERS) {
      expect(screen.getByTestId(`guide-nav-${chapter.id}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('guide-checkpoint')).toBeInTheDocument();
    // First chapter has no back link.
    expect(screen.queryByTestId('guide-prev')).toBeNull();
  }, 20000);

  it('navigates to a chapter by route and offers prev/next', async () => {
    renderAppAt(guidePath('spine'));
    expect(await screen.findByRole('heading', { name: 'Approve the spine' })).toBeInTheDocument();
    expect(screen.getByTestId('guide-prev')).toHaveTextContent('Create the module');
    expect(screen.getByTestId('guide-next')).toHaveTextContent('Read, edit, rewrite');

    const user = userEvent.setup();
    await user.click(screen.getByTestId('guide-next'));
    expect(await screen.findByRole('heading', { name: 'Read, edit, rewrite' })).toBeInTheDocument();
    expect(window.location.pathname).toBe(guidePath('parts'));
  }, 20000);

  it('renders the not-found page for an unknown chapter id', async () => {
    renderAppAt(guidePath('not-a-chapter'));
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  }, 20000);

  it('resolves campaign-scoped CTAs against the most recent campaign', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    renderAppAt(guidePath('spine'));
    await flushAsyncUpdates();
    const link = await screen.findByTestId('guide-app-link');
    expect(link).toHaveAttribute('href', modulesPath(campaign.id));
    expect(link).toHaveAttribute('target', '_blank');
  }, 20000);

  it('renders a disabled hint for campaign-scoped CTAs without a campaign', async () => {
    renderAppAt(guidePath('spine'));
    await flushAsyncUpdates();
    expect(await screen.findByTestId('guide-app-link-disabled')).toHaveTextContent(
      'create a campaign first',
    );
  }, 20000);
});

describe('guide entry points', () => {
  it("the wizard's author step links to the guide in a new tab", async () => {
    renderAppAt(ROUTES.campaignPicker);
    act(() => {
      useOnboardingStore.getState().openWizard('author');
    });
    await screen.findByTestId('setup-wizard');
    await waitFor(() => {
      expect(screen.getByTestId('wizard-row-author')).toHaveAttribute('aria-expanded', 'true');
    });
    const link = screen.getByTestId('wizard-link-guide');
    expect(link).toHaveAttribute('href', guidePath());
    expect(link).toHaveAttribute('target', '_blank');
  }, 20000);

  it('the modules empty state links to the guide', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    renderAppAt(modulesPath(campaign.id));
    const empty = await screen.findByTestId('modules-empty-guide');
    expect(empty).toHaveAttribute('href', guidePath());
    expect(empty).toHaveAttribute('target', '_blank');
  }, 20000);
});
