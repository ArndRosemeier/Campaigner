import { createBrowserRouter } from 'react-router-dom';

import { NotFoundPage } from '@/components/NotFoundPage';
import { AppShell } from '@/app/layout/AppShell';
import { ROUTES } from '@/app/routes';
import { CampaignPickerPage } from '@/features/campaign/CampaignPickerPage';
import { GraphPage } from '@/features/campaign/GraphPage';
import { WorkspacePage } from '@/features/campaign/WorkspacePage';
import { PlayPage } from '@/features/play/PlayPage';
import { RulesPage } from '@/features/rules/RulesPage';
import { SettingsPage } from '@/features/settings/SettingsPage';

/**
 * Builds the app's route table, per 05-UI.md §Routes. All pages render inside
 * `AppShell` so the top bar is present on every route.
 *
 * Exported as a factory so tests can mount a fresh router bound to the current
 * URL; the app itself uses the singleton below.
 */
export type AppRouter = ReturnType<typeof createBrowserRouter>;

export function createAppRouter(): AppRouter {
  return createBrowserRouter([
    {
      path: ROUTES.campaignPicker,
      element: <AppShell />,
      children: [
        { index: true, element: <CampaignPickerPage /> },
        { path: ROUTES.workspace, element: <WorkspacePage /> },
        { path: ROUTES.artifact, element: <WorkspacePage /> },
        { path: ROUTES.graph, element: <GraphPage /> },
        { path: ROUTES.play, element: <PlayPage /> },
        { path: ROUTES.rules, element: <RulesPage /> },
        { path: ROUTES.settings, element: <SettingsPage /> },
        { path: '*', element: <NotFoundPage /> },
      ],
    },
  ]);
}

/** The router instance used by the running app. */
export const router: AppRouter = createAppRouter();
